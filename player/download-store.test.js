/* The downloads record's rules (PQ-16, #29): what a stored value is read back
 * as, which transitions are refused, who goes first when the 2 GB cap is
 * reached, and what the player opens.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST, beyond the happy path: the eviction
 * guard. The cap is a courtesy to the device; an episode the listener is
 * halfway through is the listener's, and the one-line mutation that makes the
 * planner forget that (dropping `isInProgress` from the filter) is the one
 * this file most wants to catch. The thresholds are `position-store.js`'s own,
 * imported, never restated — a second opinion on "in progress" is the bug
 * where the Library and the player disagree.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEY, DEFAULT_CAP_BYTES, STATUSES,
  readDownloads, writeDownloads, applyProgress, markPlayed, markMissing,
  evictionPlan, playSource, localPlayable, usageLine,
} from "./download-store.js";
import { NEAR_END_SEC, MIN_RESUME_SEC } from "./position-store.js";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A `done` row, with the fields the planner and the usage line read. */
function done(bytes, { played = null, finished = "2026-09-01T00:00:00.000Z", dur = null } = {}) {
  return {
    status: "done", bytes, total: bytes, path: `/files/${bytes}.mp3`, webSrc: null,
    observed_duration_sec: dur, updated_at: finished, last_played_at: played, reason: null, source_url: null,
  };
}

/** Three finished downloads, oldest-played first: a (Sept 1), b (Sept 2), c (Sept 3), 900 MB each. */
function threeOverCap() {
  return {
    settings: { cellular: false, capBytes: 2 * GB },
    items: {
      a: done(900 * MB, { played: "2026-09-01T10:00:00.000Z" }),
      b: done(900 * MB, { played: "2026-09-02T10:00:00.000Z" }),
      c: done(900 * MB, { played: "2026-09-03T10:00:00.000Z" }),
    },
  };
}

/* ---------- reading and writing ---------- */

test("readDownloads normalises: junk statuses, non-object rows and bad settings are dropped, defaults applied", () => {
  const store = fakeStorage();
  store.setItem(KEY, JSON.stringify({
    settings: { cellular: "yes", capBytes: -5 },
    items: {
      keep: { status: "queued", bytes: "12", source_url: "https://x/e.mp3" },
      unknown: { status: "paused", bytes: 5 },            // a status this build does not know
      scalar: 7,                                           // not a row
      doneNoPath: { status: "done", bytes: 100 },          // a contradiction: read back as missing
    },
  }));
  const v = readDownloads(store);
  assert.equal(KEY, "cp_downloads");
  assert.equal(DEFAULT_CAP_BYTES, 2 * 1024 ** 3);
  assert.deepEqual(STATUSES, ["queued", "downloading", "done", "failed", "unplayable-here", "missing"]);
  assert.deepEqual(Object.keys(v.items).sort(), ["doneNoPath", "keep"],
    "mutation: delete the STATUS_SET check in normaliseItem -> `unknown` survives");
  assert.equal(v.items.keep.bytes, 0, "a string byte count is not a number");
  assert.equal(v.items.keep.source_url, "https://x/e.mp3");
  assert.equal(v.items.doneNoPath.status, "missing");
  assert.deepEqual(v.settings, { cellular: false, capBytes: DEFAULT_CAP_BYTES },
    "Q17 defaults: cellular off, 2 GB — a string `cellular` is not `true`");
  // Corrupt JSON and a dead store both read as the empty record, never a throw.
  store.setItem(KEY, "{not json");
  assert.deepEqual(readDownloads(store), { settings: { cellular: false, capBytes: DEFAULT_CAP_BYTES }, items: {} });
  assert.deepEqual(readDownloads(null).items, {});
  // The write round-trips through the same normalisation.
  assert.equal(writeDownloads(store, v), true);
  assert.deepEqual(readDownloads(store), v);
});

/* ---------- transitions ---------- */

test("applyProgress: `done` without a path is refused (identity); with one it lands and clears a stale reason", () => {
  const v0 = { settings: {}, items: {} };
  const v1 = applyProgress(v0, { id: "e1", status: "failed", reason: "net", now: "2026-09-10T00:00:00Z" });
  assert.equal(v1.items.e1.reason, "net", "failed keeps its reason");
  const refused = applyProgress(v1, { id: "e1", status: "done", bytes: 10 * MB, now: "2026-09-10T00:01:00Z" });
  assert.equal(refused, v1, "mutation: drop the `status === \"done\" && !isStr(path)` guard -> a path-less done row enters");
  const v2 = applyProgress(v1, { id: "e1", status: "done", bytes: 10 * MB, path: "/files/e1.mp3", now: "2026-09-10T00:01:00Z" });
  assert.notEqual(v2, v1);
  assert.equal(v1.items.e1.status, "failed", "pure: the input value is not mutated");
  assert.equal(v2.items.e1.status, "done");
  assert.equal(v2.items.e1.path, "/files/e1.mp3");
  assert.equal(v2.items.e1.reason, null, "a retried download does not carry last week's error");
  assert.equal(v2.items.e1.total, 10 * MB, "a finished file is its own total");
  assert.equal(v2.items.e1.updated_at, "2026-09-10T00:01:00.000Z");
  assert.equal(applyProgress(v2, { id: "e1", status: "paused" }), v2, "an unknown status is refused (identity)");
  assert.equal(applyProgress(v2, { status: "queued" }), v2, "no id is refused (identity)");
});

/* ---------- eviction ---------- */

test("evictionPlan removes the oldest last_played_at first, one at a time, until the done bytes fit", () => {
  const plan = evictionPlan(threeOverCap(), {});
  assert.deepEqual(plan, ["a"], "mutation: flip the sort to newest-first -> [\"c\"]");
  // Tighter cap: two have to go, still oldest first.
  const tight = threeOverCap();
  tight.settings.capBytes = 1 * GB;
  assert.deepEqual(evictionPlan(tight, {}), ["a", "b"]);
  // Under the cap: nothing to do.
  const roomy = threeOverCap();
  roomy.settings.capBytes = 3 * GB;
  assert.deepEqual(evictionPlan(roomy, {}), []);
});

test("evictionPlan never evicts an episode in progress (sec 600 of 3600), even when that leaves the record over the cap", () => {
  const v = threeOverCap();
  const positions = { a: { sec: 600, durationSec: 3600 } };
  assert.deepEqual(evictionPlan(v, positions), ["b"],
    "mutation: drop `!isInProgress(...)` from the candidate filter -> [\"a\"]");
  // Every one of them in progress: the plan is empty and the cap goes unmet.
  const all = { a: { sec: 600, durationSec: 3600 }, b: { sec: 600, durationSec: 3600 }, c: { sec: 600, durationSec: 3600 } };
  assert.deepEqual(evictionPlan(v, all), []);
  // The thresholds are position-store's: exactly MIN_RESUME_SEC counts, one under does not.
  assert.deepEqual(evictionPlan(v, { a: { sec: MIN_RESUME_SEC, durationSec: 3600 } }), ["b"]);
  assert.deepEqual(evictionPlan(v, { a: { sec: MIN_RESUME_SEC - 1, durationSec: 3600 } }), ["a"]);
  // An unknown duration with a real position is in progress — the record's observed duration fills in when it has one.
  assert.deepEqual(evictionPlan(v, { a: { sec: 600, durationSec: null } }), ["b"]);
  const observed = threeOverCap();
  observed.items.a.observed_duration_sec = 3600;
  assert.deepEqual(evictionPlan(observed, { a: { sec: 3600 - NEAR_END_SEC + 1, durationSec: null } }), ["a"],
    "the record's observed_duration_sec is the fallback duration, so near its end it is finished");
});

test("evictionPlan: a finished episode (sec 3580 of 3600) is evictable", () => {
  const v = threeOverCap();
  assert.deepEqual(evictionPlan(v, { a: { sec: 3580, durationSec: 3600 } }), ["a"],
    "mutation: change `<=` to `<` on the NEAR_END_SEC clause -> still [\"a\"]; change the guard to `sec >= MIN_RESUME_SEC` alone -> [\"b\"]");
  // Exactly on the near-end line is still in progress; one past it is finished.
  assert.deepEqual(evictionPlan(v, { a: { sec: 3600 - NEAR_END_SEC, durationSec: 3600 } }), ["b"]);
  assert.deepEqual(evictionPlan(v, { a: { sec: 3600 - NEAR_END_SEC + 1, durationSec: 3600 } }), ["a"]);
});

test("evictionPlan: an id with no position is evictable, and a never-played download ranks by when it finished", () => {
  const v = threeOverCap();
  assert.deepEqual(evictionPlan(v, { b: { sec: 600, durationSec: 3600 }, c: { sec: 600, durationSec: 3600 } }), ["a"],
    "mutation: treat a missing position as in progress -> []");
  // Never played: `updated_at` (when the download finished) is the LRU key.
  const never = threeOverCap();
  never.items.a.last_played_at = null;
  never.items.a.updated_at = "2026-09-04T00:00:00.000Z"; // finished after c was last played
  assert.deepEqual(evictionPlan(never, {}), ["b"]);
  // Only `done` bytes count: a downloading row neither counts nor is planned.
  const inflight = threeOverCap();
  inflight.items.d = { status: "downloading", bytes: 5 * GB, total: 6 * GB, path: null };
  assert.deepEqual(evictionPlan(inflight, {}), ["a"]);
});

/* ---------- the play source ---------- */

test("playSource on ios: a done record plays file:// + path, isLocalFile true", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const rec = done(10 * MB);
  assert.deepEqual(playSource(item, rec, { platform: "ios" }), { audio_url: "file://" + rec.path, isLocalFile: true },
    "mutation: drop the `file://` prefix -> a bare path AVDeck cannot load");
  // An already-schemed path is not doubled.
  assert.equal(playSource(item, { ...rec, path: "file:///files/e1.mp3" }, { platform: "ios" }).audio_url, "file:///files/e1.mp3");
});

test("playSource on android: a done record plays the bridge's webSrc, isLocalFile true", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const rec = { ...done(10 * MB), webSrc: "https://appassets.androidplatform.net/files/e1.mp3" };
  assert.deepEqual(playSource(item, rec, { platform: "android" }), { audio_url: rec.webSrc, isLocalFile: true },
    "mutation: return `file://` + path on every platform -> the WebView cannot read the files dir");
  // No webSrc to play: it degrades to the stream rather than handing over null.
  assert.deepEqual(playSource(item, { ...rec, webSrc: null }, { platform: "android" }), { audio_url: item.audio_url, isLocalFile: false });
});

test("playSource is the item's remote audio_url for anything that is not a playable download", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const remote = { audio_url: "https://cdn/e1.mp3", isLocalFile: false };
  assert.deepEqual(playSource(item, null, { platform: "ios" }), remote, "no record");
  assert.deepEqual(playSource(item, { ...done(1), status: "downloading" }, { platform: "ios" }), remote,
    "mutation: test `record.path` alone -> a downloading row with a partial path plays the half file");
  assert.deepEqual(playSource(item, { ...done(1), status: "missing", path: null }, { platform: "ios" }), remote, "missing");
  assert.deepEqual(playSource(item, { ...done(1), status: "unplayable-here" }, { platform: "ios" }), remote, "unplayable here");
  assert.deepEqual(playSource(item, done(1), {}), remote, "no platform and no webSrc: remote, never a null audio_url");
});

/* ---------- missing ---------- */

test("markMissing flips a done row to missing, drops its path, keeps the row; an unknown id is a no-op", () => {
  const v = threeOverCap();
  const next = markMissing(v, "a");
  assert.equal(next.items.a.status, "missing", "mutation: set status to \"failed\" -> red");
  assert.equal(next.items.a.path, null);
  assert.equal(v.items.a.status, "done", "pure: the input is not mutated");
  assert.equal(Object.keys(next.items).length, 3, "the row stays: the listener asked for this episode");
  assert.equal(markMissing(v, "nope"), v, "identity for an id with no record");
  // And it no longer counts: 2 x 900 MB fits under 2 GB.
  assert.deepEqual(evictionPlan(next, {}), []);
  // markPlayed moves a row to the back of the queue.
  const played = markPlayed(v, "a", "2026-09-09T00:00:00Z");
  assert.equal(played.items.a.last_played_at, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(evictionPlan(played, {}), ["b"]);
  assert.equal(markPlayed(v, "nope"), v);
});

/* ---------- the usage line ---------- */

test("usageLine: binary GB to one decimal, the cap trimmed, done rows counted; empty says so", () => {
  const v = {
    settings: { capBytes: 2 * GB },
    items: {
      a: done(600 * MB), b: done(600 * MB), c: done(600 * MB), d: done(600 * MB),
      e: done(600 * MB), f: done(600 * MB), g: done(600 * MB),               // 4200 MB = 4.1015625 GB
      h: { status: "downloading", bytes: 900 * MB, total: 1 * GB, path: null }, // not counted
      i: { status: "missing", bytes: 900 * MB, total: 900 * MB, path: null },   // not counted
    },
  };
  assert.equal(usageLine(v), "4.1 GB of 2 GB used · 7 episodes",
    "mutation: divide by 1e9 -> \"4.4 GB\"; count every row -> \"9 episodes\"");
  const one = { settings: { capBytes: 2 * GB }, items: { a: done(Math.round(1.2 * GB)) } };
  assert.equal(usageLine(one), "1.2 GB of 2 GB used · 1 episode", "singular");
  assert.equal(usageLine({ settings: { capBytes: 1.5 * GB }, items: { a: done(1) } }), "0.0 GB of 1.5 GB used · 1 episode",
    "a fractional cap keeps its decimal");
  assert.equal(usageLine({ settings: {}, items: {} }), "0 episodes downloaded");
  assert.equal(usageLine({ settings: {}, items: { h: { status: "queued", bytes: 0 } } }), "0 episodes downloaded",
    "a queued row is not a downloaded episode");
});

/* ---------- the queue item ---------- */

test("localPlayable: a local source replaces audio_url, keeps the remote one as source_audio_url and sets isLocalFile", () => {
  const item = { id: "e1", title: "T", audio_url: "https://cdn/e1.mp3", duration_sec: 3600 };
  const out = localPlayable(item, { audio_url: "file:///files/e1.mp3", isLocalFile: true });
  assert.deepEqual(out, {
    id: "e1", title: "T", duration_sec: 3600,
    audio_url: "file:///files/e1.mp3", source_audio_url: "https://cdn/e1.mp3", isLocalFile: true,
  }, "mutation: drop `source_audio_url` -> the missing-file degrade has nothing to fall back to");
  assert.equal(item.audio_url, "https://cdn/e1.mp3", "pure: the item is not mutated");
});

test("localPlayable returns the same item (===) when the source is remote", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  assert.equal(localPlayable(item, { audio_url: "https://cdn/e1.mp3", isLocalFile: false }), item,
    "mutation: always spread -> a new object, and every caller's `===` check re-renders");
  assert.equal(localPlayable(item, null), item);
});
