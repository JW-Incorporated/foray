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
