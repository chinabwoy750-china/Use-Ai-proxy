# Use-AI Proxy Capture (browser extension)

Captures **logged-in cookies** (including **HttpOnly**) and tokens from provider sites, then POSTs them to your proxy:

`POST /api/extension/import`

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Pin the extension

## Use

1. Click the extension → set **Proxy URL** (`https://myproxy-use.onrender.com`) and **Admin password**
2. Open a provider site and **log in** (DeepSeek, Kimi, Perplexity, …)
3. Click **Capture & send**
4. Check `/admin` — a new account should appear under that provider

## Firefox

`about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`

## Security

- Password is stored in `chrome.storage.sync` on your browser only
- Only send to **your** proxy URL
- Extension needs cookie access to read HttpOnly session cookies
