'use strict';
/**
 * OpenCode Free → OpenAI SSE
 * Base: https://opencode.ai/inference/openai/v1
 * Auth: Bearer public (free lane). May 429 FreeUsageLimitError per IP.
 */
const crypto = require('crypto');

const BASE = (process.env.OPENCODE_URL || 'https://opencode.ai').replace(/\/$/, '');
const CHAT_URL = `${BASE}/inference/openai/v1/chat/completions`;
const OPENCODE_UA = 'opencode/1.18.31';
const OPENCODE_CLIENT = 'desktop';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const MODELS = [
  { slug: 'opencode', id: 'big-pickle' },
  { slug: 'opencode-big-pickle', id: 'big-pickle' },
  { slug: 'big-pickle', id: 'big-pickle' },
  { slug: 'opencode-beam', id: 'beam-free' },
  { slug: 'beam-free', id: 'beam-free' },
  { slug: 'opencode-flint', id: 'flint-40b-free' },
  { slug: 'flint-40b-free', id: 'flint-40b-free' },
  { slug: 'opencode-mimo', id: 'mimo-v2.6-flash-free' },
  { slug: 'mimo-v2.6-flash-free', id: 'mimo-v2.6-flash-free' },
  { slug: 'opencode-deepseek', id: 'deepseek-v4.1-flash-free' },
  { slug: 'deepseek-v4.1-flash-free', id: 'deepseek-v4.1-flash-free' },
  { slug: 'opencode-glm', id: 'glm-5.3-flash-free' },
  { slug: 'glm-5.3-flash-free', id: 'glm-5.3-flash-free' },
  { slug: 'opencode-nemotron', id: 'nemotron-3.5-lightning-free' },
  { slug: 'nemotron-3.5-lightning-free', id: 'nemotron-3.5-lightning-free' },
  { slug: 'nemotron-3.5-super-vl-free', id: 'nemotron-3.5-super-vl-free' },
];

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id, object: 'chat.completion', choices: [] }));
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
module.exports = handle;
