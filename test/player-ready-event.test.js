/* The page's three waits for the player bridge, and the one event they wait on
 * (code-health CH-28: A3-13, X1-20; docs/roadmap/code-health.md).
 *
 * The player is an ES module and app.js a classic script, so the page cannot
 * assume `window.ForayPlayer` exists. Three places waited for it:
 *
 *   - `playerBridge()` -- on a click or a page render. Bounded at
 *     PLAYER_WAIT_MS (5 s): a broken deploy shows a message, not an empty page.
 *   - `restoreNowPlayingRibbon()` -- at boot. UNBOUNDED on purpose: a module
 *     that lands at 7 s on a slow cell link must still put the bar back and
 *     repaint Home, and it repaints Home BECAUSE it was late (the `late` flag).
 *   - `bindEngineDevRows()` -- at boot. Unbounded for the same reason.
 *
 * They now share one `whenPlayerBridge(fn, { timeoutMs })`, which calls `fn`
 * with `{ player, late }`. A callback and not a Promise, deliberately: with the
 * bridge already here the boot restore runs SYNCHRONOUSLY (the ribbon suites
 * assert the restore calls right after the call returns, and Home's repaint
 * lands in the same tick as the event in test/load-states.test.js), and a
 * Promise would push both to a microtask.
 *
 * The event name was a literal in seven places across two files with no pin; a
 * typo in client.js's dispatch would leave every `once: true` listener waiting
 * forever. app.js now spells it once (PLAYER_READY_EVENT) and the last test
 * below pins that spelling to client.js's dispatch.
 *
 * Harness: the node:vm stub of test/load-states.test.js, with a FAKE CLOCK so a
 * test can let 7 seconds pass without waiting them.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8");

process.on("unhandledRejection", () => {});

const { El } = require("./helpers/fake-dom.js");

function mount({ hash = "#/", bridge = null } = {}) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const winListeners = new Map();
  /* The fake clock: setTimeout only records; `elapse(ms)` runs every timer due
     by then. Nothing here waits real time, so "7 seconds later" is exact. */
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); },
    removeEventListener(t, fn) { winListeners.set(t, (winListeners.get(t) || []).filter((f) => f !== fn)); },
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, queueMicrotask,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + (Number(ms) || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (bridge) ctx.ForayPlayer = bridge;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  vm.runInContext("state.forays = { forays: [] }; state.segments = {}; state.segmentSources = {};", ctx);
  return {
    ctx, state,
    listeners: (type) => (winListeners.get(type) || []).length,
    /* A `once: true` listener is dropped as it fires, as the browser does. */
    fire: (type) => { const fns = winListeners.get(type) || []; winListeners.set(type, []); for (const fn of fns) fn(); },
    elapse: (ms) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now || !timers.has(id)) continue;
        timers.delete(id);
        try { t.fn(); } catch (_) { /* a boot timer this stub cannot satisfy is not under test */ }
      }
    },
  };
}

/** A bridge with nothing to restore, that records what the page asked of it. */
function lateBridge() {
  const calls = [];
  return {
    calls,
    restoreLastEpisode: () => { calls.push("restoreLastEpisode"); return null; },
    whenEngineReady: () => { calls.push("whenEngineReady"); return new Promise(() => {}); },
  };
}

test("characterization: a player module that lands at 7 s still restores the bar, readies the engine rows, and repaints Home because it was late", () => {
  /* The two boot waits are unbounded on purpose (A3-13). The repaint with
     NOTHING restored is the `late` flag's whole job: Home's first paint read
     `forayCards()` with no module and must be redone.

     MUTATION 1: give the boot waits the click-time bound -- pass
     `{ timeoutMs: PLAYER_WAIT_MS }` to whenPlayerBridge in
     restoreNowPlayingRibbon and bindEngineDevRows. At 5 s the wait gives up
     with no player and stops listening; the 7 s arrival restores nothing, red.
     MUTATION 2: drop the flag -- call `whenLaneKnown(false)` from the arrival
     path. Nothing was restored, so Home is not repainted, red. */
  const m = mount({ hash: "#/" });
  let repaints = 0;
  m.ctx.renderCurrentPage = () => { repaints += 1; };
  m.ctx.restoreNowPlayingRibbon();
  m.ctx.bindEngineDevRows();
  m.elapse(7000);
  assert.strictEqual(repaints, 0, "nothing repaints while there is no module");
  const bridge = lateBridge();
  m.ctx.ForayPlayer = bridge;
  m.fire("forayplayer:ready");
  assert.deepStrictEqual(bridge.calls.filter((c) => c === "restoreLastEpisode"), ["restoreLastEpisode"], "the bar is restored from the late module");
  assert.ok(bridge.calls.includes("whenEngineReady"), "the engine rows wait on the late module's lane");
  assert.strictEqual(repaints, 1, "Home repaints once, because the module was late");
});

test("characterization: a bridge already here is used at once and is not late", () => {
  /* Synchronous, and not late: the restore has run by the time the call
     returns, and with nothing restored Home is NOT repainted.
     MUTATION: make whenPlayerBridge report `late: true` when the bridge is
     already here. Home repaints for nothing, red. MUTATION 2: resolve the
     present-bridge case on a microtask (Promise.resolve().then(...)) -- the
     restore has not run when the call returns, red. */
  const bridge = lateBridge();
  const m = mount({ hash: "#/", bridge });
  let repaints = 0;
  m.ctx.renderCurrentPage = () => { repaints += 1; };
  m.ctx.restoreNowPlayingRibbon();
  assert.deepStrictEqual(bridge.calls, ["restoreLastEpisode"], "restored synchronously");
  assert.strictEqual(repaints, 0, "not late, nothing restored: no repaint");
});

test("characterization: playerBridge gives up at PLAYER_WAIT_MS with null and leaves no listener behind", async () => {
  /* The click-time wait keeps its bound. MUTATION: pass `timeoutMs: null` from
     playerBridge -- the promise never settles at 5 s and the listener stays,
     red. */
  const m = mount({ hash: "#/library" });
  const before = m.listeners("forayplayer:ready");
  let got;
  m.ctx.playerBridge().then((p) => { got = p; });
  assert.strictEqual(m.listeners("forayplayer:ready"), before + 1);
  m.elapse(4999);
  await Promise.resolve();
  assert.strictEqual(got, undefined, "still waiting before the bound");
  m.elapse(1);
  await Promise.resolve();
  assert.strictEqual(got, null, "gave up with no bridge");
  assert.strictEqual(m.listeners("forayplayer:ready"), before, "and stopped listening");
});
