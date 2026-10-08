/* Tactile `search` (Find, idle): the subject mosaic, the followed strip, the
 * field and the head. Redesign 2026, docs/redesign-2026/directions/tactile/
 * BUILD-PLAN.md 2.9, BUILD-NOTES 4.4.
 *
 * WHAT THIS PROVES
 *   1. The mosaic is DRAWN, not sorted: at least 30% of the tiles sit outside
 *      the listener's own subjects on every one of 200 seeds (the exploration
 *      floor, CLAUDE.md principle 1), and the draw is still reproducible.
 *   2. Fixed count and shape: 14 tiles, one 2x2 `l`, three 2x1 `m`, ten 1x1 `s`,
 *      in the layout order; no two neighbours (the one beside it, and the one
 *      above it in the two-column grid) share a branch.
 *   3. "Own" is observed: a strong interest weight or a tag on a followed show.
 *   4. A tile is a link to the search for its own name, its name and count are
 *      escaped, and its artwork reaches the page only through safeUrl().
 *   5. "More subjects" swaps the set in place (same count, none of the same
 *      subjects while enough others exist) and a repaint keeps the set.
 *   6. The followed strip renders only when the listener follows something,
 *      carries the display name ("Lingthusiasm", not its subtitle) and links to
 *      the show.
 *   7. Against the committed catalogue and taxonomy the page really draws 14
 *      tiles, no A-Z list, no "Name a subject" key.
 *   8. The geometry the screen is judged on, read from the sheet: the pill's
 *      height and its dock arithmetic, the 44px clear key, the mosaic's grid.
 *
 * WHAT IT CANNOT PROVE: how any of it looks. tools/ui-lab/fidelity.mjs measures
 * that against the prototype in a real browser; this suite runs in node:vm.
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken
 * it"). The pure draw is driven with the real findMosaicTiles on a synthetic
 * pool whose OWN set is 70% of it, which is the case the floor exists for: with
 * a pool that is mostly new ground the floor would hold under any ordering and
 * the test could not fail. The render tests run the real renderAllShows over a
 * DOM stub with recorded listeners, so "More subjects" is clicked through the
 * handler the page binds. Each test names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
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
  "sh-form", "sh-input", "sh-note", "sh-results", "sh-browse", "sh-dismiss",
  "ep-search-results", "pl-search-results", "find-more", "find-mosaic",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
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
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") && !s.includes(" ") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
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
  return { ctx, evalIn, store, state: evalIn("state"), byId, view: () => byId.get("view").innerHTML };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

/* A synthetic catalogue: 10 roots x 4 leaves, four shows with artwork on each
   leaf. 40 subjects, 10 branches, so a branch cap of two and the neighbour
   rule are both satisfiable, and "own" can be most of the pool. */
function syntheticData() {
  const nodes = [];
  const shows = [];
  for (let r = 0; r < 10; r++) {
    nodes.push({ id: `root${r}`, parent: null, label: `Root ${r}`, weight: 0.5 });
    for (let l = 0; l < 4; l++) {
      const id = `root${r}/leaf${l}`;
      nodes.push({ id, parent: `root${r}`, label: `Subject ${r}-${l}`, weight: 0.5 });
      for (let s = 0; s < 4; s++) {
        shows.push({ show_id: `show-${r}-${l}-${s}`, title: `Show ${r}-${l}-${s}`, artwork_url: `https://is1-ssl.mzstatic.com/image/thumb/p/${r}${l}${s}/600x600bb.jpg`, taxonomy_node_ids: [id] });
      }
    }
  }
  return { taxonomy: { nodes }, catalog: { shows } };
}

function mountSynthetic({ ownShare = 0.7, seed = {} } = {}) {
  const m = mount({ seed });
  const d = syntheticData();
  m.state.taxonomy = d.taxonomy;
  m.state.catalog = d.catalog;
  /* The first `ownShare` of the leaves are strongly liked; the rest sit at the default. */
  const leaves = d.taxonomy.nodes.filter((n) => n.parent);
  m.state.interests = {};
  leaves.forEach((n, i) => { m.state.interests[n.id] = i < leaves.length * ownShare ? 0.9 : 0.5; });
  return m;
}

const tilesIn = (html) => [...html.matchAll(/<a class="tile tile--([lms])" href="([^"]*)" data-subject="([^"]*)">/g)].map((x) => ({ size: x[1], href: x[2], id: x[3] }));

/* ------------------------------------------------------------------ 1 floor */

test("the mosaic is drawn under the exploration floor: at least 30% of the tiles are outside the listener's own subjects, on 200 seeds", () => {
  /* MUTATION: sort by affinity. In findMosaicTiles replace the two shuffled
     draws with `const picks = candidates.slice().sort((a, b) => b.weight - a.weight).slice(0, want).map((p) => ({ ...p, outside: !own.has(p.id) }));`
     (and skip the `outsidePicks` lines). Every seed then returns the 14 most
     liked subjects, all own, and the first assertion fails. RUN: failed as named. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const own = m.ctx.findOwnSubjectIds();
  assert.strictEqual(pool.length, 40, "fixture: every leaf is a subject");
  assert.ok(own.size >= 28, "fixture: the listener's own subjects are most of the pool, the case the floor is for");
  for (let seed = 1; seed <= 200; seed++) {
    const tiles = m.ctx.findMosaicTiles(pool, { own, seed });
    const outside = tiles.filter((t) => !own.has(t.id)).length;
    assert.strictEqual(tiles.length, 14);
    assert.ok(outside / tiles.length >= 0.3, `seed ${seed}: only ${outside} of ${tiles.length} tiles are new ground`);
    assert.deepStrictEqual(tiles.map((t) => t.outside), tiles.map((t) => !own.has(t.id)), "the flag the page reads agrees with the set");
  }
});

test("the draw is a shuffle, not a fixed list: different seeds draw different sets, one seed always the same", () => {
  /* MUTATION: ignore the seed (`seededShuffle(list, 1)`). Every seed gives the
     same tiles and the first assertion fails. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const own = m.ctx.findOwnSubjectIds();
  const key = (seed) => m.ctx.findMosaicTiles(pool, { own, seed }).map((t) => t.id).join("|");
  const keys = new Set();
  for (let seed = 1; seed <= 20; seed++) keys.add(key(seed));
  assert.ok(keys.size >= 15, `20 seeds gave only ${keys.size} distinct mosaics`);
  assert.strictEqual(key(7), key(7), "the same seed reproduces the same mosaic");
});

test("a pool with no new ground still fills the mosaic from what it has, and a pool of all new ground is all outside", () => {
  /* The floor is a MINIMUM of new ground, never a quota that starves the page.
     MUTATION: drop the `extra`/`insidePicks` backfill. The short-pool half
     returns fewer than 14 tiles and goes red. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const all = new Set(pool.map((p) => p.id));
  const allOwn = m.ctx.findMosaicTiles(pool, { own: all, seed: 3 });
  assert.strictEqual(allOwn.length, 14, "everything is own: the page still draws a full mosaic");
  const none = m.ctx.findMosaicTiles(pool, { own: new Set(), seed: 3 });
  assert.ok(none.every((t) => t.outside), "nothing is own: every tile is new ground");
  const few = m.ctx.findMosaicTiles(pool.slice(0, 9), { own: new Set(), seed: 3 });
  assert.strictEqual(few.length, 9, "a small catalogue draws what it has");
});

/* ----------------------------------------------------------- 2 shape/layout */

test("fixed count and shape: 14 tiles, one l, three m, ten s, in the layout order, on every seed", () => {
  /* MUTATION: change one entry of FIND_LAYOUT from "s" to "m". The size census
     and the layout-order assertion both fail. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const own = m.ctx.findOwnSubjectIds();
  const layout = m.evalIn("FIND_LAYOUT");
  assert.strictEqual(layout.length, 14);
  assert.deepStrictEqual(
    ["l", "m", "s"].map((k) => layout.filter((x) => x === k).length),
    [1, 3, 10], "one 2x2, three 2x1, ten 1x1: the ten singles pair off, so no tile is half a row"
  );
  for (let seed = 1; seed <= 100; seed++) {
    const tiles = m.ctx.findMosaicTiles(pool, { own, seed });
    assert.deepStrictEqual([...tiles.map((t) => t.size)], [...layout], `seed ${seed}: sizes follow the layout`);
    for (const t of tiles) assert.ok(t.arts.length >= (t.size === "l" ? 4 : 3), `${t.id}: enough covers for a ${t.size} tile`);
    assert.strictEqual(new Set(tiles.map((t) => t.id)).size, 14, "no subject twice");
  }
});

test("no two neighbours share a branch: the one beside it and the one above it in the two-column grid", () => {
  /* MUTATION: place the tiles in draw order (replace the arrangement loop with
     `const placed = picks.map((p, i) => ({ ...p, size: slots[i] }))`). Across
     200 seeds some adjacent pair shares a branch and this goes red. RUN: red. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const own = m.ctx.findOwnSubjectIds();
  for (let seed = 1; seed <= 200; seed++) {
    const tiles = m.ctx.findMosaicTiles(pool, { own, seed });
    for (let i = 1; i < tiles.length; i++) {
      assert.notStrictEqual(tiles[i].branch, tiles[i - 1].branch, `seed ${seed}: tiles ${i - 1} and ${i} share ${tiles[i].branch}`);
      if (i > 1) assert.notStrictEqual(tiles[i].branch, tiles[i - 2].branch, `seed ${seed}: tiles ${i - 2} and ${i} share ${tiles[i].branch}`);
    }
  }
});

test("size follows weight: the heaviest subject with four covers is the l tile", () => {
  /* MUTATION: take the LIGHTEST instead (`b.p.weight - a.p.weight` ->
     `a.p.weight - b.p.weight` in the byWeight sort). The l tile is then the
     least liked of the draw and this goes red. */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const own = m.ctx.findOwnSubjectIds();
  for (let seed = 1; seed <= 50; seed++) {
    const tiles = m.ctx.findMosaicTiles(pool, { own, seed });
    const big = tiles.find((t) => t.size === "l");
    assert.strictEqual(big.weight, Math.max(...tiles.map((t) => t.weight)), `seed ${seed}: l is the heaviest`);
  }
});

/* ---------------------------------------------------------------- 3 own set */

test("'own' is observed: a strong interest weight, or a tag on a show the listener follows, and nothing else", () => {
  /* MUTATION: drop the followed-shows loop in findOwnSubjectIds. The followed
     leaf is no longer own and the second assertion fails. */
  const followed = { "show-3-2-0": { show_id: "show-3-2-0", title: "Show 3-2-0", starred_at: "2026-10-01T00:00:00Z" } };
  const m = mountSynthetic({ ownShare: 0, seed: { cp_starred_shows: JSON.stringify(followed) } });
  m.state.interests = { "root1/leaf0": 0.9, "root1/leaf1": 0.64, "root1/leaf2": 0.2 };
  const own = m.ctx.findOwnSubjectIds();
  assert.ok(own.has("root1/leaf0"), "a strong interest is own");
  assert.ok(!own.has("root1/leaf1"), "0.64 is below the line (FIND_OWN_INTEREST is 0.65)");
  assert.ok(own.has("root3/leaf2"), "the leaf a followed show is tagged with is own");
  assert.ok(!own.has("root1/leaf2"), "a weak interest is not");
});

/* ------------------------------------------------------------------ 4 tiles */

test("a tile links to the search for its own name; name and count are escaped; artwork goes through safeUrl", () => {
  /* MUTATION: drop esc() from the name in findTileHtml (the `<b>` renders raw)
     or the encodeURIComponent from the href. Either fails below. */
  const m = mount();
  const tile = {
    id: "x/y", label: "<b>Fish & chips</b>", branch: "x", count: 1, weight: 0.5, size: "s",
    arts: [{ url: "javascript:alert(1)", id: "a", name: "A" }, { url: "https://is1-ssl.mzstatic.com/image/thumb/p/1/600x600bb.jpg", id: "b", name: "B" }, { url: null, id: "c", name: "C" }],
  };
  const html = m.ctx.findTileHtml(tile);
  assert.ok(!html.includes("<b>"), `the label is escaped: ${html}`);
  assert.ok(html.includes("&lt;b&gt;Fish &amp; chips&lt;/b&gt;"));
  assert.ok(html.includes('href="#/shows/q/%3Cb%3EFish%20%26%20chips%3C%2Fb%3E"'), `the href is the encoded search: ${html}`);
  assert.ok(html.includes(">1 show<"), "one show is singular, as one mono readout");
  assert.ok(!/javascript:/i.test(html), "a hostile artwork URL never reaches the page");
  assert.ok(html.includes('src="https://is1-ssl.mzstatic.com/image/thumb/p/1/264x264bb.jpg"'), "good artwork is requested at 3x its drawn size");
  assert.ok(html.includes('data-i="C"></span>'), "a show with no artwork keeps its enamel and initial");
});

test("a tile counts shows as one readout ('14 shows') and an l tile draws a 2x2 collage of four covers", () => {
  /* MUTATION: draw three covers for `l` (`t.arts.slice(0, 4)` -> `slice(0, 3)`). */
  const m = mountSynthetic();
  const pool = m.ctx.findSubjectPool();
  const tiles = m.ctx.findMosaicTiles(pool, { own: new Set(), seed: 5 });
  const l = tiles.find((t) => t.size === "l");
  const lHtml = m.ctx.findTileHtml(l);
  assert.strictEqual((lHtml.match(/find-art--cell/g) || []).length, 4, "four cells");
  assert.ok(lHtml.includes('class="find-collage"'));
  assert.ok(/<span class="readout">4 shows<\/span>/.test(lHtml), "count is one readout");
  const s = m.ctx.findTileHtml(tiles.find((t) => t.size === "s"));
  assert.strictEqual((s.match(/find-art--disc/g) || []).length, 3, "three overlapping discs on s and m");
});

/* ----------------------------------------------------------- 5 More subjects */

test("'More subjects' swaps the set in place: same count, none of the same subjects, and a repaint keeps whatever is showing", () => {
  /* MUTATION: drop `exclude` from findCurrentTiles (advance draws without
     leaving the shown set out), or drop the `findMosaicDrawn` early return so a
     repaint redraws. The overlap assertion and the stability assertion fail. */
  const again = mountSynthetic();
  again.ctx.renderAllShows();
  const before = tilesIn(again.view()).map((t) => t.id);
  again.ctx.renderAllShows();
  assert.deepStrictEqual(tilesIn(again.view()).map((t) => t.id), before, "a repaint of the page keeps the set");
  again.byId.get("find-more").dispatch("click");
  const swapped = tilesIn(again.byId.get("find-mosaic").innerHTML).map((t) => t.id);
  again.ctx.renderAllShows();
  assert.deepStrictEqual(tilesIn(again.view()).map((t) => t.id), swapped, "and after 'More subjects' a repaint keeps the NEW set, not a redraw");

  const m = mountSynthetic();
  m.ctx.renderAllShows();
  const first = tilesIn(m.view());
  assert.strictEqual(first.length, 14, "the first set");
  assert.ok(m.view().includes('id="find-more"'), "there are more subjects than tiles, so the key is there");

  assert.strictEqual(m.byId.get("find-more").dispatch("click"), 1, "the page binds exactly one handler to the key");
  const after = tilesIn(m.byId.get("find-mosaic").innerHTML);
  assert.strictEqual(after.length, 14, "the count stays fixed: a new draw, not a longer list");
  const overlap = after.filter((t) => first.some((f) => f.id === t.id));
  assert.deepStrictEqual(overlap, [], "none of the subjects that were on screen");
});

test("there is no 'More subjects' key when the whole pool is already on screen", () => {
  /* MUTATION: render the key unconditionally (drop the `poolSize > tiles.length`
     gate). The key shows over a pool of 12 and this goes red. */
  const m = mount();
  const nodes = [];
  const shows = [];
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `r${i}`, parent: null, label: `Subject ${i}`, weight: 0.5 });
    for (let s = 0; s < 3; s++) shows.push({ show_id: `s${i}-${s}`, title: "T", artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/p/1/600x600bb.jpg", taxonomy_node_ids: [`r${i}`] });
  }
  m.state.taxonomy = { nodes };
  m.state.catalog = { shows };
  m.ctx.renderAllShows();
  assert.strictEqual(tilesIn(m.view()).length, 12, "a small catalogue draws what it has");
  assert.ok(!m.view().includes('id="find-more"'), "and offers no more of it");
});

/* ------------------------------------------------------- 6 followed strip */

test("the followed strip renders only when the listener follows something, and reads the display name", () => {
  /* MUTATION: drop the `if (!entries.length) return ""` guard (the strip then
     renders for the empty seed), or show the raw title (drop tactileDisplayName). */
  const none = mountSynthetic();
  none.ctx.renderAllShows();
  assert.ok(!none.view().includes("Followed shows"), "absent in the empty seed");
  assert.ok(!none.view().includes("find-strip"));

  const follows = {
    "ling": { show_id: "ling", title: "Lingthusiasm - A podcast that's enthusiastic about linguistics", artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/p/1/600x600bb.jpg", starred_at: "2026-10-03T00:00:00Z" },
    "odd": { show_id: "odd", title: "Odd Lots", artwork_url: null, starred_at: "2026-10-04T00:00:00Z" },
  };
  const m = mountSynthetic({ seed: { cp_starred_shows: JSON.stringify(follows) } });
  m.ctx.renderAllShows();
  const html = m.view();
  assert.ok(html.includes('id="find-followed-h">Followed shows<'), "the heading");
  assert.ok(html.includes('>Lingthusiasm<'), "the subtitle clause is dropped, so the name is not clipped at the gutter");
  assert.ok(!html.includes("A podcast that"), "…and never appears on the strip");
  assert.ok(html.indexOf(">Odd Lots<") < html.indexOf(">Lingthusiasm<"), "newest first");
  assert.ok(html.includes('class="find-strip__item" href="#/show/odd"'), "an item links to its show page");
  assert.ok(html.includes('href="#/starred-shows"'), "and the heading row carries 'See all'");
  assert.ok(html.indexOf("find-followed-h") < html.indexOf("find-subjects-h"), "the strip sits above the subjects");
});

/* ------------------------------------------------------------ 7 real data */

test("against the committed catalogue the page draws 14 subject tiles, no A-Z list, and the readout line instead of a 'Name a subject' key", async () => {
  /* MUTATION: put the old `shows` list back (drop `find ? "" :` in
     renderShowIndexPage) -> `show-index` appears. Put the "Name a subject" key
     back -> its assertion fails. */
  const m = await mountBooted();
  m.ctx.renderAllShows();
  const html = m.view();
  const tiles = tilesIn(html);
  assert.strictEqual(tiles.length, 14, "the committed catalogue has plenty of tagged subjects");
  assert.deepStrictEqual(["l", "m", "s"].map((k) => tiles.filter((t) => t.size === k).length), [1, 3, 10]);
  assert.strictEqual(new Set(tiles.map((t) => t.href)).size, 14, "no two tiles run the same search");
  assert.ok(!html.includes("show-index"), "no A-Z list under the mosaic");
  assert.ok(html.includes('<h2 class="display-xl">Find</h2>'), "the title is the display-xl 'Find'");
  assert.ok(html.includes('<p class="label find-hint">Type any subject and 4a builds a playlist</p>'), "the readout line, in the date's slot");
  assert.ok(!/Name a subject</.test(html), "no separate 'Name a subject' key: the field already says it");
  assert.ok(html.includes('placeholder="Search, or name a subject"'), "the field's placeholder");
  assert.ok(html.includes('id="find-more"'), "the 'More subjects' key ends the page");

  const drawn = m.ctx.findCurrentTiles().tiles;
  const own = m.ctx.findOwnSubjectIds();
  assert.ok(drawn.filter((t) => !own.has(t.id)).length / drawn.length >= 0.3, "and the real draw is under the floor too");
  const labels = drawn.map((t) => t.label.toLowerCase());
  assert.strictEqual(new Set(labels).size, labels.length, "tile names are unique (History is a root and a leaf; only one gets a tile)");
});

test("the Find copy obeys the listener copy rules: 'subject', never 'topic', no we/us/our, nothing banned", () => {
  /* MUTATION: change the readout to "Type any topic and we build a playlist". */
  const m = mountSynthetic();
  m.ctx.renderAllShows();
  const text = m.view().replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.ok(!/\b(topic|topics)\b/i.test(text), "subject, not topic");
  assert.ok(!/\b(we|us|our|we're)\b/i.test(text), "no we/us/our");
  for (const banned of ["fascinating", "deep dive", "delve", "explores"]) assert.ok(!text.toLowerCase().includes(banned), banned);
  const hint = /Type any subject and 4a builds a playlist/.exec(text)[0];
  assert.ok(hint.split(/\s+/).length <= 16, "a hook is at most 16 words");
});

/* ------------------------------------------------------------ 8 geometry */

function rule(selector) {
  const hit = parseRules(CSS).filter((r) => r.selectors.includes(selector) && !r.atRules.length);
  assert.ok(hit.length, `no rule for ${selector}`);
  const decls = {};
  for (const r of hit) for (const d of r.decls) decls[d.prop] = d.value;
  return decls;
}

test("the field is a 52px card-filled pill docked 12px above the 64px deck, and the clear key is a 44px target", () => {
  /* MUTATION: change `--s-3` to `--s-2` in the `--find-dock` arithmetic (the
     pill then floats 8px above the deck, not 12), or the pill's height from
     `calc(var(--s-12) + var(--s-1))` to `var(--s-12)` (48, not 52), or the
     clear key's width from `var(--tap)` to 40px. Each fails below. */
  const pill = rule("body.view-find #sh-compose");
  assert.strictEqual(pill.height, "calc(var(--s-12) + var(--s-1))", "48 + 4 = 52");
  assert.strictEqual(pill["border-radius"], "var(--r-pill)");
  assert.strictEqual(pill.background, "var(--card)");
  assert.strictEqual(pill["box-shadow"], "var(--shadow-deck)");
  assert.strictEqual(pill.padding, "0 var(--s-2) 0 var(--s-4)", "16 leading, 8 trailing around the 44px key");
  assert.strictEqual(pill["--find-dock"], "calc(var(--safe-b) + var(--s-3) + var(--deck-h) + var(--s-3))", "safe + 12 + deck + 12");
  assert.strictEqual(pill.bottom, "calc(var(--kb-inset, 0px) + var(--find-dock))", "the keyboard lifts it by its own inset");
  assert.strictEqual(rule("body.view-find.kb-open #sh-compose")["--find-dock"], "var(--s-3)", "with the keyboard up the deck is gone and the field docks to it");
  assert.strictEqual(rule("body.view-find.sh-searching #sh-compose")["--find-dock"], "var(--s-3)", "…and with the field focused, which is when the bar hides");
  const clear = rule("body.view-find #sh-dismiss");
  assert.strictEqual(clear.width, "var(--tap)");
  assert.strictEqual(clear.height, "var(--tap)");
  const tokens = rule(":root");
  assert.strictEqual(tokens["--tap"], "44px");
  assert.strictEqual(tokens["--deck-h"], "64px");
  assert.strictEqual(tokens["--s-3"], "12px");
});

test("the mosaic is two columns with a 12px gap; strip items are 72px wide with 64px art; every colour reads a token", () => {
  /* MUTATION: set `.mosaic`'s gap to 8px, the strip item to 64px, or hard-code
     a hex in the Find section. Each fails below. */
  const mosaic = rule(".mosaic");
  assert.strictEqual(mosaic["grid-template-columns"], "1fr 1fr");
  assert.strictEqual(mosaic.gap, "var(--gap)");
  assert.strictEqual(rule(":root")["--gap"], "12px");
  assert.strictEqual(rule(".find-strip__item").width, "72px");
  assert.strictEqual(rule(".find-strip__art").width, "64px");
  assert.strictEqual(rule(".find-collage").width, "178px", "2x2 of 88 with a 2px seam");
  assert.strictEqual(rule(".find-art--cell").width, "88px");
  const start = CSS.indexOf("FIND (TACTILE): the subject mosaic page");
  const end = CSS.indexOf("COMPONENT GALLERY. Development-only");
  assert.ok(start > 0 && end > start, "the Find section is delimited");
  const section = CSS.slice(start, end);
  assert.deepStrictEqual(section.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "no hex literal in the Find section: every colour is a token");
  assert.ok(!/\bstyle=/.test(APP_SRC.slice(APP_SRC.indexOf("function findSubjectPool"), APP_SRC.indexOf("function bindFindMore"))), "no inline style in the Find markup");
});

test("the Find section adds no transition or animation the one reduced-motion block does not already cover", () => {
  /* MUTATION: add `transition: transform .2s` to `.mosaic .tile`. */
  const start = CSS.indexOf("FIND (TACTILE): the subject mosaic page");
  const end = CSS.indexOf("COMPONENT GALLERY. Development-only");
  const section = CSS.slice(start, end);
  assert.ok(!/\btransition\s*:|\banimation\s*:/.test(section.replace(/transition:\s*none/g, "")), "Find's own rules animate nothing; its tiles and keys reuse the primitives' transitions, which the block names");
});
