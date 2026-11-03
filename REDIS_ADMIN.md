# Admin password + Upstash Redis

## 1. Admin password (required for `/admin`)

In **Render → your service → Environment** add:

```
ADMIN_PASSWORD=choose-a-long-secret
```

Redeploy once. Open `https://YOUR-APP.onrender.com/admin` and log in with that password.

You can also save `ADMIN_PASSWORD` from the admin UI after Redis works (stored in Redis for next boots). **Keep the same value in Render env** as a backup so you can always log in if Redis is empty.

## 2. Upstash Redis (survive redeploys)

1. Create a free DB at https://upstash.com → Redis
2. Open the database → **REST API**
3. Copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**
4. In Render Environment set:

```
UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxxxx
```

Optional:

```
CONFIG_REDIS_KEY=useai-proxy:config
```

5. Redeploy. Logs should show: `loaded N keys from Upstash Redis` or `Upstash configured but empty`.
6. Open `/admin`, paste provider cookies/tokens, **Save**.  
   Response meta should include `savedToRedis: true`.

On the next deploy, secrets are loaded from Redis automatically (disk on Render free is wiped; Redis is not).

## Priority

1. Values in Redis (after first admin save)
2. Local `data/config.json` (dev only)
3. Render Environment variables

## Security

- Never commit REST tokens or `ADMIN_PASSWORD`
- Only put Upstash + admin password in Render env; put long provider cookies in admin → Redis
