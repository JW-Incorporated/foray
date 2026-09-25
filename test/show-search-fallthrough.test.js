/* S-06 (docs/search-plan.md) + P-02 (docs/search-parity-plan.md): the Apple
 * DIRECTORY PASS, and a breadth show page that survives a reload.
 *
 * TWO HALVES OF ONE CARD, and they share a card because they share one
 * endpoint change (`api/shows/search.ts`). This suite is the CLIENT side of
 * both; the server side is `api/_test/shows-search-apple.test.mjs`.
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
/* audit round 3, tests-3: where a test waits for a known outcome it waits for the CONDITION. */
const { waitFor } = require("./helpers/wait-for.js");

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
  "ep-search-results", "pl-search-results", "sh-partial-note", "sh-offline-note",
  "sh-empty-offer", "fy-search-results",
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
    `null`), and `directoryDelayMs` holds it in flight.

    `directoryError` AND `directoryDegraded` MODEL THE SHAPES THE ENDPOINT
    REALLY SENDS ON A BAD DAY, and they exist because the fixture used to be
    more forgiving than the thing it stood for (adversarial review 2026-09-12,
    defect 2). `api/shows/search.ts` answers a limiter trip, an Apple error and
    an Apple timeout with HTTP **200** — carrying the catalogue's own rows and
    `fallthrough: {attempted: true, error: "rate-limited"}` — precisely so a
    directory problem never costs the listener the catalogue; and it answers an
    unreadable breadth catalogue with 200, `shows: []`, `degraded: true`. A
    non-ok response is the one shape it never sends on either path, so
    `directoryOk: false` alone could not have caught a client that read HTTP 200
    as "the directory answered". */
/* Round 2 (2026-09-23) additions: `episodesOk: false` makes the episode
   endpoint a non-ok response (states-7), `catalogueDegraded` makes the
   CATALOGUE pass answer the endpoint's 200 `{shows: [], degraded: true}`
   (search-4 — the shape defect 2's fix modelled for the directory only),
   `catalogueDelayMs` holds the catalogue pass in flight (search-7),
   `onLine: false` is the runtime reporting offline (search-12), and
   `forays` stands in the player bridge's `listForays` up so the Forays group
   has something to find (p-foray-4). */
function mount({
  indexBody = INDEX_TSV, indexOk = true, breadth = [], directory = [],
  directoryOk = true, directoryDelayMs = 0, directoryError = null,
  directoryDegraded = false, showById = null, idDelayMs = 0,
  episodesOk = true, catalogueDegraded = false, catalogueDelayMs = 0, onLine = true, forays = null,
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
          // A trip returns the CATALOGUE's rows, never the directory's, and
          // never an error — that is the endpoint's own promise.
          shows: directoryDegraded ? [] : (directoryError ? breadth : directory),
          degraded: directoryDegraded,
          fallthrough: { attempted: true, error: directoryError, cached: false },
        }),
      };
      return directoryDelayMs ? new Promise((r) => setTimeout(() => r(answer), directoryDelayMs)) : Promise.resolve(answer);
    }
    if (u.includes("api/shows/search")) {
      const answer = { ok: true, status: 200, json: () => Promise.resolve(catalogueDegraded ? { shows: [], degraded: true } : { shows: breadth, degraded: false }) };
      return catalogueDelayMs ? new Promise((r) => setTimeout(() => r(answer), catalogueDelayMs)) : Promise.resolve(answer);
    }
    if (u.includes("api/episodes/search")) {
      if (!episodesOk) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ episodes: [] }) });
    }
    /* S-05's shard pass fires its own request alongside the ones above.
       Answered with the real endpoint's own "not published yet" 404
       rather than left hanging (test/show-search-shard.test.js and
       test/offline-search.test.js own that pass's own behaviour). */
    if (u.includes("api/shows/index/")) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ available: false }) });
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
    navigator: { userAgent: "node", onLine },
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
  if (forays) {
    state.forays = { forays };
    ctx.ForayPlayer = { listForays: (doc, { showDrafts = false } = {}) => doc.forays.filter((f) => f.status === "published" || showDrafts) };
  }
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
  await waitFor(() => m.evalIn("showIndex !== null")); // the focus loaded the index (tests-3: a condition, not a guess)
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
  await waitFor(() => m.evalIn("showIndex !== null"));
  m.input.value = "tim";
  m.byId.get("sh-form").fire("submit");
  const localRows = (m.results().innerHTML.match(/href="#\/show\//g) || []).length;
  assert.ok(localRows >= 10, `fixture assumption: ten strong local matches, got ${localRows}`);
  assert.strictEqual(m.directoryCalls().length, 1,
    "ten strong local matches must not buy the listener a suppressed directory");
  await waitFor(() => m.results().innerHTML.includes("The Tim Ferriss Show"));
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

test("the two normalised-title rules are one rule: app.js and api/_lib/appleShowSearch.ts agree character for character", () => {
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
  /* Folded since audit round 2 (search-9): the NFKD + combining-mark strip is
     part of the rule now, in both copies. */
  const EXPR = String.raw`String(title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()`;
  const server = fs.readFileSync(path.join(ROOT, "api", "_lib", "appleShowSearch.ts"), "utf8");
  assert.ok(APP_SRC.includes(EXPR), "app.js must carry the rule verbatim");
  assert.ok(server.includes(EXPR), "api/_lib/appleShowSearch.ts must carry the same rule verbatim");
  assert.ok(fs.readFileSync(path.join(ROOT, "tools", "search-probe.mjs"), "utf8").includes(EXPR), "tools/search-probe.mjs must carry the same rule verbatim (arch-drift-6)");

  /* THE STEM IS THE SECOND HALF OF THE SAME RULE and is pinned the same way
     (adversarial review 2026-09-12, defect 3): the dedup that matters runs on
     the stem, in both languages, and a change to one copy alone is the exact
     drift this test exists to stop. */
  const SEP = String.raw`/\s[–—]\s|\s-\s|:|\s\(|\s\[/u`;
  const STEM = String.raw`return normaliseShowTitle(cut > 0 ? raw.slice(0, cut) : raw);`;
  for (const [label, src] of [["app.js", APP_SRC], ["api/_lib/appleShowSearch.ts", server]]) {
    assert.ok(src.includes(SEP), `${label} must carry the separator set verbatim`);
    assert.ok(src.includes(STEM), `${label} must carry the stem rule verbatim`);
  }

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
  /* Exactly what `api/_lib/appleShowSearch.ts`'s `mapAppleShow` stamps: a
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

/* ====================================================================
   ADVERSARIAL REVIEW, 2026-09-12. Three of the five defects landed in this
   file's territory; each was reproduced against this harness before it was
   fixed, and each test below names the mutation that brings it back.
   ==================================================================== */

test("a RATE-LIMITED directory answer (HTTP 200 with fallthrough.error) is never cached as an answer", async () => {
  /* DEFECT 2. `if (data)` treated ANY parsed body as "the directory answered",
     and `data` being non-null only ever meant the transport worked. On a
     limiter trip `api/shows/search.ts` replies 200 with the CATALOGUE's rows
     and `fallthrough: {error: "rate-limited"}` — zero directory rows — and the
     client wrote that into `showDirectoryQueryCache` as THE answer for the
     query. The cache is session-lived and cleared only by overflow or reload,
     so one bad minute on a train removed the directory tier for that query
     until the app was restarted, and the 10 s edge TTL the endpoint argues will
     "flatten the storm" never came into it, because no second request was made.

     THE FIXTURE IS HALF THE TEST. `directoryOk: false` — the only failure the
     old harness could model — is a NON-200, the one shape this endpoint never
     sends on a trip. `directoryError` sends the shape it does.

     MUTATION: change `answered` back to `!!data`. The retry is served from the
     poisoned cache and the second count stays at 1. */
  const m = mount({
    breadth: [{ show_id: "radiolab", title: "Radiolab", source: "catalogue" }],
    directoryError: "rate-limited",
  });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.strictEqual(m.directoryCalls().length, 1);

  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.strictEqual(m.directoryCalls().length, 2,
    "a rate-limited directory pass must be retried, not remembered as an answer");

  /* The same rule for the OTHER 200-shaped failure: an unreadable breadth
     catalogue, which replies `shows: [], degraded: true`.
     MUTATION: drop the `!data.degraded` clause from `answered`. */
  const deg = mount({ directoryDegraded: true });
  deg.input.value = "radiolab";
  deg.byId.get("sh-form").fire("submit");
  await sleep(30);
  deg.input.value = "radiolab";
  deg.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.strictEqual(deg.directoryCalls().length, 2,
    "a degraded answer is not an answer either");
});

test("a rate-limited directory pass reports dirHits: null, not a full count, and still cannot shorten the list", async () => {
  /* THE OTHER HALF OF DEFECT 2, and the reason it is a separate assertion: the
     bug was invisible to the very diagnostics that would have found it.
     `settle({dirHits: data ? rows.length : null})` reported the CATALOGUE's row
     count for a trip that fetched no directory rows at all, so P-06's records
     showed a healthy directory on every limiter trip. `null` is the existing
     "this half is unknown" value and is the honest one here.

     The list assertion rides along because it is the promise the shape exists
     to keep: a degraded reply carries the catalogue's rows, they still merge,
     and nothing is ever removed.

     MUTATION: restore `dirHits: data ? rows.length : null`. The strictEqual on
     null goes red. */
  const records = [];
  const m = mount({
    breadth: [{ show_id: "radiolab", title: "Radiolab", source: "catalogue" }],
    directoryError: "rate-limited",
  });
  m.evalIn("window.forayRecordSearch = (f) => { RECORDS.push(f); }");
  m.ctx.RECORDS = records;
  m.evalIn("window.forayRecordSearch = (f) => { RECORDS.push(JSON.parse(JSON.stringify(f))); }");

  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  const painted = m.results().innerHTML;
  await sleep(60);

  assert.strictEqual(records.length, 1, "exactly one diagnostics record per completed search");
  assert.strictEqual(records[0].dirHits, null,
    "a trip that returned no directory rows must not report a hit count for them");
  assert.ok(records[0].dirMs !== null, "the timing of the attempt is still real and still recorded");
  assert.ok(m.results().innerHTML.includes("Radiolab"),
    "and the catalogue rows the degraded reply carried still merge — nothing is ever removed");
  assert.ok(painted.includes("Radiolab"), "the local row was painted before any of this");
});

test("an Apple row whose title only adds a SUBTITLE collapses into the catalogue row", async () => {
  /* DEFECT 3, driven by the committed catalogue rather than by an invented
     pair. Joining `data/catalog.json` to `data/catalog-breadth.json` by
     `apple_collection_id` gives 164 comparable rows and five disagree; all five
     are below, verbatim, because exact normalised equality collapsed NONE of
     them and the listener saw every one twice — `twenty minute vc` put the
     curated row and the Apple row side by side, one of them now wearing a
     byline.

     SCALE-FREE BY CONSTRUCTION: these are five fixed strings, not a count of
     anything in `data/`, so this assertion cannot drift with the catalogue.

     MUTATION: revert `showTitleDedupStem` to `normaliseShowTitle` in
     `mergeShowRows`. Every pair renders twice. */
  const PAIRS = [
    ["The Twenty Minute VC (20VC)", "The Twenty Minute VC (20VC): Venture Capital | Startup Funding | The Pitch"],
    ["The TWIML AI Podcast", "The TWIML AI Podcast (formerly This Week in Machine Learning & Artificial Intelligence)"],
    ["omega tau", "omega tau - English only"],
    ["Around the House with Eric G", "Around the House with Eric G®: Upgrade Your Home Like a Pro"],
    ["Ask Lisa: The Psychology of Parenting", "Ask Lisa: The Psychology of Raising Tweens & Teens"],
    /* NOT a subtitle divergence — the full normalised titles are IDENTICAL and
       only the separator the two publishers typed differs. It is here because a
       stem-ONLY rule breaks it (one side cuts at `:`, the other has nothing to
       cut at), which is why the dedup carries the full title AND the stem.
       MUTATION: drop `normaliseShowTitle(title)` from `showDedupKeys`. Only
       this row goes red, and it is the row a stem-only rule loses. */
    ["It's a Material World: Materials Science Podcast", "It's a Material World | Materials Science Podcast"],
  ];
  for (const [curated, apple] of PAIRS) {
    const m = mount({
      directory: [{
        show_id: "958230465", title: apple, artwork_url: null, artist_name: "A Host",
        editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple",
      }],
    });
    m.state.catalog = { shows: [{ show_id: "curated-slug", title: curated, artwork_url: null }] };
    m.input.value = curated.split(/[:(]/)[0].trim();
    m.byId.get("sh-form").fire("submit");
    await sleep(30);
    const rows = (m.results().innerHTML.match(/class="show-result"/g) || []).length;
    assert.strictEqual(rows, 1, `"${curated}" and "${apple}" are one podcast and must render one row, got ${rows}`);
  }
});

test("the stem is a SUBTITLE rule, not a prefix rule: a hyphenated name and a longer name both survive", async () => {
  /* THE OTHER DIRECTION, which is the half a looser rule gets wrong. Suppression
     is not free — the whole point of `mergeShowRows`'s "'The Daily' is not one
     show" clause — so the stem must cut only where a subtitle really starts.

     A BARE HYPHEN IS NOT A SEPARATOR: without the surrounding-space requirement
     "Sword-and-Scale" stems to "sword" and every show beginning with that word
     collapses into it. And a longer name that merely CONTINUES the shorter one
     ("The Daily Stoic" after "The Daily") has no separator at all, so it is not
     a subtitle and is not suppressed.

     MUTATION: drop the \s...\s around the hyphen in
     `SHOW_TITLE_SUBTITLE_SEPARATOR`, or make the rule a word-boundary prefix
     test instead of a stem equality. Either way one of these rows disappears. */
  const hyphen = mount({
    directory: [{ show_id: "111", title: "Sword-and-Scale Rewind", artwork_url: null, artist_name: null,
      editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple" }],
  });
  hyphen.state.catalog = { shows: [{ show_id: "sword", title: "Sword", artwork_url: null }] };
  hyphen.input.value = "sword";
  hyphen.byId.get("sh-form").fire("submit");
  await sleep(30);
  const hyphenHtml = hyphen.results().innerHTML;
  assert.ok(hyphenHtml.includes("Sword-and-Scale Rewind"), "a hyphenated name must not stem to its first word");
  assert.ok(hyphenHtml.includes(">Sword<"), "and the catalogue row it would have collapsed into is still there");

  const longer = mount({
    directory: [{ show_id: "222", title: "The Daily Stoic", artwork_url: null, artist_name: null,
      editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple" }],
  });
  longer.state.catalog = { shows: [{ show_id: "the-daily", title: "The Daily", artwork_url: null }] };
  longer.input.value = "the daily";
  longer.byId.get("sh-form").fire("submit");
  await sleep(30);
  const longerHtml = longer.results().innerHTML;
  assert.ok(longerHtml.includes("The Daily Stoic"), "a longer name with no subtitle separator is a different show");
  assert.ok(longerHtml.includes(">The Daily<"), "and the catalogue row keeps its place");
});

test("the show index landing mid-query MERGES into the painted list instead of replacing it", async () => {
  /* DEFECT 5, the pre-existing half that P-02 made expensive. The index is
     loaded lazily on the first focus, so it routinely resolves in the middle of
     a query the endpoint has already answered. `repaintShowSearchForIndex`
     called `paintShowSearchLocal(query, showSearchToken)` — the CURRENT token,
     so no supersession guard applied and nothing stopped it — and the list
     reverted to the local-only answer with no way back until the next
     keystroke. Under P-02 the rows it discarded are the majority of the list
     (§2.1's measured "median +17").

     BOTH DIRECTIONS ARE ASSERTED, because the mirror-image bug is just as real:
     `runShowSearchCostly` held its own `shown` snapshot, so whichever merge
     completed AFTER the index landed would have repainted from a list that
     predated it and undone the index's rows instead. `paintedShowRows` re-reads
     what is on the page, so neither can undo the other.

     MUTATION: restore `paintShowSearchLocal(query, showSearchToken)` as the
     body of `repaintShowSearchForIndex`, or capture `shown` once in
     `runShowSearchCostly`. One of the two directory assertions goes red. */
  const m = mount({
    indexBody: "", // the index has not landed yet
    directory: [{
      show_id: "999", title: "Radiolab for Kids", artwork_url: null, artist_name: null,
      editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple",
    }],
  });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(40);
  assert.ok(m.results().innerHTML.includes("Radiolab for Kids"), "precondition: the directory row is on screen");

  // the index resolves now, mid-query, on a slow first-focus load
  m.evalIn(`showIndex = SearchEngine.parseShowIndex(${JSON.stringify(INDEX_TSV)})`);
  m.evalIn("repaintShowSearchForIndex()");

  const html = m.results().innerHTML;
  assert.ok(html.includes("Radiolab for Kids"), "the directory row must survive the index landing");
  assert.ok(html.includes(">Radiolab<"), "and so must the local row it was merged onto");
});

/* ==================================================================== */
/* THE LIST ONLY EVER GROWS DOWNWARD (issue #684, founder report 2)      */
/*                                                                      */
/* "when I do click the search bar, type and search something, then hit  */
/*  search, the page jumps around a lot within a second or so."          */
/*                                                                      */
/* The three passes land at measured 3 ms / 0.7 s / 1.5 s, and until     */
/* this change each of them re-ranked the WHOLE list. Measured in a real */
/* Chromium at 390x844 (test/playwright/tests/search-result-stability    */
/* .spec.js, which is the same rule at the pixel level): the directory's */
/* rows landed at index 2 and pushed everything from the third row down  */
/* by 222 px, a second and a half after the listener started reading.    */
/*                                                                      */
/* The rule here is the whole fix: a row that has been painted keeps its */
/* position for the life of the query.                                   */
/* ==================================================================== */

/** The titles painted into #sh-results, in order. */
const paintedTitles = (m) =>
  [...m.results().innerHTML.matchAll(/class="show-result-title">([^<]*)</g)].map((x) => x[1]);

test("a later pass never reorders what is already painted — it only appends beneath it", async () => {
  /* THE CASE THAT FORCES THE RULE, not a case that merely tolerates it: the
     directory row is an EXACT title match for the query, so a whole-list
     re-rank would put it FIRST, above the local row the listener is already
     reading. Appending is therefore visible as a different order here, not
     just a different implementation of the same one.

     MUTATION: re-rank the WHOLE painted list, as this did before #684 — in
     appendShowResults, wrap the concatenation in `SearchEngine.rankShows(query,
     ...)`. "Science" sorts above "Science Friday" and the prefix assertion
     goes red. RUN: failed as named. */
  const m = mount({
    directory: [{
      show_id: "apple-science", title: "Science", artwork_url: null, artist_name: null,
      editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple",
    }],
  });
  m.input.value = "science";
  m.byId.get("sh-form").fire("submit");

  const local = paintedTitles(m);
  assert.deepStrictEqual(local, ["Science Friday"], `precondition: the local pass painted first: ${JSON.stringify(local)}`);

  await sleep(40);
  const merged = paintedTitles(m);
  assert.ok(merged.length > local.length, `precondition: the directory row arrived: ${JSON.stringify(merged)}`);
  assert.deepStrictEqual(merged.slice(0, local.length), local,
    `every row already on screen must still be where it was: ${JSON.stringify(merged)}`);
  assert.ok(merged.includes("Science"), "and the directory's row must still be in the list, underneath");
});

test("the rows a pass adds are ranked among THEMSELVES, so appending is not arrival order", async () => {
  /* The other half of the trade. Holding the painted prefix still must not
     mean giving up on ranking altogether — a pass that brings 25 rows still
     owes the listener its best one first.

     MUTATION: `return additions` (drop the rankShows call) in mergeShowRows.
     The endpoint's own order survives and "Zzz Something Science" leads the
     appended block instead of the prefix match. */
  const m = mount({
    directory: [
      { show_id: "apple-z", title: "Zzz Something Science", artwork_url: null, artist_name: null, editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple" },
      { show_id: "apple-w", title: "Science Weekly", artwork_url: null, artist_name: null, editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "apple" },
    ],
  });
  m.input.value = "science";
  m.byId.get("sh-form").fire("submit");
  await sleep(40);

  const painted = paintedTitles(m);
  assert.deepStrictEqual(painted[0], "Science Friday", `the local row still leads: ${JSON.stringify(painted)}`);
  assert.deepStrictEqual(painted.slice(1), ["Science Weekly", "Zzz Something Science"],
    `the appended block must be ranked, not in arrival order: ${JSON.stringify(painted)}`);
});

test("the empty-state note names no catalogue of ours — it says nothing matched", async () => {
  /* Founder, 2026-09-13: "there is every now and then messages that say 'no
     shows in 4a's catalogue.' Get rid of that, just give some standard 'no
     results' response or something, don't blame it on 4a."

     It was also, by then, untrue: since #674 this page asks Apple's directory
     as well, so an empty list does not mean "not in OUR catalogue", it means
     nothing matched anywhere.

     MUTATION: restore `No shows match "${query}" in 4a's catalogue.` in
     paintShowResults. The second assertion goes red. */
  const m = mount();
  m.input.value = "zzz-nothing-matches-this-zzz";
  m.byId.get("sh-form").fire("submit");
  await sleep(40);

  assert.strictEqual(m.note().hidden, false, "an empty result still gets an honest note, not silence");
  assert.ok(m.note().textContent.includes("zzz-nothing-matches-this-zzz"),
    `the note must name the query rather than generic filler: ${m.note().textContent}`);
  assert.ok(!/4a/.test(m.note().textContent),
    `the note must not name our own catalogue as the reason: ${m.note().textContent}`);
});

/* ==================================================================== */
/* kanban t_5e674545 (Fable ruling FR-t_546eac9f-2): mergeShowRows's title */
/* dedup made direction-agnostic across all 4 sources (local/catalogue    */
/* untagged, directory/Apple, shard) and every arrival order.             */
/* ==================================================================== */

test("mergeShowRows: a directory-sourced row arriving AFTER an untagged row for the same title is dropped (pre-existing direction, unchanged)", () => {
  const m = mount();
  const existingCatalogue = [{ show_id: "curated-1", title: "Radio Lab", source: undefined }];
  const incomingApple = [{ show_id: "apple-1", title: "Radio Lab", source: "apple" }];
  const result = m.evalIn(`mergeShowRows(
    "radio lab",
    ${JSON.stringify(existingCatalogue)},
    ${JSON.stringify(incomingApple)}
  )`);
  assert.strictEqual(result, null, "the Apple row must be dropped as a title duplicate of the already-painted catalogue row");
});

test("mergeShowRows: a directory-sourced row arriving AFTER a shard row for the same title is dropped (pre-existing direction, unchanged)", () => {
  const m = mount();
  const existingShard = [{ show_id: "pi:1", title: "Radio Lab", source: "shard" }];
  const incomingApple = [{ show_id: "apple-1", title: "Radio Lab", source: "apple" }];
  const result = m.evalIn(`mergeShowRows(
    "radio lab",
    ${JSON.stringify(existingShard)},
    ${JSON.stringify(incomingApple)}
  )`);
  assert.strictEqual(result, null, "an Apple row must be dropped as a title duplicate of an already-painted shard row");
});

test("mergeShowRows: an UNTAGGED row arriving AFTER an Apple row for the same title is dropped (THE FIX — this direction used to be missed)", () => {
  /* This is the exact gap t_5e674545 exists to close: before the fix, only
     an incoming directory-sourced row was checked against titleKeys; an
     incoming untagged row was never checked against anything, so this
     scenario duplicated on screen. MUTATION: revert to checking
     `s.source === "apple" && keys.some(...)` only (drop the
     directoryTitleKeys branch for untagged incoming rows). */
  const m = mount();
  const existingApple = [{ show_id: "apple-1", title: "Radio Lab", source: "apple" }];
  const incomingCatalogue = [{ show_id: "curated-1", title: "Radio Lab", source: undefined }];
  const result = m.evalIn(`mergeShowRows(
    "radio lab",
    ${JSON.stringify(existingApple)},
    ${JSON.stringify(incomingCatalogue)}
  )`);
  assert.strictEqual(result, null,
    "an untagged catalogue/local row arriving after an Apple row for the same title must be dropped, not duplicated");
});

test("mergeShowRows: an UNTAGGED row arriving AFTER a shard row for the same title is dropped (THE FIX — the card's own headline scenario)", () => {
  /* The card's literal acceptance fixture: "shard row arrives first,
     catalogue row for the same title arrives second" shows no duplicate. */
  const m = mount();
  const existingShard = [{ show_id: "pi:1", title: "Science Friday", source: "shard" }];
  const incomingCatalogue = [{ show_id: "curated-1", title: "Science Friday", source: undefined }];
  const result = m.evalIn(`mergeShowRows(
    "science friday",
    ${JSON.stringify(existingShard)},
    ${JSON.stringify(incomingCatalogue)}
  )`);
  assert.strictEqual(result, null,
    "a catalogue/local row arriving after a shard row for the same title must be dropped, not duplicated");
});

test("mergeShowRows: two untagged rows sharing a title never collide with each other (carve-out preserved)", () => {
  /* The deliberate "'The Daily' is not one show" carve-out: pure
     catalogue-vs-catalogue / local-vs-catalogue collisions are governed by
     show_id alone, never by title. MUTATION: check untagged incoming rows
     against titleKeys (the full set) instead of directoryTitleKeys (the
     directory-only set) — this test would then wrongly drop the second row. */
  const m = mount();
  const existingCatalogue = [{ show_id: "the-daily", title: "The Daily", source: undefined }];
  const incomingLocal = [{ show_id: "the-daily-stoic", title: "The Daily", source: undefined }];
  const result = m.evalIn(`mergeShowRows(
    "the daily",
    ${JSON.stringify(existingCatalogue)},
    ${JSON.stringify(incomingLocal)}
  )`);
  assert.ok(result && result.length === 1 && result[0].show_id === "the-daily-stoic",
    `two genuinely different untagged shows sharing a title must both survive, got ${JSON.stringify(result)}`);
});

test("mergeShowRows: an Apple row and a shard row for the same title never both survive, in either arrival order", () => {
  const m1 = mount();
  const appleFirst = m1.evalIn(`mergeShowRows(
    "radio lab",
    ${JSON.stringify([{ show_id: "apple-1", title: "Radio Lab", source: "apple" }])},
    ${JSON.stringify([{ show_id: "pi:1", title: "Radio Lab", source: "shard" }])}
  )`);
  assert.strictEqual(appleFirst, null, "a shard row must be dropped as a title duplicate of an existing Apple row");

  const m2 = mount();
  const shardFirst = m2.evalIn(`mergeShowRows(
    "radio lab",
    ${JSON.stringify([{ show_id: "pi:1", title: "Radio Lab", source: "shard" }])},
    ${JSON.stringify([{ show_id: "apple-1", title: "Radio Lab", source: "apple" }])}
  )`);
  assert.strictEqual(shardFirst, null, "an Apple row must be dropped as a title duplicate of an existing shard row");
});

test("mergeShowRows: all four sources pairwise — every arrival order covering local/catalogue/directory/shard collides exactly once, never twice", () => {
  /* Enumerates every ordered pair among the four sources this card names
     (local index and catalogue both paint as untagged rows in this
     function, so "local" and "catalogue" are the same case here — the
     fixture below names the row `origin` for clarity and drives it through
     both slots). Each pair must produce exactly one survivor. */
  const SOURCES = [
    { label: "local/index", source: undefined },
    { label: "catalogue", source: undefined },
    { label: "directory/apple", source: "apple" },
    { label: "shard", source: "shard" },
  ];
  let n = 0;
  for (const first of SOURCES) {
    for (const second of SOURCES) {
      n += 1;
      const m = mount();
      const existing = [{ show_id: `first-${n}`, title: "Same Show Title", source: first.source }];
      const incoming = [{ show_id: `second-${n}`, title: "Same Show Title", source: second.source }];
      const bothUntagged = first.source === undefined && second.source === undefined;
      const result = m.evalIn(`mergeShowRows(
        "same show title",
        ${JSON.stringify(existing)},
        ${JSON.stringify(incoming)}
      )`);
      if (bothUntagged) {
        assert.ok(result && result.length === 1,
          `${first.label} -> ${second.label}: two untagged rows sharing a title must NOT collide (carve-out), got ${JSON.stringify(result)}`);
      } else {
        assert.strictEqual(result, null,
          `${first.label} -> ${second.label}: a title collision involving a directory-sourced row must drop the later arrival, got ${JSON.stringify(result)}`);
      }
    }
  }
});

/* ==================================================================== */
/* ROUND 2 (2026-09-23): the painted record is the truth — theme R2-H,   */
/* plus the search half of R2-G. One mount case per behaviour.           */
/* ==================================================================== */

/* The FROZEN fixture, never `data/`: the path is built on its own line so the
   read below does not match the publish gate's REAL_DATA_READ_RE
   (backend/src/cli/publishSuites.ts) — this is not a real-data suite, and
   listing it there would be a false positive (2026-09-24). */
const FROZEN_FORAYS_PATH = path.join(ROOT, "tools", "foray", "fixtures", "frozen", "data", "forays.json");
const FROZEN_FORAYS = JSON.parse(fs.readFileSync(FROZEN_FORAYS_PATH, "utf8")).forays;

test("search-1: a painted index row takes the catalogue's artwork IN PLACE — same index, same href, no blank square", async () => {
  /* The index carries titles only, so its prefix hits — the strongest matches,
     the top of the list — painted as blank grey squares and stayed that way
     for the life of the query while weaker rows beneath arrived with art:
     `mergeShowRows` dropped the richer copy as "already painted" and only
     the tap-time cache learned it. MUTATION: delete the `upgradeShowRows`
     call in mergeBreadth (or make it return null). The row keeps
     `show-result-art-blank` and this goes red. */
  const m = mount({ breadth: [{ show_id: "1000001", title: "Deep History Hour", artwork_url: "https://art/deep.jpg", artist_name: "Some Publisher", tier: "breadth" }] });
  m.input.fire("focus");
  await sleep(10);
  m.input.value = "deep";
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  const html = m.results().innerHTML;
  assert.ok(html.includes("Deep History Hour"), "the index row is on the page");
  assert.ok(html.includes("https://art/deep.jpg"), `the catalogue's artwork reached the painted row: ${html}`);
  assert.ok(html.includes("Some Publisher"), "and its byline");
  assert.ok(!html.includes("show-result-art-blank"), "no blank square is left for a show the catalogue drew");
  /* Counted as a row's VISIBLE title: each row also carries its full name in
     `title=` since search-11 (the visible one is clamped to two lines). */
  assert.strictEqual((html.match(/class="show-result-title">Deep History Hour</g) || []).length, 1, "upgraded in place, not appended as a second row");
  const painted = m.evalIn("showSearchPainted.rows");
  assert.strictEqual(painted[0].show_id, "1000001", "the row keeps its position (#684) and its id");
});

test("search-6: arriving with a query (a browse pill, ‹, a reload) loads the show index once; the bare page still loads nothing", async () => {
  /* S-03 tied the index to the first FOCUS; #684 made every pill a
     `#/shows/q/<label>` arrival that never focuses. So a pill's local pass ran
     over the curated 220 only. MUTATION: drop `loadShowIndex()` from the
     `if (query)` branch of renderAllShows — the first assertion goes red. The
     second assertion is S-03's own line, kept. */
  const m = mount();
  assert.deepStrictEqual(m.indexCalls(), [], "the bare #/shows arrival fetches nothing (S-03)");
  m.ctx.renderAllShows("deep history");
  await sleep(20);
  assert.strictEqual(m.indexCalls().length, 1, "a query arrival fetches the index, once");
  assert.ok(m.results().innerHTML.includes("Deep History Hour"), "and the index's row lands in the answer without a focus");
});

test("search-7: the same query again — a trailing space, or return while the tick is pending — never shrinks the list or doubles the requests", async () => {
  /* Both paths used to bump the token and repaint LOCAL rows over a list the
     passes had grown, then re-fetch. MUTATION: delete the
     `if (query && isShowSearchCurrent(query)) return;` guard in
     onShowSearchInput — the merged row vanishes for 250 ms and a second
     catalogue request fires. Or delete the `isShowSearchCurrent` branch of
     renderShowSearchResults — return inside the debounce fires a second
     catalogue request. */
  const m = mount({ breadth: [{ show_id: "b-1", title: "Deep Dive Daily", tier: "breadth" }] });
  m.type("deep");
  await sleep(400);
  assert.ok(m.results().innerHTML.includes("Deep Dive Daily"), "precondition: the catalogue row merged");
  assert.strictEqual(m.catalogueCalls().length, 1);

  m.type("deep ");                                    // same trimmed query
  assert.ok(m.results().innerHTML.includes("Deep Dive Daily"), "the merged row is still on the page the instant after the keystroke");
  await sleep(400);
  assert.strictEqual(m.catalogueCalls().length, 1, "no second request for the query already answered");

  const n = mount({ breadth: [{ show_id: "b-1", title: "Deep Dive Daily", tier: "breadth" }] });
  n.type("deep");                                     // tick pending
  n.input.value = "deep";
  n.byId.get("sh-form").fire("submit");               // return inside the debounce
  await sleep(400);
  assert.strictEqual(n.catalogueCalls().length, 1, "return ran the pending tick once, it did not add a second pass");
  assert.ok(n.results().innerHTML.includes("Deep Dive Daily"));
});

test("races-2: ✕ inside the debounce takes the in-flight search with it — no results, no episodes, no address for a query nobody can see", async () => {
  /* dismissShowSearch cleared the field and the paint but not the token or the
     pending tick, so the tick ran anyway: rows under an empty field, and
     noteShowQueryInRoute wrote `#/shows/q/<q>` back. MUTATION: delete the
     `supersedeShowSearch()` call at the top of dismissShowSearch. */
  const m = mount({ breadth: [{ show_id: "b-1", title: "Deep Dive Daily", tier: "breadth" }] });
  m.type("deep");
  m.ctx.dismissShowSearch(m.input);                   // inside the 250 ms window
  assert.strictEqual(m.input.value, "");
  await sleep(400);
  assert.strictEqual(m.results().hidden, true, `nothing may come back under the empty field: ${m.results().innerHTML}`);
  assert.strictEqual(m.catalogueCalls().length, 0, "the cleared query's passes never ran");
  assert.strictEqual(m.ctx.location.hash, "#/shows", "and the address stays at the root");
});

test("search-4: a DEGRADED catalogue reply (200, shows: [], degraded: true) is not cached and is reported as the failure it is", async () => {
  /* Defect 2's fix was applied to the directory pass only; the catalogue pass
     still wrote the degraded answer into its session cache and settled as
     "answered". MUTATION: change `answered` back to `!!data` in the catalogue
     pass — the cache holds the poisoned entry and no failure line paints. */
  const m = mount({ catalogueDegraded: true, directoryDegraded: true });
  m.input.value = "zz";                               // two characters: the directory pass does not run, so only the catalogue pass can report
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.strictEqual(m.evalIn('showBreadthQueryCache.has("zz")'), false, "a degraded reply is not an answer to remember");
  const partial = m.byId.get("sh-partial-note");
  assert.strictEqual(partial.hidden, false, "the pass that did not answer says so");
  assert.match(partial.innerHTML, /Part of this search didn't load\./);
  assert.match(partial.innerHTML, /data-retry/, "with Try again");
});

test("states-7: a dead episode endpoint under a FULL show list still says part of the search did not load, with Try again", async () => {
  /* The failure line lived in the EMPTY branch of paintShowResults, and the
     episode pass never reported at all — on Wi-Fi with no internet a few
     curated rows painted and the Episodes section silently never came.
     MUTATION: delete the `noteShowSearchFailure(query, myToken, "episodes")`
     line in renderEpisodeSearchResults's .then — red. Or paint the partial
     note only when `rows.length === 0` — the second mount goes red. */
  const m = mount({ episodesOk: false });
  m.input.value = "radiolab";                         // a curated hit: the list is NOT empty
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.ok(m.results().innerHTML.includes("Radiolab"), "precondition: rows are on the page");
  const partial = m.byId.get("sh-partial-note");
  assert.strictEqual(partial.hidden, false, "the episode failure is painted over a full list");
  assert.match(partial.innerHTML, /Part of this search didn't load\./);
  assert.match(partial.innerHTML, /data-retry/);

  const n = mount({ directoryOk: false });
  n.input.value = "radiolab";
  n.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.ok(n.results().innerHTML.includes("Radiolab"));
  assert.strictEqual(n.byId.get("sh-partial-note").hidden, false, "a failed show pass is painted over a full list too");

  const ok = mount();
  ok.input.value = "radiolab";
  ok.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.strictEqual(ok.byId.get("sh-partial-note").hidden, true, "and nothing failed, nothing is said");
});

test("states-7: Try again on the partial-load line re-runs the same search — and a failed search is re-runnable by return too", async () => {
  /* The failure line's Try again is the plain submit path; a search with a
     recorded failure is not "current" to isShowSearchCurrent, so the same
     query runs again from the top. MUTATION: make isShowSearchCurrent ignore
     showSearchFailure — return does nothing and the count stays at 1. */
  const m = mount({ episodesOk: false });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  const before = m.apiCalls().filter((u) => u.includes("api/episodes/search")).length;
  assert.strictEqual(before, 1);
  m.byId.get("sh-form").fire("submit");               // return, same query, after a failure
  await sleep(30);
  assert.strictEqual(m.apiCalls().filter((u) => u.includes("api/episodes/search")).length, 2, "the failed pass is asked again");
});

test("search-12 / states-9: offline, a NON-empty list carries the honest offline note and no failure line; the network passes' failure is explained, not stacked", async () => {
  /* Offline, the catalogue and directory passes fail (fetch rejects), so the
     failure line joined the offline note over the rows. The offline note is
     the explanation; a Try again with no connection is a button that does
     nothing. MUTATION: drop the `isOfflineForShardSearch()` clause from
     paintShowSearchPartialNote — the failure line paints alongside, red. */
  const m = mount({ onLine: false, directoryOk: false });
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  await sleep(30);
  assert.ok(m.results().innerHTML.includes("Radiolab"), "the local pass still answers offline");
  assert.strictEqual(m.byId.get("sh-offline-note").hidden, false, "the offline note explains the rows");
  assert.strictEqual(m.byId.get("sh-partial-note").hidden, true, "and no failure line is stacked on it");
});

test("search-5: the lit Search tab returns to the search that was left — to the top on the results, to the root only from the root", () => {
  /* The tab's href is the bare `#/shows`, so from an opened result the browser
     navigated there and renderAllShows("") threw the query away. MUTATION:
     delete the `href === "#/shows" && tabForHash(here) === "search"` branch
     of onTabBarClick — the first case navigates to the root, red. */
  const m = mount();
  m.type("lex");
  m.ctx.location.hash = "#/shows/q/lex";             // what noteShowQueryInRoute wrote on the tick
  m.evalIn('noteShowQueryInRoute("lex")');
  const tab = { getAttribute: (a) => (a === "href" ? "#/shows" : null) };
  const fire = () => { let prevented = false; m.ctx.onTabBarClick({ target: { closest: () => tab }, preventDefault() { prevented = true; } }); return prevented; };

  m.ctx.location.hash = "#/show/lex-fridman-podcast"; // a result was opened
  assert.strictEqual(fire(), true, "from a pushed page the tap is handled, not a navigation to the root");
  assert.strictEqual(m.ctx.location.hash, "#/shows/q/lex", "it pops back to the search that was left");

  m.ctx.location.hash = "#/shows/q/lex";             // on the results themselves
  assert.strictEqual(fire(), true, "on the results the tap is the same-tab gesture");
  assert.strictEqual(m.ctx.location.hash, "#/shows/q/lex", "and the results stay");

  m.ctx.dismissShowSearch(m.input);                   // the search was cleared: the tab's last stop is the root
  m.ctx.location.hash = "#/show/radiolab";
  assert.strictEqual(fire(), false, "with nothing to return to, the tap is the ordinary navigation to the root");

  m.ctx.location.hash = "#/library";                  // another tab: never touched
  assert.strictEqual(fire(), false);
});

test("search-3: return puts the keyboard away, and both search fields ask for the search keyboard without autocorrect", () => {
  /* The submit handler ran the search and never let go of the field, so
     WebKit's keyboard stayed up; the comments claimed the opposite. MUTATION:
     delete the `input.blur()` line in the #sh-form submit handler, or the
     `${SEARCH_INPUT_ATTRS}` from either input. */
  const m = mount();
  let blurred = 0;
  m.input.blur = () => { blurred++; };
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  assert.strictEqual(blurred, 1, "return blurs the field");
  assert.ok(m.results().innerHTML.includes("Radiolab"), "and the results stay");

  const attrs = 'enterkeyhint="search" autocorrect="off" autocapitalize="none" spellcheck="false"';
  assert.ok(APP_SRC.includes(`const SEARCH_INPUT_ATTRS = '${attrs}';`), "one constant holds the keyboard hints");
  assert.match(APP_SRC, /<input id="sh-input" type="text"[^>]*\$\{SEARCH_INPUT_ATTRS\}>/, "the Search page's field carries them");
  assert.match(APP_SRC, /<input data-show-ep-search-input type="text"[^>]*\$\{SEARCH_INPUT_ATTRS\}>/, "and the show page's episode field");
});

test("p-foray-4: typing a Foray's own subject finds the Foray — a Forays group above the shows, from the same list Home and Library read", () => {
  /* Search had no Foray result kind at all. The frozen fixture's published
     Foray is the one a listener could find. MUTATION: delete the
     `paintForaySearchResults(query, myToken)` call in paintShowSearchLocal —
     the group never paints, red. */
  const m = mount({ forays: FROZEN_FORAYS });
  const published = FROZEN_FORAYS.find((f) => f.id === "capital-types-1");
  assert.strictEqual(published.status, "published", "fixture: capital-types-1 is the published one");
  m.type("capital");
  const box = m.byId.get("fy-search-results");
  assert.strictEqual(box.hidden, false, "the Forays group paints on the keystroke");
  assert.ok(box.innerHTML.includes('href="#/foray/capital-types-1"'), `the Foray is linked: ${box.innerHTML}`);
  assert.ok(box.innerHTML.includes(m.ctx.esc(published.title)));
  assert.ok(box.innerHTML.includes("<h3>Forays</h3>"), "under its own heading");

  m.type("wrong default");                            // a running-order slot title, not in the title or summary
  assert.strictEqual(box.hidden, false, "slot titles count too");
  assert.ok(box.innerHTML.includes("capital-types-1"));

  m.type("grilling");                                 // a DRAFT's subject: not listed, not found
  assert.strictEqual(box.hidden, true, "a draft is not searchable, the same rule Home and Library apply");

  m.type("zzqx");
  assert.strictEqual(box.hidden, true, "nothing matched, nothing painted");
  assert.strictEqual(box.innerHTML, "");
});

test("ROUND 2 review (p-foray-4 / visual-9 / p-foray-8): a Foray found in Search is the SAME row as on #/forays — no FORAY tag under 'Forays', and its length line", () => {
  /* The group hand-copied the old row: a published hit wore a FORAY kicker
     right under its own <h3>Forays</h3> and had no length/progress line.
     MUTATION: put the hand-written row template back in
     paintForaySearchResults -> the kicker is back and the rows differ; red. */
  const m = mount({ forays: FROZEN_FORAYS });
  m.type("capital");
  const box = m.byId.get("fy-search-results");
  const html = box.innerHTML;
  assert.ok(html.includes('href="#/foray/capital-types-1"'), "precondition: the published Foray is found");
  assert.ok(!html.includes("fy-home-kicker"), `a published row does not restate the heading: ${html}`);
  const published = FROZEN_FORAYS.find((f) => f.id === "capital-types-1");
  const listRow = m.evalIn("forayRowsHtml")([published], { inSection: true });
  assert.ok(html.includes(listRow.trim()), "the row is the #/forays list's own row, byte for byte");
  assert.match(m.evalIn("forayListHtml").toString(), /forayRowsHtml\(/, "and #/forays renders through the same builder");
});

test("copy-8: every quoted query goes through the one typographic pair — no straight-quoted interpolation is left in a listener string", () => {
  /* The CTA used curly quotes and every other quoted query used straight ones,
     side by side on the empty-search screen. MUTATION: put `"${query}"`
     back in any of the five sites — the count goes to 1, red. */
  const straight = [...APP_SRC.matchAll(/[A-Za-z] "\$\{[^}]*\}"/g)].map((x) => x[0]);
  assert.deepStrictEqual(straight, [], `a listener string quotes an interpolation with straight quotes: ${JSON.stringify(straight)}`);
  assert.match(APP_SRC, /function quoteQuery\(text\) \{\s*return `\\u201c\$\{text\}\\u201d`;/, "the helper is the one place the pair lives");
  for (const site of [
    "No shows found for ${quoteQuery(query)}.",
    "Searching for ${quoteQuery(query)}…",
    "No episodes match ${quoteQuery(esc(searchQuery.trim()))}.",
    "Not much on ${quoteQuery(query)} yet",
    "Create a playlist about ${quoteQuery(esc(query))}",
    "Starts with ${quoteQuery(",
  ]) assert.ok(APP_SRC.includes(site), `site must use the helper: ${site}`);
  const m = mount();
  assert.strictEqual(m.evalIn("quoteQuery")("x"), "\u201cx\u201d");
});

test("search-9: the local passes and the dedup keys fold diacritics, so 'cafe' finds 'Café' on the device and an Apple 'Café X' is one show with the index's 'Cafe X'", () => {
  /* foldDiacritics reached rankShows and the shard pass on 2026-09-15 and not
     searchShows, prefixSearchShows, scanShowIndex or normaliseShowTitle.
     MUTATION: put `.toLowerCase()` back in place of `foldDiacritics` in
     searchShows (first block), in parseShowIndex/prefixSearchShows (second),
     or drop the NFKD strip from normaliseShowTitle (third). Each block goes
     red on its own. */
  const m = mount();
  const SE = m.evalIn("SearchEngine");
  assert.strictEqual(SE.searchShows("cafe", [{ show_id: "c", title: "Café con Pam" }]).length, 1, "the curated pass folds");
  assert.strictEqual(SE.searchShows("café", [{ show_id: "c", title: "Cafe con Pam" }]).length, 1, "in both directions");

  const idx = SE.parseShowIndex("Café Society\t1\t3\t0\nZebra Hour\t2\t4\t0\n");
  assert.deepStrictEqual([...idx.keys], ["cafe society", "zebra hour"], "the index keys are folded"); // spread: a vm-realm array has a foreign prototype
  assert.strictEqual(SE.prefixSearchShows("cafe", idx).length, 1, "the prefix pass folds the needle");
  assert.strictEqual(SE.scanShowIndex("societe", SE.parseShowIndex("La Société\t9\t3\t0\n")).length, 1, "the scan pass too");
  assert.strictEqual(SE.foldDiacritics("𝐁𝟑𝟒𝐧"), "b34n", "NFKD before lowercase: compatibility letters fold to plain lowercase");

  const norm = m.evalIn("normaliseShowTitle");
  assert.strictEqual(norm("Café X"), norm("Cafe X"), "the dedup key folds");
  /* Round-2 review: NFKD before lowercase, as foldDiacritics does. MUTATION:
     `.toLowerCase().normalize("NFKD")` in either copy -> red (the copies are
     pinned to each other above, so both move together). */
  assert.strictEqual(norm("𝐁𝟑𝟒𝐧’𝐬 𝐭𝐞𝐫𝐫𝐢𝐭𝐨𝐫𝐢𝐮𝐦"), norm("B34n's Territorium"), "a compatibility-letter title is the plain one");
  const merged = m.evalIn("mergeShowRows")("cafe",
    [{ show_id: "1000009", title: "Cafe X" }],
    [{ show_id: "555", title: "Café X", source: "apple" }]);
  assert.strictEqual(merged, null, "an Apple 'Café X' is the index's 'Cafe X', not a second row");
});
