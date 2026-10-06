/* The now-playing bar's Foray restore reads its Foray through the page's ONE
 * resolve call and its point through the ONE resume-point read (code-health
 * CH-22: A3-01, A3-03).
 *
 * `restoreNowPlayingRibbon` asks for the Foray played last and falls back to the
 * episode pointer (`restoreLastForayRibbon(...) || restoreLastEpisode()`). The
 * Foray half resolved with its own copy of the resolve call and read its point
 * bare, so a resolver or a point read that threw escaped into the restore's
 * catch: the bar restored NOTHING, the episode fallback skipped. Through
 * `resolveListedForay` and `readForayPoint` a throw is "no Foray", and the
 * episode comes back as it would for any other missing Foray.
 *
 * test/foray-ribbon-restore.test.js pins the page's half of the choice itself;
 * this suite pins what a throw, and a finished Foray, do to it.
 *
 * Harness: the node:vm DOM stub of test/foray-ribbon-restore.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF normalised on read — see jump-back-in-kinds.test.js for why. */
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

const RESOLVED = { id: "f1", title: "A Foray", playable: [{ id: "s1" }], totalSec: 600 };

function loadApp(bridge) {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const store = new Map();
  const ctx = {
    console: { ...console, warn: noop, error: noop },
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: () => makeEl(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    /* NOT home, so the restore does not re-render a page this stub cannot draw. */
    location: { hash: "#/library", href: "https://example.test/#/library" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  vm.runInContext("state.forays = { forays: [] }; state.segments = {}; state.segmentSources = {};", ctx);
  return ctx;
}

/** A bridge that records which restore the page asked for, and how. */
function fakeBridge({ resolve = () => RESOLVED, forayResume = () => ({ elapsedSec: 150 }) } = {}) {
  const calls = [];
  return {
    calls,
    lastPlayedForay: () => "f1",
    resolve: (doc, opts) => { calls.push(["resolve", opts.id]); return resolve(doc, opts); },
    forayResume: (id, opts) => { calls.push(["forayResume", id, Object.keys(opts || {}).sort().join(",")]); return forayResume(id, opts); },
    restoreForay: (r, opts) => { calls.push(["restoreForay", r.id, opts.startElapsedSec]); return { id: `foray:${r.id}` }; },
    restoreLastEpisode: () => { calls.push(["restoreLastEpisode"]); return { id: "ep-a" }; },
  };
}

test("characterization: a part-played Foray played last is restored on boot, at its resume point", () => {
  /* MUTATION: drop `restoreLastForayRibbon(...) ||` from
     restoreNowPlayingRibbon — the episode is restored instead, red. */
  const bridge = fakeBridge();
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  const restores = bridge.calls.filter(([k]) => k !== "forayResume");
  assert.deepStrictEqual(restores, [["resolve", "f1"], ["restoreForay", "f1", 150]]);
});

test("characterization: a Foray played to the end is not put on the bar; the episode is", () => {
  /* The real player answers a finished point only when asked with
     `includeFinished`; the bar must never start a Foray at its last second.
     MUTATION: restore from `played` as well as `resume` in
     restoreLastForayRibbon — the finished Foray takes the bar, red. */
  const done = { finished: true, elapsedSec: 600, index: 0 };
  const bridge = fakeBridge({ forayResume: (_id, opts) => (opts && opts.includeFinished ? done : null) });
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepStrictEqual(bridge.calls.filter(([k]) => k !== "forayResume" && k !== "resolve"), [["restoreLastEpisode"]]);
});

test("A3-01: a resolver that throws is 'no Foray', and the episode pointer restores", () => {
  /* Was: the throw escaped restoreLastForayRibbon into the restore's catch, so
     the bar restored nothing at all. MUTATION: give restoreLastForayRibbon its
     own unguarded `player.resolve(...)` again — no restoreLastEpisode, red. */
  const bridge = fakeBridge({ resolve: () => { throw new Error("malformed segments doc"); } });
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepStrictEqual(bridge.calls, [["resolve", "f1"], ["restoreLastEpisode"]]);
});

test("A3-03: a point read that throws is 'no Foray', and the episode pointer restores", () => {
  /* MUTATION: read the point with a bare `player.forayResume(...)` in
     restoreLastForayRibbon again — the throw skips the episode, red. */
  const bridge = fakeBridge({ forayResume: () => { throw new Error("corrupt progress row"); } });
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepStrictEqual(bridge.calls.at(-1), ["restoreLastEpisode"]);
  assert.ok(!bridge.calls.some(([k]) => k === "restoreForay"));
});

test("A3-03: the bar reads its point the way the Foray page does: the resolved Foray and includeFinished", () => {
  /* One read for both surfaces, so the finished-vs-resume rule cannot change
     in one and not the other. MUTATION: call `player.forayResume(id,
     { resolved: r })` in restoreLastForayRibbon again — red. */
  const bridge = fakeBridge();
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepStrictEqual(bridge.calls.find(([k]) => k === "forayResume"), ["forayResume", "f1", "includeFinished,resolved"]);
});
