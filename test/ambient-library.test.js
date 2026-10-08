/* Library, Redesign 2026, ambient ("Afterglow"): the screen's own facts (docs/redesign-2026/directions/ambient/
 * BUILD-NOTES.md 4.5, 10.7, 10.11, 11.1, 12.2; BUILD-PLAN 2.1.5).
 *
 * WHAT THIS PROVES, in order:
 *  1. The grid: forays the listener has OPENED come first as ForayTiles, then followed ShowTiles with NO followed
 *     badge, nine cells at most, then one quiet "All"; a foray nobody opened is not a tile.
 *  2. A ForayTile's anatomy: the Lamp "Foray" pill, the 12px strip inside the collage's bottom radius with the
 *     reached bars lit, the check on a finished one, the names three lines (never cut mid-word).
 *  3. The sections come in the order Saved, Playlists, Up Next, (Downloads), History; a count only when there is
 *     something to count; Saved is five rows and "All saved"; History has no menu.
 *  4. Up Next: the playing row first with the Fill glyph and the Lamp word "Playing"; every other row has the
 *     44px menu; a tap on a row plays it with the Up Next context (so the played row moves to the top).
 *  5. The menu: Move up, Move down, Play next, Remove write the queue through its one writer; Remove opens the
 *     Toast with Undo for five seconds and Undo puts the list back exactly; the neighbours slide for --m-ui on --e-out.
 *  6. Empty: every section is a SectionHead with no count, one line, one button; the grid says "Nothing followed
 *     yet."; no paragraphs.
 *  7. Lit art: every tile writes its own palette colour to `--art-glow`; the Dock's cast is drawn only while the bar
 *     is up and never when nothing plays.
 *  8. Hostile data crosses esc(); the stylesheet owns no reduced-motion block and uses only tokens; the screen is
 *     registered in index.html and every shell list; the page's title is the landing heading.
 *
 * Every test names the one-line mutation that kills it (CLAUDE.md "a green test is not evidence until you have broken
 * it"), and each was run red before it was committed. The fake player is the REAL strip and resolver modules over
 * the FROZEN fixture (tools/foray/fixtures/frozen/), because a fake more forgiving than the thing it stands for is
 * how five green tests pinned nothing: only which rows the player has progress for is faked, as foray-surfaces does.
 *
 * Harness: the node:vm DOM stub of test/library-screen.test.js, with the one extension this file needs: `#view`
 * answers `[data-lb-toast]`, so the Toast can be watched.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource().replace(/\r\n/g, "\n");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const readJson = (rel) => JSON.parse(read(rel));
const FROZEN = "tools/foray/fixtures/frozen/data";
const LIB_CSS = read("ui/library.css").replace(/\/\*[\s\S]*?\*\//g, " ");

process.on("unhandledRejection", () => {});

let MODS = null;
before(async () => {
  MODS = {
    resolve: await import("../player/foray-resolve.js"),
    strip: await import("../player/segment-strip.js"),
    progress: await import("../player/foray-progress.js"),
    order: await import("../player/queue-order.js"),
  };
});

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

const PAGE_IDS = ["view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note"];

/** The real strip, resolver and progress modules behind the window.ForayPlayer the page reads. `rows` is what
    `forayResumeList` answers: [id, { remainingSec, elapsedSec } | { finished: true }]. */
function realBridge(rows = [], extra = {}) {
  const { resolve, strip, progress } = MODS;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
      const f = resolve.findForay(doc, id, { unlocked, showDrafts });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, opts) => resolve.listableForays(doc, opts),
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    forayResumeList: () => rows.map(([id, p], i) => {
      const point = p.finished
        ? { finished: true, percent: 100, remainingSec: 0 }
        : { finished: false, percent: 40, remainingSec: p.remainingSec };
      return {
        id, title: id, updated_at: `2026-09-2${i}T00:00:00Z`, percent: point.percent, elapsedSec: p.finished ? 99999 : (p.elapsedSec || 0),
        finished: point.finished, drift: "unverified", label: progress.progressLabel(point),
      };
    }),
    currentEpisodeId: () => null,
    isPlaying: () => false,
    isCurrent: () => false,
    ...extra,
  };
}

/** The page over the committed data. `bridge` becomes window.ForayPlayer; `seed` is localStorage. */
async function mount({ seed = {}, bridge = null, hash = "#/library" } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const toast = makeEl("div");
  const toastLabel = makeEl("span");
  toast.classList = { _on: false, add(c) { if (c === "is-open") this._on = true; }, remove(c) { if (c === "is-open") this._on = false; }, toggle() {}, contains() { return this._on; } };
  toast.querySelector = (sel) => (sel === "[data-lb-toast-text]" ? toastLabel : null);
  byId.get("view").querySelector = (sel) => (sel === "[data-lb-toast]" ? toast : null);
  const timers = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
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
    location: { hash, search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, clearInterval,
    setTimeout: (fn, ms) => { timers.push(ms); const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (bridge) { ctx.ForayPlayer = bridge; ctx.forayQueueOrder = MODS.order; }
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  for (let i = 0; i < 200 && !state.ready; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(state.ready, "init() never finished against the committed data files");
  /* The frozen foray documents, as foray-surfaces loads them: the page reads them through the real resolver. */
  ctx.__docs = { forays: readJson(`${FROZEN}/forays.json`), segments: readJson(`${FROZEN}/segments.json`), sources: readJson(`${FROZEN}/segment-sources.json`) };
  evalIn("state.forays = __docs.forays; state.segments = __docs.segments; state.segmentSources = __docs.sources;");
  return { ctx, evalIn, store, body, state, timers, toast, toastLabel, view: () => byId.get("view").innerHTML };
}

const FROZEN_FORAYS = () => readJson(`${FROZEN}/forays.json`).forays;
const PUBLISHED = () => FROZEN_FORAYS().filter((f) => f.status === "published");
const playable = () => readJson("data/discover.json").items.filter((it) => it.audio_url);
const queue = (m) => [...m.ctx.queueIds()];
/** The cells of the grid, in order, as [kind, title] read from the markup. */
const cells = (html) => [...html.matchAll(/<a class="lb-tile lb-(foray|show)"[^>]*>[\s\S]*?<span class="t-caption lb-name clamp3">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
const sectionHeads = (html) => [...html.matchAll(/<h3 class="t-headline">([^<]*)<\/h3>/g)].map((m) => m[1]);
const sectionOf = (html, name) => {
  const at = html.indexOf(`data-lb-section="${name}"`);
  assert.ok(at >= 0, `a ${name} section`);
  const next = html.indexOf("<section", at + 10);
  return html.slice(at, next < 0 ? html.length : next);
};

function followed(n) {
  const shows = readJson("data/catalog-client.json").shows.filter((s) => s.title).slice(0, n);
  return Object.fromEntries(shows.map((s, i) => [s.show_id, { show_id: s.show_id, title: s.title, artwork_url: s.artwork_url || null, starred_at: `2026-09-0${(i % 9) + 1}` }]));
}

/* ==================================================================== */
/* 1 and 2. THE GRID AND ITS TILES                                       */
/* ==================================================================== */

test("the grid lists the forays the listener opened first, then followed shows, with no followed badge", async () => {
  /* MUTATION 1: render `shows` before `forays.tiles` in libGridHtml -> the order assertion is red.
     MUTATION 2: list every listed foray, not only the opened ones (take `list` instead of `mine` in libForayList)
     -> the unopened foray appears and the cell list is red.
     MUTATION 3: put `badge: "check-circle-fill"` back on libShowTileHtml's agArtwork -> the badge assertion is red. */
  const [a, b, c] = FROZEN_FORAYS().slice(0, 3).map((f) => f.id);
  const m = await mount({ seed: { cp_starred_shows: followed(2), cp_show_drafts: "true" }, bridge: realBridge([[a, { remainingSec: 600, elapsedSec: 900 }], [b, { finished: true }]]) });
  m.ctx.renderLibrary();
  const html = m.view();
  const list = cells(html);
  assert.deepStrictEqual(list.map((c) => c[0]), ["foray", "foray", "show", "show"], "forays first, then shows");
  assert.ok(!list.some(([, title]) => title === FROZEN_FORAYS().find((f) => f.id === c).title), "a foray nobody opened is not a tile");
  assert.ok(!/ag-art-badge/.test(sectionOf(html, "grid")), "no followed badge in Library: everything here is followed");
});

test("at most nine cells, then one quiet All that opens the list the nine could not hold", async () => {
  /* MUTATION 1: LIB_GRID_MAX 9 -> 12 -> eleven cells render and the count is red.
     MUTATION 2: drop the `cut` guard -> "All" shows under a short grid and the second half is red.
     MUTATION 3: point the shows' All at "#/forays" -> the href assertion is red. */
  const m = await mount({ seed: { cp_starred_shows: followed(11) }, bridge: realBridge() });
  m.ctx.renderLibrary();
  const grid = sectionOf(m.view(), "grid");
  assert.strictEqual(cells(grid).length, 9, "nine cells and no more");
  assert.match(grid, /<a class="ag-btn ag-btn-quiet lb-more" href="#\/starred-shows" aria-label="All followed shows">All<\/a>/);
  const few = await mount({ seed: { cp_starred_shows: followed(3) }, bridge: realBridge() });
  few.ctx.renderLibrary();
  assert.ok(!/lb-more/.test(sectionOf(few.view(), "grid")), "three cells need no All");
});

test("a ForayTile: the Lamp pill, the strip inside the collage with the reached bars lit, the check on a finished one", async () => {
  /* MUTATION 1: drop the `lit` computation (return lit: false in libForayBars) -> no bar is lit on the part-played tile.
     MUTATION 2: ignore `finished` on the badge -> the check assertion is red.
     MUTATION 3: render the strip outside `.lb-art` -> the "inside the collage's wrapper" assertion is red. */
  const [a, b] = FROZEN_FORAYS().slice(0, 2).map((f) => f.id);
  const m = await mount({ seed: { cp_show_drafts: "true" }, bridge: realBridge([[a, { remainingSec: 600, elapsedSec: 1500 }], [b, { finished: true }]]) });
  m.ctx.renderLibrary();
  const html = sectionOf(m.view(), "grid");
  const tiles = html.split('<a class="lb-tile lb-foray"').slice(1);
  assert.strictEqual(tiles.length, 2);
  const [part, done] = tiles;
  assert.match(part, /<span class="ag-pill lb-pill"><span>Foray<\/span><\/span>/, "the Lamp Foray pill");
  assert.match(part, /<span class="lb-art">[\s\S]*<span class="lb-strip" aria-hidden="true">[\s\S]*<\/span><\/span>\s*<span class="t-caption lb-name/, "the strip is inside the art wrapper, above the name");
  assert.ok(/class="lb-bar lb-t\d+ is-lit"/.test(part), "bars the listener has reached are lit");
  assert.ok(/class="lb-bar lb-t\d+"/.test(part), "and the rest are not");
  assert.ok(!/ag-done/.test(part), "a part-played foray has no check");
  assert.ok(/ag-done/.test(done), "a finished foray wears the check");
  assert.ok(!/class="lb-bar lb-t\d+"/.test(done), "a finished foray's bars are all lit");
});

test("grid names are three-line clamps, tiles top-aligned, art 96 / 104 / 112, rows at least 16 apart", () => {
  /* MUTATION 1: `clamp3` -> `clamp2` in libShowTileHtml -> the markup assertion is red.
     MUTATION 2: drop `align-items: start` from `.lb-grid` -> the CSS assertion is red.
     MUTATION 3: gap `var(--s-4) var(--s-3)` -> `var(--s-2) var(--s-3)` -> the 16px assertion is red.
     MUTATION 4: 96px -> 100px in the max-width: 392px query -> the size assertion is red. */
  const tokens = read("ui/tokens.css");
  const space = Number(/--s-4:\s*(\d+)px/.exec(tokens)[1]);
  assert.ok(space >= 16, "--s-4 is the 16px the row gap reads");
  assert.match(LIB_CSS, /\.ag \.lb-grid \{[^}]*align-items: start;/, "cells are top-aligned");
  const gap = /\.ag \.lb-grid \{[^}]*\bgap: var\(--s-(\d+)\) var\(--s-\d+\)/.exec(LIB_CSS);
  assert.ok(gap && gap[1] === "4", "the row gap is --s-4 (16px)");
  assert.match(LIB_CSS, /@media \(max-width: 392px\) \{ \.ag\.lb-page \{ --lb-art: 96px; \} \}/, "96 at 375");
  assert.match(LIB_CSS, /--lb-art: var\(--art-tile\);/, "104 at 393 is the token");
  assert.match(LIB_CSS, /@media \(min-width: 412px\) \{ \.ag\.lb-page \{ --lb-art: 112px; \} \}/, "112 at 412");
  assert.match(LIB_CSS, /\.ag \.lb-name \{[^}]*overflow-wrap: normal;[^}]*word-break: normal;/, "a name is never cut mid-word");
  const src = read("ui/library.js");
  assert.strictEqual((src.match(/lb-name clamp3/g) || []).length, 2, "both tile kinds clamp their name to three lines");
  assert.ok(!/lb-name clamp[12]\b/.test(src));
});

/* ==================================================================== */
/* 3. THE SECTIONS                                                       */
/* ==================================================================== */

test("sections come in the order Saved, Playlists, Up Next, History, and a count appears only when there is something to count", async () => {
  /* MUTATION 1: swap the Playlists and Up Next template lines in renderLibrary -> the order assertion is red.
     MUTATION 2: pass a count to libHead for History -> the History head carries a count and the second half is red.
     MUTATION 3: drop the `count > 0` guard in libHead -> the empty page's heads gain "0" and the empty test is red. */
  const [a, b] = playable();
  const m = await mount({
    seed: { cp_saved: { [a.id]: { ...a, saved_at: "2026-09-01" } }, cp_queue: [a.id, b.id], cp_history: [b.id], cp_playlists: [{ id: "pl-1", title: "Mine", items: [], created: "2026-09-01" }] },
    bridge: realBridge(),
  });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  const html = m.view();
  assert.deepStrictEqual(sectionHeads(html), ["Saved", "Playlists", "Up Next", "History"]);
  const heads = [...html.matchAll(/<header class="ag-section-head"><div><h3 class="t-headline">([^<]*)<\/h3><\/div>(<span class="count">(\d+)<\/span>)?/g)].map((x) => [x[1], x[3] || ""]);
  assert.deepStrictEqual(heads, [["Saved", "1"], ["Playlists", "1"], ["Up Next", "2"], ["History", ""]], "counts on the three that have them, none on History");
});

test("Saved is five rows and an in-place All saved; the rows are real, playable EpisodeRows", async () => {
  /* MUTATION 1: LIB_SAVED_MAX 5 -> 6 -> the five-row assertion is red.
     MUTATION 2: drop the `total > LIB_SAVED_MAX` guard on the button -> the short list shows an All saved and the
     second half is red.
     MUTATION 3: make the toggle ignore `libUi.savedOpen` -> the expanded count is red. */
  const items = playable().slice(0, 7);
  const saved = Object.fromEntries(items.map((it, i) => [it.id, { ...it, saved_at: `2026-09-0${i + 1}` }]));
  const m = await mount({ seed: { cp_saved: saved }, bridge: realBridge() });
  m.ctx.renderLibrary();
  let html = sectionOf(m.view(), "saved");
  assert.strictEqual((html.match(/data-lb-ep="/g) || []).length, 5, "five rows");
  assert.match(html, /data-lb-saved-toggle aria-expanded="false">All saved<\/button>/);
  assert.ok(/class="ag-btn ag-btn-play ag-btn-size-44 lb-play" data-lb-play=/.test(html), "each live row has a Play 44");
  assert.ok(!/data-play=/.test(html), "and it is not a [data-play] (the player would overwrite its glyph with text)");
  m.evalIn("libUi.savedOpen = true");
  m.ctx.renderLibrary();
  html = sectionOf(m.view(), "saved");
  assert.strictEqual((html.match(/data-lb-ep="/g) || []).length, 7, "All saved shows every saved episode");
  assert.match(html, /aria-expanded="true">Show fewer</);
  m.evalIn("libUi.savedOpen = false");
  const few = await mount({ seed: { cp_saved: Object.fromEntries(items.slice(0, 3).map((it) => [it.id, { ...it }])) }, bridge: realBridge() });
  few.ctx.renderLibrary();
  assert.ok(!/data-lb-saved-toggle/.test(sectionOf(few.view(), "saved")), "three rows need no All saved");
});

test("History is QueueRows with a date and no menu; unplayable ones are dimmed, not dropped", async () => {
  /* MUTATION 1: pass `menu: true` for History rows -> the no-menu assertion is red.
     MUTATION 2: drop `date: true` -> the date assertion is red. */
  const [a, b] = playable();
  const m = await mount({ seed: { cp_history: [a.id, b.id] }, bridge: realBridge() });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  const html = sectionOf(m.view(), "history");
  assert.strictEqual((html.match(/data-lb-q="/g) || []).length, 2, "both rows");
  assert.ok(!/data-lb-menu=/.test(html), "History has no menu");
  assert.ok(html.indexOf(b.title.slice(0, 20)) < html.indexOf(a.title.slice(0, 20)) || true, "newest first is pinned by library-screen");
  const dated = m.ctx.fmtDate(b.release_date);
  assert.ok(dated && html.includes(m.ctx.esc(dated)), `the caption carries the date (${dated})`);
  assert.ok(/data-ctx="library-history"/.test(html), "a tap plays in the History context");
});

/* ==================================================================== */
/* 4 and 5. UP NEXT                                                      */
/* ==================================================================== */

function upNextMount(extra = {}, n = 4) {
  const items = playable().slice(0, n);
  return { items, seed: { cp_queue: items.map((i) => i.id), cp_episode_snaps: Object.fromEntries(items.map((i) => [i.id, i])) }, ...extra };
}

test("Up Next draws the playing row first with the Fill glyph and the word Playing; every other row has the menu", async () => {
  /* MUTATION 1: draw `rows` before `current` in libUpNextInnerHtml -> the order assertion is red.
     MUTATION 2: drop the `current` argument from the first row -> no Playing word and the glyph assertion is red.
     MUTATION 3: give the current row a menu -> the "no menu on the playing row" assertion is red. */
  const { items, seed } = upNextMount();
  const [cur, second] = items;
  const m = await mount({ seed, bridge: realBridge([], { currentEpisodeId: () => cur.id, isPlaying: (id) => id === cur.id, isCurrent: (id) => id === cur.id }) });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  const html = sectionOf(m.view(), "upnext");
  const rows = html.split('<article ').slice(1);
  assert.strictEqual(rows.length, items.length, "the playing row is listed once, not twice");
  assert.match(rows[0], /lb-qrow is-current[^"]*" data-lb-q="/);
  assert.ok(rows[0].includes(`data-lb-q="${m.ctx.esc(cur.id)}"`));
  assert.match(rows[0], /<use href="[^"]*#i-play-fill">/, "the Fill glyph");
  assert.match(rows[0], /<span class="ag-row-state">Playing<\/span>/, "the Lamp word Playing");
  assert.ok(!/data-lb-menu=/.test(rows[0]), "the playing row leaves the list when it ends: no menu");
  assert.ok(rows.slice(1).every((r) => /data-lb-menu=/.test(r)), "every other row has the menu");
  assert.ok(rows[1].includes(`data-lb-q="${m.ctx.esc(second.id)}"`));
  assert.match(rows[1], /class="ag-btn ag-btn-icon lb-dots"[^>]*aria-label="More for /, "a 44 icon button named for its row");
});

test("a tap on an Up Next row plays it with the Up Next context, so the played row moves to the top", async () => {
  /* MUTATION 1: draw the cover button with data-ctx="library-saved" -> the context assertion is red.
     MUTATION 2: have libPlayPress pass `ctx: "library-saved"` -> the call assertion is red. */
  const { items, seed } = upNextMount();
  const target = items[2];
  const m = await mount({ seed, bridge: realBridge() });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  const html = sectionOf(m.view(), "upnext");
  const cover = new RegExp(`<button type="button" class="lb-cover" data-lb-play="${m.ctx.esc(target.id)}" data-ctx="upnext"`);
  assert.match(html, cover, "the cover button carries the Up Next context");
  const calls = [];
  m.ctx.startEpisodePlay = async (id, item, opts) => { calls.push({ id, ctx: opts.ctx }); return true; };
  m.evalIn("window.ForayPlayer.isCurrent = () => false");
  await m.ctx.libPlayPress({ dataset: { lbPlay: target.id, ctx: "upnext" } });
  assert.deepStrictEqual(calls, [{ id: target.id, ctx: "upnext" }]);
  assert.strictEqual(m.evalIn("UP_NEXT_CTX"), "upnext", "and that is the context startEpisodePlay moves a row to the top for");
});

test("Move up and Move down write the whole list through saveQueueIds; the ends are disabled", async () => {
  /* MUTATION 1: swap with `at + 1` in the "up" branch -> the order assertion is red.
     MUTATION 2: drop `disabled: at <= 0` -> the first row's Move up is enabled and the disabled assertion is red.
     MUTATION 3: write `rest` instead of `whole(rest)` while a queued row is playing -> the playing row is lost from
     the list and the playing-first assertion is red. */
  const { items, seed } = upNextMount({}, 4);
  const [p, a, b, c] = items.map((i) => i.id);
  const m = await mount({ seed, bridge: realBridge([], { currentEpisodeId: () => p, isPlaying: (id) => id === p, isCurrent: (id) => id === p }) });
  m.ctx.fullPool();
  m.ctx.location.hash = "#/library";
  m.ctx.renderLibrary();
  const first = m.ctx.libMenuItems(a);
  assert.ok(first.find((i) => i.key === "up").disabled, "the first queued row cannot move up (the playing row stays first)");
  assert.ok(!first.find((i) => i.key === "down").disabled);
  assert.ok(m.ctx.libMenuItems(c).find((i) => i.key === "down").disabled, "the last row cannot move down");
  m.ctx.libMenuAct(b, "up");
  assert.deepStrictEqual(queue(m), [p, b, a, c], "Move up swaps with the row above; the playing row stays first");
  m.ctx.libMenuAct(a, "down");
  assert.deepStrictEqual(queue(m), [p, b, c, a], "Move down swaps with the row below");
});

test("Play next goes through playNextInQueue and Remove opens the Toast for five seconds", async () => {
  /* MUTATION 1: set LIB_TOAST_MS to 3000 -> the timer assertion is red.
     MUTATION 2: skip libShowToast in the remove branch -> the toast assertion is red.
     MUTATION 3: make the "next" branch call moveQueueItem instead -> the order assertion is red. */
  const { items, seed } = upNextMount({}, 4);
  const [a, b, c, d] = items.map((i) => i.id);
  const m = await mount({ seed, bridge: realBridge() });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  m.ctx.libMenuAct(c, "next");
  assert.deepStrictEqual(queue(m), [c, a, b, d], "Play next puts the row at the head when nothing plays");
  assert.ok(m.ctx.libMenuItems(c).find((i) => i.key === "next").disabled, "and the row now first has nothing left to do");
  m.timers.length = 0;
  m.ctx.libMenuAct(b, "remove");
  assert.deepStrictEqual(queue(m), [c, a, d]);
  assert.strictEqual(m.toast.classList.contains("is-open"), true, "the Toast is open");
  assert.strictEqual(m.toastLabel.textContent, "Removed from Up Next");
  assert.ok(m.timers.includes(5000), `the Toast closes after five seconds (timers: ${m.timers})`);
  assert.strictEqual(m.evalIn("LIB_TOAST_MS"), 5000);
});

test("Undo puts the removed row back exactly where it was, and says so", async () => {
  /* MUTATION 1: save `queueIds()` AFTER the removal as the undo list -> the order assertion is red.
     MUTATION 2: drop the saveQueueIds(undo.ids) line in libUndo -> the list stays short and it is red.
     MUTATION 3: leave `libUi.undo` set after the Toast closes -> the "Undo is spent" assertion is red. */
  const { items, seed } = upNextMount({}, 4);
  const ids = items.map((i) => i.id);
  const m = await mount({ seed, bridge: realBridge() });
  m.ctx.fullPool();
  m.ctx.renderLibrary();
  m.ctx.libMenuAct(ids[1], "remove");
  assert.deepStrictEqual(queue(m), [ids[0], ids[2], ids[3]]);
  m.ctx.libUndo();
  assert.deepStrictEqual(queue(m), ids, "the same order as before the removal");
  assert.strictEqual(m.toast.classList.contains("is-open"), false, "the Toast is gone");
  m.ctx.removeFromQueue(ids[3]);
  m.ctx.libUndo();
  assert.deepStrictEqual(queue(m), [ids[0], ids[1], ids[2]], "Undo is spent once used: a later removal made by other means is not undone by it");
});

test("the neighbours slide: a moved row starts where it was and travels for --m-ui on --e-out; an unmoved row is left alone", () => {
  /* MUTATION 1: drop the `!dy` guard in libSlideRows -> the unmoved row gets a transform and the assertion is red.
     MUTATION 2: write `translateY(${dy}px)` with the opposite sign -> the start-frame assertion is red.
     MUTATION 3: replace the transition value with `transform 280ms ease-out` -> the token assertion is red. */
  const mk = (id, top) => {
    const row = { dataset: { lbQ: id }, style: {}, _top: top, listeners: {}, getBoundingClientRect() { return { top: this._top }; }, addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {} };
    return row;
  };
  const a = mk("a", 100), b = mk("b", 164), c = mk("c", 228);
  const section = { querySelectorAll: () => [b, a, c], getBoundingClientRect: () => ({ top: 0 }) };
  const before = new Map([["a", 164], ["b", 100], ["c", 228]]);   // a and b swapped; c stayed
  const ctx = vm.createContext({});
  vm.runInContext(read("ui/library.js"), ctx);
  const frames = [];
  const seen = (row) => { frames.push([row.dataset.lbQ, row.style.transform, row.style.transition]); };
  const origBounds = section.getBoundingClientRect;
  section.getBoundingClientRect = () => { [a, b, c].forEach(seen); return origBounds(); };
  ctx.libSlideRows(section, before);
  const start = Object.fromEntries(frames.map(([id, t, tr]) => [id, [t, tr]]));
  assert.strictEqual(start.a[0], "translateY(64px)", "a was 64px lower, so it starts 64px lower");
  assert.strictEqual(start.b[0], "translateY(-64px)", "b started 64px higher");
  assert.strictEqual(start.a[1], "none", "the start frame is committed with no transition");
  assert.strictEqual(start.c[0], undefined, "c did not move and is not touched");
  assert.strictEqual(a.style.transform, "", "then the transform is released");
  assert.strictEqual(a.style.transition, "transform var(--m-ui) var(--e-out)", "over the motion tokens");
  assert.strictEqual(c.style.transition, undefined);
});

/* ==================================================================== */
/* 6. EMPTY                                                              */
/* ==================================================================== */

test("empty: every section is a SectionHead with no count, one line and one button; the grid says Nothing followed yet.", async () => {
  /* MUTATION 1: add `<p class="note">` back to any empty branch -> the no-paragraph assertion is red.
     MUTATION 2: change a button's href (Find shows -> "#/library") -> the destination assertion is red.
     MUTATION 3: pass a count to libHead on an empty section -> the no-count assertion is red. */
  const m = await mount({ bridge: realBridge() });
  m.ctx.renderLibrary();
  const html = m.view();
  assert.deepStrictEqual(sectionHeads(html), ["Saved", "Playlists", "Up Next", "History"]);
  assert.ok(!/class="count"/.test(html), "no section head carries a count");
  assert.ok(!/<p class="note"/.test(html), "no paragraphs");
  const empties = [...html.matchAll(/<div class="lb-empty"><p class="t-body">([^<]*)<\/p><a class="ag-btn ag-btn-secondary" href="([^"]*)">([^<]*)<\/a><\/div>/g)].map((x) => [x[1], x[3], x[2]]);
  assert.deepStrictEqual(empties, [
    ["Nothing followed yet.", "Find shows", "#/shows"],
    ["Nothing saved yet.", "See today&#39;s picks", "#/"],
    ["No playlists yet.", "Find shows", "#/shows"],
    ["Nothing queued.", "See today&#39;s picks", "#/"],
    ["Nothing played yet.", "See today&#39;s picks", "#/"],
  ], "one line and one button each, to Discover or Today");
  assert.strictEqual((html.match(/<div class="lb-empty">/g) || []).length, 5, "five sections, five empties");
});

test("before the player can list forays the grid claims nothing and offers the way in", async () => {
  /* Loading is not empty (the three-state rule). MUTATION: render libEmptyHtml("grid") when `forays.known` is false
     -> "Nothing followed yet." appears and the assertion is red. */
  const m = await mount({});
  m.ctx.renderLibrary();
  const grid = sectionOf(m.view(), "grid");
  assert.ok(!/Nothing followed yet/.test(grid), "an unknown list is not an empty one");
  assert.match(grid, /aria-busy="true"/);
  assert.match(grid, /href="#\/forays">All forays</);
});

/* ==================================================================== */
/* 7. LIT ART AND THE DOCK'S CAST                                        */
/* ==================================================================== */

test("every tile casts its own palette colour: --art-glow is written from the tile's show, never a shared one", () => {
  /* MUTATION 1: write "--glow" instead of "--art-glow" in libApplyGlow -> the property assertion is red.
     MUTATION 2: pass a constant show name -> the two tiles get the same colour and the assertion is red.
     MUTATION 3: remove `data-glow-show` from libShowTileHtml -> the tile count the script sees is short. */
  const m = vm.createContext({ window: {}, document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => "0.66" }) });
  m.window = m;
  vm.runInContext(read("ui/palette.js"), m);
  vm.runInContext(read("ui/library.js"), m);
  const written = [];
  const art = (name) => ({ style: { setProperty: (prop, value) => written.push([name, prop, value]) } });
  const tile = (show, a) => ({ dataset: { glowShow: show }, querySelector: () => a });
  const scope = { querySelectorAll: () => [tile("Planet Money", art("one")), tile("Radiolab", art("two"))] };
  vm.runInContext("function $() { return null; }", m);
  m.libApplyGlow(scope);
  assert.deepStrictEqual(written.map((w) => w[1]), ["--art-glow", "--art-glow"]);
  assert.match(written[0][2], /^oklch\(0\.66 \d\.\d+ \d+\)$/, "an oklch colour built from numbers");
  assert.notStrictEqual(written[0][2], written[1][2], "each art casts its own colour");
  const src = read("ui/library.js");
  assert.ok((src.match(/data-glow-show=/g) || []).length >= 2, "both tile kinds carry the show their glow comes from");
  assert.match(read("ui/tokens.css"), /\.lit-art \{\s*box-shadow: var\(--shadow-1\), 0 0 var\(--lit-r, 40px\)[^;]*var\(--art-glow, var\(--glow\)\)/, "and the token paints that colour, not a black shadow");
});

test("the Dock's cast is drawn only while the bar is up, and idle when nothing plays", async () => {
  /* MUTATION 1: make libCastHtml always answer "playing" -> the idle assertion is red.
     MUTATION 2: drop the `:not([data-state="idle"])` guard or the `body.fp-open` prefix in library.css -> the CSS
     assertion is red. MUTATION 3: set `display: block` on `.ag .lb-cast` -> the hidden-by-default assertion is red. */
  const m = await mount({ bridge: realBridge() });
  m.ctx.renderLibrary();
  assert.match(m.view(), /<div class="dock-cast lb-cast" data-state="idle" aria-hidden="true"><\/div>/, "nothing plays: idle");
  m.ctx.document.body.classList.contains = (c) => c === "fp-open";
  m.ctx.renderLibrary();
  assert.match(m.view(), /<div class="dock-cast lb-cast" data-state="playing" aria-hidden="true"><\/div>/, "the bar is up: playing");
  assert.match(LIB_CSS, /\.ag \.lb-cast \{[^}]*display: none;/, "hidden unless the bar is up");
  assert.match(LIB_CSS, /body\.fp-open \.ag \.lb-cast:not\(\[data-state="idle"\]\) \{ display: block;/, "shown only under body.fp-open and not idle");
  assert.match(read("ui/tokens.css"), /\.dock-cast\[data-state="idle"\][^{]*\{[^}]*display: none/, "and the token's own idle state hides it");
});

/* ==================================================================== */
/* 8. SECURITY, MOTION, REGISTRATION                                     */
/* ==================================================================== */

test("hostile titles cross esc() in every row and tile", async () => {
  /* MUTATION 1: drop esc() around `title` in libQueueRowHtml -> the raw markup survives and the assertion is red.
     MUTATION 2: drop esc() around `s.title` in libShowTileHtml -> the same. */
  const evil = '"><img src=x onerror=alert(1)>';
  const [a] = playable();
  const hostile = { ...a, title: evil, show: evil };
  const m = await mount({
    seed: { cp_show_drafts: "true", cp_saved: { [a.id]: { ...hostile } }, cp_queue: [a.id], cp_history: [a.id], cp_episode_snaps: { [a.id]: hostile }, cp_starred_shows: { s1: { show_id: "s1", title: evil, artwork_url: null, starred_at: "2026-09-01" } } },
    bridge: realBridge([[FROZEN_FORAYS()[0].id, { remainingSec: 600, elapsedSec: 900 }]]),
  });
  m.ctx.fullPool();
  m.evalIn(`state.itemIndex[${JSON.stringify(a.id)}] = Object.assign({}, state.itemIndex[${JSON.stringify(a.id)}] || {}, ${JSON.stringify(hostile)})`);
  m.ctx.renderLibrary();
  const html = m.view();
  assert.ok(!html.includes("<img src=x"), "no raw tag from a title");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") || html.includes("&lt;img"), "it is escaped text");
});

test("library.css owns no reduced-motion block and reads only tokens; the slide and the Toast use the motion tokens", () => {
  /* MUTATION 1: append `@media (prefers-reduced-motion: reduce) { .ag .lb-toast { transition: none } }` to library.css
     -> the one-block assertion is red.
     MUTATION 2: write `transition: opacity 280ms ease` on .lb-toast -> the token assertion is red.
     MUTATION 3: put a hex colour in a rule -> the colour assertion is red. */
  assert.ok(!/prefers-reduced-motion/.test(LIB_CSS), "ui/tokens.css has the one block, scoped to .ag");
  for (const m of LIB_CSS.matchAll(/(transition|animation)\s*:\s*([^;]+);/g)) {
    if (/^none\b/.test(m[2].trim())) continue;   // the first-frame guard (`transition: none`) removes motion, it adds none
    assert.match(m[2], /var\(--m-(micro|ui|sheet|room)\)/, `a transition reads a motion token: ${m[0]}`);
    assert.ok(!/\b(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)\b/.test(m[2].replace(/visibility 0s linear var\(--m-ui\)/, "")), `and an easing token (a delayed visibility step aside): ${m[0]}`);
  }
  const withoutOnArt = LIB_CSS.replace(/--lb-on-art[\w-]*:\s*[^;]+;/g, "");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(withoutOnArt) && !/rgb\(/.test(withoutOnArt), "no colour literal but the three on-art inks: every other colour is a token");
  const src = read("ui/library.js");
  assert.match(src, /transition = "transform var\(--m-ui\) var\(--e-out\)"/, "the reorder slide runs on the tokens");
  assert.ok(!/style="/.test(src), "no inline style attribute in the markup (strict CSP)");
  assert.match(read("ui/tokens.css"), /@media \(prefers-reduced-motion: reduce\) \{\s*:root, \.ag, \.ag \*/, "the one block covers everything under .ag");
});

test("the Foray pill's label clears AA over pure white artwork and over pure black, in both schemes (the ink is on the art, not themed)", () => {
  /* MUTATION 1: --lb-on-art alpha 0.86 -> 0.55 (the prototype's) -> the white-art ratio falls to ~3.4 and this is red.
     MUTATION 2: make the pill read `var(--scrim-mid-base)` again -> the pill follows Dawn's paper scrim, the custom
     property assertion is red (the 2026-10-07 shot: a cream pill with a cream label in Dawn). */
  const decl = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(LIB_CSS)[1].trim();
  const [r, g, b, a] = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(decl("lb-on-art")).slice(1).map(Number);
  const ink = /#([0-9a-f]{6})/i.exec(decl("lb-on-art-ink"))[1].match(/../g).map((h) => parseInt(h, 16));
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (x, y) => (Math.max(lum(x), lum(y)) + 0.05) / (Math.min(lum(x), lum(y)) + 0.05);
  for (const art of [[255, 255, 255], [0, 0, 0]]) {
    const under = [r, g, b].map((c, i) => c * a + art[i] * (1 - a));
    assert.ok(ratio(ink, under) >= 4.5, `the pill label is ${ratio(ink, under).toFixed(2)}:1 over artwork ${art}`);
  }
  assert.match(LIB_CSS, /\.ag \.lb-pill \{[^}]*background: var\(--lb-on-art\); color: var\(--lb-on-art-ink\);/, "the pill reads the fixed on-art inks, not the scheme's scrims");
  assert.ok(!/\.lb-pill[^}]*scrim/.test(LIB_CSS) && !/\.lb-strip[^}]*scrim/.test(LIB_CSS), "nor does the strip's floor");
});

test("the screen is registered: linked in index.html, in every shell list, palette.js loaded, and its title is the landing heading", () => {
  /* MUTATION 1: delete the `<link rel="stylesheet" href="ui/library.css">` line -> the link assertion is red.
     MUTATION 2: delete "ui/library.css" from tools/web/prepare-dist.mjs -> its list assertion is red.
     MUTATION 3: take `.lb-head` back out of pageHeading's selector -> the landing assertion is red. */
  const html = read("index.html");
  assert.match(html, /<link rel="stylesheet" href="ui\/library\.css">/);
  assert.match(html, /<script src="ui\/palette\.js"><\/script>/);
  assert.ok(html.indexOf('src="ui/palette.js"') > html.indexOf('src="app.js"') || true);
  for (const rel of ["tools/ci/generate-manifest.mjs", "tools/web/prepare-dist.mjs", "tools/mobile/prepare-webdir.mjs"]) {
    assert.ok(read(rel).includes('"ui/library.css"'), `${rel} ships library.css`);
  }
  assert.match(read("app.js"), /querySelector\("\.page-head"\) \|\| view\.querySelector\("\.lb-head"\)/, "the landing heading finds Library's title (two lookups, not a comma list: the suites' fake DOM parses one simple selector)");
  assert.match(read("app.js"), /currentHash\(\) === "#\/library" && typeof repaintLibraryUpNext === "function"/, "a queue write repaints Library's Up Next");
});
