'use strict';
/**
 * OpenCode Free → OpenAI SSE
 * Base: https://opencode.ai/inference/openai/v1
 * Auth: Bearer public (free lane). May 429 FreeUsageLimitError per IP.
 */
const crypto = require('crypto');

const BASE = (process.env.OPENCODE_URL || 'https://opencode.ai').replace(/\/$/, '');
const CHAT_URL = `${BASE}/inference/openai/v1/chat/completions`;
const MODELS_URL = `${BASE}/zen/v1/models`;
const OPENCODE_UA = 'opencode/1.18.31';
const OPENCODE_CLIENT = 'desktop';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Verified against https://opencode.ai/zen/v1/models — every entry below has
// cost.text.input.price === 0 and cost.text.output.price === 0. Paid models are
// never exposed. The list refreshes itself from that endpoint every 6h.
const FREE_FALLBACK = [
  'big-pickle',
  'beam-free',
  'deepseek-v4.1-flash-free',
  'flint-40b-free',
  'glm-5.3-flash-free',
  'iceman-free',
  'inkling-2-small-free',
  'longcat-2.5-free',
  'mimo-v2.6-flash-free',
  'minimax-m3.1-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
];

function buildModels(ids) {
  const list = ids.includes('big-pickle') ? ids : ['big-pickle'].concat(ids);
  return [{ slug: 'opencode', id: list[0] }].concat(list.map((id) => ({ slug: id, id })));
}

let MODELS = buildModels(FREE_FALLBACK);


function modelInfo(name) {
  const m = String(name || '')
    .toLowerCase()
    .replace(/^opencode\//, '')
    .replace(/^myproxy\//, '');
  const bySlug = MODELS.find((x) => x.slug === m);
  if (bySlug) return bySlug;
  const byId = MODELS.find((x) => x.id === m);
  if (byId) return byId;
  return { slug: m || 'opencode', id: m || 'big-pickle' };
}

function enabled() {
  return process.env.OPENCODE_ENABLED !== '0';
}

function generateSessionId() {
  const time = Date.now();
  const counter = Math.floor(Math.random() * 8);
  const mask = (1n << 48n) - 1n;
  const prefix = (~(BigInt(time) * 0x1000n + BigInt(counter)) & mask)
    .toString(16)
    .padStart(12, '0');
  let rand = '';
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) rand += BASE62[bytes[i] % 62];
  return `ses_${prefix}${rand}`;
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handle(opts, res) {
  const stream = opts.stream !== false;
  const model = String(opts.model || 'opencode');
  const info = modelInfo(model);
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const session = generateSessionId();

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    sseWrite(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  }

  if (!enabled()) {
    const msg = '\n\n[Error: OpenCode disabled — set OPENCODE_ENABLED=1]';
    if (stream) {
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }

  const body = {
    model: info.id,
    messages: opts.messages || [],
    stream: true,
    max_tokens: opts.max_tokens || 2048,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;

  try {
    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': OPENCODE_UA,
        'x-opencode-client': OPENCODE_CLIENT,
        'x-opencode-session': session,
        'x-opencode-session-id': session,
        'x-session-affinity': session,
        'x-session-id': session,
        'x-opencode-project': 'global',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`OpenCode ${r.status}: ${t.slice(0, 280)}`);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let got = false;
    let buffered = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = ev?.choices?.[0]?.delta || {};
        const content = delta.content || '';
        const reasoning = delta.reasoning_content || delta.reasoning || '';
        if (content || reasoning) got = true;
        if (!stream) {
          if (content) buffered += content;
          continue;
        }
        if (stream && (content || reasoning)) {
          const d = {};
          if (content) d.content = content;
          if (reasoning) d.reasoning_content = reasoning;
          if (delta.role) d.role = delta.role;
          sseWrite(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: d, finish_reason: null }],
          });
        }
      }
    }

    if (!got && stream) {
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              content:
                '\n\n[Error: OpenCode empty reply — free limit or upstream issue. Try big-pickle / beam-free later.]',
            },
            finish_reason: null,
          },
        ],
      });
    }

    if (stream) {
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: buffered }, finish_reason: 'stop' },
        ],
      })
    );
  } catch (err) {
    const msg = `\n\n[Error: ${err.message || err}]`;
    if (stream) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
      }
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

handle.MODELS = MODELS;

// Refresh the free catalogue in the background so /v1/models never goes stale.
// Only zero-price models are kept; a fetch failure leaves the verified list.
async function refreshFreeModels() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(MODELS_URL, {
      headers: { 'User-Agent': OPENCODE_UA, Accept: 'application/json' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return;
    const j = await r.json();
    const ids = (Array.isArray(j?.data) ? j.data : [])
      .filter((m) => {
        const p = m && m.cost && m.cost.text;
        const input = p && p.input ? Number(p.input.price) : NaN;
        const output = p && p.output ? Number(p.output.price) : NaN;
        return input === 0 && output === 0;
      })
      .map((m) => String(m.id))
      .filter(Boolean);
    if (ids.length) {
      MODELS = buildModels(ids);
      handle.MODELS = MODELS;
      module.exports.MODELS = MODELS;
    }
  } catch (_) {}
}

refreshFreeModels();
setInterval(refreshFreeModels, 6 * 60 * 60 * 1000).unref();

module.exports = handle;
module.exports.MODELS = MODELS;
module.exports.modelInfo = modelInfo;
module.exports.refreshFreeModels = refreshFreeModels;
