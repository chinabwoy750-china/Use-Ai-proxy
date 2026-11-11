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
