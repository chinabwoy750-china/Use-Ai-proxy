'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = 'https://yuanbao.tencent.com';
const CREATE = `${BASE}/api/user/agent/conversation/create`;
const MODELS = [{ slug: 'yuanbao' }, { slug: 'tencent-yuanbao' }];

module.exports = makeProxy({
  name: 'yuanbao',
  models: MODELS,
  getCookie: () => envCookie('YUANBAO_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('YUANBAO_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: ctx.cookie,
      Origin: BASE,
      Referer: `${BASE}/`,
      'User-Agent': 'Mozilla/5.0',
    };
    const cr = await fetch(CREATE, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'naQivTmsDa' }),
    });
    const cj = await cr.json().catch(() => ({}));
    const convId = cj?.id || cj?.data?.id;
    if (!cr.ok || !convId) throw new Error(`Yuanbao create ${cr.status}: ${JSON.stringify(cj).slice(0, 180)}`);
    const r = await fetch(`${BASE}/api/chat/${convId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: msg,
        agentId: 'naQivTmsDa',
        conversationId: convId,
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Yuanbao chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Yuanbao empty]');
    ctx.end();
  },
});
