/* "Up Next" auto-advance (docs/listening-queue-plan.md §8 addendum,
 * kanban card t_b9880844).
 *
 * WHAT THIS PROVES, in order:
 *  1. `cp_autoadvance` is OFF by default (autoAdvanceOn() with no stored
 *     value reads false).
 *  2. Toggling it on and finishing an episode played FROM the queue starts
 *     the next queued item.
 *  3. Finishing an episode NOT played from the queue never triggers
 *     auto-advance, even with the toggle on.
 *  4. Finishing the last item in the queue stops cleanly — no loop back to
 *     the first item, nothing else is played.
 *  5. Auto-advance being off means a queue-originated finish never advances,
 *     even though the origin tracking itself still ran.
 *  6. A queue-originated episode removed from cp_queue before it finishes
 *     freezes — advance is a no-op rather than guessing a position.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it".
 *
 * Harness: the same node:vm DOM stub as test/up-next-queue.test.js, duplicated
 * rather than imported for the same reason that suite's header gives — this
 * suite's fixture (a fake ForayPlayer standing in for player/client.js, since
 * app.js is a classic script tested in isolation from the real ES module) is
 * its own and does not belong in the shared harness.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

/** A minimal fake standing in for `window.ForayPlayer` — this suite tests
    app.js's DECISION logic (should the next item play, and which one), not
    player/client.js's own playback machinery (that lives in
    player/*.test.js). `play()` records calls instead of touching audio. */
function makeFakePlayer() {
  const calls = [];
  return {
    calls,
    async play(item, opts) {
      calls.push({ item, opts });
      return true;
    },
    onEpisodeEnded() { return () => {}; },
  };
}

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
  const state = evalIn("state");

  // Seed a minimal live pool directly on state, bypassing init()/fetch — the
  // same shortcut test/up-next-queue.test.js's non-booted tests use.
  const discover = readJson("data/discover.json");
  const playable = discover.items.filter((it) => it.audio_url);

  return {
    ctx, evalIn, store, body, state, playable,
    view: () => byId.get("view").innerHTML,
    queueRaw: () => JSON.parse(store.get("cp_queue") || "null"),
  };
}

function seedLivePool(m, items) {
  for (const it of items) m.state.itemIndex[it.id] = it;
  m.state.poolIds = new Set(items.map((it) => it.id));
  // whyFor() reads state.session.cards — a minimal empty session is enough
  // for it to fall back to item.hook/"" without throwing.
  if (!m.state.session) m.state.session = { session_id: "s-1", cards: [] };
}

/* ==================================================================== */
/* 1. OFF BY DEFAULT                                                     */
/* ==================================================================== */

test("auto-advance is OFF by default", () => {
  /* MUTATION: change autoAdvanceOn()'s lsGet fallback from false to true.
     This assertion fails immediately, with no toggle ever touched. */
  const m = mount();
  assert.strictEqual(m.ctx.autoAdvanceOn(), false, "auto-advance must default to off");
});

/* ==================================================================== */
/* 2. ON + QUEUE-ORIGINATED FINISH ADVANCES TO THE NEXT ITEM              */
/* ==================================================================== */

test("toggling on and finishing a queue-played episode starts the next queued item", () => {
  /* MUTATION: drop the `if (!wasFromQueue) return;` guard in
     advanceQueueOnEnded, or the `if (!autoAdvanceOn()) return;` guard. Either
     way play() gets called when it should not have been gated on one of
     these, but more precisely: flip `ids[i + 1]` to `ids[i - 1]` and the
     WRONG item (a or none) would be played instead of c. */
  const m = mount();
  assert.ok(m.playable.length >= 3, "fixture assumption: need at least three playable episodes");
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);

  m.ctx.lsSet("cp_autoadvance", true);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.addToQueue(c.id);

  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  // Simulate: the listener pressed play on b's #/queue row.
  m.ctx.setQueuePlaybackOrigin(b.id);
  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 1, "exactly one auto-advance play must fire");
  assert.strictEqual(fake.calls[0].item.id, c.id, "the item AFTER the finished one must play next");
});

/* ==================================================================== */
/* 3. A NON-QUEUE FINISH NEVER ADVANCES, EVEN WITH THE TOGGLE ON          */
/* ==================================================================== */

test("finishing an unrelated (non-queue) episode never triggers auto-advance", () => {
  /* MUTATION: remove the `wasFromQueue` check entirely (advance on every
     finish while the toggle is on). This test seeds a queue but never marks
     the finished episode as queue-originated, so the mutant would
     incorrectly advance to the queue's first item. */
  const m = mount();
  assert.ok(m.playable.length >= 2, "fixture assumption: need at least two playable episodes");
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);

  m.ctx.lsSet("cp_autoadvance", true);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);

  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  // Some OTHER episode, not from #/queue, finishes (e.g. played from home).
  m.ctx.clearQueuePlaybackOrigin();
  m.ctx.advanceQueueOnEnded("some-unrelated-episode-id");

  assert.strictEqual(fake.calls.length, 0, "a non-queue finish must never advance the queue");
});

/* ==================================================================== */
/* 4. END OF QUEUE STOPS CLEANLY, NO LOOP                                */
/* ==================================================================== */

test("finishing the last queued item stops cleanly — no loop, nothing plays", () => {
  /* MUTATION: change `if (!nextId) return;` to wrap around
     (`ids[(i + 1) % ids.length]`). The mutant would replay `a`, and this
     assertion (zero calls) fails. */
  const m = mount();
  assert.ok(m.playable.length >= 2, "fixture assumption: need at least two playable episodes");
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);

  m.ctx.lsSet("cp_autoadvance", true);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);

  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.setQueuePlaybackOrigin(b.id);
  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 0, "the end of the queue must not loop or pull in more content");
});

/* ==================================================================== */
/* 5. THE TOGGLE ITSELF GATES ADVANCE, EVEN FOR A QUEUE-ORIGINATED FINISH */
/* ==================================================================== */

test("auto-advance stays off: a queue-played finish does not advance while the toggle is off", () => {
  /* MUTATION: drop the `if (!autoAdvanceOn()) return;` guard. With the
     toggle at its default (off) and a legitimate queue-originated finish,
     the mutant would still advance — this assertion (zero calls) catches it
     even though test 2 already exercises the "on" path, because a guard
     removed entirely still passes test 2 (it never turns anything off). */
  const m = mount();
  assert.ok(m.playable.length >= 2, "fixture assumption: need at least two playable episodes");
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);

  // cp_autoadvance intentionally left at its default (off).
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);

  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.setQueuePlaybackOrigin(a.id);
  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls.length, 0, "auto-advance must not fire while the toggle is off");
});

/* ==================================================================== */
/* 6. REMOVED-MID-PLAYBACK FREEZES RATHER THAN GUESSING                  */
/* ==================================================================== */

test("an episode removed from the queue before it finishes freezes — no guess at what's next", () => {
  /* MUTATION: fall back to `ids[0]` (or any other guess) when the finished
     item's id is no longer found in cp_queue, instead of returning. This
     assertion (zero calls) would then fail because SOMETHING played. */
  const m = mount();
  assert.ok(m.playable.length >= 3, "fixture assumption: need at least three playable episodes");
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);

  m.ctx.lsSet("cp_autoadvance", true);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.addToQueue(c.id);

  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  // b started playing from the queue, then got removed from cp_queue before
  // it finished (e.g. the listener dequeued it mid-listen from another tab).
  m.ctx.setQueuePlaybackOrigin(b.id);
  m.ctx.removeFromQueue(b.id);
  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 0, "an episode no longer in the queue must not guess a next item");
});
