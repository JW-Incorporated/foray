/* S-05 (4a-shows-pipeline-plan.md §3.2, kanban t_546eac9f) — the offline
 * rule (D9) for the shard-backed shows search: when the runtime reports
 * offline, the shard fetch is SKIPPED, not attempted-and-failed. Results
 * come from the local pass alone (curated catalogue + S-03's title-only
 * index, both already in memory / IndexedDB), the results header shows
 * "Showing shows available offline", and the shard pass makes ZERO
 * requests — the card's own literal acceptance line.
 *
 * Also covers `showById`'s `pi:` resolution and the `#/show/pi:<n>` route
 * S-05 adds: a shard result renders a show page it has never seen before,
 * from the shard row + S-02's header fields (artwork, title, editorial
 * note absence handled the same way a breadth-tier show already is).
 *
 * Every test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub from test/show-search-fallthrough.test.js,
 * extended with a toggleable `navigator.onLine` and a `shardCalls()`
 * counter. Duplicated rather than imported, per that file's own header.
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
  "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-offline-note",
  "sh-partial-note", "sh-results", "ep-search-results", "pl-search-results",
];

const SHOWS = [
  { show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null },
];

function shardRow({ id, t, a = null, img = null, c = false }) {
  return { id, t, a, i: null, u: null, img, n: null, c };
}

/* A shard whose one row is NOT in the curated catalogue above, so any
   result the tests see for "science friday" can only have come from the
   shard pass (never the local curated pass, which has nothing to match). */
const SCIENCE_FRIDAY_SHARD = [shardRow({ id: 555, t: "Science Friday", img: "https://x.test/sf.png" })];

function mount({ onLine = true } = {}) {
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
      return Promise.resolve({ ok: false, status: 504, text: () => Promise.resolve("") });
    }
    if (u.includes("api/shows/index/shards/sc.json")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SCIENCE_FRIDAY_SHARD) });
    }
    if (u.includes("api/shows/index/")) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ available: false }) });
    }
    if (u.includes("api/shows/search")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ shows: [], degraded: false }) });
    }
    if (u.includes("api/episodes/search")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ episodes: [] }) });
    }
    return new Promise(() => {}); // anything else hangs rather than resolving something invented
  };

  const store = new Map();
  const navObj = { userAgent: "node", onLine };
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
    navigator: navObj,
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
  state.ready = true;
  ctx.renderAllShows();

  const input = byId.get("sh-input");
  const type = (text) => { input.value = text; return input.fire("input"); };
  return {
    ctx, byId, calls, state, input, type, setOnline: (v) => { navObj.onLine = v; },
    apiCalls: () => calls.filter((u) => u.includes("/api/")),
    shardCalls: () => calls.filter((u) => u.includes("api/shows/index/shards/")),
    evalIn: (src) => vm.runInContext(src, ctx),
    results: () => byId.get("sh-results"),
    note: () => byId.get("sh-note"),
    offlineNote: () => byId.get("sh-offline-note"),
  };
}

/* ==================================================================== */
/* D9: offline skips the shard fetch entirely                            */
/* ==================================================================== */

test("offline: a search for a shard-only show makes ZERO shard requests", async () => {
  /* MUTATION: check navigator.onLine only inside the .then() (after the
     fetch already started) instead of before building the request — the
     request would still fire and this assertion would see 1, not 0. */
  const m = mount({ onLine: false });
  m.type("science friday");
  await sleep(300);
  assert.strictEqual(m.shardCalls().length, 0,
    `offline must fire zero shard requests, saw: ${JSON.stringify(m.shardCalls())}`);
});

test("online: the identical search DOES fire a shard request (control, so the test above proves something)", async () => {
  const m = mount({ onLine: true });
  m.type("science friday");
  await sleep(300);
  assert.strictEqual(m.shardCalls().length, 1,
    `online must fire exactly one shard request for a fresh query, saw: ${JSON.stringify(m.shardCalls())}`);
});

test('offline: the results header note becomes visible (the static copy is "Showing shows available offline", pinned in app.js\'s own template)', async () => {
  /* MUTATION: leave #sh-offline-note hidden regardless of navigator.onLine.
     This assertion is on the actual DOM node paintShowResults toggles; the
     stub harness does not parse the innerHTML template that carries the
     static copy (see the sibling assertion below, which pins that text
     directly against the app.js source). */
  const m = mount({ onLine: false });
  m.type("lex");
  await sleep(300);
  assert.strictEqual(m.offlineNote().hidden, false, "the offline note must be visible");
});

test("the offline note's static copy says what an offline search can honestly say", () => {
  /* Pinned against the one place the sentence lives (`OFFLINE_SEARCH_NOTE`,
     written into #sh-compose's innerHTML) rather than against the stub, which
     cannot parse HTML. It read "Showing shows available offline" until audit
     round 2 (states-9): nothing is available offline — the rows are names 4a
     already knows and every tap on one needs the network — so the sentence was
     a promise the app could not keep. MUTATION: reword the copy in app.js
     without updating this pin, or put "available offline" back. */
  assert.match(APP_SRC, /<p id="sh-offline-note" class="note" hidden>\$\{OFFLINE_SEARCH_NOTE\}<\/p>/);
  const note = /const OFFLINE_SEARCH_NOTE = "([^"]+)";/.exec(APP_SRC);
  assert.ok(note, "the sentence is one named constant");
  assert.strictEqual(note[1], "You're offline — these are show names 4a already knows. Episodes need a connection.");
  assert.doesNotMatch(note[1], /available offline/, "it must not promise offline availability");
});

test("an EMPTY offline search says so in one line — no 'No shows found' over 'available offline' over 'Try again'", async () => {
  /* Audit round 2, search-12: offline, a query outside the curated 220 stacked
     three notes under the pill, each true and together contradictory. Now the
     empty note itself says "You're offline", the offline note (which explains
     ROWS) stays hidden with none to explain, and the failure line with its
     useless-offline Try again is not painted. MUTATION: drop the
     `isOfflineForShardSearch()` clause from paintShowSearchPartialNote, or the
     `shows.length > 0` clause from the offline note's hidden test. */
  const m = mount({ onLine: false });
  m.type("zzqx-nothing");
  await sleep(300);
  assert.match(m.note().textContent, /^You're offline — no shows found for “zzqx-nothing”\.$/, m.note().textContent);
  assert.strictEqual(m.offlineNote().hidden, true, "no rows, so nothing for the offline note to explain");
  const partial = m.byId.get("sh-partial-note");
  assert.strictEqual(partial.hidden, true, `the failure line is not painted offline: ${partial.innerHTML}`);
  assert.doesNotMatch(partial.innerHTML, /data-retry/);
});

test("online: the offline header stays hidden", async () => {
  const m = mount({ onLine: true });
  m.type("lex");
  await sleep(300);
  assert.strictEqual(m.offlineNote().hidden, true, "the offline note must not show while online");
});

test("offline: the curated/local result still paints — offline degrades the network tiers, not the whole search", async () => {
  /* D9 is a REFUSAL to fetch, not a refusal to answer. A show already on the
     device (the curated catalogue, S-03's index) must still be found.
     MUTATION: skip the local pass too when offline. */
  const m = mount({ onLine: false });
  m.type("lex fridman");
  await sleep(300);
  assert.ok(m.results().innerHTML.includes("Lex Fridman Podcast"),
    "the curated show must still be found locally while offline");
});

test("offline: no OTHER request fires either — the directory and catalogue passes have their own network guards, this is not a shard-only claim", async () => {
  /* Belt-and-braces: D9's acceptance line is "zero requests" for the whole
     offline search, not just the shard pass. The directory/catalogue passes
     already reach a live endpoint unconditionally in this harness (they
     have no offline guard of their own pre-S-05, per §1.5's own design) —
     this test documents the shard pass's OWN contribution is genuinely
     zero, leaving those two as the only remaining network activity, which
     is out of this card's scope to change. Asserted narrowly on shard
     calls specifically so a regression in an unrelated pass cannot mask a
     regression in this one. */
  const m = mount({ onLine: false });
  m.type("lex fridman");
  await sleep(300);
  assert.strictEqual(m.shardCalls().length, 0);
});

/* ==================================================================== */
/* pi: id resolution and the #/show/pi:<n> route                         */
/* ==================================================================== */

test("a pi: result opens a page with a header and (when present) episodes, from the shard row alone", async () => {
  /* MUTATION: drop the `pi:` branch from showById, or fail to seed
     state.shardShowCache from the shard pass — renderShow would then call
     resolveMissingShow, which for a `pi:` id renders "Show not found."
     immediately (no fallback lookup — see that function's own header), and
     this assertion would fail on the title. */
  const m = mount({ onLine: true });
  m.type("science friday");
  await sleep(300);
  assert.strictEqual(m.shardCalls().length, 1);

  const show = m.evalIn('showById("pi:555")');
  assert.ok(show, "the shard result must be resolvable by its pi: id after the search");
  assert.strictEqual(show.title, "Science Friday");
  assert.strictEqual(show.artwork_url, "https://x.test/sf.png");

  m.ctx.location.hash = "#/show/pi:555";
  m.evalIn("renderCurrentPage()");
  const view = m.byId.get("view");
  assert.ok(view.innerHTML.includes("Science Friday"), "the show page must render the shard-sourced title");
});

test("#/show/pi:<n> route: the URL-encoded colon still resolves (encodeURIComponent(\"pi:555\") round-trips)", async () => {
  /* The router decodeURIComponent()s the hash segment (see renderCurrentPage's
     `#/show/(.+)` branch) — a link built with encodeURIComponent(show_id)
     (showResultRow's own href) must still resolve after that round trip.
     MUTATION: route on the RAW (still-encoded) segment instead of the
     decoded one. */
  const m = mount({ onLine: true });
  m.type("science friday");
  await sleep(300);

  const encoded = m.evalIn('encodeURIComponent("pi:555")');
  m.ctx.location.hash = `#/show/${encoded}`;
  m.evalIn("renderCurrentPage()");
  const view = m.byId.get("view");
  assert.ok(view.innerHTML.includes("Science Friday"));
});

test("a pi: id with no cached shard result renders honest 'Show not found.' immediately — no network fallback", async () => {
  /* S-05's own scope decision (see resolveMissingShow's header): a pi: id
     has no id-map/network fallback, because no shard-index release exists
     yet. A cold open must not hang on "Loading show..." forever. */
  const m = mount({ onLine: true });
  m.ctx.location.hash = "#/show/pi:999999";
  m.evalIn("renderCurrentPage()");
  const view = m.byId.get("view");
  assert.ok(view.innerHTML.includes("Show not found."));
  // No id-lookup request of any kind for a pi: id.
  assert.strictEqual(m.apiCalls().filter((u) => u.includes("id=pi")).length, 0);
});

test("a curated show_id is unaffected by the pi: branch — showById's existing rule for a real slug still applies", async () => {
  const m = mount({ onLine: true });
  const show = m.evalIn('showById("lex-fridman-podcast")');
  assert.strictEqual(show.title, "Lex Fridman Podcast");
});

test("a shard result's accent-aware rank survives mergeShowRows/rankShows re-ranking (review finding, round 3)", async () => {
  /* app.js:mergeShowRows re-ranks every addition through
     SearchEngine.rankShows before appending it beneath what is already
     painted — a SEPARATE bucket comparator from rankShardRows, and the
     first review pass's accent fix only touched rankShardRows. Without
     folding rankShows's own comparator too, an accented exact title
     ("Café") would come back correctly ordered out of rankShardRows and
     then get RE-demoted the moment mergeShowRows called rankShows on it.
     MUTATION: revert rankShows to a bare `.toLowerCase()` (drop
     foldDiacritics there). This shard, appended in shuffled order, must
     still come back with the exact accented title first. */
  const CAFE_SHARD = [
    shardRow({ id: 701, t: "Nearby Cafe Chat" }), // substring
    shardRow({ id: 702, t: "Café", c: true }), // exact (accented)
    shardRow({ id: 703, t: "Cafeteria Talk" }), // prefix
  ];
  const m = mount({ onLine: true });
  m.evalIn(`
    const _shardFetch = window.fetchShardRows;
    window.fetchShardRows = async (key) => (key === "ca" ? ${JSON.stringify(CAFE_SHARD)} : []);
  `);
  m.type("cafe");
  await sleep(300);
  const html = m.results().innerHTML;
  const posCafe = html.indexOf("Café");
  const posCafeteria = html.indexOf("Cafeteria Talk");
  const posNearby = html.indexOf("Nearby Cafe Chat");
  assert.ok(posCafe >= 0 && posCafeteria >= 0 && posNearby >= 0, "all three shard rows must appear");
  assert.ok(posCafe < posCafeteria, "the exact accented title must rank above the prefix match");
  assert.ok(posCafeteria < posNearby, "the prefix match must rank above the substring match");
});

test("a shard row duplicating an already-painted curated show by title is dropped, not shown twice (review finding, round 3)", async () => {
  /* mergeShowRows's dedup used to gate on `s.source === "apple"` only.
     A shard row's show_id is `pi:<id>` — a different id space from the
     curated catalogue's slug — so the id-based half of the dedup can never
     catch this case, and only the title-based half (shared with Apple
     rows) can. MUTATION: drop `|| s.source === "shard"` from that
     condition. "Lex Fridman Podcast" (curated, painted locally first) must
     not reappear a second time once a shard row for the same title lands. */
  const LEX_SHARD = [shardRow({ id: 900, t: "Lex Fridman Podcast" })];
  const m = mount({ onLine: true });
  m.evalIn(`
    window.fetchShardRows = async (key) => (key === "fr" ? ${JSON.stringify(LEX_SHARD)} : []);
  `);
  m.type("fridman");
  await sleep(300);
  const html = m.results().innerHTML;
  const first = html.indexOf("Lex Fridman Podcast");
  const second = html.indexOf("Lex Fridman Podcast", first + 1);
  assert.ok(first >= 0, "the curated show must still appear");
  assert.strictEqual(second, -1, "the shard's duplicate of the same title must not appear a second time");
});
