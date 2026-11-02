'use strict';
/**
 * OpenCode Free → OpenAI SSE
 * No user API key — Authorization: Bearer public
 * May 403 FreeTierError without browser-like TLS (wreq). Best-effort on Render.
 */
const crypto = require('crypto');

const BASE = process.env.OPENCODE_URL || 'https://opencode.ai';
const CHAT_URL = `${BASE}/inference/v1/chat/completions`;
const OPENCODE_UA = 'opencode/1.18.31';
const OPENCODE_CLIENT = 'desktop';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const MODELS = [
  { slug: 'opencode', id: 'muse-spark-1.3-contributor-free' },
  { slug: 'opencode-muse', id: 'muse-spark-1.3-contributor-free' },
  { slug: 'opencode-muse-1.2', id: 'muse-spark-1.2-contributor-free' },
  { slug: 'opencode-union', id: 'union-alpha' },
];

function modelInfo(name) {
  const m = String(name || '').toLowerCase().replace(/^opencode\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function enabled() {
  return process.env.OPENCODE_ENABLED !== '0';
}

function generateSessionId() {
  const time = Date.now();
  const counter = Math.floor(Math.random() * 8);
  const mask = (1n << 48n) - 1n;
  const prefix = (~(BigInt(time) * 0x1000n + BigInt(counter)) & mask).toString(16).padStart(12, '0');
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
    temperature: opts.temperature,
  };

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
      throw new Error(`OpenCode ${r.status}: ${t.slice(0, 220)}`);
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
                '\n\n[Error: OpenCode empty/403 — free tier often requires browser TLS (wreq). Try from a VPS or use another provider.]',
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
