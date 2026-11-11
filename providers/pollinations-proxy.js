'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');

// Free (anonymous tier) endpoint — no key required.
const FREE_URL = 'https://text.pollinations.ai/openai';
// Keyed endpoint, only used when POLLINATIONS_KEY is set.
const KEYED_URL = 'https://gen.pollinations.ai/v1/chat/completions';
const MODELS_URL = 'https://text.pollinations.ai/models';

// Verified against https://text.pollinations.ai/models — entries with
// tier === "anonymous" are free. Paid/keyed tiers are never exposed.
const FREE_FALLBACK = ['openai-fast'];

function buildModels(ids, aliases) {
  const list = ids.slice();
  const out = [{ slug: 'pollinations', id: list[0] }];
  for (const id of list) out.push({ slug: id, id });
  for (const [alias, id] of Object.entries(aliases || {})) {
    if (!out.some((m) => m.slug === alias)) out.push({ slug: alias, id });
  }
  return out;
}

let MODELS = buildModels(FREE_FALLBACK, { openai: 'openai-fast', 'gpt-oss': 'openai-fast' });

function modelInfo(name) {
  const m = String(name || '')
    .toLowerCase()
    .replace(/^pollinations\//, '')
    .trim();
  const hit = MODELS.find((x) => x.slug === m);
  return hit || MODELS[0];
}

const proxy = makeProxy({
  name: 'pollinations',
  models: MODELS,
  getCookie: () => envCookie('POLLINATIONS_KEY', 'POLLINATIONS_API_KEY'),
  async run(ctx) {
    const msg = lastUserText(ctx.opts.messages);
    const info = modelInfo(ctx.opts.model);
    const body = {
      model: info.id,
      messages: ctx.opts.messages || [{ role: 'user', content: msg }],
      stream: true,
      referrer: 'useai-proxy',
    };
    const urls = ctx.cookie ? [KEYED_URL, FREE_URL] : [FREE_URL];
    let lastErr = '';
    for (const url of urls) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'Mozilla/5.0',
        };
        if (ctx.cookie && url === KEYED_URL) headers.Authorization = `Bearer ${ctx.cookie}`;
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          lastErr = `${url} ${r.status} ${t.slice(0, 160)}`;
          continue;
        }
        let got = false;
        await readSseOpenAI(r, (t) => {
          got = true;
          ctx.write(t);
        });
        if (!got) ctx.write('\n\n[Error: Pollinations empty reply]');
        ctx.end();
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    throw new Error(`Pollinations failed: ${lastErr}`);
  },
});

proxy.MODELS = MODELS;

// Keep the free catalogue in sync with the live endpoint (hourly).
async function refreshFreeModels() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(MODELS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return;
    const list = await r.json();
    const free = (Array.isArray(list) ? list : []).filter(
      (m) => m && String(m.tier || '').toLowerCase() === 'anonymous'
    );
    if (!free.length) return;
    const ids = free.map((m) => String(m.name)).filter(Boolean);
    const aliases = {};
    for (const m of free) {
      for (const a of Array.isArray(m.aliases) ? m.aliases : []) {
        if (a && !ids.includes(String(a))) aliases[String(a)] = String(m.name);
      }
    }
    MODELS = buildModels(ids, aliases);
    proxy.MODELS = MODELS;
    module.exports.MODELS = MODELS;
  } catch (_) {}
}

refreshFreeModels();
setInterval(refreshFreeModels, 60 * 60 * 1000).unref();

module.exports = proxy;
module.exports.MODELS = MODELS;
module.exports.modelInfo = modelInfo;
module.exports.refreshFreeModels = refreshFreeModels;
