'use strict';
const http = require('http');
const useaiProxy = require('./useai-proxy');

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
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
    return res.end(JSON.stringify({ ok: true, pool: useaiProxy.getPoolStats?.() || {} }));
  }

  if (req.url === '/v1/models' && req.method === 'GET') {
    const models = (useaiProxy.MODELS || []).map(m => ({
      id: m.slug,
      object: 'model',
      created: 0,
      owned_by: 'useai',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: models }));
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let opts;
    try {
      opts = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json' }));
    }
    return useaiProxy(opts, res);
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`useai-proxy listening on ${PORT}`));
