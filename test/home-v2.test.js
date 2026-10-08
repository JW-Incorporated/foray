/* U-03 (docs/ui-transition-plan.md, kanban t_6e8343b6): Home v2 with the exploration
 * floor (D1, resolves gate #123) — REWRITTEN for Today (Redesign 2026, ambient direction),
 * which overturns "Home section order and content" (U-03; founder 2026-09-18 and 09-24).
 * test-classification.md: KEEP the floor, the bridge copy, the badge honesty and F14; REWRITE
 * the section order, the names and the greeting. The ~30% floor survives on its new surface.
 *
 * WHAT THIS SUITE PROVES, in order:
 *  1. renderHome() has one shape: Today (`.ag.td-today`).
 *  2. The sections render in the direction’s order: header, hero, Keep listening, Today’s
 *     picks, Playlists for you, Off your path — and Off your path carries its explainer and no
 *     Stretch pill.
 *  3. THE FLOOR: Today’s picks carry exactly one Stretch card, never first and never last, with
 *     its bridge line, on 20 consecutive renders.
 *  4. A Stretch pill and its bridge line never appear apart, and the bridge never reads as a
 *     taste-match reason (the copy rule: a stretch pick states its bridge, never "because you").
 *  5. "Playlists for you" badges every generated tile "Generated for you" and never badges an own
 *     playlist that way; F14: generated playlists are interest leaves, not card slots.
 *  6. "Shared with you" and "Build your own" are not built (D10/D8).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same flat-by-id node:vm DOM stub test/home-information-architecture.test.js
 * uses, duplicated rather than imported (that file’s own header explains why) — quietMount()
 * seeds just enough state for renderHome()/buildCards() to run without booting against the real
 * data files, which is both faster and independent of today’s discover pool.
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
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

/* A mounted, flag-on app with two card slots (one "top", one "stretch") for
   Suggested, and two Forays for Forays for you with topics on
   opposite sides of a clear interest split, so pickWithStretchFloor always
   has a real lower tier to draw its stretch pick from. */
function ui2Mount(overrides = {}) {
  const m = mount({ seed: { cp_ui_v2: "true", ...overrides.seed } });
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = {
    nodes: [
      { id: "engineering", parent: null, label: "Engineering", weight: 0.9 },
      { id: "business", parent: null, label: "Business", weight: 0.5 },
      { id: "comedy", parent: null, label: "Comedy", weight: 0.5 },
      // A leaf under a root that is NOT a card slot, so "Playlists for you"
      // has something to generate (F14: generated playlists are interest
      // leaves filled from the pool, never the card slots).
      { id: "business/startups", parent: "business", label: "Startups", weight: 0.5 },
    ],
  };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  /* Eight subjects, so the 60% cut leaves a lower tier for "Off your path" to draw from (sports, food)
     beside the Stretch slot’s own subject (comedy). */
  m.state.interests = { engineering: 0.9, business: 0.6, comedy: 0.1, "business/startups": 0.8, arts: 0.7, history: 0.6, travel: 0.14, sports: 0.13, food: 0.12 };
  // One show per episode: a generated playlist holds at most 2 from one show (PKG-04).
  const lowerTier = ["arts", "history", "travel", "sports", "food"].map((b, i) => ({ id: "x-" + b, title: "About " + b, show: "Show " + b, duration_min: 25, topics: [b], release_date: "2026-09-1" + i, audio_url: "https://cdn.test/x-" + b + ".mp3", hook: "A short look at " + b + "." }));
  m.state.discover = { items: [1, 2, 3].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" })).concat(lowerTier) };
  m.state.cardSlots = [
    {
      branch: "engineering", role: "top",
      item: { id: "ep-top", title: "Fusion 101", show: "Engineering Weekly", duration_min: 30, artwork_url: null, topics: ["engineering"], audio_url: "https://cdn.test/top.mp3", hook: "How a star in a jar works." },
      items: [
        { id: "ep-top", title: "Fusion 101", show: "Engineering Weekly", duration_min: 30, topics: ["engineering"], audio_url: "https://cdn.test/top.mp3", hook: "How a star in a jar works." },
        { id: "ep-top2", title: "Fusion 102", show: "Engineering Weekly", duration_min: 31, topics: ["engineering"], audio_url: "https://cdn.test/top2.mp3" },
        { id: "ep-top3", title: "Fusion 103", show: "Engineering Weekly", duration_min: 32, topics: ["engineering"], audio_url: "https://cdn.test/top3.mp3" },
      ],
    },
    {
      branch: "comedy", role: "stretch",
      item: { id: "ep-stretch", title: "A comedy bit", show: "Laugh Hour", duration_min: 20, artwork_url: null, topics: ["comedy"], audio_url: "https://cdn.test/stretch.mp3" },
      items: [{ id: "ep-stretch", title: "A comedy bit", show: "Laugh Hour", duration_min: 20, topics: ["comedy"], audio_url: "https://cdn.test/stretch.mp3" }],
    },
  ];
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [
      { id: "foray-eng", title: "Deep Fusion", topic: "engineering/energy-fusion", status: "published" },
      { id: "foray-biz", title: "Founder Stories", topic: "business/startups", status: "published" },
      { id: "foray-comedy", title: "Standup Roots", topic: "comedy/history", status: "published" },
    ],
    forayResumeList: () => [],
    resolve: () => null,
    segmentStripHtml: () => "",
    applyStripGrow: () => {},
  };
  if (overrides.mutate) overrides.mutate(m);
  return m;
}

/* ==================================================================== */
/* 1. THE DISPATCH                                                       */
/* ==================================================================== */

test("renderHome always renders Today (cp_ui_v2 retired, U-11 cutover; Home redesigned 2026)", () => {
  /* CUTOVER (U-11, founder override, 2026-09-06): ui2On() always returns true, so
     renderHome() has one shape. REDESIGN 2026 (ambient): that shape is Today, the
     `.ag.td-today` room, not the `.home.hv2-home` column.
     MUTATION: change renderHome() to render anything other than renderHomeV2(). */
  const on = ui2Mount();
  on.ctx.renderHome();
  assert.ok(/class="ag td-today[ "]/.test(on.view()), "renderHome() must always render Today");
  assert.ok(!on.view().includes('class="home hv2-home"'), "and never the retired v2 column");
  assert.ok(!on.view().includes('class="cards4"'), "nor the retired four-card grid");
});

/* ==================================================================== */
/* 2. SECTION ORDER                                                      */
/* ==================================================================== */

test("Today renders top to bottom: header, hero, Keep listening, Today's picks, Playlists for you, Off your path", () => {
  /* Overturns "Home section order and content" (U-03; founder 2026-09-18 and 09-24) by name:
     DIRECTION.md "Home order: hero, Keep listening, Today's picks, Playlists, Off your path".
     MUTATION: swap the order of any two section pieces in todayHtml's template. The
     strictly-increasing index assertion below fails, naming the two that are out of order. */
  const m = ui2Mount();
  m.ctx.ForayPlayer.forayResumeList = () => [
    { id: "foray-eng", title: "Deep Fusion", percent: 40, label: "12 min left", finished: false },
  ];
  m.ctx.renderHome();
  const html = m.view();
  const marks = [
    ["header", 'class="td-head"'], ["hero", 'class="td-hero"'], ["Keep listening", 'aria-label="Keep listening"'],
    ["Today's picks", 'aria-label="Today\'s picks"'], ["Playlists for you", 'aria-label="Playlists for you"'], ["Off your path", 'aria-label="Off your path"'],
  ].map(([label, needle]) => [label, html.indexOf(needle)]);
  for (const [label, i] of marks) assert.ok(i !== -1, `${label} did not render at all`);
  const at = marks.map((x) => x[1]);
  assert.ok(at.every((v, i) => i === 0 || at[i - 1] < v), `sections rendered out of order: ${marks.map((x) => x.join("=")).join(" ")}`);
});

test("Off your path opens with its one-line explainer, and its rows carry no Stretch pill", () => {
  /* MUTATION: reword TODAY_OFFPATH_NOTE, or render a Stretch pill on the Off-your-path rows
     (todayStretchCard instead of todayEpisodeRow there). */
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const off = html.slice(html.indexOf('aria-label="Off your path"'));
  assert.ok(off.includes("About a third of each day sits outside your usual subjects. This is today’s third."), "the explainer is verbatim");
  assert.ok((off.match(/class="raised td-row/g) || []).length >= 2, "two or three rows");
  assert.ok(!/Stretch/.test(off), "the section is the label: no Stretch pill inside it");
});

/* ==================================================================== */
/* 3. THE FLOOR — A STRETCH CARD IN THE PICKS, 20 SEEDED RENDERS         */
/* ==================================================================== */

test("Today's picks carry one Stretch card with its bridge line, never first and never last, on 20 consecutive renders", () => {
  /* MUTATION: in pickWithStretchFloor / buildCards, never find a stretch (the stretch slot's role
     "top") -> every iteration fails. MUTATION 2: in todayPicks, splice the stretch at index 0 or
     at rows.length -> the position assertions fail. */
  for (let i = 0; i < 20; i++) {
    const m = ui2Mount();
    m.ctx.renderHome();
    const html = m.view();
    const list = html.slice(html.indexOf('aria-label="Today\'s picks"'), html.indexOf('aria-label="Playlists for you"'));
    const cards = [...list.matchAll(/<article class="raised (?:ag-stretch-card td-stretch|td-row)[^"]*"/g)].map((x) => /td-stretch/.test(x[0]));
    assert.ok(cards.length >= 3, `run ${i}: the picks list has rows (${cards.length})`);
    assert.strictEqual(cards.filter(Boolean).length, 1, `run ${i}: exactly one Stretch card`);
    assert.ok(!cards[0] && !cards[cards.length - 1], `run ${i}: the Stretch card is neither first nor last`);
    assert.ok(/class="ag-pill"><svg[^>]*><use[^>]*><\/use><\/svg><span>Stretch<\/span>/.test(list), `run ${i}: it wears the Stretch pill`);
  }
});

/* ==================================================================== */
/* 4. THE STRETCH PILL AND ITS BRIDGE LINE NEVER APPEAR ALONE            */
/* ==================================================================== */

test("a Stretch pill never appears without its bridge line, and a bridge line never appears without a Stretch pill", () => {
  /* MUTATION: render the pill without `<p class="t-why td-bridge">` in todayStretchCard (or the
     bridge without the pill). The counts below diverge. */
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const pills = (html.match(/<span>Stretch<\/span>/g) || []).length;
  const bridges = (html.match(/class="t-why td-bridge"/g) || []).length;
  assert.ok(pills > 0, "expected at least one Stretch pill to render");
  assert.strictEqual(pills, bridges, `${pills} pill(s) but ${bridges} bridge line(s): every stretch card carries exactly one of each`);
});

test("the stretch bridge line never reads as a row-reason match to the listener's taste", () => {
  /* The copy rule (D1): a stretch pick states why it is outside the listener's usual subjects, never a
     reason implying it matches their taste. MUTATION: reword stretchBridgeText to "Because you ...". */
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const bridgeText = [...html.matchAll(/class="t-why td-bridge">([^<]*)<\/p>/g)].map((mm) => mm[1]);
  assert.ok(bridgeText.length > 0, "expected at least one bridge line to inspect");
  for (const line of bridgeText) {
    assert.doesNotMatch(line, /because you/i, `a stretch bridge line must never read as a taste-match reason: "${line}"`);
    assert.match(line, /outside your usual/i, `a stretch bridge line must state the outside-your-usual-subjects bridge: "${line}"`);
  }
});

/* ==================================================================== */
/* 5. THE GENERATED-PLAYLIST BADGE                                       */
/* ==================================================================== */

test("a generated playlist tile is badged 'Generated for you'; the listener's own playlist never is", () => {
  /* MUTATION: badge every tile unconditionally (`generated: true` always in todayHtml) — the
     "own playlist has no badge" assertion fails. MUTATION 2: never badge — the "generated tile
     is badged" assertion fails. */
  const m = ui2Mount();
  m.evalIn(`lsSet("cp_playlists", ${JSON.stringify([
    { id: "own-1", title: "My Real Playlist", items: [{ id: "e1" }, { id: "e2" }], created: "2026-09-01T00:00:00Z" },
  ])})`);
  m.ctx.renderHome();
  const html = m.view();
  assert.ok(html.includes("Generated for you"), "expected at least one generated-playlist badge");
  assert.ok(html.includes("My Real Playlist"), "expected the listener's own playlist to render");
  const ownStart = html.indexOf("My Real Playlist");
  const tileOpenBefore = html.lastIndexOf('<a class="raised ag-playlist-tile td-ptile"', ownStart);
  const tileCloseAfter = html.indexOf("</a>", ownStart);
  assert.ok(tileOpenBefore > -1, "the own playlist is a tile");
  assert.ok(!html.slice(tileOpenBefore, tileCloseAfter).includes("Generated for you"), "the listener's own playlist must not carry the generated badge");
});

/* ==================================================================== */
/* 5b. F14: GENERATED PLAYLISTS ARE NOT "SUGGESTED" REGROUPED     */
/* ==================================================================== */

test("F14: a generated playlist is an interest leaf filled from the pool, never a card slot", () => {
  /* Wyatt, 2026-09-08: "playlists are now the same as 'episodes for you',
     which is not the intent." MUTATION: make generatedPlaylists() return
     the card slots projected as playlists (the first U-03 implementation)
     -> the "Engineering" card appears under Playlists for you and this fails. */
  const m = ui2Mount();
  m.state.discover = { items: m.state.discover.items.concat([4].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" }))) };
  m.ctx.renderHome();
  const html = m.view();
  const section = html.slice(html.indexOf('aria-label="Playlists for you"'), html.indexOf('aria-label="Off your path"'));
  assert.ok(section.includes("Startups"), "the interest leaf playlist renders under Playlists for you");
  /* Encoded since 2026-09-22 (audit: one spelling of a playlist route —
     playlistRoute()); the router decodes it back to `gen-business/startups`. */
  assert.ok(section.includes('href="#/playlist/gen-business%2Fstartups"'), "a generated tile links to its own detail page");
  assert.ok(!section.includes("#/subject/"), "no card slot is presented as a generated playlist");
  assert.ok(!/clamp2">Engineering</.test(section) && !/clamp2">Comedy</.test(section), "the card slots' subjects do not appear as generated playlists");
});

test("F14: the generated playlist's detail page resolves by id, lists the leaf's episodes newest first, and has no remove button", () => {
  /* MUTATION: drop `|| generatedPlaylistById(id)` from renderPlaylistDetail
     -> "Playlist not found." */
  const m = ui2Mount();
  m.state.discover = { items: [1, 2, 3].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" })) };
  m.ctx.renderPlaylistDetail("gen-business/startups");
  const html = m.view();
  assert.ok(!html.includes("Playlist not found"), "generated id resolves");
  assert.ok(html.includes("Generated for you"), "the eyebrow says what it is: 4a's, in Lamp");
  assert.ok(!html.includes("pl-remove"), "nothing to remove: it is not saved");
  assert.ok(html.indexOf("Startup 3") < html.indexOf("Startup 1"), "newest episode first");
});

/* ==================================================================== */
/* 6. OUT OF SCOPE: NOT BUILT, AND NOT SIMULATED EITHER                  */
/* ==================================================================== */

test("'Shared with you' and 'Build your own' are not built anywhere in the v2 render", () => {
  // D10/D8: explicitly out of scope for this card. Not a stub, not a
  // disabled control — no trace at all.
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  assert.ok(!/shared with you/i.test(html), "'Shared with you' must not appear on Home v2");
  assert.ok(!/build your own/i.test(html), "'Build your own' must not appear on Home v2");
});
