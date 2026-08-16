/* Foray service worker — offline shell.
   The founding constraint is "sessions survive cell dead zones"; the web
   stopgap should at least render its last-known state offline. App shell is
   cache-first; data files are network-first with cache fallback so a fresh
   session wins when connectivity exists. */

const CACHE = "foray-v4";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "search-engine.js",
  "app.js",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];
const DATA_PREFIX = "data/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  const isData = url.pathname.includes("/" + DATA_PREFIX);
  if (isData) {
    // Network-first: fresh data when online, last-known data when not.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Shell: cache-first, refresh in the background.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const refresh = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
