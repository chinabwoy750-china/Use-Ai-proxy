'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = 'https://aistudio.tencent.ai';
const MODELS = [{ slug: 'aistudio' }, { slug: 'tencent-aistudio' }, { slug: 'hunyuan' }];

module.exports = makeProxy({
  name: 'aistudio',
  models: MODELS,
  getCookie: () => envCookie('AISTUDIO_COOKIE', 'TENCENT_AISTUDIO_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('AISTUDIO_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const url = `${BASE}/api/chat/HunyuanDefault`;
    const r = await fetch(url, {
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
    if (!r.ok) throw new Error(`AI Studio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: AI Studio empty]');
    ctx.end();
  },
});
