'use strict';
const { lastUserText, messagesToPlain, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const DISPATCH = 'https://notrack.ai/api/dispatch';
const MODELS = [{ slug: 'notrack' }, { slug: 'notrack-web' }];

function buildCookie(raw) {
  if (!raw) return '';
  if (raw.includes('uid=') || raw.includes('si_')) return raw;
  return raw;
}

module.exports = makeProxy({
  name: 'notrack',
  models: MODELS,
  getCookie: () => envCookie('NOTRACK_COOKIE', 'NOTRACK_COOKIES'),
  async run(ctx) {
    const cookie = buildCookie(ctx.cookie);
    if (!cookie) throw new Error('NOTRACK_COOKIE required (uid + si_usr_id + si_ses_id)');
    const userInput = messagesToPlain(ctx.opts.messages) || lastUserText(ctx.opts.messages);
    const body = {
      user_input: userInput,
      mode: 'usual',
      model: 'C',
      persona: 'normal',
      max_turns: 6,
      chat_id: null,
      attachments: [],
      regenerate: false,
      edit: false,
      edit_mid: null,
    };
    const r = await fetch(DISPATCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: cookie,
        Origin: 'https://notrack.ai',
        Referer: 'https://notrack.ai/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`NoTrack ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    // also try raw text lines as content
    if (!got) ctx.write('\n\n[Error: NoTrack empty stream]');
    ctx.end();
  },
});
