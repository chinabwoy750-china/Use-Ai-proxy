'use strict';
/**
 * Perchance AI Text-to-Image → OpenAI /v1/images/generations
 *
 * Upstream: https://image-generation.perchance.org/api
 * Channel:  ai-text-to-image-generator (https://perchance.org/ai-text-to-image-generator)
 *
 * Auth: optional PERCHANCE_USER_KEY (from browser). If missing, tries /verifyUser
 * (often blocked by Cloudflare on datacenter IPs — then paste key in Admin).
 */
const crypto = require('crypto');

const API = (process.env.PERCHANCE_API || 'https://image-generation.perchance.org/api').replace(/\/$/, '');
const CHANNEL = process.env.PERCHANCE_CHANNEL || 'ai-text-to-image-generator';
const GENERATOR = process.env.PERCHANCE_GENERATOR || 'ai-image-generator';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MODELS = [
  { slug: 'perchance', label: 'Perchance AI T2I' },
  { slug: 'perchance-t2i', label: 'Perchance T2I alias' },
  { slug: 'perchance-square', label: '512x512' },
  { slug: 'perchance-portrait', label: '512x768' },
  { slug: 'perchance-landscape', label: '768x512' },
];

let cachedKey = '';
let cachedKeyAt = 0;
const KEY_TTL_MS = 25 * 60 * 1000; // keys often last ~30m

function loadKeyFromEnv() {
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.perchance || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
    for (const a of accounts) {
      const v = (a && a.values) || {};
      const k = String(v.PERCHANCE_USER_KEY || a.key || '').trim();
      if (k) return k;
    }
  } catch (_) {}
  return String(process.env.PERCHANCE_USER_KEY || '').trim();
}

function headers() {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://perchance.org',
    Referer: 'https://perchance.org/ai-text-to-image-generator',
  };
}

async function fetchUserKey(force = false) {
  const envKey = loadKeyFromEnv();
  if (envKey && !force) return envKey;
  if (!force && cachedKey && Date.now() - cachedKeyAt < KEY_TTL_MS) return cachedKey;

  const url =
    `${API}/verifyUser?thread=0&__cacheBust=${Math.random()}`;
  const r = await fetch(url, { method: 'GET', headers: headers() });
  const text = await r.text();
  if (!r.ok) {
    if (/just a moment|cloudflare/i.test(text)) {
      throw new Error(
        'Perchance Cloudflare blocked verifyUser — open perchance.org/ai-text-to-image-generator, DevTools → Network → verifyUser → copy userKey into Admin (PERCHANCE_USER_KEY)'
      );
    }
    throw new Error(`Perchance verifyUser ${r.status}: ${text.slice(0, 160)}`);
  }
  let key = '';
  try {
    const j = JSON.parse(text);
    key = j.userKey || j.user_key || j.key || '';
  } catch (_) {
    const m = text.match(/"userKey"\s*:\s*"([^"]+)"/);
    if (m) key = m[1];
  }
  if (!key) throw new Error('Perchance verifyUser: no userKey in response');
  cachedKey = key;
  cachedKeyAt = Date.now();
  return key;
}

function resolutionFor(opts) {
  const model = String(opts.model || '').toLowerCase();
  if (model.includes('portrait')) return '512x768';
  if (model.includes('landscape')) return '768x512';
  if (model.includes('square')) return '512x512';
  // OpenAI size
  const size = String(opts.size || '').toLowerCase();
  if (size === '512x768' || size === 'portrait') return '512x768';
  if (size === '768x512' || size === 'landscape') return '768x512';
  if (size === '1024x1024') return '512x512';
  if (/^\d+x\d+$/.test(size)) return size;
  return process.env.PERCHANCE_RESOLUTION || '512x512';
}

async function generateOnce(userKey, prompt, negative, seed, resolution, guidance) {
  const requestId = 'aiImageCompletion' + Math.floor(Math.random() * 2 ** 30);
  const params = new URLSearchParams({
    prompt: String(prompt || ''),
    negativePrompt: String(negative || ''),
    userKey: String(userKey),
    __cacheBust: String(Math.random()),
    seed: String(seed == null ? -1 : seed),
    resolution: String(resolution),
    guidanceScale: String(guidance == null ? 7 : guidance),
    channel: CHANNEL,
    subChannel: 'public',
    requestId,
    generatorName: GENERATOR,
  });

  // Prefer GET (common in community clients); fall back POST
  let r = await fetch(`${API}/generate?${params.toString()}`, {
    method: 'GET',
    headers: headers(),
  });
  let text = await r.text();
  if (!r.ok && r.status !== 400) {
    r = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generatorName: GENERATOR,
        channel: CHANNEL,
        subChannel: 'public',
        prompt,
        negativePrompt: negative || '',
        seed: seed == null ? -1 : seed,
        resolution,
        guidanceScale: guidance == null ? 7 : guidance,
        userKey,
        requestId,
      }),
    });
    text = await r.text();
  }

  if (/invalid_key|invalid key/i.test(text)) {
    const err = new Error('invalid_key');
    err.code = 'invalid_key';
    throw err;
  }
  if (!r.ok) {
    throw new Error(`Perchance generate ${r.status}: ${text.slice(0, 180)}`);
  }

  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Perchance generate: bad JSON ' + text.slice(0, 120));
  }

  // shapes: { status, fileUrl, imageId } or { data: { ... } }
  const data = j.data || j;
  return data;
}

async function waitForImage(userKey, prompt, negative, seed, resolution, guidance, timeoutMs = 90000) {
  const start = Date.now();
  let last = null;
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    last = await generateOnce(userKey, prompt, negative, seed, resolution, guidance);
    const status = String(last.status || last.state || '').toLowerCase();
    const imageId = last.imageId || last.id || last.fileName || '';
    const fileUrl = last.fileUrl || last.url || last.imageUrl || '';

    if (fileUrl || (imageId && (status === 'success' || status === 'done' || status === 'complete' || last.success))) {
      return last;
    }
    // sometimes imageId appears while still waiting
    if (imageId && attempt > 1 && (status === 'success' || !status || status === 'ready')) {
      return last;
    }
    await new Promise((r) => setTimeout(r, status === 'waiting' || status === 'queued' || status === 'pending' ? 2500 : 1500));
  }
  throw new Error('Perchance timeout waiting for image: ' + JSON.stringify(last).slice(0, 200));
}

async function downloadImage(result) {
  const fileUrl = result.fileUrl || result.url || result.imageUrl || '';
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    const r = await fetch(fileUrl, { headers: headers() });
    if (!r.ok) throw new Error('Perchance download URL ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf;
  }
  const imageId = result.imageId || result.id || result.fileName;
  if (!imageId) throw new Error('Perchance: no imageId/url in result');
  const url = `${API}/downloadTemporaryImage?imageId=${encodeURIComponent(imageId)}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Perchance download ${r.status}: ${t.slice(0, 120)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

/**
 * OpenAI-compatible image generation
 * POST body: { prompt, n?, size?, model?, response_format?, negative_prompt? }
 */
async function handleImage(opts, res) {
  const prompt = String(opts.prompt || opts.input || '').trim();
  if (!prompt) return sendJson(res, 400, { error: { message: 'prompt required' } });

  const n = Math.min(Math.max(parseInt(opts.n || '1', 10) || 1, 1), 4);
  const resolution = resolutionFor(opts);
  const guidance = opts.guidance_scale != null ? Number(opts.guidance_scale) : 7;
  const negative = opts.negative_prompt || opts.negativePrompt || '';
  const fmt = String(opts.response_format || 'b64_json').toLowerCase();
  const seedBase = opts.seed != null ? Number(opts.seed) : -1;

  try {
    let userKey = await fetchUserKey(false);
    const data = [];

    for (let i = 0; i < n; i++) {
      const seed = seedBase === -1 ? -1 : seedBase + i;
      let result;
      try {
        result = await waitForImage(userKey, prompt, negative, seed, resolution, guidance);
      } catch (e) {
        if (e.code === 'invalid_key' || /invalid_key/i.test(e.message || '')) {
          cachedKey = '';
          userKey = await fetchUserKey(true);
          result = await waitForImage(userKey, prompt, negative, seed, resolution, guidance);
        } else {
          throw e;
        }
      }

      if (fmt === 'url') {
        const url =
          result.fileUrl ||
          result.url ||
          (result.imageId
            ? `${API}/downloadTemporaryImage?imageId=${encodeURIComponent(result.imageId)}`
            : '');
        if (!url) throw new Error('Perchance: no image url');
        data.push({ url, revised_prompt: prompt });
      } else {
        const buf = await downloadImage(result);
        data.push({
          b64_json: buf.toString('base64'),
          revised_prompt: prompt,
        });
      }
    }

    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data,
    });
  } catch (e) {
    return sendJson(res, 502, {
      error: {
        message: e.message || String(e),
        type: 'perchance_error',
      },
    });
  }
}

// Chat fallback: tell client to use images endpoint
async function handleChat(opts, res) {
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const model = opts.model || 'perchance';
  const msg =
    'Perchance is an image model. Use POST /v1/images/generations with {"prompt":"...","model":"perchance"}.';
  if (opts.stream !== false) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: msg }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  return sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: msg }, finish_reason: 'stop' }],
  });
}

handleChat.handleImage = handleImage;
handleChat.MODELS = MODELS;
handleChat.isConfigured = () => true; // public with optional key
module.exports = handleChat;
module.exports.handleImage = handleImage;
module.exports.MODELS = MODELS;
