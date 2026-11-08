'use strict';
/**
 * Kiro OAuth — aligned with 9router KiroService
 * Methods: AWS Builder ID (device code), Google/GitHub social (PKCE + kiro:// callback paste), import token
 */
const crypto = require('crypto');

const REGION = 'us-east-1';
const OIDC = `https://oidc.${REGION}.amazonaws.com`;
const SOCIAL_AUTH = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';
const START_URL = 'https://view.awsapps.com/start';
const CLIENT_NAME = 'kiro-oauth-client';
const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];
const GRANT_TYPES = ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'];
const ISSUER = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6';


async function fetchProfileArn(accessToken, region = 'us-east-1') {
  if (!accessToken) return null;
  const endpoints = [
    {
      url: `https://codewhisperer.${region}.amazonaws.com`,
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
        Authorization: 'Bearer ' + accessToken,
        'x-amz-sso-bearer': accessToken,
        Accept: 'application/json',
        'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
      },
    },
    {
      url: `https://codewhisperer.${region}.amazonaws.com/ListAvailableProfiles`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + accessToken,
        'x-amz-sso-bearer': accessToken,
        Accept: 'application/json',
      },
    },
    {
      url: `https://q.${region}.amazonaws.com`,
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
        Authorization: 'Bearer ' + accessToken,
        'x-amz-sso-bearer': accessToken,
        Accept: 'application/json',
      },
    },
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify({ maxResults: 10 }),
      });
      const text = await r.text();
      if (!r.ok) continue;
      let data = {};
      try { data = JSON.parse(text); } catch { continue; }
      const profiles = Array.isArray(data.profiles) ? data.profiles : [];
      const arnOf = (p) => (p && (p.arn || p.profileArn)) || null;
      const match =
        profiles.find((p) => String(arnOf(p) || '').includes(':' + region + ':')) ||
        profiles.find((p) => arnOf(p)) ||
        profiles[0];
      const arn = arnOf(match);
      if (arn) return arn;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 9router shared defaults when ListAvailableProfiles returns empty */
const DEFAULT_PROFILE_ARNS = {
  'builder-id': 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
  social: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
  google: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
  github: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
};

function resolveDefaultProfileArn(authMethod) {
  const m = String(authMethod || 'builder-id').toLowerCase();
  return DEFAULT_PROFILE_ARNS[m] || DEFAULT_PROFILE_ARNS['builder-id'];
}

/** In-memory OAuth sessions (device + social PKCE) */
const sessions = new Map();

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function registerClient() {
  const r = await fetch(`${OIDC}/client/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: CLIENT_NAME,
      clientType: 'public',
      scopes: SCOPES,
      grantTypes: GRANT_TYPES,
      issuerUrl: ISSUER,
    }),
  });
  if (!r.ok) throw new Error('Kiro client register failed: ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  return { clientId: data.clientId, clientSecret: data.clientSecret };
}

async function startDevice(authMethod = 'builder-id') {
  const { clientId, clientSecret } = await registerClient();
  const startUrl = authMethod === 'idc' ? START_URL : START_URL;
  const r = await fetch(`${OIDC}/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!r.ok) throw new Error('Kiro device auth failed: ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  const sid = crypto.randomBytes(12).toString('hex');
  sessions.set(sid, {
    type: 'device',
    clientId,
    clientSecret,
    deviceCode: data.deviceCode,
    created: Date.now(),
  });
  return {
    sessionId: sid,
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    verificationUriComplete: data.verificationUriComplete,
    expiresIn: data.expiresIn,
    interval: data.interval || 5,
  };
}

async function pollDevice(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.type !== 'device') throw new Error('Invalid or expired device session');
  const r = await fetch(`${OIDC}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      deviceCode: s.deviceCode,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    return {
      pending: data.error === 'authorization_pending' || data.error === 'slow_down',
      error: data.error || 'token_error',
      errorDescription: data.error_description,
    };
  }
  sessions.delete(sessionId);
  const profileArn = await fetchProfileArn(data.accessToken);
  return {
    pending: false,
    tokens: {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expiresIn,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      authMethod: 'builder-id',
      profileArn,
    },
  };
}

function startSocial(provider) {
  const idp = provider === 'github' ? 'Github' : 'Google';
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  const sid = crypto.randomBytes(12).toString('hex');
  sessions.set(sid, { type: 'social', verifier, state, provider: idp, created: Date.now() });
  const authUrl =
    `${SOCIAL_AUTH}/login?idp=${idp}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&state=${state}&prompt=select_account`;
  return {
    sessionId: sid,
    authUrl,
    redirectUri: REDIRECT_URI,
    hint: 'After login, browser may show an error opening kiro:// — copy the full address bar URL (kiro://…?code=…&state=…) and paste it back here.',
  };
}

async function exchangeSocial(sessionId, callbackUrl) {
  const s = sessions.get(sessionId);
  if (!s || s.type !== 'social') throw new Error('Invalid or expired social session');
  let code = '';
  let state = '';
  try {
    const u = new URL(callbackUrl.replace(/^kiro:/, 'http:'));
    code = u.searchParams.get('code') || '';
    state = u.searchParams.get('state') || '';
  } catch {
    const m = String(callbackUrl).match(/[?&]code=([^&]+)/);
    code = m ? decodeURIComponent(m[1]) : '';
    const m2 = String(callbackUrl).match(/[?&]state=([^&]+)/);
    state = m2 ? decodeURIComponent(m2[1]) : '';
  }
  if (!code) throw new Error('No code in callback URL');
  if (state && s.state && state !== s.state) throw new Error('State mismatch');

  const r = await fetch(`${SOCIAL_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: s.verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!r.ok) throw new Error('Social token exchange failed: ' + (await r.text()).slice(0, 220));
  const data = await r.json();
  sessions.delete(sessionId);
  let profileArn = data.profileArn || null;
  if (!profileArn) profileArn = await fetchProfileArn(data.accessToken);
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    profileArn,
    expiresIn: data.expiresIn || 3600,
    authMethod: s.provider === 'Github' ? 'github' : 'google',
  };
}

async function refreshSocial(refreshToken) {
  const r = await fetch(`${SOCIAL_AUTH}/refreshToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) throw new Error('Kiro refresh failed: ' + (await r.text()).slice(0, 180));
  const data = await r.json();
  return {
    accessToken: data.accessToken || data.access_token,
    refreshToken: data.refreshToken || refreshToken,
    expiresIn: data.expiresIn || 3600,
  };
}

// GC old sessions
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.created || 0) > 15 * 60 * 1000) sessions.delete(k);
  }
}, 60 * 1000).unref?.();

module.exports = {
  startDevice,
  pollDevice,
  startSocial,
  exchangeSocial,
  refreshSocial,
  fetchProfileArn,
  resolveDefaultProfileArn,
  DEFAULT_PROFILE_ARNS,
  REDIRECT_URI,
};
