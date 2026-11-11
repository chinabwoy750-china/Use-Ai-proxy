'use strict';
/**
 * Grok Web → OpenAI SSE
 * Auth: full grok.com Cookie (sso + ideally cf_clearance)
 *
 * Model ids / modes below are taken from grok.com's live client bundle
 * (chat-page-store: modelModeToModelConfigModelMode) — do not invent new ones.
 */
const crypto = require('crypto');

const GROK_NEW = process.env.GROK_URL || 'https://grok.com/rest/app-chat/conversations/new';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// modelName = grok.com model id, modelMode = its ModelMode enum.
const MODELS = [
  { slug: 'grok', label: 'Grok (fast)', modelName: 'grok-3', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-fast', label: 'Grok Fast', modelName: 'grok-3', modelMode: 'MODEL_MODE_FAST' },
  { slug: 'grok-auto', label: 'Grok Auto', modelName: 'grok-4-auto', modelMode: 'MODEL_MODE_AUTO' },
  { slug: 'grok-expert', label: 'Grok Expert', modelName: 'grok-4', modelMode: 'MODEL_MODE_EXPERT' },
  { slug: 'grok-heavy', label: 'Grok Heavy', modelName: 'grok-4-heavy', modelMode: 'MODEL_MODE_HEAVY' },
  { slug: 'grok-4-1', label: 'Grok 4.1', modelName: 'grok-4-1', modelMode: 'MODEL_MODE_GROK_4_1' },
  {
    slug: 'grok-4-1-thinking',
    label: 'Grok 4.1 Thinking',
    modelName: 'grok-4-1-thinking',
    modelMode: 'MODEL_MODE_GROK_4_1_THINKING',
  },
  {
    slug: 'grok-4-1-nightly',
    label: 'Grok 4.1 Nightly',
    modelName: 'grok-4-1-nightly',
    modelMode: 'MODEL_MODE_GROK_4_1_NIGHTLY',
  },
  {
    slug: 'grok-4-mini-thinking',
    label: 'Grok 4 Mini Thinking',
    modelName: 'grok-4-mini-thinking',
    modelMode: 'MODEL_MODE_GROK_4_MINI_THINKING',
  },
  { slug: 'grok-420', label: 'Grok 4.20', modelName: 'grok-420', modelMode: 'MODEL_MODE_GROK_420' },
  { slug: 'grok-43', label: 'Grok 4.3', modelName: 'grok-43', modelMode: 'MODEL_MODE_GROK43' },
];

// Old / made-up slugs kept as aliases so existing clients don't break.
const ALIASES = {
  'grok-3': 'grok',
  'grok-3-5': 'grok',
  'grok-2': 'grok',
  'grok-4': 'grok-4-1',
  'grok-4-thinking': 'grok-4-1-thinking',
  'grok-4-mini': 'grok-4-mini-thinking',
  'grok-4.1': 'grok-4-1',
  'grok-4.1-thinking': 'grok-4-1-thinking',
  'grok-4.20': 'grok-420',
  'grok-4.3': 'grok-43',
  'grok-latest': 'grok',
};

function modelInfo(id) {
  const m = String(id || '')
    .toLowerCase()
    .replace(/^grok\//, '')
    .trim();
  const slug = ALIASES[m] || m;
  return MODELS.find((x) => x.slug === slug) || MODELS[0];
}

// ── Cookie pool ─────────────────────────────────────────────────────────────
// GROK_COOKIES supports several cookies separated by "|||" (cookies contain
// commas, so "," is unsafe). GROK_COOKIE stays the single-account setting.
function loadCookies() {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const part of String(process.env.GROK_COOKIES || '').split('|||')) push(part);
  push(process.env.GROK_COOKIE);
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.grok || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
    for (const a of accounts) {
      const v = (a && a.values && a.values.GROK_COOKIE) || a.key || '';
      push(v);
    }
  } catch (_) {}
  return out;
}

const COOLDOWN_MS = Math.max(
  30_000,
  parseInt(process.env.GROK_COOLDOWN_MS || String(5 * 60_000), 10) || 300_000
);
const MAX_RETRIES = Math.max(0, parseInt(process.env.GROK_RETRIES || '1', 10) || 0);
const cooldown = new Map(); // cookie -> { until, reason }

function cookieKey(cookie) {
  return crypto.createHash('sha256').update(String(cookie)).digest('hex').slice(0, 16);
}

function markCooling(cookie, ms, reason) {
  const until = Date.now() + Math.max(1000, ms || COOLDOWN_MS);
  cooldown.set(cookieKey(cookie), { until, reason: reason || '' });
}

function coolingLeft(cookie) {
  const s = cooldown.get(cookieKey(cookie));
  return s && s.until > Date.now() ? s.until - Date.now() : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimited(status, text) {
  if (status === 429) return true;
  return /"code"\s*:\s*8\b|too many requests|rate limit/i.test(String(text || ''));
}

function isAuthFailure(status, text) {
  if (status === 401 || status === 403) return true;
  return /unauthorized|forbidden|invalid token|sso|not authenticated|sign in/i.test(String(text || ''));
}

function retryAfterMs(r) {
  const h = r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : '';
  const secs = parseInt(h || '', 10);
  if (secs > 0) return secs * 1000;
  return 0;
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

function rateLimitMessage(info, retryAfter) {
  const wait = retryAfter > 0 ? ` Retry after ~${Math.ceil(retryAfter / 1000)}s.` : '';
  return (
    `Grok 429 — rate limited / quota exhausted for ${info.label} (${info.modelMode}).` +
    ' Grok Web allows only a few messages per window on free accounts, and premium modes' +
    ' (4.1 Thinking, 4.1 Nightly, 4.20, 4.3, Heavy) need SuperGrok.' +
    ` Try model "grok" (fast), wait a bit, or add another account cookie.${wait}`
  );
}

async function callGrok(cookie, body) {
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
      'x-xai-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { r, text };
}

async function handle(opts, res) {
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

  const cookies = loadCookies();
  if (!cookies.length) {
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

  // Prefer cookies that are not cooling down; fall back to all if every one is.
  const ready = cookies.filter((c) => coolingLeft(c) === 0);
  const order = ready.length ? ready : cookies;

  let lastError = null;
  let lastRetryAfter = 0;

  try {
    for (let ci = 0; ci < order.length; ci++) {
      const cookie = order[ci];

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let result;
        try {
          result = await callGrok(cookie, body);
        } catch (e) {
          lastError = new Error(`Grok network error: ${e.message || String(e)}`);
          break; // try next cookie
        }

        const { r, text } = result;

        if (r.ok) {
          if (/just a moment|cf-browser-verification|cloudflare/i.test(text) && text.length < 5000) {
            lastError = new Error(
              'Cloudflare HTML instead of chat stream — re-capture cookies or use a non-datacenter IP'
            );
            break;
          }

          const { full } = parseStreamBody(text);
          if (!full) {
            const sample = String(text || '')
              .replace(/\s+/g, ' ')
              .slice(0, 180);
            lastError = new Error(
              'Grok empty reply' +
                (sample ? ' — upstream: ' + sample : ' — no parseable tokens; try re-capture cookie')
            );
            break;
          }

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
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created,
              model,
              choices: [
                { index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' },
              ],
            })
          );
        }

        if (isRateLimited(r.status, text)) {
          lastRetryAfter = retryAfterMs(r) || lastRetryAfter;
          markCooling(cookie, lastRetryAfter || COOLDOWN_MS, '429');
          const err = new Error(rateLimitMessage(info, lastRetryAfter));
          err.code = 429;
          err.retryAfterMs = lastRetryAfter || COOLDOWN_MS;
          err.upstream = text.slice(0, 220);
          lastError = err;
          if (attempt < MAX_RETRIES) {
            await sleep(1500 * (attempt + 1));
            continue; // retry same cookie once before rotating
          }
          break; // rotate to next cookie
        }

        if (/just a moment|cf-browser-verification|cloudflare|attention required/i.test(text)) {
          lastError = new Error(
            'Cloudflare challenge — re-capture GROK_COOKIE with extension (include cf_clearance). Render IP may be blocked.'
          );
          break;
        }

        if (isAuthFailure(r.status, text)) {
          lastError = new Error(
            `Grok auth failed (${r.status}) — re-capture the Cookie (sso + cf_clearance).`
          );
          break;
        }

        lastError = new Error(`Grok ${r.status}: ${text.slice(0, 220)}`);
        break;
      }

      // If the failure is not rate-limit/auth related, don't burn other accounts.
      if (lastError && lastError.code !== 429 && !/auth failed|Cloudflare|empty reply|network error/i.test(lastError.message)) {
        break;
      }
    }

    throw lastError || new Error('Grok request failed');
  } catch (e) {
    const msg = '\n\n[Error: ' + (e.message || String(e)) + (e.upstream ? ' — upstream: ' + e.upstream : '') + ']';
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
      const headers = { 'Content-Type': 'application/json' };
      if (e.code === 429) headers['Retry-After'] = String(Math.ceil((e.retryAfterMs || COOLDOWN_MS) / 1000));
      res.writeHead(e.code === 429 ? 429 : 502, headers);
      return res.end(
        JSON.stringify({
          error: {
            message: e.message || String(e),
            type: e.code === 429 ? 'rate_limit_error' : 'upstream_error',
          },
        })
      );
    } catch (_) {}
  }
}

handle.MODELS = MODELS;
handle.isConfigured = () => loadCookies().length > 0;
module.exports = handle;
module.exports.MODELS = MODELS;
module.exports.isConfigured = handle.isConfigured;
module.exports.modelInfo = modelInfo;
