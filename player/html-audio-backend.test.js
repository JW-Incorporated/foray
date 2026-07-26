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
