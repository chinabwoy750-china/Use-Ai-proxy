const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const s = await chrome.storage.sync.get(['proxyUrl', 'password']);
  if (s.proxyUrl) $('url').value = s.proxyUrl;
  if (s.password) $('pw').value = s.password;
  const sel = $('prov');
  for (const p of EXT_PROVIDERS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  // detect current tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const d = extDetectProvider(tab?.url || '');
    if (d) {
      sel.value = d.id;
      $('st').textContent = 'Tab looks like ' + d.name;
    }
  } catch {}
}

$('go').onclick = async () => {
  const proxyUrl = $('url').value.trim();
  const password = $('pw').value;
  const providerId = $('prov').value || '';
  const accountName = $('name').value.trim();
  await chrome.storage.sync.set({ proxyUrl, password });
  $('go').disabled = true;
  $('st').className = 'status';
  $('st').textContent = 'Capturing…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CAPTURE',
      proxyUrl,
      password,
      providerId,
      accountName,
    });
    if (!res?.ok) throw new Error(res?.error || 'Failed');
    $('st').className = 'status ok';
    $('st').textContent = 'Saved ' + res.provider + ' (' + (res.keys || []).join(', ') + ')';
  } catch (e) {
    $('st').className = 'status err';
    $('st').textContent = e.message || String(e);
  } finally {
    $('go').disabled = false;
  }
};

loadSettings();
