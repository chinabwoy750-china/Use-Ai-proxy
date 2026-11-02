'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const MODELS = [
  { slug: 'cloudflare' },
  { slug: 'cf-ai' },
  { slug: 'workers-ai' },
];

module.exports = makeProxy({
  name: 'cloudflare',
  models: MODELS,
  getCookie: () => envCookie('CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN'),
  async run(ctx) {
    const account = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!ctx.cookie || !account) throw new Error('CF_API_TOKEN + CF_ACCOUNT_ID required');
    const msg = lastUserText(ctx.opts.messages);
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.cookie}`,
      },
      body: JSON.stringify({
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Cloudflare AI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Cloudflare AI empty]');
    ctx.end();
  },
});
