/* Matevio service worker — makes the app installable and fast, while keeping
   updates instant. The API and WebSocket always go straight to the network;
   the HTML is network-first (so a new deploy's ?v= assets load immediately),
   and versioned static assets are cache-first. Bump CACHE to purge old caches. */
const CACHE = "matevio-v50";
const MSG_CACHE = "matevio-msg";   // holds the localized reminder text (never purged)
const SHELL = [
  "/",
  "/static/style.css",
  "/static/i18n.js",
  "/static/app.js",
  "/static/puzzles.json",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MSG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- daily reminder: periodic background sync fires (installed PWA, Chrome/
// Android) → show the localized "today's puzzle / streak" notification. ----
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "daily-reminder") e.waitUntil(showDailyReminder());
});
function _todayStr() {
  // local calendar date YYYY-MM-DD (matches the app's dateStr())
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function showDailyReminder() {
  let title = "오늘의 퍼즐 🔥", body = "스트릭을 지키세요 — 오늘의 퍼즐이 기다려요!";
  try {
    const r = await caches.open(MSG_CACHE).then((c) => c.match("/__reminder"));
    if (r) { const j = await r.json(); title = j.title || title; body = j.body || body; }
  } catch (e2) {}
  // FIX4: conditional — skip on days the user already opened the app or already
  // solved today's daily; word it around the streak they'd actually lose.
  try {
    const s = await caches.open(MSG_CACHE).then((c) => c.match("/__reminder_state"));
    if (s) {
      const j = await s.json();
      if (j.date === _todayStr() && j.dailyDone) return;   // already done today → don't nag
      if (j.streak >= 2 && j.body_streak) body = j.body_streak.replace("{n}", j.streak);
      if (j.title) title = j.title;
    }
  } catch (e3) {}
  return self.registration.showNotification(title, {
    body, tag: "daily-reminder", icon: "/static/icons/icon-192.png", badge: "/static/icons/icon-192.png",
  });
}
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow("/");
  }));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // never cache: API calls, websockets, non-GET, cross-origin — always live
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/sw.js") return;

  // HTML navigations: network-first so the newest page (and its ?v= links) win,
  // and live data is never stale; fall back to the cached shell only when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return r; })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // versioned assets + icons: cache-first, then network (and store it)
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((r) => {
        if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return r;
      })
    )
  );
});
