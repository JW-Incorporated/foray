/* REACH: can the device answer with a row it is already holding?
 *
 * WHY THIS SUITE EXISTS, AND WHY IT IS SEPARATE
 * `test/show-index.test.js` covers `scanShowIndex` in isolation — it proves
 * the scan FINDS things. `test/show-search-ranking.test.js` covers the
 * comparator — it proves found things are ORDERED well. Neither one runs the
 * app, so neither one could see the defect this suite was written for: the
 * scan was correct, the ranking was correct, and app.js simply did not CALL
 * the scan, so a `chart_rank` 1 show sitting in the committed index was absent
 * from the client's answer at any position.
 *
 * Nothing in the suite would have gone red if the gate at that call site had
 * been deleted or inverted. `test/show-search-fallthrough.test.js` names the
 * constant (`SHOW_PREFIX_UNDERDELIVERS_BELOW`) only as a counterexample for a
 * DIFFERENT gate, the directory pass's. This suite closes that hole from the
 * outside: type a query, look at what is on the page, with no endpoint
 * answering at all.
 *
 * THE CORPUS IS THE COMMITTED `data/show-index.tsv`, NOT A FIXTURE, and that
 * is the point rather than an accident. A fixture proves the wiring; only the
 * real file can answer "is The Daily reachable from what the phone downloaded
 * on its last visit", which is the founder-visible question. The cost is that
 * a data refresh can move these numbers, so every assertion below is written
 * against a PROPERTY (this row is present / absent) with its own premise
 * guard, never against a rank that a new chart cut could shift.
 *
 * NO ENDPOINT ANSWERS ANYWHERE IN THIS FILE. Every `/api/` request the page
 * makes is left hanging, exactly as it would be on a plane or in the ~250 ms +
 * RTT window before the first response lands. Anything that appears on the
 * page therefore came from `data/show-index.tsv` and the curated catalogue and
 * from nowhere else.
 *
 * Every test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub from test/show-search-fallthrough.test.js,
 * reduced to what this file needs (no directory fixtures, no delays) and
 * pointed at the real index. Duplicated rather than imported, for the reason
 * that file's own header gives.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const REAL_INDEX = fs.readFileSync(path.join(ROOT, "data", "show-index.tsv"), "utf8");
const REAL_CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8"));

process.on("unhandledRejection", () => {});

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

/** Mounts app.js over the REAL committed index with every `/api/` request left
    unanswered. Returns the handful of accessors these tests need. */
function mount({ indexBody = REAL_INDEX } = {}) {
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
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(indexBody) });
    }
    /* EVERYTHING ELSE HANGS. Not an error, not an empty answer: a hang is the
       only shape that cannot be mistaken for "the endpoint contributed
       nothing", because `fetchApiJson` turns an error into `null` and app.js
       has a documented repaint path for that. A promise that never settles
       leaves the painted list provably local. */
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
  state.catalog = { shows: REAL_CATALOG.shows };
  state.discover = { items: [] };
  state.cardSlots = [];
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  ctx.renderAllShows();

  const input = byId.get("sh-input");
  return {
    ctx, byId, calls, state, input,
    evalIn: (src) => vm.runInContext(src, ctx),
    results: () => byId.get("sh-results"),
    apiCalls: () => calls.filter((u) => u.includes("/api/")),
    /** Loads the index, types `q`, and runs the costly pass, all locally. */
    async search(q) {
      input.fire("focus");
      await sleep(20);
      input.value = q;
      byId.get("sh-form").fire("submit");
      return this.results().innerHTML;
    },
  };
}

/* The row the whole defect is about: in the committed index, not curated, and
   a WORD-START match for "daily" rather than a prefix one — so the prefix pass
   cannot return it at any position and only the scan can. */
const THE_DAILY = { title: "The Daily", show_id: "1200361736" };

test("a broad query reaches a word-start row the device is already holding: The Daily, from the committed index, with no endpoint", async () => {
  /* THE TEST THAT WOULD HAVE CAUGHT IT. Measured 2026-09-13 over the committed
     data/show-index.tsv: `daily` returns 25 rows from curated + the prefix
     pass, so the old gate (`shown().length < SHOW_PREFIX_UNDERDELIVERS_BELOW`)
     skipped the index scan, and The Daily — `chart_rank` 1, `show_id`
     1200361736, physically present in the file the phone already downloaded —
     was absent from the client's answer ENTIRELY. With the scan it is 17 of
     218. The 17 is P-10's ranking gap and is not what this asserts; the
     absence is a REACH gap and is.

     Nothing is mocked away here: the corpus is the committed file and no
     endpoint ever answers, so a pass means the device could answer this query
     on a plane.

     MUTATION: restore `if (showIndex && shown().length < SHOW_PREFIX_UNDERDELIVERS_BELOW)`
     at the scan's call site in `runShowSearchCostly`, or any other gate keyed
     on how many rows the local pass already produced. `daily` produces 25, the
     scan never runs, and this goes red — which is exactly the state main was
     in before this change. */
  const m = mount();
  const html = await m.search("daily");
  assert.ok(html.includes(THE_DAILY.title),
    "The Daily must be on screen from local data alone");
  assert.ok(html.includes(`#/show/${THE_DAILY.show_id}`),
    `and it must be the committed row ${THE_DAILY.show_id}, not some other show whose title contains the words`);
});

test("the premise the test above rests on: `daily` really does deliver enough local rows to trip the old count gate", async () => {
  /* A GUARD AGAINST A VACUOUS GREEN. If a future index refresh dropped the
     "Daily…" rows, `daily` would fall under ten local hits, the old gate would
     have run the scan anyway, and the test above would pass without proving
     anything at all. This asserts the fixture's own premise instead of
     assuming it: the local pass alone clears `SHOW_PREFIX_UNDERDELIVERS_BELOW`,
     which is what made the scan skippable in the first place.

     It also pins the SHAPE of the defect rather than its size — `>=`, not
     `=== 25` — so a data refresh that changes the count by a few rows does not
     turn a still-true statement red.

     MUTATION: have the local pass return fewer than ten rows for `daily` (for
     instance by dropping the prefix pass out of `localShowMatches`). This goes
     red and says plainly that the test above is no longer testing the gate. */
  const m = mount();
  m.input.fire("focus");
  await sleep(20);
  const localRows = m.evalIn('localShowMatches("daily").length');
  const oldGate = m.evalIn("SHOW_PREFIX_UNDERDELIVERS_BELOW");
  assert.ok(localRows >= oldGate,
    `the old gate only suppressed the scan when the local pass was full: got ${localRows} local rows against a gate of ${oldGate}`);
  const prefixOnly = m.evalIn('SearchEngine.prefixSearchShows("daily", showIndex).map(s => s.title)');
  assert.ok(!prefixOnly.includes(THE_DAILY.title),
    "and The Daily must be unreachable by the prefix pass — if it were a prefix hit there would be no reach gap to fix");
});

test("a second query, so the fix cannot be one show deep: Hardcore History from the index alone", async () => {
  /* `history` is the other shape of the same defect: 14 prefix hits, 25 local
     rows, the scan skipped, and 93 word-start rows unreachable — among them
     Dan Carlin's Hardcore History, which is a word-start match and not a
     prefix one. The listener still SAW it before this change because it is
     also one of the curated 220; what they could not see was the other 82 rows
     the index holds, and what an off-network device could not reach was the
     index's copy at all.

     Asserting a second, differently-shaped query is what stops a fix that
     special-cases one title or one query string from passing.

     MUTATION: gate the scan on anything about the local hit count. `history`
     paints 25 local rows, the scan never runs, and the word-start rows below
     never arrive. */
  const m = mount();
  const html = await m.search("history");
  assert.ok(html.includes("Hardcore History"),
    "a word-start row must be reachable for `history` too, from local data alone");
  const rows = (html.match(/href="#\/show\//g) || []).length;
  assert.ok(rows > 25,
    `the scan must widen the answer beyond the local pass's own rows: got ${rows}`);
});

test("no endpoint contributed any of it — the rows above are provably the committed index", async () => {
  /* THE PROVENANCE ASSERTION, separate because the three tests above would all
     still pass if some endpoint had quietly answered. Every `/api/` request in
     this harness hangs forever, so `state.breadthShowCache` — the only place
     an endpoint row is ever recorded — must be empty when the page is showing
     The Daily.

     MUTATION: have the harness answer `api/shows/search` with a row for The
     Daily. The first test goes green for the wrong reason and this one goes
     red, which is the pairing that makes "from local data alone" a claim
     rather than a hope. */
  const m = mount();
  const html = await m.search("daily");
  assert.ok(html.includes(THE_DAILY.title), "premise: the row is on screen");
  assert.ok(m.apiCalls().length > 0, "premise: the page did ask the endpoints (they simply never answer)");
  assert.strictEqual(Object.keys(m.state.breadthShowCache || {}).length, 0,
    "no endpoint row was ever merged, so everything on screen came from data/show-index.tsv and the curated catalogue");
});

test("the scan is gated on COST: a two-character query does not pay for it", async () => {
  /* THE OTHER HALF OF THE CHANGE, and the half a "just delete the gate" fix
     would have got wrong. The scan's cost tracks its HIT COUNT, and measured
     on the committed index (2026-09-13, 15 reps per query, forced GC between
     them, worst case over the highest-hit substrings of real titles) the
     one-character worst case is 331 ms median / 473 ms p95 (`l`, 5,332 hits)
     and the two-character worst case is 220 ms median (`e `, 8,517 hits),
     against 139 ms median / 319 ms p95 at three characters (`dcast `). Three
     is the only floor that keeps the debounce tick under `l`'s ~500 ms on both
     statistics, and it costs nothing in reach because every query in the
     measured defect is five characters or more.

     `da` is a word-start match for "The Daily" — with no floor the scan would
     return it — so its ABSENCE here is the floor, observed from outside.

     MUTATION: lower `SHOW_SCAN_MIN_QUERY_LENGTH` to 1 or 2, or drop the floor
     and scan unconditionally. `da` starts returning word-start rows and this
     goes red, having just re-admitted a third of a second of main-thread work
     to the second keystroke of every search. */
  const m = mount();
  const html = await m.search("da");
  assert.ok(!html.includes(`#/show/${THE_DAILY.show_id}`),
    "a two-character query must not pay for the scan — it is the most expensive length and the least useful");
  assert.strictEqual(m.evalIn("SHOW_SCAN_MIN_QUERY_LENGTH"), 3,
    "the floor is 3, derived from the cost table above and not a round number someone liked");
});
