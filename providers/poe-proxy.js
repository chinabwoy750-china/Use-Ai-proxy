'use strict';
const { lastUserText, envCookie, makeProxy } = require('../web-kit');
const GQL = 'https://www.poe.com/api/gql_POST';
const MODELS = [{ slug: 'poe' }, { slug: 'poe-web' }];

function pb(cookie) {
  const m = String(cookie).match(/p-b=([^;]+)/);
  return m ? m[1] : cookie;
}

module.exports = makeProxy({
  name: 'poe',
  models: MODELS,
  getCookie: () => envCookie('POE_COOKIE', 'POE_PB'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('POE_COOKIE required (p-b=...)');
    const token = pb(ctx.cookie);
    const msg = lastUserText(ctx.opts.messages);
    // Poe uses GraphQL; simplified send — may need formkey from page for full fidelity
    const r = await fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `p-b=${token}`,
        Origin: 'https://www.poe.com',
        Referer: 'https://www.poe.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        queryName: 'sendMessageMutation',
        variables: { query: msg },
        query: 'mutation { placeholder }',
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Poe ${r.status}: ${text.slice(0, 220)}`);
    // best-effort parse
    try {
      const j = JSON.parse(text);
      const content =
        j?.data?.messageEdge?.node?.text ||
        j?.data?.messageAdded?.text ||
        JSON.stringify(j).slice(0, 500);
      ctx.write(content || text.slice(0, 500));
    } catch {
      ctx.write(text.slice(0, 800));
    }
    ctx.end();
  },
});
