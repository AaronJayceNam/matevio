# Cloudflare + Render — kill the "server waking up" message

Render's free tier sleeps after ~15 min idle, so the next visitor waits ~45s
("서버 깨우는 중…"). GitHub Actions' cron is throttled to ~hourly and can't keep
it awake. **Cloudflare Cron Triggers fire reliably**, so we use Cloudflare to
keep Render warm (and, optionally, to serve the frontend instantly from its
global edge). Render still runs the backend (FastAPI + Stockfish + WebSocket).

## Option A — Keep-alive Worker (do this first; ~2 min, removes the message)

Pings `https://matevio.com/api/health` every 5 minutes so Render never sleeps.

**Dashboard way (no tools):**
1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Create Worker**. Name it `matevio-keepalive`, Deploy.
2. **Edit code** → paste the contents of `keepalive-worker.js` → Deploy.
3. Worker → **Settings → Triggers → Cron Triggers → Add** → `*/5 * * * *` → Save.
4. (Optional) **Settings → Variables → Add variable** `PING_URL = https://matevio.com/api/health`.
5. Open the Worker's `*.workers.dev` URL once — it should print `pinged … -> 200`.

**CLI way:**
```bash
cd cloudflare
npx wrangler login
npx wrangler deploy
```

That alone keeps the backend awake → the "waking up" banner (which only appears
after a request is slow >4.5s) stops showing.

## Option B — Serve the frontend from Cloudflare Pages (instant load, optional)

Even the very first page load then comes from Cloudflare's edge, not Render.

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → pick this
   repo. Build settings: **Build command:** *(none)*, **Output directory:**
   `webapp/static`.
2. In the Pages project **Settings → Environment variables**, or by editing the
   deployed `index.html`, ensure the backend origin is set. Simplest: add this
   line to `webapp/static/index.html` **before** the `app.js` script tag:
   ```html
   <script>window.CC_BACKEND = "https://matevio.com";</script>
   ```
   (The app already routes every API + WebSocket call through `window.CC_BACKEND`;
   empty = same-origin, so this is the only change needed.)
3. On **Render → your service → Environment**, add:
   `CC_ALLOWED_ORIGINS = https://<your-pages-domain>.pages.dev`
   (comma-separate if you also use a custom domain). This enables CORS so the
   Pages-hosted frontend may call the Render API/WS.
4. Point users at the Pages URL (or move `matevio.com` DNS to it and keep the API
   on a subdomain like `api.matevio.com` → Render).

## Notes
- Free Render web services get ~750 instance-hours/month. Keeping one service
  awake 24/7 ≈ 730 h, which fits — but if you run other services too, watch the
  total.
- WebSockets work through Cloudflare on the free plan, so `/ws`, `/wsc` are fine.
