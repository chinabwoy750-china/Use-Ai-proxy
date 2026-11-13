'use strict';
/**
 * Google AI Studio / Gemini API (OpenAI-style surface via this proxy)
 *
 * Prefer: AISTUDIO_API_KEY or GEMINI_API_KEY or GOOGLE_API_KEY
 * (create free key at https://aistudio.google.com/apikey )
 *
 * Cookie-only web reverse for aistudio.google.com is fragile; API key is reliable.
 */
const crypto = require('crypto');
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');

const API_BASE = (process.env.AISTUDIO_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

const GEMINI_MODELS = [
  { slug: 'gemini-2.0-flash', id: 'gemini-2.0-flash' },
  { slug: 'gemini-2.0-flash-lite', id: 'gemini-2.0-flash-lite' },
  { slug: 'gemini-2.5-flash', id: 'gemini-2.5-flash' },
  { slug: 'gemini-2.5-flash-lite', id: 'gemini-2.5-flash-lite' },
  { slug: 'gemini-2.5-pro', id: 'gemini-2.5-pro' },
  { slug: 'gemini-flash-latest', id: 'gemini-flash-latest' },
  { slug: 'gemini-flash-lite-latest', id: 'gemini-flash-lite-latest' },
  { slug: 'gemini-pro-latest', id: 'gemini-pro-latest' },
  { slug: 'gemini-2.0-flash-exp', id: 'gemini-2.0-flash-exp' },
];

const MODELS = [
  { slug: 'aistudio', id: 'gemini-2.0-flash' },
  { slug: 'gemini', id: 'gemini-2.0-flash' },
  ...GEMINI_MODELS,
];

function loadApiKey() {
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.aistudio || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
    for (const a of accounts) {
      const v = (a && a.values) || {};
      const k = String(
        v.AISTUDIO_API_KEY || v.GEMINI_API_KEY || v.GOOGLE_API_KEY || a.key || ''
      ).trim();
      if (k) return k;
    }
  } catch (_) {}
  return (
    process.env.AISTUDIO_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    envCookie('AISTUDIO_API_KEY', 'GEMINI_API_KEY') ||
    ''
  ).trim();
}

function resolveModel(name) {
  const m = String(name || 'gemini-2.0-flash')
    .toLowerCase()
    .replace(/^aistudio\//, '')
    .replace(/^google\//, '')
    .trim();
  if (m === 'aistudio' || m === 'gemini' || m === 'google') return 'gemini-2.0-flash';
  const hit = MODELS.find((x) => x.slug === m);
  return (hit && hit.id) || m;
}

function toGeminiContents(messages) {
  const contents = [];
  let system = '';
  for (const msg of messages || []) {
    if (!msg) continue;
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + String(msg.content || '');
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let text = msg.content;
    if (Array.isArray(text)) {
      text = text
        .filter((p) => p && (p.type === 'text' || p.text))
        .map((p) => p.text || '')
        .join('\n');
    }
    contents.push({ role, parts: [{ text: String(text || '') }] });
  }
  if (system && contents.length) {
    contents[0].parts.unshift({ text: system + '\n\n' });
  } else if (system) {
    contents.unshift({ role: 'user', parts: [{ text: system }] });
  }
  return contents;
}

function extractGeminiText(obj) {
  try {
    const parts = obj?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('');
  } catch {
    return '';
  }
}

async function streamGemini(apiKey, modelId, messages, write, end) {
  const url =
    `${API_BASE}/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: { temperature: 0.9 },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`AI Studio/Gemini ${r.status}: ${t.slice(0, 220)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let got = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const raw = line.trim();
      if (!raw.startsWith('data:')) continue;
      const payload = raw.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const text = extractGeminiText(obj);
        if (text) {
          got = true;
          write(text);
        }
      } catch (_) {}
    }
  }
  if (!got) write('\n\n[Error: Gemini empty reply]');
  end();
}

async function nonStreamGemini(apiKey, modelId, messages) {
  const url =
    `${API_BASE}/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      generationConfig: { temperature: 0.9 },
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`AI Studio/Gemini ${r.status}: ${t.slice(0, 220)}`);
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error('Gemini bad JSON');
  }
  return extractGeminiText(j) || '';
}

const proxy = makeProxy({
  name: 'aistudio',
  models: MODELS,
  getCookie: () => loadApiKey(),
  async run(ctx) {
    const apiKey = loadApiKey();
    if (!apiKey) {
      throw new Error(
        'AISTUDIO_API_KEY required — create a free key at https://aistudio.google.com/apikey and paste it in Admin (Google AI Studio)'
      );
    }
    const modelId = resolveModel(ctx.opts.model);
    const messages =
      ctx.opts.messages || [{ role: 'user', content: lastUserText(ctx.opts.messages) }];

    if (ctx.stream !== false) {
      await streamGemini(apiKey, modelId, messages, ctx.write, ctx.end);
      return;
    }
    const text = await nonStreamGemini(apiKey, modelId, messages);
    ctx.write(text || '\n\n[Error: Gemini empty]');
    ctx.end();
  },
});

proxy.MODELS = MODELS;
proxy.isConfigured = () => !!loadApiKey();
module.exports = proxy;
module.exports.MODELS = MODELS;
