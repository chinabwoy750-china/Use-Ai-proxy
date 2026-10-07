# Use-Ai-proxy

OpenAI-compatible multi-upstream proxy:

- **DeepSeek** — `chat.deepseek.com` (cookie + token + PoW)
- **Kimi** — `www.kimi.ai` (access / refresh token)
- **HuggingFace Chat** — `huggingface.co/chat` (`hf-chat` cookie)
- **Mistral Le Chat** — `chat.mistral.ai` (cookie) or official `MISTRAL_API_KEY`

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` (SSE)

## Env

### DeepSeek
- `DEEPSEEK_URL` (default `https://chat.deepseek.com`)
- `DEEPSEEK_TOKEN`
- `DEEPSEEK_COOKIE`

### Kimi
- `KIMI_URL` (default `https://www.kimi.ai`)
- `KIMI_TOKEN` and/or `KIMI_REFRESH_TOKEN`

### HuggingFace Chat
- `HF_CHAT_COOKIE` — value of the `hf-chat` cookie from a logged-in browser (or full `Cookie` header containing `hf-chat=...`)
- `HF_CHAT_MODEL` — optional default model id (default `omni`)

## Models (examples)

| model | upstream |
|-------|----------|
| `deepseek` / `deepseek-chat` | DeepSeek |
| `kimi` / `kimi-search` | Kimi |
| `huggingface` / `hf` / `omni` | HF Chat |
| `hf-qwen` / `hf-deepseek` / `hf-glm` | HF Chat shortcuts |

## Run

```bash
npm start
```

## Cookie helper (HF)

On https://huggingface.co/chat (logged in), DevTools Console:

```js
copy(document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('hf-chat='))?.split('=').slice(1).join('=')||'')
```

Then set `HF_CHAT_COOKIE` to that value.


### Mistral
- `MISTRAL_COOKIE` or `MISTRAL_COOKIE_HEADER` — `mistral-chat-session` from chat.mistral.ai (web)
- `MISTRAL_API_KEY` — optional official API (preferred on Render; avoids Cloudflare)
- Models: `mistral`, `mistral-large`, `mistral-small`, `codestral`

Cookie helper (on https://chat.mistral.ai, logged in):

```js
(function () {
  const raw = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('mistral-chat-session='));
  const val = raw ? raw.slice('mistral-chat-session='.length) : document.cookie;
  console.log(val);
  try { copy(val); } catch (_) {}
})();
```
