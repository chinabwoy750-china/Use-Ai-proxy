'use strict';
/**
 * HuggingFace Chat web proxy (huggingface.co/chat)
 *
 * Env:
 *   HF_CHAT_COOKIE   required — value of the `hf-chat` cookie (or full Cookie header)
 *   HF_CHAT_URL      optional — default https://huggingface.co
 *   HF_CHAT_MODEL    optional — default model id when client sends "huggingface" / "hf"
 */
const crypto = require('crypto');

const HF_BASE = (process.env.HF_CHAT_URL || 'https://huggingface.co').replace(/\/$/, '');
const ENV_COOKIE = process.env.HF_CHAT_COOKIE || process.env.HF_COOKIE || '';
const DEFAULT_MODEL = process.env.HF_CHAT_MODEL || 'omni';

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

function cookieHeader() {
  const c = ENV_COOKIE.trim();
  if (!c) return '';
  if (/hf-chat\s*=/i.test(c)) return c;
  return `hf-chat=${c}`;
}

function headers(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: HF_BASE,
    Referer: `${HF_BASE}/chat`,
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
  const sys = (messages || []).filter((m) => m.role === 'system');
  if (!sys.length) return '';
  return sys
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
  // allow full HF model ids e.g. Qwen/Qwen3.8-27B
  if (String(name || '').includes('/')) return name;
  return DEFAULT_MODEL;
}

async function createConversation(modelId, preprompt) {
  const body = { model: modelId };
  if (preprompt) body.preprompt = preprompt;
  const r = await fetch(`${HF_BASE}/chat/conversation`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const t = await r.text();
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

async function getRootMessageId(conversationId) {
  const r = await fetch(`${HF_BASE}/chat/api/conversation/${conversationId}`, {
    headers: headers(),
  });
  if (!r.ok) {
    // older path
    const r2 = await fetch(`${HF_BASE}/chat/conversation/${conversationId}/__data.json`, {
      headers: headers(),
    });
    if (!r2.ok) return null;
    return null;
  }
  const j = await r.json().catch(() => null);
  const data = j?.json || j;
  const messages = data?.messages || [];
  if (messages.length) return messages[messages.length - 1].id || messages[0].id;
  return data?.id || null;
}

module.exports = async function huggingfaceProxy(opts, res) {
  if (!ENV_COOKIE) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(
      JSON.stringify({
        error: 'Set HF_CHAT_COOKIE to the hf-chat cookie from huggingface.co/chat (logged in)',
      })
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

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);

    const text = lastUser(opts.messages);
    const pre = systemPrompt(opts.messages);
    const conversationId = await createConversation(modelId, pre);
    let messageId = await getRootMessageId(conversationId);
    if (!messageId) {
      // HF often uses a client-generated UUID for the first user message id
      messageId = crypto.randomUUID();
    }

    const reqJson = {
      id: messageId,
      inputs: text,
      is_continue: false,
      is_retry: false,
      web_search: !!opts.web_search,
      tools: [],
    };

    // multipart field "data" as hugchat does
    const boundary = '----HFBoundary' + crypto.randomBytes(8).toString('hex');
    const bodyStr =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="data"\r\n\r\n` +
      `${JSON.stringify(reqJson)}\r\n` +
      `--${boundary}--\r\n`;

    const upstream = await fetch(`${HF_BASE}/chat/conversation/${conversationId}`, {
      method: 'POST',
      headers: headers({
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Referer: `${HF_BASE}/chat/conversation/${conversationId}`,
      }),
      body: bodyStr,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      throw new Error(`HF chat ${upstream.status}: ${errText.slice(0, 280)}`);
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
        const raw = line.trim();
        if (!raw) continue;
        // Some deployments prefix data:
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
          const token = obj.token || obj.text || obj.token?.text || '';
          const s = typeof token === 'string' ? token : token?.text || '';
          if (s) safeWrite(`data: ${mk({ content: s })}\n\n`);
        } else if (type === 'finalAnswer') {
          // already streamed tokens; ignore full text to avoid duplication
          continue;
        } else if (type === 'status') {
          continue;
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
module.exports.isConfigured = () => !!ENV_COOKIE;
