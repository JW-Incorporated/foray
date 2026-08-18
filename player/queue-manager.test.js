/* Tests for the queue manager (issue #33), driven through a fake backend.

   The manager is the layer where pure logic meets the outside world, so these
   assert on the SEQUENCE of backend calls — that is where corner cases #12,
   #15 and #19 actually show up. */

import test from "node:test";
import assert from "node:assert/strict";
import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { SINGLE_ITEM, PICKED_FIRST, CONTINUE_TAIL } from "./queue-strategy.js";

const ep = (id, extra = {}) => ({ id, kind: "episode", rate: 1.0, ...extra });
const tts = (id) => ({ id, kind: "tts" });

/** Records every call so tests can assert on ordering, not just end state. */
class FakeBackend {
  constructor({ failLoadFor = [], durationById = {} } = {}) {
    this.calls = [];
    this.currentTime = 0;
    this._duration = 3600;
    /** Per-item duration of "the copy in hand" — what ADR-0007's third rung
        compares against `reference_duration_sec`. Keyed by queue item id. */
    this.durationById = durationById;
    this._loadedId = null;
    this.outPoint = null;
    this.failLoadFor = new Set(failLoadFor);
    this.onItemEnded = null;
    this.onError = null;
  }
  get duration() { return this.durationById[this._loadedId] ?? this._duration; }
  set duration(v) { this._duration = v; }
  async load(item, { startOffset = 0 } = {}) {
    this._loadedId = item.id;
    this.outPoint = null; // contract: a load drops any armed boundary
    this.calls.push(`load:${item.id}@${Math.round(startOffset)}`);
    if (this.failLoadFor.has(item.id)) throw new Error("missing file");
  }
  play() { this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  seek(s) { this.calls.push(`seek:${Math.round(s)}`); }
  setOutPoint(s) {
    this.outPoint = s;
    this.calls.push(`outPoint:${s == null ? "null" : Math.round(s)}`);
  }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
  // ids only, for assertions that do not care about the offset
  loads() { return this.calls.filter((c) => c.startsWith("load:")).map((c) => c.split("@")[0]); }
}

/** A backend from before out-points existed. Used to prove the refusal. */
class OutPointBlindBackend extends FakeBackend {
  constructor(opts) { super(opts); this.setOutPoint = undefined; }
}

/* ---------- the seam beat's clock ----------

   NEVER let a test wait out a real 2.0 s beat, and never assert on wall clock:
   #195 already cost this repo a flaky suite that went red whenever the box was
   busy, and a transcription run pins this laptop for tens of minutes at a time.
   Both schedulers below are deterministic and complete in zero real time.

   INSTANT is the default for every pre-existing test: the beat is armed, held
   and released exactly as it is in production, just on the next microtask
   instead of in two seconds, so those tests keep asserting on call ORDER and
   are untouched by this feature. `manual` is for the tests that are about the
   beat itself — nothing fires until the test says so, which is the only way to
   observe "the load happened INSIDE the gap" rather than hoping a sleep was
   long enough. */
const INSTANT_SCHEDULER = {
  nowMs: () => 0,
  // queueMicrotask, not a synchronous call: a scheduler that fires inside
  // schedule() is not setTimeout semantics, and it made every pre-existing
  // test blind to the beat's async ordering. This is still zero wall clock.
  schedule: (_ms, fn) => { let dead = false; queueMicrotask(() => { if (!dead) fn(); }); return () => { dead = true; }; },
};

function manualScheduler() {
  let now = 0;
  const pending = [];
  return {
    nowMs: () => now,
    schedule(ms, fn) {
      const entry = { at: now + ms, fn, dead: false };
      pending.push(entry);
      return () => { entry.dead = true; };
    },
    /** Move the clock and run whatever came due. Returns after the callbacks'
        own microtasks have drained, so `await tick()` leaves the player settled. */
    async advance(ms) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.dead || entry.at > now) continue;
        entry.dead = true;
        entry.fn();
      }
      await tick();
    },
    get live() { return pending.filter((e) => !e.dead).length; },
  };
}

/** Drain the microtask queue — the manager awaits its own promises. */
const tick = () => new Promise((r) => setImmediate(r));

function make(opts = {}) {
  __resetInstanceForTests();
  const Backend = opts.backendClass ?? FakeBackend;
  const backend = new Backend(opts.backend);
  const saved = new Map();
  const positionStore = {
    save: (id, seconds) => saved.set(id, { seconds }),
    load: (id) => saved.get(id) ?? null,
  };
  const log = [];
  const scheduler = opts.scheduler ?? INSTANT_SCHEDULER;
  const m = new PlayerQueueManager({
    backend, positionStore, telemetry: (t) => log.push(t), strategy: opts.strategy,
    scheduler, seamGapSec: opts.seamGapSec, onSeamGapChange: opts.onSeamGapChange,
  });
  return { m, backend, saved, log, scheduler };
}

/* ---------- the blocking decision, made pluggable ---------- */

test("SINGLE_ITEM is the default and yields a one-episode queue", () => {
  const { m } = make();
  const q = m.setQueueFromPick(ep("a"), { others: [ep("b"), ep("c")] });
  assert.deepStrictEqual(q.map((i) => i.id), ["a"]);
});

test("PICKED_FIRST puts the pick ahead of the other cards, without duplicating it", () => {
  const { m } = make({ strategy: PICKED_FIRST });
  const q = m.setQueueFromPick(ep("a"), { others: [ep("b"), ep("a"), ep("c")] });
  assert.deepStrictEqual(q.map((i) => i.id), ["a", "b", "c"]);
});

test("CONTINUE_TAIL appends the part-heard item", () => {
  const { m } = make({ strategy: CONTINUE_TAIL });
  const q = m.setQueueFromPick(ep("a"), { continueItem: ep("z") });
  assert.deepStrictEqual(q.map((i) => i.id), ["a", "z"]);
});

test("a malformed strategy is rejected at construction, not at play time", () => {
  __resetInstanceForTests();
  assert.throws(
    () => new PlayerQueueManager({ backend: new FakeBackend(), strategy: { name: "x" } }),
    /queue strategy/
  );
});

/* ---------- single-instance invariant (corner case #19) ---------- */

test("a second manager cannot be constructed while one is alive", () => {
  const { m } = make();
  assert.throws(() => new PlayerQueueManager({ backend: new FakeBackend() }), /already exists/);
  m.dispose();
  // ...and is allowed again once disposed.
  assert.doesNotThrow(() => new PlayerQueueManager({ backend: new FakeBackend() }));
  __resetInstanceForTests();
});

/* ---------- play / end / advance ---------- */

test("play loads then starts, in that order", async () => {
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  assert.deepStrictEqual(backend.calls, ["load:a@0", "rate:1", "play"]);
});

test("the manager adds no macrotask between a settled load and play()", async () => {
  /* Necessary, not sufficient, and the distinction matters: WebKit's user-gesture
     indicator is stack-scoped, so an `await` can lose a gesture with no timer
     involved at all — which is exactly why #225 had to spend the gesture on the
     element in the backend rather than tidy this chain. What this pins is the
     cheaper half: once a load HAS settled, the reducer, the effect loop, the
     rate, the out-point and the beat's zero-length wait all stay inside the task
     that asked. Put one timer in that chain and even a load that resolves
     instantly — the same-source shortcut, which is how a tap gets audio out of an
     element already holding the URL — could not start playback.

     A timer callback stands in for "the task ended". */
  const { m, backend } = make();
  let sameTask = true;
  setTimeout(() => { sameTask = false; }, 0);
  const playedWith = [];
  const realPlay = backend.play.bind(backend);
  backend.play = () => { playedWith.push(sameTask); realPlay(); };

  m.setQueueFromPick(ep("a"));
  await m.play(0);

  assert.deepStrictEqual(playedWith, [true], "a macrotask between the load and play() strands every start");
});

test("SINGLE_ITEM ends the session instead of chaining into another episode", async () => {
  // CLAUDE.md product principle 1: no autoplay chains.
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"), { others: [ep("b")] });
  await m.play(0);
  backend.calls.length = 0;
  await backend.onItemEnded();
  assert.equal(m.state.type, "ended");
  assert.deepStrictEqual(backend.loads(), [], "must not load anything after the single item ends");
});

test("PICKED_FIRST advances to the next episode when one ends", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [ep("b")] });
  await m.play(0);
  backend.calls.length = 0;
  await backend.onItemEnded();
  assert.deepStrictEqual(backend.loads(), ["load:b"]);
});

/* ---------- fast double-skip (corner case #19) ---------- */

test("a fast double-skip loads only the final target", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [ep("b"), ep("c")] });
  await m.play(0);
  backend.calls.length = 0;

  await Promise.all([m.skipToNext(), m.skipToNext()]);

  assert.ok(backend.loads().includes("load:c"), "must reach the final target");
  assert.ok(!backend.calls.includes("play") || backend.loads().length <= 2,
    "must not stack concurrent loads into overlapping playback");
});

/* ---------- bridge TTS (corner case #12) ---------- */

test("an episode followed by a bridge enters transitioning and plays the bridge", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [tts("bridge"), ep("b")] });
  await m.play(0);
  backend.calls.length = 0;

  await backend.onItemEnded();
  assert.equal(m.state.type, "transitioning");
  assert.deepStrictEqual(backend.calls, ["rate:1", "load:bridge@0", "play"]);
});

test("a missing bridge asset never stalls the queue", async () => {
  // Corner case #12's spirit: a missing transition line must not block
  // episode audio.
  const { m, backend } = make({ strategy: PICKED_FIRST, backend: { failLoadFor: ["bridge"] } });
  m.setQueueFromPick(ep("a"), { others: [tts("bridge"), ep("b")] });
  await m.play(0);
  backend.calls.length = 0;

  await backend.onItemEnded();
  assert.ok(backend.loads().includes("load:b"), "must advance past the broken bridge to the real item");
});

test("skipToNext steps over a bridge rather than playing it alone", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [tts("bridge"), ep("b")] });
  await m.play(0);
  backend.calls.length = 0;
  await m.skipToNext();
  assert.deepStrictEqual(backend.loads(), ["load:b"]);
});

/* ---------- interruption (corner case #11) ---------- */

test("an interruption saves position and pauses", async () => {
  const { m, backend, saved } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  backend.currentTime = 42;
  backend.calls.length = 0;

  await m.interruptionBegan();
  assert.ok(backend.calls.includes("pause"));
  assert.equal(saved.get("a").seconds, 42);
});

test("declined call resumes; answered call stays paused but ready", async () => {
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);

  await m.interruptionBegan();
  await m.interruptionEnded(true);
  assert.equal(m.state.type, "playing", "declined -> resumes");

  await m.interruptionBegan();
  await m.interruptionEnded(false);
  assert.equal(m.state.type, "interrupted", "answered -> paused but ready");
  assert.equal(m.state.wasPlaying, false);
});

/* ---------- route policy (corner case #13) ---------- */

test("a route disappearing pauses immediately", async () => {
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  backend.calls.length = 0;
  await m.routeChanged({ oldDeviceUnavailable: true });
  assert.equal(m.state.type, "interrupted");
  assert.ok(backend.calls.includes("pause"));
});

test("auto-resume happens only for a route already known as a car", async () => {
  const { m } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);

  // Unknown route reappearing must NOT start audio unasked.
  await m.routeChanged({ oldDeviceUnavailable: true, routeName: "Some Headphones" });
  await m.routeChanged({ oldDeviceUnavailable: false, routeName: "Some Headphones" });
  assert.equal(m.state.type, "interrupted", "unknown route must not auto-resume");

  // A route we have seen as a car does resume.
  await m.routeChanged({ oldDeviceUnavailable: true, routeName: "Civic", isCarRoute: true });
  await m.routeChanged({ oldDeviceUnavailable: false, routeName: "Civic" });
  assert.equal(m.state.type, "playing", "known car route resumes");
});

/* ---------- cold launch (corner case #15) ---------- */

test("cold launch prepares the asset AT the saved position, never seeking after play", async () => {
  // The offset rides on the load. Seeking afterwards cannot work — on a cold
  // launch the state is `idle` and the reducer rejects a seek there — and it
  // would also let the episode's opening be briefly audible before the jump.
  const { m, backend, saved } = make();
  saved.set("a", { seconds: 1800 });

  await m.restoreColdLaunchState({ items: [ep("a")], index: 0, autoplay: true });

  assert.ok(backend.calls.includes("load:a@1800"), `expected load at 1800, got ${backend.calls}`);
  const loadIdx = backend.calls.findIndex((c) => c.startsWith("load:a@"));
  const playIdx = backend.calls.indexOf("play");
  assert.ok(playIdx >= 0 && loadIdx < playIdx, "load must precede playback");
  assert.ok(!backend.calls.some((c) => c.startsWith("seek:")), "no post-hoc seek");
});

test("a resumed episode reloads at its saved position; a fresh one starts at zero", async () => {
  const { m, backend, saved } = make({ strategy: PICKED_FIRST });
  saved.set("b", { seconds: 900 });
  m.setQueueFromPick(ep("a"), { others: [ep("b")] });
  await m.play(0);
  assert.ok(backend.calls.includes("load:a@0"), "unheard episode starts at zero");
  await m.skipToNext();
  assert.ok(backend.calls.includes("load:b@900"), "part-heard episode resumes");
});

test("a TTS bridge always starts at zero, never resumes", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  // A stale position on a one-line transition would be nonsense.
  m.positionStore.save("bridge", 5);
  m.setQueueFromPick(ep("a"), { others: [tts("bridge"), ep("b")] });
  await m.play(0);
  backend.calls.length = 0;
  await backend.onItemEnded();
  assert.ok(backend.calls.includes("load:bridge@0"));
});

test("cold launch without autoplay restores position without making noise", async () => {
  const { m, backend, saved } = make();
  saved.set("a", { seconds: 600 });
  await m.restoreColdLaunchState({ items: [ep("a")], index: 0, autoplay: false });
  assert.ok(!backend.calls.includes("play"), "restoring must not start audio on its own");
});

/* ---------- effect coverage ---------- */

test("every effect the reducer can emit has a handler", async () => {
  // A silently-ignored effect is a stuck player, which is far harder to
  // diagnose later than a loud throw now.
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [tts("bridge"), ep("b")] });
  await assert.doesNotReject(async () => {
    await m.play(0);
    await m.seek(30, { precise: true });
    await m.pause();
    await m.interruptionEnded(true);
    await m.skipToNext();
    await m.skipToPrevious();
    await backend.onItemEnded();
    await m.stop();
  });
});

test("an unknown ref surfaces as an error rather than hanging", async () => {
  const { m } = make();
  m.loadQueue([ep("a")]);
  m.currentIndex = 0;
  await m._handle({ type: "play", item: { id: "ghost", kind: "episode" } });
  assert.equal(m.state.type, "idle", "error path drops to idle");
});

/* ---------- timer ---------- */

test("the position timer runs only while playing", async () => {
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  assert.ok(m._timer, "timer should run while playing");
  await m.pause();
  assert.equal(m._timer, null, "timer must stop when not playing");
  m.dispose();
});

/* ---------- regressions found while building #33 ---------- */

test("skipToPrevious restarts at zero, not at the playhead just saved", async () => {
  // The reducer's skip emits savePosition BEFORE loadItem. Without an explicit
  // override the reload reads back the position that save just wrote, and
  // "restart" silently resumes to the exact spot the user asked to leave.
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  backend.currentTime = 1234;
  backend.calls.length = 0;

  await m.skipToPrevious();
  assert.ok(backend.calls.includes("load:a@0"), `expected restart at 0, got ${backend.calls}`);
});

test("a skip saves the OUTGOING episode's position, never the incoming one's", async () => {
  // The bug this whole index split exists to prevent — and the one
  // PlayerQueueManager.swift still has.
  const { m, backend, saved } = make({ strategy: PICKED_FIRST });
  saved.set("b", { seconds: 900 });
  m.setQueueFromPick(ep("a"), { others: [ep("b")] });
  await m.play(0);
  backend.currentTime = 77;

  await m.skipToNext();
  assert.equal(saved.get("a").seconds, 77, "outgoing episode keeps its playhead");
  assert.equal(saved.get("b").seconds, 900, "incoming episode's resume point survives");
});

test("a fast double-skip advances two items, not one", async () => {
  const { m, backend } = make({ strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [ep("b"), ep("c")] });
  await m.play(0);
  backend.calls.length = 0;

  await m.skipToNext();
  await m.skipToNext();
  assert.equal(m._currentItem().id, "c", "two skips must land two items along");
});

/* ---------- Forays: in-point, out-point, and the ADR-0007 ladder (#111) ----

   A Foray is an ordered list of [start_sec, end_sec] slices, usually of a
   different episode each time. The manager's share of that is the in-point,
   the load-time ladder, and interpreting `setOutPoint`; the boundary itself is
   the backend's job and is tested there. */

const CATALOGUE = {
  "ep-static": {
    id: "ep-static", audio_url: "https://cdn.example/static.mp3",
    dai_suspected: false, duration_sec: 3600, title: "Static", show: "Indie",
  },
  "ep-other": {
    id: "ep-other", audio_url: "https://cdn.example/other.mp3",
    dai_suspected: false, duration_sec: 3600, title: "Other", show: "Indie",
  },
  "ep-dai": {
    id: "ep-dai", audio_url: "https://cdn.example/dai.mp3",
    dai_suspected: true, duration_sec: 2501, title: "Stitched", show: "Big",
  },
};
const resolveItem = (id) => CATALOGUE[id] ?? null;
const fseg = (extra = {}) => ({
  type: "segment", item_id: "ep-static", start_sec: 100, end_sec: 210,
  why: "he explains it plainly", ...extra,
});
const fdai = (extra = {}) => fseg({
  item_id: "ep-dai", start_anchor: "so the thing about fire",
  end_anchor: "and that is why it stuck", reference_duration_sec: 2501, ...extra,
});
const foray = (items) => ({ id: "foray-1", title: "Fire", items });

/* ---------- the in-point ---------- */

test("a segment loads at its start_sec, not at a saved position for that episode", async () => {
  // #65 §4. Resuming a segment to where the listener last left the episode
  // drops them outside the segment entirely — usually into another story.
  const { m, backend, saved } = make();
  saved.set("ep-static", { seconds: 1800 });
  saved.set("foray-1#0", { seconds: 1800 });
  await m.playForay(foray([fseg({ start_sec: 640, end_sec: 750 })]), { resolveItem });
  assert.ok(backend.calls.includes("load:foray-1#0@640"), `got ${backend.calls}`);
});

test("the out-point is armed on the backend after the load, before playback", async () => {
  const { m, backend } = make();
  await m.playForay(foray([fseg()]), { resolveItem });
  const order = backend.calls;
  assert.ok(order.includes("outPoint:210"), `got ${order}`);
  assert.ok(order.indexOf("load:foray-1#0@100") < order.indexOf("outPoint:210"));
  assert.ok(order.indexOf("outPoint:210") < order.indexOf("play"), "armed before anything is audible");
});

test("a whole episode arms nothing — out-points cost episodes nothing", async () => {
  const { m, backend } = make();
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  assert.ok(!backend.calls.some((c) => c.startsWith("outPoint:")));
});

/* ---------- the out-point, seen from the manager ---------- */

test("reaching an out-point advances exactly like the file running out", async () => {
  const { m, backend } = make();
  await m.playForay(foray([fseg(), fseg({ item_id: "ep-other", start_sec: 20, end_sec: 90 })]), { resolveItem });
  backend.calls.length = 0;

  await backend.onItemEnded("outPoint");
  assert.equal(m.state.type, "playing");
  assert.equal(m._currentItem().id, "foray-1#1");
  assert.ok(backend.calls.includes("load:foray-1#1@20"), `got ${backend.calls}`);
  assert.ok(backend.calls.includes("outPoint:90"), "the next slice arms its own boundary");
});

test("an out-point end and a natural end produce identical backend calls", async () => {
  // The property the whole design rests on: reusing `itemEnded` means nothing
  // downstream can behave differently. Asserted where it can actually fail —
  // the reducer has no reason field to branch on (its own suite covers that),
  // so the only place a divergence could hide is here.
  const run = async (reason) => {
    const { m, backend } = make();
    await m.playForay(foray([fseg(), fseg({ item_id: "ep-other", start_sec: 20, end_sec: 90 })]), { resolveItem });
    backend.calls.length = 0;
    await backend.onItemEnded(reason);
    return { calls: backend.calls.slice(), state: m.state.type, at: m._currentItem().id };
  };
  const outPoint = await run("outPoint");
  const natural = await run("natural");
  assert.deepStrictEqual(outPoint.calls, natural.calls);
  assert.equal(outPoint.state, natural.state);
  assert.equal(outPoint.at, natural.at);
});

test("an out-point on the last segment ends the session, with no chaining", async () => {
  const { m, backend, log } = make();
  await m.playForay(foray([fseg()]), { resolveItem });
  backend.calls.length = 0;
  await backend.onItemEnded("outPoint");
  assert.equal(m.state.type, "ended");
  assert.deepStrictEqual(backend.loads(), []);
  assert.ok(log.some((t) => /item\.ended\.outPoint/.test(t)), "and it is observable");
});

test("back-to-back segments of ONE episode both play, at their own in-points", async () => {
  // The case an id-keyed queue gets wrong: both entries resolve to the same
  // episode, so a lookup by episode id would replay segment 1 forever.
  const { m, backend } = make();
  await m.playForay(foray([
    fseg({ start_sec: 100, end_sec: 210 }),
    fseg({ start_sec: 210, end_sec: 330 }),
  ]), { resolveItem });
  await backend.onItemEnded("outPoint");

  assert.equal(m._currentItem().id, "foray-1#1");
  assert.ok(backend.calls.includes("load:foray-1#1@210"), `got ${backend.calls}`);
  assert.ok(backend.calls.includes("outPoint:330"));
});

test("pausing inside a segment and resuming does not replay the segment", async () => {
  // Every resume path routes back through loadItem, so a flat "segments always
  // load at start_sec" would replay the whole slice after a phone call.
  const { m, backend } = make();
  await m.playForay(foray([fseg({ start_sec: 100, end_sec: 210 })]), { resolveItem });
  backend.currentTime = 172;
  await m.pause();
  backend.calls.length = 0;

  await m.resume();
  assert.equal(m.state.type, "playing");
  assert.ok(backend.calls.includes("load:foray-1#0@172"), `expected a resume at 172, got ${backend.calls}`);
  assert.ok(backend.calls.includes("outPoint:210"), "and the boundary is re-armed");
});

test("a resume from OUTSIDE the slice still lands on the in-point", async () => {
  // The playhead is only a resume point while it is inside this item's own
  // slice; anywhere else it belongs to something the listener already left.
  const { m, backend } = make();
  await m.playForay(foray([fseg({ start_sec: 100, end_sec: 210 })]), { resolveItem });
  backend.currentTime = 2400;
  await m.pause();
  backend.calls.length = 0;
  await m.resume();
  assert.ok(backend.calls.includes("load:foray-1#0@100"), `got ${backend.calls}`);
});

test("skipToPrevious restarts a segment at its in-point, not at 0:00 of the episode", async () => {
  const { m, backend } = make();
  await m.playForay(foray([fseg({ start_sec: 640, end_sec: 750 })]), { resolveItem });
  backend.currentTime = 700;
  backend.calls.length = 0;
  await m.skipToPrevious();
  assert.ok(backend.calls.includes("load:foray-1#0@640"), `got ${backend.calls}`);
});

test("going back to an earlier segment re-seeks and re-arms", async () => {
  const { m, backend } = make();
  await m.playForay(foray([
    fseg({ start_sec: 100, end_sec: 210 }),
    fseg({ item_id: "ep-other", start_sec: 20, end_sec: 90 }),
  ]), { resolveItem });
  await backend.onItemEnded("outPoint");
  backend.calls.length = 0;

  await m.play(0);
  assert.equal(m._currentItem().id, "foray-1#0");
  assert.ok(backend.calls.includes("load:foray-1#0@100"));
  assert.ok(backend.calls.includes("outPoint:210"));
});

test("no resume position is stored for a segment", async () => {
  // 110 seconds long, synthetic id, and the in-point overrides it anyway —
  // storing one is localStorage litter plus a cp_events row per segment.
  const { m, backend, saved } = make();
  await m.playForay(foray([fseg(), fseg({ item_id: "ep-other" })]), { resolveItem });
  backend.currentTime = 150;
  await m.skipToNext();
  assert.equal(saved.get("foray-1#0"), undefined);
  assert.equal(saved.get("ep-static"), undefined);
});

/* ---------- narration ---------- */

test("narration between segments plays as an ordinary TTS item at 1.0x", async () => {
  const { m, backend } = make();
  await m.playForay(foray([
    { type: "narration", id: "nar-1", asset: "narration/fire-1.mp3" },
    fseg(),
  ]), { resolveItem });
  assert.ok(backend.calls.includes("load:nar-1@0"));
  assert.ok(backend.calls.includes("rate:1"));
  assert.ok(!backend.calls.some((c) => c.startsWith("outPoint:")), "narration has no out-point");
});

/* ---------- the listener's speed (§12) ----------

   Every test here would have passed before this feature existed, for the wrong
   reason: `restoreRate` emitted `setRate(1.0)` unconditionally, and `1.0` is
   also the right answer when nobody has changed the speed. So each one below
   sets a NON-1 rate, which is the only way to tell "restored the listener's
   choice" apart from "reset to normal".

   THE MUTATION THAT KILLS THIS WHOLE SECTION is one line: put `restoreRate`
   back to `this.backend.setRate(item?.rate ?? 1.0)`. Six of these go red, and
   `seg`/`ep`/`fseg` all carry a vestigial `rate: 1.0`, so demoting it to
   `item?.rate ?? this._rate` reddens them too. */

test("a speed set before play applies to the very first segment, not 1x", async () => {
  // The stored-rate path: `client.js` calls `setRate` once at boot from `cp_rate`,
  // before anything is loaded. If the first `itemLoaded` overrides it, a listener
  // who chose 1.5x last week starts every session at 1x.
  const { m, backend } = make();
  m.setRate(1.5);
  await m.playForay(foray([fseg()]), { resolveItem });
  assert.deepStrictEqual(backend.calls, [
    "rate:1.5",            // setRate, applied immediately
    "load:foray-1#0@100",
    "rate:1.5",            // restoreRate on itemLoaded — the listener's, not 1.0
    "outPoint:210",
    "play",
  ]);
});

test("the speed survives a cross-episode seam, which is where it used to be lost", async () => {
  /* THE TRAP THIS FEATURE IS ABOUT. `playbackRate` resets to 1 when a media
     element loads a new source, and a Foray changes source at a seam — so the
     naive version works until the first seam and then silently drops to 1x
     mid-listen. Here the reset was OURS and arrived even earlier than the
     engine's.

     Three different episodes, so all three loads are real cross-episode loads. */
  const { m, backend } = make();
  m.loadQueue(THREE.map((s) => ({ ...s })));
  m.setRate(1.75);
  await m.play(0);
  await m.skipToNext();
  await m.skipToNext();

  const rates = backend.calls.filter((c) => c.startsWith("rate:"));
  assert.deepStrictEqual(
    rates, ["rate:1.75", "rate:1.75", "rate:1.75", "rate:1.75"],
    "one for the set and one per load — and never a 1 among them"
  );
  assert.equal(m.rate, 1.75);
});

test("a speed changed mid-Foray holds for every segment after it", async () => {
  // The other half: not "the stored value applies" but "a change while listening
  // is not undone by the next boundary". Before this, a tap survived exactly one
  // segment — a median 103 s — and then reverted with nothing on screen to say so.
  const { m, backend } = make();
  m.loadQueue(THREE.map((s) => ({ ...s })));
  await m.play(0);
  assert.ok(backend.calls.includes("rate:1"), "starts at normal speed");

  m.setRate(2);
  await m.skipToNext();
  await m.skipToNext();

  const after = backend.calls.slice(backend.calls.indexOf("rate:2"));
  assert.deepStrictEqual(
    after.filter((c) => c.startsWith("rate:")), ["rate:2", "rate:2", "rate:2"],
    "the change, then one restore per remaining load"
  );
});

/** A Foray whose middle item is a narration bridge, which is the only shape that
    reaches the reducer's `transitioning` state. A narration item at index 0 is
    loaded as an ordinary item instead (`play(0)` -> `loadingItem` -> `playing`),
    so it exercises `resetRateForTTS` but not the bridge path — the first draft of
    these two tests used that shape and asserted against the wrong one. */
const BRIDGED = () => foray([
  fseg(),
  { type: "narration", id: "nar-1", asset: "narration/fire-1.mp3" },
  fseg({ start_sec: 400, end_sec: 500 }),
]);

test("narration still plays at 1.0x, and the listener's speed comes back after it", async () => {
  /* Corner case #18, which the new ownership must not weaken: a bridge is one
     line of our own narration at a level and a pace we chose, and playing it at
     2x is not a feature. `resetRateForTTS` is deliberately the literal 1.0 rather
     than a consultation of `this._rate`. */
  const { m, backend } = make();
  m.setRate(2);
  await m.playForay(BRIDGED(), { resolveItem });
  await m._handleBackendItemEnded(END_OUT_POINT);   // segment 1 ends, the bridge starts
  assert.equal(m.state.type, "transitioning", "the bridge is what is audible");
  await m._handleBackendItemEnded();               // the line finishes

  assert.deepStrictEqual(
    backend.calls.filter((c) => c.startsWith("rate:")),
    ["rate:2", "rate:2", "rate:1", "rate:2", "rate:2"],
    "set, first segment, the bridge forced to normal, then the listener's speed back — twice, " +
    "because `itemEnded` in `transitioning` restores it before the load and `itemLoaded` again after"
  );
  assert.ok(
    backend.calls.indexOf("rate:1") < backend.calls.indexOf("load:nar-1@0"),
    "and forced BEFORE the narration is audible, not after"
  );
});

test("a tap during narration is deferred, not lost, and lands when the line ends", async () => {
  /* The one case the ownership adds. Without the guard, corner case #18 would
     hold for every path except a listener touching the control at the wrong
     moment — which is exactly when a guarantee stops being one. Deferred, not
     ignored: the value is theirs from the next segment on.

     MUTATION THAT KILLS THIS: delete the `_narrationIsAudible()` branch in
     `setRate`. `rate:1.5` then reaches the element mid-line and the middle
     assertion fails. */
  const { m, backend, log } = make();
  await m.playForay(BRIDGED(), { resolveItem });
  await m._handleBackendItemEnded(END_OUT_POINT);
  assert.equal(m.state.type, "transitioning", "the bridge is what is audible");

  const before = backend.calls.length;
  assert.equal(m.setRate(1.5), 1.5, "the value is accepted and remembered");
  assert.deepStrictEqual(
    backend.calls.slice(before), [],
    "but nothing reaches the element while our own narration is sounding"
  );
  assert.ok(log.some((t) => /rate\.deferred=1\.5/.test(t)), "and it says so");
  assert.equal(m.rate, 1.5, "the control's label is already theirs, even though the audio is not");

  await m._handleBackendItemEnded();
  assert.ok(backend.calls.includes("rate:1.5"), "the deferred speed lands on the segment after the line");
});

test("setRate snaps a junk or off-ladder value instead of handing it to the element", () => {
  /* `playbackRate = 0` pauses an element with no `pause` event, a negative one
     throws in some engines, and `NaN` throws in all of them — and this method is
     reachable from a console and from a hand-edited `cp_rate`. The ladder is the
     allowlist; `playback-rate.js` owns the snapping. */
  const { m, backend } = make();
  for (const bad of [0, -1, NaN, Infinity, null, undefined, "1.5", {}]) {
    assert.equal(m.setRate(bad), 1, `${String(bad)} must fall back to normal speed`);
  }
  assert.equal(m.setRate(1.6), 1.5, "and an off-ladder number snaps to the nearest stop");
  assert.equal(m.setRate(9), 2, "while one past the top clamps rather than resetting to 1x");
  assert.ok(
    backend.calls.every((c) => !c.startsWith("rate:") || /^rate:(1|1\.5|2)$/.test(c)),
    `the element only ever saw ladder values: ${backend.calls}`
  );
});

test("changing speed does NOT cut a running seam beat", async () => {
  /* Every transport method cuts the beat, because the beat marks an edit the
     listener did not ask for and touching the transport means they have named a
     destination. Changing speed names no destination — it is a preference about
     how the rest of the hour sounds — so routing `setRate` through `_transport`
     would swallow the authored 2.0 s for a tap that was not about going
     anywhere, and start the next segment early.

     MUTATION THAT KILLS THIS: wrap `setRate`'s body in
     `this._transport("rate", ...)`. The beat is cut and both assertions fail. */
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler });
  m.loadQueue(THREE.map((s) => ({ ...s })));
  await m.play(0);

  const ended = m._handleBackendItemEnded(END_OUT_POINT);
  await tick();
  assert.equal(m.inSeamGap, true, "the beat is running");

  m.setRate(1.25);
  assert.equal(m.inSeamGap, true, "and a speed change must leave it running");
  assert.equal(m.seamGapRemainingMs, 2000, "with its full remainder still owed");

  await scheduler.advance(2000);
  await ended;
  assert.equal(m.currentIndex, 1, "the beat was spent, then the next segment started");
  assert.ok(backend.calls.includes("rate:1.25"), "at the speed the listener chose mid-beat");
});

test("the rate getter reports the CHOSEN speed, which is what a label is painted from", () => {
  // Never the element's live `playbackRate`: a load assigns `src` and resets it to
  // 1 for the moment before `restoreRate` runs, so a label painted from the
  // element would flicker to "1×" at every seam.
  const { m } = make();
  assert.equal(m.rate, 1, "normal speed until someone says otherwise");
  m.setRate(1.25);
  assert.equal(m.rate, 1.25);
});

/* ---------- the ADR-0007 ladder, at load ---------- */

test("a DAI segment plays when the copy in hand matches the reference duration", async () => {
  // Rung 3: the ad load happens to match, so the timestamp cache is live.
  const { m, backend, log } = make({ backend: { durationById: { "foray-1#0": 2510 } } });
  await m.playForay(foray([fdai()]), { resolveItem });
  assert.equal(m.state.type, "playing");
  assert.ok(backend.calls.includes("outPoint:210"));
  assert.ok(log.some((t) => /exact — ad load matches the reference copy/.test(t)));
});

test("a DAI segment whose copy has drifted is skipped, and says so", async () => {
  // #111's acceptance criterion: never played at the stale offset, and logged.
  const { m, backend, log } = make({ backend: { durationById: { "foray-1#0": 2700 } } });
  await m.playForay(foray([fdai(), fseg({ item_id: "ep-other", start_sec: 20, end_sec: 90 })]), { resolveItem });

  assert.equal(m._currentItem().id, "foray-1#1", "advanced to the next segment");
  assert.ok(!backend.calls.includes("outPoint:210"), "the drifted segment never became audible");
  assert.ok(log.some((t) => /foray\.segment\.skipped\.atLoad foray-1#0/.test(t)));
  assert.ok(log.some((t) => /not implemented/.test(t)), "and names the rung that would have saved it");
});

test("a Foray whose every segment fails the ladder ends instead of looping", async () => {
  const { m, log } = make({ backend: { durationById: { "foray-1#0": 2700, "foray-1#1": 2700 } } });
  await m.playForay(foray([fdai(), fdai({ start_sec: 400, end_sec: 500 })]), { resolveItem });
  assert.equal(m.state.type, "ended");
  assert.equal(log.filter((t) => /skipped\.atLoad/.test(t)).length, 2);
});

test("a copy that reports no duration at all is skipped, not guessed at", async () => {
  // Live streams and some CDNs report NaN. "Unknown" is not "matches".
  const { m, backend, log } = make();
  backend.duration = NaN;
  await m.playForay(foray([fdai()]), { resolveItem });
  assert.equal(m.state.type, "ended");
  assert.ok(log.some((t) => /reports no duration/.test(t)));
});

/* ---------- refusals that must be loud ---------- */

test("a backend with no out-point watch refuses the Foray instead of playing whole episodes", async () => {
  const { m } = make({ backendClass: OutPointBlindBackend });
  assert.throws(
    () => m.setQueueFromForay(foray([fseg()]), { resolveItem }),
    /no setOutPoint/
  );
});

test("an unbounded queue still works on a backend with no out-point watch", async () => {
  const { m, backend } = make({ backendClass: OutPointBlindBackend });
  m.setQueueFromPick(ep("a"));
  await m.play(0);
  assert.equal(m.state.type, "playing");
  assert.ok(backend.calls.includes("play"));
});

test("a bounded item reaching a blind backend by any other route refuses too", async () => {
  // setQueueFromForay's throw is bypassed by loadQueue() and by
  // restoreColdLaunchState() — a cold-launch restore of a Foray is exactly that
  // path. A `_perform` case that only logs would emit the warning and then let
  // `startPlayback` run anyway, which is the outcome the warning claims to
  // prevent, so the refusal has to throw.
  const { m, backend } = make({ backendClass: OutPointBlindBackend });
  m.loadQueue([{ id: "f#0", kind: "episode", audio_url: "x", start_sec: 100, end_sec: 210 }]);
  await m.play(0);
  assert.equal(m.state.type, "idle", "must degrade, not play");
  assert.ok(!backend.calls.includes("play"), `must never start audio it cannot stop: ${backend.calls}`);
});

test("cold-launch restore of a Foray on a blind backend makes no sound either", async () => {
  const { m, backend } = make({ backendClass: OutPointBlindBackend });
  await m.restoreColdLaunchState({
    items: [{ id: "f#0", kind: "episode", audio_url: "x", start_sec: 100, end_sec: 210 }],
    index: 0, autoplay: true,
  });
  assert.ok(!backend.calls.includes("play"));
});

test("an item with a start but nothing to stop at is not a segment", async () => {
  // One definition of bounded, so this takes the ordinary saved-position path
  // rather than silently losing its resume point to a half-formed in-point.
  const { m, backend, saved } = make();
  saved.set("a", { seconds: 1800 });
  m.loadQueue([{ id: "a", kind: "episode", audio_url: "x", start_sec: 640 }]);
  await m.play(0);
  assert.ok(backend.calls.includes("load:a@1800"), `got ${backend.calls}`);
  assert.ok(!backend.calls.some((c) => c.startsWith("outPoint:")));
});

/* ---------- reporting ---------- */

test("playForay reports what it dropped, and why, rather than quietly shortening", async () => {
  const { m, log } = make();
  const report = await m.playForay(foray([
    fseg(),
    fdai({ start_anchor: "" }),          // DAI without anchors — ADR-0007
    fseg({ item_id: "ghost" }),          // unresolvable
  ]), { resolveItem });

  assert.equal(report.items.length, 1);
  assert.equal(report.skipped.length, 2);
  assert.deepStrictEqual(report.skipped.map((s) => s.index), [1, 2]);
  assert.ok(log.some((t) => /foray\.segment\.skipped\[1\].*anchors/.test(t)));
  assert.ok(log.some((t) => /queue\.foray\.foray-1\.n=1\.skipped=2/.test(t)));
});

test("a Foray with nothing playable makes no noise", async () => {
  const { m, backend, log } = make();
  const report = await m.playForay(foray([fseg({ item_id: "ghost" })]), { resolveItem });
  assert.equal(report.items.length, 0);
  assert.ok(!backend.calls.includes("play"));
  assert.ok(log.some((t) => /empty — every item was skipped/.test(t)));
});

/* ---------- the seam beat (docs/curation/segment-length-rules.md §6b) -------

   Foray #1 carries no narration, so all 31 of its transitions are unbridged
   and each one gets 2.0 s of silence. Every test below drives the beat's clock
   by hand (`manualScheduler`) — there is no sleeping here and no assertion on
   elapsed wall clock, deliberately: #195 already de-flaked this suite once and
   a transcription queue is on this box.

   `seam()` starts a two-segment Foray of DIFFERENT episodes and stops the first
   at its out-point WITHOUT waiting for the beat, so each test can look inside
   the gap before letting it finish. */

const plays = (backend) => backend.calls.filter((c) => c === "play").length;

async function seam(opts = {}) {
  const scheduler = manualScheduler();
  const h = make({ ...opts, scheduler });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  // NOT awaited: the beat is still running when this returns, which is the
  // whole point. `settled` is the promise the out-point path eventually keeps.
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  return { ...h, scheduler, settled };
}

test("an unbridged segment-to-segment seam holds 2.0 s before the next segment is audible", async () => {
  const { m, backend, scheduler, settled } = await seam();
  assert.equal(m.inSeamGap, true, "a beat should be running");
  assert.equal(m.seamGapRemainingMs, 2000);
  assert.equal(plays(backend), 1, "the second segment must not be audible yet");

  await scheduler.advance(1999);
  assert.equal(plays(backend), 1, "still inside the beat");

  await scheduler.advance(1);
  await settled;
  assert.equal(plays(backend), 2, "the beat is over, segment 2 starts");
  assert.equal(m.inSeamGap, false);
  assert.equal(m.seamGapRemainingMs, 0);
});

test("THE GAP ABSORBS THE LOAD: the next segment is fetched and positioned inside the beat", async () => {
  // The difference between a graceful beat and a stall. Invert this ordering
  // and the listener waits `gap + load` instead of `max(gap, load)`.
  const { backend, scheduler, settled } = await seam();
  assert.ok(backend.loads().includes("load:foray-1#1"), `not loaded yet: ${backend.calls}`);
  assert.ok(backend.calls.includes("load:foray-1#1@400"), "and positioned at its in-point");
  assert.equal(plays(backend), 1, "loaded, positioned, and still silent");
  await scheduler.advance(2000);
  await settled;
  assert.equal(plays(backend), 2);
});

test("a load slower than the beat costs max(gap, load), never gap + load", async () => {
  const scheduler = manualScheduler();
  let release;
  const held = new Promise((r) => { release = r; });
  class SlowLoad extends FakeBackend {
    async load(item, opts) {
      await super.load(item, opts);
      if (item.id === "foray-1#1") await held;
    }
  }
  __resetInstanceForTests();
  const backend = new SlowLoad();
  const m = new PlayerQueueManager({ backend, scheduler });
  await m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  backend.currentTime = 210;
  const settled = backend.onItemEnded("outPoint");
  await tick();

  // Three seconds of load against a two-second beat. The beat is already spent
  // by the time the bytes land, so nothing may be added on top of the load.
  await scheduler.advance(3000);
  assert.equal(plays(backend), 1, "still loading");
  release();
  await settled;
  assert.equal(plays(backend), 2, "plays the instant the bytes land — no residual wait");
  assert.equal(scheduler.live, 0, "no beat timer was ever needed");
  m.dispose();
  __resetInstanceForTests();
});

test("the out-point still stops the outgoing segment first; the beat is silence, not overlap", async () => {
  const { backend, scheduler, settled } = await seam();
  assert.equal(plays(backend), 1);
  await scheduler.advance(2000);
  await settled;
  const order = backend.calls;
  assert.ok(order.lastIndexOf("load:foray-1#1@400") < order.lastIndexOf("play"));
  assert.ok(order.lastIndexOf("outPoint:500") < order.lastIndexOf("play"), "armed before audible");
});

test("no beat before the FIRST segment — pressing play must be instant", async () => {
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler });
  await m.playForay(foray([fseg()]), { resolveItem });
  assert.equal(plays(backend), 1);
  assert.equal(m.inSeamGap, false);
  assert.equal(scheduler.live, 0);
});

test("no beat after the LAST segment — the Foray just ends", async () => {
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler });
  await m.playForay(foray([fseg()]), { resolveItem });
  backend.currentTime = 210;
  await backend.onItemEnded("outPoint");
  assert.equal(m.state.type, "ended");
  assert.equal(m.inSeamGap, false);
  assert.equal(scheduler.live, 0);
});

test("a bridged seam gets no beat — the narration is the marker", async () => {
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler });
  m.loadQueue([
    { id: "s1", kind: "episode", audio_url: "x", start_sec: 10, end_sec: 20 },
    tts("bridge"),
    { id: "s2", kind: "episode", audio_url: "y", start_sec: 30, end_sec: 40 },
  ]);
  await m.play(0);
  backend.currentTime = 20;
  await backend.onItemEnded("outPoint");
  assert.equal(m.state.type, "transitioning");
  assert.equal(m.inSeamGap, false, "silence on top of narration is dead air");
  assert.equal(scheduler.live, 0);
});

test("no beat between two ordinary episodes — a full episode ending is not an edit we made", async () => {
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler, strategy: PICKED_FIRST });
  m.setQueueFromPick(ep("a"), { others: [ep("b")] });
  await m.play(0);
  await backend.onItemEnded();
  assert.equal(m.inSeamGap, false);
  assert.equal(plays(backend), 2);
});

/* ---------- what the transport does DURING a beat ---------- */

test("PAUSE during a beat: the beat ends and nothing becomes audible", async () => {
  const { m, backend, scheduler, settled } = await seam();
  await m.pause();
  await settled;
  assert.equal(m.state.type, "interrupted");
  assert.equal(plays(backend), 1, "pause must not be overtaken by the beat's own timer");
  assert.equal(m.inSeamGap, false);
  assert.equal(scheduler.live, 0, "no timer left to start audio into a paused player");

  // Letting the clock run past where the beat would have ended changes nothing
  // — the classic "it started playing two seconds after I paused" bug.
  await scheduler.advance(5000);
  assert.equal(plays(backend), 1);
});

test("resuming after a pause inside a beat is instant — the beat is not re-served", async () => {
  const { m, backend, scheduler, settled } = await seam();
  await m.pause();
  await settled;
  await m.resume();
  assert.equal(plays(backend), 2, "audio on the gesture, no fresh 2 s wait");
  assert.equal(scheduler.live, 0);
  // The resume lands back at the segment's in-point, not at 0:00 of the episode.
  assert.ok(backend.calls.includes("load:foray-1#1@400"), `got ${backend.calls}`);
});

test("SKIP during a beat: straight on, no beat, and the abandoned load stays silent", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler });
  await h.m.playForay(foray([
    fseg(),
    fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 }),
    fseg({ item_id: "ep-other", start_sec: 700, end_sec: 800 }),
  ]), { resolveItem });
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  assert.equal(h.m.inSeamGap, true);

  await h.m.skipToNext();
  await settled;
  assert.equal(h.m.inSeamGap, false, "a skip is a destination, not an edit to mark");
  assert.equal(plays(h.backend), 2, "exactly one new start — the superseded load must not also play");
  assert.ok(h.backend.calls.includes("load:foray-1#2@700"), `got ${h.backend.calls}`);
  assert.equal(scheduler.live, 0);

  // Nothing left to fire, so time passing cannot start the segment we skipped.
  await scheduler.advance(5000);
  assert.equal(plays(h.backend), 2);
});

test("SCRUB during a beat: the beat ends early and playback starts at the scrubbed point", async () => {
  const { m, backend, scheduler, settled } = await seam();
  await m.seek(450, { precise: true });
  await settled;
  assert.equal(plays(backend), 2, "the listener grabbed the transport; give them audio");
  const order = backend.calls;
  assert.ok(order.includes("seek:450"), `got ${order}`);
  assert.ok(order.lastIndexOf("seek:450") < order.lastIndexOf("play"), "the seek lands before it is audible");
  assert.equal(scheduler.live, 0);
});

test("stopping during a beat leaves nothing armed and nothing audible", async () => {
  const { m, backend, scheduler, settled } = await seam();
  await m.stop();
  await settled;
  assert.equal(m.state.type, "idle");
  assert.equal(plays(backend), 1);
  await scheduler.advance(5000);
  assert.equal(plays(backend), 1);
});

test("losing the output device during a beat cancels it rather than playing into a dead route", async () => {
  const { m, backend, scheduler, settled } = await seam();
  await m.routeChanged({ oldDeviceUnavailable: true });
  await settled;
  assert.equal(plays(backend), 1);
  await scheduler.advance(5000);
  assert.equal(plays(backend), 1);
});

/* ---------- the beat versus the other failure paths ---------- */

test("a segment the ADR-0007 ladder refuses consumes the remaining beat, it does not restart it", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, backend: { durationById: { "foray-1#1": 4000 } } });
  await h.m.playForay(foray([
    fseg(),
    fdai({ start_sec: 400, end_sec: 500 }),          // fails the drift rung at load
    fseg({ item_id: "ep-other", start_sec: 700, end_sec: 800 }),
  ]), { resolveItem });
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();

  // The refused segment was loaded and rejected inside the beat; the third is
  // now loading against the SAME deadline, not a second one.
  assert.ok(h.log.some((t) => /skipped\.atLoad/.test(t)), `ladder did not fire: ${h.log}`);
  assert.equal(h.m.seamGapRemainingMs, 2000, "one deadline, not two");
  await scheduler.advance(2000);
  await settled;
  assert.equal(plays(h.backend), 2);
  assert.ok(h.backend.calls.includes("load:foray-1#2@700"), `got ${h.backend.calls}`);
});

test("a load that FAILS at a seam reports immediately — an error must not wait out the beat", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, backend: { failLoadFor: ["foray-1#1"] } });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  await h.backend.onItemEnded("outPoint");   // resolves without advancing the clock
  assert.equal(h.m.state.type, "idle");
  assert.ok(h.log.some((t) => /player\.error/.test(t)), `got ${h.log}`);
  assert.equal(scheduler.live, 0);
});

/* ---------- supersession: the bug a synchronous fake cannot show ----------

   `FakeBackend.load` resolves synchronously. Every test above is therefore
   blind to WHEN the "am I still the current load?" comparison happens, because
   with an instant load the replacement is already in place by the time a stale
   wait resumes and the stale `itemLoaded` looks harmless.

   It is not harmless. Against a load that takes any real time, a stale wait
   that resolves at CUT time arms an out-point which the replacement `load()`
   then clears (backend contract), and the replacement's own `itemLoaded` is
   ignored because the state has already moved to `playing` — leaving a segment
   with NO boundary, playing to the end of somebody's whole two-hour episode.
   That is the outcome `_perform`'s setOutPoint refusal calls worse than not
   playing at all. These tests exist to keep that fixed. */

/** Any real network load: resolves a few microtask turns later. */
class AsyncLoadBackend extends FakeBackend {
  constructor(opts = {}) { super(opts); this.turns = opts.turns ?? 3; }
  async load(item, o) {
    for (let i = 0; i < this.turns; i++) await Promise.resolve();
    return super.load(item, o);
  }
}

/** A two-segment Foray, stopped at the first out-point, beat still running,
    against a backend whose loads take time. */
async function slowSeam(extra = {}) {
  const scheduler = manualScheduler();
  const h = make({ scheduler, backendClass: AsyncLoadBackend, backend: { turns: 3 }, ...extra });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  assert.equal(h.m.inSeamGap, true, "the beat should be running before the test acts");
  return { ...h, scheduler, settled };
}

const lastPlayIsAfterLastLoad = (backend) => {
  const calls = backend.calls;
  const lastLoad = calls.map((c) => c.startsWith("load:")).lastIndexOf(true);
  return calls.lastIndexOf("play") > lastLoad;
};

test("skipToPrevious during a beat leaves the out-point ARMED", async () => {
  const { m, backend, settled } = await slowSeam();
  await m.skipToPrevious();
  await settled;
  assert.notEqual(backend.outPoint, null, "no boundary: this segment would play to the end of its episode");
  assert.equal(backend.outPoint, 500);
  assert.ok(lastPlayIsAfterLastLoad(backend), `played before the bytes landed: ${backend.calls}`);
});

test("play() during a beat leaves the out-point ARMED", async () => {
  // The UI-reachable one: #fy-prev inside a fresh segment, a running-order row,
  // and a strip scrub all reach manager.play().
  const { m, backend, settled } = await slowSeam();
  await m.play(0);
  await settled;
  assert.notEqual(backend.outPoint, null);
  assert.equal(backend.outPoint, 210, "back on segment 1, armed at ITS boundary");
  assert.ok(lastPlayIsAfterLastLoad(backend), `played before the bytes landed: ${backend.calls}`);
});

test("skipToNext during a beat never starts audio before the load resolves", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, backendClass: AsyncLoadBackend, backend: { turns: 3 } });
  await h.m.playForay(foray([
    fseg(),
    fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 }),
    fseg({ item_id: "ep-other", start_sec: 700, end_sec: 800 }),
  ]), { resolveItem });
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();

  await h.m.skipToNext();
  await settled;
  assert.equal(h.backend.outPoint, 800);
  assert.ok(lastPlayIsAfterLastLoad(h.backend), `played before the bytes landed: ${h.backend.calls}`);
  assert.equal(plays(h.backend), 2, "the superseded load must not also play");
});

test("a scrub during a beat still starts, against a slow load — the cut must not abandon", async () => {
  // The mirror-image failure of the one above: if cutting a beat abandoned the
  // waiting load outright, nothing would ever dispatch `itemLoaded` for a seek
  // and the player would sit in `loadingItem` forever. Silence with no way out.
  const { m, backend, settled } = await slowSeam();
  await m.seek(450, { precise: true });
  await settled;
  assert.equal(m.state.type, "playing", "a scrub during a beat must not strand the player");
  assert.equal(plays(backend), 2);
  assert.ok(backend.calls.includes("seek:450"), `got ${backend.calls}`);
});

test("pause during a beat, against a slow load, still makes nothing audible", async () => {
  const { m, backend, scheduler, settled } = await slowSeam();
  await m.pause();
  await settled;
  assert.equal(m.state.type, "interrupted");
  assert.equal(plays(backend), 1);
  await scheduler.advance(5000);
  assert.equal(plays(backend), 1);
});

/* ---------- the surface has to hear about the beat ---------- */

test("onSeamGapChange fires true when a beat starts and false when it ends", async () => {
  // Without this hook the page has nothing to repaint on: the element is paused
  // for the whole beat, so no media event fires and the UI keeps saying
  // "Loading…" through a silence it chose on purpose.
  const seen = [];
  const scheduler = manualScheduler();
  const h = make({ scheduler, onSeamGapChange: (inGap) => seen.push(inGap) });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  assert.deepStrictEqual(seen, [], "no beat before the first segment");

  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  assert.deepStrictEqual(seen, [true], "armed");
  await scheduler.advance(2000);
  await settled;
  assert.deepStrictEqual(seen, [true, false], "and released, exactly once each");
});

test("onSeamGapChange also reports the end when a transport action cuts the beat", async () => {
  const seen = [];
  const scheduler = manualScheduler();
  const h = make({ scheduler, onSeamGapChange: (inGap) => seen.push(inGap) });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  await h.m.pause();
  await settled;
  assert.deepStrictEqual(seen, [true, false]);
});

test("a surface that throws in onSeamGapChange cannot break playback", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, onSeamGapChange: () => { throw new Error("bad paint"); } });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  await tick();
  await scheduler.advance(2000);
  await settled;
  assert.equal(plays(h.backend), 2);
});

test("inSeamGap is true from the moment the seam is armed, not only once loaded", async () => {
  // The load happens INSIDE the beat, and that load is silence the listener is
  // already hearing. A flag that only went true afterwards would leave the page
  // showing "Loading…" for the first part of every beat.
  const scheduler = manualScheduler();
  const h = make({ scheduler, backendClass: AsyncLoadBackend, backend: { turns: 3 } });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  const settled = h.backend.onItemEnded("outPoint");
  // Deliberately no `tick()`: the load is still in flight here.
  assert.equal(h.m.inSeamGap, true);
  assert.ok(!h.backend.loads().includes("load:foray-1#1"), "the fixture premise — still loading");
  await tick();
  await h.scheduler.advance(2000);
  await settled;
  assert.equal(h.m.inSeamGap, false);
});

test("a failed load at a seam drops the deadline with it", async () => {
  // Otherwise the next load — including a cold-launch restore, which touches no
  // transport method and so cuts nothing — inherits a deadline it never earned.
  const scheduler = manualScheduler();
  const h = make({ scheduler, backend: { failLoadFor: ["foray-1#1"] } });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  await h.backend.onItemEnded("outPoint");
  assert.equal(h.m.seamGapRemainingMs, 0, "a dead segment must not leave a live beat behind");
});

test("the last segment failing the ladder ends the Foray without a beat left over", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, backend: { durationById: { "foray-1#1": 4000 } } });
  await h.m.playForay(foray([fseg(), fdai({ start_sec: 400, end_sec: 500 })]), { resolveItem });
  h.backend.currentTime = 210;
  await h.backend.onItemEnded("outPoint");
  assert.equal(h.m.state.type, "ended");
  assert.equal(h.m.seamGapRemainingMs, 0);
  assert.equal(scheduler.live, 0);
});

test("disposing during a beat leaves no timer alive", async () => {
  const { m, scheduler, settled } = await seam();
  m.dispose();
  await settled;
  assert.equal(scheduler.live, 0);
  __resetInstanceForTests();
});

test("the beat is observable in telemetry, both when it fires and when it is cut", async () => {
  const { m, log, scheduler, settled } = await seam();
  assert.ok(log.some((t) => /seam\.gap\.armed 2\.0s beat: foray-1#0 -> foray-1#1/.test(t)), `got ${log}`);
  assert.ok(log.some((t) => /seam\.gap\.hold 2000ms/.test(t)));
  await m.pause();
  await settled;
  assert.ok(log.some((t) => /seam\.gap\.cut\.pause/.test(t)), `got ${log}`);
  await scheduler.advance(2000);
});

test("seamGapSec: 0 turns the beat off entirely, and nothing else changes", async () => {
  const scheduler = manualScheduler();
  const h = make({ scheduler, seamGapSec: 0 });
  await h.m.playForay(
    foray([fseg(), fseg({ item_id: "ep-other", start_sec: 400, end_sec: 500 })]),
    { resolveItem }
  );
  h.backend.currentTime = 210;
  await h.backend.onItemEnded("outPoint");   // no advance needed
  assert.equal(plays(h.backend), 2);
  assert.equal(h.m.inSeamGap, false);
  assert.equal(scheduler.live, 0);
});

/* ---------- prefetch: the next segment loads before the boundary ----------

   The manager's whole job here is to answer "what comes next, and where does it
   start" when the backend says the window is open. The load itself, the second
   element and the handover are the backend's (`html-audio-backend.js`
   §"prefetch"). What these assert is that the RIGHT item is warmed, at the right
   in-point, only when there is a seam to cover — and that the beat survives.

   Measured cause, run 32036295743: a 2.0 s beat that the listener experienced
   as 9,153 ms, all of it a media load that ran after the boundary had paused
   the element and silenced the page. */

/* Imported down here so this whole section is an APPEND: `player/html-audio-
   backend.test.js` and this file are both being edited by other open work
   (#211), and an append cannot conflict with an edit above it. ES imports are
   hoisted, so the position is a diff-hygiene choice and nothing else. */
import { END_OUT_POINT } from "./queue-state.js";

/** A backend that models the real one's prefetch contract: warming an item
    makes its later load resolve at once, and anything else costs
    `COLD_LOAD_MS` — the load actually measured on the device. */
const COLD_LOAD_MS = 9153;

class PrefetchBackend extends FakeBackend {
  constructor(opts = {}) {
    super(opts);
    this._scheduler = opts.scheduler ?? null;
    this._warmed = new Set();
    this.windowsOpened = 0;
  }
  /** What the backend's own playhead watch does PREFETCH_LEAD_SEC before the
      boundary. Called by the test at the moment it wants to observe. */
  openPrefetchWindow() {
    this.windowsOpened++;
    if (this.onPrefetchWindow) this.onPrefetchWindow();
  }
  prefetch(item, { startOffset = 0 } = {}) {
    this.calls.push(`prefetch:${item.id}@${Math.round(startOffset)}`);
    this._warmed.add(`${item.id}@${Math.round(startOffset)}`);
    return true;
  }
  prefetches() { return this.calls.filter((c) => c.startsWith("prefetch:")); }
  async load(item, { startOffset = 0 } = {}) {
    const warm = this._warmed.has(`${item.id}@${Math.round(startOffset)}`);
    if (!warm && this._scheduler) {
      // A cold load, on the virtual clock, so "how long was the seam" is a
      // deterministic number instead of a wall-clock race.
      await new Promise((resolve) => this._scheduler.schedule(COLD_LOAD_MS, resolve));
    }
    this._warmed.delete(`${item.id}@${Math.round(startOffset)}`);
    return super.load(item, { startOffset });
  }
  play() {
    // Stamped, because the question this file exists to answer is WHEN the next
    // segment became audible relative to the boundary.
    this.calls.push(this._scheduler ? `play@${this._scheduler.nowMs()}` : "play");
  }
  playedAt() {
    return this.calls.filter((c) => c.startsWith("play@")).map((c) => Number(c.slice(5)));
  }
}

/** Three bounded segments over three DIFFERENT episodes, so every seam is a
    real cross-episode load — 16 of Foray #1's 31 seams are exactly this. */
const seg = (id, start, end, url) => ({
  id, kind: "episode", rate: 1.0, start_sec: start, end_sec: end, audio_url: url,
});
const THREE = [
  seg("s0", 100, 200, "https://cdn.example/a.mp3"),
  seg("s1", 300, 400, "https://cdn.example/b.mp3"),
  seg("s2", 500, 600, "https://cdn.example/c.mp3"),
];

function prefetching(opts = {}) {
  __resetInstanceForTests();
  const scheduler = opts.scheduler ?? INSTANT_SCHEDULER;
  const backend = new PrefetchBackend({ ...(opts.backend ?? {}), scheduler });
  const log = [];
  const m = new PlayerQueueManager({
    backend, telemetry: (t) => log.push(t), scheduler,
    seamGapSec: opts.seamGapSec, onSeamGapChange: opts.onSeamGapChange,
  });
  m.loadQueue(opts.queue ?? THREE.map((s) => ({ ...s })));
  return { m, backend, log, scheduler };
}

test("the window warms the next segment, at its own in-point", async () => {
  const { m, backend } = prefetching();
  await m.play(0);
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), ["prefetch:s1@300"],
    "the next segment's start_sec is the offset, not 0 and not a saved position");
  m.dispose();
});

test("each boundary warms the item that boundary will actually advance to", async () => {
  const { m, backend } = prefetching();
  await m.play(0);
  backend.openPrefetchWindow();
  await m.skipToNext();
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), ["prefetch:s1@300", "prefetch:s2@500"]);
  m.dispose();
});

test("nothing is warmed on the last item — a Foray does not chain", async () => {
  // Principle 1: no autoplay chains. There is no next episode to warm, and
  // warming one would be the beginning of exactly the thing we refuse to build.
  const { m, backend, log } = prefetching();
  await m.play(2);
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), []);
  assert.ok(log.some((l) => /prefetch\.none/.test(l)));
  m.dispose();
});

test("a bridged seam is not warmed — narration is the marker and it is ours", async () => {
  const queue = [THREE[0], tts("bridge"), THREE[1]].map((i) => ({ ...i }));
  const { m, backend, log } = prefetching({ queue });
  await m.play(0);
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), []);
  assert.ok(log.some((l) => /prefetch\.skipped/.test(l)));
  m.dispose();
});

test("warming follows the SAME rule as the beat, so the two cannot drift", async () => {
  // Eligibility is `seamGapSec(...) > 0` — the one decision in seam-gap.js —
  // rather than a second copy of "is this a segment-to-segment seam". Collapse
  // the beat and warming goes with it, which is the observable proof they are
  // one rule.
  const { m, backend } = prefetching({ seamGapSec: 0 });
  await m.play(0);
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), [], "no beat means no seam to cover");
  m.dispose();
});

test("a window that opens while nothing is playing warms nothing", async () => {
  const { m, backend } = prefetching();
  await m.play(0);
  await m.pause();
  backend.openPrefetchWindow();
  assert.deepStrictEqual(backend.prefetches(), []);
  m.dispose();
});

test("a backend with no prefetch is never asked for one", async () => {
  // Every other suite in this repo drives exactly such a backend, and the
  // native backend (#28) may never implement it.
  const { m, backend } = make();
  assert.equal(backend.onPrefetchWindow, undefined,
    "the manager must not wire a hook a backend cannot honour");
  await m.play(0);
  m.dispose();
});

/* ---- the number this whole change exists to move ---- */

/**
 * A virtual clock that fires each timer AT ITS OWN DUE TIME.
 *
 * `manualScheduler` above moves the clock and then runs everything that came
 * due, which is right for asserting on ordering and wrong for asserting on
 * duration: a callback would read `nowMs()` as the end of the jump rather than
 * the moment it was owed. Since the whole point of this section is a DURATION —
 * "how long was the seam" — it needs a clock that is honest inside a callback.
 *
 * Still zero wall clock, still deterministic, still nothing a busy box can
 * change. (#195: never assert on the real clock in this repo.)
 */
function virtualScheduler() {
  let now = 0;
  const pending = [];
  const drain = () => new Promise((r) => setImmediate(r));
  return {
    nowMs: () => now,
    schedule(ms, fn) {
      const e = { at: now + ms, fn, dead: false };
      pending.push(e);
      return () => { e.dead = true; };
    },
    /** Run to `untilMs`, firing due timers in order, draining microtasks after
        each — so work a callback queues (a load resolving, the next effect) has
        happened before the clock moves again. */
    async run(untilMs) {
      /* DRAIN BEFORE MOVING THE CLOCK, and this line is the whole reason the
         first draft of `seamCostMs` measured 9,153 ms for a warmed seam. The
         boundary is dispatched by the test *before* `run()` — synchronously
         starting an async chain that parks on the first `await`. Without this
         drain, the clock jumps to `untilMs` first, and the parked chain then
         reaches `_awaitSeamGap` with the beat's deadline already in the past:
         the beat reads as spent and the number comes out as if nothing had been
         warmed. The product was right; the clock was lying. */
      await drain();
      for (;;) {
        const due = pending
          .filter((e) => !e.dead && e.at <= untilMs)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.dead = true;
        due.fn();
        await drain();
      }
      now = Math.max(now, untilMs);
      await drain();
    },
  };
}

/**
 * Drive one seam and return how long it lasted: the virtual wall time from the
 * out-point firing to the next segment becoming audible. Same quantity the
 * device probe records as `observedGapMs`.
 */
async function seamCostMs({ warm }) {
  const scheduler = virtualScheduler();
  const { m, backend } = prefetching({ scheduler });
  // Segment 0's own load is cold either way; get it out of the way first, so the
  // seam is measured against the boundary and nothing else.
  const started = m.play(0);
  await scheduler.run(COLD_LOAD_MS);
  await started;
  assert.equal(m.state.type, "playing", "precondition: the first segment is audible");

  if (warm) backend.openPrefetchWindow();   // PREFETCH_LEAD_SEC before the boundary
  const boundaryAt = scheduler.nowMs();
  const ended = backend.onItemEnded(END_OUT_POINT);
  // The same generous run in both cases, so the two differ in the mechanism
  // rather than in how they were driven.
  await scheduler.run(boundaryAt + COLD_LOAD_MS);
  await ended;
  const audibleAt = backend.playedAt().at(-1);
  assert.equal(m.currentIndex, 1, "the seam completed");
  m.dispose();
  return audibleAt - boundaryAt;
}

test("a warmed seam is the 2.0 s beat; an unwarmed one is the load — measured on the virtual clock", async () => {
  /* THE BEFORE AND AFTER, in one test, with no wall clock anywhere: the seam is
     `max(beat, load)` and the only way to shorten it is to move the load out
     from under the boundary.

     COLD_LOAD_MS is the load measured on the device (9,153 ms). The beat is the
     authored 2.0 s. So the same seam costs 9,153 ms cold and 2,000 ms warmed —
     and 2,000 ms is not an accident of the fix, it is the beat still being
     honoured, which is the point. */
  const coldSeamMs = await seamCostMs({ warm: false });
  assert.equal(coldSeamMs, COLD_LOAD_MS,
    `an unwarmed seam is the load and nothing else, got ${coldSeamMs}`);

  const warmSeamMs = await seamCostMs({ warm: true });
  assert.equal(warmSeamMs, 2000,
    `a warmed seam is exactly the authored beat, got ${warmSeamMs}`);
  assert.ok(warmSeamMs < coldSeamMs, "and that is the whole fix");
});

test("losing the race costs what it costs today, and never the segment", async () => {
  /* The case that must not regress. A prefetch that has not finished by the
     boundary means the backend's `load()` falls back to the ordinary path — so
     the seam is long, exactly as long as it is today, and everything else is
     unchanged: the queue advances by one, the next segment starts at its own
     in-point, and its out-point is armed. What the listener must never get is a
     segment that starts mid-word, a segment cut short, or a queue that walked
     past something that never played. */
  const scheduler = virtualScheduler();
  const { m, backend } = prefetching({ scheduler });
  const started = m.play(0);
  await scheduler.run(COLD_LOAD_MS);
  await started;
  // The window opens, but this warm load never finishes: the manager asked, the
  // backend has nothing ready by the boundary, and `load()` takes the slow path.
  backend.openPrefetchWindow();
  backend._warmed.clear();

  const ended = backend.onItemEnded(END_OUT_POINT);
  await scheduler.run(scheduler.nowMs() + COLD_LOAD_MS);
  await ended;

  assert.equal(m.state.type, "playing");
  assert.equal(m.currentIndex, 1, "advanced by exactly one — nothing was skipped");
  assert.ok(backend.calls.includes("load:s1@300"), "and it started at its own in-point");
  assert.equal(backend.outPoint, 400, "with its own out-point armed");
  m.dispose();
});
