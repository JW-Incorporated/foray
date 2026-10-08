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
 *  9. Then more of what fits (PQ-11, #691): once Up Next and the list are
 *     spent, the tail built from today's deal plays — every third pick the
 *     stretch subject, said with the bridge line and announced — never an
 *     episode already played or queued, and the switch stops it too.
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

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

/* The rules themselves are player/continuation.js since NE-13, published to
   the page by player/client.js as `window.forayContinuation`. The fake player
   below stands in for client.js, so the harness publishes the REAL rules the
   same way — every assertion in this suite runs through the delegation. */
let CONTINUATION = null;
/* The tail's ordering rule (player/tail-fill.js, PQ-10), published by
   client.js as `window.forayTailFill`; the harness publishes the real one. */
let TAIL_FILL = null;
before(async () => {
  CONTINUATION = await import("../player/continuation.js");
  TAIL_FILL = await import("../player/tail-fill.js");
});

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
  const navCalls = [];
  let currentId = null;
  return {
    calls,
    navCalls,
    async play(item, opts) {
      calls.push({ item, opts });
      currentId = item.id;
      return true;
    },
    onEpisodeEnded() { return () => {}; },
    /* The two halves of the steering wheel's skip (review 2026-09-23). */
    setEpisodeNavigation(nav) { navCalls.push(nav); return true; },
    currentEpisodeId() { return currentId; },
    /* The round-2 previous rule (p-car-5): the page asks whether ◀◀ means
       restart, and restarts through the player's own seek. */
    restartWindowPassed: true,
    previousMeansRestart() { return this.restartWindowPassed; },
    seeks: [],
    async seekTo(pos) { this.seeks.push(pos); return true; },
    isCurrent(id) { return id === currentId; },
    /** What the OS would be offered right now: the getters, read as the real
        surface reads them at install time. */
    offered() {
      const nav = navCalls[navCalls.length - 1];
      return { next: nav ? nav.next : null, previous: nav ? nav.previous : null };
    },
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
  ctx.forayContinuation = CONTINUATION;
  ctx.forayTailFill = TAIL_FILL;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);

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
  /* MUTATION: restore the "Up Next auto-advance" label in bindSettingSwitches. */
  const m = mount();
  m.ctx.bindSettingSwitches();
  m.ctx.paintSettingSwitches();
  assert.strictEqual(m.evalIn('$("#autoadvance-toggle").textContent'), "Continuous playback: on");
});

/* ==================================================================== */
/* 2. UP NEXT PLAYS THROUGH, AND A FINISHED EPISODE LEAVES IT             */
/* ==================================================================== */

test("a finished Up Next episode plays the next queued one, and leaves Up Next", () => {
  /* The natural end of a queued episode: it leaves, and Up Next's HEAD plays —
     a row sitting above it was put there (reordered up while it played, or
     the episode was started from elsewhere), so it is next. Nothing wraps
     (audit round 2, p-impatient-7: the old `rest.slice(at).concat(rest.slice(0,
     at))` re-served an abandoned row after the last one).
     MUTATION: restore the wrap-around — c plays here and a comes back later.
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
  assert.strictEqual(fake.calls[0].item.id, a.id, "Up Next's head plays next");
  assert.deepStrictEqual([...m.queueRaw()], [a.id, c.id], "the finished episode leaves Up Next");

  /* From the top of the list, the row below is the head. */
  m.ctx.advanceQueueOnEnded(a.id);
  assert.strictEqual(fake.calls[1].item.id, c.id);
  assert.deepStrictEqual([...m.queueRaw()], [c.id]);
});

test("⏭ is the natural end reached early: the skipped episode leaves, every other row stays, and the head plays (founder, 2026-09-24)", async () => {
  /* FOUNDER, 2026-09-24, reversing the round-2 default: "Playing something
     from up next removes the items above it - disagree, reverse this. That
     item in the queue jumps to the top." With [a, b, c, d] queued and c
     playing (started from elsewhere, so it has not jumped), a skip drops c
     alone and plays a — Up Next's head — leaving [a, b, d] in order.
     MUTATION: restore the round-2 skip (`rest = queued.slice(at + 1)`) -> d
     plays and a and b leave Up Next. */
  const m = mount();
  const [a, b, c, d] = m.playable;
  seedLivePool(m, [a, b, c, d]);
  for (const it of [a, b, c, d]) m.ctx.addToQueue(it.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await fake.play(c, {});
  m.ctx.refreshEpisodeNavigation();

  const { next } = fake.offered();
  assert.strictEqual(typeof next, "function", "c has something after it");
  await next();
  assert.strictEqual(fake.calls[1]?.item.id, a.id, "the skip plays Up Next's head");
  assert.deepStrictEqual([...m.queueRaw()], [a.id, b.id, d.id], "only the skipped episode left; the rest kept their order");
});

test("playing row k from the Up Next page moves THAT row to the top and keeps every other row, in order (founder, 2026-09-24)", async () => {
  /* "That item in the queue jumps to the top." The page's ▶ carries
     `data-ctx="upnext"`; a play accepted from it moves row k to the top.
     MUTATION: drop the `playedFromUpNext` call from bindPlay -> [a, b, c, d]
     survives unmoved. MUTATION 2: restore the round-2 body
     (`ids.slice(at)`) -> a and b leave. */
  const m = mount();
  const [a, b, c, d] = m.playable;
  seedLivePool(m, [a, b, c, d]);
  for (const it of [a, b, c, d]) m.ctx.addToQueue(it.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  const rows = [a, b, c, d].map((it) => ({ id: it.id, ctx: "upnext" }));   // the literal the Up Next QueueRow stamps (pinned below)
  await clickRow(m, rows, 2);
  assert.strictEqual(fake.calls[0]?.item.id, c.id);
  assert.deepStrictEqual([...m.queueRaw()], [c.id, a.id, b.id, d.id], "c jumped to the top; nothing left, nothing else moved");
  /* PORTED (Redesign 2026, ambient): the page's row is Library's QueueRow, whose cover button names the list. MUTATION: draw
     the cover with another data-ctx in libQueueRowHtml -> red. */
  assert.match(m.ctx.libQueueRowHtml({ item: c, id: c.id, state: "live" }, { upnext: true, menu: true, page: true, ctx: "upnext" }), /data-lb-play="[^"]+" data-swipe-id="[^"]+" data-ctx="upnext"/, "the page's row names its list");

  /* And when c ends, it leaves and the row that was first plays: nothing the
     listener passed over is lost. */
  m.ctx.advanceQueueOnEnded(c.id);
  assert.strictEqual(fake.calls[1]?.item.id, a.id, "the old head plays after the jumped row");
  assert.deepStrictEqual([...m.queueRaw()], [a.id, b.id, d.id]);
});

test("a refused play from the Up Next page moves nothing (founder, 2026-09-24)", async () => {
  /* The move is applied only once the play is accepted. MUTATION: call
     playedFromUpNext before the `ok` check in bindPlay -> c jumps anyway. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  for (const it of [a, b, c]) m.ctx.addToQueue(it.id);
  const fake = makeFakePlayer();
  fake.play = async function (item, opts) { this.calls.push({ item, opts }); return false; };
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b, c].map((it) => ({ id: it.id, ctx: "upnext" })), 2);
  assert.deepStrictEqual([...m.queueRaw()], [a.id, b.id, c.id]);
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

test("REVIEW: Up Next first, THEN the rest of the chosen list — queue [X], tap ep1, and ep2 follows X", async () => {
  /* The two branches used to be exclusive: with anything queued the list was
     never reached, and once X had played, X was not in the list, so nothing
     played. MUTATION: restore `else if (queued.length) candidates = queued` —
     the second advance plays nothing. MUTATION 2: anchor the list on the
     finished id only (drop `state.playListCursor`) — same silence. */
  const m = mount();
  const [x, ep1, ep2, ep3] = m.playable;
  seedLivePool(m, [x, ep1, ep2, ep3]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  m.ctx.addToQueue(x.id);
  const rows = [ep1, ep2, ep3].map((it) => ({ id: it.id, ctx: "show-x" }));

  await clickRow(m, rows, 0);
  m.ctx.advanceQueueOnEnded(ep1.id);
  assert.strictEqual(fake.calls[1]?.item.id, x.id, "Up Next comes first");
  m.ctx.advanceQueueOnEnded(x.id);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.calls[2]?.item.id, ep2.id, "then the list resumes after the last row that played");
  m.ctx.advanceQueueOnEnded(ep2.id);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.calls[3]?.item.id, ep3.id);
});

test("REVIEW: an Up Next with nothing playable falls through to the list", async () => {
  /* MUTATION: return `fromQueue.find(...) || null` without looking at the list. */
  const m = mount();
  const [ep1, ep2] = m.playable;
  const silent = { ...m.playable[2], id: "queued-no-audio", audio_url: null };
  seedLivePool(m, [ep1, ep2, silent]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  m.ctx.addToQueue(silent.id);
  await clickRow(m, [ep1, ep2].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  m.ctx.advanceQueueOnEnded(ep1.id);
  assert.strictEqual(fake.calls[1]?.item.id, ep2.id);
});

test("REVIEW: an episode started off the chain does not resume a list from an earlier visit", async () => {
  /* The cursor must not outlive the chain. MUTATION: drop the `onChain` test in
     planAfterEnded — the unrelated episode's end plays ep2. */
  const m = mount();
  const [ep1, ep2] = m.playable;
  seedLivePool(m, [ep1, ep2]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [ep1, ep2].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  m.ctx.advanceQueueOnEnded("started-from-a-timestamp");
  assert.strictEqual(fake.calls.length, 1, "only the tap itself played");
});

test("REVIEW: the page gives the player its next/previous, so the steering wheel's skip is live", async () => {
  /* `setEpisodeNavigation` had no caller in app.js: the car's skip stayed
     greyed out with a full Up Next. MUTATION: delete the
     `refreshEpisodeNavigation()` call from setPlayList (and saveQueueIds) —
     the player is never told, and `offered()` is empty. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  assert.ok(fake.navCalls.length > 0, "the page must hand the player its navigation");
  let offered = fake.offered();
  assert.strictEqual(typeof offered.next, "function", "a list with a row after this one offers the skip");
  assert.strictEqual(typeof offered.previous, "function", "previous is always offered for an episode: it can at least restart (p-car-5)");

  await offered.next();
  assert.strictEqual(fake.calls[1]?.item.id, b.id, "the skip plays what the end of the episode would");
  offered = fake.offered();
  assert.strictEqual(offered.next, null, "the last row of the list offers no skip");
  assert.strictEqual(typeof offered.previous, "function", "but it can go back");

  const before = fake.navCalls.length;
  m.ctx.addToQueue(c.id);
  assert.ok(fake.navCalls.length > before, "an Up Next edit re-asks, so the skip appears at once");
  assert.strictEqual(typeof fake.offered().next, "function", "Up Next now has something after this");
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

test("app-1-9: with the switch off, the finished episode still leaves Up Next and nothing plays", () => {
  /* The removal lived only inside the advance, so the finished row stayed at
     the top of Up Next and a later advance replayed it. MUTATION: return
     before the removal when the switch is off (the old guard) -> the finished
     row is still queued; red. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  m.ctx.lsSet("cp_autoadvance", false);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;

  m.ctx.advanceQueueOnEnded(a.id);

  assert.strictEqual(fake.calls.length, 0, "the switch still means silence");
  assert.deepStrictEqual([...m.ctx.queueIds()], [b.id], "the finished row left Up Next");

  /* The replay the finding describes: the switch back on, another episode ends. */
  m.ctx.lsSet("cp_autoadvance", true);
  m.ctx.advanceQueueOnEnded(c.id);
  assert.ok(!fake.calls.some((call) => JSON.stringify(call).includes(a.id)), "the finished episode was replayed");
});

test("REVIEW: a chained play that throws is reported to the bar, not left as an unhandled rejection", async () => {
  /* advanceQueueOnEnded called `.play(...).then(...)` with no catch: a throw
     was an unhandled rejection and a silent stop. MUTATION: drop the rejection
     handler from startChained. */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  m.ctx.addToQueue(b.id);
  const reported = [];
  m.ctx.window.ForayPlayer = {
    async play() { throw Object.assign(new Error("boom"), { name: "TypeError" }); },
    onEpisodeEnded() { return () => {}; },
    reportPlayFailure(err) { reported.push(err); },
  };
  await m.ctx.advanceQueueOnEnded(a.id);
  assert.strictEqual(reported.length, 1, "the bar is told the next episode did not start");
  assert.strictEqual(reported[0].name, "TypeError");
});

/* ==================================================================== */
/* 9. PREVIOUS MEANS RESTART, THEN THE ROW BEFORE (audit round 2, p-car-5) */
/* ==================================================================== */

test("REVIEW: ◀◀ restarts the episode past the window, and goes to the previous row only inside it", async () => {
  /* Forty minutes into episode 3, previous landed at the start of episode 2,
     and from the mini bar it was greyed out. The rule every podcast player
     uses, and the Foray's own `forayPrevious`: restart, unless we have only
     just started AND there is a row before this one. The window is the
     player's (`previousMeansRestart`), not a second copy here.
     MUTATION: `if (!prev) return null` back in the getter -> the mini-bar
     case below offers nothing. MUTATION 2: ignore `previousMeansRestart` ->
     the forty-minute case starts episode 2. */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b].map((it) => ({ id: it.id, ctx: "show-x" })), 1);   // b, with a before it

  fake.restartWindowPassed = true;                                             // forty minutes in
  await fake.offered().previous();
  assert.deepStrictEqual(fake.seeks, [0], "past the window, previous restarts");
  assert.strictEqual(fake.calls.length, 1, "…and starts nothing else");

  fake.restartWindowPassed = false;                                            // just started
  await fake.offered().previous();
  assert.strictEqual(fake.calls[1]?.item.id, a.id, "inside the window, the row before plays");

  /* Started from the mini bar / Jump back in: no list, so previous can only
     restart — and it is offered, not greyed out. */
  m.ctx.setPlayList(null);
  await fake.play(b, {});
  m.ctx.refreshEpisodeNavigation();
  const { previous } = fake.offered();
  assert.strictEqual(typeof previous, "function", "an episode with no list still has a previous");
  fake.restartWindowPassed = false;
  await previous();
  assert.deepStrictEqual(fake.seeks, [0, 0], "with no row before it, previous restarts even inside the window");
});

/* ==================================================================== */
/* 9. THEN MORE OF WHAT FITS: THE TAIL (PQ-11, issue #691)                */
/* ==================================================================== */

/* Today's deal, seeded straight onto state.cardSlots in the shape buildCards
   writes — the dealer itself is never run here (it rolls dice and records a
   Home deal as seen; app.js never runs it from the continuation path either).
   One stretch slot first, then two top slots; every episode from a different
   show, so tail-fill's no-back-to-back-show rule never reorders the walk. The
   stretch branch has the taxonomy label "Craft & making", whose "&" proves
   the why line is plain text. Expected tail: t1, t2, s1, t3, t4, s2. */
function seedDeal(m) {
  const byShow = new Map();
  for (const it of m.playable) if (!byShow.has(it.show)) byShow.set(it.show, it);
  const [a, b, t1, t2, t3, t4, s1, s2] = [...byShow.values()];
  seedLivePool(m, [a, b, t1, t2, t3, t4, s1, s2]);
  m.state.taxonomy = { nodes: [{ id: "craft", parent: null, label: "Craft & making" }] };
  m.state.cardSlots = [
    { slot: 1, branch: "craft", role: "stretch", item: s1, items: [s1, s2] },
    { slot: 2, branch: "engineering", role: "top", item: t1, items: [t1, t3] },
    { slot: 3, branch: "science", role: "top", item: t2, items: [t2, t4] },
  ];
  return { a, b, t1, t2, t3, t4, s1, s2 };
}

const settle = () => new Promise((r) => setImmediate(r));

test("PQ-11: with Up Next empty and the list finished, the next play is the tail's first pick", async () => {
  /* The founder's car case (2026-09-14): the list runs out and the silence
     returns. MUTATION: drop `tail: tailIds(currentId)` from continuationState
     -> nothing plays after a. */
  const m = mount();
  const { a, t1 } = seedDeal(m);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [{ id: a.id, ctx: "show-x" }], 0);
  assert.deepStrictEqual([...m.ctx.tailIds(a.id)].slice(0, 3), [t1.id, m.state.cardSlots[2].item.id, m.state.cardSlots[0].item.id],
    "the tail is today's deal, top, top, stretch");

  await m.ctx.advanceQueueOnEnded(a.id);
  assert.strictEqual(fake.calls.length, 2, "the end of the list is no longer the end");
  assert.strictEqual(fake.calls[1].item.id, t1.id, "the tail's first pick plays");
  assert.strictEqual(m.state.playListCursor, a.id, "the list cursor stays where the list ended");
});

test("PQ-11: the third tail play is the stretch pick, its why is the bridge line naming the subject, and it is announced", async () => {
  /* README founder-question default 18: every third tail pick is the stretch
     subject. MUTATION: make tailIds rebuild from scratch each time (drop the
     `walked` filtering, so the played pick is just excluded) -> the stretch
     stays at position 3 of each fresh build and t3 plays third instead of s1.
     MUTATION 2: return whyFor(...) unconditionally from chainedWhy -> the why
     is the hook. MUTATION 3: drop the announce() after a tail start. */
  const m = mount();
  const { a, t1, t2, s1 } = seedDeal(m);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [{ id: a.id, ctx: "show-x" }], 0);

  await m.ctx.advanceQueueOnEnded(a.id); await settle();
  await m.ctx.advanceQueueOnEnded(t1.id); await settle();
  await m.ctx.advanceQueueOnEnded(t2.id); await settle();

  assert.deepStrictEqual(fake.calls.map((c) => c.item.id), [a.id, t1.id, t2.id, s1.id], "top, top, then the stretch subject");
  assert.strictEqual(fake.calls[3].opts.why,
    "Outside your usual subjects — a deliberate change of pace into Craft & making.",
    "the stretch pick says why, naming the subject, in plain text");
  assert.notStrictEqual(fake.calls[1].opts.why, fake.calls[3].opts.why, "a top pick does not get the bridge line");
  const region = m.body.children.filter((el) => el.id === "a11y-status").at(-1);
  assert.ok(region, "a tail start is announced");
  assert.strictEqual(region.textContent, `Up next: ${s1.title}`);
});

test("PQ-11: a tail pick never repeats an episode already played or queued", async () => {
  /* t1 is in history, t2 is queued. Up Next plays first (t2), and then the
     tail must skip both. MUTATION: drop `...pickedHistory()` from tailIds'
     exclude -> t1 plays again. MUTATION 2: drop `...queueIds()` -> the tail
     read while t2 is queued offers t2. */
  const m = mount();
  const { a, t1, t2, t3 } = seedDeal(m);
  m.ctx.recordHistory(t1.id);
  m.ctx.addToQueue(t2.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [{ id: a.id, ctx: "show-x" }], 0);
  assert.ok(![...m.ctx.tailIds(a.id)].includes(t1.id), "history is not in the tail");
  assert.ok(![...m.ctx.tailIds(a.id)].includes(t2.id), "Up Next is not in the tail");

  await m.ctx.advanceQueueOnEnded(a.id); await settle();
  assert.strictEqual(fake.calls[1].item.id, t2.id, "Up Next still comes first");
  await m.ctx.advanceQueueOnEnded(t2.id); await settle();
  assert.strictEqual(fake.calls[2].item.id, t3.id, "the tail skips what was played and queued");
  const played = fake.calls.map((c) => c.item.id);
  assert.strictEqual(new Set(played).size, played.length, "nothing played twice");
});

test("PQ-11: the switch off stops the tail too — and the skip still reaches it (a skip is the end reached early)", async () => {
  /* README default 18: "The existing switch turns off the whole chain."
     MUTATION: drop the `if (!autoAdvanceOn())` branch from
     advanceQueueOnEnded -> t1 plays with the switch off. */
  const m = mount();
  const { a, t1 } = seedDeal(m);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [{ id: a.id, ctx: "show-x" }], 0);
  m.ctx.lsSet("cp_autoadvance", false);

  await m.ctx.advanceQueueOnEnded(a.id); await settle();
  assert.strictEqual(fake.calls.length, 1, "with the switch off, the end of the list is silence");

  /* EPISODE_NAVIGATION.next reads the same rules, so the steering wheel's
     skip at the end of the list goes into the tail — switch or no switch. */
  m.ctx.refreshEpisodeNavigation();
  const { next } = fake.offered();
  assert.strictEqual(typeof next, "function", "the skip is offered at the end of the list");
  await next();
  assert.strictEqual(fake.calls[1]?.item.id, t1.id, "and plays the tail's first pick");
});
