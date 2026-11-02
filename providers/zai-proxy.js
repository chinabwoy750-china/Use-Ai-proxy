'use strict';
const crypto = require('crypto');
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const BASE = 'https://chat.z.ai';
const CHAT = `${BASE}/api/v2/chat/completions`;
const MODELS = [
  { slug: 'zai' },
  { slug: 'z-ai' },
  { slug: 'zai-web' },
  { slug: 'glm-z' },
];

module.exports = makeProxy({
  name: 'zai',
  models: MODELS,
  getCookie: () => envCookie('ZAI_COOKIE', 'ZAI_TOKEN'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('ZAI_COOKIE or ZAI_TOKEN required');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: BASE,
      Referer: `${BASE}/`,
      'User-Agent': 'Mozilla/5.0',
    };
    if (ctx.cookie.includes('=')) headers.Cookie = ctx.cookie;
    else headers.Authorization = `Bearer ${ctx.cookie}`;
    const body = {
      stream: true,
      model: 'glm-4.5',
      messages: ctx.opts.messages || [{ role: 'user', content: msg }],
      chat_id: crypto.randomUUID(),
      id: crypto.randomUUID(),
    };
    const r = await fetch(CHAT, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Z.ai ${r.status}: ${(await r.text()).slice(0, 220)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) ctx.write('\n\n[Error: Z.ai empty — may need CAPTCHA/browser worker]');
    ctx.end();
  },
});
