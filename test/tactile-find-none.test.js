/* Tactile `search-none` (Find, no results): the screen for a query nothing matched.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.11,
 * BUILD-NOTES 4.4.
 *
 * WHAT THIS PROVES
 *   1. THE SENTENCE NEVER CONTRADICTS THE TILE. "{Subject} has {n} shows." and the
 *      tile's count readout are the same number, the number of shows the catalogue
 *      tags with that subject, and the category page the tile opens lists exactly
 *      that many. The expected numbers come from the fixture's own tags, not from
 *      the code under test, so a count wrong in both places still fails.
 *   2. The heading is "No shows match '{q}'." in the prototype's single curly pair,
 *      set as text (a query cannot become an element), and every other place the
 *      query or a subject's label is interpolated goes through esc().
 *   3. NEVER A BARE SENTENCE: a subject that matches gets its sentence and tile, a
 *      query that is a subject's own name with narrower subjects gets the chips, a
 *      query that is neither gets the key alone, and in every case the settled line
 *      is followed by the "Make a playlist about" key. While passes are still owed
 *      the box is empty and hidden (the line is "Searching for ...", not an answer).
 *   4. Which subject a query names: every word of it in the label, the label that IS
 *      the query first, then one that starts with it, then more shows; and only a
 *      subject that holds shows of its own (a root is almost never tagged on a show,
 *      and a tile for one would open an empty page).
 *   5. The tile is a FILL (`--ultramarine-soft`), never an outline, and opens the
 *      category page by a route that goes through safeUrl on a hostile id.
 *   6. The stylesheet: the heading role, the column rhythm, the rules that give way
 *      to Episodes / Playlists / Forays, and that the block adds no hex, motion or
 *      !important.
 *   7. The copy passes the same banned-phrase lists backend/test/copyRules.test.ts
 *      uses, says "subject" and never "topic", and has no we/us/our.
 *   8. The harness has the settled step, appended after the five that existed, and
 *      the screen map points at it with the heading, sentence, tile and key as
 *      regions.
 *
 * WHAT IT CANNOT PROVE: how any of it looks. tools/ui-lab/fidelity.mjs measures that
 * against the prototype in a real browser; this suite runs in node:vm.
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken it").
 * The page is the real renderAllShows over a DOM stub with recorded listeners, and
 * the painter is the real paintShowResults, so a mutation in ui/search.js or
 * ui/browse.js changes what these tests read. The catalogue fixture tags five shows
 * with one subject, four with another and ONE with a third, so a count that is
 * hard-coded, off by one, or not singularised fails somewhere. The stub's
 * `querySelector` answers null for everything but ids, which is more forgiving than a
 * browser for bindCreatePlaylistCta (it simply finds no key to bind), so the click
 * path is not claimed here. Each test names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { interpolatedUrlAttrs, unguardedInterpolatedUrlAttrs } = require("./helpers/url-attr-census.js");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");
const copy = require("../backend/src/copy/rules.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const listeners = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, evt = {}) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) fn({ type, preventDefault() {}, target: this, ...evt });
      return fns.length;
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, blur() {}, remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-results-count", "sh-browse", "sh-dismiss",
  "sh-partial-note", "sh-empty-offer", "sh-offline-note",
  "ep-search-results", "pl-search-results", "fy-search-results", "find-more", "find-mosaic",
];

const NODES = [
  { id: "engineering", parent: null, label: "Engineering" },
  { id: "engineering/energy-fusion", parent: "engineering", label: "Fusion & energy systems" },
  { id: "engineering/energy-grid", parent: "engineering", label: "Energy Grid" },
  { id: "craft/instrument-making", parent: "craft", label: "Instrument making" },
  { id: "science", parent: null, label: "Science" },
  { id: "science/physics", parent: "science", label: "Physics" },
  { id: "science/geology", parent: "science", label: "Geology" },
];
const tagged = (n, id, art = true) => Array.from({ length: n }, (_, i) => ({
  show_id: `${id}-${i}`, title: `${id} show ${i}`, taxonomy_node_ids: [id],
  ...(art ? { artwork_url: `https://is1-ssl.mzstatic.com/image/thumb/p/${id.length}${i}/600x600bb.jpg` } : {}),
}));
const CATALOG = { shows: [
  ...tagged(5, "engineering/energy-fusion"),
  ...tagged(4, "engineering/energy-grid"),
  ...tagged(1, "craft/instrument-making", false),
  ...tagged(1, "science/physics"),
] };

function mount({ nodes = NODES, catalog = CATALOG, onLine = true } = {}) {
  const store = new Map();
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
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
        return s.startsWith("#") && !s.includes(" ") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node", onLine },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/shows", search: "", pathname: "/", href: "https://x.test/" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollY: 0,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  state.catalog = catalog;
  state.discover = { items: [] };
  state.cardSlots = [];
  state.taxonomy = { nodes };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  return { ctx, evalIn, store, state, byId };
}

/** What the page paints for a settled search of `query` that found no show: the
    real painter, with every pass answered. `settled: false` is a search still owed. */
function paintNone(m, query, { settled = true } = {}) {
  m.ctx.renderAllShows();
  const token = m.evalIn("showSearchToken");
  if (settled) m.evalIn(`showSearchSettled = { token: showSearchToken, query: ${JSON.stringify(query)} }`);
  m.evalIn("paintShowResults")(query, [], token);
  return { note: m.byId.get("sh-note"), offer: m.byId.get("sh-empty-offer") };
}

/** The numbers a listener could read off the offer: the sentence's and the tile's. */
function readCounts(html) {
  const line = /<p class="find-none__line">(.*?) has (\d+) shows?\.<\/p>/.exec(html);
  const tile = /<a class="tile tile--m is-hit"[^>]*>[\s\S]*?<strong class="tile__name">(.*?)<\/strong><span class="readout">(\d+) shows?<\/span>/.exec(html);
  return { line, tile };
}

const RULES = parseRules(CSS);
function rule(selector) {
  const out = {};
  let found = false;
  for (const r of RULES) {
    if (!r.selectors || !r.selectors.includes(selector)) continue;
    if (r.atRules.length) continue;
    found = true;
    for (const d of r.decls) out[d.prop] = d.value;
  }
  assert.ok(found, `styles.css has no rule for ${selector}`);
  return out;
}
const NONE_START = CSS.lastIndexOf("/*", CSS.indexOf("FIND, NO RESULTS (TACTILE): never a bare sentence"));
const NONE_END = CSS.indexOf("COMPONENT GALLERY. Development-only");
const NONE_CSS = CSS.slice(NONE_START, NONE_END);

/* ------------------------------------------------- 1 the sentence and the tile */

test("the sentence's count is the tile's count, and both are the number of shows the catalogue tags with the subject", () => {
  /* MUTATION 1: in findNoneSubjectHtml write `findShowsCount(subject.count + 1)` in the
     sentence (it then says six where the tile says five).
     MUTATION 2: in findTileBody write `findShowsCount(t.count + 1)` (the tile then
     disagrees with the sentence; the mosaic's tiles read the same builder, so the idle
     screen's counts move too).
     MUTATION 3: in findNoneSubject set `count: best.shows.length + 1` (sentence and
     tile agree with each other and are both wrong; only the fixture's own tag count,
     computed here, catches it).
     MUTATION 4: print `${n} shows` in findShowsCount (one show reads "1 shows"). */
  const cases = [["fusion", "Fusion & energy systems", 5], ["energy grid", "Energy Grid", 4], ["instrument", "Instrument making", 1]];
  for (const [q, label, n] of cases) {
    const m = mount();
    const { offer } = paintNone(m, q);
    const { line, tile } = readCounts(offer.innerHTML);
    assert.ok(line, `${q}: the sentence names a subject: ${offer.innerHTML}`);
    assert.ok(tile, `${q}: the tile shows its count: ${offer.innerHTML}`);
    const raw = (s) => s.replace(/&amp;/g, "&");
    assert.strictEqual(raw(line[1]), label, `${q}: the sentence names the subject`);
    assert.strictEqual(raw(tile[1]), label, `${q}: and the tile is that subject's`);
    assert.strictEqual(Number(line[2]), n, `${q}: the sentence says ${n}`);
    assert.strictEqual(Number(tile[2]), Number(line[2]), `${q}: the tile's readout is the sentence's number`);
    const tags = CATALOG.shows.filter((s) => s.taxonomy_node_ids.includes(NODES.find((x) => x.label === label).id)).length;
    assert.strictEqual(tags, n, "fixture: the expected number is the catalogue's own tag count");
    const word = n === 1 ? "show" : "shows";
    assert.ok(offer.innerHTML.includes(`has ${n} ${word}.</p>`) && offer.innerHTML.includes(`<span class="readout">${n} ${word}</span>`), `${q}: singular for one, plural otherwise`);
  }
});

test("the tile opens the category page, which lists exactly the count the tile printed", () => {
  /* MUTATION: point the tile at `#/shows/q/<label>` (the screen the listener is already
     on: a search for a label that may itself find nothing, so the tile could loop), or
     count with `showsForCategory(...)` replaced by a descendant walk (the page behind
     the tile would list fewer shows than the tile claims). */
  const m = mount();
  const { offer } = paintNone(m, "fusion");
  const href = /<a class="tile tile--m is-hit" href="([^"]*)"/.exec(offer.innerHTML);
  assert.ok(href, offer.innerHTML);
  assert.strictEqual(href[1], "#/category/engineering%2Fenergy-fusion", "the category page for that subject");
  const id = decodeURIComponent(href[1].slice("#/category/".length));
  assert.strictEqual(m.evalIn("showsForCategory")(id).length, 5, "and that page lists the five the tile counted");
});

/* --------------------------------------------------- 2 heading and escaping */

test("the heading is 'No shows match ‘q’.' as text, and the query and the subject's label go through esc() everywhere else", () => {
  /* MUTATION 1: interpolate `${query}` (not esc) in the key's label or its data
     attribute, or in the subject block (a hostile subject label below).
     MUTATION 2: set the note with innerHTML instead of textContent (the stub keeps
     both, and the test reads that innerHTML stayed empty).
     MUTATION 3: put quoteQuery() back in the heading (double curly pair). */
  const hostile = "<b>x</b>";
  const m = mount();
  const { note, offer } = paintNone(m, hostile);
  assert.strictEqual(note.textContent, "No shows match ‘<b>x</b>’.", "the prototype's single pair, the query as text");
  assert.strictEqual(note.innerHTML, "", "never written as markup");
  assert.ok(!offer.innerHTML.includes("<b>x</b>"), `the raw query never reaches the offer: ${offer.innerHTML}`);
  assert.ok(offer.innerHTML.includes("Make a playlist about ‘&lt;b&gt;x&lt;/b&gt;’"), "escaped in the key's label");
  assert.ok(offer.innerHTML.includes('data-create-playlist="&lt;b&gt;x&lt;/b&gt;"'), "and in its attribute");

  /* A subject whose label is hostile: the sentence and the tile name it escaped. */
  const nodes = [{ id: "x/hostile", parent: "x", label: "<i>Fusion</i> & more" }];
  const shows = tagged(3, "x/hostile");
  const h = mount({ nodes, catalog: { shows } });
  const out = paintNone(h, "fusion").offer.innerHTML;
  assert.ok(!out.includes("<i>Fusion</i>"), `the raw label never reaches the page: ${out}`);
  assert.ok(out.includes("&lt;i&gt;Fusion&lt;/i&gt; &amp; more has 3 shows."), "the sentence escapes it");
  assert.ok(out.includes('<strong class="tile__name">&lt;i&gt;Fusion&lt;/i&gt; &amp; more</strong>'), "and so does the tile");
  assert.ok(!/\bstyle=/.test(out), "no inline style in the markup (strict CSP)");
});

/* ------------------------------------------------------ 3 never a bare sentence */

test("a settled empty search is never a bare sentence: subject + tile + key, chips + key, or the key alone", () => {
  /* MUTATION 1: drop the `parts.push(... find-none__key ...)` line in
     paintShowSearchEmptyOffer (the first three cases lose the key).
     MUTATION 2: return `null` from findNoneSubject (the first case loses its
     sentence and tile).
     MUTATION 3: drop the chips branch's `else` (a subject and chips together), or the
     chips branch itself (the third case loses them).
     MUTATION 4: leave `box.hidden = true` for the key-only case (the offer is hidden
     and the heading stands alone). */
  const keyOf = (html) => (html.match(/data-create-playlist=/g) || []).length;

  const subject = mount();
  const a = paintNone(subject, "fusion").offer;
  assert.strictEqual(a.hidden, false);
  assert.ok(a.innerHTML.includes('class="find-none"') && a.innerHTML.includes("is-hit"), "a matching subject: its sentence and tile");
  assert.strictEqual(keyOf(a.innerHTML), 1, "and one key");
  assert.ok(a.innerHTML.indexOf("is-hit") < a.innerHTML.indexOf("data-create-playlist="), "the key is under the tile");
  assert.ok(!a.innerHTML.includes("fy-chips"), "no chips beside a tile");

  const chips = mount();
  const b = paintNone(chips, "science").offer;
  assert.strictEqual(b.hidden, false);
  assert.ok(/Shows filed under Science:/.test(b.innerHTML) && b.innerHTML.includes('href="#/category/science%2Fphysics"'), `a subject's own name with narrower subjects: the chips: ${b.innerHTML}`);
  assert.ok(!b.innerHTML.includes("geology"), "only a subject that holds a show is offered");
  assert.ok(!b.innerHTML.includes("is-hit"), "and no tile for a root that holds none of its own");
  assert.strictEqual(keyOf(b.innerHTML), 1, "then the key");

  const none = mount();
  const c = paintNone(none, "zzqxjv").offer;
  assert.strictEqual(c.hidden, false, "the heading never stands alone");
  assert.strictEqual(keyOf(c.innerHTML), 1);
  assert.ok(!c.innerHTML.includes("find-none\"") && !c.innerHTML.includes("fy-chips"), `a query that names nothing: the key alone: ${c.innerHTML}`);
  assert.ok(c.innerHTML.includes("Make a playlist about ‘zzqxjv’"), "carrying the query");
});

test("while a pass is still owed the box is empty and hidden, and a non-empty answer clears it again", () => {
  /* MUTATION: pass `{ query }` whatever `settled` says (the key and tile would show
     under "Searching for ..."), or drop the `paintShowSearchEmptyOffer(null)` after the
     empty branch (a later answer with rows would keep the old tile). */
  const m = mount();
  const searching = paintNone(m, "fusion", { settled: false });
  assert.strictEqual(searching.note.dataset.state, "searching");
  assert.strictEqual(searching.offer.hidden, true, "an unanswered search offers nothing");
  assert.strictEqual(searching.offer.innerHTML, "");
  paintNone(m, "fusion");
  assert.strictEqual(m.byId.get("sh-empty-offer").hidden, false);
  const token = m.evalIn("showSearchToken");
  m.evalIn("paintShowResults")("fusion", [{ show_id: "a", title: "A show" }], token);
  assert.strictEqual(m.byId.get("sh-empty-offer").hidden, true, "rows arrived: the offer goes");
  assert.strictEqual(m.byId.get("sh-empty-offer").innerHTML, "");
});

test("offline, the line is the offline one and the offer still stands under it", () => {
  /* MUTATION: skip the offer when `offline` (the offline line would be bare). */
  const m = mount({ onLine: false });
  const { note, offer } = paintNone(m, "fusion");
  assert.strictEqual(note.textContent, "You're offline — no shows found for “fusion”.");
  assert.ok(offer.innerHTML.includes("find-none") && offer.innerHTML.includes("data-create-playlist="), "the subject is on the device, so the tile and the key are still honest offline");
});

/* ---------------------------------------------------------- 4 which subject */

test("a query names the subject whose label is the query, then one that starts with it, then one that merely contains it, then the one with more shows; a subject with no show of its own is never named", () => {
  /* MUTATION 1: drop the `if (!shows.length) continue` (a root like "Engineering", or
     a subject with no shows, is named and its tile opens an empty page).
     MUTATION 2: take the first match instead of ranking (`best = best || ...`).
     MUTATION 3: test `low.includes(phrase)` instead of every word (words in another
     order stop matching). MUTATION 4: drop the tie-break on count. */
  const nodes = [
    { id: "a/grid", parent: "a", label: "Energy Grid" },
    { id: "a/energy", parent: "a", label: "Energy" },
    { id: "a/storage", parent: "a", label: "Energy storage and grid tie" },
    { id: "a/gridfirst", parent: "a", label: "Grid energy" },
    { id: "a", parent: null, label: "Engineering" },
    { id: "b/empty", parent: "b", label: "Energy of nothing" },
    { id: "c/small", parent: "c", label: "Wind grid" },
    { id: "c/big", parent: "c", label: "Power grid" },
  ];
  const shows = [...tagged(2, "a/grid"), ...tagged(3, "a/energy"), ...tagged(6, "a/storage"), ...tagged(2, "a/gridfirst"), ...tagged(2, "c/small"), ...tagged(6, "c/big")];
  const m = mount({ nodes, catalog: { shows } });
  const named = (q) => { const s = m.evalIn("findNoneSubject")(q); return s && s.label; };
  assert.strictEqual(named("energy"), "Energy", "the label that IS the query first, though another holds more shows");
  assert.strictEqual(named("energy grid"), "Energy Grid", "the exact phrase beats labels that hold both words elsewhere");
  assert.strictEqual(named("grid energy"), "Grid energy", "words in another order are another label");
  assert.strictEqual(named("grid"), "Grid energy", "a label that STARTS with the query beats ones that contain it");
  assert.strictEqual(named("storage tie"), "Energy storage and grid tie", "every word, in any order: one label holds both");
  assert.strictEqual(named("wind power"), null, "words that no one label holds together name nothing");
  assert.strictEqual(named("engineering"), null, "a root that holds no show of its own is not a tile");
  assert.strictEqual(named("nothing"), null, "nor is a subject with no shows");
  assert.strictEqual(named("   "), null, "an empty query names nothing");
  const tie = mount({ nodes: nodes.filter((n) => n.parent === "c"), catalog: { shows } });
  assert.strictEqual(tie.evalIn("findNoneSubject")("grid").label, "Power grid", "on a tie of rank, the subject with more shows");
  const art = m.evalIn("findNoneSubject")("energy grid");
  assert.strictEqual(art.arts.length, 2, "the disc art is the subject's own shows' covers, as many as it has up to three");
  assert.strictEqual(m.evalIn("findNoneSubject")("energy").arts.length, 3, "and no more than three");
});

/* ------------------------------------------------------------- 5 the tile */

test("the tile is a fill in --ultramarine-soft with the card's shape, never an outline, and its route goes through safeUrl on a hostile id", () => {
  /* MUTATION 1: replace `background: var(--ultramarine-soft)` with
     `outline: 2px solid var(--ultramarine)` (an outline tile).
     MUTATION 2: add an `outline`, `border` or a 1px ring `box-shadow` to the rule.
     MUTATION 3: write the href without encodeURIComponent, or without safeUrl (the
     hostile id below then ends the attribute or is refused to "#"). */
  const hit = rule("body.view-find .tile.is-hit");
  assert.strictEqual(hit.background, "var(--ultramarine-soft)", "filled, in the soft ultramarine");
  for (const bad of ["outline", "outline-color", "border", "border-color", "box-shadow"]) assert.ok(!(bad in hit), `the hit rule draws no ${bad}: it is a fill, not a ring`);
  assert.strictEqual(rule("body.view-find .tile.is-hit .readout").color, "var(--ink)", "ink on it, so the readout clears AA (ui-tokens-dial pins ink on --ultramarine-soft)");
  const tileRules = RULES.filter((r) => r.selectors && r.selectors.some((s) => /(^|\s)\.tile(\.is-hit)?$|\.tile\.is-hit/.test(s)) && !r.atRules.length);
  for (const r of tileRules) for (const d of r.decls) assert.ok(!(d.prop === "outline" && /ultramarine/.test(d.value)), `no ultramarine outline on a tile (${r.selectors.join(", ")})`);

  const hostileId = 'x/hos" onclick="y';
  const nodes = [{ id: hostileId, parent: "x", label: "Fusion systems" }];
  const m = mount({ nodes, catalog: { shows: tagged(3, hostileId) } });
  const out = paintNone(m, "fusion").offer.innerHTML;
  const hrefs = [...out.matchAll(/<a class="tile tile--m is-hit" href="([^"]*)"/g)].map((x) => x[1]);
  assert.strictEqual(hrefs.length, 1, `one tile, and its href is one attribute (a quote in the id did not end it): ${out}`);
  assert.strictEqual(hrefs[0], "#/category/x%2Fhos%22%20onclick%3D%22y");
  assert.ok(!/onclick="/.test(out), "the hostile id grew no attribute");
  const browseJs = fs.readFileSync(path.join(ROOT, "ui", "browse.js"), "utf8").replace(/\r\n/g, "\n");
  const seen = interpolatedUrlAttrs(browseJs);
  assert.ok(seen.length >= 3, `the census sees the tile hrefs in ui/browse.js (saw ${seen.length})`);
  assert.deepStrictEqual(unguardedInterpolatedUrlAttrs(browseJs), [], "every interpolated href/src in ui/browse.js names safeUrl");
});

/* ------------------------------------------------------------ 6 the stylesheet */

test("the heading is in the heading role, the offer is one 12px column, and the sentence, tile and key give way to a group that answered", () => {
  /* MUTATION 1: drop `font-family: var(--dial-font-display)` or the heading size token
     from the `#sh-note[data-state="empty"]` rule (the line reads as a footnote again).
     MUTATION 2: drop the `margin-bottom` pull-back (the page's 32px gap opens between
     the heading and the sentence; fidelity measured it at 0px with it).
     MUTATION 3: delete the first hide rule (Episodes or Playlists answered and the
     screen still says a subject has shows, under results).
     MUTATION 4: delete the last rule, or drop its `.fy-playlist-search` exclusion (two
     closing keys, or none when the playlist cards already stand). WHAT IT CANNOT PROVE:
     that :has() selects what the page puts there; fidelity `search-none-i4` read the
     layout (every region 0.0px) with the scorer's own key present. */
  const head = rule('body.view-find #sh-note[data-state="empty"]');
  assert.strictEqual(head["font-family"], "var(--dial-font-display)");
  assert.strictEqual(head["font-size"], "var(--t-heading)");
  assert.strictEqual(head["line-height"], "var(--lh-heading)");
  assert.strictEqual(head["font-weight"], "var(--w-heading)");
  assert.strictEqual(head["margin-bottom"], "calc(var(--gap) - var(--s-8))", "the page's block gap (--s-8) pulled back to the section's --gap");
  assert.strictEqual(rule("body.view-find .page--find").gap, "var(--s-8)", "fixture: that is the page's gap");
  const col = rule("body.view-find #sh-empty-offer:not([hidden])");
  assert.strictEqual(col.display, "flex");
  assert.strictEqual(col["flex-direction"], "column");
  assert.strictEqual(col.gap, "var(--gap)");
  assert.strictEqual(rule("body.view-find .find-none").gap, "var(--gap)");
  const line = rule("body.view-find .find-none__line");
  assert.strictEqual(line.font, "var(--w-body) var(--t-body-lg)/var(--lh-body-lg) var(--font-text)", "body-lg, the prototype's sentence");

  const answered = 'body.view-find #sh-empty-offer:is(:has(~ #ep-search-results:not([hidden])), :has(~ #pl-search-results .fy-playlist-search), :has(~ #fy-search-results:not([hidden]))) :is(.find-none, .find-none__key) { display: none; }';
  assert.ok(NONE_CSS.includes(answered), "the sentence, tile and key go when Episodes, Playlists or Forays answered (the same three conditions that drop the heading)");
  const emptyBox = 'body.view-find #sh-empty-offer:is(:has(~ #ep-search-results:not([hidden])), :has(~ #pl-search-results .fy-playlist-search), :has(~ #fy-search-results:not([hidden]))):not(:has(.fy-chips)) { display: none; }';
  assert.ok(NONE_CSS.includes(emptyBox), "and with nothing left in the box (no chips) the box itself goes: an empty flex item still takes the page's 32px gap (fidelity search-typing: rows +32, key +48 without this)");
  const same = 'body.view-find #sh-note[data-state="empty"]:is(:has(~ #ep-search-results:not([hidden])), :has(~ #pl-search-results .fy-playlist-search), :has(~ #fy-search-results:not([hidden])))';
  assert.ok(CSS.includes(same), "fixture: and those are the heading's own conditions, word for word");
  const single = "body.view-find #sh-empty-offer:has(.find-none__key):not(:has(~ #ep-search-results:not([hidden]))):not(:has(~ #fy-search-results:not([hidden]))):not(:has(~ #pl-search-results .fy-playlist-search)) ~ #pl-search-results .sh-create-cta { display: none; }";
  assert.ok(NONE_CSS.includes(single), "and while this key stands, the playlist group's own closing key is not drawn beside it (it stays under playlist cards)");
});

test("the no-results block reads tokens only and adds no hex, motion or !important", () => {
  /* MUTATION: hard-code a hex in `.tile.is-hit`, add `transition: background .2s` to
     it, or an !important anywhere in the block. */
  assert.ok(NONE_START > 0 && NONE_END > NONE_START, "the block is delimited");
  const rules = NONE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepStrictEqual(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "no hex literal: every colour is a token");
  assert.ok(!/\btransition\b|\banimation\b|@keyframes/.test(rules), "no motion of its own");
  assert.ok(!/!important/.test(rules), "specificity, not !important");
});

/* ---------------------------------------------------------------- 7 the copy */

test("the screen's copy passes the banned-phrase lists, says 'subject' never 'topic', and has no we/us/our", () => {
  /* MUTATION: write "topic" in the sentence ("Fusion & energy systems is a topic with
     5 shows"), "explores" in the heading, or "we found no shows" in the heading. WHAT
     IT CANNOT PROVE: the offline sentence ("no shows found") is the existing copy and
     is read here too, so it is held to the same lists. */
  const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const lines = [];
  for (const q of ["fusion", "zzqxjv", "science"]) {
    const m = mount();
    const { note, offer } = paintNone(m, q);
    lines.push(note.textContent, strip(offer.innerHTML));
  }
  const off = mount({ onLine: false });
  lines.push(paintNone(off, "fusion").note.textContent);
  for (const text of lines) {
    for (const re of [...copy.BANNED, ...copy.INTERNAL_VOCABULARY, ...copy.COMMUTE_FRAMING]) assert.ok(!re.test(text), `${re} in: ${text}`);
    assert.ok(!/\btopics?\b/i.test(text), `"subject", not "topic": ${text}`);
    assert.ok(!/\b(we|us|our|we're|we've)\b/i.test(text), `no we/us/our: ${text}`);
  }
  assert.ok(lines.some((t) => /^No shows match ‘fusion’\.$/.test(t)), "fixture: the heading was read");
  assert.ok(lines.some((t) => /Fusion & energy systems has 5 shows\./.test(t)), "and the sentence");
});

/* -------------------------------------------------------------- 8 the harness */

test("the harness has a settled no-results step appended after the five it already had, and the screen map points at it with the heading, sentence, tile and key as regions", () => {
  /* MUTATION: delete the appended step, point screens.json back at
     `search-no-results` (the focused step, deck hidden: the field and tab bar regions
     move 76px), or reorder the step ahead of the existing five. The query is one that
     finds no show in the committed index and names a subject that holds shows. */
  const states = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8").replace(/\r\n/g, "\n");
  const block = states.slice(states.indexOf('id: "search",'), states.indexOf('id: "stress",'));
  const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(labels.slice(0, 5), ["search-idle", "search-results-fusion", "search-results-history", "search-no-results", "search-results-typing"], "the existing five keep their order");
  assert.strictEqual(labels[5], "search-no-results-subject", "the new one is appended");
  const q = /label: "search-no-results-subject"[^\n]*typeSearchThenReturn\(page, "([^"]+)"\)/.exec(block);
  assert.ok(q, "it types a query and presses return, so the field lets go and the deck is back");
  const tsv = fs.readFileSync(path.join(ROOT, "data", "show-index.tsv"), "utf8").toLowerCase();
  assert.strictEqual(tsv.split(q[1]).length - 1, 0, `fixture: "${q[1]}" is in no show title the lab's index holds, so no show answers`);
  const taxonomy = readJson("data/taxonomy.json").nodes;
  const catalog = readJson("data/catalog-client.json").shows;
  const holds = taxonomy.filter((n) => n.label.toLowerCase().includes(q[1]) && catalog.some((s) => (s.taxonomy_node_ids || []).includes(n.id)));
  assert.ok(holds.length >= 1, `and "${q[1]}" names a subject in the committed taxonomy that holds shows (${holds.map((n) => n.label).join(", ")})`);
  const map = readJson("docs/redesign-2026/directions/tactile/screens.json").screens["search-none"];
  assert.deepStrictEqual(map.app, { state: "search", step: "search-no-results-subject" });
  assert.strictEqual(map.regions.heading.app, "#sh-note");
  assert.strictEqual(map.regions.heading.prototype, "#results .heading");
  assert.strictEqual(map.regions.sentence.app, ".find-none__line");
  assert.strictEqual(map.regions.rows.app, "#sh-empty-offer .tile");
  assert.strictEqual(map.regions.primary.app, ".find-none__key .keycap");
  assert.strictEqual(map.regions.primary.prototype, "#results .keycap--ultramarine");
});
