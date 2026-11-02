'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config-store');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

config.bootstrap();

function load(name) {
  try {
    return require(name);
  } catch (e) {
    console.error(`[load] ${name}:`, e.message);
    return null;
  }
}

const deepseekProxy = load('./deepseek-proxy');
const kimiProxy = load('./kimi-proxy');
const huggingfaceProxy = load('./huggingface-proxy');
const mistralProxy = load('./mistral-proxy');
const perplexityProxy = load('./perplexity-proxy');
const grokProxy = load('./grok-proxy');
const opencodeProxy = load('./opencode-proxy');
const ucProxy = load('./uc-proxy');
const veoProxy = load('./veo-proxy');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

function routeProxy(model) {
  const m = String(model || '').toLowerCase();

  if ((m.startsWith('kimi') || m.startsWith('moonshot')) && kimiProxy) return kimiProxy;
  if ((m.startsWith('mistral') || m.startsWith('codestral')) && mistralProxy) return mistralProxy;
  if ((m.startsWith('pplx') || m.startsWith('perplexity')) && perplexityProxy) return perplexityProxy;
  if (m.startsWith('grok') && grokProxy) return grokProxy;
  if (m.startsWith('opencode') && opencodeProxy) return opencodeProxy;
  if ((m.startsWith('uc') || m === 'glm-image') && ucProxy) return ucProxy;
  if ((m.startsWith('veo') || m === 'nano-banana') && veoProxy) return veoProxy;

  if (
    huggingfaceProxy &&
    (m.startsWith('hf') ||
      m.startsWith('huggingface') ||
      m === 'omni' ||
      (m.includes('/') && !m.startsWith('myproxy')))
  ) {
    return huggingfaceProxy;
  }

  return deepseekProxy;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function collectModels() {
  const models = [];
  const add = (mod, owner) => {
    if (!mod) return;
    for (const m of mod.MODELS || []) {
      const id = m.slug || m.id || m;
      models.push({ id, object: 'model', created: 0, owned_by: owner });
    }
  };
  add(deepseekProxy, 'deepseek');
  add(kimiProxy, 'kimi');
  add(mistralProxy, 'mistral');
  add(huggingfaceProxy, 'huggingface');
  add(perplexityProxy, 'perplexity');
  add(grokProxy, 'grok');
  add(opencodeProxy, 'opencode');
  add(ucProxy, 'uc');
  add(veoProxy, 'veo');
  return models;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Password',
      });
      return res.end();
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      const html = path.join(PUBLIC, 'admin.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(html));
    }

    if (pathname === '/api/admin/status' && req.method === 'GET') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      return sendJson(res, 200, config.status());
    }

    if (pathname === '/api/admin/config' && req.method === 'POST') {
      const auth = config.checkAdminAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.reason });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const st = config.saveFromAdmin(body);
      return sendJson(res, 200, st);
    }

    if (pathname === '/health' || pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        ...config.getPublicProviders(),
        admin: '/admin',
      });
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, { object: 'list', data: collectModels() });
    }

    if (pathname === '/v1/images/generations' && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try {
        opts = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      if (ucProxy && ucProxy.handleImage) return ucProxy.handleImage(opts, res);
      return sendJson(res, 503, { error: 'image provider unavailable' });
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let opts;
      try {
        opts = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      if (opts.model && String(opts.model).toLowerCase().startsWith('myproxy/')) {
        opts.model = String(opts.model).slice('myproxy/'.length);
      }
      const proxy = routeProxy(opts.model);
      if (!proxy) return sendJson(res, 503, { error: 'no upstream for model' });
      return proxy(opts, res);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[request]', err && err.message ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal' });
    }
  }
});

server.listen(PORT, () => {
  console.log(
    `proxy on ${PORT} · admin /admin · providers: deepseek kimi mistral hf perplexity grok opencode uc veo`
  );
});
