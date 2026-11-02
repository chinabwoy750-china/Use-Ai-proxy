'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const URL = 'https://outerface.venice.ai/api/inference/chat';
const MODELS = [{ slug: 'venice' }, { slug: 'venice-web' }];

module.exports = makeProxy({
  name: 'venice',
  models: MODELS,
  getCookie: () => envCookie('VENICE_COOKIE', 'VENICE_TOKEN'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('VENICE_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://venice.ai',
      Referer: 'https://venice.ai/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
    else headers.Authorization = `Bearer ${ctx.cookie}`;
    const r = await fetch(URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        model: 'default',
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Venice ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Venice empty reply]');
    ctx.end();
  },
});
