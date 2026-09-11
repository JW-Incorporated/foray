/* U-03 (docs/ui-transition-plan.md): Home v2 over the REAL data files.
 *
 * The card's first acceptance line is "at inset 0 and 59 px, all four
 * sections render with real data". test/home-v2.test.js deliberately runs on
 * a synthetic seed (faster, independent of today's pool) and
 * test/home-layout.test.js evaluates `.hv2-home`'s CSS at both insets — but
 * nothing rendered Home v2 over the committed data/*.json until this suite
 * (audit, 2026-09-10). This boots app.js the way init() does — the same ten
 * documents, `loadInterests()` over the real taxonomy — with the Foray bridge
 * built from the REAL pure modules `player/client.js` composes
 * (`player/foray-resolve.js` for listForays/resolve, `player/segment-strip.js`
 * for the strip; client.js itself needs `window` at import time, which is the
 * only reason it is not imported whole), so every card here is one the live
 * site would draw today. NO DATA IS FAKED OR ADDED.
 *
 * WHAT THIS PROVES, in order:
 *  1. The greeting, Forays for you, Playlists for you and Episodes for you all
 *     render over the real data, in the card's order. "Jump back in" is the
 *     one section that does NOT render here, by design: a fresh profile has
 *     nothing to resume and the section omits itself rather than showing an
 *     empty rail (jumpBackInV2Html) — asserted, not skipped.
 *  2. At inset 0 and at inset 59 px the same sections render (nothing in
 *     app.js reads the inset — the tab bar's reservation is CSS), and at each
 *     inset the committed stylesheet's content reservation under Home is at
 *     least the tab bar's own height at that inset, evaluated numerically
 *     (var() and env() substituted, calc() summed), so the last section is
 *     never under the bar. Not a grep for "env(": a bare px value fails at 59.
 *  3. THE FLOOR over real data, "Episodes for you": a visible Stretch tag and
 *     its bridge line on 20 consecutive renders of a fresh profile (real
 *     Math.random, real pool, real default weights).
 *  4. THE FLOOR over real data, "Forays for you": CANNOT be satisfied today,
 *     and this suite says so rather than faking it. data/forays.json carries
 *     ONE published Foray (its three drafts are not listable without their
 *     unlock key), so pickWithStretchFloor() sees a single subject and has no
 *     lower tier to draw a stretch pick from. Its documented fallback —
 *     "ordinary top-ranked-first ... never render a fake stretch label over an
 *     ordinary pick" — is what is asserted: exactly one Foray card, carrying
 *     its real SegmentStrip, NO Stretch tag, NO bridge line.
 *  5. The fixture fact behind 4, pinned as a tripwire: the day a second
 *     published Foray on another subject root lands, this fails loudly and
 *     test 4 must flip to asserting the real floor (mirror test 3).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same flat-by-id node:vm DOM stub test/home-v2.test.js uses
 * (see that file's header for why it is duplicated rather than imported).
 * The ten documents are parsed once and shared read-only across mounts:
 * app.js's fullPool() snapshots every item it reads rather than mutating it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const DATA = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));

process.on("unhandledRejection", () => {});

/* The ten documents init() fetches, keyed by the state field each lands in. */
const DOCS = {
  session: DATA("session.json"),
  validated: DATA("validated-links.json"),
  taxonomy: DATA("taxonomy.json"),
  discover: DATA("discover.json"),
  semantic: DATA("semantic-index.json"),
  itemTags: DATA("item-tags.json"),
  forays: DATA("forays.json"),
  segments: DATA("segments.json"),
  segmentSources: DATA("segment-sources.json"),
  catalog: DATA("catalog-client.json"),
};

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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount() {
  const store = new Map();
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
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
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

/** The bridge app.js reads as `window.ForayPlayer`, assembled from the real
    modules player/client.js composes for these four calls (its `resolve` is
    findForay + resolveForay over indexSegments/indexSources, verbatim).
    `applyStripGrow` measures real layout and `forayResumeList` reads a real
    profile's resume rows; a flat stub has neither, and a fresh profile has
    nothing to resume, so both are the empty case — which is a real state,
    not a shortcut. */
async function realBridge() {
  const fr = await import(pathToFileURL(path.join(ROOT, "player", "foray-resolve.js")).href);
  const strip = await import(pathToFileURL(path.join(ROOT, "player", "segment-strip.js")).href);
  return {
    listForays: (doc, { unlocked = [] } = {}) => fr.listableForays(doc, { unlocked }),
    resolve: (doc, { id, segmentsDoc, sourcesDoc, unlocked = [] } = {}) => {
      const foray = fr.findForay(doc, id, { unlocked });
      if (!foray) return null;
      return fr.resolveForay(foray, { segments: fr.indexSegments(segmentsDoc), sources: fr.indexSources(sourcesDoc) });
    },
    segmentStripHtml: strip.segmentStripHtml,
    applyStripGrow() {},
    forayResumeList: () => [],
  };
}

/** A fresh profile booted over the real documents, exactly as init() leaves
    state before its first route(): every document in place, interests seeded
    from the real taxonomy, card slots NOT yet dealt (renderHomeV2 deals them). */
async function mountReal(bridge) {
  const m = mount();
  m.ctx.ForayPlayer = bridge || await realBridge();
  Object.assign(m.state, DOCS);
  m.ctx.loadInterests();
  m.evalIn("state.ready = true");
  return m;
}

const SECTIONS = ["hv2-greeting", "hv2-forays", "hv2-playlists", "hv2-episodes"];
const forayRoot = (f) => (f.topic || "other").split("/")[0];

/* ==================================================================== */
/* 1. ALL SECTIONS RENDER OVER THE REAL DATA, IN ORDER                   */
/* ==================================================================== */

test("over the real data files the greeting, Forays for you, Playlists for you and Episodes for you render in order; Jump back in omits itself on a fresh profile", async () => {
  /* MUTATION: return "" from foraysForYouHtml() (or any other section) ->
     that section's index is -1 and the failure names it. MUTATION 2: make
     jumpBackInV2Html() emit its <section> with nothing to resume -> the
     "omits itself" assertion fails. */
  const m = await mountReal();
  m.ctx.renderHome();
  const html = m.view();
  const at = Object.fromEntries(SECTIONS.map((cls) => [cls, html.indexOf(cls)]));
  for (const cls of SECTIONS) assert.ok(at[cls] !== -1, `${cls} did not render over the real data`);
  assert.ok(
    at["hv2-greeting"] < at["hv2-forays"] && at["hv2-forays"] < at["hv2-playlists"] && at["hv2-playlists"] < at["hv2-episodes"],
    `sections out of order: ${JSON.stringify(at)}`
  );
  assert.strictEqual(html.indexOf("hv2-jbi"), -1,
    "Jump back in must omit itself on a fresh profile (nothing to resume) rather than render an empty rail");
  assert.strictEqual(m.state.cardSlots.length, 4, "buildCards() deals four subject slots from the real pool");
  assert.ok((html.match(/class="hv2-foray-card/g) || []).length >= 1, "at least one real Foray card renders");
  assert.ok(html.includes("Generated for you"),
    "Playlists for you over the real pool carries generated playlists (a fresh profile has no own playlists to show first)");
});

/* ==================================================================== */
/* 2. INSET 0 AND INSET 59 PX                                            */
/* ==================================================================== */

/** The last declaration of `prop` across every unconditional `selector {}`
    rule in the sheet (later wins), so a token block and a layout block for
    the same selector cascade the way a browser cascades them. */
function declOf(selector, prop) {
  const sel = selector.replace(/[.[\]]/g, "\\$&");
  const blocks = [...CSS.matchAll(new RegExp(`(?:^|\\n)${sel}\\s*\\{([^}]*)\\}`, "g"))];
  assert.ok(blocks.length, `styles.css has no \`${selector} {\` rule`);
  let last = null;
  for (const b of blocks) {
    for (const d of b[1].matchAll(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+);`, "g"))) last = d[1].trim();
  }
  assert.ok(last, `\`${selector}\` declares no ${prop}`);
  return last;
}

/** Pixels for a length expression at a given safe-area inset: `var(--tab-bar-h)`
    from :root, `env(safe-area-inset-bottom[, 0])` = the inset, `calc(a + b)`
    summed. Any term it does not recognise is a failure, never a guess. */
function pxAt(expr, inset) {
  const tabH = /--tab-bar-h:\s*([\d.]+)px/.exec(CSS);
  assert.ok(tabH, "styles.css defines --tab-bar-h");
  const e = expr
    .replace(/var\(--tab-bar-h\)/g, `${tabH[1]}px`)
    .replace(/env\(safe-area-inset-bottom(?:,\s*0)?\)/g, `${inset}px`);
  const inner = (/^calc\((.*)\)$/.exec(e.trim()) || [null, e])[1];
  return inner.split("+").reduce((sum, term) => {
    const px = /^\s*(-?[\d.]+)px\s*$/.exec(term);
    assert.ok(px, `unrecognised term "${term}" in "${expr}" — extend pxAt() rather than let it guess`);
    return sum + Number(px[1]);
  }, 0);
}

test("at inset 0 and at inset 59 px the same sections render, and the stylesheet reserves at least the tab bar's height under them at each inset", async () => {
  /* The render is inset-independent by construction (app.js never reads an
     inset), so the section assertion is the same markup twice; what differs
     per inset is the geometry the committed stylesheet resolves to.
     MUTATION: change `body.ui-v2`'s padding-bottom to a bare `56px` (drop
     env(safe-area-inset-bottom)) -> at inset 59 the reservation is 56 and the
     bar is 115; this fails by 59px. At inset 0 both are 56 and it passes —
     which is why both insets are asserted. */
  const m = await mountReal();
  m.ctx.renderHome();
  const html = m.view();
  for (const inset of [0, 59]) {
    for (const cls of SECTIONS) assert.ok(html.includes(cls), `inset ${inset}px: ${cls} must render`);
    const reserved = pxAt(declOf("body.ui-v2", "padding-bottom"), inset);
    const bar = pxAt(declOf(".tab-bar", "height"), inset);
    assert.ok(bar > inset, `inset ${inset}px: the bar's own box (${bar}px) must exceed the inset it pads`);
    assert.ok(reserved >= bar,
      `inset ${inset}px: Home reserves ${reserved}px under its content but the tab bar is ${bar}px tall — the last section would sit under the bar`);
  }
});

/* ==================================================================== */
/* 3. THE FLOOR OVER REAL DATA — EPISODES FOR YOU, 20 RENDERS            */
/* ==================================================================== */

test("THE FLOOR over real data: Episodes for you carries a visible Stretch tag with its bridge line on 20 consecutive renders of a fresh profile", async () => {
  /* MUTATION: in buildCards(), set `stretchBranch` to null -> no slot has
     role "stretch", miniCardV2 appends no bridge line, and run 0 fails.
     Real Math.random throughout: the stretch slot is structural (a branch
     outside the top interest tier, chosen deliberately), not a jitter
     outcome, so 20 unseeded renders is the honest form of "20 seeded
     renders" here. */
  const bridge = await realBridge();
  for (let i = 0; i < 20; i++) {
    const m = await mountReal(bridge);
    m.ctx.renderHome();
    const html = m.view();
    const episodes = html.slice(html.indexOf("hv2-episodes"));
    assert.ok(/class="mc-stretch"[^>]*>Stretch</.test(episodes), `run ${i}: Episodes for you must carry a visible Stretch tag over the real pool`);
    assert.ok(episodes.includes('class="hv2-bridge">'), `run ${i}: the stretch pick must carry its bridge line`);
    const stretchSlots = m.state.cardSlots.filter((sl) => sl.role === "stretch");
    assert.strictEqual(stretchSlots.length, 1, `run ${i}: exactly one of the four slots is the stretch pick`);
  }
});

/* ==================================================================== */
/* 4-5. THE FLOOR OVER REAL DATA — FORAYS FOR YOU: THE DOCUMENTED FALLBACK */
/* ==================================================================== */

test("THE FLOOR over real data, Forays for you: with one published Foray there is no lower tier, so the documented fallback renders — one card with its real strip, no Stretch tag, no fake bridge line", async () => {
  /* This is the acceptance line that CANNOT be met on today's data, stated
     rather than faked (see the header and test 5).
     MUTATION: in pickWithStretchFloor, fall back to `branchAvg[0].b` when the
     lower tier is empty -> the single Foray is labelled Stretch over an
     ordinary pick and the "no Stretch label" assertion fails.
     MUTATION 2: return "" from foraysForYouHtml() when stretchIndex is -1 ->
     the section vanishes and the card count is 0. */
  const m = await mountReal();
  m.ctx.renderHome();
  const html = m.view();
  const section = html.slice(html.indexOf("hv2-forays"), html.indexOf("hv2-playlists"));
  const listable = m.ctx.forayCards();
  assert.strictEqual(listable.length, 1, "fixture (pinned by test 5): exactly one listable Foray today");
  assert.strictEqual((section.match(/class="hv2-foray-card/g) || []).length, 1, "the one published Foray renders as one card");
  assert.ok(section.includes("fy-strip"), "the card carries its SegmentStrip, resolved from the real segments/sources documents");
  assert.ok(!section.includes("hv2-stretch-tag"), "no Stretch label may be painted over an ordinary pick when there is no lower tier");
  assert.ok(!section.includes("hv2-bridge"), "no bridge line without a stretch pick");
  const floor = m.ctx.pickWithStretchFloor(listable, { branchFn: forayRoot, scoreFn: () => 0.5, take: 4 });
  assert.strictEqual(floor.stretchIndex, -1,
    "pickWithStretchFloor reports no stretch pick (its documented fallback), which is exactly what the section rendered from");
});

test("FIXTURE FACT (tripwire): data/forays.json lists exactly one Foray for a fresh visitor, on the `business` root — flip test 4 to the real floor when this changes", async () => {
  /* Not a behaviour test. The day a second published Foray on a different
     subject root lands, "Forays for you" gains a lower tier and the floor
     becomes satisfiable over real data: test 4 must then assert a Stretch tag
     + bridge line (mirror test 3) instead of the fallback.
     MUTATION: publish a second Foray on another root -> this fails naming the
     new count and roots. */
  const bridge = await realBridge();
  const listable = bridge.listForays(DOCS.forays, { unlocked: [] });
  const roots = [...new Set(listable.map(forayRoot))];
  const drafts = (DOCS.forays.forays || []).filter((f) => f.status !== "published").length;
  assert.deepStrictEqual({ listable: listable.length, roots, ids: listable.map((f) => f.id) },
    { listable: 1, roots: ["business"], ids: ["capital-types-1"] },
    `the published-Foray fixture changed (${drafts} draft(s) besides) — upgrade test 4 from the fallback to the real Stretch floor`);
});
