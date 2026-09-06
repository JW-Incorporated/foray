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
        not answer for a page's CODE, that page is running last-known code from
        a specific retained generation, and it is told which one
        (`stale-shell`, carrying that generation's `deployId`). The PAGE keeps
        that id in its own memory — not the worker's — and tags its `data/`
        requests with it (`?_fdid=`), so they keep reading the SAME generation
        the code came from, never today's. This is the one rule that keeps
        offline from becoming a new way to build a mismatched pair.

     3. A REFUSAL IS VISIBLE. The worker tells the page (`stale-shell`), and
        app.js says so with a reload control. A wrong pair has to fail loudly
        and recoverably; rendering it silently is the bug being fixed.

   THE DEPLOY MANIFEST (#233 remainder, closed here)
   GitHub Pages serves `main` root with no build step and no server-side hook,
   so there was no artifact-level place to stamp a deploy id — until now.
   `deploy-manifest.json` is a committed, generated file (see
   `tools/ci/generate-manifest.mjs`, and NOT the pre-existing `manifest.json`,
   which stays the PWA web-app manifest `index.html` links) naming a
   content-derived `deploy_id` and a sha256 for every shell/module/data file
   that ships. Two holes this closes, and one it narrows but does not close —
   named honestly rather than overclaimed, because a review asked the question
   directly:

     - THE CACHE WAS NOT GENERATION-ATOMIC. Each file used to be written to one
       shared cache as it arrived, so a load in which `app.js` answered and
       `client.js` timed out left two generations in one bucket. Now each
       generation gets its OWN cache (`foray-gen-<deploy_id>`), built from
       manifest-verified fetches only, and promotion is a single pointer write
       (`activate`) — nothing reads a generation as current until the pointer
       says so, and an incomplete INSTALL promotes nothing.
     - THE DEGRADED SET LIVED ONLY IN WORKER MEMORY and failed open after an
       idle-worker eviction. Replaced entirely: the pin lives on the page, and
       generation lookups go through durable `CacheStorage`, not a
       worker-memory `Set`. A worker restart mid-session re-derives everything
       from the pointer cache and whatever `_fdid` the request already carries
       — there is nothing in memory to lose.
     - THE PIN CAN STILL LAND AFTER THE DATA, at RUNTIME, for the one file
       fetched in parallel with the pin-setting files: the deferred ES module
       `player/client.js`. Install-time atomicity (above) closes this for a
       TORN INSTALL — a manifest that never verifies never promotes, so a
       load straight after install cannot see this split. It does NOT close it
       for a load where `index.html` and `app.js` both answer live (untagged,
       no pin — this page IS current) while `client.js`'s OWN request, fired
       in parallel, independently fails and falls back to an OLDER retained
       generation's cached copy. `handleShell` pins THAT ONE REQUEST'S
       fallback correctly, but by the time it resolves, `app.js`'s `init()`
       has already sent its untagged `data/*.json` fetches — there is nothing
       left to retroactively re-tag. A review asked directly whether this is
       closed; it is not, and closing it fully would mean blocking every page
       load on `player/client.js` before starting any data fetch, which
       contradicts the founding "survive a dead zone" constraint the same way
       precaching the module outright would (see below). The exposure is the
       same one the original design named: a stale `client.js` is a stale
       PLAYER, not a stale reader of `data/*.json` — `renderForay` already
       guards its calls into the module with `typeof`, and #233's actual
       complaint (a Foray id the reader cannot resolve) is about `app.js`
       against `data/*.json`, which this file's central mechanism protects
       fully. Real, bounded, and disclosed rather than silently reintroduced.

   RETENTION. `activate` keeps the current and the immediately previous
   generation, and deletes anything older. That is what lets a page already
   pinned to the generation just superseded keep reading a consistent pair
   through one more deploy, without the worker remembering who is pinned to
   what — the pin travels with the page's own requests instead.

   OFFLINE IS PRESERVED. The current generation's cache is still the fallback
   for everything, and the wait for the origin is bounded by NET_TIMEOUT_MS so
   a dead zone costs a few seconds rather than hanging. The founding constraint
   is "sessions survive cell dead zones"; a fix that made every load
   network-dependent would trade this bug for a worse one.

   THIS FILE IS WEB-ONLY BY CONSTRUCTION. `navigator.serviceWorker` does not
   exist under `capacitor://localhost` (measured on iOS, #213/#220), and app.js
   refuses to register the worker there anyway (`shouldRegisterServiceWorker`).
   The native shells are immune to #233 and nothing here may assume a worker is
   present. */

/* The manifest, not this constant, now decides what a generation contains and
   what a returning visitor's code is measured against — see
   `tools/ci/generate-manifest.mjs`. This name is only the family every
   generation cache and the pointer cache are drawn from. */
const CACHE_PREFIX = "foray-gen-";

/* BUILD_ID exists for exactly one reason and is read by nothing below: a
   browser only re-runs `install()` (and therefore only re-reads
   `deploy-manifest.json`) when the fetched `sw.js` bytes differ, byte for
   byte, from the previously registered copy. Every OTHER file this file's
   `precache()` depends on can change on a deploy — `index.html`, `app.js`,
   `player/*.js`, every `data/*.json` — while `sw.js` itself stays
   byte-identical, and a browser that sees identical bytes skips `install()`
   entirely and never notices the new manifest exists. `tools/ci/generate-
   manifest.mjs --write` stamps this string to the freshly computed
   `deploy_id` on every run, so a real content change always changes sw.js's
   own bytes too, and `--check` fails if the two ever drift apart. */
const BUILD_ID = "b247afe51c40937c";
const POINTER_CACHE = "foray-pointer";
const PENDING_CACHE = "foray-pending";
/* Cache keys are Requests/URLs, so a plain string needs a URL of its own to be
   stored under. Neither of these is ever fetched — they exist only as cache
   keys for a one-line Response body. */
const POINTER_KEY = "https://foray.invalid/__generation-pointer__";
const PENDING_KEY = "https://foray.invalid/__pending-generation__";
/* Recorded inside EVERY generation cache, alongside its files, at install
   time — see cachePut()'s header for why a generation cache needs its own
   manifest snapshot available at runtime, not only during install. */
const GEN_MANIFEST_KEY = "https://foray.invalid/__manifest__";

const MANIFEST_URL = "deploy-manifest.json";

const DATA_PREFIX = "data/";

/* RETENTION is fixed at two generations — current + immediately previous —
   by the pointer cache's own shape: it names exactly one "previous" id at
   promotion time, not a list. Widening retention further would need the
   pointer cache to become a small ordered list rather than a single value;
   not needed today; see sw.js's header for why two is the right number (a
   client already pinned to the generation just superseded keeps reading a
   consistent pair through one more deploy). */

/* How long the origin gets to answer before the last-known copy is served.
   Generous on purpose: an unchanged file answers 304, so this only bites when a
   CHANGED file is crawling. Much lower and a slow-but-working connection is
   told it is offline; much higher and a black-holed connection (a captive
   portal, a dead zone that accepts the SYN) hangs the page instead of falling
   back. A fetch that times out is not abandoned — it still writes to the cache
   when it lands, so the next load's revalidation is a cheap 304 rather than the
   same timeout again. */
const NET_TIMEOUT_MS = 6000;

self.addEventListener("install", (e) => {
  /* skipWaiting STAYS, deliberately. It is one of the two ways a page can end
     up straddling generations, so it is worth saying why it is still here: the
     load that installs a new worker is served by the OLD one either way (the
     old worker owns the requests that are already in flight), so waiting does
     not save that load — it only delays the fix by one more visit. Given that
     this file exists to stop a stale-code load, taking effect a visit later is
     the wrong trade. The straddle it does create is handled: `activate` claims
     the open pages and then tells them they are a version behind. */
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

/**
 * Verify sha256 file hashes against the manifest, and stage them into a new
 * per-generation cache — but do NOT promote it. Promotion (the pointer write)
 * happens in `activate`, so a worker that is terminated between install and
 * activate still promotes correctly: the pending id is itself durable, in
 * `PENDING_CACHE`, not a module-scope variable that a restart would drop.
 *
 * All-or-nothing, exactly like the old `addAll`-based precache: a manifest we
 * cannot fetch, a file that does not answer, or a file whose bytes do not match
 * its recorded hash (a torn deploy — some files already on the new commit,
 * some still serving the old one) aborts the whole install. Nothing is
 * promoted and the previous pointer is untouched.
 */
async function precache() {
  const manifestRes = await fetch(MANIFEST_URL, { cache: "reload" });
  if (!manifestRes || !manifestRes.ok) {
    throw new TypeError(`precache failed: manifest.json did not answer`);
  }
  const manifest = await manifestRes.json();
  const deployId = manifest && manifest.deploy_id;
  const files = (manifest && manifest.files) || {};
  const paths = Object.keys(files);
  if (!deployId || paths.length === 0) {
    throw new TypeError("precache failed: manifest.json is missing deploy_id or files");
  }

  const verified = await Promise.all(
    paths.map(async (path) => {
      const res = await fetch(path, { cache: "reload" });
      if (!res || !res.ok) throw new TypeError(`precache failed for ${path}`);
      const buf = await res.clone().arrayBuffer();
      const digest = await sha256Hex(buf);
      const expected = String(files[path]).replace(/^sha256:/, "");
      if (digest !== expected) {
        throw new TypeError(`precache failed: ${path} does not match the manifest (torn deploy)`);
      }
      return [path, res];
    })
  );

  const genCache = await caches.open(CACHE_PREFIX + deployId);
  /* Navigations request "./" (or the origin root), a distinct cache key from
     "index.html" even though it is the same bytes — `cachedShellFallback`
     looks up "./" specifically. Cloned from the SAME verified response before
     either copy is stored, so a torn deploy can't desync the two. */
  await Promise.all(
    verified.map(([path, res]) => {
      const puts = [genCache.put(path, path === "index.html" ? res.clone() : res)];
      if (path === "index.html") puts.push(genCache.put("./", res));
      return Promise.all(puts);
    })
  );
  /* The manifest itself is stored INSIDE the generation cache too, not only
     read during install — `cachePut` needs it at runtime to tell a
     manifest-tracked file (which must never be silently overwritten by an
     unverified live response — see its header) from an untracked one. Keyed
     by the SAME resolved absolute URL every cache entry above was actually
     stored under (path resolved against this worker's own script URL, query
     stripped — matching what every runtime request resolves to), not the raw
     manifest path string, so a runtime lookup is a direct object-key hit
     rather than re-deriving how a relative path resolves. */
  const resolvedHashes = {};
  for (const path of paths) {
    const resolvedUrl = new URL(path, self.location.href);
    resolvedHashes[resolvedUrl.origin + resolvedUrl.pathname] = files[path];
  }
  /* "./" is a distinct cache key from "index.html" (same bytes, see the PUT
     above) and therefore needs its own tracked-hash entry, or a live
     navigation response could overwrite it unchecked. */
  if (files["index.html"]) {
    const rootUrl = new URL("./", self.location.href);
    resolvedHashes[rootUrl.origin + rootUrl.pathname] = files["index.html"];
  }
  await genCache.put(GEN_MANIFEST_KEY, new Response(JSON.stringify(resolvedHashes)));

  /* Record what `activate` should promote. Written last, after every file is
     verified AND staged, so a crash here still leaves nothing pending. */
  const pending = await caches.open(PENDING_CACHE);
  await pending.put(PENDING_KEY, new Response(deployId));
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const pendingCache = await caches.open(PENDING_CACHE);
    const pendingRes = await pendingCache.match(PENDING_KEY);
    if (!pendingRes) return; // nothing to promote (e.g. re-activation with no new install)
    const newDeployId = (await pendingRes.text()).trim();

    const pointerCache = await caches.open(POINTER_CACHE);
    const previousRes = await pointerCache.match(POINTER_KEY);
    const previousDeployId = previousRes ? (await previousRes.text()).trim() : null;

    /* THE ATOMIC STEP. Nothing above this line is visible to a request; only
       after this write does `isCurrent()`/`currentDeployId()` report the new
       generation. */
    await pointerCache.put(POINTER_KEY, new Response(newDeployId));
    /* Only cleared AFTER the pointer write above succeeds. Deleting it
       earlier (a review caught this) would drop the durable "this needs
       promoting" marker if the pointer write itself then failed — a
       transient CacheStorage/quota error between the two would leave a fully
       verified, fully staged generation with no record that it was ever
       meant to be promoted, and no later activate would retry it. Leaving
       the marker in place until promotion is confirmed makes a failed
       promotion retryable on the next activate instead of silently stuck. */
    await pendingCache.delete(PENDING_KEY);

    /* Bounded retention: current + previous. Anything older, and any
       non-generation cache name (a prior architecture's leftovers), is
       deleted. */
    const keep = new Set([CACHE_PREFIX + newDeployId]);
    if (previousDeployId && previousDeployId !== newDeployId) {
      keep.add(CACHE_PREFIX + previousDeployId);
    }
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== POINTER_CACHE && k !== PENDING_CACHE && !keep.has(k));
    await Promise.all(stale.map((k) => caches.delete(k)));

    await self.clients.claim();

    /* Only when a PREVIOUS generation actually existed and changed. On a
       first-ever install there is nothing to be behind, and announcing an
       update to somebody's first page load would be a lie. */
    if (previousDeployId && previousDeployId !== newDeployId) {
      await tellClients("generation-changed", { deployId: newDeployId });
    }
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

/* ---------- generation lookup ---------- */

/** The deploy id the pointer currently names, or null before any install. */
async function currentDeployId() {
  const pointerCache = await caches.open(POINTER_CACHE);
  const res = await pointerCache.match(POINTER_KEY);
  return res ? (await res.text()).trim() : null;
}

/** True if a generation cache for this deploy id still exists (retained). */
async function hasGeneration(deployId) {
  if (!deployId) return false;
  const keys = await caches.keys();
  return keys.includes(CACHE_PREFIX + deployId);
}

/** Look up `request` inside one specific generation's cache, ignoring query. */
async function matchGeneration(deployId, request) {
  if (!deployId) return undefined;
  const keys = await caches.keys();
  const name = CACHE_PREFIX + deployId;
  if (!keys.includes(name)) return undefined;
  const cache = await caches.open(name);
  return cache.match(stripQuery(request));
}

/**
 * The Request/URL a generation cache actually stores under, with any query
 * string removed. `_fdid=<id>` (data requests) and `?foray=<id>` (deep links,
 * never stored — see cachePut) are both request-time routing, not part of the
 * file identity a generation cache keys on; keeping them in the cache key
 * would give every distinct query its own copy of the same file.
 */
function stripQuery(request) {
  const url = new URL(request.url);
  if (!url.search) return request;
  return new Request(url.origin + url.pathname, { method: "GET" });
}

/**
 * Resolve a CODE/shell request against retained generations, current first.
 * Returns `{ response, deployId }` for whichever generation answered, or null.
 */
async function cachedShellFallback(request) {
  const current = await currentDeployId();
  if (current) {
    const hit = await matchGeneration(current, request);
    if (hit) return { response: hit, deployId: current };
  }
  /* A deep link never matches the precached "./" entry, because a cache lookup
     is query-sensitive — so `?foray=grilling-history-2`, the one URL the
     founder actually opens, was the one URL with no offline copy (#233 point
     3). Navigations fall back to the shell entry within the SAME generation. */
  if (isNavigation(request) && current) {
    const cache = await caches.open(CACHE_PREFIX + current);
    const shell = (await cache.match("./")) || (await cache.match("index.html"));
    if (shell) return { response: shell, deployId: current };
  }
  return null;
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
function fromOrigin(request, env) {
  const live = networkFetch(request).then(
    (res) => {
      /* Written to the cache whenever it lands, including after this call has
         already given up on it. That is what keeps a slow connection from being
         stuck on the same timeout every load. Handed to `waitUntil` rather than
         left floating: the response has already gone back to the page by then,
         and a worker the browser is free to terminate would otherwise drop the
         write — the failure being "the cache never fills, and nobody notices
         until the next dead zone". */
      if (res && res.ok) env.waitUntil(cachePut(request, res.clone()));
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

/**
 * A live origin answer is written back into the CURRENT generation's cache —
 * never a retained-but-superseded one — so a page running today's code keeps
 * getting a cheap revalidation on the next load without disturbing whatever an
 * older, still-pinned page is reading from its own retained generation.
 *
 * A generation cache is not free to accept anything, though: every file
 * `precache()` staged there was verified against `deploy-manifest.json`'s
 * sha256 at install time, and that is the whole basis for `handleData`'s
 * "the tagged generation is authoritative" rule. A stray write from an ORDINARY
 * runtime fetch — no manifest check, no atomic promotion — must not be able to
 * silently replace one of those verified bytes with something that came from
 * the origin mid-rollout (a real risk: an old, still-active worker can still be
 * answering requests for pages pinned to it while a NEW deploy is already
 * propagating on the origin, so "the origin answered" is not "the origin
 * answered with THIS generation's bytes"). So a manifest-tracked path is only
 * ever overwritten if the incoming bytes re-verify against the SAME hash the
 * generation was installed with; anything that fails that check is silently
 * dropped, and the generation keeps the copy install already proved correct.
 * A path the manifest never tracked (there are none today, but the check
 * costs nothing and keeps this correct if one is ever added) is cached as
 * before — there is no verified copy for it to corrupt.
 */
async function cachePut(request, response) {
  /* Deliberately NOT every URL that ever answered. `?_fdid=<id>` (and, before
     it, `?foray=<id>`) is unbounded, and v4 stored one full copy of index.html
     per distinct query string; the precached "./" entry already answers any
     navigation offline. */
  if (isNavigation(request)) {
    try { if (new URL(request.url).search) return; } catch (_) { return; }
  }
  const current = await currentDeployId();
  if (!current) return;
  try {
    const cache = await caches.open(CACHE_PREFIX + current);
    const key = stripQuery(request);
    const expected = await trackedHash(cache, key.url);
    if (expected) {
      const buf = await response.clone().arrayBuffer();
      const digest = await sha256Hex(buf);
      if (digest !== expected) return; // does not match this generation; drop it, keep the verified copy
    }
    await cache.put(key, response);
  } catch (_) { /* a full or evicted cache is a slower page, not a broken one */ }
}

/** The manifest-recorded sha256 for `url` inside `cache`, or null if this
    generation's manifest does not track that URL at all. */
async function trackedHash(cache, url) {
  const manifestRes = await cache.match(GEN_MANIFEST_KEY);
  if (!manifestRes) return null;
  const hashes = await manifestRes.json();
  const u = new URL(url);
  const hash = hashes[u.origin + u.pathname];
  return hash ? String(hash).replace(/^sha256:/, "") : null;
}

/* ---------- talking to the page ---------- */

async function tellClient(clientId, reason, extra) {
  if (!clientId || !self.clients || !self.clients.get) return;
  try {
    const client = await self.clients.get(clientId);
    if (client) client.postMessage({ source: "foray-sw", reason, ...(extra || {}) });
  } catch (_) { /* a page that has gone away needs no message */ }
}

async function tellClients(reason, extra) {
  if (!self.clients || !self.clients.matchAll) return;
  try {
    const all = await self.clients.matchAll({ type: "window" });
    for (const client of all) client.postMessage({ source: "foray-sw", reason, ...(extra || {}) });
  } catch (_) { /* same */ }
}

/* ---------- responses of last resort ---------- */

/* 504 rather than an empty document or an empty JSON body. app.js turns a
   non-ok into null and every consumer treats null as "absent", which is how the
   page ends up saying "Couldn't load forays right now" instead of rendering
   an empty running order against code that cannot read it. */
function unavailable(request) {
  if (isNavigation(request)) {
    return new Response(
      "<!doctype html><html lang=en><meta charset=utf-8><title>4a</title>" +
        "<p>4a couldn't load and there is no saved copy on this device. " +
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
async function handleShell(request, env, pin) {
  const res = await fromOrigin(request, env);
  /* `opaqueredirect` is a real answer from the origin even though `ok` is false:
     a navigation's redirect mode is "manual", so a redirect arrives as an opaque
     response that `respondWith` is happy with and the browser then follows.
     Reading it as "no answer" would serve the cached shell for a URL the origin
     wanted to move, and mark the page a version behind for no reason. It cannot
     happen at the current scope (`/foray/` does not redirect, and `/foray` is
     outside the worker's scope entirely) — this is here so that stays true by
     accident rather than by luck. */
  if (res && (res.ok || res.type === "opaqueredirect")) return res;
  /* No answer, or an answer that is not the file — a 404 mid-deploy reads the
     same way here. Serve the last-known copy from whichever generation still
     has it, and if this was code, tell the page which generation it is now
     running: from here on, ITS data requests must carry that generation's id,
     never today's.

     THE PIN MUST NOT DEPEND ON THE `stale-shell` MESSAGE ARRIVING IN TIME. A
     review caught this: `handleShell`'s decision for app.js's OWN fetch is
     made and returned before app.js has executed a single line, so a
     `postMessage` sent from here can race app.js's `addEventListener` and be
     lost — events do not queue for a listener that attaches after they fire.
     So for a CODE fallback the pin is instead baked directly into the
     response BYTES the browser is about to execute/parse, synchronously,
     before any of that file's own code runs: a `self.__forayPinnedDeployId =
     "<id>";` statement prepended to a `.js` fallback (valid as a top-level
     statement in both classic scripts and ES modules), or a
     `<meta name="foray-pin-deploy-id" content="<id>">` tag inserted into a
     navigation's `<head>` (parsed before any script tag runs). app.js reads
     `self.__forayPinnedDeployId` — falling back to the meta tag when it is a
     fresh navigation load — as the FIRST thing it does, before `init()`. The
     `stale-shell` postMessage is sent too, unchanged, purely for the reload
     notice; it is no longer what establishes the pin. */
  const fallback = await cachedShellFallback(request);
  if (pin && env.clientId && fallback) {
    env.waitUntil(tellClient(env.clientId, "stale-shell", { deployId: fallback.deployId }));
  } else if (pin && env.clientId) {
    env.waitUntil(tellClient(env.clientId, "stale-shell", { deployId: null }));
  }
  if (!fallback) return res || unavailable(request);
  if (!pin) return fallback.response;
  return stampPin(request, fallback.response, fallback.deployId);
}

/**
 * Bakes `deployId` into a CODE fallback response's own bytes, synchronously
 * readable by that file's very first statement — see `handleShell`'s header
 * for why this exists instead of relying solely on postMessage timing.
 */
async function stampPin(request, response, deployId) {
  const url = new URL(request.url);
  const isHtml = isNavigation(request) || /\.html$/.test(url.pathname);
  const body = await response.text();
  const stamped = isHtml
    ? body.replace(
        /<head(\s[^>]*)?>/i,
        (m) => `${m}\n<meta name="foray-pin-deploy-id" content="${escapeHtmlAttr(deployId)}">`
      )
    : `self.__forayPinnedDeployId=${JSON.stringify(deployId)};\n${body}`;
  /* Fresh headers, NOT `response.headers` reused verbatim — a review caught
     this: a static host commonly sends `Content-Length` on the cached
     origin response this came from, and prepending/inserting bytes without
     dropping it leaves a declared length that no longer matches the actual
     body. A browser is entitled to reject that as a malformed
     service-worker response, which would break exactly the offline/stale
     fallback this function exists to serve. `Content-Length` (recomputed
     automatically from the new body by the platform) and `Content-Encoding`
     (the cached bytes are already decoded text, not compressed, so a stale
     encoding header would make the browser try to decompress plain text)
     are the two that matter; everything else on a same-origin text response
     is safe to carry forward unmodified. */
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(stamped, { status: response.status, headers });
}

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Data: origin first, cache second — unless the request already carries a
 * `_fdid` naming the generation the page's CODE was pinned to (see
 * `handleShell`), in which case THAT generation's cache is authoritative and
 * the origin is never consulted, even if it happens to be the current
 * pointer's generation: the page's code already fell back once, so its data
 * must keep reading the exact bytes cached alongside that fallback, never
 * whatever the origin answers with right now — `data/*.json` refreshes
 * independently of a deploy (the nightly content pipeline), so "the tagged
 * generation is also current" does not mean "today's origin answer is safe".
 *
 * A tagged request whose generation has aged out of retention (or was never
 * valid) FAILS VISIBLY rather than silently falling through to the live,
 * untagged path — a review correctly named this as the failure mode the
 * whole feature exists to prevent. A page can stay open across two
 * subsequent deploys (RETAIN_GENERATIONS keeps only the current and
 * immediately-previous one), and if its tagged generation is deleted by then,
 * quietly serving it CURRENT data would recreate exactly the mismatched
 * code/data pair #233 was about — the tag exists specifically so that never
 * happens silently. `unavailable(request)` is the same 504 an untagged
 * request gets when nothing is cached at all: it surfaces as "Couldn't load
 * forays right now", recoverable by the reload control the stale-shell
 * notice already offers, rather than a silently wrong pairing.
 */
async function handleData(request, env) {
  const url = new URL(request.url);
  const taggedId = url.searchParams.get("_fdid");

  if (taggedId) {
    const pinned = await matchGeneration(taggedId, request);
    if (pinned) return pinned;
    return unavailable(request);
  }

  const res = await fromOrigin(request, env);
  /* `res.ok`, not `res` — the same rule `handleShell` applies, for the same
     reason. A 404 or a 502 on `data/session.json` is not an answer worth
     rendering: `fetchJson` turns it into null and `init()` gives up with
     "Couldn't load 4a" even when a perfectly good cached copy is sitting
     right here. A genuine 404 with nothing cached still surfaces as the 404, so
     a file that was really removed still reads as absent. */
  if (res && res.ok) return res;
  const current = await currentDeployId();
  const cached = current ? await matchGeneration(current, request) : undefined;
  return cached || res || unavailable(request);
}

self.addEventListener("fetch", (e) => {
  const request = e.request;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;

  /* Which page asked, and how to keep the worker alive for the writes that
     outlive the response.

     For a subresource that is `clientId`. For a NAVIGATION it is not, and the
     two are not interchangeable: on a navigation `clientId` names the page that
     INITIATED it — the document about to be replaced, or another tab entirely —
     while `resultingClientId` names the page about to exist. Reading `clientId`
     first would pin and message a document that is going away and leave the new
     one unpinned, which is how Angular's service worker shipped this exact bug
     (angular#42607). Our own reload control is such a navigation, so getting it
     backwards would mean the recovery path never recovered.

     `resultingClientId` is absent in older Safari, and there is deliberately no
     fallback to `clientId` there: a page that cannot be named is not pinned,
     which fails open, and pinning the WRONG document would fail closed on
     somebody else's tab.

     `waitUntil` is wrapped because it throws once the event has settled, and a
     cache write we are too late to register is not worth a broken response. */
  const env = {
    clientId: (isNavigation(request) ? e.resultingClientId : e.clientId) || "",
    waitUntil: (p) => { try { e.waitUntil(p); } catch (_) { /* too late; harmless */ } },
  };

  if (isData(url)) e.respondWith(handleData(request, env));
  else e.respondWith(handleShell(request, env, isCode(request, url)));
});
