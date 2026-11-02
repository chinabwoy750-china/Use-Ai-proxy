'use strict';
/**
 * Veo AI Free (veoaifree.com) — best-effort free image/video
 * No credentials. Heavily rate-limited (~6/hour/IP). API paths may change.
 */
const crypto = require('crypto');

const ORIGIN = process.env.VEO_URL || 'https://veoaifree.com';

const MODELS = [
  { slug: 'veo', kind: 'video' },
  { slug: 'veo-free', kind: 'video' },
  { slug: 'veo-image', kind: 'image' },
  { slug: 'nano-banana', kind: 'image' },
];

function modelInfo(id) {
  const m = String(id || '').toLowerCase().replace(/^veo\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function enabled() {
  return process.env.VEO_ENABLED !== '0';
}

function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].role === 'user') {
      const c = arr[i].content;
      return typeof c === 'string' ? c : JSON.stringify(c);
    }
  }
  return '';
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function tryGenerate(prompt, kind) {
  // Probe common free-tier endpoints; sites change often.
  const paths =
    kind === 'video'
      ? ['/api/video', '/api/generate/video', '/api/v1/video']
      : ['/api/image', '/api/generate/image', '/api/v1/image'];

  let lastErr = 'no endpoint worked';
  for (const p of paths) {
    try {
      const r = await fetch(ORIGIN + p, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: ORIGIN,
          Referer: ORIGIN + '/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ prompt, model: kind === 'video' ? 'veo' : 'nano-banana' }),
      });
      const t = await r.text();
      if (!r.ok) {
        lastErr = `${p} → ${r.status} ${t.slice(0, 100)}`;
        continue;
      }
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        lastErr = `${p} non-json`;
        continue;
      }
      const url = j.url || j.video_url || j.image_url || j.data?.[0]?.url || j.result;
      if (url) return String(url);
      lastErr = `${p} no url field`;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(`Veo free failed (${lastErr}). Site may have changed or rate-limited.`);
}

async function handle(opts, res) {
  const stream = opts.stream !== false;
  const model = String(opts.model || 'veo');
  const info = modelInfo(model);
  const prompt = lastUserText(opts.messages) || opts.prompt || '';
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    sseWrite(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  }

  try {
    if (!enabled()) throw new Error('Veo disabled — set VEO_ENABLED=1');
    if (!prompt) throw new Error('empty prompt');
    const url = await tryGenerate(prompt, info.kind);
    const content =
      info.kind === 'video' ? `Video: ${url}\n${url}` : `![image](${url})\n${url}`;
    if (stream) {
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      })
    );
  } catch (err) {
    const msg = `\n\n[Error: ${err.message || err}]`;
    if (stream) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
      }
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

handle.MODELS = MODELS;
module.exports = handle;
