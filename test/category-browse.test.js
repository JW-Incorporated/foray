/* Requirements A3.2 (browse shows by category) and A3.3 (all-shows index)
 * from Joey's marked-up requirements doc — kanban card "Build: category
 * browse — linkify taxonomy chips + all-shows index".
 *
 * WHAT THIS PROVES, in order:
 *  1. taxonomyChip() renders a real navigable `<a href="#/category/:id">`,
 *     not the old inert `<span>` — the exact "go nowhere" complaint the
 *     card body quotes.
 *  2. showsForCategory() is the honest taxonomy_node_ids overlap: every show
 *     that carries the node id, no more, no less, against the real
 *     committed catalogue.
 *  3. renderCategory() renders that overlap as a list of show-result rows,
 *     each linking to its own #/show/:id page, plus an honest empty/unknown
 *     state (same "absence is a real state, not an error" rule renderShow
 *     already follows for an unknown show_id).
 *  4. renderAllShows() renders the FULL curated catalogue, A-Z, as the same
 *     row shape.
 *  5. route() dispatches #/category/:id and #/shows to the two renderers,
 *     matching the #/show/:id and #/playlist/:id pattern already wired.
 *  6. #/shows is REACHABLE, and by exactly one affordance: the menu's own
 *     "Shows" item. (Was: a "Browse all shows" link on Home, behind the
 *     Shows tab. The founder asked for that button gone — item 6 — and the
 *     menu entry replaced it, so what needs pinning is that the page did not
 *     become unreachable in the process.)
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js, duplicated
 * rather than imported — see that file's header for why.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
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
  /* #684: the browse tiles now run the ordinary search, so a #/shows/q/:q
     render reaches the same nodes a submit does. */
  "sh-browse", "sh-dismiss", "ep-search-results", "pl-search-results",
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
  runAppSource(APP_SRC, ctx);

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
    byId,
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

const rowCount = (html) => (html.match(/class="show-result"/g) || []).length;

/* ==================================================================== */
/* 1. taxonomyChip() IS A REAL LINK, NOT AN INERT <span>                 */
/* ==================================================================== */

test("taxonomyChip renders a navigable <a href=\"#/category/:id\"> (the 'goes nowhere' complaint, fixed)", () => {
  /* MUTATION: revert taxonomyChip to `<span class="fy-chip">...</span>`.
     This assertion fails because no #/category/ href appears. */
  const m = mount();
  m.state.taxonomy = { nodes: [{ id: "engineering/energy-fusion", label: "Fusion & energy systems", parent: "engineering" }] };
  const html = m.ctx.taxonomyChip("engineering/energy-fusion");
  assert.ok(
    html.includes('<a class="fy-chip" href="#/category/engineering%2Fenergy-fusion">'),
    `expected a category link, got: ${html}`
  );
  assert.ok(html.includes("Fusion &amp; energy systems"), "must still render the escaped label text");
});

test("taxonomyChip falls back to the raw node id when the taxonomy has no matching node", () => {
  /* Mirrors the pre-existing fallback in the old <span> version — absence is
     a real, renderable state, not a crash.
     MUTATION: drop the `node?.label ||` fallback. This throws or renders
     "undefined" instead of the raw id. */
  const m = mount();
  m.state.taxonomy = { nodes: [] };
  const html = m.ctx.taxonomyChip("unknown/node");
  assert.ok(html.includes(">unknown/node<"), `expected the raw id as fallback label, got: ${html}`);
});

/* ==================================================================== */
/* 2. showsForCategory() — THE HONEST OVERLAP, AGAINST REAL DATA         */
/* ==================================================================== */

test("showsForCategory returns exactly the shows carrying that taxonomy node, against the real catalogue", () => {
  /* Cross-checked against an independent filter over catalog-client.json
     directly, not against showsForCategory's own join.
     MUTATION: change the filter to `.some(...)` matching on parent branch
     instead of exact node id (over-broad), or drop the filter entirely
     (returns everything). Either fails the exact-set comparison below. */
  const m = mount();
  const catalog = readJson("data/catalog-client.json");
  m.state.catalog = catalog;
  const nodeId = "engineering/energy-fusion";
  const expected = catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(nodeId)).map((s) => s.show_id).sort();
  assert.ok(expected.length > 0, "fixture assumption: at least one show must carry this node in the real catalogue");

  const got = m.ctx.showsForCategory(nodeId).map((s) => s.show_id).sort();
  assert.deepStrictEqual(got, expected, "must return exactly the overlap set, no more, no less");
});

test("showsForCategory returns an empty array for a node id no show carries", () => {
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "a", title: "A", taxonomy_node_ids: ["other/node"] }] };
  assert.deepStrictEqual(m.ctx.showsForCategory("nonexistent/node"), []);
});

/* ==================================================================== */
/* 3. renderCategory() — THE A3.2 LANDING PAGE                          */
/* ==================================================================== */

test("renderCategory renders the category's label as heading and every matching show as a result row", async () => {
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const taxonomy = readJson("data/taxonomy.json");
  const nodeId = "engineering/energy-fusion";
  const label = taxonomy.nodes.find((n) => n.id === nodeId).label;
  const expected = catalog.shows.filter((s) => (s.taxonomy_node_ids || []).includes(nodeId));
  assert.ok(expected.length > 0, "fixture assumption: category must have at least one show");

  m.ctx.renderCategory(nodeId);
  const html = m.view();
  assert.ok(html.includes(m.ctx.esc(label)), "must render the category's real label as the heading");
  assert.strictEqual(rowCount(html), expected.length, "row count must match the exact overlap set");
  for (const show of expected) {
    assert.ok(
      html.includes(`href="#/show/${encodeURIComponent(show.show_id)}"`),
      `must link to ${show.show_id}'s own show page`
    );
  }
});

test("renderCategory on an unknown node id renders the raw id as heading with zero rows, not a crash", () => {
  /* MUTATION: remove the `node?.label ||` fallback or the empty-list guard
     in renderShowIndexPage. This throws, or omits the "No shows here yet"
     copy the empty case is supposed to render. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [] };
  assert.doesNotThrow(() => m.ctx.renderCategory("nonexistent/node"));
  const html = m.view();
  assert.ok(html.includes("nonexistent/node"), "unknown node id must still render as its own heading");
  assert.strictEqual(rowCount(html), 0, "zero shows must render zero result rows");
  assert.ok(html.includes("No shows here yet"), "must render the honest empty-state copy");
});

/* ==================================================================== */
/* 4. renderAllShows() — THE A3.3 ALL-SHOWS INDEX                       */
/* ==================================================================== */

test("renderAllShows (Discover) draws the five subject groups from the real catalogue, and no A-Z list", async () => {
  /* REDESIGN 2026 (ambient screen 4) RETIRED THE A-Z INDEX: "renders every catalogue show, A-Z, as a result row"
     pinned a page whose idle state was 220 rows and a pill wall. Discover's idle state is five heads of SubjectTiles
     (ui/browse.js discoverGroups), and the listener who does not know what they want gets subjects, not names.
     The category page above keeps the A-Z template; this page does not use it.

     Over the committed data: each of the five heads is drawn, in the direction's order, each with at least one
     tile; every tile's count is the number of curated shows with a leaf under that root (counted independently
     here); no show row and no `show-index` is on the idle page; and no taxonomy id reaches the page's words.

     MUTATION: render `renderShowIndexPage("Discover", "", shows, ...)` again (the A-Z list comes back) -> the
     first assertion fails. Another: print `tile.id` instead of `tile.name` -> the id assertion fails. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const taxonomy = readJson("data/taxonomy.json");

  m.ctx.renderAllShows();
  const page = m.view();
  assert.ok(!page.includes("show-index") && !/class="show-result"/.test(page), "no A-Z list and no show rows on the idle page");

  const heads = [...page.matchAll(/<h3 class="t-headline">([^<]*)<\/h3>/g)].map((mm) => mm[1].replace(/&amp;/g, "&"));
  assert.deepStrictEqual(heads, ["Science & nature", "People & society", "Business & work", "Arts & culture", "Making & tech"],
    "five heads, the direction's own names, in its order");

  const byId = new Map(taxonomy.nodes.map((n) => [n.id, n]));
  const rootOf = (id) => { let n = byId.get(id); while (n && n.parent) n = byId.get(n.parent); return n && n.id; };
  const tiles = [...page.matchAll(/<a class="ag-subject-tile raised is-default" href="#\/shows\/q\/([^"]+)">[\s\S]*?<p class="t-caption count">(\d+) shows?<\/p>/g)];
  assert.ok(tiles.length >= 15, `a page of subjects, not a handful (${tiles.length})`);
  for (const [, enc, n] of tiles) {
    const label = decodeURIComponent(enc);
    const root = taxonomy.nodes.find((x) => x.parent === null && x.label === label);
    assert.ok(root, `a tile's search is its own label, and that label is a root: ${label}`);
    const expected = catalog.shows.filter((s) => (s.taxonomy_node_ids || []).some((id) => rootOf(id) === root.id)).length;
    assert.strictEqual(Number(n), expected, `${label}: the count is the shows with a leaf under the root`);
    assert.ok(expected >= m.evalIn("DISCOVER_MIN_SHOWS"), `${label}: no tile for a subject with fewer than ${m.evalIn("DISCOVER_MIN_SHOWS")} shows`);
  }
  assert.ok(!/(?:science|engineering|true-crime|kids-family)\//.test(page) && !/>\s*(?:true-crime|kids-family|personal-journals)\s*</.test(page),
    "no taxonomy id in the page's words");
});

test("every taxonomy root with shows under it has a group, so a new root is never silently missing from Discover", async () => {
  /* The groups are a fixed map from root id to head (DISCOVER_SUBJECT_GROUPS). A root the taxonomy gains later,
     with shows under it and no entry in the map, would simply not be drawn. This is the test that says so.
     MUTATION: delete "architecture" from the Making & tech list -> red, naming it. */
  const m = await mountBooted();
  const catalog = readJson("data/catalog-client.json");
  const taxonomy = readJson("data/taxonomy.json");
  const byId = new Map(taxonomy.nodes.map((n) => [n.id, n]));
  const rootOf = (id) => { let n = byId.get(id); while (n && n.parent) n = byId.get(n.parent); return n && n.id; };
  const withShows = new Set(catalog.shows.flatMap((s) => (s.taxonomy_node_ids || []).map(rootOf)).filter(Boolean));
  const mapped = new Set(m.evalIn("DISCOVER_SUBJECT_GROUPS").flatMap(([, ids]) => ids));
  const unmapped = [...withShows].filter((id) => !mapped.has(id));
  assert.deepStrictEqual(unmapped, [], "a root with shows under it and no group");
  const unknown = [...mapped].filter((id) => !byId.has(id));
  assert.deepStrictEqual(unknown, [], "a group names a root the taxonomy does not have");
});

/* ==================================================================== */
/* 5. ROUTING — #/category/:id AND #/shows                              */
/* ==================================================================== */

test("route() dispatches #/category/:id to renderCategory, matching the #/show/:id pattern", () => {
  /* MUTATION: delete the `#/category/` branch from route(). This test fails
     because renderHome (the fallback) runs instead. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [{ id: "some/node", label: "Some Node", parent: "some" }] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/category/some%2Fnode";
  m.ctx.route();
  assert.ok(m.view().includes("Some Node"), "route() must dispatch #/category/:id to renderCategory");
});

test("route() dispatches #/shows to renderAllShows, matching the #/playlists pattern", () => {
  /* MUTATION: delete the `#/shows` branch from route(). This fails because
     renderHome runs instead, and the "Shows" heading never appears. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "a", title: "A Show", taxonomy_node_ids: [] }] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/shows";
  m.ctx.route();
  assert.ok(m.view().includes('<h2 class="t-title">Discover</h2>'), "route() must dispatch #/shows to renderAllShows");
});

/* ==================================================================== */
/* 6. #/shows IS STILL REACHABLE AFTER "BROWSE ALL SHOWS" WAS REMOVED    */
/* ==================================================================== */

test("the Discover tab carries the destination #/shows - the tab bar replaced the menu's entry", () => {
  /* The affordance the removed "Browse all shows" button provided, replaced rather than dropped - first by
     the drawer's "Shows" link, now (RULING THAT FELL: "four tabs + drawer"; the drawer carries no
     navigation) by the Discover tab. Read out of ui/tabbar.js's TAB_ROUTES rather than a render, because
     that is where the shipped nav lives.

     MUTATION: point the Discover entry at another hash, or delete it. This fails, and #/shows becomes an
     address with no link to it anywhere in the app. The page's heading is the tab's name (one name per
     destination; the three route assertions above and below). */
  const tabs = fs.readFileSync(path.join(ROOT, "ui", "tabbar.js"), "utf8");
  assert.ok(
    /\{ key: "discover", label: "Discover", hash: "#\/shows"/.test(tabs),
    "the tab bar must carry a Discover entry linking to #/shows"
  );
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(!/id="drawer"/.test(html), "and no drawer is left to carry a second copy");
});

test("nothing renders a 'Browse all shows' link any more — the menu replaced it, it was not duplicated", () => {
  /* Item 6 of the founder's list, and the direction that actually needs a
     test: the menu entry above could have been ADDED while the Home button
     stayed, which is one more thing on the home screen rather than one fewer.

     Asserted over app.js's source rather than one render, because the link
     could reappear on any page's template and a per-page render check would
     only cover the page someone thought to render.

     MUTATION: restore the `<a id="browse-all-link" ...>Browse all shows ›</a>`
     line to renderHome's template. Both assertions fail. */
  const src = readAppSource();
  assert.ok(!/id="browse-all-link"/.test(src), "the browse-all-link element must be gone from app.js");
  assert.ok(!/Browse all shows\s*›/.test(src), "the rendered 'Browse all shows ›' label must be gone from app.js");
});

/* ==================================================================== */
/* 7. THE BROWSE TILES SEARCH THEIR OWN TEXT (issue #684, report 1)      */
/*                                                                      */
/* Founder, 2026-09-13: "clicking on any of the tiles on the search      */
/* page gives 0 results. It should just search for that text."           */
/*                                                                      */
/* THE MEASUREMENT, over the committed data, is section 7.1 below: 32 of */
/* the 41 rendered tiles matched ZERO shows, because a tile emits a      */
/* taxonomy ROOT and shows are tagged with LEAVES. Searching each label  */
/* instead returns 10-50 shows (median 37) once the directory answers —  */
/* measured live against api/shows/search the same day.                  */
/* ==================================================================== */

/* 7.1 — THE DIAGNOSIS, pinned on the real data rather than argued. */
test("a taxonomy ROOT is not what a show is tagged with — the join a tile's count uses cannot be the category page", async () => {
  /* This is the defect itself, stated structurally so it does not rot into a
     threshold: `science` is a root, real curated shows carry `science/...`
     leaves, and `showsForCategory` matches ids EXACTLY. So the root finds
     nothing while its children find plenty — which is what put "No shows here
     yet." behind four fifths of the pill row, and why a Discover tile counts the
     shows with a leaf UNDER its root (discoverGroups) and sends the listener to
     a search, never to `#/category/<root>`.

     MUTATION: teach showsForCategory to expand a root (`id === nodeId ||
     id.startsWith(nodeId + "/")`). The first assertion goes red — which is the
     honest signal that the alternative fix landed and this test should be
     re-read, not deleted. */
  const m = await mountBooted();
  const leafTagged = (m.state.catalog.shows || []).filter((s) =>
    (s.taxonomy_node_ids || []).some((id) => id.startsWith("science/")));
  assert.ok(leafTagged.length > 0, "fixture assumption: the committed catalogue tags shows under science/*");
  assert.strictEqual(m.ctx.showsForCategory("science").length, 0,
    "the root itself matches nothing, though its children match real shows");

  const science = m.ctx.discoverGroups().flatMap((g) => g.tiles).find((t) => t.id === "science");
  assert.ok(science, "…and the Discover tile for the root exists");
  assert.strictEqual(science.count, leafTagged.length,
    "…counting every show with a leaf under it, which is what the join could not do");
});

/* 7.2 — WHAT THE TILE DOES NOW. */
test("a subject tile links to the search for its own label, never to a category page", async () => {
  /* MUTATION: build the tile's href from `taxonomyChip` (`#/category/:id`) in
     agSubjectTile's caller. Every href becomes `#/category/:id` and both
     assertions go red. */
  const m = await mountBooted();
  const html = m.ctx.discoverGroupsHtml(m.ctx.discoverGroups());
  assert.ok(html.includes('class="dsc-grid"'), "fixture assumption: the grids rendered");
  assert.ok(!/href="#\/category\//.test(html), "no tile may point at a category page");
  assert.ok(html.includes('href="#/shows/q/Science"'),
    `each tile must run the ordinary search for its own label: ${html.slice(0, 300)}`);
});

test("a tile's label is escaped in the text, encoded in the href, and survives the round trip", () => {
  /* The labels are not all tidy identifiers — "Craft & making", "Kids &
     Family", "TV & Film". An ampersand has to be percent-encoded in the URL
     and entity-escaped in the text, and it has to decode back to the literal
     label the search then runs. A long word carries a soft hyphen in the TEXT
     and never in the href: the search is for the label, not for how it breaks.

     MUTATION: drop `encodeURIComponent` from agSubjectTile. The href carries a
     bare `&`, and the label the search receives is half of the one on the tile.
     MUTATION: pass the soft-hyphenated name as `searchQuery` -> the last
     assertion goes red. */
  const m = mount();
  const craft = m.ctx.discoverTileHtml({ id: "craft", name: "Craft & making", count: 14, arts: [] });
  assert.ok(craft.includes('href="#/shows/q/Craft%20%26%20making"'), `got: ${craft}`);
  assert.ok(craft.includes(">Craft &amp; making<"), `the visible label stays escaped: ${craft}`);

  const href = /href="([^"]+)"/.exec(craft)[1].replace(/&amp;/g, "&");
  const q = /^#\/shows\/q\/(.*)$/.exec(href)[1];
  assert.strictEqual(decodeURIComponent(q), "Craft & making", "the route must decode back to the exact label");

  const rel = m.ctx.discoverTileHtml({ id: "relationships", name: "Relationships", count: 7, arts: [] });
  assert.ok(rel.includes("Relation" + String.fromCharCode(173) + "ships</h4>"), "the long word carries its soft hyphen in the text");
  assert.ok(rel.includes('href="#/shows/q/Relationships"'), "…and the search is for the plain label");
});

test("route() dispatches #/shows/q/:query to the Shows page with that search already run", () => {
  /* The other end of the tile's href, pinned through route() rather than by
     calling renderAllShows directly — a tile linking to an address nothing
     dispatches is the same class of dead end as the empty category page it
     replaced.

     MUTATION: delete the `#/shows/q/` branch from renderCurrentPage. The hash
     falls through to renderHome, and the heading assertion goes red. */
  const m = mount();
  m.state.catalog = { shows: [{ show_id: "sf", title: "Science Friday", taxonomy_node_ids: [] }] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/shows/q/Science";
  m.ctx.route();

  assert.ok(m.view().includes('<h2 class="t-title">Discover</h2>'), "it is the Shows page, not a new one");
  assert.strictEqual(m.byId.get("sh-input").value, "Science",
    "the field must hold the query, so it can be edited rather than retyped");
  assert.ok(m.byId.get("sh-results").innerHTML.includes("Science Friday"),
    `the search must already have run: ${m.byId.get("sh-results").innerHTML}`);
  assert.strictEqual(m.byId.get("sh-browse").hidden, true,
    "and the idle groups must be out of the way, by the page's own predicate");
});

test("a malformed #/shows/q/ hash lands on the plain Shows page instead of throwing", () => {
  /* A hash is user-authored text. `decodeURIComponent("%")` raises a URIError,
     and an uncaught one inside renderCurrentPage takes the whole render down —
     a blank screen for a typo.

     MUTATION: replace `safeDecode(m[1])` with `decodeURIComponent(m[1])`.
     route() throws and this goes red. */
  const m = mount();
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.state.ready = true;

  m.ctx.location.hash = "#/shows/q/%";
  assert.doesNotThrow(() => m.ctx.route());
  assert.ok(m.view().includes('<h2 class="t-title">Discover</h2>'), "an undecodable query is not a query — the idle page stands");
});

/* 7.3 — WHAT WAS NOT DELETED, AND WHY. */
test("#/category/:id is NOT a dead route — the show page's chips still lead there, and they always land on something", async () => {
  /* The repo rule is that a change which supersedes a path deletes the path
     (docs/curation/listening-quality-plan.md §5). This one supersedes the
     TILES' use of the category page, not the category page.

     Its live caller is renderShow's chip strip, and those chips are built from
     a show's OWN taxonomy_node_ids — so the page they open contains at least
     that show BY CONSTRUCTION and can never be the empty one #684 reports.
     Asserted over the whole committed catalogue rather than one example.

     MUTATION: delete renderCategory and its route -> the third assertion goes
     red. MUTATION: rewire renderShow's chips to browseTile as well -> the same
     assertion goes red, which is where a future decision to retire the
     category page would have to be recorded. */
  const m = await mountBooted();
  const shows = m.state.catalog.shows || [];
  const everyTaggedId = [...new Set(shows.flatMap((s) => s.taxonomy_node_ids || []))];
  assert.ok(everyTaggedId.length > 0, "fixture assumption: the catalogue carries taxonomy ids");

  const barren = everyTaggedId.filter((id) => m.ctx.showsForCategory(id).length === 0);
  assert.deepStrictEqual(barren, [],
    "every id a show page can emit must open a category page with at least that show on it");

  assert.ok(m.ctx.taxonomyChip(everyTaggedId[0]).includes('href="#/category/'),
    "the show page's chips still go to the category page");
});
