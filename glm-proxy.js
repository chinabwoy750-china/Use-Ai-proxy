'use strict';
const crypto = require('crypto');

// ChatGLM / Zhipu web (refresh_token from localStorage chatglm_refresh_token on chatglm.cn)
const GLM_BASE = (process.env.GLM_URL || 'https://chatglm.cn').replace(/\/$/, '');
const GLM_TOKEN = process.env.GLM_TOKEN || process.env.GLM_REFRESH_TOKEN || '';

const MODELS = [
  { slug: 'glm-4', label: 'GLM-4' },
  { slug: 'glm-4-plus', label: 'GLM-4 Plus' },
  { slug: 'glm-4-flash', label: 'GLM-4 Flash' },
  { slug: 'glm-5', label: 'GLM-5' },
  { slug: 'chatglm', label: 'ChatGLM' },
];

let accessCache = null;

function hdrs(access) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Origin': GLM_BASE,
    'Referer': GLM_BASE + '/',
    'Authorization': `Bearer ${access}`,
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-Lang': 'en',
  };
}

async function getAccess() {
  if (accessCache && accessCache.exp > Date.now() + 30_000) return accessCache.token;
  if (!GLM_TOKEN) throw new Error('Set GLM_TOKEN = chatglm_refresh_token from chatglm.cn localStorage');
  const refresh = GLM_TOKEN.replace(/^Bearer\s+/i, '');

  const urls = [
    `${GLM_BASE}/chatglm/user-api/user/refresh`,
    `${GLM_BASE}/api/user/refresh`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          ...hdrs(refresh),
          Authorization: `Bearer ${refresh}`,
        },
        body: '{}',
      });
      const t = await r.text();
      if (!r.ok) continue;
      const j = JSON.parse(t);
      const token = j?.result?.access_token || j?.access_token || j?.data?.access_token || j?.token;
      if (token) {
        accessCache = { token, exp: Date.now() + 20 * 60_000 };
        return token;
      }
    } catch {}
  }
  accessCache = { token: refresh, exp: Date.now() + 5 * 60_000 };
  return refresh;
}

function lastUserText(messages) {
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

module.exports = async function glmProxy(opts, res) {
  if (!GLM_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({ error: 'Set GLM_TOKEN = chatglm_refresh_token from chatglm.cn' }));
  }

  const model = opts.model || 'glm-4';
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

    const access = await getAccess();
    const prompt = lastUserText(opts.messages);

    const streamUrls = [
      `${GLM_BASE}/chatglm/backend-api/assistant/stream`,
      `${GLM_BASE}/backend-api/assistant/stream`,
    ];

    let streamRes = null;
    let lastErr = null;
    for (const url of streamUrls) {
      try {
        streamRes = await fetch(url, {
          method: 'POST',
          headers: { ...hdrs(access), Accept: 'text/event-stream' },
          body: JSON.stringify({
            assistant_id: '65940acff94777010aa6b796', // default assistant; may vary
            conversation_id: '',
            meta_data: {
              mention_conversation_id: '',
              is_test: false,
              input_question_type: 'xxxx',
              channel: '',
              draft_id: '',
            },
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: prompt }],
              },
            ],
          }),
        });
        if (streamRes.ok) break;
        lastErr = new Error(`GLM stream ${streamRes.status}: ${(await streamRes.text()).slice(0, 150)}`);
        streamRes = null;
      } catch (e) { lastErr = e; }
    }
    if (!streamRes) throw lastErr || new Error('GLM stream failed');

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
          // ChatGLM SSE shapes vary: parts, text, message, delta
          const parts = evt?.parts || evt?.message?.content || [];
          if (Array.isArray(parts)) {
            for (const p of parts) {
              const text = p?.text || p?.content || '';
              if (text) safeWrite(`data: ${mk({ content: text })}\n\n`);
            }
          }
          const text = evt?.text || evt?.delta || evt?.content || '';
          if (typeof text === 'string' && text) safeWrite(`data: ${mk({ content: text })}\n\n`);
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
module.exports.isConfigured = () => !!GLM_TOKEN;
