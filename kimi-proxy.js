'use strict';
const crypto = require('crypto');

// Kimi web reverse (refresh_token from localStorage on kimi.moonshot.cn / www.kimi.com)
const KIMI_BASE = (process.env.KIMI_URL || 'https://www.kimi.com').replace(/\/$/, '');
const KIMI_TOKEN = process.env.KIMI_TOKEN || process.env.KIMI_REFRESH_TOKEN || '';

const MODELS = [
  { slug: 'kimi', label: 'Kimi' },
  { slug: 'kimi-k2', label: 'Kimi K2' },
  { slug: 'moonshot-v1', label: 'Moonshot v1' },
];

let cachedAccess = null; // { token, exp }

function headers(accessToken) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Origin': KIMI_BASE,
    'Referer': KIMI_BASE + '/',
    'Authorization': `Bearer ${accessToken}`,
  };
}

async function getAccessToken() {
  if (cachedAccess && cachedAccess.exp > Date.now() + 60_000) return cachedAccess.token;
  if (!KIMI_TOKEN) throw new Error('Set KIMI_TOKEN (refresh_token from Kimi localStorage)');

  // refresh_token may already be an access JWT — try as-is first path via /api/user
  const refresh = KIMI_TOKEN.replace(/^Bearer\s+/i, '');
  // Common endpoints across kimi.com / moonshot.cn generations
  const endpoints = [
    `${KIMI_BASE}/api/user/access_token`,
    'https://kimi.moonshot.cn/api/user/access_token',
    'https://www.kimi.com/api/user/access_token',
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers(refresh),
          Authorization: `Bearer ${refresh}`,
        },
        body: '{}',
      });
      const t = await r.text();
      if (!r.ok) { lastErr = new Error(`access_token ${r.status}: ${t.slice(0, 120)}`); continue; }
      let j; try { j = JSON.parse(t); } catch { lastErr = new Error('access_token non-json'); continue; }
      const token = j?.access_token || j?.token || j?.data?.access_token;
      if (!token) { lastErr = new Error('no access_token in response'); continue; }
      cachedAccess = { token, exp: Date.now() + 25 * 60_000 };
      return token;
    } catch (e) { lastErr = e; }
  }
  // Fallback: use refresh token directly as Bearer (works for some kimi-auth cookies)
  cachedAccess = { token: refresh, exp: Date.now() + 10 * 60_000 };
  return refresh;
}

async function createChat(access) {
  const endpoints = [
    `${KIMI_BASE}/api/chat`,
    'https://kimi.moonshot.cn/api/chat',
    'https://www.kimi.com/api/chat',
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: headers(access),
        body: JSON.stringify({ name: 'New chat', is_example: false }),
      });
      const t = await r.text();
      if (!r.ok) { lastErr = new Error(`chat create ${r.status}: ${t.slice(0, 150)}`); continue; }
      const j = JSON.parse(t);
      const id = j?.id || j?.data?.id || j?.chat?.id;
      if (id) return { id, base: url.replace(/\/api\/chat$/, '') };
      lastErr = new Error('no chat id');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Kimi chat create failed');
}

function flattenMessages(messages) {
  return (messages || []).map(m => {
    let c = m.content;
    if (Array.isArray(c)) c = c.filter(p => p.type === 'text').map(p => p.text).join('\n');
    return { role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(c || '') };
  });
}

module.exports = async function kimiProxy(opts, res) {
  if (!KIMI_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({ error: 'Set KIMI_TOKEN = refresh_token from kimi localStorage' }));
  }

  const model = opts.model || 'kimi';
  const chatId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mk = (delta, finish = null) => JSON.stringify({
    id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const safeWrite = (d) => { if (!res.destroyed && !res.writableEnded) try { res.write(d); } catch {} };

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);

    const access = await getAccessToken();
    const { id: convId, base } = await createChat(access);
    const msgs = flattenMessages(opts.messages);
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')?.content || '';

    const streamUrl = `${base}/api/chat/${convId}/completion/stream`;
    const body = {
      messages: msgs,
      references: [],
      use_search: !!opts.use_search,
      kimiplus_id: /^[a-z0-9]{20}$/i.test(model) ? model : undefined,
    };
    // Some API versions want only the last message + history on server
    const streamRes = await fetch(streamUrl, {
      method: 'POST',
      headers: { ...headers(access), Accept: 'text/event-stream' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: lastUser }],
        references: [],
        use_search: false,
        ...body,
      }),
    });

    if (!streamRes.ok) {
      const err = await streamRes.text().catch(() => '');
      throw new Error(`Kimi stream ${streamRes.status}: ${err.slice(0, 200)}`);
    }

    const reader = streamRes.body.getReader();
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
          const evt = JSON.parse(raw);
          const text = evt?.text || evt?.content || evt?.message || evt?.choices?.[0]?.delta?.content || '';
          if (typeof text === 'string' && text) safeWrite(`data: ${mk({ content: text })}\n\n`);
          if (evt?.event === 'done' || evt?.finish) { /* end */ }
        } catch {}
      }
    }
    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    safeWrite(`data: ${mk({ content: '\n\n[Error: ' + (err.message || err) + ']' })}\n\n`);
    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
};

module.exports.MODELS = MODELS;
module.exports.isConfigured = () => !!KIMI_TOKEN;
