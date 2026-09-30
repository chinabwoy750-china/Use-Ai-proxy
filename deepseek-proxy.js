'use strict';
const crypto = require('crypto');
const { solveChallengeAsync, buildPowHeader } = require('./pow-solver');

const DEEPSEEK_URL = (process.env.DEEPSEEK_URL || 'https://chat.deepseek.com').replace(/\/$/, '');
const DEEPSEEK_COOKIE = process.env.DEEPSEEK_COOKIE || '';
const DEEPSEEK_TOKEN = process.env.DEEPSEEK_TOKEN || '';

function dsHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${DEEPSEEK_TOKEN}`,
    'Cookie': DEEPSEEK_COOKIE,
    'Origin': DEEPSEEK_URL,
    'Referer': `${DEEPSEEK_URL}/`,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': '2.2.0',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': '0',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
  };
}

module.exports = async function deepseekProxy(opts, res) {
  if (!DEEPSEEK_COOKIE || !DEEPSEEK_TOKEN) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({
      error: 'Set DEEPSEEK_COOKIE and DEEPSEEK_TOKEN env vars (from logged-in chat.deepseek.com)',
    }));
    return;
  }

  const isExpert = opts.model === 'deepseek-expert' || opts.model === 'deepseek-reasoner';
  const chatId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const mkChunk = (delta, finish = null) => JSON.stringify({
    id: chatId, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: opts.model || 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  let message = '', system_prompt = '', history = [];
  if (Array.isArray(opts.messages)) {
    let lastUserIdx = -1;
    for (let i = 0; i < opts.messages.length; i++) {
      if (opts.messages[i].role === 'user') lastUserIdx = i;
    }
    for (let i = 0; i < opts.messages.length; i++) {
      const m = opts.messages[i];
      if (m.role === 'system') system_prompt = m.content || '';
      else if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content
          : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '');
        if (i === lastUserIdx) message = text;
        else history.push({ role: 'user', content: text });
      } else if (m.role === 'assistant') {
        history.push({ role: 'assistant', content: m.content || '' });
      }
    }
  } else {
    message = opts.message || '';
    system_prompt = opts.system_prompt || '';
    history = opts.history || [];
  }

  const safeWrite = (data) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(data); } catch {}
  };
  const emitDS = (delta) => safeWrite('data: ' + mkChunk(delta) + '\n\n');

  let abortCtrl = null;
  const onClose = () => { try { abortCtrl?.abort(); } catch {} };

  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    safeWrite(`data: ${mkChunk({ role: 'assistant', content: '' })}\n\n`);

    const createRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat_session/create`, {
      method: 'POST', headers: dsHeaders(), body: '{}',
    });
    if (!createRes.ok) throw new Error(`Session create failed: ${createRes.status}`);
    const createData = await createRes.json();
    const activeSessionId =
      createData?.data?.biz_data?.chat_session?.id ||
      createData?.data?.biz_data?.id ||
      createData?.data?.id || '';
    if (!activeSessionId) throw new Error('No session ID returned');

    const challengeRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat/create_pow_challenge`, {
      method: 'POST', headers: dsHeaders(),
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    });
    if (!challengeRes.ok) throw new Error(`Challenge fetch failed: ${challengeRes.status}`);
    const challengeData = await challengeRes.json();
    const challenge = challengeData?.data?.biz_data?.challenge;
    if (!challenge || !challenge.challenge) throw new Error('Invalid challenge data');

    const answer = await solveChallengeAsync(challenge);
    const powHeader = buildPowHeader(
      answer, challenge.challenge, challenge.salt, challenge.signature,
      challenge.target_path || '/api/v0/chat/completion'
    );

    let prompt = '';
    if (system_prompt) prompt += system_prompt + '\n\n';
    for (const m of history) {
      if (m.role === 'user') prompt += 'User: ' + (m.content || '') + '\n\n';
      else if (m.role === 'assistant') prompt += 'Assistant: ' + (m.content || '') + '\n\n';
    }
    prompt += message || '';

    abortCtrl = new AbortController();
    res.on?.('close', onClose);

    const chatRes = await fetch(`${DEEPSEEK_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers: { ...dsHeaders(), 'x-ds-pow-response': powHeader },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        chat_session_id: activeSessionId,
        model_type: isExpert ? 'expert' : null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: isExpert,
        search_enabled: false,
        action: null,
        preempt: false,
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text().catch(() => '');
      throw new Error(`DeepSeek chat failed (${chatRes.status}): ${errText.slice(0, 200)}`);
    }

    const ctype = (chatRes.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      const errText = await chatRes.text().catch(() => '');
      throw new Error(errText.slice(0, 300) || 'non-streaming response');
    }

    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let dsEvent = '';
    let streamDone = false;
    let inThinking = isExpert;

    while (!streamDone) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
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
        if (!trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6).trim();
        const evtType = dsEvent;
        dsEvent = '';
        if (evtType === 'close') {
          safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
          safeWrite('data: [DONE]\n\n');
          streamDone = true;
          break;
        }
        if (evtType === 'ready' || evtType === 'update_session' || evtType === 'title') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.o === 'BATCH' && Array.isArray(evt.v) &&
              evt.v.some(item => item.p === 'quasi_status' && item.v === 'FINISHED')) {
            safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
            safeWrite('data: [DONE]\n\n');
            streamDone = true;
            break;
          }
          if (evt.v && evt.v.response && evt.v.response.fragments) {
            for (const frag of evt.v.response.fragments) {
              if (frag.type === 'RESPONSE' && frag.content) {
                inThinking = false;
                emitDS({ content: frag.content });
              } else if (frag.type === 'THINK' && frag.content) {
                inThinking = true;
                emitDS({ reasoning_content: frag.content });
              }
            }
          }
          if (evt.o === 'APPEND' && Array.isArray(evt.v)) {
            for (const item of evt.v) {
              if (item.type === 'RESPONSE' && item.content) {
                inThinking = false;
                emitDS({ content: item.content });
              }
            }
          }
          if (inThinking) {
            if (evt.p && String(evt.p).includes('/content') && typeof evt.v === 'string')
              emitDS({ reasoning_content: evt.v });
            else if (typeof evt.v === 'string' && !evt.p && !evt.o)
              emitDS({ reasoning_content: evt.v });
            continue;
          }
          if (evt.o === 'APPEND' && typeof evt.v === 'string') emitDS({ content: evt.v });
          else if (evt.p && String(evt.p).includes('/content') && typeof evt.v === 'string')
            emitDS({ content: evt.v });
          else if (typeof evt.v === 'string' && !evt.p && !evt.o) emitDS({ content: evt.v });
        } catch {}
      }
    }
    res.removeListener?.('close', onClose);
    if (!res.writableEnded) {
      safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
      safeWrite('data: [DONE]\n\n');
      try { res.end(); } catch {}
    }
  } catch (err) {
    res.removeListener?.('close', onClose);
    if (res.destroyed || res.writableEnded) return;
    const msg = err && err.message ? err.message : String(err);
    safeWrite(`data: ${mkChunk({ content: '\n\n[Error: ' + msg + ']' })}\n\n`);
    safeWrite(`data: ${mkChunk({}, 'stop')}\n\n`);
    safeWrite('data: [DONE]\n\n');
    try { res.end(); } catch {}
  }
};

module.exports.MODELS = [
  { slug: 'deepseek-chat', label: 'DeepSeek Chat' },
  { slug: 'deepseek-expert', label: 'DeepSeek Expert' },
  { slug: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];
