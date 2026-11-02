'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = 'https://t3.chat';
const MODELS = [{ slug: 't3' }, { slug: 't3-web' }, { slug: 't3-chat' }];

module.exports = makeProxy({
  name: 't3',
  models: MODELS,
  getCookie: () => envCookie('T3_COOKIE', 'T3_CHAT_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('T3_COOKIE required (include convex-session-id)');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: ctx.cookie,
        Origin: BASE,
        Referer: `${BASE}/`,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`t3.chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: t3 empty — check convex-session-id cookie]');
    ctx.end();
  },
});
