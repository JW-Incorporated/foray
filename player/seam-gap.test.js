/* The seam beat's decision table (player/seam-gap.js).

   One question, one screen of answers. The player's own timing is tested in
   player/queue-manager.test.js; this suite only pins WHICH transitions are
   seams, because that is the part a future change is most likely to get subtly
   wrong — a gap on a skip is a stall, and a missing gap on an auto-advance is
   the butt-cut this whole feature exists to remove. */

import test from "node:test";
import assert from "node:assert/strict";
import { seamGapSec, describeSeam, isSegment, SEAM_GAP_SEC, AUTO_ADVANCE, USER_ACTION } from "./seam-gap.js";

const seg = (id, start = 100, end = 210) => ({ id, kind: "episode", start_sec: start, end_sec: end });
const episode = (id) => ({ id, kind: "episode" });
const bridge = (id) => ({ id, kind: "tts" });

/* ---------- the number ---------- */

test("the merged rule is 2.0 s, not 04_VOICE_AUDIO_SPEC's 0.5 s", () => {
  // docs/curation/segment-length-rules.md §0 and §6b, adopted from the
  // audiobook section-break convention (§2e). The 0.5 s in
  // docs/brief/04_VOICE_AUDIO_SPEC.md is padding around a TTS item — a
  // different job, and the rules doc says so out loud.
  assert.equal(SEAM_GAP_SEC, 2.0);
});

test("an unbridged segment-to-segment auto-advance gets the full beat", () => {
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b") }), 2.0);
});

test("the length is overridable without touching the rule", () => {
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b"), gapSec: 3.5 }), 3.5);
});

test("a nonsense length collapses to no beat rather than to NaN", () => {
  for (const bad of [NaN, Infinity, -1, "2", null]) {
    assert.equal(seamGapSec({ from: seg("a"), to: seg("b"), gapSec: bad }), 0, `gapSec=${bad}`);
  }
});

/* ---------- what is not a seam ---------- */

test("a user-driven move gets no beat — they named where to go", () => {
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b"), cause: USER_ACTION }), 0);
});

test("an unrecognised cause is treated as user-driven, not as an auto-advance", () => {
  // Fail towards "no silence": a spurious 2 s wait on a button press is a bug
  // the listener feels immediately, and a missing beat is only a missing beat.
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b"), cause: "whatever" }), 0);
});

test("a bridged seam gets no beat — narration is the marker, silence would be dead air", () => {
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b"), bridged: true }), 0);
});

test("the first item of a Foray has nothing to be marked off from", () => {
  assert.equal(seamGapSec({ from: null, to: seg("b") }), 0);
});

test("the end of the queue gets no beat — silence before silence", () => {
  assert.equal(seamGapSec({ from: seg("a"), to: null }), 0);
});

test("an ordinary unbounded episode on either side is not a seam we made", () => {
  assert.equal(seamGapSec({ from: episode("a"), to: seg("b") }), 0);
  assert.equal(seamGapSec({ from: seg("a"), to: episode("b") }), 0);
  assert.equal(seamGapSec({ from: episode("a"), to: episode("b") }), 0);
});

test("a TTS item on either side is not a segment seam", () => {
  assert.equal(seamGapSec({ from: bridge("n1"), to: seg("b") }), 0);
  assert.equal(seamGapSec({ from: seg("a"), to: bridge("n1") }), 0);
});

test("called with nothing at all, it answers zero instead of throwing", () => {
  assert.equal(seamGapSec(), 0);
});

/* ---------- isSegment: the one definition of bounded ---------- */

test("a segment is a real forward slice, and nothing else is", () => {
  assert.equal(isSegment(seg("a", 100, 210)), true);
  assert.equal(isSegment({ id: "a", start_sec: 100 }), false, "no end_sec is an episode");
  assert.equal(isSegment({ id: "a", start_sec: 210, end_sec: 210 }), false, "zero-length");
  assert.equal(isSegment({ id: "a", start_sec: 210, end_sec: 100 }), false, "backwards");
  assert.equal(isSegment({ id: "a", start_sec: 0, end_sec: NaN }), false, "junk end");
  assert.equal(isSegment(null), false);
  assert.equal(isSegment(undefined), false);
});

test("a segment starting at 0:00 is still a segment", () => {
  assert.equal(isSegment({ id: "a", start_sec: 0, end_sec: 90 }), true);
});

/* ---------- telemetry says what was decided, not what we hoped ---------- */

test("the beat's log line names both sides and the length", () => {
  const line = describeSeam({ from: seg("foray-1#3"), to: seg("foray-1#4") });
  assert.match(line, /2\.0s beat/);
  assert.match(line, /foray-1#3 -> foray-1#4/);
});

test("every refusal explains itself differently", () => {
  const reasons = [
    describeSeam({ from: seg("a"), to: seg("b"), cause: USER_ACTION }),
    describeSeam({ from: seg("a"), to: seg("b"), bridged: true }),
    describeSeam({ from: null, to: seg("b") }),
    describeSeam({ from: episode("a"), to: episode("b") }),
  ];
  assert.equal(new Set(reasons).size, 4, `duplicated reasons: ${reasons}`);
  for (const r of reasons) assert.match(r, /^no beat/);
});

test("AUTO_ADVANCE is the default cause, so the ordinary path needs no argument", () => {
  assert.equal(AUTO_ADVANCE, "auto");
  assert.equal(seamGapSec({ from: seg("a"), to: seg("b") }), seamGapSec({ from: seg("a"), to: seg("b"), cause: AUTO_ADVANCE }));
});
