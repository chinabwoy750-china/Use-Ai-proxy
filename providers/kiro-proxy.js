'use strict';
const { makeProxy, lastUserText, readSseOpenAI } = require('../web-kit');
const kiroOauth = require('../kiro-oauth');

const REFRESH_URL = process.env.KIRO_REFRESH_URL || 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const OIDC_TOKEN = 'https://oidc.us-east-1.amazonaws.com/token';
const BASES = (
  process.env.KIRO_BASES ||
  'https://runtime.us-east-1.kiro.dev/generateAssistantResponse'
).split(',').map((s) => s.trim()).filter(Boolean);

/** Full catalog (9router registry-aligned). Exposed as kiro/<id> and bare id where safe. */
const KIRO_MODEL_IDS = [
  'claude-opus-5.5', 'claude-opus-5.5-thinking', 'claude-opus-5.5-agentic', 'claude-opus-5.5-thinking-agentic',
  'claude-opus-5', 'claude-opus-5-thinking', 'claude-opus-5-agentic', 'claude-opus-5-thinking-agentic',
  'claude-opus-4.8', 'claude-opus-4.8-thinking', 'claude-opus-4.8-agentic', 'claude-opus-4.8-thinking-agentic',
  'claude-opus-4.7', 'claude-opus-4.7-thinking', 'claude-opus-4.7-agentic', 'claude-opus-4.7-thinking-agentic',
  'claude-opus-4.5', 'claude-opus-4.5-thinking', 'claude-opus-4.5-agentic', 'claude-opus-4.5-thinking-agentic',
  'claude-sonnet-5', 'claude-sonnet-5-thinking', 'claude-sonnet-5-agentic', 'claude-sonnet-5-thinking-agentic',
  'claude-sonnet-4.5', 'claude-sonnet-4.5-thinking', 'claude-sonnet-4.5-agentic', 'claude-sonnet-4.5-thinking-agentic',
  'claude-haiku-4.5', 'claude-haiku-4.5-thinking', 'claude-haiku-4.5-agentic', 'claude-haiku-4.5-thinking-agentic',
  'deepseek-3.2', 'qwen3-coder-next', 'glm-5', 'MiniMax-M2.5',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.6-sol-thinking', 'gpt-5.6-terra-thinking', 'gpt-5.6-luna-thinking',
  'gpt-5.6-sol-agentic', 'gpt-5.6-terra-agentic', 'gpt-5.6-luna-agentic',
  'gpt-5.6-sol-thinking-agentic', 'gpt-5.6-terra-thinking-agentic', 'gpt-5.6-luna-thinking-agentic',
];

const MODELS = [
  { slug: 'kiro' },
  ...KIRO_MODEL_IDS.map((id) => ({ slug: 'kiro/' + id })),
  ...KIRO_MODEL_IDS.map((id) => ({ slug: id })),
];

function upstreamModelId(model) {
  const m = String(model || 'kiro');
  if (m === 'kiro' || m === 'kiro-sonnet') return 'claude-sonnet-4.5';
  if (m.startsWith('kiro/')) return m.slice(5);
  return m;
}

async function refreshAccess() {
  const refresh = process.env.KIRO_REFRESH_TOKEN || '';
  if (!refresh) throw new Error('No KIRO_REFRESH_TOKEN — run OAuth again (Google / GitHub / Builder ID)');

  const clientId = process.env.KIRO_CLIENT_ID || '';
  const clientSecret = process.env.KIRO_CLIENT_SECRET || '';

  // Builder ID / IDC — must use AWS OIDC token endpoint
  if (clientId && clientSecret) {
    const r = await fetch(OIDC_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken: refresh,
        grantType: 'refresh_token',
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(
        'Kiro OIDC refresh ' + r.status + ': ' + text.slice(0, 160) +
          ' — Builder ID session expired; add account again via OAuth'
      );
    }
    const j = JSON.parse(text);
    if (j.refreshToken) process.env.KIRO_REFRESH_TOKEN = j.refreshToken;
    return j.accessToken;
  }

  // Social (Google/GitHub) or imported token (often starts with aorAAAAAG)
  const r = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(
      'Kiro social refresh ' + r.status + ': ' + text.slice(0, 160) +
        ' — token invalid/expired. Remove the account and login with Google/GitHub again.'
    );
  }
  let j = {};
  try { j = JSON.parse(text); } catch { throw new Error('Kiro refresh: bad JSON'); }
  if (j.refreshToken) process.env.KIRO_REFRESH_TOKEN = j.refreshToken;
  return j.accessToken || j.access_token || j.token;
}

const proxy = makeProxy({
  name: 'kiro',
  models: MODELS,
  getCookie: () => process.env.KIRO_ACCESS_TOKEN || process.env.KIRO_REFRESH_TOKEN || '',
  async run(ctx) {
    let access = process.env.KIRO_ACCESS_TOKEN || '';
    const refresh = process.env.KIRO_REFRESH_TOKEN || '';
    const apiKey = process.env.KIRO_API_KEY || '';

    if ((!access || process.env.KIRO_FORCE_REFRESH === '1') && refresh) {
      access = await refreshAccess();
      process.env.KIRO_ACCESS_TOKEN = access;
    }
    if (!access && !apiKey) {
      throw new Error('Kiro not configured — use OAuth on the Kiro provider page (Google / GitHub / Builder ID)');
    }

    const token = access || apiKey;
    const prompt = lastUserText(ctx.opts.messages);
    const modelId = upstreamModelId(ctx.opts.model);

    const openaiBase = process.env.KIRO_OPENAI_BASE;
    if (openaiBase) {
      const r = await fetch(openaiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: ctx.opts.messages || [{ role: 'user', content: prompt }],
          stream: true,
        }),
      });
      if (!r.ok) throw new Error('Kiro ' + r.status + ': ' + (await r.text()).slice(0, 220));
      await readSseOpenAI(r, ctx.write);
      ctx.end();
      return;
    }

    const base = BASES[0];
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        'x-amz-sso-bearer': token,
        'x-amzn-kiro-agent-mode': 'spec',
        'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
      },
      body: JSON.stringify({
        conversationState: {
          currentMessage: {
            userInputMessage: {
              content: prompt,
              modelId,
            },
          },
          chatTriggerType: 'MANUAL',
        },
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      // Access expired → try one refresh if we have refresh token
      if ((r.status === 401 || r.status === 403) && refresh) {
        const neu = await refreshAccess();
        process.env.KIRO_ACCESS_TOKEN = neu;
        throw new Error('Kiro auth expired and was refreshed — retry the request');
      }
      throw new Error('Kiro ' + r.status + ': ' + text.slice(0, 240));
    }
    let content = text;
    try {
      const j = JSON.parse(text);
      content = j.completion || j.output || j.message || JSON.stringify(j).slice(0, 500);
    } catch {}
    ctx.write(String(content));
    ctx.end();
  },
});

proxy.MODELS = MODELS;
proxy.KIRO_MODEL_IDS = KIRO_MODEL_IDS;
module.exports = proxy;
