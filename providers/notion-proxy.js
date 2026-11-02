'use strict';
const { lastUserText, envCookie, makeProxy } = require('../web-kit');
const URL = 'https://app.notion.com/api/v3/runInferenceTranscript';
const MODELS = [{ slug: 'notion' }, { slug: 'notion-ai' }, { slug: 'notion-web' }];

module.exports = makeProxy({
  name: 'notion',
  models: MODELS,
  getCookie: () => envCookie('NOTION_COOKIE', 'NOTION_TOKEN_V2'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('NOTION_COOKIE required (token_v2)');
    const msg = lastUserText(ctx.opts.messages);
    const cookie = ctx.cookie.includes('token_v2=') ? ctx.cookie : `token_v2=${ctx.cookie}`;
    const r = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://app.notion.com',
        Referer: 'https://app.notion.com/ai',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        // Notion transcript shape is complex; minimal prompt surface
        traceId: require('crypto').randomUUID(),
        spaceId: null,
        transcript: [{ type: 'user', value: [{ type: 'text', content: msg }] }],
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Notion ${r.status}: ${text.slice(0, 200)}`);
    ctx.write(text.slice(0, 2000) || '\n\n[Error: Notion empty — spaceId may be required]');
    ctx.end();
  },
});
