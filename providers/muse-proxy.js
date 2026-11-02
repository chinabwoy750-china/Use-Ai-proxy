'use strict';
const { lastUserText, envCookie, makeProxy } = require('../web-kit');
const GQL = 'https://www.meta.ai/api/graphql';
const MODELS = [{ slug: 'muse' }, { slug: 'meta-ai' }, { slug: 'muse-spark' }];

module.exports = makeProxy({
  name: 'muse',
  models: MODELS,
  getCookie: () => envCookie('MUSE_COOKIE', 'META_AI_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('MUSE_COOKIE / META_AI_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ctx.cookie,
        Origin: 'https://www.meta.ai',
        Referer: 'https://www.meta.ai/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        // GraphQL doc id changes; best-effort message
        variables: { message: msg },
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Meta AI ${r.status}: ${text.slice(0, 200)}`);
    ctx.write(text.slice(0, 1500) || '\n\n[Error: Meta AI empty — GraphQL doc may need update]');
    ctx.end();
  },
});
