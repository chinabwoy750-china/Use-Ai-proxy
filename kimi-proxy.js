'use strict';
/**
 * Kimi (www.kimi.ai overseas / www.kimi.com CN)
 *
 * Auth:
 *   KIMI_URL   = https://www.kimi.ai   (overseas — default)
 *   KIMI_TOKEN = access_token (typ=access, ~15 min)  OR refresh_token if you only have that
 *
 * Browser: localStorage on kimi.ai → access_token + refresh_token
 * access_token works as Authorization: Bearer (verified).
 * Old /api/user/access_token is 404 — do NOT call it.
 */
const crypto = require('crypto');

const KIMI_BASE = (process.env.KIMI_URL || 'https://www.kimi.ai').replace(/\/$/, '');
const KIMI_TOKEN = (process.env.KIMI_TOKEN || process.env.KIMI_ACCESS_TOKEN || process.env.KIMI_REFRESH_TOKEN || '').replace(/^Bearer\s+/i, '');

const MODELS = [
  { slug: 'kimi', label: 'Kimi' },
  { slug: 'kimi-k2', label: 'Kimi K2' },
  { slug: 'moonshot-v1', label: 'Moonshot' },
];

function headers(token) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Origin': KIMI_BASE,
    'Referer': KIMI_BASE + '/',
    'Authorization': `Bearer ${token}`,
    'r-timezone': 'UTC',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
  };
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
    headers: headers(token),
    body: JSON.stringify({ name: 'New Chat', is_example: false }),
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`Kimi create chat ${r.status}: ${t.slice(0, 200)}`);
  }
  let j;
  try { j = JSON.parse(t); } catch {
    throw new Error('Kimi create chat: non-JSON (auth expired?)');
  }
  const id = j.id || j.data?.id || j.chat?.id;
  if (!id) throw new Error('Kimi create chat: no id in ' + t.slice(0, 150));
  return id;
}

module.exports = async function kimiProxy(opts, res) {
  if (!KIMI_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({
      error: 'Set KIMI_TOKEN to access_token from kimi.ai localStorage (KIMI_URL=https://www.kimi.ai)',
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

    const token = KIMI_TOKEN;
    const chatId = await createChat(token);
    const prompt = lastUser(opts.messages);

    // Primary stream path used by classic kimi web client
    const streamPaths = [
      `${KIMI_BASE}/api/chat/${chatId}/completion/stream`,
      `${KIMI_BASE}/api/chat/${chatId}/completion`,
    ];

    let streamRes = null;
    let lastErr = null;
    const body = {
      messages: [{ role: 'user', content: prompt }],
      references: [],
      use_search: !!opts.use_search,
      use_deep_research: false,
    };

    for (const url of streamPaths) {
      try {
        streamRes = await fetch(url, {
          method: 'POST',
          headers: { ...headers(token), Accept: 'text/event-stream' },
          body: JSON.stringify(body),
        });
        if (streamRes.ok) break;
        const errText = await streamRes.text().catch(() => '');
        lastErr = new Error(`stream ${streamRes.status} ${url}: ${errText.slice(0, 180)}`);
        streamRes = null;
      } catch (e) {
        lastErr = e;
        streamRes = null;
      }
    }
    if (!streamRes) throw lastErr || new Error('Kimi stream failed');

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
          // ops: text / content / message / event types
          if (evt.event === 'cmpl' || evt.op === 'append' || evt.type === 'cmpl') {
            const text = evt.text || evt.content || evt.message || '';
            if (text) safeWrite(`data: ${mk({ content: text })}\n\n`);
          } else {
            const text = evt.text || evt.content || evt.choices?.[0]?.delta?.content || '';
            if (typeof text === 'string' && text) safeWrite(`data: ${mk({ content: text })}\n\n`);
          }
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
module.exports.isConfigured = () => !!KIMI_TOKEN;
