/* Today (Redesign 2026, Tactile Home), on a synthetic seed, with the exploration
 * floor (D1, resolves gate #123) carried over from U-03.
 *
 * WHAT FELL (test-classification.md section 0, "Home section order and
 * content", U-03; founder 2026-09-18 and 09-24): the five-section order
 * (greeting, Jump back in, Forays for you, Playlists for you, Suggested), the
 * "Suggested" heading and the rails' cards. WHAT DID NOT: the floor, the
 * bridge copy rule, the generated-playlist badge and F14 (generated playlists
 * are interest leaves, never card slots): product principles 1 and 2.
 *
 * WHAT THIS SUITE PROVES, in order:
 *  1. renderHome() renders Today's layout (the retired four-card grid never).
 *  2. Header, Resume, Today's foray, Also today, Playlists for you, New ground:
 *     in that order; no "Suggested" heading, and Home never says "Episodes for
 *     you".
 *  3. Also today: three pick rows and the bridge card second, each row linking
 *     its episode and carrying the episode's own hook as its why-line.
 *  4. THE FLOOR: Also today always carries the Stretch slot, its Stretch tag
 *     paired with its bridge sentence, on 20 consecutive seeded renders; the
 *     pairing is exact.
 *  5. The bridge sentence never reads as a taste-match reason, states that the
 *     pick is outside the listener's usual subjects, names both subjects and
 *     stays within 16 words for every pair of real subjects (and a long one).
 *  6. "Playlists for you" badges every generated card "Generated for you" and
 *     never badges an own/real playlist that way.
 *  7. F14: a generated playlist is an interest leaf filled from the pool.
 *  8. "Shared with you" and "Build your own" are not built (D10/D8).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same flat-by-id node:vm DOM stub test/home-information-
 * architecture.test.js uses, duplicated rather than imported (that file's
 * own header explains why) - quietMount() seeds just enough state for
 * renderHome()/buildCards() to run without booting against the real data
 * files, which is both faster and independent of today's discover pool.
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

/* A mounted app with two card slots (one "top", one "stretch") for Also today,
   and Forays with topics on opposite sides of a clear interest split, so
   pickWithStretchFloor always has a real lower tier to draw its stretch pick
   from. The Foray bridge is a stub that resolves one running order, so the hero
   and Resume have something to draw. */
function ui2Mount(overrides = {}) {
  const m = mount({ seed: { ...overrides.seed } });
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = {
    nodes: [
      { id: "engineering", parent: null, label: "Engineering", weight: 0.9 },
      { id: "business", parent: null, label: "Business", weight: 0.5 },
      { id: "comedy", parent: null, label: "Comedy", weight: 0.5 },
      { id: "history", parent: null, label: "History", weight: 0.5 },
      // A leaf under a root that is NOT a card slot, so "Playlists for you"
      // has something to generate (F14: generated playlists are interest
      // leaves filled from the pool, never the card slots).
      { id: "business/startups", parent: "business", label: "Startups", weight: 0.5 },
    ],
  };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.interests = { engineering: 0.9, business: 0.6, comedy: 0.1, "business/startups": 0.8 };
  // One show per episode: a generated playlist holds at most 2 from one show (PKG-04).
  m.state.discover = { items: [1, 2, 3].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" })) };
  const ep = (id, title, show, topic, min = 30) => ({ id, title, show, duration_min: min, artwork_url: null, topics: [topic], hook: `${title}, in one line.`, audio_url: `https://cdn.test/${id}.mp3` });
  const slot = (branch, role, ...items) => ({ branch, role, item: items[0], items });
  m.state.cardSlots = [
    slot("engineering", "top", ep("ep-top", "Fusion 101", "Engineering Weekly", "engineering")),
    slot("history", "top", ep("ep-hist", "The long view", "History Hour", "history")),
    slot("comedy", "stretch", ep("ep-stretch", "A comedy bit", "Laugh Hour", "comedy", 20)),
  ];
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [
      { id: "foray-eng", title: "Deep Fusion", topic: "engineering/energy-fusion", status: "published", summary: "Fusion, from the magnets to the money." },
      { id: "foray-biz", title: "Founder Stories", topic: "business/startups", status: "published" },
      { id: "foray-comedy", title: "Standup Roots", topic: "comedy/history", status: "published" },
    ],
    forayResumeList: () => [],
    resolve: (doc, { id }) => ({ id, title: id, totalSec: 1320, playable: [{ show: "Engineering Weekly", kind: "tape" }, { show: "Founders Weekly", kind: "tape" }] }),
    stripModel: () => ({ segments: [
      { kind: "segment", show: "Engineering Weekly", sourceKey: "a", lengthSec: 600 },
      { kind: "narration", show: "", sourceKey: "n", lengthSec: 20 },
      { kind: "segment", show: "Founders Weekly", sourceKey: "b", lengthSec: 700 },
    ] }),
    stripTally: () => ({ clips: 2, bridges: 1, shows: 2, totalSec: 1320, estimated: false }),
    fmtSpan: (sec) => `${Math.round(sec / 60)} min`,
    segmentStripHtml: () => "",
    applyStripGrow: () => {},
  };
  if (overrides.mutate) overrides.mutate(m);
  return m;
}

const SECTION = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);

/* ==================================================================== */
/* 1. THE LAYOUT                                                         */
/* ==================================================================== */

test("renderHome always renders Today's layout (the retired four-card grid never)", () => {
  /* MUTATION: change renderHome() to render anything other than
     renderHomeV2(). The Today assertion fails. */
  const on = ui2Mount();
  on.ctx.renderHome();
  assert.ok(on.view().includes('<div class="today">'), "renderHome() must render Today");
  assert.ok(!on.view().includes('class="cards4"'), "renderHome() must never render the retired four-card grid");
  assert.ok(!on.view().includes("hv2-"), "no trace of the retired Home v2 markup");
});

/* ==================================================================== */
/* 2. SECTION ORDER                                                      */
/* ==================================================================== */

test("the sections render top to bottom: header, Resume, Today's foray, Also today, Playlists for you, New ground", () => {
  // MUTATION: swap the order of any two section calls inside renderHomeV2's
  // template literal. The strictly-increasing index assertion below fails,
  // naming the two that are out of order.
  const m = ui2Mount();
  m.ctx.ForayPlayer.forayResumeList = () => [
    { id: "foray-eng", title: "Deep Fusion", percent: 40, label: "12 min left", finished: false },
  ];
  m.ctx.renderHome();
  const html = m.view();
  const marks = [["header", "today-top"], ["Resume", "today-resume"], ["Today's foray", "today-hero"], ["Also today", "today-also"], ["Playlists for you", "today-playlists"], ["New ground", 'class="gauge"']];
  const at = marks.map(([label, s]) => [label, html.indexOf(s)]);
  for (const [label, i] of at) assert.ok(i !== -1, `${label} did not render at all`);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i - 1][1] < at[i][1], `${at[i - 1][0]} (${at[i - 1][1]}) must come before ${at[i][0]} (${at[i][1]})`);
  }
  assert.match(html, /<h1 class="display-xl today-title" tabindex="-1">Today<\/h1>/);
  assert.match(html, /data-today-date>[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}</, "the date line, in mono, under the title");
});

test("the card-slot section is headed \"Also today\", never \"Suggested\", and Home never says \"Episodes for you\"", () => {
  /* The founder renamed the old section "Suggested" (2026-09-24) after "Episodes
     for you" (persona 56/82); Tactile's slot is "Also today" (DIRECTION.md).
     MUTATION: restore the old heading in todayAlsoHtml. */
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  assert.match(html, /<h2 class="heading" id="today-also-title">Also today<\/h2>/);
  assert.ok(!/Suggested/.test(html), "no Suggested heading");
  assert.ok(!/Episodes for you/i.test(html), "the older section name is gone from Home");
});

/* ==================================================================== */
/* 3. ALSO TODAY                                                         */
/* ==================================================================== */

test("Also today is three picks with the bridge card second; each row links its episode and says why in the episode's own words", () => {
  /* MUTATION: put the bridge last (drop the reorder in todayAlsoHtml) -> the
     position assertion fails. MUTATION 2: use item.title for the why-line ->
     the hook assertion fails. */
  const m = ui2Mount();
  m.ctx.renderHome();
  const also = SECTION(m.view(), "today-also", "today-playlists");
  const kinds = [...also.matchAll(/class="(row-episode|card bridge)[ "]/g)].map(x => x[1]);
  assert.deepStrictEqual(kinds, ["row-episode", "card bridge", "row-episode"], "a row, the bridge, the rest (two top slots here)");
  assert.match(also, /<a class="row__link" href="#\/episode\/ep-top">Fusion 101<\/a>/);
  assert.match(also, /<p class="row__why">Fusion 101, in one line\.<\/p>/);
  assert.match(also, /data-play="ep-top"/, "the key is the engine's own Play control");
  assert.match(also, /data-upnext="ep-top"/, "and so is + Up Next");
});

/* ==================================================================== */
/* 4. THE FLOOR - STRETCH SLOT PRESENCE, 20 SEEDED RENDERS               */
/* ==================================================================== */

test("Also today carries the Stretch slot with its bridge sentence, on 20 consecutive seeded renders", () => {
  // MUTATION: in todayAlsoSlots, return `stretch: null` -> every iteration
  // fails. MUTATION 2: in todayAlsoHtml, drop the bridge card from `ordered` ->
  // the same.
  for (let i = 0; i < 20; i++) {
    const m = ui2Mount();
    m.ctx.renderHome();
    const html = m.view();
    assert.ok(/class="tag tag--stretch"/.test(html), `run ${i}: Also today must carry a visible Stretch tag`);
    assert.ok(/class="bridge__sentence">/.test(html), `run ${i}: the stretch pick must carry its bridge sentence`);
  }
});

/* ==================================================================== */
/* 5. THE STRETCH TAG AND ITS BRIDGE SENTENCE NEVER APPEAR ALONE         */
/* ==================================================================== */

test("a Stretch tag never appears without its bridge sentence, and the sentence never appears without a Stretch tag", () => {
  // MUTATION: render the tag in tactileBridgeCard without the sentence (or the
  // sentence without the tag). The counts below diverge.
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  const tags = (html.match(/class="tag tag--stretch"/g) || []).length;
  const sentences = (html.match(/class="bridge__sentence"/g) || []).length;
  assert.ok(tags > 0, "expected at least one Stretch tag to render");
  assert.strictEqual(tags, sentences, `${tags} Stretch tag(s) but ${sentences} bridge sentence(s)`);
});

test("the bridge sentence is never a taste-match reason: it says the pick is outside the usual subjects and names both ends", () => {
  // The copy rule (D1): a stretch pick states why it's outside the listener's
  // usual subjects, never a reason implying it matches their taste.
  // MUTATION: change the sentence to `Because you like ${known}, try ${stretch}.`
  // -> the "because you" and "outside your usual" assertions fail.
  const m = ui2Mount();
  m.ctx.renderHome();
  const lines = [...m.view().matchAll(/class="bridge__sentence">([^<]*)<\/p>/g)].map((mm) => mm[1]);
  assert.ok(lines.length > 0, "expected at least one bridge sentence to inspect");
  for (const line of lines) {
    assert.doesNotMatch(line, /because you/i, `a bridge sentence must never read as a taste-match reason: "${line}"`);
    assert.match(line, /outside your usual/i, `it must state the outside-your-usual-subjects bridge: "${line}"`);
    assert.match(line, /Engineering/, "it names where the listener already is (their highest-ranked dealt subject)");
    assert.match(line, /Comedy/, "and where the pick goes");
  }
});

test("a bridge sentence is at most 16 words for every pair of real subjects, and a long pair falls back to the one-subject sentence", async () => {
  /* BUILD-NOTES 3.8: 16 words or fewer. MUTATION: drop the fallback in
     stretchBridgeSentence (always return the two-subject sentence) -> the long
     pair is 17 words. MUTATION 2: raise TODAY_BRIDGE_WORDS to 99 -> same. */
  const m = ui2Mount();
  const roots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8")).nodes.filter((n) => n.parent === null).map((n) => n.label);
  assert.ok(roots.length > 5, "the real taxonomy has subjects to pair");
  const words = (t) => t.trim().split(/\s+/).length;
  for (const a of roots) for (const b of roots) {
    const s = m.ctx.stretchBridgeSentence(a, b);
    assert.ok(words(s) <= 16, `"${s}" is ${words(s)} words`);
  }
  const long = m.ctx.stretchBridgeSentence("Fusion and energy systems today", "Craft and making things");
  assert.ok(words(long) <= 16, long);
  assert.doesNotMatch(long, /from Fusion/, "the long pair uses the one-subject sentence");
});

/* ==================================================================== */
/* 6. THE GENERATED-PLAYLIST BADGE                                       */
/* ==================================================================== */

test("a generated playlist card is badged 'Generated for you'; the listener's own playlist never is", () => {
  // MUTATION: badge every card in todayPlaylistsHtml unconditionally
  // (`generated: true` always) - the "own playlist has no badge" assertion
  // fails. MUTATION 2: never badge (`generated: false` always) - the
  // "generated card is badged" assertion fails.
  const m = ui2Mount();
  m.evalIn(`lsSet("cp_playlists", ${JSON.stringify([
    { id: "own-1", title: "My Real Playlist", items: [{ id: "e1" }, { id: "e2" }], created: "2026-09-01T00:00:00Z" },
  ])})`);
  m.ctx.renderHome();
  const html = m.view();

  assert.ok(html.includes("Generated for you"), "expected at least one generated-playlist badge");
  assert.ok(html.includes("My Real Playlist"), "expected the listener's own playlist to render");

  // Isolate the own-playlist card's markup: from its own <a> to its close, so a
  // narrower slice than the section proves NO badge sits on that card rather
  // than merely "a badge exists somewhere".
  const ownCardStart = html.indexOf("My Real Playlist");
  const cardOpenBefore = html.lastIndexOf('<a class="today-pcard"', ownCardStart);
  const cardCloseAfter = html.indexOf("</a>", ownCardStart);
  const ownCardHtml = html.slice(cardOpenBefore, cardCloseAfter);
  assert.ok(!ownCardHtml.includes("Generated for you"), "the listener's own playlist must not carry the generated badge");
});

/* ==================================================================== */
/* 6b. F14: GENERATED PLAYLISTS ARE NOT THE CARD SLOTS REGROUPED         */
/* ==================================================================== */

test("F14: a generated playlist is an interest leaf filled from the pool, never a card slot", () => {
  /* Wyatt, 2026-09-08: "playlists are now the same as 'episodes for you',
     which is not the intent." MUTATION: make generatedPlaylists() return
     the card slots projected as playlists (the first U-03 implementation)
     -> the "Engineering" card appears under Playlists for you and this fails. */
  const m = ui2Mount();
  m.state.discover = { items: [1, 2, 3, 4].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" })) };
  m.ctx.renderHome();
  const html = m.view();
  const section = SECTION(html, "today-playlists", 'class="gauge"');
  assert.ok(section.includes("Startups"), "the interest leaf playlist renders under Playlists for you");
  /* Encoded since 2026-09-22 (audit: one spelling of a playlist route —
     playlistRoute()); the router decodes it back to `gen-business/startups`. */
  assert.ok(section.includes('href="#/playlist/gen-business%2Fstartups"'), "a generated card links to its own detail page");
  assert.ok(!section.includes("#/subject/"), "no card slot is presented as a generated playlist");
  assert.ok(!/today-pcard__name">Engineering</.test(section) && !/today-pcard__name">Comedy</.test(section), "the card slots' subjects do not appear as generated playlists");
});

test("F14: the generated playlist's detail page resolves by id, lists the leaf's episodes newest first, and has no remove button", () => {
  /* MUTATION: drop `|| generatedPlaylistById(id)` from renderPlaylistDetail
     -> "Playlist not found." */
  const m = ui2Mount();
  m.state.discover = { items: [1, 2, 3].map(i => ({ id: "st" + i, title: "Startup " + i, show: "Founders " + i, duration_min: 30, topics: ["business/startups"], release_date: "2026-09-0" + i, audio_url: "https://cdn.test/st" + i + ".mp3" })) };
  m.ctx.renderPlaylistDetail("gen-business/startups");
  const html = m.view();
  assert.ok(!html.includes("Playlist not found"), "generated id resolves");
  assert.ok(html.includes("generated for you"), "subtitle says what it is");
  assert.ok(!html.includes("pl-remove"), "nothing to remove: it is not saved");
  assert.ok(html.indexOf("Startup 3") < html.indexOf("Startup 1"), "newest episode first");
});

/* ==================================================================== */
/* 7. OUT OF SCOPE: NOT BUILT, AND NOT SIMULATED EITHER                  */
/* ==================================================================== */

test("'Shared with you' and 'Build your own' are not built anywhere in the Today render", () => {
  // D10/D8: explicitly out of scope for this card. Not a stub, not a
  // disabled control — no trace at all.
  const m = ui2Mount();
  m.ctx.renderHome();
  const html = m.view();
  assert.ok(!/shared with you/i.test(html), "'Shared with you' must not appear on Today");
  assert.ok(!/build your own/i.test(html), "'Build your own' must not appear on Today");
});
