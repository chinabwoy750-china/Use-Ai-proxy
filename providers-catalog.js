'use strict';
/**
 * Shared provider catalog for /admin, /providers, and console scrapers.
 */
const fs = require('fs');
const path = require('path');
const iconLib = require('./icon-library');

const ICONS_DIR = path.join(__dirname, 'public', 'icons');
const ICON_LINKS_PATH = path.join(ICONS_DIR, '_links.json');

/** Durable overrides (Redis/env) — survive Render redeploys */
function readIconOverrides() {
  try {
    const raw = process.env.PROVIDER_ICON_OVERRIDES || '';
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeIconOverrides(obj) {
  const next = obj && typeof obj === 'object' ? obj : {};
  process.env.PROVIDER_ICON_OVERRIDES = JSON.stringify(next);
  // best-effort persist via config-store (async fire-and-forget)
  try {
    const config = require('./config-store');
    if (config.saveFromAdmin) {
      Promise.resolve(config.saveFromAdmin({ PROVIDER_ICON_OVERRIDES: process.env.PROVIDER_ICON_OVERRIDES })).catch(() => {});
    }
  } catch (_) {}
  return next;
}


const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', color: '#4D6BFE', text: 'DS', site: 'https://chat.deepseek.com', models: 'deepseek-chat, deepseek-reasoner', scraper: 'deepseek' },
  { id: 'kimi', name: 'Kimi / Moonshot', color: '#1A1A1A', text: 'Ki', site: 'https://www.kimi.ai', models: 'kimi, kimi-k2', scraper: 'kimi' },
  { id: 'perplexity', name: 'Perplexity Web', color: '#20808D', text: 'Px', site: 'https://www.perplexity.ai', models: 'pplx-*, perplexity', scraper: 'perplexity' },
  { id: 'grok', name: 'Grok Web', color: '#1DA1F2', text: 'Gk', site: 'https://grok.com', models: 'grok', scraper: 'cookie' },
  { id: 'uc', name: 'UC / uncensored.com', color: '#7C3AED', text: 'UC', site: 'https://uncensored.com', models: 'uc-*, glm-image', scraper: 'uc' },
  { id: 'mistral', name: 'Mistral / Codestral', color: '#F7D046', text: 'M', site: 'https://console.mistral.ai', models: 'codestral, mistral-*', scraper: 'none' },
  { id: 'huggingface', name: 'Hugging Face', color: '#FFD21E', text: 'HF', site: 'https://huggingface.co/chat', models: 'hf / omni', scraper: 'hf' },
  { id: 'opencode', name: 'OpenCode Free', color: '#E87040', text: 'OC', site: 'https://opencode.ai', models: 'opencode', scraper: 'none' },
  { id: 'notrack', name: 'NoTrack Web', color: '#22C55E', text: 'NT', site: 'https://notrack.ai', models: 'notrack', scraper: 'cookie' },
  { id: 't3', name: 't3.chat', color: '#A78BFA', text: 'T3', site: 'https://t3.chat', models: 't3', scraper: 'cookie' },
  { id: 'venice', name: 'Venice Web', color: '#0EA5E9', text: 'V', site: 'https://venice.ai', models: 'venice', scraper: 'cookie' },
  { id: 'poe', name: 'Poe Web', color: '#5B21B6', text: 'Poe', site: 'https://poe.com', models: 'poe', scraper: 'poe' },
  { id: 'arena', name: 'Arena.ai', color: '#F97316', text: 'Ar', site: 'https://arena.ai', models: 'arena', scraper: 'cookie' },
  { id: 'zenmux', name: 'ZenMux Free', color: '#14B8A6', text: 'ZX', site: 'https://zenmux.ai', models: 'zenmux', scraper: 'cookie' },
  { id: 'blackbox', name: 'Blackbox Web', color: '#111827', text: 'BB', site: 'https://app.blackbox.ai', models: 'blackbox', scraper: 'cookie' },
  { id: 'inner', name: 'Inner.ai', color: '#EC4899', text: 'In', site: 'https://app.innerai.com', models: 'inner', scraper: 'cookie' },
  { id: 'adapta', name: 'Adapta Web', color: '#6366F1', text: 'Ad', site: 'https://agent.adapta.one', models: 'adapta', scraper: 'cookie' },
  { id: 'muse', name: 'Meta AI / Muse', color: '#0668E1', text: 'Me', site: 'https://www.meta.ai', models: 'muse, meta-ai', scraper: 'cookie' },
  { id: 'tinycms', name: 'TinyCMS / FreeGPT', color: '#84CC16', text: 'TC', site: 'https://gov.freegpt.win', models: 'tinycms', scraper: 'cookie' },
  { id: 'maxai', name: 'MaxAI', color: '#F43F5E', text: 'Mx', site: 'https://www.maxai.co', models: 'maxai', scraper: 'cookie' },
  { id: 'pollinations', name: 'Pollinations', color: '#F59E0B', text: 'Po', site: 'https://pollinations.ai', models: 'pollinations', scraper: 'none' },
  { id: 'doubao', name: 'Doubao / Dola', color: '#3B82F6', text: 'Db', site: 'https://www.dola.com', models: 'doubao', scraper: 'cookie' },
  { id: 'zai', name: 'Z.ai Web', color: '#8B5CF6', text: 'Z', site: 'https://chat.z.ai', models: 'zai', scraper: 'zai' },
  { id: 'yuanbao', name: 'Tencent Yuanbao', color: '#22C55E', text: 'Yb', site: 'https://yuanbao.tencent.com', models: 'yuanbao', scraper: 'cookie' },
  { id: 'aistudio', name: 'Tencent AI Studio', color: '#16A34A', text: 'AS', site: 'https://aistudio.tencent.ai', models: 'aistudio', scraper: 'cookie' },
  { id: 'v0', name: 'v0.dev', color: '#000000', text: 'v0', site: 'https://v0.dev', models: 'v0', scraper: 'cookie' },
  { id: 'notion', name: 'Notion AI', color: '#111111', text: 'No', site: 'https://www.notion.so', models: 'notion', scraper: 'cookie' },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', color: '#F97316', text: 'CF', site: 'https://dash.cloudflare.com', models: 'cloudflare', scraper: 'none' },
  { id: 'longcat', name: 'LongCat', color: '#06B6D4', text: 'LC', site: 'https://longcat.chat', models: 'longcat', scraper: 'none' },
  { id: 'promptql', name: 'PromptQL', color: '#7C3AED', text: 'PQ', site: 'https://prompt.ql.app', models: 'promptql', scraper: 'bearer' },
  { id: 'hyperagent', name: 'HyperAgent', color: '#0F766E', text: 'HA', site: 'https://hyperagent.com', models: 'hyperagent', scraper: 'cookie' },
  { id: 'conol', name: 'Conol', color: '#BE185D', text: 'Co', site: 'https://conol.ai', models: 'conol', scraper: 'cookie' },
  { id: 'twinmind', name: 'Twinmind', color: '#1D4ED8', text: 'TM', site: 'https://app.twinmind.com', models: 'twinmind', scraper: 'bearer' },
  { id: 'syntx', name: 'SYNTX.ai', color: '#B45309', text: 'SX', site: 'https://syntx.ai', models: 'syntx', scraper: 'bearer' },
  { id: 'veo', name: 'Veo Free', color: '#EA4335', text: 'V', site: 'https://veoaifree.com', models: 'veo', scraper: 'none' },
];

/** DevTools console scrapers — copy() so values land on clipboard */
const SCRAPERS = {
  perplexity: `(() => {
  console.log('%cHttpOnly: use Application → Cookies → __Secure-next-auth.session-token', 'color:#e3b341');
  copy('__Secure-next-auth.session-token=');
  console.log('Paste the token VALUE after = then put the full string in PERPLEXITY_COOKIE');
  return document.cookie;
})()`,
  deepseek: `(() => {
  const token = localStorage.getItem('userToken')
    || localStorage.getItem('token')
    || Object.entries(localStorage).find(([k]) => /token/i.test(k))?.[1]
    || '';
  const cookie = document.cookie || '';
  const out = {
    DEEPSEEK_URL: location.origin,
    DEEPSEEK_TOKEN: String(token || '').replace(/^Bearer\\s+/i, ''),
    DEEPSEEK_COOKIE: cookie,
  };
  console.log(out);
  copy(JSON.stringify(out, null, 2));
  console.log('%cCopied DeepSeek token + cookie JSON', 'color:#4D6BFE');
  return out;
})()`,

  kimi: `(() => {
  let access = '', refresh = '';
  try {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (/access/i.test(k) && v.startsWith('eyJ')) access = v;
      if (/refresh/i.test(k) && v.startsWith('eyJ')) refresh = v;
    }
    for (const k of Object.keys(sessionStorage)) {
      const v = sessionStorage.getItem(k) || '';
      if (!access && /access/i.test(k) && v.startsWith('eyJ')) access = v;
      if (!refresh && /refresh/i.test(k) && v.startsWith('eyJ')) refresh = v;
    }
  } catch {}
  const cookie = document.cookie || '';
  const out = {
    KIMI_URL: location.origin.includes('kimi.com') && !location.origin.includes('kimi.ai')
      ? 'https://www.kimi.com' : 'https://www.kimi.ai',
    KIMI_TOKEN: access,
    KIMI_REFRESH_TOKEN: refresh,
    KIMI_COOKIE: cookie,
  };
  console.log(out);
  copy(JSON.stringify(out, null, 2));
  console.log('%cCopied Kimi tokens JSON', 'color:#56d364');
  return out;
})()`,

  cookie: `(() => {
  const cookie = document.cookie || '';
  console.log({ cookie, length: cookie.length });
  copy(cookie);
  console.log('%cCopied document.cookie (note: HttpOnly cookies are NOT included)', 'color:#e3b341');
  console.log('For HttpOnly values open DevTools → Application → Cookies → copy name=value pairs manually.');
  return cookie;
})()`,

  uc: `(() => {
  const all = document.cookie || '';
  const need = ['__client', '__session', '__client_uat'];
  const parts = all.split(';').map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) map[p.slice(0, i)] = p.slice(i + 1);
  }
  // HttpOnly __client will be missing from document.cookie
  const out = {
    UC_COOKIE: all,
    has___client: '__client' in map,
    note: '__client is usually HttpOnly — copy it from Application → Cookies if missing',
  };
  console.log(out);
  copy(all);
  console.log('%cCopied visible cookies. Ensure __client is present for UC.', 'color:#7C3AED');
  return out;
})()`,

  hf: `(() => {
  const raw = document.cookie || '';
  const hf = raw.split(';').map(s => s.trim()).find(s => s.startsWith('hf-chat='));
  const val = hf ? hf.split('=').slice(1).join('=') : '';
  console.log({ 'hf-chat': val });
  copy(val || raw);
  console.log('%cCopied hf-chat cookie value', 'color:#FFD21E');
  return val || raw;
})()`,

  poe: `(() => {
  const raw = document.cookie || '';
  const pb = raw.split(';').map(s => s.trim()).find(s => s.startsWith('p-b='));
  const out = pb || raw;
  console.log({ cookie: out });
  copy(out);
  console.log('%cCopied Poe p-b cookie', 'color:#5B21B6');
  return out;
})()`,

  zai: `(() => {
  let token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  for (const k of Object.keys(localStorage)) {
    const v = localStorage.getItem(k) || '';
    if (!token && /token/i.test(k) && v.length > 20) token = v;
  }
  const cookie = document.cookie || '';
  const out = { ZAI_TOKEN: token, ZAI_COOKIE: cookie };
  console.log(out);
  copy(JSON.stringify(out, null, 2));
  console.log('%cCopied Z.ai token/cookie JSON', 'color:#8B5CF6');
  return out;
})()`,

  bearer: `(() => {
  console.log('%cOpen Network tab → pick an API request → Request Headers → Authorization: Bearer …', 'color:#3d7dff');
  console.log('Or try localStorage:');
  const found = {};
  for (const k of Object.keys(localStorage)) {
    const v = localStorage.getItem(k) || '';
    if (/token|jwt|auth/i.test(k) || v.startsWith('eyJ')) found[k] = v.slice(0, 80) + (v.length > 80 ? '…' : '');
  }
  console.table(found);
  const first = Object.entries(localStorage).find(([, v]) => String(v).startsWith('eyJ'));
  if (first) {
    copy(String(first[1]).replace(/^Bearer\\s+/i, ''));
    console.log('%cCopied JWT from localStorage key: ' + first[0], 'color:#56d364');
  } else {
    console.log('No JWT in localStorage — copy Bearer token from Network headers manually.');
  }
})()`,

  none: `(() => {
  console.log('This provider uses an API key from its dashboard, not a browser session.');
  console.log('Paste the key into the admin field directly.');
})()`,
};

function scraperFor(provider) {
  const kind = (provider && provider.scraper) || 'cookie';
  return SCRAPERS[kind] || SCRAPERS.cookie;
}


function listIconLinks() {
  const fromDisk = {};
  try {
    if (fs.existsSync(ICON_LINKS_PATH)) {
      const j = JSON.parse(fs.readFileSync(ICON_LINKS_PATH, 'utf8'));
      if (j && typeof j === 'object') Object.assign(fromDisk, j);
    }
  } catch {}
  // Redis/env overrides win over disk
  return { ...fromDisk, ...readIconOverrides() };
}

function saveIconLink(id, url) {
  const safe = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safe) throw new Error('bad id');
  const u = String(url || '').trim();
  if (!u) throw new Error('url required');
  if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
    throw new Error('url must be http(s) or data:image');
  }
  try {
    if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
    const disk = {};
    try {
      if (fs.existsSync(ICON_LINKS_PATH)) Object.assign(disk, JSON.parse(fs.readFileSync(ICON_LINKS_PATH, 'utf8')));
    } catch {}
    disk[safe] = u;
    fs.writeFileSync(ICON_LINKS_PATH, JSON.stringify(disk, null, 2));
  } catch (_) {}
  const all = readIconOverrides();
  all[safe] = u;
  writeIconOverrides(all);
  return u;
}

function resolveIcons() {
  const files = listIconFiles();
  const links = listIconLinks();
  const library = iconLib.buildLibraryIcons(PROVIDERS);
  // priority: durable overrides / uploads > disk files > CDN library
  return { ...library, ...files, ...links };
}

function iconCandidatesFor(id) {
  const p = PROVIDERS.find((x) => x.id === id) || {};
  return iconLib.iconCandidates(id, { site: p.site });
}

function listIconFiles() {
  const out = {};
  try {
    if (!fs.existsSync(ICONS_DIR)) return out;
    for (const name of fs.readdirSync(ICONS_DIR)) {
      const m = name.match(/^([a-z0-9_-]+)\.(png|svg|webp|jpg|jpeg)$/i);
      if (!m) continue;
      out[m[1].toLowerCase()] = '/icons/' + name;
    }
  } catch (_) {}
  return out;
}

function saveIcon(id, mime, base64Data) {
  const safe = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safe) throw new Error('bad id');
  const map = {
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
  };
  const ext = map[mime] || 'png';
  const raw = String(base64Data).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > 1.5 * 1024 * 1024) throw new Error('icon too large (max 1.5MB)');
  // Prefer durable data-URI in Redis (survives redeploy). Also write disk for local/dev.
  const dataUri = 'data:' + (mime || 'image/png') + ';base64,' + raw;
  if (buf.length > 350000) {
    // large files: disk only (Redis limit); warn by still saving link if possible
    try {
      if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
      for (const e of ['png', 'svg', 'webp', 'jpg', 'jpeg']) {
        const p = path.join(ICONS_DIR, safe + '.' + e);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
      }
      fs.writeFileSync(path.join(ICONS_DIR, safe + '.' + ext), buf);
    } catch (e) {
      throw new Error('upload failed: ' + (e.message || e));
    }
    // store path reference (ephemeral on Render — prefer smaller icons or URL links)
    const url = '/icons/' + safe + '.' + ext;
    const all = readIconOverrides();
    all[safe] = url;
    writeIconOverrides(all);
    return url;
  }
  const all = readIconOverrides();
  all[safe] = dataUri;
  writeIconOverrides(all);
  try {
    if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ICONS_DIR, safe + '.' + ext), buf);
  } catch (_) {}
  return dataUri;
}

module.exports = {
  PROVIDERS,
  SCRAPERS,
  scraperFor,
  listIconFiles,
  listIconLinks,
  saveIconLink,
  resolveIcons,
  iconCandidatesFor,
  iconLibraryMeta: iconLib.libraryMeta,
  saveIcon,
  ICONS_DIR,
};
