/* Stage 1 of docs/show-pages-plan.md — the standalone `#/show/:id` page over
 * data already sitting unused in the client (kanban card "Build: per-show
 * pages Stage 1"). See the plan for the full data-model reasoning.
 *
 * WHAT THIS PROVES, in order:
 *  1. A valid show_id renders the header (artwork, title, editorial note,
 *     taxonomy chips) plus every discover-pool episode for that show, each
 *     playable exactly as a playlist row is today.
 *  2. An unknown show_id renders "Show not found", not a crash — the same
 *     shape renderPlaylistDetail already guards.
 *  3. The Lingthusiasm fallback-match path BY NAME: it is the one show
 *     catalog.json's title-join misses (its catalog.json title carries a
 *     subtitle its discover.json `show` field does not), so it is the one
 *     case that actually exercises TITLE_ALIASES rather than the show_id
 *     join succeeding by construction.
 *  4. The route wires `#/show/:id` into route() the same way `#/playlist/:id`
 *     already does.
 *  5. `data/catalog-client.json` (the projected copy `tools/build-catalog-
 *     client.mjs` derives) is in sync with `data/catalog.json` and carries
 *     the exact field whitelist renderShow() reads.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/playlist-durability.test.js,
 * duplicated rather than imported — that file's helpers are scoped to
 * playlist fixtures (poolItem, setPool, rotateOut) this suite does not need,
 * and a shared harness module is a bigger refactor than this card's scope.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

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

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
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
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

const rowCount = (html) => (html.match(/class="ep-row/g) || []).length;

/* ==================================================================== */
/* 1. A VALID show_id RENDERS HEADER + EPISODES, AGAINST THE REAL DATA   */
/* ==================================================================== */

test("a valid show_id renders artwork, title, editorial note and taxonomy chips", async () => {
  /* "making-chips" is picked deliberately: it joins on show_id cleanly (not the
     fallback path — that is tested separately below) AND carries a non-null
     artwork_url in catalog.json, which not every show does (e.g.
     lex-fridman-podcast's show-level record has none, even though its
     episodes do) — so this is the header test, not the episode-count one.

     MUTATION: drop the `show.editorial_note ?` branch from renderShow's
     template. The editorial-note assertion fails. MUTATION 2: drop the chips
     line. The taxonomy label assertion fails. MUTATION 3: drop the
     `show.artwork_url ?` branch. The artwork assertion fails. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "making-chips");
  assert.ok(show, "fixture assumption: making-chips must be in catalog-client.json");
  assert.ok(show.artwork_url, "fixture assumption: making-chips must carry a show-level artwork_url");

  m.ctx.renderShow("making-chips");
  const html = m.view();
  assert.ok(html.includes(m.ctx.esc(show.title)), "must render the show title");
  assert.ok(html.includes(m.ctx.esc(show.editorial_note)), "must render the editorial note");
  assert.ok(html.includes('class="show-art"'), "must render the artwork image");
  const taxonomy = readJson("data/taxonomy.json");
  for (const nodeId of show.taxonomy_node_ids) {
    const label = taxonomy.nodes.find((n) => n.id === nodeId)?.label || nodeId;
    assert.ok(html.includes(m.ctx.esc(label)), `must render the "${label}" taxonomy chip`);
  }
});

test("every discover-pool episode for the show renders as a playable ep-row", async () => {
  /* Cross-checked against an independent count straight off discover.json, not
     against renderShow's own join — so a join that silently dropped or
     duplicated episodes would be caught here rather than agreeing with itself.

     MUTATION: change episodesForShow's filter to `.slice(0, 1)` (or any other
     truncation). The row-count assertion fails because it no longer matches
     the independently-counted expectation. */
  const m = await mountBooted();
  const discover = readJson("data/discover.json");
  const expected = discover.items.filter((it) => it.show === "Lex Fridman Podcast");
  assert.ok(expected.length > 1, "fixture assumption: need a multi-episode show");

  m.ctx.renderShow("lex-fridman-podcast");
  const html = m.view();
  assert.strictEqual(rowCount(html), expected.length, "row count must match the discover pool exactly");
  for (const ep of expected.slice(0, 3)) {
    assert.ok(html.includes(m.ctx.esc(ep.title)), `must render episode "${ep.title}"`);
  }
});

/* ==================================================================== */
/* 2. NOT-FOUND STATE                                                    */
/* ==================================================================== */

test("an unknown show_id renders 'Show not found', not a crash", () => {
  /* Mirrors renderPlaylistDetail's existing "Playlist not found" guard —
     asserted with a synthetic pool so this test does not depend on the
     network/boot path at all.

     MUTATION: remove the `if (!show)` guard from renderShow. This throws
     (reading .title off null) instead of rendering the not-found copy, and
     the test fails with an uncaught exception rather than a clean assertion. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  assert.doesNotThrow(() => m.ctx.renderShow("this-show-does-not-exist"));
  const html = m.view();
  assert.ok(html.includes("Show not found"), `expected a not-found message, got: ${html}`);
  assert.strictEqual(rowCount(html), 0, "must render zero episode rows for an unknown show");
});

/* ==================================================================== */
/* 2b. A3.1/Q3 — BREADTH-TIER SHOW PAGE DEGRADES HONESTLY (no Stage 3b   */
/*     episode list wired in yet — see kanban t_567b570f)                */
/* ==================================================================== */

test("a breadth-tier show (found via search, zero curated episodes) shows an honest 'fetching' state, not an empty/broken page", () => {
  /* MUTATION: drop the `isBreadthTier` branch from renderShow so a breadth
     show with zero discover-pool episodes falls through to the curated-tier
     "No episodes... right now" copy. That copy implies the show is empty,
     which is false for a breadth-tier show whose real episode list Stage 3b
     (t_567b570f) hasn't wired in yet — this test pins the distinct, honest
     copy the card's own constraint requires. */
  const m = mount();
  m.state.catalog = { shows: [] }; // not in the curated set
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.breadthShowCache = {
    "999999": { show_id: "999999", title: "Deep Sea Engineering Hour", tier: "breadth", artwork_url: null, taxonomy_node_ids: [], editorial_note: null },
  };

  assert.doesNotThrow(() => m.ctx.renderShow("999999"));
  const html = m.view();
  assert.ok(html.includes("Deep Sea Engineering Hour"), "must render the breadth show's title");
  assert.ok(!html.includes("Show not found"), "a breadth-tier show_id must resolve, not 404");
  assert.ok(!html.includes("No episodes from this show are in 4a's catalogue right now"), "must NOT use the curated-tier empty copy, which implies the show has none");
  assert.ok(html.toLowerCase().includes("fetching"), "must show an honest in-progress state instead");
  assert.strictEqual(rowCount(html), 0, "no episode rows yet — Stage 3b (t_567b570f) wires the real list in separately");
});

test("a curated-tier show with genuinely zero discover-pool episodes keeps its original empty-state copy (regression guard)", () => {
  /* MUTATION: remove the `isBreadthTier` condition entirely so EVERY
     zero-episode show gets the breadth "fetching" copy. This test catches
     that regression: a curated show is not "still loading," it genuinely
     has none, and must keep saying so. */
  const m = mount();
  m.state.catalog = {
    shows: [{ show_id: "curated-no-eps", title: "Curated No Episodes Show", artwork_url: null, taxonomy_node_ids: [], editorial_note: null }],
  };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };

  m.ctx.renderShow("curated-no-eps");
  const html = m.view();
  assert.ok(html.includes("No episodes from this show are in 4a's catalogue right now"), "curated-tier zero-episode state must be unchanged");
  assert.ok(!html.toLowerCase().includes("fetching"), "must not show the breadth-tier in-progress copy for a curated show");
});

test("route() dispatches #/show/:id to renderShow, matching the #/playlist/:id pattern", () => {
  /* Pins the wiring itself, not just renderShow in isolation — a route()
     regex that stops matching would leave renderShow correct and unreachable.

     MUTATION: delete the `#/show/` branch from route(). This test fails
     because renderHome (the fallback) runs instead and the view never
     contains the not-found copy renderShow would have produced. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/show/unknown-show";
  m.ctx.route();
  assert.ok(m.view().includes("Show not found"), "route() must dispatch to renderShow for #/show/:id");
});

/* ==================================================================== */
/* 3. THE Lingthusiasm FALLBACK PATH, BY NAME                            */
/* ==================================================================== */

test("Lingthusiasm resolves via the title-alias fallback, not the show_id join", async () => {
  /* THE ONE SHOW docs/show-pages-plan.md flags as not guaranteed to join by
     title equality (§1). catalog.json's title carries a subtitle
     ("Lingthusiasm - A podcast that's enthusiastic about linguistics") that
     discover.json's `show` field does not ("Lingthusiasm"), so an exact-title
     match alone would render zero episodes here even though the show_id join
     itself succeeds.

     MUTATION 1: delete TITLE_ALIASES' one entry. The episode-row assertion
     fails — episodesForShow finds nothing, because the exact-title filter
     alone misses every Lingthusiasm episode.
     MUTATION 2: replace the alias-aware Set with plain exact-title matching
     (`it.show === show.title`). Same failure, for the same reason: this
     mutation IS deleting the alias in effect. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lingthusiasm");
  assert.ok(show, "fixture assumption: lingthusiasm must be in catalog-client.json");
  assert.notStrictEqual(show.title, "Lingthusiasm", "fixture assumption: the catalog title must NOT equal the discover.json show name (that is the whole reason this test exists)");

  const discover = readJson("data/discover.json");
  const expected = discover.items.filter((it) => it.show === "Lingthusiasm" || it.show === show.title);
  assert.ok(expected.length > 0, "fixture assumption: discover.json must carry Lingthusiasm episodes under the short name");

  m.ctx.renderShow("lingthusiasm");
  const html = m.view();
  assert.strictEqual(rowCount(html), expected.length, "the fallback join must find every Lingthusiasm episode");
  for (const ep of expected) {
    assert.ok(html.includes(m.ctx.esc(ep.title)), `must render "${ep.title}" via the fallback join`);
  }
});

test("episodesForShow: a show with an id-matched title needs no alias and is unaffected by the fallback Set", () => {
  /* Guards the OTHER direction: adding the alias machinery must not start
     matching episodes across shows for the 219 shows that join cleanly.

     MUTATION: make the wanted-set include every show's title (e.g. drop the
     `.filter(Boolean)` and let a `TITLE_ALIASES[show.title]` of `undefined`
     leak in as a literal "undefined" string, or broaden the filter to a
     substring match). The cross-show assertion below would then admit an
     item from a different show, and this fails. */
  const m = mount();
  const items = [
    { id: "a--1", show: "Show A", title: "A1" },
    { id: "b--1", show: "Show B", title: "B1" },
  ];
  m.state.discover = { items };
  const showA = { show_id: "show-a", title: "Show A" };
  const result = m.ctx.episodesForShow(showA);
  assert.strictEqual(result.length, 1, "must match only Show A's own episode");
  assert.strictEqual(result[0].id, "a--1");
});

/* ==================================================================== */
/* 4. data/catalog-client.json STAYS IN SYNC WITH data/catalog.json      */
/* ==================================================================== */

test("catalog-client.json is derived from catalog.json via the committed build script", () => {
  /* Pins that the checked-in derived file is not stale — CI has no separate
     "regenerate and diff" step, so a hand-edited or out-of-date
     catalog-client.json would otherwise ship silently.

     MUTATION: edit data/catalog-client.json by hand after a catalog.json
     change without re-running the build script. This fails on the byte
     comparison. */
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, "tools", "build-catalog-client.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.ok(out.includes("up to date"), out);
});

test("catalog-client.json carries exactly the six fields renderShow() reads, for every show", () => {
  /* The whitelist is the decision, so it is pinned literally — same pattern as
     playlist-durability.test.js's PLAYLIST_PART_FIELDS pin.

     MUTATION: add a field to CLIENT_SHOW_FIELDS in tools/build-catalog-
     client.mjs (e.g. `feed_url`) without a reason. This fails, because the
     projected shape grows past what this test allows. */
  const client = readJson("data/catalog-client.json");
  const expectedKeys = ["show_id", "title", "artwork_url", "editorial_note", "taxonomy_node_ids", "episode_count"].sort();
  for (const show of client.shows) {
    assert.deepStrictEqual(Object.keys(show).sort(), expectedKeys, `show ${show.show_id} has an unexpected field set`);
  }
});

/* ==================================================================== */
/* 5. STAGE 4 — SHOW-NAME LINKS ON epRow/archivedRow/renderEpisode       */
/* ==================================================================== */

test("epRow links its show-name text to #/show/:show_id when the show is in catalog.json", async () => {
  /* Against the real committed data, not a synthetic fixture, so this proves
     the join actually resolves for real content, not just the shape of the
     code. Reuses renderShow's own render (epRow is exactly what it calls) so
     this is also an end-to-end proof, not a unit test in isolation.

     MUTATION: change showNameLink's template to a plain `${label}` (drop the
     `<a>` wrapper). This assertion fails because no `#/show/lex-fridman-podcast`
     href appears anywhere in the output. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lex-fridman-podcast");
  assert.ok(show, "fixture assumption: lex-fridman-podcast must be in catalog-client.json");

  m.ctx.renderShow("lex-fridman-podcast");
  const html = m.view();
  assert.ok(
    html.includes(`<a class="show-link" href="#/show/lex-fridman-podcast">${m.ctx.esc(show.title)}</a>`),
    "every epRow on the show's own page must link its show name back to that show's page"
  );
});

test("epRow/archivedRow do not touch the play/star/external-link controls (PR #357 regression)", () => {
  /* Explicit regression coverage per the card body — Stage 4 must add a link
     on the show-name text ONLY. Asserts the exact set of controls next to a
     synthetic row is unchanged shape, independent of the row-count suite in
     test/playlist-durability.test.js (also re-run, unchanged, for this PR).

     MUTATION: remove starBtn/upNextBtn/playBtn from epRow's template. This
     assertion fails because the corresponding class disappears. */
  const m = mount();
  const item = { id: "ep-x", title: "X", show: "Unlisted Show", duration_min: 10, audio_url: "https://example.com/a.mp3" };
  const html = m.ctx.epRow(item, 0, "ctx-1", -1);
  assert.match(html, /class="play-btn"/, "play button must be present, unchanged");
  assert.match(html, /class="star /, "star toggle must be present, unchanged");
  assert.match(html, /data-upnext=/, "up-next control must be present, unchanged");
  assert.strictEqual((html.match(/class="play-btn"/g) || []).length, 1, "exactly one play control per row (PR #357)");
});

test("archivedRow links its show-name text to #/show/:show_id for a gone episode", () => {
  /* An archived part's show is still browsable even though the specific
     episode aged out of the catalogue — the card body calls this out by name.

     MUTATION: make archivedRow use `esc(item.show)` again instead of
     showNameLink(item.show). This assertion fails because no anchor appears. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "gone-show", title: "Gone Show" }] };
  const item = { id: "ep-y", title: "Y", show: "Gone Show", duration_min: 5 };
  const html = m.ctx.archivedRow(item, 0, "ctx-1");
  assert.ok(
    html.includes('<a class="show-link" href="#/show/gone-show">Gone Show</a>'),
    "archivedRow must still link the show name even when the episode itself is gone"
  );
});

test("showNameLink falls back to plain escaped text when no catalog record joins", () => {
  /* Absence is a real, renderable state (Stage 1's own rule) — a show
     discover.json names that catalog.json does not carry yet must not throw
     or produce a dead link.

     MUTATION: make showIdForShowName return an empty string instead of null
     for a miss. `showId ? ... : label` still holds (empty string is falsy),
     so this specific mutation wouldn't be caught — the real risk mutation is
     dropping the ternary's else branch entirely, which would emit an <a
     href="#/show/undefined"> and fail the plain-text assertion below. */
  const m = mount();
  m.state.catalog = { shows: [] };
  const html = m.ctx.showNameLink("Some Unknown Show");
  assert.strictEqual(html, m.ctx.esc("Some Unknown Show"), "must render plain escaped text, no anchor, when no show record matches");
});

test("showIdForShowName resolves Lingthusiasm via TITLE_ALIASES, the same fallback episodesForShow uses", () => {
  /* The reverse direction of the Stage 1 fallback test above: given the short
     discover.json name, showIdForShowName must still find the show_id even
     though catalog.json's title carries the extra subtitle.

     MUTATION: drop the TITLE_ALIASES fallback loop in showIdForShowName. This
     assertion fails because only an exact-title match would be attempted. */
  const m = mount();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lingthusiasm");
  m.state.catalog = catalog;
  assert.strictEqual(m.ctx.showIdForShowName("Lingthusiasm"), show.show_id);
});

test("renderEpisode links its show-name text to #/show/:show_id when the show joins", () => {
  /* Per the card body: renderEpisode's existing show-name text field becomes
     a link too, sequenced after show-pages Stage 1 (now merged).

     MUTATION: revert renderEpisode's show line to `esc(item.show || "")`.
     This assertion fails because no anchor appears in the output. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "ep-show", title: "Episode Show" }] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.itemIndex = {
    "ep-z": { id: "ep-z", title: "Z", show: "Episode Show", duration_min: 5, audio_url: "https://example.com/a.mp3" },
  };
  m.ctx.renderEpisode("ep-z");
  const html = m.view();
  assert.ok(
    html.includes('<a class="show-link" href="#/show/ep-show">Episode Show</a>'),
    "renderEpisode must link the show name to its show page"
  );
});

/* ==================================================================== */
/* 6. A2.5 — "SIMILAR SHOWS" ROW (taxonomy_node_ids overlap)             */
/* ==================================================================== */

test("similarShows ranks by shared taxonomy_node_ids count, against the real catalogue", async () => {
  /* lex-fridman-podcast (engineering/energy-fusion only) against the real
     220-show catalogue, not a synthetic fixture — proves the join works on
     what's actually shipped. omega-tau shares 1 node with lex (energy-fusion)
     same as titans-of-nuclear, but this only pins that every returned show
     actually shares at least one node — the mixed-count ranking is pinned
     with a synthetic fixture below where the counts are controlled.

     MUTATION: change `.filter(x => x.shared > 0)` to admit shared === 0.
     The "every result must overlap" assertion below fails immediately. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lex-fridman-podcast");
  m.state.catalog = catalog;
  const results = m.ctx.similarShows(show);
  assert.ok(results.length > 0, "fixture assumption: lex-fridman-podcast must have real overlapping shows");
  const wanted = new Set(show.taxonomy_node_ids);
  for (const r of results) {
    assert.ok(r.show_id !== show.show_id, "must never include the show itself");
    assert.ok((r.taxonomy_node_ids || []).some((id) => wanted.has(id)), `${r.show_id} must share at least one taxonomy node`);
  }
});

test("similarShows ranks higher shared-count above lower, ties broken by show_id", () => {
  /* Synthetic fixture, counts fully controlled: B shares 2 nodes (higher),
     C shares 1, D shares 0 (must be excluded entirely, not padded in at the
     bottom — the "honest empty beats padding" rule).

     MUTATION: sort by insertion order instead of `b.shared - a.shared`. B
     and C swap position and the strict order assertion fails.
     MUTATION 2: drop the `x.shared > 0` filter. D appears in the output and
     the length assertion fails. */
  const m = mount();
  const A = { show_id: "show-a", taxonomy_node_ids: ["x", "y"] };
  const B = { show_id: "show-b", taxonomy_node_ids: ["x", "y"] };
  const C = { show_id: "show-c", taxonomy_node_ids: ["x"] };
  const D = { show_id: "show-d", taxonomy_node_ids: ["z"] };
  m.state.catalog = { shows: [A, B, C, D] };
  const result = m.ctx.similarShows(A);
  assert.deepStrictEqual(result.map((s) => s.show_id), ["show-b", "show-c"], "must rank by shared-count descending and exclude zero-overlap shows");
});

test("similarShows ties broken by show_id for a stable, pinnable order", () => {
  /* Two shows with an identical shared count must not depend on catalog
     array order — the exact failure mode a naive stable-sort-on-insertion
     approach would hide until the catalogue's own order shifted.

     MUTATION: drop the `|| a.show.show_id.localeCompare(b.show.show_id)`
     tiebreaker. This test still passes by accident with today's array order,
     so it is paired with the reversed-order variant below to actually catch it. */
  const m = mount();
  const A = { show_id: "show-a", taxonomy_node_ids: ["x"] };
  const Z = { show_id: "show-z", taxonomy_node_ids: ["x"] };
  const M = { show_id: "show-m", taxonomy_node_ids: ["x"] };
  m.state.catalog = { shows: [Z, M] }; // reversed insertion order on purpose
  const result = m.ctx.similarShows(A);
  assert.deepStrictEqual(result.map((s) => s.show_id), ["show-m", "show-z"], "equal-score ties must sort by show_id, independent of catalog array order");
});

test("similarShows returns [] for a show with no taxonomy_node_ids of its own", () => {
  /* There is nothing to overlap against — this must be an empty result, not
     a crash and not every-other-show-by-default.

     MUTATION: change `if (!nodeIds.size) return [];` to fall through. This
     throws or returns the whole catalogue instead of []. */
  const m = mount();
  const bare = { show_id: "bare-show" };
  m.state.catalog = { shows: [bare, { show_id: "other", taxonomy_node_ids: ["x"] }] };
  assert.strictEqual(m.ctx.similarShows(bare).length, 0);
});

test("similarShows caps at 6 results even with more overlapping shows available", () => {
  /* Card scope: "top 4-6 shown", not every show that shares a node —
     unbounded output would defeat the point of a curated row.

     MUTATION: remove the `.slice(0, limit)` call. The length assertion
     below fails because all 9 overlapping shows are returned. */
  const m = mount();
  const A = { show_id: "show-a", taxonomy_node_ids: ["x"] };
  const others = Array.from({ length: 9 }, (_, i) => ({ show_id: `show-${i}`, taxonomy_node_ids: ["x"] }));
  m.state.catalog = { shows: [A, ...others] };
  assert.strictEqual(m.ctx.similarShows(A).length, 6);
});

test("renderShow renders a 'Similar shows' section linking to each match, via the real catalogue", async () => {
  /* End-to-end through renderShow itself, against real committed data, not
     just similarShows() in isolation — proves the section is actually wired
     into the page and each link is a real, navigable show-result row
     (reusing showResultRow, so it carries no play/star controls — this is a
     show link, not a playable item, same rule as the shows-search results).

     MUTATION: delete `${similarShowsSection(show)}` from renderShow's
     template. The heading and href assertions both fail. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const show = catalog.shows.find((s) => s.show_id === "lex-fridman-podcast");
  m.ctx.renderShow("lex-fridman-podcast");
  const html = m.view();
  assert.ok(html.includes("Similar shows"), "must render the 'Similar shows' heading");
  const expected = m.ctx.similarShows(show);
  assert.ok(expected.length > 0, "fixture assumption: lex-fridman-podcast must have real similar shows");
  for (const s of expected) {
    assert.ok(html.includes(`href="#/show/${encodeURIComponent(s.show_id)}"`), `must link to ${s.show_id}`);
  }
});

test("renderShow renders no 'Similar shows' section when no other show overlaps", () => {
  /* Absence is a real, renderable state — matches moreFromShow's own rule
     ("Renders nothing (not an empty section)") and renderShow's existing
     "no episodes" branch. A show with taxonomy_node_ids that share nothing
     with the rest of the catalogue must not get an empty heading.

     MUTATION: return a `""`-guard-less section unconditionally. The
     "must not include" assertion fails because the heading appears anyway. */
  const m = mount();
  const lonely = { show_id: "lonely-show", title: "Lonely Show", taxonomy_node_ids: ["unique/node"] };
  const other = { show_id: "other-show", title: "Other Show", taxonomy_node_ids: ["different/node"] };
  m.state.catalog = { shows: [lonely, other] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.ctx.renderShow("lonely-show");
  const html = m.view();
  assert.ok(!html.includes("Similar shows"), "must not render an empty 'Similar shows' section");
});

test("catalog-client.json is measurably smaller than catalog.json (the gzip claim is real)", () => {
  /* Not a byte-exact pin (catalog.json changes nightly) — just proves the
     projection is doing real work, so the PR's "measured, not assumed" claim
     in the plan stays true as the catalogue grows.

     MUTATION: make buildCatalogClient() copy every field instead of
     projecting (e.g. `out = { ...show }`). The size assertion fails because
     the two files converge to the same size. */
  const fullBytes = fs.statSync(path.join(ROOT, "data", "catalog.json")).size;
  const clientBytes = fs.statSync(path.join(ROOT, "data", "catalog-client.json")).size;
  assert.ok(clientBytes < fullBytes * 0.8, `catalog-client.json (${clientBytes} B) should be well under catalog.json (${fullBytes} B)`);
});

/* ==================================================================== */
/* 7. A3.5 — "SHOWS WE VOUCH FOR" (editorial_note home-screen row)       */
/* ==================================================================== */

test("showsWeVouchFor only ever returns shows with a non-empty editorial_note", () => {
  /* MUTATION: drop the `.filter(s => s.editorial_note && ...)` line. The
     "must exclude the blank show" assertion fails because show-blank appears
     in the output. */
  const m = mount();
  m.state.catalog = {
    shows: [
      { show_id: "show-a", editorial_note: "A real note." },
      { show_id: "show-blank", editorial_note: "" },
      { show_id: "show-none" },
    ],
  };
  const result = m.ctx.showsWeVouchFor(8, new Date("2026-09-02T00:00:00Z"));
  assert.ok(result.every((s) => s.editorial_note && s.editorial_note.trim()), "every result must carry a real editorial_note");
  assert.ok(!result.some((s) => s.show_id === "show-blank"), "must exclude a show with an empty editorial_note");
  assert.ok(!result.some((s) => s.show_id === "show-none"), "must exclude a show with no editorial_note field at all");
});

test("showsWeVouchFor caps at the given limit even with more eligible shows available", () => {
  /* MUTATION: remove the `.slice(0, limit)` call. The length assertion fails
     because all 20 eligible shows are returned instead of 8. */
  const m = mount();
  const shows = Array.from({ length: 20 }, (_, i) => ({ show_id: `show-${i}`, editorial_note: `Note ${i}.` }));
  m.state.catalog = { shows };
  const result = m.ctx.showsWeVouchFor(8, new Date("2026-09-02T00:00:00Z"));
  assert.strictEqual(result.length, 8);
});

test("showsWeVouchFor returns [] (not a crash) when the catalogue has zero editorially-noted shows", () => {
  /* MUTATION: drop the `if (!shows.length) return [];` guard. This would
     otherwise still return [] here by construction, so the mutation that
     actually kills this test is dropping the whole filter+guard pair such
     that an unfiltered empty array is passed to seededShuffle and slice --
     asserting the empty-input contract directly rather than relying on that
     side effect. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "no-note-show" }] };
  const result = m.ctx.showsWeVouchFor(8, new Date("2026-09-02T00:00:00Z"));
  assert.strictEqual(result.length, 0, "must return an empty array for a catalogue with no editorially-noted shows");
});

test("showsWeVouchFor is deterministic for a fixed day: same day, same input, same output twice", () => {
  /* Same calendar day must produce the exact same set and order on repeated
     calls — a visitor refreshing mid-day, or two renders in the same
     session, must not see the row reshuffle under them.

     MUTATION: seed with Math.random() instead of dayOfYearSeed(now). Two
     calls diverge and the deepStrictEqual below fails (non-deterministically,
     which is itself the failure mode this guards against). */
  const m = mount();
  const shows = Array.from({ length: 30 }, (_, i) => ({ show_id: `show-${i}`, editorial_note: `Note ${i}.` }));
  m.state.catalog = { shows };
  const now = new Date("2026-09-02T14:00:00Z");
  const a = m.ctx.showsWeVouchFor(8, now).map((s) => s.show_id);
  const b = m.ctx.showsWeVouchFor(8, now).map((s) => s.show_id);
  assert.deepStrictEqual(a, b, "the same calendar day must yield the identical set and order");
});

test("showsWeVouchFor changes its sample across two different calendar days", () => {
  /* Proves the "day-rotating" half of the design, not just the "stable
     within a day" half — otherwise a seed that silently ignored `now`
     entirely would still pass the determinism test above.

     MUTATION: hardcode dayOfYearSeed to always return the same value
     regardless of `now`. Both days produce byte-identical output and this
     assertion (which allows either a different set OR a different order)
     fails. */
  const m = mount();
  const shows = Array.from({ length: 40 }, (_, i) => ({ show_id: `show-${i}`, editorial_note: `Note ${i}.` }));
  m.state.catalog = { shows };
  const day1 = m.ctx.showsWeVouchFor(8, new Date("2026-09-02T00:00:00Z")).map((s) => s.show_id);
  const day2 = m.ctx.showsWeVouchFor(8, new Date("2026-11-17T00:00:00Z")).map((s) => s.show_id);
  assert.notDeepStrictEqual(day1, day2, "different calendar days should not always produce the identical sampled set/order");
});

test("showsWeVouchFor's base order is show_id-sorted before shuffling, independent of catalog array order", () => {
  /* Mirrors similarShows' own tie-breaking discipline: the result must not
     depend on the order shows happen to sit in state.catalog.shows.

     MUTATION: skip the `.sort((a, b) => a.show_id.localeCompare(b.show_id))`
     step. Feeding the same shows in two different array orders would then
     produce two different outputs for the identical day, and this fails. */
  const m = mount();
  const shows = Array.from({ length: 10 }, (_, i) => ({ show_id: `show-${i}`, editorial_note: `Note ${i}.` }));
  const reversed = shows.slice().reverse();
  const now = new Date("2026-09-02T00:00:00Z");
  m.state.catalog = { shows };
  const forward = m.ctx.showsWeVouchFor(8, now).map((s) => s.show_id);
  m.state.catalog = { shows: reversed };
  const backward = m.ctx.showsWeVouchFor(8, now).map((s) => s.show_id);
  assert.deepStrictEqual(forward, backward, "catalog array order must not change the sampled result");
});

test("vouchForHtml renders the 'Shows we vouch for' heading and a real link for every sampled show", async () => {
  /* End-to-end through vouchForHtml itself, against real committed data, not
     just showsWeVouchFor() in isolation — proves the section is actually
     wired and each link is a real, navigable show-result row (reusing
     showResultRow, so it carries no play/star controls — a show link, not a
     playable item, same rule similarShowsSection and the shows-search
     results already follow).

     MUTATION: delete `${vouchForHtml()}` from renderHome's template. The
     heading and href assertions both fail. */
  const m = await mountBooted();
  const shows = m.ctx.showsWeVouchFor();
  assert.ok(shows.length > 0, "fixture assumption: the real 220-show catalogue must have editorially-noted shows");
  m.ctx.renderHome();
  const html = m.view();
  assert.ok(html.includes("Shows we vouch for"), "must render the 'Shows we vouch for' heading");
  for (const s of shows) {
    assert.ok(html.includes(`href="#/show/${encodeURIComponent(s.show_id)}"`), `must link to ${s.show_id}`);
  }
});

test("vouchForHtml renders nothing when the catalogue has zero editorially-noted shows", () => {
  /* Absence is a real, renderable state — matches similarShowsSection's,
     moreFromShow's and renderShow's own "no episodes" rule.

     MUTATION: return the section markup unconditionally without the
     `if (!shows.length) return "";` guard. The "must not include" assertion
     fails because the heading appears anyway with an empty list under it. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "no-note-show" }] };
  const html = m.ctx.vouchForHtml();
  assert.ok(!html.includes("Shows we vouch for"), "must not render an empty 'Shows we vouch for' section");
});

test("vouchForHtml's row is separate from the topic cards and forays, per the B1 separation rule", () => {
  /* Product requirement B1: an editorial surface must be its own
     distinctly-labeled section, never blended into episode or foray
     markup. Pins the actual DOM shape: its own <section>, its own <h3>
     heading text distinct from any card/foray label, using the show-results
     row markup (not ep-row, not fy-home-row).

     MUTATION: merge the vouch-for shows into the cards4 grid or the fy-home
     foray list instead of a standalone section. The section/heading
     assertions fail because "Shows we vouch for" no longer sits inside its
     own <section class="ep-more fy-vouch">. */
  const m = mount();
  m.state.catalog = {
    shows: [
      { show_id: "vouch-a", editorial_note: "A real note." },
      { show_id: "vouch-b", editorial_note: "Another real note." },
    ],
  };
  const html = m.ctx.vouchForHtml();
  assert.ok(html.includes('<section class="ep-more fy-vouch">'), "must render its own distinctly-classed section");
  assert.ok(html.includes("<h3>Shows we vouch for</h3>"), "must render its own distinct heading");
  assert.ok(html.includes('class="show-result"'), "must reuse the show-result row markup, not ep-row or fy-home-row");
  assert.ok(!html.includes('class="ep-row'), "must not render as episode rows");
  assert.ok(!html.includes('class="fy-home-row'), "must not render as foray rows");
});
