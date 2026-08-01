// Cloudflare Worker — keeps the Render backend warm so users never see the
// "서버 깨우는 중…" (server waking up) message.
//
// WHY: Render's free tier sleeps after ~15 min idle; the first request then
// cold-starts (~45s). GitHub Actions' scheduled cron is throttled to roughly
// hourly, so it can't keep the server awake. Cloudflare Cron Triggers fire
// reliably (down to every minute), so a tiny Worker ping every few minutes
// keeps Render from ever sleeping.
//
// Deploy: see cloudflare/README.md (dashboard paste OR `npx wrangler deploy`).

const DEFAULT_PING = "https://matevio.com/api/health";

export default {
  // Fires on the cron schedule in wrangler.toml. Uses waitUntil so the ping
  // finishes even after the handler returns.
  async scheduled(event, env, ctx) {
    const url = (env && env.PING_URL) || DEFAULT_PING;
    ctx.waitUntil(
      fetch(url, { method: "GET", cf: { cacheTtl: 0 } }).catch(() => {})
    );
  },

  // Optional: visiting the Worker URL pings once and reports status, so you can
  // verify it works from a browser.
  async fetch(request, env) {
    const url = (env && env.PING_URL) || DEFAULT_PING;
    const started = Date.now();
    try {
      const r = await fetch(url, { cf: { cacheTtl: 0 } });
      return new Response(`pinged ${url} -> ${r.status} in ${Date.now() - started}ms`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (e) {
      return new Response(`ping failed: ${e}`, { status: 502 });
    }
  },
};
