'use strict';
const crypto = require('crypto');

function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].role === 'user') {
      const c = arr[i].content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
      }
      return JSON.stringify(c);
    }
  }
  return '';
}

function messagesToPlain(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr
    .map((m) => {
      const role = m.role || 'user';
      let content = m.content;
      if (typeof content !== 'string') {
        if (Array.isArray(content)) content = content.map((p) => p?.text || '').join('\n');
        else content = JSON.stringify(content);
      }
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startStream(res, model, id, created) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
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

function streamText(res, model, id, created, text) {
  if (!text) return;
  sseWrite(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
}

function endStream(res, model, id, created) {
  sseWrite(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamError(res, model, id, created, err, started) {
  const msg = `\n\n[Error: ${err && err.message ? err.message : err}]`;
  if (!started) startStream(res, model, id, created);
  streamText(res, model, id, created, msg);
  endStream(res, model, id, created);
}

function newIds(model) {
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    created: Math.floor(Date.now() / 1000),
    model: String(model || 'unknown'),
  };
}

function envCookie(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

async function readSseOpenAI(response, onDelta) {
  if (!response.body) {
    const t = await response.text();
    if (t) onDelta(t);
    return;
  }
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        const d = ev?.choices?.[0]?.delta || {};
        if (d.content) onDelta(d.content);
        if (d.reasoning_content) onDelta(d.reasoning_content, 'reasoning');
        if (typeof ev?.content === 'string') onDelta(ev.content);
        if (typeof ev?.token === 'string') onDelta(ev.token);
        if (typeof ev?.text === 'string') onDelta(ev.text);
        if (typeof ev?.delta === 'string') onDelta(ev.delta);
      } catch {
        if (payload && !payload.startsWith('{')) onDelta(payload);
      }
    }
  }
}

function makeProxy({ name, models, getCookie, run }) {
  async function handle(opts, res) {
    const stream = opts.stream !== false;
    const { id, created, model } = newIds(opts.model || models[0]?.slug || name);
    let started = false;
    try {
      if (stream) {
        startStream(res, model, id, created);
        started = true;
      }
      const cookie = getCookie();
      if (!cookie && name !== 'zenmux' && name !== 'arena') {
        // some free providers may work without
      }
      await run({
        opts,
        res,
        stream,
        id,
        created,
        model,
        cookie,
        started,
        write(text) {
          if (stream) streamText(res, model, id, created, text);
        },
        end() {
          if (stream) endStream(res, model, id, created);
        },
      });
    } catch (err) {
      if (stream) streamError(res, model, id, created, err, started);
      else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
      }
    }
  }
  handle.MODELS = models;
  handle.NAME = name;
  return handle;
}

module.exports = {
  lastUserText,
  messagesToPlain,
  sseWrite,
  startStream,
  streamText,
  endStream,
  streamError,
  newIds,
  envCookie,
  readSseOpenAI,
  makeProxy,
};
