/* Continuous playback — founder ruling 2026-09-14 (docs/DECISIONS.md, PR #695,
 * issue #691), implemented by the 2026-09-22 audit fix.
 *
 * "I just want more podcasts to play while I'm in the car and can't pick
 * something out for myself." This suite used to pin the OPPOSITE — default off,
 * and only an episode started from #/queue could ever chain — and it kept
 * passing for eight days after the ruling, because it tested the old decision
 * faithfully. It now pins the ruling.
 *
 * WHAT THIS PROVES, in order:
 *  1. `cp_autoadvance` is ON by default, and its switch is called "Continuous
 *     playback".
 *  2. A finished Up Next episode plays the next queued one, and leaves Up Next.
 *  3. Up Next comes FIRST: a finish from anywhere else plays Up Next's head
 *     (including the episode removed from Up Next while it played).
 *  4. With Up Next empty, the next row of the list the play started from plays —
 *     driven through the REAL bindPlay, which is where the list is recorded.
 *  5. The list is the rows of THAT list (same data-ctx), not the whole screen.
 *  6. An unplayable row is passed over, not stopped at.
 *  7. The end of the list is the end: nothing loops.
 *  8. The switch still turns it off.
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

/** Drive the REAL bindPlay over a row list and click row `index`. Every button
    carries `data-ctx`, as epRow's play buttons do. */
async function clickRow(m, buttons, index) {
  const handlers = [];
  const btns = buttons.map(({ id, ctx }, i) => ({
    dataset: { play: id, ctx },
    addEventListener: (_t, fn) => { handlers[i] = fn; },
  }));
  m.ctx.bindPlay({ querySelectorAll: (sel) => (sel === "[data-play]" ? btns : []) });
  await handlers[index]({ preventDefault() {}, stopPropagation() {} });
}

/* ==================================================================== */
/* 1. ON BY DEFAULT, AND NAMED FOR WHAT IT DOES                           */
/* ==================================================================== */

test("continuous playback is ON by default", () => {
  /* MUTATION: change autoAdvanceOn()'s lsGet fallback from true back to false. */
  const m = mount();
  assert.strictEqual(m.ctx.autoAdvanceOn(), true, "the founder's car case must work out of the box");
});

test("the switch is labelled 'Continuous playback', not its storage key", () => {
  /* MUTATION: restore the "Up Next auto-advance" label in bindDrawerToggles. */
  const m = mount();
  m.ctx.bindDrawerToggles();
  m.ctx.paintDrawerToggles();
  assert.strictEqual(m.evalIn('$("#autoadvance-toggle").textContent'), "Continuous playback: on");
});

/* ==================================================================== */
/* 2. UP NEXT PLAYS THROUGH, AND A FINISHED EPISODE LEAVES IT             */
/* ==================================================================== */

test("a finished Up Next episode plays the next queued one, and leaves Up Next", () => {
  /* MUTATION: flip `rest.slice(at)` to `rest.slice(at + 1)` — c is skipped.
     MUTATION 2: drop `saveQueueIds(rest)` — b is still queued afterwards. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.addToQueue(c.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 1, "exactly one advance must fire");
  assert.strictEqual(fake.calls[0].item.id, c.id, "the item AFTER the finished one plays next");
  assert.deepStrictEqual([...m.queueRaw()], [a.id, c.id], "the finished episode leaves Up Next");
});

/* ==================================================================== */
/* 3. UP NEXT FIRST, WHEREVER THE FINISHED EPISODE CAME FROM              */
/* ==================================================================== */

test("an episode played from anywhere else continues into Up Next", () => {
  /* The gate the ruling removed: `if (!wasFromQueue) return;`. MUTATION: drop
     the `else if (queued.length)` branch of nextAfterEnded — nothing plays. */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.advanceQueueOnEnded("some-unrelated-episode-id");

  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].item.id, a.id, "Up Next's head plays next");
});

test("an Up Next episode removed while it played continues into what is left of Up Next", () => {
  /* Was "freezes rather than guesses" under the old design. Now the finished
     episode is simply not in Up Next, so Up Next's head is next — the same rule
     as any other finish. MUTATION: return null when the finished id is not
     queued. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  m.ctx.addToQueue(c.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.removeFromQueue(b.id);
  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].item.id, a.id);
});

/* ==================================================================== */
/* 4 & 5. THE LIST THE LISTENER CHOSE                                    */
/* ==================================================================== */

test("with Up Next empty, the next row of the list the play started from plays", async () => {
  /* Driven through the real bindPlay, because that is where the list is
     recorded. MUTATION: drop the setPlayList call from bindPlay — nothing
     plays after the first row. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  const rows = [a, b, c].map((it) => ({ id: it.id, ctx: "show-x" }));

  await clickRow(m, rows, 0);
  assert.strictEqual(fake.calls.length, 1, "the tap itself plays a");
  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls.length, 2, "the list continues");
  assert.strictEqual(fake.calls[1].item.id, b.id);
});

test("the list is the rows sharing the tapped row's data-ctx, not the whole screen", async () => {
  /* Library shows Saved and History on one page. MUTATION: drop the
     `b.dataset.ctx === listCtx` filter — the History row (x) plays after a. */
  const m = mount();
  const [a, x, b] = m.playable;
  seedLivePool(m, [a, x, b]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  const rows = [
    { id: a.id, ctx: "library-saved" },
    { id: x.id, ctx: "library-history" },
    { id: b.id, ctx: "library-saved" },
  ];

  await clickRow(m, rows, 0);
  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls[1].item.id, b.id, "the next SAVED row, not the History one between");
});

/* ==================================================================== */
/* 6. AN UNPLAYABLE ROW IS PASSED OVER                                    */
/* ==================================================================== */

test("an unplayable next row is passed over rather than stopped at", async () => {
  /* Stopping is the silence the ruling is about. MUTATION: take
     `candidates[0]` without the liveEpisode audio test — the silent row is
     handed to play() and b never plays. */
  const m = mount();
  const [a, b] = m.playable;
  const silent = { ...m.playable[2], id: "no-audio-row", audio_url: null };
  seedLivePool(m, [a, silent, b]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  const rows = [a, silent, b].map((it) => ({ id: it.id, ctx: "show-x" }));

  await clickRow(m, rows, 0);
  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls[1]?.item.id, b.id);
});

/* ==================================================================== */
/* 7. THE END IS THE END                                                  */
/* ==================================================================== */

test("finishing the last queued item stops cleanly — no loop, nothing plays", () => {
  /* MUTATION: fall back to the queue's first item when nothing follows. */
  const m = mount();
  const [a] = m.playable;
  seedLivePool(m, [a]);
  m.ctx.addToQueue(a.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls.length, 0, "the end of Up Next must not loop");
});

test("finishing the last row of a list stops cleanly", async () => {
  /* MUTATION: wrap the list (`list.slice(i + 1).concat(list.slice(0, i))`). */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  const rows = [a, b].map((it) => ({ id: it.id, ctx: "show-x" }));

  await clickRow(m, rows, 1);
  m.ctx.advanceQueueOnEnded(b.id);

  assert.strictEqual(fake.calls.length, 1, "only the tap itself played");
});

/* ==================================================================== */
/* 8. THE SWITCH STILL TURNS IT OFF                                       */
/* ==================================================================== */

test("with the switch off, nothing continues", () => {
  /* The ruling keeps `cp_autoadvance` as an off-switch. MUTATION: drop the
     `if (!autoAdvanceOn()) return;` guard. */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  m.ctx.lsSet("cp_autoadvance", false);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls.length, 0);
});
