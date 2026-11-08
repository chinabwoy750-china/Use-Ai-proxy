/* global EXT_PROVIDERS, extDetectProvider */
importScripts('providers.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'CAPTURE') {
    captureAndSend(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
});

async function getCookiesForDomains(domains) {
  const all = [];
  for (const domain of domains) {
    try {
      const list = await chrome.cookies.getAll({ domain: domain.replace(/^\./, '') });
      all.push(...list);
    } catch {}
    try {
      const list2 = await chrome.cookies.getAll({ domain });
      all.push(...list2);
    } catch {}
  }
  // de-dupe name+domain
  const seen = new Set();
  return all.filter((c) => {
    const k = c.name + '@' + c.domain;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cookieHeader(cookies, names) {
  let list = cookies;
  if (names && names.length) {
    const prefer = cookies.filter((c) => names.includes(c.name));
    if (prefer.length) list = prefer;
  }
  return list.map((c) => c.name + '=' + c.value).join('; ');
}

async function readTabLocal(tabId, keys) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (keys) => {
        const local = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            local[k] = localStorage.getItem(k);
          }
        } catch {}
        let bearer = '';
        try {
          for (const k of Object.keys(local)) {
            const v = local[k] || '';
            if (/token/i.test(k) && (v.startsWith('eyJ') || v.startsWith('Bearer'))) {
              bearer = v;
              break;
            }
          }
        } catch {}
        const pick = {};
        for (const k of keys || []) if (local[k] != null) pick[k] = local[k];
        return { local: Object.assign({}, local, pick), bearer };
      },
      args: [keys || []],
    });
    return result || { local: {}, bearer: '' };
  } catch {
    return { local: {}, bearer: '' };
  }
}

async function captureAndSend({ proxyUrl, password, providerId, accountName }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.id) throw new Error('No active tab');

  const detected = extDetectProvider(tab.url);
  const provider =
    (providerId && EXT_PROVIDERS.find((p) => p.id === providerId)) || detected;
  if (!provider) throw new Error('Open a supported provider site tab first (DeepSeek, Kimi, …)');

  const cookies = await getCookiesForDomains(provider.cookieDomains || []);
  if (provider.requireAnyCookie && provider.requireAnyCookie.length) {
    const has = provider.requireAnyCookie.some((n) => cookies.some((c) => c.name === n));
    if (!has) {
      throw new Error('Required cookie missing (' + provider.requireAnyCookie.join(' or ') + ') — log in fully first');
    }
  } else if (provider.cookieNames) {
    const has = provider.cookieNames.some((n) => cookies.some((c) => c.name === n));
    if (!has && cookies.length === 0) {
      throw new Error('No cookies found — log in on this tab first');
    }
  }
  if (!cookies.length) {
    throw new Error('No cookies found — log in on this tab first');
  }

  const store = await readTabLocal(tab.id, provider.localKeys || []);
  // Always prefer FULL jar for CF sites; optional cookieNames only filters when set
  const ctx = {
    url: tab.url,
    cookies,
    cookieHeader: cookieHeader(cookies, provider.cookieNames || null),
    local: store.local || {},
    bearer: store.bearer || '',
  };
  const values = provider.build(ctx);
  // drop empty
  for (const k of Object.keys(values)) {
    if (values[k] == null || values[k] === '') delete values[k];
  }
  if (!Object.keys(values).length) {
    throw new Error('Nothing captured — are you logged in on this page?');
  }

  const base = String(proxyUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set your proxy URL (e.g. https://myproxy-use.onrender.com)');
  if (!password) throw new Error('Set admin password');

  const res = await fetch(base + '/api/extension/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + password,
    },
    body: JSON.stringify({
      provider: provider.id,
      name: accountName || (provider.name + ' extension'),
      values,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText || 'Import failed');
  return { provider: provider.id, keys: Object.keys(values), message: j.message || 'Saved' };
}
