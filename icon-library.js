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

/** Curated brand accents (id → [hue, sat, light]) for prettier monograms */
const BRAND_HUES = {
  deepseek: [220, 92, 55],
  kimi: [280, 70, 48],
  moonshot: [265, 75, 50],
  perplexity: [188, 78, 42],
  grok: [200, 90, 52],
  xai: [200, 90, 52],
  uc: [270, 85, 52],
  mistral: [42, 95, 52],
  huggingface: [30, 95, 55],
  opencode: [18, 88, 52],
  notrack: [145, 70, 42],
  t3: [265, 80, 58],
  venice: [198, 85, 48],
  poe: [268, 75, 48],
  arena: [24, 95, 52],
  zenmux: [238, 78, 55],
  blackbox: [210, 40, 35],
  doubao: [215, 90, 55],
  zai: [262, 80, 52],
  glm: [255, 70, 50],
  zhipu: [255, 70, 50],
  yuanbao: [145, 75, 42],
  aistudio: [217, 89, 55],
  google: [217, 89, 55],
  gemini: [262, 75, 55],
  v0: [0, 0, 22],
  notion: [0, 0, 18],
  cloudflare: [24, 95, 52],
  longcat: [185, 75, 45],
  promptql: [270, 80, 52],
  hyperagent: [172, 70, 38],
  conol: [330, 75, 48],
  twinmind: [225, 85, 50],
  syntx: [32, 90, 48],
  veo: [4, 85, 52],
  kiro: [16, 95, 55],
  openrouter: [245, 70, 55],
  nvidia: [82, 90, 42],
  ollama: [0, 0, 18],
  agnes: [330, 80, 55],
  pollinations: [38, 95, 52],
  maxai: [38, 92, 52],
  muse: [214, 90, 48],
  meta: [214, 90, 48],
  searxng: [210, 80, 48],
  byteplus: [8, 95, 52],
  'mimo-free': [38, 90, 50],
  'api-airforce': [198, 85, 48],
  'kilo-gateway': [168, 75, 42],
  poolside: [238, 70, 52],
  kimchi: [0, 85, 50],
  nous: [268, 65, 48],
  vertex: [217, 80, 50],
  'gemini-cli': [217, 80, 50],
  'cloudflare-ai': [24, 95, 52],
};

function colorForId(id) {
  const key = String(id || 'x').toLowerCase();
  if (BRAND_HUES[key]) {
    const [hue, sat, light] = BRAND_HUES[key];
    return { hue, sat, light, bg: `hsl(${hue} ${sat}% ${light}%)`, fg: '#ffffff' };
  }
  const s = key;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  // Prefer vivid mid hues (skip muddy browns)
  const hue = (h % 300) + ((h >> 8) % 40);
  const sat = 72 + (h % 18);
  const light = 48 + (h % 10);
  return { hue, sat, light, bg: `hsl(${hue} ${sat}% ${light}%)`, fg: '#ffffff' };
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
 * Premium colorful monogram — multi-stop gradient, glow, gloss, soft shadow.
 */
function defaultIconDataUri(id, opts = {}) {
  const label = initialsFor(id, opts.text);
  const { hue, sat, light, fg } = colorForId(id);
  const c1 = `hsl(${hue} ${Math.min(sat + 8, 98)}% ${Math.min(light + 10, 62)}%)`;
  const c2 = `hsl(${(hue + 18) % 360} ${sat}% ${light}%)`;
  const c3 = `hsl(${(hue + 42) % 360} ${Math.max(sat - 5, 55)}% ${Math.max(light - 12, 28)}%)`;
  const glow = `hsl(${hue} 90% 70%)`;
  const uid = String(id || 'x').replace(/[^a-z0-9]/gi, '') || 'x';
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const fs = safe.length > 2 ? 34 : 46;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<defs>` +
    `<linearGradient id="bg-${uid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/><stop offset="55%" stop-color="${c2}"/><stop offset="100%" stop-color="${c3}"/>` +
    `</linearGradient>` +
    `<radialGradient id="glow-${uid}" cx="30%" cy="25%" r="70%">` +
    `<stop offset="0%" stop-color="#ffffff" stop-opacity=".35"/><stop offset="45%" stop-color="${glow}" stop-opacity=".2"/><stop offset="100%" stop-color="#000" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<linearGradient id="shine-${uid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#fff" stop-opacity=".28"/><stop offset="40%" stop-color="#fff" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<filter id="sh-${uid}" x="-25%" y="-25%" width="150%" height="150%">` +
    `<feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="hsl(${hue} 80% 20%)" flood-opacity=".45"/>` +
    `</filter>` +
    `</defs>` +
    `<rect width="128" height="128" rx="32" fill="#0a0d12"/>` +
    `<rect x="6" y="6" width="116" height="116" rx="28" fill="url(#bg-${uid})" filter="url(#sh-${uid})"/>` +
    `<rect x="6" y="6" width="116" height="116" rx="28" fill="url(#glow-${uid})"/>` +
    `<rect x="6" y="6" width="116" height="58" rx="28" fill="url(#shine-${uid})"/>` +
    `<circle cx="96" cy="28" r="18" fill="#fff" opacity=".08"/>` +
    `<text x="64" y="68" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="${fs}" ` +
    `font-weight="800" fill="${fg}" letter-spacing="-0.05em">${safe}</text>` +
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
  kiro: { domain: 'kiro.dev' },
  openrouter: { lobe: 'openrouter', domain: 'openrouter.ai' },
  nvidia: { lobe: 'nvidia', simple: 'nvidia', domain: 'nvidia.com' },
  ollama: { lobe: 'ollama', domain: 'ollama.com' },
  gemini: { lobe: 'gemini', domain: 'gemini.google.com' },
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
  luma: { domain: 'lumalabs.ai' },
  kling: { domain: 'klingai.com' },
  pika: { lobe: 'pika', domain: 'pika.art' },
  suno: { lobe: 'suno', domain: 'suno.com' },
  udio: { lobe: 'udio', domain: 'udio.com' },
  'api-airforce': { domain: 'api.airforce' },
  agnes: { domain: 'agnes-ai.com' },
  bazaarlink: { domain: 'bazaarlink.com' },
  byteplus: { domain: 'byteplus.com' },
  'cloudflare-ai': { domain: 'dash.cloudflare.com' },
  'kilo-gateway': { domain: 'kilo.ai' },
  kimchi: { domain: 'kimchi.ai' },
  'mimo-free': { domain: 'mimo.ai' },
  nous: { domain: 'nousresearch.com' },
  poolside: { domain: 'poolside.ai' },
  vertex: { domain: 'cloud.google.com' },
  'baidu-search': { lobe: 'baidu', simple: 'baidu', domain: 'baidu.com' },
  'brave-search': { simple: 'brave', domain: 'brave.com' },
  exa: { domain: 'exa.ai' },
  'exa-fetch': { domain: 'exa.ai' },
  firecrawl: { domain: 'firecrawl.dev' },
  'google-pse': { lobe: 'google', simple: 'google', domain: 'google.com' },
  'jina-ai': { domain: 'jina.ai' },
  jina: { domain: 'jina.ai' },
  'jina-reader': { domain: 'jina.ai' },
  linkup: { domain: 'linkup.so' },
  'ollama-search': { lobe: 'ollama', domain: 'ollama.com' },
  'perplexity-search': { lobe: 'perplexity', simple: 'perplexity', domain: 'perplexity.ai' },
  searxng: { domain: 'searxng.org' },
  searchapi: { domain: 'searchapi.io' },
  serper: { domain: 'serper.dev' },
  tavily: { domain: 'tavily.com' },
  'tavily-fetch': { domain: 'tavily.com' },
  tinyfish: { domain: 'tinyfish.ai' },
  xquik: { domain: 'x.com' },
  youcom: { domain: 'you.com' },
  'black-forest-labs': { domain: 'blackforestlabs.ai' },
  'cloudflare-image': { lobe: 'cloudflare', simple: 'cloudflare', domain: 'cloudflare.com' },
  comfyui: { domain: 'comfy.org' },
  'fal-ai': { domain: 'fal.ai' },
  'gemini-image': { lobe: 'gemini', domain: 'gemini.google.com' },
  'huggingface-image': { lobe: 'huggingface', simple: 'huggingface', domain: 'huggingface.co' },
  nanobanana: { domain: 'nanobanana.ai' },
  'openai-image': { lobe: 'openai', simple: 'openai', domain: 'openai.com' },
  perchance: { domain: 'perchance.org' },
  'pollinations-image': { domain: 'pollinations.ai' },
  recraft: { domain: 'recraft.ai' },
  'runway-image': { domain: 'runwayml.com' },
  sdwebui: { domain: 'github.com' },
  'siliconflow-image': { domain: 'siliconflow.cn' },
  'stability-ai': { lobe: 'stability', domain: 'stability.ai' },
  'together-image': { lobe: 'together', domain: 'together.ai' },
  topaz: { domain: 'topazlabs.com' },
  'venice-image': { domain: 'venice.ai' },
  'xai-image': { lobe: 'xai', domain: 'x.ai' },
  'agnes-video': { domain: 'agnes-ai.com' },
  hailuo: { domain: 'minimaxi.com' },
  'pollinations-video': { domain: 'pollinations.ai' },
  runwayml: { domain: 'runwayml.com' },
  'veoaifree-web': { lobe: 'google', domain: 'deepmind.google' },
  'vertex-video': { lobe: 'googlecloud', domain: 'cloud.google.com' },
  'xai-video': { lobe: 'xai', domain: 'x.ai' },
  'aws-polly': { lobe: 'amazonaws', simple: 'amazonaws', domain: 'aws.amazon.com' },
  assemblyai: { domain: 'assemblyai.com' },
  cartesia: { domain: 'cartesia.ai' },
  coqui: { domain: 'github.com' },
  deepgram: { domain: 'deepgram.com' },
  'edge-tts': { simple: 'microsoft', domain: 'microsoft.com' },
  elevenlabs: { domain: 'elevenlabs.io' },
  'fish-audio': { domain: 'fish.audio' },
  'gemini-tts': { lobe: 'gemini', domain: 'ai.google.dev' },
  'google-tts': { lobe: 'google', simple: 'google', domain: 'google.com' },
  'groq-stt': { lobe: 'groq', domain: 'groq.com' },
  'huggingface-stt': { lobe: 'huggingface', simple: 'huggingface', domain: 'huggingface.co' },
  inworld: { domain: 'inworld.ai' },
  'minimax-tts': { domain: 'minimaxi.com' },
  'ollama-tts': { lobe: 'ollama', domain: 'ollama.com' },
  'openai-audio': { lobe: 'openai', simple: 'openai', domain: 'openai.com' },
  playht: { domain: 'play.ht' },
  'selfhosted-stt': { domain: 'github.com' },
  'selfhosted-tts': { domain: 'github.com' },
  tortoise: { domain: 'github.com' },
  'xiaomi-mimo-tts': { simple: 'xiaomi', domain: 'xiaomi.com' },
  'devin-cli': { domain: 'devin.ai' },
  'gemini-cli': { lobe: 'gemini', domain: 'ai.google.dev' },
  'local-device': { domain: 'localhost' },
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
  // Prefer explicit map; otherwise try id / base id as Lobe + Simple slug
  const base = key.replace(/-(web|image|video|tts|stt|search|fetch|audio|cli|api)$/g, '');
  const lobeSlug = meta.lobe || null;
  const guessedLobe = meta.lobe || meta.simple || null;
  // Auto-try slug forms for unmapped providers (library first; 404 falls through onerror)
  const autoSlugs = [];
  if (!meta.lobe && !meta.simple) {
    autoSlugs.push(key, base, key.replace(/-/g, ''), base.replace(/-/g, ''));
  }
  const simple = meta.simple || null;
  const domain = meta.domain || domainFromSite(opts.site) || '';
  const fallback = defaultIconDataUri(key, { text: opts.text });

  const urls = [];
  const pushLobe = (slug) => {
    if (!slug) return;
    urls.push(LOBE_PNG_DARK(slug));
    urls.push(LOBE_SVG(slug));
    urls.push(LOBE_SVG_JSDELIVR(slug));
  };
  if (lobeSlug) pushLobe(lobeSlug);
  for (const s of autoSlugs) pushLobe(s);
  if (simple) urls.push(SIMPLE(simple));
  for (const s of autoSlugs) urls.push(SIMPLE(s));
  if (domain) {
    urls.push(FAVICON(domain, 128));
    urls.push(DDG(domain));
  }
  // Always end with monogram when nothing in the library loads
  urls.push(fallback);
  return Array.from(new Set(urls.filter(Boolean)));
}

/**
 * Primary icon URL.
 * If no Lobe/Simple brand SVG is mapped, use the custom monogram immediately
 * (still lists CDN favicons as onerror fallbacks via iconCandidates).
 */
function resolveIconUrl(id, opts = {}) {
  // Always use the library chain (Lobe / Simple / favicon). Monogram is last candidate only.
  const candidates = iconCandidates(id, opts);
  return candidates[0] || defaultIconDataUri(String(id || '').toLowerCase(), { text: opts.text });
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
    note: 'Every provider uses the icon library (Lobe → Simple Icons → site favicon). Monogram only if none load. Uploads/links still override.',
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
