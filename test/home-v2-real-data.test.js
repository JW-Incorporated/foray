/* U-03 (docs/ui-transition-plan.md): Home v2 over the REAL data files — REWRITTEN for Today
 * (Redesign 2026, ambient direction), which overturns "Home section order and content" by name.
 *
 * The card’s first acceptance line is "at inset 0 and 59 px, all sections render with real
 * data". test/home-v2.test.js deliberately runs on a synthetic seed (faster, independent of
 * today’s pool); nothing rendered Home over the committed data/*.json until this suite
 * (audit, 2026-09-10). This boots app.js the way init() does — the same ten documents,
 * `loadInterests()` over the real taxonomy — with the Foray bridge built from the REAL pure
 * modules `player/client.js` composes (`player/foray-resolve.js` for listForays/resolve,
 * `player/segment-strip.js` for the tally; client.js itself needs `window` at import time, which
 * is the only reason it is not imported whole), so every row here is one the live site would draw
 * today. NO DATA IS FAKED OR ADDED.
 *
 * WHAT THIS PROVES, in order:
 *  1. A fresh profile’s Today renders header, hero (the first pick: a first run), Today’s picks,
 *     Playlists for you and Off your path over the real data, in the direction’s order. "Keep
 *     listening" is the one section that does NOT render here, by design: a fresh profile has
 *     nothing mid-listen and the section omits itself rather than showing an empty row.
 *  2. At inset 0 and at inset 59 px the same sections render (nothing in app.js reads the inset —
 *     the tab bar’s reservation is CSS), and at each inset the committed stylesheet’s content
 *     reservation under Home is at least the tab bar’s own height at that inset, evaluated
 *     numerically (var() and env() substituted, calc() summed), so the last section is never
 *     under the bar. Not a grep for "env(": a bare px value fails at 59.
 *  3. THE FLOOR over real data, "Today’s picks": a Stretch card with its bridge line, neither
 *     first nor last, on 20 consecutive renders of a fresh profile (real Math.random, real pool,
 *     real default weights) — including the first-run list, which starts at the SECOND pick.
 *  4. The hero of a returning profile is a real, resolvable Foray (never the floor’s stretch
 *     Foray); a fresh profile’s hero is an episode.
 *  5. The precondition behind 1 and 4: something is listable, and only published Forays are.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same flat-by-id node:vm DOM stub test/home-v2.test.js uses
 * (see that file’s header for why it is duplicated rather than imported).
 * The ten documents are parsed once and shared read-only across mounts:
 * app.js’s fullPool() snapshots every item it reads rather than mutating it.
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
  runAppSource(APP_SRC, ctx);

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
    stripTally: strip.stripTally,
    fmtSpan: fr.fmtSpan,
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

const SECTIONS = ['class="td-head"', 'class="td-hero"', 'aria-label="Today\'s picks"', 'aria-label="Playlists for you"', 'aria-label="Off your path"'];
const forayRoot = (f) => (f.topic || "other").split("/")[0];

/* ==================================================================== */
/* 1. ALL SECTIONS RENDER OVER THE REAL DATA, IN ORDER                   */
/* ==================================================================== */

test("over the real data files a fresh profile's Today renders header, hero, picks, Playlists for you and Off your path in order; Keep listening omits itself", async () => {
  /* MUTATION: return "" from todayOffPath's section (or any other section) -> that section's index
     is -1 and the failure names it. MUTATION 2: make todayKeepEntry return an entry for a fresh
     profile -> the "omits itself" assertion fails. */
  const m = await mountReal();
  m.ctx.renderHome();
  const html = m.view();
  const at = SECTIONS.map((needle) => html.indexOf(needle));
  SECTIONS.forEach((needle, i) => assert.ok(at[i] !== -1, `${needle} did not render over the real data`));
  assert.ok(at.every((v, i) => i === 0 || at[i - 1] < v), `sections out of order: ${JSON.stringify(at)}`);
  assert.strictEqual(html.indexOf('aria-label="Keep listening"'), -1,
    "Keep listening must omit itself on a fresh profile (nothing mid-listen) rather than render an empty row");
  assert.strictEqual(m.state.cardSlots.length, 4, "buildCards() deals four subject slots from the real pool");
  assert.ok(html.includes("Generated for you"),
    "Playlists for you over the real pool carries generated playlists (a fresh profile has no own playlists to show first)");
  const off = html.slice(html.indexOf('aria-label="Off your path"'));
  assert.ok((off.match(/class="raised td-row/g) || []).length >= 2, "Off your path draws two or three rows from the real pool");
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
/* 3. THE FLOOR OVER REAL DATA — TODAY'S PICKS, 20 RENDERS               */
/* ==================================================================== */

test("THE FLOOR over real data: Today's picks carry a Stretch card with its bridge line, neither first nor last, on 20 consecutive renders of a fresh profile", async () => {
  /* MUTATION: in buildCards(), set `stretchBranch` to null -> no slot has role "stretch", the picks
     carry no Stretch card and run 0 fails. MUTATION 2: in todayPicks, drop the `at` rule so the
     stretch is spliced at index 0 -> the position assertion fails (after the first-run hero is
     removed it is index 0 only if the list is rebuilt wrongly).
     Real Math.random throughout: the stretch slot is structural (a branch outside the top interest
     tier, chosen deliberately), not a jitter outcome, so 20 unseeded renders is the honest form of
     "20 seeded renders" here. */
  const bridge = await realBridge();
  for (let i = 0; i < 20; i++) {
    const m = await mountReal(bridge);
    m.ctx.renderHome();
    const html = m.view();
    const list = html.slice(html.indexOf('aria-label="Today\'s picks"'), html.indexOf('aria-label="Playlists for you"'));
    const cards = [...list.matchAll(/<article class="raised (?:ag-stretch-card td-stretch|td-row)[^"]*"/g)].map((x) => /td-stretch/.test(x[0]));
    assert.ok(cards.length >= 4 && cards.length <= 6, `run ${i}: four to six picks (${cards.length})`);
    assert.strictEqual(cards.filter(Boolean).length, 1, `run ${i}: exactly one Stretch card`);
    assert.ok(!cards[0] && !cards[cards.length - 1], `run ${i}: it is neither first nor last`);
    assert.ok(list.includes('class="t-why td-bridge">'), `run ${i}: the stretch pick must carry its bridge line`);
    const stretchSlots = m.state.cardSlots.filter((sl) => sl.role === "stretch");
    assert.strictEqual(stretchSlots.length, 1, `run ${i}: exactly one of the four slots is the stretch pick`);
  }
});

/* ==================================================================== */
/* 4. THE HERO: A REAL FORAY FOR A RETURNING LISTENER                     */
/* ==================================================================== */

test("a returning profile's hero is a real listable Foray with its shows' collage; a fresh profile's hero is an episode", async () => {
  /* MUTATION: drop the `firstRun ? null :` guard on todayForayHero -> the fresh profile's hero is a
     Foray. MUTATION 2: return null from todayForayHero -> the returning hero is an episode and the
     collage/route assertions fail. */
  const bridge = await realBridge();
  const fresh = await mountReal(bridge);
  fresh.ctx.renderHome();
  assert.ok(!/<a class="td-hero-art" href="#\/foray\//.test(fresh.view()), "a first run leads with a pick, not a Foray");
  assert.ok(/<a class="td-hero-art" href="#\/episode\//.test(fresh.view()), "the first-run hero is an episode");

  const m = await mountReal(bridge);
  m.store.set("cp_history", JSON.stringify(["something-played"]));
  m.ctx.renderHome();
  const html = m.view();
  const listable = m.ctx.forayCards();
  const hero = /<a class="td-hero-art" href="#\/foray\/([^"]+)"/.exec(html);
  assert.ok(hero, "a returning profile's hero is a Foray");
  assert.ok(listable.some((f) => encodeURIComponent(f.id) === hero[1]), "and a listable one (published, for a visitor who asked for none)");
  assert.match(html, /class="ag-collage ag-collage-160 c[1-4]/, "its collage is the shows' art");
  assert.match(html, /\d+ shows? · /, "its meta says how many shows and how long");
});

test("the hero is never the floor's stretch Foray", async () => {
  /* The floor reserves a Foray slot for a subject outside the listener's top tier (D1). That Foray is
     a stretch, not "today's". MUTATION: delete `if (i === pick.stretchIndex) continue;` in
     todayForayHero -> the hero is picks[0], the stretch one. */
  const bridge = await realBridge();
  const m = await mountReal(bridge);
  m.store.set("cp_history", JSON.stringify(["something-played"]));
  const real = m.ctx.forayCards().slice(0, 2);
  assert.ok(real.length >= 2 || bridge.listForays(DOCS.forays, { unlocked: [] }).length >= 1, "premise: a real Foray to stand in");
  const [a, b] = real.length >= 2 ? real : [real[0], real[0]];
  m.ctx.foraysForYouPicks = () => ({ picks: [a, b], stretchIndex: 0, drafts: [] });
  const hero = m.ctx.todayForayHero();
  assert.ok(hero, "a hero still resolves");
  if (real.length >= 2) assert.strictEqual(hero.id, b.id, "and it is the second pick, not the stretch one");
  m.ctx.foraysForYouPicks = () => ({ picks: [a], stretchIndex: 0, drafts: [] });
  assert.strictEqual(m.ctx.todayForayHero(), null, "with only a stretch Foray to offer there is no Foray hero (an episode leads instead)");
});

test("the real data lists at least one Foray for a fresh visitor, so the Forays-for-you tests above are about something", async () => {
  /* This was the tripwire that pinned WHICH Foray is published and on which
     root (see test 4 for why it went). What remains is the precondition: with
     nothing listable the section omits itself and tests 1, 2 and 4 would be
     asserting on an empty slice. Which Foray is published is pinned once, in
     tools/foray/check-forays.test.mjs — publishing is a founder action.
     MUTATION: set every Foray in data/forays.json to "draft" -> red here. */
  const bridge = await realBridge();
  const listable = bridge.listForays(DOCS.forays, { unlocked: [] });
  assert.ok(listable.length >= 1, "data/forays.json lists no Foray for a fresh visitor");
  for (const f of listable) assert.strictEqual(f.status, "published", `${f.id} is listed to a fresh visitor without being published`);
});
