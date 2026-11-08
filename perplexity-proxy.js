'use strict';
/**
 * Perplexity Web → OpenAI SSE
 * Auth: __Secure-next-auth.session-token (cookie value or full Cookie header)
 * Endpoint: https://www.perplexity.ai/rest/sse/perplexity_ask
 */
const crypto = require('crypto');

const PPLX_SSE = 'https://www.perplexity.ai/rest/sse/perplexity_ask';
const PPLX_API_VERSION = '2.18';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MODELS = [
  { slug: 'perplexity', mode: 'copilot', pref: 'pplx_pro' },
  { slug: 'pplx-auto', mode: 'concise', pref: 'pplx_pro' },
  { slug: 'pplx-sonar', mode: 'copilot', pref: 'experimental' },
  { slug: 'pplx-gpt', mode: 'copilot', pref: 'gpt54' },
  { slug: 'pplx-gemini', mode: 'copilot', pref: 'gemini31pro_high' },
  { slug: 'pplx-sonnet', mode: 'copilot', pref: 'claude46sonnet' },
  { slug: 'pplx-opus', mode: 'copilot', pref: 'claude46opus' },
];

function modelInfo(id) {
  const m = String(id || '').toLowerCase().replace(/^perplexity\//, '');
  return MODELS.find((x) => x.slug === m) || MODELS[0];
}

function getCookie() {
  let c = (process.env.PERPLEXITY_COOKIE || process.env.PERPLEXITY_TOKEN || '').trim();
  if (!c) return '';
  // Bare JWT / token value
  if (!c.includes('=') && !c.includes(';')) {
    c = `__Secure-next-auth.session-token=${c}`;
  }
  return c;
}

function cookieHasSession(c) {
  return /(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=/.test(c) ||
    /session-token=/i.test(c);
}

function isCloudflareHtml(text) {
  const s = String(text || '');
  return /<!DOCTYPE|<html|cf-browser-verification|Just a moment|challenge-platform|cf-challenge/i.test(s);
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

function buildBody(query, mode, modelPref) {
  const tz = 'UTC';
  return {
    query_str: query,
    params: {
      query_str: query,
      search_focus: 'internet',
      mode,
      model_preference: modelPref,
      sources: ['web'],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: PPLX_API_VERSION,
      language: 'en-US',
      timezone: tz,
      in_page: 'home',
      search_recency_filter: null,
      is_related_query: false,
      is_voice_to_voice: false,
      use_web_results: true,
    },
  };
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function extractDeltas(event) {
  const out = [];
  const blocks = event?.blocks || event?.data?.blocks || [];
  for (const block of blocks) {
    const mb = block.markdown_block || block.markdownBlock;
    if (!mb) continue;
    const chunks = mb.chunks || [];
    if (chunks.length) out.push(chunks.join(''));
  }
  if (!out.length && typeof event?.text === 'string') out.push(event.text);
  if (!out.length && typeof event?.answer === 'string') out.push(event.answer);
  return out.join('');
}

async function handle(opts, res) {
  const cookie = getCookie();
  const stream = opts.stream !== false;
  const model = String(opts.model || 'perplexity');
  const info = modelInfo(model);
  const query = lastUserText(opts.messages);
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': UA,
    Origin: 'https://www.perplexity.ai',
    Referer: 'https://www.perplexity.ai/',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
  if (cookie) headers.Cookie = cookie;

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
    const msg = '\n\n[Error: Perplexity not configured — set PERPLEXITY_COOKIE]';
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
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: msg } }));
  }

  if (!query) {
    const msg = '\n\n[Error: empty user message]';
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
  }

  if (!cookieHasSession(cookie)) {
    const msg =
      '\n\n[Error: PERPLEXITY_COOKIE is missing __Secure-next-auth.session-token. ' +
      'document.cookie cannot read it (HttpOnly). Copy it from DevTools → Application → Cookies → perplexity.ai]';
    if (stream) {
      sseWrite(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: msg }, finish_reason: null }] });
      sseWrite(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }

  try {
    const r = await fetch(PPLX_SSE, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(query, info.mode, info.pref)),
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      if (r.status === 403 && isCloudflareHtml(bodyText)) {
        // Common on Render/datacenter IPs even with valid session + cf_clearance
        throw new Error(
          'Perplexity 403 Cloudflare challenge — session cookie missing/expired, or Render IP blocked. ' +
            'Copy FULL cookies including HttpOnly __Secure-next-auth.session-token from Application → Cookies (not document.cookie).'
        );
      }
      throw new Error(`Perplexity ${r.status}: ${bodyText.slice(0, 200)}`);
    }

    let seen = '';
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        const full = extractDeltas(ev);
        if (full && full.length > seen.length) {
          const delta = full.slice(seen.length);
          seen = full;
          if (stream && delta) {
            sseWrite(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
          }
        }
      }
    }

    if (!seen) {
      const msg = '\n\n[Error: Perplexity empty reply — cookie may be expired]';
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
        choices: [{ index: 0, message: { role: 'assistant', content: seen }, finish_reason: 'stop' }],
      })
    );
  } catch (err) {
    const msg = `\n\n[Error: ${err.message || err}]`;
    if (stream) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
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
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
  }
}

handle.MODELS = MODELS;
module.exports = handle;
