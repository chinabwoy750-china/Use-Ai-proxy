'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = 'https://api.syntx.ai';
const MODELS = [{ slug: 'syntx' }, { slug: 'syntx-ai' }];

module.exports = makeProxy({
  name: 'syntx',
  models: MODELS,
  getCookie: () => envCookie('SYNTX_TOKEN', 'SYNTX_JWT'),
  async run(ctx) {
    const token = (ctx.cookie || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('SYNTX_TOKEN required (Bearer JWT from syntx.ai)');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://syntx.ai',
      Referer: 'https://syntx.ai/',
      'User-Agent': 'Mozilla/5.0',
    };
    const cr = await fetch(`${BASE}/api/v1/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'proxy', scope: 'text' }),
    });
    const cj = await cr.json().catch(() => ({}));
    const chatUuid = cj?.uuid || cj?.id || cj?.data?.uuid || cj?.data?.id;
    if (!cr.ok || !chatUuid) throw new Error(`SYNTX chat create ${cr.status}: ${JSON.stringify(cj).slice(0, 180)}`);
    const r = await fetch(`${BASE}/api/v1/llm/generate`, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({
        chat_uuid: chatUuid,
        text: msg,
        model: 'default',
        thinking: false,
        plan: false,
        deep_research: false,
        tools: [],
      }),
    });
    if (!r.ok) throw new Error(`SYNTX generate ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) {
      const t = await r.text().catch(() => '');
      ctx.write(t.slice(0, 1500) || '\n\n[Error: SYNTX empty]');
    }
    ctx.end();
  },
});
