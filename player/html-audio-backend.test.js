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
  /* Record every delivered tick AND the playhead it delivered. This is the naive
     implementation's clock — the thing the fine timer has to beat — measured
     under the load in the room rather than assumed from TIMEUPDATE_MS. The
     playhead matters as much as the timestamp: a bare timeupdate check stops on
     the first tick whose `currentTime` has reached the boundary, so those are
     exactly the values it would have seen. */
  const ticks = [];
  const fire = el._fire.bind(el);
  el._fire = (type, ...rest) => {
    if (type === "timeupdate") ticks.push({ at: now(), t: el.currentTime });
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
  return { el, b, log, ends, ticks };
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
   green run costs the same however large it is, and only a broken build pays.

   ── and then the comparative budget was still flaky, and the reason is the
      real lesson of this file ────────────────────────────────────────────────

   It reddened CI at random for a day after #195 — observed by four separate
   sessions, twice as a bare `FAILED (1): node --test` on the root group that
   passed on the next two runs. Reproduced at 1 run in 12 under 16 busy loops on
   16 cores, and 6 runs in 10 under 32. The product is identical in both columns,
   which is most of the proof that the test was measuring the box.

   Two bugs were found and fixed first, and they were real:

   1. **The comparison was not within one run.** It took `Math.min` of the naive
      cost across the four phase-sweep runs and `Math.max` of the overshoot
      across the same four — budget from the least-loaded run, measurement from
      the most-loaded.
   2. **The naive cost fell back to the NOMINAL tick** when a run delivered fewer
      than two ticks, which is exactly what a slow box does, so the fallback
      reinstated the magic number in the one case where it was certain to be too
      small.

   **Fixing both was not enough, and that is the point.** Pairing per run still
   failed 6 runs in 10 at 32 busy loops, and asserting measurability instead of
   falling back merely converted a wrong budget into a loud failure — it made the
   whole root group RED 4 runs in 8, because `node --test` already runs 32 suites
   in parallel and starves itself. Measured cause: the widest delivered tick
   interval reached **1,825 ms against a nominal 250 ms**, while the fine timer's
   own wake was late by a different and uncorrelated amount.

   A ratio between two INDEPENDENTLY SCHEDULED OS TIMERS cannot be asserted
   under arbitrary load, however carefully it is paired. Both timers stretch, but
   not together, and the tail is where CI lives.

   So the budget is gone rather than widened, and the claims were split by what
   each one actually needs:

   - **Real clock, asserted:** only ONE-SIDED facts — the boundary fired, and it
     was not early. A late OS timer cannot break either; only a wrong
     implementation can. These hold on any box under any load.
   - **Real clock, measured and reported as a diagnostic:** how the overshoot
     compared to what a bare timeupdate check would have cost in that same run,
     computed from the ticks actually delivered (`naiveOvershootSec`) rather than
     from a tick-interval proxy. Worth printing on every run; not worth failing a
     build over.
   - **No clock at all, asserted, and this is where the teeth are:** that the
     fine timer is armed, for the right delay, scaled by rate — and that its wake
     is what stops the item, while an early wake reschedules instead. Disable the
     fine stage and SIX of those fail, in well under a second. See "the boundary's
     below.

   The rule that survives, and it generalises past this file: **a test may assert
   an ordering or a decision on a real clock, but not a duration.** If the
   assertion would change verdict because another process got busy, it is
   measuring the box. Move it to a driven clock, or demote it to a diagnostic. */

/** Ceiling for "an end was reported". Was 3-4 s, which a saturated box beats.
    Not larger, because ten of these in a row is what a broken out-point costs
    before the suite reports it, and there is no `--test-timeout` above us. */
const END_BUDGET_MS = 10000;

/** What a bare `if (currentTime >= end) stop()` on `timeupdate` would have cost
 *  IN THIS RUN, in seconds of content — the naive implementation the fine timer
 *  exists to beat, measured from the ticks this run actually delivered rather
 *  than modelled from TIMEUPDATE_MS.
 *
 *  A naive check can only stop ON a tick, so its overshoot is the playhead at the
 *  first tick to reach the boundary, minus the boundary.
 *
 *  Returns **null** when no delivered tick ever reached the boundary. That is the
 *  healthy case rather than a measurement failure: reaching the boundary clears
 *  the element's interval, so "no tick saw it" means the fine timer got there
 *  first and beat the naive check by more than this run can quantify.
 *
 *  This replaces a proxy — the widest gap between consecutive ticks, times a
 *  fraction — which is what made this file flaky. See the section header. */
function naiveOvershootSec(ticks, target) {
  for (const { t } of ticks) if (t >= target) return t - target;
  return null;
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
  /* The one-sided guarantee. The fine timer is a prediction; it only ever stops
     on a re-read of the real playhead.

     THIS TEST WAS FULLY VACUOUS until 2026-08-17, and the way it failed is worth
     keeping written down because all three holes are the same species. Neuter
     `_reachOutPoint` so the boundary never stops anything at all and it still
     PASSED, in 30 seconds:

       - `await waitForEnd(ends)` discarded its return value, so "the boundary
         never fired" was indistinguishable from success;
       - `currentTime >= target` is satisfied by a playhead that simply ran FREE
         past the boundary — after the 10 s ceiling the element sits at ~110,
         which is comfortably past 100.4;
       - `lastOutPointOvershootSec >= 0` starts as `null`, and `null >= 0` is
         **true**.

     Each one turned an absence into a pass. `assertBoundaryHeld` was written to
     close exactly these and this test was left behind, so it uses the helper
     now — which also means a broken build reports in about a second instead of
     burning 30 s to report green. */
  for (const target of [100.4, 100.75, 101.1]) {
    const { el, b, ends, ticks } = ticking();
    await b.load(item("seg"), { startOffset: 100 });
    b.setOutPoint(target);
    b.play();
    const reason = await waitForEnd(ends);
    assertBoundaryHeld({ target, rate: 1, reason, el, ticks, overshoot: b.lastOutPointOvershootSec });
  }
});

/** Where to put the boundary, as WALL-CLOCK seconds after the in-point, spread
    ACROSS a tick interval on purpose. A naive check can only fire ON a tick, so
    its error is however far the boundary sits past the last one — which means a
    single target can make a naive implementation look good by luck of alignment.
    Measured: with the fine watch disabled and a lone target of 100.7, the
    overshoot was 50 ms and the old version of this test passed a genuinely broken
    build. Sweeping the phase exercises the naive worst case.

    Wall clock rather than content seconds so the sweep still spans a whole tick
    at 2x, where content seconds would buy half the runway. */
const PHASE_SWEEP_WALL_SEC = [0.70, 0.76, 0.82, 0.88];

/** Drive one boundary to completion on a real clock. */
async function measureBoundary(wallSec, rate) {
  const target = 100 + wallSec * rate; // content seconds from the in-point
  const { el, b, ends, ticks } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  if (rate !== 1) b.setRate(rate);
  b.setOutPoint(target);
  b.play();
  const reason = await waitForEnd(ends);
  return { target, rate, reason, el, ticks, overshoot: b.lastOutPointOvershootSec };
}

/** The load-invariant half of a real-clock boundary run, asserted; the
 *  comparative half, measured and returned for the caller to report.
 *
 *  WHAT IS ASSERTED IS ONE-SIDED ON PURPOSE. "It fired" and "it was not early"
 *  cannot be broken by a late OS timer, only by a wrong implementation, so they
 *  are safe to assert on any box under any load. A RATIO between the fine timer
 *  and the tick interval is not: they are two independently scheduled OS timers,
 *  and starving the box decorrelates them at the tail. See the section header for
 *  the measurements that settled this.
 *
 *  The tightness claim still has teeth — they are in the clock-free tests below,
 *  where disabling the fine watch fails six of them outright. */
function assertBoundaryHeld(r) {
  // The boundary must actually FIRE. Without this the whole test is vacuous:
  // `lastOutPointOvershootSec` starts as null, and `null < anything` is true.
  assert.equal(r.reason, "outPoint", `the out-point at ${r.target} never fired at ${r.rate}x`);
  assert.equal(typeof r.overshoot, "number", "and it must record what the stop cost");
  // Never early, at any rate, under any load — the payoff is never clipped.
  assert.ok(
    r.el.currentTime >= r.target,
    `stopped at ${r.el.currentTime} before ${r.target} (${r.rate}x) — the payoff was clipped`
  );
  return naiveOvershootSec(r.ticks, r.target);
}

/* These two are named for what they ASSERT, not for what they print. They used to
   be called "the boundary beats a bare timeupdate check" — which is still the
   claim the file makes, and still measured on every run, but it is now asserted
   by the clock-free tests below rather than here. A test name that promises more
   than its assertions deliver is the same failure the FLOORS in
   test/suite-integrity.test.js exist to prevent: it reads as coverage. */

test("on a real clock the boundary fires and never clips, at every phase of a tick", async (t) => {
  // Measured on an idle box the overshoot is 5-15 ms against a ~250 ms tick, and
  // no tick ever observes the boundary at all — the fine timer gets there first,
  // which is the whole point of it existing.
  let decisive = 0;
  for (const wallSec of PHASE_SWEEP_WALL_SEC) {
    const r = await measureBoundary(wallSec, 1);
    const naive = assertBoundaryHeld(r);
    if (naive === null) decisive++;
    t.diagnostic(
      `boundary ${r.target.toFixed(2)}: overshoot ${(r.overshoot * 1000).toFixed(0)}ms vs a bare ` +
      `timeupdate check's ${naive === null ? "(no tick ever saw the boundary)" : `${(naive * 1000).toFixed(0)}ms`}` +
      ` — ${r.ticks.length} ticks delivered`
    );
  }
  t.diagnostic(`the fine timer beat the tick outright in ${decisive}/${PHASE_SWEEP_WALL_SEC.length} runs`);
});

test("on a real clock the boundary fires and never clips at 2x either", async (t) => {
  // At 2x one timeupdate is half a second of CONTENT — a whole sentence. What is
  // asserted here is only what a real clock can show and load cannot break: the
  // boundary fires at 2x and does not stop short. That the fine timer's CONTENT
  // window stays flat as the rate rises is proved as arithmetic below, with no
  // clock, which is where that claim belongs.
  const r = await measureBoundary(0.82, 2);
  const naive = assertBoundaryHeld(r);
  t.diagnostic(
    `2x boundary ${r.target.toFixed(2)}: overshoot ${(r.overshoot * 1000).toFixed(0)}ms vs a bare ` +
    `timeupdate check's ${naive === null ? "(no tick ever saw the boundary)" : `${(naive * 1000).toFixed(0)}ms`}`
  );
});

/* ---------- the boundary's ARITHMETIC, with no clock at all ----------

   Everything above measures a real scheduler, which is the only way to claim the
   boundary is tight on a real box. It also means every budget above is a claim
   about the SCHEDULER, and a loaded scheduler is late — which is why those tests
   now compare only numbers gathered in the same run.

   The tests below need no clock at all, because the rate claim is not really
   about a race: it is about the delay the backend ARMS its fine timer for. The
   fine timer is scheduled for (end - now) / rate seconds of WALL clock, so
   doubling the rate halves the wait and the CONTENT a late wake can spill stays
   flat. That is arithmetic. Asserting it against a real clock is what made the
   old version of this claim fail under load; read the decision instead.

   Same instinct as #196's injectable seam scheduler — drive the seam, do not
   race it — but achieved by capturing `setTimeout`, exactly as the "every
   deadline is ref'd" test above already does, so no product code has to grow an
   injection point for it. */

/** An <audio> stand-in whose playhead moves only when the test moves it: no
    interval, no wall clock, `currentTime` is exactly what was last written. */
class SteppedAudio {
  constructor({ at = 0, rate = 1, durationSec = 3600 } = {}) {
    this.listeners = new Map();
    this.src = ""; this.currentSrc = "";
    this.duration = durationSec;
    this.playbackRate = rate;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 4;
    this.error = null;
    this.paused = false; // already rolling, so the fine watch is allowed to arm
    this.calls = [];
    this.playResult = Promise.resolve();
    this._at = at;
  }
  get currentTime() { return this._at; }
  set currentTime(v) { this._at = v; this._fire("seeked"); }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  _fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }
  load() { this.calls.push("load"); this.currentSrc = this.src; }
  play() { this.calls.push("play"); this.paused = false; return this.playResult; }
  pause() { this.calls.push("pause"); this.paused = true; }
  removeAttribute(a) { this.calls.push(`removeAttribute:${a}`); this.src = ""; }
}

/** Every wall-clock delay the backend asks for while arming a boundary at
    `outPoint`, with the playhead standing at `at` and the element at `rate`.
    No timer is ever created, so nothing can fire and nothing leaks. */
function armedFineDelaysMs({ at, outPoint, rate }) {
  const el = new SteppedAudio({ at, rate });
  const realSetTimeout = globalThis.setTimeout;
  const asked = [];
  globalThis.setTimeout = (fn, ms) => { asked.push(ms); return { hasRef: () => true }; };
  try {
    const b = new HtmlAudioBackend({ element: el });
    b.setOutPoint(outPoint); // arms the fine watch directly while not paused
    return asked;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/* The numbers below use dyadic content gaps (0.5 s, 0.75 s) and power-of-two
   rates so that (end - now) / rate is EXACT in binary and the expected
   millisecond is not a rounding coin-flip. Do not "tidy" them to 100.4 and 1.5x:
   100.4 - 100 is 0.40000000000000568, which Math.ceil turns into 401, not 400 —
   which would turn an exact assertion back into a flaky one. */

test("the fine timer is armed in wall clock, so a faster rate shortens the wait", () => {
  // 0.5 s of CONTENT to go, at four rates. The wall clock remaining halves each
  // time the rate doubles; the content it guards does not move.
  const at = 100, outPoint = 100.5;
  assert.deepStrictEqual(armedFineDelaysMs({ at, outPoint, rate: 1 }), [500]);
  assert.deepStrictEqual(armedFineDelaysMs({ at, outPoint, rate: 2 }), [250]);
  assert.deepStrictEqual(armedFineDelaysMs({ at, outPoint, rate: 4 }), [125]);
  assert.deepStrictEqual(armedFineDelaysMs({ at, outPoint, rate: 8 }), [63], "62.5 ms, rounded up");
});

test("a faster rate does not loosen the boundary: armed wall time x rate is constant", () => {
  // The claim itself, as one identity, with no clock in it. Whatever the rate,
  // the fine timer wakes after the SAME amount of CONTENT — so the window in
  // which a late wake could spill the next speaker's first words does not widen
  // as the listener speeds up. A bare timeupdate check has no such property: its
  // window is one tick of WALL clock, which is `rate` times as much content.
  for (const rate of [1, 2, 4, 8]) {
    const [ms] = armedFineDelaysMs({ at: 100, outPoint: 100.5, rate });
    const contentMs = ms * rate;
    // Rounding the wall delay up to a whole millisecond costs at most 1 ms of
    // wall clock, which is `rate` ms of content.
    assert.ok(
      Math.abs(contentMs - 500) <= rate,
      `at ${rate}x the fine timer guards ${contentMs}ms of content, not ~500ms`
    );
  }
});

test("the fine watch stays out of the way until the boundary is within the lead", () => {
  // It is deliberately NOT armed a whole segment early: timeupdate is free and
  // already firing, and a fine timer armed minutes out would just be rescheduled
  // hundreds of times. The lead is 0.5 s of WALL clock, so the rate changes WHEN
  // arming happens — not how tight the boundary ends up being.
  assert.deepStrictEqual(
    armedFineDelaysMs({ at: 100, outPoint: 100.75, rate: 1 }), [],
    "0.75 s of wall clock out — timeupdate's job, not the fine timer's"
  );
  assert.deepStrictEqual(
    armedFineDelaysMs({ at: 100, outPoint: 100.75, rate: 2 }), [375],
    "the same boundary at 2x is 0.375 s of wall clock out, so it arms"
  );
  assert.deepStrictEqual(
    armedFineDelaysMs({ at: 100, outPoint: 100.5, rate: 1 }), [500],
    "a boundary exactly at the lead still arms"
  );
});

test("an out-point already behind the playhead arms no timer, at any rate", () => {
  /* The disarmed half of the scrub-past policy, asserted without waiting on a
     clock to fail to fire — which is the only way to tell "correctly disarmed"
     from "the timer just has not gone off yet".

     ITS POSITIVE CONTROL IS ITS SIBLINGS, and that is worth stating: `[]` is also
     what a completely disabled fine stage returns, so this test alone passes under
     that regression. What distinguishes the two is that the tests above assert
     NON-empty arming for the same helper — so a disabled fine stage reddens them
     while this one stays green, and the pair is unambiguous. Do not delete this
     one's siblings and leave it; on its own it proves nothing.

     Not merely `[]` by arithmetic accident either: with the arm gate removed the
     remaining distance is negative, which is not `> 0.5`, so the helper would
     return `[4]` (the timer floor) rather than `[]`. The assertion discriminates. */
  for (const rate of [1, 2, 4]) {
    assert.deepStrictEqual(
      armedFineDelaysMs({ at: 200, outPoint: 100.5, rate }), [],
      `${rate}x: the playhead is past it, so there is no crossing to wait for`
    );
  }
});

/** Arm a boundary and hand back the fine timer's callback, so a test can wake it
    itself. Nothing is ever scheduled: the "timer" is the returned function.

    The capture has to be re-installed around `wake()` as well as around the
    arming, because waking re-schedules — restoring the real `setTimeout` too
    early lets the reschedule escape into a live timer and reports the stale
    delay. (Which it did, first time round.) */
function armed({ at, outPoint, rate = 1 }) {
  const el = new SteppedAudio({ at, rate });
  const realSetTimeout = globalThis.setTimeout;
  const asked = [];
  const log = [];
  let pending = null;
  const stub = (fn, ms) => { asked.push(ms); pending = fn; return { hasRef: () => true }; };
  const capture = (body) => {
    globalThis.setTimeout = stub;
    try { return body(); } finally { globalThis.setTimeout = realSetTimeout; }
  };
  const ends = [];
  const b = capture(() => {
    const backend = new HtmlAudioBackend({ element: el, telemetry: (m) => log.push(m) });
    backend.onItemEnded = (reason) => ends.push(reason ?? "natural");
    backend.setOutPoint(outPoint);
    return backend;
  });
  return {
    el, b, ends, asked, log,
    /** Fire the pending fine timer. Everything here is synchronous, so nothing
        else can arm a timer inside the capture window. */
    wake: () => capture(() => {
      if (typeof pending !== "function") {
        throw new Error("wake() called with no fine timer armed — the test's premise is wrong");
      }
      const fn = pending; pending = null; fn();
    }),
    armedMs: () => asked[asked.length - 1],
    armCount: () => asked.length,
  };
}

test("the fine timer, not the next timeupdate, is what stops the item", () => {
  /* THE TEETH. The wall-clock tests above can only observe that the stop was
     early enough; this shows WHAT stopped it, and needs no clock to do it. Not a
     single `timeupdate` is fired here, so if the fine stage were disabled — the
     regression the comparative test was built to catch, measured at 90-133 ms
     against a 250 ms tick — nothing would stop at all and this fails outright. */
  const a = armed({ at: 100, outPoint: 100.5 });
  assert.equal(a.armedMs(), 500, "the fine timer must be armed in the first place");
  assert.deepStrictEqual(a.ends, [], "and nothing may fire before it wakes");

  a.el._at = 100.5;  // the playhead reaches the boundary...
  a.wake();          // ...and the fine timer wakes, with no tick involved

  assert.deepStrictEqual(a.ends, ["outPoint"], "the fine wake must stop the item");
  assert.equal(a.el.paused, true, "and pause it, like a file running out");
  assert.equal(a.b.lastOutPointOvershootSec, 0, "at the boundary exactly, given an exact playhead");
});

test("an early fine wake reschedules instead of stopping short", () => {
  // The one-sided guarantee, as a decision rather than a race: the fine timer is
  // a PREDICTION, so it re-reads the playhead and only stops if the boundary is
  // genuinely reached. Waking early must cost a reschedule, never a clipped
  // payoff — and the reschedule must be for the remaining distance.
  const a = armed({ at: 100, outPoint: 100.5 });
  assert.equal(a.armedMs(), 500);

  // 100.25, not 100.3: dyadic, so the remaining distance is exact in binary and
  // Math.ceil is not a coin-flip. 100.5 - 100.3 is 0.20000000000000284, which
  // rounds up to 201 — this assertion caught exactly that on the first attempt.
  a.el._at = 100.25; // woke early: 0.25 s of content still to go
  a.wake();

  assert.deepStrictEqual(a.ends, [], "must not report an end before the boundary");
  assert.equal(a.el.paused, false, "and must not pause the audio either");
  assert.equal(a.armedMs(), 250, "re-armed for exactly the remaining 0.25 s");
});

test("a frozen playhead stands the fine watch down instead of spinning", () => {
  /* The stall contract, with no clock and no rebuffering simulation: a fine wake
     that finds the playhead exactly where the LAST wake found it is a decoder
     stall, not timer jitter, and rescheduling on it would spin at the 4 ms timer
     floor. The watch hands back to `timeupdate`/`playing`, which cost nothing
     while stalled.

     There is a real-clock version of this below, and it is the one that used to
     flake: it slept 350 ms and then froze the element, with the boundary 600 ms
     of content away — so a starved box reached the boundary legitimately BEFORE
     the stall was applied, and the test then blamed the backend for an end it was
     right to report. This version cannot race, because nothing here advances
     except what the test advances. */
  const a = armed({ at: 100, outPoint: 100.5 });
  assert.equal(a.armedMs(), 500);

  a.el._at = 100.25;   // progress, but not to the boundary: reschedule
  a.wake();
  assert.equal(a.armedMs(), 250, "an early wake WITH progress reschedules");
  assert.equal(a.log.filter((m) => /outPoint\.stalled/.test(m)).length, 0, "and is not a stall");

  const armsBefore = a.armCount();
  a.wake();            // woken again, playhead has NOT moved: a stall
  assert.deepStrictEqual(a.ends, [], "a stall must not report an end — that audio never played");
  assert.equal(a.el.paused, false, "and must not pause");
  assert.equal(
    a.armCount(), armsBefore,
    "the fine watch must arm NOTHING after a no-progress wake — rescheduling here is the spin"
  );
  assert.equal(a.log.filter((m) => /outPoint\.stalled/.test(m)).length, 1, "and it says so, once");
});

test("a buffering stall at the boundary neither stops early nor spins", async () => {
  /* The real-clock companion to "a frozen playhead stands the fine watch down"
     above. That one owns the INVARIANT and cannot race; this one owns the
     end-to-end path — a real rebuffer, on a real interval, resuming for real.

     It used to `await sleep(350)` and then freeze the element, with the boundary
     600 ms of content away. That is a duration assumption in disguise: it needs
     350 ms of sleep to elapse before 600 ms of content does. Measured under 32
     busy loops on 16 cores it broke 2 runs in 10 — the playhead reached the
     boundary first, the backend correctly reported the end, and the test called
     it "an end for audio that never played".

     Now it polls to a CONDITION, and the precondition is asserted separately with
     its own message, so a raced setup says "the setup raced" instead of implicating
     the backend. The fine watch has to be ARMED when the stall lands (that is the
     whole point), and arming happens inside the last 0.5 s of wall clock, so the
     window is inherently bounded — polling every 5 ms is the tightest detection
     available rather than a guess at a sleep length. */
  const { el, b, log, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.9);
  b.play();

  // Into the arm lead (0.5 s of wall clock, so from 100.4) but short of 100.9.
  const deadline = now() + END_BUDGET_MS;
  while (el.currentTime < 100.5 && now() < deadline) await sleep(5);
  assert.ok(
    el.currentTime < 100.9,
    `setup raced: the playhead was at ${el.currentTime} before the stall could be applied, ` +
    `so the boundary had already been reached legitimately. Not a backend fault.`
  );

  el.stall();
  const frozenAt = el.currentTime;
  await sleep(400);

  assert.deepStrictEqual(ends, [], "must not report an end for audio that never played");
  assert.equal(el.currentTime, frozenAt, "sanity: the stall really froze the playhead");
  const stallLogs = log.filter((m) => /outPoint\.stalled/.test(m)).length;
  assert.ok(stallLogs <= 2, `stood down ${stallLogs} times — the fine watch is spinning`);

  el.unstall();
  assert.equal(await waitForEnd(ends), "outPoint", "must resume and still stop at the boundary");
  assert.ok(el.currentTime >= 100.9, `resumed and stopped at ${el.currentTime}`);
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
  // Identity, not tightness: it stopped at the SECOND slice's boundary (100.4)
  // rather than the first's (900.4). The upper bound used to be 101, which was a
  // 0.6 s real-clock overshoot BUDGET in disguise — the exact thing the section
  // header above bans. 410 separates the two boundaries with 300 s to spare and
  // claims nothing about latency.
  assert.ok(el.currentTime >= 100.4 && el.currentTime < 410, `stopped at ${el.currentTime}`);
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
  // Identity again: the second slice's own boundary (400.5), not the first's
  // (100.5). Was `< 401` — a 0.5 s latency budget on a real clock. See above.
  assert.ok(el.currentTime >= 400.5 && el.currentTime < 700, `second slice stopped at ${el.currentTime}`);
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
/*  It also SAMPLES the playhead at the instant the condition holds, and callers
 *  assert on the sample rather than re-reading `el.currentTime` later. That is not
 *  tidiness: these slices are 0.5 s of CONTENT, so a couple of intervening
 *  assertions on a loaded box are enough for the slice to hit its out-point and
 *  the manager to advance — at which point `el.currentTime` is the NEXT segment's
 *  in-point (~50) and an assertion of `>= 300` fails for a player that did
 *  everything right. Sample once, assert on the sample. */
async function waitForPlaying(m, id, el) {
  const deadline = now() + END_BUDGET_MS;
  while (now() < deadline) {
    if (m.state.type === "playing" && m._currentItem()?.id === id) {
      return { ok: true, at: el.currentTime };
    }
    await sleep(5);
  }
  return { ok: false, at: null };
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
  // Identity, not latency: 100 rather than the stale saved 3000, and not slice
  // 2's 300. A tight upper bound here would be a real-clock duration budget.
  assert.ok(el.currentTime >= 100 && el.currentTime < 200, `opened at ${el.currentTime}, wanted the first in-point (100), not the saved 3000`);

  // Slice 1 -> slice 2: same episode, so a seek rather than a refetch — with
  // the seam beat in between, which is silence and not a second load.
  const loadsBefore = el.calls.filter((c) => c === "load").length;
  const slice2 = await waitForPlaying(m, "f1#1", el);
  assert.ok(slice2.ok, `never reached slice 2 (state ${m.state.type})`);
  assert.equal(el.calls.filter((c) => c === "load").length, loadsBefore,
    "two slices of one episode must not refetch it");
  assert.ok(slice2.at >= 300 && slice2.at < 301, `second in-point, got ${slice2.at}`);

  // A phone call mid-slice must not replay the slice.
  await m.interruptionBegan();
  const pausedAt = el.currentTime;
  await m.interruptionEnded(true);
  assert.equal(m.state.type, "playing");
  assert.ok(el.currentTime >= pausedAt - 0.05, `resumed at ${el.currentTime}, was at ${pausedAt}`);

  // Slice 2 -> slice 3: different episode, so a real load.
  const slice3 = await waitForPlaying(m, "f1#2", el);
  assert.ok(slice3.ok, `never reached slice 3 (state ${m.state.type})`);
  assert.equal(el.src, "https://cdn.example/b.mp3");
  assert.ok(slice3.at >= 50 && slice3.at < 51, `third in-point, got ${slice3.at}`);

  // ...and the Foray ends rather than rolling into anything.
  let deadline = now() + END_BUDGET_MS;
  while (m.state.type !== "ended" && now() < deadline) await sleep(5);
  assert.equal(m.state.type, "ended");
  assert.equal(el.paused, true);
  m.dispose();
});
