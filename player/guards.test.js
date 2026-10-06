/* player/guards.js — the one `isNum` and the one `isObj` (code-health CH-41,
   X1-16), and the two `clampIndex` contracts told apart by name (X1-17).

   The CHARACTERIZATION half below landed before guards.js existed: it pins,
   through each module's own exports, what that module does today with a
   number that is not finite (NaN, Infinity, a numeric string, null) and with
   a value that is not a plain object, so the swap onto the shared guards is
   seen to change nothing. The modules with no export reaching their guard
   (queue-manager's narration deadline, client.js's Foray totals) keep their
   own suites, which stay green untouched.

   Every test names the one-line mutation that turns it red; each was run. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  makeProgress, percentDone, remainingLabel, forayWriteDue, isProgressRecord, resumePoint,
} from "./foray-progress.js";
import { isRate, normalizeRate, DEFAULT_RATE } from "./playback-rate.js";
import { mediaPositionState } from "./media-session.js";
import { growOf } from "./segment-strip.js";
import { structuralCheck } from "./foray-structure.js";
import { readAll } from "./bookmarks.js";
import { alertsOn, setAlerts, dueForCheck, alertText } from "./show-alerts.js";

const NOT_FINITE = [NaN, Infinity, -Infinity, "5", null, undefined];

test("CH-41 characterization: foray-progress reads a non-finite clock as absent", () => {
  /* MUTATION: drop `Number.isFinite` from foray-progress's number guard -> an
     Infinity total is stored and percentDone(5, Infinity) stops being 0. */
  const row = makeProgress({ forayId: "f", elapsedSec: NaN, totalSec: Infinity, intoSec: "3", now: "t" });
  assert.equal(row.elapsed_sec, 0);
  assert.equal(row.total_sec, 0);
  assert.equal(row.into_sec, 0);
  for (const bad of NOT_FINITE) {
    assert.equal(percentDone(bad, 10), 0, `percentDone(${String(bad)}, 10)`);
    assert.equal(percentDone(5, bad), 0, `percentDone(5, ${String(bad)})`);
    assert.equal(remainingLabel(bad), "finished", `remainingLabel(${String(bad)})`);
    assert.equal(forayWriteDue(null, bad), false, `forayWriteDue(null, ${String(bad)})`);
    assert.equal(isProgressRecord({ foray_id: "f", elapsed_sec: bad, total_sec: 10 }), false);
    assert.equal(isProgressRecord({ foray_id: "f", elapsed_sec: 5, total_sec: bad }), false);
  }
  assert.equal(percentDone(5, 10), 50, "premise: a finite pair still answers");
});

test("CH-41 characterization: a stored index past the live end resumes nowhere (-1), never at the last segment", () => {
  /* X1-17's half in foray-progress: "past the live end" is -1 there, the
     opposite of client.js's clamp to the last index. MUTATION: give the
     resume clamp client.js's body (Math.min(Math.max(0, n), max)) -> 31
     against a live maxIndex of 19 reads 19. */
  const rec = makeProgress({ forayId: "f", elapsedSec: 100, totalSec: 1000, index: 31, now: "t" });
  assert.equal(resumePoint(rec, { maxIndex: 19 }).index, -1, "past the end is not found");
  assert.equal(resumePoint(rec, { maxIndex: 31 }).index, 31, "at the end is kept");
  assert.equal(resumePoint(rec, {}).index, 31, "no live count passes the index through");
  assert.equal(resumePoint(rec, { maxIndex: NaN }).index, 31, "an unreadable live count passes it through");
  assert.equal(resumePoint({ ...rec, index: -1 }, { maxIndex: 19 }).index, -1, "-1 survives");
  assert.equal(resumePoint({ ...rec, index: 2.5 }, { maxIndex: 19 }).index, -1, "a non-integer is not an index");
});

test("CH-41 characterization: playback-rate refuses a non-finite rate and falls back to the default", () => {
  /* MUTATION: make playback-rate's guard `typeof v === "number"` only ->
     normalizeRate(Infinity) is snapped onto the top stop instead of 1. */
  for (const bad of NOT_FINITE) {
    assert.equal(isRate(bad), false, `isRate(${String(bad)})`);
    assert.equal(normalizeRate(bad), DEFAULT_RATE, `normalizeRate(${String(bad)})`);
  }
  assert.equal(isRate(1.5), true, "premise: a real stop is a rate");
  assert.equal(normalizeRate(1.3), 1.25, "premise: a finite rate still snaps");
});

test("CH-41 characterization: media-session reports nothing for a non-finite duration and clamps the rest", () => {
  /* MUTATION: drop `Number.isFinite` from media-session's guard -> an
     Infinity duration is reported (a TypeError in the real API). */
  for (const bad of NOT_FINITE) {
    assert.equal(mediaPositionState({ durationSec: bad }), null, `duration ${String(bad)}`);
    assert.deepEqual(mediaPositionState({ durationSec: 100, positionSec: bad, playbackRate: bad }),
      { duration: 100, position: 0, playbackRate: 1 }, `position/rate ${String(bad)}`);
  }
});

test("CH-41 characterization: segment-strip gives a non-finite length the minimum share", () => {
  /* MUTATION: drop `Number.isFinite` from segment-strip's guard -> growOf(Infinity) is Infinity. */
  for (const bad of NOT_FINITE) assert.equal(growOf(bad), 1, `growOf(${String(bad)})`);
  assert.equal(growOf(5.4), 5, "premise: a finite length still rounds");
});

test("CH-41 characterization: foray-structure refuses an array, null or string item and a non-finite runtime", () => {
  /* MUTATION: let foray-structure's plain-object guard accept arrays -> the
     array item stops reading `not-an-object`. */
  const { ok, problems } = structuralCheck([
    Object.assign([], { id: "arr", kind: "tts", duration_sec: 5, text: "x" }),
    null,
    "x",
    { id: "a", kind: "tts", duration_sec: Infinity },
  ]);
  assert.equal(ok, false);
  assert.deepEqual(problems.filter((p) => p.index < 3), [
    { index: 0, code: "not-an-object" }, { index: 1, code: "not-an-object" }, { index: 2, code: "not-an-object" },
  ]);
  assert.ok(problems.some((p) => p.index === 3 && p.code === "no-duration"), "Infinity is no runtime");
});

test("CH-41 characterization: bookmarks read an array map, an array row and a non-finite second as corrupt", () => {
  /* MUTATION: let bookmarks' plain-object guard accept arrays -> the array
     row (which carries sec and created_at) is kept. */
  const store = (v) => ({ get: () => v });
  assert.deepEqual(readAll(store([])), {});
  assert.deepEqual(readAll(store({
    ep: [Object.assign([], { sec: 1, created_at: "x" }), { sec: 2, created_at: "y" }, { sec: NaN, created_at: "z" }],
  })), { ep: [{ sec: 2, label: null, created_at: "y", duration_sec: null }] });
});

test("CH-41 characterization: show-alerts treats null and a primitive as no record", () => {
  /* MUTATION: make show-alerts' object guard `typeof v === "object"` only ->
     alertsOn(null) throws reading null.alerts. */
  for (const none of [null, undefined, "x", 3]) {
    assert.equal(alertsOn(none), true, `alertsOn(${String(none)})`);
    assert.equal(dueForCheck(none, 0), true, `dueForCheck(${String(none)})`);
    assert.deepEqual(alertText(none, none), { title: "", body: "" });
  }
  assert.deepEqual(setAlerts(null, false), { alerts: false });
  assert.equal(alertsOn({ alerts: false }), false, "premise: a real record still answers");
});
