'use strict';
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const CHAT = 'https://api2.twinmind.com/api/v3/chat';
const MODELS = [{ slug: 'twinmind' }, { slug: 'twin-mind' }];

function extractToken(raw) {
  if (!raw) return '';
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      return j.accessToken || j.access_token || j.token || '';
    } catch {
      return t;
    }
  }
  return t.replace(/^Bearer\s+/i, '');
}

module.exports = makeProxy({
  name: 'twinmind',
  models: MODELS,
  getCookie: () => envCookie('TWINMIND_TOKEN', 'TWINMIND_JWT'),
  async run(ctx) {
    const token = extractToken(ctx.cookie);
    if (!token) throw new Error('TWINMIND_TOKEN required (Firebase JWT or stsTokenManager JSON)');
    const msg = lastUserText(ctx.opts.messages);
    const r = await fetch(CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream, application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        message: msg,
        messages: ctx.opts.messages || [{ role: 'user', content: msg }],
        model: 'auto',
        stream: true,
      }),
    });
    if (!r.ok) throw new Error(`Twinmind ${r.status}: ${(await r.text()).slice(0, 220)}`);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('event-stream')) {
      let got = false;
      await readSseOpenAI(r, (t) => {
        got = true;
        ctx.write(t);
      });
      if (!got) ctx.write('\n\n[Error: Twinmind empty SSE]');
    } else {
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        ctx.write(j?.message || j?.content || j?.text || text.slice(0, 1500));
      } catch {
        ctx.write(text.slice(0, 1500));
      }
    }
    ctx.end();
  },
});
