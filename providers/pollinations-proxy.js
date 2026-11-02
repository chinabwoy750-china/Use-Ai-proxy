'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const URLS = [
  'https://gen.pollinations.ai/v1/chat/completions',
  'https://text.pollinations.ai/openai',
];
const MODELS = [
  { slug: 'pollinations' },
  { slug: 'pollinations-openai' },
  { slug: 'pollinations-gpt' },
];

module.exports = makeProxy({
  name: 'pollinations',
  models: MODELS,
  getCookie: () => envCookie('POLLINATIONS_KEY', 'POLLINATIONS_API_KEY'),
  async run(ctx) {
    const msg = lastUserText(ctx.opts.messages);
    const body = {
      model: ctx.opts.model?.includes('gpt') ? 'openai' : 'openai',
      messages: ctx.opts.messages || [{ role: 'user', content: msg }],
      stream: true,
    };
    let lastErr = '';
    for (const url of URLS) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'Mozilla/5.0',
        };
        if (ctx.cookie) headers.Authorization = `Bearer ${ctx.cookie}`;
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!r.ok) {
          lastErr = `${url} ${r.status} ${(await r.text()).slice(0, 120)}`;
          continue;
        }
        let got = false;
        await readSseOpenAI(r, (t) => {
          got = true;
          ctx.write(t);
        });
        if (!got) ctx.write('\n\n[Error: Pollinations empty]');
        ctx.end();
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    throw new Error(`Pollinations failed: ${lastErr}`);
  },
});
