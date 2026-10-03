'use strict';
/**
 * Kimi web proxy (www.kimi.ai overseas)
 *
 * Env:
 *   KIMI_URL            default https://www.kimi.ai
 *   KIMI_TOKEN          optional access_token (short-lived)
 *   KIMI_REFRESH_TOKEN  preferred — ~90 day refresh_token from localStorage
 *
 * Refresh (Connect RPC, verified):
 *   POST https://auth.kimi.ai/api/account.gateway.v1.AuthService/RefreshToken
 *   Content-Type: application/json
 *   Body: {"refresh_token":"<jwt>"}
 *   Response: {"accessToken":"...","refreshToken":"..."}  // refresh rotates
 */
const crypto = require('crypto');

const KIMI_BASE = (process.env.KIMI_URL || 'https://www.kimi.ai').replace(/\/$/, '');
const AUTH_BASE = (process.env.KIMI_AUTH_URL || 'https://auth.kimi.ai').replace(/\/$/, '');
const ENV_TOKEN = (process.env.KIMI_TOKEN || process.env.KIMI_ACCESS_TOKEN || '').replace(/^Bearer\s+/i, '');
const ENV_REFRESH = (process.env.KIMI_REFRESH_TOKEN || '').replace(/^Bearer\s+/i, '');

const MODELS = [
  { slug: 'kimi', label: 'Kimi' },
  { slug: 'kimi-k2', label: 'Kimi K2' },
  { slug: 'moonshot-v1', label: 'Moonshot' },
];

let state = {
  access: null,
  refresh: null,
  expMs: 0,
};

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function classifyToken(jwt) {
  const p = decodeJwtPayload(jwt);
  if (!p) return { typ: 'unknown', expMs: 0 };
  return { typ: p.typ || 'unknown', expMs: p.exp ? p.exp * 1000 : 0, payload: p };
}

(function bootstrap() {
  if (ENV_TOKEN) {
    const c = classifyToken(ENV_TOKEN);
    if (c.typ === 'refresh') {
      state.refresh = ENV_TOKEN;
    } else {
      state.access = ENV_TOKEN;
      state.expMs = c.expMs || (Date.now() + 14 * 60_000);
    }
  }
  if (ENV_REFRESH) state.refresh = ENV_REFRESH;
  // If only KIMI_TOKEN was a refresh-looking JWT, already handled
  if (!state.refresh && ENV_TOKEN && classifyToken(ENV_TOKEN).typ === 'refresh') {
    state.refresh = ENV_TOKEN;
  }
})();

function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': KIMI_BASE,
    'Referer': KIMI_BASE + '/',
  };
}

function apiHeaders(token) {
  return {
    ...browserHeaders(),
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'r-timezone': 'UTC',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
  };
}

async function refreshAccess() {
  if (!state.refresh) {
    throw new Error('No KIMI_REFRESH_TOKEN — set refresh_token from kimi.ai localStorage (typ=refresh)');
  }
  const url = `${AUTH_BASE}/api/account.gateway.v1.AuthService/RefreshToken`;
  const r = await fetch(url, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ refresh_token: state.refresh }),
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`Kimi refresh ${r.status}: ${t.slice(0, 250)}`);
  }
  let j;
  try { j = JSON.parse(t); } catch {
    throw new Error('Kimi refresh: non-JSON response');
  }
  // Response is camelCase
  const access = j.accessToken || j.access_token;
  const newRefresh = j.refreshToken || j.refresh_token;
  if (!access) throw new Error('Kimi refresh: missing accessToken in ' + t.slice(0, 150));
  if (newRefresh) state.refresh = newRefresh; // rotated — must keep
  const c = classifyToken(access);
  state.access = access;
  state.expMs = c.expMs || (Date.now() + 14 * 60_000);
  console.log('[kimi] refreshed accessToken, exp in', Math.round((state.expMs - Date.now()) / 1000), 's');
  return access;
}

async function getAccess() {
  const skew = 60_000;
  if (state.access && state.expMs > Date.now() + skew) return state.access;
  if (state.refresh) return refreshAccess();
  if (state.access) return state.access;
  throw new Error('Set KIMI_REFRESH_TOKEN (preferred) or KIMI_TOKEN access_token');
}

function lastUser(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      let c = m.content;
      if (Array.isArray(c)) c = c.filter(p => p.type === 'text').map(p => p.text).join('\n');
      return String(c || '');
    }
  }
  return '';
}

async function createChat(token) {
  const r = await fetch(`${KIMI_BASE}/api/chat`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({ name: 'New Chat', is_example: false }),
  });
  const t = await r.text();
  if (r.status === 401 && state.refresh) {
    const access = await refreshAccess();
    return createChat(access);
  }
  if (!r.ok) throw new Error(`Kimi create chat ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  const id = j.id || j.data?.id || j.chat?.id;
  if (!id) throw new Error('Kimi create chat: no id');
  return id;
}

module.exports = async function kimiProxy(opts, res) {
  if (!state.access && !state.refresh && !ENV_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({
      error: 'Set KIMI_REFRESH_TOKEN (localStorage refresh_token) or KIMI_TOKEN (access_token)',
    }));
  }

  const model = opts.model || 'kimi';
  const openaiId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mk = (delta, finish = null) => JSON.stringify({
    id: openaiId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const safeWrite = (d) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(d); } catch {}
  };

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);

    let token = await getAccess();
    let chatId;
    try {
      chatId = await createChat(token);
    } catch (e) {
      if (/401|expired|invalid|unauthenticated/i.test(String(e.message)) && state.refresh) {
        token = await refreshAccess();
        chatId = await createChat(token);
      } else throw e;
    }

    const prompt = lastUser(opts.messages);
    const streamUrl = `${KIMI_BASE}/api/chat/${chatId}/completion/stream`;
    const body = {
      messages: [{ role: 'user', content: prompt }],
      references: [],
      use_search: !!opts.use_search,
      use_deep_research: false,
    };

    let streamRes = await fetch(streamUrl, {
      method: 'POST',
      headers: { ...apiHeaders(token), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    if (streamRes.status === 401 && state.refresh) {
      token = await refreshAccess();
      streamRes = await fetch(streamUrl, {
        method: 'POST',
        headers: { ...apiHeaders(token), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
    }
    if (!streamRes.ok) {
      const err = await streamRes.text().catch(() => '');
      throw new Error(`Kimi stream ${streamRes.status}: ${err.slice(0, 200)}`);
    }

    const reader = streamRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawAssistant = false;
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
          const evt = JSON.parse(raw);
          let text = evt.text || evt.content || evt.choices?.[0]?.delta?.content || '';
          if (typeof text !== 'string' || !text) continue;
          if (!sawAssistant && text.trim() === prompt.trim()) continue;
          sawAssistant = true;
          safeWrite(`data: ${mk({ content: text })}\n\n`);
        } catch {}
      }
    }

    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    const msg = err && err.message ? err.message : String(err);
    safeWrite(`data: ${mk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
};

module.exports.MODELS = MODELS;
module.exports.isConfigured = () => !!(state.access || state.refresh || ENV_TOKEN);
