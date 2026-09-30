# Use AI Proxy

OpenAI-compatible proxy for [use.ai](https://use.ai).

## Endpoints

- `GET /health` — pool stats
- `GET /v1/models` — model list
- `POST /v1/chat/completions` — chat (SSE stream)

## Run locally

```bash
npm install
npm start
```

## Render

1. New Web Service → connect this repo
2. Build: `npm install`
3. Start: `npm start`
4. Free tier is fine for testing (cold starts + sleep after idle)

Point clients at `https://YOUR-SERVICE.onrender.com/v1`.

## Proxies

Residential/mobile SOCKS recommended. Seed `working_proxies.txt` next to the code if you have a validated list. Free scraped lists often fail WebSocket (403).
