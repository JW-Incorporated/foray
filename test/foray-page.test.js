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
const readData = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

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
  state.forays = readData(`${FZ}/forays.json`);
  state.segments = readData(`${FZ}/segments.json`);
  state.segmentSources = readData(`${FZ}/segment-sources.json`);
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
