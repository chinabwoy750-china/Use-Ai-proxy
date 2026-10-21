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


const EMPTY_RETRY_SUFFIX =
  'Previous reply had no visible output. Please regenerate the visible final answer or tool call now.';
const EMPTY_RETRY_MAX = Math.max(0, parseInt(process.env.DEEPSEEK_EMPTY_RETRY || '1', 10) || 1);

async function createPowHeader() {
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
    challengeData?.data?.biz_data
    || challengeData?.data
    || challengeData?.biz_data
    || challengeData;
  if (!challenge || !challenge.challenge) {
    throw new Error('Invalid challenge data: ' + JSON.stringify(challengeData).slice(0, 200));
  }
  const answer = await solveChallengeAsync(challenge);
  return buildPowHeader(
    answer,
    challenge.challenge,
    challenge.salt,
    challenge.signature,
    challenge.target_path || '/api/v0/chat/completion'
  );
}

function observeMessageId(evt, cur) {
  try {
    if (typeof evt.response_message_id === 'number' && evt.response_message_id > 0) {
      return evt.response_message_id;
    }
    const candidates = [
      evt?.v?.response?.message_id,
      evt?.message?.response?.message_id,
      evt?.v?.message_id,
      evt?.message_id,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  return cur;
}

/**
 * Consume one upstream DeepSeek SSE body. Emits OpenAI chunks via emitOpenAI.
 * Does NOT write [DONE] / stop — caller owns finalization after optional retries.
 */
async function consumeDeepSeekSSE(chatRes, {
  emitOpenAI,
  isExpert,
  searchEnabled,
  wantSearch,
  idleMs,
  signal,
}) {
  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let dsEvent = '';
  let streamDone = false;
  let inThinking = !!isExpert;
  let sawResponseFragment = false;
  let sawResponseContent = false;
  let sawSearchPhase = false;
  let responseChars = 0;
  let thinkingChars = 0;
  let responseMessageId = 0;
  const fragTypeByIndex = Object.create(null);
  const SEARCH_ANN =
    /I('ll| will) use the search tool|searching the web|web search tool|^SEARCH\b|^WEB_SEARCH\b|^SEARCHING\b/i;

  function emitToken(text, forceChannel) {
    if (!text) return;
    const channel = forceChannel || (sawResponseFragment || !inThinking ? 'content' : 'think');
    if (channel === 'think') {
      thinkingChars += text.length;
      emitOpenAI({ reasoning_content: text });
    } else {
      if (SEARCH_ANN.test(text) && text.length < 120) {
        sawSearchPhase = true;
        emitOpenAI({ content: text });
      } else {
        sawResponseContent = true;
        responseChars += text.length;
        emitOpenAI({ content: text });
      }
    }
  }

  function noteFragType(idx, type) {
    const t = String(type || '').toUpperCase();
    if (!t) return;
    fragTypeByIndex[idx] = t;
    if (t === 'THINK' || t === 'REASONING') inThinking = true;
    if (t === 'RESPONSE' || t === 'TEMPLATE_RESPONSE') {
      inThinking = false;
      sawResponseFragment = true;
    }
    if (t === 'SEARCH' || t === 'SEARCH_RESULT' || t === 'WEB_SEARCH' || t === 'TOOL_SEARCH') {
      sawSearchPhase = true;
    }
  }

  let idleTimer = null;
  let timedOut = false;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      streamDone = true;
      try { reader.cancel(); } catch {}
    }, idleMs);
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
    if (signal?.aborted) break;
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
          streamDone = true;
          break;
        }
        if (evtType === 'ready' || evtType === 'update_session' || evtType === 'title') continue;

        try {
          const evt = JSON.parse(raw);
          responseMessageId = observeMessageId(evt, responseMessageId);

          // Terminal BATCH with FINISHED
          if (
            (evt.o === 'BATCH' || (Array.isArray(evt.v) && evt.p === 'response'))
            && Array.isArray(evt.v)
            && evt.v.some(
              (item) =>
                (item.p === 'quasi_status' || item.p === 'status')
                && (item.v === 'FINISHED' || item.v === 'CONTENT_FILTER')
            )
          ) {
            if (
              (searchEnabled || wantSearch || sawSearchPhase)
              && !sawResponseContent
              && responseChars < 80
            ) {
              console.log('[deepseek] ignore early BATCH FINISHED during search; keep reading');
              resetIdleTimer();
              continue;
            }
            streamDone = true;
            break;
          }

          // search_results path
          if (
            evt.p === 'response/search_results'
            || (typeof evt.p === 'string' && /search_results|\/results$/i.test(evt.p))
          ) {
            sawSearchPhase = true;
            const n = Array.isArray(evt.v) ? evt.v.length : 0;
            if (n) emitOpenAI({ content: `\n[Found ${n} web page(s)]\n` });
            continue;
          }

          // Track fragment type assignments
          if (typeof evt.p === 'string') {
            const tm = evt.p.match(/fragments\/(-?\d+)\/type$/i);
            if (tm && evt.v != null) noteFragType(tm[1], evt.v);
          }

          // fragments envelope
          if (evt.v && evt.v.response && Array.isArray(evt.v.response.fragments)) {
            evt.v.response.fragments.forEach((frag, i) => {
              if (frag && frag.type) noteFragType(String(i), frag.type);
            });
            for (const frag of evt.v.response.fragments) {
              if (!frag) continue;
              const ftype = String(frag.type || '').toUpperCase();
              if (ftype === 'THINK' || ftype === 'REASONING') {
                if (frag.content) emitToken(frag.content, 'think');
              } else if (ftype === 'RESPONSE' || ftype === 'TEMPLATE_RESPONSE') {
                if (frag.content) emitToken(frag.content, 'content');
              } else if (ftype === 'SEARCH' || ftype === 'TOOL_SEARCH') {
                sawSearchPhase = true;
              } else if (frag.content) {
                emitToken(frag.content);
              }
            }
            continue;
          }

          // APPEND array of fragment-like items
          if (evt.o === 'APPEND' && Array.isArray(evt.v)) {
            for (const item of evt.v) {
              if (item && typeof item === 'object') {
                if (item.type) noteFragType(String(item.id ?? item.index ?? ''), item.type);
                const itype = String(item.type || '').toUpperCase();
                if (itype === 'THINK' || itype === 'REASONING') {
                  if (item.content) emitToken(item.content, 'think');
                } else if (itype === 'RESPONSE' || itype === 'TEMPLATE_RESPONSE') {
                  if (item.content) emitToken(item.content, 'content');
                } else if (item.content) {
                  emitToken(item.content);
                }
              } else if (typeof item === 'string') {
                emitToken(item);
              }
            }
            continue;
          }

          // Path + value token
          if (typeof evt.v === 'string' && typeof evt.p === 'string') {
            const isSearchPath = /search/i.test(evt.p);
            const fragMatch = evt.p.match(/fragments\/(-?\d+)/i);
            const knownType = fragMatch ? fragTypeByIndex[fragMatch[1]] : null;
            const isContentPath = /fragments\/-?\d+\/content/i.test(evt.p);
            const isThinkPath =
              knownType === 'THINK'
              || knownType === 'REASONING'
              || (/think|reasoning/i.test(evt.p) && !isContentPath);
            const isResponsePath =
              knownType === 'RESPONSE'
              || knownType === 'TEMPLATE_RESPONSE'
              || (/RESPONSE/i.test(evt.p) && !/think/i.test(evt.p))
              || (
                isContentPath
                && knownType !== 'THINK'
                && knownType !== 'REASONING'
                && knownType !== 'SEARCH'
                && knownType !== 'TOOL_SEARCH'
                && knownType !== 'TOOL_OPEN'
              );

            if (isSearchPath || knownType === 'SEARCH' || knownType === 'TOOL_SEARCH') {
              sawSearchPhase = true;
              continue;
            } else if (
              isResponsePath
              || (isContentPath && (!isExpert || sawResponseFragment || !inThinking))
            ) {
              sawResponseFragment = true;
              inThinking = false;
              emitToken(evt.v, 'content');
            } else if (isThinkPath || (isExpert && inThinking && !sawResponseFragment)) {
              inThinking = true;
              emitToken(evt.v, 'think');
            } else if (/status|token|title|session|elapsed/i.test(evt.p)) {
              // metadata
            } else if (isExpert && !sawResponseFragment) {
              emitToken(evt.v, 'think');
            } else {
              emitToken(evt.v, 'content');
            }
            continue;
          }

          // Bare string token
          if (typeof evt.v === 'string' && !evt.p && !evt.o) {
            if (isExpert && !sawResponseFragment) emitToken(evt.v, 'think');
            else emitToken(evt.v);
            continue;
          }

          // status SET FINISHED
          if (
            evt.p
            && /status$/i.test(evt.p)
            && (evt.v === 'FINISHED' || evt.v === 'CONTENT_FILTER')
          ) {
            if (
              (searchEnabled || wantSearch || sawSearchPhase)
              && !sawResponseContent
              && responseChars < 80
            ) {
              console.log('[deepseek] ignore early FINISHED during search; waiting for answer');
              resetIdleTimer();
              continue;
            }
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
  try { reader.cancel(); } catch {}

  return {
    responseChars,
    thinkingChars,
    responseMessageId,
    sawResponseContent,
    sawSearchPhase,
    timedOut,
  };
}

async function deepseekProxy(opts, res) {
  // Only real reasoner IDs / explicit thinking flag — NOT plain "deepseek"/"deepseek-chat"
  const modelName = String(opts.model || 'deepseek').toLowerCase();
  const isExpert =
    modelName === 'deepseek-expert'
    || modelName === 'deepseek-reasoner'
    || modelName === 'deepseek-r1'
    || modelName.includes('reasoner')
    || modelName.includes('r1')
    || modelName.includes('expert')
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
  let activeLocalSession = session_id || activeSessionId || '';
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
    if (!activeLocalSession) {
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
      activeLocalSession =
        createData?.data?.biz_data?.chat_session?.id
        || createData?.data?.biz_data?.id
        || createData?.data?.id
        || createData?.biz_data?.id
        || '';
      if (!activeLocalSession) throw new Error('No session ID returned from create');
      activeSessionId = activeLocalSession;
    }

    const basePrompt = buildPrompt(system_prompt, history, message);
    const hasClientTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    const wantSearch =
      opts.search_enabled === true
      || /search/i.test(String(opts.model || ''))
      || /\b(web\s*search|search the web|do a (web )?search|google|look up|find online|list .{0,40} websites?)\b/i.test(
        message || ''
      );
    const searchEnabled =
      hasClientTools
        ? false
        : opts.search_enabled === false
          ? false
          : !!(wantSearch || opts.search_enabled === true);
    const idleMs = searchEnabled || wantSearch ? 240000 : 120000;

    abortCtrl = new AbortController();
    res.on?.('close', onClientClose);

    let parentMessageId = opts.parent_message_id || null;
    let totalContent = 0;
    let lastStats = { responseChars: 0, thinkingChars: 0, sawSearchPhase: false, timedOut: false };
    let attempt = 0;

    while (attempt <= EMPTY_RETRY_MAX) {
      const prompt =
        attempt === 0
          ? basePrompt
          : (basePrompt.trimEnd() + '\n\n' + EMPTY_RETRY_SUFFIX);
      // On empty retry: disable thinking so we force a visible answer (ds2api-style recovery)
      const thinkingThis = attempt === 0 ? !!isExpert : false;

      const powHeader = await createPowHeader();
      const body = {
        chat_session_id: activeLocalSession,
        parent_message_id: parentMessageId || null,
        model_type: isExpert && attempt === 0 ? 'expert' : 'default',
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingThis,
        search_enabled: attempt === 0 ? searchEnabled : false,
        action: null,
        preempt: false,
      };

      const chatRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat/completion`, {
        method: 'POST',
        headers: { ...DS_HEADERS(), 'x-ds-pow-response': powHeader },
        signal: abortCtrl.signal,
        body: JSON.stringify(body),
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text().catch(() => '');
        const msg = `DeepSeek chat failed (${chatRes.status}): ${errText.slice(0, 200)}`;
        if (/401|403|40003|invalid token|expired|muted/i.test(msg) && rotateAccount(msg)) {
          throw new Error(msg + ' (rotated account — retry request)');
        }
        if (/401|403|429|502|503/i.test(String(chatRes.status))) {
          activeSessionId = null;
          activeLocalSession = '';
        }
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

      lastStats = await consumeDeepSeekSSE(chatRes, {
        emitOpenAI,
        isExpert: thinkingThis,
        searchEnabled: body.search_enabled,
        wantSearch,
        idleMs,
        signal: abortCtrl.signal,
      });
      totalContent += lastStats.responseChars;
      if (lastStats.responseMessageId) {
        parentMessageId = lastStats.responseMessageId;
      }

      console.log(
        '[deepseek] attempt=%s model=%s contentChars=%s thinkChars=%s search=%s timedOut=%s msgId=%s',
        attempt,
        opts.model,
        lastStats.responseChars,
        lastStats.thinkingChars,
        !!(searchEnabled || lastStats.sawSearchPhase),
        lastStats.timedOut,
        lastStats.responseMessageId || 0
      );

      if (lastStats.responseChars > 0 || lastStats.timedOut || abortCtrl.signal.aborted) {
        break;
      }
      // Empty visible output → same-session retry (ds2api EmptyOutputRetry)
      attempt += 1;
      if (attempt <= EMPTY_RETRY_MAX) {
        console.log('[deepseek] empty visible output — same-session retry %s/%s', attempt, EMPTY_RETRY_MAX);
      }
    }

    if (!res.writableEnded) {
      if (totalContent < 1) {
        if (lastStats.sawSearchPhase) {
          emitOpenAI({
            content: '\n\n[Error: DeepSeek closed before final answer after search]',
          });
        } else if (lastStats.thinkingChars > 0) {
          emitOpenAI({
            content:
              '\n\n[Error: DeepSeek returned reasoning only (no visible answer). Try model deepseek-chat or disable thinking.]',
          });
        } else {
          emitOpenAI({
            content: '\n\n[Error: DeepSeek stream closed with empty reply]',
          });
        }
      }
      emitOpenAI({}, 'stop');
      safeWrite('data: [DONE]\n\n');
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
  } finally {
    res.removeListener?.('close', onClientClose);
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

