'use strict';
/**
 * Unified web search / web fetch / image / video endpoints
 * Inspired by 9Router + OmniRoute model IDs and shapes.
 *
 * Endpoints (wired in server.js):
 *   POST /v1/search          (alias /v1/web/search)
 *   POST /v1/web/fetch
 *   POST /v1/images/generations  (extra free backends)
 *   POST /v1/videos/generations
 *   GET  /v1/models/web
 *   GET  /v1/models/image
 *   GET  /v1/models/video
 */

function envKey(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    for (const k of keys) {
      for (const id of Object.keys(all)) {
        const accounts = (all[id] && all[id].accounts) || [];
        for (const a of accounts) {
          const vals = (a && a.values) || {};
          if (vals[k]) return String(vals[k]).trim();
          if (a.key && (id === k.toLowerCase() || id.includes(k.split('_')[0].toLowerCase()))) {
            return String(a.key).trim();
          }
        }
      }
    }
  } catch (_) {}
  return '';
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

/* ---------- catalog (9router / OmniRoute style ids) ---------- */

const SEARCH_MODELS = [
  { id: 'searxng/search', kind: 'webSearch', provider: 'searxng', auth: 'none', label: 'SearXNG (public / self-host)' },
  { id: 'duckduckgo/search', kind: 'webSearch', provider: 'duckduckgo', auth: 'none', label: 'DuckDuckGo HTML' },
  { id: 'brave-search/search', kind: 'webSearch', provider: 'brave', auth: 'apiKey', label: 'Brave Search' },
  { id: 'tavily/search', kind: 'webSearch', provider: 'tavily', auth: 'apiKey', label: 'Tavily Search' },
  { id: 'serper/search', kind: 'webSearch', provider: 'serper', auth: 'apiKey', label: 'Serper (Google)' },
  { id: 'exa/search', kind: 'webSearch', provider: 'exa', auth: 'apiKey', label: 'Exa Search' },
  { id: 'google-pse/search', kind: 'webSearch', provider: 'google-pse', auth: 'apiKey', label: 'Google Programmable Search' },
  { id: 'youcom/search', kind: 'webSearch', provider: 'youcom', auth: 'apiKey', label: 'You.com' },
  { id: 'searchapi/search', kind: 'webSearch', provider: 'searchapi', auth: 'apiKey', label: 'SearchAPI' },
  { id: 'linkup/search', kind: 'webSearch', provider: 'linkup', auth: 'apiKey', label: 'Linkup' },
  { id: 'perplexity/search', kind: 'webSearch', provider: 'perplexity', auth: 'apiKey', label: 'Perplexity Search API' },
];

const FETCH_MODELS = [
  { id: 'jina/reader', kind: 'webFetch', provider: 'jina', auth: 'optional', label: 'Jina Reader (free tier)' },
  { id: 'firecrawl/scrape', kind: 'webFetch', provider: 'firecrawl', auth: 'apiKey', label: 'Firecrawl' },
  { id: 'tavily/extract', kind: 'webFetch', provider: 'tavily', auth: 'apiKey', label: 'Tavily Extract' },
  { id: 'exa/contents', kind: 'webFetch', provider: 'exa', auth: 'apiKey', label: 'Exa Contents' },
  { id: 'direct/fetch', kind: 'webFetch', provider: 'direct', auth: 'none', label: 'Direct HTTP fetch' },
];

const IMAGE_MODELS = [
  { id: 'pollinations/image', kind: 'image', provider: 'pollinations', auth: 'none', label: 'Pollinations Image (free)' },
  { id: 'perchance', kind: 'image', provider: 'perchance', auth: 'session', label: 'Perchance T2I' },
  { id: 'flux/schnell', kind: 'image', provider: 'pollinations', auth: 'none', label: 'Flux via Pollinations' },
  { id: 'fal/flux', kind: 'image', provider: 'fal', auth: 'apiKey', label: 'Fal.ai FLUX' },
  { id: 'openai/dall-e-3', kind: 'image', provider: 'openai', auth: 'apiKey', label: 'OpenAI DALL·E 3' },
  { id: 'stability/sd3', kind: 'image', provider: 'stability', auth: 'apiKey', label: 'Stability SD3' },
];

const VIDEO_MODELS = [
  { id: 'pollinations/video', kind: 'video', provider: 'pollinations', auth: 'none', label: 'Pollinations Video (experimental)' },
  { id: 'veo', kind: 'video', provider: 'veo', auth: 'session', label: 'Veo free web' },
  { id: 'xai/grok-imagine-video', kind: 'video', provider: 'xai', auth: 'apiKey', label: 'xAI Grok Imagine Video' },
  { id: 'fal/video', kind: 'video', provider: 'fal', auth: 'apiKey', label: 'Fal.ai Video' },
  { id: 'runway/gen3', kind: 'video', provider: 'runway', auth: 'apiKey', label: 'Runway Gen-3' },
];

/* ---------- helpers ---------- */

function pickProvider(model, list) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return list.find((x) => x.auth === 'none') || list[0];
  return (
    list.find((x) => x.id === m) ||
    list.find((x) => x.id.endsWith('/' + m) || x.id.startsWith(m + '/')) ||
    list.find((x) => x.provider === m) ||
    list.find((x) => m.includes(x.provider)) ||
    list[0]
  );
}

const SEARX_INSTANCES = (
  process.env.SEARXNG_URLS ||
  process.env.SEARXNG_URL ||
  [
    'https://searx.be',
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.bus-hit.me',
  ].join(',')
)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

async function searchSearxng(query, maxResults) {
  const errors = [];
  for (const base of SEARX_INSTANCES) {
    try {
      const url =
        `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en`;
      const r = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'useai-proxy/1.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        errors.push(base + ' ' + r.status);
        continue;
      }
      const j = await r.json();
      const results = (j.results || []).slice(0, maxResults).map((x) => ({
        title: x.title || '',
        url: x.url || x.href || '',
        content: x.content || x.snippet || '',
        engine: x.engine || 'searxng',
      }));
      if (results.length) return { provider: 'searxng', instance: base, results };
    } catch (e) {
      errors.push(base + ' ' + (e.message || e));
    }
  }
  throw new Error('SearXNG all instances failed: ' + errors.slice(0, 3).join('; '));
}

async function searchDuckDuckGo(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  });
  const html = await r.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < maxResults) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    let href = m[1];
    // ddg redirect
    const um = href.match(/uddg=([^&]+)/);
    if (um) href = decodeURIComponent(um[1]);
    results.push({ title, url: href, content: '', engine: 'duckduckgo' });
  }
  return { provider: 'duckduckgo', results };
}

async function searchBrave(query, maxResults) {
  const key = envKey('BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY');
  if (!key) throw new Error('BRAVE_API_KEY required');
  const r = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': key } }
  );
  const j = await r.json();
  if (!r.ok) throw new Error('Brave ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  const results = ((j.web && j.web.results) || []).map((x) => ({
    title: x.title,
    url: x.url,
    content: x.description || '',
    engine: 'brave',
  }));
  return { provider: 'brave', results };
}

async function searchTavily(query, maxResults) {
  const key = envKey('TAVILY_API_KEY');
  if (!key) throw new Error('TAVILY_API_KEY required');
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, include_answer: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Tavily ' + r.status);
  return {
    provider: 'tavily',
    answer: j.answer || '',
    results: (j.results || []).map((x) => ({
      title: x.title,
      url: x.url,
      content: x.content || '',
      engine: 'tavily',
    })),
  };
}

async function searchSerper(query, maxResults) {
  const key = envKey('SERPER_API_KEY');
  if (!key) throw new Error('SERPER_API_KEY required');
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: maxResults }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Serper ' + r.status);
  return {
    provider: 'serper',
    results: (j.organic || []).map((x) => ({
      title: x.title,
      url: x.link,
      content: x.snippet || '',
      engine: 'serper',
    })),
  };
}

async function searchExa(query, maxResults) {
  const key = envKey('EXA_API_KEY');
  if (!key) throw new Error('EXA_API_KEY required');
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, num_results: maxResults, type: 'auto' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Exa ' + r.status);
  return {
    provider: 'exa',
    results: (j.results || []).map((x) => ({
      title: x.title,
      url: x.url,
      content: x.text || x.summary || '',
      engine: 'exa',
    })),
  };
}

async function handleSearch(opts, res) {
  const query = String(opts.query || opts.q || '').trim();
  if (!query) return sendJson(res, 400, { error: { message: 'query required' } });
  const maxResults = Math.min(Math.max(parseInt(opts.max_results || opts.maxResults || '8', 10) || 8, 1), 20);
  const meta = pickProvider(opts.model || opts.provider, SEARCH_MODELS);
  const order = [];
  // preferred first, then free fallbacks
  order.push(meta.provider);
  for (const p of ['searxng', 'duckduckgo', 'brave', 'tavily', 'serper', 'exa']) {
    if (!order.includes(p)) order.push(p);
  }

  const errors = [];
  for (const p of order) {
    try {
      let out;
      if (p === 'searxng') out = await searchSearxng(query, maxResults);
      else if (p === 'duckduckgo') out = await searchDuckDuckGo(query, maxResults);
      else if (p === 'brave') out = await searchBrave(query, maxResults);
      else if (p === 'tavily') out = await searchTavily(query, maxResults);
      else if (p === 'serper') out = await searchSerper(query, maxResults);
      else if (p === 'exa') out = await searchExa(query, maxResults);
      else continue;
      return sendJson(res, 200, {
        object: 'web.search',
        model: meta.id,
        provider: out.provider,
        query,
        answer: out.answer || null,
        results: out.results,
        errors,
      });
    } catch (e) {
      errors.push({ provider: p, error: e.message || String(e) });
    }
  }
  return sendJson(res, 502, { error: { message: 'All search providers failed', errors } });
}

/* ---------- fetch ---------- */

async function fetchJina(url, format) {
  const key = envKey('JINA_API_KEY');
  const endpoint = `https://r.jina.ai/${url}`;
  const headers = {
    Accept: format === 'html' ? 'text/html' : 'text/markdown',
    'User-Agent': 'useai-proxy/1.0',
  };
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error('Jina ' + r.status + ': ' + text.slice(0, 120));
  return { url, title: '', markdown: text, provider: 'jina' };
}

async function fetchFirecrawl(url) {
  const key = envKey('FIRECRAWL_API_KEY');
  if (!key) throw new Error('FIRECRAWL_API_KEY required');
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown', 'html'] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Firecrawl ' + r.status);
  const data = j.data || j;
  return {
    url,
    title: data.metadata?.title || '',
    markdown: data.markdown || '',
    html: data.html || '',
    provider: 'firecrawl',
  };
}

async function fetchDirect(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; useai-proxy/1.0; +https://github.com/chinabwoy750-china/Use-Ai-proxy)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const html = await r.text();
  if (!r.ok) throw new Error('Direct fetch ' + r.status);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';
  // crude strip
  const markdown = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000);
  return { url, title, markdown, html: html.slice(0, 200000), provider: 'direct' };
}

async function handleFetch(opts, res) {
  const target = String(opts.url || opts.target || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return sendJson(res, 400, { error: { message: 'url must start with http(s)://' } });
  }
  const format = String(opts.format || 'markdown').toLowerCase();
  const meta = pickProvider(opts.model || opts.provider, FETCH_MODELS);
  const order = [meta.provider, 'jina', 'direct', 'firecrawl'];
  const seen = new Set();
  const errors = [];
  for (const p of order) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      let out;
      if (p === 'jina') out = await fetchJina(target, format);
      else if (p === 'firecrawl') out = await fetchFirecrawl(target);
      else if (p === 'direct') out = await fetchDirect(target);
      else continue;
      return sendJson(res, 200, {
        object: 'web.fetch',
        model: meta.id,
        ...out,
        format,
        errors,
      });
    } catch (e) {
      errors.push({ provider: p, error: e.message || String(e) });
    }
  }
  return sendJson(res, 502, { error: { message: 'All fetch providers failed', errors } });
}

/* ---------- images (free pollinations) ---------- */

async function handlePollinationsImage(opts, res) {
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return sendJson(res, 400, { error: { message: 'prompt required' } });
  const size = String(opts.size || '1024x1024');
  const [w, h] = size.split('x').map((n) => parseInt(n, 10) || 1024);
  const seed = opts.seed != null ? Number(opts.seed) : Math.floor(Math.random() * 1e9);
  const model = /flux/i.test(String(opts.model || '')) ? 'flux' : 'flux';
  const imgUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&enhance=true`;

  const fmt = String(opts.response_format || 'url').toLowerCase();
  if (fmt === 'url') {
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: imgUrl, revised_prompt: prompt }],
    });
  }
  const r = await fetch(imgUrl, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) {
    return sendJson(res, 502, { error: { message: 'Pollinations image ' + r.status } });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: buf.toString('base64'), revised_prompt: prompt }],
  });
}

/* ---------- video ---------- */

async function handleVideo(opts, res) {
  const prompt = String(opts.prompt || opts.input || '').trim();
  if (!prompt) return sendJson(res, 400, { error: { message: 'prompt required' } });
  const meta = pickProvider(opts.model || opts.provider, VIDEO_MODELS);

  if (meta.provider === 'pollinations' || meta.id.includes('pollinations')) {
    // Pollinations experimental video endpoint pattern
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?model=veo&nologo=true`;
    return sendJson(res, 200, {
      object: 'video.generation',
      model: meta.id,
      status: 'completed',
      data: [
        {
          url,
          note: 'Pollinations video URLs are experimental; may return image if video model unavailable',
        },
      ],
    });
  }

  if (meta.provider === 'xai') {
    const key = envKey('XAI_API_KEY', 'GROK_API_KEY');
    if (!key) {
      return sendJson(res, 503, {
        error: {
          message: 'XAI_API_KEY required for grok-imagine-video',
          type: 'missing_api_key',
        },
      });
    }
    return sendJson(res, 501, {
      error: {
        message: 'xAI video generation requires official video API access — configure key and use xAI docs endpoint',
      },
    });
  }

  if (meta.provider === 'veo') {
    return sendJson(res, 501, {
      error: {
        message: 'Use chat model "veo" / images path for Veo free web, or configure VEOTOKEN in Admin',
      },
    });
  }

  return sendJson(res, 503, {
    error: {
      message: `Video provider ${meta.provider} needs API key in Admin`,
      model: meta.id,
    },
  });
}

function listModels(kind) {
  if (kind === 'web' || kind === 'search') {
    return { object: 'list', data: [...SEARCH_MODELS, ...FETCH_MODELS] };
  }
  if (kind === 'image') return { object: 'list', data: IMAGE_MODELS };
  if (kind === 'video') return { object: 'list', data: VIDEO_MODELS };
  return {
    object: 'list',
    data: [...SEARCH_MODELS, ...FETCH_MODELS, ...IMAGE_MODELS, ...VIDEO_MODELS],
  };
}

module.exports = {
  handleSearch,
  handleFetch,
  handlePollinationsImage,
  handleVideo,
  listModels,
  SEARCH_MODELS,
  FETCH_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  pickProvider,
};
