/* The now-playing ribbon offers whatever was played LAST — a Foray included.
 *
 * Persona audit, 2026-09-22 (the car tier): "A part-played Foray cannot be
 * resumed from the mini bar — and the bar may show a stale single episode
 * instead." The durable pointer the ribbon restored from was written only by
 * `ForayPlayer.play()`, so after a relaunch mid-Foray the bar offered an episode
 * from days earlier, and the Foray was four taps across three screens away.
 *
 * `player/transport-reconcile.test.js` part 9 pins the player's half through the
 * real client (`lastPlayedForay`, `restoreForay`, the press). This pins the
 * PAGE's half — `restoreNowPlayingRibbon` asks for the Foray first, resolves it
 * through the same `forayViewOpts()` gate as every Foray the page opens, and
 * falls back to the episode pointer — against a fake bridge, because the page's
 * decision is the thing under test.
 *
 * Harness: the node:vm DOM stub of test/jump-back-in-kinds.test.js.
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
    console,
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

/** A bridge that records which restore the page asked for. */
function fakeBridge({ lastForay = "f1", resolves = true, resume = { elapsedSec: 150 } } = {}) {
  const calls = [];
  return {
    calls,
    lastPlayedForay: () => lastForay,
    resolve: (_doc, opts) => { calls.push(["resolve", opts.id]); return resolves ? RESOLVED : null; },
    forayResume: () => resume,
    restoreForay: (r, opts) => { calls.push(["restoreForay", r.id, opts.startElapsedSec]); return { id: `foray:${r.id}` }; },
    restoreLastEpisode: () => { calls.push(["restoreLastEpisode"]); return { id: "ep-a" }; },
  };
}

test("a Foray that was played last takes the ribbon, at its resume point", () => {
  /* KILLING MUTATION: drop `restoreLastForayRibbon(...) ||` from
     `restoreNowPlayingRibbon` — the page goes straight to the episode pointer. */
  const bridge = fakeBridge();
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepEqual(bridge.calls, [["resolve", "f1"], ["restoreForay", "f1", 150]]);
});

test("with no Foray more recent than the episode, the episode pointer restores as before", () => {
  const bridge = fakeBridge({ lastForay: null });
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepEqual(bridge.calls, [["restoreLastEpisode"]]);
});

test("a Foray this listener may not see (a draft, a withdrawn one) is never put on the bar", () => {
  /* `resolve` goes through `forayViewOpts()`, the same gate as every Foray the
     page opens, and a null answer falls back to the episode. KILLING MUTATION:
     call `restoreForay` without checking the resolve. */
  const bridge = fakeBridge({ resolves: false });
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepEqual(bridge.calls, [["resolve", "f1"], ["restoreLastEpisode"]]);
});

test("an older player module with no Foray ribbon still restores the episode", () => {
  const bridge = fakeBridge();
  delete bridge.lastPlayedForay;
  delete bridge.restoreForay;
  const app = loadApp(bridge);
  app.restoreNowPlayingRibbon();
  assert.deepEqual(bridge.calls, [["restoreLastEpisode"]]);
});

test("Jump back in's Foray rows are read against the Foray as it resolves NOW (audit sweep, qa row 163)", () => {
  /* The player's half — `forayResumeList` measuring against `resolveFor`'s
     live runtime — is pinned in player/transport-reconcile.test.js part 10.
     This is the page's half: it hands the list a resolver, and that resolver
     goes through the same `forayViewOpts()` gate and documents as every other
     Foray this page opens. KILLING MUTATION: call `forayResumeList` with
     `{ foraysDoc: state.forays }` only, as before. */
  const bridge = fakeBridge();
  let handed = null;
  bridge.forayResumeList = (opts) => { handed = opts; return []; };
  bridge.listForays = () => [];
  const app = loadApp(bridge);
  app.forayResumeRows();
  assert.ok(handed, "the page asked for the rows");
  assert.equal(typeof handed.resolveFor, "function", "with a live resolver");
  assert.equal(handed.resolveFor("f1"), RESOLVED);
  assert.deepEqual(bridge.calls, [["resolve", "f1"]], "which is the page's own resolve");
});
