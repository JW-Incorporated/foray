/* Tactile `foray` (Foray detail): the page a Foray opens on.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.17,
 * BUILD-NOTES 4.6.
 *
 * WHAT THIS PROVES
 *   1. THE CHROME. A paper back keycap top-left (a link that steps history and falls back to
 *      the Forays list), a paper share keycap top-right, the "Foray" tag, the title as a
 *      display-xl h1 clamped at four lines with balanced wrapping and room for descenders,
 *      then the band in a card-wide well, then the readout, the summary, the why-line, From,
 *      Clips and the pinned key, in that order.
 *   2. THE BAND. Its codes are the primitive's own (once per RUN of one show, never under
 *      24px), as HTML over the bars; on the un-narrated Barbecue fixture no code repeats beside
 *      itself at 375, 393 or 412 (the "BR BR" defect); the needle shows only in progress and
 *      the filled part follows the stored place; played and browsing bars are at full enamel.
 *   3. THE NUMBERS. The readout is "about 22 min . 4 shows . 8 clips" from the strip's own
 *      tally (tape clips, shows heard, "about" only for an estimate); a Foray with no narration
 *      says so in words; the why-line is printed only when a reason is observed and fits the
 *      18-word ceiling, never invented.
 *   4. THE ROWS. One From row per show, its swatch the band's code and enamel; Clips grouped by
 *      slot, each row a row-wide button that starts the Foray AT that clip (`data-fy` is the
 *      queue index), with its votes beside it and nothing nested inside the button.
 *   5. THE KEY. One extended persimmon keycap, `keycap--lg keycap--round keycap--pin`: Play with
 *      the runtime, Resume with the clock, Start over with no readout; 56 high, padding
 *      0 20 0 14, glyph 28, word 17/700, readout at 85%; right-aligned at deck + 16; the
 *      paper fade behind it is deck + safe-b + 100 and solid to 60%.
 *   6. THE STATES. In progress, played, un-narrated, and unavailable (an empty well with no
 *      station labels, a needle lifted 20 degrees, "This foray isn't available right now.",
 *      Try another foray and Yours, share gone, back kept).
 *   7. SHARE. The shell's share sheet, else Web Share, else the link on the clipboard; a
 *      published Foray shares its hash route, a draft its unlocking address; a dismissed
 *      sheet is not an error.
 *   8. THE LIMITS. Every interpolation escaped and every href through safeUrl; no inline style;
 *      44px targets; one reduced-motion block that names the pin's transition; tokens only in
 *      the stylesheet block; the copy passes the banned-phrase lists.
 *   9. THE HARNESS. The four steps are appended to `returning` after the ones that existed, and
 *      the screen map points at them with the band, the key and the rows as regions.
 *
 * WHAT IT CANNOT PROVE: how any of it looks. tools/ui-lab/fidelity.mjs measures that against
 * the prototype in a real browser; this suite runs the real renderForay in node:vm over a small
 * DOM that parses innerHTML into a tree.
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken it"). The page
 * is the real renderForay over the REAL resolver, strip model and tally (player/foray-resolve.js,
 * player/segment-strip.js) and the frozen Foray fixtures, so a mutation in ui/foray.js or
 * ui/foray-player.js changes what these tests read. The fake DOM is KINDER than a browser in
 * two ways, both named: it does not lay anything out (so every pixel claim is a CSS-text claim,
 * read from the stylesheet), and it has no text nodes (so words are read from the markup the
 * page wrote and, for the key, from what paintForay assigned). Each test names its mutation;
 * all were run red (see the run record in docs/redesign-2026/directions/tactile/PROGRESS.md).
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { El } = require("./helpers/fake-dom.js");
const { parseRules } = require("./helpers/dial-css.js");
const copy = require("../backend/src/copy/rules.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const FZ = "tools/foray/fixtures/frozen/data";
const FORAYS = readJson(`${FZ}/forays.json`);
const SEGMENTS = readJson(`${FZ}/segments.json`);
const SOURCES = readJson(`${FZ}/segment-sources.json`);
const CATALOG = readJson("data/catalog.json");

const NARRATED = "what-engineers-actually-do-all-day-e08236";   // frozen, draft: 40 narration beats, 16 clips
const UNNARRATED = "grilling-history-2";                          // frozen, draft: 10 clips, no narration (the prototype's Barbecue)
const PUBLISHED = "capital-types-1";                               // frozen, published, no narration

process.on("unhandledRejection", () => {});

/* ---------------------------------------------------------------- the stylesheet */

const rules = parseRules(CSS);
function decl(selector, atRules = []) {
  const out = {};
  let found = false;
  for (const r of rules) {
    if (!r.selectors || !r.selectors.includes(selector)) continue;
    if (r.atRules.join("|") !== atRules.join("|")) continue;
    found = true;
    for (const d of r.decls) out[d.prop] = d.value;
  }
  assert.ok(found, `styles.css has no rule for ${selector}`);
  return out;
}
const FORAY_START = CSS.lastIndexOf("/*", CSS.indexOf("FORAY DETAIL (TACTILE): the band, the clips, one pinned key"));
/* ends at the next section: the onboarding block (group F) follows, else the reduced-motion block */
const FORAY_END = (() => { const o = CSS.indexOf("/* ONBOARDING (Tactile"); return o > FORAY_START ? o : CSS.indexOf("/* ---------- REDUCE MOTION: ONE BLOCK"); })();
const FORAY_CSS = CSS.slice(FORAY_START, FORAY_END);

/* ---------------------------------------------------------------- the page */

const playerMods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();

/** A bridge over the REAL resolver and strip module. `resume` is the stored point (or null),
    `calls` records what the page asked the player to do. */
async function makeBridge({ resume = null, forays = FORAYS } = {}) {
  const { resolve, strip } = await playerMods;
  const calls = [];
  const bridge = {
    calls,
    resolve(doc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
      const f = resolve.findForay(doc, id, { unlocked, showDrafts });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc) => (doc?.forays || []).filter((f) => f.status === "published"),
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    narratorName: strip.NARRATOR_NAME,
    forayResume: (id, opts = {}) => {
      calls.push({ name: "forayResume", args: [id, opts] });
      if (!resume) return null;
      return resume.finished && !opts.includeFinished ? null : resume;
    },
    forayDriftIsClean: () => true,
    clearForayResume: (id) => { calls.push({ name: "clearForayResume", args: [id] }); },
    watchForay: (fn) => { bridge.onChange = fn; return null; },
    playForay: (r, opts) => { calls.push({ name: "playForay", args: [r.id, opts] }); return null; },
    forayToggle: () => { calls.push({ name: "forayToggle", args: [] }); },
    forayJump: (i) => { calls.push({ name: "forayJump", args: [i] }); },
  };
  void forays;
  return bridge;
}

/** Mount the real app.js over a small DOM and render the Foray page for `id`. */
async function page(id, { width = 393, resume = null, unlock = false, forays = FORAYS, segments = SEGMENTS, sources = SOURCES, navigator: nav = {}, search = null, setup = null } = {}) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const elId of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = elId; body.appendChild(e);
  }
  const warnings = [];
  const bridge = await makeBridge({ resume });
  const ctx = {
    console: { ...console, warn: (...a) => { warnings.push(a.map(String).join(" ")); }, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        if (str.startsWith("#view ")) return view.querySelector(str.slice(6));
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true, ...nav },
    addEventListener() {}, removeEventListener() {},
    innerWidth: width,
    location: { hash: `#/foray/${id}`, search: search ?? (unlock ? `?foray=${id}` : ""), pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.catalog = CATALOG;
  state.forays = forays;
  state.segments = segments;
  state.segmentSources = sources;
  if (setup) setup(ctx, state);
  await ctx.renderForay(id);
  const html = view.innerHTML;
  return { ctx, state, view, body, html, bridge, warnings };
}

/** The resolved Foray the page would have, for expectations computed outside the page. */
async function resolved(id) {
  const { resolve } = await playerMods;
  const f = resolve.findForay(FORAYS, id, { unlocked: [id], showDrafts: true });
  return resolve.resolveForay(f, { segments: resolve.indexSegments(SEGMENTS), sources: resolve.indexSources(SOURCES) });
}

const textOf = (html, re) => (re.exec(html) || [])[1];
const keyWord = (m) => m.view.querySelector("#fy-play").querySelector(".keycap__label").textContent;
const keyRead = (m) => m.view.querySelector("#fy-play").querySelector(".keycap__readout");

/* ============================================================ 1. chrome */

test("the chrome: back and share keycaps, the Foray tag, a display-xl title, the band in a well, then the sections and the pinned key, in that order", async () => {
  /* MUTATION 1: in renderForay, draw the header before `forayBarHtml` (the keys move below the
     title) -> the order assertion is red. MUTATION 2: change the back key to
     `keycap--ink` / drop `keycap--paper` -> the class assertion is red. MUTATION 3: point the
     back link at `#/` -> red (it must land where an unlocked draft is still listed). MUTATION 4:
     draw the title as `<h2 class="heading">` -> red. */
  const m = await page(NARRATED, { unlock: true });
  const h = m.html;
  assert.match(h, /<a class="keycap keycap--sm keycap--paper back" href="#\/library" data-yours-chip-link="forays" aria-label="Back">/, "the back key is a small paper link to Yours, on its Forays chip");
  assert.match(h, /<button type="button" class="keycap keycap--sm keycap--paper" id="fdet-share" aria-label="Share this foray">/, "the share key is a small paper button");
  assert.match(h, /<span class="tag tag--narration">[\s\S]*?<span>Foray<\/span><\/span>/, "the tag is the narration tag, 'Foray'");
  const title = (await resolved(NARRATED)).title;
  assert.ok(h.includes(`<h1 class="display-xl fdet-title">${title}</h1>`), "the title is the display-xl h1");
  const at = (needle) => { const i = h.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const order = ['class="fdet-bar"', 'class="tag tag--narration"', 'class="display-xl fdet-title"', 'class="well fdet-well"', 'class="readout fdet-facts"', 'class="fdet-summary"',
    '<h2 class="heading">From</h2>', '<h2 class="heading">Clips</h2>', 'class="fdet-pin"'].map(at);
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "bar, tag, title, well, readout, summary, From, Clips, key");
  assert.ok(at('aria-label="Back"') < at('id="fdet-share"'), "back at the left, share at the right");
  assert.strictEqual(m.view.querySelectorAll(".fdet-bar").length, 1);
  assert.ok(!/ style="/.test(h), "no inline style attribute anywhere on the page (the CSP)");
});

test("the page is named: its h1 is the heading a navigation lands focus on and the document is titled after", async () => {
  /* The page has no `.page-head`, which is where pageHeading() used to look, so without this focus fell to the
     bare #view and the document stayed "4a". MUTATION: drop `|| view.querySelector("h1.fdet-title")` from
     pageHeading -> red. */
  const m = await page(PUBLISHED);
  const head = m.ctx.pageHeading(m.view);
  assert.ok(head, "a heading is found");
  assert.ok(head.classList.contains("fdet-title"));
  assert.strictEqual(head.tagName, "H1");
  const un = await page("does-not-exist");
  assert.ok(un.ctx.pageHeading(un.view).classList.contains("fdet-title"), "and the unavailable page is named too");
});

test("the title is clamped at four balanced lines and keeps its descenders", () => {
  /* MUTATION: `-webkit-line-clamp: 3` or drop `text-wrap: balance` or `padding-bottom` -> red. */
  const t = decl(".fdet-title");
  assert.strictEqual(t["-webkit-line-clamp"], "4");
  assert.strictEqual(t["line-clamp"], "4");
  assert.strictEqual(t["text-wrap"], "balance");
  assert.strictEqual(t.overflow, "hidden");
  assert.match(t["padding-bottom"] || "", /var\(--s-1\)/, "the clamp's overflow box would shave the last line's descenders without it");
  assert.strictEqual(t.display, "-webkit-box");
});

/* ============================================================ 2. the band */

/** Runs of one show, in order, from the resolved entries, worked out outside the page. */
function runsOf(r) {
  const runs = [];
  for (const e of r.playable) {
    const narration = e.kind === "tts" || e.type === "narration" || !e.show;
    if (narration) continue;
    const last = runs[runs.length - 1];
    if (last && last.show === e.show) last.n += 1; else runs.push({ show: e.show, n: 1 });
  }
  return runs;
}

test("band codes: once per run, never beside themselves, at 375, 393 and 412 on the un-narrated Barbecue fixture and on a narrated one", async () => {
  /* The "BR BR" defect: the same show's code twice in a row, from a band that keyed bars by
     source episode instead of by show. A narrated Foray draws several clips of one show from
     different episodes side by side, which is where a per-episode key splits one run into many.
     MUTATION 1: in forayBandModel set `showId: s.sourceKey` (key by episode) -> there are more
     runs than the show-by-show runs worked out here; red. MUTATION 2: make forayBandWidth()
     return 2000 -> the Barbecue band carries more than its five stations at 412; red. */
  for (const id of [UNNARRATED, NARRATED]) {
    const r = await resolved(id);
    const shows = runsOf(r);
    assert.ok(shows.every((run, i) => i === 0 || shows[i - 1].show !== run.show), "fixture: the runs are already merged");
    if (id === NARRATED) assert.ok(shows.length < r.playable.filter((e) => e.show).length, "fixture: some show has clips side by side");
    for (const width of [375, 393, 412]) {
      const m = await page(id, { width, unlock: true });
      const codes = [...m.html.matchAll(/<span class="fdet-code"[^>]*>([^<]*)<\/span>/g)].map((x) => x[1]);
      assert.ok(codes.length > 0, `${id} ${width}: the band is labelled`);
      codes.forEach((code, i) => assert.notStrictEqual(code, codes[i - 1], `${id} ${width}: ${code} twice in a row: ${codes.join(" ")}`));
      assert.ok(codes.length <= shows.length, `${id} ${width}: at most one code per run (${codes.length} codes, ${shows.length} runs)`);
      const runsOnPage = [...m.html.matchAll(/<span class="fdet-code" data-run-start="(\d+)" data-run-end="(\d+)"/g)].map((x) => [Number(x[1]), Number(x[2])]);
      runsOnPage.forEach(([a, b], i) => { assert.ok(b >= a); if (i) assert.ok(a > runsOnPage[i - 1][1], `${id} ${width}: runs do not overlap`); });
      assert.ok(codes.every((c) => /^[A-Z0-9]{2}$/.test(c)), `${id} ${width}: two-letter station codes`);
      const bars = (m.html.match(/<rect class="t-band__bar t-band__bar--c\d"/g) || []).length / 2;
      assert.ok(bars >= shows.length, `${id} ${width}: a bar per clip, merged per run at most (${bars} bars, ${shows.length} runs)`);
    }
  }
  /* The one fixed point: at 412 the whole Barbecue band carries these six stations. SO is the
     narrow (under 24px) second run, labelled by tactileBandLabelRuns because colour must never be
     the only thing that names a run. MUTATION: make tactileBandLabelRuns keep only runs >= 24px -> SO drops; red. */
  const wide = await page(UNNARRATED, { width: 412, unlock: true });
  assert.deepStrictEqual([...wide.html.matchAll(/<span class="fdet-code"[^>]*>([^<]*)<\/span>/g)].map((x) => x[1]), ["OS", "SO", "BR", "MP", "GC", "BC"]);
});

test("the codes are HTML over the bars and the SVG's own glyphs and needle are hidden", () => {
  /* The band's SVG is stretched by a non-uniform viewBox: a glyph in it is squeezed to a third
     of its width and a needle's cap becomes an ellipse (Now Playing hit the same wall).
     MUTATION: delete `.fdet-stage .t-band__code, .fdet-stage .needle { display: none }` -> the
     codes and the needle are drawn twice; red. */
  assert.strictEqual(decl(".fdet-stage .t-band__code").display, "none");
  assert.strictEqual(decl(".fdet-stage .needle").display, "none");
  const code = decl(".fdet-code");
  assert.strictEqual(code.position, "absolute");
  assert.match(code.left, /var\(--x, 0\)/);
  assert.match(decl(".fdet-code.is-current").color, /var\(--ink\)/, "the run under the needle is --ink");
  assert.strictEqual(decl(".fdet-code.is-current")["font-weight"], "800");
  assert.strictEqual(decl(".fdet .band--detail").height, "60px", "the primitive's viewBox is 1000x60: at 60px the bars are 28px tall");
  const well = decl(".fdet-well");
  assert.match(well.padding, /var\(--s-2\) 10px 2px/);
  assert.strictEqual(well.display, "block");
});

test("the needle shows only in progress, the rest of the bars sit at 40% only in progress, and the filled part is the stored place", async () => {
  /* MUTATION 1: delete the `:not([data-foray-state="progress"]) .fdet-needle` rule -> a fresh
     page draws a needle at 0; red. MUTATION 2: delete the `.t-band__base { opacity: 1 }` rule ->
     a finished Foray reads as 40%; red. MUTATION 3: write the filled width from
     `state.forayResume` only (not 1 for a played Foray) -> the finished width is 0; red. */
  assert.ok(CSS.includes('.fdet:not([data-foray-state="progress"]):not(.fdet--unavailable) .fdet-needle { display: none; }'));
  assert.ok(CSS.includes('.fdet:not([data-foray-state="progress"]) .t-band__base { opacity: 1; }'));
  const progress = { elapsedSec: 700, index: 6, remainingSec: 1000, percent: 40, finished: false, label: "17 min left", drift: "unverified" };
  const fresh = await page(NARRATED, { unlock: true });
  const mid = await page(NARRATED, { unlock: true, resume: progress });
  const done = await page(NARRATED, { unlock: true, resume: { ...progress, elapsedSec: 99999, finished: true, label: "Played" } });
  const state = (m) => m.view.querySelector(".fdet").getAttribute("data-foray-state") ?? textOf(m.html, /<div class="page foray fdet" data-foray-state="([^"]*)"/);
  assert.deepStrictEqual([state(fresh), state(mid), state(done)], ["fresh", "progress", "done"]);
  /* Read from the markup the render wrote, BEFORE the first paint overwrites it, so a wrong
     initial width is not hidden by the paint that follows. */
  const width = (m) => Number(textOf(m.html, /<rect class="band__progress" x="0" y="0" width="([\d.]+)"/));
  assert.strictEqual(width(fresh), 0, "nothing played");
  assert.ok(width(mid) > 100 && width(mid) < 900, `the filled part stands near the stored place (${width(mid)})`);
  assert.ok(width(done) >= 990, `a played Foray is filled end to end (${width(done)})`);
  /* The run under the needle is drawn in --ink: only where there is a needle. A browsing or played
     page has no current run (MUTATION 4: pass `mark` instead of -1 for them -> red). */
  const current = (m) => m.view.querySelectorAll(".fdet-code").filter((c) => c.classList.contains("is-current")).length;
  assert.deepStrictEqual([current(fresh), current(mid), current(done)], [0, 1, 0], "no current run while browsing, one in progress, none once played");
  /* And a Foray that has just played out while the page was open: the tick says ended, the index is still
     a clip, and no run is current any more. The clip is one inside a run that carries a code, so the
     positive control (live, it IS current) is not vacuous. */
  const r = await resolved(NARRATED);
  const firstCoded = Number(mid.view.querySelectorAll(".fdet-code")[0].dataset.runStart);
  const index = mid.state.forayBand.items[firstCoded].index;
  const tick = (over) => mid.bridge.onChange({ forayId: NARRATED, index, playing: true, running: true, loading: false, gap: false, ended: false, elapsedSec: 100, totalSec: r.totalSec, error: null, ...over });
  tick({});
  assert.strictEqual(current(mid), 1, "positive control: live inside a coded run, that run is current");
  tick({ playing: false, running: false, ended: true, elapsedSec: r.totalSec });
  assert.strictEqual(current(mid), 0, "a Foray that has played out has no current run");
  assert.strictEqual(mid.view.querySelector(".fdet").getAttribute("data-foray-state"), "done");
  assert.ok(done.html.includes('<span class="tag tag--played">'), "and its title carries the Played tag");
  assert.ok(!fresh.html.includes("tag--played") && !mid.html.includes("tag--played"));
});

/* ============================================================ 3. the numbers */

test("the readout is 'about 22 min . 4 shows . 8 clips' from the strip's tally: tape clips, shows heard, 'about' only for an estimate", async () => {
  /* MUTATION 1: count `r.playable.length` in place of `tally.clips` -> the narrated Foray's
     readout counts the bridges; red. MUTATION 2: print "about" always (or never) -> one of the
     two runtimes is wrong; red. MUTATION 3: count `r.shows.length` instead of `tally.shows`. */
  const { strip } = await playerMods;
  for (const [id, hedged] of [[NARRATED, true], [UNNARRATED, false], [PUBLISHED, false]]) {
    const r = await resolved(id);
    const tally = strip.stripTally(r.playable);
    const m = await page(id, { unlock: true });
    const facts = textOf(m.html, /<p class="readout fdet-facts">([^<]*)<\/p>/);
    const mins = Math.round(r.totalSec / 60);
    assert.ok(facts.startsWith(hedged ? "about " : ""), `${id}: ${facts}`);
    assert.strictEqual(tally.estimated, hedged, `${id}: fixture: the runtime is ${hedged ? "an estimate" : "measured"}`);
    assert.match(facts, new RegExp(`^${hedged ? "about " : ""}${mins} min · ${tally.shows} shows? · ${tally.clips} clips?$`), `${id}: ${facts}`);
    assert.ok(tally.clips < r.playable.length || !hedged, "fixture: the narrated Foray has bridges the count leaves out");
  }
});

test("a Foray with no narration says so in words, once; a narrated one does not", async () => {
  /* MUTATION: drop the `narrated ? "" : ...` guard -> the narrated page says it has none; red.
     MUTATION 2: always print it -> same. */
  const none = await page(UNNARRATED, { unlock: true });
  const some = await page(NARRATED, { unlock: true });
  assert.strictEqual((none.html.match(/No narration yet on this one\./g) || []).length, 1);
  assert.ok(!some.html.includes("No narration yet"));
  assert.strictEqual(none.view.querySelectorAll(".t-band__bar--narration").length, 0, "and its band carries no narration ticks");
  assert.ok(some.view.querySelectorAll(".t-band__bar--narration").length > 0, "while the narrated band carries them");
});

test("'Why today' is printed only for an observed reason, and only within the 18-word ceiling", async () => {
  /* MUTATION 1: return `TODAY_FIRST_RUN_LINE` unconditionally -> the unobserved case prints a why;
     red. MUTATION 2: drop the `wordCount(line) <= 18` guard -> the long-label case prints; red.
     MUTATION 3: drop the try/catch -> a reason that throws breaks the page; red. MUTATION 4: print
     the interest line for any score (drop `> 0.5`) -> the default-interest case prints; red. */
  const quiet = (ctx) => {
    ctx.todayIsFirstRun = () => false;
    ctx.jumpBackInEntries = () => [];
    ctx.foraysForYouPicks = () => null;
  };
  const none = await page(UNNARRATED, { unlock: true, setup: quiet });
  assert.ok(!none.html.includes("Why today") && !none.html.includes("fdet-why"), "no observed reason: no why-line at all");

  /* A first run is observed (nothing played, nothing to resume): the page says what 4a does then. */
  const first = await page(UNNARRATED, { unlock: true });
  assert.ok(first.html.includes('<span class="label fdet-muted">Why today</span>'));
  assert.ok(first.html.includes(vm.runInContext("TODAY_FIRST_RUN_LINE", first.ctx)), "the first-run line, from the one place it is written");

  const stretch = await page(UNNARRATED, { unlock: true, setup: (ctx) => {
    quiet(ctx);
    ctx.foraysForYouPicks = () => ({ picks: [{ id: UNNARRATED }], stretchIndex: 0 });
    ctx.subjectLabel = () => "Food";
  } });
  const line = stretch.ctx.forayWhyToday(stretch.state.foray);
  assert.match(line, /^Outside your usual subjects/, "the stretch pick says it is outside the usual subjects, on purpose");
  assert.ok(copy.wordCount(line) <= 18);
  assert.ok(stretch.html.includes(`<p class="fdet-why__line">${line}</p>`) || stretch.html.includes("Outside your usual subjects"), "and the page prints it");
  stretch.ctx.subjectLabel = () => "a very long subject label ".repeat(12).trim();
  assert.strictEqual(stretch.ctx.forayWhyToday(stretch.state.foray), "", "over the ceiling: no line rather than a long one");
  stretch.ctx.foraysForYouPicks = () => { throw new Error("blew up"); };
  assert.strictEqual(stretch.ctx.forayWhyToday(stretch.state.foray), "", "a reason that cannot be worked out is no reason, not a broken page");

  const liked = await page(UNNARRATED, { unlock: true, setup: (ctx, state) => {
    quiet(ctx);
    ctx.subjectLabel = () => "Food";
    state.interests = { food: 0.9 };
  } });
  assert.ok(liked.html.includes("A pick for your interest in Food."), "a subject the listener has moved up says so");
  const cold = await page(UNNARRATED, { unlock: true, setup: (ctx, state) => { quiet(ctx); state.interests = { food: 0.5 }; } });
  assert.ok(!cold.html.includes("Why today"), "the default weight is not an interest");
});

/* ============================================================ 4. the rows */

test("From: one row per show, its swatch the band's code and enamel, its count in clips, a link only where the show has a page", async () => {
  /* MUTATION 1: build the swatch's code with `tactileStationCode(name)` (no collision ladder) ->
     two shows can share a code; the band-agreement assertion is red on a collision fixture.
     MUTATION 2: say "segments" -> the copy assertion is red. MUTATION 3: drop the shows with no
     link -> a row disappears; red. */
  const m = await page(UNNARRATED, { unlock: true });
  const r = await resolved(UNNARRATED);
  const shows = [...new Set(r.entries.filter((e) => e.type !== "narration" && e.show).map((e) => e.show))];
  const rows = m.view.querySelectorAll(".fdet-from");
  assert.strictEqual(rows.length, shows.length, "one row per show the Foray draws on");
  const swatches = [...m.html.matchAll(/<span class="fdet-sw (t-band__bar--c\d)" aria-hidden="true">([A-Z0-9]{2})<\/span><span class="art-frame/g)];
  assert.strictEqual(swatches.length, shows.length, "each carries its code in a swatch, never a bare letter");
  const bandCodes = [...m.html.matchAll(/<span class="fdet-code"[^>]*>([^<]*)<\/span>/g)].map((x) => x[1]);
  for (const c of bandCodes) assert.ok(swatches.some((s) => s[2] === c), `the band's ${c} is a swatch's code too`);
  assert.strictEqual(new Set(swatches.map((s) => s[2])).size, swatches.length, "no two shows share a code");
  assert.ok(m.html.includes("2 clips") && m.html.includes("1 clip<"), "counts say clip or clips");
  assert.ok(!/segments?</.test(m.html), "the copy rules call segment pipeline vocabulary");
  const linked = (m.html.match(/<a class="row__link" href="#\/show\/[^"]+">/g) || []).length;
  const plain = (m.html.match(/<span data-credit-show="/g) || []).length;
  assert.strictEqual(linked + plain, shows.length, "every From row is a link or plain text");
});

test("Clips: grouped by slot in the Foray's own order; every row is one button whose data-fy is its queue index; nothing is nested in it", async () => {
  /* The authored position of an item (`ord`) and its place in the playing queue
     (`queueIndex`) come apart the moment one item resolves but cannot play: ord still counts it,
     the queue does not. The Foray here opens with a clip whose episode has no audio file.
     MUTATION 1: key the row on `entry.ord` instead of `entry.queueIndex` -> tapping a row would
     start the Foray one clip late; red. MUTATION 2: put the thumbs inside the button -> the
     nesting assertion is red. MUTATION 3: render slot headings from `slot.id`. */
  const doc = JSON.parse(JSON.stringify(FORAYS));
  const f = doc.forays.find((x) => x.id === UNNARRATED);
  const sources = JSON.parse(JSON.stringify(SOURCES));
  const segments = JSON.parse(JSON.stringify(SEGMENTS));
  sources.sources.push({ id: "ghost-src", show: "A Show Nobody Will Hear", title: "Ghost", audio_url: null });
  segments.segments.push({ id: "ghost-src#0", item_id: "ghost-src", start_sec: 0, end_sec: 30 });
  f.items = [{ type: "segment", segment_id: "ghost-src#0", slot: f.items[0].slot }, ...f.items];
  const m = await page(UNNARRATED, { unlock: true, forays: doc, segments, sources });
  const r = m.state.foray;
  const headings = [...m.html.matchAll(/<div class="fdet-slot">\s*<h3 class="h17">([^<]*)<\/h3>/g)].map((x) => x[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
  assert.deepStrictEqual(headings, r.slots.map((s) => s.title), "one heading per slot, in order");
  const rows = m.view.querySelectorAll("[data-fy]");
  const playable = r.entries.filter((e) => e.playable);
  assert.ok(playable.some((e) => e.ord !== e.queueIndex), "fixture: the two numberings differ");
  assert.deepStrictEqual(rows.map((x) => Number(x.dataset.fy)), playable.map((e) => e.queueIndex), "the queue index, in running order");
  assert.ok(rows.every((x) => x.tagName === "BUTTON" && x.classList.contains("segrow")));
  const button = (html) => html.slice(html.indexOf("<button"), html.indexOf("</button>"));
  const rowHtml = m.html.split(/<div class="fdet-seg(?: is-out)?">/).slice(1);
  assert.strictEqual(rowHtml.length, playable.length + r.entries.filter((e) => !e.playable).length);
  for (const h of rowHtml.filter((x) => x.includes("data-fy="))) {
    const inner = button(h);
    assert.ok(!/<button[\s\S]*<button|<a |data-thumb/.test(inner.slice(1)), `a clip row's button holds no link or vote: ${inner.slice(0, 200)}`);
    assert.match(inner, /<span class="fdet-sw [^"]*"/, "its swatch");
    assert.match(inner, /<span class="readout fdet-seg__len">\d+:\d\d<\/span>/, "its runtime in the mono readout");
  }
  assert.ok(m.html.includes('data-thumb="up"') && m.html.includes('data-thumb="down"'), "the votes are still beside each clip");
});

test("tapping a clip row starts the Foray there when cold and jumps inside it when live", async () => {
  /* MUTATION: bind the rows to `start(0)` -> the startIndex assertion is red. */
  const m = await page(UNNARRATED, { unlock: true });
  const rows = m.view.querySelectorAll("[data-fy]");
  rows[3].click();
  await new Promise((r) => setTimeout(r, 0));
  const started = m.bridge.calls.filter((c) => c.name === "playForay");
  assert.strictEqual(started.length, 1);
  assert.strictEqual(started[0].args[1].startIndex, Number(rows[3].dataset.fy), "at the row's own clip");
});

/* ============================================================ 5. the pinned key */

test("one pinned key: Play with the runtime, Resume with the clock, Start over with none", async () => {
  /* MUTATION 1: label the cold key "Start" -> red. MUTATION 2: show the runtime beside Resume
     (not the clock) -> red. MUTATION 3: leave the readout visible for a finished Foray -> the
     hidden assertion is red. MUTATION 4: draw a second `id="fy-play"` or any other control with
     the pin's classes -> the count assertion is red. */
  const { resolve } = await playerMods;
  const r = await resolved(NARRATED);
  const fresh = await page(NARRATED, { unlock: true });
  const mid = await page(NARRATED, { unlock: true, resume: { elapsedSec: 760, index: 4, remainingSec: 1500, percent: 33, finished: false, label: "25 min left", drift: "unverified" } });
  const done = await page(NARRATED, { unlock: true, resume: { elapsedSec: 99999, index: 15, remainingSec: 0, percent: 100, finished: true, label: "Played", drift: "unverified" } });
  assert.strictEqual(fresh.view.querySelectorAll(".keycap--pin").length, 1, "exactly one pinned key");
  assert.ok(fresh.html.includes('class="keycap keycap--persimmon keycap--lg keycap--round keycap--pin" id="fy-play"'));
  assert.strictEqual(keyWord(fresh), "Play");
  assert.strictEqual(keyRead(fresh).textContent, resolve.fmtSpan(r.totalSec), "the runtime beside Play");
  assert.strictEqual(keyWord(mid), "Resume");
  assert.strictEqual(keyRead(mid).textContent, resolve.fmtClock(760), "the clock beside Resume");
  assert.strictEqual(keyWord(done), "Start over");
  assert.strictEqual(keyRead(done).hidden, true, "no readout beside Start over");
  assert.ok(fresh.html.includes('<svg class="i" aria-hidden="true" focusable="false"><use href="#ph-play-fill"></use></svg><svg class="i i--swap"') && fresh.html.includes("#ph-pause-fill"), "the glyphs are sprite icons, play and (swapped in while running) pause");
  assert.ok(fresh.html.includes(" data-ctl-icons"), "so no engine writes a text glyph into the key");
});

test("a finished Foray's key starts over: forgets the place, logs a restart, starts from the top", async () => {
  /* MUTATION: drop `player.clearForayResume(r.id)` from the finished branch, or start with
     `startAt(...)` -> red. */
  const m = await page(NARRATED, { unlock: true, resume: { elapsedSec: 99999, index: 15, remainingSec: 0, percent: 100, finished: true, label: "Played", drift: "unverified" } });
  const events = [];
  m.ctx.logEvent = (type) => events.push(type);
  m.view.querySelector("#fy-play").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.bridge.calls.some((c) => c.name === "clearForayResume"));
  const start = m.bridge.calls.find((c) => c.name === "playForay");
  assert.strictEqual(start.args[1].startIndex, 0);
  assert.strictEqual(start.args[1].startElapsedSec, undefined);
  assert.deepStrictEqual(events, ["foray_restart"]);
});

test("the key's geometry and its fade, read from the stylesheet", () => {
  /* BUILD-PLAN 2.17 item 4. MUTATION: change any of these values in the block -> red naming it. */
  const key = decl(".fdet-pin .keycap--pin");
  assert.strictEqual(key.height, "56px");
  assert.strictEqual(key["min-width"], "0");
  assert.strictEqual(key.padding, "0 var(--s-5) 0 14px", "0 20px 0 14px: the glyph's side is tighter than the word's");
  assert.strictEqual(key.gap, "var(--s-2)");
  assert.strictEqual(decl(".fdet-pin .keycap--pin .i").width, "28px");
  assert.strictEqual(decl(".fdet-pin .keycap--pin .i").height, "28px");
  assert.strictEqual(decl(".fdet-pin .keycap__label").font, "700 var(--t-body-lg)/1 var(--font-text)");
  const read = decl(".fdet-pin .keycap__readout");
  assert.strictEqual(read.color, "var(--on-persimmon)");
  assert.strictEqual(read.opacity, "1", "the readout is not faded: the contrast test below holds the number");
  const pin = decl(".fdet-pin");
  assert.strictEqual(pin.position, "fixed");
  assert.strictEqual(pin.bottom, "calc(var(--foray-dock) + var(--s-4))", "right-aligned at deck + 16");
  assert.match(pin.right, /max\(var\(--gutter\), calc\(\(100vw - 680px\) \/ 2 \+ var\(--gutter\)\)\)/, "right-aligned to the page's own right edge");
  assert.strictEqual(decl("body.ui-v2.view-foray")["--foray-dock"], "calc(var(--safe-b) + var(--s-3) + var(--deck-h))");
  assert.strictEqual(decl("body.ui-v2.view-foray.fp-open:not(.mini-dismissed)")["--foray-dock"], "calc(var(--safe-b) + var(--s-3) + var(--deck-h) + var(--fp-bar-h))", "and above the mini player when it is up");
  const fade = decl("body.view-foray::after");
  assert.strictEqual(fade.height, "calc(var(--deck-h) + var(--safe-b) + 100px)", "the paper fade is deck + safe-b + 100px");
  assert.strictEqual(fade.background, "linear-gradient(to top, var(--paper) 60%, transparent)", "solid to 60%");
  assert.strictEqual(fade["pointer-events"], "none");
  assert.ok(Number(fade["z-index"]) < Number(pin["z-index"]), "the key stands above the fade, so the fade is what it sits on");
  assert.match(decl("body.view-foray.fp-open:not(.mini-dismissed)::after").height, /var\(--fp-bar-h\)/, "and the fade grows with the mini");
});

/* ============================================================ 6. the states */

test("un-narrated and played pages follow their states: the unavailable page is its own screen", async () => {
  /* MUTATION 1: draw the share key on the unavailable page -> red. MUTATION 2: draw bars or
     codes in the empty well -> red. MUTATION 3: point 'Try another foray' at the Foray that is
     not available -> red. MUTATION 4: drop `fdet-well--empty`'s needle rule or its rotation. */
  const m = await page("does-not-exist");
  const h = m.html;
  assert.ok(h.includes('class="page foray fdet fdet--unavailable" data-foray-state="unavailable"'));
  assert.ok(!h.includes("fdet-share") && !h.includes("Share this foray"), "nothing to share");
  assert.ok(h.includes('class="keycap keycap--sm keycap--paper back"'), "back is kept");
  assert.ok(h.includes('<h1 class="display fdet-title">This foray isn&#39;t available right now.</h1>') || h.includes("<h1 class=\"display fdet-title\">This foray isn't available right now.</h1>"));
  assert.ok(h.includes('class="well fdet-well fdet-well--empty"') && h.includes("band--empty"), "an empty well");
  assert.strictEqual(m.view.querySelectorAll(".fdet-code").length, 0, "no station labels");
  assert.strictEqual(m.view.querySelectorAll("rect").length, 0, "no bars");
  assert.strictEqual(m.view.querySelectorAll("#fy-play").length, 0, "no pinned key");
  assert.match(h, /<a class="keycap keycap--md keycap--persimmon" href="#\/foray\/capital-types-1"><span class="keycap__label">Try another foray<\/span><\/a>/, "the next Foray that can be opened");
  assert.match(h, /<a class="keycap keycap--md keycap--paper" href="#\/library"><span class="keycap__label">Yours<\/span><\/a>/);
  /* The same page for a draft nobody unlocked: a client that tells "hidden" from "missing" announces unpublished work. */
  const hidden = await page(UNNARRATED);
  assert.ok(hidden.html.includes("fdet--unavailable"));
  assert.ok(hidden.html.includes('href="#/foray/capital-types-1"'), "and never offers the hidden one");
  /* The empty well, in the stylesheet. */
  assert.strictEqual(decl(".band--empty .t-band__code").display, "none");
  assert.strictEqual(decl(".band--empty .band__labels").display, "none", "the spec's own rule, spelled as the spec spells it");
  const needle = decl(".fdet-well--empty .fdet-needle");
  assert.match(needle.transform, /rotate\(20deg\)/, "lifted 20 degrees");
  assert.strictEqual(needle["transform-origin"], "50% 100%", "pivoting on its foot");
  assert.strictEqual(needle["--x"], ".5");
});

test("'Try another foray' falls back to the Forays list when nothing else can be opened", async () => {
  /* MUTATION: drop the `return "#/forays"` fallback -> the key has no href; red. The Forays
     list is Yours' Forays chip now, so the key opens it directly (data-yours-chip-link). */
  const m = await page("does-not-exist", { forays: { ...FORAYS, forays: [] } });
  assert.ok(m.html.includes('<a class="keycap keycap--md keycap--persimmon" href="#/library" data-yours-chip-link="forays">'));
});

/* ============================================================ 7. share */

test("share: the shell's sheet, else Web Share, else the clipboard; a published Foray shares its route, a draft its unlocking address; a dismissed sheet is not an error", async () => {
  /* MUTATION 1: share `location.href` -> the url assertions are red. MUTATION 2: drop the
     AbortError return -> the dismissed case warns; red. MUTATION 3: drop the clipboard branch. */
  const BASE = "https://jw-incorporated.github.io/foray/";
  const shared = [];
  const web = await page(PUBLISHED, { navigator: { share: async (d) => { shared.push(d); } } });
  web.view.querySelector("#fdet-share").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(shared.length, 1);
  assert.strictEqual(shared[0].title, (await resolved(PUBLISHED)).title);
  assert.strictEqual(shared[0].url, `${BASE}#/foray/${PUBLISHED}`, "the route of a published Foray");

  const draft = await page(UNNARRATED, { unlock: true, navigator: { share: async (d) => { shared.push(d); } } });
  draft.view.querySelector("#fdet-share").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(shared[1].url, `${BASE}?foray=${UNNARRATED}`, "a draft's address unlocks it");

  const dismissed = await page(PUBLISHED, { navigator: { share: async () => { throw Object.assign(new Error("dismissed"), { name: "AbortError" }); } } });
  dismissed.view.querySelector("#fdet-share").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(dismissed.warnings.length, 0, "a dismissed sheet is silent");

  const clip = [];
  const bare = await page(PUBLISHED, { navigator: { clipboard: { writeText: async (t) => { clip.push(t); } } } });
  bare.view.querySelector("#fdet-share").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(clip.length, 1);
  assert.strictEqual(clip[0], `${BASE}#/foray/${PUBLISHED}`, "no sheet at all: the link goes on the clipboard");

  const native = [];
  const shell = await page(PUBLISHED, { navigator: { share: async () => { throw new Error("must not be used"); } } });
  shell.ctx.Capacitor = { Plugins: { Share: { share: async (d) => { native.push(d.url); } } } };
  shell.view.querySelector("#fdet-share").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(native.length, 1, "the shell's own sheet comes first");
  assert.strictEqual(native[0], `${BASE}#/foray/${PUBLISHED}`);
});

/* ============================================================ 8. the limits */

test("every interpolation is escaped: a hostile title, summary, slot title and show name reach the page as text", async () => {
  /* MUTATION: drop esc() around any one of `r.title`, `summary`, the slot title or the show
     name in the From row or a clip row -> the raw tag is in the markup; red. */
  const hostile = `<img src=x onerror=alert(1)>`;
  const doc = JSON.parse(JSON.stringify(FORAYS));
  const f = doc.forays.find((x) => x.id === UNNARRATED);
  f.title = hostile; f.summary = hostile; f.slots[0].title = hostile;
  const sources = JSON.parse(JSON.stringify(SOURCES));
  sources.sources[0].show = hostile;
  const m = await page(UNNARRATED, { unlock: true, forays: doc });
  m.state.segmentSources = sources;
  await m.ctx.renderForay(UNNARRATED);
  assert.ok(!m.view.innerHTML.includes("<img src=x"), `a raw tag reached the page: ${m.view.innerHTML.match(/.{40}<img src=x.{40}/)}`);
  assert.ok(m.view.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("every in-page href goes through safeUrl: the back key, the From links and 'Try another foray'", () => {
  /* MUTATION: interpolate any of these hrefs without safeUrl -> the app-security census is
     red as well; this pins the three this screen added by name. */
  const src = APP_SRC.slice(APP_SRC.indexOf("function forayFromRowHtml("), APP_SRC.indexOf("function forayRow("));
  assert.ok(/href="\$\{esc\(safeUrl\("#" \+ showRoutePath\(show\.showId\)\)\)\}"/.test(src), "From links");
  const bar = APP_SRC.slice(APP_SRC.indexOf("function forayBarHtml("), APP_SRC.indexOf("function forayFromRowHtml("));
  /* routeLinkAttrs() writes `href="${esc(safeUrl(...))}"` itself (ui/library.js), and sends the old
     Forays address to Yours' Forays chip; the census in app-security.test.js reads it there. */
  assert.ok(/\$\{routeLinkAttrs\("#\/forays"\)\}/.test(bar), "back");
  const un = APP_SRC.slice(APP_SRC.indexOf("function renderForayUnavailable("), APP_SRC.indexOf("async function renderForay("));
  assert.ok(/\$\{routeLinkAttrs\(nextAvailableForayHref\(id\)\)\}/.test(un) && /href="\$\{esc\(safeUrl\("#\/library"\)\)\}"/.test(un), "unavailable keys");
});

test("the stylesheet block reads tokens only, adds no !important, and its one transition is named in the reduced-motion block", () => {
  /* MUTATION 1: a hex colour in the block -> red. MUTATION 2: `!important` -> red. MUTATION 3:
     `transition` on anything but `.fdet-pin`, or drop `.fdet-pin` from the reduced-motion list ->
     red. */
  assert.ok(FORAY_CSS.length > 2000, "fixture: the block was found");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(FORAY_CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "no hex colour");
  assert.ok(!/!important/.test(FORAY_CSS), "no !important");
  const bare = FORAY_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const transitions = [...bare.matchAll(/([^{}]+)\{[^{}]*\btransition\b[^{}]*\}/g)].map((x) => x[1].trim());
  assert.deepStrictEqual(transitions, [".fdet-pin"], "the pin's slide away from the open sheet is the only motion");
  assert.ok(!/@keyframes|\banimation\b/.test(bare), "no animation");
  const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.fdet-pin,/, "named in the one reduced-motion block");
  assert.strictEqual((CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1, "which is the only one");
});

/* ---------------------------------------------------------------- contrast (WCAG AA, both schemes) */

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** `fg` at `alpha` over `bg`, as the browser composites it. */
const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
/** The token values of each shipped scheme, read from the stylesheet (the Cream block, then both
    Bakelite blocks, which must agree). */
function schemeTokens() {
  const light = decl(":root", []);
  const darkOverride = decl(':root[data-theme="dark"]');
  const darkMedia = decl(':root:not([data-theme="light"])', ["@media (prefers-color-scheme: dark)"]);
  for (const k of ["--paper", "--ink", "--ink-2", "--persimmon", "--on-persimmon"]) {
    assert.strictEqual(darkMedia[k], darkOverride[k], `the two dark blocks agree on ${k}`);
  }
  return { Cream: light, Bakelite: darkOverride };
}

test("the pinned key's readout is AA text on the persimmon key, in both schemes", () => {
  /* The readout is 13px/500 mono: normal-size text, so 4.5:1. White at the primitive's .85 over
     Cream's #C93F14 is 4.01:1; axe cannot see it because the key's fill is painted on a z-index:-1
     ::before. This reads the OPACITY the pin actually declares and composites it, so any fade that
     drops a scheme under 4.5 fails here.
     MUTATION: `.fdet-pin .keycap__readout { opacity: .85 }` -> red naming Cream at 4.01; deleting the
     declaration -> red on the first assertion (the primitive's .85 would show through). */
  const pinOpacity = decl(".fdet-pin .keycap__readout").opacity;
  assert.ok(pinOpacity !== undefined, "the pin states its own opacity: the primitive's .85 would otherwise win");
  const alpha = Number(pinOpacity);
  assert.ok(alpha > 0 && alpha <= 1, `opacity ${pinOpacity} is a number`);
  const schemes = schemeTokens();
  for (const [scheme, t] of Object.entries(schemes)) {
    const fill = hexRgb(t["--persimmon"]);
    const r = ratio(over(hexRgb(t["--on-persimmon"]), fill, alpha), fill);
    assert.ok(r >= 4.5, `${scheme}: the readout is ${r.toFixed(2)}:1 on the key (needs 4.5)`);
  }
  /* Harness check: the arithmetic reproduces the reviewer's measurements, or it measures nothing. */
  const cream = schemes.Cream;
  const fill = hexRgb(cream["--persimmon"]);
  assert.ok(Math.abs(ratio(over(hexRgb(cream["--on-persimmon"]), fill, 0.85), fill) - 4.01) < 0.02, "Cream at .85 reads 4.01:1");
  assert.ok(Math.abs(ratio(hexRgb(cream["--on-persimmon"]), fill) - 4.99) < 0.02, "Cream at 1 reads 4.99:1");
});

test("a clip that cannot play keeps its text at full ink; only the swatch fades", () => {
  /* The row is a plain div, not a disabled control, so the show name and why-line are information and
     the inactive-component exemption does not apply: --ink at 60% over Cream's paper is 4.36:1 and
     the --ink-2 sub-line at 60% is 2.70:1. The state is told in words (`.fdet-seg__out`).
     MUTATION: `.fdet-seg.is-out .fdet-seg__row { opacity: .6 }` back -> red on the first assertion;
     `.fdet-seg.is-out { opacity: .6 }` -> red on the second. */
  assert.strictEqual(decl(".fdet-seg.is-out .fdet-seg__row").opacity, undefined, "no dimming on the row that holds the text");
  assert.strictEqual(decl(".fdet-seg.is-out .fdet-sw").opacity, ".6", "the aria-hidden swatch is what fades");
  assert.ok(!rules.some((r) => r.selectors && r.selectors.includes(".fdet-seg.is-out") && r.decls.some((d) => d.prop === "opacity")), "nor the clip as a whole");
  for (const [scheme, t] of Object.entries(schemeTokens())) {
    const paper = hexRgb(t["--paper"]);
    assert.ok(ratio(hexRgb(t["--ink"]), paper) >= 4.5, `${scheme}: the show name is AA on paper`);
    assert.ok(ratio(hexRgb(t["--ink-2"]), paper) >= 4.5, `${scheme}: the sub-line and the plain-words line are AA on paper`);
  }
  /* Nothing else re-dims the row's text through the clip's own classes. */
  for (const sel of [".fdet-seg__text", ".fdet-seg .row__title", ".fdet-seg__sub", ".fdet-seg__out", "body.view-foray .fdet-seg__out"]) {
    const o = rules.filter((r) => r.selectors && r.selectors.includes(sel)).flatMap((r) => r.decls).find((d) => d.prop === "opacity");
    assert.strictEqual(o, undefined, `${sel} carries no opacity`);
  }
});

test("targets: clip rows and votes reach 44px, the keys are the primitives' own", () => {
  /* MUTATION: `.fdet-seg .segrow { min-height: 40px }` or `.fy-thumb { width: 36px }` -> red. */
  const px = (v) => Number(/^(\d+)px$/.exec(v)?.[1]);
  assert.ok(px(decl(".fdet-seg .segrow")["min-height"]) >= 44);
  assert.strictEqual(px(decl(".fdet-seg__row")["min-height"]), 56, "rows are 56");
  const thumb = decl("body.view-foray .fdet .fy-thumb");
  assert.strictEqual(thumb.width, "var(--tap)");
  assert.strictEqual(thumb.height, "var(--tap)");
  assert.strictEqual(thumb["min-width"], "var(--tap)");
  assert.strictEqual(decl(".fdet-from")["min-height"] ?? "56px", "56px", "From rows keep the row-show 56");
  /* The gates' tap-target pass (tools/ui-lab/gates.mjs) found two text links under 44px: the From rows' name
     and the sources block's show name. The first is stretched over its row and a little beyond (a 44px
     square centred on a name near the top of a 56px row would start above it); the second is a 44px box
     that takes one line of room. MUTATION: drop either rule -> red here and in the gate. */
  assert.strictEqual(decl(".fdet-from .row__link::after").inset, "calc(var(--s-1) * -1.5) 0");
  const srcLink = decl(".fdet .fy-src-show .show-link");
  assert.strictEqual(srcLink["min-height"], "var(--tap)");
  assert.match(srcLink["margin-block"], /var\(--lh-body\) - var\(--tap\)/, "and gives the extra height back as negative margin");
  assert.strictEqual(decl(".fdet .fy-src-eps li span").opacity, "1", "the legacy 75% on the clip counts takes --ink-2 under AA on the card");
  assert.strictEqual(decl(".fdet a.keycap").color, "var(--k-ink)", "a key drawn as a link keeps its own ink: 'Try another foray' is white on persimmon, not the page's ink");
  assert.strictEqual(decl(".fdet-sw").width, "24px");
  assert.strictEqual(decl(".fdet-sw").height, "24px");
  const keysSrc = APP_SRC.slice(APP_SRC.indexOf("function forayBarHtml("), APP_SRC.indexOf("function forayFromRowHtml("));
  assert.ok(/size: "sm", variant: "paper"/.test(keysSrc), "share is the primitive's small paper key (44 tall)");
});

test("the page's own copy passes the listener copy lists, says clips and subjects, and has no we/us/our", async () => {
  /* MUTATION: say "segments" in the From row (or "topic" in a why-line) -> red. */
  const strings = ["No narration yet on this one.", "This foray isn't available right now.", "Try another foray", "Yours", "Why today", "From", "Clips",
    "Play", "Resume", "Start over", "Pause", "Nothing to play", "Share this foray", "Back", "Link copied.", "This clip isn't available right now.",
    "Outside your usual subjects — a deliberate change of pace into Food."];
  for (const s of strings) {
    assert.ok(!copy.BANNED.some((re) => re.test(s)), `banned phrase in "${s}"`);
    assert.ok(!/\b(we|us|our)\b/i.test(s), `we/us/our in "${s}"`);
    assert.ok(!/\btopics?\b/i.test(s), `"topic" in "${s}": the word is subject`);
    assert.ok(!copy.INTERNAL_VOCABULARY.some((re) => re.test(s)), `pipeline vocabulary in "${s}"`);
  }
  const m = await page(UNNARRATED, { unlock: true });
  const visible = [...m.html.matchAll(/>([^<>]{2,})</g)].map((x) => x[1]);
  for (const s of visible) assert.ok(!/\bsegments?\b/i.test(s), `the page says segment: "${s}"`);
});

/* ============================================================ 9. the harness */

test("the harness: four steps appended to `returning` after the existing ones, and the screen map points at them with band, key and rows", () => {
  /* MUTATION 1: move a step before `...coreRoutes(...)` -> the order assertion is red. MUTATION 2:
     rename a step in states.mjs or screens.json -> red (fidelity.mjs would exit 2 for it too).
     MUTATION 3: drop the band/primary/rows regions from the foray row. */
  const states = read("tools/ui-lab/lib/states.mjs");
  const returning = states.slice(states.indexOf('id: "returning"'), states.indexOf('id: "player"'));
  const labels = [...returning.matchAll(/label: "(foray[a-z-]*)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(labels, ["foray-progress", "foray-done", "foray-unnarrated", "foray-unavailable"]);
  assert.ok(returning.indexOf("...coreRoutes(fx, { entities: true })") < returning.indexOf('label: "foray-progress"'), "appended, never reordered");
  const map = readJson("docs/redesign-2026/directions/tactile/screens.json").screens;
  for (const id of ["foray", "foray-progress", "foray-done", "foray-unnarrated"]) {
    assert.deepStrictEqual(Object.keys(map[id].regions), ["header", "band", "primary", "rows", "tabBar"], id);
    assert.strictEqual(map[id].regions.band.app, ".fdet-well");
    assert.strictEqual(map[id].regions.primary.app, ".fdet-pin .keycap");
  }
  assert.deepStrictEqual(Object.keys(map["foray-unavailable"].regions), ["header", "band", "primary", "tabBar"]);
  for (const [id, step] of [["foray", "foray"], ["foray-progress", "foray-progress"], ["foray-done", "foray-done"], ["foray-unnarrated", "foray-unnarrated"], ["foray-unavailable", "foray-unavailable"]]) {
    assert.strictEqual(map[id].app.state, "returning");
    assert.strictEqual(map[id].app.step, step);
    assert.ok(step === "foray" || labels.includes(step), `${step} is a step the harness has`);
  }
  assert.ok(states.includes('const published = fx.forays.find((f) => f.status === "published");'), "the base `foray` step shoots a Foray the page opens (the first in the file is a draft)");
});
