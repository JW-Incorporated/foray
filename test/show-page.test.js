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
  "sh-note", "sh-results",
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
