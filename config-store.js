'use strict';
/**
 * Runtime config: env vars + optional data/config.json override.
 * On Render free the disk is ephemeral — set env for persistence.
 * Admin can still apply live values for the current process.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

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
];

const SENSITIVE = new Set(
  KEYS.filter(
    (k) =>
      /TOKEN|COOKIE|PASSWORD|KEY|ACCOUNTS/i.test(k) && k !== 'OPENCODE_ENABLED' && k !== 'VEO_ENABLED'
  )
);

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
    if (obj[k] !== undefined && obj[k] !== null) clean[k] = String(obj[k]);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** Apply key/value into process.env (live). */
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

/** Load file config over env at startup. */
function bootstrap() {
  const file = readFileConfig();
  applyEnv(file);
  return status();
}

function status() {
  const file = readFileConfig();
  const out = {};
  for (const k of KEYS) {
    const fromEnv = process.env[k];
    const fromFile = file[k];
    const val = fromEnv || fromFile || '';
    const configured = !!(val && String(val).trim());
    out[k] = {
      configured,
      source: fromEnv ? 'env' : fromFile ? 'file' : 'none',
      preview: configured
        ? SENSITIVE.has(k)
          ? mask(val)
          : String(val).slice(0, 80)
        : '',
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
  };
}

function saveFromAdmin(body) {
  const incoming = {};
  for (const k of KEYS) {
    if (body[k] === undefined) continue;
    // empty string = clear only if explicit clear flag
    if (body[k] === '' && body._clear && body._clear[k]) {
      incoming[k] = '';
      continue;
    }
    if (body[k] === '') continue; // don't wipe secrets on partial save
    incoming[k] = String(body[k]);
  }
  const prev = readFileConfig();
  const merged = { ...prev, ...incoming };
  for (const k of Object.keys(incoming)) {
    if (incoming[k] === '') delete merged[k];
  }
  writeFileConfig(merged);
  applyEnv(incoming);
  return status();
}

function checkAdminAuth(req) {
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || '';
  if (!expected) return { ok: false, reason: 'ADMIN_PASSWORD not set' };
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
  const q = (req.url || '').includes('token=') ? new URL(req.url, 'http://x').searchParams.get('token') : null;
  if (q) token = q;
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
  bootstrap,
  status,
  saveFromAdmin,
  applyEnv,
  getPublicProviders,
  checkAdminAuth,
  readFileConfig,
};
