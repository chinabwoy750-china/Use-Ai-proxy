'use strict';
const { envCookie, makeProxy, lastUserText, readSseOpenAI } = require('../web-kit');

const BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const DEFAULT_MODELS = [
  'openrouter/auto',
  'crouton-alpha',
  'lyria-3-pro-preview',
  'openrouter/free',
];

function keys() {
  const raw =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_API_KEYS ||
    process.env.OPENROUTER_KEY ||
    '';
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const pipe = line.indexOf('|');
      if (pipe > 0) return line.slice(pipe + 1).trim();
      return line.replace(/^Bearer\s+/i, '');
    })
    .filter(Boolean);
}

let rr = 0;
function nextKey() {
  const ks = keys();
  if (!ks.length) return '';
  const useRr = /^(1|true|yes)$/i.test(String(process.env.OPENROUTER_ROUND_ROBIN || '1'));
  if (!useRr) return ks[0];
  const k = ks[rr % ks.length];
  rr += 1;
  return k;
}

module.exports = makeProxy({
  name: 'openrouter',
  models: DEFAULT_MODELS.map((slug) => ({ slug })),
  getCookie: () => keys()[0] || '',
  async run(ctx) {
    const key = nextKey();
    if (!key) throw new Error('OPENROUTER_API_KEY required');
    const model = String(ctx.opts.model || 'openrouter/auto')
      .replace(/^openrouter\//, '')
      .replace(/^or\//, '');
    const upstreamModel =
      model === 'auto' || model === 'free' || model === 'openrouter'
        ? 'openrouter/auto'
        : model;

    const body = {
      model: upstreamModel,
      messages: ctx.opts.messages || [{ role: 'user', content: lastUserText(ctx.opts.messages) }],
      stream: true,
    };
    if (ctx.opts.temperature != null) body.temperature = ctx.opts.temperature;
    if (ctx.opts.max_tokens != null) body.max_tokens = ctx.opts.max_tokens;

    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://myproxy-use.onrender.com',
        'X-Title': process.env.OPENROUTER_TITLE || 'Use-AI Proxy',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 220)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: OpenRouter empty stream]');
    ctx.end();
  },
});

module.exports.MODELS = DEFAULT_MODELS;
module.exports.keys = keys;
