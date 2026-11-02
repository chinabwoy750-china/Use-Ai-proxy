'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = process.env.LONGCAT_URL || 'https://api.longcat.chat/openai/v1/chat/completions';
const MODELS = [{ slug: 'longcat' }, { slug: 'longcat-lite' }];

module.exports = makeProxy({
  name: 'longcat',
  models: MODELS,
  getCookie: () => envCookie('LONGCAT_API_KEY', 'LONGCAT_KEY'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('LONGCAT_API_KEY required');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.cookie}`,
      },
      body: JSON.stringify({
        model: 'LongCat-Flash-Lite',
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`LongCat ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: LongCat empty]');
    ctx.end();
  },
});
