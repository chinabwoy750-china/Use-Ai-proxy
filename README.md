# DeepSeek OpenAI-compatible proxy

Replaces the use.ai upstream (CF-blocked) with DeepSeek web chat + PoW.

## Required env

From a logged-in browser session on https://chat.deepseek.com :

```bash
export DEEPSEEK_URL=https://chat.deepseek.com
export DEEPSEEK_TOKEN='...'      # Authorization Bearer token
export DEEPSEEK_COOKIE='...'     # full Cookie header
```

### How to grab them

1. Open https://chat.deepseek.com and sign in
2. DevTools → Network → any `api/v0` request
3. Copy `Authorization: Bearer ...` → `DEEPSEEK_TOKEN`
4. Copy the full `Cookie` request header → `DEEPSEEK_COOKIE`

## Run

```bash
npm start
# or
DEEPSEEK_TOKEN=... DEEPSEEK_COOKIE=... npm start
```

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Say pong"}],"stream":true}'
```

Models: `deepseek-chat`, `deepseek-expert`, `deepseek-reasoner`

## Qwen (chat.qwen.ai)

Env:

```bash
export QWEN_TOKEN='...'    # localStorage.token on chat.qwen.ai
export QWEN_COOKIE='...'   # full Cookie header from any api request
```

Browser console on https://chat.qwen.ai:

```js
(async () => {
  const token = localStorage.getItem('token') || '';
  const cookie = document.cookie;
  const out = `export QWEN_TOKEN='${token}'\nexport QWEN_COOKIE='${cookie}'`;
  console.log({ token: token.slice(0, 20) + '...', cookieLen: cookie.length });
  try { await navigator.clipboard.writeText(out); console.log('Copied exports'); } catch {}
  return out;
})();
```

**Important:** paste **full Cookie** from Network tab if `document.cookie` is incomplete (need `ssxmod_itna`, `cna`, etc. for WAF).

Models: `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3-coder-plus`, …
Routing: model names starting with `qwen` go to Qwen; others to DeepSeek.
