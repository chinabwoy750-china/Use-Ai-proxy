'use strict';
/**
 * Runtime config: process.env + optional data/config.json + optional Upstash Redis.
 * Priority on load: Redis (if configured) > local file > existing env.
 * Saves go to Redis (durable on Render) and local file (dev).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const REDIS_KEY = process.env.CONFIG_REDIS_KEY || 'useai-proxy:config';

const KEYS = [
  'ADMIN_PASSWORD',
  'DEEPSEEK_URL',
  'DEEPSEEK_TOKEN',
  'DEEPSEEK_COOKIE',
  'DEEPSEEK_ACCOUNTS',
  'KIMI_URL',
  'KIMI_TOKEN',
  'KIMI_REFRESH_TOKEN',
  'KIMI_REFRESH_TOKENS',
  'PERPLEXITY_COOKIE',
  'PERPLEXITY_TOKEN',
  'GROK_COOKIE',
  'UC_COOKIE',
  'MISTRAL_API_KEY',
  'MISTRAL_API_KEYS',
  'MISTRAL_COOKIE',
  'HF_CHAT_COOKIE',
  'HF_COOKIE',
  'OPENCODE_ENABLED',
  'VEO_ENABLED',
  'NOTRACK_COOKIE',
  'T3_COOKIE',
  'VENICE_COOKIE',
  'POE_COOKIE',
  'ARENA_COOKIE',
  'ZENMUX_COOKIE',
  'BLACKBOX_COOKIE',
  'INNER_COOKIE',
  'INNER_TOKEN',
  'ADAPTA_COOKIE',
  'MUSE_COOKIE',
  'META_AI_COOKIE',
  'TINYCMS_COOKIE',
  'MAXAI_COOKIE',
  'POLLINATIONS_KEY',
  'POLLINATIONS_API_KEY',
  'DOUBAO_COOKIE',
  'DOLA_COOKIE',
  'ZAI_COOKIE',
  'ZAI_TOKEN',
  'YUANBAO_COOKIE',
  'AISTUDIO_COOKIE',
  'TENCENT_AISTUDIO_COOKIE',
  'V0_COOKIE',
  'NOTION_COOKIE',
  'NOTION_TOKEN_V2',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_ACCOUNT_ID',
  'LONGCAT_API_KEY',
  'LONGCAT_KEY',
  'PROMPTQL_TOKEN',
  'PROMPTQL_JWT',
  'HYPERAGENT_COOKIE',
  'CONOL_COOKIE',
  'TWINMIND_TOKEN',
  'TWINMIND_JWT',
  'SYNTX_TOKEN',
  'SYNTX_JWT',
];

const SENSITIVE = new Set(
  KEYS.filter(
    (k) =>
      /TOKEN|COOKIE|PASSWORD|KEY|ACCOUNTS/i.test(k) &&
      k !== 'OPENCODE_ENABLED' &&
      k !== 'VEO_ENABLED'
  )
);

function redisConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Upstash ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j && Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : j;
}

async function readRedisConfig() {
  if (!redisConfigured()) return null;
  try {
    const raw = await redisCommand(['GET', REDIS_KEY]);
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    const j = JSON.parse(String(raw));
    return j && typeof j === 'object' ? j : {};
  } catch (err) {
    console.error('[config] redis GET failed:', err.message || err);
    return null;
  }
}

async function writeRedisConfig(obj) {
  if (!redisConfigured()) return false;
  const clean = {};
  for (const k of KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]) !== '') {
      clean[k] = String(obj[k]);
    }
  }
  await redisCommand(['SET', REDIS_KEY, JSON.stringify(clean)]);
  return true;
}

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function readFileConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeFileConfig(obj) {
  ensureDir();
  const clean = {};
  for (const k of KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]) !== '') {
      clean[k] = String(obj[k]);
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

function applyEnv(obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (!KEYS.includes(k)) continue;
    if (v === null || v === undefined || v === '') {
      delete process.env[k];
    } else {
      process.env[k] = String(v);
    }
  }
}

/**
 * Load order: start with env (Render dashboard), then file, then Redis wins for set keys.
 * ADMIN_PASSWORD from env is kept if Redis does not define it (so you can always boot).
 */
async function bootstrap() {
  const file = readFileConfig();
  applyEnv(file);

  const redis = await readRedisConfig();
  if (redis && typeof redis === 'object') {
    const envAdmin = process.env.ADMIN_PASSWORD;
    applyEnv(redis);
    // If Redis had no admin password but Render env does, keep env
    if (!redis.ADMIN_PASSWORD && envAdmin) {
      process.env.ADMIN_PASSWORD = envAdmin;
    }
    console.log(`[config] loaded ${Object.keys(redis).length} keys from Upstash Redis`);
  } else if (redisConfigured()) {
    console.log('[config] Upstash configured but empty or failed — using env/file');
  } else {
    console.log('[config] no Upstash — using env + local file only');
  }
  return status();
}

function status() {
  const file = readFileConfig();
  const out = {
    _meta: {
      redis: redisConfigured(),
      redisKey: REDIS_KEY,
      filePath: CONFIG_PATH,
    },
  };
  for (const k of KEYS) {
    const fromEnv = process.env[k];
    const fromFile = file[k];
    const val = fromEnv || fromFile || '';
    const configured = !!(val && String(val).trim());
    let source = 'none';
    if (fromEnv) source = redisConfigured() ? 'runtime' : 'env';
    if (!fromEnv && fromFile) source = 'file';
    out[k] = {
      configured,
      source: configured ? source : 'none',
      preview: configured ? (SENSITIVE.has(k) ? mask(val) : String(val).slice(0, 80)) : '',
    };
  }
  return out;
}

function mask(s) {
  const t = String(s);
  if (t.length <= 8) return '****';
  return t.slice(0, 4) + '…' + t.slice(-4) + ` (${t.length} chars)`;
}

function getPublicProviders() {
  return {
    deepseek: !!(process.env.DEEPSEEK_TOKEN || process.env.DEEPSEEK_ACCOUNTS),
    kimi: !!(process.env.KIMI_TOKEN || process.env.KIMI_REFRESH_TOKEN || process.env.KIMI_REFRESH_TOKENS),
    perplexity: !!(process.env.PERPLEXITY_COOKIE || process.env.PERPLEXITY_TOKEN),
    grok: !!process.env.GROK_COOKIE,
    uc: !!process.env.UC_COOKIE,
    mistral: !!(process.env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEYS || process.env.MISTRAL_COOKIE),
    huggingface: !!(process.env.HF_CHAT_COOKIE || process.env.HF_COOKIE),
    opencode: process.env.OPENCODE_ENABLED !== '0',
    veo: process.env.VEO_ENABLED !== '0',
    notrack: !!process.env.NOTRACK_COOKIE,
    t3: !!process.env.T3_COOKIE,
    venice: !!process.env.VENICE_COOKIE,
    poe: !!process.env.POE_COOKIE,
    arena: !!process.env.ARENA_COOKIE,
    zenmux: !!process.env.ZENMUX_COOKIE,
    blackbox: !!process.env.BLACKBOX_COOKIE,
    inner: !!(process.env.INNER_COOKIE || process.env.INNER_TOKEN),
    adapta: !!process.env.ADAPTA_COOKIE,
    muse: !!(process.env.MUSE_COOKIE || process.env.META_AI_COOKIE),
    tinycms: !!process.env.TINYCMS_COOKIE,
    maxai: !!process.env.MAXAI_COOKIE,
    pollinations: true,
    doubao: !!(process.env.DOUBAO_COOKIE || process.env.DOLA_COOKIE),
    zai: !!(process.env.ZAI_COOKIE || process.env.ZAI_TOKEN),
    yuanbao: !!process.env.YUANBAO_COOKIE,
    aistudio: !!(process.env.AISTUDIO_COOKIE || process.env.TENCENT_AISTUDIO_COOKIE),
    v0: !!process.env.V0_COOKIE,
    notion: !!(process.env.NOTION_COOKIE || process.env.NOTION_TOKEN_V2),
    cloudflare: !!(process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN),
    longcat: !!(process.env.LONGCAT_API_KEY || process.env.LONGCAT_KEY),
    promptql: !!(process.env.PROMPTQL_TOKEN || process.env.PROMPTQL_JWT),
    hyperagent: !!process.env.HYPERAGENT_COOKIE,
    conol: !!process.env.CONOL_COOKIE,
    twinmind: !!(process.env.TWINMIND_TOKEN || process.env.TWINMIND_JWT),
    syntx: !!(process.env.SYNTX_TOKEN || process.env.SYNTX_JWT),
    redis: redisConfigured(),
  };
}

async function saveFromAdmin(body) {
  const incoming = {};
  for (const k of KEYS) {
    if (body[k] === undefined) continue;
    if (body[k] === '' && body._clear && body._clear[k]) {
      incoming[k] = '';
      continue;
    }
    if (body[k] === '') continue;
    incoming[k] = String(body[k]);
  }

  const prevFile = readFileConfig();
  let prevRedis = {};
  try {
    prevRedis = (await readRedisConfig()) || {};
  } catch (_) {}
  const merged = { ...prevFile, ...prevRedis, ...incoming };
  for (const k of Object.keys(incoming)) {
    if (incoming[k] === '') delete merged[k];
  }

  writeFileConfig(merged);
  applyEnv(incoming);

  let redisOk = false;
  let redisError = null;
  try {
    redisOk = await writeRedisConfig(merged);
  } catch (err) {
    redisError = err.message || String(err);
    console.error('[config] redis SET failed:', redisError);
  }

  const st = status();
  st._meta = st._meta || {};
  st._meta.savedToRedis = redisOk;
  if (redisError) st._meta.redisError = redisError;
  return st;
}

function checkAdminAuth(req) {
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return {
      ok: false,
      reason:
        'ADMIN_PASSWORD not set. Set it in Render Environment (and optionally save via admin after Redis is connected).',
    };
  }
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || '';
  let token = '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  else if (auth.startsWith('Basic ')) {
    try {
      const dec = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      token = dec.split(':').slice(1).join(':') || dec;
    } catch (_) {}
  }
  try {
    if ((req.url || '').includes('token=')) {
      const q = new URL(req.url, 'http://x').searchParams.get('token');
      if (q) token = q;
    }
  } catch (_) {}
  const x = h['x-admin-token'] || h['x-admin-password'];
  if (x) token = String(x);
  if (token && token === expected) return { ok: true };
  return { ok: false, reason: 'unauthorized' };
}

module.exports = {
  KEYS,
  SENSITIVE,
  DATA_DIR,
  CONFIG_PATH,
  REDIS_KEY,
  redisConfigured,
  bootstrap,
  status,
  saveFromAdmin,
  applyEnv,
  getPublicProviders,
  checkAdminAuth,
  readFileConfig,
};
