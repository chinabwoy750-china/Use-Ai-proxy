'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://gov.freegpt.win/api/openai/oneapi/v1/chat/completions';
const MODELS = [{ slug: 'tinycms' }, { slug: 'tinycms-web' }, { slug: 'freegpt' }];

module.exports = makeProxy({
  name: 'tinycms',
  models: MODELS,
  getCookie: () => envCookie('TINYCMS_COOKIE', 'TINYCMS_TOKEN'),
  async run(ctx) {
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-origin': 'https://gov.freegpt.win',
      referer: 'https://gov.freegpt.win/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie) {
      if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
      else headers.Authorization = `Bearer ${ctx.cookie}`;
    }
    const r = await fetch(CHAT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`TinyCMS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: TinyCMS empty]');
    ctx.end();
  },
});
