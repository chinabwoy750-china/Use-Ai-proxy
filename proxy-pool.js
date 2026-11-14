'use strict';
/**
 * Outbound proxy pool
 *
 * Why live was 0: Render had raw=0 — no PROXY_POOL / PROXY_POOL_URL / proxies.txt on disk
 * (proxies.txt is gitignored). Fix: set PROXY_POOL_URL, or POST /api/proxy-pool/import,
 * or store list in Redis (useai-proxy:proxy-pool).
 */

const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const MAX = Math.min(Math.max(parseInt(process.env.PROXY_POOL_MAX || '60', 10) || 60, 5), 200);
const TEST_URL = process.env.PROXY_POOL_TEST_URL || 'https://api.ipify.org?format=json';
const TEST_MS = Math.min(Math.max(parseInt(process.env.PROXY_POOL_TEST_TIMEOUT_MS || '6000', 10) || 6000, 2000), 15000);
const COOLDOWN = Math.min(Math.max(parseInt(process.env.PROXY_POOL_COOLDOWN_MS || '90000', 10) || 90000, 10000), 600000);
const REDIS_KEY = process.env.PROXY_POOL_REDIS_KEY || 'useai-proxy:proxy-pool';

let live = [];
let rawList = [];
let rr = 0;
let testing = false;
let lastRefresh = 0;
let lastError = '';
let lastImport = 0;

function parseLine(line) {
  line = String(line || '').trim();
  if (!line || line.startsWith('#')) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    const parts = line.split(':');
    if (parts.length === 2) line = 'http://' + parts[0] + ':' + parts[1];
    else if (parts.length === 4)
      line = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
    else if (parts.length >= 3) line = 'http://' + parts[0] + ':' + parts[1];
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

function loadEnvList() {
  const t = process.env.PROXY_POOL || '';
  return t ? loadFromText(t.replace(/,/g, '\n')) : [];
}

async function loadRemote() {
  const url = process.env.PROXY_POOL_URL;
  if (!url) return [];
  try {
    const r = await undiciFetch(url, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) {
      lastError = 'PROXY_POOL_URL HTTP ' + r.status;
      return [];
    }
    return loadFromText(await r.text());
  } catch (e) {
    lastError = 'PROXY_POOL_URL ' + (e.message || e);
    return [];
  }
}

async function redisGet() {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return [];
  try {
    const r = await undiciFetch(`${base}/get/${encodeURIComponent(REDIS_KEY)}`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const val = j.result;
    if (!val) return [];
    return loadFromText(typeof val === 'string' ? val : String(val));
  } catch (e) {
    lastError = 'redis get ' + (e.message || e);
    return [];
  }
}

async function redisSet(text) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return false;
  try {
    await undiciFetch(`${base}/set/${encodeURIComponent(REDIS_KEY)}/${encodeURIComponent(text)}`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    });
    return true;
  } catch {
    return false;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeHttpDispatcher(proxyUrl) {
  return new ProxyAgent(proxyUrl);
}

async function testHttpProxy(proxyUrl) {
  const start = Date.now();
  try {
    const r = await undiciFetch(TEST_URL, {
      dispatcher: makeHttpDispatcher(proxyUrl),
      signal: AbortSignal.timeout(TEST_MS),
      headers: { Accept: 'application/json' },
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, latency: Date.now() - start, error: 'status ' + r.status };
    return { ok: true, latency: Date.now() - start, ip: t.slice(0, 64) };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, error: e.message || String(e) };
  }
}

async function refresh(force) {
  if (testing) return stats();
  if (!force && Date.now() - lastRefresh < 45_000) return stats();
  testing = true;
  lastError = '';
  try {
    const merged = [
      ...loadEnvList(),
      ...loadLocalFile(),
      ...(await loadRemote()),
      ...(await redisGet()),
    ];
    rawList = [...new Set(merged)];
    if (!rawList.length) {
      live = [];
      lastError =
        'No proxies loaded. Set PROXY_POOL_URL, or POST text list to /api/proxy-pool/import, or add PROXY_POOL env. proxies.txt is not deployed (gitignored).';
      lastRefresh = Date.now();
      return stats();
    }

    // HTTP only for undici path (socks need extra agent; skip for reliability)
    const httpOnes = shuffle(rawList.filter((p) => p.startsWith('http')));
    const candidates = httpOnes.slice(0, MAX * 4);
    if (!candidates.length) {
      live = [];
      lastError =
        `Loaded ${rawList.length} proxies but 0 HTTP — SOCKS-only lists cannot be used for fetch yet. Add http://host:port lines.`;
      lastRefresh = Date.now();
      return stats();
    }

    const next = [];
    let i = 0;
    const concurrency = 15;
    async function worker() {
      while (i < candidates.length && next.length < MAX) {
        const idx = i++;
        const p = candidates[idx];
        const r = await testHttpProxy(p);
        if (r.ok) {
          next.push({
            url: p,
            scheme: 'http',
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
    if (!live.length) {
      lastError = `Tested ${Math.min(candidates.length, MAX * 4)} HTTP proxies — all failed (dead free list or Render blocked). Try residential HTTP proxies.`;
    }
    lastRefresh = Date.now();
    console.log(`[proxy-pool] raw=${rawList.length} tested≈${Math.min(candidates.length, MAX * 4)} live=${live.length}`);
  } finally {
    testing = false;
  }
  return stats();
}

async function importList(text) {
  const list = loadFromText(text);
  if (!list.length) throw new Error('No valid proxy lines');
  // keep unique merge with existing
  rawList = [...new Set([...rawList, ...list])];
  const body = rawList.join('\n');
  await redisSet(body);
  // also write local if possible
  try {
    fs.writeFileSync(path.join(process.cwd(), 'proxies.txt'), body);
  } catch (_) {}
  lastImport = Date.now();
  await refresh(true);
  return stats();
}

function enabled() {
  if (process.env.PROXY_POOL_ENABLED === '0') return false;
  return live.length > 0;
}

function pick() {
  const now = Date.now();
  const usable = live.filter((p) => p.fails < 4 && now - (p.lastFail || 0) > COOLDOWN * Math.min(p.fails, 3));
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
      const r = await undiciFetch(url, {
        ...init,
        dispatcher: makeHttpDispatcher(p.url),
      });
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
    lastImport,
    lastError: lastError || null,
    hint:
      rawList.length === 0
        ? 'Import proxies: POST /api/proxy-pool/import with text body, or set PROXY_POOL_URL'
        : live.length === 0
          ? 'Proxies loaded but none passed HTTP test — need working http://host:port'
          : 'ok',
    sample: live.slice(0, 8).map((p) => ({
      url: p.url.replace(/\/\/([^:]+:)[^@]+@/, '//$1***@'),
      latency: p.latency,
      fails: p.fails,
    })),
  };
}

setTimeout(() => {
  refresh(true).catch((e) => console.warn('[proxy-pool]', e.message));
}, 2000);
setInterval(() => {
  refresh(true).catch(() => {});
}, 12 * 60 * 1000).unref?.();

module.exports = {
  refresh,
  importList,
  pick,
  report,
  fetchWithPool,
  stats,
  enabled,
  parseLine,
  loadFromText,
};
