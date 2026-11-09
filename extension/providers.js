/**
 * Capture map for ALL web-session providers in myproxy-use.
 * API-key / OAuth-only providers are listed at the bottom (not auto-captured).
 */
function unwrapToken(raw) {
  let t = String(raw || '').trim().replace(/^Bearer\s+/i, '');
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('"')) {
    try {
      const j = JSON.parse(t);
      if (typeof j === 'string') t = j;
      else if (j && typeof j === 'object') {
        t = j.value || j.token || j.userToken || j.access_token || j.accessToken || t;
      }
    } catch (e) {}
  }
  return String(t || '').replace(/^Bearer\s+/i, '').trim();
}

function pickJwt(local) {
  let access = '', refresh = '';
  for (const [k, v] of Object.entries(local || {})) {
    const u = unwrapToken(v);
    if (!u.startsWith('eyJ') && u.length < 20) continue;
    if (/refresh/i.test(k)) refresh = u;
    else if (/access|token|auth|jwt/i.test(k)) access = access || u;
    else if (u.startsWith('eyJ')) access = access || u;
  }
  return { access, refresh };
}

function cookieOnly(envKey) {
  return function build(ctx) {
    if (!ctx.cookieHeader) throw new Error('No cookies — log in on this site first');
    const o = {};
    o[envKey] = ctx.cookieHeader;
    return o;
  };
}

const EXT_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    match: [/chat\.deepseek\.com/, /deepseek\.com/],
    cookieDomains: ['.deepseek.com', 'chat.deepseek.com', 'www.deepseek.com'],
    localKeys: ['userToken', 'token'],
    build(ctx) {
      let token = unwrapToken(ctx.local.userToken || ctx.local.token || ctx.bearer || '');
      if (!token) {
        for (const [k, v] of Object.entries(ctx.local || {})) {
          if (!/token/i.test(k)) continue;
          const u = unwrapToken(v);
          if (u && u.length > 20) { token = u; break; }
        }
      }
      if (!token) throw new Error('No DeepSeek token in localStorage');
      if (!ctx.cookieHeader) throw new Error('No DeepSeek cookies');
      return {
        DEEPSEEK_URL: 'https://chat.deepseek.com',
        DEEPSEEK_TOKEN: token,
        DEEPSEEK_COOKIE: ctx.cookieHeader,
      };
    },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    match: [/kimi\.ai/, /kimi\.com/],
    cookieDomains: ['.kimi.ai', 'www.kimi.ai', '.kimi.com', 'www.kimi.com'],
    localKeys: [],
    build(ctx) {
      const { access, refresh } = pickJwt(ctx.local);
      if (!access && !refresh) throw new Error('No Kimi JWT in storage — log in first');
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
    cookieDomains: ['.perplexity.ai', 'www.perplexity.ai', '.www.perplexity.ai'],
    cookieNames: null,
    requireAnyCookie: ['__Secure-next-auth.session-token', 'next-auth.session-token'],
    localKeys: [],
    build(ctx) {
      const names = (ctx.cookies || []).map((c) => c.name);
      if (!names.some((n) => /session-token/i.test(n))) {
        throw new Error('Missing session-token — log in on perplexity.ai');
      }
      return { PERPLEXITY_COOKIE: ctx.cookieHeader };
    },
  },
  {
    id: 'grok',
    name: 'Grok',
    match: [/grok\.com/, /x\.com\/i\/grok/],
    cookieDomains: ['.grok.com', 'grok.com', '.x.com', 'x.com'],
    localKeys: [],
    build: cookieOnly('GROK_COOKIE'),
  },
  {
    id: 'uc',
    name: 'UC / uncensored.com',
    match: [/uncensored\.com/],
    cookieDomains: ['.uncensored.com', 'uncensored.com', 'www.uncensored.com'],
    cookieNames: null,
    requireAnyCookie: ['__client'],
    localKeys: [],
    build(ctx) {
      if (!(ctx.cookies || []).some((c) => c.name === '__client')) {
        throw new Error('Missing __client cookie (HttpOnly) — log in fully');
      }
      return { UC_COOKIE: ctx.cookieHeader };
    },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    match: [/huggingface\.co/],
    cookieDomains: ['.huggingface.co', 'huggingface.co'],
    cookieNames: null,
    localKeys: [],
    build(ctx) {
      const hf = (ctx.cookies || []).find((c) => c.name === 'hf-chat');
      if (!hf && !ctx.cookieHeader) throw new Error('No hf-chat cookie');
      return { HF_CHAT_COOKIE: hf ? hf.value : ctx.cookieHeader };
    },
  },
  {
    id: 'poe',
    name: 'Poe',
    match: [/poe\.com/],
    cookieDomains: ['.poe.com', 'poe.com'],
    localKeys: [],
    build: cookieOnly('POE_COOKIE'),
  },
  {
    id: 'zai',
    name: 'Z.ai',
    match: [/chat\.z\.ai/, /z\.ai/],
    cookieDomains: ['.z.ai', 'chat.z.ai', 'z.ai'],
    localKeys: ['token'],
    build(ctx) {
      const { access } = pickJwt(ctx.local);
      return {
        ZAI_TOKEN: access || unwrapToken(ctx.local.token || ctx.bearer || ''),
        ZAI_COOKIE: ctx.cookieHeader,
      };
    },
  },
  {
    id: 'venice',
    name: 'Venice',
    match: [/venice\.ai/],
    cookieDomains: ['.venice.ai', 'venice.ai', 'www.venice.ai'],
    localKeys: [],
    build: cookieOnly('VENICE_COOKIE'),
  },
  {
    id: 'notrack',
    name: 'NoTrack',
    match: [/notrack\.ai/],
    cookieDomains: ['.notrack.ai', 'notrack.ai'],
    localKeys: [],
    build: cookieOnly('NOTRACK_COOKIE'),
  },
  {
    id: 't3',
    name: 't3.chat',
    match: [/t3\.chat/],
    cookieDomains: ['.t3.chat', 't3.chat'],
    localKeys: [],
    build: cookieOnly('T3_COOKIE'),
  },
  {
    id: 'arena',
    name: 'LM Arena',
    match: [/lmarena\.ai/],
    cookieDomains: ['.lmarena.ai', 'lmarena.ai'],
    localKeys: [],
    build: cookieOnly('ARENA_COOKIE'),
  },
  {
    id: 'zenmux',
    name: 'ZenMux',
    match: [/zenmux\.ai/],
    cookieDomains: ['.zenmux.ai', 'zenmux.ai'],
    localKeys: [],
    build: cookieOnly('ZENMUX_COOKIE'),
  },
  {
    id: 'blackbox',
    name: 'Blackbox',
    match: [/blackbox\.ai/],
    cookieDomains: ['.blackbox.ai', 'www.blackbox.ai', 'blackbox.ai'],
    localKeys: [],
    build: cookieOnly('BLACKBOX_COOKIE'),
  },
  {
    id: 'doubao',
    name: 'Doubao',
    match: [/doubao\.com/],
    cookieDomains: ['.doubao.com', 'www.doubao.com', 'doubao.com'],
    localKeys: [],
    build: cookieOnly('DOUBAO_COOKIE'),
  },
  {
    id: 'yuanbao',
    name: 'Yuanbao',
    match: [/yuanbao\.tencent\.com/],
    cookieDomains: ['.tencent.com', 'yuanbao.tencent.com', '.yuanbao.tencent.com'],
    localKeys: [],
    build: cookieOnly('YUANBAO_COOKIE'),
  },
  {
    id: 'aistudio',
    name: 'Google AI Studio',
    match: [/aistudio\.google\.com/],
    cookieDomains: ['.google.com', 'aistudio.google.com'],
    localKeys: [],
    build: cookieOnly('AISTUDIO_COOKIE'),
  },
  {
    id: 'v0',
    name: 'v0.dev',
    match: [/v0\.dev/],
    cookieDomains: ['.v0.dev', 'v0.dev'],
    localKeys: [],
    build: cookieOnly('V0_COOKIE'),
  },
  {
    id: 'notion',
    name: 'Notion AI',
    match: [/notion\.so/, /notion\.site/],
    cookieDomains: ['.notion.so', 'www.notion.so', 'notion.so'],
    localKeys: [],
    build: cookieOnly('NOTION_COOKIE'),
  },
  {
    id: 'muse',
    name: 'Meta AI',
    match: [/meta\.ai/, /www\.meta\.ai/],
    cookieDomains: ['.meta.ai', 'meta.ai', 'www.meta.ai'],
    localKeys: [],
    build: cookieOnly('MUSE_COOKIE'),
  },
  {
    id: 'maxai',
    name: 'MaxAI',
    match: [/maxai\.me/],
    cookieDomains: ['.maxai.me', 'maxai.me'],
    localKeys: [],
    build: cookieOnly('MAXAI_COOKIE'),
  },
  {
    id: 'inner',
    name: 'Inner',
    match: [/inner\.ai/],
    cookieDomains: ['.inner.ai', 'inner.ai'],
    localKeys: [],
    build(ctx) {
      const { access } = pickJwt(ctx.local);
      const val = access || ctx.cookieHeader;
      if (!val) throw new Error('No Inner token/cookie');
      return { INNER_TOKEN: val };
    },
  },
  {
    id: 'adapta',
    name: 'Adapta',
    match: [/adapta\.org/],
    cookieDomains: ['.adapta.org', 'adapta.org'],
    localKeys: [],
    build: cookieOnly('ADAPTA_COOKIE'),
  },
  {
    id: 'tinycms',
    name: 'TinyCMS / FreeGPT',
    match: [/freegpt\.one/, /tinycms/],
    cookieDomains: ['.freegpt.one', 'freegpt.one'],
    localKeys: [],
    build: cookieOnly('TINYCMS_COOKIE'),
  },
  {
    id: 'promptql',
    name: 'PromptQL',
    match: [/promptql\.io/],
    cookieDomains: ['.promptql.io', 'promptql.io'],
    localKeys: [],
    build(ctx) {
      const { access } = pickJwt(ctx.local);
      if (!access && !ctx.cookieHeader) throw new Error('No PromptQL JWT/cookie');
      return { PROMPTQL_TOKEN: access || ctx.cookieHeader };
    },
  },
  {
    id: 'hyperagent',
    name: 'HyperAgent',
    match: [/hyperagent\.com/],
    cookieDomains: ['.hyperagent.com', 'hyperagent.com'],
    localKeys: [],
    build: cookieOnly('HYPERAGENT_COOKIE'),
  },
  {
    id: 'conol',
    name: 'Conol',
    match: [/conol\.ai/],
    cookieDomains: ['.conol.ai', 'conol.ai'],
    localKeys: [],
    build: cookieOnly('CONOL_COOKIE'),
  },
  {
    id: 'twinmind',
    name: 'Twinmind',
    match: [/twinmind\.com/],
    cookieDomains: ['.twinmind.com', 'app.twinmind.com', 'twinmind.com'],
    localKeys: [],
    build(ctx) {
      const { access } = pickJwt(ctx.local);
      if (!access && !ctx.cookieHeader) throw new Error('No Twinmind JWT/cookie');
      return { TWINMIND_TOKEN: access || ctx.cookieHeader };
    },
  },
  {
    id: 'syntx',
    name: 'SYNTX',
    match: [/syntx\.ai/],
    cookieDomains: ['.syntx.ai', 'syntx.ai'],
    localKeys: [],
    build(ctx) {
      const { access } = pickJwt(ctx.local);
      if (!access && !ctx.cookieHeader) throw new Error('No SYNTX JWT/cookie');
      return { SYNTX_TOKEN: access || ctx.cookieHeader };
    },
  },
  {
    id: 'pollinations',
    name: 'Pollinations',
    match: [/pollinations\.ai/],
    cookieDomains: ['.pollinations.ai', 'pollinations.ai'],
    localKeys: [],
    build(ctx) {
      // often no auth; still save cookies if any
      return { POLLINATIONS_COOKIE: ctx.cookieHeader || '1' };
    },
  },
];

/** Not handled by cookie capture — use Admin OAuth / API key instead */
const EXT_SKIP = {
  kiro: 'Use Admin → Kiro → OAuth (Builder ID / Google / GitHub)',
  veo: 'Toggle VEO_ENABLED in Admin (no session cookie)',
  mistral: 'API key provider — paste key in Admin',
  openrouter: 'API key provider',
  nvidia: 'API key provider',
  ollama: 'API key provider',
  gemini: 'API key provider',
  opencode: 'Enable in Admin / env',
};

function extDetectProvider(url) {
  const u = String(url || '');
  return EXT_PROVIDERS.find((p) => (p.match || []).some((re) => re.test(u))) || null;
}
