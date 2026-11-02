'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://chatapi.innerai.com/chat';
const MODELS = [{ slug: 'inner' }, { slug: 'inner-ai' }, { slug: 'innerai' }];

module.exports = makeProxy({
  name: 'inner',
  models: MODELS,
  getCookie: () => envCookie('INNER_COOKIE', 'INNER_TOKEN', 'INNER_AI_TOKEN'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('INNER_COOKIE or INNER_TOKEN required');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://app.innerai.com',
      Referer: 'https://app.innerai.com/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
    else headers.Authorization = `Bearer ${ctx.cookie}`;
    const r = await fetch(CHAT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Inner.ai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Inner.ai empty]');
    ctx.end();
  },
});
