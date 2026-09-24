/* Where to resume, and what a saved position looks like (#26; NE-08).

   THIS SUITE READS ITS FIXTURES. Every test below except the last runs the
   `resume-rules` family's cases that name it in `covers[]`
   (player/parity/fixtures/resume-rules/) against the real module — so one file
   is both this suite's assertion and the Swift port's test list
   (ResumeRules.swift, NE-09). The numbers (10 s, 30 s, 60 s, 15 s) are AUTHORED
   cases: record.mjs refuses to overwrite them, so moving one is a decision made
   on purpose, not a re-record.

   Until NE-08 `PositionStore` had no suite of its own: its rules were only
   reached through the manager's and the client's tests. They are pure
   functions now (`resumeOffsetFor`, `positionRow`, `positionEvent`), and the
   class is the storage glue around them — pinned by the last test here.

   TO SEE ONE FAIL: set MIN_RESUME_SEC to 5, or `>=` for `>` in the near-end
   check, or drop `|| last === 0` from `positionEvent` — each turns the named
   test red with the case id and the diff. */

import test from "node:test";
import assert from "node:assert/strict";
import { fixtureCases } from "./parity/suite.js";
import { PositionStore, positionRow, positionEvent, resumeOffsetFor } from "./position-store.js";

const cases = fixtureCases("resume-rules", "position-store");

test("the numbers: nothing under 10 s, finished inside 30 s of the end, one event a minute, a write every 15 s", (t) => cases(t));

/* ---------- resumeOffsetFor ---------- */

test("a position under 10 s is nothing to resume", (t) => cases(t));
test("a position inside 30 s of the end means the episode is finished", (t) => cases(t));
test("the caller's duration wins, and the row's own stands in when there is none", (t) => cases(t));
test("no row resumes at 0", (t) => cases(t));

/* ---------- positionRow ---------- */

test("a saved row is {seconds, duration, updated_at, source: local}", (t) => cases(t));
test("a position that is not a finite, non-negative number, or has no id, is never written", (t) => cases(t));

/* ---------- positionEvent ---------- */

test("a position event goes out at most once a minute per item", (t) => cases(t));
test("the first save always emits, and so does every save after one emitted at 0 s", (t) => cases(t));

/* ---------- the class is glue around the rules ---------- */

/* JS-only (exclusions.json, js-module-shape): the Swift engine's store is its
   own (EngineStore, NE-19); what it shares with this class is the rules above,
   through the fixtures. This pins that the class really routes through them —
   storage write, the per-item event mark, and the resume read — so a rule
   fixed in the pure function cannot be bypassed by a stale copy in the class.
   TO SEE IT FAIL: make `save` emit `seconds` unrounded, or remember the
   ROUNDED mark, or have `resumeOffset` skip `resumeOffsetFor`. */
test("PositionStore writes positionRow, emits by positionEvent per item, and resumes by resumeOffsetFor", () => {
  const rows = new Map();
  const storage = {
    setItem: (k, v) => rows.set(k, v),
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    removeItem: (k) => rows.delete(k),
  };
  const events = [];
  const store = new PositionStore({ storage, onSave: (id, seconds, meta) => events.push([id, seconds, meta]) });

  /* 72.2 is 59.8 s after 12.4 but 60.2 s after its ROUNDED 12: it separates the
     unrounded mark from a rounded one. */
  const saves = [["a", 12.4], ["a", 40], ["a", 72.2], ["a", 72.6], ["b", 5], ["a", 133], ["a", 133.2]];
  const want = [];
  const marks = new Map();
  for (const [id, s] of saves) {
    store.save(id, s, { duration: 3600 });
    const row = JSON.parse(rows.get(`cp_pos:${id}`));
    assert.deepStrictEqual(row, positionRow(id, s, { duration: 3600 }, row.updated_at), `${id}@${s}: the stored row is positionRow's`);
    assert.ok(!Number.isNaN(Date.parse(row.updated_at)), "updated_at is a real timestamp");
    const e = positionEvent(marks.get(id), s, 3600);
    if (e) { marks.set(id, e.mark); want.push([id, e.seconds, { duration: e.duration }]); }
  }
  assert.deepStrictEqual(events, want, "events are positionEvent's, per item, with the unrounded mark");
  // Spelled out once, so the rule cannot pass by agreeing with itself:
  assert.deepStrictEqual(events.map(([id, s]) => `${id}@${s}`), ["a@12", "a@73", "b@5", "a@133"]);

  store.save("a", -1, { duration: 3600 });
  assert.equal(JSON.parse(rows.get("cp_pos:a")).seconds, 133.2, "an invalid position leaves the last good row alone");

  for (const duration of [null, 3600, 150]) {
    assert.equal(store.resumeOffset("a", { duration }), resumeOffsetFor(store.load("a"), { duration }), `resumeOffset(duration=${duration})`);
  }
  assert.equal(store.resumeOffset("a"), 133.2);
  assert.equal(store.resumeOffset("a", { duration: 150 }), 0, "inside 30 s of a 150 s end");
  assert.equal(store.resumeOffset("nobody"), 0);
});
