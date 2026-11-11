'use strict';
const { makeProxy, lastUserText, readSseOpenAI } = require('../web-kit');
const connections = require('../connection-store');
const kiroOauth = require('../kiro-oauth');

const REFRESH_URL = process.env.KIRO_REFRESH_URL || 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const OIDC_TOKEN = 'https://oidc.us-east-1.amazonaws.com/token';
const BASES = (
  process.env.KIRO_BASES ||
  'https://q.us-east-1.amazonaws.com/generateAssistantResponse,https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse,https://runtime.us-east-1.kiro.dev/generateAssistantResponse'
).split(',').map((s) => s.trim()).filter(Boolean);

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

/** Prefer connection-store account values (multi-account), fall back to env */
function loadCreds() {
  let accounts = [];
  try {
    const all = connections.getAll ? connections.getAll() : JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.kiro || all.Kiro || {};
    accounts = Array.isArray(entry.accounts) ? entry.accounts : [];
  } catch {}
  const v = (accounts[0] && accounts[0].values) || {};
  return {
    access: v.KIRO_ACCESS_TOKEN || process.env.KIRO_ACCESS_TOKEN || '',
    refresh: v.KIRO_REFRESH_TOKEN || process.env.KIRO_REFRESH_TOKEN || '',
    apiKey: v.KIRO_API_KEY || process.env.KIRO_API_KEY || '',
    clientId: v.KIRO_CLIENT_ID || process.env.KIRO_CLIENT_ID || '',
    clientSecret: v.KIRO_CLIENT_SECRET || process.env.KIRO_CLIENT_SECRET || '',
    authMethod: v.KIRO_AUTH_METHOD || process.env.KIRO_AUTH_METHOD || '',
    profileArn: v.KIRO_PROFILE_ARN || process.env.KIRO_PROFILE_ARN || '',
    accounts,
  };
}

function persistCredsPatch(patch) {
  try {
    const all = connections.getAll ? connections.getAll() : JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    const entry = all.kiro || { accounts: [] };
    const accounts = Array.isArray(entry.accounts) ? entry.accounts.slice() : [];
    if (!accounts.length) accounts.push({ name: 'Kiro', values: {} });
    accounts[0].values = Object.assign({}, accounts[0].values || {}, patch);
    entry.accounts = accounts;
    all.kiro = entry;
    if (connections.setAll) connections.setAll(all);
    else process.env.PROVIDER_CONNECTIONS = JSON.stringify(all);
  } catch {}
  for (const [k, val] of Object.entries(patch)) {
    if (val) process.env[k] = val;
  }
}

async function refreshAccess(creds) {
  const refresh = creds.refresh;
  if (!refresh) throw new Error('No KIRO_REFRESH_TOKEN — run OAuth again (Google / GitHub / Builder ID)');

  const clientId = creds.clientId;
  const clientSecret = creds.clientSecret;
  const isBuilder = !!(clientId && clientSecret) || creds.authMethod === 'builder-id';

  if (isBuilder && clientId && clientSecret) {
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
        'Kiro OIDC (Builder ID) refresh ' + r.status + ': ' + text.slice(0, 180) +
          ' — remove account and login with AWS Builder ID again'
      );
    }
    const j = JSON.parse(text);
    const access = j.accessToken;
    const patch = { KIRO_ACCESS_TOKEN: access };
    if (j.refreshToken) patch.KIRO_REFRESH_TOKEN = j.refreshToken;
    persistCredsPatch(patch);
    return access;
  }

  if (isBuilder && (!clientId || !clientSecret)) {
    throw new Error(
      'Builder ID account is missing clientId/clientSecret. Delete the Kiro account and add it again with AWS Builder ID OAuth so those are saved.'
    );
  }

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
  const access = j.accessToken || j.access_token || j.token;
  const patch = { KIRO_ACCESS_TOKEN: access };
  if (j.refreshToken) patch.KIRO_REFRESH_TOKEN = j.refreshToken;
  persistCredsPatch(patch);
  return access;
}


/** Parse AWS event-stream / hybrid body used by Kiro & CodeWhisperer */
function parseKiroEventStream(raw) {
  const text = String(raw || '');
  const parts = [];
  // JSON payloads embedded in the binary/event stream
  const re = /\{\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"modelId"\s*:\s*"[^"]*"\s*\}/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      // JSON-decode the content string escapes
      const content = JSON.parse('"' + m[1].replace(/"/g, '\\"') + '"');
      // simpler: reconstruct object
    } catch (_) {}
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj.content === 'string') parts.push(obj.content);
    } catch (_) {
      // fallback unescape
      try {
        parts.push(JSON.parse('"' + m[1] + '"'));
      } catch {
        parts.push(m[1]);
      }
    }
  }
  // Alternate shape: "content":"..." without modelId on same object
  if (!parts.length) {
    const re2 = /"content"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    while ((m = re2.exec(text))) {
      // only take chunks near assistantResponseEvent
      const idx = m.index;
      const window = text.slice(Math.max(0, idx - 120), idx);
      if (!/assistantResponseEvent/i.test(window) && parts.length === 0) {
        // still allow if stream is pure json fragments
      }
      try {
        parts.push(JSON.parse('"' + m[1] + '"'));
      } catch {
        parts.push(m[1]);
      }
    }
  }
  return parts.join('');
}

function isKiroEventStream(raw) {
  const s = String(raw || '');
  return /assistantResponseEvent|metadataEvent|:event-type/.test(s);
}


const proxy = makeProxy({
  name: 'kiro',
  models: MODELS,
  getCookie: () => {
    const c = loadCreds();
    return c.access || c.refresh || c.apiKey || '';
  },
  async run(ctx) {
    let creds = loadCreds();
    let access = creds.access;
    const apiKey = creds.apiKey;

    if ((!access || process.env.KIRO_FORCE_REFRESH === '1') && creds.refresh) {
      access = await refreshAccess(creds);
      creds = loadCreds();
      access = access || creds.access;
    }
    if (!access && !apiKey) {
      throw new Error('Kiro not configured — use OAuth on the Kiro provider page (Google / GitHub / Builder ID)');
    }

    const token = access || apiKey;
    let profileArn = creds.profileArn || '';
    if (!profileArn && access && !apiKey) {
      try {
        profileArn = (await kiroOauth.fetchProfileArn(access)) || '';
        if (profileArn) persistCredsPatch({ KIRO_PROFILE_ARN: profileArn });
      } catch (e) {
        console.error('[kiro] profileArn fetch failed', e.message || e);
      }
    }
    if (!profileArn && !apiKey) {
      // 9router fallback shared defaults
      profileArn = kiroOauth.resolveDefaultProfileArn(creds.authMethod || 'builder-id');
      if (profileArn) persistCredsPatch({ KIRO_PROFILE_ARN: profileArn });
    }
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

    let lastErr = '';
    let content = '';
    let ok = false;
    for (const base of BASES) {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, application/vnd.amazon.eventstream, */*',
        Authorization: 'Bearer ' + token,
        'x-amz-sso-bearer': token,
        'x-amzn-kiro-agent-mode': 'spec',
        'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
        'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
        ...(profileArn ? { 'x-amzn-codewhisperer-profile-arn': profileArn } : {}),
      };
      // CodeWhisperer streaming target when hitting amazonaws hosts
      if (/amazonaws\.com/.test(base) && !/generateAssistantResponse/i.test(base)) {
        headers['x-amz-target'] = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
        headers['Content-Type'] = 'application/x-amz-json-1.0';
      }

      const r = await fetch(base, {
        method: 'POST',
        headers,
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
          profileArn: profileArn || undefined,
        }),
      });
      const text = await r.text();
      if (!r.ok) {
        lastErr = 'Kiro ' + r.status + ' @ ' + base + ': ' + text.slice(0, 200);
        if ((r.status === 401 || r.status === 403) && creds.refresh) {
          try {
            await refreshAccess(loadCreds());
          } catch {}
        }
        continue;
      }

      if (isKiroEventStream(text)) {
        content = parseKiroEventStream(text);
      } else {
        try {
          const j = JSON.parse(text);
          content =
            j.completion ||
            j.output ||
            j.message ||
            (j.result && (j.result.completion || j.result.message)) ||
            '';
          if (!content && typeof j === 'object') content = parseKiroEventStream(text);
        } catch {
          content = parseKiroEventStream(text) || text;
        }
      }

      if (content && String(content).trim()) {
        ok = true;
        break;
      }
      // 200 but empty parse — keep trying next base
      lastErr = 'Kiro empty parse @ ' + base + ' (len=' + text.length + ')';
    }
    if (!ok) throw new Error(lastErr || 'Kiro all endpoints failed');
    ctx.write(String(content));
    ctx.end();
  },
});

proxy.MODELS = MODELS;
proxy.KIRO_MODEL_IDS = KIRO_MODEL_IDS;
proxy.loadCreds = loadCreds;
module.exports = proxy;
