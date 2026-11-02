'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://zenmux.ai/api/anthropic/v1/messages';
const MODELS = [{ slug: 'zenmux' }, { slug: 'zenmux-free' }];

module.exports = makeProxy({
  name: 'zenmux',
  models: MODELS,
  getCookie: () => envCookie('ZENMUX_COOKIE', 'ZENMUX_TOKEN'),
  async run(ctx) {
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      Origin: 'https://zenmux.ai',
      Referer: 'https://zenmux.ai/platform/chat',
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie) {
      if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
      else headers['x-api-key'] = ctx.cookie;
    }
    const r = await fetch(CHAT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'default',
        max_tokens: 2048,
        stream: true,
        messages: [{ role: 'user', content: msg }],
      }),
    });
    if (!r.ok) throw new Error(`ZenMux ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    // anthropic SSE content_block_delta
    if (!got) {
      // try re-read not possible; signal
      ctx.write('\n\n[Error: ZenMux empty stream]');
    }
    ctx.end();
  },
});
