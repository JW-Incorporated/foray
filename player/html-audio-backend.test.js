/* Tests for HtmlAudioBackend (issue #24), against a fake <audio> element that
   reproduces the browser's event ordering.

   The interesting behaviour is all in the ordering — metadata before
   currentTime, seek settling before "ready", rate surviving a load — so the
   fake fires events the way a real element does rather than resolving
   everything immediately. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { HtmlAudioBackend } from "./html-audio-backend.js";

const item = (id, url = "https://cdn.example/ep.mp3") => ({ id, audio_url: url, kind: "episode" });

/** Minimal HTMLAudioElement stand-in. `load()` schedules the real sequence:
    loadedmetadata -> (seeked) -> canplay. */
class FakeAudio {
  constructor({ failWith = null, durationSec = 3600 } = {}) {
    this.listeners = new Map();
    this.src = "";
    this.currentSrc = "";
    this.currentTime = 0;
    this.duration = durationSec;
    this.playbackRate = 1;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 0;
    this.error = failWith ? { code: failWith } : null;
    this._failWith = failWith;
    this.calls = [];
    this.playResult = Promise.resolve();
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  _fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }

  load() {
    this.calls.push("load");
    this.currentSrc = this.src;
    queueMicrotask(() => {
      if (this._failWith) { this.readyState = 0; return this._fire("error"); }
      this.readyState = 1;
      this._fire("loadedmetadata");
      // A real element fires `seeked` only if currentTime actually moved.
      queueMicrotask(() => {
        this.readyState = 4;
        if (this.currentTime > 0) this._fire("seeked");
        this._fire("canplay");
      });
    });
  }
  play() { this.calls.push("play"); return this.playResult; }
  pause() { this.calls.push("pause"); }
  removeAttribute(a) { this.calls.push(`removeAttribute:${a}`); this.src = ""; }
}

const mk = (opts) => {
  const el = new FakeAudio(opts);
  const log = [];
  return { el, log, b: new HtmlAudioBackend({ element: el, telemetry: (m) => log.push(m) }) };
};

/* ---------- loading ---------- */

test("load resolves once the element can produce audio", async () => {
  const { b, el } = mk();
  await b.load(item("a"));
  assert.equal(el.src, "https://cdn.example/ep.mp3");
  assert.ok(el.calls.includes("load"));
});

test("load applies the start offset AFTER metadata, never before", async () => {
  // Assigning currentTime at readyState 0 is discarded by real browsers.
  const { b, el } = mk();
  const order = [];
  el.addEventListener("loadedmetadata", () => order.push(`meta@${el.currentTime}`));
  await b.load(item("a"), { startOffset: 1800 });
  assert.equal(el.currentTime, 1800);
  assert.deepStrictEqual(order, ["meta@0"], "offset must not be applied before metadata");
});

test("load does not resolve until the seek has settled near the offset", async () => {
  // `canplay` can fire for the buffered head while the seek is still
  // resolving; resolving then would start playback at 0:00.
  const { b, el } = mk();
  await b.load(item("a"), { startOffset: 600 });
  assert.ok(Math.abs(el.currentTime - 600) <= 1);
});

test("a media error rejects so the manager's degrade path can run", async () => {
  const { b } = mk({ failWith: 4 });
  await assert.rejects(() => b.load(item("a")), /load failed/);
});

test("an item with no audio_url rejects rather than loading an empty src", async () => {
  const { b, el } = mk();
  await assert.rejects(() => b.load({ id: "x", audio_url: null }), /no audio_url/);
  assert.equal(el.src, "");
});

/* ---------- CORS posture (measured in #20 §3) ---------- */

test("the element is never given a crossorigin attribute", async () => {
  // Podcast CDNs send no Access-Control-Allow-Origin. Setting crossorigin
  // turns a working no-cors media load into a hard failure.
  const { b, el } = mk();
  await b.load(item("a"));
  assert.equal(el.crossOrigin, undefined, "crossOrigin must never be set");
});

/* ---------- autoplay policy ---------- */

test("a rejected play() surfaces as onError, never an unhandled rejection", async () => {
  const { b, el } = mk();
  await b.load(item("a"));
  const err = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
  el.playResult = Promise.reject(err);

  let reported = null;
  b.onError = (m) => { reported = m; };
  b.play();
  await new Promise((r) => setTimeout(r, 0));

  assert.match(reported ?? "", /NotAllowedError/);
});

/* ---------- rate ---------- */

test("rate set before play survives the load that reset it", async () => {
  // Assigning src resets playbackRate to 1 in most browsers, which would
  // silently undo the manager's restoreRate effect.
  const { b, el } = mk();
  b.setRate(1.5);
  await b.load(item("a"));
  el.playbackRate = 1; // what the browser does on src assignment
  b.play();
  assert.equal(el.playbackRate, 1.5);
});

test("a bad rate falls back to 1.0 rather than muting or reversing playback", () => {
  const { b, el } = mk();
  for (const bad of [0, -1, NaN, null, undefined, "fast"]) {
    b.setRate(bad);
    assert.equal(el.playbackRate, 1.0, String(bad));
  }
});

/* ---------- seek ---------- */

test("seek moves the playhead and ignores junk", async () => {
  const { b, el } = mk();
  await b.load(item("a"));
  b.seek(120);
  assert.equal(el.currentTime, 120);
  for (const bad of [-5, NaN, Infinity, "60", null]) {
    b.seek(bad);
    assert.equal(el.currentTime, 120, `${bad} must be ignored`);
  }
});

test("seek carries the precise flag into telemetry without changing behaviour", async () => {
  const { b, log } = mk();
  await b.load(item("a"));
  b.seek(90, { precise: true });
  assert.ok(log.some((m) => /precise=true/.test(m)));
});

/* ---------- volume / ducking ---------- */

test("volume clamps to 0..1 — ducking uses this, not Web Audio", () => {
  const { b, el } = mk();
  b.setVolume(0.15);
  assert.equal(el.volume, 0.15);
  b.setVolume(5); assert.equal(el.volume, 1);
  b.setVolume(-2); assert.equal(el.volume, 0);
});

/* ---------- callbacks ---------- */

test("the element's ended event reaches the manager", async () => {
  const { b, el } = mk();
  let ended = 0;
  b.onItemEnded = () => { ended++; };
  await b.load(item("a"));
  el._fire("ended");
  assert.equal(ended, 1);
});

/* ---------- duration ---------- */

test("duration is null rather than NaN when unknown", async () => {
  const { b, el } = mk();
  await b.load(item("a"));
  assert.equal(b.duration, 3600);
  el.duration = NaN;
  assert.equal(b.duration, null, "NaN would poison the scrubber range");
});

/* ---------- release ---------- */

test("release stops playback, drops the buffer and detaches listeners", async () => {
  const { b, el } = mk();
  let ended = 0;
  b.onItemEnded = () => { ended++; };
  await b.load(item("a"));
  b.release();

  assert.ok(el.calls.includes("pause"));
  assert.ok(el.calls.includes("removeAttribute:src"), "must drop the buffer, not leave it decoding");
  el._fire("ended");
  assert.equal(ended, 0, "listeners must be detached");
});

test("a released backend refuses further work instead of half-operating", async () => {
  const { b } = mk();
  b.release();
  await assert.rejects(() => b.load(item("a")), /released/);
});

/* ---------- single element (corner case #19) ---------- */

test("loading a second item reuses the same element", async () => {
  // A new element per item is the web form of two-players-alive: the old one
  // keeps decoding and both are audible.
  const { b, el } = mk();
  await b.load(item("a", "https://cdn.example/a.mp3"));
  await b.load(item("b", "https://cdn.example/b.mp3"));
  assert.equal(b.el, el, "must not swap elements");
  assert.equal(el.src, "https://cdn.example/b.mp3");
});

/* ---------- integration: manager + backend ----------
   The point of #24 is that the two compose. These drive the real manager
   against the real backend, with only the <audio> element faked. */

import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { PICKED_FIRST } from "./queue-strategy.js";

function wired(opts = {}) {
  __resetInstanceForTests();
  const el = new FakeAudio(opts);
  const backend = new HtmlAudioBackend({ element: el });
  const saved = new Map();
  const m = new PlayerQueueManager({
    backend,
    positionStore: {
      save: (id, seconds) => saved.set(id, { seconds }),
      load: (id) => saved.get(id) ?? null,
    },
    strategy: opts.strategy,
  });
  return { m, backend, el, saved };
}

test("integration: tapping an item loads it and starts audio", async () => {
  const { m, el } = wired();
  m.setQueueFromPick(item("a", "https://cdn.example/a.mp3"));
  await m.play(0);
  assert.equal(el.src, "https://cdn.example/a.mp3");
  assert.ok(el.calls.includes("play"));
  assert.equal(m.state.type, "playing");
});

test("integration: a resumed episode starts at its saved position, not 0:00", async () => {
  const { m, el, saved } = wired();
  saved.set("a", { seconds: 1800 });
  m.setQueueFromPick(item("a"));
  await m.play(0);
  assert.equal(el.currentTime, 1800);
  // and the offset landed before anything became audible
  assert.ok(el.calls.indexOf("load") < el.calls.indexOf("play"));
});

test("integration: an unplayable item degrades instead of hanging", async () => {
  // Corner case #6/#10 — a 403 or a missing file must not wedge the player.
  const { m } = wired({ failWith: 4 });
  m.setQueueFromPick(item("a"));
  await m.play(0);
  assert.equal(m.state.type, "idle", "error path drops to idle rather than stalling in loadingItem");
});

test("integration: end of a single-item queue stops cleanly, no autoplay chain", async () => {
  const { m, el } = wired();
  m.setQueueFromPick(item("a"), { others: [item("b")] });
  await m.play(0);
  el.calls.length = 0;
  el._fire("ended");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.state.type, "ended");
  assert.ok(!el.calls.includes("play"), "must not roll into another episode");
});

test("integration: a fast double-skip leaves exactly one source loaded", async () => {
  // The web form of corner case #19.
  const { m, el } = wired({ strategy: PICKED_FIRST });
  m.setQueueFromPick(item("a", "https://cdn.example/a.mp3"), {
    others: [item("b", "https://cdn.example/b.mp3"), item("c", "https://cdn.example/c.mp3")],
  });
  await m.play(0);
  await m.skipToNext();
  await m.skipToNext();
  assert.equal(el.src, "https://cdn.example/c.mp3", "only the final target should be loaded");
  assert.equal(m._currentItem().id, "c");
});

/* ---------- out-points (#111 / #65) ----------

   These run against a REAL clock. `TickingAudio` derives `currentTime` from
   elapsed wall time the way a decoder does, and fires `timeupdate` on a genuine
   250 ms interval, so the numbers below are measured rather than asserted into
   existence — which is the only way a claim about boundary accuracy means
   anything. Each test costs well under a second. */

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic
const TIMEUPDATE_MS = 250;

class TickingAudio {
  constructor({ durationSec = 3600 } = {}) {
    this.listeners = new Map();
    this.src = ""; this.currentSrc = "";
    this.duration = durationSec;
    this.playbackRate = 1;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 0;
    this.error = null;
    this.paused = true;
    this.calls = [];
    this.playResult = Promise.resolve();
    this._base = 0;
    this._t0 = null;
    this._stalled = false;
    this._ticker = null;
  }
  get currentTime() {
    if (this.paused || this._stalled || this._t0 == null) return this._base;
    return this._base + ((now() - this._t0) / 1000) * this.playbackRate;
  }
  set currentTime(v) { this._base = v; this._t0 = now(); this._fire("seeked"); }

  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  _fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }

  load() {
    this.calls.push("load");
    this.currentSrc = this.src;
    queueMicrotask(() => {
      this.readyState = 1;
      this._fire("loadedmetadata");
      queueMicrotask(() => { this.readyState = 4; this._fire("canplay"); });
    });
  }
  play() {
    this.calls.push("play");
    this._base = this.currentTime;
    this._t0 = now();
    this.paused = false;
    this._fire("playing");
    this._ticker = setInterval(() => {
      if (this.currentTime >= this.duration) {
        this._base = this.duration;
        this.pause();
        return this._fire("ended");
      }
      this._fire("timeupdate");
    }, TIMEUPDATE_MS);
    if (this._ticker.unref) this._ticker.unref();
    return this.playResult;
  }
  pause() {
    this._base = this.currentTime;
    this.paused = true;
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    this.calls.push("pause");
    this._fire("pause");
  }
  /** Freeze the decoder without pausing — a rebuffer. */
  stall() { this._base = this.currentTime; this._stalled = true; this._fire("waiting"); }
  unstall() { this._t0 = now(); this._stalled = false; this._fire("playing"); }
  removeAttribute(a) { this.calls.push(`removeAttribute:${a}`); this.src = ""; }
}

/** Every backend built by `ticking()`, so a broken out-point cannot leave a
    real interval running for the rest of the file. */
const tickingBuilt = [];
after(() => { for (const el of tickingBuilt) { try { el.pause(); } catch (_) {} } });

const ticking = (opts = {}) => {
  const el = new TickingAudio(opts);
  /* Timestamp every delivered tick. This is the naive implementation's clock —
     the thing the fine timer has to beat — measured under the load in the room
     rather than assumed from TIMEUPDATE_MS. */
  const tickAt = [];
  const fire = el._fire.bind(el);
  el._fire = (type, ...rest) => {
    if (type === "timeupdate") tickAt.push(now());
    return fire(type, ...rest);
  };
  tickingBuilt.push(el);
  const log = [];
  // A short load deadline so the stall cases cost milliseconds, not the ten
  // real seconds the shipped default allows a slow CDN. The deadline itself is
  // ref'd in production and here — that is the point of the tests below.
  const b = new HtmlAudioBackend({
    element: el, telemetry: (m) => log.push(m), loadTimeoutMs: opts.loadTimeoutMs ?? 200,
  });
  const ends = [];
  b.onItemEnded = (reason) => ends.push(reason ?? "natural");
  return { el, b, log, ends, tickAt };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- surviving a loaded box ----------

   This is the only suite in the root group that drives a REAL clock: the fake
   element ticks on a real `setInterval` and the backend arms real timers, because
   what is under test is when a boundary actually lands. That makes every budget
   here a claim about the SCHEDULER, and on a machine whose cores are saturated —
   a transcription run, or a CI runner shared with three other jobs — the
   scheduler is late by tens to hundreds of milliseconds. Measured: this suite
   failed exactly once in four full runs, and the run it failed was the one with a
   transcription job pinning every core. The two failures were both hard-coded
   PRECISION budgets (50 ms and 100 ms of out-point overshoot).

   The fix is NOT a bigger constant. The claim worth making is comparative, and
   the comparison is already available for free in the same run:

     A bare `if (currentTime >= end)` on `timeupdate` — the naive implementation
     this backend's fine timer exists to beat — cannot stop sooner than the NEXT
     TICK. So one observed tick interval IS the naive cost, measured under
     whatever load is happening right now. Asserting the overshoot comes in at a
     fraction of it is load-invariant by construction: starve the box and both
     numbers stretch together.

   That replaces an earlier attempt here that added a measured scheduler jitter to
   a hard-coded 50 ms and capped it at the nominal 250 ms tick. Two things were
   wrong with it, both caught in review: the "one-sided guarantee" it fell back to
   was `overshoot >= 0`, which is non-negative by construction and so asserted
   nothing at all; and the cap was set against the NOMINAL tick, while a genuinely
   naive implementation measures 90-133 ms — inside the inflated budget a loaded
   box produced. It could have passed a real regression. This cannot: the budget
   is derived from the naive cost rather than guessed against it.

   The other rule still holds: a budget for "did the thing happen at all" is a
   ceiling, not a duration. The wait returns the moment the event lands, so a
   green run costs the same however large it is, and only a broken build pays. */

/** Ceiling for "an end was reported". Was 3-4 s, which a saturated box beats.
    Not larger, because ten of these in a row is what a broken out-point costs
    before the suite reports it, and there is no `--test-timeout` above us. */
const END_BUDGET_MS = 10000;

/** The widest gap between consecutive `timeupdate`s actually delivered — the
    naive implementation's worst case, on this box, during this measurement.
    Falls back to the nominal interval when there were too few ticks to measure
    a gap (a very short segment), which is the conservative direction. */
function observedTickMs(tickAt) {
  let worst = 0;
  for (let i = 1; i < tickAt.length; i++) worst = Math.max(worst, tickAt[i] - tickAt[i - 1]);
  return worst > 0 ? worst : TIMEUPDATE_MS;
}

/** Wait for the backend to report an end, or give up. Returns the reason so a
    caller can assert the boundary FIRED — `waitForEnd` returning null and the
    overshoot never being written is otherwise indistinguishable from success. */
async function waitForEnd(ends, budgetMs = END_BUDGET_MS) {
  const deadline = now() + budgetMs;
  while (!ends.length && now() < deadline) await sleep(5);
  return ends[0] ?? null;
}

test("an out-point stops the item and reports the same end a finished file reports", async () => {
  const { el, b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.8);
  b.play();

  assert.equal(await waitForEnd(ends), "outPoint");
  assert.equal(el.paused, true, "the boundary must pause, like a file running out");
});

test("the stop is never early — the payoff is never clipped", async () => {
  // The one-sided guarantee. The fine timer is a prediction; it only ever stops
  // on a re-read of the real playhead.
  for (const target of [100.4, 100.75, 101.1]) {
    const { el, b, ends } = ticking();
    await b.load(item("seg"), { startOffset: 100 });
    b.setOutPoint(target);
    b.play();
    await waitForEnd(ends);
    assert.ok(el.currentTime >= target, `stopped at ${el.currentTime} before ${target}`);
    assert.ok(b.lastOutPointOvershootSec >= 0);
  }
});

/** Fraction of the naive cost the fine timer must come in under. A bare
    timeupdate check averages half a tick and peaks at a whole one, so a half is
    already a losing score for it; measured, this backend comes in nearer a
    twentieth. Loose enough not to flake, tight enough that "the fine watch
    stopped working" — measured at 90-133 ms against a 250 ms nominal tick —
    fails it. */
const NAIVE_FRACTION = 0.5;

/* The out-points are spread ACROSS a tick interval on purpose. A naive check can
   only fire on a tick, so its error is however far the boundary sits past the
   last one — which means a single target can make a naive implementation look
   good by luck of alignment. Measured: with the fine watch disabled and a lone
   target of 100.7, the overshoot was 50 ms and this test passed a genuinely
   broken build. Sweeping the phase exercises the naive worst case (very nearly a
   whole tick) while the fine timer, which is scheduled in wall clock rather than
   on ticks, stays flat across all of them. */
const PHASE_SWEEP = [100.70, 100.76, 100.82, 100.88];

test("the boundary beats a bare timeupdate check, measured against one", async () => {
  // Measured on an idle box the overshoot is 5-15 ms against a ~250 ms tick.
  // The budget is a fraction of the tick interval THIS RUN actually delivered,
  // so a saturated scheduler stretches both sides equally instead of being
  // reported as a product regression — which is the flake this replaces.
  const overshoots = [];
  let naiveMs = Infinity;
  for (const target of PHASE_SWEEP) {
    const { b, ends, tickAt } = ticking();
    await b.load(item("seg"), { startOffset: 100 });
    b.setOutPoint(target);
    b.play();
    // The boundary must actually FIRE. Without this the whole test is vacuous:
    // `lastOutPointOvershootSec` starts as null, and `null < anything` is true.
    assert.equal(await waitForEnd(ends), "outPoint", `the out-point at ${target} never fired`);
    assert.equal(typeof b.lastOutPointOvershootSec, "number");
    overshoots.push(b.lastOutPointOvershootSec);
    naiveMs = Math.min(naiveMs, observedTickMs(tickAt));
  }
  const worst = Math.max(...overshoots);
  const budgetSec = (naiveMs * NAIVE_FRACTION) / 1000;
  assert.ok(
    worst < budgetSec,
    `worst overshoot ${worst}s (of ${overshoots.join(", ")}) vs ${budgetSec}s ` +
    `— a naive check would have cost up to ${naiveMs.toFixed(0)}ms`
  );
});

test("a faster rate does not loosen the boundary", async () => {
  // At 2x, one timeupdate is half a second of CONTENT — a whole sentence. The
  // fine timer is scheduled in wall clock, so the content overshoot stays flat.
  const { b, ends, tickAt } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setRate(2);
  b.setOutPoint(101.2);
  b.play();
  assert.equal(await waitForEnd(ends), "outPoint", "the out-point never fired at 2x");
  const worst = b.lastOutPointOvershootSec;
  // At 2x a tick covers twice the CONTENT, which is what the naive check would
  // overshoot by — the comparison is against content seconds either way.
  const budgetSec = (observedTickMs(tickAt) * 2 * NAIVE_FRACTION) / 1000;
  assert.ok(typeof worst === "number" && worst < budgetSec, `overshoot ${worst}s at 2x vs ${budgetSec}s`);
});

test("a buffering stall at the boundary neither stops early nor spins", async () => {
  const { el, b, log, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.6);
  b.play();
  await sleep(350);
  el.stall();
  const frozenAt = el.currentTime;
  await sleep(400);

  assert.deepStrictEqual(ends, [], "must not report an end for audio that never played");
  assert.equal(el.currentTime, frozenAt, "sanity: the stall really froze the playhead");
  const stallLogs = log.filter((m) => /outPoint\.stalled/.test(m)).length;
  assert.ok(stallLogs <= 2, `stood down ${stallLogs} times — the fine watch is spinning`);

  el.unstall();
  assert.equal(await waitForEnd(ends), "outPoint", "must resume and still stop at the boundary");
  assert.ok(el.currentTime >= 100.6);
});

test("an out-point past the real audio yields exactly one end, the natural one", async () => {
  const { b, log, ends } = ticking({ durationSec: 100.5 });
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(400); // authored end_sec well past this copy
  b.play();

  assert.equal(await waitForEnd(ends), "natural");
  await sleep(300);
  assert.equal(ends.length, 1, "the file end and a late boundary must not both fire");
  assert.ok(log.some((m) => /outPoint\.beyondDuration/.test(m)), "and it says so");
});

/* ---------- scrubbing past the out-point ---------- */

test("scrubbing past the out-point frees the rest of the episode", async () => {
  // Decision: free play. The boundary is an editorial claim about where the
  // interesting part stops, not a lock — and the listener just asked, by hand,
  // to hear what comes after.
  const { el, b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(110);
  b.play();
  b.seek(130);
  await sleep(400);
  assert.deepStrictEqual(ends, [], "no advance");
  assert.equal(el.paused, false, "and no clamp back to the boundary either");
  assert.ok(el.currentTime > 130);
});

test("scrubbing back before the out-point re-arms it", async () => {
  const { b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(110);
  b.play();
  b.seek(130);          // past — disarmed
  await sleep(60);
  b.seek(109.7);        // back before it — armed again
  assert.equal(await waitForEnd(ends), "outPoint");
});

test("an out-point already behind the playhead never fires", async () => {
  const { b, ends, log } = ticking();
  await b.load(item("seg"), { startOffset: 500 });
  b.setOutPoint(200);
  b.play();
  await sleep(400);
  assert.deepStrictEqual(ends, []);
  assert.ok(log.some((m) => /outPoint\.set 200\.00s armed=false/.test(m)));
});

/* ---------- the load contract ---------- */

test("load clears the previous item's out-point", async () => {
  // Contract, relied on by the reducer: it emits setOutPoint only for bounded
  // items, so a stale boundary would otherwise stop a whole episode partway
  // through at a time taken from the segment before it.
  const { b, ends } = ticking();
  await b.load(item("seg", "https://cdn.example/a.mp3"), { startOffset: 100 });
  b.setOutPoint(100.5);
  await b.load(item("whole", "https://cdn.example/b.mp3"));
  assert.equal(b.outPoint, null);
  b.play();
  await sleep(400);
  assert.deepStrictEqual(ends, []);
});

test("setOutPoint(null) and junk clear the watch rather than arming nonsense", async () => {
  const { b } = ticking();
  await b.load(item("seg"));
  for (const bad of [null, undefined, NaN, Infinity, -5, 0, "120"]) {
    b.setOutPoint(100);
    b.setOutPoint(bad);
    assert.equal(b.outPoint, null, String(bad));
  }
});

test("release stops the watch dead", async () => {
  const { b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.4);
  b.play();
  b.release();
  await sleep(400);
  assert.deepStrictEqual(ends, [], "a released backend must not report anything");
});

/* ---------- back-to-back segments in ONE episode ---------- */

test("the same source is a seek, not a refetch", async () => {
  // Consecutive Foray segments routinely share an episode. Re-assigning src —
  // even to the identical string — restarts the media load algorithm: the
  // buffer is dropped, there is an audible gap, and on an ad-stitched host the
  // refetch can return a different stitch that moves every later timestamp.
  const { el, b, log } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 100 });
  el.calls.length = 0;

  await b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 400 });
  assert.deepStrictEqual(el.calls, [], "no second load() on the element");
  assert.equal(el.currentTime, 400, "just a seek to the next in-point");
  assert.equal(b.currentItem.id, "seg-2", "and the backend knows which item it is on");
  assert.ok(log.some((m) => /load\.sameSource/.test(m)));
});

test("an in-place seek that never settles rejects rather than wedging the player", async () => {
  // Seeking into an unbuffered region drops readyState below HAVE_FUTURE_DATA,
  // and a refill that never arrives is the ordinary stall shape: browsers fire
  // `stalled`/`suspend` and NEVER `error`. With no deadline the promise stays
  // pending forever, `_loadItem` awaits forever, and the state machine sits in
  // loadingItem with two leaked listeners and no recovery.
  const { el, b } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 100 });
  el.readyState = 1; // the seek target is not buffered
  const before = el.listeners.get("seeked").size;

  await assert.rejects(
    () => b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 4000 }),
    /did not settle/
  );
  assert.equal(el.listeners.get("seeked").size, before, "and it leaks no listeners on the way out");
});

test("a media error during an in-place seek rejects, so the degrade path runs", async () => {
  const { el, b } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 100 });
  el.readyState = 1;
  const p = b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 4000 });
  el.error = { code: 2 };
  el._fire("error");
  await assert.rejects(() => p, /in-place seek to 4000s failed/);
});

test("a first load that stalls without erroring also degrades rather than hanging", async () => {
  // Same hole as the in-place path, in the path a Foray's FIRST segment takes.
  // A fetch that stops without failing fires `stalled`/`suspend` and then
  // nothing — no `canplay`, no `error` — so only a deadline gets us out.
  const el = new TickingAudio();
  el.load = function () { this.calls.push("load"); this.currentSrc = this.src; }; // never settles
  const b = new HtmlAudioBackend({ element: el, loadTimeoutMs: 150 });
  await assert.rejects(() => b.load(item("seg")), /load of seg did not settle within 150ms/);
});

test("every deadline is ref'd, so it fires whether or not anything else is running", async () => {
  // THE CI FAILURE ON THIS PR. An unref'd timer only runs if something else
  // keeps the event loop alive, so a recovery deadline that is unref'd is not a
  // recovery at all — it depends on unrelated activity elsewhere in the
  // process. Node 24's test runner happened to hold the loop open and Node 22's
  // did not, which is the entire difference between green locally and a hung
  // suite in CI. This asserts the property directly rather than hoping a
  // version difference shows up again.
  const el = new TickingAudio();
  el.load = function () { this.calls.push("load"); };
  const b = new HtmlAudioBackend({ element: el, loadTimeoutMs: 60 });
  const armed = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    const t = realSetTimeout(fn, ms);
    armed.push(t);
    return t;
  };
  try {
    await assert.rejects(() => b.load(item("seg")), /did not settle/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(armed.length >= 1, "the load must arm a deadline at all");
  for (const t of armed) {
    assert.ok(t?.hasRef?.() !== false, "a deadline must never be unref'd");
  }
});

test("consecutive same-episode slices may run BACKWARDS through the episode", async () => {
  // Nothing requires a Foray's slices to be in episode order — a later segment
  // can sit earlier in the file. The in-place seek must go backwards and the
  // boundary must re-arm behind the old one.
  const { el, b, ends } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 900 });
  b.setOutPoint(900.4);
  b.play();
  assert.equal(await waitForEnd(ends), "outPoint");

  await b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 100 });
  assert.equal(el.currentTime, 100, "seeks backwards within the buffered source");
  b.setOutPoint(100.4);
  b.play();
  const deadline = now() + END_BUDGET_MS;
  while (ends.length < 2 && now() < deadline) await sleep(5);
  assert.deepStrictEqual(ends, ["outPoint", "outPoint"]);
  assert.ok(el.currentTime >= 100.4 && el.currentTime < 101);
});

test("arming while paused works: the boundary takes effect once play starts", async () => {
  // setOutPoint runs before startPlayback, so nothing can be scheduled yet.
  // The `playing` event is what arms the fine watch.
  const { b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.4);
  assert.equal(b.outPoint, 100.4);
  await sleep(120);
  assert.deepStrictEqual(ends, [], "nothing fires while paused");
  b.play();
  assert.equal(await waitForEnd(ends), "outPoint");
});

test("a different source still reloads", async () => {
  const { el, b } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 100 });
  el.calls.length = 0;
  await b.load(item("seg-2", "https://cdn.example/two.mp3"), { startOffset: 30 });
  assert.ok(el.calls.includes("load"));
  assert.equal(el.src, "https://cdn.example/two.mp3");
  assert.equal(el.currentTime, 30);
});

test("back-to-back slices of one episode each stop at their own boundary", async () => {
  const { el, b, ends } = ticking();
  await b.load(item("seg-1", "https://cdn.example/one.mp3"), { startOffset: 100 });
  b.setOutPoint(100.5);
  b.play();
  assert.equal(await waitForEnd(ends), "outPoint");

  el.calls.length = 0;
  await b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 400 });
  b.setOutPoint(400.5);
  b.play();
  const deadline = now() + END_BUDGET_MS;
  while (ends.length < 2 && now() < deadline) await sleep(5);
  assert.deepStrictEqual(ends, ["outPoint", "outPoint"]);
  assert.ok(el.currentTime >= 400.5 && el.currentTime < 401, `second slice stopped at ${el.currentTime}`);
  assert.ok(!el.calls.includes("load"), "and never refetched the shared episode");
});

/* ---------- integration: a whole Foray, real manager, real backend ----------
   The unit tests above each hold one layer still. This one drives the actual
   stack — reducer, manager, backend, a clock — through the shape a Foray
   really has: two slices of one episode, then a slice of another, with a phone
   call in the middle. It is the test that would catch a wiring mistake none of
   the layers can see on its own. */

/** Wait until `id` is not merely LOADED but audible.
 *
 *  These two used to be the same instant and are not any more: an unbridged
 *  seam holds a beat between the load and `startPlayback`, and the manager
 *  moves `currentIndex` at the load. Polling on the item alone therefore
 *  returns mid-silence, and anything the test then does — a phone call, in the
 *  case below — happens to a player that is between segments rather than
 *  inside one. Poll-until-condition, never a sleep: a green run costs whatever
 *  the box actually needed and no more. */
async function waitForPlaying(m, id) {
  const deadline = now() + END_BUDGET_MS;
  while (now() < deadline) {
    if (m.state.type === "playing" && m._currentItem()?.id === id) return true;
    await sleep(5);
  }
  return false;
}

test("integration: a three-segment Foray plays every slice and stops", async () => {
  __resetInstanceForTests();
  const el = new TickingAudio();
  const backend = new HtmlAudioBackend({ element: el });
  const saved = new Map();
  const m = new PlayerQueueManager({
    backend,
    positionStore: { save: (id, s) => saved.set(id, { seconds: s }), load: (id) => saved.get(id) ?? null },
    /* A real 2.0 s beat twice over would add four seconds of sleeping to this
       suite for no extra coverage — the beat's LENGTH is a constant pinned in
       player/seam-gap.test.js and its behaviour is driven by a fake clock in
       player/queue-manager.test.js. What is only testable here is that the
       DEFAULT scheduler (a real setTimeout) actually fires, so the beat stays
       real and is merely short. Everything below waits on a condition, so this
       number is not load-bearing either. */
    seamGapSec: 0.05,
  });
  // A stale position on the shared episode must never win over an in-point.
  saved.set("ep-a", { seconds: 3000 });

  const catalogue = {
    "ep-a": { id: "ep-a", audio_url: "https://cdn.example/a.mp3", dai_suspected: false, duration_sec: 3600 },
    "ep-b": { id: "ep-b", audio_url: "https://cdn.example/b.mp3", dai_suspected: false, duration_sec: 3600 },
  };
  const s = (item_id, start, end) => ({ type: "segment", item_id, start_sec: start, end_sec: end, why: "w" });

  const report = await m.playForay({
    id: "f1",
    items: [s("ep-a", 100, 100.5), s("ep-a", 300, 300.5), s("ep-b", 50, 50.5)],
  }, { resolveItem: (id) => catalogue[id] ?? null });

  assert.deepStrictEqual(report.skipped, []);
  assert.equal(el.currentTime >= 100 && el.currentTime < 101, true, "opened at the first in-point, not at 3000");

  // Slice 1 -> slice 2: same episode, so a seek rather than a refetch — with
  // the seam beat in between, which is silence and not a second load.
  const loadsBefore = el.calls.filter((c) => c === "load").length;
  assert.ok(await waitForPlaying(m, "f1#1"), `never reached slice 2 (state ${m.state.type})`);
  assert.equal(el.calls.filter((c) => c === "load").length, loadsBefore,
    "two slices of one episode must not refetch it");
  assert.ok(el.currentTime >= 300 && el.currentTime < 301, `second in-point, got ${el.currentTime}`);

  // A phone call mid-slice must not replay the slice.
  await m.interruptionBegan();
  const pausedAt = el.currentTime;
  await m.interruptionEnded(true);
  assert.equal(m.state.type, "playing");
  assert.ok(el.currentTime >= pausedAt - 0.05, `resumed at ${el.currentTime}, was at ${pausedAt}`);

  // Slice 2 -> slice 3: different episode, so a real load.
  assert.ok(await waitForPlaying(m, "f1#2"), `never reached slice 3 (state ${m.state.type})`);
  assert.equal(el.src, "https://cdn.example/b.mp3");
  assert.ok(el.currentTime >= 50 && el.currentTime < 51);

  // ...and the Foray ends rather than rolling into anything.
  let deadline = now() + END_BUDGET_MS;
  while (m.state.type !== "ended" && now() < deadline) await sleep(5);
  assert.equal(m.state.type, "ended");
  assert.equal(el.paused, true);
  m.dispose();
});

/* ---------- prefetch: two elements, one audio session ----------

   Everything below is about the seam measured in run 32036295743: a 2.0 s beat
   that the listener experienced as 9,153 ms, all of it the media load, because
   the load ran after the boundary had paused the element and silenced the page.

   NO WALL-CLOCK BUDGETS IN HERE. Not one. The whole section is driven by hand —
   `currentTime` is assigned and `timeupdate` is fired by the test — so every
   assertion is a one-sided fact or an ordering, and a starved box cannot change
   any of them. `PREFETCH_LEAD_SEC` is imported and compared against, never
   re-stated as a number. */

import { PREFETCH_LEAD_SEC } from "./html-audio-backend.js";

/** Two fakes that record into ONE ordering log, because the load-bearing claims
    are about the sequence ACROSS the pair — "the outgoing element was paused
    before the incoming one played" is not observable on either alone.

    `paused`, `playing` and `pause` are modelled here and not in `FakeAudio`
    because this is the first section that needs them: a handover turns on which
    element is paused, and `_notePause`/`_handoverUnproven` react to the events. */
class PairAudio extends FakeAudio {
  constructor(name, pairLog, opts = {}) {
    super(opts);
    this.name = name;
    this.pairLog = pairLog;
    this.paused = true;
    /** Refuse to play, the way autoplay policy refuses an element that has
        never been touched by a gesture. A refused play fires no `playing`. */
    this.refuse = Boolean(opts.refuse);
    /** Defer the seek, so `canplay` can arrive while the playhead is still at
        the head of the file — the case that would start the next segment at
        0:00 of somebody else's episode if "ready" were read off `canplay`. */
    this.laggySeek = Boolean(opts.laggySeek);
    this._pendingSeek = null;
  }
  get currentTime() { return this._time ?? 0; }
  set currentTime(v) {
    if (this.laggySeek) { this._pendingSeek = v; return; }
    this._time = v;
  }
  /** Land a seek this element deferred. */
  settleSeek() {
    if (this._pendingSeek != null) this._time = this._pendingSeek;
    this._pendingSeek = null;
    this._fire("seeked");
    this._fire("canplay");
  }
  load() { this.pairLog.push(`${this.name}:load`); super.load(); }
  play() {
    this.pairLog.push(`${this.name}:play`);
    this.calls.push("play");
    if (this.refuse) {
      return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    }
    this.paused = false;
    this._fire("playing");
    return Promise.resolve();
  }
  pause() {
    this.pairLog.push(`${this.name}:pause`);
    this.calls.push("pause");
    this.paused = true;
    this._fire("pause");
  }
  removeAttribute(a) { this.pairLog.push(`${this.name}:drop`); super.removeAttribute(a); }
  /** Advance the playhead and deliver the tick a decoder would. */
  tickTo(t) { this._time = t; this._fire("timeupdate"); }
}

function pair({ a: aOpts = {}, warm: wOpts = {} } = {}) {
  const pairLog = [];
  const a = new PairAudio("A", pairLog, aOpts);
  const w = new PairAudio("B", pairLog, wOpts);
  const log = [];
  const b = new HtmlAudioBackend({ element: a, warmElement: w, telemetry: (m) => log.push(m) });
  const ends = [];
  b.onItemEnded = (r) => ends.push(r ?? "natural");
  return { a, w, b, log, ends, pairLog };
}

const A_URL = "https://cdn.example/a.mp3";
const B_URL = "https://cdn.example/b.mp3";
const C_URL = "https://cdn.example/c.mp3";
/** Drain microtasks — a warm load settles across a couple of them. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

/* ---- the capability, and its absence ---- */

test("with no second element prefetch is unavailable and every path is unchanged", async () => {
  // Every pre-existing test in this file runs in exactly this configuration,
  // which is why they are all still valid: without a warm element the backend
  // is the one-element backend it has always been.
  const { b, el } = mk();
  assert.equal(b.canPrefetch, false);
  assert.match(b.prefetchOffReason ?? "", /no second element/);
  assert.equal(b.prefetch(item("b", B_URL), { startOffset: 12 }), false);
  await b.load(item("a", A_URL));
  assert.equal(el.src, A_URL, "the ordinary load must still work");
});

/* ---- warming ---- */

test("prefetch loads the next episode on the OTHER element, leaving the player alone", async () => {
  const { b, a, w } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  const playerLoads = a.calls.filter((c) => c === "load").length;

  assert.equal(b.prefetch(item("b", B_URL), { startOffset: 12 }), true);
  await settle();

  assert.equal(w.src, B_URL);
  assert.equal(w.currentTime, 12, "the warm element is parked at the next in-point");
  assert.equal(a.calls.filter((c) => c === "load").length, playerLoads, "the player element must not reload");
  assert.equal(a.src, A_URL);
  assert.equal(b.warmState?.ready, true);
});

test("the warm element is NEVER played — one element owns the audio session", async () => {
  // The iOS failure this rules out: a second element that begins playing takes
  // the audio session and silences the first, and a foreground test never shows
  // it. So the invariant is asserted over a whole warm-and-hand-over cycle.
  const { b, a, w } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  // Precondition, or this asserts nothing: a prefetch that did not happen
  // trivially never played anything.
  assert.equal(w.src, B_URL, "precondition: the warm element really is loaded");
  assert.deepStrictEqual(w.calls.filter((c) => c === "play"), [], "the warm element must never be played");
  assert.equal(w.paused, true);
  assert.equal(a.paused, false, "and the player must still be the one making sound");
});

test("a warm element is ready only at the in-point, never on canplay for the file's head", async () => {
  // Reading "ready" off `canplay` would hand over an element sitting at 0:00 of
  // somebody else's episode — the seam would be gone and replaced by something
  // far worse than a slow one.
  const { b } = pair({ warm: { laggySeek: true } });
  await b.load(item("a", A_URL));
  b.prefetch(item("b", B_URL), { startOffset: 900 });
  await settle();
  assert.equal(b.warmState?.ready, false, "canplay alone must not mean ready");

  b._warmEl.settleSeek();
  await settle();
  assert.equal(b.warmState?.ready, true, "and once the playhead is at the in-point, it is");
});

test("a next segment in the SAME episode is refused — the seek shortcut already covers it", async () => {
  // 15 of Foray #1's 31 seams stay inside one episode. Warming those would
  // refetch a whole podcast to reach a position the element already holds, and
  // on an ad-stitched host the refetch can come back differently stitched.
  const { b, w, log } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  assert.equal(b.prefetch(item("a2", A_URL), { startOffset: 300 }), false);
  assert.equal(w.src, "", "the warm element must not have been touched");
  assert.ok(log.some((l) => /prefetch\.skipped .*same episode/.test(l)));
});

test("a warm load that errors is not fatal and does not stand warming down", async () => {
  const { b, log } = pair({ warm: { failWith: 4 } });
  await b.load(item("a", A_URL));
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  assert.ok(log.some((l) => /prefetch\.failed/.test(l)));
  assert.equal(b.canPrefetch, true, "one bad episode is not a broken mechanism");
});

/* ---- the handover ---- */

test("a boundary hands over to the warm element instead of loading anything", async () => {
  const { b, a, w } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  const warmLoads = w.calls.filter((c) => c === "load").length;

  await b.load(item("b", B_URL), { startOffset: 12 });

  assert.equal(b.el, w, "the warm element is now the player");
  assert.equal(b.currentTime, 12, "already at the in-point");
  assert.equal(w.calls.filter((c) => c === "load").length, warmLoads, "no load happened at the boundary");
  assert.equal(a.paused, true);
});

test("the outgoing element is paused BEFORE the incoming one plays, never both at once", async () => {
  const { b, a, w, pairLog } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  await b.load(item("b", B_URL), { startOffset: 12 });
  assert.equal(a.paused, true, "the outgoing element must be paused by the time the swap is done");
  b.play();

  const pausedA = pairLog.lastIndexOf("A:pause");
  const playedB = pairLog.lastIndexOf("B:play");
  assert.ok(pausedA >= 0 && playedB >= 0, `expected both events, got ${pairLog.join(" ")}`);
  assert.ok(pausedA < playedB, `A must be paused before B plays: ${pairLog.join(" ")}`);
});

test("the demoted element's buffer is dropped rather than left decoding", async () => {
  const { b, a } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });
  assert.ok(a.calls.includes("removeAttribute:src"), "the demoted element must let go of its buffer");
});

test("a handover carries the rate and the duck onto the element that inherits the role", async () => {
  // Neither survives the swap on its own, and a duck that silently reset to 1.0
  // on the next segment would be a bug with no visible cause.
  const { b, w } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.setRate(1.5);
  b.setVolume(0.3);
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });
  b.play();
  assert.equal(w.volume, 0.3, "the duck must follow the role");
  assert.equal(w.playbackRate, 1.5, "and so must the rate");
});

test("an out-point armed after a handover still fires — the watch moved with the role", async () => {
  // THE regression that would be worse than the bug being fixed. A missed
  // out-point runs a median 936.5 s of the wrong episode. If the element's
  // listeners were stranded on the demoted element, this is where it shows.
  const { b, w, ends } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });
  b.play();
  b.setOutPoint(20);

  w.tickTo(19);
  assert.deepStrictEqual(ends, [], "not early");
  w.tickTo(20.01);
  assert.deepStrictEqual(ends, ["outPoint"], "the boundary must land on the promoted element");
  assert.equal(w.paused, true);
});

test("a surface's own listeners survive a handover", async () => {
  // `player/client.js` repaints off `timeupdate`. Attached to one element
  // directly, it would stop repainting for the rest of the Foray at the first
  // cross-episode seam.
  const { b, w } = pair();
  let paints = 0;
  b.addMediaListener("timeupdate", () => { paints++; });
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });

  w.tickTo(13);
  assert.ok(paints > 0, "the surface must still hear the element that is now playing");
});

/* ---- losing the race: this is the case that must not regress ---- */

test("a warm load that has not finished by the boundary falls back to the ordinary load", async () => {
  const { b, a, w } = pair({ warm: { laggySeek: true } });
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 900 });
  await settle();
  assert.equal(b.warmState?.ready, false, "precondition: the warm load has not finished");

  await b.load(item("b", B_URL), { startOffset: 900 });

  assert.equal(b.el, a, "the player element must not change when the race is lost");
  assert.equal(a.src, B_URL, "the boundary loads it the way it always has");
  assert.equal(b.warmState, null, "and the warm element is left holding nothing");
  assert.equal(w.src, "");
});

test("a warm element ready for a DIFFERENT item is discarded, never promoted", async () => {
  // The "next segment starts mid-word" failure: a listener who skips must not
  // inherit a buffer warmed for the segment they skipped past.
  const { b, a } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  await b.load(item("c", C_URL), { startOffset: 40 });
  assert.equal(b.el, a, "no handover for an item nobody warmed");
  assert.equal(a.src, C_URL);
  assert.equal(b.warmState, null);
});

test("a warm element at the wrong OFFSET of the right episode is not promoted", async () => {
  const { b, a } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  await b.load(item("b2", B_URL), { startOffset: 600 });
  assert.equal(b.el, a, "same episode, wrong in-point: that is not the segment we warmed");
});

/* ---- the two safety nets ---- */

test("a promoted element that refuses to play falls back to the one holding the gesture", async () => {
  /* Autoplay policy is per ELEMENT, and the element the listener tapped is the
     other one. In the Capacitor shells this cannot happen; in the web PWA
     exactly one handover per session is exposed. Reporting an error would stop
     the Foray, and a listener with a locked screen cannot tap — so this must
     degrade to today's behaviour instead, and keep the boundary. */
  const { b, a, w, log } = pair({ warm: { refuse: true } });
  let reported = null;
  b.onError = (m) => { reported = m; };

  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });
  b.setOutPoint(20);
  b.play();          // refused by the promoted element
  await settle();

  assert.equal(reported, null, "a recoverable refusal must not reach the manager's degrade path");
  assert.equal(b.el, a, "the element that holds the gesture is the player again");
  assert.equal(a.src, B_URL, "and it loaded the segment the listener was owed");
  assert.equal(b.outPoint, 20, "the boundary MUST survive the recovery");
  assert.equal(a.paused, false, "audio is running again");
  assert.equal(b.canPrefetch, false, "and warming is off for the rest of the session");
  assert.ok(log.some((l) => /handover\.refused/.test(l)));
  assert.equal(w.paused, true);
});

test("a refusal on the fallback element is a real error and is reported", async () => {
  // Recovery happens once. A second refusal is the ordinary autoplay failure
  // this backend has always surfaced, and it must not loop.
  const { b, log } = pair({ a: { refuse: true }, warm: { refuse: true } });
  let reported = null;
  b.onError = (m) => { reported = m; };
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  await b.load(item("b", B_URL), { startOffset: 12 });
  b.play();
  await settle();
  assert.match(reported ?? "", /NotAllowedError/);
  assert.ok(log.some((l) => /handover\.refused/.test(l)));
});

test("playback stopping while a prefetch is in flight stands warming down for good", async () => {
  // On iOS, losing the audio session looks exactly like an unexplained `pause`,
  // and a second element loading media while the first plays is the one thing
  // warming could plausibly cause. We cannot prevent it and must not resume
  // through it — a phone call arrives the same way — so it becomes a recorded
  // failure and warming stops.
  const { b, a, log } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  a._fire("pause");   // nobody asked for this
  assert.equal(b.canPrefetch, false);
  assert.ok(log.some((l) => /pausedUnexpectedly/.test(l)));
  assert.equal(b.warmState, null);
});

test("the player's OWN pause at the boundary does not stand warming down", async () => {
  // The out-point pauses the element at every seam, with a prefetch normally in
  // flight. A detector that could not tell that apart would switch itself off
  // on the first healthy seam and this whole feature would be dead code.
  const { b, a } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.play();
  b.setOutPoint(120);
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();

  a.tickTo(120.01);            // the boundary lands, and pauses the element
  assert.equal(b.canPrefetch, true, "our own boundary pause must not read as a lost session");
});

test("release lets go of the warm element's buffer too", async () => {
  const { b, w } = pair();
  await b.load(item("a", A_URL), { startOffset: 100 });
  b.prefetch(item("b", B_URL), { startOffset: 12 });
  await settle();
  b.release();
  assert.ok(w.calls.includes("removeAttribute:src"), "a released backend must not leave a warm buffer decoding");
  assert.equal(b.canPrefetch, false);
});

/* ---- the window: WHEN warming starts ---- */

test("the window opens inside the lead, stays shut outside it, and fires once per boundary", async () => {
  const { b, a } = pair();
  let windows = 0;
  b.onPrefetchWindow = () => { windows++; };
  await b.load(item("a", A_URL), { startOffset: 0 });
  b.play();

  b.setOutPoint(1000);
  a.tickTo(1000 - PREFETCH_LEAD_SEC - 1);
  assert.equal(windows, 0, "outside the lead, nothing is warmed and no bandwidth is spent");

  a.tickTo(1000 - PREFETCH_LEAD_SEC + 1);
  assert.equal(windows, 1, "inside the lead, exactly one notification");
  a.tickTo(1000 - PREFETCH_LEAD_SEC + 2);
  a.tickTo(1000 - PREFETCH_LEAD_SEC + 3);
  assert.equal(windows, 1, "once per boundary, not once per tick");
});

test("the lead is WALL clock, so a faster rate opens the window earlier in the episode", async () => {
  // The load takes wall clock, not content. At 2x, `PREFETCH_LEAD_SEC` of wall
  // clock is twice as much of the episode.
  const { b, a } = pair();
  let windows = 0;
  b.onPrefetchWindow = () => { windows++; };
  await b.load(item("a", A_URL), { startOffset: 0 });
  b.play();
  b.setOutPoint(1000);

  const justOutsideAt1x = 1000 - PREFETCH_LEAD_SEC - 2;
  a.tickTo(justOutsideAt1x);
  assert.equal(windows, 0, "precondition: at 1x this playhead is outside the lead");

  a.playbackRate = 2;
  a.tickTo(justOutsideAt1x + 0.01);
  assert.equal(windows, 1, "at 2x the same distance is half the wall clock, so the window is open");
});

test("a paused element opens no window — nothing is approaching a boundary", async () => {
  const { b, a } = pair();
  let windows = 0;
  b.onPrefetchWindow = () => { windows++; };
  await b.load(item("a", A_URL), { startOffset: 0 });
  b.setOutPoint(1000);
  assert.equal(a.paused, true, "precondition: never played");
  a.tickTo(999);
  assert.equal(windows, 0);
});

test("a window handler that throws cannot take the audio down with it", async () => {
  const { b, a, ends } = pair();
  b.onPrefetchWindow = () => { throw new Error("surface bug"); };
  await b.load(item("a", A_URL), { startOffset: 0 });
  b.play();
  b.setOutPoint(1000);
  a.tickTo(999);
  a.tickTo(1000.01);
  assert.deepStrictEqual(ends, ["outPoint"], "the out-point still lands");
});
