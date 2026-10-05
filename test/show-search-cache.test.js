/* S-05 (docs/search-plan.md): the in-memory hot-query cache for the breadth
 * pass, and the deliberate refusal that goes with it.
 *
 * WHY A CACHE HERE AND NOT IN THE HTTP LAYER
 * Measured, docs/search-plan.md §1.5: `fetchApiJson` passes
 * `{ cache: "no-cache" }`, so a repeat of an identical query revalidates over
 * the network every time REGARDLESS of the endpoint's `max-age=300`. The
 * browser cache is defeated by design (the same call shape `fetchJson` uses,
 * and for the same reason: data that refreshes nightly must not be served
 * stale from a disk cache). So the endpoint's caching headers buy the app
 * nothing and the only place a retype can be made free is in memory.
 *
 * THE REFUSAL, because it is the point of the card rather than a footnote.
 * §1.4 measured forced-MISS ttfb at 0.72-0.88 s and repeat-HIT at 0.41-1.12 s
 * — a ~0.3 s delta on a ~0.8 s wall time, because a Vercel cache HIT does not
 * invoke the function at all. Cold start is NOT what makes search feel slow;
 * the round trip is, and S-03's on-device index is what removes it. A warm-up
 * ping or a keep-warm cron would add a scheduled job and buy a third of the
 * wrong number. There is no test for a thing that does not exist, so it is
 * said here instead.
 *
 * Every test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub, same shape as test/show-search-live.test.js's
 * (see that file's header for why each of these suites carries its own).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEl(tag) {
  const handlers = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
    fire(type, evt) {
      const fn = handlers.get(type);
      if (!fn) throw new Error(`no ${type} handler is bound to #${this.id}`);
      return fn(evt || { preventDefault() {} });
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
  "ep-search-results", "pl-search-results",
];

function mount({ breadthOk = true, episodesOk = true, episodes = [] } = {}) {
  const calls = [];
  const records = [];
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const fetchImpl = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("show-index.tsv")) return Promise.resolve({ ok: false, status: 504, text: () => Promise.resolve("") });
    if (u.includes("api/shows/search")) {
      if (!breadthOk) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          shows: [{ show_id: "1000001", title: "Deep History Hour", artwork_url: null, tier: "breadth" }],
          degraded: false,
        }),
      });
    }
    if (u.includes("api/episodes/search")) {
      if (!episodesOk) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ episodes, source: ["apple"] }),
      });
    }
    return new Promise(() => {});
  };

  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/shows", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, Intl,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    /* The one diagnostics bridge, spied exactly as
       test/search-probe-record.test.js spies it: it is a plain global, not DOM
       plumbing. Deliberately NO `requestIdleCallback` in this context — that is
       the real fallback path (older WebKit, the native shell), and it is the
       one a test can drive. */
    forayRecordSearch: (fields) => { records.push(fields); return true; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const state = vm.runInContext("state", ctx);
  state.catalog = { shows: [{ show_id: "radiolab", title: "Radiolab", artwork_url: null }] };
  state.discover = { items: [] };
  state.cardSlots = [];
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  ctx.renderAllShows();

  const search = async (q) => {
    byId.get("sh-input").value = q;
    byId.get("sh-form").fire("submit");
    await sleep(20);
  };
  return {
    ctx, byId, calls, state, search, records,
    evalIn: (src) => vm.runInContext(src, ctx),
    /* P-02 (docs/search-parity-plan.md) split one show request into two: the
       CATALOGUE pass, and the DIRECTORY pass carrying `fallthrough=1`. This
       suite is about `showBreadthQueryCache`, which is the catalogue pass's
       cache and nothing else — the directory pass has its own
       (`showDirectoryQueryCache`), pinned in
       test/show-search-fallthrough.test.js. Filtering here rather than
       loosening every count below keeps each assertion about the one cache it
       names. */
    breadthCalls: () => calls.filter((u) => u.includes("api/shows/search") && !u.includes("fallthrough=1")),
    directoryCalls: () => calls.filter((u) => u.includes("api/shows/search") && u.includes("fallthrough=1")),
    episodeCalls: () => calls.filter((u) => u.includes("api/episodes/search")),
  };
}

test("a repeat of an identical query fires ZERO breadth requests", async () => {
  /* THE CARD'S ACCEPTANCE LINE, asserted as a request count. A listener who
     types "history", looks at the list, deletes it and types it again three
     seconds later should not pay 0.4-1.1 s twice.

     MUTATION (the one the card names): remove the
     `showBreadthQueryCache.get(cacheKey)` lookup from `runShowSearchCostly`.
     The second search fires a second request and the count below is 2. */
  const m = mount();
  await m.search("history");
  assert.strictEqual(m.breadthCalls().length, 1);
  await m.search("history");
  assert.strictEqual(m.breadthCalls().length, 1, "the second identical query must not reach the network");
  assert.ok(m.byId.get("sh-results").innerHTML.includes("Deep History Hour"),
    "and it must still show the cached breadth result, not silently drop it");
});

test("the cache key is the normalized query, so case and surrounding space do not split it", async () => {
  /* `api/shows/search.ts` lowercases and trims server-side (its
     `searchBreadthShows` call does `String(query).trim().toLowerCase()`), so
     "History", "history" and " history " are ONE question as far as the
     endpoint is concerned. A cache keyed on the raw text would ask it three
     times and get three identical answers.

     MUTATION: key the cache on `query` instead of `showBreadthCacheKey(query)`.
     Each variant misses and the count goes to 3. */
  const m = mount();
  await m.search("history");
  await m.search("History");
  await m.search("  HISTORY  ");
  assert.strictEqual(m.breadthCalls().length, 1);
});

test("two different queries are two different entries", async () => {
  /* The other direction, so the test above cannot be satisfied by a cache
     that returns the same answer for everything.

     MUTATION: key the cache on a constant. The second query is served the
     first one's results and the count below stays at 1. */
  const m = mount();
  await m.search("history");
  await m.search("radiolab");
  assert.strictEqual(m.breadthCalls().length, 2);
});

test("a FAILED breadth fetch is not cached, so a later identical query retries", async () => {
  /* `fetchApiJson` swallows a network error to `null` (its own header says
     so), which is indistinguishable at the call site from "the endpoint
     answered". Caching that would turn one tunnel into a permanently empty
     breadth pass for that query, for the rest of the session.

     MUTATION: cache `breadthShows` unconditionally rather than inside
     `if (data)`. The second attempt is served the empty non-answer and the
     count stays at 1. */
  const m = mount({ breadthOk: false });
  await m.search("history");
  assert.strictEqual(m.breadthCalls().length, 1);
  await m.search("history");
  assert.strictEqual(m.breadthCalls().length, 2, "a failure must not be remembered as an answer");
});

test("the cache is bounded, and overflowing it clears rather than growing without limit", async () => {
  /* A session tab is long-lived and every distinct query text is a new key, so
     an unbounded Map here is a slow leak. Wholesale clear on overflow rather
     than LRU eviction, following `SEARCH_CACHE_MAX`/`searchCache` in the same
     file: every entry is a pure function of its key and cheap to rebuild, so
     the bookkeeping an LRU needs would buy nothing.

     Driven against the cache directly rather than through 200 real searches —
     the claim is about the bound, and 200 debounced round trips would make
     this a slow test about the harness.

     MUTATION: delete the `if (showBreadthQueryCache.size >= SHOW_BREADTH_CACHE_MAX)
     showBreadthQueryCache.clear();` line. The size grows past the cap and the
     assertion below fails. */
  const m = mount();
  const max = m.evalIn("SHOW_BREADTH_CACHE_MAX");
  assert.strictEqual(typeof max, "number");
  m.evalIn(`for (let i = 0; i < ${max} - 1; i++) showBreadthQueryCache.set("filler-" + i, []);`);
  assert.strictEqual(m.evalIn("showBreadthQueryCache.size"), max - 1);
  await m.search("history");
  assert.strictEqual(m.evalIn("showBreadthQueryCache.size"), max, "the last entry before the cap still fits");
  await m.search("radiolab");
  assert.strictEqual(m.evalIn("showBreadthQueryCache.size"), 1,
    "at the cap the cache clears wholesale and starts again with the new entry");
});

test("the cache is session-scoped memory, never persisted to localStorage", async () => {
  /* The catalogue refreshes nightly, so a cached result that outlived the tab
     would be a stale answer with no way to notice. It is also search text,
     which docs/legal/privacy-policy.md §2 now discloses is sent — but sent is
     not the same as STORED, and the policy says nothing is stored against
     you. Writing queries to localStorage would quietly make that false.

     MUTATION: persist `showBreadthQueryCache` under a `cp_` key on every
     write. The localStorage sweep below finds the query text and this goes
     red. */
  const m = mount();
  await m.search("history");
  const dump = m.evalIn("JSON.stringify(Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])))");
  assert.ok(!dump.includes("history"), `search text reached localStorage: ${dump}`);
});


/* ==================================================================== */
/* S-05, THE EPISODE HALF (finding 4, client audit 2026-09-12)           */
/* ==================================================================== */

/* The shows half shipped with the hot-query cache, the pre-fetch supersession
   check and the diagnostics row. The episode half — backed by the SLOWER of
   the two endpoints — got none of the three and fired on every debounce tick.
   These are the same three claims as above, asserted against it. */

test("a repeat of an identical query fires ZERO episode requests", async () => {
  /* The same acceptance line as the shows half, on the endpoint where it costs
     more. MUTATION: remove the `episodeSearchQueryCache.get(cacheKey)` lookup
     from `renderEpisodeSearchResults`. The second search fires a second
     request and the count below is 2. */
  const m = mount({ episodes: [{ show_id: "1000001", show_title: "Deep History Hour", title: "The First Fire", guid: "g1", audio_url: "https://x.test/a.mp3", duration_seconds: 1800 }] });
  await m.search("history");
  assert.strictEqual(m.episodeCalls().length, 1);
  assert.ok(m.byId.get("ep-search-results").innerHTML.includes("The First Fire"), "the first answer painted");
  await m.search("history");
  assert.strictEqual(m.episodeCalls().length, 1, "the second identical query must not reach the network");
  assert.ok(m.byId.get("ep-search-results").innerHTML.includes("The First Fire"),
    "and the cached answer must still paint — a cache that renders nothing is a regression, not a saving");
});

test("the episode cache is keyed on the normalized query, is bounded, and is two entries for two queries", async () => {
  /* One test for the three properties the shows cache's own suite states
     separately, because the code is the same code and the point here is that
     it IS the same code rather than a second convention.

     MUTATION: key on the raw `query` — the case/space variants miss and the
     count goes to 3. MUTATION: delete the `>= EPISODE_SEARCH_CACHE_MAX` clear
     — the size assertion goes red. */
  const m = mount();
  await m.search("history");
  await m.search("History");
  await m.search("  HISTORY  ");
  assert.strictEqual(m.episodeCalls().length, 1, "case and surrounding space are one question");
  await m.search("radiolab");
  assert.strictEqual(m.episodeCalls().length, 2, "and two different queries are two entries");

  const max = m.evalIn("EPISODE_SEARCH_CACHE_MAX");
  assert.strictEqual(typeof max, "number");
  m.evalIn(`for (let i = 0; i < ${max} - 1; i++) episodeSearchQueryCache.set("filler-" + i, { episodes: [] });`);
  await m.search("a fresh query at the cap");
  assert.strictEqual(m.evalIn("episodeSearchQueryCache.size"), 1,
    "at the cap the cache clears wholesale and starts again with the new entry");
});

test("a FAILED episode fetch is not cached, so a later identical query retries", async () => {
  /* `fetchApiJson` swallows a network error to `null`, which at the call site
     is indistinguishable from "the endpoint answered with nothing". Caching
     that would turn one tunnel into a permanently empty Episodes section for
     that query for the rest of the session.

     MUTATION: cache the response unconditionally rather than inside `if (data)`.
     The second attempt is served the non-answer and the count stays at 1. */
  const m = mount({ episodesOk: false });
  await m.search("history");
  assert.strictEqual(m.episodeCalls().length, 1);
  await m.search("history");
  assert.strictEqual(m.episodeCalls().length, 2, "a failure must not be remembered as an answer");
});

test("the episode endpoint is not asked at all once a newer query owns the page", async () => {
  /* The pre-fetch supersession check. The token was checked only on the
     RESPONSE, so a superseded tick still spent the whole round trip — on a
     phone, on the slower endpoint, once per keystroke that outran the
     debounce. The shows half's own section has done this since S-05.

     Driven at the function rather than through the keyboard, because what is
     being asserted is precisely that nothing happens: a stale token is handed
     in and the network must stay untouched.

     MUTATION: delete the `if (myToken !== showSearchToken) { report(...); return; }`
     line above the fetch. The request fires and the count below is 1. */
  const m = mount();
  const before = m.episodeCalls().length;
  m.evalIn("renderEpisodeSearchResults('history', showSearchToken - 1)");
  await sleep(20);
  assert.strictEqual(m.episodeCalls().length - before, 0,
    "a superseded pass must not pay for a round trip whose answer it will throw away");
});

/* ==================================================================== */
/* The record measures every slow half (findings 2 + 4)                 */
/* ==================================================================== */

test("ONE search record carries the episode endpoint AND the playlist CTA's scan, not only the shows half", async () => {
  /* FINDING 2: `createPlaylistCtaHtml` runs the same 1.3-8 s
     `searchWithRelaxation` scan `buildPlaylist` does, and it ran behind a
     `setTimeout(0)` — one paint turn, then the main thread blocked for
     seconds on the COMMON path (a show-name query matching no playlist). It
     was invisible in the record built to measure search, because `painted_ms`
     was stamped from the local pass and the record was closed before the scan
     ever ran.

     FINDING 4: the episode endpoint was in no record at all.

     Both are now fields of the ONE entry, which is why the record is written
     when the LAST half answers rather than when the shows half does.

     MUTATION: drop `ctaMs`/`epMs` from the object `runShowSearchCostly`
     builds, or write the record from the breadth branch again. The field
     assertions go red. MUTATION: call `settle` twice from one half — the
     "exactly one" assertion goes red. */
  const m = mount();
  await m.search("a query no playlist matches");
  await sleep(30);
  assert.strictEqual(m.records.length, 1, `exactly one record per completed search, got ${m.records.length}`);
  const r = m.records[0];
  assert.ok(Number.isFinite(r.ctaMs), `the CTA's scan is measured, got ${r.ctaMs}`);
  assert.ok(Number.isFinite(r.epMs), `the episode endpoint is measured, got ${r.epMs}`);
  assert.ok(Number.isFinite(r.netMs) && Number.isFinite(r.localMs) && Number.isFinite(r.paintedMs),
    "and the three that were already there are still there");
  assert.strictEqual(r.qLen, "a query no playlist matches".length);
  assert.ok(!Object.values(r).some((v) => typeof v === "string" && v.includes("playlist")),
    "query LENGTH, never the query text — S-01's rule, restated where the fields grew");
});

test("the CTA's scan is scheduled through the idle queue, and the record still lands without one", async () => {
  /* `setTimeout(fn, 0)` buys ONE paint turn and then runs on the very next
     task; `requestIdleCallback` waits for a frame with room in it and carries
     a deadline. `init()` has primed the search vocabulary that way since the H
     bug — this is that idiom, named as `whenIdle` and used by the search tick.

     TWO CLAIMS, because the fallback is the path this harness is on: the
     helper PREFERS `requestIdleCallback` when the host has one (asserted by
     installing a spy), and a host without one still completes the search
     (this whole suite, which has no `requestIdleCallback` at all).

     MUTATION: call `setTimeout(..., 0)` directly again in
     `renderPlaylistSearchResults`. The spy below is never called and this
     goes red. */
  const m = mount();
  const idleCalls = [];
  m.ctx.requestIdleCallback = (fn, opts) => { idleCalls.push(opts); return setTimeout(fn, 0); };
  await m.search("another query no playlist matches");
  await sleep(30);
  assert.ok(idleCalls.length >= 1, "the scan went through requestIdleCallback");
  assert.ok(idleCalls.every((o) => o && Number.isFinite(o.timeout)),
    "with a deadline, so a permanently busy thread does not mean never");
  assert.strictEqual(m.records.length, 1, "and the record still lands");
});
