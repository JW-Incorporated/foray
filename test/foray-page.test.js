/* The Foray page's lifecycle (code-health CH-22: A3-01, A3-02, A3-03).
 *
 * One resolve call, one resume-point read, and the page's state cleared when
 * the listener leaves it:
 *   - the page resolves its Foray through the same call every list surface
 *     uses, and a resolver that throws lands on the page's own "Couldn't load
 *     forays right now." with Try again, not on a "Loading…" that never ends;
 *   - the stored point is read once, by one helper, which splits "a place to
 *     resume" from "played to the end" and survives a throwing read;
 *   - leaving the page clears `state.foray*` and unhooks the page's callback, so
 *     a Foray still playing in the mini bar cannot write its resume point into
 *     state while Home is on screen.
 *
 * Harness: the REAL app.js in a node:vm over the shared small DOM
 * (test/helpers/fake-dom.js), copied from test/load-states.test.js — the mount,
 * and a bridge over the REAL resolver and strip modules reading the FROZEN
 * fixture (never a live Foray id).
 *
 * Every test names the mutation that turns it red; each was run red once.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const { El } = require("./helpers/fake-dom.js");

process.on("unhandledRejection", () => {});

const FZ = "tools/foray/fixtures/frozen/data";
const ID = "capital-types-1";   // published, 22 items, in the frozen fixture
const readFrozen = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const playerMods = (async () => ({
  resolve: await import("../player/foray-resolve.js"),
  strip: await import("../player/segment-strip.js"),
}))();

/** A bridge over the real resolver and strip, recording what the page asked of
    it. `point` is what `forayResume` answers; `watched` every callback the
    page handed `watchForay`, `null` included. */
async function forayBridge() {
  const { resolve, strip } = await playerMods;
  const b = {
    point: null,
    watched: [],
    starts: [],
    events: [],
    resolve(doc, { id, segmentsDoc, sourcesDoc } = {}) {
      const f = resolve.findForay(doc, id, { unlocked: [id], showDrafts: true });
      return f ? resolve.resolveForay(f, { segments: resolve.indexSegments(segmentsDoc), sources: resolve.indexSources(sourcesDoc) }) : null;
    },
    stripTally: strip.stripTally,
    stripModel: strip.stripModel,
    fmtClock: resolve.fmtClock,
    fmtSpan: resolve.fmtSpan,
    narratorName: strip.NARRATOR_NAME,
    playbackRate: () => 1, rateStops: () => [1], setPlaybackRate() {},
    forayResume: (_id, opts = {}) => {
      const p = typeof b.point === "function" ? b.point(opts) : b.point;
      return p && p.finished && !opts.includeFinished ? null : p;
    },
    clearForayResume() {},
    watchForay: (fn) => { b.watched.push(fn); return null; },
    playForay: async (r, opts) => { b.starts.push(opts); return true; },
    forayToggle: async () => {},
    listForays: (doc) => (doc?.forays || []).filter((f) => f.status === "published"),
    forayResumeList: () => [],
  };
  return b;
}

function mount({ hash, bridge }) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const fetched = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => { fetched.push(String(url)); return new Promise(() => {}); },
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
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  ctx.logEvent = (type, data) => { bridge.events.push([type, data]); };
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [{ id: "science", label: "Science" }] };
  state.forays = readFrozen(`${FZ}/forays.json`);
  state.segments = readFrozen(`${FZ}/segments.json`);
  state.segmentSources = readFrozen(`${FZ}/segment-sources.json`);
  return { ctx, state, view, fetched, html: () => view.innerHTML };
}

/** A press that leaves the handlers bound (the shared DOM's click() is
    one-shot, which is right for a Try again and wrong for a Play pressed twice). */
function press(el) {
  for (const fn of [...(el._on.get("click") || [])]) fn({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} });
}

async function settle(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

/** Navigate the way the router does: the hash moves, then the page renders. */
async function go(m, hash) {
  m.ctx.location.hash = hash;
  m.ctx.renderCurrentPage();
  await settle();
}

async function openForay(point = null) {
  const b = await forayBridge();
  b.point = point;
  const m = mount({ hash: `#/foray/${ID}`, bridge: b });
  m.ctx.renderCurrentPage();
  await settle();
  return { ...m, bridge: b };
}

const PART = { elapsedSec: 600, index: 3, percent: 20, label: "40 min left", drift: "unverified" };
const DONE = { finished: true, elapsedSec: 3000, index: 21, percent: 100, remainingSec: 0, label: "Played", drift: "unverified" };

/* ==================================================================== */
/* Characterization: today's page                                        */
/* ==================================================================== */

test("characterization: a part-played Foray opens on 'Jump back in at' with Start over, and the main button resumes there", async () => {
  /* MUTATION: drop the resume half of renderForay's point read (always null) —
     no banner, red. */
  const m = await openForay(PART);
  assert.strictEqual(m.state.foray?.id, ID, "the page resolved its Foray");
  assert.match(m.html(), /Jump back in at 10:00/);
  assert.match(m.html(), /id="fy-restart">Start over<\/button>/);
  assert.doesNotMatch(m.html(), /fy-played/);
  assert.strictEqual(m.state.forayResume?.elapsedSec, 600, "the main button's start point");
  press(m.view.querySelector("#fy-play"));
  await settle();
  assert.strictEqual(m.bridge.starts.length, 1);
  assert.strictEqual(m.bridge.starts[0].startElapsedSec, 600, "Play resumes from the stored point");
});

test("characterization: a finished Foray opens on 'Played' with Play again, and the main button starts from the top", async () => {
  /* MUTATION: drop `includeFinished: true` from the page's point read (the
     bridge then answers null for a finished point, as the real one does) — no
     Played banner, red. */
  const m = await openForay(DONE);
  assert.match(m.html(), /class="fy-resume fy-played" id="fy-resume"[\s\S]*?>Played<\/span>[\s\S]*?id="fy-restart">Play again<\/button>/);
  assert.doesNotMatch(m.html(), /Jump back in at/);
  assert.strictEqual(m.state.forayResume, null);
  press(m.view.querySelector("#fy-play"));
  await settle();
  assert.strictEqual(m.bridge.starts[0].startIndex, 0, "from the top");
});

test("characterization: navigating Home and back re-renders the Foray page and re-hooks its callback", async () => {
  /* MUTATION: make renderForay return early when `state.foray` already names
     this id — the page comes back as Home's markup, red. */
  const m = await openForay(PART);
  await go(m, "#/");
  assert.doesNotMatch(m.html(), /id="fy-play"/, "fixture: Home is on screen");
  await go(m, `#/foray/${ID}`);
  assert.match(m.html(), /id="fy-play"/, "the Foray page is back");
  assert.match(m.html(), /Jump back in at 10:00/, "with its resume point read again");
  assert.strictEqual(m.state.foray?.id, ID);
  assert.strictEqual(typeof m.bridge.watched.at(-1), "function", "and the live player paints this page again");
});

test("characterization: a start that fails leaves the page standing — the next Play retries from the same point", async () => {
  /* guardForayStart clears only the LIVE half (`forayPlaying`, `forayPainted`):
     the listener is still on the page, so the Foray and its resume point stay.
     MUTATION: have guardForayStart call leaveForayPage() — state.foray and
     state.forayResume go null and the retry starts from 0, red. */
  const m = await openForay(PART);
  let fail = true;
  m.bridge.playForay = async (_r, opts) => { m.bridge.starts.push(opts); if (fail) throw new Error("refused"); return true; };
  press(m.view.querySelector("#fy-play"));
  await settle();
  assert.strictEqual(m.state.foray?.id, ID, "the page's Foray survives a failed start");
  assert.strictEqual(m.state.forayResume?.elapsedSec, 600, "and so does its resume point");
  assert.strictEqual(m.state.forayPlaying, null);
  fail = false;
  press(m.view.querySelector("#fy-play"));
  await settle();
  assert.strictEqual(m.bridge.starts.length, 2);
  assert.strictEqual(m.bridge.starts[1].startElapsedSec, 600, "the retry resumes where the first press meant to");
});

/* ==================================================================== */
/* A3-01: a resolver that throws is a failed load, with Try again        */
/* ==================================================================== */

test("A3-01: a resolve that throws paints 'Couldn't load forays right now.' with a Try again that re-fetches the Foray documents", async () => {
  /* Was: the throw escaped renderForay and the page sat on "Loading…" with no
     Try again. MUTATION: drop the try/catch around renderForay's resolve — the
     page stays on "Loading…", red. */
  const b = await forayBridge();
  b.resolve = () => { throw new Error("malformed segments doc"); };
  const m = mount({ hash: `#/foray/${ID}`, bridge: b });
  m.ctx.renderCurrentPage();
  await settle();
  assert.match(m.html(), /Couldn't load forays right now\./, m.html().slice(0, 300));
  assert.doesNotMatch(m.html(), /Loading…/);
  assert.ok(m.view.querySelector(".back"), "with its way back");
  const btn = m.view.querySelector("[data-retry]");
  assert.ok(btn, "and Try again");
  const before = m.fetched.length;
  btn.click();
  assert.ok(m.fetched.slice(before).some((u) => /data\/forays\.json/.test(u)), "wired to the Foray documents (retryForayDocs), not to a re-render");
  assert.strictEqual(m.state.foray, null, "no Foray is on screen");
});

/* ==================================================================== */
/* A3-03: one resume-point read                                          */
/* ==================================================================== */

test("A3-03: a resume-point read that throws opens the page with no offer, not a page stuck on 'Loading…'", async () => {
  /* Was: refreshForayResume swallowed a throwing `forayResume` and renderForay
     did not. MUTATION: drop the try/catch inside readForayPoint — renderForay
     throws and the page stays on "Loading…", red. */
  const b = await forayBridge();
  b.forayResume = () => { throw new Error("corrupt progress row"); };
  const m = mount({ hash: `#/foray/${ID}`, bridge: b });
  m.ctx.renderCurrentPage();
  await settle();
  assert.match(m.html(), /id="fy-play"/, "the page rendered");
  assert.doesNotMatch(m.html(), /id="fy-resume"/, "with no resume offer");
  assert.strictEqual(m.state.forayResume, null);
});

test("A3-03: the page reads its point with the resolved Foray and includeFinished, and nothing else", async () => {
  /* `totalSec` and `itemCount` were passed beside `resolved`, from which the
     player derives both. MUTATION: pass `totalSec: 1` again — red. */
  const b = await forayBridge();
  const asked = [];
  b.point = (opts) => { asked.push(opts); return PART; };
  const m = mount({ hash: `#/foray/${ID}`, bridge: b });
  m.ctx.renderCurrentPage();
  await settle();
  assert.strictEqual(asked.length, 1, "one read at render");
  assert.deepStrictEqual(Object.keys(asked[0]).sort(), ["includeFinished", "resolved"]);
  assert.strictEqual(asked[0].resolved, m.state.foray);
  assert.strictEqual(asked[0].includeFinished, true);
});

test("A3-03: Start over logs the point the page holds NOW, not the one it rendered with", async () => {
  /* Render on 10:00, play to the end, close the bar: the point reads finished
     and the banner turns into Played / Play again. Pressing it logged
     `from_sec: 600` from the bind-time `resume` parameter, a point that no
     longer existed. MUTATION: restore `|| resume?.elapsedSec` (the parameter)
     in the restart handler — from_sec 600, red. */
  const m = await openForay(PART);
  const onChange = m.bridge.watched.at(-1);
  onChange({ forayId: ID, index: 20, playing: true, running: true, elapsedSec: 2990 });
  m.bridge.point = DONE;
  onChange({ forayId: ID, index: -1, playing: false, running: false, elapsedSec: 0 });
  assert.strictEqual(m.state.forayResume, null, "premise: no resume point once played to the end");
  m.view.querySelector("#fy-restart").click();
  await settle();
  const restart = m.bridge.events.find(([t]) => t === "foray_restart");
  assert.ok(restart, "the restart is logged");
  assert.strictEqual(restart[1].from_sec, 0);
});

/* ==================================================================== */
/* A3-02: leaving the page clears its state                              */
/* ==================================================================== */

test("A3-02: after navigating Home, the Foray still in the bar cannot write the page's resume point", async () => {
  /* Listener plays Foray A, goes Home, closes the bar: the page's callback
     still ran paintForay, whose live->cold step re-read A's point into
     `state.forayResume` with Home on screen. MUTATION: drop the
     leaveForayPage() call from renderCurrentPage — state.foray is still A and
     state.forayResume 30:00, red. */
  const m = await openForay(PART);
  const onChange = m.bridge.watched.at(-1);
  onChange({ forayId: ID, index: 5, playing: true, running: true, elapsedSec: 1800 });
  assert.strictEqual(m.state.forayPlaying, ID, "fixture: the page saw the Foray live");
  await go(m, "#/");
  m.bridge.point = { ...PART, elapsedSec: 1800, index: 5 };
  onChange({ forayId: ID, index: -1, playing: false, running: false, elapsedSec: 0 });   // the bar is closed
  assert.strictEqual(m.state.forayResume, null, "no resume point written while Home is on screen");
  assert.strictEqual(m.state.foray, null, "no Foray is 'on screen'");
  assert.strictEqual(m.state.forayPlaying, null);
  assert.strictEqual(m.state.forayPainted, null);
  assert.strictEqual(m.state.forayPaintedLive, null);
});

test("A3-02: leaving the page unhooks its callback from the live player", async () => {
  /* MUTATION: drop `watchForay(null)` from leaveForayPage — the last callback
     the player holds is still the Foray page's, red. */
  const m = await openForay(PART);
  assert.strictEqual(typeof m.bridge.watched.at(-1), "function", "fixture: the page hooked itself");
  await go(m, "#/");
  assert.strictEqual(m.bridge.watched.at(-1), null, "Home holds no Foray callback");
});

/* ==================================================================== */
/* A3-05 (code-health CH-39): the bridge's capabilities are visible      */
/* ==================================================================== */

/** FORAY_PAGE_EXPORTS, read out of the vm (a top-level `const` is not a
    property of the global object); [] before CH-39 defined it. */
function pageExports(ctx) {
  return [...vm.runInContext("typeof FORAY_PAGE_EXPORTS === 'undefined' ? [] : FORAY_PAGE_EXPORTS", ctx)];
}

/** The page, opened over a bridge that has every export the Foray page names
    except `drop`, with the field record's page entry (`forayNoteDataSource`)
    captured. The rest of the bridge is the real one above. */
async function openForayWithout(drop) {
  const b = await forayBridge();
  const noop = () => null;
  Object.assign(b, {
    stripInto() {}, forayCredits: () => ({ credits: [], summary: "" }),
    nudgeSteps: () => ({ back: 15, fwd: 30 }), rateLabel: (r) => `${r}×`,
  });
  delete b[drop];
  const m = mount({ hash: `#/foray/${ID}`, bridge: b });
  const rows = [];
  const warned = [];
  m.ctx.forayNoteDataSource = (fields) => { rows.push(fields); return true; };
  m.ctx.console.warn = (...args) => { warned.push(args.join(" ")); };
  /* Anything the page names that this bridge still lacks is stubbed, so the one
     export missing is the one the test dropped. */
  for (const name of pageExports(m.ctx)) if (name !== drop && typeof b[name] !== "function") b[name] = noop;
  m.ctx.renderCurrentPage();
  await settle();
  return { ...m, bridge: b, rows, warned };
}

test("characterization: a bridge with no `stripTally` still renders the Foray page, without the header's counts", async () => {
  /* THE DEGRADE STAYS (sw.js's "THE PIN CAN STILL LAND AFTER THE DATA" relies
     on it): a module of another vintage costs a section, never the page.
     MUTATION: call `player.stripTally(r.playable)` unguarded in forayHeadSub —
     the page throws and stays on "Loading…", red. */
  const m = await openForayWithout("stripTally");
  assert.match(m.html(), /id="fy-play"/, "the page rendered");
  const sub = /<p class="sub">([^<]*)<\/p>/.exec(m.html());
  assert.ok(sub, "the header line is there");
  assert.doesNotMatch(sub[1], /clip|show/, "with no counts: a missing number, not a wrong one");
  assert.match(sub[1], /^\d+ min$/, `the runtime alone: "${sub[1]}"`);
});

test("A3-05: a missing bridge export is said once — a console line and one diagnostics row naming it — and the page still renders", async () => {
  /* Was: a typo or rename of a bridge export shipped green and the page lost
     its header counts with nothing anywhere saying why. MUTATION: delete the
     `bridgeCapabilities(player, id)` call from renderForay — no row and no
     line, red. MUTATION: drop the once-per-load guard — the second render
     writes a second row, red. */
  const m = await openForayWithout("stripTally");
  assert.match(m.html(), /id="fy-play"/, "the page still rendered");
  assert.strictEqual(m.rows.length, 1, `one diagnostics row: ${JSON.stringify(m.rows)}`);
  const row = m.rows[0];
  assert.strictEqual(row.status, "bridge-missing");
  assert.strictEqual(row.trigger, "foray-page");
  assert.strictEqual(row.code, "strip-tally", "the export, as a token diagnostic-log.js admits (lower-case, no prose)");
  assert.strictEqual(row.forayId, ID);
  assert.ok(m.warned.some((w) => /stripTally/.test(w)), `and the console names it: ${JSON.stringify(m.warned)}`);
  await go(m, "#/");
  await go(m, `#/foray/${ID}`);
  assert.match(m.html(), /id="fy-play"/, "fixture: the page rendered a second time");
  assert.strictEqual(m.rows.length, 1, "once per page load, not once per visit: the ring is 200 entries");
});

test("A3-05: a complete bridge writes no row", async () => {
  /* MUTATION: put an export the real ForayPlayer does not have in
     FORAY_PAGE_EXPORTS (the test below goes red too) — or invert the filter in
     bridgeCapabilities — and a complete bridge reports a gap, red. */
  const m = await openForayWithout("__nothing__");
  assert.match(m.html(), /id="fy-play"/);
  assert.deepStrictEqual(m.rows, []);
  assert.deepStrictEqual(m.warned.filter((w) => /bridge/.test(w)), []);
});

test("A3-05: every export the Foray page names is a member of the real ForayPlayer (player/client.js)", () => {
  /* The list is what turns a rename into a red build instead of a silent
     section. Read off client.js's ForayPlayer object literal: a member is a
     line indented two spaces that opens with its name. MUTATION: rename
     `stripTally` in client.js's ForayPlayer (or misspell it in
     FORAY_PAGE_EXPORTS) — red. */
  const client = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8");
  const start = client.indexOf("const ForayPlayer = {");
  assert.ok(start >= 0, "fixture: client.js defines ForayPlayer as an object literal");
  const body = client.slice(start);
  const m = mount({ hash: "#/", bridge: {} });
  const names = pageExports(m.ctx);
  assert.ok(names.length >= 10, `the page names its exports: ${names}`);
  for (const name of names) {
    assert.match(body, new RegExp(`\\n  (?:async )?${name}\\b`),`ForayPlayer has no member "${name}"`);
  }
});
