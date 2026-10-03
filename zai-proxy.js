'use strict';
/**
 * chat.z.ai (Z.AI / GLM web) OpenAI-compatible proxy
 *
 * Env:
 *   ZAI_URL   default https://chat.z.ai
 *   ZAI_TOKEN JWT from localStorage.token (or Authorization Bearer on chat requests)
 *
 * Upstream: POST /api/v2/chat/completions
 * Note: some regions/accounts need captcha / X-Signature; if you get 4xx HTML or
 * signature errors, refresh token after a successful browser chat.
 */
const crypto = require('crypto');

const ZAI_BASE = (process.env.ZAI_URL || 'https://chat.z.ai').replace(/\/$/, '');
const ZAI_TOKEN = (process.env.ZAI_TOKEN || '').replace(/^Bearer\s+/i, '');
const FE_VERSION = process.env.ZAI_FE_VERSION || 'prod-fe-1.1.37';

const MODELS = [
  { slug: 'glm-5', label: 'GLM-5' },
  { slug: 'glm-5.1', label: 'GLM-5.1' },
  { slug: 'glm-5.2', label: 'GLM-5.2' },
  { slug: 'glm-5.3', label: 'GLM-5.3' },
  { slug: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
  { slug: 'glm-4.7', label: 'GLM-4.7' },
  { slug: 'zai', label: 'Z.AI default' },
];

const ALIASES = {
  zai: 'glm-5',
  glm: 'glm-5',
  'glm-flash': 'glm-5.3-flash',
  'chatglm': 'glm-5',
};

function resolveModel(name) {
  const n = String(name || 'glm-5').toLowerCase();
  return ALIASES[n] || name || 'glm-5';
}

function headers() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Origin': ZAI_BASE,
    'Referer': ZAI_BASE + '/',
    'Authorization': `Bearer ${ZAI_TOKEN}`,
    'X-FE-Version': FE_VERSION,
  };
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

function chatId() {
  // z.ai often wants UUID-like chat ids
  return crypto.randomUUID();
}

module.exports = async function zaiProxy(opts, res) {
  if (!ZAI_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({
      error: 'Set ZAI_TOKEN = localStorage.token from https://chat.z.ai',
    }));
  }

  const model = resolveModel(opts.model);
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

    const id = chatId();
    const body = {
      stream: true,
      model,
      messages: toMessages(opts.messages),
      chat_id: id,
      id,
      params: {},
      features: {
        enable_thinking: /think|reason/i.test(String(opts.model || '')),
      },
    };

    const url = `${ZAI_BASE}/api/v2/chat/completions`;
    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers(),
          'X-Region': process.env.ZAI_REGION || 'overseas',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('Z.AI fetch failed: ' + (e.message || e));
    }
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      if (/captcha|FRONTEND_CAPTCHA|verify/i.test(errText)) {
        throw new Error('Z.AI captcha required (Aliyun). Pure token is not enough on free Node — need browser captcha or official API key.');
      }
      if (upstream.status === 401 || upstream.status === 403) {
        throw new Error(`Z.AI auth ${upstream.status}: bad/expired ZAI_TOKEN or not authenticated — ${errText.slice(0, 180)}`);
      }
      throw new Error(`Z.AI ${upstream.status}: ${errText.slice(0, 220)}`);
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
          const evt = JSON.parse(raw);
          // OpenAI-like
          const d = evt.choices?.[0]?.delta || {};
          if (d.reasoning_content) safeWrite(`data: ${mk({ reasoning_content: d.reasoning_content })}\n\n`);
          if (d.content) safeWrite(`data: ${mk({ content: d.content })}\n\n`);
          // z.ai custom shapes
          if (evt.delta_content) safeWrite(`data: ${mk({ content: evt.delta_content })}\n\n`);
          if (typeof evt.content === 'string' && evt.content && !d.content) {
            // full replace style — emit as content (may duplicate; ok for v1)
            safeWrite(`data: ${mk({ content: evt.content })}\n\n`);
          }
          if (evt.data?.delta_content) safeWrite(`data: ${mk({ content: evt.data.delta_content })}\n\n`);
          if (evt.type === 'error' || evt.error) {
            const msg = evt.error?.message || evt.message || JSON.stringify(evt.error || evt);
            safeWrite(`data: ${mk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
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
module.exports.isConfigured = () => !!ZAI_TOKEN;
