/* Tests for HtmlAudioBackend (issue #24), against a fake <audio> element that
   reproduces the browser's event ordering.

   The interesting behaviour is all in the ordering — metadata before
   currentTime, seek settling before "ready", rate surviving a load — so the
   fake fires events the way a real element does rather than resolving
   everything immediately. */

import test from "node:test";
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

const ticking = (opts = {}) => {
  const el = new TickingAudio(opts);
  const log = [];
  // A short load deadline so the stall cases cost milliseconds, not the ten
  // real seconds the shipped default allows a slow CDN. The deadline itself is
  // ref'd in production and here — that is the point of the tests below.
  const b = new HtmlAudioBackend({
    element: el, telemetry: (m) => log.push(m), loadTimeoutMs: opts.loadTimeoutMs ?? 200,
  });
  const ends = [];
  b.onItemEnded = (reason) => ends.push(reason ?? "natural");
  return { el, b, log, ends };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for the backend to report an end, or give up. */
async function waitForEnd(ends, budgetMs) {
  const deadline = now() + budgetMs;
  while (!ends.length && now() < deadline) await sleep(5);
  return ends[0] ?? null;
}

test("an out-point stops the item and reports the same end a finished file reports", async () => {
  const { el, b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(100.8);
  b.play();

  assert.equal(await waitForEnd(ends, 3000), "outPoint");
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
    await waitForEnd(ends, 3000);
    assert.ok(el.currentTime >= target, `stopped at ${el.currentTime} before ${target}`);
    assert.ok(b.lastOutPointOvershootSec >= 0);
  }
});

test("the boundary lands inside a fifth of a timeupdate interval, measured", async () => {
  // ~250 ms is what a bare `if (currentTime >= end)` on timeupdate would cost.
  // Measured locally this comes in around 5-15 ms; the assertion is loose
  // enough for a loaded CI box and still an order of magnitude tighter.
  const overshoots = [];
  for (let i = 0; i < 3; i++) {
    const { b, ends } = ticking();
    await b.load(item("seg"), { startOffset: 100 });
    b.setOutPoint(100.7);
    b.play();
    await waitForEnd(ends, 3000);
    overshoots.push(b.lastOutPointOvershootSec);
  }
  const worst = Math.max(...overshoots);
  assert.ok(worst < TIMEUPDATE_MS / 1000 / 5, `worst overshoot ${worst}s (of ${overshoots.join(", ")})`);
});

test("a faster rate does not loosen the boundary", async () => {
  // At 2x, one timeupdate is half a second of CONTENT — a whole sentence. The
  // fine timer is scheduled in wall clock, so the content overshoot stays flat.
  const { b, ends } = ticking();
  await b.load(item("seg"), { startOffset: 100 });
  b.setRate(2);
  b.setOutPoint(101.2);
  b.play();
  await waitForEnd(ends, 3000);
  assert.ok(b.lastOutPointOvershootSec < 0.1, `overshoot ${b.lastOutPointOvershootSec}s at 2x`);
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
  assert.equal(await waitForEnd(ends, 3000), "outPoint", "must resume and still stop at the boundary");
  assert.ok(el.currentTime >= 100.6);
});

test("an out-point past the real audio yields exactly one end, the natural one", async () => {
  const { b, log, ends } = ticking({ durationSec: 100.5 });
  await b.load(item("seg"), { startOffset: 100 });
  b.setOutPoint(400); // authored end_sec well past this copy
  b.play();

  assert.equal(await waitForEnd(ends, 3000), "natural");
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
  assert.equal(await waitForEnd(ends, 3000), "outPoint");
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
  assert.equal(await waitForEnd(ends, 3000), "outPoint");

  await b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 100 });
  assert.equal(el.currentTime, 100, "seeks backwards within the buffered source");
  b.setOutPoint(100.4);
  b.play();
  const deadline = now() + 3000;
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
  assert.equal(await waitForEnd(ends, 3000), "outPoint");
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
  assert.equal(await waitForEnd(ends, 3000), "outPoint");

  el.calls.length = 0;
  await b.load(item("seg-2", "https://cdn.example/one.mp3"), { startOffset: 400 });
  b.setOutPoint(400.5);
  b.play();
  const deadline = now() + 3000;
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

test("integration: a three-segment Foray plays every slice and stops", async () => {
  __resetInstanceForTests();
  const el = new TickingAudio();
  const backend = new HtmlAudioBackend({ element: el });
  const saved = new Map();
  const m = new PlayerQueueManager({
    backend,
    positionStore: { save: (id, s) => saved.set(id, { seconds: s }), load: (id) => saved.get(id) ?? null },
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

  // Slice 1 -> slice 2: same episode, so a seek rather than a refetch.
  const loadsBefore = el.calls.filter((c) => c === "load").length;
  let deadline = now() + 4000;
  while (m._currentItem()?.id !== "f1#1" && now() < deadline) await sleep(5);
  assert.equal(m._currentItem().id, "f1#1");
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
  deadline = now() + 4000;
  while (m._currentItem()?.id !== "f1#2" && now() < deadline) await sleep(5);
  assert.equal(m._currentItem().id, "f1#2");
  assert.equal(el.src, "https://cdn.example/b.mp3");
  assert.ok(el.currentTime >= 50 && el.currentTime < 51);

  // ...and the Foray ends rather than rolling into anything.
  deadline = now() + 4000;
  while (m.state.type !== "ended" && now() < deadline) await sleep(5);
  assert.equal(m.state.type, "ended");
  assert.equal(el.paused, true);
  m.dispose();
});
