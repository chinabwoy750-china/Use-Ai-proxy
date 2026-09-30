'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const tls = require('tls');
const WebSocket = require('ws');
const { SocksClient } = require('socks');

let _SPA, _HPA, _HSPA;
async function loadSPA() {
  if (!_SPA) { const m = await import('socks-proxy-agent'); _SPA = m.SocksProxyAgent; }
  return _SPA;
}
async function loadHPA() {
  if (!_HPA) { const m = await import('http-proxy-agent'); _HPA = m.HttpProxyAgent; }
  return _HPA;
}
async function loadHSPA() {
  if (!_HSPA) { const m = await import('https-proxy-agent'); _HSPA = m.HttpsProxyAgent; }
  return _HSPA;
}

function isSocksProxy(proxy) {
  return proxy && (proxy.startsWith('socks5') || proxy.startsWith('socks4'));
}
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const AUTH_BASE = 'https://api.use.ai/v1/auth';
const WS_AGENT_BASE = 'wss://agents.use.ai/agents/budget-agent';
const MODEL_PREFIX = 'gateway-';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';

const HTTP_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://use.ai/',
  'Origin': 'https://use.ai',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache',
};

const WS_OPEN_TIMEOUT = 10000;
const WS_IDLE_TIMEOUT = 300000;

const MODELS = [
  { slug: 'gpt-5-6-sol', label: 'GPT-5.6 Sol' },
  { slug: 'gpt-5-6-terra', label: 'GPT-5.6 Terra' },
  { slug: 'gpt-5-6-luna', label: 'GPT-5.6 Luna' },
  { slug: 'gpt-5-5', label: 'GPT-5.5' },
  { slug: 'gpt-5-4', label: 'GPT-5.4' },
  { slug: 'gpt-5-3', label: 'GPT-5.3' },
  { slug: 'gpt-5-1', label: 'GPT-5.1' },
  { slug: 'gpt-5', label: 'GPT-5' },
  { slug: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { slug: 'gpt-4o', label: 'GPT-4o' },
  { slug: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { slug: 'claude-sonnet-5', label: 'Sonnet 5' },
  { slug: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { slug: 'claude-opus-5', label: 'Opus 5' },
  { slug: 'claude-opus-4-8', label: 'Opus 4.8' },
  { slug: 'claude-opus-4-7', label: 'Opus 4.7' },
  { slug: 'claude-opus-4-6', label: 'Opus 4.6' },
  { slug: 'claude-opus-4-5', label: 'Opus 4.5' },
  { slug: 'claude-opus-4-1', label: 'Opus 4.1' },
  { slug: 'fable-5', label: 'Fable 5' },
  { slug: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro' },
  { slug: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { slug: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { slug: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash' },
  { slug: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { slug: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { slug: 'deepseek-r1', label: 'DeepSeek R1' },
  { slug: 'grok-4-3', label: 'Grok 4.3' },
  { slug: 'grok-4', label: 'Grok 4' },
  { slug: 'qwen-3-max', label: 'Qwen 3 Max' },
  { slug: 'qwen-3-5-397b', label: 'Qwen 3.5' },
  { slug: 'kimi-k2-6', label: 'Kimi K2.6' },
  { slug: 'kimi-k2', label: 'Kimi K2' },
  { slug: 'llama-3-3-70b-versatile', label: 'Llama 3.3' },
  { slug: 'glm-5-2', label: 'GLM 5.2' },
];

const MODEL_ALIASES = { default: 'gpt-5-6-sol', fast: 'gpt-5-6-luna', smart: 'claude-opus-4-8' };
const MODEL_SLUGS = new Set(MODELS.map(m => m.slug));

function resolveModel(name) {
  if (!name) return 'gpt-5-6-sol';
  if (MODEL_SLUGS.has(name)) return name;
  if (MODEL_ALIASES[name]) return MODEL_ALIASES[name];
  return 'gpt-5-6-sol';
}

// ── Email Generator ─────────────────────────────────────────────────────────

function randLetters(lo, hi) {
  const len = lo + Math.floor(Math.random() * (hi - lo + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
}

function genEmail() {
  // High-entropy local part — collisions force magic-link and waste a proxy attempt.
  const tag = crypto.randomUUID().replace(/-/g, '');
  const local = randLetters(6, 10) + tag.slice(0, 12);
  const domain = randLetters(6, 10) + tag.slice(12, 16);
  const tlds = ['com', 'net', 'org', 'io', 'co', 'xyz', 'info', 'dev'];
  const tld = tlds[Math.floor(Math.random() * tlds.length)];
  return `${local}@${domain}.${tld}`;
}

// ── Cookie Helpers ──────────────────────────────────────────────────────────

function parseSetCookies(headers) {
  const jar = {};
  const raw = headers['set-cookie'];
  if (!raw || !raw.length) return jar;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const cookie of list) {
    const part = cookie.split(';')[0].trim();
    const eq = part.indexOf('=');
    if (eq > 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return jar;
}

function cookieString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Proxy Pool ──────────────────────────────────────────────────────────────

// Real persistent filesystem — pool and proxy state live next to the code and
// survive restarts, no /tmp overlay.
const TMP_DIR = path.join(__dirname, '..');
const PROXIES_FILE = path.join(TMP_DIR, 'proxies.txt');
const WORKING_FILE = path.join(TMP_DIR, 'working_proxies.txt');
const BUNDLED_PROXIES_FILE = path.join(__dirname, '..', 'proxies.txt');
const POOL_STATE_FILE = path.join(TMP_DIR, 'useai-bots.txt');
const PROXY_HEALTH_FILE = path.join(TMP_DIR, 'useai-proxy-health.json');
const PROXY_REFRESH_MS = 15 * 60 * 1000;
const PROXIFLY_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt';
const PROXYSCRAPE_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=5000&status=alive';

let cachedProxies = [];
let proxiesLoaded = false;
let refreshRunning = false;
let refreshPromise = null;

function parseProxyLines(txt) {
  return txt.split('\n').map(l => l.trim()).filter(l => l && (l.startsWith('socks') || l.startsWith('http')));
}

const BUNDLED_WORKING_FILE = path.join(__dirname, '..', 'working_proxies.txt');

function loadProxies() {
  if (proxiesLoaded) return;
  proxiesLoaded = true;

  // Prefer working_proxies.txt (previously validated by test-proxies.py)
  try {
    const txt = fs.readFileSync(WORKING_FILE, 'utf-8');
    const list = parseProxyLines(txt);
    if (list.length) { cachedProxies = list; return; }
  } catch {}

  // On Vercel /tmp is wiped on each cold start, so the state file is gone.
  // Prefer the bundled validated working list over the raw scraped one — the
  // raw list is mostly dead/blocked and was the root of cold-start creation
  // failures surfacing as `all proxies failed` to users.
  if (BUNDLED_WORKING_FILE !== WORKING_FILE) {
    try {
      const txt = fs.readFileSync(BUNDLED_WORKING_FILE, 'utf-8');
      const list = parseProxyLines(txt);
      if (list.length) { cachedProxies = list; return; }
    } catch {}
  }

  // Fall back to proxies.txt
  try {
    const txt = fs.readFileSync(PROXIES_FILE, 'utf-8');
    cachedProxies = parseProxyLines(txt);
  } catch {
    cachedProxies = [];
  }

  // On Vercel /tmp is empty each cold start — fall back to the bundled repo file
  if (!cachedProxies.length && BUNDLED_PROXIES_FILE !== PROXIES_FILE) {
    try {
      const txt = fs.readFileSync(BUNDLED_PROXIES_FILE, 'utf-8');
      cachedProxies = parseProxyLines(txt);
    } catch {
      cachedProxies = [];
    }
  }

  // If still empty, trigger an async scrape immediately
  if (!cachedProxies.length) {
    refreshProxies().catch(() => {});
  }
}

async function fetchUrl(url, label) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': USER_AGENT }, timeout: 15000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error(`${label} timeout`)); });
  });
}

async function fetchProxyList() {
  const sources = [
    { url: PROXIFLY_URL, label: 'proxifly' },
    { url: PROXYSCRAPE_URL, label: 'proxyscrape' },
  ];
  for (const src of sources) {
    try {
      const raw = await fetchUrl(src.url, src.label);
      const lines = parseProxyLines(raw);
      if (lines.length) return lines;
    } catch {}
  }
  return [];
}

function pruneDeadProven() {
  const now = Date.now();
  for (let i = provenProxies.length - 1; i >= 0; i--) {
    const h = proxyHealth.get(provenProxies[i]);
    if (h && h.blocked && (h.lastOk === 0 || now - h.lastOk > 20 * 60_000)) {
      provenProxies.splice(i, 1);
    }
  }
}

function mergeValidated(working) {
  if (!working.length) return;
  // New candidates for scanning
  cachedProxies = working;
  proxiesLoaded = true;
  // Promote validated proxies into provenProxies directly (Python already tested them)
  const proven = new Set(provenProxies);
  for (const p of working) {
    if (!proven.has(p)) recordProxyResult(p, true);
  }
}

async function refreshProxies() {
  if (refreshRunning) return refreshPromise;
  refreshRunning = true;
  refreshPromise = (async () => {
    try {
      // 1. Scrape fresh proxy list (proxifly primary, proxyscrape fallback)
      const lines = await fetchProxyList();
      if (!lines.length) return;
      fs.writeFileSync(PROXIES_FILE, lines.join('\n') + '\n');

      // Load raw candidates — provenProxies from last fetch are untouched and keep working
      cachedProxies = lines;
      proxiesLoaded = true;
      pruneDeadProven();

      // 2. Validate in background via test-proxies.py — don't await, merge results when done
      {
        const { spawn } = require('child_process');
        const script = path.join(__dirname, '..', 'test-proxies.py');
        const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
        const py = spawn(pythonBin, [script], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
        py.on('close', () => {
          try {
            const txt = fs.readFileSync(WORKING_FILE, 'utf-8');
            mergeValidated(parseProxyLines(txt));
          } catch {}
        });
        py.on('error', () => {});
      }
    } catch { /* leave existing pool intact */ } finally {
      refreshRunning = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

const proxyHealth = new Map();

function getHealth(proxy) {
  let h = proxyHealth.get(proxy);
  if (!h) { h = { ok: 0, fail: 0, lastOk: 0, blocked: false, coolingUntil: 0, inUse: 0 }; proxyHealth.set(proxy, h); }
  return h;
}

function recordProxyResult(proxy, success) {
  if (!proxy) return;
  const h = getHealth(proxy);
  if (success) {
    h.ok++; h.lastOk = Date.now(); h.blocked = false; h.coolingUntil = 0;
    if (!provenProxiesSet.has(proxy)) { provenProxies.push(proxy); provenProxiesSet.add(proxy); }
  } else {
    h.fail++;
    if (h.fail >= 3 && h.ok === 0) h.blocked = true;
  }
  persistProxyHealth();
}

function cooldownProxy(proxy, ms) {
  if (!proxy) return;
  const h = getHealth(proxy);
  h.coolingUntil = Math.max(h.coolingUntil, Date.now() + ms);
  persistProxyHealth();
}

function acquireProxy(proxy) { getHealth(proxy).inUse++; }
function releaseProxy(proxy) { const h = getHealth(proxy); if (h.inUse > 0) h.inUse--; }

const PROXY_HEALTH_WRITE_MS = 500;
let proxyHealthWriteTimer = null;
function persistProxyHealth() {
  clearTimeout(proxyHealthWriteTimer);
  proxyHealthWriteTimer = setTimeout(() => {
    try {
      const health = {};
      for (const [proxy, h] of proxyHealth) {
        if (h.ok === 0 && h.fail === 0 && !h.blocked && !h.coolingUntil) continue;
        health[proxy] = { ok: h.ok, fail: h.fail, lastOk: h.lastOk, blocked: h.blocked, coolingUntil: h.coolingUntil };
      }
      fs.writeFileSync(PROXY_HEALTH_FILE, JSON.stringify({ proven: provenProxies.slice(0, 500), health }));
    } catch {}
  }, PROXY_HEALTH_WRITE_MS);
}

function loadProxyHealth() {
  try {
    const raw = fs.readFileSync(PROXY_HEALTH_FILE, 'utf-8');
    const state = JSON.parse(raw);
    const health = state.health || {};
    let restored = 0;
    for (const proxy of Object.keys(health)) {
      const h = health[proxy];
      proxyHealth.set(proxy, {
        ok: h.ok || 0, fail: h.fail || 0, lastOk: h.lastOk || 0,
        blocked: !!h.blocked, coolingUntil: h.coolingUntil || 0, inUse: 0,
      });
      restored++;
    }
    if (Array.isArray(state.proven)) {
      for (const p of state.proven) { if (typeof p === 'string' && !provenProxiesSet.has(p)) { provenProxies.push(p); provenProxiesSet.add(p); } }
    }
    if (restored) console.log(`[useai] restored ${restored} proxy health entries from ${PROXY_HEALTH_FILE}`);
  } catch {}
}

const provenProxies = [];
// Mirror of provenProxies for membership tests. Every recordProxyResult, every merge
// and every createAccount candidate filter did provenProxies.includes(p) — O(n) over
// a list that grows with the proxy pool. The array is kept because order matters
// (most-proven first); the Set only answers "is it in there".
const provenProxiesSet = new Set();

const MAX_PROXY_CONCURRENT = 2;

function pickProxy() {
  loadProxies();
  const now = Date.now();

  if (provenProxies.length) {
    // Shuffle and pick first one that isn't cooling or overloaded
    // Fisher-Yates, which is uniform by construction. sort() with a random comparator
    // gives a distribution that depends on the engine's sort algorithm rather than one
    // you can reason about — it is not necessarily badly biased, it is just not
    // guaranteed to be anything. Same cost, so prefer the one with a known property.
    const shuffled = provenProxies.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const p of shuffled) {
      const h = proxyHealth.get(p);
      if (!h) return p;
      if (h.blocked) continue;
      if (h.coolingUntil > now) continue;
      if (h.inUse >= MAX_PROXY_CONCURRENT) continue;
      return p;
    }
    // All cooling/busy — return least busy non-blocked, or undefined if everything is blocked
    const usable = shuffled.filter(p => !proxyHealth.get(p)?.blocked);
    if (!usable.length) return undefined;
    return usable.sort((a, b) => (proxyHealth.get(a)?.inUse || 0) - (proxyHealth.get(b)?.inUse || 0))[0];
  }

  if (!cachedProxies.length) return undefined;
  for (let i = 0; i < 30; i++) {
    const p = cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
    const h = proxyHealth.get(p);
    if (!h) return p;
    if (h.blocked) continue;
    if (h.coolingUntil > now) continue;
    return p;
  }
  return cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
}

// ── HTTP Fetch (SOCKS5) ─────────────────────────────────────────────────────

async function fetchWithProxy(url, options = {}, proxy) {
  let agent;
  if (proxy) {
    if (isSocksProxy(proxy)) {
      const Agent = await loadSPA();
      agent = new Agent(proxy);
    } else {
      const urlObj = new URL(url);
      if (urlObj.protocol === 'https:') {
        const Agent = await loadHSPA();
        agent = new Agent(proxy);
      } else {
        const Agent = await loadHPA();
        agent = new Agent(proxy);
      }
    }
  }
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const maxBytes = (options.maxResponseBytes || 8 * 1024 * 1024);
    let size = 0;
    let tooBig = false;
    const req = (isHttps ? https : http).request({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers,
      agent,
      rejectUnauthorized: !proxy,
    }, res => {
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          tooBig = true;
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString('utf-8');
        const headers = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        headers['set-cookie'] = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode || 200, headers, body });
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('request timeout')));
    req.on('error', err => {
      if (tooBig) return;
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── WebSocket (SOCKS5) ──────────────────────────────────────────────────────

function parseProxyUrl(proxy) {
  const url = new URL(proxy);
  return {
    host: url.hostname,
    port: parseInt(url.port),
    type: url.protocol === 'socks5:' ? 5 : 4,
    userId: url.username || undefined,
    password: url.password || undefined,
  };
}

async function connectWsViaHttp(uri, headers, proxy) {
  const urlObj = new URL(uri);
  const proxyUrl = new URL(proxy);
  const targetHost = urlObj.hostname;
  const targetPort = parseInt(urlObj.port) || 443;

  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port) || 8080,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxyUrl.username
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`).toString('base64') }
        : {},
    });

    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP CONNECT failed: ${res.statusCode}`));
        return;
      }
      proxyReq.setTimeout(0);
      const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false });
      tlsSocket.on('error', () => {});
      const ws = new WebSocket(uri, { headers, createConnection: () => tlsSocket });
      resolve(ws);
    });

    proxyReq.on('error', reject);
    proxyReq.setTimeout(10000, () => { proxyReq.destroy(new Error('CONNECT timeout')); });
    proxyReq.end();
  });
}

async function connectWsWithProxy(uri, headers, proxy) {
  if (!proxy) return new WebSocket(uri, { headers });

  if (!isSocksProxy(proxy)) return connectWsViaHttp(uri, headers, proxy);

  const urlObj = new URL(uri);
  const proxyParsed = parseProxyUrl(proxy);

  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxyParsed.host,
      port: proxyParsed.port,
      type: proxyParsed.type,
      userId: proxyParsed.userId,
      password: proxyParsed.password,
    },
    command: 'connect',
    destination: {
      host: urlObj.hostname,
      port: parseInt(urlObj.port) || 443,
    },
  });

  const tlsSocket = tls.connect({
    socket,
    servername: urlObj.hostname,
    rejectUnauthorized: false,
  });

  tlsSocket.on('error', () => {});

  return new WebSocket(uri, {
    headers,
    createConnection: () => tlsSocket,
  });
}

// ── Account Creation ────────────────────────────────────────────────────────

// Hit the main site through the same proxy to collect Cloudflare / edge cookies
// before auth + WS. Without these, agents.use.ai often returns 403 on WS open.
async function warmEdgeCookies(proxy, jar) {
  try {
    const r = await fetchWithProxy('https://use.ai/', {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      },
      maxResponseBytes: 256 * 1024,
    }, proxy);
    Object.assign(jar, parseSetCookies(r.headers));
  } catch { /* non-fatal */ }
  try {
    const r2 = await fetchWithProxy('https://agents.use.ai/', {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Origin': 'https://use.ai',
        'Referer': 'https://use.ai/',
        Cookie: cookieString(jar),
      },
      maxResponseBytes: 64 * 1024,
    }, proxy);
    Object.assign(jar, parseSetCookies(r2.headers));
  } catch { /* non-fatal */ }
}

async function tryCreateAccount(proxy) {
  // Always brand-new email. Existing accounts force magic-link and cannot be
  // signed in via credentials any more.
  const email = genEmail();
  const jar = {};

  await warmEdgeCookies(proxy, jar);

  const r1 = await fetchWithProxy(`${AUTH_BASE}/email-login`, {
    method: 'POST',
    headers: { ...HTTP_HEADERS, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ email }),
  }, proxy);
  if (r1.status >= 400) throw new Error(`email-login ${r1.status}: ${(r1.body || '').slice(0, 150)}`);
  Object.assign(jar, parseSetCookies(r1.headers));

  let r1Body = {};
  try { r1Body = JSON.parse(r1.body || '{}'); } catch {}
  // If upstream decided this email already exists, credentials will only return
  // magic_link — burn this attempt and let the caller rotate.
  if (r1Body.status === 'existing_user' || r1Body.requiresMagicLink) {
    throw new Error('email-login existing_user (magic link only)');
  }

  const guestId = crypto.randomUUID();
  const mixpanelId = crypto.randomUUID();
  const mid = crypto.randomUUID();

  const r2 = await fetchWithProxy(`${AUTH_BASE}/sign-in/credentials`, {
    method: 'POST',
    headers: { ...HTTP_HEADERS, 'Content-Type': 'application/json', Cookie: cookieString(jar) },
    body: JSON.stringify({ email, mixpanelUserId: mixpanelId, guestId, mid, turnstileBypass: true }),
  }, proxy);
  if (r2.status >= 400) throw new Error(`sign-in ${r2.status}: ${(r2.body || '').slice(0, 150)}`);
  Object.assign(jar, parseSetCookies(r2.headers));

  let r2Body = {};
  try { r2Body = JSON.parse(r2.body || '{}'); } catch {}
  if (r2Body.action === 'magic_link') {
    throw new Error('sign-in magic_link (existing user)');
  }

  // Credentials response now includes userId on success — prefer it so we do
  // not hard-fail when get-session returns null (cookie timing / CF edge).
  let userId = r2Body.userId || '';

  const s = await fetchWithProxy(`${AUTH_BASE}/get-session?disableCookieCache=true`, {
    method: 'GET',
    headers: { ...HTTP_HEADERS, Cookie: cookieString(jar) },
  }, proxy);

  if (s.status === 200 && s.body && s.body !== 'null') {
    try {
      const j = JSON.parse(s.body);
      const user = j.user || j.session?.user || {};
      userId = user.id || j.user?.id || j.session?.user?.id || userId;
    } catch {}
  }

  // Require a session cookie. Without it every downstream call 401s.
  let token = '';
  for (const [k, v] of Object.entries(jar)) {
    if (k.includes('session_token')) { token = v; break; }
  }
  if (!token) {
    // Some deployments set the token under a slightly different name; accept any
    // better-auth session cookie as proof of login.
    for (const [k, v] of Object.entries(jar)) {
      if (k.includes('better-auth') && v && v.length > 20) { token = v; break; }
    }
  }
  if (!token && !userId) {
    throw new Error(`get-session ${s.status}, body=${(s.body || '').slice(0, 200)}, no session cookie`);
  }
  if (!userId) {
    // Last resort: decode access_token JWT payload for sub/id.
    try {
      for (const [k, v] of Object.entries(jar)) {
        if (!k.includes('access_token') || !v) continue;
        const parts = decodeURIComponent(v).split('.');
        if (parts.length < 2) continue;
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        userId = payload.sub || payload.id || payload.userId || '';
        if (userId) break;
      }
    } catch {}
  }
  if (!userId) throw new Error('account created but userId missing');

  const cookieHeader = cookieString(jar);
  const wsTokens = await fetchWsTokens({ cookieHeader }, proxy).catch(() => null);
  return { email, userId, cookieHeader, token, bornAt: Date.now(), proxy, wsTokens };
}

async function testProxy(proxy) {
  const email = genEmail();
  let agent;
  if (isSocksProxy(proxy)) {
    const Agent = await loadSPA();
    agent = new Agent(proxy);
  } else {
    const Agent = await loadHSPA();
    agent = new Agent(proxy);
  }
  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${AUTH_BASE}/email-login`);
    const body = JSON.stringify({ email });
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: { ...HTTP_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      agent,
      rejectUnauthorized: false,
    }, res => {
      res.resume();
      if (res.statusCode >= 400) reject(new Error(`blocked ${res.statusCode}`));
      else resolve(true);
    });
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let scanRunning = false;
let scanStats = { tested: 0, found: 0 };

async function scanForProxies() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const batch = new Set();
    let attempts = 0;
    while (batch.size < 50 && attempts < 200) {
      attempts++;
      const p = cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
      if (proxyHealth.has(p)) continue;
      batch.add(p);
    }
    if (!batch.size) return;
    await Promise.allSettled([...batch].map(async proxy => {
      scanStats.tested++;
      try {
        await testProxy(proxy);
        recordProxyResult(proxy, true);
        scanStats.found++;
      } catch {
        recordProxyResult(proxy, false);
      }
    }));
  } finally {
    scanRunning = false;
  }
}

// Home / residential hosts: set ALLOW_DIRECT=1 so auth+WS use your real ISP IP
// instead of free datacenter proxies (which get CF 403 on agents.use.ai).
const ALLOW_DIRECT = /^(1|true|yes)$/i.test(String(process.env.ALLOW_DIRECT || ''));

async function createAccount() {
  loadProxies();

  let lastErr;

  function classifyCreateError(msg) {
    if (/429/.test(msg)) return 'rate';
    if (/403|ws blocked|Unexpected server response: 403/.test(msg)) return 'block';
    if (/existing_user|magic_link/.test(msg)) return 'email';
    if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout|socket hang up|CONNECT/.test(msg)) return 'conn';
    return 'other';
  }

  // Prefer direct path on residential hosts — no proxy needed.
  if (ALLOW_DIRECT) {
    try {
      const acct = await tryCreateAccount(null);
      return acct;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!cachedProxies.length) {
    await (refreshPromise || refreshProxies());
    if (!cachedProxies.length) {
      if (ALLOW_DIRECT && lastErr) throw lastErr;
      throw new Error('no proxies available');
    }
  }

  if (provenProxies.length) {
    const toTry = [pickProxy(), pickProxy(), pickProxy()].filter((p, i, a) => p && a.indexOf(p) === i);
    for (const proxy of toTry) {
      acquireProxy(proxy);
      try {
        const acct = await tryCreateAccount(proxy);
        recordProxyResult(proxy, true);
        return acct;
      } catch (e) {
        lastErr = e;
        const msg = e?.message || '';
        const kind = classifyCreateError(msg);
        if (kind === 'rate') cooldownProxy(proxy, 2 * 60_000);
        else if (kind === 'block') cooldownProxy(proxy, 15 * 60_000);
        else if (kind === 'email') { /* email collision — proxy is fine, just retry */ }
        else if (kind === 'conn') recordProxyResult(proxy, false);
        else recordProxyResult(proxy, false);
      } finally {
        releaseProxy(proxy);
      }
    }
  }

  const picks = new Set();
  for (let i = 0; picks.size < 8 && i < 60; i++) {
    const p = pickProxy();
    if (p) picks.add(p);
  }
  for (const proxy of picks) {
    acquireProxy(proxy);
    try {
      const acct = await tryCreateAccount(proxy);
      recordProxyResult(proxy, true);
      return acct;
    } catch (e) {
      const msg = e?.message || '';
      const kind = classifyCreateError(msg);
      if (kind === 'rate') cooldownProxy(proxy, 2 * 60_000);
      else if (kind === 'block') cooldownProxy(proxy, 15 * 60_000);
      else if (kind === 'email') { /* retry with new email */ }
      else recordProxyResult(proxy, false);
      lastErr = e;
    } finally {
      releaseProxy(proxy);
    }
  }
  throw new Error(`all proxies failed: ${lastErr?.message || 'unknown'}`);
}

// ── Account Pool ────────────────────────────────────────────────────────────

const POOL_SIZE = 100;
const POOL_MIN = 50;
const POOL_CRITICAL = 10;
const BATCH_SIZE = 10;
const MAX_CONCURRENT_FILLS = 5;

// Global cap on simultaneous upstream account creations. Without it, a pool
// stampede (empty pool + N concurrent senders) fires dozens of email-login
// requests through the same few proxies in a second, which Cloudflare answers
// with 400 and locks the proxies out — the "all proxies failed: email-login
// 400" wall. Six in-flight creations keeps fill steady without tripping it.
const MAX_CREATING = 6;
let creatingNow = 0;

async function semaphoreCreate() {
  while (creatingNow >= MAX_CREATING) await new Promise(r => setTimeout(r, 200));
  creatingNow++;
  try { return await createAccount(); }
  finally { creatingNow--; }
}

let pool = [];
let fillInProgress = 0;
let warmed = false;
let fillPromise = null;
let poolPaused = false;
let poolResumePromise = null;
let poolEverHealthy = false;
let lastFillErrors = [];
let fillStats = { attempts: 0, successes: 0, failures: 0 };
let useaiRequests = 0;
const useaiRequestTs = [];

// ── Account Pool Persistence ────────────────────────────────────────────────
//
// The account pool is otherwise in-memory only: on a warm Vercel instance the
// process can restart with an empty pool, and every account must be re-created
// through free proxies (slow, failure-prone). We persist the pool to a state
// file on every successful creation and reload it on startup so warm restarts
// reuse already-created accounts instead of re-creating them.

const POOL_STATE_MAX = 100;

function pushToPool(acct) {
  if (!acct) return;
  pool.push(acct);
  persistPool();
}

function persistPool() {
  try {
    // Only persist accounts that can be reused (full cookie header present).
    const lines = pool.slice(0, POOL_STATE_MAX).map(a => {
      const { email, userId, cookieHeader, token, bornAt, proxy } = a;
      return JSON.stringify({ email, userId, cookieHeader, token, bornAt, proxy });
    });
    fs.writeFileSync(POOL_STATE_FILE, lines.join('\n'));
  } catch {}
}

function loadPool() {
  try {
    const raw = fs.readFileSync(POOL_STATE_FILE, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    let restored = 0;
    for (const line of lines) {
      if (pool.length >= POOL_SIZE) break;
      try {
        const a = JSON.parse(line);
        if (!a || !a.cookieHeader || !a.email) continue;
        // Deliberately drop wsTokens — cached WS tokens go stale across
        // restarts; getWsTokens() refetches fresh ones at stream time.
        pool.push({ ...a, wsTokens: null });
        restored++;
      } catch {}
    }
    if (restored) console.log(`[useai] restored ${restored} accounts from ${POOL_STATE_FILE}`);
  } catch {}
}

function recordUseaiRequest() {
  useaiRequests++;
  useaiRequestTs.push(Date.now());
  if (useaiRequestTs.length > 500) useaiRequestTs.shift();
}

function useaiRequestCount(ms) {
  const cutoff = Date.now() - ms;
  return useaiRequestTs.filter(t => t >= cutoff).length;
}
let lastPoolAlert = 0;
const POOL_ALERT_COOLDOWN = 5 * 60_000;
const POOL_WEBHOOK = '';

function sendPoolAlert(reason, details) {
  if (Date.now() - lastPoolAlert < POOL_ALERT_COOLDOWN) return;
  lastPoolAlert = Date.now();
  const embed = {
    title: 'Pool Alert',
    color: 0xffaa00,
    fields: [
      { name: 'Reason', value: reason, inline: true },
      { name: 'Pool Size', value: `${pool.length} / ${POOL_SIZE}`, inline: true },
      { name: 'Details', value: details.slice(0, 1000), inline: false },
      { name: 'Stats', value: `Attempts: ${fillStats.attempts} | Success: ${fillStats.successes} | Fail: ${fillStats.failures}`, inline: false },
      { name: 'Time', value: new Date().toISOString(), inline: true },
    ],
  };
  fetch(POOL_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  }).catch(() => {});
}

async function fillPool() {
  if (fillInProgress >= MAX_CONCURRENT_FILLS) { if (fillPromise) await fillPromise; return; }
  const room = POOL_SIZE - pool.length;
  if (room <= 0) return;
  const threads = Math.min(MAX_CONCURRENT_FILLS - fillInProgress, Math.ceil(room / BATCH_SIZE));
  const promises = [];
  for (let t = 0; t < threads; t++) {
    fillInProgress++;
    const p = (async () => {
      try {
        const count = Math.min(BATCH_SIZE, POOL_SIZE - pool.length);
        if (count <= 0) return;
        const inFlight = Array.from({ length: count }, () => {
          fillStats.attempts++;
          return semaphoreCreate().then(acct => {
            if (acct) { pushToPool(acct); fillStats.successes++; }
          }).catch(e => {
            fillStats.failures++;
            const msg = e?.message || String(e);
            lastFillErrors.push({ time: Date.now(), error: msg.slice(0, 200) });
            if (lastFillErrors.length > 10) lastFillErrors.shift();
          });
        });
        await Promise.allSettled(inFlight);
      } finally {
        fillInProgress--;
        if (fillInProgress === 0) fillPromise = null;
      }
    })();
    promises.push(p);
  }
  fillPromise = Promise.all(promises);
  await fillPromise;
  if (pool.length < POOL_CRITICAL && fillStats.attempts > 10) {
    const recentErrs = lastFillErrors.slice(-3).map(e => e.error).join(' | ');
    const rate = fillStats.attempts ? Math.round(fillStats.successes / fillStats.attempts * 100) : 0;
    sendPoolAlert(pool.length === 0 ? 'Pool empty' : 'Pool critically low', `${pool.length} / ${POOL_SIZE} available\nSuccess rate: ${rate}% (${fillStats.successes}/${fillStats.attempts})\nProxies: ${cachedProxies.length}\nErrors: ${recentErrs || 'none'}`);
  }
}

function emergencyFill() {
  if (poolPaused) return;
  poolPaused = true;
  poolResumePromise = fillPool().then(() => {
    poolPaused = false;
    poolResumePromise = null;
    if (pool.length < POOL_CRITICAL) {
      fillPool().catch(() => {});
    }
  }).catch(err => {
    console.error('[useai] emergencyFill failed:', err.message);
    poolPaused = false;
    poolResumePromise = null;
  });
}

function warmPool() {
  if (warmed) return;
  warmed = true;
  loadProxies();
  // Validate immediately — the 2s setTimeout left a cold-start window on Vercel
  // where first requests rode raw, unvalidated scraped proxies.
  (async () => {
    for (let i = 0; i < 5; i++) {
      await scanForProxies().catch(() => {});
      if (provenProxies.length >= 3) break;
    }
    fillPool().catch(() => {});
  })();
  setInterval(() => {
    scanForProxies().catch(() => {});
  }, 15_000);

  // Refresh proxy pool from proxifly (proxyscrape fallback) every 15 minutes
  setInterval(() => {
    refreshProxies().catch(() => {});
  }, PROXY_REFRESH_MS);
}

// ── Silent Retry ────────────────────────────────────────────────────────────
//
// Dead/overloaded proxies are common — createAccount() burns through every
// candidate and throws `all proxies failed: <lastErr>`. When the underlying
// cause is a connection-level failure (timeout/reset/refused) a quick silent
// retry with a short backoff often finds a healthy proxy (or lets a scanned-in
// one land), instead of surfacing the error to the user immediately.

const PROXY_CONN_ERR_RE = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|connect timeout|CONNECT timeout|socket hang up|Unexpected server response|ws blocked|all proxies failed|email-login existing_user|sign-in magic_link/;

async function createAccountWithRetry(maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await createAccount();
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      // Only retry connection-level failures silently; auth/block errors are
      // deterministic and won't be fixed by another attempt.
      if (!PROXY_CONN_ERR_RE.test(msg)) break;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

const USEAI_CAPACITY_MSG = 'use.ai is at capacity right now — the account pool is refilling. Please retry in about a minute.';

let singleCreateFlight = null;
let createBlockedUntil = 0;

// Coalesced fallback creation for grabAccount: when the pool is empty, every
// concurrent sender used to spawn its own createAccountWithRetry() (3 attempts
// each), so 30 users = 90 email-login calls through the same proxies → 400
// storm → nothing created. Now one flight serves all waiters, and a failure
// parks the fallback for 20s so the fillPool loop (still running in the
// background) is the one to recover instead of a user-driven stampede.
function coalescedCreate() {
  const now = Date.now();
  if (now < createBlockedUntil) return Promise.reject(new Error(USEAI_CAPACITY_MSG));
  if (!singleCreateFlight) {
    singleCreateFlight = (async () => {
      try {
        return await createAccountWithRetry();
      } catch (e) {
        createBlockedUntil = Date.now() + 20_000;
        throw e;
      } finally {
        singleCreateFlight = null;
      }
    })();
  }
  return singleCreateFlight;
}

async function grabAccount() {
  if (poolPaused) {
    throw new Error('pool_paused');
  }
  if (pool.length < POOL_CRITICAL && poolEverHealthy) {
    emergencyFill();
    throw new Error('pool_paused');
  }
  if (!poolEverHealthy && pool.length >= POOL_CRITICAL) poolEverHealthy = true;
  if (pool.length < POOL_MIN && fillInProgress === 0) fillPool();
  if (pool.length > 0) { recordUseaiRequest(); const acct = pool.pop(); persistPool(); return acct; }
  if (fillInProgress > 0 && fillPromise) {
    await fillPromise;
    if (pool.length > 0) { recordUseaiRequest(); const acct = pool.pop(); persistPool(); return acct; }
  }
  recordUseaiRequest();
  try {
    const acct = await coalescedCreate();
    if (acct) { persistPool(); return acct; }
  } catch (e) {
    if (e?.message === USEAI_CAPACITY_MSG || /all proxies failed|email-login|sign-in|get-session/.test(e?.message || '')) {
      throw new Error(USEAI_CAPACITY_MSG);
    }
    throw e;
  }
  throw new Error(USEAI_CAPACITY_MSG);
}

// ── WebSocket Streaming ─────────────────────────────────────────────────────

function toParts(messages) {
  const out = [];
  for (const m of messages) {
    let content = (m.content || '').trim();
    if (!content && m.role !== 'user') content = '[...]';
    if (!content) continue;
    const role = m.role === 'user' || m.role === 'assistant' ? m.role : 'user';
    out.push({
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      role,
      parts: [{ type: 'text', text: content }],
      metadata: {},
    });
  }
  if (!out.length) {
    out.push({
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      role: 'user',
      parts: [{ type: 'text', text: '' }],
      metadata: {},
    });
  }
  return out;
}

function buildFrame(chatId, userId, email, model, parts) {
  return {
    chatId, userId, email,
    userType: 'regular', userEmail: email,
    planType: 'free', subscriptionStatus: 'inactive',
    isFreemium: false, isTestUser: false,
    selectedModel: MODEL_PREFIX + resolveModel(model),
    locale: 'en',
    isWebSearchMode: false, isDeepResearchMode: false, isImageGenerationMode: false,
    agenticMode: false,
    messages: parts,
    trigger: 'submit-message', source: 'chat_page',
  };
}

async function fetchWsTokens(acct, proxy) {
  const hdrs = { ...HTTP_HEADERS, Cookie: acct.cookieHeader, 'Content-Type': 'application/json' };
  const [rToken, rAttest] = await Promise.all([
    fetchWithProxy(`${AUTH_BASE}/token`, { method: 'GET', headers: hdrs }, proxy),
    fetchWithProxy(`${AUTH_BASE}/app-attestation`, { method: 'POST', headers: hdrs, body: JSON.stringify({ priorToken: '' }) }, proxy),
  ]);
  if (rToken.status !== 200) throw new Error(`token endpoint returned ${rToken.status}`);
  if (rAttest.status !== 200) throw new Error(`app-attestation returned ${rAttest.status}`);
  const tokenJson = JSON.parse(rToken.body);
  const attJson = JSON.parse(rAttest.body);
  const wsToken = tokenJson.token || '';
  const appToken = attJson.token || '';
  if (!wsToken || !appToken) throw new Error('token/app-attestation returned empty');
  return { wsToken, appToken };
}

async function getWsTokens(acct) {
  if (acct.wsTokens) return acct.wsTokens;
  return fetchWsTokens(acct, acct.proxy || null);
}

async function streamWs(acct, model, messages, onToken, onDone, onError, abortHolder) {
  const parts = toParts(messages);
  let closed = false;
  let idleTimer;
  let safetyTimer;

  try {
    const { wsToken, appToken } = await getWsTokens(acct);
    if (abortHolder?.gone) return;
    const chatId = crypto.randomUUID();

    const params = new URLSearchParams({
      token: wsToken, app_token: appToken,
      userId: acct.userId, userType: 'regular',
      userEmail: acct.email, planType: 'free', isTestUser: 'false',
    });
    const uri = `${WS_AGENT_BASE}/${chatId}?${params}`;

    async function connectWs(proxyStr, timeout = WS_OPEN_TIMEOUT) {
      const wsHeaders = {
        Cookie: acct.cookieHeader,
        Origin: 'https://use.ai',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      };
      const ws = await connectWsWithProxy(uri, wsHeaders, proxyStr);

      // Safe kill: terminate() emits "WebSocket was closed before the connection
      // was established" which becomes an unhandled 'error' and crashes Node if
      // no listener is attached. Always swallow after removeAllListeners.
      const killWs = () => {
        try {
          ws.removeAllListeners();
          ws.on('error', () => {});
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
            ws.terminate();
          }
        } catch {}
      };

      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(arg);
        };
        const timer = setTimeout(() => {
          killWs();
          settle(reject, new Error('ws open timeout'));
        }, timeout);

        ws.once('open', () => settle(resolve));
        ws.once('error', (e) => {
          killWs();
          const msg = e?.message || String(e);
          if (/closed before the connection was established/i.test(msg)) {
            settle(reject, new Error('ws open timeout'));
            return;
          }
          if (/403|401|Unexpected server response/.test(msg)) {
            settle(reject, new Error(`ws blocked: ${msg}`));
          } else {
            settle(reject, e instanceof Error ? e : new Error(msg));
          }
        });
        ws.once('unexpected-response', (req, res) => {
          // Drain body so the socket can close cleanly
          try { res.resume(); } catch {}
          killWs();
          settle(reject, new Error(`ws blocked: Unexpected server response: ${res.statusCode}`));
        });
      });
      return ws;
    }

    // Proxy first when present; ALLOW_DIRECT enables home-IP fallback / pure direct.
    let ws;
    const tryOrder = [];
    if (acct.proxy) tryOrder.push(acct.proxy);
    if (ALLOW_DIRECT) tryOrder.push(undefined); // direct
    if (!tryOrder.length) {
      throw new Error('ws blocked: no proxy on account (set ALLOW_DIRECT=1 for home IP)');
    }

    let lastWsErr;
    for (const proxyStr of tryOrder) {
      try {
        ws = await connectWs(proxyStr, 10000);
        lastWsErr = null;
        break;
      } catch (err) {
        lastWsErr = err;
        const msg = err?.message || String(err);
        if (proxyStr && /ws blocked|403|401|Unexpected server response/.test(msg)) {
          const h = getHealth(proxyStr);
          h.blocked = true;
          h.fail = (h.fail || 0) + 3;
          cooldownProxy(proxyStr, 30 * 60_000);
          recordProxyResult(proxyStr, false);
          const idx = provenProxies.indexOf(proxyStr);
          if (idx >= 0) {
            provenProxies.splice(idx, 1);
            provenProxiesSet.delete(proxyStr);
          }
        }
      }
    }
    if (!ws) throw (lastWsErr || new Error('WS connection failed'));
    if (!ws) throw new Error('WS connection failed');
    if (abortHolder?.gone) { try { ws.close(); } catch {} return; }

    if (abortHolder) {
      abortHolder.current = () => {
        if (!closed) { closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); try { ws.close(); } catch {} }
      };
    }

    let firstTokenReceived = false;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!closed) { closed = true; ws.close(); onDone(); } }, WS_IDLE_TIMEOUT);
    };
    resetIdleTimer();

    safetyTimer = setTimeout(() => { if (!closed) { closed = true; ws.close(); onDone(); } }, 10 * 60 * 1000);

    const frame = buildFrame(chatId, acct.userId, acct.email, model, parts);
    ws.send(JSON.stringify(frame));

    ws.on('message', data => {
      if (closed) return;
      const raw = data.toString();
      resetIdleTimer();
      try {
        const o = JSON.parse(raw);
        if (o.type === 'rate-limit-error') {
          closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); ws.close();
          onError(new Error('rate-limit-error: ' + (o.messageMetadata?.errorType || 'unknown')));
          return;
        }
        const chunk = o.chunk;
        if (chunk && typeof chunk === 'object') {
          if (chunk.type === 'text-delta' && chunk.delta) {
            if (!firstTokenReceived) { firstTokenReceived = true; clearTimeout(safetyTimer); }
            onToken(chunk.delta);
          } else if (chunk.type === 'finish') {
            closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); ws.close(); onDone(); return;
          } else if (chunk.delta || chunk.content) {
            if (!firstTokenReceived) { firstTokenReceived = true; clearTimeout(safetyTimer); }
            onToken(chunk.delta || chunk.content);
          }
        }
        if (o.type === 'stream-complete') {
          closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); ws.close(); onDone();
        }
      } catch {}
    });

    ws.on('close', () => { if (!closed) { closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); onDone(); } });
    ws.on('error', (err) => { if (!closed) { closed = true; clearTimeout(idleTimer); clearTimeout(safetyTimer); onError(err); } });
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Truncation Detection & Auto-Continue ────────────────────────────────────

function isTruncated(text) {
  if (!text) return false;
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  if ((trimmed.match(/```/g) || []).length % 2 !== 0) return true;
  const lastLine = trimmed.split('\n').pop().trimEnd();
  // NOTE: prose legitimately ends in ":" / "," / "{" etc., so punctuation-only
  // heuristics are dropped — they caused false-positive auto-continues that
  // duplicated/garbled output. Only structural truncation signs remain.
  if (/^(\d+\.|[-*+])\s*$/.test(lastLine)) return true;
  // HTML-specific: opening <html> tag with no closing </html>
  if (/<html[\s>]/i.test(trimmed) && !/<\/html>/i.test(trimmed)) return true;
  // Unbalanced <script> or <style> blocks
  const scriptOpen = (trimmed.match(/<script[\s>]/gi) || []).length;
  const scriptClose = (trimmed.match(/<\/script>/gi) || []).length;
  if (scriptOpen !== scriptClose) return true;
  const styleOpen = (trimmed.match(/<style[\s>]/gi) || []).length;
  const styleClose = (trimmed.match(/<\/style>/gi) || []).length;
  if (styleOpen !== styleClose) return true;
  // Line ends mid-attribute or mid-opening-tag
  if (/[=<]$/.test(lastLine)) return true;
  return false;
}

function buildContinuePrompt(fullReply, originalUserMessage) {
  const tail = fullReply.trimEnd().split('\n').slice(-25).join('\n');
  return [
    'Continue exactly from where you stopped.',
    'Do NOT restart, repeat, or summarize anything.',
    'Do NOT add any commentary.',
    'Just output the next tokens seamlessly.',
    'Resume from:',
    '',
    tail,
  ].join('\n');
}

// ── OpenAI-Compatible SSE Streaming ─────────────────────────────────────────

const MAX_AUTO_CONTINUES = 5;

function mkChunk(id, model, delta, finish = null) {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

module.exports = async function useaiProxy(opts, res) {
  let message, system_prompt, history;
  if (Array.isArray(opts.messages)) {
    const msgs = opts.messages;
    system_prompt = '';
    history = [];
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'system') {
        system_prompt = m.content || '';
      } else if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '');
        if (i === lastUserIdx) { message = text; }
        else { history.push({ role: 'user', content: text }); }
      } else if (m.role === 'assistant') {
        let text = m.content || '';
        if (!text && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          text = m.tool_calls.map(tc => { const fn = tc.function || {}; return 'Called ' + fn.name + '(' + (fn.arguments || '') + ')'; }).join(', ');
        }
        history.push({ role: 'assistant', content: text });
      } else if (m.role === 'tool') {
        history.push({ role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '') });
      }
    }
    if (message === undefined) message = '';
  } else {
    message = opts.message;
    system_prompt = opts.system_prompt;
    history = opts.history;
  }

  const model = resolveModel(opts.model);

  const wsMessages = [];
  if (system_prompt) wsMessages.push({ role: 'user', content: '[System] ' + system_prompt });
  const allHistory = Array.isArray(history) ? history : [];
  for (const m of allHistory) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    wsMessages.push({ role, content: m.content || '' });
  }
  wsMessages.push({ role: 'user', content: message || '' });

  const completionId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const committed = { value: false };
  const gotContent = { value: false };
  let fullResponse = '';
  let autoContinueCount = 0;

  const commitHeaders = () => {
    if (committed.value || res.headersSent) return;
    committed.value = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    try { res.write('data: ' + mkChunk(completionId, model, { role: 'assistant', content: '' }) + '\n\n'); } catch {}
  };

  const safeWrite = (data) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(data); } catch {}
  };

  const safeEnd = () => {
    if (res.destroyed || res.writableEnded) return;
    try { res.end(); } catch {}
  };

  const keepalive = setInterval(() => {
    if (committed.value && !res.writableEnded && !res.destroyed) { try { res.write(': keepalive\n\n'); } catch {} }
  }, 15000);

  const abortHolder = {};
  if (typeof res.on === 'function') {
    res.on('close', () => {
      clearInterval(keepalive);
      // Mark the response as gone so any in-flight grabAccount()/WS-connect
      // recursion can bail out before opening a new connection to a dead socket.
      abortHolder.gone = true;
      try { abortHolder.current?.(); } catch {}
    });
  }

  function doStream(acct, msgs, retries = 1, silentRetries = 4) {
    streamWs(
      acct, model, msgs,
      (delta) => {
        commitHeaders();
        if (!gotContent.value && acct.proxy) {
          // First token proves this proxy can open agents.use.ai WS.
          recordProxyResult(acct.proxy, true);
        }
        gotContent.value = true;
        fullResponse += delta;
        safeWrite('data: ' + mkChunk(completionId, model, { content: delta }) + '\n\n');
      },
      async () => {
        if (res.writableEnded || res.destroyed) return;
        if (!fullResponse && !gotContent.value) {
          clearInterval(keepalive);
          commitHeaders();
          safeWrite('data: ' + mkChunk(completionId, model, { content: 'Error: empty response from upstream' }) + '\n\n');
          safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
          safeWrite('data: [DONE]\n\n');
          safeEnd();
          return;
        }
        if (isTruncated(fullResponse) && autoContinueCount < MAX_AUTO_CONTINUES) {
          try {
            autoContinueCount++;
            const continueAccount = await grabAccount();
            if (res.destroyed || res.writableEnded) return;
            const continuePrompt = buildContinuePrompt(fullResponse, message || '');
            const continueMessages = [];
            if (system_prompt) continueMessages.push({ role: 'user', content: '[System] ' + system_prompt });
            for (const m of allHistory) {
              const role = m.role === 'assistant' ? 'assistant' : 'user';
              continueMessages.push({ role, content: m.content || '' });
            }
            continueMessages.push({ role: 'user', content: message || '' });
            // Send only the tail of the previous reply — resending the full
            // response bloats context on every continue and can exceed use.ai's
            // limit after a couple of auto-continue loops.
            const tailResponse = fullResponse.length > 2000 ? fullResponse.slice(-2000) : fullResponse;
            continueMessages.push({ role: 'assistant', content: tailResponse });
            continueMessages.push({ role: 'user', content: continuePrompt });
            doStream(continueAccount, continueMessages);
          } catch {
            clearInterval(keepalive);
            if (!res.writableEnded) {
              commitHeaders();
              safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
              safeWrite('data: [DONE]\n\n');
              safeEnd();
            }
          }
        } else {
          clearInterval(keepalive);
          if (!res.writableEnded) {
            commitHeaders();
            safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
            safeWrite('data: [DONE]\n\n');
            safeEnd();
          }
        }
      },
      async (err) => {
        if (res.writableEnded || res.destroyed) return;
        clearInterval(keepalive);
        const msg = err?.message || 'ws error';
        const isProxyErr = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connect timeout|ws open timeout|Unexpected server response|ws blocked|no proxy on account/.test(msg);
        const canRetry = !gotContent.value && !msg.includes('rate-limit') &&
          (retries > 0 || (isProxyErr && silentRetries > 0));
        if (canRetry) {
          try {
            const newAcct = await grabAccount();
            if (res.destroyed || res.writableEnded) return;
            doStream(
              newAcct, msgs,
              isProxyErr ? retries : retries - 1,
              isProxyErr ? silentRetries - 1 : silentRetries
            );
            return;
          } catch { /* fall through */ }
        } else if (fullResponse && !msg.includes('rate-limit')) {
          if (!res.writableEnded) {
            safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
            safeWrite('data: [DONE]\n\n');
            safeEnd();
          }
          return;
        }
        commitHeaders();
        safeWrite('data: ' + mkChunk(completionId, model, { content: '\n\nError: ' + msg }) + '\n\n');
        safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
        safeWrite('data: [DONE]\n\n');
        safeEnd();
      },
      abortHolder
    );
  }

  // SSE headers first — avoids Render/client idle timeout while grabbing accounts.
  commitHeaders();

  let firstAccount;
  try {
    firstAccount = await Promise.race([
      grabAccount(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(USEAI_CAPACITY_MSG)), 25000)),
    ]);
  } catch (err) {
    clearInterval(keepalive);
    if (err?.message === 'pool_paused') {
      safeWrite('data: ' + mkChunk(completionId, model, { content: 'Please wait for the account pool to fill up. ETA: ~2 minutes. Try again shortly.' }) + '\n\n');
      safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
      safeWrite('data: [DONE]\n\n');
      safeEnd();
      return;
    }
    safeWrite('data: ' + mkChunk(completionId, model, { content: 'Error: ' + (err?.message || 'account creation failed') }) + '\n\n');
    safeWrite('data: ' + mkChunk(completionId, model, {}, 'stop') + '\n\n');
    safeWrite('data: [DONE]\n\n');
    safeEnd();
    return;
  }

  doStream(firstAccount, wsMessages);
};

// ── Health Check ────────────────────────────────────────────────────────────

module.exports.healthCheck = async function() {
  try {
    const proxy = pickProxy();
    const r = await fetchWithProxy('https://api.use.ai/v1/auth/get-session', { method: 'GET', headers: HTTP_HEADERS }, proxy);
    return r.status < 500;
  } catch {
    return false;
  }
};

// ── Pool Stats (for frontend display) ──────────────────────────────────────

module.exports.getPoolStats = function() {
  if (pool.length < POOL_MIN && fillInProgress === 0) {
    fillPool();
  }
  const blocked = [...proxyHealth.values()].filter(h => h.blocked).length;
  const tested = proxyHealth.size;
  return {
    available: pool.length, total: POOL_SIZE, filling: fillInProgress > 0,
    stats: fillStats, recentErrors: lastFillErrors.slice(-5),
    proxies: { total: cachedProxies.length, proven: provenProxies.length, tested, blocked, scanStats },
    usage: { requests: useaiRequests, last5m: useaiRequestCount(5 * 60_000), lastHour: useaiRequestCount(60 * 60_000) },
  };
};

// ── Model List (for /v1/models) ────────────────────────────────────────────

module.exports.MODELS = MODELS;
module.exports.resolveModel = resolveModel;

// ── Warm pool on startup ────────────────────────────────────────────────────

loadPool();
loadProxyHealth();
warmPool();
