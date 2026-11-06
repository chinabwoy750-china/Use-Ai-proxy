'use strict';
/**
 * Provider icon library — multi-CDN resolver.
 * Sources (in priority order after local uploads/links):
 *  1. Lobe Icons SVG  (unpkg / jsDelivr)
 *  2. Lobe Icons PNG dark
 *  3. Simple Icons
 *  4. Google S2 favicon of provider site
 *  5. DuckDuckGo icon service
 *
 * Future providers: resolveIcon(id, { site }) uses id as Lobe slug, then site favicon.
 */

const LOBE_SVG = (slug) =>
  `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${slug}.svg`;
const LOBE_SVG_JSDELIVR = (slug) =>
  `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${slug}.svg`;
const LOBE_PNG_DARK = (slug) =>
  `https://unpkg.com/@lobehub/icons-static-png@latest/dark/${slug}.png`;
const SIMPLE = (slug) => `https://cdn.simpleicons.org/${slug}`;
const FAVICON = (domain, size = 128) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;

const DDG = (domain) =>
  `https://icons.duckduckgo.com/ip3/${domain}.ico`;

/** Stable HSL accent from provider id */
function colorForId(id) {
  const s = String(id || 'x');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 58 + (h % 20);
  const light = 42 + (h % 12);
  return { hue, sat, light, bg: `hsl(${hue} ${sat}% ${light}%)`, fg: '#f8fafc' };
}

function initialsFor(id, text) {
  if (text && String(text).trim()) {
    const t = String(text).trim();
    if (t.length <= 3) return t.toUpperCase();
  }
  const parts = String(id || '?').split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(id || '?').slice(0, 2).toUpperCase();
}

/**
 * Custom default icon — rounded square, soft gradient, monogram.
 * Always available offline as a data URI (no CDN).
 */
function defaultIconDataUri(id, opts = {}) {
  const label = initialsFor(id, opts.text);
  const { hue, bg } = colorForId(id);
  const bg2 = `hsl(${(hue + 28) % 360} 52% 32%)`;
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="${bg2}"/>` +
    `</linearGradient>` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity=".35"/>` +
    `</filter></defs>` +
    `<rect width="128" height="128" rx="28" fill="#0b0f14"/>` +
    `<rect x="8" y="8" width="112" height="112" rx="24" fill="url(#g)" filter="url(#s)"/>` +
    `<text x="64" y="64" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="Inter,ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${safe.length > 2 ? 36 : 44}" ` +
    `font-weight="700" fill="#f8fafc" letter-spacing="-0.04em">${safe}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}


/** Explicit slug / domain map for known providers */
const PROVIDER_ICON_MAP = {
  deepseek: { lobe: 'deepseek', simple: 'deepseek', domain: 'deepseek.com' },
  kimi: { lobe: 'kimi', domain: 'kimi.ai' },
  moonshot: { lobe: 'moonshot', domain: 'moonshot.cn' },
  perplexity: { lobe: 'perplexity', simple: 'perplexity', domain: 'perplexity.ai' },
  grok: { lobe: 'grok', domain: 'x.ai' },
  xai: { lobe: 'xai', domain: 'x.ai' },
  uc: { domain: 'uncensored.com' },
  mistral: { lobe: 'mistral', simple: 'mistral', domain: 'mistral.ai' },
  huggingface: { lobe: 'huggingface', simple: 'huggingface', domain: 'huggingface.co' },
  hf: { lobe: 'huggingface', simple: 'huggingface', domain: 'huggingface.co' },
  opencode: { domain: 'opencode.ai' },
  notrack: { domain: 'notrack.ai' },
  t3: { domain: 't3.chat' },
  venice: { domain: 'venice.ai' },
  poe: { lobe: 'poe', domain: 'poe.com' },
  arena: { domain: 'lmarena.ai' },
  lmarena: { domain: 'lmarena.ai' },
  zenmux: { lobe: 'zenmux', domain: 'zenmux.ai' },
  blackbox: { domain: 'blackbox.ai' },
  inner: { domain: 'inner.ai' },
  adapta: { domain: 'adapta.org' },
  muse: { domain: 'meta.ai' },
  meta: { lobe: 'meta', simple: 'meta', domain: 'meta.ai' },
  tinycms: { domain: 'freegpt.one' },
  maxai: { domain: 'maxai.me' },
  pollinations: { domain: 'pollinations.ai' },
  doubao: { lobe: 'doubao', domain: 'doubao.com' },
  zai: { lobe: 'zai', domain: 'z.ai' },
  glm: { lobe: 'zhipu', domain: 'chatglm.cn' },
  zhipu: { lobe: 'zhipu', domain: 'zhipu.ai' },
  yuanbao: { lobe: 'yuanbao', domain: 'yuanbao.tencent.com' },
  aistudio: { lobe: 'google', simple: 'google', domain: 'aistudio.google.com' },
  google: { lobe: 'google', simple: 'google', domain: 'google.com' },
  gemini: { lobe: 'gemini', domain: 'gemini.google.com' },
  v0: { lobe: 'v0', domain: 'v0.dev' },
  notion: { lobe: 'notion', simple: 'notion', domain: 'notion.so' },
  cloudflare: { lobe: 'cloudflare', simple: 'cloudflare', domain: 'cloudflare.com' },
  longcat: { domain: 'longcat.chat' },
  promptql: { domain: 'promptql.io' },
  hyperagent: { domain: 'hyperagent.com' },
  conol: { domain: 'conol.ai' },
  twinmind: { domain: 'twinmind.com' },
  syntx: { domain: 'syntx.ai' },
  veo: { lobe: 'google', domain: 'deepmind.google' },
  openai: { lobe: 'openai', simple: 'openai', domain: 'openai.com' },
  anthropic: { lobe: 'anthropic', simple: 'anthropic', domain: 'anthropic.com' },
  claude: { lobe: 'claude', domain: 'claude.ai' },
  openrouter: { lobe: 'openrouter', domain: 'openrouter.ai' },
  groq: { lobe: 'groq', domain: 'groq.com' },
  together: { lobe: 'together', domain: 'together.ai' },
  fireworks: { lobe: 'fireworks', domain: 'fireworks.ai' },
  cohere: { lobe: 'cohere', simple: 'cohere', domain: 'cohere.com' },
  qwen: { lobe: 'qwen', domain: 'chat.qwen.ai' },
  alibaba: { lobe: 'alibabacloud', domain: 'aliyun.com' },
  minimax: { lobe: 'minimax', domain: 'minimaxi.com' },
  baichuan: { lobe: 'baichuan', domain: 'baichuan-ai.com' },
  yi: { lobe: 'yi', domain: 'lingyiwanwu.com' },
  stepfun: { lobe: 'stepfun', domain: 'stepfun.com' },
  siliconflow: { lobe: 'siliconcloud', domain: 'siliconflow.cn' },
  ollama: { lobe: 'ollama', domain: 'ollama.com' },
  lmstudio: { lobe: 'lmstudio', domain: 'lmstudio.ai' },
  cursor: { lobe: 'cursor', domain: 'cursor.com' },
  replit: { lobe: 'replit', simple: 'replit', domain: 'replit.com' },
  vercel: { lobe: 'vercel', simple: 'vercel', domain: 'vercel.com' },
  github: { lobe: 'github', simple: 'github', domain: 'github.com' },
  microsoft: { lobe: 'microsoft', simple: 'microsoft', domain: 'microsoft.com' },
  azure: { lobe: 'azure', simple: 'microsoftazure', domain: 'azure.microsoft.com' },
  aws: { lobe: 'aws', simple: 'amazonaws', domain: 'aws.amazon.com' },
  bedrock: { lobe: 'bedrock', domain: 'aws.amazon.com' },
  nvidia: { lobe: 'nvidia', simple: 'nvidia', domain: 'nvidia.com' },
  deepinfra: { lobe: 'deepinfra', domain: 'deepinfra.com' },
  fireworksai: { lobe: 'fireworks', domain: 'fireworks.ai' },
  cerebras: { lobe: 'cerebras', domain: 'cerebras.ai' },
  sambanova: { lobe: 'sambanova', domain: 'sambanova.ai' },
  hyperbolic: { lobe: 'hyperbolic', domain: 'hyperbolic.xyz' },
  novita: { lobe: 'novita', domain: 'novita.ai' },
  fal: { lobe: 'fal', domain: 'fal.ai' },
  replicate: { lobe: 'replicate', domain: 'replicate.com' },
  midjourney: { lobe: 'midjourney', domain: 'midjourney.com' },
  stability: { lobe: 'stability', domain: 'stability.ai' },
  runway: { lobe: 'runway', domain: 'runwayml.com' },
  luma: { lobe: 'luma', domain: 'lumalabs.ai' },
  kling: { lobe: 'kling', domain: 'klingai.com' },
  pika: { lobe: 'pika', domain: 'pika.art' },
  suno: { lobe: 'suno', domain: 'suno.com' },
  udio: { lobe: 'udio', domain: 'udio.com' },
};

function domainFromSite(site) {
  if (!site) return '';
  try {
    const u = new URL(site.startsWith('http') ? site : `https://${site}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return String(site).replace(/^https?:\/\//, '').split('/')[0];
  }
}

/**
 * Returns ordered candidate URLs for a provider icon.
 */
function hasBrandSvg(meta, key) {
  return !!(meta.lobe || meta.simple);
}

function iconCandidates(id, opts = {}) {
  const key = String(id || '').toLowerCase().trim();
  const meta = PROVIDER_ICON_MAP[key] || {};
  const lobe = meta.lobe || (meta.simple ? null : null);
  // Only use auto lobe slug when explicitly mapped — avoids 404 spam for unknown brands
  const lobeSlug = meta.lobe;
  const simple = meta.simple;
  const domain = meta.domain || domainFromSite(opts.site) || '';
  const fallback = defaultIconDataUri(key, { text: opts.text });

  const urls = [];
  if (lobeSlug) {
    urls.push(LOBE_SVG(lobeSlug));
    urls.push(LOBE_SVG_JSDELIVR(lobeSlug));
    urls.push(LOBE_PNG_DARK(lobeSlug));
  }
  if (simple) urls.push(SIMPLE(simple));
  // Favicons only as secondary (often low-res); default monogram is reliable
  if (domain) {
    urls.push(FAVICON(domain, 128));
    urls.push(DDG(domain));
  }
  urls.push(fallback);
  return Array.from(new Set(urls.filter(Boolean)));
}

/**
 * Primary icon URL.
 * If no Lobe/Simple brand SVG is mapped, use the custom monogram immediately
 * (still lists CDN favicons as onerror fallbacks via iconCandidates).
 */
function resolveIconUrl(id, opts = {}) {
  const key = String(id || '').toLowerCase().trim();
  const meta = PROVIDER_ICON_MAP[key] || {};
  if (meta.lobe || meta.simple) {
    return iconCandidates(id, opts)[0];
  }
  return defaultIconDataUri(key, { text: opts.text });
}

function buildLibraryIcons(providers = []) {
  const out = {};
  const ids = new Set([
    ...Object.keys(PROVIDER_ICON_MAP),
    ...providers.map((p) => p.id),
  ]);
  for (const id of ids) {
    const p = providers.find((x) => x.id === id) || {};
    out[id] = resolveIconUrl(id, { site: p.site, text: p.text || p.name });
  }
  return out;
}

function libraryMeta() {
  return {
    sources: [
      'Lobe Icons SVG (unpkg)',
      'Lobe Icons SVG (jsDelivr)',
      'Lobe Icons PNG dark (unpkg)',
      'Simple Icons CDN',
      'Google S2 Favicons',
      'DuckDuckGo Icons',
    ],
    mapped: Object.keys(PROVIDER_ICON_MAP).length,
    note: 'Local uploads and admin links override library. Unmapped brands use a custom monogram SVG until you upload a real icon.',
  };
}

module.exports = {
  PROVIDER_ICON_MAP,
  iconCandidates,
  resolveIconUrl,
  buildLibraryIcons,
  libraryMeta,
  defaultIconDataUri,
  colorForId,
  LOBE_SVG,
  SIMPLE,
  FAVICON,
};
