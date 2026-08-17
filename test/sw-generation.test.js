/* One generation per page load — the coverage for issue #233.
 *
 * WHY THIS EXISTS
 * `sw.js` used to run two cache policies at once: `data/` network-first,
 * everything else cache-first with a background refresh. The consequence was
 * invisible from either branch on its own — a returning visitor ran the
 * PREVIOUS deploy's `app.js` against TODAY's `data/forays.json`, and `app.js`
 * and `player/client.js` could come from two different deploys. Nothing in CI
 * knew, because both branches are individually reasonable.
 *
 * The first test below is the reproduction: cached code, live network, and an
 * assertion that the page does NOT receive the new data. It fails against the
 * v4 worker and passes against this one.
 *
 * HOW IT TESTS THE REAL FILE
 * `sw.js` is evaluated in a `node:vm` context whose `self` is the context — the
 * same trick `test/app-security.test.js` and `tools/mobile/shell-invariants.test.mjs`
 * use for `app.js`. The listeners it registers are the real ones and they are
 * driven with FetchEvent-shaped objects. There is no test-only hook in `sw.js`:
 * everything below goes through `install`, `activate` and `fetch`.
 *
 * `setTimeout` in the context is a recorder rather than a timer, so the
 * network-timeout path is exercised without spending six seconds, and no test
 * leaves a pending handle.
 *
 * WHAT IT DOES NOT DO
 * It does not prove anything about a real browser's CacheStorage semantics, HTTP
 * revalidation, or `resultingClientId` support. The cache here is an in-memory
 * Map that is query-sensitive the way `caches.match` is, which is the one
 * semantic #233 point 3 turns on. Everything else about the platform is reasoned
 * about in `sw.js`'s header, not measured here.
 *
 * No dependencies: node:test + node:vm only.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SW_SRC = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const ORIGIN = "https://jw-incorporated.github.io";
const BASE = `${ORIGIN}/foray/`;

/* The eight files app.js fetches are all under this prefix; one of them is
   enough to prove the rule. */
const FORAYS = "data/forays.json";

/* ------------------------------------------------------------------ harness */

/** Absolute URL for a string or a request-shaped object, resolved like the page. */
function abs(input) {
  return new URL(typeof input === "string" ? input : input.url, BASE).href;
}

/**
 * Load the real `sw.js` into a context we control.
 *
 * `network(url)` returns a Response, throws to mean "no answer", or returns a
 * promise that never settles to mean "hanging". `seed` pre-populates the named
 * cache the way an earlier visit would have.
 */
function loadWorker({ network, seed = {}, seedCache = "foray-v5", windows = [] } = {}) {
  const listeners = {};
  const timers = [];
  const posted = [];
  const store = new Map();
  const waits = [];
  let claims = 0;
  let skipped = 0;

  const bucket = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  for (const [url, body] of Object.entries(seed)) {
    bucket(seedCache).set(abs(url), { body, status: 200 });
  }

  const answer = network || (() => { throw new Error("no network in this test"); });
  const fakeFetch = (input) => Promise.resolve().then(() => answer(abs(input), input));

  /* Bodies are stored as text and re-wrapped on read. Storing Response objects
     and cloning them repeatedly is the kind of harness detail that fails for
     reasons unrelated to the code under test. */
  const cacheFor = (name) => ({
    async put(request, response) {
      bucket(name).set(abs(request), { body: await response.text(), status: response.status });
    },
    async match(request) {
      const hit = bucket(name).get(abs(request));
      return hit ? new Response(hit.body, { status: hit.status }) : undefined;
    },
    async addAll(urls) {
      for (const url of urls) {
        const res = await fakeFetch(url);
        if (!res || !res.ok) throw new TypeError(`addAll failed for ${url}`);
        bucket(name).set(abs(url), { body: await res.text(), status: res.status });
      }
    },
  });

  const client = (id) => ({ id, postMessage: (message) => posted.push({ id, message }) });

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    fetch: fakeFetch,
    caches: {
      async open(name) { bucket(name); return cacheFor(name); },
      async keys() { return [...store.keys()]; },
      async delete(name) { return store.delete(name); },
      async match(request) {
        for (const name of store.keys()) {
          const hit = await cacheFor(name).match(request);
          if (hit) return hit;
        }
        return undefined;
      },
    },
    clients: {
      async get(id) { return windows.includes(id) ? client(id) : undefined; },
      async matchAll() { return windows.map(client); },
      async claim() { claims += 1; },
    },
    location: { origin: ORIGIN, href: `${BASE}sw.js` },
    Response, Request, URL, Promise, Set, Map, JSON, Error, TypeError, Object,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.live = false; },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() { skipped += 1; return Promise.resolve(); },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SW_SRC, ctx, { filename: "sw.js" });

  const event = (extra) => {
    const e = { waitUntil: (p) => waits.push(p), ...extra };
    return e;
  };

  return {
    /** Fire a lifecycle handler and await whatever it passed to waitUntil. */
    async lifecycle(type) {
      waits.length = 0;
      listeners[type](event({}));
      await Promise.all(waits);
    },
    /** Fire a fetch handler; resolves to the Response, or undefined if the
        worker declined to intercept. Does not await, so the timeout path can be
        driven — see `settle`. */
    fire(request, ids = {}) {
      let responded;
      listeners.fetch(event({
        request,
        clientId: ids.clientId || "",
        resultingClientId: ids.resultingClientId || "",
        respondWith: (p) => { responded = p; },
      }));
      return responded;
    },
    async fetch(request, ids) {
      const res = this.fire(request, ids);
      return res === undefined ? undefined : await res;
    },
    /** Await everything the worker handed to waitUntil — the cache writes and
        the postMessages, which by design outlive the response. */
    async settle() {
      while (waits.length) await Promise.all(waits.splice(0));
    },
    /** Run every timer the worker is waiting on. */
    fireTimers() {
      for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); }
    },
    cacheNames: () => [...store.keys()],
    cachedBody: (url, name = "foray-v5") => {
      const hit = bucket(name).get(abs(url));
      return hit ? hit.body : null;
    },
    posted,
    claims: () => claims,
    skipped: () => skipped,
  };
}

const nav = (url) => ({ url: abs(url), method: "GET", mode: "navigate" });
const sub = (url) => ({ url: abs(url), method: "GET", mode: "same-origin" });
const ok = (body) => new Response(body, { status: 200 });
const offline = () => { throw new Error("network unreachable"); };

/* Every shell file install precaches, so `addAll` succeeds. */
const shellNetwork = (url) => ok(`shell:${url.slice(BASE.length) || "./"}`);

/* ------------------------------------------------- the pair, in both orders */

test("THE #233 REPRODUCTION: a page served cached code is not handed fresh data", async () => {
  /* Exactly the founder's situation: a phone that had visited before (so app.js
     is in the cache), a data file that landed today, and connectivity. Under v4
     this returned the new document to the old code. */
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1", [FORAYS]: '{"forays":["grilling-history-1"]}' },
    network: (url) => {
      if (url.endsWith("app.js")) offline();
      return ok('{"forays":["grilling-history-1","grilling-history-2"]}');
    },
  });

  const code = await h.fetch(sub("app.js"), { clientId: "page-1" });
  assert.equal(await code.text(), "APP@deploy-1", "the page is running last-known code");

  const data = await h.fetch(sub(FORAYS), { clientId: "page-1" });
  assert.equal(
    await data.text(),
    '{"forays":["grilling-history-1"]}',
    "old code must be paired with the data cached alongside it, never with today's"
  );
});

test("a page whose code came from the origin gets today's data", async () => {
  /* The direction that is easy to lose by over-tightening the guard above: if
     every page were served cached data, the founder would never see a Foray that
     landed today, which is a worse bug than the one being fixed. */
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1", [FORAYS]: '{"forays":["grilling-history-1"]}' },
    network: (url) => ok(url.endsWith("app.js") ? "APP@deploy-2" : '{"forays":["grilling-history-2"]}'),
  });

  const code = await h.fetch(sub("app.js"), { clientId: "page-1" });
  assert.equal(await code.text(), "APP@deploy-2");

  const data = await h.fetch(sub(FORAYS), { clientId: "page-1" });
  assert.equal(await data.text(), '{"forays":["grilling-history-2"]}');
});

test("a repeat visit runs the current deploy, not the previous one", async () => {
  /* v4's cache-first shell returned the cached copy and refreshed in the
     background, so the new code arrived on the visit AFTER this one. */
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1" },
    network: () => ok("APP@deploy-2"),
  });
  const res = await h.fetch(sub("app.js"), { clientId: "page-1" });
  assert.equal(await res.text(), "APP@deploy-2");
});

test("one code file that does not answer pins the whole page, not just itself", async () => {
  /* app.js and player/client.js are separate cache entries. Under v4 they
     refreshed on separate schedules and could come from two different deploys.
     Here app.js is current and the module is not — which means the PAGE is not
     current, so its data comes from the cache too. */
  const h = loadWorker({
    seed: { "player/client.js": "MODULE@deploy-1", [FORAYS]: '{"forays":["grilling-history-1"]}' },
    network: (url) => {
      if (url.endsWith("player/client.js")) offline();
      return ok(url.endsWith("app.js") ? "APP@deploy-2" : '{"forays":["grilling-history-2"]}');
    },
  });

  assert.equal(await (await h.fetch(sub("app.js"), { clientId: "page-1" })).text(), "APP@deploy-2");
  assert.equal(
    await (await h.fetch(sub("player/client.js"), { clientId: "page-1" })).text(),
    "MODULE@deploy-1"
  );
  assert.equal(
    await (await h.fetch(sub(FORAYS), { clientId: "page-1" })).text(),
    '{"forays":["grilling-history-1"]}'
  );
});

test("styles and icons do not pin the page — only code decides the generation", async () => {
  /* The over-strict direction. A failed icon or stylesheet cannot make a page
     misread data, so treating it as a generation signal would refuse today's
     data to a page that is perfectly current. */
  const h = loadWorker({
    seed: { "styles.css": "CSS@deploy-1" },
    network: (url) => {
      if (url.endsWith("styles.css")) offline();
      return ok(url.endsWith("app.js") ? "APP@deploy-2" : '{"forays":["grilling-history-2"]}');
    },
  });

  await h.fetch(sub("app.js"), { clientId: "page-1" });
  assert.equal(await (await h.fetch(sub("styles.css"), { clientId: "page-1" })).text(), "CSS@deploy-1");
  assert.equal(
    await (await h.fetch(sub(FORAYS), { clientId: "page-1" })).text(),
    '{"forays":["grilling-history-2"]}',
    "a stale stylesheet is not a stale program"
  );
});

test("an opaque redirect is an answer from the origin, not a stale shell", async () => {
  /* A navigation's redirect mode is "manual", so a redirect arrives with
     `ok === false` and `type === "opaqueredirect"`. Reading that as "no answer"
     would serve the cached shell for a URL the origin wanted to move, and mark a
     current page a version behind. */
  const redirect = { ok: false, status: 0, type: "opaqueredirect", clone: () => redirect };
  const h = loadWorker({
    seed: { "./": "INDEX@deploy-1" },
    network: (url) => (url === BASE ? redirect : ok('{"forays":["grilling-history-2"]}')),
  });

  const res = await h.fetch(nav("./"), { resultingClientId: "page-1" });
  assert.equal(res, redirect, "handed straight back for the browser to follow");
  assert.equal(
    await (await h.fetch(sub(FORAYS), { clientId: "page-1" })).text(),
    '{"forays":["grilling-history-2"]}',
    "and the page is not pinned to the cache"
  );
});

/* ------------------------------------------------------- saying so, out loud */

test("falling back to cached code tells the page it is a version behind", async () => {
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1" },
    network: offline,
    windows: ["page-1"],
  });
  await h.fetch(sub("app.js"), { clientId: "page-1" });
  await h.settle();
  assert.deepEqual(h.posted, [{ id: "page-1", message: { source: "foray-sw", reason: "stale-shell" } }]);
});

test("refusing data with nothing cached answers 504 and says why", async () => {
  /* app.js turns a non-ok into null and every consumer treats null as absent, so
     this is the path that ends in "Forays aren't available right now" rather than
     an empty running order rendered by code that cannot read the document. */
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1" },
    network: (url) => {
      if (url.endsWith("app.js")) offline();
      return ok('{"forays":["grilling-history-2"]}');
    },
    windows: ["page-1"],
  });
  await h.fetch(sub("app.js"), { clientId: "page-1" });
  await h.settle();
  h.posted.length = 0;                       // isolate the message this fetch sends

  const data = await h.fetch(sub(FORAYS), { clientId: "page-1" });
  await h.settle();
  assert.equal(data.status, 504);
  assert.deepEqual(h.posted, [{ id: "page-1", message: { source: "foray-sw", reason: "stale-shell" } }]);
});

test("activate drops the previous generation, claims its pages and says so", async () => {
  const h = loadWorker({ seed: { "app.js": "APP@deploy-1" }, seedCache: "foray-v4", windows: ["page-1"] });
  await h.lifecycle("activate");
  assert.equal(h.cacheNames().includes("foray-v4"), false, "the old generation is deleted");
  assert.equal(h.claims(), 1);
  assert.deepEqual(h.posted, [
    { id: "page-1", message: { source: "foray-sw", reason: "generation-changed" } },
  ]);
});

test("a first-ever install announces nothing — there is no version to be behind", async () => {
  const h = loadWorker({ windows: ["page-1"] });
  await h.lifecycle("activate");
  assert.equal(h.claims(), 1);
  assert.deepEqual(h.posted, [], "telling somebody's first page load that it updated is a lie");
});

/* ----------------------------------------------------------------- offline */

test("install precaches the shell into foray-v5", async () => {
  /* Also the behavioural pin on the version bump HUMAN-ACTIONS #9 asks for: the
     name is asserted, not the constant, so a bump cannot be reverted quietly. */
  const h = loadWorker({ network: shellNetwork });
  await h.lifecycle("install");
  assert.deepEqual(h.cacheNames(), ["foray-v5"]);
  assert.equal(h.cachedBody("./"), "shell:./");
  assert.equal(h.cachedBody("app.js"), "shell:app.js");
  assert.equal(h.skipped(), 1);
});

test("with no network a navigation is still answered from the precached shell", async () => {
  const h = loadWorker({ network: shellNetwork });
  await h.lifecycle("install");

  const dead = loadWorker({ seed: { "./": "INDEX" }, network: offline });
  const res = await dead.fetch(nav("./"), { resultingClientId: "page-1" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "INDEX");
});

test("a deep link is answered offline even though its query never matched the cache", async () => {
  /* #233 point 3. `caches.match` is query-sensitive, so `?foray=…` — the only URL
     the founder actually opens — was the one URL with no offline copy. */
  const h = loadWorker({ seed: { "./": "INDEX" }, network: offline });
  const res = await h.fetch(nav("./?foray=grilling-history-2"), { resultingClientId: "page-1" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "INDEX");
});

test("a query-bearing navigation is not stored, but a script is", async () => {
  /* v4 stored one full copy of index.html per distinct query string, and
     `?foray=<id>` is unbounded. The precached "./" already answers offline. */
  const h = loadWorker({ network: (url) => ok(`served:${url}`) });
  await h.fetch(nav("./?foray=grilling-history-2"), { resultingClientId: "page-1" });
  await h.fetch(sub("app.js"), { clientId: "page-1" });
  await h.settle();
  assert.equal(h.cachedBody("./?foray=grilling-history-2"), null);
  assert.equal(h.cachedBody("app.js"), `served:${BASE}app.js`);
});

test("nothing cached and no network is a 504, not a hang or a blank page", async () => {
  const h = loadWorker({ network: offline });
  const res = await h.fetch(nav("./"), { resultingClientId: "page-1" });
  assert.equal(res.status, 504);
  assert.match(await res.text(), /no saved copy on this device/);
});

/* --------------------------------------------------------- bounded waiting */

test("a hanging origin is bounded: the last-known copy is served instead", async () => {
  /* The founding constraint is dead-zone survival, and a dead zone that accepts
     the connection and never answers is the shape that hangs a page. Without the
     race this assertion never resolves and the suite times out. */
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1", [FORAYS]: '{"forays":["grilling-history-1"]}' },
    network: (url) => (url.endsWith("app.js") ? new Promise(() => {}) : ok("{}")),
  });
  const pending = h.fire(sub("app.js"), { clientId: "page-1" });
  h.fireTimers();
  /* Raced against a real timer so that a worker which never falls back FAILS
     here rather than hanging the suite. A test whose failure mode is "CI runs
     forever" is not a passing test and not a failing one either. */
  const served = await Promise.race([
    pending.then((r) => r.text()),
    new Promise((r) => setTimeout(() => r("never answered"), 500)),
  ]);
  assert.equal(served, "APP@deploy-1");

  /* And the page is pinned by the timeout exactly as it is by a failure. */
  assert.equal(
    await (await h.fetch(sub(FORAYS), { clientId: "page-1" })).text(),
    '{"forays":["grilling-history-1"]}'
  );
});

test("a response that lands after the timeout still warms the cache", async () => {
  /* Otherwise a slow-but-working connection pays the same timeout on every load
     forever, and the new deploy never arrives. */
  let release;
  const h = loadWorker({
    seed: { "app.js": "APP@deploy-1" },
    network: () => new Promise((resolve) => { release = () => resolve(ok("APP@deploy-2")); }),
  });
  const pending = h.fire(sub("app.js"), { clientId: "page-1" });
  h.fireTimers();
  const served = await Promise.race([
    pending.then((r) => r.text()),
    new Promise((r) => setTimeout(() => r("never answered"), 500)),
  ]);
  assert.equal(served, "APP@deploy-1");

  release();
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  assert.equal(h.cachedBody("app.js"), "APP@deploy-2");
});

/* -------------------------------------------------- what is not intercepted */

test("a cross-origin request is left alone", async () => {
  const h = loadWorker({ network: () => ok("nope") });
  const res = h.fire({ url: "https://traffic.megaphone.fm/APO3303969728.mp3", method: "GET", mode: "cors" });
  assert.equal(res, undefined, "episode audio comes from ~41 CDNs and is none of our business");
});

test("a non-GET request is left alone", async () => {
  const h = loadWorker({ network: () => ok("nope") });
  const res = h.fire({ url: `${ORIGIN}/rest/v1/events`, method: "POST", mode: "cors" });
  assert.equal(res, undefined);
});

/* ------------------------------------------------------- the page's half */

/** Minimal DOM: enough for showShellNotice and nothing more. Honest about it —
    `innerHTML` is scanned for `id="…"` rather than parsed, which is why the
    assertions below check the markup string as well as the elements. */
function makeDocument() {
  const mk = (tagName) => {
    const el = {
      tagName, id: "", className: "", textContent: "", hidden: false,
      children: [], parentNode: null, listeners: {},
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      removeEventListener() {},
      setAttribute() {}, removeAttribute() {},
      appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
      insertBefore(child, ref) {
        const at = el.children.indexOf(ref);
        el.children.splice(at < 0 ? el.children.length : at, 0, child);
        child.parentNode = el;
        return child;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    let html = "";
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: (value) => {
        html = String(value);
        el.children = [];
        for (const m of html.matchAll(/id="([^"]+)"/g)) {
          el.appendChild(Object.assign(mk("stub"), { id: m[1] }));
        }
      },
    });
    return el;
  };

  const body = mk("body");
  const view = Object.assign(mk("main"), { id: "view" });
  body.appendChild(view);

  const walk = (el, id) => {
    if (el.id === id) return el;
    for (const child of el.children) {
      const hit = walk(child, id);
      if (hit) return hit;
    }
    return null;
  };

  return {
    body,
    documentElement: mk("html"),
    addEventListener() {},
    createElement: mk,
    querySelector: (sel) => (sel.startsWith("#") ? walk(body, sel.slice(1)) : null),
    querySelectorAll: () => [],
    _view: view,
  };
}

/** Evaluate the real app.js and hand back its service-worker message listener. */
function loadPage() {
  const document = makeDocument();
  const store = new Map();
  const messages = [];
  let reloads = 0;

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),          // parks init() at its first await
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: {
      userAgent: "node",
      serviceWorker: {
        register: () => Promise.resolve(),
        addEventListener: (type, fn) => { if (type === "message") messages.push(fn); },
      },
    },
    location: {
      protocol: "https:", hash: "#/", search: "", pathname: "/foray/",
      href: `${BASE}`, reload: () => { reloads += 1; },
    },
    document,
    history: { replaceState() {}, pushState() {} },
    addEventListener() {},
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, Object, Set, Map,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  assert.equal(messages.length, 1, "app.js must listen for the worker's messages");
  return {
    send: (data) => messages[0]({ data }),
    notice: () => document.querySelector("#shell-notice"),
    reloadButton: () => document.querySelector("#shell-notice-reload"),
    reloads: () => reloads,
    view: document._view,
    body: document.body,
  };
}

test("the worker's stale-shell message puts a reload control on the page", async () => {
  const page = loadPage();
  assert.equal(page.notice(), null, "nothing is shown until the worker says something");

  page.send({ source: "foray-sw", reason: "stale-shell" });
  const bar = page.notice();
  assert.ok(bar, "a notice is added");
  assert.equal(bar.className, "shell-notice");
  assert.match(bar.innerHTML, /last saved copy/);
  assert.match(bar.innerHTML, /Reload to get the current version\./);
  /* A sibling BEFORE #view, because route() rewrites #view on every hash change
     and would otherwise wipe the notice on the first navigation. */
  assert.equal(bar.parentNode, page.body);
  assert.ok(page.body.children.indexOf(bar) < page.body.children.indexOf(page.view));
});

test("the generation-changed message says something different and still offers the reload", async () => {
  const page = loadPage();
  page.send({ source: "foray-sw", reason: "generation-changed" });
  assert.match(page.notice().innerHTML, /updated in the background/);
  assert.match(page.notice().innerHTML, /Reload to get the current version\./);
});

test("pressing Reload reloads, and nothing reloads on its own", async () => {
  /* Deliberately not automatic: a reload loop cannot be rolled back by reverting
     the commit, because clients keep the worker they have until it updates. */
  const page = loadPage();
  page.send({ source: "foray-sw", reason: "stale-shell" });
  assert.equal(page.reloads(), 0);
  const button = page.reloadButton();
  assert.ok(button, "the notice carries a control that fixes it");
  for (const fn of button.listeners.click || []) fn();
  assert.equal(page.reloads(), 1);
});

test("a message that is not from the worker is ignored", async () => {
  const page = loadPage();
  page.send({ source: "some-other-frame", reason: "stale-shell" });
  page.send("stale-shell");
  page.send(null);
  assert.equal(page.notice(), null);
});

test("an unrecognised reason renders nothing rather than an empty bar", async () => {
  const page = loadPage();
  page.send({ source: "foray-sw", reason: "something-a-later-worker-sends" });
  assert.equal(page.notice(), null);
});
