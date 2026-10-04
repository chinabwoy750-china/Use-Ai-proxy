'use strict';

const crypto = require('crypto');
const { solveChallengeAsync, buildPowHeader } = require('./pow-solver');

// secrets.js is expected to export:
//   DEEPSEEK_URL   e.g. 'https://chat.deepseek.com'
//   DEEPSEEK_COOKIE
//   DEEPSEEK_TOKEN
let DEEPSEEK_URL = process.env.DEEPSEEK_URL || 'https://chat.deepseek.com';
try {
  const secrets = require('./secrets');
  if (secrets.DEEPSEEK_URL) DEEPSEEK_URL = secrets.DEEPSEEK_URL;
  if (secrets.DEEPSEEK_TOKEN && !process.env.DEEPSEEK_TOKEN) process.env.DEEPSEEK_TOKEN = secrets.DEEPSEEK_TOKEN;
  if (secrets.DEEPSEEK_COOKIE && !process.env.DEEPSEEK_COOKIE) process.env.DEEPSEEK_COOKIE = secrets.DEEPSEEK_COOKIE;
} catch (_) {}

/**
 * Account pool. Separators:
 *   DEEPSEEK_TOKEN  — single token OR comma-separated tokens
 *   DEEPSEEK_COOKIE — single cookie OR use ||| between accounts (cookies contain commas)
 *   Or DEEPSEEK_ACCOUNTS="token1|cookie1\ntoken2|cookie2"
 */
function loadAccounts() {
  const accounts = [];
  const rawAccounts = process.env.DEEPSEEK_ACCOUNTS || '';
  if (rawAccounts.trim()) {
    for (const line of rawAccounts.split(/[\n;]+/)) {
      const s = line.trim();
      if (!s) continue;
      const pipe = s.indexOf('|');
      if (pipe === -1) accounts.push({ token: s, cookie: '' });
      else accounts.push({ token: s.slice(0, pipe).trim(), cookie: s.slice(pipe + 1).trim() });
    }
  }
  const tokens = (process.env.DEEPSEEK_TOKEN || '').split(',').map((x) => x.trim()).filter(Boolean);
  const cookies = (process.env.DEEPSEEK_COOKIE || '').split('|||').map((x) => x.trim());
  if (!accounts.length && tokens.length) {
    for (let i = 0; i < tokens.length; i++) {
      accounts.push({ token: tokens[i], cookie: cookies[i] || cookies[0] || '' });
    }
  }
  return accounts;
}

let ACCOUNTS = loadAccounts();
let accountIndex = 0;
let activeSessionId = null;

function currentAccount() {
  if (!ACCOUNTS.length) return { token: '', cookie: '' };
  return ACCOUNTS[accountIndex % ACCOUNTS.length];
}

function rotateAccount(reason) {
  if (ACCOUNTS.length < 2) return false;
  accountIndex = (accountIndex + 1) % ACCOUNTS.length;
  activeSessionId = null;
  console.log('[deepseek] rotate account ->', accountIndex, reason || '');
  return true;
}

function DS_HEADERS() {
  const acc = currentAccount();
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${acc.token}`,
    'Cookie': acc.cookie,
    'Origin': DEEPSEEK_URL,
    'Referer': `${DEEPSEEK_URL}/`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': '2.2.0',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': '3600',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
  };
}

function jsonErr(res, status, msg) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ error: msg }));
}

function extractMessages(opts) {
  let message = '';
  let session_id = opts.session_id || '';
  let system_prompt = '';
  let history = [];

  if (Array.isArray(opts.messages)) {
    const msgs = opts.messages;
    let lastUserIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') lastUserIdx = i;
    }
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'system') {
        system_prompt = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
            : '');
      } else if (m.role === 'user') {
        const text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
            : '');
        if (i >= lastUserIdx) message = text;
        else history.push({ role: 'user', content: text });
      } else if (m.role === 'assistant') {
        history.push({ role: 'assistant', content: m.content || '' });
      } else if (m.role === 'tool') {
        history.push({ role: 'assistant', content: `[Tool result: ${m.content}]` });
      }
    }
  } else {
    message = opts.message || '';
    system_prompt = opts.system_prompt || '';
    history = Array.isArray(opts.history) ? opts.history : [];
  }
  return { message, session_id, system_prompt, history };
}

function buildPrompt(system_prompt, history, message) {
  let prompt = '';
  if (system_prompt) prompt += system_prompt + '\n\n';
  if (Array.isArray(history)) {
    for (const m of history) {
      if (m.role === 'user') prompt += 'User: ' + (m.displayText || m.content || '') + '\n\n';
      else if (m.role === 'assistant') prompt += 'Assistant: ' + (m.content || '') + '\n\n';
    }
  }
  prompt += message || '';
  return prompt;
}

async function deepseekProxy(opts, res) {
  const isExpert = opts.model === 'deepseek-expert'
    || opts.model === 'deepseek-reasoner'
    || opts.model === 'deepseek-r1'
    || opts.model === 'deepseek'
    || opts.thinking === true
    || (opts.thinking && opts.thinking.type === 'enabled');

  const chatId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mkChunk = (delta, finish = null) => JSON.stringify({
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: opts.model || 'deepseek',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const { message, session_id, system_prompt, history } = extractMessages(opts);
  let activeSessionId = session_id || '';
  let abortCtrl = null;

  const onClientClose = () => {
    try { abortCtrl?.abort(); } catch {}
  };
  const safeWrite = (data) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(data); } catch {}
  };
  function emitOpenAI(delta, finish = null) {
    safeWrite(`data: ${mkChunk(delta, finish)}\n\n`);
  }

  try {
    // Commit SSE immediately so TTFB timers never abort us during PoW/session setup.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(`data: ${mkChunk({ role: 'assistant', content: '' })}\n\n`);

    if (!ACCOUNTS.length || (!currentAccount().token && !currentAccount().cookie)) {
      throw new Error('Missing DEEPSEEK_TOKEN / DEEPSEEK_COOKIE — set env (multi: DEEPSEEK_ACCOUNTS or TOKEN,TOKEN with COOKIE|||COOKIE)');
    }

    // 1. Session
    if (!activeSessionId) {
      const createRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat_session/create`, {
        method: 'POST',
        headers: DS_HEADERS(),
        body: '{}',
      });
      if (!createRes.ok) {
        const t = await createRes.text().catch(() => '');
        throw new Error(`Session create failed: ${createRes.status} ${t.slice(0, 120)}`);
      }
      const createData = await createRes.json();
      activeSessionId =
        createData?.data?.biz_data?.chat_session?.id
        || createData?.data?.biz_data?.id
        || createData?.data?.id
        || createData?.biz_data?.id
        || '';
      if (!activeSessionId) throw new Error('No session ID returned from create');
    }

    // 2. PoW challenge
    const challengeRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: DS_HEADERS(),
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    });
    if (!challengeRes.ok) {
      const t = await challengeRes.text().catch(() => '');
      throw new Error(`Challenge fetch failed: ${challengeRes.status} ${t.slice(0, 120)}`);
    }
    const challengeData = await challengeRes.json();
    const challenge =
      challengeData?.data?.biz_data?.challenge
      || challengeData?.biz_data?.challenge
      || challengeData?.data?.challenge;
    if (!challenge || !challenge.challenge) {
      throw new Error('Invalid challenge data: ' + JSON.stringify(challengeData).slice(0, 200));
    }

    // 3. Solve PoW (worker thread, 45s budget)
    const answer = await solveChallengeAsync(challenge);
    const powHeader = buildPowHeader(
      answer,
      challenge.challenge,
      challenge.salt,
      challenge.signature,
      challenge.target_path || '/api/v0/chat/completion'
    );

    const prompt = buildPrompt(system_prompt, history, message);

    abortCtrl = new AbortController();
    res.on?.('close', onClientClose);

    // 4. Completion stream
    const chatRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers: { ...DS_HEADERS(), 'x-ds-pow-response': powHeader },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        chat_session_id: activeSessionId,
        parent_message_id: opts.parent_message_id || null,
        model_type: isExpert ? 'expert' : null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: !!isExpert,
        search_enabled: opts.search_enabled !== false,
        action: null,
        preempt: false,
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text().catch(() => '');
      const msg = `DeepSeek chat failed (${chatRes.status}): ${errText.slice(0, 200)}`;
      if (/401|403|40003|invalid token|expired|muted/i.test(msg) && rotateAccount(msg)) {
        throw new Error(msg + ' (rotated account — retry request)');
      }
      // reset session on transient failures
      if (/401|403|429|502|503/i.test(String(chatRes.status))) activeSessionId = null;
      throw new Error(msg);
    }

    const ctype = (chatRes.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      const errText = await chatRes.text().catch(() => '');
      let msg = 'non-streaming response';
      try {
        const j = JSON.parse(errText);
        const bd = j?.data;
        if (j.code !== undefined && j.code !== 0) msg = `${j.msg || 'code ' + j.code}`;
        else if (bd && (bd.biz_code || bd.biz_msg)) {
          msg = bd.biz_msg || String(bd.biz_code);
          if (bd.is_muted && bd.mute_until) {
            msg += ` (muted until ${new Date(bd.mute_until * 1000).toUTCString()})`;
          }
        }
      } catch {}
      throw new Error(msg);
    }

    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let dsEvent = '';
    let streamDone = false;
    let inThinking = !!isExpert;

    let idleTimer = null;
    let timedOut = false;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        streamDone = true;
        try { reader.cancel(); } catch {}
      }, 45000);
    };

    while (!streamDone) {
      resetIdleTimer();
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      clearTimeout(idleTimer);
      const { done, value } = chunk;
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('event: ')) {
          dsEvent = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const raw = trimmed.slice(6).trim();
          const evtType = dsEvent;
          dsEvent = '';

          if (evtType === 'close') {
            emitOpenAI({}, 'stop');
            safeWrite('data: [DONE]\n\n');
            streamDone = true;
            break;
          }
          if (evtType === 'ready' || evtType === 'update_session' || evtType === 'title') continue;

          try {
            const evt = JSON.parse(raw);

            // Terminal BATCH with FINISHED
            if (
              (evt.o === 'BATCH' || (Array.isArray(evt.v) && evt.p === 'response'))
              && Array.isArray(evt.v)
              && evt.v.some((item) =>
                (item.p === 'quasi_status' || item.p === 'status')
                && (item.v === 'FINISHED' || item.v === 'CONTENT_FILTER')
              )
            ) {
              emitOpenAI({}, 'stop');
              safeWrite('data: [DONE]\n\n');
              streamDone = true;
              break;
            }

            // Initial envelope with fragments
            if (evt.v && evt.v.response && Array.isArray(evt.v.response.fragments)) {
              for (const frag of evt.v.response.fragments) {
                if (frag.type === 'RESPONSE') {
                  inThinking = false;
                  if (frag.content) emitOpenAI({ content: frag.content });
                } else if (frag.type === 'THINK') {
                  inThinking = true;
                  if (frag.content) emitOpenAI({ reasoning_content: frag.content });
                }
              }
            }

            // APPEND array of fragment-like items
            if (evt.o === 'APPEND' && Array.isArray(evt.v)) {
              for (const item of evt.v) {
                if (item.type === 'RESPONSE') {
                  inThinking = false;
                  if (item.content) emitOpenAI({ content: item.content });
                } else if (item.type === 'THINK') {
                  inThinking = true;
                  if (item.content) emitOpenAI({ reasoning_content: item.content });
                } else if (typeof item === 'string') {
                  if (inThinking) emitOpenAI({ reasoning_content: item });
                  else emitOpenAI({ content: item });
                }
              }
              continue;
            }

            // Path-based APPEND / SET on content
            if (evt.p && typeof evt.v === 'string') {
              const isThinkPath = /think|reasoning/i.test(evt.p) || inThinking;
              const isContentPath = /\/content|fragments/i.test(evt.p) || !evt.p;
              if (isThinkPath && !/RESPONSE/i.test(evt.p)) {
                emitOpenAI({ reasoning_content: evt.v });
              } else if (isContentPath) {
                inThinking = false;
                emitOpenAI({ content: evt.v });
              }
              continue;
            }

            // Bare string token
            if (typeof evt.v === 'string' && !evt.p && !evt.o) {
              if (inThinking) emitOpenAI({ reasoning_content: evt.v });
              else emitOpenAI({ content: evt.v });
              continue;
            }

            // status SET FINISHED
            if (evt.p && /status$/i.test(evt.p) && (evt.v === 'FINISHED' || evt.v === 'CONTENT_FILTER')) {
              emitOpenAI({}, 'stop');
              safeWrite('data: [DONE]\n\n');
              streamDone = true;
              break;
            }
          } catch {
            // ignore malformed SSE frames
          }
        }
      }
    }
    clearTimeout(idleTimer);
    res.removeListener?.('close', onClientClose);
    if (timedOut && !res.writableEnded) {
      emitOpenAI({}, 'stop');
      safeWrite('data: [DONE]\n\n');
    }
    if (!res.writableEnded) {
      try { res.end(); } catch {}
    }
  } catch (err) {
    res.removeListener?.('close', onClientClose);
    if (res.destroyed || res.writableEnded) return;
    const hint = err.name === 'AbortError'
      ? 'DeepSeek timed out — try again'
      : `DeepSeek unavailable (${err.message})`;
    safeWrite(`data: ${mkChunk({ content: `\n\n[Error: ${hint}]` })}\n\n`);
    safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
}

async function deepseekDelete({ session_id }, res) {
  if (!session_id) {
    jsonErr(res, 400, 'Missing session_id');
    return;
  }
  try {
    const r = await fetch(`${DEEPSEEK_URL}/api/v0/chat_session/${session_id}`, {
      method: 'DELETE',
      headers: {
        'Cookie': currentAccount().cookie,
        'Origin': DEEPSEEK_URL,
        'Referer': `${DEEPSEEK_URL}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'x-client-bundle-id': 'com.deepseek.chat',
        'Authorization': `Bearer ${currentAccount().token}`,
      },
    });
    res.statusCode = r.ok ? 200 : r.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ ok: r.ok }));
  } catch {
    jsonErr(res, 502, 'DeepSeek delete failed');
  }
}

deepseekProxy.MODELS = [
  { slug: 'deepseek-chat', label: 'DeepSeek Chat' },
  { slug: 'deepseek-expert', label: 'DeepSeek Expert / R1' },
  { slug: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  { slug: 'deepseek-r1', label: 'DeepSeek R1 alias' },
  { slug: 'deepseek', label: 'DeepSeek default' },
];
deepseekProxy.accountCount = () => ACCOUNTS.length;

deepseekProxy.deepseekDelete = deepseekDelete;
module.exports = deepseekProxy;
module.exports.deepseekProxy = deepseekProxy;
module.exports.deepseekDelete = deepseekDelete;

