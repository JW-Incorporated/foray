/* S-06 (docs/search-plan.md) + P-02 (docs/search-parity-plan.md): the Apple
 * DIRECTORY PASS, and a breadth show page that survives a reload.
 *
 * TWO HALVES OF ONE CARD, and they share a card because they share one
 * endpoint change (`api/shows/search.ts`). This suite is the CLIENT side of
 * both; the server side is `api/test/shows-search-apple.test.mjs`.
 *
 * (a) THE DIRECTORY PASS. S-06 shipped this as a LAST RESORT behind two gates:
 *     the client asked only when its own local pass found nothing, and the
 *     endpoint called Apple only when the full 19,904-row merged catalogue
 *     also found nothing. P-02 replaced both with a SECOND PASS, and this
 *     suite is where the reversal is pinned, because the old tests asserted
 *     the old gate in both directions and a change that only edited the source
 *     would have gone red for the right reason and been "fixed" by loosening
 *     them.
 *
 *     WHAT REPLACED THE GATE, and every clause is a measurement rather than a
 *     preference (docs/search-parity-plan.md §4 P-02, measured 2026-09-12 over
 *     25 listener queries against the live endpoint and Apple's directory):
 *
 *       - The directory is asked on EVERY debounced search of >= 3 characters.
 *         No threshold on how many local rows there were, and none on how
 *         strong they were. All 25 queries gained rows (min +2, median +17,
 *         max +25); there is no query where the local pass was enough.
 *       - A count threshold is not merely unnecessary, it is BACKWARDS at the
 *         lengths that matter. `tim` returns ten strong local matches and not
 *         one of them is The Tim Ferriss Show, which Apple returns at #5. A
 *         threshold of ten — the value already in app.js as
 *         `SHOW_PREFIX_UNDERDELIVERS_BELOW` — suppresses exactly the show the
 *         listener meant, BECAUSE the local pass delivered plenty.
 *       - The local list paints first and never waits for either request, and
 *         a directory pass that fails or times out leaves it exactly as it
 *         was. Both are asserted below rather than argued.
 *       - The directory's rows are deduped by `apple_collection_id` (which IS
 *         the Apple row's `show_id`) AND by normalised title. Apple returns
 *         the same show under several collection ids — `lex fridman` returns
 *         three rows all titled "Lex Fridman Podcast" — so the title half is
 *         the half doing the work on that query, not belt-and-braces.
 *
 * (b) LINKABILITY (#560 item 7, requirements §6.8). `state.breadthShowCache`
 *     is in-memory and populated only by a search response THIS session, so a
 *     cold open on `#/show/1234567890`, a shared link, a reload or a restored
 *     tab rendered "Show not found." — every way of reaching a breadth show
 *     except "I just searched for it".
 *
 * Every test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub from test/show-search-live.test.js, extended
 * with an `id=` response and an optional delay so the navigated-away case can
 * be driven. Duplicated rather than imported, for the reason that file's own
 * header gives.
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

/** `{ ctx, byId, calls }` — `calls` is every URL the page asked for, in order.

    P-02 split one show request into two, so the harness answers them
    separately: `breadth` is what the CATALOGUE pass returns and `directory` is
    what the pass carrying `fallthrough=1` returns. `directoryOk: false` makes
    the directory request a non-ok response (which `fetchApiJson` resolves to
    `null`), and `directoryDelayMs` holds it in flight. */
function mount({
  indexBody = INDEX_TSV, indexOk = true, breadth = [], directory = [],
  directoryOk = true, directoryDelayMs = 0, showById = null, idDelayMs = 0,
} = {}) {
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
    if (u.includes("api/shows/search") && u.includes("id=")) {
      const body = { id: "x", show: showById, degraded: false };
      const answer = { ok: true, status: 200, json: () => Promise.resolve(body) };
      return idDelayMs ? new Promise((r) => setTimeout(() => r(answer), idDelayMs)) : Promise.resolve(answer);
    }
    if (u.includes("api/shows/search") && u.includes("fallthrough=1")) {
      if (!directoryOk) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      const answer = {
        ok: true, status: 200,
        json: () => Promise.resolve({
          shows: directory, degraded: false,
          fallthrough: { attempted: true, error: null, cached: false },
        }),
      };
      return directoryDelayMs ? new Promise((r) => setTimeout(() => r(answer), directoryDelayMs)) : Promise.resolve(answer);
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
    catalogueCalls: () => calls.filter((u) => u.includes("api/shows/search") && u.includes("q=") && !u.includes("fallthrough=1")),
    directoryCalls: () => calls.filter((u) => u.includes("api/shows/search") && u.includes("fallthrough=1")),
    evalIn: (src) => vm.runInContext(src, ctx),
    results: () => byId.get("sh-results"),
    note: () => byId.get("sh-note"),
  };
}

test("the directory IS asked when the device already answered — P-02's reversal, in one assertion", () => {
  /* THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the card.
     S-06's version read "the fall-through is NOT asked for when the device
     already answered" and its mutation line was "always append
     `&fallthrough=1` → red". That gate is what docs/search-parity-plan.md §2.1
     measured as "the largest share of still totally sucks": "radiolab" is one
     exact local hit, and Apple holds 21 rows for it of which 18 are new after
     dedup — Dolly Parton's America, Terrestrials, FM Fatale, the WNYC network
     a listener typing "radiolab" is reaching for.

     The catalogue pass must still fire, and must still NOT carry the flag:
     that is the other half of P-02's shape (two requests, so the catalogue's
     118 ms answer is not held behind Apple's 381-561 ms one).

     MUTATION: restore `const fallthrough = shown.length === 0 ? "&fallthrough=1" : ""`
     on the catalogue fetch and delete the directory pass. No request carries
     the flag and this goes red — which is exactly the shape of the no-op this
     card was at risk of shipping. */
  const m = mount();
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  assert.strictEqual(m.catalogueCalls().length, 1, "the catalogue pass must still fire, unflagged");
  assert.strictEqual(m.directoryCalls().length, 1,
    `a local hit must STILL ask the directory: ${JSON.stringify(m.apiCalls())}`);
  assert.ok(m.directoryCalls()[0].includes("q=radiolab"));
});

test("the directory is asked on a genuine local miss too, so the reversal did not simply swap which case is broken", () => {
  /* The other direction, so the test above cannot be satisfied by a client
     that asks the directory only when the local pass found something.

     MUTATION: gate the directory pass on `shown.length > 0`. A query for a
     show in neither catalogue never reaches Apple and this goes red. */
  const m = mount();
  m.input.value = "zzqx-no-such-show-anywhere";
  m.byId.get("sh-form").fire("submit");
  assert.strictEqual(m.directoryCalls().length, 1,
    `a genuine local miss must reach the directory: ${JSON.stringify(m.apiCalls())}`);
});

test("an index-only hit no longer closes the gate: the seam S-03 opened is now asked about too", async () => {
  /* The seam between S-03 and S-06, re-pointed by P-02 rather than deleted.
     "Deep History Hour" is in the index and not in `state.catalog.shows`, so
     S-06 treated it as a local hit and shut the gate. It is still a local hit
     — the row paints from the index with no network at all, asserted below —
     but it is no longer a reason to withhold the directory: the index is the
     `chart_rank <= 100` cut of a US top-chart set, about 0.3% of what a
     listener thinks they are searching (deck §2.3).

     MUTATION: gate the directory pass on `shown.length === 0`. The index hit
     suppresses the directory and the `directoryCalls()` assertion goes red. */
  const m = mount();
  m.input.fire("focus");
  await sleep(10);
  m.input.value = "deep history";
  m.byId.get("sh-form").fire("submit");
  assert.ok(m.results().innerHTML.includes("Deep History Hour"),
    "the index hit still paints locally — that half of S-03 is untouched");
  assert.strictEqual(m.directoryCalls().length, 1, "and the directory is asked anyway");
});

test("TEN strong local matches still ask the directory: the `tim` case, which every threshold gets wrong", async () => {
  /* THE CASE THAT KILLS THE THRESHOLD P-02 WAS ORIGINALLY WRITTEN TO PICK, and
     it is here because it is the one a future "let us add a cheap gate back"
     change would break first, silently, while looking more efficient.

     Measured 2026-09-12: `tim` returns TEN strong local matches over the
     committed index, every one of them a `prefix` match (Timothy Keller
     Sermons, Timcast IRL, Timcast News, Tiny Matters...), and NOT ONE of them
     is The Tim Ferriss Show — which Apple returns at position 5. Strong-match
     COUNT anti-correlates with relevance at short lengths. Ten is also exactly
     `SHOW_PREFIX_UNDERDELIVERS_BELOW`, the constant already in app.js, so the
     obvious cheap gate is the one that breaks this query.

     The fixture reproduces the shape rather than the data: ten index rows that
     all prefix-match "tim", none of which is the show the listener meant.

     MUTATION: gate the directory pass on `shown.length < SHOW_PREFIX_UNDERDELIVERS_BELOW`,
     or on any other count of local hits. Ten local rows suppress the request
     and this goes red. */
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(`Timcast Filler ${i}\t200000${i}\t${i + 1}\t0`);
  const m = mount({
    indexBody: rows.concat([""]).join("\n"),
    directory: [{
      show_id: "863897795", title: "The Tim Ferriss Show", artwork_url: null,
      artist_name: "Tim Ferriss", editorial_note: null, taxonomy_node_ids: [],
      tier: "breadth", source: "apple",
    }],
  });
  m.input.fire("focus");
  await sleep(10);
  m.input.value = "tim";
  m.byId.get("sh-form").fire("submit");
  const localRows = (m.results().innerHTML.match(/href="#\/show\//g) || []).length;
  assert.ok(localRows >= 10, `fixture assumption: ten strong local matches, got ${localRows}`);
  assert.strictEqual(m.directoryCalls().length, 1,
    "ten strong local matches must not buy the listener a suppressed directory");
  await sleep(20);
  assert.ok(m.results().innerHTML.includes("The Tim Ferriss Show"),
    "and the show the listener actually meant must arrive");
});

test("under three characters the directory is not asked at all, and at three it is", async () => {
  /* THE ONLY GATE LEFT, and it is about the QUERY, never about what the local
     pass found. Measured: at 1-2 characters the local pass already returns
     54-450 rows and Apple's answer is noise (`h` -> "Handsome", "Happier"),
     and those are also the only lengths at which the local pass produces
     `substring` matches at all (97 of 450 rows for `h`; ZERO across all 25
     real listener queries). At three the directory is already load-bearing:
     `tim` and `lex` both need it.

     Both directions in one test deliberately — a floor asserted only from
     below is satisfied by never asking, and only from above by always asking.

     MUTATION: drop the `directoryKey.length < SHOW_DIRECTORY_MIN_QUERY_LENGTH`
     branch, or change the 3 to a 1. The two-character query fires a request
     and the first assertion goes red. */
  const m = mount();
  assert.strictEqual(m.evalIn("SHOW_DIRECTORY_MIN_QUERY_LENGTH"), 3);
  m.input.value = "le";
  m.byId.get("sh-form").fire("submit");
  assert.deepStrictEqual(m.directoryCalls(), [], "two characters must not spend an Apple slot");
  assert.strictEqual(m.catalogueCalls().length, 1, "the catalogue pass is not floored — only the directory is");

  m.input.value = "lex";
  m.byId.get("sh-form").fire("submit");
  assert.strictEqual(m.directoryCalls().length, 1, "three characters is where the directory starts earning its keep");
});

test("Apple's duplicate rows collapse by normalised title, not just by collection id", async () => {
  /* Apple returns the same show under several `collectionId`s — measured
     2026-09-12, `lex fridman` returns THREE rows all titled "Lex Fridman
     Podcast" with three distinct ids, which is why its merged ceiling is 3-4
     rows and not the 10 the card's first draft asked for. A dedup by
     `apple_collection_id` alone surfaces all three, one under the other, which
     is worse than the one row the listener had before this card.

     Only rows Apple produced are title-deduped: a catalogue row carries
     artwork, a chart rank and an editorial note that a title collision would
     throw away, and two genuinely different shows can share a title. The
     second half of this test is that boundary.

     MUTATION: delete the `s.source === "apple" && title && seenTitles.has(title)`
     check from `mergeBreadth`. Three identical rows render and the count goes
     to 3. */
  const dupes = ["1", "2", "3"].map((n) => ({
    show_id: `1000000${n}`, title: n === "2" ? "Lex  Fridman Podcast!" : "Lex Fridman Podcast",
    artwork_url: null, artist_name: "Lex Fridman", editorial_note: null,
    taxonomy_node_ids: [], tier: "breadth", source: "apple",
  }));
  const m = mount({ directory: dupes });
  m.input.value = "lex fridman";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  const html = m.results().innerHTML;
  const shown = dupes.filter((d) => html.includes(`href="#/show/${d.show_id}"`));
  assert.strictEqual(shown.length, 0,
    `the curated "Lex Fridman Podcast" already answers this; Apple's copies must collapse into it, got ${shown.map((s) => s.show_id)}`);
  assert.ok(html.includes('href="#/show/lex-fridman-podcast"'), "and the local row is what survives");

  /* The boundary: a CATALOGUE row sharing a normalised title is NOT dropped.
     MUTATION: apply the title dedup to every row rather than to apple rows
     only. This second half goes red. */
  const m2 = mount({ breadth: [{
    show_id: "555555", title: "Radiolab", artwork_url: null, editorial_note: null,
    taxonomy_node_ids: [], tier: "breadth", chart_rank: 140,
  }] });
  m2.input.value = "radiolab";
  m2.byId.get("sh-form").fire("submit");
  await sleep(20);
  assert.ok(m2.results().innerHTML.includes('href="#/show/555555"'),
    "a catalogue row is authoritative about itself and must survive a title collision");
});

test("the local list paints before either request resolves, and a failed directory pass leaves it exactly as it was", async () => {
  /* THE CARD'S TWO NON-NEGOTIABLES IN ONE TEST, because they are the same
     claim from two sides: the directory can only ever ADD.

     `mergeBreadth` appends and re-ranks; there is no path in it that removes a
     row, and `fetchApiJson` resolves `null` on any non-ok response, so a 502,
     a timeout and a rate-limited answer are the same thing here — nothing
     arrives, nothing changes. The directory request is held 60 ms so the
     "painted before" half is a real observation rather than a race.

     MUTATION: have the directory branch call `paintShowResults(query, rows, myToken)`
     instead of `mergeBreadth(rows)` — the shape the old server branch had, where
     Apple REPLACED rather than merged. The failed pass blanks the list and the
     final assertion goes red. */
  const m = mount({ directoryOk: false, directoryDelayMs: 60 });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  const painted = m.results().innerHTML;
  assert.ok(painted.includes("Radiolab"), "the local row is on the page before anything resolves");
  assert.strictEqual(m.results().hidden, false);
  await sleep(120);
  assert.strictEqual(m.results().innerHTML, painted,
    "a failed directory pass must leave the local list byte for byte as it was");
});

test("the directory pass has its own hot-query cache, and a failure is not cached as an answer", async () => {
  /* A SECOND cache rather than a second field on `showBreadthQueryCache`: the
     two passes answer at different times and either can fail alone, so one
     shared entry would let a directory failure poison the catalogue answer for
     that query — or let a catalogue answer arriving first cache an entry the
     directory half would then never be allowed to fill.

     Same rule as the catalogue cache on failures (`test/show-search-cache.js`'s
     own line): `fetchApiJson` swallows an error to `null`, which is
     indistinguishable at the call site from "answered with nothing". Caching
     it would turn one bad moment on a train into a permanently directory-less
     session for that query.

     MUTATION: drop the `showDirectoryQueryCache` lookup — the repeat fires a
     second request and the first count goes to 2. Or move the cache write
     outside `if (data)` — the failing mount below stops retrying and its count
     stays at 1. */
  const m = mount({ directory: [{
    show_id: "777777", title: "A Directory Row", artwork_url: null, artist_name: null,
    editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple",
  }] });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  assert.strictEqual(m.directoryCalls().length, 1);
  m.input.value = "  RADIOLAB ";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  assert.strictEqual(m.directoryCalls().length, 1,
    "a repeat — case and spacing normalised, as the catalogue cache does — must not re-ask Apple");
  assert.ok(m.results().innerHTML.includes("A Directory Row"),
    "and the cached rows must still be merged, not silently dropped");

  const bad = mount({ directoryOk: false });
  bad.input.value = "radiolab";
  bad.byId.get("sh-form").fire("submit");
  await sleep(20);
  bad.input.value = "radiolab";
  bad.byId.get("sh-form").fire("submit");
  await sleep(20);
  assert.strictEqual(bad.directoryCalls().length, 2, "a failure must not be remembered as an answer");
});

test("the two normalised-title rules are one rule: app.js and api/shows/appleShowSearch.ts agree character for character", () => {
  /* The dedup happens on BOTH sides — the endpoint merges Apple beneath the
     catalogue, the client merges whatever arrives beneath what is painted — so
     two copies of the rule exist, in two languages, with no import between
     them (the same situation `test/show-search-ranking.test.js` pins for the
     bucket table against `backend/src/catalog/searchBreadthShows.ts`).
     Discipline is not the mechanism: this reads both files.

     Behaviour as well as source, because identical text that both did the
     wrong thing would still be one rule: the shared battery below is the
     measured cases — Apple's real duplicate ("Lex  Fridman Podcast!"), a title
     that is mostly punctuation ("99% Invisible"), and a non-ASCII title, which
     is why the classes are `\p{L}/\p{N}` and not `\W`.

     MUTATION: change either copy — `\W` for `[^\p{L}\p{N}]`, or drop the
     `.trim()`. The expressions differ and this goes red. */
  const EXPR = String.raw`String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()`;
  const server = fs.readFileSync(path.join(ROOT, "api", "shows", "appleShowSearch.ts"), "utf8");
  assert.ok(APP_SRC.includes(EXPR), "app.js must carry the rule verbatim");
  assert.ok(server.includes(EXPR), "api/shows/appleShowSearch.ts must carry the same rule verbatim");

  const m = mount();
  const norm = (t) => m.evalIn("normaliseShowTitle")(t);
  assert.strictEqual(norm("Lex  Fridman Podcast!"), norm("Lex Fridman Podcast"));
  assert.strictEqual(norm("99% Invisible"), "99 invisible");
  assert.strictEqual(norm("The Daily — NYT"), "the daily nyt");
  assert.strictEqual(norm("伊藤洋一のRound Up World Now！"), "伊藤洋一のround up world now",
    "a CJK title must not be shredded into single characters, which is what \\W would do");
  assert.strictEqual(norm("!!!"), "", "an all-punctuation title normalises to empty, which is never a dedup key");
});

test("an Apple directory result is rendered and cached like any other breadth row", async () => {
  /* The endpoint returns Apple rows in the SAME `shows` array and the SAME row
     shape as catalogue rows, deliberately, so the client needs no new branch.
     This is what pins that claim from the client's side: the row renders, it
     links to `#/show/:id`, and it is seeded into `state.breadthShowCache` so
     tapping it resolves.

     Driven through the DIRECTORY pass since P-02 (the `fallthrough=1` request),
     which is the only pass Apple rows can arrive on.

     MUTATION: have the endpoint return Apple hits under a separate
     `apple_shows` key. Nothing renders and this goes red — which is the
     failure a "the server returns it" test alone would not catch. */
  const m = mount({ directory: [{
    show_id: "999000111",
    title: "A Show Not In Our Catalogue At All",
    artwork_url: null,
    artist_name: "Somebody Else",
    editorial_note: null,
    taxonomy_node_ids: [],
    tier: "breadth",
    source: "apple",
  }] });
  m.input.value = "zzqx-no-such-show-anywhere";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  const html = m.results().innerHTML;
  assert.ok(html.includes("A Show Not In Our Catalogue At All"), `expected the Apple row, got ${html}`);
  assert.ok(html.includes('href="#/show/999000111"'), "and it must be tappable");
  assert.ok(m.state.breadthShowCache["999000111"], "and seeded so the tap resolves");
});

/* ---------- S-06, the client audit's finding 1: the ORDER survives ---------- */

const APPLE_THREE = ["Zebra Talks", "Morning Brief", "Acquired"].map((title, i) => ({
  /* Exactly what `api/shows/appleShowSearch.ts`'s `mapAppleShow` stamps: a
     `tier: "breadth"` row with NO `chart_rank` — Apple's ranking is the array
     order and nothing else. */
  show_id: `90000${i}`,
  title,
  artwork_url: null,
  artist_name: "Somebody Else",
  editorial_note: null,
  taxonomy_node_ids: [],
  tier: "breadth",
  source: "apple",
}));

test("the Apple fall-through's ranking survives the merge instead of being replaced by A-Z", async () => {
  /* FINDING 1, client audit 2026-09-12, and the most expensive of the eight:
     the fall-through only fires when NOTHING on the device matched, so on that
     path 100% of what the listener sees is Apple's list — and `rankShows` was
     throwing Apple's relevance away and re-sorting the whole thing
     alphabetically.

     WHY IT TIED ALL THE WAY DOWN TO THE TITLE. Apple matches on `artistName`
     and fuzzily, so every row it returns is `SHOW_MATCH_UNMATCHED`; every row
     is `tier: "breadth"`; and `mapAppleShow` stamps no `chart_rank`, so every
     row lands in the same (empty) popularity band. Three ties, then
     `compareTitles`.

     MUTATION: delete the `if (a.bucket === SHOW_MATCH_UNMATCHED) return 0;`
     line from `compareShowMatches` in search-engine.js. The three rows come
     back "Acquired | Morning Brief | Zebra Talks" and this goes red — which is
     the exact before-case the audit demonstrated. */
  const m = mount({ breadth: APPLE_THREE });
  m.input.value = "zzqx-no-such-show-anywhere";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  const html = m.results().innerHTML;
  const order = APPLE_THREE
    .map((r) => ({ title: r.title, at: html.indexOf(`href="#/show/${r.show_id}"`) }))
    .sort((a, b) => a.at - b.at)
    .map((r) => r.title);
  assert.ok(order.every((t, i) => html.indexOf(APPLE_THREE[i].title) >= 0), "all three rendered");
  assert.deepStrictEqual(order, ["Zebra Talks", "Morning Brief", "Acquired"],
    `the endpoint's order is the listener's order; got ${order.join(" | ")}`);
});

test("a row the listener's own query DOES match still leads the server's suggestions", async () => {
  /* The other direction, so the test above cannot be satisfied by a comparator
     that has stopped ranking at all. A breadth row whose title actually
     contains the typed text is a real match and is promoted above the
     unmatched ones — that is the bucket rule `rankShows` documents, and it is
     the half that must survive the fix.

     MUTATION: return 0 from `compareShowMatches` unconditionally. The matching
     row stays wherever the endpoint put it and this goes red. */
  const m = mount({ breadth: [...APPLE_THREE, {
    show_id: "900099", title: "Talking zzqx Weekly", artwork_url: null,
    artist_name: null, editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple",
  }] });
  m.input.value = "zzqx";
  m.byId.get("sh-form").fire("submit");
  await sleep(20);
  const html = m.results().innerHTML;
  assert.ok(html.indexOf('href="#/show/900099"') < html.indexOf('href="#/show/900000"'),
    "a genuine title match outranks the server's unmatched suggestions");
});

test("`rankShows` never reorders a group it did not rank, on the exact three-row case", () => {
  /* The same rule one level down, where it can be stated without a DOM: the
     comparator's contract is "an unmatched pair keeps its arrival order", and
     `Array.prototype.sort` has been required to be stable since ES2019, which
     is what makes returning 0 sufficient.

     Driven through the real search-engine.js the page loaded, so a mutation in
     that file is what turns this red rather than a copy of it here. */
  const m = mount();
  const rank = (rows) => m.ctx.SearchEngine.rankShows("fridman", rows).map((r) => r.title);
  assert.deepStrictEqual(rank(APPLE_THREE), ["Zebra Talks", "Morning Brief", "Acquired"]);
  assert.deepStrictEqual(rank([...APPLE_THREE].reverse()), ["Acquired", "Morning Brief", "Zebra Talks"],
    "arrival order, not one fixed order — reversing the input reverses the answer");
  assert.strictEqual(m.ctx.SearchEngine.rankShows("fridman", APPLE_THREE).length, 3,
    "and nothing is dropped: the server chose these rows by its own rule");
});

test("a breadth show page survives a cold open: showById's miss is resolved from the endpoint", async () => {
  /* #560 item 7 / requirements §6.8, and the acceptance line is literally
     "open #/show/<id> in a fresh session". `state.breadthShowCache` is
     in-memory and populated only by a search response THIS session, so before
     this change a shared link, a reload or a restored tab rendered "Show not
     found." — every way of reaching a breadth show except "I just searched
     for it".

     The fresh session is the `mount()` itself: nothing has been searched, the
     cache is empty, and the id is one no curated show has.

     MUTATION: restore the old `if (!show) { ... "Show not found." ... return; }`
     branch in `renderShow`. The page never recovers and the title assertion
     goes red. */
  const m = mount({ showById: {
    show_id: "424242", title: "A Linkable Breadth Show", artwork_url: null,
    editorial_note: null, taxonomy_node_ids: [], tier: "breadth",
  } });
  assert.equal(m.state.breadthShowCache["424242"], undefined, "fresh session: nothing cached");

  m.ctx.location.hash = "#/show/424242";
  m.ctx.renderShow("424242");
  assert.ok(m.byId.get("view").innerHTML.includes("Loading show"),
    "the miss must show a loading state, not a premature 'not found'");
  await sleep(20);
  assert.ok(m.byId.get("view").innerHTML.includes("A Linkable Breadth Show"),
    `expected the show page, got ${m.byId.get("view").innerHTML.slice(0, 200)}`);
  assert.ok(m.state.breadthShowCache["424242"], "and the row is seeded for the rest of the session");
  const idCall = m.apiCalls().find((u) => u.includes("id=424242"));
  assert.ok(idCall, "the id lookup must be a single-row request, not a search");
  assert.ok(!idCall.includes("q="), "q and id are mutually exclusive at the endpoint");
});

test("a genuinely unknown id still says 'Show not found.', and a loaded index answers without any network at all", async () => {
  /* Two halves of the same rule, and both matter.

     (a) A miss the endpoint confirms is a real, renderable state — not a
     spinner that never resolves. The endpoint answers 200 with `show: null`
     for exactly this reason (a 404 would be indistinguishable from a dead
     endpoint through `fetchApiJson`).

     (b) WHICH PATH WINS. Once the index is loaded it can answer a
     `#/show/:id` miss with no network at all — but it is only loaded when the
     listener searched first. On a genuine cold open it is not, and fetching
     436 KB of index to render one page would be a worse trade than one row
     over the wire, so the index is never fetched FOR this.

     MUTATION: make `resolveMissingShow` always fetch. The second half's
     fetch-count assertion goes red, and a listener who has already paid for
     the index pays again for every show page. */
  const m = mount({ showById: null });
  m.ctx.location.hash = "#/show/nope-not-real";
  m.ctx.renderShow("nope-not-real");
  await sleep(20);
  assert.ok(m.byId.get("view").innerHTML.includes("Show not found."),
    "a confirmed miss must be an honest empty state");

  const m2 = mount();
  m2.input.fire("focus");
  await sleep(10);
  const before = m2.apiCalls().length;
  m2.ctx.location.hash = "#/show/1000001";
  m2.ctx.renderShow("1000001");
  /* NO ID LOOKUP — not "no network at all". `renderShow` itself legitimately
     fetches the show's episode list, so a bare call-count assertion would be
     about the wrong request and would go red for a reason unrelated to this
     card. What must be absent is the single-row lookup. */
  assert.ok(!m2.apiCalls().some((u) => u.includes("api/shows/search") && u.includes("id=")),
    "a loaded index must answer the id miss with no lookup at all");
  void before;
  assert.ok(m2.byId.get("view").innerHTML.includes("Deep History Hour"));
});

test("navigating away while the id lookup is in flight does not clobber the new page", async () => {
  /* The same "still mounted" rule `renderShow`'s own episode fetch follows. A
     listener who taps back while the row is in flight would otherwise have
     their new page replaced by a show page they already left — the class of
     bug that only shows up on a slow connection, which is exactly when it
     matters.

     MUTATION: drop the `location.hash !== wanted` guard in
     `resolveMissingShow`. #view is overwritten with the show page and this
     goes red. */
  const m = mount({ showById: {
    show_id: "424242", title: "A Linkable Breadth Show", artwork_url: null,
    editorial_note: null, taxonomy_node_ids: [], tier: "breadth",
  }, idDelayMs: 40 });
  m.ctx.location.hash = "#/show/424242";
  m.ctx.renderShow("424242");
  m.ctx.location.hash = "#/shows";
  m.byId.get("view").innerHTML = "<p>somewhere else</p>";
  await sleep(80);
  assert.equal(m.byId.get("view").innerHTML, "<p>somewhere else</p>",
    "the in-flight row must not repaint a page the listener has left");
});

/* ---------- P-03: the byline (docs/search-parity-plan.md, 2026-09-12) --------

   These belong in THIS suite rather than the ranking one because the byline
   exists because of P-02: after the directory became a second pass, most of
   what a listener sees is rows APPLE chose, matched against an author index we
   do not have. "andrew huberman" returns *Huberman Lab* first and nothing
   visible on that row contains a word he typed. The byline is the row saying
   why it is there — and it is the only half of P-03 that survived measurement,
   the ranking half having been refused (see test/show-search-ranking.test.js's
   last two tests and `rankShows`'s header).

   Every string below is a real Apple `artistName`, measured 2026-09-12. */

test("a directory row renders its author as a byline", () => {
  /* MUTATION: drop the `${by ? ...}` branch from `showResultRow`, or gate it on
     `show.source === "apple"` and pass a row without that field. The byline
     disappears and this goes red. */
  const m = mount();
  const html = m.ctx.showResultRow({
    show_id: "1545953110", title: "Huberman Lab", artwork_url: null,
    artist_name: "Scicomm Media", tier: "breadth", source: "apple",
  });
  assert.ok(html.includes("Huberman Lab"), "the title still renders");
  assert.ok(html.includes('class="show-result-by">Scicomm Media<'),
    "the author must render in its own element, or the row cannot explain itself");
});

test("a row with no author renders no byline element at all", () => {
  /* THE SHARED-CALLER GUARANTEE. `showResultRow` is also `similarShowsSection`'s
     and A3.5's row, and every curated show reaches it — no committed catalogue
     row has an author (that is P-03a's whole point), so an unconditional byline
     would put an empty grey line under all 220 of them.

     A WHITESPACE-ONLY AUTHOR IS NO AUTHOR, tested explicitly: `artist_name`
     comes off a third-party API, and `by` is trimmed rather than truthiness-
     checked precisely so " " cannot render a blank line.

     MUTATION: change the `by` guard to `show.artist_name` untrimmed, or emit the
     span unconditionally. The second assertion goes red. */
  const m = mount();
  const curated = m.ctx.showResultRow({
    show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null,
  });
  assert.ok(!curated.includes("show-result-by"),
    "a curated row has no author and must render exactly as it did before P-03");
  assert.ok(!m.ctx.showResultRow({ show_id: "x", title: "X", artist_name: "   " }).includes("show-result-by"),
    "a whitespace-only artist_name is not an author");
});

test("an author string is escaped, not trusted", () => {
  /* `artist_name` is attacker-controllable in the only sense that matters: it
     is whatever an arbitrary podcast publisher typed into Apple's directory,
     and it now reaches innerHTML. It goes through the same `esc` the title
     does. Not hypothetical for this field — the measured long tail already
     contains pipes and angle-adjacent punctuation ("Hosted By: Amanda McKinney
     | Andrew Huberman").

     MUTATION: interpolate `by` instead of `esc(by)`. The raw tag appears and
     this goes red. */
  const m = mount();
  const html = m.ctx.showResultRow({
    show_id: "1", title: "A Show", artist_name: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes("<img src=x"), "an author string must never reach innerHTML as markup");
  assert.ok(html.includes("&lt;img src=x"), "it must render as escaped text instead");
});
