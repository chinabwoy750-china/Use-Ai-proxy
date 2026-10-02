'use strict';
const crypto = require('crypto');

const QWEN_URL = (process.env.QWEN_URL || 'https://chat.qwen.ai').replace(/\/$/, '');
const QWEN_TOKEN = process.env.QWEN_TOKEN || '';
const QWEN_COOKIE = process.env.QWEN_COOKIE || '';

const DEFAULT_MODEL = 'qwen3.7-plus';

const MODELS = [
  { slug: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { slug: 'qwen3.7-max', label: 'Qwen3.7 Max' },
  { slug: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
  { slug: 'qwen3.5-plus', label: 'Qwen3.5 Plus' },
  { slug: 'qwen3-coder-plus', label: 'Qwen3 Coder' },
  { slug: 'qwen-plus', label: 'Qwen Plus (alias)' },
  { slug: 'qwen-max', label: 'Qwen Max (alias)' },
];

const ALIASES = {
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.7-max',
  'qwen': 'qwen3.7-plus',
  'qwen-coder': 'qwen3-coder-plus',
};

function headers() {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': QWEN_URL,
    'Referer': QWEN_URL + '/',
    'source': 'web',
    'bx-v': '2.5.31',
  };
  if (QWEN_TOKEN) h['Authorization'] = `Bearer ${QWEN_TOKEN.replace(/^Bearer\s+/i, '')}`;
  if (QWEN_COOKIE) h['Cookie'] = QWEN_COOKIE;
  return h;
}

function resolveModel(name) {
  const n = String(name || DEFAULT_MODEL).toLowerCase();
  return ALIASES[n] || name || DEFAULT_MODEL;
}

function toQwenMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    }
    out.push({ role, content: String(content || '') });
  }
  return out;
}

async function createChat(model) {
  const res = await fetch(`${QWEN_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      title: 'New Chat',
      models: [model],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (/text\/html/i.test(res.headers.get('content-type') || '') || text.includes('<html')) {
      throw new Error('Qwen WAF/auth blocked — refresh QWEN_TOKEN + full QWEN_COOKIE from browser');
    }
    throw new Error(`chats/new ${res.status}: ${text.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('chats/new: non-JSON response (likely WAF)');
  }
  const chatId = data?.data?.id || data?.id || data?.data?.chat_id;
  if (!chatId) throw new Error('chats/new: no chat_id in response');
  return chatId;
}

module.exports = async function qwenProxy(opts, res) {
  if (!QWEN_TOKEN && !QWEN_COOKIE) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({
      error: 'Set QWEN_TOKEN (localStorage token) and QWEN_COOKIE (full Cookie header) from chat.qwen.ai',
    }));
    return;
  }

  const model = resolveModel(opts.model);
  const chatIdOpenAI = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mkChunk = (delta, finish = null) => JSON.stringify({
    id: chatIdOpenAI,
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
    safeWrite(`data: ${mkChunk({ role: 'assistant', content: '' })}\n\n`);

    const chatId = await createChat(model);
    const messages = toQwenMessages(opts.messages);

    const body = {
      chat_id: chatId,
      model,
      messages,
      stream: true,
      incremental_output: true,
      version: '2.1',
      feature_config: {
        thinking_enabled: /thinking|reason/i.test(String(opts.model || '')),
      },
    };

    const chatRes = await fetch(
      `${QWEN_URL}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
      {
        method: 'POST',
        headers: { ...headers(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      }
    );

    if (!chatRes.ok) {
      const errText = await chatRes.text().catch(() => '');
      if (/text\/html/i.test(chatRes.headers.get('content-type') || '') || errText.includes('<html')) {
        throw new Error('Qwen WAF/auth blocked — refresh QWEN_TOKEN + full QWEN_COOKIE');
      }
      throw new Error(`completions ${chatRes.status}: ${errText.slice(0, 250)}`);
    }

    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let streamDone = false;

    while (!streamDone) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') {
          if (raw === '[DONE]') streamDone = true;
          continue;
        }
        try {
          const evt = JSON.parse(raw);
          // phase-based: think / thinking -> reasoning; answer / message -> content
          const phase = evt.phase || evt.type || evt.choices?.[0]?.delta?.phase;
          const delta = evt.choices?.[0]?.delta || evt.delta || {};
          let content = delta.content || evt.content || evt.message || evt.data?.delta || '';
          let reasoning = delta.reasoning_content || evt.reasoning_content || '';

          if (phase === 'think' || phase === 'thinking' || phase === 'thinking_summary') {
            if (typeof content === 'string' && content && !reasoning) reasoning = content, content = '';
          }
          if (typeof reasoning === 'string' && reasoning) {
            safeWrite(`data: ${mkChunk({ reasoning_content: reasoning })}\n\n`);
          }
          if (typeof content === 'string' && content) {
            safeWrite(`data: ${mkChunk({ content })}\n\n`);
          }
          // alternate shapes
          if (evt.data && typeof evt.data === 'string') {
            safeWrite(`data: ${mkChunk({ content: evt.data })}\n\n`);
          }
          if (evt.finish_reason || evt.choices?.[0]?.finish_reason) {
            streamDone = true;
          }
        } catch {}
      }
    }

    safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    const msg = err && err.message ? err.message : String(err);
    safeWrite(`data: ${mkChunk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
    safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
};

module.exports.MODELS = MODELS;
module.exports.isConfigured = () => !!(QWEN_TOKEN || QWEN_COOKIE);
