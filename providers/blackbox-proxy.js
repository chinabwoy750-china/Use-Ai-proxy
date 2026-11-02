'use strict';
const crypto = require('crypto');
const { lastUserText, envCookie, makeProxy, readSseOpenAI } = require('../web-kit');
const API = 'https://app.blackbox.ai/api/chat';
const MODELS = [{ slug: 'blackbox' }, { slug: 'blackbox-web' }];

module.exports = makeProxy({
  name: 'blackbox',
  models: MODELS,
  getCookie: () => envCookie('BLACKBOX_COOKIE'),
  async run(ctx) {
    if (!ctx.cookie) throw new Error('BLACKBOX_COOKIE required');
    const msg = lastUserText(ctx.opts.messages);
    const chatId = crypto.randomUUID();
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Cookie: ctx.cookie,
        Origin: 'https://app.blackbox.ai',
        Referer: `https://app.blackbox.ai/chat/${chatId}`,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        messages: [{ id: chatId, content: msg, role: 'user' }],
        id: chatId,
        previewToken: null,
        userId: null,
        codeModelMode: true,
        agentMode: {},
        trendingAgentMode: {},
        isMicMode: false,
        userSystemPrompt: null,
        maxTokens: 1024,
        playgroundTopP: null,
        playgroundTemperature: null,
        isChromeExt: false,
        githubToken: null,
        clickedAnswer2: false,
        clickedAnswer3: false,
        clickedForceWebSearch: false,
        visitFromDelta: false,
        mobileClient: false,
        userSelectedModel: null,
        validated: '00f222a518cbbd5e',
        imageGenerationMode: false,
        webSearchModePrompt: false,
        deepSearchMode: false,
      }),
    });
    if (!r.ok) throw new Error(`Blackbox ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let got = false;
    await readSseOpenAI(r, (t) => {
      got = true;
      ctx.write(t);
    });
    if (!got) {
      const t = await r.clone?.text?.().catch(() => '');
      if (t) ctx.write(t.slice(0, 1000));
      else ctx.write('\n\n[Error: Blackbox empty]');
    }
    ctx.end();
  },
});
