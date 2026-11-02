'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://www.dola.com/chat/completion';
const MODELS = [{ slug: 'doubao' }, { slug: 'dola' }, { slug: 'doubao-web' }];

module.exports = makeProxy({
  name: 'doubao',
  models: MODELS,
  getCookie: () => envCookie('DOUBAO_COOKIE', 'DOLA_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('DOUBAO_COOKIE / DOLA_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: ctx.cookie,
        Origin: 'https://www.dola.com',
        Referer: 'https://www.dola.com/chat/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Doubao/Dola ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Doubao empty]');
    ctx.end();
  },
});
