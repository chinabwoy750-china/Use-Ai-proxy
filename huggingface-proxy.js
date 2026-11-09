'use strict';
/**
 * HuggingFace Chat web proxy — cookie pool + rotate on 429/401
 *
 * Env:
 *   HF_COOKIES = "cookie1|||cookie2|||cookie3"  (||| — cookies may contain commas)
 *   HF_CHAT_COOKIE = single cookie (legacy)
 *   HF_CHAT_URL, HF_CHAT_MODEL
 */
const crypto = require('crypto');

const HF_BASE = (process.env.HF_CHAT_URL || 'https://huggingface.co').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.HF_CHAT_MODEL || 'omni';

function loadCookiePool() {
  const list = [];
  // Extension / admin multi-accounts
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.huggingface || all.hf || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
    for (const a of accounts) {
      const v = (a && a.values) || {};
      const c = String(v.HF_CHAT_COOKIE || v.HF_COOKIE || v.HF_COOKIES || a.key || '').trim();
      if (c) list.push(c);
    }
  } catch (_) {}
  const envPool = (process.env.HF_COOKIES || process.env.HF_CHAT_COOKIE || process.env.HF_COOKIE || '')
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of envPool) {
    if (!list.includes(c)) list.push(c);
  }
  return list;
}

let rrIdx = 0;
const coolUntil = new Map();

function pickCookie() {
  const pool = loadCookiePool();
  if (!pool.length) return '';
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const c = pool[(rrIdx + i) % pool.length];
    if ((coolUntil.get(c) || 0) > now) continue;
    rrIdx = (rrIdx + i + 1) % pool.length;
    return c;
  }
  return pool[rrIdx++ % pool.length];
}

function coolCookie(c, ms = 60_000) {
  if (c) coolUntil.set(c, Date.now() + ms);
}

console.log('[huggingface] cookie loader ready');

const MODELS = [
  { slug: 'huggingface', label: 'HF Chat (default)' },
  { slug: 'hf', label: 'HF alias' },
  { slug: 'omni', label: 'HF Omni router' },
  { slug: 'hf-qwen', label: 'Qwen on HF Chat' },
  { slug: 'hf-deepseek', label: 'DeepSeek on HF Chat' },
  { slug: 'hf-glm', label: 'GLM on HF Chat' },
];

const MODEL_MAP = {
  huggingface: DEFAULT_MODEL,
  hf: DEFAULT_MODEL,
  omni: 'omni',
  'hf-qwen': 'Qwen/Qwen3.8-27B',
  'hf-deepseek': 'deepseek-ai/DeepSeek-V4.1-Flash',
  'hf-glm': 'zai-org/GLM-5.3',
};

function cookieHeader(raw) {
  if (!raw) return '';
  if (/hf-chat\s*=/i.test(raw)) return raw;
  return `hf-chat=${raw}`;
}

function headers(cookie, extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: HF_BASE,
    Referer: `${HF_BASE}/chat`,
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

function resolveModel(name) {
  const n = String(name || 'huggingface').toLowerCase();
  if (MODEL_MAP[n]) return MODEL_MAP[n];
  if (String(name || '').includes('/')) return name;
  return DEFAULT_MODEL;
}

async function createConversation(cookie, modelId, preprompt) {
  const body = { model: modelId };
  if (preprompt) body.preprompt = preprompt;
  const r = await fetch(`${HF_BASE}/chat/conversation`, {
    method: 'POST',
    headers: headers(cookie, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (r.status === 429 || r.status === 401) {
    coolCookie(cookie, 60_000);
    const err = new Error(`HF create ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (!r.ok) throw new Error(`HF create conversation ${r.status}: ${t.slice(0, 200)}`);
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error('HF create conversation: bad JSON');
  }
  const id = j.conversationId || j.id;
  if (!id) throw new Error('HF create conversation: no conversationId');
  return id;
}

module.exports = async function huggingfaceProxy(opts, res) {
  if (!loadCookiePool().length) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(
      JSON.stringify({ error: 'Set HF_COOKIES (cookie1|||cookie2|||...) or HF_CHAT_COOKIE' })
    );
  }

  const modelIn = opts.model || 'huggingface';
  const modelId = resolveModel(modelIn);
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

  const maxAttempts = Math.max(loadCookiePool().length, 1);
  let upstream = null;
  let lastErr = null;
  const tried = new Set();

  for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
    const cookie = pickCookie();
    if (!cookie || tried.has(cookie)) {
      if (tried.size >= loadCookiePool().length) break;
      continue;
    }
    tried.add(cookie);
    try {
      const text = lastUser(opts.messages);
      const pre = systemPrompt(opts.messages);
      const conversationId = await createConversation(cookie, modelId, pre);
      const messageId = crypto.randomUUID();
      const reqJson = {
        id: messageId,
        inputs: text,
        is_continue: false,
        is_retry: false,
        web_search: !!opts.web_search,
        tools: [],
      };
      const boundary = '----HFBoundary' + crypto.randomBytes(8).toString('hex');
      const bodyStr =
        `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n` +
        `${JSON.stringify(reqJson)}\r\n--${boundary}--\r\n`;

      upstream = await fetch(`${HF_BASE}/chat/conversation/${conversationId}`, {
        method: 'POST',
        headers: headers(cookie, {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Referer: `${HF_BASE}/chat/conversation/${conversationId}`,
        }),
        body: bodyStr,
      });

      if (upstream.status === 429 || upstream.status === 401) {
        coolCookie(cookie, 60_000);
        lastErr = new Error(`HF ${upstream.status} — rotating cookie`);
        upstream = null;
        continue;
      }
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        lastErr = new Error(`HF chat ${upstream.status}: ${errText.slice(0, 280)}`);
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

  try {
    if (!upstream) throw lastErr || new Error('All HF cookies failed / rate limited');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);

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
        const raw = line.trim();
        if (!raw) continue;
        const payload = raw.startsWith('data:') ? raw.slice(5).trim() : raw;
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        const type = obj.type || '';
        if (type === 'stream' || type === 'token') {
          const token = obj.token || obj.text || '';
          const s = typeof token === 'string' ? token : token?.text || '';
          if (s) safeWrite(`data: ${mk({ content: s })}\n\n`);
        } else if (typeof obj.token === 'string') {
          safeWrite(`data: ${mk({ content: obj.token })}\n\n`);
        } else if (obj.token && typeof obj.token.text === 'string') {
          safeWrite(`data: ${mk({ content: obj.token.text })}\n\n`);
        }
      }
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
module.exports.isConfigured = () => loadCookiePool().length > 0;
