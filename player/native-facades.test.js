/* The facades (player/native-facades.js; plan §5.6; NE-21): the manager and
   backend client.js reads, answered by the native engine.

   Most tests here run the whole page-side stack — native-engine.js over
   parity/reference-engine.js (the real PlayerQueueManager behind protocol v1) — so a
   facade that says the right thing about a fake is not enough to pass.

   THESE ARE THE JS-ONLY FACADE TESTS transport-reconcile.test.js maps to
   (player/parity/facades.json, plan §6.5). That suite is about one failure: the
   page's belief and the audio disagreeing, and a press spent correcting the
   app (#263, #689). In native mode the page's side of that rule lives HERE —
   the belief is the engine's snapshot, re-read on return — and each test below
   is named in facades.json by the reconcile tests whose page-side rule it
   carries. Rules the Swift engine reimplements are not mapped here; they are
   owed to the engine's own cards in unported.json. */

import test from "node:test";
import assert from "node:assert/strict";

import { createNativeFacades, mediaEventsBetween, MEDIA_TICK_MS } from "./native-facades.js";
import { createNativeEngine, ENGINE_PLUGIN } from "./native-engine.js";
import { ReferenceEngine } from "./parity/reference-engine.js";
import { HtmlAudioBackend } from "./html-audio-backend.js";
import { contractSchemaDocument } from "./engine-contract.js";
import { continuationPlan } from "./continuation.js";
import { manualScheduler, tick } from "./parity/fakes.js";

const MEDIA_TYPES = ["play", "playing", "pause", "waiting", "ended", "emptied"];
const SNAP = contractSchemaDocument().$defs.snapshot["x-examples"].valid;

const episode = (id, extra = {}) => ({
  id, kind: "episode", title: `Title ${id}`, show: `Show ${id}`,
  audio_url: `https://cdn.test/${id}.mp3`, duration_sec: 3600, ...extra,
});

/** The whole page-side stack over the reference engine. */
async function stack({ engine = {}, facades = {} } = {}) {
  const scheduler = manualScheduler();
  let pageNow = 10_000;
  const ref = new ReferenceEngine({ scheduler, now: () => 1790000000000, ...engine });
  const eng = createNativeEngine({ capacitor: ref.asCapacitor(), scheduler, now: () => pageNow });
  const mode = await eng.engineModeReady;
  assert.equal(mode.mode, "native");
  const f = createNativeFacades({ engine: eng, scheduler, ...facades });
  const media = [];
  for (const type of MEDIA_TYPES) f.backend.addMediaListener(type, () => media.push(type));
  const cmds = () => ref.diagnostics.filter((r) => r.kind === "cmd").map((r) => r.cmd);
  /** Let events cross the bridge, and the engine's 1 Hz window close. */
  const settle = async () => { await tick(); await scheduler.advance(1000); await tick(); };
  return {
    ref, eng, f, scheduler, media, cmds, settle,
    passPageTime(ms) { pageNow += ms; },
    done() { f.dispose(); ref.dispose(); },
  };
}

/** A scripted engine, for snapshots the reference cannot easily produce. */
async function scripted(first = SNAP.playing) {
  const listeners = new Set();
  const sent = [];
  let pageNow = 10_000;
  const scheduler = manualScheduler();
  const capacitor = {
    getPlatform: () => "ios",
    isPluginAvailable: (n) => n === ENGINE_PLUGIN,
    nativePromise(plugin, method, payload) {
      if (method === "engineHello") {
        return Promise.resolve({
          mode: "native", reason: "build-default", engineVersion: "t", protocol: 1, capabilities: ["episode"],
          ownedKeyPrefixes: ["cp_pos:", "cp_foray:", "cp_last_episode"], snapshot: first, pendingAdvances: [], pendingEvents: [],
        });
      }
      if (method === "engineSend") { sent.push(payload); return Promise.resolve({ ok: true, snapshot: first }); }
      return Promise.resolve(first);
    },
    addListener(p, e, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; },
  };
  const eng = createNativeEngine({ capacitor, scheduler, now: () => pageNow });
  await eng.engineModeReady;
  const f = createNativeFacades({ engine: eng, scheduler });
  const media = [];
  for (const type of [...MEDIA_TYPES, "timeupdate"]) f.backend.addMediaListener(type, () => media.push(type));
  let seq = first.seq;
  return {
    eng, f, media, sent, scheduler,
    passPageTime(ms) { pageNow += ms; },
    async push(over) {
      seq += 1;
      const snapshot = { ...first, ...over, seq };
      for (const fn of [...listeners]) queueMicrotask(() => fn(JSON.parse(JSON.stringify({ type: "snapshot", snapshot }))));
      await tick();
    },
  };
}

/* ---------- the element trace ---------- */

/** An <audio> element as the spec fires its events: `play` when the paused
    flag drops, `playing` once audio flows, `pause` only if it was playing, a
    run-out fires `pause` BEFORE `ended`, and a second load fires `emptied`. */
class SpecElement {
  constructor() {
    this.listeners = new Map();
    this.src = ""; this.currentSrc = ""; this.currentTime = 0; this.duration = NaN;
    this.playbackRate = 1; this.volume = 1; this.preload = "none";
    this.readyState = 0; this.paused = true; this.ended = false; this.error = null;
  }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn({ type: t }); }
  load() {
    if (this.currentSrc) this.fire("emptied");
    this.currentSrc = this.src; this.currentTime = 0; this.readyState = 0; this.ended = false;
    queueMicrotask(() => {
      this.readyState = 1; this.duration = 3600; this.fire("loadedmetadata");
      queueMicrotask(() => { this.readyState = 4; if (this.currentTime > 0) this.fire("seeked"); this.fire("canplay"); });
    });
  }
  play() {
    if (this.paused) {
      this.paused = false; this.ended = false; this.fire("play");
      queueMicrotask(() => { if (!this.paused) this.fire("playing"); });
    }
    return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; this.fire("pause"); } }
  removeAttribute() { this.src = ""; }
  runOut() { this.currentTime = this.duration; this.paused = true; this.ended = true; this.fire("pause"); this.fire("ended"); }
}

test("synthesised media events match an HtmlAudioBackend trace for play -> pause -> play -> ended", async () => {
  // MUTATION: in mediaEventsBetween, push "ended" before "pause" -> the orders differ.
  // MUTATION: drop the `playing` push on not-running -> running -> one short.
  const el = new SpecElement();
  const real = new HtmlAudioBackend({ element: el });
  const want = [];
  for (const type of MEDIA_TYPES) real.addMediaListener(type, () => want.push(type));
  await real.load(episode("a"));
  real.play(); await tick();
  real.pause();
  real.play(); await tick();
  el.runOut(); await tick();
  real.release();
  assert.deepStrictEqual(want, ["play", "playing", "pause", "play", "playing", "pause", "ended"], "the element's own trace");

  const s = await stack();
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0); await s.settle();
  await s.f.manager.pause(); await s.settle();
  await s.f.manager.resume(); await s.settle();
  await s.ref.deck("ended"); await s.settle();
  assert.deepStrictEqual(s.media, want);
  s.done();
});

test("mediaEventsBetween: a new item empties, a stall waits, and a position that moved updates", () => {
  const base = { state: "playing", running: true, ended: false, buffering: false, inSeamGap: false, itemId: "a", positionSec: 10 };
  assert.deepStrictEqual(mediaEventsBetween(base, { ...base, itemId: "b", positionSec: 0 }), ["emptied", "timeupdate"]);
  assert.deepStrictEqual(mediaEventsBetween(base, { ...base, buffering: true }), ["waiting"]);
  assert.deepStrictEqual(mediaEventsBetween({ ...base, buffering: true }, base), ["playing"]);
  assert.deepStrictEqual(mediaEventsBetween(base, { ...base, positionSec: 40 }), ["timeupdate"]);
  assert.deepStrictEqual(mediaEventsBetween(null, { ...base, state: "loadingItem" }), ["play", "timeupdate"],
    "a load in flight has been asked to play and is not yet playing");
  assert.deepStrictEqual(mediaEventsBetween(base, base), []);
});

/* ---------- the belief is the engine's (transport-reconcile's page side) ---------- */

test("attach replaces a stale belief with the engine's word, says it corrected, and one press then sends one intent", async () => {
  // MUTATION: make attach() return false without reading -> the belief stays
  // "playing" and the press after it is a pause, not a resume.
  const s = await stack();
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  await s.eng.setVisible(false);
  // The engine stops while the page is asleep (a route gone, a car switched
  // off): the engine saw it, the page did not.
  await s.ref.manager.pause();
  s.ref._transition();
  await s.settle();
  assert.equal(s.f.manager.state.type, "playing", "precondition: the page's belief is stale");

  assert.equal(await s.f.manager.attach("visible"), true);
  assert.equal(s.f.manager.state.type, "interrupted");
  assert.equal(s.f.manager.elementIsAudible, false);
  assert.equal(await s.f.manager.reconcileWithBackend("visible"), false, "nothing new: corrects once");

  const before = s.cmds().length;
  await s.f.manager.resume();
  assert.deepStrictEqual(s.cmds().slice(before), ["play"], "one press, one intent");
  assert.equal(s.ref.manager.state.type, "playing");
  s.done();
});

test("attach only READS: returning to the page sends no command, so it can never start audio", async () => {
  // MUTATION: make attach() send "play" -> a command crosses and the paused
  // engine starts.
  const s = await stack();
  assert.deepStrictEqual(s.cmds(), [], "the boot path (hello, facades) sent nothing");
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  await s.f.manager.pause();
  const ops = s.ref.log.ops.length;
  const cmds = s.cmds().length;
  for (let i = 0; i < 3; i++) await s.f.manager.attach("visible");
  assert.equal(s.cmds().length, cmds, "no command crossed");
  assert.deepStrictEqual(s.ref.log.ops.slice(ops), [], "the deck was not touched");
  assert.equal(s.ref.manager.state.type, "interrupted");
  s.done();
});

test("one authority: state, elementIsAudible and the media events all read the same snapshot", async () => {
  // MUTATION: make elementIsAudible read `s.running` alone -> true during a stall.
  const s = await scripted({ ...SNAP.playing, durationSec: 3600 });
  assert.equal(s.f.manager.state.type, "playing");
  assert.equal(s.f.manager.elementIsAudible, true);
  assert.equal(s.f.backend.paused, false);
  await s.push({ buffering: true, effectiveRate: 0 });
  assert.deepStrictEqual([s.f.manager.state.type, s.f.manager.elementIsAudible], ["playing", false], "a stall: running, not audible");
  await s.push({ buffering: false, isNarrationPlayhead: true });
  assert.equal(s.f.manager.elementIsAudible, false, "a spoken line is not the element's sound (as the manager answers)");
  await s.push({ isNarrationPlayhead: false, state: "interrupted", running: false, wasPlaying: true, effectiveRate: 0 });
  assert.deepStrictEqual(s.f.manager.state, { type: "interrupted", wasPlaying: true });
  assert.equal(s.f.manager.elementIsAudible, false);
  assert.equal(s.f.backend.paused, true);
});

/* ---------- a press carries its own start ---------- */

test("a play carries its own start into playEpisode — one command, never play-then-seek — and 0:00 is a start", async () => {
  // MUTATION: `at > 0` instead of `at >= 0` in play() -> the 0:00 press resumes
  // at the stored 1200 s.
  const s = await stack();
  s.ref.positions.save("a", 1200, { duration: 3600 });
  s.ref.positions.save("c", 900, { duration: 3600 });
  const loads = () => s.ref.log.ops.filter((o) => o.startsWith("load:"));

  s.f.manager.setQueueFromPick(episode("a"));
  assert.equal(await s.f.manager.play(0, { startOffset: 0 }), true);
  s.f.manager.setQueueFromPick(episode("b"));
  await s.f.manager.play(0, { startOffset: 1800 });
  s.f.manager.setQueueFromPick(episode("c"));
  await s.f.manager.play(0);
  assert.deepStrictEqual(loads(), ["load:a@0", "load:b@1800", "load:c@900"]);
  assert.deepStrictEqual(s.cmds(), ["playEpisode", "playEpisode", "playEpisode"], "no seekTo follows a play");
  s.done();
});

/* ---------- where the playhead is, and how long ---------- */

test("the playhead and the duration are the snapshot's: extrapolated while flowing, frozen otherwise, null while unknown", async () => {
  // MUTATION: make backend.duration return `durationSec ?? 0` -> the unknown
  // duration paints a zero-length bar instead of an empty one.
  const s = await scripted({ ...SNAP.playing, positionSec: 100, durationSec: 3000, effectiveRate: 1 });
  s.passPageTime(4000);
  assert.equal(s.f.backend.currentTime, 104);
  assert.equal(s.f.backend.duration, 3000, "the MEASURED duration, the engine's");
  await s.push({ state: "loadingItem", itemId: "b", playheadItemId: null, positionSec: 1200, durationSec: null, effectiveRate: 0 });
  s.passPageTime(5000);
  assert.equal(s.f.backend.currentTime, 1200, "a cold load shows its resume point and does not run");
  assert.equal(s.f.backend.duration, null, "unknown is null, never the last episode's");
  await s.push({ state: "interrupted", running: false, wasPlaying: false, positionSec: 50, durationSec: 3000, effectiveRate: 0 });
  s.passPageTime(5000);
  assert.equal(s.f.backend.currentTime, 50, "paused is frozen");
});

/* ---------- refusals ---------- */

test("a refused play answers false and keeps the engine's reason for the bar", async () => {
  // MUTATION: return `true` from _send regardless -> the page records a play that never happened.
  const s = await stack({ engine: { activation: () => ({ ok: false, token: "cannot-start-playing" }) } });
  s.f.manager.setQueueFromPick(episode("a"));
  assert.equal(await s.f.manager.play(0), false);
  assert.equal(s.f.manager.lastRefusal, "session-failed:cannot-start-playing");
  assert.ok(!s.ref.log.ops.includes("play"));
  s.done();
});

/* ---------- a stall ---------- */

test("a stall synthesises waiting, and audio flowing again synthesises playing", async () => {
  // MUTATION: drop the `waiting` branch for running -> running -> no Buffering.
  const s = await stack();
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  await s.settle();
  s.media.length = 0;
  await s.ref.deck("stall"); await s.settle();
  await s.ref.deck("flowing"); await s.settle();
  assert.deepStrictEqual(s.media, ["waiting", "playing"]);
  s.done();
});

/* ---------- next / previous ---------- */

test("next and previous are offered exactly when the engine says so, and not before the page's chain", async () => {
  // MUTATION: make canNext read the facade's own queue length -> true before any chain.
  const s = await stack();
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  assert.equal(s.f.manager.canNext, false, "no chain yet: nothing to skip to");
  assert.equal(s.f.manager.canPrevious, true);
  const plan = continuationPlan(
    { currentId: "a", queue: ["b"], playList: null, playChainId: null, playListCursor: null, items: { b: episode("b") }, isPlayable: ["b"] },
    { planSeq: 1, autoAdvance: false },
  );
  await s.eng.send("setContinuation", plan);
  assert.equal(s.f.manager.canNext, true);
  s.done();
});

/* ---------- a pointer needs an id ---------- */

test("an item with no id sends nothing and moves no pointer", async () => {
  // MUTATION: drop the `!item?.id` return in play() -> the command reaches the
  // engine client, which refuses it as unknown-cmd: lastRefusal is no longer
  // null. (The client's own contract check is the second net, and it is why
  // no command crosses either way.)
  const s = await stack();
  s.f.manager.setQueueFromPick({ title: "no id", audio_url: "https://cdn.test/x.mp3" });
  assert.equal(await s.f.manager.play(0), false);
  assert.equal(s.f.manager.lastRefusal, null, "refused by the facade itself, before any payload was built");
  assert.deepStrictEqual(s.cmds(), []);
  assert.equal(s.ref.storage.getItem("cp_last_episode"), null);
  s.done();
});

/* ---------- the listener's speed ---------- */

test("a rate set at any moment reaches the engine, and the label reads it back before the engine answers", async () => {
  // MUTATION: make `rate` read the snapshot's rate -> the label reads 1 while
  // the send is in flight (the snapshot the page holds predates the change).
  const s = await stack();
  const p = s.f.manager.setRate(1.5);
  assert.equal(s.f.manager.rate, 1.5, "the label reads the choice before the engine has answered");
  await p;
  assert.equal(s.ref.manager.rate, 1.5, "and the engine took it, booted or not");
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  await s.f.manager.setRate(2);
  assert.equal(s.ref.manager.rate, 2, "a speed that arrives after the player booted still reaches it");
  assert.equal(s.f.manager.rate, 2);
  s.done();
});

/* ---------- the natural end ---------- */

test("the natural end reaches the page as pause then ended with no command sent, and repaints through onStateSettled", async () => {
  // MUTATION: in createNativeFacades, skip manager.onSnapshot -> onStateSettled never hears "ended".
  const settled = [];
  const s = await stack({ facades: { onStateSettled: (st) => settled.push(st.type) } });
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  await s.settle();
  s.media.length = 0;
  const cmds = s.cmds().length;
  await s.ref.deck("ended");
  await s.settle();
  assert.deepStrictEqual(s.media, ["pause", "ended"]);
  assert.equal(s.cmds().length, cmds, "the end needed no command from the page");
  assert.equal(settled.at(-1), "ended");
  s.done();
});

/* ---------- the ticker ---------- */

test("the timeupdate ticker runs once a second, only while visible and only while audio flows", async () => {
  // MUTATION: drop `this.engine.visible` from _syncTick -> ticks while hidden.
  const s = await scripted({ ...SNAP.playing });
  await tick();
  s.media.length = 0;
  await s.scheduler.advance(MEDIA_TICK_MS);
  await s.scheduler.advance(MEDIA_TICK_MS);
  assert.deepStrictEqual(s.media, ["timeupdate", "timeupdate"]);
  await s.eng.setVisible(false);
  await tick();
  s.media.length = 0;
  await s.scheduler.advance(5 * MEDIA_TICK_MS);
  assert.deepStrictEqual(s.media, [], "hidden: the page is not painted");
  await s.eng.setVisible(true);
  await tick();
  s.media.length = 0;
  await s.push({ state: "interrupted", running: false, wasPlaying: true, effectiveRate: 0 });
  s.media.length = 0;
  await s.scheduler.advance(5 * MEDIA_TICK_MS);
  assert.deepStrictEqual(s.media, [], "paused: nothing to update");
});

/* ---------- what the page no longer does ---------- */

test("positions, routes and interruptions are the engine's: the facade writes nothing and decides nothing", async () => {
  const s = await stack();
  s.f.manager.setQueueFromPick(episode("a"));
  await s.f.manager.play(0);
  const cmds = s.cmds().length;
  s.f.manager._persistPosition();
  assert.equal(await s.f.manager.routeChanged({ oldDeviceUnavailable: true }), false);
  assert.equal(await s.f.manager.interruptionEnded(true), false);
  assert.equal(s.cmds().length, cmds);
  assert.throws(() => s.f.manager.setQueueFromForay({ id: "f" }), /capability-off/);
  assert.equal(s.f.backend.notePlayGesture(), undefined);
  s.done();
});

test("a page booted while the engine is already playing reports the engine's item, not an empty queue", async () => {
  const s = await scripted({ ...SNAP.playing, itemId: "ep-9", itemKind: "episode", nowPlaying: { title: "Nine", artist: "", album: "" } });
  assert.deepStrictEqual(s.f.manager.queue, [{ id: "ep-9", kind: "episode", title: "Nine" }]);
  assert.equal(s.f.manager.currentIndex, 0);
  assert.deepStrictEqual(s.sent, [], "attaching to a running engine sends nothing");
});
