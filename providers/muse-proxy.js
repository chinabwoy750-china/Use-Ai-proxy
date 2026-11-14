
'use strict';
/**
 * Meta AI (meta.ai) — cookie session → OpenAI SSE
 * Needs MUSE_COOKIE / META_AI_COOKIE with full jar from www.meta.ai
 * GraphQL requires fb_dtsg + lsd; we bootstrap those from the homepage when possible.
 */
const { lastUserText, envCookie, makeProxy } = require('../web-kit');

const HOME = 'https://www.meta.ai/';
const GQL = 'https://www.meta.ai/api/graphql';
const MODELS = [{ slug: 'muse' }, { slug: 'meta-ai' }, { slug: 'muse-spark' }];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function pick(re, text) {
  const m = text && text.match(re);
  return m ? m[1] : '';
}

async function bootstrap(cookie) {
  const r = await fetch(HOME, {
    headers: {
      Cookie: cookie,
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.meta.ai/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  const fb_dtsg =
    pick(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/, html) ||
    pick(/"dtsg":\{"token":"([^"]+)"/, html) ||
    pick(/name="fb_dtsg"\s+value="([^"]+)"/, html) ||
    pick(/fb_dtsg\\?":\\?"([^"\\]+)/, html);
  const lsd =
    pick(/"LSD",\[\],\{"token":"([^"]+)"/, html) ||
    pick(/name="lsd"\s+value="([^"]+)"/, html) ||
    pick(/"lsd":"([^"]+)"/, html);
  const userId =
    pick(/"USER_ID":"(\d+)"/, html) ||
    pick(/"userID":"(\d+)"/, html) ||
    pick(/"actorID":"(\d+)"/, html) ||
    '0';
  // Common meta.ai chat-friendly doc ids rotate; try a few known + page-embedded
  const docIds = [
    ...new Set(
      [
        pick(/"doc_id":"(\d{15,20})"/, html),
        pick(/doc_id=(\d{15,20})/, html),
        // fallbacks occasionally seen in public clients (may go stale)
        '24060673956617425',
        '7338230682907343',
      ].filter(Boolean)
    ),
  ];
  return { fb_dtsg, lsd, userId, docIds, status: r.status, htmlLen: html.length };
}

function extractReply(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') {
    try {
      return extractReply(JSON.parse(payload));
    } catch {
      return payload.slice(0, 4000);
    }
  }
  const chunks = [];
  const walk = (o, depth) => {
    if (depth > 12 || o == null) return;
    if (typeof o === 'string') {
      if (o.length > 8 && !/^[A-Z0-9_]+$/.test(o) && !o.startsWith('http')) chunks.push(o);
      return;
    }
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (/text|message|snippet|content|body|reply/i.test(k) && typeof v === 'string') chunks.push(v);
        else walk(v, depth + 1);
      }
    }
  };
  walk(payload, 0);
  // prefer longest textual chunk
  chunks.sort((a, b) => b.length - a.length);
  return (chunks[0] || '').trim();
}

module.exports = makeProxy({
  name: 'muse',
  models: MODELS,
  getCookie: () => envCookie('MUSE_COOKIE', 'META_AI_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('MUSE_COOKIE / META_AI_COOKIE required (full jar from www.meta.ai)');
    const msg = lastUserText(ctx.opts.messages);
    if (!msg) throw new Error('empty message');

    const boot = await bootstrap(ctx.cookie);
    if (!boot.fb_dtsg || !boot.lsd) {
      throw new Error(
        `Meta AI session bootstrap failed (status ${boot.status}, html ${boot.htmlLen}). Cookie missing/expired or Cloudflare blocked Render IP — re-capture cookies on meta.ai while logged in.`
      );
    }

    let lastErr = '';
    for (const doc_id of boot.docIds) {
      const variables = {
        input: {
          message: {
            sensitive_string_value: msg,
          },
          externalConversationId: null,
          promptID: '',
          externalConversationIdKey: '',
        },
      };
      // Also try simpler shapes Meta has used
      const attempts = [
        {
          fb_dtsg: boot.fb_dtsg,
          lsd: boot.lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'useAbraSendMessageMutation',
          variables: JSON.stringify(variables),
          doc_id,
          server_timestamps: true,
        },
        {
          fb_dtsg: boot.fb_dtsg,
          lsd: boot.lsd,
          variables: JSON.stringify({ message: msg, conversation_id: null }),
          doc_id,
        },
      ];

      for (const form of attempts) {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) body.set(k, String(v));
        if (boot.userId && boot.userId !== '0') body.set('__user', boot.userId);
        body.set('__a', '1');

        const r = await fetch(GQL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: ctx.cookie,
            Origin: 'https://www.meta.ai',
            Referer: 'https://www.meta.ai/',
            'User-Agent': UA,
            'X-FB-LSD': boot.lsd,
            'X-ASBD-ID': '129477',
            'X-FB-Friendly-Name': form.fb_api_req_friendly_name || 'MetaAIChat',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(45000),
        });
        const text = await r.text();
        if (!r.ok) {
          lastErr = `Meta AI ${r.status}: ${text.slice(0, 180)}`;
          continue;
        }
        let json = null;
        try {
          json = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ''));
        } catch {
          lastErr = 'Meta AI bad JSON';
          continue;
        }
        if (json.errors && json.errors.length) {
          lastErr = 'Meta AI: ' + (json.errors[0].message || JSON.stringify(json.errors[0])).slice(0, 200);
          continue;
        }
        const reply = extractReply(json);
        if (reply && reply.length > 2) {
          ctx.write(reply);
          ctx.end();
          return;
        }
        lastErr = 'Meta AI empty payload for doc_id ' + doc_id;
      }
    }

    throw new Error(
      (lastErr || 'Meta AI failed') +
        ' — GraphQL doc_id may have rotated. Re-login on meta.ai, re-copy cookies via the extension, or use another chat provider.'
    );
  },
});
