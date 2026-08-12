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
  constructor({ failLoadFor = [] } = {}) {
    this.calls = [];
    this.currentTime = 0;
    this.duration = 3600;
    this.failLoadFor = new Set(failLoadFor);
    this.onItemEnded = null;
    this.onError = null;
  }
  async load(item, { startOffset = 0 } = {}) {
    this.calls.push(`load:${item.id}@${Math.round(startOffset)}`);
    if (this.failLoadFor.has(item.id)) throw new Error("missing file");
  }
  play() { this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  seek(s) { this.calls.push(`seek:${Math.round(s)}`); }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
  // ids only, for assertions that do not care about the offset
  loads() { return this.calls.filter((c) => c.startsWith("load:")).map((c) => c.split("@")[0]); }
}

function make(opts = {}) {
  __resetInstanceForTests();
  const backend = new FakeBackend(opts.backend);
  const saved = new Map();
  const positionStore = {
    save: (id, seconds) => saved.set(id, { seconds }),
    load: (id) => saved.get(id) ?? null,
  };
  const log = [];
  const m = new PlayerQueueManager({
    backend, positionStore, telemetry: (t) => log.push(t), strategy: opts.strategy,
  });
  return { m, backend, saved, log };
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
