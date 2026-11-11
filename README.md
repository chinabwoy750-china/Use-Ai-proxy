# Use-AI Proxy

OpenAI-compatible multi-provider reverse proxy with admin dashboard.

## Providers

| Model prefix | Provider | Credential env |
|--------------|----------|----------------|
| `deepseek-*` (default) | DeepSeek Web | `DEEPSEEK_TOKEN`, `DEEPSEEK_COOKIE` |
| `kimi*` | Kimi | `KIMI_TOKEN`, `KIMI_REFRESH_TOKEN` |
| `perplexity`, `pplx-*` | Perplexity Web | `PERPLEXITY_COOKIE` |
| `grok*` | Grok Web | `GROK_COOKIE` |
| `opencode*` | OpenCode Free | `OPENCODE_ENABLED=1` (no key) |
| `uc*` | UC Web (image) | `UC_COOKIE` (must include `__client`) |
| `veo*` | Veo Free | `VEO_ENABLED=1` |
| `codestral*`, `mistral*` | Mistral | `MISTRAL_API_KEY` |
| `hf*`, `omni` | Hugging Face | `HF_CHAT_COOKIE` |

## Endpoints

- `GET /health`
- `GET /v1/models` — only providers that currently have credentials (or are keyless-enabled)
- `GET /v1/models?all=1` — full catalog, including unconfigured providers
- `POST /v1/chat/completions`
- `POST /v1/images/generations` (UC)
- `GET /admin` — dashboard (requires `ADMIN_PASSWORD`)

## Admin

Set `ADMIN_PASSWORD` on the host, open `/admin`, log in, paste cookies/tokens per provider.

On **Render free**, disk is ephemeral — also set the same values as **Environment** variables so they survive restarts. Admin “Save” applies **live** to the running process.

## Grok models

Slugs map to the real model ids / modes used by grok.com (taken from its live client
bundle, `chat-page-store: modelModeToModelConfigModelMode`):

| Slug | grok.com id | Mode | Notes |
|------|-------------|------|-------|
| `grok`, `grok-fast` | `grok-3` | `MODEL_MODE_FAST` | default, free-friendly |
| `grok-auto` | `grok-4-auto` | `MODEL_MODE_AUTO` | |
| `grok-expert` | `grok-4` | `MODEL_MODE_EXPERT` | |
| `grok-heavy` | `grok-4-heavy` | `MODEL_MODE_HEAVY` | SuperGrok |
| `grok-4-1` | `grok-4-1` | `MODEL_MODE_GROK_4_1` | |
| `grok-4-1-thinking` | `grok-4-1-thinking` | `MODEL_MODE_GROK_4_1_THINKING` | SuperGrok |
| `grok-4-1-nightly` | `grok-4-1-nightly` | `MODEL_MODE_GROK_4_1_NIGHTLY` | |
| `grok-4-mini-thinking` | `grok-4-mini-thinking` | `MODEL_MODE_GROK_4_MINI_THINKING` | |
| `grok-420` | `grok-420` | `MODEL_MODE_GROK_420` | Grok 4.20 |
| `grok-43` | `grok-43` | `MODEL_MODE_GROK43` | Grok 4.3 |

Aliases: `grok-4`, `grok-3`, `grok-2`, `grok-4.1`, `grok-4.20`, `grok-4.3`, `grok-4-thinking`.

**429 "Too many requests"** means the account hit its Grok Web quota (free accounts get a
small window; premium modes need SuperGrok). The proxy retries once, rotates through
`GROK_COOKIES` / Admin accounts, and returns HTTP 429 with `Retry-After`.

| Env | Default | Meaning |
|-----|---------|---------|
| `GROK_COOKIES` | — | Several cookies separated by `\|\|\|` (cookies contain commas) |
| `GROK_RETRIES` | `1` | Retries per cookie before rotating |
| `GROK_COOLDOWN_MS` | `300000` | How long a rate-limited cookie is skipped |

## Run

```bash
export ADMIN_PASSWORD='change-me'
export DEEPSEEK_TOKEN='...'
# ...
npm start
```

## Notes

- **Grok**: Cloudflare may block datacenter IPs; paste full Cookie including `cf_clearance`.
- **OpenCode Free**: may return 403 without browser TLS fingerprint.
- **UC**: `__client` is HttpOnly — copy from DevTools Application → Cookies, not `document.cookie`.
