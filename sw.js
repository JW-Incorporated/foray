/* Foray service worker — one generation per page load.

   THE INVARIANT (issue #233)
   `index.html`, `app.js`, `search-engine.js`, `player/*.js` and `data/*.json`
   are ONE artifact. A page load must receive every one of them from a single
   deploy. Yesterday's code against today's data is not a slower update — it is
   a different program reading a file it has never seen: a Foray id it cannot
   resolve, a field it does not know to read. That pair is what the founder's
   "several errors" looked like from a phone that had visited before (#225).

   WHY A CACHE BUMP ALONE WAS NOT THE FIX
   v4 ran two policies at once. `data/` was network-first, so it was always
   current. Everything else was cache-first with a background refresh, so a
   returning visitor ran the PREVIOUS deploy's code and picked the new one up on
   the visit after. `app.js` and `player/client.js` were separate cache entries
   with separate background refreshes, so they could even come from two
   different deploys. A version bump rescues the visitors who reload after the
   bump and leaves that mechanism running for the next deploy. So the mechanism
   is gone instead, in three parts:

     1. ONE POLICY FOR CODE AND DATA. Every same-origin GET asks the origin
        first and falls back to the cache only when the origin does not answer.
        Non-navigation requests are refetched with `cache: "no-cache"` so the
        browser revalidates rather than handing us whatever its HTTP cache is
        holding — without that the shell would ride GitHub Pages' `max-age`
        while `data/` (which app.js already fetches with `no-cache`) did not,
        which is a skew window all by itself. An unchanged file answers 304: a
        repeat visit costs one round trip and no bytes.

     2. A PAGE THAT FELL BACK IS PINNED TO ITS FALLBACK. When the origin does
        not answer for a page's CODE, that page is running last-known code, and
        its client id goes into `degraded`. Its `data/` requests are then served
        from the cache or refused — never from the network. This is the one rule
        that keeps offline from becoming a new way to build a mismatched pair,
        and it is why the offline shell can stay.

     3. A REFUSAL IS VISIBLE. The worker tells the page (`stale-shell`), and
        app.js says so with a reload control. A wrong pair has to fail loudly
        and recoverably; rendering it silently is the bug being fixed.

   OFFLINE IS PRESERVED. The shell is still precached on install, the cache is
   still the fallback for everything, and the wait for the origin is bounded by
   NET_TIMEOUT_MS so a dead zone costs a few seconds rather than hanging. The
   founding constraint is "sessions survive cell dead zones"; a fix that made
   every load network-dependent would trade this bug for a worse one.

   `player/*.js` IS DELIBERATELY NOT PRECACHED. `client.js` is the entry point
   of a module graph, so precaching it alone would fail offline on its first
   `import`, and precaching the graph means a list in this file that rots every
   time a module is added — the "someone has to remember" failure this repo
   keeps closing. Those files land in the cache the first time they are fetched
   and are served under the same one-generation policy as everything else.

   THIS FILE IS WEB-ONLY BY CONSTRUCTION. `navigator.serviceWorker` does not
   exist under `capacitor://localhost` (measured on iOS, #213/#220), and app.js
   refuses to register the worker there anyway (`shouldRegisterServiceWorker`).
   The native shells are immune to #233 and nothing here may assume a worker is
   present. */

/* Bumped from v4 (HUMAN-ACTIONS #9). `activate` deletes every cache that is not
   this one, so the bump is what gives a returning visitor a clean cutover
   instead of a half-migrated one. */
const CACHE = "foray-v5";

/* Precached on install so a cold start with no network still renders. */
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

/* How long the origin gets to answer before the last-known copy is served.
   Generous on purpose: an unchanged file answers 304, so this only bites when a
   CHANGED file is crawling. Much lower and a slow-but-working connection is
   told it is offline; much higher and a black-holed connection (a captive
   portal, a dead zone that accepts the SYN) hangs the page instead of falling
   back. A fetch that times out is not abandoned — it still writes to the cache
   when it lands, so the next load's revalidation is a cheap 304 rather than the
   same timeout again. */
const NET_TIMEOUT_MS = 6000;

/* Client ids whose CODE was served from the cache — see §2 above.
   In memory, and the browser may terminate an idle worker, which empties it. An
   unknown client is therefore treated as healthy rather than refused: failing
   open costs one page the pairing guarantee, failing closed would refuse data to
   a perfectly online visitor. A page load's requests are seconds apart and a
   worker is only killed when idle, so the window is small — stated rather than
   hidden. */
const degraded = new Set();

self.addEventListener("install", (e) => {
  /* skipWaiting STAYS, deliberately. It is one of the two ways a page can end
     up straddling generations, so it is worth saying why it is still here: the
     load that installs a new worker is served by the OLD one either way (the
     old worker owns the requests that are already in flight), so waiting does
     not save that load — it only delays the fix by one more visit. Given that
     this file exists to stop a stale-code load, taking effect a visit later is
     the wrong trade. The straddle it does create is handled: `activate` claims
     the open pages and then tells them they are a version behind. */
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== CACHE);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
    /* Only when a PREVIOUS generation was actually replaced. On a first-ever
       install there is nothing to be behind, and announcing an update to
       somebody's first page load would be a lie. */
    if (stale.some((k) => k.startsWith("foray-"))) await tellClients("generation-changed");
  })());
});

/* ---------- classification ---------- */

function isNavigation(request) {
  return request.mode === "navigate";
}

function isData(url) {
  return url.pathname.includes("/" + DATA_PREFIX);
}

/* Which files decide a page's generation. Only CODE can misread data, so
   styles, icons and the manifest are deliberately excluded: a failed icon must
   not make a working page refuse its data. Matched by extension rather than by
   a list so `player/*.js` — and whatever module lands next — is covered without
   anyone remembering to add it. */
function isCode(request, url) {
  return isNavigation(request) || /\.(?:js|html)$/.test(url.pathname);
}

/* ---------- network ---------- */

function networkFetch(request) {
  /* A navigation keeps its own Request. A navigation's redirect mode is
     "manual", and `respondWith` rejects a response that followed a redirect for
     one of those — so re-issuing it as a plain GET would turn a redirect into a
     broken page. It costs the forced revalidation on `index.html` only, and
     index.html carries no data: the files the invariant is about (the scripts
     and `data/`) all get `no-cache`. */
  return isNavigation(request) ? fetch(request) : fetch(request.url, { cache: "no-cache" });
}

/** Resolve to the response, or to null if the origin failed or was too slow. */
function fromOrigin(request) {
  const live = networkFetch(request).then(
    (res) => {
      /* Written to the cache whenever it lands, including after this call has
         already given up on it. That is what keeps a slow connection from being
         stuck on the same timeout every load. */
      if (res && res.ok) cachePut(request, res.clone());
      return res;
    },
    () => null
  );
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, NET_TIMEOUT_MS);
    live.then(
      (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

/* ---------- cache ---------- */

async function cachePut(request, response) {
  /* Deliberately NOT every URL that ever answered. `?foray=<id>` is unbounded,
     and v4 stored one full copy of index.html per distinct query string; the
     precached "./" entry already answers any navigation offline. */
  if (isNavigation(request)) {
    let search = "";
    try { search = new URL(request.url).search; } catch (_) { search = "?"; }
    if (search) return;
  }
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch (_) { /* a full or evicted cache is a slower page, not a broken one */ }
}

async function cachedFallback(request) {
  const direct = await caches.match(request);
  if (direct) return direct;
  /* A deep link never matches the precached "./" entry, because caches.match is
     query-sensitive — so `?foray=grilling-history-2`, the one URL the founder
     actually opens, was the one URL with no offline copy (#233 point 3). */
  if (isNavigation(request)) {
    return (await caches.match("./")) || (await caches.match("index.html")) || null;
  }
  return null;
}

/* ---------- talking to the page ---------- */

async function tellClient(clientId, reason) {
  if (!clientId || !self.clients || !self.clients.get) return;
  try {
    const client = await self.clients.get(clientId);
    if (client) client.postMessage({ source: "foray-sw", reason });
  } catch (_) { /* a page that has gone away needs no message */ }
}

async function tellClients(reason) {
  if (!self.clients || !self.clients.matchAll) return;
  try {
    const all = await self.clients.matchAll({ type: "window" });
    for (const client of all) client.postMessage({ source: "foray-sw", reason });
  } catch (_) { /* same */ }
}

/* ---------- responses of last resort ---------- */

/* 504 rather than an empty document or an empty JSON body. app.js turns a
   non-ok into null and every consumer treats null as "absent", which is how the
   page ends up saying "Forays aren't available right now" instead of rendering
   an empty running order against code that cannot read it. */
function unavailable(request) {
  if (isNavigation(request)) {
    return new Response(
      "<!doctype html><html lang=en><meta charset=utf-8><title>Foray</title>" +
        "<p>Foray couldn't load and there is no saved copy on this device. " +
        "Reload once you have a connection.",
      { status: 504, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  return new Response("", { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/* ---------- the two handlers ---------- */

/**
 * Shell (code, styles, icons): origin first, cache second.
 * `pin` is true for the files that decide the generation — see isCode().
 */
async function handleShell(request, clientId, pin) {
  const res = await fromOrigin(request);
  if (res && res.ok) {
    if (pin && clientId) degraded.delete(clientId);
    return res;
  }
  /* No answer, or an answer that is not the file — a 404 mid-deploy reads the
     same way here. Serve the last-known copy, and if this was code, pin the
     page to it: from here on its data comes from the cache too. */
  const cached = await cachedFallback(request);
  if (pin && clientId) {
    degraded.add(clientId);
    tellClient(clientId, "stale-shell");
  }
  if (cached) return cached;
  return res || unavailable(request);
}

/**
 * Data: origin first, cache second — unless this page is already known to be
 * running last-known code, in which case the origin is not consulted at all.
 * That refusal is the whole of #233: fresh data is exactly what old code cannot
 * read, so withholding it is the safe answer and saying so is the recoverable
 * one.
 */
async function handleData(request, clientId) {
  if (clientId && degraded.has(clientId)) {
    const cached = await caches.match(request);
    if (cached) return cached;
    tellClient(clientId, "stale-shell");
    return unavailable(request);
  }
  const res = await fromOrigin(request);
  if (res) return res;
  const cached = await caches.match(request);
  return cached || unavailable(request);
}

self.addEventListener("fetch", (e) => {
  const request = e.request;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;

  /* Which page asked. On a navigation the page does not exist yet, so
     `resultingClientId` names the one about to. Either can be absent (no
     `resultingClientId` in older Safari), and a page that cannot be named
     cannot be pinned — it gets the plain policy rather than a refusal. */
  const clientId = e.clientId || e.resultingClientId || "";

  if (isData(url)) e.respondWith(handleData(request, clientId));
  else e.respondWith(handleShell(request, clientId, isCode(request, url)));
});
