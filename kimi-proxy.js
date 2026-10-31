'use strict';
/**
 * Kimi web proxy (www.kimi.ai overseas)
 *
 * Env:
 *   KIMI_URL
 *   KIMI_TOKEN / KIMI_ACCESS_TOKEN — optional single access token
 *   KIMI_REFRESH_TOKEN — single refresh token
 *   KIMI_REFRESH_TOKENS — comma-separated refresh tokens (pool / rotation)
 */
const crypto = require('crypto');
const { buildToolInstructions, StreamToolSieve, stripInstructionLeak, LeakStripStream } = require('./tool-sieve');

const KIMI_BASE = (process.env.KIMI_URL || 'https://www.kimi.ai').replace(/\/$/, '');
const AUTH_BASE = (process.env.KIMI_AUTH_URL || 'https://auth.kimi.ai').replace(/\/$/, '');
const ENV_TOKEN = (process.env.KIMI_TOKEN || process.env.KIMI_ACCESS_TOKEN || '').replace(/^Bearer\s+/i, '');
const ENV_REFRESH = (process.env.KIMI_REFRESH_TOKEN || '').replace(/^Bearer\s+/i, '');

const MODELS = [
  { slug: 'kimi', label: 'Kimi (default)' },
  { slug: 'kimi-latest', label: 'Kimi latest' },
  { slug: 'kimi-k2', label: 'Kimi K2' },
  { slug: 'kimi-k1', label: 'Kimi K1 / thinking' },
  { slug: 'kimi-search', label: 'Kimi + web search' },
  { slug: 'kimi-research', label: 'Kimi deep research' },
  { slug: 'kimi-silent', label: 'Kimi silent search' },
  { slug: 'moonshot-v1', label: 'Moonshot alias' },
];

/** Map OpenAI model id -> upstream completion flags */
function modelOptions(modelName) {
  const m = String(modelName || 'kimi').toLowerCase();
  const o = {
    use_search: false,
    use_deep_research: false,
    use_semantic_memory: false,
    kimiplus_id: 'kimi',
    // scenario hints some clients send as model suffix
  };
  if (m.includes('search') || m.includes('web')) o.use_search = true;
  if (m.includes('research') || m.includes('explore')) o.use_deep_research = true;
  if (m.includes('silent')) { o.use_search = true; o.silent_search = true; }
  if (m.includes('k2')) o.kimiplus_id = 'kimi'; // K2 still uses kimi chat surface on web
  if (m.includes('k1') || m.includes('think') || m.includes('reason')) o.thinking = true;
  // explicit opts from client body win later
  return o;
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function classifyToken(jwt) {
  const p = decodeJwtPayload(jwt);
  if (!p) return { typ: 'unknown', expMs: 0 };
  return { typ: p.typ || 'unknown', expMs: p.exp ? p.exp * 1000 : 0, payload: p };
}

const pool = [];
let rrIdx = 0;

function addCred({ refresh = null, access = null, expMs = 0 } = {}) {
  if (!refresh && !access) return;
  pool.push({ refresh, access, expMs: expMs || 0, coolUntil: 0 });
}

(function bootstrapPool() {
  const refreshes = [];
  if (process.env.KIMI_REFRESH_TOKENS) {
    for (const s of process.env.KIMI_REFRESH_TOKENS.split(',')) {
      const x = s.trim().replace(/^Bearer\s+/i, '');
      if (x) refreshes.push(x);
    }
  }
  if (ENV_REFRESH) refreshes.unshift(ENV_REFRESH);
  const seen = new Set();
  for (const rt of refreshes) {
    if (seen.has(rt)) continue;
    seen.add(rt);
    addCred({ refresh: rt });
  }
  if (ENV_TOKEN) {
    const c = classifyToken(ENV_TOKEN);
    if (c.typ === 'refresh') {
      if (!seen.has(ENV_TOKEN)) addCred({ refresh: ENV_TOKEN });
    } else {
      addCred({ access: ENV_TOKEN, expMs: c.expMs || Date.now() + 14 * 60_000 });
    }
  }
  console.log('[kimi] credential pool size:', pool.length);
})();

function pickCred() {
  if (!pool.length) return null;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const c = pool[(rrIdx + i) % pool.length];
    if (c.coolUntil > now) continue;
    rrIdx = (rrIdx + i + 1) % pool.length;
    return c;
  }
  return pool.reduce((a, b) => (a.coolUntil < b.coolUntil ? a : b));
}

function coolCred(cred, ms = 60_000) {
  if (cred) cred.coolUntil = Date.now() + ms;
}

function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: KIMI_BASE,
    Referer: KIMI_BASE + '/',
  };
}

function apiHeaders(token) {
  return {
    ...browserHeaders(),
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'r-timezone': 'UTC',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
  };
}

async function refreshCred(cred) {
  if (!cred.refresh) throw new Error('No refresh_token on this Kimi credential');
  const url = `${AUTH_BASE}/api/account.gateway.v1.AuthService/RefreshToken`;
  const r = await fetch(url, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ refresh_token: cred.refresh }),
  });
  const t = await r.text();
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) coolCred(cred, 5 * 60_000);
    throw new Error(`Kimi refresh ${r.status}: ${t.slice(0, 250)}`);
  }
  let j;
  try { j = JSON.parse(t); } catch {
    throw new Error('Kimi refresh: non-JSON response');
  }
  const access = j.accessToken || j.access_token;
  const newRefresh = j.refreshToken || j.refresh_token;
  if (!access) throw new Error('Kimi refresh: missing accessToken');
  if (newRefresh) cred.refresh = newRefresh;
  const c = classifyToken(access);
  cred.access = access;
  cred.expMs = c.expMs || (Date.now() + 14 * 60_000);
  return access;
}

async function getCredAccess(cred) {
  const skew = 60_000;
  if (cred.access && cred.expMs > Date.now() + skew) return cred.access;
  if (cred.refresh) return refreshCred(cred);
  if (cred.access) return cred.access;
  throw new Error('Kimi credential empty');
}

function lastUser(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      let c = m.content;
      if (Array.isArray(c)) c = c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      return String(c || '');
    }
  }
  return '';
}

async function createChat(token) {
  const r = await fetch(`${KIMI_BASE}/api/chat`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({ name: 'New Chat', is_example: false }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Kimi create chat ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  const id = j.id || j.data?.id || j.chat?.id;
  if (!id) throw new Error('Kimi create chat: no id');
  return id;
}

module.exports = async function kimiProxy(opts, res) {
  const model = opts.model || 'kimi';
  const chatIdOut = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mk = (delta, finish = null) =>
    JSON.stringify({
      id: chatIdOut,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const wantStream = opts.stream !== false;
  let nsContent = '';
  let nsReasoning = '';
  let nsToolCalls = [];
  let nsFinish = 'stop';

  const safeWrite = (d) => {
    if (res.destroyed || res.writableEnded) return;
    if (!wantStream) {
      try {
        const line = String(d || '');
        for (const part of line.split('\n')) {
          const tr = part.trim();
          if (!tr.startsWith('data:')) continue;
          const raw = tr.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          const j = JSON.parse(raw);
          const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          if (delta.content) nsContent += delta.content;
          if (delta.reasoning_content) nsReasoning += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) nsToolCalls.push(...delta.tool_calls);
          if (j.choices && j.choices[0] && j.choices[0].finish_reason) {
            nsFinish = j.choices[0].finish_reason;
          }
        }
      } catch {}
      return;
    }
    try { res.write(d); } catch {}
  };

  try {
    if (!pool.length) throw new Error('Set KIMI_REFRESH_TOKEN or KIMI_REFRESH_TOKENS (comma-separated)');

    res.statusCode = 200;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      safeWrite(`data: ${mk({ role: 'assistant', content: '' })}\n\n`);
    } else {
      res.setHeader('Content-Type', 'application/json');
    }

    let prompt = lastUser(opts.messages);
    const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    // Hermes/China-GPT attach large tools[]; long injections make Kimi web return empty.
    // Inject a short hint only for small tool lists; large lists rely on plain reply + retry.
    if (hasTools && opts.tools.length <= 12) {
      prompt = buildToolInstructions(opts.tools) + prompt;
    }
    // Client-owned tools: don't force Kimi built-in search
    const streamUrlTpl = (id) => `${KIMI_BASE}/api/chat/${id}/completion/stream`;
    const mo = modelOptions(model);
    const wantThinking =
      !!mo.thinking ||
      /k1|think|reason/i.test(String(model || '')) ||
      opts.reasoning === true ||
      opts.thinking === true;
    const body = {
      messages: [{ role: 'user', content: prompt }],
      references: [],
      refs: [],
      history: [],
      kimiplus_id: mo.kimiplus_id || 'kimi',
      use_search: hasTools ? false : (opts.use_search != null ? !!opts.use_search : !!mo.use_search),
      use_deep_research: hasTools ? false : (opts.use_deep_research != null ? !!opts.use_deep_research : !!mo.use_deep_research),
      use_semantic_memory: false,
      // web surface flags (ignored if unsupported)
      ...(wantThinking ? { thinking: true, enable_thinking: true } : {}),
    };

    let lastErr = null;
    let streamRes = null;
    let token = null;
    let chatId = null;
    const tried = new Set();

    for (let attempt = 0; attempt < Math.max(pool.length, 1) + 1; attempt++) {
      const cred = pickCred();
      if (!cred || tried.has(cred)) {
        if (tried.size >= pool.length) break;
        continue;
      }
      tried.add(cred);
      try {
        token = await getCredAccess(cred);
        chatId = await createChat(token);
        streamRes = await fetch(streamUrlTpl(chatId), {
          method: 'POST',
          headers: { ...apiHeaders(token), Accept: 'text/event-stream' },
          body: JSON.stringify(body),
        });
        if (streamRes.status === 401) {
          token = await refreshCred(cred);
          streamRes = await fetch(streamUrlTpl(chatId), {
            method: 'POST',
            headers: { ...apiHeaders(token), Accept: 'text/event-stream' },
            body: JSON.stringify(body),
          });
        }
        if (streamRes.status === 429) {
          coolCred(cred, 60_000);
          lastErr = new Error('Kimi 429 rate limited');
          continue;
        }
        if (!streamRes.ok) {
          const err = await streamRes.text().catch(() => '');
          lastErr = new Error(`Kimi stream ${streamRes.status}: ${err.slice(0, 200)}`);
          if (streamRes.status === 401 || streamRes.status === 403) coolCred(cred, 5 * 60_000);
          continue;
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        coolCred(cred, 30_000);
      }
    }
    if (lastErr || !streamRes || !streamRes.ok) {
      throw lastErr || new Error('Kimi: all credentials failed');
    }

    const reader = streamRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawAssistant = false;
    const sieve = hasTools ? new StreamToolSieve(true) : null;
    const leak = new LeakStripStream();
    let emittedChars = 0;
    const emitContent = (piece) => {
      if (!piece) return;
      const cleaned = leak.push(piece);
      if (!cleaned) return;
      if (sieve) {
        const { flush } = sieve.push(cleaned);
        if (flush) {
          emittedChars += flush.length;
          safeWrite(`data: ${mk({ content: flush })}\n\n`);
        }
      } else {
        emittedChars += cleaned.length;
        safeWrite(`data: ${mk({ content: cleaned })}\n\n`);
      }
    };
    const emitReasoning = (piece) => {
      if (!piece || typeof piece !== 'string') return;
      const cleaned = stripInstructionLeak(piece);
      if (cleaned) {
        emittedChars += cleaned.length;
        safeWrite(`data: ${mk({ reasoning_content: cleaned })}\n\n`);
      }
    };
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
          const delta = evt.choices?.[0]?.delta || {};
          // Reasoning / thinking fragments (official API + web variants)
          const reason =
            delta.reasoning_content ||
            evt.reasoning_content ||
            evt.reasoning ||
            evt.thinking ||
            (evt.type === 'thinking' || evt.event === 'thinking' || evt.view === 'thinking'
              ? (evt.text || evt.content || '')
              : '') ||
            '';
          if (reason && typeof reason === 'string') {
            sawAssistant = true;
            emitReasoning(reason);
          }
          let text =
            delta.content ||
            evt.text ||
            evt.content ||
            '';
          // Some web events nest content under message
          if (!text && evt.message && typeof evt.message.content === 'string') {
            text = evt.message.content;
          }
          if (typeof text !== 'string' || !text) continue;
          // Only skip long prompt echoes (tool system blocks). Short user
          // messages like "Hi" must NOT be treated as echoes — that was
          // dropping the first token and yielding " there! I'm Kimi…".
          if (
            !sawAssistant &&
            prompt &&
            prompt.trim().length >= 80 &&
            text.trim() === prompt.trim()
          ) {
            continue;
          }
          // Skip if this chunk was already handled as reasoning-only
          if (reason && text === reason) continue;
          sawAssistant = true;
          emitContent(text);
        } catch {}
      }
    }
    // flush held leak buffer
    {
      const tail = leak.flush();
      if (tail) {
        if (sieve) {
          const { flush } = sieve.push(tail);
          if (flush) safeWrite(`data: ${mk({ content: flush })}\n\n`);
        } else {
          safeWrite(`data: ${mk({ content: tail })}\n\n`);
        }
      }
    }

    let finish = 'stop';
    if (sieve) {
      const fin = sieve.finalize();
      if (fin.tool_calls && fin.tool_calls.length) {
        const pre = stripInstructionLeak(fin.content || '');
        if (pre) {
          emittedChars += pre.length;
          safeWrite(`data: ${mk({ content: pre })}\n\n`);
        }
        for (let i = 0; i < fin.tool_calls.length; i++) {
          const tc = fin.tool_calls[i];
          safeWrite(`data: ${mk({
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
            }],
          })}\n\n`);
        }
        finish = 'tool_calls';
        emittedChars += 1;
      } else if (fin.leftover) {
        const cleaned = stripInstructionLeak(fin.leftover);
        if (cleaned) {
          emittedChars += cleaned.length;
          safeWrite(`data: ${mk({ content: cleaned })}\n\n`);
        }
      }
    }

    // China-GPT/Hermes always send tools[]. Kimi web often returns empty
    // when a tool system prompt is injected — retry once as plain chat.
    if (emittedChars === 0 && hasTools && token && wantStream) {
      console.log('[kimi] empty stream with tools — retrying plain chat');
      try {
        chatId = await createChat(token);
        const plainBody = {
          messages: [{ role: 'user', content: lastUser(opts.messages) }],
          references: [],
          refs: [],
          history: [],
          kimiplus_id: mo.kimiplus_id || 'kimi',
          use_search: false,
          use_deep_research: false,
          use_semantic_memory: false,
          ...(wantThinking ? { thinking: true, enable_thinking: true } : {}),
        };
        streamRes = await fetch(streamUrlTpl(chatId), {
          method: 'POST',
          headers: { ...apiHeaders(token), Accept: 'text/event-stream' },
          body: JSON.stringify(plainBody),
        });
        if (streamRes.ok) {
          const reader2 = streamRes.body.getReader();
          const dec2 = new TextDecoder();
          let buf2 = '';
          while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            buf2 += dec2.decode(value, { stream: true });
            const lines = buf2.split('\n');
            buf2 = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const raw = t.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              try {
                const evt = JSON.parse(raw);
                const delta = evt.choices?.[0]?.delta || {};
                const reason = delta.reasoning_content || evt.reasoning_content || evt.reasoning || evt.thinking || '';
                if (reason) {
                  emittedChars += reason.length;
                  safeWrite(`data: ${mk({ reasoning_content: reason })}\n\n`);
                }
                let text = delta.content || evt.text || evt.content || '';
                if (typeof text === 'string' && text) {
                  emittedChars += text.length;
                  safeWrite(`data: ${mk({ content: text })}\n\n`);
                }
              } catch {}
            }
          }
        }
      } catch (retryErr) {
        console.log('[kimi] plain retry failed', retryErr && retryErr.message);
      }
    }

    safeWrite(`data: ${mk({}, finish)}\n\n`);
    safeWrite('data: [DONE]\n\n');
    if (!wantStream) {
      const message = { role: 'assistant', content: nsContent || null };
      if (nsReasoning) message.reasoning_content = nsReasoning;
      if (nsToolCalls.length) {
        message.tool_calls = nsToolCalls;
        message.content = message.content || null;
      }
      const payload = {
        id: chatIdOut,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: nsFinish || finish || 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      try { res.end(JSON.stringify(payload)); } catch {}
      return;
    }
    try { res.end(); } catch {}
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    const msg = err && err.message ? err.message : String(err);
    if (!wantStream) {
      try {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error' } }));
      } catch {}
      return;
    }
    safeWrite(`data: ${mk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
    safeWrite(`data: ${mk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
};

module.exports.MODELS = MODELS;
module.exports.isConfigured = () => pool.length > 0 || !!(ENV_TOKEN || ENV_REFRESH);
