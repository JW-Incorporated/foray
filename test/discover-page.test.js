/* Discover (Redesign 2026, direction "ambient", BUILD-PLAN screen 4): the page behind #/shows.
 *
 * WHAT THIS PINS, in order (the suites it sits beside keep their own subjects: search-page-chrome.test.js the
 * field's focus/blur/Escape rules, search-field-bottom.test.js the docking arithmetic, search-playlists.test.js the
 * Make-a-playlist button, category-browse.test.js the real-data page; this file is what none of them can say):
 *
 *   1. THE SUBJECTS. Groups are built from the taxonomy's ROOTS with at least two curated shows under them (a show is
 *      tagged with leaves), biggest first, one cover collage per tile from that subject's first four shows with
 *      artwork, soft hyphens only in the drawn name.
 *   2. THE EMPTY PAGE'S SUBJECT LINE: exact name beats prefix beats substring, a group name answers with its biggest
 *      subject, and under three characters nothing matches.
 *   3. THE ROWS. A show row carries the Ember followed badge only for a followed show; an episode row is compact (no
 *      why-line), is one link with the play button as its SIBLING, and has no star or Up Next button; a playlist row
 *      marks a generated one in Lamp; every title goes through esc().
 *   4. THE FIELD AND THE PAGE'S CONSTANTS. The viewport meta asks for the keyboard to resize the layout; the debounce
 *      is 150 ms; the focus ring is 2px Lamp outside the pill; the x is 44; the grid is 2-up and an odd last tile spans.
 *   5. NO MOTION OF ITS OWN. Nothing in the Discover CSS transitions or animates, so the one reduced-motion block
 *      (ui/tokens.css) still covers every movement on the page.
 *   6. NO NETWORK WRITE. The Make-a-playlist path reaches no fetch at all, with the lab flag on or off, so a lab build
 *      cannot write to production from it (the rule in build-loop.md section 6; test/lab-flag.test.js carries the
 *      one-line pointer).
 *   7. THE MAP. Every screens.json row this screen owns points at a state and step that exist in the harness.
 *
 * Every test names the one-line mutation that turns it red, and each was run (CLAUDE.md, "a green test is not evidence
 * until you have broken it"). The floor lives in test/suite-integrity.test.js.
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const listeners = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(), id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [], offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; }, append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, click() {}, blur() {}, remove() {},
  };
}

const PAGE_IDS = ["view", "sh-form", "sh-input", "sh-note", "sh-results", "sh-browse", "sh-dismiss", "sh-make", "sh-make-note", "sh-empty",
  "ep-search-results", "pl-search-results", "fy-search-results"];

function mount({ seed = {}, lab = false, fetchImpl } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const fetched = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url, init) => { fetched.push({ url: String(url), method: (init && init.method) || "GET" }); return fetchImpl ? fetchImpl(url, init) : new Promise(() => {}); },
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete", addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") && !s.includes(" ") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" }, addEventListener() {}, removeEventListener() {},
    location: { hash: "#/shows", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent, scrollY: 0,
  };
  if (lab) ctx.__FORAY_LAB__ = true;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const m = { ctx, evalIn, store, byId, fetched, state: evalIn("state") };
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.discover = { items: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  return m;
}

const NODES = [
  { id: "science", label: "Science", parent: null },
  { id: "science/materials", label: "Materials", parent: "science" },
  { id: "science/space", label: "Space science", parent: "science" },
  { id: "craft", label: "Craft & making", parent: null },
  { id: "craft/wood", label: "Woodwork", parent: "craft" },
  { id: "relationships", label: "Relationships", parent: null },
  { id: "math", label: "Math", parent: null },
  { id: "nature", label: "Nature", parent: null },
  { id: "nature/wild", label: "Wild places", parent: "nature" },
];
const show = (id, title, ids, extra = {}) => ({ show_id: id, title, taxonomy_node_ids: ids, artwork_url: `https://art.test/${id}.jpg`, ...extra });

/* ==================================================================== */
/* 1. THE SUBJECTS                                                       */
/* ==================================================================== */

test("a subject is a taxonomy ROOT with two or more shows under it, counted through its leaves, biggest first", () => {
  /* MUTATION: set DISCOVER_MIN_SHOWS to 1 -> "Math" (one show) gets a tile and the length assertion fails. Another:
     count `taxonomy_node_ids` against the root id directly (no discoverRootOf) -> every count is 0 and the page is empty. */
  const m = mount();
  m.state.taxonomy = { nodes: NODES };
  m.state.catalog = { shows: [
    show("a", "Alpha", ["science/materials"]), show("b", "Beta", ["science/space", "science/materials"]),   // two leaves of one root: ONE show
    show("c", "Gamma", ["craft/wood"]), show("d", "Delta", ["craft/wood"]), show("e", "Eps", ["craft/wood"]),
    show("h", "Theta", ["nature/wild"]), show("i", "Iota", ["nature/wild"]), show("j", "Kappa", ["nature/wild"]),
    show("f", "Zeta", ["math"]),                                                                              // one show: no tile
    show("g", "Eta", ["gone/node"]),                                                                          // a stale tag takes nothing down
  ] };
  const groups = m.ctx.discoverGroups();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(groups.map((g) => [g.name, g.tiles.map((t) => [t.id, t.count])]))), [
    ["Science & nature", [["nature", 3], ["science", 2]]],   // biggest first inside a head; the group order is the direction's
    ["Making & tech", [["craft", 3]]],                        // the empty heads (People, Business, Arts) are dropped; math (one show) has no tile
  ], "five fixed heads, empty ones dropped, one stale tag ignored");
});

test("a tile's collage is the subject's first four shows WITH artwork, by chart rank then name", () => {
  /* MUTATION: sort by title only (drop the chart_rank term) -> the ranked show is not first. Another: drop the
     `if (src)` guard -> a show with no artwork takes a slot with a lettered placeholder and the count assertion fails. */
  const m = mount();
  m.state.taxonomy = { nodes: NODES };
  m.state.catalog = { shows: [
    show("a", "Aardvark", ["craft/wood"]), show("b", "Bat", ["craft/wood"], { chart_rank: 3 }), show("c", "Cat", ["craft/wood"], { chart_rank: 1 }),
    show("d", "Dog", ["craft/wood"], { artwork_url: null }), show("e", "Eel", ["craft/wood"]), show("f", "Fox", ["craft/wood"]), show("g", "Gnu", ["craft/wood"]),
  ] };
  const craft = m.ctx.discoverGroups().flatMap((g) => g.tiles).find((t) => t.id === "craft");
  assert.deepStrictEqual(Array.from(craft.arts.map((a) => a.name)), ["Cat", "Bat", "Aardvark", "Eel"], "ranked first, then A-Z, artless Dog skipped, four at most");
  assert.ok(craft.arts.every((a) => a.decorative === true), "decorative: the tile's own text names the subject");
});

test("a long root label carries its soft hyphen in the drawn name only", () => {
  /* MUTATION: drop "Relationships" from DISCOVER_SOFT_BREAKS -> the drawn name has no soft hyphen. Another: draw
     `tile.name` instead of discoverLabel(tile.name) -> same. */
  const m = mount();
  assert.strictEqual(m.ctx.discoverLabel("Relationships"), "Relation" + String.fromCharCode(173) + "ships");
  assert.strictEqual(m.ctx.discoverLabel("Health & Fitness"), "Health & Fitness", "short words are untouched");
  assert.strictEqual(m.ctx.discoverLabel("Fiction & Audio Drama"), "Fiction & Audio Drama");
  assert.strictEqual(m.ctx.discoverLabel("Unmarkedlongwordhere"), "Unmarkedlongwordhere", "an unmarked long word is left to CSS, not guessed at");
});

test("a SubjectTile counts in the singular and the plural, and escapes its name", () => {
  /* MUTATION: drop esc() around `name` in agSubjectTile -> the hostile-name assertion fails. Another: always "shows" ->
     the singular assertion fails. */
  const m = mount();
  assert.match(m.ctx.agSubjectTile({ name: "A", count: 1 }), /<p class="t-caption count">1 show<\/p>/);
  assert.match(m.ctx.agSubjectTile({ name: "A", count: 2 }), /<p class="t-caption count">2 shows<\/p>/);
  const hostile = m.ctx.agSubjectTile({ name: "<img src=x onerror=alert(1)>", count: 2, searchQuery: "<b>\"x\"</b>" });
  assert.ok(!hostile.includes("<img") && !hostile.includes("<b>"), `name and query are escaped: ${hostile}`);
  assert.ok(hostile.includes('href="#/shows/q/%3Cb%3E%22x%22%3C%2Fb%3E"'), "and the query is percent-encoded into the route");
});

/* ==================================================================== */
/* 2. THE EMPTY PAGE'S SUBJECT LINE                                      */
/* ==================================================================== */

test("the subject a query names: exact over prefix over substring, then a group's name, never under three characters", () => {
  /* MUTATION: drop the `r === best.r` tie-break -> the smaller subject wins a tie and the first assertion fails.
     Another: drop the `q.length < 3` guard -> "sc" names Science. */
  const m = mount();
  m.state.taxonomy = { nodes: NODES };
  m.state.catalog = { shows: [
    show("a", "A", ["science/materials"]), show("b", "B", ["science/materials"]), show("c", "C", ["science/materials"]),
    show("d", "D", ["craft/wood"]), show("e", "E", ["craft/wood"]),
  ] };
  /* A TIE: two subjects whose names both CONTAIN "making"; the bigger one answers. */
  m.state.taxonomy = { nodes: NODES.concat([{ id: "culture", label: "Pottery making", parent: null }]) };
  m.state.catalog.shows.push(show("p", "P", ["culture"]), show("q", "Q", ["culture"]), show("r", "R", ["craft/wood"]));
  assert.strictEqual(m.ctx.discoverSubjectMatch("making").name, "Craft & making",
    "a tie goes to the subject with more shows (Craft & making has 3, Pottery making 2, and Pottery's head comes first)");  const name = (q) => { const t = m.ctx.discoverSubjectMatch(q); return t && t.name; };
  assert.strictEqual(name("science"), "Science", "exact");
  assert.strictEqual(name("craft"), "Craft & making", "prefix");
  assert.strictEqual(name("making"), "Craft & making", "substring");
  assert.strictEqual(name("  SCIENCE "), "Science", "trimmed and folded");
  assert.strictEqual(name("sc"), null, "two characters name nothing");
  assert.strictEqual(name("making things nobody named"), null, "a longer query is not a substring of a name");
  assert.strictEqual(name("tech"), "Craft & making", "a GROUP's name (Making & tech) answers with that group's biggest subject");
});

/* ==================================================================== */
/* 3. THE ROWS                                                           */
/* ==================================================================== */

test("a show row marks FOLLOWED with the Ember badge and the word; an unfollowed one has neither", () => {
  /* BUILD-NOTES 10.7: the badge is state that varies, so it lives here and in "Where this came from" only.
     MUTATION: drop `badge: followed ? ... : ""` -> the badge assertion fails. Another: draw the badge always -> the
     unfollowed assertion fails. */
  const m = mount({ seed: { cp_starred_shows: JSON.stringify({ "s-1": { show_id: "s-1", title: "One", starred_at: "2026-09-01T00:00:00Z" } }) } });
  const on = m.ctx.discoverShowRow({ show_id: "s-1", title: "One", artwork_url: "https://art.test/1.jpg", episode_count: 12 });
  assert.ok(on.includes("ag-art-badge") && on.includes("#i-check-circle-fill"), "the badge");
  assert.match(on, /Following · 12 episodes/, "and the word, so the state is never only a mark");
  const off = m.ctx.discoverShowRow({ show_id: "s-2", title: "Two", artwork_url: "https://art.test/2.jpg", episode_count: 1 });
  assert.ok(!off.includes("ag-art-badge") && !off.includes("Following"), "an unfollowed show carries neither");
  assert.match(off, /1 episode</, "the singular");
});

test("a show row's caption: the count when known, else the byline, else the word 'Podcast'; the title is escaped and whole in title=", () => {
  /* Every result row has art and ONE meta line (DIRECTION.md, Discover). Iteration 2: a row with no count and no
     byline used to carry no caption, so its title centred and the list lost its shared baseline.
     MUTATION: drop `|| DISCOVER_SHOW_KIND` -> the bare-row assertion fails. Another: drop `esc(by ...)` -> the hostile
     byline assertion fails. Another: print "0 episodes" for a null count. */
  const m = mount();
  const bare = m.ctx.discoverShowRow({ show_id: "x", title: "Bare" });
  assert.match(bare, /<span class="t-caption dsc-meta">Podcast<\/span>/, "no count and no byline: still one caption line, the kind of thing it is");
  assert.ok(!/0 episodes/.test(bare), "and never a count it does not know");
  const by = m.ctx.discoverShowRow({ show_id: "x", title: "By", artist_name: "<b>Host</b>" });
  assert.ok(by.includes("&lt;b&gt;Host&lt;/b&gt;") && !by.includes("<b>"), "the byline stands in, escaped");
  const hostile = m.ctx.discoverShowRow({ show_id: "x/y", title: "<script>alert(1)</script>" });
  assert.ok(!hostile.includes("<script>"), "the title is escaped");
  assert.ok(hostile.includes('href="#/show/x%2Fy"') && hostile.includes('title="&lt;script&gt;'), "the id is encoded and the whole name rides in title=");
});

test("an episode row is COMPACT: no why-line, one link with the play button as its sibling, no star, no Up Next", () => {
  /* MUTATION: put `<p class="t-why">` back in discoverEpisodeRow -> the why assertion fails. Another: move the play
     button inside the <a> -> the nesting assertion fails (card-anatomy.test.js pins the same rule for the old row). */
  const m = mount();
  const item = { id: "e1", title: "Episode One", show: "Some Show", show_id: "ss", hook: "A long hook that is the old row's second line.", audio_url: "https://cdn.test/a.mp3", duration_min: 38, release_date: "2026-09-12" };
  const html = m.ctx.discoverEpisodeRow(item, "episode-search-x");
  assert.ok(!/t-why|ep-hook/.test(html) && !html.includes("A long hook"), "no why-line, no snippet");
  const link = /<a class="dsc-row-link"[^>]*>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(link, "the row's one link");
  assert.ok(!/<button/.test(link[1]), "no button inside the link");
  assert.ok(html.indexOf('class="play-btn"') > html.indexOf("</a>"), "the play button is the link's sibling");
  assert.ok(!/class="star|up-next/.test(html), "no star and no Up Next on a result row");
  assert.ok(html.includes('aria-hidden="true"') && html.includes("ag-art-56"), "56 art, hidden from assistive tech (the title names the row)");
  assert.match(html, /Some Show · 38 min · /, "one meta line");
});

test("an episode with no audio says so once instead of drawing a dead play button", () => {
  /* MUTATION: drop `|| notPlayableNote()` -> the row has no control and no note. */
  const m = mount();
  const html = m.ctx.discoverEpisodeRow({ id: "e2", title: "No Audio", show: "S" }, "episode-search-x");
  assert.ok(!html.includes("play-btn") && html.includes("Not available to play"));
});

test("a generated playlist is marked in Lamp; an own one is not; the title is escaped", () => {
  /* MUTATION: drop the `generated ?` conditional -> the own row carries the mark. Another: drop esc() on the title. */
  const m = mount();
  m.ctx.resolveParts = () => [];
  const own = m.ctx.discoverPlaylistRow({ id: "p1", title: "<i>Mine</i>", items: [] }, false);
  const gen = m.ctx.discoverPlaylistRow({ id: "gen-x", title: "Theirs", items: [] }, true);
  assert.ok(!own.includes("Generated for you") && !own.includes("<i>"), "own: no mark, title escaped");
  assert.ok(gen.includes('<span class="dsc-gen">Generated for you</span>'), "generated: the Lamp mark");
});

/* ==================================================================== */
/* 4. THE FIELD AND THE PAGE'S CONSTANTS                                 */
/* ==================================================================== */

test("the viewport asks the keyboard to resize the layout, and still forbids zoom", () => {
  /* MUTATION: drop `interactive-widget=resizes-content` from index.html's viewport meta -> red. (The no-zoom half is
     test/no-horizontal-scroll.test.js's; it is restated here so the one added token cannot be bought by dropping one.) */
  const meta = /<meta name="viewport" content="([^"]+)"/.exec(read("index.html"));
  assert.ok(meta, "the viewport meta exists");
  assert.match(meta[1], /interactive-widget=resizes-content/, "the field rides above the keyboard where the engine honours this");
  assert.match(meta[1], /maximum-scale=1/);
  assert.match(meta[1], /user-scalable=no/);
});

test("the costly passes wait 150 ms (the direction's number), not 250", () => {
  /* MUTATION: set SHOW_SEARCH_DEBOUNCE_MS back to 250 -> red. */
  const m = mount();
  assert.strictEqual(m.evalIn("SHOW_SEARCH_DEBOUNCE_MS"), 150);
});

test("the page's chrome: a 44 x, the grid 2-up with an odd last tile spanning", () => {
  /* The field itself is the Dock's now (ui/dock.css adopts #sh-compose; the ring, the pill and the row are pinned by
     test/dock.test.js). What this page keeps: the 44 clear button, the 2-up grid and the odd tile.
     MUTATION: drop `.dsc-grid > :last-child:nth-child(odd)` -> the span assertion fails. Another: `.ag .ag-btn-icon { width: 40px }`
     -> the 44 assertion fails (tap-targets.test.js holds the same floor for every .ag-btn). */
  const css = read("ui/primitives.css");
  const rule = (sel) => { const i = css.indexOf(`${sel} {`); assert.ok(i !== -1, `a rule for ${sel}`); return css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i)); };
  assert.match(rule(".ag .ag-btn-icon"), /width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/, "the x is the 44 icon button");
  assert.match(rule(".ag .dsc-grid"), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, "two up");
  assert.match(rule(".ag .dsc-grid > :last-child:nth-child(odd)"), /grid-column:\s*1 \/ -1/, "an odd last tile takes the row");
  assert.match(rule(".ag .dsc-grid > :last-child:nth-child(odd) .t-label"), /font:\s*var\(--t-headline\)/, "and its name steps up to the headline style");
  assert.match(rule(".ag .ag-search-field"), /min-height:\s*var\(--field\)/);
});

/* Iteration 2 (fidelity findings 1, 2, 3 and 6). The three tests below pin the CSS the screen's Dock behaviour is made
   of; the harness (`tools/ui-lab/fidelity.mjs`, run discover-i2-*) is what shows it. They read rules rather than
   computing layout, so each one also says what it cannot see. */
function cssRule(css, sel) {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i !== -1, `a rule for ${sel}`);
  return css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
}

test("Discover restyles NOTHING of the Dock: ui/primitives.css has no rule for the tab bar, the mini player, the field row or the fade", () => {
  /* THE DOCK IS ONE UNIT (ui/dock.css, pinned by test/dock.test.js). This page once carried a parallel copy of its rules
     (`body.ag-discover .tab-bar`, `body.ag-discover #foray-player ...`, `.ag.disc #sh-compose ...`, a `body.ag-discover::after`
     fade) that fought the real ones once the Dock landed. What the page owes the Dock is its colour (`--dock-page-bg`) and
     a top padding that steps aside. MUTATION: add any rule naming `.tab-bar`, `#foray-player`, `#sh-compose` or
     `body.ag-discover::after` back to ui/primitives.css -> the first assertion fails; drop the `--dock-page-bg` line -> the
     second fails. Harness audit: this reads the shipped stylesheet with comments stripped, not a copy. */
  const css = read("ui/primitives.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const dockish = [...css.matchAll(/^[^{}\n]*(\.tab-bar|#foray-player|#sh-compose|ag-discover::after|\.tab-btn|--dsc-)[^{}\n]*\{/gm)].map((m) => m[0].trim()).filter((r) => !r.startsWith(".gallery-page"));   // the gallery hides the real Dock on its own page: not a restyle of it
  assert.deepStrictEqual(dockish, [], `Dock rules duplicated on Discover: ${JSON.stringify(dockish)}`);
  assert.match(css, /body\.ag-discover \{[^}]*--dock-page-bg:\s*var\(--bg0\)/, "the Dock fades to this page's own colour");
  assert.match(css, /body\.ui-v2\.sh-compose\.ag-discover #view \{ padding-top: 0; \}/, "and the Dock's own top padding steps aside for the page's title");
});

test("'Make a playlist' rides above the Dock while the list is long, and the first heads sit 16 under the title", () => {
  /* Findings: the button read as missing (it is the last thing on a page that can run to fifty rows), and the Shows head
     sat 8px lower than the idle page's heads. Not seen here: that it is actually on screen (the fidelity run shows it).
     MUTATION: delete `position: sticky` -> the first assertion fails. Another: `z-index: 40` -> the Dock's fade (layer 55) would dim
     the button, and the second assertion fails. Another: `margin: var(--s-6) 0 var(--s-3)` on the results head -> the
     third fails (24, not the idle heads' 16). */
  const css = read("ui/primitives.css");
  const make = cssRule(css, ".ag.disc .dsc-make");
  assert.match(make, /position:\s*sticky/, "sticky");
  assert.match(make, /bottom:\s*calc\(var\(--dock-h\) \+ var\(--safe-bottom\) \+ var\(--dock-inset\) \+ var\(--s-2\)\)/, "8 above the Dock, whatever rows the Dock has (the Dock's own --dock-h)");
  assert.ok(Number(/z-index:\s*(\d+)/.exec(make)[1]) > Number(/\.dock-layer \{[^}]*z-index:\s*(\d+)/.exec(read("ui/dock.css"))[1]), "above the Dock layer and its fade");
  const head = cssRule(css, ".ag.disc .sh-results-head");
  const idle = cssRule(css, ".ag #sh-browse > .dsc-group:first-of-type > .ag-section-head");
  assert.match(head, /margin:\s*var\(--s-4\) 0 var\(--s-3\)/, "16 above, 12 below");
  assert.match(idle, /margin-top:\s*var\(--s-4\)/, "the idle page's first head is 16 too: one rhythm");
});

test("Discover's result rows are 64 tall at least, and the players' glyph controls 44", () => {
  /* MUTATION: set `.ag .dsc-row { min-height: 40px }` -> red. */
  const css = read("ui/primitives.css");
  const block = (sel) => { const i = css.indexOf(`${sel} {`); return css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i)); };
  assert.match(block(".ag .dsc-row"), /min-height:\s*var\(--row-queue\)/);
  assert.match(read("ui/tokens.css"), /--row-queue:\s*64px/);
  assert.match(block(".ag .dsc-ep .play-btn"), /width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/);
});

test("Discover's copy obeys the copy rules: no we/us/our, 'subject' never 'topic'", () => {
  /* MUTATION: put "Pick a topic" into the placeholder -> red. The strings are read from the rendered page and the empty
     page, i.e. what a listener can read, not from source. */
  const m = mount();
  m.state.taxonomy = { nodes: NODES };
  m.state.catalog = { shows: [show("a", "A", ["science/materials"]), show("b", "B", ["science/materials"])] };
  m.ctx.renderAllShows();
  const idle = m.byId.get("view").innerHTML;
  m.ctx.paintDiscoverEmpty("sci", m.evalIn("showSearchToken"));
  const empty = m.byId.get("sh-empty").innerHTML;
  const text = (idle + " " + empty + " " + (m.ctx.agButton({ label: "Make a playlist from “sci”" }))).replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(text, /\b(we|us|our|we're|we've)\b/i, "no we/us/our");
  assert.doesNotMatch(text, /\btopics?\b/i, '"subject", not "topic"');
  assert.ok(text.includes("Search, or name a subject") || idle.includes('placeholder="Search, or name a subject"'), "the placeholder is the direction's");
});

test("the page is not 'empty' while ANY group still owes an answer — the episode endpoint included", async () => {
  /* The shows passes and the playlist group answer at once; the episode endpoint is held open. An empty Shows group
     over an Episodes group still owed is a searching page.
     MUTATION: change `--answersOwed > 0` to `> 1` in runShowSearchCostly's answerDone -> the EmptyState paints with
     one half still owed and the first assertion fails. */
  const m = mount({
    fetchImpl: (url) => {
      const u = String(url);
      if (u.includes("api/episodes/search") || !u.includes("api/")) return new Promise(() => {});   // the episode endpoint never answers; boot's own data fetches hang (this harness has no drawer to boot into)
      if (u.includes("api/shows/index/")) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ shows: [], degraded: false, fallthrough: { attempted: true, error: null } }) });
    },
  });
  m.ctx.renderAllShows();
  m.ctx.renderShowSearchResults("zzqx");
  const deadline = Date.now() + 2000;
  while (m.evalIn("showSearchSettled.token") !== m.evalIn("showSearchToken") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(m.evalIn("showSearchSettled.token"), m.evalIn("showSearchToken"), "fixture: the shows passes settled");
  assert.strictEqual(m.byId.get("sh-empty").hidden, true, "…but the episode half is still owed, so the page is not empty yet");
  assert.match(m.byId.get("sh-note").textContent, /^Searching for “zzqx”…$/, "and says it is searching");
});

test("the Make button shows it is working: disabled and busy while the build waits, restored after", () => {
  /* The build waits for the search documents (seconds on a cold start); a tap that looks like nothing is the failure.
     MUTATION: delete `paintMakePending(true, btn)` from buildPlaylistFromDiscover -> the busy assertion fails. */
  const m = mount();
  const attrs = {};
  const btn = Object.assign(makeEl("button"), {
    getAttribute: (k) => (k === "data-make-playlist" ? "tokamaks" : (attrs[k] ?? null)),
    isConnected: true,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    querySelector: () => label,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  const label = makeEl("span");
  const orig = m.ctx.document.querySelector;
  m.ctx.document.querySelector = (sel) => (sel === "#sh-make [data-make-playlist]" ? btn : orig(sel));
  let held = null;
  m.ctx.whenSearchDataReady = (fn) => { held = fn; };
  m.ctx.buildPlaylist = () => ({ status: "empty", suggestions: [], playlist: null });
  m.ctx.buildPlaylistFromDiscover("tokamaks", btn);
  assert.strictEqual(btn.disabled, true, "disabled while it waits");
  assert.strictEqual(attrs["aria-busy"], "true", "and busy for assistive tech");
  assert.strictEqual(label.textContent, "Building…", "and the label says what it is doing");
  held();
  assert.strictEqual(btn.disabled, false, "restored once the build ends");
  assert.strictEqual(attrs["aria-busy"], undefined);
  assert.strictEqual(label.textContent, "Make a playlist from “tokamaks”");
});

/* ==================================================================== */
/* 5. NO MOTION OF ITS OWN                                               */
/* ==================================================================== */

test("nothing in the Discover CSS transitions or animates, so the one reduced-motion block covers the page", () => {
  /* ui/tokens.css holds the ONE reduced-motion block (`.ag *` scope). A transition added here without a line in that
     block would run for a listener who asked for none.
     MUTATION: add `transition: transform .2s` to `.ag .dsc-row` -> red. */
  const css = read("ui/primitives.css");
  const marker = css.indexOf("Discover (Redesign 2026, ambient, screen 4)");
  assert.ok(marker !== -1, "the Discover block is delimited");
  const block = css.slice(css.lastIndexOf("/*", marker)).replace(/\/\*[\s\S]*?\*\//g, "");   // from the comment that opens it
  assert.ok(!/transition|animation|@keyframes/.test(block), "the Discover block moves nothing");
  assert.strictEqual((read("ui/tokens.css").match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1, "…and the one block is still the only one in tokens.css");
});

/* ==================================================================== */
/* 6. NO NETWORK WRITE                                                   */
/* ==================================================================== */

for (const lab of [true, false]) {
  test(`the Make-a-playlist path reaches no fetch at all (lab flag ${lab ? "on" : "off"}) — it writes locally and logs a local event`, async () => {
    /* The lab rule (build-loop.md section 6): a screen that adds a network write must honour __FORAY_LAB__ and get a
       test beside lab-flag.test.js's three. This screen adds NO write: the build is `buildPlaylist` into cp_playlists
       and `logEvent("playlist_built")`, which falls to toEventRow's default (never sent). So the strongest honest test is
       that the path makes no request, either way. MUTATION: add `fetchApiJson("api/…", { method: "POST" })` (or any
       fetch) to buildPlaylistFromDiscover -> the request assertion fails in BOTH variants. */
    const m = mount({ lab, seed: { cp_ui_v2: "true" } });
    m.state.discover = JSON.parse(read("data/discover.json"));
    m.state.itemTags = JSON.parse(read("data/item-tags.json"));
    m.state.semantic = JSON.parse(read("data/semantic-index.json"));
    m.ctx.renderAllShows();
    m.ctx.location.hash = "#/shows";
    const before = m.fetched.length;
    m.evalIn("buildPlaylistFromDiscover")("meditation");
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(m.fetched.slice(before).filter((f) => f.method !== "GET").length, 0, "no write");
    assert.strictEqual(m.fetched.slice(before).length, 0, "and not a single request of any kind");
    assert.strictEqual(JSON.parse(m.store.get("cp_playlists") || "[]").length, 1, "the playlist was built, locally");
  });
}

/* ==================================================================== */
/* 7. THE MAP                                                            */
/* ==================================================================== */

test("every screens.json row Discover owns points at a harness state and step that exist", () => {
  /* fidelity.mjs refuses a map naming a step that does not exist; this says so at test time. MUTATION: rename
     "discover-kb" in states.mjs -> red naming the row. */
  const map = JSON.parse(read("docs/redesign-2026/directions/ambient/screens.json")).screens;
  const states = read("tools/ui-lab/lib/states.mjs");
  const rows = ["search", "search-typing", "search-results", "search-no-results", "discover-kb", "discover-nomini"];
  for (const id of rows) {
    assert.ok(map[id], `screens.json has the ${id} row`);
    const { state, step } = map[id].app;
    assert.ok(new RegExp(`label: "${step}"`).test(states), `${id}: step "${step}" exists in states.mjs`);
    assert.ok(new RegExp(`id: "${state}"`).test(states), `${id}: state "${state}" exists in states.mjs`);
    assert.ok(map[id].regions.field, `${id} measures the field`);
  }
});

/* ==================================================================== */
/* 8. THE DOCK'S TWO BARS (iteration 3: the mini player and the tab bar)  */
/* ==================================================================== */

/* The rule body for an exact selector in ui/primitives.css (the last one wins, like the cascade for equal specificity). */
function primRule(sel) {
  const css = read("ui/primitives.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp("(?:^|\\})\\s*" + sel.replace(/[.#\[\]"=()]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  let body = null, m;
  while ((m = re.exec(css))) body = m[1];
  return body;
}

test("a small subject's overlapping squares sit on the tile, not in a sunken well, and the tile keeps the prototype's 8 / 10 rhythm", () => {
  /* Second fidelity pass (Space and Cities, 3 shows, drew a darker inset well behind the stack, so the tile read as a different
     component from its 2x2 neighbours). MUTATIONS, each run red: (a) delete the `background: transparent` line from the c2/c3
     rule (the well returns); (b) change the grid tile's padding to var(--s-2) (the collage sits 2px left of the prototype's);
     (c) change its gap to var(--s-3) (the name column shifts 2px); (d) widen the transparent rule to `.ag-collage` itself (the
     second assertion fails: the 2x2's cell colour behind its hairline is gone). Harness audit: reads the shipped stylesheet;
     the collage's own rule keeps --collage-bg for the 4-up and the single art. */
  const well = primRule(".ag .ag-subject-tile .ag-collage.c2, .ag .ag-subject-tile .ag-collage.c3");
  assert.ok(well, "the small-subject rule exists");
  assert.match(well, /background:\s*transparent/, "no well behind two or three squares");
  assert.match(primRule(".ag .ag-collage"), /background:\s*var\(--collage-bg\)/, "the collage's own cell colour is untouched elsewhere");
  const tile = primRule(".ag .dsc-grid .ag-subject-tile, .ag .dsc-empty-tile .ag-subject-tile");
  assert.ok(tile, "Discover's tile rhythm rule exists");
  assert.match(tile, /padding:\s*var\(--s-2\)\s+calc\(var\(--s-2\)\s*\+\s*var\(--s-1\)\s*\/\s*2\)/, "8 above and below, 10 in from the sides");
  assert.match(tile, /gap:\s*calc\(var\(--s-2\)\s*\+\s*var\(--s-1\)\s*\/\s*2\)/, "10 from the collage to the name");
});
