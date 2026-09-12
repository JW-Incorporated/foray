/* S-06 (docs/search-plan.md): the Apple fall-through gate, and a breadth show
 * page that survives a reload.
 *
 * TWO HALVES OF ONE CARD, and they share a card because they share one
 * endpoint change (`api/shows/search.ts`). This suite is the CLIENT side of
 * both; the server side is `api/test/shows-search-apple.test.mjs`.
 *
 * (a) THE FALL-THROUGH GATE. Apple is asked only when nothing on the device
 *     matched. That gate is cheap — one URL parameter — and it is the one that
 *     protects a budget somebody else controls (<=20/min per warm instance,
 *     `api/episodes/appleBucket.ts`, with its own honest per-instance caveat).
 *     The endpoint has a SECOND gate over the full 19,904-row merged
 *     catalogue; neither is sufficient alone, and the reason is in that file's
 *     header. This suite proves the client's gate opens and shuts on the right
 *     condition, including the one S-03 changed: a show only the INDEX knows
 *     is a local hit, not a miss.
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

/** `{ ctx, byId, calls }` — `calls` is every URL the page asked for, in order. */
function mount({ indexBody = INDEX_TSV, indexOk = true, breadth = [], showById = null, idDelayMs = 0 } = {}) {
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

test("the fall-through is NOT asked for when the device already answered", () => {
  /* THE CARD'S OWN MUTATION LINE: "fire the fall-through on a non-empty local
     result → red". This is the client half of a two-gate design (the server
     half is in api/test/shows-search-apple.test.mjs) and it is the cheap gate:
     it costs one URL parameter and it stops a query the device already
     answered from ever reaching a 20/min budget.

     MUTATION: always append `&fallthrough=1`. Every search a listener does —
     including every one that matched locally — asks the endpoint to consider
     calling Apple, and this goes red. */
  const m = mount();
  m.input.value = "radiolab";
  m.byId.get("sh-form").fire("submit");
  const url = m.apiCalls().find((u) => u.includes("api/shows/search"));
  assert.ok(url, "the breadth pass must still fire");
  assert.ok(!url.includes("fallthrough"), `a local hit must not request the fall-through: ${url}`);
});

test("the fall-through IS asked for when nothing on the device matched", () => {
  /* The other direction, so the test above cannot be satisfied by never
     asking at all — which would leave S-06's whole feature dead and every
     suite green.

     MUTATION: drop the `&fallthrough=1` append. A query for a show in neither
     catalogue never reaches Apple and this goes red. */
  const m = mount();
  m.input.value = "zzqx-no-such-show-anywhere";
  m.byId.get("sh-form").fire("submit");
  const url = m.apiCalls().find((u) => u.includes("api/shows/search"));
  assert.ok(url.includes("fallthrough=1"), `a genuine local miss must request the fall-through: ${url}`);
});

test("the index's own hits close the gate: a show only the index knows stops the fall-through", async () => {
  /* The seam between S-03 and S-06, and the reason S-06 must not start before
     S-03. "Deep History Hour" is in the index and not in `state.catalog.shows`
     — so before S-03 this query was a zero-hit and would have asked Apple
     about a show we already hold. With the index loaded it is a local hit and
     the gate stays shut.

     MUTATION: make `localShowMatches` ignore `showIndex`. The query becomes a
     local miss again, `fallthrough=1` is appended, and this goes red. */
  const m = mount();
  m.input.fire("focus");
  await sleep(10);
  m.input.value = "deep history";
  m.byId.get("sh-form").fire("submit");
  const url = m.apiCalls().find((u) => u.includes("api/shows/search"));
  assert.ok(!url.includes("fallthrough"), `an index-only hit is still a hit: ${url}`);
});

test("an Apple fall-through result is rendered and cached like any other breadth row", async () => {
  /* The endpoint returns Apple rows in the SAME `shows` array and the SAME row
     shape as catalogue rows, deliberately, so the client needs no new branch.
     This is what pins that claim from the client's side: the row renders, it
     links to `#/show/:id`, and it is seeded into `state.breadthShowCache` so
     tapping it resolves.

     MUTATION: have the endpoint return Apple hits under a separate
     `apple_shows` key. Nothing renders and this goes red — which is the
     failure a "the server returns it" test alone would not catch. */
  const m = mount({ breadth: [{
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
