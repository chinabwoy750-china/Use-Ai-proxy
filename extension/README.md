# Use-AI Proxy Capture

Captures **HttpOnly cookies** + tokens from **all web-session providers** and POSTs to:

`POST /api/extension/import`

## Covered (web session)

DeepSeek, Kimi, Perchance T2I, Perplexity, Grok, UC, Hugging Face, Poe, Z.ai, Venice, NoTrack, t3, Arena, ZenMux, Blackbox, Doubao, Yuanbao, AI Studio, v0, Notion, Meta AI, MaxAI, Inner, Adapta, TinyCMS, PromptQL, HyperAgent, Conol, Twinmind, SYNTX, Pollinations

## Not via extension

| Provider | Use instead |
|----------|-------------|
| **Kiro** | Admin → OAuth (Builder ID / Google / GitHub) |
| **API key** (Mistral, OpenRouter, NVIDIA, …) | Admin → Add account → paste key |
| **Veo** | Admin flag `VEO_ENABLED` |

## Install

Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.

## Use

1. Set Proxy URL + Admin password in the popup  
2. Open provider site → log in  
3. **Capture & send**  
4. Check `/admin`
