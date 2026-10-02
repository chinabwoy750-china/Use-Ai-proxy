'use strict';
const http = require('http');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

function load(name) {
  try { return require(name); } catch (e) {
    console.error(`[load] ${name}:`, e.message);
    return null;
  }
}

const deepseekProxy = load('./deepseek-proxy');
const qwenProxy = load('./qwen-proxy');
const kimiProxy = load('./kimi-proxy');
const glmProxy = load('./glm-proxy');

const PORT = process.env.PORT || 3000;

function routeProxy(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('qwen') && qwenProxy) return qwenProxy;
  if ((m.startsWith('kimi') || m.startsWith('moonshot')) && kimiProxy) return kimiProxy;
  if ((m.startsWith('glm') || m.startsWith('chatglm')) && glmProxy) return glmProxy;
  return deepseekProxy;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        deepseek: !!(process.env.DEEPSEEK_COOKIE && process.env.DEEPSEEK_TOKEN),
        qwen: !!(process.env.QWEN_TOKEN || process.env.QWEN_COOKIE),
        kimi: !!process.env.KIMI_TOKEN,
        glm: !!process.env.GLM_TOKEN,
      }));
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      const models = [];
      const add = (mod, owner) => {
        if (!mod) return;
        for (const m of (mod.MODELS || [])) {
          models.push({ id: m.slug, object: 'model', created: 0, owned_by: owner });
        }
      };
      add(deepseekProxy, 'deepseek');
      add(qwenProxy, 'qwen');
      add(kimiProxy, 'kimi');
      add(glmProxy, 'glm');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models }));
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let opts;
      try { opts = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'bad json' }));
      }
      const proxy = routeProxy(opts.model);
      if (!proxy) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no upstream for model' }));
      }
      return proxy(opts, res);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[request]', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  }
});

server.listen(PORT, () => console.log(`proxy on ${PORT} (deepseek/qwen/kimi/glm)`));
