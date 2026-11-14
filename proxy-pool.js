'use strict';
/**
 * Outbound proxy pool — rotate free/paid HTTP & SOCKS5 proxies for
 * Cloudflare-blocked upstreams (Perchance, etc.).
 *
 * Sources (first that yields URLs wins, then merged):
 *   PROXY_POOL          comma/newline separated list
 *   PROXY_POOL_FILE     path (default ./proxies.txt)
 *   PROXY_POOL_URL      remote text list URL
 *   Upstash Redis key   useai-proxy:proxy-pool (optional)
 *
 * Env:
 *   PROXY_POOL_ENABLED=1     force on (default: on if any proxies loaded)
 *   PROXY_POOL_MAX=80        max live proxies kept in memory
 *   PROXY_POOL_TEST_URL=https://httpbin.org/ip
 *   PROXY_POOL_TEST_TIMEOUT_MS=8000
 *   PROXY_POOL_COOLDOWN_MS=120000
 */

const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

let SocksProxyAgent = null;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (_) {}

const MAX = Math.min(Math.max(parseInt(process.env.PROXY_POOL_MAX || '80', 10) || 80, 5), 300);
const TEST_URL = process.env.PROXY_POOL_TEST_URL || 'https://api.ipify.org?format=json';
const TEST_MS = Math.min(Math.max(parseInt(process.env.PROXY_POOL_TEST_TIMEOUT_MS || '8000', 10) || 8000, 2000), 20000);
const COOLDOWN = Math.min(Math.max(parseInt(process.env.PROXY_POOL_COOLDOWN_MS || '120000', 10) || 120000, 10000), 600000);

/** @type {{ url: string, scheme: string, fails: number, lastOk: number, lastFail: number, latency: number }[]} */
let live = [];
let rawList = [];
let rr = 0;
let testing = false;
let lastRefresh = 0;

function parseLine(line) {
  line = String(line || '').trim();
  if (!line || line.startsWith('#')) return null;
  // host:port:user:pass → http://user:pass@host:port
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    const parts = line.split(':');
    if (parts.length === 2) line = 'http://' + parts[0] + ':' + parts[1];
    else if (parts.length === 4) line = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    else if (parts.length === 3) line = `http://${parts[0]}:${parts[1]}`; // host:port:something
  }
  try {
    const u = new URL(line);
    if (!['http:', 'https:', 'socks5:', 'socks4:', 'socks:'].includes(u.protocol)) return null;
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function loadFromText(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = parseLine(line);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function loadLocalFile() {
  const file = process.env.PROXY_POOL_FILE || path.join(process.cwd(), 'proxies.txt');
  try {
    if (fs.existsSync(file)) return loadFromText(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return [];
}

async function loadRemote() {
  const url = process.env.PROXY_POOL_URL;
  if (!url) return [];
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    return loadFromText(await r.text());
  } catch {
    return [];
  }
}

function loadEnvList() {
  const t = process.env.PROXY_POOL || '';
  if (!t) return [];
  return loadFromText(t.replace(/,/g, '\n'));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDispatcher(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol.startsWith('socks')) {
    if (!SocksProxyAgent) throw new Error('socks-proxy-agent not installed');
    // undici doesn't take socks agent directly — use agent in node http style via undici ProxyAgent only for http
    // For socks we use SocksProxyAgent with node's fetch polyfill path — undici ProxyAgent is HTTP CONNECT only
    return { type: 'socks', agent: new SocksProxyAgent(proxyUrl) };
  }
  return { type: 'http', dispatcher: new ProxyAgent(proxyUrl) };
}

async function testOne(proxyUrl) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_MS);
  try {
    const d = makeDispatcher(proxyUrl);
    let ip = '';
    if (d.type === 'http') {
      const r = await undiciFetch(TEST_URL, {
        dispatcher: d.dispatcher,
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      const t = await r.text();
      if (!r.ok) throw new Error('status ' + r.status);
      try {
        ip = JSON.parse(t).ip || '';
      } catch {
        ip = t.slice(0, 40);
      }
    } else {
      // socks via node https through agent — use undici not available; use global fetch with custom agent not in node18
      // Fallback: mark untested socks as provisional OK only if CONNECT works via quick socket — skip strict test
      const net = require('net');
      const u = new URL(proxyUrl);
      await new Promise((resolve, reject) => {
        const s = net.connect({ host: u.hostname, port: Number(u.port) || 1080 }, () => {
          s.end();
          resolve();
        });
        s.on('error', reject);
        s.setTimeout(TEST_MS, () => {
          s.destroy();
          reject(new Error('timeout'));
        });
      });
      ip = 'socks-ok';
    }
    return { ok: true, latency: Date.now() - start, ip };
  } catch (e) {
    return { ok: false, error: e.message || String(e), latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(force) {
  if (testing) return;
  if (!force && Date.now() - lastRefresh < 60_000) return;
  testing = true;
  try {
    const merged = [
      ...loadEnvList(),
      ...loadLocalFile(),
      ...(await loadRemote()),
    ];
    const uniq = [...new Set(merged)];
    rawList = uniq;
    if (!uniq.length) {
      live = [];
      lastRefresh = Date.now();
      return;
    }
    // Prefer http proxies for undici reliability; sample socks
    const httpOnes = shuffle(uniq.filter((p) => p.startsWith('http')));
    const socksOnes = shuffle(uniq.filter((p) => p.startsWith('socks')));
    const candidates = [...httpOnes.slice(0, MAX * 2), ...socksOnes.slice(0, Math.floor(MAX / 2))];
    const next = [];
    // parallel test limited concurrency
    const queue = candidates.slice(0, MAX * 3);
    const concurrency = 12;
    let i = 0;
    async function worker() {
      while (i < queue.length && next.length < MAX) {
        const idx = i++;
        const p = queue[idx];
        const r = await testOne(p);
        if (r.ok) {
          next.push({
            url: p,
            scheme: p.split(':')[0],
            fails: 0,
            lastOk: Date.now(),
            lastFail: 0,
            latency: r.latency,
          });
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    live = next.sort((a, b) => a.latency - b.latency);
    lastRefresh = Date.now();
    console.log(
      `[proxy-pool] loaded ${uniq.length} candidates, live=${live.length} (http=${live.filter((x) => x.scheme === 'http').length})`
    );
  } finally {
    testing = false;
  }
}

function enabled() {
  if (process.env.PROXY_POOL_ENABLED === '0') return false;
  if (process.env.PROXY_POOL_ENABLED === '1') return true;
  return live.length > 0 || rawList.length > 0;
}

function pick() {
  const now = Date.now();
  const usable = live.filter((p) => p.fails < 3 && now - p.lastFail > COOLDOWN * Math.min(p.fails, 3));
  const pool = usable.length ? usable : live;
  if (!pool.length) return null;
  rr = (rr + 1) % pool.length;
  return pool[rr];
}

function report(proxyUrl, ok) {
  const p = live.find((x) => x.url === proxyUrl);
  if (!p) return;
  if (ok) {
    p.fails = 0;
    p.lastOk = Date.now();
  } else {
    p.fails += 1;
    p.lastFail = Date.now();
  }
}

/**
 * fetch through next proxy. Falls back to direct if pool empty/disabled.
 * opts: standard fetch RequestInit + { preferProxy: true, retries: 3 }
 */
async function fetchWithPool(url, opts = {}) {
  const retries = opts.retries != null ? opts.retries : 8;
  const prefer = opts.preferProxy !== false;
  const rotateOn = opts.rotateOnStatuses || [403, 429, 503];
  const { retries: _r, preferProxy: _p, rotateOnStatuses: _ros, ...init } = opts;

  if (!prefer || !enabled()) {
    return undiciFetch(url, init);
  }

  await refresh(false);
  let lastErr;
  let lastRes = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const p = pick();
    if (!p) break;
    try {
      const d = makeDispatcher(p.url);
      if (d.type !== 'http') {
        report(p.url, false);
        continue;
      }
      const r = await undiciFetch(url, {
        ...init,
        dispatcher: d.dispatcher,
      });
      // rate-limit / block → try next proxy
      if (rotateOn.includes(r.status)) {
        report(p.url, false);
        lastRes = r;
        continue;
      }
      report(p.url, r.status < 500);
      return r;
    } catch (e) {
      report(p.url, false);
      lastErr = e;
    }
  }
  if (lastRes) return lastRes;
  try {
    return await undiciFetch(url, init);
  } catch (e) {
    throw lastErr || e;
  }
}

function stats() {
  return {
    enabled: enabled(),
    raw: rawList.length,
    live: live.length,
    testing,
    lastRefresh,
    sample: live.slice(0, 5).map((p) => ({
      url: p.url.replace(/\/\/([^:]+:)[^@]+@/, '//$1***@'),
      latency: p.latency,
      fails: p.fails,
      scheme: p.scheme,
    })),
  };
}

// bootstrap async
setTimeout(() => {
  refresh(true).catch((e) => console.warn('[proxy-pool]', e.message));
}, 1500);
setInterval(() => {
  refresh(true).catch(() => {});
}, 15 * 60 * 1000).unref?.();

module.exports = {
  refresh,
  pick,
  report,
  fetchWithPool,
  stats,
  enabled,
  parseLine,
  loadFromText,
};
