/* The cp_bookmarks store (issue #30 §1; roadmap PQ-12).

   TO SEE ONE FAIL: drop the `near` check in addBookmark (the 5-s dedupe test
   makes two rows), swap `>` for `>=` on DRIFT_TOLERANCE_SEC in seek-policy
   (the 10-s drift test still passes, so the mutation to catch is `>` -> `<`:
   45 s reads EXACT and 10 s APPROXIMATE), or return the new row before
   `edit()` is consulted (the refused-write test gets a row, not null).
   CH-09a: every write is an EDIT over the value it lands on; see the
   hydrating-store test for the mutations that pins. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY, PER_EPISODE_CAP, TOTAL_CAP, DEDUPE_WINDOW_SEC,
  readAll, addBookmark, removeBookmark, listBookmarks, bookmarkPrecision, bookmarkLabel,
} from "./bookmarks.js";
import { EXACT, APPROXIMATE, DRIFT_TOLERANCE_SEC } from "./seek-policy.js";

/** A store shaped like app.js's storedValue/editStored once storage has
    settled: get(key, fallback), edit(key, fallback, fn) -> boolean, the edit
    applied at once over the stored value. */
function memoryStore(initial = {}, { refuse = false } = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    edit: (key, fallback, fn) => {
      const value = fn(data.has(key) ? data.get(key) : fallback);
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

/** editStored BEFORE storage has settled: an edit is queued, `get` answers the
    unhydrated value with the queued edits applied, and `land(durable)` swaps
    in the hydrated value and runs every queued edit over it, in order. */
function hydratingStore(unhydrated = {}) {
  const data = new Map(Object.entries(unhydrated));
  const queued = [];
  const view = (key, fallback) => queued.reduce((v, fn) => fn(v), data.has(key) ? data.get(key) : fallback);
  return {
    get: (key, fallback) => view(key, fallback),
    edit: (key, fallback, fn) => { queued.push(fn); return true; },
    land(durable) {
      data.clear();
      for (const [k, v] of Object.entries(durable)) data.set(k, JSON.parse(JSON.stringify(v)));
      const value = queued.splice(0).reduce((v, fn) => fn(v), data.has(KEY) ? data.get(KEY) : {});
      data.set(KEY, JSON.parse(JSON.stringify(value)));
    },
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

test("a write is an edit over the value it lands on: a queued mark joins the hydrated rows and is deduped there (CH-09a)", () => {
  /* Before storage settles app.js queues the edit and re-runs it over the
     durable value (A1-03). MUTATION: build the new map from `readAll(store)`
     (the page's view) inside the edit instead of from its argument -> the
     hydrated ep-old row is lost; red. MUTATION 2: drop the near check from
     placeRow (dedupe only against the view) -> the mark the durable list
     already holds at 62 s gets a second row at 60 s; red. MUTATION 3: make
     removeBookmark's edit ignore its argument and remove from
     `readAll(store)` -> the ep3 mark queued before it is lost; red.
     MUTATION 4: return the row without consulting edit()'s answer -> the
     refused-write test above gets a row; red. */
  const store = hydratingStore();
  const fresh = addBookmark(store, { episodeId: "ep1", sec: 30, now: at(0) });
  assert.ok(fresh, "a queued edit is taken");
  assert.equal(addBookmark(store, { episodeId: "ep1", sec: 32, now: at(1) }).created_at, fresh.created_at,
    "the view includes the queued mark, so a double tap is the same bookmark");
  addBookmark(store, { episodeId: "ep2", sec: 60, now: at(2) });
  const durableRow = { sec: 62, label: null, created_at: "2026-01-01T00:00:00.000Z", duration_sec: null };
  const oldRow = { sec: 5, label: null, created_at: "2026-01-02T00:00:00.000Z", duration_sec: null };
  store.land({ [KEY]: { ep2: [durableRow], "ep-old": [oldRow] } });
  assert.deepEqual(store.raw(), {
    "ep-old": [oldRow],
    ep1: [{ ...fresh }],
    ep2: [durableRow],
  });

  const removing = hydratingStore({ [KEY]: { ep1: [{ ...fresh }] } });
  const added = addBookmark(removing, { episodeId: "ep3", sec: 7, now: at(3) });
  assert.equal(removeBookmark(removing, "ep1", fresh.created_at), true);
  removing.land({ [KEY]: { ep1: [{ ...fresh }], "ep-old": [oldRow] } });
  assert.deepEqual(removing.raw(), { "ep-old": [oldRow], ep3: [{ ...added }] },
    "the removal lands on the hydrated map with the edit queued before it applied");
});

/* ---- the length of the copy in hand: ForayPlayer.observedDurationSec ----

   app.js's bookmarkObservedSec asks the REAL player for the length of the
   copy in hand, and before this card nothing answered, so no drift was ever
   seen and a moved timeline was still claimed to the second. The answer is
   the duration PositionStore recorded beside the position (the media
   element's own reading), or null; never the catalogue's duration_sec.

   The real player/client.js is imported over a stub localStorage seeded
   BEFORE the import (its durable store reads storage into memory when the
   module loads), with a cache-busting query so each test gets a fresh
   module. `cp_last_episode` carries the catalogue's 3600 s for the same
   episode: it is the one place client.js can see a catalogue duration for an
   id without a booted player, so a reading that leaned on the catalogue
   would answer from it. */

let clientSeq = 0;
async function clientOver(rows) {
  const data = new Map(Object.entries(rows));
  const ls = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
  const names = ["window", "document", "localStorage", "navigator"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) => Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  set("localStorage", ls);
  set("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
  set("document", { hidden: false, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] });
  set("navigator", {});
  try {
    return (await import(`./client.js?observed=${++clientSeq}`)).default;
  } finally {
    for (const [n, d] of prev) {
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  }
}

const posRow = (seconds, duration) => JSON.stringify({ seconds, duration, updated_at: "2026-10-01T10:00:00.000Z", source: "local" });
const LAST_EP = JSON.stringify({ id: "ep-1", title: "Ep", show: "Show", audio_url: "https://x.test/a.mp3", duration_sec: 3600 });

test(`observedDurationSec: a stored position measured more than ${DRIFT_TOLERANCE_SEC} s off the bookmark's length makes the mark approximate, 'around minute 62'`, async () => {
  /* The bookmark was set on a 3600 s copy; the copy that played since
     measured 3645 s (45 s of ad load), the catalogue still says 3600.
     MUTATION (run): make ForayPlayer.observedDurationSec return the
     catalogue's duration (`return readLastEpisode(storage)?.duration_sec ??
     null;`) -> 3600, no drift, "at 1:02:03"; red. MUTATION 2 (run):
     `return null;` -> no reading, "at 1:02:03"; red. */
  const client = await clientOver({ "cp_pos:ep-1": posRow(1800, 3645), cp_last_episode: LAST_EP });
  assert.equal(typeof client.observedDurationSec, "function", "the member app.js's bookmarkObservedSec asks for exists");
  const observed = client.observedDurationSec("ep-1");
  assert.equal(observed, 3645, "the length the player measured, not the catalogue's 3600");
  const bm = { sec: 3723, label: null, created_at: "2026-10-01T09:00:00.000Z", duration_sec: 3600 };
  const verdict = bookmarkPrecision({ dai_suspected: true }, bm, observed);
  assert.equal(verdict.precision, APPROXIMATE);
  assert.equal(bookmarkLabel(bm, verdict), "around minute 62");
  const inside = await clientOver({ "cp_pos:ep-1": posRow(1800, 3610) });
  assert.equal(bookmarkPrecision({ dai_suspected: true }, bm, inside.observedDurationSec("ep-1")).precision, EXACT,
    "10 s of drift is the same copy: at 1:02:03");
});

test("observedDurationSec is null when nothing was measured: no stored position, or one stored without a duration; never the catalogue's", async () => {
  /* MUTATION (run): `return knownEpisodeDurationSec(id,
     readLastEpisode(storage)?.duration_sec);` (measured first, catalogue
     second) -> 3600 for an episode the player never measured; red. */
  const client = await clientOver({ cp_last_episode: LAST_EP, "cp_pos:ep-2": posRow(60, null) });
  assert.equal(client.observedDurationSec("ep-1"), null, "no stored position: the catalogue's 3600 is not a reading");
  assert.equal(client.observedDurationSec("ep-2"), null, "a position with no measured length");
  assert.equal(client.observedDurationSec("ep-none"), null);
  assert.equal(client.observedDurationSec(""), null);
});
