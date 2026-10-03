// signer.js — pure-Node reversed signature for chat.z.ai web chat
// Source: ZtoApi PR #6 (roseforyou/ZtoApi), double-layer HMAC-SHA256, 5-min time window.
// CONFIDENCE: medium — algorithm reversed from OSS (Dec 2025). If upstream changed the
// secret or scheme, use SIGN_MODE=playwright (browser oracle) instead.

const crypto = require('crypto');

// Default root key (hex) from ZtoApi. Override with ZAI_SIGNING_SECRET (hex or utf8).
const DEFAULT_KEY_HEX = '6b65792d40404040292929282928283929292d787878782626262525252525';

function getRootKey() {
  const env = process.env.ZAI_SIGNING_SECRET;
  if (!env) return Buffer.from(DEFAULT_KEY_HEX, 'hex');
  if (/^[0-9a-fA-F]+$/.test(env) && env.length % 2 === 0) return Buffer.from(env, 'hex');
  return Buffer.from(env, 'utf8');
}

// Extract user_id from JWT payload (fields: id / user_id / uid / sub)
function userIdFromToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 'guest';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    for (const k of ['id', 'user_id', 'uid', 'sub']) {
      const v = payload[k];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
  } catch (_) {}
  return 'guest';
}

/**
 * Generate the X-Signature + fingerprint query params.
 * @param {string} token        - ZAI_TOKEN JWT (Bearer)
 * @param {string} lastUserMsg  - text content of the last user message
 * @returns { signature, params } where params is an object of URL query params
 */
function signRequest(token, lastUserMsg) {
  const timestamp = Date.now();
  const tsStr = String(timestamp);
  const requestId = crypto.randomUUID();
  const userId = userIdFromToken(token);

  // 1. Base64-encode the last user message (UTF-8)
  const bodyBase64 = Buffer.from(lastUserMsg, 'utf8').toString('base64');

  // 2. String to sign: "requestId,<id>,timestamp,<ts>,user_id,<uid>|<base64(msg)>|<ts>"
  const e = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;
  const stringToSign = `${e}|${bodyBase64}|${tsStr}`;

  // 3. 5-minute time window
  const timeWindow = String(Math.floor(timestamp / (5 * 60 * 1000)));

  // 4. Layer 1: HMAC-SHA256(rootKey, timeWindow) -> intermediate key (hex string)
  const rootKey = getRootKey();
  const intermediateKey = crypto.createHmac('sha256', rootKey)
    .update(timeWindow).digest('hex');

  // 5. Layer 2: HMAC-SHA256(intermediateKey (utf8), stringToSign) -> signature hex
  const signature = crypto.createHmac('sha256', Buffer.from(intermediateKey, 'utf8'))
    .update(stringToSign).digest('hex');

  // 6. Fingerprint query params (browser-fingerprint fields the upstream expects)
  const now = new Date(timestamp);
  const localTime = now.toISOString().replace('T', ' ').substring(0, 23) + 'Z';
  const params = {
    timestamp: tsStr,
    requestId,
    user_id: userId,
    version: '0.0.1',
    token,
    timezone: 'Asia/Shanghai',
    protocol: 'https:',
    timezone_offset: '-480',
    local_time: localTime,
    utc_time: now.toUTCString(),
    signature_timestamp: tsStr,
  };

  return { signature, params, requestId, timestamp, userId };
}

module.exports = { signRequest, userIdFromToken };
