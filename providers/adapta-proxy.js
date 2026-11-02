'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const STREAM = 'https://agent.adapta.one/api/chat/stream/v1';
const MODELS = [{ slug: 'adapta' }, { slug: 'adapta-web' }];

module.exports = makeProxy({
  name: 'adapta',
  models: MODELS,
  getCookie: () => envCookie('ADAPTA_COOKIE', 'ADAPTA_TOKEN'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('ADAPTA_COOKIE required (Clerk session)');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://agent.adapta.one',
      Referer: 'https://agent.adapta.one/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
    else headers.Authorization = `Bearer ${ctx.cookie}`;
    const r = await fetch(STREAM, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Adapta ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Adapta empty]');
    ctx.end();
  },
});
