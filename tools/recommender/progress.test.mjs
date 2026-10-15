/* tools/recommender/progress.mjs: reservations and pass records in
   data/recommender/rating-progress.json (RV-02, docs/roadmap/recommender-v1.md
   D10).

   Every test names the one-line mutation of progress.mjs that turns it red;
   each was run red before this suite was committed. Each test builds its own
   progress object, and the disk tests write only to a fresh temp folder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCK_STALE_MS,
  STALE_MS,
  emptyProgress,
  loadProgress,
  lockPathFor,
  markRated,
  reclaimStale,
  release,
  reserve,
  saveProgress,
  serializeProgress,
  withProgressLock,
} from "./progress.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
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

/* One child process doing what prepare and merge do: under the lock, load the
   file, say "loaded", hold for HOLD_MS, add KEY's pass record, save. */
const CHILD = `
import { loadProgress, markRated, saveProgress, withProgressLock } from ${JSON.stringify(pathToFileURL(join(HERE, "progress.mjs")).href)};
const { FILE, KEY, HOLD_MS } = process.env;
withProgressLock(FILE, () => {
  const p = loadProgress(FILE);
  process.stdout.write("loaded");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(HOLD_MS));
  markRated(p, [KEY], { pass: 1, batchId: KEY });
  saveProgress(FILE, p);
});
`;

function child(file, key, holdMs) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, FILE: file, KEY: key, HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const loaded = new Promise((resolve) => {
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("loaded")) resolve();
    });
  });
  const exited = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${key} exited ${code}`))));
  });
  return { loaded, exited };
}

test("two interleaved read-modify-writes under the lock both land", async () => {
  /* MUTATION (run red): make withProgressLock `return fn();` (no lock) -- the
     second process loads the file while the first holds its copy, the first
     saves last, and the second's pass record is lost (the RV-13 pilot's
     four lost batches). */
  const dir = mkdtempSync(join(tmpdir(), "rv-progress-"));
  try {
    const file = join(dir, "rating-progress.json");
    saveProgress(file, emptyProgress());
    const first = child(file, "first", 1500);
    await first.loaded; // the first holds the lock with the file loaded
    const second = child(file, "second", 0);
    await Promise.all([first.exited, second.exited]);
    assert.deepEqual(Object.keys(loadProgress(file).rated).sort(), ["first", "second"]);
    assert.equal(existsSync(lockPathFor(file)), false, "the lock is released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead holder's stale lock is taken over; a live one is waited on, then refused", () => {
  /* MUTATION (run red): drop the `age >= staleMs` takeover in
     withProgressLock -- a lock left by a crashed prepare blocks every later
     run until it times out. And `age >= staleMs` -> `true`: the live lock
     below is taken over and fn runs inside another process's write. */
  const dir = mkdtempSync(join(tmpdir(), "rv-progress-"));
  try {
    const file = join(dir, "rating-progress.json");
    const lock = lockPathFor(file);
    mkdirSync(lock);
    const dead = (Date.now() - LOCK_STALE_MS - 60e3) / 1000;
    utimesSync(lock, dead, dead);
    assert.equal(withProgressLock(file, () => "ran", { waitMs: 200 }), "ran");
    assert.equal(existsSync(lock), false);

    mkdirSync(lock); // a live holder
    let ran = false;
    assert.throws(
      () => withProgressLock(file, () => (ran = true), { waitMs: 150 }),
      (e) => e.code === "progress_locked" && e.message.includes(lock),
    );
    assert.equal(ran, false);
    assert.ok(existsSync(lock), "a live holder's lock is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock is released when the locked work throws", () => {
  /* MUTATION (run red): release the lock after `fn()` returns instead of in
     `finally` -- a prepare or merge that throws leaves the lock held and the
     next run waits it out and is refused. */
  const dir = mkdtempSync(join(tmpdir(), "rv-progress-"));
  try {
    const file = join(dir, "rating-progress.json");
    assert.throws(() => withProgressLock(file, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(lockPathFor(file)), false);
    assert.equal(withProgressLock(file, () => 7, { waitMs: 100 }), 7, "the next caller gets the lock at once");
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

test("the committed rating-progress.json is in saveProgress form with nothing in flight", () => {
  /* MUTATION (run red): commit the file as one line (the first save would
     rewrite every byte), or with a reservation still in flight. RV-13 commits
     the pilot's pass records, so the file is no longer empty; what must hold
     is the canonical form and that no batch was left reserved. */
  const file = join(ROOT, "data", "recommender", "rating-progress.json");
  const text = readFileSync(file, "utf8");
  const progress = loadProgress(file);
  assert.equal(text, serializeProgress(progress));
  assert.deepEqual(progress.in_flight, {});
});
