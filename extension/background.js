/* global EXT_PROVIDERS, extDetectProvider */
importScripts('providers.js');

async function injectPerchanceKeyHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        if (window.__pcKeyHooked) return;
        window.__pcKeyHooked = true;
        const save = (k) => {
          if (!k || typeof k !== 'string') return;
          const key = k.trim();
          if (key.length < 16) return;
          try {
            sessionStorage.setItem('PERCHANCE_USER_KEY', key);
            localStorage.setItem('PERCHANCE_USER_KEY', key);
          } catch (e) {}
          window.__pcUserKey = key;
        };
        const scan = (s) => {
          if (!s || typeof s !== 'string') return;
          let m = s.match(/userKey=([a-fA-F0-9]{32,128})/);
          if (m) save(m[1]);
          m = s.match(/"userKey"\s*:\s*"([^"]+)"/);
          if (m) save(m[1]);
        };
        const ofetch = window.fetch;
        window.fetch = async function () {
          const res = await ofetch.apply(this, arguments);
          try {
            const url = String(arguments[0] && arguments[0].url ? arguments[0].url : arguments[0] || '');
            scan(url);
            if (/verifyUser|generate|checkVerification/i.test(url)) {
              const clone = res.clone();
              clone.text().then(scan).catch(() => {});
            }
          } catch (e) {}
          return res;
        };
        const open = XMLHttpRequest.prototype.open;
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__pcUrl = url;
          return open.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          this.addEventListener('load', function () {
            try {
              scan(String(this.__pcUrl || ''));
              scan(String(this.responseText || ''));
            } catch (e) {}
          });
          return send.apply(this, arguments);
        };
        try {
          performance.getEntriesByType('resource').forEach((e) => scan(e.name || ''));
        } catch (e) {}
      },
    });
  } catch (e) {
    console.warn('perchance hook', e);
  }
}

async function readPerchanceKeyFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const keys = [];
        try {
          keys.push(sessionStorage.getItem('PERCHANCE_USER_KEY'));
          keys.push(localStorage.getItem('PERCHANCE_USER_KEY'));
          keys.push(window.__pcUserKey);
        } catch (e) {}
        try {
          performance.getEntriesByType('resource').forEach((e) => {
            const m = String(e.name || '').match(/userKey=([a-fA-F0-9]{32,128})/);
            if (m) keys.push(m[1]);
          });
        } catch (e) {}
        return keys.filter(Boolean)[0] || '';
      },
    });
    for (const r of results || []) {
      if (r && r.result) return String(r.result).trim();
    }
    return '';
  } catch {
    return '';
  }
}

async function fetchPerchanceUserKey(tabId) {
  if (tabId) {
    await injectPerchanceKeyHook(tabId);
    let key = await readPerchanceKeyFromTab(tabId);
    if (key) return key;
  }

  const browserId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const url =
    'https://image-generation.perchance.org/api/verifyUser?browserId=' +
    browserId +
    '&thread=0&__cacheBust=' +
    Math.random();
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://perchance.org/ai-text-to-image-generator',
      Origin: 'https://perchance.org',
    },
  });
  const text = await r.text();
  if (/just a moment|cloudflare/i.test(text)) {
    throw new Error(
      'Cloudflare challenge — open Perchance, pass the check, click Generate, wait for image, THEN Capture'
    );
  }
  try {
    const j = JSON.parse(text);
    if (j.userKey) return j.userKey;
    if (j.status === 'failed_verification' || j.reason === 'token_required') {
      throw new Error(
        'Perchance needs a page Generate first (Turnstile). Click Generate, wait for the image, then Capture'
      );
    }
  } catch (e) {
    if (e.message && /Turnstile|Generate|Cloudflare/.test(e.message)) throw e;
  }
  const m = text.match(/"userKey"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  if (tabId) {
    const key = await readPerchanceKeyFromTab(tabId);
    if (key) return key;
  }
  throw new Error(
    'No userKey found. Open perchance.org/ai-text-to-image-generator → Generate → wait for image → Capture. Or copy userKey from Network tab (generate?userKey=...)'
  );
}




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

  // Perchance: fetch userKey from this machine (bypasses Render Cloudflare)
  if (provider.id === 'perchance') {
    await injectPerchanceKeyHook(tab.id);
    const userKey = await fetchPerchanceUserKey(tab.id);
    const values = { PERCHANCE_USER_KEY: userKey };
    const base = String(proxyUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('Set Proxy URL in the popup first');
    const r = await fetch(base + '/api/extension/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password || '',
      },
      body: JSON.stringify({
        provider: 'perchance',
        name: accountName || 'Perchance extension',
        values,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      throw new Error(j.error || j.message || 'Import failed HTTP ' + r.status);
    }
    return {
      provider: 'perchance',
      keys: Object.keys(values),
      message: j.message || 'Imported Perchance userKey',
      accounts: j.accounts,
    };
  }

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
