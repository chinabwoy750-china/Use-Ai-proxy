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
