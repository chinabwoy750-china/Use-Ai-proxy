'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const MODELS = [{ slug: 'maxai' }, { slug: 'max-ai' }];

module.exports = makeProxy({
  name: 'maxai',
  models: MODELS,
  getCookie: () => envCookie('MAXAI_COOKIE', 'MAXAI_TOKEN'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('MAXAI_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    // MaxAI often uses extension backend; try common chat path
    const url = 'https://api.maxai.co/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
    else headers.Authorization = `Bearer ${ctx.cookie}`;
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`MaxAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: MaxAI empty]');
    ctx.end();
  },
});
