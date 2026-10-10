/* The page's half of continuous playback under the native engine (NE-13;
 * docs/native-engine-plan.md §5.5).
 *
 * The RULES are player/continuation.js and are pinned by its fixture family
 * (player/continuation.test.js). This suite pins app.js's WIRING around them,
 * which is where the plan's promises are kept or broken:
 *
 *  1. app.js keeps no copy of the rule: what plays next is whatever
 *     `window.forayContinuation` answers.
 *  2. Whenever the answer can change, the player is handed
 *     `setContinuation({planSeq, autoAdvance, chain})` — including when the
 *     Continuous playback switch is flipped while an episode plays, which is
 *     the one change the engine could not otherwise see before the episode
 *     ends.
 *  3. With the switch off the chain is still sent, so the car's skip works.
 *     Past the end of the list the chain runs on into the tail (PQ-11, #691),
 *     each such hop marked `fromTail`, so the engine keeps playing too.
 *  4. `applyEngineAdvance` applies a hop the engine walked exactly once —
 *     across a second delivery AND across a reload — writing the page-owned
 *     `cp_engine_applied` watermark BEFORE `play_started` is logged.
 *  5. `drainEngineEvents` logs each engine `position` event once, with the
 *     time the engine recorded it, watermark first.
 *  6. Every Up Next tool re-sends the plan (PQ-07, #762): Play next, a drag
 *     reorder and Clear all write through `saveQueueIds`, and the engine's
 *     K-hop chain follows each new order — the iOS parity pin behind the
 *     founder's drag gesture.
 *
 * Every test names the mutation that kills it (CLAUDE.md: "a green test is not
 * evidence until you have broken it").
 *
 * Harness: the node:vm page of test/up-next-autoadvance.test.js, duplicated
 * rather than imported for the reason that suite gives. Two differences: its
 * elements remember their listeners (the switch is clicked for real), and the
 * page gets a recording event log in place of player/client.js's.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

let RULES = null;
let TAIL_FILL = null;
let QUEUE_ORDER = null;
before(async () => {
  RULES = await import("../player/continuation.js");
  TAIL_FILL = await import("../player/tail-fill.js");
  QUEUE_ORDER = await import("../player/queue-order.js");
});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
  "banner-slot", "pl-form", "pl-input", "pl-note",
];

/** A fake `window.ForayPlayer` with the native branch's extra method:
    `setContinuation` records every plan it is handed. */
function makeFakePlayer() {
  const calls = [];
  const plans = [];
  let currentId = null;
  return {
    calls, plans,
    async play(item, opts) { calls.push({ item, opts }); currentId = item.id; return true; },
    onEpisodeEnded() { return () => {}; },
    setEpisodeNavigation() { return true; },
    setContinuation(plan) { plans.push(JSON.parse(JSON.stringify(plan))); },
    currentEpisodeId() { return currentId; },
  };
}

function mount({ store = new Map(), rules = RULES } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  const events = [];
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
    /* player/client.js's event pipeline, recording each row together with the
       watermark as it stood at the moment the row was appended. */
    forayEventLog: {
      append(row) { events.push({ row, appliedAtAppend: store.has("cp_engine_applied") ? JSON.parse(store.get("cp_engine_applied")) : null }); },
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.forayContinuation = rules;
  ctx.forayTailFill = TAIL_FILL;
  /* player/client.js publishes the Up Next order rules (PQ-01) the same way;
     Play next and Clear read them through queueOrderRules(). */
  ctx.forayQueueOrder = QUEUE_ORDER;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  const playable = readJson("data/discover.json").items.filter((it) => it.audio_url);
  return {
    ctx, evalIn, store, state, playable, byId, events,
    rows: (type) => events.filter((e) => e.row.type === type),
    applied: () => (store.has("cp_engine_applied") ? JSON.parse(store.get("cp_engine_applied")) : null),
    queueRaw: () => JSON.parse(store.get("cp_queue") || "null"),
  };
}

function seedLivePool(m, items) {
  for (const it of items) m.state.itemIndex[it.id] = it;
  m.state.poolIds = new Set(items.map((it) => it.id));
  if (!m.state.session) m.state.session = { session_id: "s-1", cards: [] };
}

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
/* 1. THE RULE IS THE MODULE'S                                            */
/* ==================================================================== */

test("app.js plays what player/continuation.js picks, and nothing when the rules are absent", () => {
  /* MUTATION: restore app.js's own planAfterEnded body (any local copy) — the
     stubbed pick is ignored and Up Next's head plays instead. */
  const m = mount({
    rules: { ...RULES, nextAfterEnded: (s, id) => ({ nextId: "picked-by-module", rest: null, fromList: false, state: { ...s, playChainId: "picked-by-module" } }) },
  });
  const [a] = m.playable;
  const picked = { ...m.playable[1], id: "picked-by-module" };
  seedLivePool(m, [a, picked]);
  m.ctx.addToQueue(a.id);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  m.ctx.advanceQueueOnEnded("something-else");
  assert.strictEqual(fake.calls[0]?.item.id, "picked-by-module");

  const bare = mount({ rules: null });
  seedLivePool(bare, [a]);
  bare.ctx.addToQueue(a.id);
  const fake2 = makeFakePlayer();
  bare.ctx.window.ForayPlayer = fake2;
  bare.ctx.advanceQueueOnEnded("something-else");
  assert.strictEqual(fake2.calls.length, 0, "no rules, no pick: app.js has no fallback copy to drift");
});

/* ==================================================================== */
/* 2 & 3. THE PLAN IS SENT AHEAD, AND RE-SENT WHEN THE SWITCH MOVES       */
/* ==================================================================== */

test("a play hands the player setContinuation: the chain continuationPlan computes, with autoAdvance", async () => {
  /* MUTATION: drop sendContinuation() from refreshEpisodeNavigation — no plan.
     MUTATION 2: drop the sendContinuation() after bindPlay's play — the last
     plan was made before the tap's play, from no current episode, and is empty. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b, c].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  const plan = fake.plans.at(-1);
  assert.ok(plan, "the player was handed a plan");
  assert.strictEqual(plan.autoAdvance, true);
  assert.deepStrictEqual(plan.chain.map((h) => h.nextId), [b.id, c.id], "the rest of the list, in order");
  assert.deepStrictEqual(plan.chain.map((h) => h.hopSeq), [1, 2]);
  assert.ok(plan.chain.every((h) => h.planSeq === plan.planSeq), "each hop names its plan");
  assert.strictEqual(plan.chain[0].lastEpisodeRow.id, b.id);
  assert.strictEqual(plan.chain[0].lastEpisodeRow.updated_at, undefined, "the engine stamps the time");
  const seqs = fake.plans.map((p) => p.planSeq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "planSeq only rises");
});

test("flipping Continuous playback while an episode plays re-sends the plan with the new autoAdvance", async () => {
  /* The toggle used to only write cp_autoadvance: fine for a player that asks
     at the end, invisible to one that was told ahead. MUTATION: drop the
     refreshEpisodeNavigation() call from the "Continuous playback" toggle. */
  const m = mount();
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  m.ctx.bindDrawerToggles();
  const before = fake.plans.length;
  try { m.byId.get("autoadvance-toggle").click(); } catch (_) { /* the drawer repaint is not under test */ }
  assert.strictEqual(m.ctx.autoAdvanceOn(), false, "the click turned it off");
  assert.ok(fake.plans.length > before, "the flip was sent while playing");
  const plan = fake.plans.at(-1);
  assert.strictEqual(plan.autoAdvance, false);
  assert.deepStrictEqual(plan.chain.map((h) => h.nextId), [b.id], "the chain is still planned with the switch off");
  assert.strictEqual(RULES.canNext(plan), true, "so the car's skip is still offered");
});

test("PQ-11: the plan sent after a list end carries hops with fromTail: true beyond the list", async () => {
  /* The page is asleep in the car when the list ends, so the tail has to be
     in the plan the engine was handed, not only in the page's own answer.
     The deal is seeded on state.cardSlots (the dealer is never run here).
     MUTATION: drop `tail: tailIds(currentId)` from continuationState -> the
     chain stops at b. MUTATION 2: drop the `state.tailPlayed` line from
     applyEngineAdvance -> the next plan is a fresh build: [t3, t2, s1]. */
  const m = mount();
  const byShow = new Map();
  for (const it of m.playable) if (!byShow.has(it.show)) byShow.set(it.show, it);
  const [a, b, t1, t2, t3, s1] = [...byShow.values()];
  seedLivePool(m, [a, b, t1, t2, t3, s1]);
  m.state.cardSlots = [
    { slot: 1, branch: "craft", role: "stretch", item: s1, items: [s1] },
    { slot: 2, branch: "engineering", role: "top", item: t1, items: [t1, t3] },
    { slot: 3, branch: "science", role: "top", item: t2, items: [t2] },
  ];
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, b].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  const plan = fake.plans.at(-1);
  assert.deepStrictEqual(plan.chain.map((h) => h.nextId), [b.id, t1.id, t2.id, s1.id, t3.id],
    "the rest of the list, then the tail: top, top, stretch, top");
  assert.deepStrictEqual(plan.chain.map((h) => h.fromTail), [false, true, true, true, true], "each hop beyond the list says it is from the tail");
  assert.deepStrictEqual(plan.chain.map((h) => h.fromList), [true, false, false, false, false]);

  /* The engine walks b and then the first tail hop while the page sleeps;
     applying the tail hop moves the chain like a list hop and leaves the list
     cursor at the list's end, and the next plan continues the SAME tail (t2
     next, not a rebuild that would put the stretch back at position 3). */
  assert.strictEqual(m.ctx.applyEngineAdvance({ ...plan.chain[0], planSeq: plan.planSeq }), true);
  assert.strictEqual(m.ctx.applyEngineAdvance({ ...plan.chain[1], planSeq: plan.planSeq }), true);
  assert.strictEqual(m.state.playChainId, t1.id, "the chain is on the tail hop");
  assert.strictEqual(m.state.playListCursor, b.id, "a tail hop leaves the list cursor at the list's end");
  await fake.play(t1, {});
  m.ctx.refreshEpisodeNavigation();
  assert.deepStrictEqual(fake.plans.at(-1).chain.map((h) => h.nextId), [t2.id, s1.id, t3.id], "the walk continues where the engine left it");
});

/* ==================================================================== */
/* 4. AN ADVANCE THE ENGINE WALKED IS APPLIED ONCE                        */
/* ==================================================================== */

function hopFor(m, planSeq, hopSeq, item, extra = {}) {
  return { planSeq, hopSeq, finishedId: "earlier", nextId: item.id, fromList: false, queueAfter: [], item, lastEpisodeRow: null, ...extra };
}

test("applyEngineAdvance applies a hop once: Up Next, the chain, play_started at the engine's time, history", () => {
  /* MUTATION: drop `lsSet(ENGINE_APPLIED_KEY, step.applied)` from
     applyEngineAdvance — the second delivery logs a second play_started. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  m.ctx.addToQueue(a.id);
  m.ctx.addToQueue(b.id);
  const hop = hopFor(m, 5, 1, b, { queueAfter: [b.id, c.id], fromList: false, at: Date.parse("2026-09-24T07:30:00.000Z") });

  assert.strictEqual(m.ctx.applyEngineAdvance(hop), true);
  assert.strictEqual(m.ctx.applyEngineAdvance(hop), false, "the same hop again is a no-op");

  const started = m.rows("play_started");
  assert.strictEqual(started.length, 1, "exactly one play_started for one hop");
  assert.deepStrictEqual(
    { ...started[0].row.payload, topics: [...started[0].row.payload.topics] },
    { episode_id: b.id, topics: [...(b.topics || [])], ctx: "autoadvance" },
  );
  assert.strictEqual(started[0].row.ts, "2026-09-24T07:30:00.000Z", "the row carries the time the engine played it");
  assert.deepStrictEqual([...m.queueRaw()], [b.id, c.id], "Up Next is what the engine left");
  assert.strictEqual(m.state.playChainId, b.id, "the chain is on the hop");
  assert.ok(m.ctx.pickedHistory().includes(b.id), "history has it");
});

test("the watermark is written BEFORE play_started, and a reload does not re-apply the hop", () => {
  /* MUTATION: move the lsSet after logEvent in applyEngineAdvance — the row is
     appended while the watermark still predates it. MUTATION 2: key the
     watermark in memory only — the fresh page applies the hop again. */
  const store = new Map();
  const m = mount({ store });
  const [a, b] = m.playable;
  seedLivePool(m, [a, b]);
  const h1 = hopFor(m, 7, 1, a);
  const h2 = hopFor(m, 7, 2, b);
  m.ctx.applyEngineAdvance(h1);
  m.ctx.applyEngineAdvance(h2);
  const started = m.rows("play_started");
  assert.deepStrictEqual(
    started.map((e) => e.appliedAtAppend?.advance),
    [{ planSeq: 7, hopSeq: 1 }, { planSeq: 7, hopSeq: 2 }],
    "each row was logged with its own hop already recorded",
  );

  const again = mount({ store });
  seedLivePool(again, [a, b]);
  assert.strictEqual(again.ctx.applyEngineAdvance(h1), false);
  assert.strictEqual(again.ctx.applyEngineAdvance(h2), false);
  assert.strictEqual(again.rows("play_started").length, 0, "the reloaded page logs nothing new");
  assert.strictEqual(again.ctx.applyEngineAdvance(hopFor(again, 8, 1, a)), true, "a later plan's hop still applies");
});

/* ==================================================================== */
/* 5. THE ENGINE'S POSITION EVENTS ARE REPLAYED ONCE, AT THEIR OWN TIME   */
/* ==================================================================== */

test("drainEngineEvents logs each position once, at the engine's timestamp, watermark first", () => {
  /* MUTATION: drop the lsSet from drainEngineEvents — the second drain logs
     both positions again. MUTATION 2: drop `{ ts: step.row.ts }` — the rows
     are stamped at the drain, not at the drive. */
  const m = mount();
  const events = [
    { seq: 1, kind: "position", episode_id: "ep-x", seconds: 60, duration: 3600, at: Date.parse("2026-09-24T07:31:00.000Z") },
    { seq: 2, kind: "position", episode_id: "ep-x", seconds: 120, duration: 3600, at: Date.parse("2026-09-24T07:32:00.000Z") },
  ];
  assert.strictEqual(m.ctx.drainEngineEvents(events), 2);
  assert.strictEqual(m.ctx.drainEngineEvents(events), 0, "a second delivery of the same log is a no-op");
  const rows = m.rows("position");
  assert.deepStrictEqual(rows.map((e) => e.row.ts), ["2026-09-24T07:31:00.000Z", "2026-09-24T07:32:00.000Z"]);
  assert.deepStrictEqual(rows.map((e) => ({ ...e.row.payload })), [
    { episode_id: "ep-x", seconds: 60, duration: 3600 },
    { episode_id: "ep-x", seconds: 120, duration: 3600 },
  ], "client.js's own position payload, so the privacy disclosure is unchanged");
  assert.deepStrictEqual(rows.map((e) => e.appliedAtAppend?.event), [1, 2], "each row logged after its seq was recorded");
  assert.deepStrictEqual(m.applied(), { advance: null, event: 2 });
});

/* ==================================================================== */
/* 6. EVERY UP NEXT TOOL RE-SENDS THE PLAN (PQ-07, #762)                  */
/* ==================================================================== */

/** `a` playing, with `queued` in Up Next and a plan already sent from that
    state. No dealt cards, so the chain has no tail hops: what follows the
    queued rows is the play list or nothing. */
async function playingWithQueue(m, playing, queued) {
  m.state.cardSlots = [];
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  for (const it of queued) m.ctx.addToQueue(it.id);
  await fake.play(playing, {});
  m.ctx.refreshEpisodeNavigation();
  return fake;
}

test("PQ-07: Play next re-sends the plan, and the engine's chain reaches the moved row first", async () => {
  /* MUTATION: drop refreshEpisodeNavigation() from saveQueueIds — the last
     plan is still the one sent before Play next: [b, c]. */
  const m = mount();
  const [a, b, c] = m.playable;
  seedLivePool(m, [a, b, c]);
  const fake = await playingWithQueue(m, a, [a, b, c]);
  assert.deepStrictEqual(fake.plans.at(-1).chain.map((h) => h.nextId), [b.id, c.id], "before: Up Next in order");
  const sent = fake.plans.length;
  const prevSeq = fake.plans.at(-1).planSeq;

  assert.strictEqual(m.ctx.playNextInQueue(c.id), true);
  assert.deepStrictEqual([...m.queueRaw()], [a.id, c.id, b.id], "c sits right after the playing row");
  assert.ok(fake.plans.length > sent, "Play next sent a plan");
  const plan = fake.plans.at(-1);
  assert.strictEqual(plan.chain[0].nextId, c.id, "the engine plays c next");
  assert.strictEqual(plan.chain[1].nextId, b.id, "then b");
  assert.strictEqual(plan.chain.length, 2);
  assert.ok(plan.planSeq > prevSeq, "the new plan supersedes the old one");
});

test("PQ-07: a drag reorder (saveQueueIds(moveTo(...))) re-sends the plan in the new order", async () => {
  /* The drag handle (PQ-04) commits on pointerup through exactly this call.
     MUTATION: drop refreshEpisodeNavigation() from saveQueueIds — the engine
     keeps the pre-drag chain [b, c, d]. */
  const m = mount();
  const [a, b, c, d] = m.playable;
  seedLivePool(m, [a, b, c, d]);
  const fake = await playingWithQueue(m, a, [a, b, c, d]);
  assert.deepStrictEqual(fake.plans.at(-1).chain.map((h) => h.nextId), [b.id, c.id, d.id]);
  const sent = fake.plans.length;
  const prevSeq = fake.plans.at(-1).planSeq;

  const order = m.ctx.forayQueueOrder.moveTo(m.ctx.queueIds(), b.id, 3);
  m.ctx.saveQueueIds(order);
  assert.deepStrictEqual([...m.queueRaw()], [a.id, c.id, d.id, b.id], "b dragged to the bottom");
  assert.ok(fake.plans.length > sent, "the drop sent a plan");
  const plan = fake.plans.at(-1);
  assert.deepStrictEqual(plan.chain.map((h) => h.nextId), [c.id, d.id, b.id], "the engine walks the dragged order");
  assert.ok(plan.planSeq > prevSeq, "the new plan supersedes the old one");
});

test("PQ-07: Clear re-sends the plan: the chain goes on with the play list and has no queued hops", async () => {
  /* MUTATION: drop refreshEpisodeNavigation() from saveQueueIds — the engine
     still holds the cleared rows b and c at the head of its chain. */
  const m = mount();
  const [a, p1, p2, b, c] = m.playable;
  seedLivePool(m, [a, p1, p2, b, c]);
  m.state.cardSlots = [];
  const fake = makeFakePlayer();
  m.ctx.window.ForayPlayer = fake;
  await clickRow(m, [a, p1, p2].map((it) => ({ id: it.id, ctx: "show-x" })), 0);
  m.ctx.addToQueue(b.id);
  m.ctx.addToQueue(c.id);
  m.ctx.refreshEpisodeNavigation();
  const queuedPlan = fake.plans.at(-1);
  assert.deepStrictEqual(queuedPlan.chain.map((h) => h.nextId).slice(0, 2), [b.id, c.id], "before: Up Next comes first");
  const sent = fake.plans.length;

  const removed = m.ctx.clearQueue();
  assert.ok(removed >= 2, "b and c were cleared");
  assert.ok(!m.ctx.queueIds().includes(b.id) && !m.ctx.queueIds().includes(c.id));
  assert.ok(fake.plans.length > sent, "Clear sent a plan");
  const plan = fake.plans.at(-1);
  assert.deepStrictEqual(plan.chain.map((h) => h.nextId), [p1.id, p2.id], "the rest of the play list");
  assert.ok(plan.chain.every((h) => h.fromList === true && !h.fromTail), "no queued hops left in the plan");
  assert.ok(plan.planSeq > queuedPlan.planSeq, "the new plan supersedes the old one");
});

/* ==================================================================== */
/* CH3-04 (R4-01): the plan carries each hop's downloaded source        */
/* ==================================================================== */

/* Everything above is app.js BUILDING the plan; this is player/client.js
   SENDING it. In the native lane the engine walks the chain by itself
   (Continuous playback at an episode end, the wheel's next/previous) with the
   page asleep, so the `audio_url` each hop carries is the only source the
   engine has. A page-started play goes through `localSourceFor` (the
   downloaded file, the stream kept as `source_audio_url`); a hop did not, so
   an offline drive through a downloaded Up Next walked onto a dead link:
   `stop cause=load-deadline`, silence.

   Harness: the real client.js in a pretend iOS shell over the reference
   engine, cut down from player/native-mode.test.js's `bootNative` (duplicated
   rather than imported for the reason that file gives: importing a test file
   runs its tests). Nothing plays here; the suite reads the `setContinuation`
   payloads the page sends. */

let nativeBootSeq = 0;

function nativeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], attrs: new Map(), listeners: new Map(),
    style: {}, dataset: {}, className: "", textContent: "", hidden: false,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    append(...kids) { for (const k of kids) this.children.push(k); },
    appendChild(k) { this.children.push(k); return k; },
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
  };
}

async function bootNativeClient(t) {
  const { pathToFileURL } = require("node:url");
  const { createReferenceEngine } = await import("../player/parity/reference-engine.js");
  const { __resetInstanceForTests } = await import("../player/queue-manager.js");
  let mono = 0;
  const scheduler = {
    nowMs: () => ++mono,
    schedule: () => () => {},
  };
  const ref = createReferenceEngine({ scheduler, now: () => 1_790_000_000_000 });
  const base = ref.asCapacitor({ platform: "ios" });
  /** Every `setContinuation` the page sent the engine, as the wire carried it. */
  const plans = [];
  const capacitor = {
    ...base,
    nativePromise(plugin, method, payload) {
      if (plugin === "ForayAudio" && method === "engineSend" && payload?.cmd === "setContinuation") {
        plans.push(JSON.parse(JSON.stringify(payload.args)));
      }
      return base.nativePromise(plugin, method, payload);
    },
  };
  const rows = new Map();
  const storage = {
    get length() { return rows.size; },
    key: (i) => [...rows.keys()][i] ?? null,
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => { rows.set(k, String(v)); },
    removeItem: (k) => { rows.delete(k); },
  };
  const docListeners = new Map();
  const doc = {
    hidden: false,
    activeElement: null,
    body: nativeNode("body"),
    createElement: (tag) => nativeNode(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(docListeners.get(type) ?? [])]) fn(); },
  };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    Capacitor: capacitor,
    speechSynthesis: {
      speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {},
    },
    ForayMediaSession: { install: () => true, uninstall: () => true },
  };
  const names = ["window", "document", "localStorage", "navigator", "Event", "Audio"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) => Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  set("window", win);
  set("document", doc);
  set("localStorage", storage);
  set("navigator", { storage: { persisted: async () => false }, mediaSession: null });
  set("Event", class { constructor(type) { this.type = type; } });
  set("Audio", function Audio() { throw new Error("the native lane builds no <audio>"); });
  __resetInstanceForTests();
  const href = pathToFileURL(path.join(ROOT, "player", "client.js")).href;
  const client = (await import(`${href}?ch3-04=${++nativeBootSeq}`)).default;
  t.after(async () => {
    try {
      doc.hidden = true;
      doc.fire("visibilitychange");
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    } finally {
      ref.dispose();
      for (const [n, d] of prev) {
        if (d) Object.defineProperty(globalThis, n, d);
        else delete globalThis[n];
      }
    }
  });
  assert.strictEqual(await client.whenEngineReady(), "native", "fixture premise: the native lane");
  /* app.js's half of the downloads surface (bootDownloads): the record is
     `cp_downloads`, read through the published store's own reader. */
  win.forayDownloads.recordFor = (id) => win.forayDownloads.store.readDownloads(win.forayStorage).items[id] || null;
  return { client, win, plans };
}

const remoteEpisode = (id) => ({
  id, kind: "episode", title: `Title ${id}`, show: "Show", audio_url: `https://cdn/${id}.mp3`, duration_sec: 3600,
});
/** continuation.js's hop shape, `lastEpisodeRow` built from the ORIGINAL item. */
const planHop = (planSeq, hopSeq, finishedId, item) => ({
  planSeq, hopSeq, finishedId, nextId: item.id, fromList: false, fromTail: false, queueAfter: [], item,
  lastEpisodeRow: { id: item.id, title: item.title, show: item.show, audio_url: item.audio_url, duration_sec: item.duration_sec },
});

/** app.js's `onDownloadEvent` for one plugin event, through the published store. */
async function downloadEvent(win, name, payload) {
  const rules = win.forayDownloads.store;
  const report = rules.reportFromEvent(name, payload, { now: Date.now() });
  rules.writeDownloads(win.forayStorage, rules.applyProgress(rules.readDownloads(win.forayStorage), report));
  await settle();
}

/** Let the engine client's serial send reach the wire. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const FILE_B = "/var/mobile/Containers/Data/Application/X/Library/Application Support/downloads/b.mp3";

test("CH3-04: a hop of a downloaded episode is sent with its file, the stream kept as source_audio_url; lastEpisodeRow still names the stream", async (t) => {
  /* R4's repro: `chain.map(h => h.item.audio_url)` was `https://cdn/b.mp3` for
     a `done` row, so the engine streamed the episode the listener downloaded.
     MUTATION: drop the `localSourceFor` map in sendEnginePlan (send the chain
     as built) — hop b goes out with the remote URL; red.
     MUTATION 2: rebuild `lastEpisodeRow` from the localised item — the pointer
     row the engine stores names a file that may be evicted by tomorrow; red. */
  const { client, win, plans } = await bootNativeClient(t);
  win.forayDownloads.store.writeDownloads(win.forayStorage, {
    items: { b: { status: "done", path: FILE_B, bytes: 10, total: 10 } },
  });
  const hops = [planHop(7, 1, "z", remoteEpisode("a")), planHop(7, 2, "a", remoteEpisode("b"))];
  const handed = JSON.parse(JSON.stringify(hops));
  assert.strictEqual(await client.setContinuation({ planSeq: 7, autoAdvance: true, chain: hops }), true);
  const sent = plans.at(-1);
  assert.ok(sent, "the plan reached the engine");
  const hopB = sent.chain[1];
  assert.ok(hopB.item.audio_url.startsWith("file://"), `the engine walks to the file, not ${hopB.item.audio_url}`);
  assert.ok(hopB.item.audio_url.endsWith("/b.mp3"));
  assert.strictEqual(hopB.item.source_audio_url, "https://cdn/b.mp3", "the stream rides along, as for a page-started play");
  assert.strictEqual(hopB.item.isLocalFile, true);
  assert.deepStrictEqual(hopB.lastEpisodeRow, handed[1].lastEpisodeRow, "the pointer row names the episode's stream");
  assert.deepStrictEqual(hops, handed, "app.js's plan is not mutated");
});

test("CH3-04: a hop with no download is sent byte-identical to the hop app.js handed over", async (t) => {
  /* MUTATION: localise every hop unconditionally (`{ ...hop, item: { ...hop.item,
     isLocalFile: false } }`) — the streamed hop gains a field; red. */
  const { client, plans } = await bootNativeClient(t);
  const hops = [planHop(8, 1, "z", remoteEpisode("a")), planHop(8, 2, "a", remoteEpisode("c"))];
  const handed = JSON.parse(JSON.stringify(hops));
  await client.setContinuation({ planSeq: 8, autoAdvance: false, chain: hops });
  assert.deepStrictEqual(plans.at(-1), { planSeq: 8, autoAdvance: false, chain: handed });
});

test("CH3-04: a download that finishes or is removed for a hop re-sends the plan; one for no hop does not", async (t) => {
  /* The plan is sent at a play or an Up Next edit; a download that lands
     afterwards would otherwise still stream on the drive.
     MUTATION: drop the re-send call from the published store's writer — no
     second plan after `downloadDone`; red.
     MUTATION 2: re-send on every write (drop the "did a hop's source move"
     check) — a progress tick for an episode in no hop re-sends; red. */
  const { client, win, plans } = await bootNativeClient(t);
  win.forayDownloads.store.writeDownloads(win.forayStorage, {
    items: {
      b: { status: "downloading", bytes: 1, total: 10 },
      q: { status: "downloading", bytes: 1, total: 10 },
    },
  });
  const hops = [planHop(9, 1, "z", remoteEpisode("a")), planHop(9, 2, "a", remoteEpisode("b"))];
  await client.setContinuation({ planSeq: 9, autoAdvance: true, chain: hops });
  assert.strictEqual(plans.length, 1);
  assert.strictEqual(plans[0].chain[1].item.audio_url, "https://cdn/b.mp3", "fixture premise: b is still downloading");

  await downloadEvent(win, "downloadProgress", { id: "q", bytes: 5, total: 10 });
  await downloadEvent(win, "downloadProgress", { id: "b", bytes: 5, total: 10 });
  assert.strictEqual(plans.length, 1, "a tick that moves no hop's source sends nothing");

  await downloadEvent(win, "downloadDone", { id: "b", path: FILE_B, bytes: 10 });
  assert.strictEqual(plans.length, 2, "b's file landed: the plan is re-sent");
  assert.strictEqual(plans[1].planSeq, 9, "the same plan, not a new one");
  assert.ok(plans[1].chain[1].item.audio_url.startsWith("file://"), "now the engine walks to the file");
  assert.deepStrictEqual(plans[1].chain[0], plans[0].chain[0], "the other hop is unchanged");

  await downloadEvent(win, "downloadDone", { id: "q", path: "/x/q.mp3", bytes: 10 });
  assert.strictEqual(plans.length, 2, "a download for an episode in no hop sends nothing");

  const rules = win.forayDownloads.store;
  rules.writeDownloads(win.forayStorage, rules.removeRow(rules.readDownloads(win.forayStorage), "b"));
  await settle();
  assert.strictEqual(plans.length, 3, "b's file removed: the plan is re-sent");
  assert.strictEqual(plans[2].chain[1].item.audio_url, "https://cdn/b.mp3", "and the engine streams b again");
  assert.strictEqual(plans[2].chain[1].item.source_audio_url, undefined);
});
