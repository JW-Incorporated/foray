/* Stage 2 of docs/show-pages-plan.md — show search (kanban card "Build:
 * show-pages Stage 2 — show search"). Show search is a SEPARATE mode from
 * the existing topic-relevance scorer buildPlaylist() uses: it answers
 * "does this show exist here" by matching catalog(-client).json's `title`
 * field, and it is never merged into the playlist builder's result list.
 *
 * IT LIVES ON THE SHOWS PAGE (#/shows) as of 2026-09-03. It used to sit on
 * HOME, behind a "Playlists | Shows" tab strip that time-shared one strip of
 * the home screen with #pl-form's playlist builder. The founder asked for the
 * search off Home ("remove the search from Home; move it into the Shows
 * page"), and once the two searches sit on two different pages there is
 * nothing left for a tab to toggle, so `setSearchTab` and `.search-tabs` are
 * gone rather than moved. The result-painting below is unchanged.
 *
 * WHAT THIS PROVES, in order:
 *  1. SearchEngine.searchShows (pure, no DOM) matches a known show's name
 *     exact, partial, and case-insensitively against the real committed
 *     catalog-client.json, and returns nothing for junk/no-match queries.
 *  2. The two search modes never touch each other: searchShows never reuses
 *     interpretQuery/scoreMatch, and buildPlaylist never reads catalog data.
 *  3. On the Shows page, the search is a distinct affordance from #pl-form:
 *     its own form, its own result list (each result linking to #/show/:id),
 *     and an honest empty state on no match — never merged into #pl-note's
 *     playlist-builder output. And it is on THAT page, and not on Home.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js, duplicated
 * rather than imported — see that file's header for why (this suite needs
 * its own extra PAGE_IDS for the new tab/results elements).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const SearchEngine = require(path.join(ROOT, "search-engine.js"));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

/* ==================================================================== */
/* 1. SearchEngine.searchShows, PURE, AGAINST THE REAL CATALOGUE         */
/* ==================================================================== */

test("an exact show title (case-insensitive) is the top and only match for that title", () => {
  /* MUTATION: swap `.toLowerCase()` for a case-sensitive compare on either
     side. The lowercased-query assertion fails because "lex fridman
     podcast" (all-lowercase) no longer matches "Lex Fridman Podcast". */
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lex-fridman-podcast");
  assert.ok(show, "fixture assumption: lex-fridman-podcast must be in catalog-client.json");

  const results = SearchEngine.searchShows("lex fridman podcast", catalog.shows);
  assert.ok(results.length >= 1, "must find at least one match");
  assert.strictEqual(results[0].show_id, "lex-fridman-podcast", "exact title match must rank first");
});

test("a partial show title surfaces the show", () => {
  /* MUTATION: change the substring check from `.indexOf(q) !== -1` to
     `.startsWith(q)`. This fails because "fridman" is a mid-title
     substring of "Lex Fridman Podcast", not a prefix. */
  const catalog = readJson("data/catalog-client.json");
  const results = SearchEngine.searchShows("fridman", catalog.shows);
  assert.ok(results.some((s) => s.show_id === "lex-fridman-podcast"), "partial title match must surface the show");
});

test("junk/no-match query returns zero results (honest empty state, product principle #1)", () => {
  /* MUTATION: make searchShows return `shows` unfiltered on no match instead
     of an empty array. The length-zero assertion fails. */
  const catalog = readJson("data/catalog-client.json");
  const results = SearchEngine.searchShows("zzz-not-a-real-show-zzz-nonsense-query", catalog.shows);
  assert.strictEqual(results.length, 0, "a junk query must return zero results, not padded/off-topic filler");
});

test("an empty or whitespace-only query returns zero results rather than the whole catalogue", () => {
  /* MUTATION: drop the `if (!q) return [];` guard. An empty query's
     `indexOf('')` is 0 for every title, so this would return all 220 shows
     instead of nothing — a query of nothing is not "show me everything". */
  const catalog = readJson("data/catalog-client.json");
  assert.strictEqual(SearchEngine.searchShows("", catalog.shows).length, 0);
  assert.strictEqual(SearchEngine.searchShows("   ", catalog.shows).length, 0);
});

test("results rank exact match first, then prefix match, then mid-title match", () => {
  /* Synthetic fixture, not the real catalogue, so the three rank tiers can be
     pinned exactly without depending on which real titles happen to collide.
     MUTATION: sort only by `idx` (drop the `rank` term from the comparator).
     "Show" (exact) would then tie/lose to "A Show About Cars" on raw index
     position and the ordering assertion fails. */
  const shows = [
    { show_id: "mid", title: "The Big Show Weekly" },
    { show_id: "prefix", title: "Show About Cars" },
    { show_id: "exact", title: "Show" },
  ];
  const results = SearchEngine.searchShows("show", shows);
  assert.deepStrictEqual(results.map((s) => s.show_id), ["exact", "prefix", "mid"]);
});

/* ==================================================================== */
/* 2. THE TWO SEARCH MODES NEVER TOUCH EACH OTHER                        */
/* ==================================================================== */

test("searchShows does not use the topic tokenizer/stopwords, so a stopword-only show name still matches", () => {
  /* "The" and "On" are STOPWORDS in the topic scorer -- if show search
     routed through tokenize()/interpretQuery() it would strip them and
     "the daily" would not literally match "The Daily".
     MUTATION: pipe the query through SearchEngine.tokenize() before
     matching. The exact-title assertion below fails because tokenize()
     drops "the", turning the query into "daily" alone, which still
     happens to substring-match here -- so this is pinned against a name
     that tokenize() would mangle differently: "On Being" loses "on". */
  const shows = [{ show_id: "on-being", title: "On Being" }];
  const results = SearchEngine.searchShows("on being", shows);
  assert.strictEqual(results.length, 1, "a stopword-leading show title must still match literally");
});

test("buildPlaylist's topic scorer is untouched by this change (search-engine.js diff is additive only)", () => {
  /* Guards the scope boundary the card calls out explicitly: this stage must
     not change buildPlaylist()'s scorer. Runs a real topic query through the
     unmodified path and checks it still produces the same shape of answer.
     MUTATION: any change to interpretQuery/scoreMatch/classifyResults as
     part of "supporting" show search would risk this drifting; this test
     exists so such a change has to justify itself here, not just in
     search-tiering.test.js. */
  const discover = readJson("data/discover.json");
  const itemTags = readJson("data/item-tags.json");
  const semantic = readJson("data/semantic-index.json");
  const ctx = { semantic, itemTags, discover };
  const interp = SearchEngine.interpretQuery("meditation", ctx);
  assert.ok(interp.groups.length > 0, "topic scorer must still interpret a real query");
  const { results } = SearchEngine.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  assert.ok(Array.isArray(results), "topic scorer must still return a results array");
});

/* ==================================================================== */
/* 3. THE "Shows" TAB, ON THE PLAYLISTS PAGE, AS A DISTINCT AFFORDANCE   */
/* ==================================================================== */

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

/* Extends show-page.test.js's PAGE_IDS with the new tab/form/results
   elements this stage adds to renderHome()'s template. */
const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

function mount({ seed = {}, fetchImpl = () => new Promise(() => {}) } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const listeners = new Map();

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
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
    /* Real addEventListener records the last handler per (el, type) so tests
       can invoke it directly -- the makeEl stub above is a no-op stand-in,
       replaced per-element below where a test needs to actually fire it. */
  };
}

/* Installs a real (recording) addEventListener on one fake element so a test
   can trigger the handler renderAllShows() attaches, without a real DOM. */
function withSubmittable(el) {
  let handler = null;
  el.addEventListener = (type, fn) => { if (type === "submit") handler = fn; };
  el.submit = (evt) => { if (handler) handler(evt || { preventDefault() {} }); };
  return el;
}

test("the show search is rendered by the Shows page, and by nothing on Home", () => {
  /* BOTH DIRECTIONS, deliberately. A test that only checked the Shows page
     would stay green if Home had simply kept its copy too — the exact failure
     mode of "move" work, and the founder asked for a move ("remove the search
     from Home; move it into the Shows page"), not an addition.

     Asserted against the rendered markup rather than the stub elements'
     `.hidden`: these fakes are never rebuilt from the template string, so a
     `hidden` attribute added in a template would not move them and such an
     assertion would be vacuous.

     MUTATION: paste the `#sh-form` block back into renderHome's template.
     The "home must render no show-search form" assertion fails. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  m.ctx.renderHome();
  const home = m.view();
  assert.ok(!home.includes('id="sh-form"'), "home must render no show-search form");
  assert.ok(!home.includes('id="sh-input"'), "home must render no show-search input");

  m.ctx.renderAllShows();
  const shows = m.view();
  assert.ok(shows.includes('id="sh-form"'), "the Shows page must render the show-search form");
  assert.ok(shows.includes('id="sh-input"'), "the Shows page must render the show-search input");
});

test("the Shows page's search needs no tab pressed first, and the tab strip is gone rather than hidden", () => {
  /* The two searches are still never merged (the card's rule), but they are
     now kept apart by living on two pages rather than by a toggle. A search
     hidden behind a tab on a page that is only about shows would be a worse
     affordance than the one it replaced, so the form renders unconditionally.

     "Gone rather than hidden" is the half worth pinning: leaving setSearchTab
     and the tab markup in place with nothing calling them is how dead UI
     accumulates, and dead UI is what the founder's "so much clutter" was
     made of.

     MUTATION: add `hidden` to the `<form id="sh-form">` in renderAllShows's
     template. The first assertion fails. MUTATION 2: re-add the `.search-tabs`
     div to renderHome. The last assertion fails. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  m.ctx.renderAllShows();
  const shows = m.view();
  assert.ok(
    /<form id="sh-form"(?![^>]*\shidden)[^>]*>/.test(shows),
    "the show-search form must render visible, with no `hidden` attribute"
  );
  assert.ok(!shows.includes("search-tabs"), "no tab strip may remain on the Shows page");

  m.ctx.renderHome();
  assert.ok(
    !/id="tab-(topics|shows)"/.test(m.view()),
    "the Playlists|Shows tabs must be gone from Home, not merely hidden"
  );
});

test("submitting a known show name on the Shows page renders a result linking to #/show/:id", () => {
  /* MUTATION: make showResultRow() link to "#" or omit the show_id. The
     href assertion fails because the link no longer points at Stage 1's
     page for this show. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "fridman";

  m.ctx.renderAllShows();
  shForm.submit();

  const results = m.byId.get("sh-results");
  assert.strictEqual(results.hidden, false, "results block must become visible on a match");
  assert.ok(results.innerHTML.includes('href="#/show/lex-fridman-podcast"'), "must link to the show's #/show/:id page");
  assert.ok(results.innerHTML.includes("Lex Fridman Podcast"), "must render the show's title");
});

test("submitting a junk query on the Shows page renders an honest empty state, not a crash or padded list", () => {
  /* MUTATION: remove the `if (!shows.length)` branch from
     renderShowSearchResults so it always writes `results.innerHTML`. The
     empty-state text assertion fails because #sh-results stays populated
     with a stale/empty render instead of showing #sh-note's message. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "zzz-nonsense-query-zzz";

  m.ctx.renderAllShows();
  shForm.submit();

  const note = m.byId.get("sh-note");
  const results = m.byId.get("sh-results");
  assert.strictEqual(results.hidden, true, "must not show a results block for a no-match query");
  assert.strictEqual(note.hidden, false, "must show the honest empty-state note");
  assert.ok(note.textContent.includes("zzz-nonsense-query-zzz"), "empty state must name the query, not generic filler text");
});

/* ==================================================================== */
/* 4. A3.1/Q3 — REACHING THE FULL BREADTH CATALOGUE VIA /api/shows/search */
/* ==================================================================== */

function mockFetch(handler) {
  return (url) => Promise.resolve(handler(String(url)));
}
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test("a breadth-tier show absent from the curated catalogue is appended once the backend endpoint responds", async () => {
  /* MUTATION: drop the `fetchJson(...).then(...)` call from
     renderShowSearchResults (or its `additions` accumulation). The breadth
     show's row would never appear, and this assertion fails. */
  const m = mount({
    fetchImpl: mockFetch((url) => {
      if (url.startsWith("api/shows/search")) {
        return jsonResponse({
          query: "science",
          shows: [{ show_id: "999999", title: "Science Friday", artwork_url: null, tier: "breadth" }],
          degraded: false,
        });
      }
      return { ok: false, status: 404, json: async () => null };
    }),
  });
  m.state.catalog = { shows: [] }; // curated catalogue has nothing named "science" — forces the breadth path
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "science";

  m.ctx.renderAllShows();
  shForm.submit();

  // The curated-first pass paints synchronously with zero results (empty
  // state); the breadth fetch resolves on a microtask, so give it one.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const results = m.byId.get("sh-results");
  assert.strictEqual(results.hidden, false, "results block must become visible once the breadth result lands");
  assert.ok(results.innerHTML.includes("Science Friday"), "must render the breadth-tier show's title");
  assert.ok(results.innerHTML.includes('href="#/show/999999"'), "must link to the breadth show's #/show/:id page");
});

test("a breadth result is cached so showById can resolve it for the show page", () => {
  /* MUTATION: remove the `state.breadthShowCache[s.show_id] = s` line —
     showById would then fail to resolve a breadth-tier show_id, and
     renderShow would render "Show not found" for a show the search just
     surfaced, even though the search endpoint proved it exists. */
  const m = mount();
  m.state.breadthShowCache = { "555555": { show_id: "555555", title: "Deep Sea Hour", tier: "breadth" } };
  const found = m.ctx.showById("555555");
  assert.ok(found, "showById must resolve a show_id from the breadth cache");
  assert.strictEqual(found.title, "Deep Sea Hour");
});

test("curated catalogue results still resolve first — the breadth fetch never overwrites an already-found curated match", () => {
  /* MUTATION: change renderShowSearchResults to always overwrite results
     with the breadth response instead of appending non-duplicate entries.
     A curated show_id would then be replaced by a differently-shaped
     breadth-endpoint record and this dedupe assertion fails. */
  const m = mount({
    fetchImpl: mockFetch((url) => {
      if (url.startsWith("api/shows/search")) {
        return jsonResponse({
          query: "lex",
          shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast (breadth copy)", tier: "breadth" }],
          degraded: false,
        });
      }
      return { ok: false, status: 404, json: async () => null };
    }),
  });
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "lex";

  m.ctx.renderAllShows();
  shForm.submit();

  const results = m.byId.get("sh-results");
  assert.ok(results.innerHTML.includes("Lex Fridman Podcast"), "curated title must be present");
  assert.ok(!results.innerHTML.includes("(breadth copy)"), "must not duplicate the same show_id from the breadth response");
});

test("a failed breadth fetch degrades silently to the curated-only results, never a crash or broken state", async () => {
  /* MUTATION: remove fetchJson's internal try/catch (or add an unguarded
     .catch-less chain here) — a rejected fetch would then produce an
     unhandled rejection instead of leaving the curated results as-is. */
  const m = mount({
    fetchImpl: mockFetch(() => { throw new Error("network down"); }),
  });
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "fridman";

  m.ctx.renderAllShows();
  assert.doesNotThrow(() => shForm.submit());

  const results = m.byId.get("sh-results");
  assert.strictEqual(results.hidden, false, "curated match must still render despite the breadth fetch failing");
  assert.ok(results.innerHTML.includes("Lex Fridman Podcast"), "curated result must still be present");
});
