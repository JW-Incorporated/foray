/* Redesign 2026, ambient direction ("Afterglow"), phase 4: the FORAYS LIST (#/forays).
 *
 * docs/redesign-2026/directions/ambient/BUILD-NOTES.md section 3 ("ForayCard") and BUILD-PLAN.md item 14 are the
 * specification; renderForays and the forayCard* builders in ui/forays.js and ui/forays.css are the build. There is no
 * prototype route for this page (only an is-it-better pair), so this suite pins the acceptance lines one at a time:
 *
 *   1  wiring: the stylesheet is linked after the primitives and ships on every path; the stylesheet is scoped, owns no
 *      reduced-motion block, loads nothing
 *   2  the grid is TWO columns at every width and the collage is 120: never a three-up ForayCard
 *   3  the card: collage, eyebrow "Foray" in Lamp, title headline (the one real link), "<n> shows, <m> min", strip
 *   4  the first show's square is whole and on top of its collage
 *   5  the strip: one bar per run of tape, widths that add up to the Foray, in-progress fill (heard bars lit, the bar the
 *      listener is in part-lit and tall, the rest dim), finished (all lit + the Fill check), fresh (lit, no check)
 *   6  the Dock's cast is on the page, there when something plays and absent when nothing does
 *   7  hostile data (a title with markup) never reaches the DOM as markup; no inline style; CSSOM-only paint
 *   8  contrast of the card's text on the raised surface in both schemes
 *   9  the harness the screens are shot with (seed, state)
 *
 * Every test names the one-line mutation that makes it fail, and each was run. A green test is not evidence until you
 * have broken it (CLAUDE.md). HARNESS AUDIT: the page is the REAL app.js + ui/*.js in a node:vm over the shared small DOM
 * (test/helpers/fake-dom.js), a bridge over the REAL resolver and the REAL strip module, and the frozen Foray fixture
 * (tools/foray/fixtures/frozen/, never live data). The stand-in the real thing is NOT is `forayResumeList`: it answers the
 * rows the test hands it, where the real one derives them from stored progress and the live running order; the page filters
 * and reads those rows the same either way, and the row SHAPE here is copied from player/client.js `forayResumeList`.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ok = require("./helpers/oklab.js");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const APP_SRC = readAppSource();
const SEARCH_SRC = read("search-engine.js");
const CSS_RAW = process.env.AMBIENT_FORAYS_CSS ? fs.readFileSync(process.env.AMBIENT_FORAYS_CSS, "utf8").replace(/\r\n/g, "\n") : read("ui/forays.css");
const CSS = strip(CSS_RAW);
const TOKENS = strip(read("ui/tokens.css"));

process.on("unhandledRejection", () => {});

/* ---------------------------------------------------------------- a small CSS reader */
function cssRules(css) {
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const prelude = stack.pop();
      if (buf.trim() && prelude !== undefined) out.push({ prelude, body: buf.trim(), atRules: stack.filter((p) => p.startsWith("@")) });
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}
function selectorsOf(prelude) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim().replace(/\s+/g, " ")); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}
const RULES = cssRules(CSS);
/** The last value `prop` gets on exactly `sel` outside any at-rule. */
const valueOf = (sel, prop) => {
  let v = null;
  for (const r of RULES) {
    if (r.prelude.startsWith("@") || r.atRules.length || !selectorsOf(r.prelude).includes(sel)) continue;
    for (const d of r.body.split(";")) {
      const c = d.indexOf(":");
      if (c >= 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim().replace(/\s+/g, " ");
    }
  }
  return v;
};

/* ---------------------------------------------------------------- the app, in a node:vm over the real player modules */
const playerMods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();
const FZ = "tools/foray/fixtures/frozen/data";
const readJson = (rel) => JSON.parse(read(rel));
const PLAIN = "capital-types-1";
const NARRATED = "what-engineers-actually-do-all-day-e08236";

/** The bridge: the real resolver, the real strip module, the real visibility rule; progress rows are the test's. */
async function bridgeOver({ rows = [] } = {}) {
  const { resolve, strip: stripMod } = await playerMods;
  return {
    resolve(doc, { id, segmentsDoc, sourcesDoc } = {}) {
      const f = resolve.findForay(doc, id, { unlocked: [id], showDrafts: true });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, opts = {}) => resolve.listableForays(doc, opts),
    stripTally: stripMod.stripTally, stripModel: stripMod.stripModel,
    fmtClock: resolve.fmtClock, fmtSpan: resolve.fmtSpan, narratorName: stripMod.NARRATOR_NAME,
    forayResumeList: () => rows,
    forayResume: () => null,
  };
}

function mount(hash, bridge) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        if (str.startsWith("#view ")) return view.querySelector(str.slice(6));
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [{ id: "business", label: "Business", parent: null }, { id: "engineering", label: "Engineering", parent: null }] };
  state.catalog = { shows: [] };
  return { ctx, state, view, body, store, html: () => view.innerHTML, run: (src) => vm.runInContext(src, ctx) };
}

/** Both fixture Forays published, so the page lists two cards; `rows` are the stored resume points. */
async function mountList({ rows = [], playing = false, tweak = null } = {}) {
  const b = await bridgeOver({ rows });
  const m = mount("#/forays", b);
  const doc = readJson(`${FZ}/forays.json`);
  for (const f of doc.forays) if (f.id === PLAIN || f.id === NARRATED) f.status = "published";
  if (tweak) tweak(doc);
  m.state.forays = doc;
  m.state.segments = readJson(`${FZ}/segments.json`);
  m.state.segmentSources = readJson(`${FZ}/segment-sources.json`);
  if (playing) m.body.classList.add("fp-open");
  m.ctx.renderCurrentPage();
  await new Promise((r) => setTimeout(r, 20));
  return m;
}
async function totalSecOf(id) {
  const { resolve } = await playerMods;
  const doc = readJson(`${FZ}/forays.json`);
  const f = doc.forays.find((x) => x.id === id);
  return resolve.resolveForay(f, { segments: resolve.indexSegments(readJson(`${FZ}/segments.json`)), sources: resolve.indexSources(readJson(`${FZ}/segment-sources.json`)) }).totalSec;
}
const resumeRow = (id, totalSec, fraction, extra = {}) => ({
  id, title: id, updated_at: "2026-10-05T11:00:00.000Z", elapsedSec: Math.round(totalSec * fraction), totalSec,
  index: 0, percent: Math.round(fraction * 100), finished: fraction >= 1, estimated: false,
  label: fraction >= 1 ? "Played" : `${Math.round(totalSec * (1 - fraction) / 60)} min left`, drift: "unverified", ...extra,
});
const cardOf = (html, id) => (html.split('<article class="raised fl-card').slice(1).find((c) => c.includes(`data-foray="${id}"`)) || "");
const barsOf = (card) => [...card.matchAll(/<span class="fl-bar t(\d)( is-here)?" data-grow="(\d+)"><i class="fl-fill" data-fill="(\d+)"><\/i><\/span>/g)]
  .map((m) => ({ tone: Number(m[1]), here: Boolean(m[2]), grow: Number(m[3]), fill: Number(m[4]) }));

/* ================================================================================ 1 wiring */

test("the stylesheet is linked after the primitives and ships on every path; it is scoped, loads nothing and owns no reduced-motion block", async () => {
  /* MUTATION 1: remove "ui/forays.css" from SHELL in tools/ci/generate-manifest.mjs or tools/web/prepare-dist.mjs, or from
     SHELL_FILES in tools/mobile/prepare-webdir.mjs, or drop the <link> from index.html -> red, naming the path.
     MUTATION 2: add a bare `.fy-row { }` rule, or an `@media (prefers-reduced-motion: reduce)` block, or an @import / url(...)
     to ui/forays.css -> red (one reduced-motion owner: ui/tokens.css). MUTATION 3: add a rule that restyles `.page-head`. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(links.includes("ui/forays.css") && links.indexOf("ui/forays.css") > links.indexOf("ui/primitives.css"), "linked after the primitives it reads");
  const shell = (rel, re) => { const m = re.exec(read(rel)); assert.ok(m, `${rel}: shell list found`); return m[1]; };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/forays\.css"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/forays\.css"/, "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/forays.css"), "prepare-webdir SHELL_FILES");
  assert.ok(pw.buildPlan(ROOT).includes("ui/forays.css"), "the app bundle's copy plan carries it");

  const flat = CSS.replace(/@(?:media|supports)[^{]*\{/g, "{");
  const heads = [...flat.matchAll(/(?:^|[}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter(Boolean);
  for (const list of heads) {
    for (const sel of selectorsOf(list)) assert.ok(/^(\.ag\b|\.page\.fl-list\b|body\.view-forays\b)/.test(sel), `unscoped selector: ${sel}`);
  }
  assert.ok(heads.length >= 30, `fixture assumption: the sheet has its rules (${heads.length})`);
  assert.doesNotMatch(CSS, /prefers-reduced-motion/, "the one block is tokens.css's");
  assert.doesNotMatch(CSS, /@import|url\(|!important/, "no origin, no image, nothing wins by force");
  assert.doesNotMatch(CSS, /\b(?:transition|animation)\s*:/, "nothing here animates, so nothing needs the block");
  const classes = new Set([...CSS.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const legacy = new Set([...read("styles.css").matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  for (const c of classes) if (/^fl-/.test(c)) assert.ok(!legacy.has(c), `.${c} is already a styles.css selector`);
});

/* ================================================================================ 2 two-up, never three-up */

test("the grid is two columns at every width and the collage is 120: a ForayCard is never three-up", async () => {
  /* MUTATION 1: `repeat(2, minmax(0, 1fr))` -> `repeat(3, minmax(0, 1fr))` -> red. MUTATION 2: add an
     `@media (min-width: 600px) { .ag .fl-grid { grid-template-columns: repeat(3, 1fr) } }` -> red (no breakpoint may raise
     the count). MUTATION 3: agCollage(c.covers, { size: 120 }) -> size: 104 in forayCardHtml (the compact tile's size) -> red. */
  assert.strictEqual(valueOf(".ag .fl-grid", "display"), "grid");
  assert.strictEqual(valueOf(".ag .fl-grid", "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  const stretched = RULES.filter((r) => /grid-template-columns/.test(r.body) && selectorsOf(r.prelude).some((s) => /fl-grid/.test(s)));
  assert.strictEqual(stretched.length, 1, "one rule sets the columns, and no @media changes the count");
  assert.deepStrictEqual(stretched[0].atRules, []);
  const m = await mountList();
  const html = m.html();
  const cards = html.split('<article class="raised fl-card').slice(1);
  assert.strictEqual(cards.length, 2, "both published Forays are listed");
  for (const c of cards) {
    assert.match(c, /class="ag-collage ag-collage-120 c\d lit-art lit-40"/, "the collage is the 120 primitive, Lit at 40");
    assert.doesNotMatch(c, /ag-collage-104|ag-collage-160/);
  }
  assert.strictEqual(valueOf(".ag .fl-art", "width"), "var(--art-foray)");
  assert.strictEqual(valueOf(".ag .fl-art", "height"), "var(--art-foray)");
  assert.strictEqual(read("ui/tokens.css").match(/--art-foray:\s*(\d+)px/)[1], "120");
});

/* ================================================================================ 3 the card */

test("a card reads: collage, the Lamp 'Foray' pill, the title (whole, never cut) as a headline link, '<n> shows, <m> min', the strip", async () => {
  /* MUTATIONS (each run red): swap the pill and the title in forayCardHtml; change the pill text to "Forays" or make it a
     plain `eyebrow` span again (grey caption, not Lamp's fill); drop `t-headline` from the title, or put `clamp3` back on it
     (a title is never cut: BUILD-NOTES 3, hero "never an ellipsis"); join the meta with " · " instead of ", "; use `r.shows.length`
     (authored count) instead of the strip's tally; delete the `fl-strip` line. */
  const m = await mountList();
  const html = m.html();
  const plain = cardOf(html, PLAIN);
  assert.ok(plain, "the plain Foray has its card");
  const order = ['class="fl-art"', "ag-collage-120", 'class="ag-pill fl-eyebrow"', "<h2", 'class="t-caption fl-meta"', 'class="fl-strip"'].map((s) => plain.indexOf(s));
  assert.ok(order.every((v) => v >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `in order: ${order}`);
  assert.match(plain, /<span class="ag-pill fl-eyebrow">Foray<\/span>/, "the pill is the word Foray, on Lamp's fill (4a's hand)");
  assert.doesNotMatch(plain, /clamp\d/, "no line clamp anywhere on the card: a name is never cut");
  assert.match(plain, /<h2 class="t-headline fl-card-title"><a class="fl-link" href="#\/foray\/capital-types-1">The types of capital a startup can raise<\/a><\/h2>/);
  const meta = /<p class="t-caption fl-meta">([^<]*)(?:<span[^>]*>[^<]*<\/span>)?<\/p>/.exec(plain);
  assert.ok(meta, "the meta line");
  assert.match(meta[1], /^\d+ shows?, (about )?(\d+ min|\d+ hr( \d+ min)?)$/, `n shows, m min: ${meta[1]}`);
  const { strip: stripMod, resolve } = await playerMods;
  const r = resolve.resolveForay(readJson(`${FZ}/forays.json`).forays.find((f) => f.id === PLAIN), { segments: resolve.indexSegments(readJson(`${FZ}/segments.json`)), sources: resolve.indexSources(readJson(`${FZ}/segment-sources.json`)) });
  assert.strictEqual(Number(/^(\d+)/.exec(meta[1])[1]), stripMod.stripTally(r.playable).shows, "the strip's own count of the shows a listener will hear");
  assert.ok(meta[1].endsWith(resolve.fmtSpan(r.totalSec)), `the runtime is the Foray's own: ${meta[1]}`);
  /* the page's heading, its Back, and nothing inline */
  assert.match(html, /<h1 class="t-title fl-title" data-page-heading tabindex="-1">Forays<\/h1>/);
  assert.match(html, /<a class="back ag-btn ag-btn-icon fl-back" href="#\/library" aria-label="Back">/);
  assert.ok(m.ctx.pageHeading(m.view), "pageHeading() finds the title: the route's focus lands on it");
  /* heading order: the page is an h1 and each card an h2, never a skipped level (axe `heading-order`).
     MUTATION: `<h2 class="t-headline fl-card-title">` -> `<h3 ...>` in forayCardHtml -> red. */
  assert.strictEqual((html.match(/<h1\b/g) || []).length, 1);
  assert.strictEqual((html.match(/<h2\b/g) || []).length, 2, "one h2 per card");
  assert.doesNotMatch(html, /<h3\b/);
  assert.doesNotMatch(html, /style="/, "no inline style: the strict CSP forbids it");
  /* The collage keeps the primitive's own display (a 2x2 is a grid): a `.ag .fl-art .ag-collage { display: block }` here ties
     `.ag .ag-collage.c4` on specificity, loads later and wins, which collapsed a 7-show Foray to one tile.
     MUTATION: re-add that rule to ui/forays.css -> red. */
  assert.doesNotMatch(CSS, /\.ag-collage[^{,]*\{[^}]*display\s*:/, "forays.css never restyles the collage's display");
  assert.strictEqual(valueOf(".ag .fl-eyebrow", "margin-top"), "var(--s-3)");
  assert.strictEqual(valueOf(".ag .fl-link::after", "inset"), "0", "the title link stretches over the card: the whole card is the tap target");
  assert.strictEqual(valueOf(".ag .fl-card", "position"), "relative");
});

/* ================================================================================ 4 the first square */

test("the first show's square is whole and on top of its collage, and the collage is ordered by first appearance", async () => {
  /* MUTATION 1: reverse `covers` (or sort it) in forayCardModels -> red. MUTATION 2: change the Two-up `nth-child(1)` z-index
     or the four-up grid in ui/primitives.css so the first square is not whole -> red (those rules are pinned here as well as
     in the primitives suite, because THIS page is where a Foray's first show decides the card). */
  const m = await mountList();
  const { resolve } = await playerMods;
  for (const id of [PLAIN, NARRATED]) {
    const card = cardOf(m.html(), id);
    const first = m.run(`forayShowsOf(resolveListedForay(${JSON.stringify(id)}))[0].name`);
    const squares = [...card.matchAll(/<span class="ag-art [^"]*" role="img" aria-label="([^"]*)">/g)].map((x) => x[1]);
    assert.ok(squares.length >= 1 && squares.length <= 4, `1 to 4 squares: ${squares.length}`);
    assert.strictEqual(squares[0].replace(/&amp;/g, "&"), first, `${id}: the first square is the first show (${first})`);
    const doc = readJson(`${FZ}/forays.json`).forays.find((f) => f.id === id);
    assert.ok(doc, "fixture");
  }
  void resolve;
  const prim = strip(read("ui/primitives.css"));
  const rule = (sel) => (cssRules(prim).find((r) => selectorsOf(r.prelude).includes(sel)) || {}).body || "";
  assert.match(rule(".ag .ag-collage.c2 > .ag-art:nth-child(1)"), /z-index: 2/, "two shows: the first on top");
  assert.match(rule(".ag .ag-collage.c3 > .ag-art:nth-child(1)"), /z-index: 3/, "three shows: the first on top");
  assert.match(rule(".ag .ag-collage.c4"), /grid-template: 1fr 1fr \/ 1fr 1fr/, "four shows: a grid, each square whole");
  assert.match(rule(".ag .ag-collage.c1 > .ag-art"), /inset: 0/, "one show: the one square fills it");
});

/* ================================================================================ 5 the strip */

test("the strip: one bar per run of tape, widths that add up to the Foray, a lit strip when the Foray is not started", async () => {
  /* MUTATION 1: fold narration into nothing (drop the `end` computation, use run.lengthSec) -> the total no longer reaches
     the Foray's runtime -> red. MUTATION 2: `fill = 100` -> `fill = 0` for an unpositioned card -> red (a never-opened Foray is
     lit throughout, like the Foray page's strip). MUTATION 3: count narration runs as bars -> the bar count differs from the
     tape-run count -> red. */
  const { strip: stripMod, resolve } = await playerMods;
  const m = await mountList();
  for (const id of [PLAIN, NARRATED]) {
    const f = readJson(`${FZ}/forays.json`).forays.find((x) => x.id === id);
    const r = resolve.resolveForay(f, { segments: resolve.indexSegments(readJson(`${FZ}/segments.json`)), sources: resolve.indexSources(readJson(`${FZ}/segment-sources.json`)) });
    const model = stripMod.stripModel(r.playable);
    const tape = model.runs.filter((x) => x.kind === "segment");
    const bars = barsOf(cardOf(m.html(), id));
    assert.strictEqual(bars.length, tape.length, `${id}: one bar per run of tape (${tape.length})`);
    assert.ok(Math.abs(bars.reduce((s, b) => s + b.grow, 0) - r.totalSec) <= bars.length, `${id}: the bars add up to the Foray (${bars.reduce((s, b) => s + b.grow, 0)} vs ${Math.round(r.totalSec)})`);
    assert.ok(bars.every((b) => b.fill === 100 && !b.here), "not started: lit throughout, no current bar");
    assert.ok(bars.every((b) => b.tone >= 0 && b.tone <= 7));
    assert.doesNotMatch(cardOf(m.html(), id), /fl-done/, "and no check");
  }
  assert.strictEqual(valueOf(".ag .fl-strip", "height"), "var(--s-3)", "the strip is 12 tall");
  assert.strictEqual(valueOf(".ag .fl-bar", "height"), "var(--s-2)", "the bars are 8");
  assert.strictEqual(valueOf(".ag .fl-bar.is-here", "height"), "var(--s-3)", "the bar the listener is in is the strip's full 12");
  assert.strictEqual(valueOf(".ag .fl-strip", "gap"), "calc(var(--s-1) / 2)", "2px between bars");
  assert.strictEqual(valueOf(".ag .fl-bar::before", "opacity"), "var(--seg-dim)", "the unheard part of a bar is the dim track");
});

test("in progress: bars already heard are full, the bar the listener is in is part-lit and tall, the rest are empty; the words go to a screen reader", async () => {
  /* MUTATION 1: `fill` computed from `elapsed / total` for every bar (not this bar's own span) -> red. MUTATION 2: drop
     `here:` -> red. MUTATION 3: treat `elapsed` of 0 as positioned (`started` true at 0) -> red in the last assertion.
     MUTATION 4: drop the sr-only state label from forayCardHtml -> red. */
  const total = await totalSecOf(PLAIN);
  const m = await mountList({ rows: [resumeRow(PLAIN, total, 0.55)] });
  const card = cardOf(m.html(), PLAIN);
  const bars = barsOf(card);
  const firstPartial = bars.findIndex((b) => b.fill < 100);
  assert.ok(firstPartial > 0, "some bars are fully heard first");
  assert.ok(bars.slice(0, firstPartial).every((b) => b.fill === 100 && !b.here), "heard bars: full, short");
  assert.ok(bars[firstPartial].fill > 0 && bars[firstPartial].fill < 100 && bars[firstPartial].here, `the bar in progress: part-lit and tall (${bars[firstPartial].fill}%)`);
  assert.ok(bars.slice(firstPartial + 1).every((b) => b.fill === 0 && !b.here), "unheard bars: empty");
  assert.strictEqual(bars.filter((b) => b.here).length, 1, "exactly one current bar");
  /* the lit fraction of the whole is the stored fraction: sum(fill * grow) / sum(grow) ~ 0.55 */
  const lit = bars.reduce((s, b) => s + b.fill * b.grow, 0) / bars.reduce((s, b) => s + 100 * b.grow, 0);
  assert.ok(Math.abs(lit - 0.55) < 0.03, `the strip is lit to where the listener is (${lit.toFixed(3)})`);
  assert.match(card, /is-started/, "the card says it is started");
  assert.match(card, /<span class="sr-only">\. \d+ min left<\/span>/, "and a screen reader hears how much is left");
  assert.doesNotMatch(card, /fl-done/, "an unfinished Foray wears no check");
  /* a row with zero elapsed is not "started": the card stays fresh */
  const zero = await mountList({ rows: [resumeRow(PLAIN, total, 0)] });
  assert.match(cardOf(zero.html(), PLAIN), /is-fresh/);
  assert.ok(barsOf(cardOf(zero.html(), PLAIN)).every((b) => b.fill === 100 && !b.here));
});

test("finished: every bar is lit and the collage wears the Fill check, in Ember; the screen-reader word is 'Played'", async () => {
  /* MUTATION 1: draw `fl-done` for started cards too -> the in-progress test goes red. MUTATION 2: swap `check-circle-fill`
     for `check-circle` (Regular) -> red (state is a Fill, as a followed show's). MUTATION 3: delete the `.fl-done` colour -> red. */
  const total = await totalSecOf(PLAIN);
  const m = await mountList({ rows: [resumeRow(PLAIN, total, 1)] });
  const card = cardOf(m.html(), PLAIN);
  const bars = barsOf(card);
  assert.ok(bars.length > 0 && bars.every((b) => b.fill === 100 && !b.here), "all lit, no current bar");
  assert.match(card, /<span class="fl-done"><svg[^>]*><use href="ui\/icons\.svg#i-check-circle-fill"/, "the Fill check, 20");
  assert.doesNotMatch(card, /#i-check-circle"/, "never the Regular check");
  assert.match(card, /is-finished/);
  assert.match(card, /<span class="sr-only">\. Played<\/span>/);
  assert.strictEqual(valueOf(".ag .fl-done", "color"), "var(--ember)");
  assert.strictEqual(valueOf(".ag .fl-done", "position"), "absolute");
  assert.strictEqual(valueOf(".ag .fl-done", "right"), "var(--s-1)");
  assert.strictEqual(valueOf(".ag .fl-done", "bottom"), "var(--s-1)");
  /* the other card, never opened, is untouched by the first one's state */
  assert.doesNotMatch(cardOf(m.html(), NARRATED), /fl-done|is-finished|is-started/);
});

test("a draft is a card too: its eyebrow says so, and a Foray with no data still draws a card without a strip", async () => {
  /* MUTATION 1: drop the `draft` branch of the eyebrow -> red. MUTATION 2: make forayCardBars throw / return one bar for a
     null resolve -> red. */
  const m = await mountList({ tweak: (doc) => { for (const f of doc.forays) if (f.id === NARRATED) f.status = "draft"; } });
  assert.deepStrictEqual(m.run("forayCards()").map((f) => f.id), [PLAIN], "a draft is not listed without the switch");
  const withDrafts = await mountList({ tweak: (doc) => { for (const f of doc.forays) if (f.id === NARRATED) f.status = "draft"; } });
  withDrafts.store.set("cp_show_drafts", "true");
  withDrafts.ctx.renderCurrentPage();
  const draft = cardOf(withDrafts.html(), NARRATED);
  assert.match(draft, /<span class="ag-pill fl-eyebrow">Foray · draft<\/span>/);
  const none = withDrafts.run(`forayCardBars(null, window.ForayPlayer, null)`);
  assert.deepStrictEqual(Array.from(none), [], "no running order: no bars");
  assert.strictEqual(withDrafts.run(`forayCardBars({ playable: [] }, window.ForayPlayer, null).length`), 0);
  assert.strictEqual(withDrafts.run(`forayCardMeta(null, window.ForayPlayer)`), "");
  /* A tone outside the eight (or none) is folded into the palette, never written as a class that styles nothing.
     MUTATION: `run.tone % 8` -> `run.tone` in forayCardBars -> red. */
  withDrafts.ctx.__p = { stripModel: () => ({ totalSec: 100, runs: [{ kind: "segment", from: 0, tone: 9 }, { kind: "segment", from: 1, tone: null }], segments: [{ startSec: 0 }, { startSec: 60 }] }) };
  assert.deepStrictEqual(JSON.parse(withDrafts.run(`JSON.stringify(forayCardBars({ playable: [{}, {}] }, __p, null))`)).map((b) => b.tone), [1, 0], "tone 9 folds to 1, no tone is 0");
  assert.deepStrictEqual(JSON.parse(withDrafts.run(`JSON.stringify(forayCardBars({ playable: [{}, {}] }, __p, null))`)).map((b) => b.grow), [60, 40], "and the bars are the spans between run starts");
  const html = withDrafts.run(`forayCardHtml({ id: "x", title: "T", draft: false, covers: [{ name: "T", src: "", tone: "amber" }], meta: "", state: "fresh", stateLabel: "", bars: [], glow: "" })`);
  assert.doesNotMatch(html, /fl-strip/, "no bars, no strip element");
  assert.match(html, /<span class="ag-art-mono"|ag-art-mono/, "the collage falls back to the title's initial");
});

/* ================================================================================ 6 the Dock's cast */

test("the Dock's cast is on the page: present when something plays, absent when nothing does", async () => {
  /* MUTATION 1: delete `${forayCastHtml()}` from the shell -> red (no cast element). MUTATION 2: delete the
     `body.view-forays.fp-open .ag .fl-cast { display: block }` rule -> red (it would never show). MUTATION 3: delete
     `.ag .fl-cast { display: none }` -> red (it would show with nothing playing). MUTATION 4: put a
     `data-state="idle"` back on the cast element -> red (stale after a cold start's late ribbon). MUTATION 5: `z-index: -1` -> `1` -> red (the cast would paint over the cards). */
  const idle = await mountList();
  const castMarkup = /<div class="dock-cast fl-cast" aria-hidden="true"><\/div>/;
  assert.match(idle.html(), castMarkup, "the element is always on the page: it follows the player live, not a state written at paint");
  assert.doesNotMatch(idle.html(), /data-state/, "no stale state attribute: a cold start restores the mini bar AFTER the first paint");
  const playing = await mountList({ playing: true });
  assert.match(playing.html(), castMarkup, "and the same element with the mini up");
  assert.ok(idle.body.classList.contains("view-forays"), "the page owns the body class its stylesheet keys on");
  assert.ok(playing.body.classList.contains("fp-open") && !idle.body.classList.contains("fp-open"), "fixture: the two mounts differ by exactly the class the stylesheet reads");
  /* the Dock is outside `.ag`: its mini title reads the scheme-following root token (the legacy `--text` is light on Dawn's paper).
     MUTATION: `color: var(--ag-text)` -> `var(--text)` on `.fp-title` -> red. */
  assert.strictEqual(valueOf("body.view-forays #foray-player .fp-title", "color"), "var(--ag-text)");
  /* the mini's skip button too (axe color-contrast read it as 1.32:1 on Dawn). MUTATION: delete the `.fp-skip` rule -> red. */
  assert.strictEqual(valueOf("body.view-forays.ui-v2 #foray-player .fp-skip", "color"), "var(--ag-text)");
  assert.strictEqual(valueOf(".ag .fl-cast", "display"), "none", "absent unless something plays");
  assert.strictEqual(valueOf("body.view-forays.fp-open .ag .fl-cast", "display"), "block", "there while the mini player is up");
  assert.strictEqual(valueOf(".ag .fl-cast", "position"), "fixed");
  assert.strictEqual(valueOf(".ag .fl-cast", "z-index"), "-1", "behind the cards, inside the page's own stacking context");
  assert.strictEqual(valueOf(".ag.fl-page", "isolation"), "isolate");
  /* the token owns the cast's look and geometry: the page adds none of its own */
  assert.match(TOKENS, /\.dock-cast \{[^}]*radial-gradient\(90% 100% at 50% 100%, color-mix\(in oklab, var\(--glow\) var\(--cast-mix\), transparent\) 0%, transparent 100%\)/);
  assert.strictEqual(valueOf("body.view-forays.fp-open", "--dock-h"), "calc(var(--tab-bar) + var(--mini))", "the cast rises from the top of the Dock, mini included");
  assert.strictEqual(valueOf("body.view-forays", "--dock-h"), "var(--tab-bar)");
  /* every state of the page carries the cast: loading and failed too */
  const loading = mount("#/forays", null);
  loading.state.forays = readJson(`${FZ}/forays.json`);
  loading.ctx.renderCurrentPage();
  assert.match(loading.html(), /class="dock-cast fl-cast"/, "the loading page keeps the Dock's light");
  /* and the Dock is the Veil: the tab bar and the mini take the page's Glow-tinted material */
  assert.strictEqual(valueOf("body.view-forays .tab-bar", "background"), "var(--glow-veil)");
  assert.strictEqual(valueOf("body.view-forays.ui-v2.fp-open #foray-player", "background"), "var(--glow-veil)");
  assert.strictEqual(valueOf("body.view-forays::after", "z-index"), "54", "the fade runs under the Dock so the last card is never sliced");
});

/* ================================================================================ 7 hostile data, CSSOM paint */

test("a title with markup never reaches the DOM as markup, and the paint is CSSOM only", async () => {
  /* MUTATION 1: drop esc() around c.title in forayCardHtml -> red. MUTATION 2: drop esc() around c.id in the href or
     data-foray -> red. MUTATION 3: write the bar widths as `style="width:…"` in the template -> red (the CSP forbids it, and
     so does the no-inline-style assertion). MUTATION 4: drop the `typeof setProperty` guard in forayCssVar's caller -> the
     stub case throws -> red. */
  const evil = 'Evil <img src=x onerror=alert(1)> "quoted"';
  const html = APP_SRC && vm.runInContext(`forayCardHtml(${JSON.stringify({ id: 'a"><b>', title: evil, draft: false, covers: [{ name: evil, src: "javascript:alert(1)", tone: "amber" }], meta: "1 show, 3 min", state: "started", stateLabel: '5 min left<script>', bars: [{ tone: 2, here: true, grow: 40, fill: 50 }], glow: "" })})`, (await mountList()).ctx);
  assert.ok(!/<img src=x/.test(html) && !/<b>/.test(html) && !/<script>/.test(html), "nothing hostile survives as markup");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("&quot;quoted&quot;"));
  assert.ok(!/javascript:/.test(html), "an unsafe artwork URL never becomes a src");
  assert.doesNotMatch(html, /style="/);
  /* the paint */
  const m = await mountList();
  const sets = [];
  const el = (tag, data) => ({ dataset: data, style: { setProperty: (k, v) => sets.push([tag, k, v]) } });
  const scope = {
    querySelectorAll: (sel) => (sel === ".fl-bar[data-grow]" ? [el("bar", { grow: "120" }), el("bar", { grow: "bad" })]
      : sel === ".fl-fill[data-fill]" ? [el("fill", { fill: "55" }), el("fill", { fill: "900" }), el("fill", { fill: "-3" })]
        : sel === ".fl-card .ag-collage" ? [el("collage", {}), el("collage", {})] : []),
    querySelector: (sel) => (sel === ".fl-page" ? el("page", {}) : null),
  };
  m.ctx.paintForayCards(scope, [{ glow: "oklch(0.66 0.100 40)" }, { glow: "oklch(0.66 0.100 200)" }]);
  const by = (tag, k) => sets.filter((s) => s[0] === tag && s[1] === k).map((s) => s[2]);
  assert.deepStrictEqual(by("bar", "flex-grow"), ["120", "1"], "a bar's width is its seconds, 1 when unreadable");
  assert.deepStrictEqual(by("fill", "width"), ["55%", "100%", "0%"], "the lit part is clamped to 0..100");
  assert.deepStrictEqual(by("collage", "--art-glow"), ["oklch(0.66 0.100 40)", "oklch(0.66 0.100 200)"], "each collage in its own first show's light");
  assert.deepStrictEqual(by("page", "--glow"), ["oklch(0.66 0.100 40)"], "the page in the first card's");
  assert.ok(sets.every((s) => !/Evil|Show|[a-z]{4,}\./.test(String(s[2]))), "only numbers and colours are written, never a name");
  assert.doesNotThrow(() => m.ctx.paintForayCards({ querySelectorAll: () => [{ dataset: { grow: "5" }, style: {} }], querySelector: () => ({ style: {} }) }, [{ glow: "x" }]), "a stub document has no CSSOM: nothing painted, nothing thrown");
  assert.doesNotThrow(() => m.ctx.paintForayCards(null, []));
  /* the real page paints the root's Glow before any frame: from the first card, through the same writer */
  assert.match(APP_SRC.slice(APP_SRC.indexOf("function paintForayCards(")), /forayClaimRootGlow\(glow\)/, "the Dock (on <body>) takes the page's light, borrowed through the claim");
  /* ORDER: every colour is read before the markup goes in */
  const render = APP_SRC.slice(APP_SRC.indexOf("function renderForays("), APP_SRC.indexOf("function forayCardMeta("));
  assert.ok(render.indexOf("forayCardModels(forayCards())") < render.indexOf('$("#view").innerHTML = shell(cards.length'), "the Glow is read before the Room is installed");
});

/* ================================================================================ 7b the root's Glow is borrowed */

test("the root's Glow is borrowed for the Dock and handed back when the route changes; other pages never keep this page's tint", async () => {
  /* The Forays page lights the ROOT's --glow (the Dock lives outside the page). It used to leave it there, so every page
     without a Glow of its own (show, episode, about, settings...) tinted its Veil with the Forays page's Glow (5.7-8.1%
     baseline diffs on every other screen). MUTATIONS (each run red): make forayReleaseRootGlow a no-op; drop the
     `forayReleaseRootGlow()` call from route() in app.js; let a second claim overwrite the saved "before" value. */
  const m = await mountList();
  const props = new Map([["--glow", "oklch(0.5 0.1 10)"]]);
  const root = { style: { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) || "", removeProperty: (k) => props.delete(k) } };
  const real = m.ctx.document;
  m.ctx.document = { ...real, documentElement: root };
  try {
    m.ctx.forayClaimRootGlow("oklch(0.66 0.100 40)");
    m.ctx.forayClaimRootGlow("oklch(0.66 0.100 200)");   /* a re-render on the same page */
    assert.strictEqual(props.get("--glow"), "oklch(0.66 0.100 200)", "the page lights the root");
    m.ctx.forayReleaseRootGlow();
    assert.strictEqual(props.get("--glow"), "oklch(0.5 0.1 10)", "what the root held before is put back, not the first claim's");
    m.ctx.forayReleaseRootGlow();
    assert.strictEqual(props.get("--glow"), "oklch(0.5 0.1 10)", "a second release is a no-op");
    props.delete("--glow");
    m.ctx.forayClaimRootGlow("oklch(0.66 0.100 40)");
    m.ctx.forayReleaseRootGlow();
    assert.ok(!props.has("--glow"), "a root that held nothing holds nothing again");
    m.ctx.forayReleaseRootGlow();
    m.ctx.forayClaimRootGlow("");
    assert.ok(!props.has("--glow"), "no Glow, no claim");
  } finally { m.ctx.document = real; }
  const at = APP_SRC.indexOf("function route()");
  const route = APP_SRC.slice(at, APP_SRC.indexOf("landOnPage({ navigated", at));
  assert.ok(route.indexOf("forayReleaseRootGlow()") > 0 && route.indexOf("forayReleaseRootGlow()") < route.indexOf("\n  renderCurrentPage();"), "route() hands the Glow back before the next page paints");
});

test("the collage draws every show the listener will hear, not only the authored list", async () => {
  /* The authored `shows` list can name fewer shows than the running order plays (the meta said "7 shows" over one tile).
     MUTATION: make forayTapeShows return `r.shows` only -> the added show is missing -> red. */
  const m = await mountList();
  const names = m.ctx.forayTapeShows({ shows: ["A"], playable: [{}] }, { stripModel: () => ({ shows: ["A", "B", "C"] }) });
  assert.deepStrictEqual(Array.from(names), ["A", "B", "C"]);
  assert.deepStrictEqual(Array.from(m.ctx.forayTapeShows({ shows: ["A"], playable: [] }, null)), ["A"], "nothing playable: the authored shows");
  assert.deepStrictEqual(Array.from(m.ctx.forayTapeShows({ shows: ["A"], playable: [{}] }, { stripModel: () => { throw new Error("bad"); } })), ["A"], "a malformed running order does not break the list");
});

/* ================================================================================ 8 contrast */

test("the card's text clears AA on the raised surface in both schemes: title and meta (the Lamp pill's own ink-on-Lamp pair is pinned by the token suite)", () => {
  /* The token suite pins text on bg0/bg1/bg2; a card is `.raised`, bg1 under the scheme's overlay, which Dusk lightens and Dawn
     whitens. MUTATION: make Dusk's `--overlay` alpha 0.30 or Dawn's `--text-2` #8A8279 in ui/tokens.css -> red, naming the pair. */
  const block = (re) => { const m = re.exec(TOKENS); assert.ok(m, `token block ${re}`); return m[1]; };
  const dusk = block(/:root, \[data-theme="dusk"\] \{([^}]*)\}/);
  const dawn = block(/\[data-theme="dawn"\] \{([^}]*)\}/);
  const hex = (b, name) => { const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b); assert.ok(m, `${name} in block`); return ok.hexToRgb(m[1]); };
  const over = (b) => {
    const m = /--overlay:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(b);
    assert.ok(m, "overlay");
    const a = Number(m[4]);
    const base = hex(b, "--bg1");
    return [0, 1, 2].map((i) => Number(m[i + 1]) / 255 * a + base[i] * (1 - a));
  };
  for (const [name, b] of [["Dusk", dusk], ["Dawn", dawn]]) {
    const bg = over(b);
    /* the pill: --lamp-ink on --lamp. MUTATION: set Dusk's --lamp-ink to #F3E7D3 in ui/tokens.css -> red. */
    assert.ok(ok.contrast(hex(b, "--lamp-ink"), hex(b, "--lamp")) >= 4.5, `${name}: the Foray pill's ink on Lamp`);
    for (const fg of ["--ag-text", "--text-2", "--lamp-text"]) {
      const ratio = ok.contrast(hex(b, fg), bg);
      assert.ok(ratio >= 4.5, `${name}: ${fg} on a raised card = ${ratio.toFixed(2)}`);
    }
  }
});

/* ================================================================================ 9 the harness */

test("the harness reaches the page: a seed with one Foray part-played and one finished, a state that opens it, and a step with something playing", async () => {
  /* MUTATION 1: drop the second Foray's row from foraysListRows in tools/ui-lab/lib/seed.mjs -> red. MUTATION 2: rename the
     `forays-list` state or its `.fl-card` ready selector -> red. MUTATION 3: delete the appended `mini-player-forays` step
     -> red. */
  const seedMod = await import(pathToFileURL(path.join(ROOT, "tools", "ui-lab", "lib", "seed.mjs")).href);
  const statesMod = await import(pathToFileURL(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs")).href);
  const fx = seedMod.loadFixtures(ROOT);
  const seed = seedMod.buildSeed("forays-progress", fx);
  const rows = Object.entries(seed).filter(([k]) => k.startsWith("cp_foray:"));
  assert.strictEqual(rows.length, 2, "two stored points");
  const [part, done] = rows.map(([, v]) => v.elapsed_sec / v.total_sec);
  assert.ok(Math.abs(part - 0.55) < 0.01, `the first is part-played (${part})`);
  assert.ok(done >= 0.999, "the second is finished");
  assert.deepStrictEqual(Object.keys(seedMod.buildSeed("returning", fx)).filter((k) => k.startsWith("cp_foray:")), [], "the plain returning profile has none");
  /* The scheme-flip helpers park on a LEGACY page, never on this one: a page that wears `.ag` crossfades its colours when the
     scheme flips and the reduced-motion gate reads 94 transitions on it (the first gates run on this branch did exactly that).
     Followed shows folded into Library (#/starred-shows is an alias of it now) and the Up Next page (#/queue) is Afterglow
     too (Redesign 2026, ambient Up Next), so no legacy PAGE is left: the helpers park on #/about and then EMPTY #view, so nothing
     drawn is left to crossfade.
     MUTATION 1: `const PARK_ROUTE = "#/about"` -> `"#/queue"` (or `"#/starred-shows"`) in tools/ui-lab/lib/states.mjs -> red.
     MUTATION 2: take the `v.replaceChildren()` out of parkAway -> the emptied-view assertion is red. */
  const statesSrc = read("tools/ui-lab/lib/states.mjs");
  assert.match(statesSrc, /const PARK_ROUTE = "#\/about";/, "parked on About, then the view is emptied");
  assert.match(statesSrc, /async function parkAway\(page\) \{[\s\S]*?PARK_ROUTE[\s\S]*?replaceChildren\(\)/, "parkAway empties #view after it parks: a drawn .ag page would crossfade its colours");
  assert.strictEqual((statesSrc.match(/await parkAway\(page\)/g) || []).length, 3, "the unavailable, Dawn and Forays Dawn helpers park through parkAway");
  assert.strictEqual((statesSrc.match(/PARK_ROUTE\)/g) || []).length, 2, "and parkAway and freshDiscover's reset are the two places that name the route");
  const states = statesMod.appStates(fx);
  const st = states.find((s) => s.id === "forays-list");
  assert.ok(st && st.seed === "forays-progress");
  assert.deepStrictEqual(st.steps.map((s) => [s.label, s.route, s.ready]), [["forays-list", "#/forays", ".fl-card"], ["forays-list-dawn", "#/forays", ".fl-card"]]);
  const player = states.find((s) => s.id === "player");
  assert.deepStrictEqual(player.steps.at(-1), { label: "mini-player-forays", route: "#/forays", ready: ".fl-card" }, "appended last: no existing step moved");
});
