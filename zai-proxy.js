'use strict';
/**
 * chat.z.ai web proxy with HMAC X-Signature (from community reverse).
 * Env: ZAI_TOKEN (required), ZAI_URL, ZAI_FE_VERSION, ZAI_SIGNING_SECRET, ZAI_REGION
 */
const crypto = require('crypto');
const { signRequest } = require('./zai-signer');

const ZAI_BASE = (process.env.ZAI_URL || 'https://chat.z.ai').replace(/\/$/, '');
const ZAI_TOKEN = (process.env.ZAI_TOKEN || '').replace(/^Bearer\s+/i, '');
const FE_VERSION = process.env.ZAI_FE_VERSION || 'prod-fe-1.3.0';
const REGION = process.env.ZAI_REGION || 'overseas';

const MODELS = [
  { slug: 'glm-5', label: 'GLM-5' },
  { slug: 'glm-5.2', label: 'GLM-5.2' },
  { slug: 'glm-5.3', label: 'GLM-5.3' },
  { slug: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
  { slug: 'glm-4.7', label: 'GLM-4.7' },
  { slug: 'zai', label: 'Z.AI default' },
];

const ALIASES = {
  zai: 'glm-5.3-flash',
  glm: 'glm-5.3',
  'glm-flash': 'glm-5.3-flash',
  'glm-5': 'glm-5.3',
};

function resolveModel(name) {
  const n = String(name || 'glm-5.3-flash').toLowerCase();
  return ALIASES[n] || name || 'glm-5.3-flash';
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

module.exports = async function zaiProxy(opts, res) {
  if (!ZAI_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(JSON.stringify({ error: 'Set ZAI_TOKEN from chat.z.ai localStorage.token' }));
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

    const prompt = lastUser(opts.messages);
    const signed = signRequest(ZAI_TOKEN, prompt);
    const qs = new URLSearchParams(signed.params || {}).toString();
    const url = `${ZAI_BASE}/api/v2/chat/completions${qs ? '?' + qs : ''}`;

    const msgId = crypto.randomUUID();
    const body = {
      model,
      messages: toMessages(opts.messages),
      stream: true,
      id: msgId,
      chat_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      signature_prompt: prompt,
      params: {},
      features: {
        enable_thinking: false,
        web_search: false,
        auto_web_search: false,
      },
    };

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Origin: ZAI_BASE,
        Referer: ZAI_BASE + '/',
        Authorization: `Bearer ${ZAI_TOKEN}`,
        'X-Signature': signed.signature,
        'X-FE-Version': FE_VERSION,
        'X-Region': REGION,
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      if (/captcha|FRONTEND_CAPTCHA/i.test(errText)) {
        throw new Error('Z.AI captcha required — HMAC alone not enough; need Playwright oracle or official API');
      }
      throw new Error(`Z.AI ${upstream.status}: ${errText.slice(0, 280)}`);
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
          if (evt.error) {
            safeWrite(`data: ${mk({ content: '\n\n[Error: ' + JSON.stringify(evt.error) + ']' })}\n\n`);
            continue;
          }
          const text =
            evt.delta_content ||
            evt.choices?.[0]?.delta?.content ||
            (typeof evt.content === 'string' ? evt.content : '') ||
            '';
          if (text) safeWrite(`data: ${mk({ content: text })}\n\n`);
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
