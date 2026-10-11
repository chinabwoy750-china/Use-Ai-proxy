'use strict';
/**
 * Mistral — API key pool (recommended) + optional web cookie pool
 *
 * Env:
 *   MISTRAL_API_KEYS = "key1,key2,key3"
 *   MISTRAL_API_KEY  = single key (legacy)
 *   MISTRAL_COOKIES  = "cookie1|||cookie2"  (web; often CF-blocked on Render)
 *   MISTRAL_COOKIE / MISTRAL_COOKIE_HEADER
 *   MISTRAL_URL, MISTRAL_API_URL
 */
const crypto = require('crypto');

const WEB_BASE = (process.env.MISTRAL_URL || 'https://chat.mistral.ai').replace(/\/$/, '');
const API_BASE = (process.env.MISTRAL_API_URL || 'https://api.mistral.ai').replace(/\/$/, '');

const KEY_POOL = (process.env.MISTRAL_API_KEYS || process.env.MISTRAL_API_KEY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const COOKIE_POOL = (
  process.env.MISTRAL_COOKIES ||
  process.env.MISTRAL_COOKIE_HEADER ||
  process.env.MISTRAL_COOKIE ||
  ''
)
  .split('|||')
  .map((s) => s.trim())
  .filter(Boolean);

let keyIdx = 0;
let cookieIdx = 0;
const keyCool = new Map();
const cookieCool = new Map();

function pickKey() {
  if (!KEY_POOL.length) return '';
  const now = Date.now();
  for (let i = 0; i < KEY_POOL.length; i++) {
    const k = KEY_POOL[(keyIdx + i) % KEY_POOL.length];
    if ((keyCool.get(k) || 0) > now) continue;
    keyIdx = (keyIdx + i + 1) % KEY_POOL.length;
    return k;
  }
  return KEY_POOL[keyIdx++ % KEY_POOL.length];
}
function coolKey(k, ms = 60_000) {
  if (k) keyCool.set(k, Date.now() + ms);
}
function pickCookie() {
  if (!COOKIE_POOL.length) return '';
  const now = Date.now();
  for (let i = 0; i < COOKIE_POOL.length; i++) {
    const c = COOKIE_POOL[(cookieIdx + i) % COOKIE_POOL.length];
    if ((cookieCool.get(c) || 0) > now) continue;
    cookieIdx = (cookieIdx + i + 1) % COOKIE_POOL.length;
    return c;
  }
  return COOKIE_POOL[cookieIdx++ % COOKIE_POOL.length];
}
function coolCookie(c, ms = 60_000) {
  if (c) cookieCool.set(c, Date.now() + ms);
}

console.log(
  '[mistral] mode:',
  KEY_POOL.length
    ? `API key pool (${KEY_POOL.length})`
    : COOKIE_POOL.length
      ? `web cookie pool (${COOKIE_POOL.length})`
      : 'unconfigured'
);

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

function cookieHeader(raw) {
  if (!raw) return '';
  if (/mistral-chat-session\s*=/i.test(raw) || raw.includes(';')) return raw;
  return `mistral-chat-session=${raw}`;
}

function webHeaders(cookie, extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept: 'application/json, text/event-stream, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: WEB_BASE,
    Referer: `${WEB_BASE}/chat`,
    Cookie: cookieHeader(cookie),
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
  const maxAttempts = Math.max(KEY_POOL.length, 1);
  let upstream = null;
  let lastErr = null;
  const tried = new Set();

  for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
    const key = pickKey();
    if (!key || tried.has(key)) {
      if (tried.size >= KEY_POOL.length) break;
      continue;
    }
    tried.add(key);
    try {
      upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
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
      if (upstream.status === 429 || upstream.status === 401) {
        coolKey(key, 60_000);
        lastErr = new Error(`Mistral API ${upstream.status} — rotating key`);
        upstream = null;
        continue;
      }
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        lastErr = new Error(`Mistral API ${upstream.status}: ${t.slice(0, 280)}`);
        upstream = null;
        continue;
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      upstream = null;
    }
  }
  if (!upstream) throw lastErr || new Error('All Mistral API keys failed / rate limited');

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

async function createWebConversation(cookie, model, sys) {
  const payload = { model };
  if (sys) payload.systemPrompt = sys;
  const r = await fetch(`${WEB_BASE}/api/chat/new`, {
    method: 'POST',
    headers: webHeaders(cookie, { 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  if (r.status === 429 || r.status === 401) {
    coolCookie(cookie, 60_000);
    const err = new Error(`Mistral web new ${r.status}`);
    err.status = r.status;
    throw err;
  }
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
  const maxAttempts = Math.max(COOKIE_POOL.length, 1);
  let upstream = null;
  let lastErr = null;
  const tried = new Set();

  for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
    const cookie = pickCookie();
    if (!cookie || tried.has(cookie)) {
      if (tried.size >= COOKIE_POOL.length) break;
      continue;
    }
    tried.add(cookie);
    try {
      const sys = systemPrompt(opts.messages);
      const message = lastUser(opts.messages);
      const conversationId = await createWebConversation(cookie, model, sys);
      upstream = await fetch(`${WEB_BASE}/api/chat`, {
        method: 'POST',
        headers: webHeaders(cookie, {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Referer: `${WEB_BASE}/chat/${conversationId}`,
        }),
        body: JSON.stringify({ conversationId, message, model }),
      });
      if (upstream.status === 429 || upstream.status === 401) {
        coolCookie(cookie, 60_000);
        lastErr = new Error(`Mistral web ${upstream.status} — rotating cookie`);
        upstream = null;
        continue;
      }
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        lastErr = new Error(`Mistral web chat ${upstream.status}: ${t.slice(0, 280)}`);
        upstream = null;
        continue;
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      upstream = null;
      if (e.status === 429 || e.status === 401) continue;
    }
  }
  if (!upstream) throw lastErr || new Error('All Mistral cookies failed / rate limited');

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
          }
        } else {
          const content = obj.content || obj.text || '';
          if (content && typeof content === 'string') safeWrite(`data: ${mk({ content })}\n\n`);
        }
      } catch {}
    }
  }
}

module.exports = async function mistralProxy(opts, res) {
  if (!KEY_POOL.length && !COOKIE_POOL.length) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(
      JSON.stringify({
        error: 'Set MISTRAL_API_KEYS (comma-separated) or MISTRAL_COOKIES (||| separated)',
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

    if (KEY_POOL.length) await streamOfficial(opts, res, model, openaiId, mk, safeWrite);
    else await streamWeb(opts, res, model, openaiId, mk, safeWrite);

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
module.exports.isConfigured = () => !!(KEY_POOL.length || COOKIE_POOL.length);
