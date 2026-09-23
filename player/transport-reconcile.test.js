/* The surface is a cache; the element is the authority (#263).

   THE FIELD REPORT THIS SUITE IS ABOUT
   The founder drove with the screen off, switched the car off, and the audio
   stopped — correctly, the route was gone. When he re-opened the app the
   transport still said playing. One press turned it to pause, a second press
   resumed where it should have. He spent a press correcting the app's belief
   before the press that did what he wanted.

   A second report landed on the same code: "it randomly stopped at the end of a
   segment and then restarted the segment when I opened the website." The
   stopping is #224 (a cross-episode seam load that fails). The RESTARTING is
   here — after that failure the player wrote down a position the listener had
   never been at.

   WHAT IS REPRODUCED HERE AND WHAT IS NOT
   Reproduced, with no wall clock and no device:
     - a state machine left saying `playing` while the element is paused, and the
       press count that costs a listener;
     - a `pause` observation that reached nothing;
     - an `_expectPause` token spent on an event that never comes, swallowing the
       next real one;
     - a stored resume row overwritten with a segment's in-point after a failed
       seam load, through the REAL `player/client.js`.
   NOT reproduced, and not claimed: an iOS page being suspended, an audio route
   physically disappearing, a car. Those are simulated by their observable
   consequences — the element is paused, and no event was delivered — which is
   exactly the pair the fix is built on. You cannot simulate a car.

   WHY A DOM STUB RATHER THAN MORE SOURCE-TEXT ASSERTIONS
   `player/client.js` was previously only assertable as text (see
   foray-playback.test.js's two regex tests), and a regex cannot tell a wire that
   is connected from one that is connected to the wrong thing. The stub below is
   ~90 lines and buys the whole stack: real client.js, real manager, real
   reducer, real HtmlAudioBackend, with only the DOM and the network faked. Every
   test in part 3 fails if the reconcile is wired to the wrong edge. */

import test from "node:test";
import assert from "node:assert/strict";

import { HtmlAudioBackend } from "./html-audio-backend.js";
import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { itemRef } from "./queue-state.js";
import { indexSegments, indexSources, resolveForay, segmentStarts } from "./foray-resolve.js";
import { ForayProgressStore, progressKey } from "./foray-progress.js";

/* ==================================================================== */
/* fakes                                                                */
/* ==================================================================== */

/**
 * An `<audio>` element that models `paused` and `ended` the way the spec says.
 *
 * THE ONE RULE THAT MATTERS: `pause()` fires `pause` only if the element was NOT
 * already paused. Every fake in this repo that pushes "pause" onto a call log
 * unconditionally is blind to the leak in `_expectPause`, because the leak IS
 * the missing event.
 */
class Element {
  constructor({ durationSec = 3600 } = {}) {
    this.listeners = new Map();
    this.calls = [];
    this.src = "";
    this.currentSrc = "";
    this.currentTime = 0;
    this.duration = durationSec;
    this.playbackRate = 1;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
    /** url -> "ok" | "error". Anything unlisted loads fine. */
    this.loadPlan = new Map();
    /** Reject `play()` with this `DOMException`-ish name instead of playing.
        `"NotAllowedError"` is autoplay policy, which is per ELEMENT — the one
        failure mode a two-element handover has and a one-element player does
        not. Off by default, so nothing above this line changes. (#267) */
    this.refusePlayWith = null;
    /** Hold the media load algorithm mid-chain instead of running it to
        `canplay`. Set true to keep a load genuinely IN FLIGHT; `releaseLoad()`
        lets it finish. Without this the race a test wants to drive resolves
        itself first and the test passes for the wrong reason. (#267) */
    this.holdLoad = false;
    this._heldLoad = null;
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }

  load() {
    this.calls.push("load");
    this.currentSrc = this.src;
    this.currentTime = 0;   // the media load algorithm, and the whole of report 2
    this.readyState = 0;
    this.ended = false;
    const plan = this.loadPlan.get(this.src) ?? "ok";
    const run = () => {
      if (plan === "error") {
        this.error = { code: 4 };
        return this.fire("error");
      }
      this.readyState = 1;
      this.fire("loadedmetadata");
      queueMicrotask(() => {
        this.readyState = 4;
        if (this.currentTime > 0) this.fire("seeked");
        this.fire("canplay");
      });
    };
    if (this.holdLoad) { this._heldLoad = run; return; }
    queueMicrotask(run);
  }
  /** Let a held load finish. A no-op if nothing is held, so a test can call it
      without first asserting that the race it wanted actually happened —
      the precondition assertions do that job explicitly instead. */
  releaseLoad() {
    const run = this._heldLoad;
    this._heldLoad = null;
    if (run) run();
  }
  play() {
    this.calls.push("play");
    if (this.refusePlayWith) {
      // A refused play changes nothing about the element and fires no `playing`.
      return Promise.reject(Object.assign(new Error("blocked"), { name: this.refusePlayWith }));
    }
    this.paused = false;
    this.ended = false;
    queueMicrotask(() => { if (!this.paused) this.fire("playing"); });
    return Promise.resolve();
  }
  pause() {
    this.calls.push("pause");
    if (this.paused) return;          // no event: the spec, and the leak
    this.paused = true;
    this.fire("pause");
  }
  removeAttribute(a) { this.calls.push(`removeAttribute:${a}`); this.src = ""; }

  /* ---- the things a car does ---- */

  /** The audio route disappeared and the page WAS running to see it. */
  routeLost() {
    this.paused = true;
    this.fire("pause");
  }
  /** The audio route disappeared while the page was suspended: it stopped, and
      no event was ever delivered. This is the founder's case. */
  routeLostUnseen() {
    this.paused = true;
  }
  /** The file ran out. `pause` BEFORE `ended`, which is the ordering that makes
      a naive detector call a finished Foray an interruption. */
  runOut() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.fire("pause");
    this.fire("ended");
  }
}

const audioItem = (id, url = `https://cdn.test/${id}.mp3`) =>
  ({ id, audio_url: url, kind: "episode" });

/** A backend that answers `paused`/`ended` — the two questions the reconcile
    asks — without dragging a whole element in. Everything else is the fake the
    manager suites already use. */
class Backend {
  constructor() {
    this.calls = [];
    this.currentTime = 0;
    this.duration = 3600;
    this.paused = true;
    this.ended = false;
    this.outPoint = null;
    this.onItemEnded = null;
    this.onError = null;
    this.onUnexplainedPause = null;
    this.failLoadFor = new Set();
    this.beforeStartPlayback = null;
  }
  async load(item, { startOffset = 0 } = {}) {
    this.outPoint = null;
    this.currentTime = startOffset;
    this.calls.push(`load:${item.id}@${Math.round(startOffset)}`);
    if (this.failLoadFor.has(item.id)) throw new Error("missing file");
  }
  play() {
    if (this.beforeStartPlayback) {
      const fn = this.beforeStartPlayback;
      this.beforeStartPlayback = null;
      fn();
    }
    this.calls.push("play");
    this.paused = false;
    this.ended = false;
  }
  pause() { this.calls.push("pause"); this.paused = true; }
  seek(s) { this.currentTime = s; this.calls.push(`seek:${Math.round(s)}`); }
  setOutPoint(s) { this.outPoint = s; this.calls.push(`outPoint:${s == null ? "null" : Math.round(s)}`); }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
  /** The route died. Nothing here tells anybody, which is the pre-#263 world. */
  stopUnseen() { this.paused = true; }
}

/** Zero wall clock. Never assert on a ratio between two OS timers (#195). */
const INSTANT = {
  nowMs: () => 0,
  schedule: (_ms, fn) => { let dead = false; queueMicrotask(() => { if (!dead) fn(); }); return () => { dead = true; }; },
};

function playerWith(items, opts = {}) {
  __resetInstanceForTests();
  const backend = opts.backend ?? new Backend();
  const saved = new Map();
  const log = [];
  const m = new PlayerQueueManager({
    backend,
    positionStore: {
      save: (id, seconds) => saved.set(id, { seconds }),
      load: (id) => saved.get(id) ?? null,
    },
    telemetry: (msg) => log.push(msg),
    scheduler: INSTANT,
    ...opts.manager,
  });
  m.loadQueue(items);
  return { m, backend, saved, log };
}

/* ==================================================================== */
/* part 1 — the backend knows what the element is doing                  */
/* ==================================================================== */

const mkBackend = () => {
  const el = new Element();
  const log = [];
  return { el, log, b: new HtmlAudioBackend({ element: el, telemetry: (msg) => log.push(msg) }) };
};

test("paused and ended are read off the element, not off what we believe", async () => {
  const { b, el } = mkBackend();
  await b.load(audioItem("a"));
  assert.equal(b.paused, true, "a loaded, un-played element is paused");
  b.play();
  assert.equal(b.paused, false);
  el.routeLostUnseen();
  assert.equal(b.paused, true, "and it says so the moment the element does, with no event");
  assert.equal(b.ended, false);
  el.ended = true;
  assert.equal(b.ended, true);
});

test("an element that does not model paused reads as NOT paused, never as paused", () => {
  /* The direction of the default is the whole point. `reconcileWithBackend` acts
     on a definite yes and moves the player towards stopped, so a fake, a stub or
     a future backend that simply lacks the property must produce inaction — not
     a Foray paused for no reason. */
  const bare = { addEventListener() {}, removeEventListener() {}, pause() {}, play() {} };
  const b = new HtmlAudioBackend({ element: bare });
  assert.equal(b.paused, false);
  assert.equal(b.ended, false);
});

test("a pause nobody asked for is reported; one we caused is not", async () => {
  const { b, el } = mkBackend();
  const seen = [];
  b.onUnexplainedPause = () => seen.push(el.currentTime);
  await b.load(audioItem("a"));
  b.play();
  await null;

  b.pause();                       // ours
  assert.deepStrictEqual(seen, [], "our own pause is explained");

  b.play();
  await null;
  el.currentTime = 61;
  el.routeLost();                  // not ours
  assert.deepStrictEqual(seen, [61], "and this one has to reach somebody");
});

test("a file that simply ran out is not an interruption", async () => {
  /* #227's mutation round found a detector that false-positived on a file that
     ran out, and `pause` fires BEFORE `ended`, so the ordering is a trap rather
     than an edge case. A finished Foray must not come back looking mid-listen. */
  const { b, el } = mkBackend();
  const seen = [];
  b.onUnexplainedPause = () => seen.push("reported");
  const ends = [];
  b.onItemEnded = (reason) => ends.push(reason);
  await b.load(audioItem("a"));
  b.play();
  await null;
  el.runOut();
  assert.deepStrictEqual(seen, [], "running out is not somebody taking the audio away");
  assert.deepStrictEqual(ends, ["natural"], "and it is still an end");
});

test("the out-point's own pause is not an unexplained one", async () => {
  /* The single most valuable measured property of this player is that the
     boundary fires 0.004–0.021 s past `end_sec` while backgrounded, and a miss
     costs a median 936.5 s of the wrong episode. The boundary pauses the
     element, so if that pause read as an interruption every seam in the hour
     would stop the Foray. */
  const { b, el } = mkBackend();
  const seen = [];
  b.onUnexplainedPause = () => seen.push("reported");
  const ends = [];
  b.onItemEnded = (reason) => ends.push(reason);
  await b.load(audioItem("a"));
  b.setOutPoint(120);
  b.play();
  await null;
  el.currentTime = 120.01;
  el.fire("timeupdate");
  assert.deepStrictEqual(ends, ["outPoint"], "the boundary landed");
  assert.equal(el.paused, true, "by pausing, like a file running out");
  assert.deepStrictEqual(seen, [], "and that pause is ours");
});

test("re-pausing an already-paused element arms nothing, so the NEXT real pause survives", async () => {
  /* THE LEAK, and why it stopped being harmless. `_expectPause` is a token
     `_notePause` spends: one armed with no matching event swallows the next
     pause. Re-pausing a stopped element fires nothing — and re-pausing a stopped
     element is exactly what reconciling a lost route does, so before #263 the
     reconcile itself would have blinded the player to the following
     interruption. Kill this by restoring `this._expectPause = true` in
     `pause()`. */
  const { b, el } = mkBackend();
  const seen = [];
  b.onUnexplainedPause = () => seen.push("reported");
  await b.load(audioItem("a"));
  b.play();
  await null;

  b.pause();                       // real: element was playing, fires `pause`
  assert.equal(el.paused, true);
  b.pause();                       // redundant: fires NOTHING
  b.pause();

  /* The listener is stopped, the page goes away, comes back, and the element is
     un-paused by something outside our control — a lock-screen play, a car
     resuming — and then the route dies for real. There is no `playing` in
     between to clear a leaked flag by hand. */
  el.paused = false;
  el.routeLost();
  assert.deepStrictEqual(seen, ["reported"], "a leaked token would have eaten this");
});

test("loading an already-paused element arms nothing either", async () => {
  const { b, el } = mkBackend();
  const seen = [];
  b.onUnexplainedPause = () => seen.push("reported");
  await b.load(audioItem("a"));          // element paused throughout the load
  el.paused = false;                     // something else started it
  el.routeLost();
  assert.deepStrictEqual(seen, ["reported"]);
});

/* ==================================================================== */
/* part 2 — the manager can be asked, and answers safely                 */
/* ==================================================================== */

const two = [audioItem("s0"), audioItem("s1")];

async function playing() {
  const p = playerWith(two);
  await p.m.play(0);
  assert.equal(p.m.state.type, "playing");
  p.backend.currentTime = 61;
  return p;
}

test("REPRODUCTION: a stop the page never saw leaves the machine saying playing", async () => {
  const { m, backend } = await playing();
  backend.stopUnseen();
  assert.equal(backend.paused, true, "the element has stopped");
  assert.equal(m.state.type, "playing", "and the state machine still claims otherwise");
  /* That is the founder's bug in one assertion: the surface paints from this
     state, so the transport says Pause and the first press is spent on it. */
  m.dispose();
});

test("reconciling corrects it, and ONE press then resumes where it stopped", async () => {
  const { m, backend } = await playing();
  backend.stopUnseen();

  const corrected = await m.reconcileWithBackend("visible");
  assert.equal(corrected, true, "it reports having corrected something");
  assert.equal(m.state.type, "interrupted");
  assert.equal(m.state.wasPlaying, true, "wasPlaying is what makes one press enough");
  assert.equal(m.state.item.id, "s0", "and it is still this segment");

  // The listener's single press.
  await m.resume();
  assert.equal(m.state.type, "playing");
  assert.equal(m.currentIndex, 0, "the same segment, not the next one");
  assert.ok(
    backend.calls.filter((c) => c === "play").length >= 2,
    "and audio was started again by the press, not by the reconcile"
  );
  m.dispose();
});

test("the reconcile itself never starts audio", async () => {
  /* #227 shipped a recovery that read every `play()` rejection as an autoplay
     refusal and restarted audio a listener had deliberately stopped, with every
     surface showing paused. The failure being fixed here is a UI that lies; it
     must not be replaced with playback nobody asked for. */
  const { m, backend } = await playing();
  backend.stopUnseen();
  const before = backend.calls.length;
  await m.reconcileWithBackend("visible");
  const after = backend.calls.slice(before);
  assert.ok(!after.includes("play"), `reconcile issued: ${after.join(", ")}`);
  assert.ok(after.includes("pause"), "it only ever moves towards stopped");
  m.dispose();
});

test("reconciling twice corrects once", async () => {
  const { m, backend, log } = await playing();
  backend.stopUnseen();

  assert.equal(await m.reconcileWithBackend("visible"), true);
  assert.equal(await m.reconcileWithBackend("visible"), false, "the second one has nothing to do");
  assert.equal(await m.reconcileWithBackend("unexplainedPause"), false);
  assert.equal(
    log.filter((l) => l.includes("reconcile.externalStop")).length, 1,
    "one correction, however many triggers fire"
  );
  m.dispose();
});

test("an element that agrees with us is left alone", async () => {
  const { m, backend } = await playing();
  assert.equal(backend.paused, false);
  assert.equal(await m.reconcileWithBackend("visible"), false);
  assert.equal(m.state.type, "playing");
  m.dispose();
});

test("a finished file is not an external stop", async () => {
  /* Paused AND ended. Without the `ended` guard this pauses a Foray whose
     `onItemEnded` is on its way, and the listener comes back to a finished
     Foray that looks mid-listen. Kill it by deleting the `backend.ended` check. */
  const { m, backend } = await playing();
  backend.paused = true;
  backend.ended = true;
  assert.equal(await m.reconcileWithBackend("visible"), false);
  assert.equal(m.state.type, "playing", "the end path owns this, not the reconcile");
  m.dispose();
});

test("a transition in flight is not a lie: reconciling mid-effect cannot stop a start", async () => {
  /* `_handle` sets the state value and THEN performs the effects, so between
     `playing` and `startPlayback` the element is legitimately still paused. A
     reconcile arriving in that window — the app being brought back to the
     foreground during a seam is precisely when it does — would pause the Foray
     one instruction before it started. Kill it by deleting the `_applying`
     guard. */
  const { m, backend } = playerWith(two);
  let sawApplying = null;
  backend.beforeStartPlayback = () => {
    // We are inside `_perform`. The state already says playing; the element does
    // not agree yet.
    assert.equal(m.state.type, "playing");
    assert.equal(backend.paused, true);
    sawApplying = m.reconcileWithBackend("visible");
  };
  await m.play(0);
  assert.equal(await sawApplying, false, "it declined");
  assert.equal(m.state.type, "playing", "and the Foray started");
  assert.equal(backend.paused, false);
  m.dispose();
});

test("A LOAD IN FLIGHT IS NOT AN EXTERNAL STOP: a seam must survive being reconciled", async () => {
  /* `loadingItem` with a paused element is the ordinary shape of every seam in
     the hour — including the 2.0 s authored beat, where the silence IS the
     product — so a reconcile that fired on it would turn each of the 21 seams in
     `capital-types-1` into an interruption. And this is exactly when it would
     fire: bringing the app back to the foreground mid-seam is a listener
     checking what is playing.

     Killed by removing the `_applying` guard, NOT by widening the state guard.
     Corrected after a mutation round: `=== "idle"` leaves this green, because a
     seam load runs inside `_handle`'s effect loop and `_applying` answers first.
     Two guards cover this case and only one of them is load-bearing here — said
     plainly rather than left as a kill instruction that does not kill, because a
     wrong one is worse than none. The state guard's own coverage is
     "reconciling twice corrects once". */
  const { m, backend } = playerWith(two);
  await m.play(0);
  backend.currentTime = 61;

  // Hold the next segment's load open, so the test sits inside the seam.
  let release;
  const held = new Promise((r) => { release = r; });
  const realLoad = backend.load.bind(backend);
  backend.load = async (item, opts) => { await held; return realLoad(item, opts); };

  const advancing = m.skipToNext();
  await null;
  assert.equal(m.state.type, "loadingItem", "mid-seam");
  assert.equal(backend.paused, true, "with the element paused, as authored");

  assert.equal(await m.reconcileWithBackend("visible"), false, "the seam is not a lie");

  release();
  await advancing;
  assert.equal(m.state.type, "playing", "and the next segment played");
  assert.equal(m.currentIndex, 1);
  m.dispose();
});

test("the backend's unexplained pause is wired to the reconcile", async () => {
  /* The observation existed before #263 and reached nothing but the prefetch
     stand-down. Kill this by deleting the `backend.onUnexplainedPause =`
     assignment in the manager's constructor. */
  const { m, backend } = await playing();
  assert.equal(typeof backend.onUnexplainedPause, "function", "the manager assigns it");
  backend.paused = true;
  backend.onUnexplainedPause();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.state.type, "interrupted", "no visibility change needed when JS is running");
  m.dispose();
});

test("playheadItemId names the item the element is holding, not the one we intend", async () => {
  /* `_loadItem` moves `currentIndex` BEFORE `backend.load` — deliberately, so
     `savePosition` runs against the outgoing item — and sets `_loadedId` only
     after the load resolves. A failed load therefore leaves them disagreeing,
     and the element's clock has already been reset. Kill this by deriving the
     getter from `currentIndex`. */
  const { m, backend } = playerWith(two);
  await m.play(0);
  assert.equal(m.playheadItemId, "s0");

  backend.failLoadFor.add("s1");
  await m.skipToNext();
  assert.equal(m.currentIndex, 1, "the manager has moved");
  assert.equal(m.playheadItemId, "s0", "the element has not");
  m.dispose();
});

test("A NARRATION BRIDGE IS ALSO SOMETHING THE ELEMENT IS HOLDING", async () => {
  /* Caught in review, not by the field: `playheadItemId` gave the PREVIOUS
     segment for a bridge's whole length, because `_playTransitionBridge` loaded
     and played the bridge without ever setting `_loadedId`. Harmless while that
     field only fed `resumingInPlace` — a bridge always starts at 0 and never
     resumes in place — and a regression the moment a surface started asking the
     getter which item the playhead is about: `client.js`'s `forayPlayhead`
     returned null for up to 180 s, freezing the Foray clock and writing no
     progress row. `foray-resolve.js` records fixing that same freeze one level
     down, so this change would have reintroduced its symptom.

     Kill this by deleting `this._loadedId = bridge.id;` from
     `_playTransitionBridge`. */
  const foray = {
    id: "f263b", kind: "deep-dive", title: "Bridged", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
      { type: "narration", id: "nar-1", asset: "https://cdn.test/nar-1.mp3", duration_sec: 40 },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: "sb" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-a", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
      { id: "sb", item_id: "ep-b", start_sec: 500, end_sec: 600, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-a", show: "Show A", title: "Ep A", audio_url: "https://cdn.test/a.mp3", duration_sec: 3600, dai_suspected: false },
      { id: "ep-b", show: "Show B", title: "Ep B", audio_url: "https://cdn.test/b.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  const resolved = resolveForay(foray, { segments, sources });
  const bridge = resolved.playable[1];
  assert.equal(bridge.kind, "tts", "the fixture must actually produce a bridge");

  const { m, backend } = playerWith(resolved.playable);
  await m.play(0);
  assert.equal(m.playheadItemId, resolved.playable[0].id);

  // The first segment reaches its out-point, so the bridge becomes the audio.
  backend.onItemEnded("outPoint");
  await settle();
  assert.equal(m.state.type, "transitioning", "the bridge phase is what is under test");
  assert.ok(
    backend.calls.includes(`load:${bridge.id}@0`),
    `the bridge was loaded, calls=${JSON.stringify(backend.calls)}`
  );
  assert.equal(
    m.playheadItemId, bridge.id,
    "the element is holding the bridge, so the playhead is about the bridge"
  );
  m.dispose();
});

/* ==================================================================== */
/* part 2b — the reconcile against the REAL backend's refusal recovery    */
/*           (#267, the tripwire on re-enabling the seam prefetch)        */
/* ==================================================================== */

/* WHY THIS PART EXISTS AND WHY IT IS HERE RATHER THAN IN
   `html-audio-backend.test.js`. That suite pins the MECHANISM — an epoch the
   recovery's continuation re-reads. This part pins the CLAIM THAT THE WINDOW IS
   REACHABLE, which is a statement about the manager and the backend together and
   is not observable from either alone. #267 says every guard in
   `reconcileWithBackend` passes while the refusal recovery's own load is in
   flight; that is either true or it is not, and it is the reason the fix is
   needed. Here it is asserted against the real reducer, the real manager and the
   real `HtmlAudioBackend`, with only the elements faked.

   `prefetch: true` is explicit, because the handover is DEFAULT OFF and nothing
   in production constructs the backend this way. That is exactly why #266 could
   not fix this and recorded it instead: reproducing it means asserting a
   behaviour no shipped path can reach. Kept working and kept honest for whoever
   re-opens the question with a device measurement. */

/** A manager over the real two-element backend, mid-handover, with the
    gesture-holding element's next load held in flight — i.e. sitting inside the
    refusal recovery. Returns everything a test needs to poke it. */
async function insideRecovery(items) {
  __resetInstanceForTests();
  const elA = new Element();
  const elW = new Element();
  const log = [];
  const backend = new HtmlAudioBackend({
    element: elA, warmElement: elW, prefetch: true, telemetry: (msg) => log.push(msg),
  });
  const m = new PlayerQueueManager({
    backend,
    positionStore: { save: () => {}, load: () => null },
    telemetry: (msg) => log.push(msg),
    scheduler: INSTANT,
  });
  m.loadQueue(items);
  await m.play(0);
  await settle();
  assert.equal(m.state.type, "playing", "precondition: the first segment is audible");

  // Warm the next segment, exactly as `onPrefetchWindow` -> `_warmNextSegment`
  // would inside the lead.
  backend.prefetch(items[1], { startOffset: 0 });
  await settle();

  // Autoplay policy is per element, and the element the listener tapped is the
  // other one. The promoted element will refuse.
  elW.refusePlayWith = "NotAllowedError";
  // And the recovery's own re-load, back onto the element that DOES hold the
  // gesture, is the load this test needs in flight.
  elA.holdLoad = true;

  await m.skipToNext();
  await settle();
  return { m, backend, elA, elW, log };
}

test("THE #267 WINDOW IS REAL: every reconcile guard passes inside the refusal recovery", async () => {
  /* Not the fix — the premise. If this test ever starts returning false, the fix
     below is guarding a window that closed for some other reason, and whoever
     finds that out should delete the guard rather than keep a mystery.

     MUTATION: there is no code mutation for this one, deliberately — it asserts a
     property of code it does not change. What breaks it is the ENVIRONMENT: flip
     `prefetch: true` to `false` in `insideRecovery` and it fails on `"the manager
     still believes the handover succeeded"` (`m.state.type` is `idle`, not
     `playing`), which is the whole reason #267 is latent. Expect that run to take
     **~10 s of real wall clock per test**: with one element there is no handover
     to refuse, so `elA.holdLoad` simply starves the ordinary load until
     `LOAD_SETTLE_TIMEOUT_MS` fires. The suite is not hung. */
  const { m, backend, elA, elW } = await insideRecovery([audioItem("a"), audioItem("b")]);

  assert.equal(backend.el, elA, "the recovery swapped back to the gesture holder");
  assert.notEqual(elW, elA);
  assert.equal(m.state.type, "playing", "the manager still believes the handover succeeded");
  assert.equal(backend.paused, true, "and the element it is holding is genuinely paused");
  assert.equal(backend.ended, false, "nothing ran out");

  const corrected = await m.reconcileWithBackend("visible");
  assert.equal(corrected, true,
    "so a visibilitychange here lands `interrupted` — correctly, on the evidence it has");
  assert.equal(m.state.type, "interrupted");
  m.dispose();
});

test("audio must NOT start after that reconcile, and the queue must not strand (#267)", async () => {
  /* The failure being prevented, end to end. Without the fix the recovery's
     continuation calls `play()` after the reconcile has landed `interrupted`:
     sound comes out while every control says Play — the #263 lie inverted, and
     the exact failure class #227 exists to stop, arriving from the other
     direction. It strands as well, because `_handleBackendItemEnded` ignores an
     end in `interrupted` and the queue never advances.

     MUTATION: delete `this._stopEpoch++;` from `HtmlAudioBackend.pause()`. This
     fails on the `elA.paused` assertion — audio starts underneath `interrupted`.
     (The same mutation is named in `html-audio-backend.test.js`; this is the
     suite that says it MATTERS, because this is the one where the pause comes
     from the reducer rather than from a test calling `pause()` by hand.)

     THE STRAND ASSERTION AT THE BOTTOM WAS AUDITED SEPARATELY, because that
     mutation stops the test before it — an assertion that never runs is not
     evidence. Comment out the `await m.resume()` and the two lines after it so
     the end arrives while the machine is still `interrupted`, and it fails with
     `log=["backend.itemEnded.ignored.state=interrupted"]` — #267's exact line,
     produced rather than quoted. */
  // THREE items, so "the queue advanced" is observable rather than "the Foray
  // ended", which is what a two-item queue can only ever show.
  const { m, backend, elA, log } = await insideRecovery(
    [audioItem("a"), audioItem("b"), audioItem("c")]
  );
  await m.reconcileWithBackend("visible");
  assert.equal(m.state.type, "interrupted", "precondition: the machine has been corrected");

  // Now the recovery's held load lands — far too late to be allowed to matter.
  elA.releaseLoad();
  await settle();

  assert.equal(m.state.type, "interrupted", "the machine is still where the evidence put it");
  assert.equal(elA.paused, true, "ABOVE ALL: no audio while every control says Play");
  assert.equal(backend.paused, true, "and the backend agrees, so the transport is not lying");
  assert.ok(log.some((l) => /handover\.recovery\.stopped/.test(l)),
    `it declines out loud, log=${JSON.stringify(log.filter((l) => /handover/.test(l)))}`);

  // ONE PRESS RESUMES — which is the only thing that makes declining correct.
  elA.holdLoad = false;
  await m.resume();
  await settle();
  assert.equal(m.state.type, "playing", "and the listener gets their segment back");
  assert.equal(elA.paused, false);

  // AND IT IS NOT STRANDED. `_handleBackendItemEnded` falls through on
  // `interrupted` and emits `backend.itemEnded.ignored.state=interrupted`, so a
  // player left in that state stops at this segment's end and never advances —
  // which is indistinguishable, to a listener, from #224 itself.
  elA.currentTime = 10;
  elA.runOut();
  await settle();
  assert.equal(
    log.some((l) => /itemEnded\.ignored/.test(l)), false,
    `the end must be acted on, not ignored; log=${JSON.stringify(log.filter((l) => /itemEnded/.test(l)))}`
  );
  assert.equal(m.currentIndex, 2, "the queue advanced to the third segment");
  m.dispose();
});

/* ==================================================================== */
/* part 3 — end to end, through the real player/client.js                */
/* ==================================================================== */

/* A DOM small enough to read and complete enough to boot the real module. */

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.classList = {
      add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
    };
  }
  append(...kids) { for (const k of kids) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  click() { return Promise.all([...(this.listeners.get("click") ?? [])].map((fn) => fn({}))); }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/**
 * Boot the real `player/client.js` against the stub above.
 *
 * A cache-busting query on the import specifier, because these globals are read
 * at module scope and Node caches a module for the life of the process — two
 * tests sharing one instance would share a booted player and a storage tier.
 */
/* `seed` is rows this device already held when the page loaded — a cold launch
   after the app was killed, which is half of what #689 reports 1 and 4 are
   about. It has to be written BEFORE the import and cannot be written after:
   `durable-store.js` reads its localStorage tier ONCE, at construction, into
   memory ("reads never touch a tier"), and the store is constructed at module
   scope. A test that booted first and seeded second would be asserting against
   an empty store and would pass for the wrong reason. */
let bootSeq = 0;
async function bootClient(t, { seed = [], mediaSession = null, capacitor = null } = {}) {
  const audio = new Element();
  const storage = new MemoryStorage();
  for (const [k, v] of seed) storage.setItem(k, v);
  const doc = {
    hidden: false,
    body: new Node("body"),
    createElement: (tag) => (String(tag).toLowerCase() === "audio" ? audio : new Node(tag)),
    querySelectorAll: () => [],
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, new Set());
      this.listeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); },
    fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); },
  };
  doc.body.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  const win = {
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, new Set());
      this.listeners.get(t).add(fn);
    },
    removeEventListener() {},
    dispatchEvent: () => true,
    /* The Capacitor shell, when a test is about the shell (2026-09-22: the
       build stamp asks the binary for its build number). Absent by default. */
    ...(capacitor ? { Capacitor: capacitor } : {}),
  };

  /* `defineProperty`, not assignment: `globalThis.navigator` is an accessor with
     no setter on Node 22+, so `globalThis.navigator = ...` throws. */
  const names = ["window", "document", "localStorage", "navigator", "Event", "Audio"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) =>
    Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  const restore = () => {
    for (const [n, d] of prev) {
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  };

  set("window", win);
  set("document", doc);
  set("localStorage", storage);
  /* `mediaSession` (2026-09-22) is the lock screen and the car, as the page sees
     them: a `navigator.mediaSession` the test can read back. Absent by default,
     so every test above keeps the inert bridge it was written against. */
  set("navigator", {
    storage: { persisted: async () => false },
    ...(mediaSession ? { mediaSession } : {}),
  });
  set("Event", class { constructor(type) { this.type = type; } });
  /* `HtmlAudioBackend` constructs `new Audio()`, not `document.createElement`.
     One element per boot, handed back so the test can be the car. */
  set("Audio", function Audio() { return audio; });
  __resetInstanceForTests();

  /* NOT restored before the test body runs. `client.js` reads `document` and
     `window` live from inside its handlers, so the stub has to stay installed
     for the whole test; each test calls `restore()` itself. */
  const client = (await import(`./client.js?reconcile=${++bootSeq}`)).default;
  /* Registered as teardown rather than called at the end of each test body: a
     test that FAILS mid-way would otherwise leave `globalThis.document` pointing
     at a stub, and every test after it in this file would run against a booted
     player it did not build. A leak like that turns one red test into a file of
     meaningless results. */
  t.after(restore);
  return { client, doc, win, audio, storage, restore };
}

/** Two segments from DIFFERENT episodes, so the seam is a real cross-episode
    load — the shape both field reports were on. */
function synthetic() {
  const foray = {
    id: "f263", kind: "deep-dive", title: "A Foray", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: "sb" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-a", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
      { id: "sb", item_id: "ep-b", start_sec: 500, end_sec: 600, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-a", show: "Show A", title: "Ep A", audio_url: "https://cdn.test/a.mp3", duration_sec: 3600, dai_suspected: false },
      { id: "ep-b", show: "Show B", title: "Ep B", audio_url: "https://cdn.test/b.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  return resolveForay(foray, { segments, sources });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function find(node, cls) {
  if (node.className === cls) return node;
  for (const k of node.children) { const hit = find(k, cls); if (hit) return hit; }
  return null;
}

/** The transport's own words, which is what the founder was reading. */
const transport = (doc) => {
  const btn = find(doc.body, "fp-play");
  return { glyph: btn.textContent, label: btn.getAttribute("aria-label"), press: () => btn.click() };
};

test("THE FOUNDER'S PRESS: after a stop the page never saw, the transport says Play", async (t) => {
  const { client, doc, audio, restore } = await bootClient(t);
  const resolved = synthetic();
  await client.playForay(resolved, { startIndex: 0 });
  await settle();
  assert.equal(transport(doc).label, "Pause", "audio is running, so the button stops it");

  // Screen off. The car is switched off; the audio route is gone. The page was
  // suspended, so no `pause` event was ever delivered.
  doc.hidden = true;
  doc.fire("visibilitychange");
  audio.currentTime = 161;
  audio.routeLostUnseen();

  // He re-opens the app.
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();

  const button = transport(doc);
  assert.equal(button.label, "Play", "one press must resume, not correct a belief");
  assert.equal(button.glyph, "▶");
  restore();
});

test("and the press resumes — the reconcile did not start anything itself", async (t) => {
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();

  audio.currentTime = 161;
  audio.routeLostUnseen();
  const before = audio.calls.length;
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  assert.ok(
    !audio.calls.slice(before).includes("play"),
    `becoming visible started audio: ${audio.calls.slice(before).join(", ")}`
  );
  assert.equal(audio.paused, true, "the listener is still stopped, as they left it");
  restore();
});

test("a finished Foray does not come back looking mid-listen", async (t) => {
  /* WHAT THIS ACTUALLY PINS, corrected after a mutation round: the unconditional
     `render()` in `reconcileOnReturn`. Delete that line and this test fails;
     delete the reconcile's `ended` guard and it stays GREEN.

     The comment here used to claim it was "the `ended` guard, end to end" and
     that was wrong, in the specific way this repo keeps getting caught by. By
     the time `visibilitychange` fires, `runOut()` has already driven the machine
     to `ended`, so `state.type !== "playing"` declines first and the `ended`
     guard is never consulted. The guard's real coverage is the part-2 test "a
     finished file is not an external stop", which reaches `paused && ended`
     while the state still says `playing` — the shape a suspended page produces
     when it is killed between the `pause` and the `ended`.

     What is still worth asserting, and is the founder-visible half: the last
     thing a finished Foray does is pause an ALREADY-PAUSED element, which fires
     nothing, so no media event is left to repaint the transport. Without the
     unconditional repaint the surface keeps offering to pause something that is
     over. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 1 });   // the last segment
  await settle();
  await settle();
  assert.equal(transport(doc).label, "Pause", "the last segment is running");

  audio.runOut();
  await settle();
  await settle();
  assert.equal(client.forayStatus().ended, true, "the reducer knows the Foray is over");

  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  assert.equal(
    transport(doc).label, "Play",
    "coming back must not offer to pause something that has finished"
  );
  restore();
});

test("A FAILED SEAM MUST NOT REWRITE THE RESUME ROW WITH THE FAILED SEGMENT'S IN-POINT", async (t) => {
  /* Report 2, reproduced end to end. Segment A plays to its out-point and the
     cross-episode load of B fails — #224 owns WHY it fails; here it simply does.
     `_loadItem` has already moved `currentIndex` to B, and assigning `src` reset
     the element's clock to 0, so `forayElapsed` for B with a playhead of 0 is B's
     IN-POINT. The listener was never there. The next repaint — the listener
     pressing play, which is what anyone does when the audio stops — wrote that
     down over the row that said where they had actually got to, and re-opening
     the site then started the failed segment from its beginning.

     Kill this by making `persistForayProgress` read `forayPosition()` again
     instead of `forayPlayhead()`: the row becomes segment "sb" at 0 s in. */
  const { client, doc, audio, storage, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/b.mp3", "error");

  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();

  // Most of the way through segment A, whose slice is [100, 200] of episode A.
  audio.currentTime = 195;
  audio.fire("timeupdate");
  await settle();
  const good = JSON.parse(storage.getItem(progressKey("f263")));
  assert.equal(good.segment_id, "sa");
  assert.ok(good.into_sec >= 95, `the good row is near A's end, got into_sec=${good.into_sec}`);

  // The boundary lands, and the next segment will not load.
  audio.currentTime = 200.01;
  audio.fire("timeupdate");
  await settle();
  await settle();
  assert.equal(audio.calls.filter((c) => c === "load").length, 2, "B was attempted");

  // The audio has stopped, so the listener presses play. This is the repaint.
  transport(doc).press();
  await settle();
  await settle();

  const after = JSON.parse(storage.getItem(progressKey("f263")));
  assert.equal(
    after.segment_id, "sa",
    "the row must not be moved onto the segment whose audio never arrived"
  );
  assert.ok(
    after.into_sec >= 95,
    `and it must still be near A's end, not any in-point — got into_sec=${after.into_sec}`
  );
  restore();
});

test("THE STORE IS NEVER HANDED A POSITION NOBODY READ", async (t) => {
  /* The invariant, asserted at the call rather than at the row.
   *
   * The test above proves the ROW survives a failed seam, and it passes with
   * `persistForayProgress`'s `elapsedSec == null` guard deleted — because
   * `ForayProgressStore.save` refuses a non-finite clock at its own first line.
   * Found by mutation: removing the guard left the whole suite green.
   *
   * That refusal is not a substitute for the guard, and the difference is
   * visible only here. `save`'s early return does NOT increment `refusedWrites`
   * — the counter that exists so "the resume store silently stopped recording"
   * is a detectable defect rather than a silent one. So a fabricated position
   * handed to the store lands in the one path that neither writes nor counts:
   * indistinguishable, afterwards, from the player never having asked. The
   * client owns its own uncertainty; it must not post it to the store and let a
   * type check downstream be the reason the listener's row survived.
   *
   * Kill this by deleting `if (elapsedSec == null) return;` from
   * `persistForayProgress`: `save` is then called with `elapsedSec: null`. */
  const seen = [];
  const real = ForayProgressStore.prototype.save;
  ForayProgressStore.prototype.save = function (args) {
    seen.push(args?.elapsedSec);
    return real.call(this, args);
  };
  t.after(() => { ForayProgressStore.prototype.save = real; });

  const { client, doc, audio, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/b.mp3", "error");
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();

  audio.currentTime = 195;
  audio.fire("timeupdate");
  await settle();
  // The seam fails, then the listener presses play — the repaint that wrote the
  // fabricated position in the field report.
  audio.currentTime = 200.01;
  audio.fire("timeupdate");
  await settle();
  await settle();
  transport(doc).press();
  await settle();
  await settle();

  assert.ok(seen.length > 0, "the writer must have been exercised at all");
  const bad = seen.filter((v) => typeof v !== "number" || !Number.isFinite(v));
  assert.deepEqual(
    bad, [],
    `every position offered to the store must be one the player actually read, got ${JSON.stringify(seen)}`
  );
  restore();
});

test("THE POSITION THE ROUTE DIED AT IS WRITTEN, past the save throttle", async (t) => {
  /* The other half of "one press does what the listener meant": being right
     about WHERE, not just about whether it is playing. The founder confirmed the
     position was correct in his report, and this keeps it correct now that a
     reconcile is what ends the interruption.
   *
   * `force: true` is the load-bearing part, and the throttle is what makes it
   * observable. `SAVE_EVERY_SEC = 5` is compared on the CLOCK VALUE, so a row
   * written at 150 refuses another until 155 — and a route that dies at 152
   * leaves the listener's real position inside that dead band forever, because
   * the clock stops moving the moment the audio does. There is no later tick to
   * carry it.
   *
   * Kill this by dropping `{ force: true }` from `persistForayProgress` in
   * `reconcileOnReturn`: the row stays at 150 and the listener loses the two
   * seconds — and, with a longer interruption, up to five. */
  const { client, doc, audio, storage, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();

  audio.currentTime = 150;             // segment sa is [100, 200] of episode A
  audio.fire("timeupdate");
  await settle();
  assert.ok(
    Math.abs(JSON.parse(storage.getItem(progressKey("f263"))).into_sec - 50) < 1,
    "a row exists at 50 s into the segment"
  );

  // Two more seconds, which the throttle refuses — correctly, on its own terms.
  audio.currentTime = 152;
  audio.fire("timeupdate");
  await settle();
  assert.ok(
    Math.abs(JSON.parse(storage.getItem(progressKey("f263"))).into_sec - 50) < 1,
    "still 50: inside the throttle's dead band, which is the setup for this test"
  );

  // The car is switched off. No event, and the clock will never move again.
  audio.routeLostUnseen();
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  await settle();

  const row = JSON.parse(storage.getItem(progressKey("f263")));
  assert.equal(row.segment_id, "sa", "still the segment the listener was inside");
  assert.ok(
    Math.abs(row.into_sec - 52) < 1,
    `the row must hold the position the route died at, got into_sec=${row.into_sec}`
  );
  restore();
});

test("a position that CAN be read is still written, so the refusal is not a mute", async (t) => {
  /* The other half of the assertion above: a guard that simply stopped writing
     would pass that test and lose every resume point in the app. */
  const { client, audio, storage, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  audio.currentTime = 150;
  audio.fire("timeupdate");
  await settle();
  const row = JSON.parse(storage.getItem(progressKey("f263")));
  assert.equal(row.segment_id, "sa");
  assert.ok(Math.abs(row.into_sec - 50) < 1, `into_sec=${row.into_sec}`);
  restore();
});

/* ==================================================================== */
/* part 4 — #689: four founder reports from one sitting in a car         */
/* ==================================================================== */

/* WHAT THIS PART IS FOR, said plainly before the code.

   Four reports, 2026-09-14, all from one listening session:

     1. "I paused a podcast and left my car. When I later opened the app, the
        podcast started playing without me pressing play."
     2. "Then, when i did press pause, it jumped back to several minutes ago in
        the podcast, I assume the last time the app was open."
     3. "I scrubbed ahead, the podcast started playing, but the button still said
        play (not pause)."
     4. "When I pressed the play button, it again jumped backwards in the
        podcast."

   Every test below names the mutation that kills it. Reports 2, 3 and 4 are
   reproduced end to end through the real `client.js`; report 1 is pinned only as
   an INVARIANT — "nothing on the boot or visible path starts audio" — because
   the reading that says this repo can start audio by itself is not supported by
   the code, and a test that claimed to reproduce it would be fiction. That
   test's own header says what was checked and what is left for the device.

   THESE ARE EPISODE TESTS, NOT FORAY TESTS, and that is the whole point. The
   background flush in `client.js` and the `resumingInPlace` branch in
   `_loadItem` were both written for a Foray and both stopped at its edge. The
   founder was listening to a podcast. */

const episodeItem = (id = "ep-a") => ({
  id, kind: "episode", title: "Ep A", show: "Show A",
  audio_url: `https://cdn.test/${id}.mp3`, duration_sec: 3600,
});

const posRow = (storage, id) => {
  const raw = storage.getItem(`cp_pos:${id}`);
  return raw ? JSON.parse(raw) : null;
};

/** A whole listening session that got to `seconds`, paused, and was
    backgrounded — handed back as the rows the NEXT launch would find on disk.
    A helper rather than four lines inline, because "what a cold launch actually
    has" is a real question with a real answer, and hand-poking a `cp_pos:` key
    would let a test assert against a row the app could never have produced. */
async function aSessionThatReached(t, seconds) {
  const first = await bootClient(t);
  await first.client.play(episodeItem());
  await settle();
  first.audio.currentTime = seconds;
  first.audio.fire("timeupdate");
  await settle();
  transport(first.doc).press();          // the pause writes the row
  await settle();
  first.doc.hidden = true;               // and the phone goes into a pocket
  first.doc.fire("visibilitychange");
  await settle();
  const rows = [...first.storage.map];
  first.restore();
  return rows;
}

test("REPORT 2: an episode backgrounded while PAUSED remembers where it was paused", async (t) => {
  /* THE CASE THE EXISTING COVERAGE DOES NOT REACH. Every background-flush test
     in this repo backgrounds while PLAYING, which is exactly the case the old
     condition allowed through.

     KILLING MUTATION: restore `if (current && isPlaying())` on the flush in
     `client.js`. A paused clock moves nowhere, so the row read back here is
     written by the flush and by nothing else — put the condition back and the
     row still says 1200, the position the transport's own `savePosition`
     recorded on the way into the pause, which is the founder's "several minutes
     ago". */
  const { client, doc, audio, storage, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();

  // Twenty minutes in, written down by the ordinary path.
  audio.currentTime = 1200;
  audio.fire("timeupdate");
  await settle();

  // He presses pause, then scrubs forward while stopped. `handleSeek` on
  // `interrupted` emits `savePosition` BEFORE `seekTo`, so the store is left
  // holding the second he has just left — the trap this test is standing on.
  transport(doc).press();
  await settle();
  assert.equal(audio.paused, true, "precondition: stopped");
  audio.currentTime = 2400;
  audio.fire("seeked");
  await settle();
  assert.ok(
    Math.abs(posRow(storage, "ep-a").seconds - 1200) < 1,
    "precondition: the row is behind the element, which is the state that is lost"
  );

  // Pocket the phone.
  doc.hidden = true;
  doc.fire("visibilitychange");
  await settle();

  const row = posRow(storage, "ep-a");
  assert.ok(row, "a paused episode that is backgrounded must leave a row");
  assert.ok(
    Math.abs(row.seconds - 2400) < 1,
    `the row must hold where it was paused, got ${row && row.seconds}`
  );
  restore();
});

test("REPORT 4: pressing play resumes where the audio IS, not where the row says", async (t) => {
  /* The founder's fourth report, end to end through the real client.

     `handlePlay` on `interrupted` re-primes the load, and `_loadItem` used to
     take `startOffset` from the stored row for any UNBOUNDED item — so a resume
     was a jump to wherever the row happened to be, however stale. The element
     was sitting right there holding this episode at the playhead the listener
     was actually at.

     KILLING MUTATION: put `bounds &&` back at the front of `resumingInPlace` in
     `queue-manager.js:_loadItem`. The load then starts at the stored 1200
     instead of the 2400 the listener scrubbed to. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  audio.currentTime = 1200;
  audio.fire("timeupdate");
  await settle();

  transport(doc).press();               // pause
  await settle();
  audio.currentTime = 2400;             // scrub ahead while stopped
  audio.fire("seeked");
  await settle();

  transport(doc).press();               // play
  await settle();
  await settle();

  assert.equal(audio.paused, false, "the press started it");
  assert.ok(
    Math.abs(audio.currentTime - 2400) < 1,
    `resumed at ${audio.currentTime}s, not where the listener scrubbed to`
  );
  restore();
});

test("A COLD resume still reads the stored row — the fix above is not a mute", async (t) => {
  /* The other half of the assertion above, and the reason the guard is
     `_loadedId === item.id` rather than "always prefer the element". A page that
     has just booted has loaded nothing: its element's clock is 0 and says
     nothing about this episode, so the row is the only thing that knows where
     the listener was. A fix that preferred the element unconditionally would
     start every session at 0:00 and pass the test above.

     KILLING MUTATION: drop `this._loadedId === item.id` from
     `reEnteringLoadedItem`. */
  const carried = await aSessionThatReached(t, 1800);

  const { client, audio, restore } = await bootClient(t, { seed: carried });
  await client.play(episodeItem());
  await settle();
  assert.ok(
    Math.abs(audio.currentTime - 1800) < 1,
    `a cold start must resume from the row, got ${audio.currentTime}s`
  );
  restore();
});

test("REPORT 3 / #688: one press does what the listener meant when the belief is stale", async (t) => {
  /* BELIEF AND ELEMENT DISAGREE, IN THE DIRECTION NOTHING USED TO CATCH.

     `reconcileWithBackend` only ever corrects "we say playing, the element is
     paused". The founder met the other one: *"I scrubbed ahead, the podcast
     started playing, but the button still said play"* — sound coming out of a
     transport that believes it is stopped. Simulated the only way it can be, by
     its observable consequence: the element is audible and no event was
     delivered. You cannot simulate a car.

     TWO KILLING MUTATIONS, each failing a different assertion:
       - `transportIsRunning()` -> `isRunning()` in `setRunning`: the press is
         swallowed by the short-circuit and `audio.paused` stays false.
       - delete the `elementIsAudible` postcondition in
         `PlayerQueueManager.pause`: the press gets past the short-circuit, the
         reducer is idempotent against a repeated interruption and emits no
         `pausePlayback` at all, and the sound carries on regardless. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();

  transport(doc).press();               // the app believes it is stopped
  await settle();
  assert.equal(transport(doc).label, "Play", "precondition: the button says Play");

  // Something outside this app made the element audible again and told nobody.
  audio.paused = false;

  transport(doc).press();               // the listener presses the "play" button
  await settle();
  await settle();

  assert.equal(
    audio.paused, true,
    "a press while sound is coming out has to stop it, whatever the button said"
  );
  assert.equal(transport(doc).label, "Play", "and the surface agrees afterwards");
  restore();
});

test("the button says what the AUDIO is doing, not what we last believed", async (t) => {
  /* The other half of report 3, and the founder's own bar for it: *"the button
     always agrees with whether sound is coming out"*. A surface cannot repaint
     at the instant of a drift nobody announced — there is no event — but it must
     not hold the lie for the rest of the session either, and before #689 it did:
     every repaint read the belief, so the label was wrong until something moved
     the state machine.

     KILLING MUTATION: `const running = transportIsRunning()` back to
     `const running = isRunning()` in `render()`. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  transport(doc).press();
  await settle();
  assert.equal(transport(doc).label, "Play", "precondition: stopped, and saying so");

  audio.paused = false;          // audible again, and nobody was told
  audio.fire("timeupdate");      // the next ordinary tick, which is all it gets

  assert.equal(
    transport(doc).label, "Pause",
    "the surface stops holding the lie at the first repaint after it"
  );
  restore();
});

test("REPORT 1 (invariant): nothing on the boot or visible path starts audio", async (t) => {
  /* WHAT IS PINNED HERE AND WHAT IS NOT, because the difference matters more
     than the test does.

     The founder's first report is audio starting with no press. Read against the
     code, nothing in this repo can do that. The three methods on
     `PlayerQueueManager` that can start audio without a listener —
     `restoreColdLaunchState({ autoplay })`, `routeChanged`'s known-car resume and
     `interruptionEnded(shouldResume)` — have NO production caller between them;
     every reference outside the manager is in a test. `reconcileWithBackend`
     moves towards paused only, which part 2 already pins. So the cause is
     outside JavaScript — a remote `play` from the car or the lock screen, or the
     native audio session — and `diag.transport(source, …)` is what will name it
     on the founder's device, because it records the presses that changed nothing
     as well as the ones that did.

     This test pins the invariant rather than claiming the fix: a page that boots
     holding a stored position, and then becomes visible, must not make a sound.
     It is what stops the eventual native wiring, or a future "carry on where you
     left off" convenience, from arriving as this report again.

     KILLING MUTATION: add a `manager.resume()` to `reconcileOnReturn`, or an
     `autoplay: true` restore to `ensureBooted`. */
  const carried = await aSessionThatReached(t, 1800);   // the row survives the app dying

  const { doc, audio, restore } = await bootClient(t, { seed: carried });

  // A cold page becoming visible, exactly as it does when the app is re-opened.
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  await settle();

  assert.ok(
    !audio.calls.includes("play"),
    `the boot/visible path started audio: ${audio.calls.join(", ") || "(no calls)"}`
  );
  assert.equal(audio.paused, true, "and nothing is coming out");
  restore();
});

test("a position is never written against an item the element is not holding", async (t) => {
  /* The guard that makes the unconditional flush safe, at the manager. The old
     `isPlaying()` condition was doing this job by accident — a state of `playing`
     implies a load that landed — so dropping it needed the real question asked
     somewhere. `_loadItem` moves `currentIndex` BEFORE `backend.load`, and
     assigning `src` resets the clock to 0, so a failed load leaves a current item
     whose audio the element never received and a playhead of 0. Writing that is
     not a weak position, it is a fabricated one, and it lands on a good row.

     KILLING MUTATION: delete the `this._loadedId !== item.id` refusal in
     `_persistPosition`. The row for `ep-b` is then created at 0. */
  const { m, backend, saved } = playerWith([audioItem("ep-a"), audioItem("ep-b")]);
  await m.play(0);
  backend.currentTime = 1200;
  m._persistPosition();
  assert.equal(Math.round(saved.get("ep-a").seconds), 1200, "the loaded item writes normally");

  // The element is still holding ep-a; the manager has been moved to ep-b by a
  // load that never landed.
  m.currentIndex = 1;
  backend.currentTime = 0;
  m._persistPosition();
  assert.equal(saved.has("ep-b"), false, "a playhead about another item is not a position");
  assert.equal(Math.round(saved.get("ep-a").seconds), 1200, "and the good row is untouched");
});

test("pause() is a postcondition, not a state transition: an audible element is silenced", async () => {
  /* The manager-level half of report 3. `interruptionBegan` is idempotent by
     design, so from `interrupted` it emits nothing at all — correct for a
     duplicate notification from the OS, wrong for a press.

     KILLING MUTATION: revert `pause()` to
     `this._transport("pause", () => this._handle(E.interruptionBegan()))`. */
  const { m, backend } = playerWith([audioItem("s0")]);
  await m.play(0);
  await m.pause();
  assert.equal(backend.paused, true, "precondition: we and the element agree");

  backend.paused = false;               // audible again, and nobody was told
  await m.pause();
  assert.equal(backend.paused, true, "the second pause has to reach the element");
  assert.equal(m.state.type, "interrupted");
});

/* ==================================================================== */
/* part 5 — the 2026-09-22 audit: one authority for every surface        */
/* ==================================================================== */

/* WHAT THIS PART IS FOR. The audit's diagnosis of the whole player: "a correct
   fix was written once, at the call site that hurt, and never promoted to the
   rule". #689 made `transportIsRunning()` the authority for the mini bar's
   button and its press; the card beside it, the lock screen and the Foray page
   kept reading the belief. Each test below drives the #689 drift — the element
   audible while the machine says paused — and asks one more surface what it
   says. */

/** A `navigator.mediaSession` that remembers what the page told it. */
function fakeMediaSession() {
  return {
    handlers: new Map(),
    metadata: null,
    playbackState: "none",
    setActionHandler(action, fn) {
      if (fn) this.handlers.set(action, fn); else this.handlers.delete(action);
    },
    setPositionState() {},
  };
}

/** Play an episode, pause it, then make the element audible behind the
    machine's back — the #689 drift, by its observable consequence. */
async function driftedEpisode(t, opts = {}) {
  const booted = await bootClient(t, opts);
  await booted.client.play(episodeItem());
  await settle();
  transport(booted.doc).press();               // the machine now says paused
  await settle();
  booted.audio.paused = false;                 // ...and sound is coming out
  booted.audio.fire("timeupdate");             // the next ordinary repaint
  return booted;
}

test("AUDIT: the card's glyph comes from the same answer as the bar's", async (t) => {
  /* KILLING MUTATION: `transportIsRunning()` back to `isPlaying()` in
     `syncCardButtons`. The card then reads "▶" beside a bar reading "❚❚". */
  const booted = await bootClient(t);
  const card = new Node("button");
  card.dataset.play = "ep-a";
  booted.doc.querySelectorAll = (sel) => (sel === "[data-play]" ? [card] : []);
  await booted.client.play(episodeItem());
  await settle();
  transport(booted.doc).press();
  await settle();
  assert.equal(card.textContent, "▶", "precondition: paused, and the card says so");
  booted.audio.paused = false;
  booted.audio.fire("timeupdate");
  assert.equal(transport(booted.doc).glyph, "❚❚", "precondition: the bar reads the element");
  assert.equal(card.textContent, "❚❚", "the card must not disagree with the bar");
  booted.restore();
});

test("AUDIT: the lock screen says PLAYING while sound is coming out", async (t) => {
  /* KILLING MUTATION: `playing: transportIsRunning()` back to
     `playing: isPlaying()` in the episode branch of `syncMediaSession`. */
  const ms = fakeMediaSession();
  const booted = await driftedEpisode(t, { mediaSession: ms });
  assert.equal(ms.playbackState, "playing");
  booted.restore();
});

test("AUDIT: the Foray page is handed the answer its press is decided by", async (t) => {
  /* KILLING MUTATION: delete `running: transportIsRunning()` from
     `forayStateSnapshot`. app.js then falls back to `playing || gap`, which is
     false here, and paints "▶ Resume" over sound. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  transport(doc).press();
  await settle();
  assert.equal(client.forayStatus().running, false, "precondition: paused");
  audio.paused = false;
  assert.equal(client.forayStatus().playing, false, "the belief still says paused");
  assert.equal(client.forayStatus().running, true, "the snapshot carries the element's answer");
  restore();
});

/* ---- one episode seek, whatever asked for it ---- */

/** The Now Playing sheet's controls, found by class like `transport` above. */
function findWhere(node, pred) {
  if (pred(node)) return node;
  for (const k of node.children) { const hit = findWhere(k, pred); if (hit) return hit; }
  return null;
}
const labelled = (prefix) => (n) => String(n.getAttribute?.("aria-label") ?? "").startsWith(prefix);
const sheet = (doc) => ({
  /* The mini bar's ↺15 (`.fp-skip`, visual pass 1) is labelled the same way
     and sits earlier in the tree; the sheet's own is the `.fp-btn`. */
  back: findWhere(doc.body, (n) => n.className === "fp-btn" && labelled("Back ")(n)),
  fwd: findWhere(doc.body, labelled("Forward ")),
  scrub: find(doc.body, "fp-scrub"),
  fill: find(doc.body, "fp-fill"),
  left: find(doc.body, "fp-left"),
});

/** A ribbon restored at launch: a stored pointer and a stored position, and no
    audio loaded behind it — exactly what `restoreLastEpisode` paints. */
async function aRestoredRibbon(t, seconds = 1800, opts = {}) {
  const carried = await aSessionThatReached(t, seconds);
  const booted = await bootClient(t, { seed: carried, ...opts });
  const rec = booted.client.restoreLastEpisode();
  assert.ok(rec, "precondition: the ribbon restored");
  assert.equal(booted.audio.calls.includes("load"), false, "precondition: nothing was loaded");
  return booted;
}

test("AUDIT: a scrub on a RESTORED ribbon is where the next press starts", async (t) => {
  /* The restored bar holds no audio, so `manager.seek` hit an empty queue, the
     reducer refused it silently, the thumb snapped back and play started from
     the OLD stored position. KILLING MUTATION: drop `restoredPending != null`
     and the `idle` state from `seekEpisodeTo`'s `nothingToSeekIn`. */
  const { doc, audio, restore } = await aRestoredRibbon(t, 1800);
  const { scrub } = sheet(doc);
  scrub.value = "250";                                   // a quarter of 3600 s
  for (const fn of scrub.listeners.get("change") ?? []) await fn();
  await settle();
  assert.equal(scrub.value, "250", "the thumb stays where the listener put it");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.paused, false, "the press started it");
  assert.ok(Math.abs(audio.currentTime - 900) < 1, `started at ${audio.currentTime}s, not where the thumb was`);
  restore();
});

test("REVIEW: a scrub to 0:00 on a restored ribbon starts at 0:00, not at the stored position", async (t) => {
  /* `play()` does not begin a part-heard episode at 0 — it begins at the stored
     resume point — and the follow-up seek was guarded by `positionSec > 0`, so
     dragging the thumb all the way left showed 0:00 and played from 30:00.
     KILLING MUTATION: put the guard back to `started && positionSec > 0`. */
  const { doc, audio, restore } = await aRestoredRibbon(t, 1800);
  const { scrub } = sheet(doc);
  scrub.value = "0";
  for (const fn of scrub.listeners.get("change") ?? []) await fn();
  await settle();
  assert.equal(scrub.value, "0", "precondition: the thumb shows the start");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.paused, false, "the press started it");
  assert.ok(audio.currentTime < 1, `started at ${audio.currentTime}s, not at the start the bar showed`);
  restore();
});

test("AUDIT: ↺ and ↻ move a restored ribbon too, and ↻ never crosses the end", async (t) => {
  /* KILLING MUTATION: put `manager.seek(... + SEEK_FWD)` back in the ↻ handler
     (no restored-bar rule, no upper clamp). */
  const { doc, client, restore } = await aRestoredRibbon(t, 3560);
  const { fwd, back, left } = sheet(doc);
  assert.equal(left.textContent, "-0:40", "precondition: forty seconds left");
  await fwd.click();                                     // 3590
  await settle();
  await fwd.click();                                     // 3620, past the 3600 s end
  await settle();
  assert.equal(left.textContent, "-0:01", "clamped one second short of the end");
  await back.click();                                    // 3599 - 15
  await settle();
  assert.equal(left.textContent, "-0:16");
  assert.equal(client.isCurrent("ep-a"), true, "and nothing ended");
  restore();
});

test("AUDIT: an episode that has ENDED can still be scrubbed back into", async (t) => {
  /* `handleSeek` refuses in `ended`, and `manager.seek` resolves normally
     anyway, so the scrub did nothing and the thumb snapped back to the far
     right. KILLING MUTATION: drop `manager.state?.type === "ended"` from
     `nothingToSeekIn`. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  audio.runOut();
  await settle();
  const { scrub, left } = sheet(doc);
  /* The countdown at the exact end has nothing left to count, so no minus
     sign. KILLING MUTATION: `remainingClock` returning `-${clock}` always. */
  assert.equal(left.textContent, "0:00", "the end is not '-0:00'");
  scrub.value = "500";
  for (const fn of scrub.listeners.get("change") ?? []) await fn();
  await settle();
  assert.equal(scrub.value, "500", "the thumb stays at the middle");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.paused, false);
  assert.ok(Math.abs(audio.currentTime - 1800) < 1, `resumed at ${audio.currentTime}s`);
  restore();
});

test("AUDIT: an episode with no known duration paints an EMPTY bar, not the last episode's", async (t) => {
  /* KILLING MUTATION: put the `dur &&` guard back around the fill with no else. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem("ep-a"));
  await settle();
  audio.currentTime = 2880;                              // 80% of the first episode
  audio.fire("timeupdate");
  assert.equal(sheet(doc).fill.style.width, "80%", "precondition: the first episode's fill");
  audio.duration = NaN;                                  // the next feed carries none
  await client.play({ ...episodeItem("ep-b"), duration_sec: null });
  await settle();
  audio.currentTime = 0;
  audio.fire("timeupdate");
  assert.equal(sheet(doc).fill.style.width, "0%");
  assert.equal(sheet(doc).scrub.value, "0");
  assert.equal(sheet(doc).left.textContent, "--:--");
  restore();
});

/* ---- where a press starts, and what the card says ---- */

test("AUDIT: a cold start on a FINISHED episode begins at the top, not at the outro", async (t) => {
  /* `PositionStore.resumeOffset` holds the near-end rule and had no caller
     outside its own file; the manager read the raw row. KILLING MUTATION:
     make `_savedPositionFor` read `this.positionStore.load(item.id)?.seconds`
     unconditionally. */
  const carried = await aSessionThatReached(t, 3590);
  const { client, audio, restore } = await bootClient(t, { seed: carried });
  await client.play(episodeItem());
  await settle();
  assert.equal(audio.paused, false);
  assert.ok(audio.currentTime < 1, `a finished episode starts over, got ${audio.currentTime}s`);
  restore();
});

test("AUDIT: the Jump back in card says a finished episode is FINISHED", async (t) => {
  /* The card reads how far the listener GOT, which is the raw row; where a
     press starts is the collapsed offset. KILLING MUTATION: feed `offset` to
     the card's reading again — "60 min left", 0%. INTEGRATION (2026-09-22): L5
     fixed the same defect through the shared `episodeProgress` reading, whose
     word for a finished episode is "Played" on every surface; that one won. */
  const carried = await aSessionThatReached(t, 3590);
  const { client, restore } = await bootClient(t, { seed: carried });
  const card = client.lastEpisodeCard();
  assert.ok(card, "the pointer is still offered");
  assert.equal(card.label, "Played");
  assert.equal(card.percent, 100);
  assert.equal(card.position_sec, 0, "and a press on it starts from the top");
  const mid = await aSessionThatReached(t, 1800);
  const again = await bootClient(t, { seed: mid });
  assert.equal(again.client.lastEpisodeCard().label, "30 min left", "a part-heard episode is unchanged");
  again.restore();
  restore();
});

test("AUDIT: play after an episode RAN OUT starts it again from the top", async (t) => {
  /* The element still holds the item with its playhead on the last second, so
     the in-place resume took it for a pause. KILLING MUTATION: drop
     `this.backend.ended !== true` from `reEnteringLoadedItem`. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  audio.runOut();
  await settle();
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.paused, false);
  assert.ok(audio.currentTime < 1, `play after the end restarts, got ${audio.currentTime}s`);
  restore();
});

/* ---- the Foray's clock, translated into a source file's ---- */

/** `synthetic()` with a rendered narration bridge in front: an item with a file
    of its own and NO `start_sec`, which is the shape the NaN came from. */
function withBridge() {
  const foray = {
    id: "f263n", kind: "deep-dive", title: "A Foray", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "narration", slot: "one", id: "n1", audio_url: "https://cdn.test/n1.mp3", duration_sec: 30, script: "Hello." },
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-a", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-a", show: "Show A", title: "Ep A", audio_url: "https://cdn.test/a.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  return resolveForay(foray, { segments, sources });
}

test("AUDIT: a scrub to the very END of a Foray lands inside the last segment, so the boundary still fires", async (t) => {
  /* `segmentAtElapsed` answers "at or past the total" with the last segment's
     END, and a seek landing exactly on the out-point reads to the backend as a
     deliberate scrub past it — disarmed, so the audio free-played into the rest
     of a stranger's episode. KILLING MUTATION: drop the `len - SEEK_INSIDE_END_SEC`
     clamp from `sourceOffsetFor`. */
  const { client, audio, restore } = await bootClient(t);
  const resolved = synthetic();
  await client.playForay(resolved, { startIndex: 1 });
  await settle();
  await client.foraySeek(resolved.totalSec);
  await settle();
  assert.ok(audio.currentTime < 600, `landed at ${audio.currentTime}s, which is on or past the out-point`);
  audio.currentTime = 600.01;
  audio.fire("timeupdate");
  await settle();
  await settle();
  assert.equal(client.forayStatus().ended, true, "the boundary fired and the Foray ended");
  restore();
});

test("AUDIT: a scrub into a narration bridge lands where it was aimed, not at its first word", async (t) => {
  /* A bridge has no `start_sec`; `undefined + into` was NaN and the seek was
     refused. KILLING MUTATION: `sourceOffsetFor` returning
     `item.start_sec + inside` unconditionally. */
  const { client, audio, restore } = await bootClient(t);
  const resolved = withBridge();
  assert.equal(resolved.playable[0].start_sec, undefined, "precondition: the bridge has no bounds");
  await client.playForay(resolved, { startIndex: 0 });
  await settle();
  await client.foraySeek(20);
  await settle();
  assert.ok(Math.abs(audio.currentTime - 20) < 0.01, `bridge seek landed at ${audio.currentTime}s`);
  restore();
});

test("AUDIT: \"Next clip\" is disabled on the last segment instead of silently doing nothing", async (t) => {
  /* KILLING MUTATION: delete the `ui.clipNext.disabled` line in `render()`.
     (Visual pass 1, persona 58: the control is the sheet's labelled clip
     button now, not the ›› the seek pair used to turn into.) */
  const { client, doc, restore } = await bootClient(t);
  const fwd = () => findWhere(doc.body, (n) => n.textContent === "Next clip ›");
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  assert.equal(fwd().disabled, false, "segment 1 of 2 has a next");
  await client.forayNext();
  await settle();
  assert.equal(fwd().disabled, true, "the last segment has none, and says so");
  restore();
});

test("AUDIT: a FINISHED Foray can be scrubbed back into its last segment", async (t) => {
  /* KILLING MUTATION: drop the `ended` clause from `foraySeek`'s `reload`. */
  const { client, audio, restore } = await bootClient(t);
  const resolved = synthetic();
  await client.playForay(resolved, { startIndex: 1 });
  await settle();
  audio.runOut();
  await settle();
  await settle();
  assert.equal(client.forayStatus().ended, true, "precondition: over");
  await client.foraySeek(resolved.totalSec - 50);           // the middle of segment sb
  await settle();
  await settle();
  assert.equal(audio.paused, false, "the scrub reloaded it");
  assert.ok(Math.abs(audio.currentTime - 550) < 1, `landed at ${audio.currentTime}s`);
  restore();
});

/* ---- a load that was superseded before it landed ---- */

test("AUDIT: a superseded load's listeners do not touch its successor's playhead", async () => {
  /* The listeners are bound to the ELEMENT, so load A (at 30:00) superseded by
     load B (at 0:00) kept listening to B's events and wrote A's offset onto B.
     KILLING MUTATION: drop the `superseded()` check from `load()`'s `onMeta`. */
  const { b, el } = mkBackend();
  el.holdLoad = true;
  const pA = b.load(audioItem("a"), { startOffset: 1800 });
  pA.catch(() => {});
  const pB = b.load(audioItem("b"), { startOffset: 0 });
  el.holdLoad = false;
  el.releaseLoad();
  await pB;
  assert.equal(el.currentTime, 0, "B starts where B was asked to start");
  await assert.rejects(pA, /superseded/, "and A is not reported as a success");
});

/** A backend whose load of `heldId` waits until the test lets it go. */
function heldBackend(heldId) {
  const backend = new Backend();
  const real = backend.load.bind(backend);
  let release = null;
  backend.load = (item, opts) => {
    if (item.id !== heldId) return real(item, opts);
    return new Promise((resolve, reject) => {
      release = (ok) => (ok ? real(item, opts).then(resolve, reject) : reject(new Error("network")));
    });
  };
  return { backend, release: (ok = true) => release(ok) };
}

test("AUDIT: a load that lands after a newer one never claims the playhead", async () => {
  /* KILLING MUTATION: stamp `this._loadedId = item.id` before the
     `_loadSeq !== seq` check in `_loadItem`. */
  const { backend, release } = heldBackend("a");
  const { m } = playerWith([audioItem("a"), audioItem("b")], { backend });
  const first = m.play(0);                 // A, held in flight
  await m.play(1);                         // the listener tapped B
  assert.equal(m.playheadItemId, "b");
  release(true);
  await first;
  assert.equal(m.playheadItemId, "b", "the element holds B, so the playhead is about B");
  assert.equal(m.state.type, "playing");
});

test("AUDIT: a superseded load that FAILS does not stop the load that replaced it", async () => {
  /* KILLING MUTATION: drop the `_loadSeq !== seq` guard from `_loadItem`'s
     catch — the stale failure dispatches `error` and the reducer goes idle. */
  const { backend, release } = heldBackend("a");
  const { m, log } = playerWith([audioItem("a"), audioItem("b")], { backend });
  const first = m.play(0);
  await m.play(1);
  release(false);
  await first;
  assert.equal(m.state.type, "playing", "B is still playing");
  assert.ok(log.some((l) => /load\.superseded a/.test(l)), "and the stale failure is recorded as such");
});

/* ---- the bar says why there is no sound ---- */

/* The bar's second line is the show line, or the status line standing in for
   it (`fp-err`, a live region) while there is something to say. The sheet's
   status line sits under the transport (`fp-err-line`). INTEGRATION
   (2026-09-22): L2 and L5 fixed the failure line separately; the merged player
   paints both lanes' states through one painter into L5's elements. */
const secondLine = (doc) => {
  const err = find(doc.body, "fp-err");
  return err && !err.hidden ? err.textContent : find(doc.body, "fp-show").textContent;
};
const statusNote = (doc) => find(doc.body, "fp-err-line");

test("AUDIT: an episode whose audio will not load says so, and play() reports it", async (t) => {
  /* KILLING MUTATIONS: `return true` at the end of `play()` (the result
     assertion), or delete the `!foray && current && /player\.error/` block in
     `onTelemetry` (the line assertions). */
  const { client, doc, audio, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/ep-a.mp3", "error");
  const ok = await client.play(episodeItem());
  await settle();
  assert.equal(ok, false, "a 404 is not a start");
  assert.match(secondLine(doc), /Did not load/, "the mini bar says it failed");
  assert.match(statusNote(doc).textContent, /could not load/, "and the sheet's status line says why");
  /* REVIEW 2026-09-23: the live region is NOT inside the bar's <button> (whose
     children are presentational, so VoiceOver never announced it) but its
     sibling, and the button's own name carries the failure. KILLING MUTATION:
     move `announce` back inside `info`, or drop the paintInfoLabel() call from
     paintStatus. */
  const hasClass = (c) => (n) => String(n.className || "").split(/\s+/).includes(c);
  const live = findWhere(doc.body, hasClass("fp-announce"));
  assert.equal(live.getAttribute("role"), "status", "the failure is announced");
  assert.match(live.textContent, /could not load/, "with the full sentence");
  const info = find(doc.body, "fp-info");
  assert.equal(findWhere(info, hasClass("fp-announce")), null, "and the live region is not inside the named button");
  assert.equal(find(info, "fp-err").getAttribute("role"), null, "the visible line inside the button claims no role");
  assert.match(info.getAttribute("aria-label"), /Did not load/, "the button's name says what the bar shows");
  assert.doesNotMatch(info.getAttribute("aria-label"), /Show A/, "not the show line hidden behind it");

  // The connection comes back and the listener does what the line said.
  audio.loadPlan.set("https://cdn.test/ep-a.mp3", "ok");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.paused, false, "the retry is the same press");
  assert.equal(secondLine(doc), "Show A", "and the failure line goes with the audio");
  restore();
});

test("REVIEW: a play the browser held back keeps its 'Press play again' line after app.js reports the refusal", async (t) => {
  /* play() now answers false for a refused start, so bindPlay's `if (!ok)`
     runs and calls reportPlayFailure(null) — AFTER the telemetry sink had
     painted the autoplay line. The generic "Did not load … check the
     connection" replaced it. KILLING MUTATION: drop the
     `if (err == null && playFailure) return;` guard in reportPlayFailure. */
  const { client, doc, audio, restore } = await bootClient(t);
  audio.refusePlayWith = "NotAllowedError";
  const ok = await client.play(episodeItem());
  await settle();
  assert.equal(ok, false, "precondition: a refused start is not a start");
  assert.match(secondLine(doc), /Press play again/, "precondition: the sink said why");
  client.reportPlayFailure(null);              // what bindPlay does with `!ok`
  assert.match(secondLine(doc), /Press play again/, "the specific line stays");
  assert.doesNotMatch(statusNote(doc).textContent, /could not load/, "no connection is blamed");
  restore();
});

test("AUDIT: a network stall paints Buffering, and the sound coming back clears it", async (t) => {
  /* KILLING MUTATION: delete the `waiting` -> `setBuffering(true)` listener. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  assert.equal(secondLine(doc), "Show A", "precondition");
  audio.fire("waiting");
  assert.equal(secondLine(doc), "Buffering…");
  assert.equal(statusNote(doc).textContent, "Buffering…");
  audio.fire("playing");
  assert.equal(secondLine(doc), "Show A");
  // A fetch stall over a full buffer is not silence, so it paints nothing.
  audio.fire("stalled");
  assert.equal(secondLine(doc), "Show A", "`stalled` alone is not a stall the listener hears");
  restore();
});

/* ---- the car's buttons ---- */

test("AUDIT: the head unit's STOP pauses and leaves every other control working", async (t) => {
  /* `stopAndClose()` from a remote stop ran `release()`, which unregisters
     every handler — the car was left with no transport at all. KILLING
     MUTATION: put `return stopAndClose();` back in `episodeMediaSurface.stop`. */
  const ms = fakeMediaSession();
  const { client, doc, audio, restore } = await bootClient(t, { mediaSession: ms });
  await client.play(episodeItem());
  await settle();
  assert.equal(audio.paused, false, "precondition: playing");
  await ms.handlers.get("stop")();
  await settle();
  assert.equal(audio.paused, true, "the stop stopped the sound");
  assert.ok(ms.handlers.has("play"), "and the car's play button is still wired");
  assert.equal(find(doc.body, "fp").hidden, false, "and the mini bar is still there");
  await ms.handlers.get("play")();
  await settle();
  await settle();
  assert.equal(audio.paused, false, "so the next press on the wheel resumes");
  restore();
});

test("REVIEW: the Android notification's own Stop (`close`) still closes a PAUSED player", async (t) => {
  /* On Android 24-33 a foreground-service notification cannot be swiped away, so
     its Stop button is the listener's only exit. It arrives as the `stop` handler
     with `{ close: true }` (foray-media-session.js `CLOSE_ACTION`). When the audit
     made every remote stop a pause, a listener who had already paused pressed Stop
     and nothing changed — the notification stayed until they unlocked the phone.
     KILLING MUTATION: drop the `details?.close` branch from `remoteStop`. */
  const ms = fakeMediaSession();
  const { client, doc, audio, restore } = await bootClient(t, { mediaSession: ms });
  await client.play(episodeItem());
  await settle();
  await ms.handlers.get("pause")();
  await settle();
  assert.equal(audio.paused, true, "precondition: the listener paused first");
  assert.equal(find(doc.body, "fp").hidden, false, "precondition: the bar is up");
  await ms.handlers.get("stop")({ close: true });
  await settle();
  assert.equal(find(doc.body, "fp").hidden, true, "the notification's Stop closed the player");
  assert.equal(ms.handlers.has("play"), false, "and released the session, which is what stops the service");
  restore();
});

test("AUDIT: the steering wheel's next/previous appear when the page offers them, and not before", async (t) => {
  /* KILLING MUTATION: make `setEpisodeNavigation` store the answer without
     re-installing the actions — the OS keeps the greyed-out buttons until the
     next play. */
  const ms = fakeMediaSession();
  const { client, restore } = await bootClient(t, { mediaSession: ms });
  await client.play(episodeItem());
  await settle();
  assert.equal(ms.handlers.has("nexttrack"), false, "no list, no skip button");
  const asked = [];
  client.setEpisodeNavigation({ next: () => asked.push("next") });
  assert.equal(ms.handlers.has("nexttrack"), true, "a list with a next item offers the button");
  assert.equal(ms.handlers.has("previoustrack"), false, "and only the one it can honour");
  await ms.handlers.get("nexttrack")();
  assert.deepEqual(asked, ["next"], "the press reaches the page's own advance");
  client.setEpisodeNavigation(null);
  assert.equal(ms.handlers.has("nexttrack"), false, "withdrawn when the list has nothing after");
  restore();
});

test("REVIEW: the page's neighbours are asked about the episode that is NOW current", async (t) => {
  /* app.js answers "next after what?" from `currentEpisodeId()`, and play()
     installs the actions BEFORE `setNowPlaying` moves `current` — so the only
     ask was about the PREVIOUS episode, and a skip wired from it would replay
     or skip the wrong row. KILLING MUTATION: drop `reaskEpisodeNeighbours()`
     from play(). */
  const ms = fakeMediaSession();
  const { client, restore } = await bootClient(t, { mediaSession: ms });
  await client.play(episodeItem("ep-a"));
  await settle();
  const askedAbout = [];
  client.setEpisodeNavigation({
    get next() { askedAbout.push(client.currentEpisodeId()); return () => {}; },
  });
  await client.play(episodeItem("ep-b"));
  await settle();
  assert.equal(askedAbout[askedAbout.length - 1], "ep-b", "the last ask is about the episode on the bar");
  restore();
});

/* ==================================================================== */
/* part 6 — founder report 1 (2026-09-22): a resumed episode restarts     */
/*          from a stale position                                        */
/* ==================================================================== */

/* THE ROOT CAUSE, as STATE.md's handoff recorded it: `PositionStore.save` had
   one production caller, a 15 s interval armed only while the REDUCER said
   `playing`. An element resumed from outside the reducer — a car or lock-screen
   press WebKit's own media session honoured, a WebView woken by the OS — never
   moved the reducer, so nothing wrote the playhead for the whole ride; the
   reconcile only ever corrected towards paused; and the native session events
   reached the diagnostic record and nothing else. Simulated here by their
   observable consequence, as parts 3-4 do: the element plays and nobody pressed
   anything in this page. You cannot simulate a car. */

/** The native shell's `foray:session`, as `foray-media-session.js` dispatches it. */
function nativeSession(win, detail) {
  for (const fn of [...(win.listeners.get("foray:session") ?? [])]) fn({ detail });
}

/** Played to `at`, paused by the listener: the machine now says `interrupted`. */
async function pausedAt(t, at = 600, opts = {}) {
  const booted = await bootClient(t, opts);
  await booted.client.play(episodeItem());
  await settle();
  booted.audio.currentTime = at;
  booted.audio.fire("timeupdate");
  transport(booted.doc).press();
  await settle();
  assert.equal(booted.audio.paused, true, "precondition: paused");
  return booted;
}

/** The lock screen's play, honoured by WebKit without asking this page. */
async function resumedFromOutside(audio) {
  audio.paused = false;
  audio.fire("play");
  audio.fire("playing");
  await settle();
}

test("REPORT 1: an element resumed from OUTSIDE the reducer still has its position written", async (t) => {
  /* KILLING MUTATION: delete the manager's `timeupdate` -> `_persistIfDue`
     hook. The reducer is corrected to `playing` by the test below's fix, but
     the interval is 15 s of wall clock and never fires here, so without the
     element-driven writer the row stays at 600 for the whole ride. */
  const { audio, storage, restore } = await pausedAt(t, 600);
  assert.ok(Math.abs(posRow(storage, "ep-a").seconds - 600) < 1, "precondition: the pause wrote 600");
  await resumedFromOutside(audio);
  audio.currentTime = 1500;
  audio.fire("timeupdate");
  assert.ok(
    Math.abs(posRow(storage, "ep-a").seconds - 1500) < 1,
    `the ride's position must be written, got ${posRow(storage, "ep-a").seconds}`
  );
  // And it is throttled by media seconds, not written at 4 Hz.
  audio.currentTime = 1504;
  audio.fire("timeupdate");
  assert.ok(Math.abs(posRow(storage, "ep-a").seconds - 1500) < 1, "four seconds later is inside the delta");
  restore();
});

test("REPORT 1: the machine is corrected TOWARDS playing when the element plays", async (t) => {
  /* KILLING MUTATION: delete the `interrupted` branch at the top of
     `reconcileWithBackend`. The machine then says paused over sound, and the
     NEXT external stop (the car switched off) is invisible to the reconcile,
     which only catches a machine that says `playing`. */
  const { client, doc, audio, restore } = await pausedAt(t, 600);
  const before = audio.calls.length;
  await resumedFromOutside(audio);
  assert.equal(client.isPlaying("ep-a"), true, "the machine agrees with the element");
  assert.deepEqual(
    audio.calls.slice(before).filter((c) => c === "play" || c === "load"), [],
    "and the correction started and loaded nothing itself"
  );
  audio.routeLostUnseen();
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  assert.equal(transport(doc).label, "Play", "so the next unseen stop is caught on return");
  restore();
});

test("REPORT 1: the native BACKGROUND event flushes the position, with no visibilitychange", async (t) => {
  /* The WebView does not always deliver `visibilitychange` when the APP goes
     away. KILLING MUTATION: delete `flushPositions()` from `onNativeSession`. */
  const { win, audio, storage, restore } = await pausedAt(t, 1200);
  audio.currentTime = 2400;                 // scrubbed while paused: the row is behind
  audio.fire("seeked");
  assert.ok(Math.abs(posRow(storage, "ep-a").seconds - 1200) < 1, "precondition: the row is stale");
  nativeSession(win, { kind: "background", reason: "did-enter", producer: "audio", at: Date.now() });
  assert.ok(Math.abs(posRow(storage, "ep-a").seconds - 2400) < 1, `got ${posRow(storage, "ep-a").seconds}`);
  restore();
});

test("REPORT 1: a route that DISAPPEARED pauses the transport and writes where it stopped", async (t) => {
  /* Corner case #13, now reachable from the device. KILLING MUTATION: delete
     the `old-device-gone` branch from `onNativeSession`. */
  const { client, doc, win, audio, storage, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  audio.currentTime = 1800;
  nativeSession(win, { kind: "routeChange", reason: "old-device-gone", producer: "audio", at: Date.now() });
  await settle();
  await settle();
  assert.equal(audio.paused, true, "the car went away, so the sound stops");
  assert.equal(transport(doc).label, "Play");
  assert.ok(Math.abs(posRow(storage, "ep-a").seconds - 1800) < 1, "at the second it stopped");
  restore();
});

test("REPORT 1: a LATE interruption never pauses audio the listener has since resumed", async (t) => {
  /* A suspended page handles a native event when it wakes, so an interruption
     can arrive after the listener pressed play on the lock screen. It is a
     reason to ASK the element, never a command. KILLING MUTATION: replace the
     reconcile in `onNativeSession` with `manager.interruptionBegan()`. */
  const { client, doc, win, audio, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  nativeSession(win, { kind: "interruptionBegan", reason: "began", producer: "audio", at: Date.now() - 60_000 });
  await settle();
  await settle();
  assert.equal(audio.paused, false, "the element is playing, so the stale event changes nothing");
  // A real one: the call took the audio and the page saw no `pause`.
  audio.routeLostUnseen();
  nativeSession(win, { kind: "interruptionBegan", reason: "began", producer: "audio", at: Date.now() });
  await settle();
  await settle();
  assert.equal(transport(doc).label, "Play", "and a real one is caught by asking");
  restore();
});

test("AUDIT: play on a FINISHED Foray starts it over instead of replaying its last segment", async (t) => {
  /* The page now labels this press "Start over", and this is what makes the
     label true. KILLING MUTATION: delete the `ended` branch in `setRunning` —
     the press then re-loads segment 2 at its in-point and the index stays 1. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 1 });
  await settle();
  await settle();
  audio.runOut();
  await settle();
  await settle();
  assert.equal(client.forayStatus().ended, true, "precondition: the Foray is over");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(client.forayStatus().index, 0, "the press goes back to the first segment");
  assert.equal(audio.src, "https://cdn.test/a.mp3", "and loads its audio");
  restore();
});

/* ==================================================================== */
/* part 7 — founder report 2 (2026-09-22): the element's side of an      */
/*          unexplained stop                                              */
/* ==================================================================== */

test("REPORT 2: an unexplained pause says what state the element was in", async () => {
  /* `diagnostic-log.js` parses these off the line (its own suite pins that);
     this pins that the backend WRITES them. KILLING MUTATION: emit the old
     bare `audio.pausedUnexpectedly — nobody asked for this pause`. */
  const { b, el, log } = mkBackend();
  await b.load(audioItem("a"));
  b.play();
  await null;
  el.currentTime = 61.25;
  el.readyState = 2;                 // HAVE_CURRENT_DATA: starving
  el.networkState = 2;               // NETWORK_LOADING
  el.routeLost();
  const line = log.find((l) => l.startsWith("audio.pausedUnexpectedly"));
  assert.match(line, /^audio\.pausedUnexpectedly t=61\.3 rs=2 ns=2 err=0 /);
});

/* ==================================================================== */
/* part 8 — founder report 3 (2026-09-22): the record says which build   */
/* ==================================================================== */

test("REPORT 3: a booted shell writes BOTH halves of the build into the record it will copy out", async (t) => {
  /* Through the real client.js: the bundled stamp for the web half, the
     binary's own `getInfo` for the native half. KILLING MUTATION: delete the
     `recordBuildStamp()` call beside `diag.boot()`. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url) === "build-stamp.json"
    ? { ok: true, json: async () => ({ deploy_id: "2b808ec9d50c5b98" }) }
    : { ok: false, status: 404, json: async () => ({}) });
  t.after(() => { globalThis.fetch = realFetch; });
  const capacitor = { nativePromise: async () => ({ build: "2026092224", version: "1.4.0" }) };
  const { restore } = await bootClient(t, { capacitor });
  await settle();
  await settle();
  const report = globalThis.window.forayDiagnosticReport();
  assert.match(report, /^build web 2b808ec9d50c5b98 · native 2026092224 \(1\.4\.0\)$/m);
  restore();
});

/* ==================================================================== */
/* part 9 — the bar offers whatever was played LAST (persona audit       */
/*          2026-09-22, the car tier: "a part-played Foray cannot be     */
/*          resumed from the mini bar")                                   */
/* ==================================================================== */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** An episode, then a Foray played to 50 s into its first segment (or the
    other way round) — the rows the next launch finds on disk. */
async function aSessionThatPlayed(t, order) {
  const first = await bootClient(t);
  for (const what of order) {
    if (what === "episode") {
      await first.client.play(episodeItem());
      await settle();
    } else {
      await first.client.playForay(synthetic(), { startIndex: 0 });
      await settle();
      first.audio.currentTime = 150;          // segment sa is [100, 200]
      first.audio.fire("timeupdate");
      await settle();
    }
    await pause(5);                           // distinct `updated_at` stamps
  }
  transport(first.doc).press();
  await settle();
  const rows = [...first.storage.map];
  first.restore();
  return rows;
}

test("PERSONA: a Foray played after an episode takes the bar, and one press resumes it where it was", async (t) => {
  /* KILLING MUTATIONS: make `lastPlayedForay` return null (the bar offers the
     older episode), or delete the `pendingForay` branch in `setRunning` (the
     press finds no audio to play). */
  const carried = await aSessionThatPlayed(t, ["episode", "foray"]);
  const { client, doc, audio, restore } = await bootClient(t, { seed: carried });
  assert.equal(client.lastPlayedForay(), "f263", "the Foray is the most recent thing played");
  const resolved = synthetic();
  const at = client.forayResume("f263", { resolved });
  assert.ok(client.restoreForay(resolved, { startElapsedSec: at.elapsedSec }), "the bar is painted");
  assert.equal(find(doc.body, "fp-title").textContent, "A Foray");
  assert.equal(audio.calls.includes("load"), false, "and nothing is loaded until the press");
  transport(doc).press();
  await settle();
  await settle();
  assert.equal(audio.src, "https://cdn.test/a.mp3");
  assert.equal(audio.paused, false);
  assert.ok(Math.abs(audio.currentTime - 150) < 1, `resumed at ${audio.currentTime}s`);
  assert.equal(client.forayStatus()?.forayId, "f263", "as the Foray, not as an episode");
  restore();
});

test("REVIEW: a Foray page opened over the restored bar hears the bar's press", async (t) => {
  /* The page rendered while nothing was live, so `watchForay` attached nothing;
     the bar's press then started the Foray with no `onChange`, the page kept
     saying "Resume", and its button restarted the Foray instead of pausing.
     KILLING MUTATION: `onChange ?? forayWatcher` back to `onChange` in
     playForay (or drop the `forayWatcher =` line in watchForay). */
  const carried = await aSessionThatPlayed(t, ["episode", "foray"]);
  const { client, doc, restore } = await bootClient(t, { seed: carried });
  const resolved = synthetic();
  const at = client.forayResume("f263", { resolved });
  assert.ok(client.restoreForay(resolved, { startElapsedSec: at.elapsedSec }), "precondition: the bar is painted");
  const painted = [];
  client.watchForay((s) => painted.push(s));   // the Foray page renders now
  assert.equal(painted.length, 0, "precondition: nothing is live to report");
  transport(doc).press();                      // ▶ on the mini bar
  await settle();
  await settle();
  assert.ok(painted.length > 0, "the page is told the Foray started");
  const last = painted[painted.length - 1];
  assert.equal(last.forayId, "f263");
  assert.equal(last.playing, true, "so it can paint Pause, and its button pauses rather than restarts");
  restore();
});

test("PERSONA: an episode played AFTER the Foray keeps the bar", async (t) => {
  /* KILLING MUTATION: drop the `forayAt > episodeAt` comparison. */
  const carried = await aSessionThatPlayed(t, ["foray", "episode"]);
  const { client, restore } = await bootClient(t, { seed: carried });
  assert.equal(client.lastPlayedForay(), null);
  restore();
});

/* ==================================================================== */
/* part 10: the audit's completeness sweep (2026-09-23) — rows another  */
/* lane handed on, re-verified live on the integration branch           */
/* ==================================================================== */

test("SWEEP: playing an item with no id leaves the last-episode pointer alone", async (t) => {
  /* qa row 169. `makeLastEpisode` answers null for an id-less item and
     `writeLastEpisode(null)` DELETES the pointer. KILLING MUTATION: put back
     `writeLastEpisode(storage, makeLastEpisode(item))` unconditionally. */
  const { client, storage, restore } = await bootClient(t);
  await client.play(episodeItem("ep-a"));
  await settle();
  assert.equal(JSON.parse(storage.getItem("cp_last_episode")).id, "ep-a", "precondition: the pointer is written");
  await client.play({ kind: "episode", title: "No id", show: "Show", audio_url: "https://cdn.test/noid.mp3" });
  await settle();
  const after = storage.getItem("cp_last_episode");
  assert.ok(after, "the pointer survived");
  assert.equal(JSON.parse(after).id, "ep-a");
  restore();
});

test("SWEEP: the lock screen shows a RESTORED bar's position, not the empty element's 0:00", async (t) => {
  /* qa row 161. `syncMediaSession` read `backend.currentTime`, which on a
     restored bar is 0 while the bar says 30:00. KILLING MUTATION: put back
     `positionSec: backend?.currentTime ?? 0` in the episode branch. */
  const ms = fakeMediaSession();
  const states = [];
  ms.setPositionState = (s) => { if (s) states.push(s); };
  const { restore } = await aRestoredRibbon(t, 1800, { mediaSession: ms });
  assert.ok(states.length > 0, "the restored bar wrote a position to the OS");
  const last = states[states.length - 1];
  assert.ok(Math.abs(last.position - 1800) < 1, `the lock screen says ${last.position}s, the bar says 1800s`);
  assert.equal(last.duration, 3600);
  restore();
});

/** A native Preferences tier whose answers wait for `release()` — hydration
    that lands AFTER the player has booted, which is qa row 168's shape. */
function lateNativeStore(rows) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const capacitor = {
    nativePromise: async (plugin, method, opts = {}) => {
      if (plugin !== "Preferences") return {};
      await gate;
      if (method === "keys") return { keys: Object.keys(rows) };
      if (method === "get") return { value: rows[opts.key] ?? null };
      return {};
    },
  };
  return { capacitor, release: () => release() };
}

test("REVIEW 2026-09-23: a speed that arrives AFTER the record's five-second bound still reaches the booted player", async (t) => {
  /* The bound `client.js` puts on the field record's wait (`HYDRATE_WAIT_MS`)
     was applied to `storageReady`, and the rate restore below awaited the same
     promise. So a durable tier that answered at six seconds -- a cold
     Preferences read, not a hang -- saw the restore run at five with the default
     speed, find it equal to the manager's, correct nothing, and never run again:
     the listener's stored 1.5x was lost for the session, which is the exact
     case the block was written for. It now awaits real hydration
     (`storageHydrated`). Mocked timers, so the bound passes for free; the store
     is released only after it. KILLING MUTATION: await `storageReady` in the
     rate-restore block again -- the button reads 1x after the release. */
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const late = lateNativeStore({ cp_rate: "1.5" });
  const { client, doc, audio, restore } = await bootClient(t, { capacitor: late.capacitor });
  await client.play(episodeItem());
  await drain();
  assert.equal(find(doc.body, "fp-rate").textContent, "1×", "precondition: booted before the stored speed arrived");
  t.mock.timers.tick(5_001);
  await drain();
  assert.equal(find(doc.body, "fp-rate").textContent, "1×", "the bound passed; nothing arrived yet");
  late.release();
  await drain();
  assert.equal(find(doc.body, "fp-rate").textContent, "1.5×", "the stored speed reached the button after the bound");
  assert.equal(audio.playbackRate, 1.5, "and the element");
  restore();
});

test("SWEEP: a speed that arrives with late hydration reaches a player that already booted", async (t) => {
  /* qa row 168. The manager was built from the rate as it stood at boot (the
     default), and the late repaint read `manager.rate` back and confirmed 1x for
     the session. KILLING MUTATION: drop the `manager.setRate(stored)` block
     from the `storageReady` handler. */
  const late = lateNativeStore({ cp_rate: "1.5" });
  const { client, doc, audio, restore } = await bootClient(t, { capacitor: late.capacitor });
  await client.play(episodeItem());
  await settle();
  assert.equal(find(doc.body, "fp-rate").textContent, "1×", "precondition: booted before the stored speed arrived");
  late.release();
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(find(doc.body, "fp-rate").textContent, "1.5×", "the stored speed is on the button");
  assert.equal(audio.playbackRate, 1.5, "and on the element");
  restore();
});

test("SWEEP: a speed the listener chose before hydration landed is not overruled by the store", async (t) => {
  /* The other half of the same rule: the late store must not overrule a choice
     made inside the window. Held by the durable store's own rule (hydration
     never clobbers a key written since construction), which the new handler
     leans on instead of a flag of its own — pinned here so a handler that
     read the durable tier directly would fail. KILLING MUTATION: in the
     handler, `manager.setRate(1.5)` in place of `readRate(storage)`. */
  const late = lateNativeStore({ cp_rate: "1.5" });
  const { client, doc, audio, restore } = await bootClient(t, { capacitor: late.capacitor });
  await client.play(episodeItem());
  await settle();
  client.setPlaybackRate(2);
  late.release();
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(find(doc.body, "fp-rate").textContent, "2×");
  assert.equal(audio.playbackRate, 2);
  restore();
});

test("SWEEP: Jump back in's Foray rows read the LIVE runtime, as the Foray page's resume does", async (t) => {
  /* qa row 163. `forayResumeList` measured percent and "min left" against the
     runtime stored with the row; `forayResume` measures against the Foray as it
     resolves now. A regenerated Foray made the two disagree. KILLING MUTATION:
     stop passing `totalSec: liveTotal` into `resumePoint` in `forayResumeList`. */
  const carried = await aSessionThatPlayed(t, ["foray"]);
  const { client, restore } = await bootClient(t, { seed: carried });
  const longer = synthetic();
  longer.totalSec = 1250;                     // the Foray grew since the row was written
  const stored = client.forayResumeList().find((r) => r.id === "f263");
  assert.ok(stored, "precondition: the row is listed");
  const row = client.forayResumeList({ resolveFor: (id) => (id === "f263" ? longer : null) }).find((r) => r.id === "f263");
  const page = client.forayResume("f263", { resolved: longer });
  assert.equal(row.totalSec, 1250);
  assert.equal(row.percent, page.percent, "the rail and the Foray page agree on how far in");
  assert.equal(row.label, page.label, "and on how long is left");
  assert.notEqual(row.label, stored.label, "which is not what the stored runtime said");
  const throwing = client.forayResumeList({ resolveFor: () => { throw new Error("no docs"); } }).find((r) => r.id === "f263");
  assert.equal(throwing.label, stored.label, "a resolver that fails leaves the stored reading");
  restore();
});

/* ======================================================================
   VISUAL PASS 1 (2026-09-23): the seek pair stays the seek pair (persona 58),
   and the mini bar gains one nudge (persona 10)
   ====================================================================== */

test("VISUAL PASS: inside a Foray the sheet's ↺15 nudges within the clip — it does not restart it", async (t) => {
  /* The ‹‹ that used to replace ↺15 called `forayPrevious`, which RESTARTS the
     current clip unless you are under 4 s into it: tap "back" eleven minutes
     in and lose the eleven minutes. KILLING MUTATION: put
     `foray ? ForayPlayer.forayPrevious() : …` back in the backBtn handler. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  const { back, fwd } = sheet(doc);
  assert.equal(back.textContent, "↺ 15", "the glyph never becomes ‹‹");
  assert.equal(fwd.textContent, "30 ↻", "the glyph never becomes ››");
  audio.currentTime = 150;                                // 50 s into clip 1 (100–200)
  audio.fire("timeupdate");
  await settle();
  await back.click();
  await settle();
  assert.ok(Math.abs(audio.currentTime - 135) < 0.01, `landed at ${audio.currentTime}s: 15 s back, not the clip's start`);
  assert.equal(client.forayStatus().index, 0, "still the same clip");
  await fwd.click();
  await settle();
  assert.ok(Math.abs(audio.currentTime - 165) < 0.01, `↻ moved 30 s forward (${audio.currentTime}s)`);
  restore();
});

test("VISUAL PASS: the mini bar's ↺15 is the same nudge, for an episode and for a Foray", async (t) => {
  /* KILLING MUTATION: drop `skipBtn` from `bar.append(...)`, or point its
     handler at `forayPrevious`. */
  const { client, doc, audio, restore } = await bootClient(t);
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  const skip = find(doc.body, "fp-skip");
  assert.ok(skip, "the bar carries a skip control");
  assert.equal(skip.getAttribute("aria-label"), "Back 15 seconds");
  audio.currentTime = 150;
  audio.fire("timeupdate");
  await settle();
  await skip.click();
  await settle();
  assert.ok(Math.abs(audio.currentTime - 135) < 0.01, `Foray: landed at ${audio.currentTime}s`);
  assert.equal(client.forayStatus().index, 0);
  restore();
});

test("VISUAL PASS: previous/next clip are their own labelled row, shown only while a Foray is loaded", async (t) => {
  /* KILLING MUTATION: delete `ui.clips.hidden = !isForay` from
     setSkipButtonMode -> the row shows over a plain episode (first assertion),
     or never shows (second). */
  const { client, doc, restore } = await bootClient(t);
  await client.play(episodeItem());
  await settle();
  const clips = find(doc.body, "fp-clips");
  assert.ok(clips, "the sheet has a clip row");
  assert.equal(clips.hidden, true, "an episode has no clips to move between");
  await client.playForay(synthetic(), { startIndex: 0 });
  await settle();
  assert.equal(clips.hidden, false, "a Foray shows it");
  const next = findWhere(doc.body, (n) => n.textContent === "Next clip ›");
  const prev = findWhere(doc.body, (n) => n.textContent === "‹ Previous clip");
  assert.ok(next && prev, "both controls are labelled in words, not glyphs");
  await next.click();
  await settle();
  assert.equal(client.forayStatus().index, 1, "Next clip moved to clip 2");
  assert.equal(next.disabled, true, "and on the last clip it is disabled");
  await prev.click();
  await settle();
  assert.equal(client.forayStatus().index, 0, "Previous clip, just into a clip, goes back one");
  restore();
});
