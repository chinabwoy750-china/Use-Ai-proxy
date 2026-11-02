'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const MODELS = [{ slug: 'arena' }, { slug: 'lmarena' }, { slug: 'arena-ai' }];

module.exports = makeProxy({
  name: 'arena',
  models: MODELS,
  getCookie: () => envCookie('ARENA_COOKIE', 'LMARENA_COOKIE'),
  async run(ctx) {
    const msg = lastUserText(ctx.opts.messages);
    // Arena endpoints change often; try common path
    const url = 'https://arena.ai/api/chat';
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://arena.ai',
      Referer: 'https://arena.ai/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie) headers.Cookie = ctx.cookie;
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: ctx.opts.messages || [{ role: 'user', content: msg }], stream: true }),
    });
    if (!r.ok) throw new Error(`Arena ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Arena empty — site API may have changed]');
    ctx.end();
  },
});
