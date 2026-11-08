'use strict';
const { makeProxy, lastUserText, readSseOpenAI } = require('../web-kit');
const kiroOauth = require('../kiro-oauth');

const REFRESH_URL = process.env.KIRO_REFRESH_URL || 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const BASES = (
  process.env.KIRO_BASES ||
  'https://runtime.us-east-1.kiro.dev/generateAssistantResponse'
).split(',').map((s) => s.trim()).filter(Boolean);

async function refreshAccess(refreshToken) {
  const r = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) throw new Error('Kiro refresh ' + r.status + ': ' + (await r.text()).slice(0, 180));
  const j = await r.json();
  return j.accessToken || j.access_token || j.token;
}

module.exports = makeProxy({
  name: 'kiro',
  models: [
    { slug: 'kiro' },
    { slug: 'kiro-sonnet' },
    { slug: 'claude-sonnet-4.5' },
    { slug: 'claude-haiku-4.5' },
  ],
  getCookie: () => process.env.KIRO_ACCESS_TOKEN || process.env.KIRO_REFRESH_TOKEN || '',
  async run(ctx) {
    let access = process.env.KIRO_ACCESS_TOKEN || '';
    const refresh = process.env.KIRO_REFRESH_TOKEN || '';
    const apiKey = process.env.KIRO_API_KEY || '';
    if (!access && refresh) {
      try {
        const tok = await kiroOauth.refreshSocial(refresh);
        access = tok.accessToken;
        if (tok.refreshToken) process.env.KIRO_REFRESH_TOKEN = tok.refreshToken;
      } catch (e) {
        access = await refreshAccess(refresh);
      }
      process.env.KIRO_ACCESS_TOKEN = access;
    }
    if (!access && !apiKey) throw new Error('KIRO_ACCESS_TOKEN / KIRO_REFRESH_TOKEN or KIRO_API_KEY required');

    const token = access || apiKey;
    const prompt = lastUserText(ctx.opts.messages);
    // Kiro native protocol is complex; try OpenAI-compat path if KIRO_OPENAI_BASE set
    const openaiBase = process.env.KIRO_OPENAI_BASE;
    if (openaiBase) {
      const r = await fetch(openaiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ctx.opts.model || 'kiro',
          messages: ctx.opts.messages || [{ role: 'user', content: prompt }],
          stream: true,
        }),
      });
      if (!r.ok) throw new Error('Kiro ' + r.status + ': ' + (await r.text()).slice(0, 220));
      await readSseOpenAI(r, ctx.write);
      ctx.end();
      return;
    }

    // Minimal non-stream fallback message so UI can verify credentials path
    const base = BASES[0];
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        'x-amz-sso-bearer': token,
        'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
      },
      body: JSON.stringify({
        conversationState: {
          currentMessage: { userInputMessage: { content: prompt } },
          chatTriggerType: 'MANUAL',
        },
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Kiro ' + r.status + ': ' + text.slice(0, 240));
    let content = text;
    try {
      const j = JSON.parse(text);
      content = j.completion || j.output || j.message || JSON.stringify(j).slice(0, 500);
    } catch {}
    ctx.write(String(content));
    ctx.end();
  },
});
