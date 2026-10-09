/* Redesign 2026, ambient, screen 15: the subject page (#/category/<id>, and Discover when the field holds a subject's
 * whole name).
 *
 * WHAT THIS PROVES, in order:
 *   1  the page's anatomy: a SectionHead (the page's h2) beside the subject's 56 collage, its count, the shows as
 *      ShowTiles that each link to the show's page, no pill wall (no `fy-chip` anywhere on the page)
 *   2  the Follow badge appears on the shows the listener follows and ONLY on those, with the word in the link's name
 *   3  a hostile show title is escaped in the text, the title attribute, the link's name; the id is encoded in the href
 *   4  names clamp to three lines and break only between words (`.clamp3`, `overflow-wrap: normal` on the tile's name)
 *   5  the grid is three across, in the stylesheet that ships
 *   6  the episodes: the newest first, at most SUBJECT_EPISODES, Family Mode applied, drawn as Discover's compact rows
 *   7  Discover: a subject's WHOLE name (any case) is the subject page's lead and its shows are tiles; a part of a
 *      name is a search and its shows stay rows; the lead repaints only when the subject changes
 *   8  the stylesheet: every rule scoped, a new name each, no inline style, one reduced-motion owner, no literal colour
 *   9  the page is wired: linked after the sheets it composes, shipped by the SW generation, the web dist and the app bundle
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is not evidence until you have broken it".
 * Which suite covers which mechanism: the grid and the clamp are pinned here (CSS text; the rendered measurement at 375,
 * 393 and 412 over every taxonomy node was run at build time with tools/ui-lab's walker: 843 tiles, none overflowing and
 * none past three lines); the exploration floor on discovery surfaces is test/home-v2.test.js and
 * test/ambient-today.test.js, untouched by this screen.
 *
 * Harness: the node:vm DOM stub of test/category-browse.test.js, duplicated rather than imported (see that file's header).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [], toggled: {},
    classList: { add() {}, remove() {}, toggle(c, on) { el.toggled[c] = on; }, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
  return el;
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link", "sh-browse", "sh-dismiss", "ep-search-results", "pl-search-results",
  "sh-subject", "fy-search-results", "sh-empty", "sh-make", "sh-partial-note", "sh-offline-note",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const bodyClasses = new Set();
  body.classList = { add: (...c) => c.forEach((x) => bodyClasses.add(x)), remove() {}, toggle() {}, contains: (c) => bodyClasses.has(c) };
  Object.defineProperty(body, "className", { get: () => [...bodyClasses].join(" "), set: (v) => { bodyClasses.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => bodyClasses.add(c)); } });
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) });
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
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
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
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, store, state: evalIn("state"), view: () => byId.get("view").innerHTML, byId, bodyClasses };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

const NODE = "engineering/energy-fusion";   // five curated shows in the committed catalogue
const tiles = (html) => html.match(/<a class="ag-show-tile"[\s\S]*?<\/a>/g) || [];

/* ==================================================================== */
/* 1. THE ANATOMY                                                        */
/* ==================================================================== */

test("the subject page is a SectionHead beside the 56 collage, the shows as ShowTiles that link to their pages, and no pill wall", async () => {
  /* MUTATIONS (each run red): render the lead without agCollage (the 56 assertion); make the tile an <article> (the
     link assertion); draw agChip/`fy-chip` links for the shows (the pill-wall assertion); render the head as an h3
     (the page would have no h2 and pageHeading() would name no page). */
  const m = await mountBooted();
  const expected = m.state.catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(NODE));
  assert.ok(expected.length >= 3, "fixture assumption: the category holds several shows");
  const label = m.state.taxonomy.nodes.find((n) => n.id === NODE).label;
  m.ctx.renderCategory(NODE);
  const html = m.view();
  assert.ok(html.includes('<div class="page-head cat-head">'), "the lead sits in the page head, which pageHeading() reads");
  assert.ok(html.includes(`<h2 class="t-headline">${m.ctx.esc(label)}</h2>`), "the SectionHead IS the page's h2");
  assert.ok(html.includes(`<span class="count">${expected.length} shows</span>`), "the subject's count");
  assert.ok(/class="ag-collage ag-collage-56 c\d/.test(html), "the subject's 56 collage");
  assert.ok(html.indexOf("ag-collage-56") < html.indexOf("ag-show-tile"), "the lead comes before the tiles");
  const found = tiles(html);
  assert.strictEqual(found.length, expected.length, "one tile per show in the overlap, no more, no fewer");
  for (const show of expected) assert.ok(html.includes(`href="#/show/${encodeURIComponent(show.show_id)}"`), `${show.show_id} links to its own page`);
  assert.ok(!/fy-chip|ag-chip|sh-browse-pills/.test(html), "no pill wall");
  assert.ok(m.bodyClasses.has("ag-category"), "the body wears the page's class (its ground, the legacy bar stepping aside)");
});

test("the tiles are most-charted first, then by title in code-unit order: the same order on every device", async () => {
  /* MUTATION: sort by `a.title.localeCompare(b.title)` (the old order) -> the first tile is the A-Z first show, not the
     most-charted one, and this fails. */
  const m = await mountBooted();
  const shows = m.state.catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(NODE));
  const want = shows.slice().sort((a, b) => {
    const ra = Number.isFinite(a.chart_rank) ? a.chart_rank : Infinity;
    const rb = Number.isFinite(b.chart_rank) ? b.chart_rank : Infinity;
    return ra - rb || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  });
  assert.notDeepStrictEqual(want.map((s) => s.show_id), shows.slice().sort((a, b) => a.title.localeCompare(b.title)).map((s) => s.show_id),
    "fixture assumption: chart order and A-Z order differ here, so this test can fail");
  m.ctx.renderCategory(NODE);
  const order = tiles(m.view()).map((t) => decodeURIComponent(/href="#\/show\/([^"]+)"/.exec(t)[1]));
  assert.deepStrictEqual(order, want.map((s) => s.show_id));
});

test("an empty subject says so in one line and draws no tile; an unknown id names itself; a failed catalogue keeps the failed page", () => {
  /* MUTATION: delete the `shows.length ? ... : <p class="note">` branch -> an empty grid with no sentence, red. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [] };
  m.ctx.renderCategory("nowhere/at-all");
  let html = m.view();
  assert.ok(html.includes("No shows here yet."), "the honest empty line");
  assert.ok(html.includes('<h2 class="t-headline">nowhere/at-all</h2>'), "the raw id names the page");
  assert.ok(html.includes('<span class="count">0 shows</span>'), "a loaded catalogue with nothing under the id says 0");
  assert.strictEqual(tiles(html).length, 0);
  m.state.catalog = null;
  m.ctx.renderCategory("nowhere/at-all");
  html = m.view();
  assert.ok(!/<span class="count">/.test(html), "no count over a catalogue that never loaded");
  assert.ok(html.includes("Couldn't load the show list."), "the failed page, with its retry");
});

/* ==================================================================== */
/* 2. FOLLOW                                                             */
/* ==================================================================== */

test("the Follow badge is drawn on the followed shows and on no other, and the link says so in words", async () => {
  /* MUTATION: pass `followed: true` unconditionally in subjectShowTile -> the unfollowed tile gets a badge, red; pass
     `followed: false` -> the followed tile loses it, red. The fixture keeps one followed and the rest not, so neither
     direction is vacuous. */
  const m = await mountBooted();
  const shows = m.state.catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(NODE));
  const followedId = shows[0].show_id;
  m.store.set("cp_starred_shows", JSON.stringify({ [followedId]: { show_id: followedId, title: shows[0].title, starred_at: "2026-10-01T00:00:00Z" } }));
  m.ctx.renderCategory(NODE);
  const found = tiles(m.view());
  const badged = found.filter((t) => t.includes("ag-art-badge"));
  assert.strictEqual(badged.length, 1, "exactly one badge");
  assert.ok(badged[0].includes(`href="#/show/${encodeURIComponent(followedId)}"`), "on the followed show");
  assert.ok(badged[0].includes(`aria-label="${m.ctx.esc(shows[0].title)}, following"`), "and the link's name carries the state in words");
  assert.ok(found.filter((t) => !t.includes("ag-art-badge")).every((t) => !t.includes("aria-label=")), "an unfollowed tile has no state word");
});

/* ==================================================================== */
/* 3. HOSTILE DATA                                                       */
/* ==================================================================== */

test("a hostile title and id are escaped in the text, the title attribute and the link's name, and encoded in the href", async () => {
  /* MUTATION: interpolate `title` raw in agShowTile's h4, title attribute or aria-label, or the id unencoded in the
     href -> the injected tag or the quote breaks out, red. */
  const m = await mountBooted();
  const evil = `"><img src=x onerror=alert(1)> & <b>`;
  m.state.catalog = { shows: [{ show_id: `a/b"c`, title: evil, artwork_url: "https://example.test/a.jpg\" onerror=\"x", taxonomy_node_ids: ["t/x"], chart_rank: 1 }] };
  m.state.taxonomy = { nodes: [{ id: "t/x", label: evil, parent: null }] };
  m.store.set("cp_starred_shows", JSON.stringify({ [`a/b"c`]: { show_id: `a/b"c`, title: evil } }));
  m.ctx.renderCategory("t/x");
  const html = m.view();
  assert.ok(!html.includes("<img src=x"), "no injected element");
  assert.ok(!/<b>/.test(html), "no injected tag");
  assert.ok(!/ onerror="/.test(html), "no attribute broken out of by a quote in the artwork address");
  assert.ok((html.match(/<img /g) || []).every((_, i, all) => all.length === (html.match(/<img src="https:\/\/example\.test\/a\.jpg&quot;/g) || []).length), "the only images are the artwork, its quote escaped");
  assert.ok(html.includes(`href="#/show/${encodeURIComponent(`a/b"c`)}"`), "the id is encoded in the href");
  assert.ok(html.includes("&quot;&gt;&lt;img"), "the title is escaped");
});

/* ==================================================================== */
/* 4 + 5. THE CLAMP AND THE GRID, IN THE SHEET THAT SHIPS                */
/* ==================================================================== */

const BROWSE_CSS = stripComments(read("ui/browse.css"));
const rule = (css, head) => {
  const re = new RegExp(`(?:^|\\})\\s*${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  return m ? m[1] : null;
};

test("a tile's name is the Caption style, clamped to three lines, and breaks between words only", async () => {
  /* MUTATIONS (each run red): change `clamp3` to `clamp2` in agShowTile (the class assertion); set
     `overflow-wrap: anywhere` on `.ag .ag-show-tile h4` (a word would break mid-letter: the CSS assertion); delete
     `-webkit-line-clamp: 3` from `.clamp3` in ui/tokens.css (the clamp assertion). The measured half (843 tiles, three
     viewports, every taxonomy node, none overflowing, none past three lines) is the build-time run named in the header. */
  const m = await mountBooted();
  m.ctx.renderCategory(NODE);
  for (const t of tiles(m.view())) assert.ok(/<h4 class="t-caption clamp3">/.test(t), "Caption style, clamp 3");
  const tokens = stripComments(read("ui/tokens.css"));
  assert.ok(/\.clamp3\s*\{[^}]*-webkit-line-clamp:\s*3/.test(tokens), "clamp3 clamps to three lines");
  const name = rule(BROWSE_CSS, ".ag .ag-show-tile h4");
  assert.ok(name && /overflow-wrap:\s*normal/.test(name) && /word-break:\s*normal/.test(name), "a name breaks between words");
  for (const m of BROWSE_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/show-tile|cat-tiles|dsc-tiles/.test(m[1])) assert.ok(!/anywhere|break-word|break-all/.test(m[2]), `no rule for a tile breaks a word mid-letter: ${m[1].trim()}`);
  }
});

test("the grid is three across, and the art is held inside its cell", () => {
  /* MUTATIONS (each run red): change `repeat(3,` to `repeat(4,` (the round-1 four-up that clipped "Unexplainabl");
     delete `min(100%, var(--art-tile))` from the art rule (a cell narrower than 104 would push the page sideways). */
  const grid = rule(BROWSE_CSS, ".ag .cat-tiles, .ag.disc .dsc-list.dsc-tiles");
  assert.ok(grid && /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(grid), "three across, each cell shrinkable");
  const art = rule(BROWSE_CSS, ".ag .cat-tiles .ag-art-104, .ag .dsc-tiles .ag-art-104");
  assert.ok(art && /width:\s*min\(100%,\s*var\(--art-tile\)\)/.test(art) && /aspect-ratio:\s*1/.test(art), "the art is the primitive's 104 held in its cell, square");
});

/* ==================================================================== */
/* 6. THE EPISODES                                                       */
/* ==================================================================== */

test("the episodes are the subject's newest, at most eight, drawn as Discover's compact rows with a play control", async () => {
  /* MUTATIONS (each run red): sort oldest first (the order assertion); drop `.slice(0, limit)` (the cap); drop
     `familyAllows(it)` (the Family Mode assertion, which turns the mode on and expects no explicit row). */
  const m = await mountBooted();
  const shows = m.state.catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(NODE));
  const titles = new Set(shows.map((s) => s.title));
  const pool = m.state.discover.items.filter((it) => titles.has(it.show));
  assert.ok(pool.length > 8, `fixture assumption: more than the cap of episodes exist for the subject (${pool.length})`);
  m.ctx.renderCategory(NODE);
  const html = m.view();
  const rows = html.match(/<article class="dsc-row dsc-ep raised">/g) || [];
  assert.strictEqual(rows.length, 8, "capped at eight");
  const ids = [...html.matchAll(/href="#\/episode\/([^"]+)"/g)].map((x) => decodeURIComponent(x[1]));
  const dates = ids.map((id) => pool.find((it) => it.id === id)?.release_date);
  assert.ok(dates.every(Boolean), "every row is a pool episode of this subject's shows");
  assert.deepStrictEqual(dates.slice().sort().reverse(), dates, "newest first");
  assert.ok(/data-play=/.test(html), "a play control on a playable row");
  assert.ok(html.includes(">Episodes</h3>"), "under its own SectionHead");
  assert.ok(html.indexOf("ag-show-tile") < html.indexOf(">Episodes</h3>"), "after the shows");
  /* Family Mode: the newest row is made explicit in the pool, so the assertion has something to hide. */
  const newest = m.state.discover.items.find((it) => it.id === ids[0]);
  newest.explicit = true;
  m.store.set("cp_family", "true");
  assert.strictEqual(m.ctx.familyAllows(newest), false, "fixture assumption: Family Mode turns this episode away");
  m.ctx.renderCategory(NODE);
  const family = m.view();
  assert.ok(!family.includes(`href="#/episode/${encodeURIComponent(ids[0])}"`), "Family Mode hides the explicit episode");
  assert.strictEqual((family.match(/<article class="dsc-row dsc-ep raised">/g) || []).length, 8, "and the next one fills its place");
});

/* ==================================================================== */
/* 7. DISCOVER: A SUBJECT'S WHOLE NAME                                   */
/* ==================================================================== */

test("a subject's whole name (any case, padded) is the subject page; a part of a name is a search", async () => {
  /* MUTATIONS (each run red): compare with `includes` instead of `===` (the "hist" assertion: a part of a name would
     take over the page mid-typing); drop `.toLowerCase()` (the case assertion). */
  const m = await mountBooted();
  const tile = m.ctx.discoverSubjectExact("History");
  assert.ok(tile, "fixture assumption: History is a subject");
  assert.strictEqual(m.ctx.discoverSubjectExact("  hISTORY ")?.id, tile.id, "case and padding do not matter");
  assert.strictEqual(m.ctx.discoverSubjectExact("hist"), null, "a part of a name is a search");
  assert.strictEqual(m.ctx.discoverSubjectExact("History of"), null, "and so is more than the name");
  assert.strictEqual(m.ctx.discoverSubjectExact(""), null);
});

test("the lead is painted for the subject, cleared for anything else, and not rebuilt while the subject is unchanged", async () => {
  /* MUTATIONS (each run red): delete the `key === subjectLeadShown` early return (the same-subject assertion: the
     collage's images would be rebuilt on every keystroke); drop `box.hidden = !tile` (a stale lead stays visible). */
  const m = await mountBooted();
  const box = m.byId.get("sh-subject");
  m.ctx.paintSubjectLead("History");
  assert.strictEqual(box.hidden, false);
  assert.ok(box.innerHTML.includes('<h3 class="t-headline">History</h3>'), "under Discover's own title the head is an h3");
  assert.ok(/ag-collage-56/.test(box.innerHTML), "with the subject's 56 collage");
  const first = box.innerHTML;
  box.innerHTML = first + "<!-- marker -->";
  m.ctx.paintSubjectLead("history");
  assert.ok(box.innerHTML.endsWith("<!-- marker -->"), "the same subject is not repainted");
  m.ctx.paintSubjectLead("hist");
  assert.strictEqual(box.hidden, true);
  assert.strictEqual(box.innerHTML, "", "cleared");
});

test("a subject query draws its shows as ShowTiles with Follow badges; any other query keeps the Raised rows", async () => {
  /* MUTATIONS (each run red): make `asTiles` always false (the first assertion) or always true (the second); drop the
     classList toggle (the grid class assertion: the tiles would stack in the row list's single column). */
  const m = await mountBooted();
  const subject = m.ctx.discoverSubjectExact("History");
  assert.ok(subject && subject.shows.length >= 3, "fixture assumption: History is a subject with several shows");
  const starred = subject.shows[1].show_id;
  m.store.set("cp_starred_shows", JSON.stringify({ [starred]: { show_id: starred, title: subject.shows[1].title } }));
  const token = m.evalIn("showSearchToken");
  const results = m.byId.get("sh-results");
  m.ctx.paintShowResults("History", m.state.catalog.shows.slice(0, 4), token);
  assert.strictEqual(tiles(results.innerHTML).length, subject.shows.length, "one tile per show of the subject");
  assert.ok(!results.innerHTML.includes("dsc-row"), "no rows");
  assert.strictEqual(results.toggled["dsc-tiles"], true, "the list wears the grid class");
  assert.strictEqual((results.innerHTML.match(/ag-art-badge/g) || []).length, 1, "the one followed show carries the badge");
  const shows = m.state.catalog.shows.slice(0, 4);
  m.ctx.paintShowResults("hist", shows, token);
  assert.strictEqual(tiles(results.innerHTML).length, 0, "a search keeps rows");
  assert.strictEqual((results.innerHTML.match(/class="dsc-row dsc-show raised"/g) || []).length, 4);
  assert.strictEqual(results.toggled["dsc-tiles"], false);
});

test("a subject's lead and the tiles under it are ONE set: the subject's own shows, whatever the text search found", async () => {
  /* The review finding: the lead said "<n> shows" from discoverGroups while the tiles were the free-text search's rows
     (History 19 vs 11, Food 21 vs 1, Nature 13 vs 0, directory rows that merely contain the word drawn as the subject's).
     Every subject is walked, with a search answer that is deliberately NOT the subject's set (the first three catalogue
     shows outside it, and nothing at all).
     MUTATIONS (each run red): delete `if (subjectTile) shows = subjectTile.shows;` in paintShowResults (the tile-set
     assertion: the foreign rows are drawn under the lead, and the empty answer paints no tiles); build the tile's `shows`
     from something other than the array `count` is the length of, e.g. `shows: shows.slice(1)` in discoverGroups (the
     count assertion); drop the `discoverSubjectExact` guard in paintDiscoverEmpty (the empty-box assertion). */
  const m = await mountBooted();
  const subjects = m.ctx.discoverGroups().flatMap((g) => g.tiles);
  assert.ok(subjects.length >= 20, "fixture assumption: the committed catalogue has many subjects");
  const lead = m.byId.get("sh-subject");
  const results = m.byId.get("sh-results");
  const empty = m.byId.get("sh-empty");
  for (const tile of subjects) {
    const inSubject = new Set(tile.shows.map((s) => s.show_id));
    const foreign = m.state.catalog.shows.filter((s) => !inSubject.has(s.show_id)).slice(0, 3);
    assert.strictEqual(foreign.length, 3, "fixture assumption: shows outside the subject exist");
    const want = tile.shows.slice(0, 50).map((s) => s.show_id);
    for (const searchAnswer of [foreign, []]) {
      const token = m.evalIn("showSearchToken");
      m.ctx.paintSubjectLead(tile.name);
      m.ctx.paintShowResults(tile.name, searchAnswer, token);
      const hrefs = tiles(results.innerHTML).map((t) => decodeURIComponent(/href="#\/show\/([^"]+)"/.exec(t)[1]));
      assert.deepStrictEqual([...hrefs], [...want], `${tile.name}: the tiles are the subject's own shows, in subjectShowOrder`);
      assert.strictEqual(tile.count, tile.shows.length, `${tile.name}: the count is the length of the set the tiles come from`);
      assert.ok(lead.innerHTML.includes(`<span class="count">${tile.count} show${tile.count === 1 ? "" : "s"}</span>`), `${tile.name}: the lead's count`);
      for (const f of foreign) assert.ok(!results.innerHTML.includes(`href="#/show/${encodeURIComponent(f.show_id)}"`), `${tile.name}: a show outside the subject is not drawn`);
      /* The empty page, asked for as runShowSearchCostly does once every group is in, must leave its box closed. */
      empty.hidden = true; empty.innerHTML = "";
      m.ctx.paintDiscoverEmpty(tile.name, token);
      assert.strictEqual(empty.hidden, true, `${tile.name}: no "Nothing named" over a subject's page`);
      assert.strictEqual(empty.innerHTML, "");
    }
  }
  /* A part of a name is still a search: no hits still gets the empty page. */
  const token = m.evalIn("showSearchToken");
  m.ctx.paintShowResults("hist", [], token);
  m.ctx.paintDiscoverEmpty("hist", token);
  assert.strictEqual(empty.hidden, false, "a search with no hits still gets its empty page");
});

/* ==================================================================== */
/* 8. THE STYLESHEET                                                     */
/* ==================================================================== */

test("ui/browse.css: every rule scoped, a new name each, one reduced-motion owner, no inline style, no literal colour", () => {
  /* MUTATIONS (each run red): add a bare `.cat-tiles { gap: 0 }`; add a `@media (prefers-reduced-motion: reduce)` block;
     add `color: #fff` to any rule; add `transition: opacity 200ms` to any rule; add `style="` to the page's template. */
  const raw = read("ui/browse.css");
  const heads = [/^\.ag(?![\w-])/, /^body\.ag-category(?![\w-])/, /^body\.ui-v2 \.ag\.cat(?![\w-])/];
  let seen = 0;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(stripComments(raw)));) {
    const prelude = m[1].trim();
    if (prelude.startsWith("@")) continue;
    for (const s of prelude.split(",").map((x) => x.trim())) {
      seen++;
      assert.ok(heads.some((h) => h.test(s)), `selector "${s}" is not scoped under .ag / body.ag-category`);
    }
    for (const d of m[2].split(";")) {
      const v = d.slice(d.indexOf(":") + 1);
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i.test(v)) assert.fail(`literal colour in ${prelude}: ${d}`);
      if (/^\s*(transition|animation)/.test(d)) assert.fail(`motion in ${prelude}: ${d}`);
    }
  }
  assert.ok(seen >= 15, `fixture assumption: the sheet's selectors are read (${seen})`);
  assert.ok(!/prefers-reduced-motion/.test(raw), "no second reduced-motion block: ui/tokens.css owns the one");
  const src = read("ui/browse.js");
  const page = src.slice(src.indexOf("function renderCategory"), src.indexOf("A3.3 — the all-shows"));
  assert.ok(!/\bstyle\s*=/.test(page), "no inline style attribute in the page's template");
  assert.ok(!/url\(|@import|https?:/.test(stripComments(raw)), "no image, no import, no origin in the sheet");
});

/* ==================================================================== */
/* 9. WIRING                                                             */
/* ==================================================================== */

test("the sheet is wired: linked after the sheets it composes, in the SW generation, the web dist and the app bundle", async () => {
  /* MUTATIONS (each run red): remove "ui/browse.css" from SHELL in tools/ci/generate-manifest.mjs, from SHELL in
     tools/web/prepare-dist.mjs or from SHELL_FILES in tools/mobile/prepare-webdir.mjs; drop the <link> from index.html. */
  const html = read("index.html");
  assert.ok(html.includes('<link rel="stylesheet" href="ui/browse.css">'), "linked");
  for (const dep of ["ui/tokens.css", "ui/primitives.css"]) assert.ok(html.indexOf("ui/browse.css") > html.indexOf(dep), `after ${dep}`);
  assert.ok(/"ui\/browse\.css"/.test(read("tools/ci/generate-manifest.mjs")), "generate-manifest SHELL");
  assert.ok(/"ui\/browse\.css"/.test(read("tools/web/prepare-dist.mjs")), "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  const files = pw.SHELL_FILES || pw.default?.SHELL_FILES;
  if (files) assert.ok(files.includes("ui/browse.css"), "prepare-webdir SHELL_FILES");
  else assert.ok(/"ui\/browse\.css"/.test(read("tools/mobile/prepare-webdir.mjs")), "prepare-webdir lists it");
});
