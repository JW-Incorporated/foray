/* tools/recommender/progress.mjs: reservations and pass records in
   data/recommender/rating-progress.json (RV-02, docs/roadmap/recommender-v1.md
   D10).

   Every test names the one-line mutation of progress.mjs that turns it red;
   each was run red before this suite was committed. Each test builds its own
   progress object, and the disk tests write only to a fresh temp folder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_MS,
  emptyProgress,
  loadProgress,
  markRated,
  reclaimStale,
  release,
  reserve,
  saveProgress,
  serializeProgress,
} from "./progress.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const HOUR = 3600e3;

test("reserve records batch_id and reserved_at", () => {
  /* MUTATION (run red): `progress.in_flight[k] = { batch_id: batchId }`
     (drop reserved_at) -- the reservation can never age out. */
  const p = emptyProgress();
  assert.deepEqual(reserve(p, ["a", "b"], "batch-1", T0), ["a", "b"]);
  assert.deepEqual(p.in_flight, {
    a: { batch_id: "batch-1", reserved_at: "2026-10-14T00:00:00.000Z" },
    b: { batch_id: "batch-1", reserved_at: "2026-10-14T00:00:00.000Z" },
  });
});

test("a reserved key cannot be reserved by a second batch", () => {
  /* MUTATION (run red): `const taken = []` (skip the in-flight check) -- the
     second batch overwrites the first's reservation and both rate the show.
     All or nothing: the free key in the refused call is not reserved either. */
  const p = emptyProgress();
  reserve(p, ["a"], "batch-1", T0);
  assert.throws(() => reserve(p, ["c", "a"], "batch-2", T0 + 1000), (e) => e.code === "already_reserved" && e.keys.join() === "a");
  assert.equal(p.in_flight.a.batch_id, "batch-1");
  assert.equal(p.in_flight.c, undefined);
  assert.throws(() => reserve(p, ["a"], "batch-1", T0 + 1000), /already in flight/, "the same batch twice is refused too");
});

test("reclaimStale frees only reservations older than staleMs", () => {
  /* MUTATION (run red): `t - at >= staleMs` -> `t - at < staleMs` -- the
     1-hour-old reservation is freed and the 13-hour-old one kept. */
  const p = emptyProgress();
  reserve(p, ["old"], "batch-1", T0);
  reserve(p, ["new"], "batch-2", T0 + 12 * HOUR);
  assert.equal(STALE_MS, 12 * HOUR);
  assert.deepEqual(reclaimStale(p, T0 + 13 * HOUR), ["old"]);
  assert.deepEqual(Object.keys(p.in_flight), ["new"]);
  assert.deepEqual(reclaimStale(p, T0 + 13 * HOUR, { staleMs: 30 * 60e3 }), ["new"], "staleMs is honoured");
});

test("release clears exactly one batch's keys", () => {
  /* MUTATION (run red): drop the `meta.batch_id === batchId` condition in
     release -- every batch's reservations are cleared. */
  const p = emptyProgress();
  reserve(p, ["a", "b"], "batch-1", T0);
  reserve(p, ["c"], "batch-2", T0);
  assert.deepEqual(release(p, "batch-1"), ["a", "b"]);
  assert.deepEqual(Object.keys(p.in_flight), ["c"]);
  assert.deepEqual(release(p, "batch-1"), [], "releasing twice is a no-op");
});

test("markRated appends the pass and never duplicates it", () => {
  /* MUTATION (run red): `passes.push(pass)` without the `includes` check --
     re-marking pass 1 records it twice. */
  const p = emptyProgress();
  markRated(p, ["a"], { pass: 2, batchId: "batch-2" });
  markRated(p, ["a"], { pass: 1, batchId: "batch-1" });
  markRated(p, ["a"], { pass: 1, batchId: "batch-1b" });
  assert.deepEqual(p.rated.a, { last_batch_id: "batch-1b", passes: [1, 2] });
  assert.throws(() => markRated(p, ["a"], { pass: 4 }), RangeError);
});

test("saveProgress writes sorted keys and a trailing newline", () => {
  /* MUTATION (run red): `JSON.stringify(progress)` in serializeProgress
     (unsorted, unindented, no newline) -- the file no longer diffs cleanly. */
  const dir = mkdtempSync(join(tmpdir(), "rv-progress-"));
  try {
    const p = emptyProgress();
    reserve(p, ["z", "a"], "batch-1", T0);
    markRated(p, ["m", "b"], { pass: 1, batchId: "batch-0" });
    const file = join(dir, "nested", "rating-progress.json");
    saveProgress(file, p);
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc.in_flight), ["a", "z"]);
    assert.deepEqual(Object.keys(doc.rated), ["b", "m"]);
    assert.deepEqual(Object.keys(doc.rated.b), ["last_batch_id", "passes"]);
    assert.ok(text.includes('\n  "in_flight": {\n    "a": {'), "two-space indent");
    assert.deepEqual(loadProgress(file), doc, "what is saved loads back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProgress: a missing file is empty, a corrupt one throws", () => {
  /* MUTATION (run red): wrap the JSON.parse in loadProgress in
     `try { ... } catch { return emptyProgress(); }` -- a corrupt file is
     silently reset and every reservation and pass record is lost. */
  const dir = mkdtempSync(join(tmpdir(), "rv-progress-"));
  try {
    assert.deepEqual(loadProgress(join(dir, "absent.json")), { in_flight: {}, rated: {} });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '{ "in_flight": ');
    assert.throws(() => loadProgress(bad), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed rating-progress.json is empty and in saveProgress form", () => {
  /* MUTATION (run red): commit the file as one line `{ "in_flight": {},
     "rated": {} }` (the first save would rewrite every byte), or with a stale
     reservation in it. A test that cannot fail on today's file until someone
     hand-edits it; written deliberately. */
  const file = join(ROOT, "data", "recommender", "rating-progress.json");
  const text = readFileSync(file, "utf8");
  assert.equal(text, serializeProgress(emptyProgress()));
  assert.deepEqual(loadProgress(file), { in_flight: {}, rated: {} });
});
