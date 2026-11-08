'use strict';
/**
 * Generic OpenAI-compatible upstream for free-tier API keys + custom endpoints.
 * Config via env:
 *   GENERIC_<ID>_BASE, GENERIC_<ID>_KEYS (newline or name|key)
 * Or CUSTOM_ENDPOINTS JSON: [{id,name,base,type:'openai'|'anthropic',keys:[]}]
 */
const { makeProxy, lastUserText, readSseOpenAI } = require('../web-kit');

function parseKeys(raw) {
  return String(raw || '')
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('|');
      if (i > 0) return line.slice(i + 1).trim().replace(/^Bearer\s+/i, '');
      return line.replace(/^Bearer\s+/i, '');
    })
    .filter(Boolean);
}

const rrMap = Object.create(null);
function nextKey(id, keys) {
  if (!keys.length) return '';
  const n = rrMap[id] || 0;
  rrMap[id] = n + 1;
  return keys[n % keys.length];
}

function loadCustomEndpoints() {
  try {
    const j = JSON.parse(process.env.CUSTOM_ENDPOINTS || '[]');
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

const BUILTIN = {
  openrouter: { base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEYS', models: ['openrouter/auto'] },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEYS', models: ['nvidia'] },
  ollama: { base: 'https://ollama.com/v1', env: 'OLLAMA_API_KEYS', models: ['ollama'] },
  'cloudflare-ai': { base: '', env: 'CF_API_TOKEN', models: ['cloudflare'] },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEYS', models: ['gemini'] },
  agnes: { base: process.env.AGNES_BASE || '', env: 'AGNES_API_KEYS', models: ['agnes'] },
  'api-airforce': { base: process.env.API_AIRFORCE_BASE || 'https://api.airforce/v1', env: 'API_AIRFORCE_KEYS', models: ['api-airforce'] },
  bazaarlink: { base: process.env.BAZAARLINK_BASE || '', env: 'BAZAARLINK_API_KEYS', models: ['bazaarlink'] },
  'kilo-gateway': { base: process.env.KILO_BASE || '', env: 'KILO_API_KEYS', models: ['kilo-gateway'] },
  poolside: { base: process.env.POOLSIDE_BASE || '', env: 'POOLSIDE_API_KEYS', models: ['poolside'] },
  kimchi: { base: process.env.KIMCHI_BASE || '', env: 'KIMCHI_API_KEYS', models: ['kimchi'] },
  byteplus: { base: process.env.BYTEPLUS_BASE || '', env: 'BYTEPLUS_API_KEYS', models: ['byteplus'] },
  'mimo-free': { base: process.env.MIMO_BASE || '', env: 'MIMO_API_KEYS', models: ['mimo-free'] },
};

function resolveTarget(model) {
  const m = String(model || '').toLowerCase();
  const customs = loadCustomEndpoints();
  for (const c of customs) {
    const id = String(c.id || '').toLowerCase();
    if (m === id || m.startsWith(id + '/') || m.startsWith(id + '-')) return { kind: 'custom', cfg: c };
  }
  for (const [id, cfg] of Object.entries(BUILTIN)) {
    if (m === id || m.startsWith(id + '/') || m.startsWith(id + '-') || m.startsWith(id + '_')) {
      return { kind: 'builtin', id, cfg };
    }
  }
  return null;
}

async function runOpenAICompatible({ base, key, body, headers = {}, write, end }) {
  if (!base) throw new Error('Base URL not configured for this provider');
  if (!key) throw new Error('API key required');
  const url = base.replace(/\/$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!r.ok) throw new Error(`Upstream ${r.status}: ${(await r.text()).slice(0, 220)}`);
  let got = false;
  await readSseOpenAI(r, (t) => {
    got = true;
    write(t);
  });
  if (!got) write('\n\n[Error: empty upstream stream]');
  end();
}

const proxy = makeProxy({
  name: 'generic-openai',
  models: Object.keys(BUILTIN).map((slug) => ({ slug })),
  getCookie: () => '1',
  async run(ctx) {
    const target = resolveTarget(ctx.opts.model);
    if (!target) throw new Error('Unknown generic provider model');
    const body = {
      model: ctx.opts.model,
      messages: ctx.opts.messages || [{ role: 'user', content: lastUserText(ctx.opts.messages) }],
    };
    if (ctx.opts.temperature != null) body.temperature = ctx.opts.temperature;
    if (ctx.opts.max_tokens != null) body.max_tokens = ctx.opts.max_tokens;

    if (target.kind === 'custom') {
      const c = target.cfg;
      const keys = Array.isArray(c.keys) ? c.keys : parseKeys(c.key || c.apiKey || '');
      const key = nextKey(c.id, keys);
      body.model = c.defaultModel || body.model.replace(new RegExp('^' + c.id + '[/-]'), '');
      if (c.type === 'anthropic') {
        // Map to Anthropic messages API minimally via OpenAI-compat if base supports it
        await runOpenAICompatible({
          base: c.base,
          key,
          body,
          headers: { 'anthropic-version': '2023-06-01' },
          write: ctx.write,
          end: ctx.end,
        });
        return;
      }
      await runOpenAICompatible({ base: c.base, key, body, write: ctx.write, end: ctx.end });
      return;
    }

    const { id, cfg } = target;
    const keys = parseKeys(process.env[cfg.env] || process.env[cfg.env.replace(/S$/, '')] || '');
    const key = nextKey(id, keys);
    body.model = String(ctx.opts.model).replace(new RegExp('^' + id + '[/-]'), '') || cfg.models[0];
    const headers = {};
    if (id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER || 'https://myproxy-use.onrender.com';
      headers['X-Title'] = 'Use-AI Proxy';
    }
    await runOpenAICompatible({
      base: process.env['GENERIC_' + id.toUpperCase().replace(/-/g, '_') + '_BASE'] || cfg.base,
      key,
      body,
      headers,
      write: ctx.write,
      end: ctx.end,
    });
  },
});

proxy.resolveTarget = resolveTarget;
proxy.BUILTIN = BUILTIN;
proxy.loadCustomEndpoints = loadCustomEndpoints;
module.exports = proxy;
