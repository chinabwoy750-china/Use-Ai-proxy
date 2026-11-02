'use strict';
/**
 * Grok Web → OpenAI SSE
 * Auth: full grok.com Cookie header (sso + preferably cf_clearance)
 * Note: Cloudflare may block plain Node fetch; works best when CF cookies match.
 */
const crypto = require('crypto');

const GROK_NEW = 'https://grok.com/rest/app-chat/conversations/new';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MODELS = [
  { slug: 'grok', modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-4', modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-4-thinking', modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_GROK_4_1_THINKING' },
  { slug: 'grok-4-mini', modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_GROK_4_1_MINI_THINKING' },
  { slug: 'grok-4-expert', modelName: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_EXPERT' },
];

function modelInfo(id) {
  const m = String(id || '').toLowerCase().replace(/^grok\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function getCookie() {
  return (process.env.GROK_COOKIE || '').trim();
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

function extractGrokText(ev) {
  // conversations/new streams JSON lines with result / token / message fields
  if (!ev || typeof ev !== 'object') return '';
  const r = ev.result || ev;
  if (typeof r.token === 'string') return r.token;
  if (typeof r.response_token === 'string') return r.response_token;
  if (r.message && typeof r.message === 'string') return r.message;
  if (typeof r.modelResponse === 'string') return r.modelResponse;
  if (r.modelResponse && typeof r.modelResponse.message === 'string') return r.modelResponse.message;
  if (typeof ev.token === 'string') return ev.token;
  return '';
}

async function handle(opts, res) {
  const cookie = getCookie();
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
    const msg = '\n\n[Error: Grok not configured — set GROK_COOKIE to full grok.com Cookie header]';
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
        Accept: 'text/event-stream, application/json',
        'User-Agent': UA,
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/',
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });

    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    if (!r.ok) {
      if (/just a moment|cf-browser-verification|cloudflare/i.test(text)) {
        throw new Error('Cloudflare challenge — re-copy Cookie (incl. cf_clearance) from a browser on a similar network');
      }
      throw new Error(`Grok ${r.status}: ${text.slice(0, 180)}`);
    }

    let full = '';
    // NDJSON or SSE
    for (const line of text.split(/\r?\n/)) {
      let payload = line.trim();
      if (!payload) continue;
      if (payload.startsWith('data:')) payload = payload.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      const tok = extractGrokText(ev);
      if (tok) {
        full += tok;
        if (stream) {
          sseWrite(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: tok }, finish_reason: null }],
          });
        }
      }
    }

    // sometimes a single JSON object
    if (!full) {
      try {
        const j = JSON.parse(text);
        const t =
          j?.result?.modelResponse?.message ||
          j?.modelResponse?.message ||
          j?.message ||
          '';
        if (t) {
          full = t;
          if (stream) {
            sseWrite(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
            });
          }
        }
      } catch (_) {}
    }

    if (!full) {
      const msg = '\n\n[Error: Grok empty reply]';
      if (stream) {
        sseWrite(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: msg }, finish_reason: null }],
        });
      }
    }

    if (stream) {
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
