'use strict';
const { lastUserText, envCookie, makeProxy } = require('../web-kit');
const ORIGIN = 'https://conol.ai';
const MODELS = [{ slug: 'conol' }, { slug: 'conol-web' }];

module.exports = makeProxy({
  name: 'conol',
  models: MODELS,
  getCookie: () => envCookie('CONOL_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('CONOL_COOKIE required (__Secure-better-auth.session_token)');
    const msg = lastUserText(ctx.opts.messages);
    const headers = {
      'Content-Type': 'application/json',
      Cookie: ctx.cookie,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': 'Mozilla/5.0',
    };
    const sr = await fetch(`${ORIGIN}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const sj = await sr.json().catch(() => ({}));
    const sid = sj?.id || sj?.session_id || sj?.sessionId;
    if (!sr.ok || !sid) throw new Error(`Conol session ${sr.status}: ${JSON.stringify(sj).slice(0, 180)}`);
    const mr = await fetch(`${ORIGIN}/api/sessions/${encodeURIComponent(sid)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: msg, message: msg }),
    });
    if (!mr.ok) throw new Error(`Conol message ${mr.status}: ${(await mr.text()).slice(0, 200)}`);
    // poll deltas briefly
    let out = '';
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const gr = await fetch(
        `${ORIGIN}/api/sessions/${encodeURIComponent(sid)}/messages?logDeltas=1`,
        { headers: { Cookie: ctx.cookie, Accept: 'application/x-ndjson, application/json' } }
      );
      const text = await gr.text();
      if (text && text.length > out.length) out = text;
      if (out.includes('"done"') || out.includes('finish')) break;
    }
    ctx.write(out.slice(0, 2500) || '\n\n[Error: Conol empty]');
    ctx.end();
  },
});
