/* The cp_bookmarks store (issue #30 §1; roadmap PQ-12).

   TO SEE ONE FAIL: drop the `near` check in addBookmark (the 5-s dedupe test
   makes two rows), swap `>` for `>=` on DRIFT_TOLERANCE_SEC in seek-policy
   (the 10-s drift test still passes, so the mutation to catch is `>` -> `<`:
   45 s reads EXACT and 10 s APPROXIMATE), or return the new row before
   `write()` is consulted (the refused-write test gets a row, not null). */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY, PER_EPISODE_CAP, TOTAL_CAP, DEDUPE_WINDOW_SEC,
  readAll, addBookmark, removeBookmark, listBookmarks, bookmarkPrecision, bookmarkLabel,
} from "./bookmarks.js";
import { EXACT, APPROXIMATE } from "./seek-policy.js";

/** A store shaped like app.js's lsGet/lsSet: get(key, fallback), set(key, value) -> boolean. */
function memoryStore(initial = {}, { refuse = false } = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => {
      writes.push([key, value]);
      if (refuse) return false;
      // Round-trip through JSON the way localStorage would, so a row that only
      // works by object identity is caught here.
      data.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
    writes,
    raw: () => data.get(KEY),
  };
}

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const at = (n) => T0 + n * 1000;

test("addBookmark appends a rounded, timestamped row and lists them sorted by sec", () => {
  const store = memoryStore();
  const b = addBookmark(store, { episodeId: "ep1", sec: 300.4, durationSec: 1800, now: at(0) });
  const a = addBookmark(store, { episodeId: "ep1", sec: 120.6, label: "the good bit", now: at(1) });
  assert.deepEqual(b, { sec: 300, label: null, created_at: new Date(at(0)).toISOString(), duration_sec: 1800 });
  assert.deepEqual(a, { sec: 121, label: "the good bit", created_at: new Date(at(1)).toISOString(), duration_sec: null });
  assert.deepEqual(listBookmarks(store, "ep1").map((r) => r.sec), [121, 300]);
  assert.equal(store.writes[0][0], KEY, "writes land on cp_bookmarks");
  assert.deepEqual(Object.keys(store.raw()), ["ep1"]);
  assert.deepEqual(listBookmarks(store, "never"), []);
});

test(`a mark within ${DEDUPE_WINDOW_SEC} s of an existing one is not added — the existing row comes back, nothing is written`, () => {
  const store = memoryStore();
  const first = addBookmark(store, { episodeId: "ep1", sec: 100, now: at(0) });
  const writesBefore = store.writes.length;
  const again = addBookmark(store, { episodeId: "ep1", sec: 104.6, now: at(5) });
  assert.deepEqual(again, first);
  assert.equal(store.writes.length, writesBefore, "the dedupe hit writes nothing");
  assert.equal(listBookmarks(store, "ep1").length, 1);
  // Just outside the window is a second mark.
  const far = addBookmark(store, { episodeId: "ep1", sec: 106, now: at(6) });
  assert.notDeepEqual(far, first);
  assert.equal(listBookmarks(store, "ep1").length, 2);
});

test(`over PER_EPISODE_CAP (${PER_EPISODE_CAP}) the oldest created_at on that episode goes`, () => {
  const store = memoryStore();
  // Oldest is NOT the smallest sec: created_at decides, not position.
  for (let i = 0; i < PER_EPISODE_CAP; i++) {
    addBookmark(store, { episodeId: "ep1", sec: 10_000 - i * 10, now: at(i) });
  }
  assert.equal(listBookmarks(store, "ep1").length, PER_EPISODE_CAP);
  const newest = addBookmark(store, { episodeId: "ep1", sec: 5, now: at(PER_EPISODE_CAP) });
  const rows = listBookmarks(store, "ep1");
  assert.equal(rows.length, PER_EPISODE_CAP);
  assert.ok(rows.some((r) => r.created_at === newest.created_at), "the new mark is kept");
  assert.ok(!rows.some((r) => r.created_at === new Date(at(0)).toISOString()), "the oldest mark (sec 10000) is gone");
  assert.ok(rows.some((r) => r.sec === 10_000 - 10), "the second-oldest stays: only one row was dropped");
});

test(`over TOTAL_CAP (${TOTAL_CAP}) the oldest created_at overall goes, from whichever episode holds it`, () => {
  const store = memoryStore();
  const perEp = 25;
  const episodes = TOTAL_CAP / perEp; // 20 episodes x 25 = 500
  let n = 0;
  for (let e = 0; e < episodes; e++) {
    for (let i = 0; i < perEp; i++) {
      addBookmark(store, { episodeId: `ep${e}`, sec: i * 100, now: at(n++) });
    }
  }
  const total = (all) => Object.values(all).reduce((s, l) => s + l.length, 0);
  assert.equal(total(readAll(store)), TOTAL_CAP);
  const newest = addBookmark(store, { episodeId: "ep-new", sec: 0, now: at(n++) });
  const all = readAll(store);
  assert.equal(total(all), TOTAL_CAP);
  assert.equal(all["ep-new"][0].created_at, newest.created_at);
  assert.equal(all.ep0.length, perEp - 1, "the oldest overall was ep0's first mark");
  assert.ok(!all.ep0.some((r) => r.created_at === new Date(at(0)).toISOString()));
  assert.equal(all.ep1.length, perEp, "no other episode lost a row");
});

test("removeBookmark removes by created_at, says so, and drops the episode key with its last row", () => {
  const store = memoryStore();
  const a = addBookmark(store, { episodeId: "ep1", sec: 100, now: at(0) });
  const b = addBookmark(store, { episodeId: "ep1", sec: 200, now: at(1) });
  addBookmark(store, { episodeId: "ep2", sec: 300, now: at(2) });
  assert.equal(removeBookmark(store, "ep1", a.created_at), true);
  assert.deepEqual(listBookmarks(store, "ep1").map((r) => r.sec), [200]);
  assert.equal(removeBookmark(store, "ep1", a.created_at), false, "already gone");
  assert.equal(removeBookmark(store, "nope", b.created_at), false, "unknown episode");
  assert.equal(removeBookmark(store, "ep1", b.created_at), true);
  assert.deepEqual(Object.keys(store.raw()), ["ep2"], "the emptied episode key is deleted");
});

test("a refused write adds nothing and returns null", () => {
  const store = memoryStore({ [KEY]: { ep1: [{ sec: 10, created_at: "2026-01-01T00:00:00.000Z", label: null, duration_sec: null }] } }, { refuse: true });
  assert.equal(addBookmark(store, { episodeId: "ep1", sec: 500, now: at(0) }), null);
  assert.deepEqual(listBookmarks(store, "ep1").map((r) => r.sec), [10], "the stored rows are untouched");
  assert.equal(removeBookmark(store, "ep1", "2026-01-01T00:00:00.000Z"), false, "a refused removal is reported as not done");
  assert.equal(listBookmarks(store, "ep1").length, 1);
  // Bad inputs are refused before any read or write.
  const clean = memoryStore();
  assert.equal(addBookmark(clean, { episodeId: "ep1", sec: -1 }), null);
  assert.equal(addBookmark(clean, { episodeId: "ep1", sec: NaN }), null);
  assert.equal(addBookmark(clean, { episodeId: "", sec: 1 }), null);
  assert.equal(clean.writes.length, 0);
});

test("readAll drops corrupt rows and non-object keys instead of throwing", () => {
  assert.deepEqual(readAll(memoryStore({ [KEY]: "garbage" })), {});
  assert.deepEqual(readAll(memoryStore({ [KEY]: [1, 2] })), {});
  assert.deepEqual(readAll(memoryStore({ [KEY]: null })), {});
  assert.deepEqual(readAll({ get() { throw new Error("deaf"); } }), {});
  const store = memoryStore({
    [KEY]: {
      ep1: [
        { sec: 30, created_at: "2026-01-01T00:00:00.000Z" }, // minimal valid: label/duration filled as null
        { sec: -5, created_at: "2026-01-01T00:00:01.000Z" }, // negative
        { sec: "12", created_at: "2026-01-01T00:00:02.000Z" }, // string sec
        { sec: Infinity, created_at: "2026-01-01T00:00:03.000Z" }, // not finite
        { sec: 40 }, // no created_at
        { sec: 50, created_at: 1700000000 }, // created_at not a string
        null, 7, "x",
        { sec: 20, created_at: "2026-01-01T00:00:04.000Z", label: 5, duration_sec: "x" }, // bad label/duration coerced to null
      ],
      ep2: "not an array",
      ep3: [{ sec: "bad", created_at: "2026-01-01T00:00:00.000Z" }], // all corrupt -> key left out
    },
  });
  assert.deepEqual(readAll(store), {
    ep1: [
      { sec: 20, label: null, created_at: "2026-01-01T00:00:04.000Z", duration_sec: null },
      { sec: 30, label: null, created_at: "2026-01-01T00:00:00.000Z", duration_sec: null },
    ],
  });
});

test("bookmarkPrecision: EXACT on a static enclosure whatever the drift", () => {
  const bm = { sec: 600, label: null, created_at: "2026-01-01T00:00:00.000Z", duration_sec: 3600 };
  assert.equal(bookmarkPrecision({ dai_suspected: false }, bm, 3600 + 900).precision, EXACT);
  assert.equal(bookmarkPrecision({}, bm, undefined).precision, EXACT);
  assert.equal(bookmarkPrecision(null, bm, 10).precision, EXACT);
});

test("bookmarkPrecision: APPROXIMATE on dai_suspected with 45 s of drift, EXACT with 10 s (own marker, DRIFT_TOLERANCE_SEC = 30)", () => {
  const item = { dai_suspected: true };
  const bm = { sec: 600, label: null, created_at: "2026-01-01T00:00:00.000Z", duration_sec: 3600 };
  const drifted = bookmarkPrecision(item, bm, 3600 + 45);
  assert.equal(drifted.precision, APPROXIMATE);
  assert.match(drifted.reason, /45s duration drift/);
  assert.equal(bookmarkPrecision(item, bm, 3600 - 45).precision, APPROXIMATE, "drift is absolute");
  assert.equal(bookmarkPrecision(item, bm, 3600 + 10).precision, EXACT);
  assert.equal(bookmarkPrecision(item, bm, 3600 - 10).precision, EXACT);
  // No duration on either side: an own marker is trusted (there is nothing to compare).
  assert.equal(bookmarkPrecision(item, { ...bm, duration_sec: null }, 3645).precision, EXACT);
  assert.equal(bookmarkPrecision(item, bm, undefined).precision, EXACT);
});

test("bookmarkLabel: the listener's label, else describeTimestamp for the precision", () => {
  const exact = { precision: EXACT, reason: "" };
  const approx = { precision: APPROXIMATE, reason: "" };
  const bm = { sec: 3723, label: null, created_at: "2026-01-01T00:00:00.000Z", duration_sec: null };
  assert.equal(bookmarkLabel({ ...bm, label: "the good bit" }, exact), "the good bit");
  assert.equal(bookmarkLabel({ ...bm, label: "the good bit" }, approx), "the good bit");
  assert.equal(bookmarkLabel(bm, exact), "at 1:02:03");
  assert.equal(bookmarkLabel(bm, approx), "around minute 62");
  assert.equal(bookmarkLabel({ ...bm, label: "" }, exact), "at 1:02:03", "an empty label falls back");
  // A bare precision string is accepted too.
  assert.equal(bookmarkLabel(bm, APPROXIMATE), "around minute 62");
});
