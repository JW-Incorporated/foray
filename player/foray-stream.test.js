/* A Foray played while it is generated (GV-57, docs/roadmap/generation-v2.md;
   the acceptance test is docs/curation/player-streaming-brief.md §5).

   A REAL PlayerQueueManager on the parity fakes (player/parity/fakes.js), driven
   by the real follower (player/foray-stream.js) over three job snapshots of one
   job: act 1 running, act 2 running, the whole Foray complete. The fetch and the
   follower's clock are injected; nothing here touches a network or a timer.

   NOT A PARITY-COVERED SUITE, on purpose (player/parity/coverage.js): appending
   to a queue is a JS-lane rule only. The native engine has no append command,
   and client.js's `followForayStream` refuses in the native lane (the last
   tests below pin the pure half of that refusal). */

import test from "node:test";
import assert from "node:assert/strict";

import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { END_OUT_POINT } from "./queue-state.js";
import { buildForayQueue } from "./foray-queue.js";
import {
  createForayStreamFollower, followForayStream, STREAM_POLL_MS, JOB_SNAPSHOT_SCHEMA,
} from "./foray-stream.js";
import { FakeBackend, MemoryStore, OpLog, fakeTts, manualScheduler, tick } from "./parity/fakes.js";

/* ---------- the job: three snapshots of one streamed Foray ---------- */

const FORAY_ID = "fire-smoke-and-the-long-cook-1a2b3c";

const CATALOGUE = {
  "ep-a": { id: "ep-a", audio_url: "https://cdn.test/a.mp3", dai_suspected: false, duration_sec: 3600, title: "A", show: "Show A" },
  "ep-b": { id: "ep-b", audio_url: "https://cdn.test/b.mp3", dai_suspected: false, duration_sec: 3600, title: "B", show: "Show B" },
  "ep-c": { id: "ep-c", audio_url: "https://cdn.test/c.mp3", dai_suspected: false, duration_sec: 3600, title: "C", show: "Show C" },
};
const QUEUE_OPTIONS = { resolveItem: (id) => CATALOGUE[id] ?? null };

const PRELUDE = { type: "narration", id: "prelude", script: "This Foray was made by a machine and has not been reviewed.", mode: "marker", slot: "a1s1" };
/* Each part ends on a clip. (A part that ends on a narration line reaches the
   end through the reducer's bridge path, which spoke a closing line after a
   clip twice before it ended until #1348 fixed it in queue-state.js.) */
const ACT1 = [
  { type: "segment", item_id: "ep-a", start_sec: 100, end_sec: 190, why: "the origin", slot: "a1s1" },
  { type: "narration", id: "n-1", script: "That was the origin. Here is the first cook.", mode: "hinge", slot: "a1s2" },
  { type: "segment", item_id: "ep-a", start_sec: 400, end_sec: 470, why: "the first cook", slot: "a1s2" },
];
const ACT2 = [
  { type: "narration", id: "n-2", script: "Now, how it actually works.", mode: "intro", slot: "a2s1" },
  { type: "segment", item_id: "ep-b", start_sec: 40, end_sec: 160, why: "how it works", slot: "a2s1" },
];
const ACT3 = [
  { type: "narration", id: "n-3", script: "And the part nobody expects.", mode: "intro", slot: "a3s1" },
  { type: "segment", item_id: "ep-c", start_sec: 300, end_sec: 410, why: "the surprise", slot: "a3s1" },
];

const ACT_TITLES = ["Act 1: The origin", "Act 2: How it actually works", "Act 3: The part nobody expects"];

function snapshot({ seq, status = "running", items, actsReady }) {
  return {
    schema: JOB_SNAPSHOT_SCHEMA,
    jobId: "6f1c0a52-3d7e-4f0b-9c64-0b8f6f1e2a10",
    forayId: FORAY_ID,
    authorId: "listener-1",
    lane: "on-demand",
    status,
    seq,
    updatedAt: `2026-10-12T10:00:${String(seq).padStart(2, "0")}.000Z`,
    title: "Fire, smoke and the long cook",
    topic: "food/grilling-bbq",
    summary: "How people learned to cook with smoke.",
    acts: ACT_TITLES.map((title, index) => ({
      index, title, status: index < actsReady ? "ready" : "pending", servable: index < actsReady,
    })),
    items: structuredClone(items),
    itemStates: items.map((it, i) => ({
      itemId: it.id ?? `${FORAY_ID}#${i}`,
      check: i === 0 ? "prelude" : it.type === "segment" ? "tape" : "verified",
      audio: "pending",
    })),
    runtimeSecSoFar: 0,
    delivery: { servableThrough: items.length, itemsGenerated: items.length, servableThroughAct: actsReady - 1, pausedAtIndex: null },
    ...(status === "running" ? {} : { closed: { outcome: status } }),
  };
}

const SNAP_1 = snapshot({ seq: 5, items: [PRELUDE, ...ACT1], actsReady: 1 });
const SNAP_2 = snapshot({ seq: 9, items: [PRELUDE, ...ACT1, ...ACT2], actsReady: 2 });
const SNAP_3 = snapshot({ seq: 12, status: "complete", items: [PRELUDE, ...ACT1, ...ACT2, ...ACT3], actsReady: 3 });

/* ---------- the rig ---------- */

/** A real manager on the parity fakes, and a follower whose fetch serves
    `responses` in order (the last one again once they run out). A response
    that is an Error is thrown. */
function rig(t, responses, { followerOpts = {} } = {}) {
  __resetInstanceForTests();
  const log = new OpLog();
  const lines = [];
  const settled = [];
  const backend = new FakeBackend({ log });
  const tts = fakeTts({ log });
  const store = new MemoryStore({ log });
  const manager = new PlayerQueueManager({
    backend, tts, positionStore: store, seamGapSec: 0, allowMultiple: true,
    telemetry: (m) => lines.push(m),
    onStateSettled: (state) => settled.push({ type: state.type, waiting: manager.forayStreamWaiting }),
  });
  t.after(() => manager.dispose());
  const clock = manualScheduler();
  const queue = [...responses];
  let fetches = 0;
  const fetchSnapshot = async () => {
    fetches++;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next == null ? next : structuredClone(next);
  };
  const follower = createForayStreamFollower({
    fetchSnapshot, manager, schedule: clock.schedule, queueOptions: QUEUE_OPTIONS,
    telemetry: (m) => lines.push(m), ...followerOpts,
  });
  t.after(() => follower.stop());
  return {
    manager, backend, tts, store, log, lines, settled, clock, follower,
    get fetches() { return fetches; },
    /** Let the follower's next poll run, and everything it started settle. */
    async nextPoll() { await clock.advance(STREAM_POLL_MS); await settle(); },
  };
}

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

/** Walk playback forward one item: a spoken line finishes, a clip reaches its
    out-point. */
async function finishCurrent(r) {
  const item = r.manager.queue[r.manager.currentIndex];
  if (item.kind === "tts") r.tts.finish();
  else r.backend.onItemEnded(END_OUT_POINT);
  await settle();
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------- §5.1-5.2: start from the first part, append the next ---------- */

test("the first snapshot with items builds the queue, plays item 0 and opens the stream", async (t) => {
  /* MUTATION THAT KILLS THIS: drop `manager.setForayStreamOpen(true)` from the
     follower's first apply -- the stream never opens. */
  const r = rig(t, [SNAP_1]);
  r.follower.start();
  await settle();
  assert.equal(r.follower.started, true);
  assert.equal(r.manager.queue.length, SNAP_1.items.length);
  assert.equal(r.manager.currentIndex, 0);
  assert.equal(r.manager.state.type, "playing");
  assert.equal(r.manager.forayStreamOpen, true);
  assert.equal(r.follower.lastSeq, SNAP_1.seq);
  // The prelude is a script with no file: it is spoken.
  assert.ok(r.log.ops.some((op) => op.startsWith("tts.speak:This Foray was made")));
});

test("an append grows the queue by exactly the new items and touches nothing loaded or playing", async (t) => {
  /* MUTATION THAT KILLS THIS: `this.queue = report.items` in appendForayItems
     (rebuild instead of append) -- the queued items are new objects. */
  const r = rig(t, [SNAP_1, SNAP_2]);
  r.follower.start();
  await settle();
  await finishCurrent(r); // the prelude ends; the act 1 clip is playing
  r.backend.currentTime = 151.5;
  assert.equal(r.manager.state.type, "playing");
  const before = r.manager.queue.slice();
  const beforeJson = clone(before);
  const index = r.manager.currentIndex;
  const state = r.manager.state;
  const opsBefore = r.log.length;

  await r.nextPoll();

  assert.equal(r.manager.queue.length, before.length + ACT2.length, "grew by exactly the new items");
  before.forEach((item, i) => {
    assert.equal(r.manager.queue[i], item, `item ${i} is the same object in the same place`);
  });
  assert.deepStrictEqual(clone(r.manager.queue.slice(0, before.length)), beforeJson, "existing items are byte-identical");
  assert.equal(r.manager.currentIndex, index, "currentIndex unchanged");
  assert.equal(r.manager.state, state, "the playing state is the same object");
  assert.equal(r.backend.currentTime, 151.5, "play position unchanged");
  assert.deepStrictEqual(r.log.since(opsBefore), [], "the append made no backend, speech or store call");
  assert.ok(r.lines.includes("foray.stream.appended.n=2"));
  // The new items are reachable when the listener gets there.
  await finishCurrent(r); // the clip ends: n-1 is spoken
  await finishCurrent(r); // n-1 ends: the second act 1 clip
  await finishCurrent(r); // that clip ends: n-2, the first appended item
  await finishCurrent(r); // n-2 ends: the act 2 clip loads
  assert.equal(r.manager.currentIndex, 5);
  assert.equal(r.manager.queue[5].source_item_id, "ep-b");
  assert.ok(r.log.ops.includes(`load:${FORAY_ID}#5@40`));
});

/* ---------- §5.3: a stale or replayed snapshot changes nothing ---------- */

test("a snapshot whose seq is not higher than the last applied is skipped", async (t) => {
  /* MUTATION THAT KILLS THIS: drop the follower's `snap.seq > lastSeq` check
     -- the replay is applied and appends act 2. */
  const replay = { ...structuredClone(SNAP_2), seq: SNAP_1.seq };
  const r = rig(t, [SNAP_1, replay, SNAP_1]);
  r.follower.start();
  await settle();
  const before = clone(r.manager.queue);
  assert.equal(await r.follower.poll(), "stale");
  assert.equal(await r.follower.poll(), "stale");
  assert.deepStrictEqual(clone(r.manager.queue), before);
  assert.ok(!r.lines.some((m) => m.startsWith("foray.stream.appended")));
});

/* ---------- §5.4: the end of an open stream is a wait ---------- */

test("reaching the end with the stream open waits, with no finished save, and an append resumes at the next index", async (t) => {
  /* MUTATIONS THAT KILL THIS: drop the waiting branch in `_handle` (no
     foray.stream.waiting, the surface reads waiting=false at the end); drop
     the `await this.play(at)` resume in appendForayItems (the player stays
     ended after the append). */
  const r = rig(t, [SNAP_1, SNAP_2]);
  r.follower.start();
  await settle();
  await finishCurrent(r); // prelude
  await finishCurrent(r); // act 1's first clip
  await finishCurrent(r); // n-1
  const saves = r.log.ops.filter((op) => op.startsWith("store.")).length;
  await finishCurrent(r); // act 1's last clip, the last item made so far
  assert.equal(r.manager.state.type, "ended");
  assert.equal(r.manager.forayStreamWaiting, true);
  assert.ok(r.lines.includes(`foray.stream.waiting at=${SNAP_1.items.length}`));
  // The surface's repaint at the end already reads "waiting", which is what
  // makes client.js skip the finished mark; and the end itself saved nothing.
  const atEnd = r.settled.filter((s) => s.type === "ended");
  assert.ok(atEnd.length > 0 && atEnd.every((s) => s.waiting === true));
  assert.equal(r.log.ops.filter((op) => op.startsWith("store.")).length, saves);
  // It never plays anything that is not in `items`.
  assert.equal(r.manager.queue.length, SNAP_1.items.length);

  await r.nextPoll();
  assert.equal(r.manager.forayStreamWaiting, false);
  assert.ok(r.lines.includes(`foray.stream.resumed at=${SNAP_1.items.length}`));
  assert.equal(r.manager.currentIndex, SNAP_1.items.length);
  assert.equal(r.manager.state.type, "playing");
  assert.ok(r.log.ops.includes("tts.speak:Now, how it actually works.@1"), "act 2's first line is spoken");
});

test("with the stream closed (the default) an ordinary Foray still ends at its last item", async (t) => {
  /* MUTATION THAT KILLS THIS: construct the manager with `_streamOpen = true`
     -- an ordinary Foray waits at its end instead of ending. */
  const r = rig(t, [SNAP_1]);
  assert.equal(r.manager.forayStreamOpen, false);
  r.manager.setQueueFromForay({ id: FORAY_ID, items: SNAP_1.items }, QUEUE_OPTIONS);
  await r.manager.play(0);
  for (let i = 0; i < SNAP_1.items.length; i++) await finishCurrent(r);
  assert.equal(r.manager.state.type, "ended");
  assert.equal(r.manager.forayStreamWaiting, false);
  assert.ok(!r.lines.some((m) => m.startsWith("foray.stream.waiting")));
});

test("a new queue closes the stream, so a Foray played after it ends normally", async (t) => {
  /* MUTATION THAT KILLS THIS: empty `_closeForayStreamForNewQueue` -- the
     stream stays open over a queue that is not the stream's. */
  const r = rig(t, [SNAP_1]);
  r.follower.start();
  await settle();
  assert.equal(r.manager.forayStreamOpen, true);
  r.manager.setQueueFromPick(CATALOGUE["ep-a"]);
  assert.equal(r.manager.forayStreamOpen, false);
});

/* ---------- §5.5: the complete snapshot converges and stops polling ---------- */

test("after the complete snapshot the queue equals buildForayQueue(whole).items and polling stops", async (t) => {
  /* MUTATION THAT KILLS THIS: return "applied" without `close(snap.status)`
     for a non-running status -- the follower keeps polling. */
  const r = rig(t, [SNAP_1, SNAP_2, SNAP_3]);
  r.follower.start();
  await settle();
  await r.nextPoll();
  await r.nextPoll();
  const whole = buildForayQueue({ id: FORAY_ID, title: SNAP_3.title, items: SNAP_3.items }, QUEUE_OPTIONS);
  assert.deepStrictEqual(clone(r.manager.queue), clone(whole.items));
  assert.equal(r.follower.running, false);
  assert.equal(r.manager.forayStreamOpen, false);
  assert.equal(r.clock.live, 0, "no poll is scheduled");
  const fetches = r.fetches;
  await r.nextPoll();
  assert.equal(r.fetches, fetches, "nothing is fetched after the stream closed");
  assert.ok(r.lines.includes("foray.stream.closed reason=complete"));
});

test("a failed snapshot while waiting stops polling and leaves the player ended, saying why", async (t) => {
  /* MUTATION THAT KILLS THIS: drop the `_onStateSettled` call in
     setForayStreamOpen -- the surface is never told the wait is over. */
  const failed = { ...structuredClone(SNAP_1), seq: 7, status: "failed", closed: { outcome: "failed", detail: "budget-stop" } };
  const r = rig(t, [SNAP_1, failed]);
  r.follower.start();
  await settle();
  for (let i = 0; i < SNAP_1.items.length; i++) await finishCurrent(r);
  assert.equal(r.manager.forayStreamWaiting, true);
  const settledBefore = r.settled.length;
  await r.nextPoll();
  assert.equal(r.manager.state.type, "ended");
  assert.equal(r.manager.forayStreamWaiting, false);
  assert.ok(r.lines.includes("foray.stream.ended reason=failed"));
  assert.equal(r.follower.running, false);
  assert.equal(r.clock.live, 0);
  // The surface is told, so it can now finish the Foray.
  assert.deepStrictEqual(r.settled.slice(settledBefore), [{ type: "ended", waiting: false }]);
});

/* ---------- a prefix that changed is refused, untouched ---------- */

test("a prefix mismatch between snapshots throws and leaves the queue untouched", async (t) => {
  /* MUTATION THAT KILLS THIS: push `report.items.slice(this.queue.length)` in
     appendForayItems instead of asking appendableTail -- nothing throws. */
  const rewritten = structuredClone(SNAP_2);
  rewritten.items[2] = { ...rewritten.items[2], script: "A different line where the old one was." };
  const r = rig(t, [SNAP_1]);
  r.follower.start();
  await settle();
  const before = clone(r.manager.queue);
  await assert.rejects(
    r.manager.appendForayItems({ id: FORAY_ID, items: rewritten.items }, QUEUE_OPTIONS),
    /item 2 \(n-1\) changed between builds/,
  );
  assert.deepStrictEqual(clone(r.manager.queue), before);
  assert.ok(!r.lines.some((m) => m.startsWith("foray.stream.appended")));
});

test("the follower stops on a mismatched snapshot and the queue keeps what it had", async (t) => {
  /* MUTATION THAT KILLS THIS: catch the apply error and return "applied"
     without `close("error")` -- the follower keeps polling a stream it
     cannot continue. */
  const reordered = structuredClone(SNAP_2);
  [reordered.items[1], reordered.items[2]] = [reordered.items[2], reordered.items[1]];
  const r = rig(t, [SNAP_1, reordered]);
  r.follower.start();
  await settle();
  const before = clone(r.manager.queue);
  await r.nextPoll();
  assert.deepStrictEqual(clone(r.manager.queue), before);
  assert.equal(r.follower.running, false);
  assert.equal(r.manager.forayStreamOpen, false);
  assert.ok(r.lines.some((m) => m.startsWith("foray.stream.error: appendableTail:")));
});

/* ---------- §5.6: "nothing yet" is silent ---------- */

test("a 404 or 403 is a silent 'nothing yet', and the first real snapshot then starts playback", async (t) => {
  /* MUTATION THAT KILLS THIS: an empty NOTHING_YET set -- a 404 and a 403
     write fetchFailed telemetry. */
  const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
  const r = rig(t, [{ status: 404 }, forbidden, null, SNAP_1]);
  r.follower.start();
  await settle();
  await r.nextPoll();
  await r.nextPoll();
  assert.equal(r.follower.started, false);
  assert.equal(r.manager.queue.length, 0);
  assert.equal(r.manager.state.type, "idle");
  assert.deepStrictEqual(r.lines, [], "no telemetry for nothing yet");
  assert.equal(r.follower.running, true, "still polling");
  await r.nextPoll();
  assert.equal(r.follower.started, true);
  assert.equal(r.manager.state.type, "playing");
});

test("a snapshot from another Foray is not appended", async (t) => {
  /* MUTATION THAT KILLS THIS: drop the forayId check in apply -- the other
     Foray's rebuild reaches appendableTail and the follower closes with
     reason=error instead. */
  const other = { ...structuredClone(SNAP_2), forayId: "someone-elses-foray" };
  const r = rig(t, [SNAP_1, other]);
  r.follower.start();
  await settle();
  const before = clone(r.manager.queue);
  await r.nextPoll();
  assert.deepStrictEqual(clone(r.manager.queue), before);
  assert.equal(r.follower.running, false);
  assert.ok(r.lines.includes("foray.stream.closed reason=other-foray"));
});

/* ---------- the lane: JS only ---------- */

test("followForayStream refuses in the native lane with a telemetry line and never fetches", async () => {
  /* MUTATION THAT KILLS THIS: drop the `lane !== "js"` refusal -- the native
     lane gets a follower that fetches. */
  const lines = [];
  let fetched = 0;
  const follower = followForayStream({
    lane: "native", manager: {}, fetchSnapshot: async () => { fetched++; return SNAP_1; }, telemetry: (m) => lines.push(m),
  });
  await settle();
  assert.equal(follower, null);
  assert.equal(fetched, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^foray\.stream\.refused lane=native/);
});

test("followForayStream in the JS lane starts a follower that drives the manager", async (t) => {
  /* MUTATION THAT KILLS THIS: drop `follower.start()` in followForayStream --
     nothing is fetched and nothing plays. */
  const r = rig(t, [SNAP_1]);
  const follower = followForayStream({
    lane: "js", manager: r.manager, fetchSnapshot: async () => structuredClone(SNAP_1),
    schedule: r.clock.schedule, queueOptions: QUEUE_OPTIONS,
  });
  t.after(() => follower.stop());
  await settle();
  assert.equal(follower.running, true);
  assert.equal(r.manager.state.type, "playing");
  assert.equal(r.manager.forayStreamOpen, true);
});
