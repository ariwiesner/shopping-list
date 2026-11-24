// Service worker: makes the app installable and lets it open without a connection.
//
// Network first, always: a deploy reaches everyone on their next open, exactly as
// before. The cache is only a fallback for when there's no network (the list itself
// syncs through Firebase, which keeps its own offline copy).
// Only this site's own files are handled; Firebase, Google sign-in (/__/auth/...),
// fonts, prices from GitHub and the import service always go straight to the network.

const CACHE = "basket-v1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./cloud.js", "./catalog.js",
  "./import-parse.js", "./compare-worker.js", "./firebase-config.js", "./photo-config.js",
  "./manifest.json", "./icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // Best effort: a missing file mustn't stop the app from installing.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/__/")) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      // Any page (an invite link, say) opens the app when offline.
      if (req.mode === "navigate") {
        const shell = (await caches.match("./index.html")) || (await caches.match("./"));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
