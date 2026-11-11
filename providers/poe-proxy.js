'use strict';
/**
 * Poe Web → OpenAI SSE
 *
 * Poe sits behind Cloudflare and only accepts requests from a browser session
 * that carries a matching `cf_clearance` cookie (Cloudflare binds that cookie to
 * the client IP). A datacenter host such as Render therefore cannot use it: the
 * request gets a "Just a moment..." challenge no matter which cookie you paste.
 *
 * This proxy still implements Poe's real GraphQL call so it works when run from
 * the same machine/browser that produced the cookies (local use), and returns a
 * clear, actionable error when Cloudflare blocks it.
 *
 * Env:
 *   POE_COOKIE   full cookie header (must include p-b=... and cf_clearance=...)
 *   POE_FORMKEY  poe-formkey value from https://poe.com (DevTools → Network)
 *   POE_BOT      bot handle to talk to (default: Assistant)
 */
const crypto = require('crypto');
const { lastUserText, envCookie, makeProxy } = require('../web-kit');

const GQL = 'https://www.poe.com/api/gql_POST';
const HOME = 'https://www.poe.com/';

// These are proxy slugs, not Poe bot handles — the bot is chosen by POE_BOT.
const MODELS = [{ slug: 'poe' }, { slug: 'poe-web' }];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function pb(cookie) {
  const m = String(cookie).match(/p-b=([^;]+)/);
  return m ? m[1] : '';
}

function isCloudflare(status, text) {
  return (
    status === 403 ||
    /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(String(text || ''))
  );
}

function cloudflareError() {
  const e = new Error(
    'Poe is blocked by Cloudflare (403 "Just a moment..."). Poe only accepts a browser session whose ' +
      'cf_clearance cookie matches the client IP, so it cannot work from a datacenter host like Render. ' +
      'Run this proxy locally with a cookie copied from your own browser, or use a residential proxy.'
  );
  e.code = 403;
  return e;
}

// poe-tag-id is md5(formkey + queryName + compact JSON variables) in the web app.
function tagId(formkey, queryName, variables) {
  return crypto
    .createHash('md5')
    .update(String(formkey) + String(queryName) + JSON.stringify(variables))
    .digest('hex');
}

async function fetchFormkey(cookie) {
  const fromEnv = String(process.env.POE_FORMKEY || '').trim();
  if (fromEnv) return fromEnv;
  const r = await fetch(HOME, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': UA,
      Cookie: cookie,
    },
  });
  const html = await r.text();
  if (isCloudflare(r.status, html)) throw cloudflareError();
  const m =
    html.match(/"formkey"\s*:\s*"([^"]+)"/) ||
    html.match(/name="formkey"\s+value="([^"]+)"/) ||
    html.match(/poe-formkey['"]?\s*[:=]\s*['"]([^'"]+)/);
  return m ? m[1] : '';
}

module.exports = makeProxy({
  name: 'poe',
  models: MODELS,
  getCookie: () => envCookie('POE_COOKIE', 'POE_PB'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('POE_COOKIE required (full cookie incl. p-b=... and cf_clearance=...)');
    const token = pb(ctx.cookie);
    if (!token) throw new Error('POE_COOKIE is missing p-b — copy the whole Cookie header from poe.com');

    const formkey = await fetchFormkey(ctx.cookie);
    if (!formkey) {
      throw new Error(
        'Could not read poe-formkey (Poe likely served a Cloudflare challenge). ' +
          'Copy poe-formkey from DevTools → Network → any /api/gql_POST request and set POE_FORMKEY.'
      );
    }

    const queryName = 'SendMessageMutation';
    const variables = {
      bot: String(process.env.POE_BOT || 'Assistant'),
      chatId: null,
      query: lastUserText(ctx.opts.messages),
      source: null,
    };

    const r = await fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': UA,
        Origin: 'https://www.poe.com',
        Referer: 'https://www.poe.com/',
        Cookie: ctx.cookie,
        'poe-formkey': formkey,
        'poe-tag-id': tagId(formkey, queryName, variables),
      },
      body: JSON.stringify({
        queryName,
        variables,
        query: null,
      }),
    });

    const text = await r.text();
    if (isCloudflare(r.status, text)) throw cloudflareError();
    if (!r.ok) throw new Error(`Poe ${r.status}: ${text.slice(0, 220)}`);

    let j = null;
    try {
      j = JSON.parse(text);
    } catch (_) {}
    if (j && Array.isArray(j.errors) && j.errors.length) {
      throw new Error(`Poe GraphQL: ${String(j.errors[0]?.message || '').slice(0, 220)}`);
    }

    const content =
      j?.data?.sendMessage?.text ||
      j?.data?.messageAdded?.text ||
      j?.data?.message?.text ||
      '';
    if (!content) {
      throw new Error(
        'Poe accepted the request but returned no text (streaming response). ' +
          'Poe requires a WebSocket subscription for streamed replies; use poe.com directly for now.'
      );
    }
    ctx.write(content);
    ctx.end();
  },
});
