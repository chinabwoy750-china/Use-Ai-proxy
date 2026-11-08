/** Provider capture definitions (classic script) */
const EXT_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    match: [/chat\.deepseek\.com/, /deepseek\.com/],
    cookieDomains: ['.deepseek.com', 'chat.deepseek.com', 'www.deepseek.com'],
    localKeys: ['userToken', 'token'],
    build(ctx) {
      const token = String(ctx.local.userToken || ctx.local.token || ctx.bearer || '').replace(/^Bearer\s+/i, '');
      return { DEEPSEEK_URL: 'https://chat.deepseek.com', DEEPSEEK_TOKEN: token, DEEPSEEK_COOKIE: ctx.cookieHeader };
    },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    match: [/kimi\.ai/, /kimi\.com/],
    cookieDomains: ['.kimi.ai', 'www.kimi.ai', '.kimi.com', 'www.kimi.com'],
    localKeys: [],
    build(ctx) {
      let access = '', refresh = '';
      for (const [k, v] of Object.entries(ctx.local || {})) {
        if (/access/i.test(k) && String(v).startsWith('eyJ')) access = v;
        if (/refresh/i.test(k) && String(v).startsWith('eyJ')) refresh = v;
      }
      return {
        KIMI_URL: /kimi\.com/.test(ctx.url || '') ? 'https://www.kimi.com' : 'https://www.kimi.ai',
        KIMI_TOKEN: access,
        KIMI_REFRESH_TOKEN: refresh,
      };
    },
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    match: [/perplexity\.ai/],
    cookieDomains: ['.perplexity.ai', 'www.perplexity.ai'],
    cookieNames: ['__Secure-next-auth.session-token', 'next-auth.session-token'],
    localKeys: [],
    build(ctx) { return { PERPLEXITY_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'grok',
    name: 'Grok',
    match: [/grok\.com/, /x\.com/],
    cookieDomains: ['.grok.com', 'grok.com', '.x.com'],
    localKeys: [],
    build(ctx) { return { GROK_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'uc',
    name: 'UC / uncensored.com',
    match: [/uncensored\.com/],
    cookieDomains: ['.uncensored.com', 'uncensored.com', 'www.uncensored.com'],
    cookieNames: ['__client'],
    localKeys: [],
    build(ctx) { return { UC_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    match: [/huggingface\.co/],
    cookieDomains: ['.huggingface.co', 'huggingface.co'],
    cookieNames: ['hf-chat'],
    localKeys: [],
    build(ctx) {
      const hf = (ctx.cookies || []).find((c) => c.name === 'hf-chat');
      return { HF_CHAT_COOKIE: hf ? hf.value : ctx.cookieHeader };
    },
  },
  {
    id: 'poe',
    name: 'Poe',
    match: [/poe\.com/],
    cookieDomains: ['.poe.com', 'poe.com'],
    cookieNames: ['p-b', 'p-lat'],
    localKeys: [],
    build(ctx) { return { POE_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'zai',
    name: 'Z.ai',
    match: [/chat\.z\.ai/, /z\.ai/],
    cookieDomains: ['.z.ai', 'chat.z.ai', 'z.ai'],
    localKeys: ['token'],
    build(ctx) {
      return {
        ZAI_TOKEN: String(ctx.local.token || ctx.bearer || '').replace(/^Bearer\s+/i, ''),
        ZAI_COOKIE: ctx.cookieHeader,
      };
    },
  },
  {
    id: 'venice',
    name: 'Venice',
    match: [/venice\.ai/],
    cookieDomains: ['.venice.ai', 'venice.ai'],
    localKeys: [],
    build(ctx) { return { VENICE_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'notrack',
    name: 'NoTrack',
    match: [/notrack\.ai/],
    cookieDomains: ['.notrack.ai', 'notrack.ai'],
    localKeys: [],
    build(ctx) { return { NOTRACK_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 't3',
    name: 't3.chat',
    match: [/t3\.chat/],
    cookieDomains: ['.t3.chat', 't3.chat'],
    localKeys: [],
    build(ctx) { return { T3_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'arena',
    name: 'LM Arena',
    match: [/lmarena\.ai/],
    cookieDomains: ['.lmarena.ai', 'lmarena.ai'],
    localKeys: [],
    build(ctx) { return { ARENA_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'blackbox',
    name: 'Blackbox',
    match: [/blackbox\.ai/],
    cookieDomains: ['.blackbox.ai', 'www.blackbox.ai'],
    localKeys: [],
    build(ctx) { return { BLACKBOX_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'doubao',
    name: 'Doubao',
    match: [/doubao\.com/],
    cookieDomains: ['.doubao.com', 'www.doubao.com'],
    localKeys: [],
    build(ctx) { return { DOUBAO_COOKIE: ctx.cookieHeader }; },
  },
  {
    id: 'aistudio',
    name: 'Google AI Studio',
    match: [/aistudio\.google\.com/],
    cookieDomains: ['.google.com', 'aistudio.google.com'],
    localKeys: [],
    build(ctx) { return { AISTUDIO_COOKIE: ctx.cookieHeader }; },
  },
];

function extDetectProvider(url) {
  const u = String(url || '');
  return EXT_PROVIDERS.find((p) => (p.match || []).some((re) => re.test(u))) || null;
}
