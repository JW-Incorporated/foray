/* Audit round 3, lane L2 (app surface): the small correctness fixes that have no
 * better-fitting suite. Each test names its finding id and the mutation that
 * turns it red.
 *
 * Harness: app.js runs in a node:vm context with a minimal fake DOM and a
 * CONTROLLED timer queue — `ctx.setTimeout` records instead of scheduling, so a
 * test fires exactly the timer it means to (and the 45 s boot deadline app.js
 * arms at load never holds the process open).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

function makeEl(tag = "div") {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(type, ev = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...ev });
    },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [], hidden: false,
    innerHTML: "", textContent: "", className: "", isConnected: true,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 300, height: 600, bottom: 600, right: 300 }),
  };
  return el;
}

function loadApp() {
  const noop = () => {};
  const timers = new Map();
  let nextTimer = 0;
  const store = new Map();
  const win = makeEl("window");
  const ctx = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    document: {
      body: makeEl("body"), documentElement: makeEl("html"), readyState: "complete",
      addEventListener: noop, removeEventListener: noop, createElement: makeEl,
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    },
    navigator: { userAgent: "node", onLine: true },
    location: { hash: "#/", href: "https://example.test/", pathname: "/", search: "" },
    history: { replaceState: noop, pushState: noop, state: null },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, Intl, TextEncoder,
    setTimeout: (fn, ms, ...args) => { nextTimer += 1; timers.set(nextTimer, { fn, ms, args }); return nextTimer; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: (fn) => { nextTimer += 1; timers.set(nextTimer, { fn, ms: 16, args: [0] }); return nextTimer; },
    cancelAnimationFrame: (id) => { timers.delete(id); },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: noop,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  return {
    ctx,
    win,
    timers,
    store,
    run: (code) => vm.runInContext(code, ctx),
    /** Fire (and remove) every pending timer armed for exactly `ms`. */
    fire(ms) {
      for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(...t.args); }
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/* ---------- app-2-14: playerBridge cleans up after a timed-out wait ---------- */

test("app-2-14: a timed-out playerBridge wait removes its listener and its timer", async () => {
  /* On the broken-deploy path (the player module never published) each visit to
     #/forays, Library or a Try again called playerBridge(), which added a
     once-listener for an event that never fires and never removed it.
     MUTATION: drop the removeEventListener in finish() — the listener count is
     2, not 0. Drop the clearTimeout — the ready-path assertion sees a timer. */
  const m = loadApp();
  const wait = m.run("PLAYER_WAIT_MS");
  /* app.js's own boot code holds a listener of its own; count relative to it. */
  const ready = () => (m.win.listeners.get("forayplayer:ready") || []).length;
  const base = ready();
  const a = m.ctx.playerBridge();
  const b = m.ctx.playerBridge();
  assert.strictEqual(ready(), base + 2, "two waits in flight");
  m.fire(wait);
  assert.strictEqual(await a, null);
  assert.strictEqual(await b, null);
  assert.strictEqual(ready(), base, "no listener outlives its wait");

  /* The ready path: the event resolves the wait and its timer is cleared. */
  const c = m.ctx.playerBridge();
  m.ctx.ForayPlayer = { ready: true };
  m.win.dispatch("forayplayer:ready");
  assert.deepStrictEqual(await c, { ready: true });
  assert.ok(![...m.timers.values()].some((t) => t.ms === wait), "the timeout is cleared once the player arrived");
});


/* ---------- app-2-15: no dead search helpers ---------------------------------- */

test("app-2-15: episodeDedupKey and showIndexFetchCount are gone from the code", () => {
  /* Both suggested behaviour that no longer existed: a single-key dedup nothing
     called (everything uses episodeDedupKeys) and a "test-visible" fetch counter
     no test read. Comments are stripped first — prose that records the deletion
     is not a code path.
     MUTATION: restore either declaration — red. */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  assert.ok(!/\bepisodeDedupKey\b/.test(code), "episodeDedupKey has no caller");
  assert.ok(!/\bshowIndexFetchCount\b/.test(code), "showIndexFetchCount has no reader");
  assert.match(code, /function episodeDedupKeys\(/, "the live helper stays");
});
