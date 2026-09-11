/* Tests for the interlude jingle (player/interlude.js, §13 of queue-manager.js).

   Three things, each pinned separately because each can be deleted without
   the others noticing:

     1. THE RULE — `interludeEligible`, a decision table.
     2. THE PLAYER — `createInterludePlayer` over a fake `<audio>`: 1.0x always,
        not-ready refused, `ended` reported once, `stop()` never reported.
     3. THE ASSET — the committed WAV's measured properties, read from its own
        header and samples: the duration constant the code carries, the format
        every host decodes, the peak the file was normalised to, the size cap.

   The CLOCK (how the jingle rides the seam beat) is queue-manager.test.js's job. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  interludeEligible, describeInterlude, createInterludePlayer,
  readInterludePref, writeInterludePref,
  INTERLUDE_ASSET_URL, INTERLUDE_ASSET_PATH, INTERLUDE_DURATION_SEC, INTERLUDE_CEILING_SEC,
  INTERLUDE_RATE, INTERLUDE_KEY,
} from "./interlude.js";
import { AUTO_ADVANCE, USER_ACTION } from "./seam-gap.js";
import { JINGLE } from "./foray-queue.js";

const seg = (id, extra = {}) => ({ id, kind: "episode", start_sec: 100, end_sec: 210, ...extra });
const nar = (id) => ({ id, kind: "tts", script: "a line" });
const episode = (id) => ({ id, kind: "episode" });
const jingle = (id) => ({ id, kind: JINGLE });

/* ---------- 1. the rule ---------- */

test("the rule: into a segment on auto-advance, from anything but a jingle", () => {
  /* MUTATIONS, one per row: drop `!from` (row 3 flips), drop `!to` (row 4),
     drop `isSegment(to)` (rows 5-6), drop the cause check (row 7), drop the
     JINGLE clause (row 8). */
  const rows = [
    [{ from: seg("a"), to: seg("b") }, true, "segment -> segment"],
    [{ from: nar("n"), to: seg("b") }, true, "narration -> segment"],
    [{ from: null, to: seg("b") }, false, "before the first item"],
    [{ from: seg("a"), to: null }, false, "after the last item"],
    [{ from: seg("a"), to: nar("n") }, false, "segment -> narration: the narration is the marker"],
    [{ from: nar("n"), to: nar("m") }, false, "narration -> narration"],
    [{ from: seg("a"), to: seg("b"), cause: USER_ACTION }, false, "a skip: the listener named a destination"],
    [{ from: jingle("j"), to: seg("b") }, false, "an authored jingle just played: one mark per seam"],
    [{ from: episode("e"), to: seg("b") }, true, "an unbounded episode -> a segment still counts"],
    [{ from: seg("a"), to: episode("e") }, false, "into an unbounded episode: not a tape seam"],
    [{ from: seg("a"), to: seg("b"), cause: AUTO_ADVANCE }, true, "explicit auto cause"],
  ];
  for (const [seam, expected, why] of rows) {
    assert.equal(interludeEligible(seam), expected, why);
  }
  assert.equal(interludeEligible(), false, "no arguments at all");
});

test("describeInterlude names the decision it made, not one it did not", () => {
  assert.equal(describeInterlude({ from: seg("a"), to: seg("b") }), "jingle: a -> b");
  assert.match(describeInterlude({ from: seg("a"), to: seg("b"), cause: USER_ACTION }), /user-driven/);
  assert.match(describeInterlude({ from: null, to: seg("b") }), /nothing before/);
  assert.match(describeInterlude({ from: seg("a"), to: null }), /nothing follows/);
  assert.match(describeInterlude({ from: seg("a"), to: nar("n") }), /not a tape segment/);
  assert.match(describeInterlude({ from: jingle("j"), to: seg("b") }), /already a jingle/);
});

/* ---------- the setting ---------- */

test("the preference is ON unless the store says the literal 'off', and a broken store is ON", () => {
  const store = (value) => ({ getItem: () => value });
  assert.equal(readInterludePref(store(null)), true, "absent");
  assert.equal(readInterludePref(store("on")), true);
  assert.equal(readInterludePref(store("off")), false);
  assert.equal(readInterludePref(store("OFF")), true, "only the exact spelling — a stray value must not silence the product");
  assert.equal(readInterludePref(null), true);
  assert.equal(readInterludePref({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("writeInterludePref stores 'on'/'off' under the cp_ key and reports a refusal", () => {
  const written = new Map();
  const store = { setItem: (k, v) => written.set(k, v), getItem: (k) => written.get(k) ?? null };
  assert.equal(writeInterludePref(store, false), true);
  assert.equal(written.get(INTERLUDE_KEY), "off");
  assert.equal(readInterludePref(store), false, "round-trips");
  assert.equal(writeInterludePref(store, true), true);
  assert.equal(readInterludePref(store), true);
  assert.equal(writeInterludePref({ setItem: () => { throw new Error("full"); } }, true), false);
  assert.equal(writeInterludePref(null, true), false);
  assert.ok(INTERLUDE_KEY.startsWith("cp_"), "CLAUDE.md § Conventions: every key keeps the cp_ prefix");
});

/* ---------- 2. the player ---------- */

function fakeElement({ readyState = 4, rejectPlay = false, throwPlay = false } = {}) {
  const listeners = {};
  return {
    readyState, networkState: 1, currentTime: 7, playbackRate: 2, muted: false, paused: true,
    src: "", preload: "", volume: 1,
    calls: [],
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of listeners[type] ?? []) fn(); },
    play() {
      this.calls.push("play");
      if (throwPlay) throw new Error("no play for you");
      this.paused = false;
      return rejectPlay ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
    },
    pause() { this.calls.push("pause"); this.paused = true; },
    load() { this.calls.push("load"); },
    removeAttribute(name) { this.calls.push(`remove:${name}`); if (name === "src") this.src = ""; },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("construction points the element at the asset and asks for it up front", () => {
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  assert.equal(el.src, INTERLUDE_ASSET_URL);
  assert.equal(el.preload, "auto");
  assert.equal(p.active, false);
  assert.equal(p.url, INTERLUDE_ASSET_URL);
  const custom = createInterludePlayer({ element: fakeElement(), url: "https://x.example/j.wav" });
  assert.equal(custom.element.src, "https://x.example/j.wav");
});

test("start() rewinds, forces 1.0x whatever the element had, plays, and reports active", () => {
  /* MUTATION: delete the `el.playbackRate = INTERLUDE_RATE` line — the element
     keeps the 2x it was built with, and the jingle would speed up with the
     listener's setting. */
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  assert.equal(el.playbackRate, 2, "the fake starts at a listener's 2x");
  assert.equal(p.start(), true);
  assert.equal(el.playbackRate, INTERLUDE_RATE);
  assert.equal(INTERLUDE_RATE, 1.0);
  assert.equal(el.currentTime, 0, "from the top, every time");
  assert.equal(el.muted, false);
  assert.deepEqual(el.calls, ["play"]);
  assert.equal(p.active, true);
  assert.equal(p.start(), false, "a second start while sounding is refused");
  assert.deepEqual(el.calls, ["play"], "and does not touch the element");
});

test("start() refuses an element that has not buffered, and does not play it", () => {
  /* The seam keeps its beat instead. MUTATION: drop the readyState check —
     `play` is called on an empty element and the jingle arrives late. */
  const el = fakeElement({ readyState: 2 });
  const p = createInterludePlayer({ element: el, telemetry: () => {} });
  assert.equal(p.start(), false);
  assert.deepEqual(el.calls, []);
  assert.equal(p.active, false);
});

test("the element's `ended` reports once, and a stop is never reported", async () => {
  /* MUTATION: drop the `_active` clear in `stop()`'s first line — the `ended`
     after the stop reaches the manager as a second end for a jingle it cut. */
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  const ends = [];
  p.onEnded = (reason) => ends.push(reason);
  p.start();
  el.fire("ended");
  el.fire("ended");
  assert.deepEqual(ends, ["ended"], "exactly once per start");
  assert.equal(p.active, false);

  p.start();
  p.stop();
  assert.equal(p.active, false);
  assert.ok(el.calls.includes("pause"));
  assert.equal(el.currentTime, 0, "rewound for the next seam");
  el.fire("ended");
  el.fire("error");
  assert.deepEqual(ends, ["ended"], "a stop reports nothing, and stray events after it report nothing");
});

test("an `error` reports 'error'; a rejected play() reports 'rejected'; a throwing play() refuses", async () => {
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  const ends = [];
  p.onEnded = (reason) => ends.push(reason);
  p.start();
  el.fire("error");
  assert.deepEqual(ends, ["error"]);

  const rej = fakeElement({ rejectPlay: true });
  const q = createInterludePlayer({ element: rej });
  const ends2 = [];
  q.onEnded = (reason) => ends2.push(reason);
  assert.equal(q.start(), true, "the call was made; the refusal is asynchronous");
  await tick();
  assert.deepEqual(ends2, ["rejected"]);
  assert.equal(q.active, false);

  const thr = fakeElement({ throwPlay: true });
  const r = createInterludePlayer({ element: thr, telemetry: () => {} });
  assert.equal(r.start(), false);
  assert.equal(r.active, false);
});

test("prime() spends the gesture muted, then rewinds and unmutes; once per session", async () => {
  /* MUTATION: drop `el.muted = true` before the play — the priming tap plays
     the jingle out loud. */
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  let mutedDuringPlay = null;
  const origPlay = el.play.bind(el);
  el.play = function () { mutedDuringPlay = this.muted; return origPlay(); };
  assert.equal(p.prime(), true);
  assert.equal(mutedDuringPlay, true, "never audible");
  await tick();
  assert.equal(el.muted, false);
  assert.equal(el.paused, true);
  assert.equal(el.currentTime, 0);
  assert.equal(p.prime(), false, "the restriction lifts once; a second tap does nothing");
  assert.equal(el.calls.filter((c) => c === "play").length, 1);
});

test("no element on this host: every method is inert and start() says so", () => {
  const p = createInterludePlayer({ element: null });
  assert.equal(p.prime(), false);
  assert.equal(p.start(), false);
  assert.equal(p.active, false);
  assert.doesNotThrow(() => { p.stop(); p.release(); });
});

test("release() silences, drops the source, and refuses to start again", () => {
  const el = fakeElement();
  const p = createInterludePlayer({ element: el });
  p.start();
  p.release();
  assert.equal(p.active, false);
  assert.ok(el.calls.includes("remove:src"));
  assert.equal(p.start(), false);
  assert.equal(p.prime(), false);
});

/* ---------- 3. the asset ---------- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = path.join(ROOT, INTERLUDE_ASSET_PATH);

/** Minimal RIFF/WAVE reader: enough to measure the file, nothing more. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  assert.ok(fmt && data, "fmt and data chunks present");
  return { bytes: buf.length, fmt, data };
}

test("the URL satisfies `media-src https:` on every host, including capacitor://localhost", () => {
  /* MUTATION: make INTERLUDE_ASSET_URL relative — it would load on the website
     and be blocked by the CSP inside the iOS shell (docs/mobile-shell.md §3). */
  assert.ok(INTERLUDE_ASSET_URL.startsWith("https://"), INTERLUDE_ASSET_URL);
  assert.ok(INTERLUDE_ASSET_URL.endsWith("/" + INTERLUDE_ASSET_PATH), "the live site serves the repo path verbatim");
});

test("the committed placeholder is 44.1 kHz stereo 16-bit PCM, under 600 KB", () => {
  const { bytes, fmt } = readWav(ASSET);
  assert.equal(fmt.format, 1, "PCM");
  assert.equal(fmt.channels, 2);
  assert.equal(fmt.sampleRate, 44_100);
  assert.equal(fmt.bitsPerSample, 16);
  assert.ok(bytes < 600 * 1024, `${bytes} bytes`);
});

test("INTERLUDE_DURATION_SEC is the file's measured length, inside the 2.5-3.5 s brief, under the ceiling", () => {
  /* MUTATION: change the constant, or regenerate the asset at another length
     without updating it — this is the drift check. */
  const { fmt, data } = readWav(ASSET);
  const frames = data.length / (fmt.channels * (fmt.bitsPerSample / 8));
  const measured = frames / fmt.sampleRate;
  assert.ok(Math.abs(measured - INTERLUDE_DURATION_SEC) < 0.001, `file is ${measured}s, constant says ${INTERLUDE_DURATION_SEC}s`);
  assert.ok(measured >= 2.5 && measured <= 3.5, `${measured}s`);
  assert.ok(INTERLUDE_CEILING_SEC > INTERLUDE_DURATION_SEC, "the ceiling must outlast the jingle or every jingle is cut");
});

test("the placeholder peaks at about -6 dBFS, starts from silence and ends in silence", () => {
  const { data } = readWav(ASSET);
  let peak = 0;
  for (let i = 0; i < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
  const dbfs = 20 * Math.log10(peak / 32767);
  assert.ok(dbfs > -6.5 && dbfs < -5.5, `peak ${dbfs.toFixed(2)} dBFS`);
  assert.equal(data.readInt16LE(0), 0, "first left sample");
  assert.equal(data.readInt16LE(2), 0, "first right sample");
  // The last 5 ms of both channels are exactly zero: no click on `ended`.
  const tailFrames = Math.floor(0.005 * 44_100);
  for (let f = 1; f <= tailFrames; f++) {
    const at = data.length - f * 4;
    assert.equal(data.readInt16LE(at), 0, `tail frame -${f} left`);
    assert.equal(data.readInt16LE(at + 2), 0, `tail frame -${f} right`);
  }
});
