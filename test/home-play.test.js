/* Home's one play button (founder, 2026-09-24).
 *
 * FOUNDER: "Add a play button at the Home Screen level and start playing
 * whatever is first in that list (whether it be Suggested or a Playlist or
 * whatever)".
 *
 * WHAT THIS PROVES, in order:
 *  1. The button sits under the greeting, above the first rail.
 *  2. It plays the first playable thing of the first rail Home draws, for each
 *     kind a first rail can hold: a Jump back in Foray (resumed), episode and
 *     playlist; a "Forays for you" Foray (from the top); a "Playlists for you"
 *     playlist; a "Suggested" subject queue. Its accessible name is
 *     "Play <what it plays>".
 *  3. A rail with nothing playable is passed over, not stopped at.
 *  4. Nothing playable on Home: no button at all.
 *  5. The round-1/2 play conventions: the loading mark while the start is in
 *     flight (and a second press does nothing), a failure is reported, a
 *     superseded start is not, and a press on what is already the player's
 *     never restarts it (a paused one resumes; a playing one is left alone).
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

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
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
  vm.runInContext(SRC, ctx, { filename: "app.js" });
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
function fakeButton() {
  const attrs = {};
  const btn = {
    dataset: {}, attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(_t, fn) { btn.handler = fn; },
  };
  return btn;
}

/** Render Home's button, bind it the way renderHomeV2 does, and press it. */
async function renderAndPress(app, btn = fakeButton()) {
  const html = app.ctx.homePlayHtml();
  app.ctx.bindHomePlay({ querySelector: (sel) => (sel === "[data-home-play]" ? btn : null) });
  assert.ok(btn.handler, "bindHomePlay bound no handler");
  await btn.handler();
  return { html, btn };
}

const label = (html) => (/data-home-play aria-label="([^"]*)"/.exec(html) || [])[1];
const subjectSlot = (items) => ({ branch: "history", role: "top", item: items[0], items });

/* ==================================================================== */
/* 1. WHERE IT IS                                                        */
/* ==================================================================== */

test("the button renders under the greeting, above the first rail", async () => {
  /* MUTATION: move `${homePlayHtml()}` below the rails in renderHomeV2, or drop it. */
  const app = loadApp(await makeBridge({ lastEpisode: { ...EP(1), updated_at: "2026-09-20T00:00:00Z", percent: 30, label: "20 min left" } }), { cardSlots: [subjectSlot([EP(2)])] });
  app.ctx.renderHome();
  const html = app.view.innerHTML;
  const at = (s) => html.indexOf(s);
  assert.ok(at("data-home-play") > -1, "Home has no play button");
  assert.ok(at("hv2-greeting") < at("data-home-play") && at("data-home-play") < at("hv2-jbi"),
    "the play button must sit between the greeting and the first rail");
  assert.strictEqual((html.match(/data-home-play/g) || []).length, 1, "ONE play control, not one per rail");
});

/* ==================================================================== */
/* 2. EACH KIND OF FIRST RAIL                                            */
/* ==================================================================== */

test("first rail Jump back in, a Foray first: it resumes that Foray, and says so by name", async () => {
  /* MUTATION: start a Foray with `startIndex: 0` always (drop the forayResume
     read) -> startElapsedSec is missing. MUTATION 2: make homePlayRails skip
     Jump back in -> the label names something else. */
  const bridge = await makeBridge({ resumeRows: [{ id: FORAY_ID, title: FORAY_TITLE, updated_at: "2026-09-21T00:00:00Z", percent: 40, label: "30 min left", finished: false, drift: "unverified" }] });
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(2)])] });
  const { html, btn } = await renderAndPress(app);
  assert.strictEqual(label(html), `Play ${FORAY_TITLE}`);
  assert.strictEqual(bridge.calls.playForay.length, 1, "the Foray starts");
  assert.strictEqual(bridge.calls.playForay[0].r.id, FORAY_ID);
  assert.strictEqual(bridge.calls.playForay[0].opts.startElapsedSec, 600, "a Jump back in Foray resumes where it was left");
  assert.strictEqual(bridge.calls.play.length, 0);
  assert.strictEqual(btn.dataset.loading, undefined, "the loading mark is cleared once the start settles");
});

test("first rail Jump back in, an episode first: it plays that episode", async () => {
  /* MUTATION: drop the `episode` branch from homePlayable -> the Suggested queue
     plays instead and the label names History. */
  const bridge = await makeBridge({ lastEpisode: { ...EP(3), updated_at: "2026-09-20T00:00:00Z", percent: 30, label: "20 min left" } });
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), "Play Episode 3");
  assert.deepStrictEqual(bridge.calls.play.map((c) => c.item.id), ["ep-3"]);
  assert.ok(app.ctx.pickedHistory().includes("ep-3"), "an accepted play is recorded, as a row's ▶ records it");
});

test("first rail Jump back in, a playlist first: its first playable row plays, the playlist is the list, and last_played_at is stamped", async () => {
  /* MUTATION: pass no ctx from homePlayable -> last_played_at is not re-stamped
     and the play list is only the one episode. */
  const pl = { id: "pl-1", title: "Road trip", created: "2026-09-01T00:00:00Z", last_played_at: "2026-09-02T00:00:00Z", items: [{ id: "ep-2" }, { id: "ep-3" }] };
  const bridge = await makeBridge();
  const app = loadApp(bridge, { playlists: [pl], cardSlots: [subjectSlot([EP(1)])], forays: false });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), "Play Road trip");
  assert.deepStrictEqual(bridge.calls.play.map((c) => c.item.id), ["ep-2"]);
  assert.deepStrictEqual([...vm.runInContext("state.playList", app.ctx)], ["ep-2", "ep-3"], "continuous playback goes on through the playlist");
  const saved = JSON.parse(app.store.get("cp_playlists"));
  assert.notStrictEqual(saved[0].last_played_at, "2026-09-02T00:00:00Z", "playing a playlist stamps it, as a row's ▶ does");
});

test("first rail Forays for you: its first Foray starts from the top", async () => {
  /* MUTATION: drop the Forays-for-you rail from homePlayRails -> the Suggested
     queue plays instead. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])] });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), `Play ${FORAY_TITLE}`);
  assert.strictEqual(bridge.calls.playForay[0]?.r.id, FORAY_ID);
  assert.strictEqual(bridge.calls.playForay[0].opts.startIndex, 0, "no stored resume: from the top");
});

test("first rail Playlists for you: the listener's own playlist plays before Suggested", async () => {
  /* A playlist never played is not in Jump back in; it is the first card of
     Playlists for you. MUTATION: drop that rail from homePlayRails -> Suggested's
     History queue plays instead. */
  const pl = { id: "pl-2", title: "Never played", created: "2026-09-01T00:00:00Z", items: [{ id: "ep-3" }, { id: "ep-1" }] };
  const bridge = await makeBridge();
  const app = loadApp(bridge, { playlists: [pl], cardSlots: [subjectSlot([EP(2)])], forays: false });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), "Play Never played");
  assert.deepStrictEqual(bridge.calls.play.map((c) => c.item.id), ["ep-3"]);
});

test("first rail Suggested: the first subject queue starts, and its rows are the list", async () => {
  /* MUTATION: drop the Suggested rail from homePlayRails -> no button at all. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1), EP(2)])], forays: false });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), "Play History");
  assert.deepStrictEqual(bridge.calls.play.map((c) => c.item.id), ["ep-1"]);
  assert.deepStrictEqual([...vm.runInContext("state.playList", app.ctx)], ["ep-1", "ep-2"]);
});

/* ==================================================================== */
/* 3. PASSED OVER, NOT STOPPED AT                                         */
/* ==================================================================== */

test("a rail with nothing playable is passed over: a playlist whose episodes left the catalogue gives way to Suggested", async () => {
  /* MUTATION: return the first candidate of the first non-empty rail without
     asking homePlayable -> the button names "Gone" and plays nothing. */
  const pl = { id: "pl-3", title: "Gone", created: "2026-09-01T00:00:00Z", last_played_at: "2026-09-02T00:00:00Z", items: [{ id: "ep-9", title: "Retired" }] };
  const bridge = await makeBridge();
  const app = loadApp(bridge, { pool: [EP(1, { audio_url: null }), EP(2)], playlists: [pl], cardSlots: [subjectSlot([EP(1, { audio_url: null }), EP(2)])], forays: false });
  const { html } = await renderAndPress(app);
  assert.strictEqual(label(html), "Play History");
  assert.deepStrictEqual(bridge.calls.play.map((c) => c.item.id), ["ep-2"], "and within the queue, the first row that can play");
});

/* ==================================================================== */
/* 4. NOTHING PLAYABLE                                                   */
/* ==================================================================== */

test("with nothing playable on Home there is no button", async () => {
  /* MUTATION: render the button with a generic "Play" when homePlayTarget is null. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { pool: [EP(1, { audio_url: null })], cardSlots: [subjectSlot([EP(1, { audio_url: null })])], forays: false });
  assert.strictEqual(app.ctx.homePlayHtml(), "");
  app.ctx.renderHome();
  assert.ok(!app.view.innerHTML.includes("data-home-play"));
});

/* ==================================================================== */
/* 5. THE PLAY CONVENTIONS                                               */
/* ==================================================================== */

test("the button carries the loading mark while the start is in flight, and a second press then does nothing", async () => {
  /* MUTATION: drop the `data-loading` write, or the early return on it -> the
     mark is missing mid-load, or a second play() is issued. */
  const bridge = await makeBridge();
  const pending = [];
  bridge.playImpl = () => new Promise((r) => { pending.push(r); });
  const release = (v) => pending.forEach((r) => r(v));
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  const btn = fakeButton();
  app.ctx.homePlayHtml();
  app.ctx.bindHomePlay({ querySelector: () => btn });
  const first = btn.handler();
  assert.strictEqual(btn.dataset.loading, "1", "the tapped control shows it is loading");
  assert.strictEqual(btn.attrs["aria-busy"], "true");
  const second = btn.handler();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bridge.calls.play.length, 1, "a press during the load is not a second start");
  bridge.setCurrent("ep-1", true);
  release(true);
  await Promise.all([first, second]);
  assert.strictEqual(btn.dataset.loading, undefined);
  assert.strictEqual(btn.attrs["aria-busy"], undefined);
});

test("a start that throws is reported on the bar; a refusal is reported; a superseded start is not", async () => {
  /* MUTATION: drop startEpisodePlay's reportPlayFailure calls -> the first two
     go unreported. MUTATION 2: drop the isCurrent check on a false answer ->
     the superseded start is reported as a failure. */
  const boom = new Error("load failed");
  for (const [name, impl, expected] of [
    ["throw", () => { throw boom; }, [boom]],
    ["refused, still ours", (item) => { bridge.setCurrent(item.id, false); return false; }, [null]],
    ["superseded", () => { bridge.setCurrent("ep-other", true); return false; }, []],
  ]) {
    var bridge = await makeBridge(); // eslint-disable-line no-var
    bridge.playImpl = impl;
    const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
    const { btn } = await renderAndPress(app);
    assert.deepStrictEqual(bridge.calls.failures, expected, name);
    assert.strictEqual(btn.dataset.loading, undefined, `${name}: the loading mark is cleared`);
    assert.ok(!app.ctx.pickedHistory().includes("ep-1"), `${name}: a start that did not happen is not history`);
  }
});

test("a Foray start that throws is reported on the bar", async () => {
  /* MUTATION: drop the catch's reportPlayFailure in startHomeForay. */
  const bridge = await makeBridge();
  const boom = new Error("no audio");
  bridge.playForayImpl = () => { throw boom; };
  const app = loadApp(bridge, { cardSlots: [] });
  await renderAndPress(app);
  assert.deepStrictEqual(bridge.calls.failures, [boom]);
});

test("a press on what is already the player's never restarts it: paused resumes, playing is left alone", async () => {
  /* MUTATION: drop the isCurrent guard in startHomeEpisode -> play() restarts
     the episode. MUTATION 2: toggle unconditionally -> the playing case pauses. */
  const bridge = await makeBridge();
  const app = loadApp(bridge, { cardSlots: [subjectSlot([EP(1)])], forays: false });
  bridge.setCurrent("ep-1", false);
  await renderAndPress(app);
  assert.strictEqual(bridge.calls.play.length, 0, "no restart");
  assert.strictEqual(bridge.calls.toggle, 1, "a paused current episode resumes");
  bridge.setCurrent("ep-1", true);
  await renderAndPress(app);
  assert.strictEqual(bridge.calls.toggle, 1, "\"Play\" never pauses what is playing");
  assert.strictEqual(bridge.calls.play.length, 0);
});

test("a press on the Foray already live resumes it rather than rebuilding it", async () => {
  /* MUTATION: drop the forayStatus check in startHomeForay -> playForay rebuilds it. */
  const bridge = await makeBridge();
  bridge.setForayLive({ forayId: FORAY_ID, running: false });
  const app = loadApp(bridge, { cardSlots: [] });
  await renderAndPress(app);
  assert.strictEqual(bridge.calls.playForay.length, 0);
  assert.strictEqual(bridge.calls.forayToggle, 1);
});
