'use strict';
const http = require('http');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

const deepseekProxy = require('./deepseek-proxy');
let qwenProxy = null;
try { qwenProxy = require('./qwen-proxy'); } catch (e) {
  console.error('[qwen] load failed', e.message);
}

const PORT = process.env.PORT || 3000;

function isQwenModel(model) {
  return /^qwen/i.test(String(model || ''));
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
      }));
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      const models = [];
      for (const m of (deepseekProxy.MODELS || [])) {
        models.push({ id: m.slug, object: 'model', created: 0, owned_by: 'deepseek' });
      }
      if (qwenProxy) {
        for (const m of (qwenProxy.MODELS || [])) {
          models.push({ id: m.slug, object: 'model', created: 0, owned_by: 'qwen' });
        }
      }
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

      if (isQwenModel(opts.model) && qwenProxy) {
        return qwenProxy(opts, res);
      }
      return deepseekProxy(opts, res);
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

server.listen(PORT, () => console.log(`proxy listening on ${PORT} (deepseek + qwen)`));
