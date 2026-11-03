'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const ORIGIN = 'https://hyperagent.com';
const MODELS = [{ slug: 'hyperagent' }, { slug: 'hyper-agent' }];

module.exports = makeProxy({
  name: 'hyperagent',
  models: MODELS,
  getCookie: () => envCookie('HYPERAGENT_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('HYPERAGENT_COOKIE required (full Cookie header)');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: ctx.cookie.replace(/^Cookie:\s*/i, ''),
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': 'Mozilla/5.0',
    };
    const tr = await fetch(`${ORIGIN}/api/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const tj = await tr.json().catch(() => ({}));
    const threadId = tj?.id || tj?.threadId || tj?.data?.id;
    if (!tr.ok || !threadId) throw new Error(`HyperAgent thread ${tr.status}: ${JSON.stringify(tj).slice(0, 180)}`);
    const r = await fetch(`${ORIGIN}/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: msg,
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`HyperAgent chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: HyperAgent empty stream]');
    ctx.end();
  },
});
