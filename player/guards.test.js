/* player/guards.js — the one `isNum` and the one `isObj` (code-health CH-41,
   X1-16), and the two `clampIndex` contracts told apart by name (X1-17).

   The CHARACTERIZATION half below landed before guards.js existed: it pins,
   through each module's own exports, what that module does today with a
   number that is not finite (NaN, Infinity, a numeric string, null) and with
   a value that is not a plain object, so the swap onto the shared guards is
   seen to change nothing. The modules with no export reaching their guard
   (queue-manager's narration deadline, client.js's Foray totals) keep their
   own suites, which stay green untouched.

   The second half is the module itself: its table, show-alerts adopting the
   array-refusing rule, foray-progress's `indexOrMissing` under its own name,
   and one owner -- no new copy anywhere in player/, and each copy that is kept
   on purpose (guards.js's header says why) pinned to the same rule.

   Every test names the one-line mutation that turns it red; each was run. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isNum, isObj } from "./guards.js";

import {
  makeProgress, percentDone, remainingLabel, forayWriteDue, isProgressRecord, resumePoint,
} from "./foray-progress.js";
import { isRate, normalizeRate, DEFAULT_RATE } from "./playback-rate.js";
import { mediaPositionState } from "./media-session.js";
import { growOf } from "./segment-strip.js";
import { structuralCheck } from "./foray-structure.js";
import { readAll } from "./bookmarks.js";
import { alertsOn, setAlerts, dueForCheck, alertText, newSince } from "./show-alerts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), "utf8");

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

/* ---------- guards.js itself (CH-41) ---------- */

test("CH-41: isNum is a finite number primitive and nothing else; isObj is a non-null, non-array object", () => {
  /* MUTATIONS: drop `Number.isFinite` from isNum -> the NaN/Infinity rows go
     red; drop `!Array.isArray` from isObj -> the [] rows go red; drop
     `v !== null` from isObj -> the null row goes red. */
  const table = [
    // value, isNum, isObj
    [0, true, false],
    [-1.5, true, false],
    [Number.MAX_VALUE, true, false],
    [NaN, false, false],
    [Infinity, false, false],
    [-Infinity, false, false],
    ["1", false, false],
    ["", false, false],
    [null, false, false],
    [undefined, false, false],
    [true, false, false],
    [Object(1), false, true],
    [[], false, false],
    [[1], false, false],
    [{}, false, true],
    [Object.create(null), false, true],
    [new Date(0), false, true],
    [() => 1, false, false],
  ];
  for (const [value, num, obj] of table) {
    let label;
    try { label = Array.isArray(value) ? `[${value}]` : typeof value === "function" ? "fn" : String(value); } catch { label = "null-prototype object"; }
    assert.equal(isNum(value), num, `isNum(${label})`);
    assert.equal(isObj(value), obj, `isObj(${label})`);
  }
});

test("CH-41: show-alerts refuses an array as a record or a row, like every sibling", () => {
  /* X1-16's drift: show-alerts' own `isObject` let an array through. MUTATION:
     put `const isObject = (v) => v != null && typeof v === "object"` back and
     use it -> the array carrying `alerts: false` reads as alerts off again. */
  const arr = Object.assign([], { alerts: false, title: "T", checked_at: "2026-01-01T00:00:00Z" });
  assert.equal(alertsOn(arr), true, "an array is no record, so alerts are on");
  assert.deepEqual(setAlerts(arr, false), { alerts: false }, "nothing is copied out of an array");
  assert.deepEqual(alertText(arr, Object.assign([], { title: "E" })), { title: "", body: "" });
  assert.equal(dueForCheck(arr, Date.parse("2026-01-01T01:00:00Z")), true, "an array's checked_at is not read");
  const row = { published_at: "2026-03-01" };
  assert.deepEqual(newSince([Object.assign([], { published_at: "2026-02-01" }), row], { seen_published_at: "2026-01-01" }),
    [row], "an array row is not a dated row");
});

test("CH-41: foray-progress's past-the-end rule is `indexOrMissing`; `clampIndex` is client.js's clamp alone", () => {
  /* X1-17. MUTATIONS: rename foray-progress's helper back to `clampIndex` ->
     the name pin goes red; give it client.js's clamp body -> 31 against a live
     maxIndex of 19 reads 19, not -1. */
  const progress = read("foray-progress.js");
  assert.match(progress, /^function indexOrMissing\(index, maxIndex\) \{$/m);
  assert.equal([...progress.matchAll(/\bclampIndex\b/g)].length, 1, "foray-progress names clampIndex only to say it is client.js's");
  assert.match(progress, /client\.js's `clampIndex`/);
  assert.match(read("client.js"),
    /^function clampIndex\(index, length\) \{\r?\n  const n = Number\.isInteger\(index\) \? index : 0;\r?\n  return Math\.min\(Math\.max\(0, n\), Math\.max\(0, length - 1\)\);\r?\n\}$/m,
    "client.js keeps its clamp onto [0, length - 1]");
  const rec = makeProgress({ forayId: "f", elapsedSec: 100, totalSec: 1000, index: 31, now: "t" });
  assert.equal(resumePoint(rec, { maxIndex: 19 }).index, -1);
});

/* A pure "finite number" or "plain object" predicate, however it is named. */
const NUM_DEF = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\((\w+)\)\s*=>\s*typeof\s+\2\s*===\s*"number"\s*&&\s*Number\.isFinite\(\2\);?\r?$/gm;
const OBJ_DEF = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\((\w+)\)\s*=>\s*\2\s*!==?\s*null\s*&&\s*typeof\s+\2\s*===\s*"object"[^;\n]*;?\r?$/gm;
/** Any definition of `name` at all, so a drifted copy cannot hide from NUM_DEF. */
const anyDef = (name) => new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${name}\\b`, "gm");

test("CH-41: one owner -- no player module grows its own guard, and every kept copy is the same rule", () => {
  /* MUTATIONS: paste `const isNum = (n) => typeof n === "number" &&
     Number.isFinite(n);` back into media-session.js -> the owner list grows;
     loosen foray-queue.js's kept copy to `typeof n === "number"` -> it is no
     longer the pinned shape and the owner list shrinks; import guards.js from
     foray-queue.js -> the signing-walk assertion goes red. */
  const modules = fs.readdirSync(HERE).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).sort();
  const owners = (re) => modules.flatMap((f) => [...read(f).matchAll(re)].map((m) => `${f}:${m[1]}`)).sort();
  assert.deepEqual(owners(NUM_DEF), [
    "duration.js:isNum", // signing-reached
    "engine-contract.js:isFiniteNum", // its one-import rule
    "foray-queue.js:isNum", // signing-reached
    "foray-resolve.js:isNum", // signing-reached
    "foray-sources.js:isNum", // signing-reached
    "guards.js:isNum",
    "locate-window.js:isNum", // dependency-free reference the native webdir copies
  ]);
  assert.deepEqual(owners(OBJ_DEF), ["engine-contract.js:isObj", "guards.js:isObj"]);
  /* Each kept copy is the ONLY definition of its name in its file, so the
     strict shape above is the rule that file runs. */
  for (const [f, name] of [
    ["duration.js", "isNum"], ["foray-queue.js", "isNum"], ["foray-resolve.js", "isNum"],
    ["foray-sources.js", "isNum"], ["locate-window.js", "isNum"],
    ["engine-contract.js", "isFiniteNum"], ["engine-contract.js", "isObj"],
  ]) {
    assert.equal([...read(f).matchAll(anyDef(name))].length, 1, `${f} defines ${name} once`);
  }
  /* The swapped modules import the guards; none keeps a local definition. */
  for (const f of [
    "bookmarks.js", "client.js", "foray-progress.js", "foray-structure.js", "media-session.js",
    "playback-rate.js", "queue-manager.js", "segment-strip.js", "show-alerts.js",
  ]) {
    const src = read(f);
    assert.match(src, /^import \{ (?:isNum|isObj|isNum, isObj) \} from "\.\/guards\.js";\r?$/m, `${f} imports guards.js`);
    for (const name of ["isNum", "isObj", "isFiniteNum", "isPlain", "isPlainObject", "isObject"]) {
      assert.equal([...src.matchAll(anyDef(name))].length, 0, `${f} defines no ${name} of its own`);
    }
  }
  /* foray-directory.js's copy had no caller at all; it is gone, not imported. */
  assert.doesNotMatch(read("foray-directory.js"), /\bisNum\b/);
  /* The signing-reached modules must NOT import guards.js: that would put it on
     the release walk (guards.js's header; tools/ci/path-policy.test.mjs). */
  for (const f of ["foray-resolve.js", "foray-queue.js", "foray-sources.js", "duration.js", "seek-policy.js", "build-stamp.js"]) {
    assert.doesNotMatch(read(f), /from "\.\/guards\.js"/, `${f} is on the signing walk`);
  }
  /* And guards.js stays a leaf. */
  assert.doesNotMatch(read("guards.js"), /^import\b/m);
});
