'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config-store');
const catalog = require('./providers-catalog');
const connections = require('./connection-store');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});


function load(name) {
  try {
    return require(name);
  } catch (e) {
    console.error(`[load] ${name}:`, e.message);
    return null;
  }
}

const deepseekProxy = load('./deepseek-proxy');
const kimiProxy = load('./kimi-proxy');
const huggingfaceProxy = load('./huggingface-proxy');
const mistralProxy = load('./mistral-proxy');
const perplexityProxy = load('./perplexity-proxy');
const grokProxy = load('./grok-proxy');
const opencodeProxy = load('./opencode-proxy');
const ucProxy = load('./uc-proxy');
const veoProxy = load('./veo-proxy');

const notrackProxy = load('./providers/notrack-proxy');
const t3Proxy = load('./providers/t3-proxy');
const veniceProxy = load('./providers/venice-proxy');
const poeProxy = load('./providers/poe-proxy');
const arenaProxy = load('./providers/arena-proxy');
const zenmuxProxy = load('./providers/zenmux-proxy');
const blackboxProxy = load('./providers/blackbox-proxy');
const innerProxy = load('./providers/inner-proxy');
const adaptaProxy = load('./providers/adapta-proxy');
const museProxy = load('./providers/muse-proxy');
const tinycmsProxy = load('./providers/tinycms-proxy');
const maxaiProxy = load('./providers/maxai-proxy');

const pollinationsProxy = load('./providers/pollinations-proxy');
const perchanceProxy = load('./providers/perchance-proxy');
const webMedia = load('./providers/web-media');
const proxyPool = load('./proxy-pool');
const doubaoProxy = load('./providers/doubao-proxy');
const zaiProxy = load('./providers/zai-proxy');
const yuanbaoProxy = load('./providers/yuanbao-proxy');
const aistudioProxy = load('./providers/aistudio-proxy');
const v0Proxy = load('./providers/v0-proxy');
const notionProxy = load('./providers/notion-proxy');
const cloudflareProxy = load('./providers/cloudflare-proxy');
const longcatProxy = load('./providers/longcat-proxy');

const promptqlProxy = load('./providers/promptql-proxy');
const hyperagentProxy = load('./providers/hyperagent-proxy');
const conolProxy = load('./providers/conol-proxy');
const twinmindProxy = load('./providers/twinmind-proxy');
const syntxProxy = load('./providers/syntx-proxy');
const genericOpenaiProxy = load('./providers/generic-openai-proxy');
const kiroProxy = load('./providers/kiro-proxy');
const kiroOauth = require('./kiro-oauth');




const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

function routeProxy(model) {
  const m = String(model || '').toLowerCase();

  if ((m.startsWith('kimi') || m.startsWith('moonshot')) && kimiProxy) return kimiProxy;
  if ((m.startsWith('mistral') || m.startsWith('codestral')) && mistralProxy) return mistralProxy;
  if ((m.startsWith('pplx') || m.startsWith('perplexity')) && perplexityProxy) return perplexityProxy;
  if (m.startsWith('grok') && grokProxy) return grokProxy;
  if (m.startsWith('opencode') && opencodeProxy) return opencodeProxy;
  if ((m.startsWith('uc') || m === 'glm-image') && ucProxy) return ucProxy;
  if ((m.startsWith('veo') || m === 'nano-banana') && veoProxy) return veoProxy;
  if ((m.startsWith('notrack')) && notrackProxy) return notrackProxy;
  if ((m.startsWith('t3')) && t3Proxy) return t3Proxy;
  if ((m.startsWith('venice')) && veniceProxy) return veniceProxy;
  if ((m.startsWith('poe')) && poeProxy) return poeProxy;
  if ((m.startsWith('arena') || m.startsWith('lmarena')) && arenaProxy) return arenaProxy;
  if ((m.startsWith('zenmux')) && zenmuxProxy) return zenmuxProxy;
  if ((m.startsWith('blackbox')) && blackboxProxy) return blackboxProxy;
  if ((m.startsWith('inner')) && innerProxy) return innerProxy;
  if ((m.startsWith('adapta')) && adaptaProxy) return adaptaProxy;
  if ((m.startsWith('muse') || m.startsWith('meta-ai') || m === 'meta') && museProxy) return museProxy;
  if ((m.startsWith('tinycms') || m.startsWith('freegpt')) && tinycmsProxy) return tinycmsProxy;
  if ((m.startsWith('maxai') || m.startsWith('max-ai')) && maxaiProxy) return maxaiProxy;

  if ((m.startsWith('pollinations')) && pollinationsProxy) return pollinationsProxy;
  if ((m.startsWith('perchance')) && perchanceProxy) return perchanceProxy;
  if ((m.startsWith('doubao') || m.startsWith('dola')) && doubaoProxy) return doubaoProxy;
  if ((m.startsWith('zai') || m.startsWith('z-ai') || m === 'glm-z') && zaiProxy) return zaiProxy;
  if ((m.startsWith('yuanbao')) && yuanbaoProxy) return yuanbaoProxy;
  if ((m.startsWith('aistudio') || m.startsWith('hunyuan') || m.startsWith('tencent-aistudio')) && aistudioProxy) return aistudioProxy;
  if ((m.startsWith('v0') || m.startsWith('vercel-v0')) && v0Proxy) return v0Proxy;
  if ((m.startsWith('notion')) && notionProxy) return notionProxy;
  if ((m.startsWith('cloudflare') || m.startsWith('cf-ai') || m.startsWith('workers-ai')) && cloudflareProxy) return cloudflareProxy;
  if ((m.startsWith('longcat')) && longcatProxy) return longcatProxy;

  if ((m.startsWith('promptql') || m.startsWith('prompt-ql')) && promptqlProxy) return promptqlProxy;
  if ((m.startsWith('hyperagent') || m.startsWith('hyper-agent')) && hyperagentProxy) return hyperagentProxy;
  if ((m.startsWith('conol')) && conolProxy) return conolProxy;
  if ((m.startsWith('twinmind') || m.startsWith('twin-mind')) && twinmindProxy) return twinmindProxy;
  if ((m.startsWith('syntx')) && syntxProxy) return syntxProxy;
  if (kiroProxy && (m === 'kiro' || m.startsWith('kiro/') || m.startsWith('kiro-') || m.startsWith('claude-opus-') || m.startsWith('claude-sonnet-') || m.startsWith('claude-haiku-') || m.startsWith('gpt-5.6-'))) return kiroProxy;
  if (genericOpenaiProxy && genericOpenaiProxy.resolveTarget && genericOpenaiProxy.resolveTarget(m)) return genericOpenaiProxy;



  if (
    huggingfaceProxy &&
    (m.startsWith('hf') ||
      m.startsWith('huggingface') ||
      m === 'omni' ||
      (m.includes('/') && !m.startsWith('myproxy')))
  ) {
    return huggingfaceProxy;
  }

  // Providers whose model ids do not carry the provider prefix (e.g. big-pickle,
  // openai-fast) need an exact slug match before the DeepSeek fallback.
  for (const mod of [opencodeProxy, pollinationsProxy]) {
    if (!mod || !Array.isArray(mod.MODELS)) continue;
    if (mod.MODELS.some((x) => String((x && (x.slug || x.id)) || x).toLowerCase() === m)) return mod;
  }

  return deepseekProxy;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

// Provider → configured?  Env flags are authoritative (bootstrap/admin saves write
// to process.env), so this stays accurate after a live Admin "Save".
function isProviderConfigured(owner, mod) {
  if (!mod) return false;
  let flags = {};
  try {
    flags = config.getPublicProviders() || {};
  } catch (_) {}
  if (Object.prototype.hasOwnProperty.call(flags, owner)) return !!flags[owner];
  // Providers without an env flag: trust the module's own check when it has one.
  if (typeof mod.isConfigured === 'function') {
    try {
      return !!mod.isConfigured();
    } catch (_) {
      return false;
    }
  }
  return true;
}

function collectModels({ includeUnconfigured = false } = {}) {
  const models = [];
  const add = (mod, owner) => {
    if (!mod) return;
    if (!includeUnconfigured && !isProviderConfigured(owner, mod)) return;
    let list = mod.MODELS || [];
    // Some providers (e.g. the generic OpenAI-compatible one) expose a whole
    // catalog but only a subset has credentials. Let them narrow the list.
    if (!includeUnconfigured && typeof mod.configuredModels === 'function') {
      try {
        const allowed = new Set(mod.configuredModels().map(String));
        list = list.filter((m) => allowed.has(String(m.slug || m.id || m)));
      } catch (_) {}
    }
    for (const m of list) {
      const id = m.slug || m.id || m;
      models.push({ id, object: 'model', created: 0, owned_by: owner });
    }
  };
  add(deepseekProxy, 'deepseek');
  add(kimiProxy, 'kimi');
  add(mistralProxy, 'mistral');
  add(huggingfaceProxy, 'huggingface');
  add(perplexityProxy, 'perplexity');
  add(grokProxy, 'grok');
  add(opencodeProxy, 'opencode');
  add(ucProxy, 'uc');
  add(veoProxy, 'veo');
  add(notrackProxy, 'notrack');
  add(t3Proxy, 't3');
  add(veniceProxy, 'venice');
  add(poeProxy, 'poe');
  add(arenaProxy, 'arena');
  add(zenmuxProxy, 'zenmux');
  add(blackboxProxy, 'blackbox');
  add(innerProxy, 'inner');
  add(adaptaProxy, 'adapta');
  add(museProxy, 'muse');
  add(tinycmsProxy, 'tinycms');
  add(maxaiProxy, 'maxai');
  add(pollinationsProxy, 'pollinations');
  add(perchanceProxy, 'perchance');
  add(doubaoProxy, 'doubao');
  add(zaiProxy, 'zai');
  add(yuanbaoProxy, 'yuanbao');
  add(aistudioProxy, 'aistudio');
  add(v0Proxy, 'v0');
  add(notionProxy, 'notion');
  add(cloudflareProxy, 'cloudflare');
  add(longcatProxy, 'longcat');
  add(promptqlProxy, 'promptql');
  add(hyperagentProxy, 'hyperagent');
  add(conolProxy, 'conol');
  add(twinmindProxy, 'twinmind');
  add(syntxProxy, 'syntx');
  add(kiroProxy, 'kiro');
  add(genericOpenaiProxy, 'generic');
  return models;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Password',
      });
      return res.end();
    }

    
    if (pathname === '/admin-providers.json') {
      const f = path.join(PUBLIC, 'admin-providers.json');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('[]'); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      const html = path.join(PUBLIC, 'admin.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(html));
    }

    if (pathname === '/api/admin/status' && req.method === 'GET') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      return sendJson(res, 200, config.status());
    }

    if (pathname === '/api/admin/config' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const st = await config.saveFromAdmin(body);
      return sendJson(res, 200, st);
    }

    
    if (pathname === '/providers' || pathname === '/providers/') {
      const html = path.join(PUBLIC, 'providers.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(html));
    }

    
    if (pathname === '/api/icons/library' && req.method === 'GET') {
      const icons = catalog.resolveIcons();
      const meta = typeof catalog.iconLibraryMeta === 'function' ? catalog.iconLibraryMeta() : {};
      return sendJson(res, 200, { ok: true, meta, icons, count: Object.keys(icons).length });
    }

    if (pathname.startsWith('/api/icons/candidates/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      const list = catalog.iconCandidatesFor ? catalog.iconCandidatesFor(id) : [];
      return sendJson(res, 200, { id, candidates: list });
    }

    if (pathname === '/api/providers-catalog' && req.method === 'GET') {
      return sendJson(res, 200, {
        providers: catalog.PROVIDERS,
        icons: catalog.resolveIcons ? catalog.resolveIcons() : catalog.listIconFiles(),
      });
    }

    if (pathname === '/api/admin/console-script' && req.method === 'GET') {
      const auth = config.checkAdminAuth(req);
      // allow without auth so copy still works from admin after login; still ok public-ish
      const u = new URL(req.url, 'http://x');
      const id = u.searchParams.get('id') || '';
      const prov = catalog.PROVIDERS.find((x) => x.id === id);
      if (!prov) return sendJson(res, 404, { error: 'unknown provider' });
      return sendJson(res, 200, {
        id: prov.id,
        site: prov.site,
        script: catalog.scraperFor(prov),
      });
    }

    
    if (pathname === '/api/admin/icon-link' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      try {
        const url = catalog.saveIconLink(body.id, body.url);
        try {
          await config.saveFromAdmin({
            PROVIDER_ICON_OVERRIDES: process.env.PROVIDER_ICON_OVERRIDES || '{}',
          });
        } catch (_) {}
        return sendJson(res, 200, { ok: true, url, icons: catalog.resolveIcons() });
      } catch (e) {
        return sendJson(res, 400, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/admin/icon' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      try {
        const url = catalog.saveIcon(body.id, body.mime || 'image/png', body.data || '');
        try {
          await config.saveFromAdmin({
            PROVIDER_ICON_OVERRIDES: process.env.PROVIDER_ICON_OVERRIDES || '{}',
          });
        } catch (_) {}
        return sendJson(res, 200, { ok: true, url, icons: catalog.resolveIcons ? catalog.resolveIcons() : catalog.listIconFiles() });
      } catch (e) {
        return sendJson(res, 400, { error: e.message || String(e) });
      }
    }

    // static icons
    if (pathname.startsWith('/icons/')) {
      const name = path.basename(pathname);
      const file = path.join(PUBLIC, 'icons', name);
      if (!file.startsWith(path.join(PUBLIC, 'icons')) || !fs.existsSync(file)) {
        res.writeHead(404); return res.end('not found');
      }
      const ext = path.extname(file).toLowerCase();
      const types = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(file));
    }

    
    
    
    if (pathname === '/api/providers/grok/diag' && req.method === 'GET') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason || 'unauthorized' });
      if (!grokProxy || typeof grokProxy.diag !== 'function') {
        return sendJson(res, 500, { error: 'grok proxy not loaded' });
      }
      try {
        return sendJson(res, 200, await grokProxy.diag());
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/providers/kiro/models' && req.method === 'GET') {
      const ids = (kiroProxy && kiroProxy.KIRO_MODEL_IDS) || [];
      const data = [{ id: 'kiro', object: 'model', owned_by: 'kiro' }].concat(
        ids.map((id) => ({ id: 'kiro/' + id, object: 'model', owned_by: 'kiro' }))
      ).concat(ids.map((id) => ({ id, object: 'model', owned_by: 'kiro' })));
      return sendJson(res, 200, { object: 'list', data });
    }

    
    if (pathname === '/api/extension/import' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason || 'unauthorized' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}');
        const provider = String(body.provider || '').trim();
        const values = body.values && typeof body.values === 'object' ? body.values : {};
        const name = String(body.name || 'Extension').trim();
        if (!provider) return sendJson(res, 400, { error: 'provider required' });
        if (!Object.keys(values).length) return sendJson(res, 400, { error: 'values required' });

        // Merge into PROVIDER_CONNECTIONS accounts
        let all = {};
        try { all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}'); } catch { all = {}; }
        const entry = all[provider] || { accounts: [] };
        const accounts = Array.isArray(entry.accounts) ? entry.accounts.slice() : [];
        accounts.push({
          name,
          values,
          key: values[Object.keys(values)[0]] || '',
        });
        entry.accounts = accounts;
        all[provider] = entry;
        process.env.PROVIDER_CONNECTIONS = JSON.stringify(all);
        if (connections && connections.writeConnections) connections.writeConnections(all);

        // Write env keys from latest account (overwrite) so proxies see them immediately
        const envBody = { ...values };
        envBody.PROVIDER_CONNECTIONS = process.env.PROVIDER_CONNECTIONS;
        // DeepSeek multi-account helper string
        if (provider === 'huggingface' || provider === 'hf') {
          const cookies = accounts.map((a) => {
            const v = a.values || {};
            return String(v.HF_CHAT_COOKIE || v.HF_COOKIE || a.key || '').trim();
          }).filter(Boolean);
          if (cookies.length) {
            envBody.HF_CHAT_COOKIE = cookies[cookies.length - 1];
            envBody.HF_COOKIES = cookies.join('|||');
          }
        }
        if (provider === 'deepseek') {
          const lines = accounts.map((a) => {
            const v = a.values || {};
            const tok = String(v.DEEPSEEK_TOKEN || a.key || '').trim();
            const c = String(v.DEEPSEEK_COOKIE || '').trim();
            return tok ? (tok + '|' + c) : '';
          }).filter(Boolean);
          if (lines.length) envBody.DEEPSEEK_ACCOUNTS = lines.join('\n');
          if (values.DEEPSEEK_TOKEN) envBody.DEEPSEEK_TOKEN = values.DEEPSEEK_TOKEN;
          if (values.DEEPSEEK_COOKIE) envBody.DEEPSEEK_COOKIE = values.DEEPSEEK_COOKIE;
        }
        await config.saveFromAdmin(envBody);

        return sendJson(res, 200, {
          ok: true,
          message: 'Imported ' + provider + ' account',
          provider,
          keys: Object.keys(values),
          accounts: accounts.length,
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/oauth/kiro/device/start' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      try {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const out = await kiroOauth.startDevice(body.method || 'builder-id');
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/oauth/kiro/device/poll' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}');
        const out = await kiroOauth.pollDevice(body.sessionId);
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/oauth/kiro/social/start' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}');
        const out = kiroOauth.startSocial(body.provider || 'google');
        return sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/oauth/kiro/social/exchange' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}');
        const tokens = await kiroOauth.exchangeSocial(body.sessionId, body.callbackUrl || body.url);
        return sendJson(res, 200, { ok: true, tokens });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || String(e) });
      }
    }

    if (pathname === '/api/browser-login/status' && req.method === 'GET') {
      const worker = !!(process.env.BROWSER_WORKER_URL || process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM);
      return sendJson(res, 200, {
        available: worker,
        mode: process.env.BROWSER_WORKER_URL ? 'worker' : (process.env.CHROME_PATH ? 'local-chrome' : 'none'),
        message: worker
          ? 'Browser login can be attempted on this host'
          : 'No browser on this host. Set BROWSER_WORKER_URL or run with Chromium. On Render free use manual credentials + console JS.',
      });
    }

    if (pathname === '/api/browser-login/start' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const worker = process.env.BROWSER_WORKER_URL;
      if (!worker) {
        return sendJson(res, 501, {
          ok: false,
          error:
            'Browser login is not available on this deploy (no BROWSER_WORKER_URL / Chromium). Open the provider site, log in, then use Copy console JS or Application → Cookies and paste under Credentials.',
        });
      }
      try {
        const r = await fetch(String(worker).replace(/\/$/, '') + '/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (process.env.BROWSER_WORKER_KEY || ''),
          },
          body: JSON.stringify({ provider: body.provider }),
        });
        const j = await r.json().catch(() => ({}));
        return sendJson(res, r.status, j);
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: e.message || String(e) });
      }
    }

    if (pathname === '/api/admin/connections' && req.method === 'GET') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      return sendJson(res, 200, connections.readConnections());
    }

    if (pathname === '/api/admin/connections' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (!body.id) return sendJson(res, 400, { error: 'id required' });
      connections.setConnection(body.id, body);
      // persist full blob via config save
      await config.saveFromAdmin({ PROVIDER_CONNECTIONS: process.env.PROVIDER_CONNECTIONS || '{}' });
      return sendJson(res, 200, connections.readConnections());
    }

    if (pathname === '/api/admin/test' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const model = body.model || body.provider || 'pollinations';
      try {
        const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
            max_tokens: 16,
          }),
        });
        const text = await r.text();
        let j = null;
        try { j = JSON.parse(text); } catch {}
        const content =
          j?.choices?.[0]?.message?.content ||
          j?.choices?.[0]?.delta?.content ||
          text.slice(0, 300);
        return sendJson(res, 200, {
          ok: r.ok,
          status: r.status,
          model,
          content: String(content).slice(0, 500),
          error: r.ok ? null : (j?.error?.message || text.slice(0, 200)),
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message || String(e) });
      }
    }


    
    if (pathname === '/api/proxy-pool' && req.method === 'GET') {
      return sendJson(res, 200, proxyPool ? proxyPool.stats() : { enabled: false });
    }
    if (pathname === '/api/proxy-pool/refresh' && req.method === 'POST') {
      if (proxyPool && proxyPool.refresh) await proxyPool.refresh(true);
      return sendJson(res, 200, proxyPool ? proxyPool.stats() : {});
    }

    if (pathname === '/health' || pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        ...config.getPublicProviders(),
        proxyPool: proxyPool && proxyPool.stats ? proxyPool.stats() : null,
        admin: '/admin',
      });
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
      return sendJson(res, 200, {
        object: 'list',
        data: collectModels({ includeUnconfigured: all }),
      });
    }

    if (pathname === '/v1/images/generations' && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try {
        opts = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const im = String(opts.model || opts.provider || '').toLowerCase();
      if (im.includes('pollinations') || im.includes('flux') || im === 'pollinations/image' || im === '') {
        if (webMedia && webMedia.handlePollinationsImage && (im.includes('pollinations') || im.includes('flux') || !im)) {
          // only default to pollinations when model empty or pollinations/flux
          if (im.includes('pollinations') || im.includes('flux')) {
            return webMedia.handlePollinationsImage(opts, res);
          }
        }
      }
      if ((im.startsWith('perchance') || im === 't2i') && perchanceProxy && perchanceProxy.handleImage) {
        return perchanceProxy.handleImage(opts, res);
      }
      if ((im.startsWith('uc') || im === 'glm-image') && ucProxy && ucProxy.handleImage) {
        return ucProxy.handleImage(opts, res);
      }
      if (webMedia && webMedia.handlePollinationsImage && (im.includes('pollinations') || im.includes('flux') || im === 'image')) {
        return webMedia.handlePollinationsImage(opts, res);
      }
      // free default: pollinations image
      if (webMedia && webMedia.handlePollinationsImage && !im) {
        return webMedia.handlePollinationsImage(opts, res);
      }
      if (webMedia && webMedia.handlePollinationsImage) return webMedia.handlePollinationsImage(opts, res);
      if (perchanceProxy && perchanceProxy.handleImage) return perchanceProxy.handleImage(opts, res);
      if (ucProxy && ucProxy.handleImage) return ucProxy.handleImage(opts, res);
      return sendJson(res, 503, { error: 'image provider unavailable' });
    }

    // 9router / OmniRoute compatible web search
    if ((pathname === '/v1/search' || pathname === '/v1/web/search') && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try { opts = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (!webMedia) return sendJson(res, 503, { error: 'web media module missing' });
      return webMedia.handleSearch(opts, res);
    }

    // web fetch
    if ((pathname === '/v1/web/fetch' || pathname === '/v1/fetch') && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try { opts = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (!webMedia) return sendJson(res, 503, { error: 'web media module missing' });
      return webMedia.handleFetch(opts, res);
    }

    // video generation
    if ((pathname === '/v1/videos/generations' || pathname === '/v1/video/generations') && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try { opts = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (!webMedia) return sendJson(res, 503, { error: 'web media module missing' });
      return webMedia.handleVideo(opts, res);
    }

    // model catalogs for agents (9router style)
    if (pathname === '/v1/models/web' && req.method === 'GET') {
      return sendJson(res, 200, webMedia ? webMedia.listModels('web') : { object: 'list', data: [] });
    }
    if (pathname === '/v1/models/image' && req.method === 'GET') {
      return sendJson(res, 200, webMedia ? webMedia.listModels('image') : { object: 'list', data: [] });
    }
    if (pathname === '/v1/models/video' && req.method === 'GET') {
      return sendJson(res, 200, webMedia ? webMedia.listModels('video') : { object: 'list', data: [] });
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try {
        opts = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      if (opts.model && String(opts.model).toLowerCase().startsWith('myproxy/')) {
        opts.model = String(opts.model).slice('myproxy/'.length);
      }
      const proxy = routeProxy(opts.model);
      if (!proxy) return sendJson(res, 503, { error: 'no upstream for model' });
      return proxy(opts, res);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[request]', err && err.message ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal' });
    }
  }
});

async function main() {
  try {
    await config.bootstrap();
  } catch (err) {
    console.error('[config] bootstrap error', err && err.message ? err.message : err);
  }
  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => {
    console.log(
      `proxy on ${PORT} · admin /admin · redis=${config.redisConfigured() ? 'on' : 'off'} · providers loaded`
    );
  });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
