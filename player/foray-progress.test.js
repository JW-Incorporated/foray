/* player/foray-progress.js — the resume point that survives closing the tab.

   The bar this feature exists to clear: a listener 20 minutes into a 61-minute
   Foray closes the tab and comes back. The tests are therefore written around
   the decisions that can lose that person — a row that reads back as absent, a
   resume offer 4 seconds before the outro, a throttle that never writes — rather
   than around the getters. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEY_PREFIX, MIN_RESUME_SEC, NEAR_END_SEC, MAX_AGE_H, SAVE_EVERY_SEC,
  ForayProgressStore, progressKey, makeProgress, isProgressRecord,
  readProgress, writeProgress, clearProgress, listProgress,
  resumePoint, percentDone, remainingLabel,
} from "./foray-progress.js";

/* ---------- a Storage that behaves like the real one ---------- */

class FakeStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failWrites = false;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}

const TOTAL = 3673;           // Foray #1's real runtime, 1:01:13
const ID = "grilling-history-1";

function record(over = {}) {
  return makeProgress({
    forayId: ID, title: "The history of grilling",
    elapsedSec: 1180, totalSec: TOTAL, index: 9,
    now: "2026-08-16T10:00:00.000Z", ...over,
  });
}

/* ---------- the key ---------- */

test("the storage key keeps the legacy cp_ prefix", () => {
  assert.equal(progressKey(ID), `cp_foray:${ID}`);
  assert.ok(KEY_PREFIX.startsWith("cp_"), "renaming this wipes every listener's resume point");
});

test("one Foray is one row, so two Forays cannot overwrite each other", () => {
  const s = new FakeStorage();
  writeProgress(s, record());
  writeProgress(s, record({ forayId: "other-foray", elapsedSec: 60 }));
  assert.equal(readProgress(s, ID).elapsed_sec, 1180);
  assert.equal(readProgress(s, "other-foray").elapsed_sec, 60);
});

/* ---------- the record ---------- */

test("makeProgress stores the Foray's own clock, not an audio element's", () => {
  const r = record();
  assert.equal(r.foray_id, ID);
  assert.equal(r.elapsed_sec, 1180);
  assert.equal(r.total_sec, TOTAL);
  assert.equal(r.index, 9);
  assert.equal(r.updated_at, "2026-08-16T10:00:00.000Z");
});

test("makeProgress refuses to record a negative or non-finite clock as one", () => {
  assert.equal(makeProgress({ forayId: ID, elapsedSec: -5, totalSec: TOTAL }).elapsed_sec, 0);
  assert.equal(makeProgress({ forayId: ID, elapsedSec: NaN, totalSec: TOTAL }).elapsed_sec, 0);
  assert.equal(makeProgress({ forayId: ID, elapsedSec: 10, totalSec: Infinity }).total_sec, 0);
});

test("an index that is not a real segment is recorded as none, not as segment 0", () => {
  // -1 means "we do not know which row to highlight". 0 means "highlight the
  // first one", which is a different and wrong claim.
  assert.equal(makeProgress({ forayId: ID, elapsedSec: 60, totalSec: TOTAL, index: -3 }).index, -1);
  assert.equal(makeProgress({ forayId: ID, elapsedSec: 60, totalSec: TOTAL, index: 1.5 }).index, -1);
  assert.equal(makeProgress({ forayId: ID, elapsedSec: 60, totalSec: TOTAL, index: 0 }).index, 0);
});

test("isProgressRecord rejects the half-written rows a reader would trip over", () => {
  assert.ok(isProgressRecord(record()));
  assert.ok(!isProgressRecord(null));
  assert.ok(!isProgressRecord({ foray_id: "", elapsed_sec: 1, total_sec: 2 }));
  assert.ok(!isProgressRecord({ foray_id: ID, elapsed_sec: "1180", total_sec: TOTAL }));
  assert.ok(!isProgressRecord({ foray_id: ID, elapsed_sec: 10, total_sec: 0 }));
});

/* ---------- storage round trip ---------- */

test("a written position reads back identically", () => {
  const s = new FakeStorage();
  assert.equal(writeProgress(s, record()), true);
  assert.deepEqual(readProgress(s, ID), record());
});

test("corrupt JSON reads as no position rather than throwing into the render loop", () => {
  const s = new FakeStorage({ [`${KEY_PREFIX}${ID}`]: "{not json" });
  assert.equal(readProgress(s, ID), null);
});

test("a row missing its required fields reads as no position", () => {
  const s = new FakeStorage({ [`${KEY_PREFIX}${ID}`]: JSON.stringify({ foray_id: ID }) });
  assert.equal(readProgress(s, ID), null);
});

test("a storage that refuses writes returns false instead of throwing", () => {
  // Private mode and a full quota both land here, and both arrive inside a
  // 4 Hz position tick.
  const s = new FakeStorage();
  s.failWrites = true;
  assert.equal(writeProgress(s, record()), false);
});

test("reading with no storage at all is null, not a crash", () => {
  assert.equal(readProgress(null, ID), null);
  assert.deepEqual(listProgress(null), []);
});

test("clear removes the row", () => {
  const s = new FakeStorage();
  writeProgress(s, record());
  clearProgress(s, ID);
  assert.equal(readProgress(s, ID), null);
});

/* ---------- listing ---------- */

test("listProgress returns only cp_foray rows, ignoring the rest of localStorage", () => {
  const s = new FakeStorage({
    cp_saved: "{}", cp_events: "[]", "cp_pos:some-episode": "{}", cp_interests: "{}",
  });
  writeProgress(s, record());
  const list = listProgress(s, { now: Date.parse("2026-08-16T11:00:00.000Z") });
  assert.equal(list.length, 1);
  assert.equal(list[0].foray_id, ID);
});

test("listProgress is newest first, so the home screen leads with the live one", () => {
  const s = new FakeStorage();
  writeProgress(s, record({ forayId: "older", now: "2026-08-10T10:00:00.000Z" }));
  writeProgress(s, record({ forayId: "newest", now: "2026-08-16T09:00:00.000Z" }));
  writeProgress(s, record({ forayId: "middle", now: "2026-08-14T10:00:00.000Z" }));
  assert.deepEqual(
    listProgress(s, { now: Date.parse("2026-08-16T10:00:00.000Z") }).map((r) => r.foray_id),
    ["newest", "middle", "older"]
  );
});

test("a position older than the age limit stops being offered", () => {
  const s = new FakeStorage();
  writeProgress(s, record({ now: "2026-01-01T00:00:00.000Z" }));
  const now = Date.parse("2026-08-16T10:00:00.000Z");
  assert.deepEqual(listProgress(s, { now }), []);
  // Still readable by id — expiry governs what we OFFER, not what we destroy.
  assert.ok(readProgress(s, ID));
  assert.ok(MAX_AGE_H > 24, "an age limit under a day would expire a weekend");
});

test("an undated row is kept rather than silently dropped", () => {
  const s = new FakeStorage({
    [`${KEY_PREFIX}${ID}`]: JSON.stringify({ foray_id: ID, elapsed_sec: 600, total_sec: TOTAL }),
  });
  assert.equal(listProgress(s).length, 1);
});

test("listProgress tolerates a storage without key() instead of throwing", () => {
  assert.deepEqual(listProgress({ getItem: () => null, length: 3 }), []);
});

/* ---------- resumePoint: the actual product decision ---------- */

test("mid-Foray, resume offers the stored position and what is left", () => {
  const p = resumePoint(record(), { totalSec: TOTAL });
  assert.equal(p.elapsedSec, 1180);
  assert.equal(p.index, 9);
  assert.equal(Math.round(p.remainingSec), TOTAL - 1180);
  assert.equal(p.finished, false);
  assert.equal(p.percent, 32);
});

test("barely started is not a resume point — it is a fresh start", () => {
  assert.equal(resumePoint(record({ elapsedSec: MIN_RESUME_SEC - 1 }), { totalSec: TOTAL }), null);
  assert.ok(resumePoint(record({ elapsedSec: MIN_RESUME_SEC + 1 }), { totalSec: TOTAL }));
});

test("inside the last segment counts as finished, not as 40 seconds to go", () => {
  // Resuming a listener 20 seconds before the closing out-point drops them into
  // a goodbye. Say finished and let them start it again.
  const p = resumePoint(record({ elapsedSec: TOTAL - (NEAR_END_SEC - 5) }), { totalSec: TOTAL });
  assert.equal(p.finished, true);
  assert.equal(p.remainingSec, 0);
  assert.equal(p.percent, 100);
});

test("a stored position past the Foray's CURRENT length is clamped, not trusted", () => {
  // A repaired data file can make the Foray shorter than it was when the row
  // was written. The live document is the authority.
  const shorter = 600;
  const p = resumePoint(record({ elapsedSec: 1180 }), { totalSec: shorter });
  assert.equal(p.elapsedSec, shorter);
  assert.equal(p.finished, true);
});

test("a stored index past the Foray's CURRENT last segment is dropped, not clamped to the end", () => {
  // The failure this prevents: a repaired data file leaves index 31 against a
  // 20-segment Foray, and the running order paints every row as already heard.
  const p = resumePoint(record({ index: 31 }), { totalSec: TOTAL, maxIndex: 19 });
  assert.equal(p.index, -1, "unknown beats a confident wrong answer");
  assert.equal(p.elapsedSec, 1180, "the clock itself is still good");
});

test("an in-range index survives the clamp, and -1 stays -1", () => {
  assert.equal(resumePoint(record({ index: 9 }), { totalSec: TOTAL, maxIndex: 31 }).index, 9);
  assert.equal(resumePoint(record({ index: 31 }), { totalSec: TOTAL, maxIndex: 31 }).index, 31);
  assert.equal(resumePoint(record({ index: -1 }), { totalSec: TOTAL, maxIndex: 31 }).index, -1);
});

test("with no maxIndex given the stored index is passed through unchanged", () => {
  assert.equal(resumePoint(record({ index: 9 }), { totalSec: TOTAL }).index, 9);
});

test("resumePoint on a missing or malformed row is null", () => {
  assert.equal(resumePoint(null, { totalSec: TOTAL }), null);
  assert.equal(resumePoint({ foray_id: ID }, { totalSec: TOTAL }), null);
});

test("with no totalSec passed, the row's own total is used", () => {
  assert.equal(resumePoint(record()).percent, 32);
});

/* ---------- display ---------- */

test("percentDone is clamped to 0..100 and never returns NaN", () => {
  assert.equal(percentDone(0, TOTAL), 0);
  assert.equal(percentDone(TOTAL, TOTAL), 100);
  assert.equal(percentDone(TOTAL * 2, TOTAL), 100);
  assert.equal(percentDone(-10, TOTAL), 0);
  assert.equal(percentDone(100, 0), 0);
  assert.equal(percentDone(NaN, TOTAL), 0);
});

test("remainingLabel is the mockup's phrasing, in whole minutes", () => {
  assert.equal(remainingLabel(TOTAL - 1180), "42 min left");
  assert.equal(remainingLabel(60 * 32), "32 min left");
  assert.equal(remainingLabel(90), "2 min left");
});

test("remainingLabel never says 0 min left", () => {
  assert.equal(remainingLabel(20), "under a minute left");
  assert.equal(remainingLabel(0), "finished");
  assert.equal(remainingLabel(-5), "finished");
  assert.equal(remainingLabel(null), "finished");
});

/* ---------- the throttled writer ---------- */

test("the store writes the first position immediately", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s });
  assert.equal(store.save({ forayId: ID, elapsedSec: 30, totalSec: TOTAL, index: 0 }), true);
  assert.equal(store.get(ID).elapsed_sec, 30);
});

test("a 4 Hz tick does not become 4 writes a second", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  store.save({ forayId: ID, elapsedSec: 30, totalSec: TOTAL });
  let wrote = 0;
  for (let t = 30.25; t < 34; t += 0.25) {
    if (store.save({ forayId: ID, elapsedSec: t, totalSec: TOTAL })) wrote++;
  }
  assert.equal(wrote, 0, "everything inside the window must be dropped");
  assert.equal(store.save({ forayId: ID, elapsedSec: 35, totalSec: TOTAL }), true);
});

test("the throttle is on the clock, so a big seek writes at once in either direction", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  store.save({ forayId: ID, elapsedSec: 1200, totalSec: TOTAL });
  assert.equal(store.save({ forayId: ID, elapsedSec: 300, totalSec: TOTAL }), true, "a scrub backwards is a move");
  assert.equal(store.get(ID).elapsed_sec, 300);
});

test("force writes through the throttle — pause and page-hide cannot wait for a tick", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  store.save({ forayId: ID, elapsedSec: 100, totalSec: TOTAL });
  assert.equal(store.save({ forayId: ID, elapsedSec: 101, totalSec: TOTAL }), false);
  assert.equal(store.save({ forayId: ID, elapsedSec: 101, totalSec: TOTAL, force: true }), true);
  assert.equal(store.get(ID).elapsed_sec, 101);
  assert.ok(SAVE_EVERY_SEC <= 15, "corner case #17's bar is 15 seconds lost, at worst");
});

test("the throttle is per Foray, so switching between two does not swallow a write", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  store.save({ forayId: ID, elapsedSec: 100, totalSec: TOTAL });
  assert.equal(store.save({ forayId: "other", elapsedSec: 100, totalSec: TOTAL }), true);
});

test("the store refuses a save it cannot make sense of", () => {
  const store = new ForayProgressStore({ storage: new FakeStorage() });
  assert.equal(store.save({ forayId: "", elapsedSec: 10, totalSec: TOTAL }), false);
  assert.equal(store.save({ forayId: ID, elapsedSec: 10, totalSec: 0 }), false);
  assert.equal(store.save({ forayId: ID, elapsedSec: NaN, totalSec: TOTAL }), false);
});

test("clearing resets the throttle too, so the next save is not swallowed", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  store.save({ forayId: ID, elapsedSec: 100, totalSec: TOTAL });
  store.clear(ID);
  assert.equal(store.get(ID), null);
  assert.equal(store.save({ forayId: ID, elapsedSec: 101, totalSec: TOTAL }), true);
});

test("a full quota does not make the store think it saved", () => {
  const s = new FakeStorage();
  s.failWrites = true;
  const store = new ForayProgressStore({ storage: s, everySec: 5 });
  assert.equal(store.save({ forayId: ID, elapsedSec: 100, totalSec: TOTAL }), false);
  s.failWrites = false;
  assert.equal(store.save({ forayId: ID, elapsedSec: 101, totalSec: TOTAL }), true,
    "the dropped write must not have advanced the throttle");
});

test("list() surfaces what the home screen renders, most recent first", () => {
  const s = new FakeStorage();
  const store = new ForayProgressStore({ storage: s });
  store.save({ forayId: "a", title: "A", elapsedSec: 600, totalSec: TOTAL, now: new Date("2026-08-15T10:00:00Z") });
  store.save({ forayId: "b", title: "B", elapsedSec: 900, totalSec: TOTAL, now: new Date("2026-08-16T10:00:00Z") });
  assert.deepEqual(store.list({ now: Date.parse("2026-08-16T11:00:00Z") }).map((r) => r.title), ["B", "A"]);
});
