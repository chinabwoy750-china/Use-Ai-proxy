'use strict';
const { lastUserText, envCookie, makeProxy } = require('../web-kit');
const GQL = 'https://data.prompt.ql.app/promptql/playground-v2-hge/v1/graphql';
const MODELS = [{ slug: 'promptql' }, { slug: 'prompt-ql' }];

module.exports = makeProxy({
  name: 'promptql',
  models: MODELS,
  getCookie: () => envCookie('PROMPTQL_TOKEN', 'PROMPTQL_JWT'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('PROMPTQL_TOKEN required (Bearer JWT from data.prompt.ql.app graphql)');
    const token = ctx.cookie.replace(/^Bearer\s+/i, '');
    const msg = lastUserText(ctx.opts.messages);
    // Minimal GraphQL probe — full playground query varies by project
    const r = await fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://prompt.ql.app',
        Referer: 'https://prompt.ql.app/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        query: 'query { __typename }',
        variables: { prompt: msg },
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`PromptQL ${r.status}: ${text.slice(0, 220)}`);
    ctx.write(text.slice(0, 1500) || '\n\n[Error: PromptQL empty — need enrich-token JWT + project query]');
    ctx.end();
  },
});
