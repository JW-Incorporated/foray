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
 *  4. `applyEngineAdvance` applies a hop the engine walked exactly once —
 *     across a second delivery AND across a reload — writing the page-owned
 *     `cp_engine_applied` watermark BEFORE `play_started` is logged.
 *  5. `drainEngineEvents` logs each engine `position` event once, with the
 *     time the engine recorded it, watermark first.
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
before(async () => { RULES = await import("../player/continuation.js"); });

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
