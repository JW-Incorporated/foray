/* Continuous playback's decisions, as pure functions (NE-13;
 * docs/native-engine-plan.md §5.5, C-1..C-6).
 *
 * WHAT MOVED HERE, AND WHY. `planAfterEnded` and `nextAfterEnded` lived in
 * app.js as closures over `state` and `localStorage`. The native engine
 * (docs/native-engine-plan.md) owns the audio, so at an episode's end it is the
 * ENGINE that has to start the next one — with the page asleep, in a car. The
 * page still owns the decision (A-1: "continuation hops" are the page's), so it
 * precomputes the next K = 8 hops and hands them over with `setContinuation`;
 * the engine walks them. That needs the rule as a function of plain inputs the
 * page can evaluate eight steps ahead, and a JS-only fixture family (C-2: this
 * file is deliberately NOT ported to Swift) that pins it.
 *
 * The rules themselves are unchanged — app.js delegates, and the existing
 * test/up-next-autoadvance.test.js and test/up-next-queue.test.js are the proof.
 * The founder ruling behind them (2026-09-14, PR #695, issue #691) is spelled
 * out beside `autoAdvanceOn` in app.js and not restated here.
 *
 * THE INJECTED STATE — plain data, so a fixture can hold it:
 *   queue           Up Next, in order (cp_queue)
 *   playList        the ordered row list the play started from, or null
 *   playChainId     the episode the chain is on (started from the list, or advanced to)
 *   playListCursor  the last row of playList that actually played
 *   isPlayable      a predicate over ids, OR an array of the playable ids
 *                   (the fixture form: a function cannot be written to JSON)
 *   items           id -> item, as a function or an object map
 *                   (continuationChain only: a hop carries the item it plays)
 *   currentId       the episode now playing (continuationChain only: where the
 *                   chain starts — `playChainId` is not always it; an episode
 *                   started with no list leaves the chain where it was)
 *
 * THE PAGE-SIDE LEDGER. When the engine walked hops while the page slept, the
 * page later applies them (`applyEngineAdvance` in app.js: Up Next, the chain,
 * `play_started`, history) and replays the engine's `position` events. Both go
 * through `logEvent`, and an event is a row that leaves the device, so each is
 * applied AT MOST ONCE: the page-owned `cp_engine_applied` watermark moves past
 * a hop or an event BEFORE its row is logged. `planAdvanceApply` and
 * `planEventDrain` decide what a delivery applies against that watermark;
 * app.js only executes the steps, in order. A crash between the write and the
 * row costs one row; the opposite order would duplicate one on every attach.
 */

import { makeLastEpisode } from "./episode-progress.js";

/** How many hops ahead the page plans (plan §3, C-2). Eight episodes is a
    long drive; a plan is re-sent whenever Up Next, the list or the switch
    changes, so K only has to outlast one sleep of the page. */
export const CHAIN_HOPS = 8;

const idList = (v) => (Array.isArray(v) ? v : []);

function playableTest(state) {
  const p = state?.isPlayable;
  if (typeof p === "function") return (id) => Boolean(p(id));
  const set = new Set(idList(p));
  return (id) => set.has(id);
}

function itemLookup(state) {
  const it = state?.items;
  if (typeof it === "function") return (id) => it(id) || null;
  return (id) => (it && typeof it === "object" && Object.prototype.hasOwnProperty.call(it, id) ? it[id] : null) || null;
}

/**
 * What plays after `finishedId`, with no writes: `{ nextId, rest, fromList }`.
 * `rest` is Up Next with the finished episode removed (or null when it was not
 * queued) — the caller saves it. Shared by the end of an episode and by the
 * steering wheel's and the sheet's ⏭, which must agree on what "next" is.
 *
 * UP NEXT'S HEAD IS NEXT (founder, 2026-09-24; app.js § the Up Next model).
 * A row played from the Up Next page jumps to the top and nothing else moves,
 * so the finished episode leaving leaves the head as the next one. The rule
 * this replaced resumed the queue at the finished row's old position and then
 * wrapped to the rows above it — with the played row at the top there is no
 * "above it", and wrapping would re-serve an abandoned row.
 *
 * UP NEXT FIRST, THEN THE LIST. The list continues only when the episode that
 * ended belongs to this chain (`playChainId`: started from the list, or by an
 * advance), so an episode started from somewhere with no list (a timestamp,
 * the restored bar) does not resume a list from an earlier visit.
 */
export function planAfterEnded(state, finishedId) {
  const isPlayable = playableTest(state);
  const queued = idList(state?.queue);
  const rest = queued.includes(finishedId) ? queued.filter((x) => x !== finishedId) : null;
  const queuedNext = (rest || queued).find((id) => isPlayable(id));
  if (queuedNext) return { nextId: queuedNext, rest, fromList: false };
  const list = idList(state?.playList);
  const onChain = Boolean(finishedId) && finishedId === state?.playChainId;
  const anchor = list.includes(finishedId) ? finishedId : (onChain ? state?.playListCursor : null);
  const i = anchor ? list.indexOf(anchor) : -1;
  const listNext = i >= 0 ? list.slice(i + 1).find((id) => isPlayable(id)) : null;
  return { nextId: listNext || null, rest, fromList: Boolean(listNext) };
}

/**
 * The plan, plus the state it leaves: `{ nextId, rest, fromList, state }`,
 * where `state` is `{queue, playList, playChainId, playListCursor}` after the
 * finished episode leaves Up Next and the chain moves on to the pick. app.js
 * writes exactly that (Up Next only when `rest` says it changed); a chain is
 * this, applied K times.
 */
export function nextAfterEnded(state, finishedId) {
  const plan = planAfterEnded(state, finishedId);
  const after = {
    queue: plan.rest ?? idList(state?.queue),
    playList: state?.playList ?? null,
    playChainId: state?.playChainId ?? null,
    playListCursor: state?.playListCursor ?? null,
  };
  if (plan.nextId) {
    after.playChainId = plan.nextId;
    if (plan.fromList) after.playListCursor = plan.nextId;
  }
  return { ...plan, state: after };
}

/** `makeLastEpisode(item)` without `updated_at` (plan §5.2): the engine stores
    it verbatim and stamps the time itself when the hop actually plays, so the
    `cp_last_episode` row it writes is byte-for-byte the one the page would. */
export function lastEpisodeRow(item) {
  const row = makeLastEpisode(item);
  if (!row) return null;
  delete row.updated_at;
  return row;
}

/**
 * The next `K` hops after `state.currentId`, in the order the end of each
 * episode would play them — `nextAfterEnded` applied K times, never anything
 * it would not pick. Each hop is
 *   {hopSeq, finishedId, nextId, fromList, queueAfter, item, lastEpisodeRow}
 * `hopSeq` counts from 1 within the chain; `queueAfter` is Up Next once that
 * hop's finished episode has left it, which is what the page saves when it
 * applies the hop.
 *
 * A pick with no item ENDS the chain: app.js's `startChained` returns without
 * playing when `liveEpisode` has nothing, and the engine cannot play what it
 * was not given either.
 */
export function continuationChain(state, K = CHAIN_HOPS) {
  const itemFor = itemLookup(state);
  const limit = Number.isInteger(K) && K > 0 ? K : 0;
  const hops = [];
  let s = state;
  let finished = state?.currentId ?? null;
  while (finished && hops.length < limit) {
    const step = nextAfterEnded(s, finished);
    if (!step.nextId) break;
    const item = itemFor(step.nextId);
    if (!item) break;
    hops.push({
      hopSeq: hops.length + 1,
      finishedId: finished,
      nextId: step.nextId,
      fromList: step.fromList,
      queueAfter: step.state.queue,
      item,
      lastEpisodeRow: lastEpisodeRow(item),
    });
    s = { ...s, ...step.state };
    finished = step.nextId;
  }
  return hops;
}

/**
 * `setContinuation`'s args (plan §5.2): `{planSeq, autoAdvance, chain}`.
 *
 * `autoAdvance` is the Continuous playback switch (`cp_autoadvance`), and it
 * gates only the END of an episode: the chain is planned either way, because
 * the steering wheel's skip plays the same next episode with the switch off
 * (`canNext` below). Each hop carries its `planSeq`, so a hop the engine walked
 * names the plan it came from and the page's watermark can order hops across
 * plans — `hopSeq` alone restarts at 1 in every plan.
 */
export function continuationPlan(state, { planSeq, autoAdvance, K = CHAIN_HOPS } = {}) {
  const chain = continuationChain(state, K).map((hop) => ({ planSeq, ...hop }));
  return { planSeq, autoAdvance: autoAdvance !== false, chain };
}

/** Whether "next" is offered (plan §5.5): the chain is non-empty, REGARDLESS
    of `autoAdvance` — the page's `EPISODE_NAVIGATION.next` has never read the
    switch, and a listener who turned off Continuous playback still skips. */
export function canNext(plan) {
  return Array.isArray(plan?.chain) && plan.chain.length > 0;
}

/* ---------- the page-side ledger (cp_engine_applied) ---------- */

const isSeq = (n) => Number.isFinite(n);

/** The watermark as stored, or the empty one: `{advance: {planSeq, hopSeq} | null,
    event: seq | null}`. A corrupt row reads as empty — replaying is the lesser
    harm than a page that can never apply an advance again. */
export function normalizeApplied(raw) {
  const a = raw && typeof raw === "object" ? raw.advance : null;
  const advance = a && isSeq(a.planSeq) && isSeq(a.hopSeq) ? { planSeq: a.planSeq, hopSeq: a.hopSeq } : null;
  const event = raw && typeof raw === "object" && isSeq(raw.event) ? raw.event : null;
  return { advance, event };
}

const hopKey = (hop) => (hop && isSeq(hop.planSeq) && isSeq(hop.hopSeq) ? { planSeq: hop.planSeq, hopSeq: hop.hopSeq } : null);
const keyAfter = (a, b) => !b || a.planSeq > b.planSeq || (a.planSeq === b.planSeq && a.hopSeq > b.hopSeq);

/** An ISO timestamp for a wall-clock ms or ISO string, or null. */
function isoAt(at) {
  if (!(typeof at === "number" || typeof at === "string") || at === "") return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Which of `hops` a delivery applies, in walk order: `{applied, steps}`, each
 * step `{applied, hop, ts}` — the watermark to write BEFORE that hop's rows,
 * the hop, and the time the engine played it (`hop.at`) or null for "now".
 * A hop at or below the watermark, or with no plan position or no `nextId`, is
 * skipped; so the same log delivered twice applies once.
 */
export function planAdvanceApply(applied, hops) {
  let mark = normalizeApplied(applied);
  const keyed = idList(hops)
    .map((hop) => ({ hop, key: hopKey(hop) }))
    .filter(({ hop, key }) => key && typeof hop.nextId === "string" && hop.nextId)
    .sort((x, y) => x.key.planSeq - y.key.planSeq || x.key.hopSeq - y.key.hopSeq);
  const steps = [];
  for (const { hop, key } of keyed) {
    if (!keyAfter(key, mark.advance)) continue;
    mark = { ...mark, advance: key };
    steps.push({ applied: mark, hop, ts: isoAt(hop.at) });
  }
  return { applied: mark, steps };
}

/**
 * Which of the engine's `pendingEvents` a drain logs, in `seq` order:
 * `{applied, steps}`, each step `{applied, row}` where `row` is
 * `{type, payload, ts}` for `logEvent` with the event's ORIGINAL time, or null
 * for an event the page does not replay (an unknown kind, or a malformed
 * position). A null row still moves the watermark: the engine is acked past it
 * either way. The `position` payload is client.js's own
 * (`{episode_id, seconds, duration}`), so the privacy disclosure is unchanged.
 */
export function planEventDrain(applied, events) {
  let mark = normalizeApplied(applied);
  const ordered = idList(events).filter((e) => e && isSeq(e.seq)).sort((x, y) => x.seq - y.seq);
  const steps = [];
  for (const e of ordered) {
    if (mark.event !== null && e.seq <= mark.event) continue;
    mark = { ...mark, event: e.seq };
    const ts = isoAt(e.at);
    const ok = e.kind === "position" && typeof e.episode_id === "string" && e.episode_id
      && Number.isFinite(e.seconds) && ts;
    const row = ok
      ? { type: "position", payload: { episode_id: e.episode_id, seconds: e.seconds, duration: Number.isFinite(e.duration) ? e.duration : null }, ts }
      : null;
    steps.push({ applied: mark, row });
  }
  return { applied: mark, steps };
}
