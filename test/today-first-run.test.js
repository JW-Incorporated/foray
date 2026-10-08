/* Today, first run (Redesign 2026, Tactile, screen "home-first-run";
 * BUILD-PLAN 2.6; DIRECTION.md "First run on Today").
 *
 * A first run is OBSERVED, never declared (product principle 2): nothing played
 * (`cp_history` empty) and nothing to resume. What changes on Today then:
 *
 *  1. No Resume card; the hero's why-line slot carries the first-run line, and
 *     "Because you follow" is nowhere in the rendered DOM.
 *  2. Also today's why-lines are about the SUBJECT: none says "your usual" or
 *     names a show (a first-run listener has neither).
 *  3. The bridge card's known end is a subject tile, not artwork; the sentence
 *     does not claim usual subjects; the arc and both dots still render.
 *  4. The gauge still renders, with the same copy: the floor is kept, not earned.
 *  5. The app-side harness state the screen is shot in exists (`empty` / `home`)
 *     and `screens.json` points at the markup this build actually draws.
 *
 * HARNESS: the flat-by-id node:vm DOM stub test/home-v2.test.js uses, duplicated
 * rather than imported (a test file that requires another registers its tests).
 * The audit of that harness: it starts with empty storage, which IS a first run,
 * so every "listened" case below seeds `cp_history` explicitly; the fake is no
 * more forgiving than the app here (the app reads the same key).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { rule } = require("./helpers/tactile-primitives.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
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
  return { ctx, evalIn, state: evalIn("state"), view: () => byId.get("view").innerHTML };
}

/* Two top slots and a Stretch slot. The episodes carry artwork on purpose: a
   first run must still draw a subject tile, not the known end's artwork, so a
   fixture without artwork could not tell the two apart (the fake must not be
   more forgiving than the thing it stands for). */
function todayMount({ listened = false } = {}) {
  const m = mount({ seed: listened ? { cp_history: JSON.stringify(["earlier-listen"]) } : {} });
  m.state.catalog = { shows: [] };
  m.state.taxonomy = { nodes: [
    { id: "engineering", parent: null, label: "Engineering", weight: 0.9 },
    { id: "comedy", parent: null, label: "Comedy", weight: 0.5 },
    { id: "history", parent: null, label: "History", weight: 0.5 },
  ] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9, comedy: 0.1 };
  m.state.discover = { items: [] };
  const ep = (id, title, show, topic) => ({ id, title, show, duration_min: 30, artwork_url: "https://img.test/" + id + ".jpg", topics: [topic], hook: `${title}, in one line.`, audio_url: `https://cdn.test/${id}.mp3` });
  const slot = (branch, role, item) => ({ branch, role, item, items: [item] });
  m.state.cardSlots = [
    slot("engineering", "top", ep("ep-top", "Fusion 101", "Engineering Weekly", "engineering")),
    slot("history", "top", ep("ep-hist", "The long view", "History Hour", "history")),
    slot("comedy", "stretch", ep("ep-stretch", "A comedy bit", "Laugh Hour", "comedy")),
  ];
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [{ id: "foray-eng", title: "Deep Fusion", topic: "engineering/energy-fusion", status: "published", summary: "Fusion, from the magnets to the money." }],
    forayResumeList: () => [],
    resolve: (doc, { id }) => ({ id, title: id, totalSec: 1320, playable: [{ show: "Engineering Weekly", kind: "tape" }, { show: "Founders Weekly", kind: "tape" }] }),
    stripModel: () => ({ segments: [
      { kind: "segment", show: "Engineering Weekly", sourceKey: "a", lengthSec: 600 },
      { kind: "segment", show: "Founders Weekly", sourceKey: "b", lengthSec: 700 },
    ] }),
    stripTally: () => ({ clips: 2, bridges: 0, shows: 2, totalSec: 1320, estimated: false }),
    fmtSpan: (sec) => `${Math.round(sec / 60)} min`,
    segmentStripHtml: () => "",
    applyStripGrow: () => {},
  };
  return m;
}

const SECTION = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);
const FIRST_RUN_LINE = "4a starts with wide bets. Each listen narrows the dial.";

/* ==================================================================== */
/* 1. NO RESUME, THE FIRST-RUN LINE, NO "BECAUSE YOU FOLLOW"             */
/* ==================================================================== */

test("first run: no Resume card, the first-run line holds the why-line slot, and 'Because you follow' is nowhere in the DOM", () => {
  /* MUTATION: render a why-line "Because you follow Engineering Weekly." beside
     (or instead of) the first-run line in todayHeroHtml or firstRunAlsoWhy ->
     the absence assertion fails. MUTATION 2: pass `firstRun: false` to
     todayHeroHtml in renderHomeV2 -> the hero line is the foray's summary and
     the line assertion fails. */
  const m = todayMount();
  m.ctx.renderHome();
  const html = m.view();
  assert.strictEqual(html.indexOf("today-resume"), -1, "nothing to resume on a first run");
  const hero = SECTION(html, "today-hero", "today-also");
  const whys = [...hero.matchAll(/class="today-hero__why">([^<]*)</g)].map((x) => x[1]);
  assert.deepStrictEqual(whys, [FIRST_RUN_LINE], "the line is the hero's only why-line");
  assert.doesNotMatch(html, /Because you follow/i, "a first-run listener has followed nothing");
  assert.doesNotMatch(html, /Fusion, from the magnets to the money/, "the foray's own summary does not sit beside the line");
});

/* ==================================================================== */
/* 2. ALSO TODAY'S WHY-LINES ARE ABOUT THE SUBJECT                       */
/* ==================================================================== */

test("first run: every Also today why-line is about its subject, within 18 words, with no 'your usual' and no show named", () => {
  /* MUTATION: in todayAlsoHtml, pass `s.item.hook` regardless of firstRun ->
     the rows carry "Fusion 101, in one line." and the subject match fails.
     MUTATION 2: make firstRunAlsoWhy return `Because you follow ${show}` or
     "Outside your usual subjects" -> the your-usual / show-name assertions fail. */
  const m = todayMount();
  m.ctx.renderHome();
  const also = SECTION(m.view(), "today-also", "today-playlists");
  const whys = [...also.matchAll(/<p class="row__why">([^<]*)<\/p>/g)].map((x) => x[1]);
  assert.strictEqual(whys.length, 2, "both top rows say why (raw, not a truncated view)");
  const subjects = ["Engineering", "History"];
  whys.forEach((line, i) => {
    assert.ok(line.startsWith(`A first look at ${subjects[i]}`), `row ${i} is about its subject: "${line}"`);
    assert.doesNotMatch(line, /your usual/i);
    for (const show of ["Engineering Weekly", "History Hour", "Laugh Hour"]) assert.ok(!line.includes(show), `"${line}" names ${show}`);
    assert.ok(line.split(/\s+/).length <= 18, `within the why-line ceiling: "${line}"`);
  });
});

test("a listener who HAS listened keeps the episode's own hook as the why-line, and the usual-subjects bridge", () => {
  /* The other half of the switch: without it the first-run branch could be
     unconditional and every test above would still pass.
     MUTATION: make todayIsFirstRun return true always -> this fails. */
  const m = todayMount({ listened: true });
  m.ctx.renderHome();
  const html = m.view();
  assert.match(html, /<p class="row__why">Fusion 101, in one line\.<\/p>/);
  assert.match(html, /Outside your usual subjects: from Engineering into Comedy, on purpose\./);
  assert.doesNotMatch(html, /art-frame--subject/, "known artwork, not a subject tile, once there is something known");
  assert.doesNotMatch(html, />4a starts with wide bets/);
});

/* ==================================================================== */
/* 3. THE BRIDGE'S KNOWN END IS A SUBJECT TILE                           */
/* ==================================================================== */

test("first run: the bridge's known slot is a subject tile with no image, the arc and both dots still render, and the sentence claims no usual subjects", () => {
  /* The fixture's known item HAS artwork, so a build that forgot to drop it
     would draw an <img> in the tile and fail the no-image assertion.
     MUTATION: in todayBridgeData, set knownArtwork from the known item even on
     a first run (drop the `known && !firstRun` guard) -> the tile
     holds an <img>. MUTATION 2: remove a bridge__dot from the card -> the dot
     count fails. MUTATION 3: use stretchBridgeSentence on a first run -> the
     your-usual assertion fails. */
  const m = todayMount();
  m.ctx.renderHome();
  const bridge = /<article class="card bridge"[\s\S]*?<\/article>/.exec(m.view())[0];
  const arc = /<div class="bridge__arc">([\s\S]*?)<\/div>/.exec(bridge)[1];
  const frames = arc.split(/(?=<span class="art-frame )/).filter((x) => x.startsWith("<span class=\"art-frame "));
  assert.strictEqual(frames.length, 2, "a known end and the stretch pick");
  assert.match(frames[0], /art-frame--subject/, "the known end is a subject tile");
  assert.doesNotMatch(frames[0], /<img/, "no artwork exists yet");
  assert.match(frames[0], /art-frame__initials[^>]*>EN</, "it is lettered with the subject's code");
  assert.doesNotMatch(frames[1], /art-frame--subject/, "the stretch end is the pick's own tile");
  assert.match(frames[1], /<img/, "and it keeps its artwork");
  assert.match(bridge, /class="bridge__path"/, "the arc");
  assert.strictEqual((bridge.match(/class="bridge__dot bridge__dot--[ab]"/g) || []).length, 2, "both dots");
  const sentence = /class="bridge__sentence">([^<]*)</.exec(bridge)[1];
  assert.doesNotMatch(sentence, /your usual|because you/i);
  assert.match(sentence, /Engineering/);
  assert.match(sentence, /Comedy/, "both ends are named by subject");
  assert.ok(sentence.split(/\s+/).length <= 16, `within the bridge ceiling: "${sentence}"`);
});

test("the subject tile is the Stretch tag's own colour pair, so it needs no new contrast pair", () => {
  /* MUTATION: change the rule's colour to --ink-3 or its fill to --paper-2 ->
     red (the pair is the one ui-tokens-dial already proves at 4.5:1). */
  const r = rule(".art-frame--subject");
  assert.match(r, /background:\s*var\(--ultramarine-soft\)/);
  assert.match(r, /color:\s*var\(--ultramarine\)/);
});

/* ==================================================================== */
/* 4. THE GAUGE IS KEPT, NOT EARNED                                      */
/* ==================================================================== */

test("first run: the gauge renders with exactly the copy it has for a returning listener", () => {
  /* MUTATION: in renderHomeV2 draw the gauge only when `!firstRun` (hide it on
     empty history) -> both renders differ and the first fails. */
  const first = todayMount();
  first.ctx.renderHome();
  const gaugeOf = (html) => (/<figure class="gauge"[\s\S]*?<\/figure>/.exec(html) || [""])[0];
  const g1 = gaugeOf(first.view());
  assert.ok(g1, "the gauge renders on a first run");
  assert.match(g1, /<p>About a third of today sits outside your usual subjects\. 4a keeps it that way\.<\/p>/);
  assert.match(g1, /<span class="readout">1 in 3<\/span>/);
  const back = todayMount({ listened: true });
  back.ctx.renderHome();
  assert.strictEqual(g1, gaugeOf(back.view()), "the same markup, first run or not");
});

/* ==================================================================== */
/* 5. THE HARNESS STATE AND THE SCREEN MAP                               */
/* ==================================================================== */

test("home-first-run is shot in the `empty` state's `home` step, and the screen map names the markup Today draws", async () => {
  /* MUTATION: point screens.json's home-first-run app.state at "returning" (a
     profile with history, so not a first run) or its hero region back at the
     retired `.hv2-jbi-card` -> red. MUTATION 2: give the `empty` seed any
     `cp_history` entry -> the seed assertion fails. */
  const { pathToFileURL } = require("node:url");
  const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
  const [{ buildSeed, loadFixtures }, { appStates }] = await Promise.all([imp("tools/ui-lab/lib/seed.mjs"), imp("tools/ui-lab/lib/states.mjs")]);
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/redesign-2026/directions/tactile/screens.json"), "utf8"));
  const row = map.screens["home-first-run"];
  assert.deepStrictEqual(row.app, { state: "empty", step: "home" });
  const fx = loadFixtures(ROOT);
  const state = appStates(fx).find((s) => s.id === row.app.state);
  assert.ok(state && state.steps.some((s) => s.label === row.app.step && s.route === "#/"));
  const seed = buildSeed(state.seed, fx);
  assert.ok(!("cp_history" in seed) && !("cp_last_episode" in seed), "nothing played, nothing to resume: a first run by observation");
  assert.strictEqual(row.regions.hero.app, ".today-hero");
  assert.strictEqual(row.regions.bridge.app, ".today .bridge");
  for (const region of Object.values(row.regions)) assert.doesNotMatch(String(region.app), /hv2-|mini-card|\.topbar/, "no selector from the retired Home");
});
