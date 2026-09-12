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

function mount({ breadthOk = true } = {}) {
  const calls = [];
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
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ episodes: [] }) });
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
    ctx, byId, calls, state, search,
    evalIn: (src) => vm.runInContext(src, ctx),
    breadthCalls: () => calls.filter((u) => u.includes("api/shows/search")),
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
