/* Today's Foray keys (Redesign 2026, Tactile Home).
 *
 * WHAT FELL. This suite pinned Home's one play capsule (founder, 2026-09-24:
 * "Add a play button at the Home Screen level and start playing whatever is
 * first in that list"), which walked Jump back in, Forays for you, Playlists
 * for you and Suggested and played the first thing that could. Tactile's Today
 * has no rails to walk: the hero is Today's foray and its Play key is that
 * founder ask, answered by one Foray, and Resume is the part-played listen. The
 * ruling that fell is "Home section order and content" (U-03,
 * test-classification.md section 0); the conventions below did not.
 *
 * WHAT THIS PROVES, in order:
 *  1. The hero is the first Foray that can play (an unresolvable one is passed
 *     over), carries ONE Play key that names it, and is absent, with its key,
 *     when no Foray can play. It says what it is made of from the running order.
 *  2. Resume is a part-played Foray or episode only, above the hero; a Foray
 *     resumes where it was left; an episode's key is the engine's own
 *     `[data-play]`; the player's own listen is not a card; a playlist never is;
 *     the same Foray is not offered twice while another can stand in.
 *  3. The round-1/2 play conventions: the start is from the top when nothing is
 *     stored, the loading mark while the start is in flight (and a second press
 *     does nothing), a failure is reported, a superseded start is not, a press on
 *     the live Foray resumes it and never restarts or pauses it, and the Foray is
 *     resolved at the press, not captured at render.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * Harness: test/foray-surfaces.test.js's node:vm stub over the REAL resolver
 * and strip modules and the FROZEN Foray fixture (tools/foray/fixtures/frozen/),
 * so the one Foray named here (`capital-types-1`, the fixture's published one)
 * is a real running order. The player's playback half is faked at exactly the
 * surface app.js calls, and records the calls.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const SRC = readAppSource().replace(/\r\n/g, "\n");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const FROZEN = path.join(ROOT, "tools/foray/fixtures/frozen/data");
const readFrozen = (f) => JSON.parse(fs.readFileSync(path.join(FROZEN, f), "utf8"));

process.on("unhandledRejection", () => {});

const FORAY_ID = "capital-types-1";
const FORAY_TITLE = readFrozen("forays.json").forays.find((f) => f.id === FORAY_ID).title;

const mods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();

const EP = (n, extra = {}) => ({
  id: `ep-${n}`, title: `Episode ${n}`, show: "History Hour", duration_min: 30,
  topics: ["history"], release_date: `2026-09-0${n}`, audio_url: `https://cdn.test/ep-${n}.mp3`, ...extra,
});

/** The fake bridge: the REAL resolver and strip over the frozen fixture, and a
    recording stand-in for playback. `resumeRows` is what forayResumeList
    answers; `lastEpisode` what lastEpisodeCard answers. */
async function makeBridge({ resumeRows = [], lastEpisode = null } = {}) {
  const { resolve, strip } = await mods;
  const calls = { play: [], playForay: [], toggle: 0, forayToggle: 0, failures: [] };
  let currentId = null;
  let playing = false;
  let forayLive = null;
  return {
    calls,
    setCurrent(id, isPlaying) { currentId = id; playing = isPlaying; },
    setForayLive(v) { forayLive = v; },
    resolve(doc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
      const f = resolve.findForay(doc, id, { unlocked, showDrafts });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    listForays: (doc, opts) => resolve.listableForays(doc, opts),
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    segmentStripHtml: strip.segmentStripHtml,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    applyStripGrow() {},
    forayResumeList: () => resumeRows,
    forayResume: (id) => (resumeRows.find((r) => r.id === id) ? { elapsedSec: 600 } : null),
    forayStatus: () => forayLive,
    async forayToggle() { calls.forayToggle += 1; },
    lastEpisodeCard: () => lastEpisode,
    /* Overridable per test: the answer `play()` gives. */
    playImpl: null,
    async play(item, opts) {
      calls.play.push({ item, opts });
      if (this.playImpl) return this.playImpl(item, opts);
      currentId = item.id; playing = true;
      return true;
    },
    playForayImpl: null,
    async playForay(r, opts) {
      calls.playForay.push({ r, opts });
      if (this.playForayImpl) return this.playForayImpl(r, opts);
      forayLive = { forayId: r.id, running: true };
      return { items: r.playable };
    },
    isCurrent: (id) => Boolean(id) && id === currentId,
    isPlaying: (id) => playing && id === currentId,
    async togglePlayback() { calls.toggle += 1; playing = !playing; },
    reportPlayFailure(err) { calls.failures.push(err); },
    setEpisodeNavigation() { return true; },
  };
}

function loadApp(bridge, { pool = [EP(1), EP(2), EP(3)], cardSlots = null, playlists = null, forays = true } = {}) {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop, append: noop,
      setAttribute: noop, removeAttribute: noop, focus: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => null, querySelectorAll: () => [],
    };
  }
  const view = makeEl();
  const store = new Map();
  if (playlists) store.set("cp_playlists", JSON.stringify(playlists));
  const ctx = {
    console: { ...console, warn: noop, error: noop },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(), readyState: "complete",
      addEventListener: noop, createElement: makeEl,
      querySelector: (sel) => (sel === "#view" ? view : sel === "#intro-sheet" ? null : makeEl()),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener: noop, removeEventListener: noop,
    location: { hash: "#/", search: "", pathname: "/", href: "https://example.test/#/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(SRC, ctx);
  ctx.__docs = {
    forays: forays ? readFrozen("forays.json") : null,
    segments: readFrozen("segments.json"), sources: readFrozen("segment-sources.json"),
    pool, slots: cardSlots || [],
  };
  vm.runInContext(`
    state.forays = __docs.forays; state.segments = __docs.segments; state.segmentSources = __docs.sources;
    state.taxonomy = { nodes: [{ id: "history", parent: null, label: "History", weight: 0.5 }] };
    state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
    state.discover = { items: __docs.pool };
    state.interests = { history: 0.5 };
    fullPool();
    state.cardSlots = __docs.slots;
  `, ctx);
  return { ctx, store, view };
}

/** A button the way bindHomePlay sees it, recording its handler and attributes. */
function fakeButton(id = FORAY_ID) {
  const attrs = {};
  const btn = {
    dataset: { homePlay: id }, attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(_t, fn) { btn.handler = fn; },
  };
  return btn;
}

/** Bind the Foray key the way renderHomeV2 does, and press it. */
async function bindAndPress(app, btn = fakeButton()) {
  app.ctx.bindHomePlay({ querySelectorAll: (sel) => (sel === "[data-home-play]" ? [btn] : []) });
  assert.ok(btn.handler, "bindHomePlay bound no handler");
  await btn.handler();
  return btn;
}

const subjectSlot = (items) => ({ branch: "history", role: "top", item: items[0], items });
/** The hero's Play key: the one control carrying data-home-play inside .today-hero. */
const heroKey = (html) => /<button[^>]*data-home-play="([^"]*)"[^>]*aria-label="([^"]*)"/.exec(html.slice(html.indexOf('class="card card--hero today-hero"')));
const resumeSection = (html) => (/<section class="card today-resume"[\s\S]*?<\/section>/.exec(html) || [""])[0];

/* ==================================================================== */
/* 1. WHERE THEY ARE                                                     */
/* ==================================================================== */

test("Today's foray is the hero: after the header, before Also today, with ONE Play key that names it", async () => {
  /* MUTATION: drop `${todayHeroHtml(...)}` from renderHomeV2, or move it below
     Also today -> the order assertion fails. MUTATION 2: render a second
     data-home-play key on the hero (Details as a key) -> the count fails. */
  const app = loadApp(await makeBridge(), { cardSlots: [subjectSlot([EP(2)])] });
  app.ctx.renderHome();
  const html = app.view.innerHTML;
  const at = (s) => html.indexOf(s);
  assert.ok(at("today-top") > -1 && at("today-hero") > at("today-top") && at("today-also") > at("today-hero"),
    "header, hero, Also today, in that order");
  const key = heroKey(html);
  assert.ok(key, "the hero has a Foray Play key");
  assert.strictEqual(key[1], FORAY_ID);
  assert.strictEqual(key[2], `Play ${FORAY_TITLE}`);
  assert.strictEqual((html.match(/data-home-play/g) || []).length, 1, "ONE Foray key on Home without a Resume card");
});

test("the hero is the first Foray that can play: an unresolvable one is passed over, not stopped at", async () => {
  /* MUTATION: take picks[0] without asking resolveListedForay for a running
     order -> the hero names the ghost and its key plays nothing. MUTATION 2:
     accept a resolved Foray with an empty `playable` -> the empty one is the hero. */
  const bridge = await makeBridge();
  const real = bridge.listForays;
  const resolve = bridge.resolve.bind(bridge);
  /* Two ghosts: one the resolver has never heard of (null), one it resolves to an
     empty running order (every segment left): neither can play. */
  bridge.resolve = (doc, o) => (o.id === "empty-foray" ? { id: o.id, title: "Empty", totalSec: 0, playable: [] } : resolve(doc, o));
  bridge.listForays = (doc, opts) => [
    { id: "ghost-foray", title: "A Foray whose segments left", topic: "history", status: "published" },
    { id: "empty-foray", title: "A Foray with nothing playable", topic: "history", status: "published" },
    ...real(doc, opts),
  ];
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(2)])] });
  app.ctx.renderHome();
  const html = app.view.innerHTML;
  assert.ok(!html.includes("ghost-foray") && !html.includes("empty-foray"), "an unresolvable Foray and an empty one are not the hero");
  assert.strictEqual(heroKey(html)[1], FORAY_ID);
});

test("with no Foray that can play there is no hero, and no Foray key at all", async () => {
  /* MUTATION: render the hero shell with an empty title when todayForayPick is null. */
  const app = loadApp(await makeBridge(), { cardSlots: [subjectSlot([EP(1)])], forays: false });
  app.ctx.renderHome();
  assert.ok(!app.view.innerHTML.includes("today-hero"));
  assert.ok(!app.view.innerHTML.includes("data-home-play"));
});

test("the hero says what it is made of, from the running order: a band, the show count, the length", async () => {
  /* MUTATION: build the band from [] (drop todayHeroModel's stripModel) -> the
     band has no bars and the bar count assertion fails. */
  const app = loadApp(await makeBridge(), { cardSlots: [subjectSlot([EP(2)])] });
  app.ctx.renderHome();
  const html = app.view.innerHTML;
  const hero = html.slice(html.indexOf('class="card card--hero today-hero"'), html.indexOf("today-also"));
  assert.match(hero, /class="band band--mini"/);
  const bars = (hero.match(/<rect class="t-band__bar /g) || []).length;
  assert.ok(bars >= 2 * 20, `a band of the foray's items, drawn twice (base and fill); saw ${bars} bars`);
  assert.match(hero, /class="readout today-hero__facts">(about )?\d+ min · \d+ shows?</);
  assert.match(hero, /Today(&#39;|')s foray</, "the eyebrow");
});

/* ==================================================================== */
/* 2. RESUME                                                             */
/* ==================================================================== */

test("Resume appears only for a part-played Foray or episode, and a Foray resumes where it was left", async () => {
  /* MUTATION: drop the percent bounds in todayResumeEntry -> a finished listen
     (percent 100) gets a card. MUTATION 2: start the Foray with startIndex 0
     always -> startElapsedSec is missing. */
  const bridge = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 40, label: "30 min left", finished: false, drift: "unverified" }] });
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(2)])] });
  app.ctx.renderHome();
  const html = app.view.innerHTML;
  const resume = resumeSection(html);
  assert.ok(resume, "a part-played Foray has a Resume card");
  assert.match(resume, /class="tag tag--playing"[\s\S]*Resume</);
  assert.match(resume, /30 min left/);
  assert.match(resume, new RegExp(`data-home-play="${FORAY_ID}"`));
  assert.ok(html.indexOf("today-resume") < html.indexOf("today-hero"), "Resume sits above Today's foray");
  const btn = await bindAndPress(app);
  assert.strictEqual(bridge.calls.playForay[0].opts.startElapsedSec, 600, "resumes where it was left");
  assert.strictEqual(btn.dataset.loading, undefined);

  const done = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 100, label: "Played", finished: true }] });
  const finished = loadApp(done, { cardSlots: [subjectSlot([EP(2)])] });
  finished.ctx.renderHome();
  assert.ok(!finished.view.innerHTML.includes("today-resume"), "a finished listen is not resumed");
});

test("a part-played episode's Resume key is the engine's own Play control", async () => {
  /* MUTATION: draw the key without data-play -> bindPlay never binds it and the
     assertion fails. MUTATION 2: drop swapIcon -> the pause icon is missing. */
  const bridge = await makeBridge({ lastEpisode: { ...EP(3), updated_at: "2026-09-20T00:00:00Z", percent: 30, label: "20 min left" } });
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  app.ctx.renderHome();
  const resume = resumeSection(app.view.innerHTML);
  assert.match(resume, /data-play="ep-3"/);
  assert.match(resume, /data-ctl-icons/);
  assert.match(resume, /#ph-pause-fill/);
  assert.match(resume, /href="#\/episode\/ep-3"/);
  assert.ok(!resume.includes("data-home-play"), "an episode does not go through the Foray press");
});

test("Resume yields to the player while it SOUNDS: what is playing is the mini player's, not a card; a paused one keeps its card", async () => {
  /* MUTATION: drop the isPlaying / running check in todayResumeEntry. MUTATION 2:
     hide on isCurrent instead (the bar restores the last episode at every launch,
     so the card would nearly never show) -> the paused assertions fail. */
  const bridge = await makeBridge({ lastEpisode: { ...EP(3), updated_at: "2026-09-20T00:00:00Z", percent: 30, label: "20 min left" } });
  bridge.setCurrent("ep-3", true);
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  app.ctx.renderHome();
  assert.ok(!app.view.innerHTML.includes("today-resume"));
  const live = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 40, label: "30 min left", finished: false }] });
  live.setForayLive({ forayId: FORAY_ID, running: true });
  const app2 = loadApp(live, { cardSlots: [subjectSlot([EP(2)])] });
  app2.ctx.renderHome();
  assert.ok(!app2.view.innerHTML.includes("today-resume"));

  const paused = await makeBridge({ lastEpisode: { ...EP(3), updated_at: "2026-09-20T00:00:00Z", percent: 30, label: "20 min left" } });
  paused.setCurrent("ep-3", false);
  const app3 = loadApp(paused, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  app3.ctx.renderHome();
  assert.ok(app3.view.innerHTML.includes("today-resume"), "loaded but paused: the card stays");
  const idle = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 40, label: "30 min left", finished: false }] });
  idle.setForayLive({ forayId: FORAY_ID, running: false });
  const app4 = loadApp(idle, { cardSlots: [subjectSlot([EP(2)])] });
  app4.ctx.renderHome();
  assert.ok(app4.view.innerHTML.includes("today-resume"), "a paused Foray keeps its card too");
});

test("a playlist is never a Resume card, and the same Foray is not offered twice while another can stand in", async () => {
  /* MUTATION: accept kind "playlist" in todayResumeEntry. MUTATION 2: drop the
     `skip` in todayForayPick -> with two listable Forays the hero repeats Resume's. */
  const pl = { id: "pl-1", title: "Road trip", created: "2026-09-01T00:00:00Z", last_played_at: "2026-09-02T00:00:00Z", items: [{ id: "ep-2" }, { id: "ep-3" }] };
  const app = loadApp(await makeBridge(), { playlists: [pl], cardSlots: [subjectSlot([EP(1)])], forays: false });
  /* Half-played (one of two episodes opened): the entry has a percent, so only the
     kind filter keeps it off Resume. */
  app.ctx.lsSet("cp_history", ["ep-2"]);
  const entry = app.ctx.jumpBackInEntries().find((e) => e.kind === "playlist");
  assert.strictEqual(entry.percent, 50, "premise: the playlist is part-played");
  app.ctx.renderHome();
  assert.ok(!app.view.innerHTML.includes("today-resume"));

  const bridge = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 40, label: "30 min left", finished: false }] });
  const real = bridge.listForays;
  const twin = { id: "capital-types-1-copy", title: "Twin", topic: "history", status: "published" };
  bridge.listForays = (doc, opts) => [...real(doc, opts), twin];
  const app2 = loadApp(bridge, { cardSlots: [subjectSlot([EP(2)])] });
  /* The twin resolves like the original: same running order under another id. */
  const resolve = bridge.resolve.bind(bridge);
  bridge.resolve = (doc, o) => (o.id === twin.id ? resolve(doc, { ...o, id: FORAY_ID }) : resolve(doc, o));
  app2.ctx.renderHome();
  const html = app2.view.innerHTML;
  assert.strictEqual(heroKey(html)[1], twin.id, "the hero is the other Foray");
  assert.strictEqual(resumeSection(html).includes(`data-home-play="${FORAY_ID}"`), true);
});

/* ==================================================================== */
/* 3. THE PLAY CONVENTIONS                                               */
/* ==================================================================== */

test("a hero press starts the Foray from the top when nothing is stored", async () => {
  /* MUTATION: pass startElapsedSec: 0 instead of startIndex: 0 for a fresh start. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { cardSlots: [] });
  await bindAndPress(app);
  assert.strictEqual(bridge.calls.playForay[0]?.r.id, FORAY_ID);
  assert.strictEqual(bridge.calls.playForay[0].opts.startIndex, 0, "no stored resume: from the top");
});

test("the key carries the loading mark while the start is in flight, and a second press then does nothing", async () => {
  /* MUTATION: drop the `data-loading` write, or the early return on it -> the
     mark is missing mid-load, or a second playForay() is issued. */
  const bridge = await makeBridge();
  const pending = [];
  bridge.playForayImpl = () => new Promise((r) => { pending.push(r); });
  const app = loadApp(bridge, { cardSlots: [] });
  const btn = fakeButton();
  app.ctx.bindHomePlay({ querySelectorAll: () => [btn] });
  const first = btn.handler();
  assert.strictEqual(btn.dataset.loading, "1", "the tapped control shows it is loading");
  assert.strictEqual(btn.attrs["aria-busy"], "true");
  const second = btn.handler();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bridge.calls.playForay.length, 1, "a press during the load is not a second start");
  pending.forEach((r) => r({ items: [] }));
  await Promise.all([first, second]);
  assert.strictEqual(btn.dataset.loading, undefined);
  assert.strictEqual(btn.attrs["aria-busy"], undefined);
});

test("a Foray start that throws is reported on the bar; a refusal is reported; a superseded start is not", async () => {
  /* MUTATION: drop the catch's reportPlayFailure in startHomeForay -> the throw
     goes unreported. MUTATION 2: drop the forayStatus check on a null report ->
     the superseded start is reported as a failure. */
  const boom = new Error("no audio");
  const cases = [
    ["throw", (b) => { b.playForayImpl = () => { throw boom; }; }, [boom]],
    ["refused, still ours", (b) => { b.playForayImpl = () => null; }, [null]],
    ["superseded", (b) => { b.playForayImpl = () => { b.setForayLive({ forayId: "someone-else", running: true }); return null; }; }, []],
  ];
  for (const [name, setup, expected] of cases) {
    const bridge = await makeBridge();
    setup(bridge);
    const app = loadApp(bridge, { cardSlots: [] });
    const btn = await bindAndPress(app);
    assert.deepStrictEqual(bridge.calls.failures, expected, name);
    assert.strictEqual(btn.dataset.loading, undefined, `${name}: the loading mark is cleared`);
  }
});

test("a press on the Foray already live resumes it rather than rebuilding it", async () => {
  /* MUTATION: drop the forayStatus check in startHomeForay -> playForay rebuilds it. */
  const bridge = await makeBridge();
  bridge.setForayLive({ forayId: FORAY_ID, running: false });
  const app = loadApp(bridge, { cardSlots: [] });
  await bindAndPress(app);
  assert.strictEqual(bridge.calls.playForay.length, 0);
  assert.strictEqual(bridge.calls.forayToggle, 1);
  bridge.setForayLive({ forayId: FORAY_ID, running: true });
  await bindAndPress(app);
  assert.strictEqual(bridge.calls.forayToggle, 1, "\"Play\" never pauses what is playing");
});

test("the Foray is resolved at the press: a key whose Foray has since left plays nothing", async () => {
  /* MUTATION: capture `r` at render and play it regardless -> playForay is called for a ghost. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { cardSlots: [] });
  await bindAndPress(app, fakeButton("ghost-foray"));
  assert.strictEqual(bridge.calls.playForay.length, 0);
});

test("a half-heard episode still gets its Resume card behind more than six newer playlists", async () => {
  /* The old rail was capped at six entries, newest first, across all three kinds;
     Resume reads the same list, so with the cap six newer playlists would have
     hidden the one thing it exists for.
     MUTATION: call jumpBackInEntries() (default cap) instead of
     jumpBackInEntries(Infinity) in homeRailPicks -> no Resume card. */
  const playlists = Array.from({ length: 8 }, (_, i) => ({
    id: `pl-${i}`, title: `P${i}`, created: "2026-09-01T00:00:00Z", last_played_at: `2026-09-2${i}T00:00:00Z`, items: [{ id: "ep-2" }],
  }));
  const bridge = await makeBridge({ lastEpisode: { ...EP(3), updated_at: "2026-09-10T00:00:00Z", percent: 30, label: "20 min left" } });
  const app = loadApp(bridge, { playlists, cardSlots: [subjectSlot([EP(1)])], forays: false });
  app.ctx.renderHome();
  assert.ok(app.view.innerHTML.includes("today-resume"), "Resume survives the cap");
});
