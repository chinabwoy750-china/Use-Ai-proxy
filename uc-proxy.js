'use strict';
/**
 * UC Web (uncensored.com) — image generation via internal API
 * Requires full Cookie header including HttpOnly __client
 * Chat completions return markdown image URL when successful.
 */
const crypto = require('crypto');

const UC_ORIGIN = 'https://uncensored.com';
const UC_CLERK = 'https://clerk.uncensored.com';
const UC_IMAGE = 'https://internal.chatuncensored.ai/v2/image-gen';
const CLERK_JS = '5.127.1';

const MODELS = [
  { slug: 'uc', model: 'seedream-v4.5' },
  { slug: 'uc-seedream', model: 'seedream-v4.5' },
  { slug: 'uc-seedream-v5', model: 'seedream-v5' },
  { slug: 'uc-nano', model: 'nano-banana-pro' },
  { slug: 'glm-image', model: 'seedream-v4.5' },
];

function modelInfo(id) {
  const m = String(id || '').toLowerCase().replace(/^uc\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function getCookie() {
  return (process.env.UC_COOKIE || '').trim();
}

function parseJar(header) {
  const jar = new Map();
  for (const part of String(header || '').split(';')) {
    const t = part.trim();
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    jar.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return jar;
}

function jarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function mintSession(cookieHeader) {
  const jar = parseJar(cookieHeader);
  const client = jar.get('__client');
  if (!client) {
    throw new Error(
      'UC credential missing the __client cookie — paste the full uncensored.com Cookie header from a logged-in session'
    );
  }
  const clerkHeaders = {
    Cookie: jarHeader(jar),
    Origin: UC_ORIGIN,
    Referer: `${UC_ORIGIN}/`,
    Accept: 'application/json',
  };

  // Resolve session id
  let sid = null;
  const claims = decodeJwt(client);
  if (claims && claims.sid) sid = claims.sid;

  if (!sid) {
    const cr = await fetch(`${UC_CLERK}/v1/client?_clerk_js_version=${CLERK_JS}`, {
      headers: clerkHeaders,
    });
    if (!cr.ok) throw new Error(`UC Clerk client ${cr.status}`);
    const cj = await cr.json().catch(() => null);
    const sessions = cj?.response?.sessions || cj?.client?.sessions || cj?.sessions || [];
    if (Array.isArray(sessions) && sessions[0]?.id) sid = sessions[0].id;
    // rotate __client if returned
    const set = typeof cr.headers.getSetCookie === 'function' ? cr.headers.getSetCookie() : [];
    for (const sc of set) {
      const m = String(sc).match(/^__client=([^;]+)/);
      if (m) jar.set('__client', m[1]);
    }
  }

  if (!sid) throw new Error('UC Clerk session not found — log in again and re-copy cookies including __client');

  const res = await fetch(
    `${UC_CLERK}/v1/client/sessions/${encodeURIComponent(sid)}/tokens?_clerk_js_version=${CLERK_JS}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: UC_ORIGIN,
        Referer: `${UC_ORIGIN}/`,
        Cookie: jarHeader(jar),
      },
      body: '',
    }
  );
  if (!res.ok) {
    const d = await res.text().catch(() => '');
    throw new Error(`UC Clerk token mint failed (HTTP ${res.status}) ${d.slice(0, 160)}`);
  }
  const body = await res.json().catch(() => null);
  const jwt = body?.jwt;
  if (!jwt) throw new Error('UC Clerk token mint returned no jwt');
  const uid = decodeJwt(jwt)?.uid || '';
  return { jwt, uid, cookie: jarHeader(jar) };
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

async function generateImage(prompt, modelVersion, auth) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.jwt}`,
    Cookie: auth.cookie,
    Origin: UC_ORIGIN,
    Referer: `${UC_ORIGIN}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };
  const body = {
    prompt,
    model_version: modelVersion,
    imageWidth: '1024',
    imageHeight: '1024',
    mode: 'dev',
    moderation_mode: 'SUPER_LIGHT',
    country: 'US',
  };
  const r = await fetch(UC_IMAGE, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`UC image ${r.status}: ${text.slice(0, 200)}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('UC image invalid JSON');
  }
  const url =
    j?.url ||
    j?.image_url ||
    j?.images?.[0]?.url ||
    j?.data?.[0]?.url ||
    (Array.isArray(j?.data) && j.data[0]) ||
    '';
  if (!url || typeof url !== 'string') throw new Error('UC image response had no url');
  return url;
}

async function handle(opts, res) {
  const stream = opts.stream !== false;
  const model = String(opts.model || 'uc');
  const info = modelInfo(model);
  const prompt = lastUserText(opts.messages) || opts.prompt || '';
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const cookie = getCookie();

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
    if (!cookie) throw new Error('UC not configured — set UC_COOKIE');
    if (!prompt) throw new Error('empty prompt');
    const auth = await mintSession(cookie);
    const url = await generateImage(prompt, info.model, auth);
    const content = `![image](${url})\n${url}`;
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
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
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

/** OpenAI images API shape */
async function handleImage(opts, res) {
  try {
    const cookie = getCookie();
    if (!cookie) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'UC_COOKIE required' } }));
    }
    const prompt = opts.prompt || '';
    const info = modelInfo(opts.model || 'uc');
    const auth = await mintSession(cookie);
    const url = await generateImage(prompt, info.model, auth);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url }] }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

handle.MODELS = MODELS;
handle.handleImage = handleImage;
module.exports = handle;
