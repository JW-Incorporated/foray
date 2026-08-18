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
import { progressKey } from "./foray-progress.js";

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
    queueMicrotask(() => {
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
    });
  }
  play() {
    this.calls.push("play");
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

     Kill it by widening the state guard (`=== "idle"`, or dropping it). */
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
  click() { for (const fn of [...(this.listeners.get("click") ?? [])]) fn({}); }
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
let bootSeq = 0;
async function bootClient() {
  const audio = new Element();
  const storage = new MemoryStorage();
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
  set("navigator", { storage: { persisted: async () => false } });
  set("Event", class { constructor(type) { this.type = type; } });
  /* `HtmlAudioBackend` constructs `new Audio()`, not `document.createElement`.
     One element per boot, handed back so the test can be the car. */
  set("Audio", function Audio() { return audio; });
  __resetInstanceForTests();

  /* NOT restored before the test body runs. `client.js` reads `document` and
     `window` live from inside its handlers, so the stub has to stay installed
     for the whole test; each test calls `restore()` itself. */
  const client = (await import(`./client.js?reconcile=${++bootSeq}`)).default;
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

test("THE FOUNDER'S PRESS: after a stop the page never saw, the transport says Play", async () => {
  const { client, doc, audio, restore } = await bootClient();
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

  const t = transport(doc);
  assert.equal(t.label, "Play", "one press must resume, not correct a belief");
  assert.equal(t.glyph, "▶");
  restore();
});

test("and the press resumes — the reconcile did not start anything itself", async () => {
  const { client, doc, audio, restore } = await bootClient();
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

test("a finished Foray does not come back looking mid-listen", async () => {
  /* The reconcile's `ended` guard, end to end. A file that ran out is paused —
     and `pause` fires BEFORE `ended` — so anything reading only `paused` calls a
     finished Foray an interruption and hands the listener back a transport that
     offers to resume something that is over. */
  const { client, doc, audio, restore } = await bootClient();
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

test("A FAILED SEAM MUST NOT REWRITE THE RESUME ROW WITH THE FAILED SEGMENT'S IN-POINT", async () => {
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
  const { client, doc, audio, storage, restore } = await bootClient();
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

test("a position that CAN be read is still written, so the refusal is not a mute", async () => {
  /* The other half of the assertion above: a guard that simply stopped writing
     would pass that test and lose every resume point in the app. */
  const { client, audio, storage, restore } = await bootClient();
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
