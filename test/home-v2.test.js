/* U-03 (docs/ui-transition-plan.md, kanban t_6e8343b6): Home v2 — four
 * sections plus the greeting, behind cp_ui_v2, with the exploration floor
 * (D1, resolves gate #123).
 *
 * WHAT THIS SUITE PROVES, in order:
 *  1. renderHome() dispatches to the v2 layout when cp_ui_v2 is on, and to
 *     the untouched flag-off layout when it is off — the two must never
 *     both render, and the flag-off shape must be byte-for-byte what
 *     test/home-layout.test.js / test/home-information-architecture.test.js
 *     already pin.
 *  2. The five sections render in the card's specified order: greeting,
 *     Jump back in, Forays for you, Playlists for you, Episodes for you.
 *  3. THE FLOOR: "Forays for you" and "Episodes for you" each carry a
 *     visible Stretch label with its required bridge line, on 20
 *     consecutive seeded renders — and the pairing is exact: a card can
 *     never have one without the other.
 *  4. A stretch card's bridge line never reads as a row reason implying
 *     the pick matches the listener's taste (the copy rule: a stretch
 *     pick states its bridge, never "because you like X").
 *  5. "Playlists for you" badges every generated card "Generated for you"
 *     and never badges an own/real playlist that way.
 *  6. "Shared with you" and "Build your own" are not built (D10/D8) — no
 *     trace of either surface anywhere in the v2 render.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same flat-by-id node:vm DOM stub test/home-information-
 * architecture.test.js uses, duplicated rather than imported (that file's
 * own header explains why) — quietMount() seeds just enough state for
 * renderHome()/buildCards() to run without booting against the real data
 * files, which is both faster and independent of today's discover pool.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}

/* A mounted, flag-on app with two card slots (one "top", one "stretch") for
   Episodes for you, and two Forays for Forays for you with topics on
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
    ],
  };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9, business: 0.6, comedy: 0.1 };
  m.state.cardSlots = [
    {
      branch: "engineering", role: "top",
      item: { id: "ep-top", title: "Fusion 101", show: "Engineering Weekly", duration_min: 30, artwork_url: null, topics: ["engineering"] },
      items: [{ id: "ep-top", title: "Fusion 101", show: "Engineering Weekly", duration_min: 30, topics: ["engineering"] }],
    },
    {
      branch: "comedy", role: "stretch",
      item: { id: "ep-stretch", title: "A comedy bit", show: "Laugh Hour", duration_min: 20, artwork_url: null, topics: ["comedy"] },
      items: [{ id: "ep-stretch", title: "A comedy bit", show: "Laugh Hour", duration_min: 20, topics: ["comedy"] }],
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
/* 1. THE FLAG DISPATCH                                                  */
/* ==================================================================== */

test("renderHome always renders the v2 layout (cp_ui_v2 retired, U-11 cutover)", () => {
  /* CUTOVER (U-11, founder override, 2026-09-06, kanban card t_a3f01c8a):
     ui2On() always returns true now, so there is no flag-off mount left
     to test — that layout, and its Settings toggle, are retired and
     preserved verbatim in archive/legacy-ui-2026-09/. This test now only
     pins renderHome()'s one remaining shape.
     MUTATION: change renderHome() to render anything other than
     renderHomeV2(). The v2 assertion fails. */
  const on = ui2Mount();
  on.ctx.renderHome();
  assert.ok(on.view().includes('class="home hv2-home"'), "renderHome() must always render the v2 Home layout");
  assert.ok(!on.view().includes('class="cards4"'), "renderHome() must never render the retired four-card grid");
});

/* ==================================================================== */
/* 2. SECTION ORDER                                                      */
/* ==================================================================== */

test("the five sections render top to bottom: greeting, Jump back in, Forays for you, Playlists for you, Episodes for you", () => {
  // MUTATION: swap the order of any two section calls inside renderHomeV2's
  // template literal. The strictly-increasing index assertion below fails,
  // naming the two that are out of order.
  const m = ui2Mount();
  m.ctx.ForayPlayer.forayResumeList = () => [
    { id: "foray-eng", title: "Deep Fusion", percent: 40, label: "12 min left", finished: false },
  ];
  m.ctx.renderHome();
  const html = m.view();

  const iGreeting = html.indexOf("hv2-greeting");
  const iJbi = html.indexOf("hv2-jbi");
  const iForays = html.indexOf("hv2-forays");
  const iPlaylists = html.indexOf("hv2-playlists");
  const iEpisodes = html.indexOf("hv2-episodes");

  for (const [label, i] of [["greeting", iGreeting], ["Jump back in", iJbi], ["Forays for you", iForays], ["Playlists for you", iPlaylists], ["Episodes for you", iEpisodes]]) {
    assert.ok(i !== -1, `${label} section did not render at all`);
  }
  assert.ok(iGreeting < iJbi && iJbi < iForays && iForays < iPlaylists && iPlaylists < iEpisodes,
    `sections rendered out of order: greeting=${iGreeting} jbi=${iJbi} forays=${iForays} playlists=${iPlaylists} episodes=${iEpisodes}`);
});

/* ==================================================================== */
/* 3. THE FLOOR — STRETCH SLOT PRESENCE, 20 SEEDED RENDERS               */
/* ==================================================================== */

test("both 'for you' sections carry a visible Stretch label with its bridge line, on 20 consecutive seeded renders", () => {
  // MUTATION: in pickWithStretchFloor, change `.filter(x => !topBranchIds.has(x.b))[0]`
  // to always return null (no stretch ever found) — every iteration below
  // fails immediately. MUTATION 2: in miniCardV2, drop the bridge-line
  // insertion — the "Stretch" tag would still render but its paired bridge
  // line would not, and the pairing assertion (test 4 below) is what
  // actually catches that; this test's own count would still pass, which is
  // why both tests exist.
  for (let i = 0; i < 20; i++) {
    const m = ui2Mount();
    m.ctx.renderHome();
    const html = m.view();
    assert.ok(/class="hv2-stretch-tag">Stretch</.test(html), `run ${i}: Forays for you must carry a visible Stretch tag`);
    assert.ok(/class="mc-stretch"[^>]*>Stretch</.test(html), `run ${i}: Episodes for you must carry a visible Stretch tag`);
    assert.ok(html.includes('class="hv2-bridge">'), `run ${i}: the stretch pick must carry a bridge line`);
  }
});

/* ==================================================================== */
/* 4. THE STRETCH TAG AND ITS BRIDGE LINE NEVER APPEAR ALONE             */
/* ==================================================================== */

test("a Stretch tag never appears without its bridge line, and a bridge line never appears without a Stretch tag", () => {
  // MUTATION: render `hv2-stretch-tag`/`mc-stretch` without also appending
  // `.hv2-bridge` (or vice versa) on one card type. The counts below diverge.
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const forayStretchTags = (html.match(/class="hv2-stretch-tag"/g) || []).length;
  const episodeStretchTags = (html.match(/class="mc-stretch"/g) || []).length;
  const stretchTags = forayStretchTags + episodeStretchTags;
  const bridgeLines = (html.match(/class="hv2-bridge"/g) || []).length;
  assert.ok(stretchTags > 0, "expected at least one Stretch tag to render");
  assert.strictEqual(stretchTags, bridgeLines,
    `${stretchTags} Stretch tag(s) but ${bridgeLines} bridge line(s) — every stretch card must carry exactly one of each`);
});

test("the stretch bridge line never reads as a row-reason match to the listener's taste", () => {
  // The copy rule (D1): a stretch pick states why it's outside the
  // listener's usual subjects, never a reason implying it matches their
  // taste (that phrasing is reserved for an ordinary row reason, and this
  // suite's fixtures never emit one on Home v2 at all).
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const bridgeText = [...html.matchAll(/class="hv2-bridge">([^<]*)<\/p>/g)].map((mm) => mm[1]);
  assert.ok(bridgeText.length > 0, "expected at least one bridge line to inspect");
  for (const line of bridgeText) {
    assert.doesNotMatch(line, /because you/i,
      `a stretch bridge line must never read as a taste-match reason: "${line}"`);
    assert.match(line, /outside your usual/i,
      `a stretch bridge line must state the outside-your-usual-subjects bridge: "${line}"`);
  }
});

/* ==================================================================== */
/* 5. THE GENERATED-PLAYLIST BADGE                                       */
/* ==================================================================== */

test("a generated playlist card is badged 'Generated for you'; the listener's own playlist never is", () => {
  // MUTATION: badge every card in playlistsForYouHtml unconditionally
  // (`generated: true` always) — the "own playlist has no badge" assertion
  // fails. MUTATION 2: never badge (`generated: false` always) — the
  // "generated card is badged" assertion fails.
  const m = ui2Mount();
  m.evalIn(`lsSet("cp_playlists", ${JSON.stringify([
    { id: "own-1", title: "My Real Playlist", items: [{ id: "e1" }, { id: "e2" }], created: "2026-09-01T00:00:00Z" },
  ])})`);
  m.ctx.renderHome();
  const html = m.view();

  assert.ok(html.includes("Generated for you"), "expected at least one generated-playlist badge");
  assert.ok(html.includes("My Real Playlist"), "expected the listener's own playlist to render");

  // Isolate the own-playlist card's markup: it runs from its own <a ...> to
  // the next <a class="hv2-playlist-card" up to the matching close, so a
  // narrower slice than the whole section is needed to prove NO badge sits
  // on that specific card rather than merely "a badge exists somewhere".
  const ownCardStart = html.indexOf("My Real Playlist");
  const cardOpenBefore = html.lastIndexOf('<a class="hv2-playlist-card"', ownCardStart);
  const cardCloseAfter = html.indexOf("</a>", ownCardStart);
  const ownCardHtml = html.slice(cardOpenBefore, cardCloseAfter);
  assert.ok(!ownCardHtml.includes("Generated for you"), "the listener's own playlist must not carry the generated badge");
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
