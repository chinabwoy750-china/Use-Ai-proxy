'use strict';
/**
 * Mistral Le Chat web proxy (chat.mistral.ai)
 *
 * Env:
 *   MISTRAL_COOKIE / MISTRAL_COOKIE_HEADER  — full Cookie header or mistral-chat-session value
 *   MISTRAL_URL   — default https://chat.mistral.ai
 *   MISTRAL_API_KEY — optional; if set, uses official api.mistral.ai instead of web (more reliable on servers)
 */
const crypto = require('crypto');

const WEB_BASE = (process.env.MISTRAL_URL || 'https://chat.mistral.ai').replace(/\/$/, '');
const API_BASE = (process.env.MISTRAL_API_URL || 'https://api.mistral.ai').replace(/\/$/, '');
const API_KEY = (process.env.MISTRAL_API_KEY || '').trim();
const ENV_COOKIE = (process.env.MISTRAL_COOKIE_HEADER || process.env.MISTRAL_COOKIE || '').trim();

const MODELS = [
  { slug: 'mistral', label: 'Mistral (default large)' },
  { slug: 'mistral-large', label: 'Mistral Large' },
  { slug: 'mistral-small', label: 'Mistral Small' },
  { slug: 'codestral', label: 'Codestral' },
  { slug: 'mistral-large-latest', label: 'mistral-large-latest' },
  { slug: 'mistral-small-latest', label: 'mistral-small-latest' },
  { slug: 'codestral-latest', label: 'codestral-latest' },
];

const MODEL_MAP = {
  mistral: 'mistral-large-latest',
  'mistral-large': 'mistral-large-latest',
  'mistral-small': 'mistral-small-latest',
  codestral: 'codestral-latest',
  'mistral-large-latest': 'mistral-large-latest',
  'mistral-small-latest': 'mistral-small-latest',
  'codestral-latest': 'codestral-latest',
};

function resolveModel(name) {
  const n = String(name || 'mistral').toLowerCase();
  return MODEL_MAP[n] || name || 'mistral-large-latest';
}

function cookieHeader() {
  const c = ENV_COOKIE;
  if (!c) return '';
  if (/mistral-chat-session\s*=/i.test(c) || c.includes(';')) return c;
  return `mistral-chat-session=${c}`;
}

function webHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept: 'application/json, text/event-stream, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: WEB_BASE,
    Referer: `${WEB_BASE}/chat`,
    Cookie: cookieHeader(),
    ...extra,
  };
}

function lastUser(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      let c = m.content;
      if (Array.isArray(c)) c = c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      return String(c || '');
    }
  }
  return '';
}

function systemPrompt(messages) {
  return (messages || [])
    .filter((m) => m.role === 'system')
    .map((m) => {
      let c = m.content;
      if (Array.isArray(c)) c = c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      return String(c || '');
    })
    .join('\n');
}

function toMessages(messages) {
  return (messages || []).map((m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: String(content || ''),
    };
  });
}

async function streamOfficial(opts, res, model, openaiId, mk, safeWrite) {
  const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages: toMessages(opts.messages),
      stream: true,
      temperature: opts.temperature,
    }),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw new Error(`Mistral API ${upstream.status}: ${t.slice(0, 280)}`);
  }
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const obj = JSON.parse(raw);
        const delta = obj.choices?.[0]?.delta || {};
        const out = {};
        if (delta.role) out.role = delta.role;
        if (delta.content) out.content = delta.content;
        if (delta.reasoning_content) out.reasoning_content = delta.reasoning_content;
        if (Object.keys(out).length) safeWrite(`data: ${mk(out)}\n\n`);
        if (obj.choices?.[0]?.finish_reason) {
          safeWrite(`data: ${mk({}, obj.choices[0].finish_reason)}\n\n`);
        }
      } catch {}
    }
  }
}

async function createWebConversation(model, sys) {
  const payload = { model };
  if (sys) payload.systemPrompt = sys;
  const r = await fetch(`${WEB_BASE}/api/chat/new`, {
    method: 'POST',
    headers: webHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Mistral web new chat ${r.status}: ${t.slice(0, 220)}`);
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error('Mistral web new chat: bad JSON');
  }
  const id = j.id || j.conversationId || j.conversation_id;
  if (!id) throw new Error('Mistral web: no conversation id');
  return id;
}

async function streamWeb(opts, res, model, openaiId, mk, safeWrite) {
  const sys = systemPrompt(opts.messages);
  const message = lastUser(opts.messages);
  const conversationId = opts.conversation_id || (await createWebConversation(model, sys));

  const upstream = await fetch(`${WEB_BASE}/api/chat`, {
    method: 'POST',
    headers: webHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Referer: `${WEB_BASE}/chat/${conversationId}`,
    }),
    body: JSON.stringify({
      conversationId,
      message,
      model,
    }),
  });

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw new Error(`Mistral web chat ${upstream.status}: ${t.slice(0, 280)}`);
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const raw = t.startsWith('data:') ? t.slice(5).trim() : t;
      if (!raw || raw === '[DONE]') continue;
      try {
        const obj = JSON.parse(raw);
        const choices = obj.choices || [];
        if (choices.length) {
          for (const choice of choices) {
            const delta = choice.delta || {};
            if (delta.content) safeWrite(`data: ${mk({ content: delta.content })}\n\n`);
            if (choice.finish_reason === 'stop') {
              /* end handled after stream */
            }
          }
        } else {
          const content = obj.content || obj.text || '';
          if (content && typeof content === 'string') {
            safeWrite(`data: ${mk({ content })}\n\n`);
          }
        }
      } catch {}
    }
  }
}

module.exports = async function mistralProxy(opts, res) {
  if (!API_KEY && !ENV_COOKIE) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(
      JSON.stringify({
        error:
          'Set MISTRAL_COOKIE (mistral-chat-session from chat.mistral.ai) or MISTRAL_API_KEY for official API',
      })
    );
  }

  const modelIn = opts.model || 'mistral';
  const model = resolveModel(modelIn);
  const openaiId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mk = (delta, finish = null) =>
    JSON.stringify({
      id: openaiId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelIn,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const safeWrite = (d) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(d);
    } catch {}
  };

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);

    // Prefer official API key on servers (avoids Cloudflare on chat.mistral.ai)
    if (API_KEY) {
      await streamOfficial(opts, res, model, openaiId, mk, safeWrite);
    } else {
      await streamWeb(opts, res, model, openaiId, mk, safeWrite);
    }

    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try {
      res.end();
    } catch {}
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!res.headersSent) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    safeWrite(`data: ${mk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try {
      res.end();
    } catch {}
  }
};

module.exports.MODELS = MODELS;
module.exports.isConfigured = () => !!(API_KEY || ENV_COOKIE);
