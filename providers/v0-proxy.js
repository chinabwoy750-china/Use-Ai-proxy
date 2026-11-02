'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://v0.dev/api/chat';
const MODELS = [{ slug: 'v0' }, { slug: 'v0-dev' }, { slug: 'vercel-v0' }];

module.exports = makeProxy({
  name: 'v0',
  models: MODELS,
  getCookie: () => envCookie('V0_COOKIE', 'VERCEL_V0_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('V0_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: ctx.cookie,
        Origin: 'https://v0.dev',
        Referer: 'https://v0.dev/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        message: msg,
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`v0 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: v0 empty]');
    ctx.end();
  },
});
