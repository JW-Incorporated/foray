/* S-02 + S-03's load path (docs/search-plan.md): the Shows search filters LIVE
 * as you type, and the expensive half of it does not.
 *
 * THE COMPLAINT THIS ANSWERS, verbatim (founder feedback F2, 2026-09-04):
 * "Shows search should filter live as you type. Hitting Go should not be
 * required."
 *
 * WHY THIS IS NOT A TWO-LINE CARD, and therefore why this suite is not a
 * two-line suite. docs/search-plan.md §1.5 measured what ONE submit already
 * costs: the breadth endpoint (0.4-1.1 s), a SECOND network call to
 * `api/episodes/search`, and a playlist CTA that defers `topicSearchStatus()`
 * — a relaxation scan this repo's own source measures at 1.3-8 s on a cold
 * cache. Binding `input` naively would have multiplied all three by the
 * keystroke. So the split is the design:
 *
 *   keystroke  -> local pass only (curated 220 + the index's prefix answer)
 *   +250 ms    -> the index scan, the breadth endpoint, the episode endpoint,
 *                 the playlist section
 *   submit     -> the same, with the debounce skipped
 *   focus      -> S-03's index, fetched lazily, once
 *
 * Every test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub from test/show-search.test.js, extended with
 * elements that record `input`/`focus`/`submit` handlers so a test can fire
 * them. Duplicated rather than imported, for the reason that file's own header
 * gives: each of these suites needs its own element set and its own fetch
 * recorder, and a shared harness would grow a flag per suite.
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

/* The debounce this suite is about, restated rather than imported: app.js's
   constant is module-scoped inside the vm context, and a test that read it
   from there could not catch the constant itself being changed. 250 ms is the
   number S-02 specifies and the number the show page's episode search already
   uses; WAIT is comfortably past it on a loaded CI runner. */
const DEBOUNCE_MS = 250;
const WAIT = 420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEl(tag) {
  const handlers = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    handlers,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
    /* Fires the handler app.js actually attached, or throws — a test that
       silently no-ops because the binding was never made would be the exact
       vacuous green this suite exists to prevent. */
    fire(type, evt) {
      const fn = handlers.get(type);
      if (!fn) throw new Error(`no ${type} handler is bound to #${this.id}`);
      return fn(evt || { preventDefault() {} });
    },
    bound(type) { return handlers.has(type); },
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

const SHOWS = [
  { show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null },
  { show_id: "radiolab", title: "Radiolab", artwork_url: null },
  { show_id: "science-friday", title: "Science Friday", artwork_url: null },
];

/* A small, REAL-SHAPED index: four tab-separated columns, sorted by lowercased
   title in code-unit order, exactly as tools/build-show-index.mjs emits. Two
   breadth rows the curated set does not have, so a test can prove the index
   added something the 220 could not. */
const INDEX_TSV = [
  "Deep History Hour\t1000001\t12\t0",
  "Lex Fridman Podcast\tlex-fridman-podcast\t\t1",
  "Radiolab\tradiolab\t\t1",
  "Science Friday\tscience-friday\t\t1",
  "Sciencey Things Weekly\t1000002\t44\t0",
  "",
].join("\n");

/** `{ ctx, byId, calls }` — `calls` is every URL the page asked for, in order. */
function mount({ indexBody = INDEX_TSV, indexOk = true, breadth = [] } = {}) {
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
    if (u.includes("show-index.tsv")) {
      return Promise.resolve({ ok: indexOk, status: indexOk ? 200 : 504, text: () => Promise.resolve(indexBody) });
    }
    if (u.includes("api/shows/search")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ shows: breadth, degraded: false }) });
    }
    if (u.includes("api/episodes/search")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ episodes: [] }) });
    }
    return new Promise(() => {}); // anything else hangs rather than resolving something invented
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
  state.catalog = { shows: SHOWS };
  state.discover = { items: [] };
  state.cardSlots = [];
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  ctx.renderAllShows();

  const input = byId.get("sh-input");
  const type = (text) => { input.value = text; return input.fire("input"); };
  return {
    ctx, byId, calls, state, input, type,
    apiCalls: () => calls.filter((u) => u.includes("/api/")),
    indexCalls: () => calls.filter((u) => u.includes("show-index.tsv")),
    results: () => byId.get("sh-results"),
    note: () => byId.get("sh-note"),
  };
}

test("a keystroke repaints local results and fires ZERO fetches", () => {
  /* THE CARD'S HEADLINE. Typing must be answered from memory. Asserted as a
     fetch COUNT rather than as "no breadth results appeared", because the
     latter would stay green if the request had been sent and simply not
     answered yet — which is the failure we are preventing, not the one we are
     tolerating.

     Synchronous on purpose: no `await` between the keystroke and the
     assertions, so a fetch fired on a microtask would still be counted.

     MUTATION: move `runShowSearchCostly` out of the `setTimeout` in
     `onShowSearchInput` and call it directly. `calls.length` becomes 2 and
     this goes red. */
  const m = mount();
  /* A DELTA, not an absolute count: mounting the page can legitimately start
     app.js's own boot fetches (`data/session.json`), which have nothing to do
     with the search box. Asserting `calls` was empty would make this test
     about app.js's boot sequence and it would rot the first time that
     changed. */
  const before = m.calls.slice();
  m.type("lex");
  assert.deepStrictEqual(m.calls, before, "a keystroke must not touch the network");
  assert.deepStrictEqual(m.apiCalls(), []);
  assert.deepStrictEqual(m.indexCalls(), []);
  assert.strictEqual(m.results().hidden, false);
  assert.ok(m.results().innerHTML.includes("Lex Fridman Podcast"));
});

test("ten keystrokes inside the debounce window produce exactly ONE costly pass", async () => {
  /* S-02's acceptance line: "a 10-keystroke burst typed at 50 ms intervals
     produces exactly one debounced pass and at most one in-flight request at
     any instant."

     Typed at 20 ms here rather than 50 ms, so the whole burst (200 ms) fits
     inside one 250 ms window on a slow runner too — the claim being tested is
     "the timer is cancelled and restarted", and a burst that straddled the
     window would be testing the runner's scheduler instead.

     MUTATION (the one the card names): drop the `clearTimeout` from
     `onShowSearchInput`. Ten timers survive, ten costly passes fire, and the
     count below is 20 calls instead of 2. */
  const m = mount();
  const word = "lex fridman";
  for (let i = 1; i <= 10; i++) {
    m.type(word.slice(0, i));
    await sleep(20);
  }
  assert.deepStrictEqual(m.apiCalls(), [], "nothing may have fired while the query was still changing");
  await sleep(WAIT);
  const shows = m.apiCalls().filter((u) => u.includes("api/shows/search"));
  const eps = m.apiCalls().filter((u) => u.includes("api/episodes/search"));
  assert.strictEqual(shows.length, 1, `expected one breadth call, got ${JSON.stringify(shows)}`);
  assert.strictEqual(eps.length, 1, `expected one episode call, got ${JSON.stringify(eps)}`);
  assert.ok(shows[0].includes(`q=${encodeURIComponent(word.slice(0, 10))}`),
    "the one call that fires must carry the LAST query typed, not the first");
});

test("Enter/submit runs the costly passes immediately, with no debounce wait", async () => {
  /* The Go button and Enter both land here (G2's default: the affordance
     survives, the REQUIREMENT does not — the button is now "search now, skip
     the debounce"). Asserted by firing submit and checking the network was
     touched before the debounce window could possibly have elapsed.

     MUTATION: make the submit handler call `onShowSearchInput` instead of
     `renderShowSearchResults`. The assertion immediately after submit finds
     zero calls and this goes red. */
  const m = mount();
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(0);
  const shows = m.apiCalls().filter((u) => u.includes("api/shows/search"));
  assert.strictEqual(shows.length, 1, "submit must not wait for the debounce");
  assert.ok(m.results().innerHTML.includes("Radiolab"));
});

test("clearing the query returns the page to its unfiltered A-Z list, not to an empty results box", async () => {
  /* S-02's own acceptance line, and it is a real regression risk: the honest
     empty state ("No shows match X") is right for a query that matched
     nothing and wrong for a query the listener just deleted. The A-Z list is
     still in the page underneath, so "restore it" means hiding the results
     block and the note rather than re-rendering anything.

     MUTATION: drop the `if (!query) { clearShowSearchResults(); return; }`
     branch from `onShowSearchInput`. `paintShowResults` then paints the
     "No shows match" note for an empty query and the `note.hidden`
     assertion fails. */
  const m = mount();
  m.type("lex");
  assert.strictEqual(m.results().hidden, false);
  m.type("");
  assert.strictEqual(m.results().hidden, true, "the results block must be hidden again");
  assert.strictEqual(m.note().hidden, true, "no 'no shows match' note for a query that no longer exists");
  assert.strictEqual(m.note().textContent, "");
  assert.strictEqual(m.byId.get("ep-search-results").hidden, true);
  assert.strictEqual(m.byId.get("pl-search-results").hidden, true);
  await sleep(WAIT);
  assert.deepStrictEqual(m.apiCalls(), [], "clearing the box must not schedule a costly pass either");
});

test("the playlist CTA's 1.3-8 s topic scan never runs while the query is still changing", async () => {
  /* §1.5 measured `topicSearchStatus()` at 1.3-8 s on a cold cache, and
     `renderPlaylistSearchResults` defers it behind a `setTimeout(0)` for
     exactly that reason. Running it per keystroke would freeze the page
     mid-word — the most visible possible failure of this card.

     Asserted through the section it paints: while the query is changing,
     `#pl-search-results` must stay empty, because the only thing that writes
     it is the costly pass.

     MUTATION: call `renderPlaylistSearchResults` from `paintShowSearchLocal`.
     The section is written on the first keystroke and this goes red. */
  const m = mount();
  for (const q of ["s", "sc", "sci", "scie"]) { m.type(q); await sleep(20); }
  assert.strictEqual(m.byId.get("pl-search-results").innerHTML, "",
    "the playlist section must not be touched by a keystroke");
  await sleep(WAIT);
  assert.strictEqual(m.apiCalls().filter((u) => u.includes("api/episodes/search")).length, 1);
});

test("the show index is fetched ZERO times before the search box is focused, and once after", async () => {
  /* S-03's acceptance line. The decode is ~113 ms measured; on `init()` that
     is a stall for a listener who came to press play and never searches. Once,
     not once-per-focus: `loadShowIndex` returns the in-flight promise while it
     is loading and the resolved index afterwards.

     MUTATION: call `loadShowIndex()` from `renderAllShows` instead of from the
     focus handler. The first assertion finds one call and goes red. */
  const m = mount();
  assert.deepStrictEqual(m.indexCalls(), [], "rendering the page must not fetch the index");
  m.type("lex");
  assert.deepStrictEqual(m.indexCalls(), [], "typing must not fetch the index either");

  m.input.fire("focus");
  m.input.fire("focus");
  m.input.fire("focus");
  await sleep(10);
  assert.strictEqual(m.indexCalls().length, 1, "three focuses, one fetch");
  m.input.fire("focus");
  await sleep(10);
  assert.strictEqual(m.indexCalls().length, 1, "a focus after the index resolved must not refetch");
});

test("once the index has loaded, a keystroke finds shows the curated 220 do not contain — still with no fetch", async () => {
  /* The product point of S-03, asserted end to end: "Deep History Hour" is in
     the index and not in `state.catalog.shows`, and it must appear from a
     KEYSTROKE, not from the endpoint.

     MUTATION: make `localShowMatches` ignore `showIndex` and always return
     `SearchEngine.searchShows(query, curated)`. "Deep History Hour" never
     appears on a keystroke and this goes red. */
  const m = mount();
  m.input.fire("focus");
  await sleep(10);
  const before = m.calls.length;
  m.type("deep");
  assert.strictEqual(m.calls.length, before, "the index pass is local — no fetch");
  assert.ok(m.results().innerHTML.includes("Deep History Hour"),
    `expected an index-only show, got ${m.results().innerHTML}`);
});

test("an index that 504s is not an error the listener sees: the curated pass still answers", async () => {
  /* This repo's "absence is a real state" rule applied to a file that is by
     construction an optimisation. An unpinned data fetch can legitimately come
     back 504 from sw.js when the origin is unreachable and nothing is cached.

     MUTATION: make `loadShowIndex` reject (or set `showIndex` to the empty
     parse) on a non-ok response. The search box goes dead and the "Radiolab"
     assertion fails. */
  const m = mount({ indexOk: false });
  m.input.fire("focus");
  await sleep(10);
  m.type("radiolab");
  assert.strictEqual(m.results().hidden, false);
  assert.ok(m.results().innerHTML.includes("Radiolab"));
  assert.strictEqual(m.note().hidden, true);
});

test("the index landing mid-query repaints the list already on screen", async () => {
  /* The seam between the two: a listener who typed before the index resolved
     would otherwise keep the 220-show answer until their next keystroke, which
     on a short query may never come.

     MUTATION: delete the `repaintShowSearchForIndex()` call from
     `loadShowIndex`. The results block still shows only the curated answer
     and this goes red. */
  const m = mount();
  m.type("sci");
  assert.ok(!m.results().innerHTML.includes("Sciencey Things Weekly"));
  m.input.fire("focus");
  await sleep(10);
  assert.ok(m.results().innerHTML.includes("Sciencey Things Weekly"),
    "the index arriving must improve the list already painted");
});

test("a breadth result from the endpoint is cached for showById, so tapping it resolves", async () => {
  /* Unchanged behaviour, re-pinned because S-02 moved the code that does it.
     `state.breadthShowCache` is what lets `#/show/:id` render for a show that
     is not in the curated catalogue, and the merge loop that seeds it now
     lives in `runShowSearchCostly`.

     MUTATION: move the `state.breadthShowCache[...] = s` assignment inside the
     `if (seen.has(...)) continue;` guard — a show already shown by the index
     pass would then never be seeded, and tapping it would say "Show not
     found." The second assertion goes red. */
  const m = mount({ breadth: [
    { show_id: "1000001", title: "Deep History Hour", artwork_url: null, tier: "breadth" },
    { show_id: "radiolab", title: "Radiolab", artwork_url: "https://x.test/a.jpg", tier: "curated" },
  ] });
  m.input.value = "history";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  assert.ok(m.state.breadthShowCache["1000001"], "a new breadth show must be seeded for showById");
  assert.ok(m.state.breadthShowCache["radiolab"],
    "a show already on screen must be seeded too — its endpoint record is the richer one");
});
