'use strict';
/**
 * Grok Web → OpenAI SSE
 * Auth: full grok.com Cookie (sso + ideally cf_clearance)
 */
const crypto = require('crypto');

const GROK_NEW = process.env.GROK_URL || 'https://grok.com/rest/app-chat/conversations/new';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MODELS = [
  { slug: 'grok', modelName: 'grok-3', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-3', modelName: 'grok-3', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-4', modelName: 'grok-4', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-4-thinking', modelName: 'grok-4', modelMode: 'MODEL_MODE_GROK_4_1_THINKING' },
  { slug: 'grok-4-mini', modelName: 'grok-4-mini', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-2', modelName: 'grok-2', modelMode: 'MODEL_MODE_FAST' },
];

function modelInfo(id) {
  const m = String(id || '').toLowerCase().replace(/^grok\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function loadCookie() {
  let c = (process.env.GROK_COOKIE || '').trim();
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.grok || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
    for (const a of accounts) {
      const v = (a && a.values && a.values.GROK_COOKIE) || a.key || '';
      if (String(v).trim()) {
        c = String(v).trim();
        break;
      }
    }
  } catch (_) {}
  return c;
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

/** Streaming token only (not final message, not thinking) */
function extractStreamToken(ev, depth = 0) {
  if (ev == null || depth > 6) return '';
  if (typeof ev !== 'object') return '';
  if (Array.isArray(ev)) return '';

  if (ev.isThinking || ev.thinking || ev.is_thinking) return '';
  if (ev.messageTag === 'thinking' || ev.tag === 'thinking') return '';
  if (String(ev.messageType || ev.type || '').toLowerCase().includes('think')) return '';

  if (typeof ev.token === 'string') return ev.token;
  if (typeof ev.response_token === 'string') return ev.response_token;

  if (ev.result) return extractStreamToken(ev.result, depth + 1);
  if (ev.response) return extractStreamToken(ev.response, depth + 1);
  return '';
}

function extractFinalMessage(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const paths = [
    ev?.result?.modelResponse?.message,
    ev?.modelResponse?.message,
    ev?.result?.message,
    ev?.finalMessage,
  ];
  for (const p of paths) {
    if (typeof p === 'string' && p.trim()) return p;
  }
  if (ev.result) {
    const nested = extractFinalMessage(ev.result);
    if (nested) return nested;
  }
  return '';
}

function cleanGrokText(s) {
  let t = String(s || '');
  t = t.replace(/^Thinking about your request\s*/i, '');
  t = t.replace(/^Thinking[\s.…]*\n+/i, '');
  const half = Math.floor(t.length / 2);
  if (t.length >= 8 && t.slice(0, half) === t.slice(half)) {
    t = t.slice(0, half);
  }
  for (let n = Math.min(200, Math.floor(t.length / 2)); n >= 12; n--) {
    if (t.slice(-n) === t.slice(-2 * n, -n)) {
      t = t.slice(0, -n);
      break;
    }
  }
  return t.trim();
}

function parseStreamBody(text) {
  let streamed = '';
  let finalMsg = '';

  const lines = String(text || '').split(/\r?\n/);
  const extra = text.includes('}{') ? text.replace(/\}\s*\{/g, '}\n{').split('\n') : [];
  const allLines = lines.concat(extra);

  for (const line of allLines) {
    let payload = String(line || '').trim();
    if (!payload) continue;
    if (payload.startsWith('data:')) payload = payload.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    const fin = extractFinalMessage(ev);
    if (fin) finalMsg = fin;
    const tok = extractStreamToken(ev);
    if (tok) streamed += tok;
  }

  // Prefer final modelResponse (complete answer, no thinking stream)
  let full = finalMsg || streamed;

  if (!full) {
    try {
      const j = JSON.parse(text);
      full = extractFinalMessage(j) || extractStreamToken(j) || '';
    } catch (_) {}
  }

  full = cleanGrokText(full);
  return { full, chunks: [] };
}


async function handle(opts, res) {
  const cookie = loadCookie();
  const stream = opts.stream !== false;
  const model = String(opts.model || 'grok');
  const info = modelInfo(model);
  const message = lastUserText(opts.messages);
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
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

  if (!cookie) {
    const msg = '\n\n[Error: Grok not configured — set GROK_COOKIE via extension or Admin]';
    if (stream) {
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
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: msg } }));
  }

  const body = {
    temporary: true,
    modelName: info.modelName,
    modelMode: info.modelMode,
    message,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: false,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: false,
    enableSideBySide: false,
  };

  try {
    const r = await fetch(GROK_NEW, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': UA,
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/',
        Cookie: cookie,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    if (!r.ok) {
      if (/just a moment|cf-browser-verification|cloudflare|attention required/i.test(text)) {
        throw new Error(
          'Cloudflare challenge — re-capture GROK_COOKIE with extension (include cf_clearance). Render IP may be blocked.'
        );
      }
      throw new Error(`Grok ${r.status}: ${text.slice(0, 220)}`);
    }

    if (/just a moment|cf-browser-verification|cloudflare/i.test(text) && text.length < 5000) {
      throw new Error(
        'Cloudflare HTML instead of chat stream — re-capture cookies or use a non-datacenter IP'
      );
    }

    const { full } = parseStreamBody(text);

    if (full) {
      if (stream) {
        sseWrite(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: full }, finish_reason: null }],
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
          choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        })
      );
    }

    // Empty — surface a short body sample for debugging
    const sample = String(text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    const msg =
      '\n\n[Error: Grok empty reply' +
      (sample ? ' — upstream: ' + sample : ' — no parseable tokens; try re-capture cookie') +
      ']';
    if (stream) {
      sseWrite(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
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
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: msg }, finish_reason: 'stop' }],
      })
    );
  } catch (e) {
    const msg = '\n\n[Error: ' + (e.message || String(e)) + ']';
    if (stream) {
      try {
        sseWrite(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
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
      } catch (_) {}
    }
    try {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message || String(e) } }));
    } catch (_) {}
  }
}

handle.MODELS = MODELS;
module.exports = handle;
module.exports.MODELS = MODELS;
