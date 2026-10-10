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
  readDownloads, writeDownloads, applyProgress, markPlayed, markMissing, removeRow,
  evictionPlan, playSource, readSource, localPlayable, usageLine, reportFromEvent,
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

test("writeDownloads(null) removes the row; a store that refuses the write answers false, never a throw", () => {
  /* CH-02 characterization: app.js's saveDownloads routes through this pair,
     so the null and refusal semantics are pinned before it does.
     MUTATION: delete `if (value === null) { storage.removeItem(KEY); return true; }`
     — null is normalised to the empty record and written; the key survives. */
  const store = fakeStorage();
  writeDownloads(store, threeOverCap());
  assert.ok(store.map.has(KEY), "fixture premise: the row is written");
  assert.deepEqual(Object.keys(readDownloads(store).items), ["a", "b", "c"], "and round-trips");
  assert.equal(writeDownloads(store, null), true);
  assert.equal(store.map.has(KEY), false, "null removes the key, it does not write \"null\" or an empty record");
  assert.deepEqual(readDownloads(store).items, {}, "and reads back as the empty record");
  const refusing = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  assert.equal(writeDownloads(refusing, threeOverCap()), false, "a quota throw is reported, not raised");
  assert.equal(writeDownloads(null, threeOverCap()), false, "no store took it");
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

/* Integration review (2026-10-04): progress and completion travel different
   paths (PQ-22 polls every 2 s; a broadcast reports completion), so a tick
   can land after `done`.
   MUTATION: delete the `IN_FLIGHT` guard line in `applyProgress` and the
   first assertion fails (the row reads "downloading" with its path still set). */
test("a late progress tick after done is refused; a missing file still moves a done row", () => {
  const v0 = { settings: {}, items: {} };
  const v1 = applyProgress(v0, { id: "e1", status: "done", bytes: 10 * MB, path: "/files/e1.mp3", now: "2026-09-10T00:01:00Z" });
  assert.equal(applyProgress(v1, { id: "e1", status: "downloading", bytes: 9 * MB, total: 10 * MB }), v1, "a late downloading tick is identity");
  assert.equal(applyProgress(v1, { id: "e1", status: "queued" }), v1, "so is a late queued");
  // Only in-flight statuses are refused: the file can still go missing.
  assert.equal(applyProgress(v1, { id: "e1", status: "missing" }).items.e1.status, "missing");
  // And an episode with no done row downloads as before.
  assert.equal(applyProgress(v0, { id: "e2", status: "downloading", bytes: 1, total: 2 }).items.e2.status, "downloading");
});

/* Integration review (2026-10-04): the bridge forwards (name, payload) and
   nothing mapped that onto a record status; `downloadFailed`'s `status` is
   the HTTP one, which `applyProgress` would drop as unknown.
   MUTATION: return `status: p.status` for `downloadFailed` and the 403 and
   500 assertions fail; return `null` for `downloadProgress` and the first does. */
test("reportFromEvent maps each bridge event to a record status, end to end through applyProgress", () => {
  const now = "2026-09-10T00:00:00Z";
  assert.deepEqual(reportFromEvent("downloadProgress", { id: "e1", bytes: 43, total: 100 }, { now }),
    { id: "e1", status: "downloading", bytes: 43, total: 100, now });
  const done1 = reportFromEvent("downloadDone", { id: "e1", path: "/files/e1.bin", bytes: 100 }, { webSrc: "https://localhost/_capacitor_file_/files/e1.bin", now });
  assert.deepEqual(done1, { id: "e1", status: "done", path: "/files/e1.bin", bytes: 100, total: 100, webSrc: "https://localhost/_capacitor_file_/files/e1.bin", now });
  assert.deepEqual(reportFromEvent("downloadFailed", { id: "e2", reason: "forbidden", status: 403 }, { now }),
    { id: "e2", status: "unplayable-here", reason: "forbidden", now }, "403: the host refuses this device (PQ-20/22)");
  assert.deepEqual(reportFromEvent("downloadFailed", { id: "e3", status: 500 }, { now }),
    { id: "e3", status: "failed", reason: "http 500", now }, "anything else is a retryable failure, reason from the HTTP status");
  assert.equal(reportFromEvent("downloadFailed", { id: "e4", reason: "unplayable-here" }).status, "unplayable-here");
  assert.equal(reportFromEvent("downloadPaused", { id: "e1" }), null, "an unknown event is null");
  assert.equal(reportFromEvent("downloadDone", { path: "/x" }), null, "no id is null");
  assert.equal(reportFromEvent("downloadDone", null), null);
  // End to end: the three events drive one record the way the page will.
  let v = { settings: {}, items: {} };
  v = applyProgress(v, reportFromEvent("downloadProgress", { id: "e1", bytes: 43, total: 100 }, { now }));
  assert.equal(v.items.e1.status, "downloading");
  v = applyProgress(v, done1);
  assert.equal(v.items.e1.status, "done");
  assert.equal(v.items.e1.webSrc, "https://localhost/_capacitor_file_/files/e1.bin");
  v = applyProgress(v, reportFromEvent("downloadFailed", { id: "e2", status: 403 }, { now }));
  assert.equal(v.items.e2.status, "unplayable-here");
  assert.equal(v.items.e2.reason, "http 403");
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
  assert.deepEqual(evictionPlan(v, null), ["a"], "no positions at all (null) is the same as none known — never a throw");
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

/* Integration review (2026-10-04). PQ-20's store is
   `Library/Application Support/foray-downloads/` — a space in every real
   iPhone path — and AVDeck parses `audio_url` with `URL(string:)`, which
   returns nil for a raw space on iOS 15/16 (the app's floor). The fixture
   paths above have no space, which is how this hid.
   MUTATION: make `fileUrl` return `"file://" + path` and this fails. */
test("playSource percent-encodes the iPhone path (Application Support has a space), segment by segment", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const path = "/var/mobile/Containers/Data/Application/ABC-123/Library/Application Support/foray-downloads/3f9a.bin";
  const src = playSource(item, { ...done(MB), path }, { platform: "ios" });
  assert.equal(src.audio_url,
    "file:///var/mobile/Containers/Data/Application/ABC-123/Library/Application%20Support/foray-downloads/3f9a.bin");
  assert.equal(src.isLocalFile, true);
  // A `#` or `?` in a segment is part of the name, not a fragment or a query.
  assert.equal(playSource(item, { ...done(MB), path: "/d/a#b?c.bin" }, { platform: "ios" }).audio_url, "file:///d/a%23b%3Fc.bin");
  // The round trip is the path: decoding the URL's path gives the file back.
  assert.equal(decodeURIComponent(new URL(src.audio_url).pathname), path);
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

test("CH-27 characterization: playSource's gate is `done` with a non-empty path, and nothing else opens the file", () => {
  /* The gate readSource shares (CH-27, P2-18). MUTATION: in the gate, test
     `typeof record.path === "string"` -> the empty-path row plays a local URL
     and this goes red. */
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const remote = { audio_url: "https://cdn/e1.mp3", isLocalFile: false };
  const rec = { ...done(MB), webSrc: "https://localhost/_capacitor_file_/files/e1.mp3" };
  assert.equal(playSource(item, rec, { platform: "android" }).isLocalFile, true);
  assert.deepEqual(playSource(item, { ...rec, path: "" }, { platform: "android" }), remote, "done, empty path");
  assert.deepEqual(playSource(item, { ...rec, path: null }, { platform: "ios" }), remote, "done, no path");
  for (const status of STATUSES.filter((s) => s !== "done")) {
    assert.deepEqual(playSource(item, { ...rec, status }, { platform: "android" }), remote, status);
  }
});

/* ---------- what the WebView reads (CH-27, P2-18) ---------- */

test("readSource: a done file opens at bridge.webSrc (CH3-05: was fileSrc), else the stored webSrc; a file: URL and a throwing bridge are null", () => {
  /* MUTATIONS: `record.webSrc ?? bridge.webSrc(...)` -> the stale stored URL
     wins and the first assert goes red; drop `!src.startsWith("file:")` -> the
     file:// answers are returned; drop the try/catch -> the throwing bridge
     throws out of readSource. */
  const rec = { ...done(MB), path: "/data/files/e1.mp3", webSrc: "https://localhost/_capacitor_file_/old/e1.mp3" };
  const bridge = { webSrc: (path) => `capacitor://localhost/_capacitor_file_${path}` };
  assert.equal(readSource(rec, bridge), "capacitor://localhost/_capacitor_file_/data/files/e1.mp3");
  assert.equal(readSource(rec, null), rec.webSrc, "no bridge: the stored webSrc");
  assert.equal(readSource(rec, {}), rec.webSrc, "a bridge without webSrc: the stored webSrc");
  assert.equal(readSource({ ...rec, webSrc: null }, null), null, "nothing the WebView can open");
  assert.equal(readSource({ ...rec, webSrc: "file:///data/files/e1.mp3" }, null), null, "file: refused");
  assert.equal(readSource(rec, { webSrc: () => "file:///data/files/e1.mp3" }), null, "file: from the bridge refused too");
  assert.equal(readSource(rec, { webSrc: () => { throw new Error("boom"); } }), null, "total");
});

test("readSource shares playSource's gate: a row the record reads back as missing opens nothing", () => {
  /* The empty-path `done` row is what normaliseDownloads calls `missing`.
     MUTATION: in readSource, replace `hasFile(record)` with the old inline
     `record.status === "done" && typeof record.path === "string"` -> the
     empty path yields a URL and this goes red. */
  const bridge = { webSrc: (path) => `https://localhost/_capacitor_file_${path}` };
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const base = { ...done(MB), webSrc: "https://localhost/_capacitor_file_/files/e1.mp3" };
  const rows = [base, { ...base, path: "" }, { ...base, path: null }, null,
    ...STATUSES.filter((s) => s !== "done").map((status) => ({ ...base, status }))];
  for (const rec of rows) {
    const plays = playSource(item, rec, { platform: "android" }).isLocalFile;
    assert.equal(readSource(rec, bridge) !== null, plays, JSON.stringify(rec));
  }
  assert.equal(readDownloads({ getItem: () => JSON.stringify({ items: { e1: { ...base, path: "" } } }) }).items.e1.status, "missing",
    "premise: the record reads this row back as missing");
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

test("removeRow is app.js's old downloadsWithout, moved: one row gone, the rest and the settings kept", () => {
  /* CH-02 (P2-11): the rule moved out of app.js. `downloadsWithout` below is
     app.js's at origin/main c58b35c4, verbatim, run over the normalised value
     app.js always handed it (downloadsValue()).
     MUTATION: drop `delete items[id];` in removeRow — the row survives; red.
     MUTATION 2: return `{ items }` (lose `...base`) — the settings go; red. */
  function downloadsWithout(value, id) {
    const items = { ...value.items };
    delete items[id];
    return { ...value, items };
  }
  const v = readDownloads((() => { const s = fakeStorage(); writeDownloads(s, { ...threeOverCap(), settings: { cellular: true, capBytes: 2 * GB } }); return s; })());
  for (const id of ["a", "b", "c"]) {
    assert.deepEqual(removeRow(v, id), downloadsWithout(v, id), `removing ${id}`);
  }
  assert.deepEqual(Object.keys(removeRow(v, "b").items), ["a", "c"]);
  assert.equal(removeRow(v, "b").settings.cellular, true, "the cellular switch survives a Remove");
  assert.deepEqual(Object.keys(v.items), ["a", "b", "c"], "pure: the input is not mutated");
  assert.equal(removeRow(v, "nope"), v, "identity for an id with no record, like markPlayed/markMissing");
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

/* ---------- CH3-05: the native index is the one truth ---------- */

/* CH3-05 characterization (R4-02). The record's `path` is read VERBATIM: the
   player opens whatever absolute path the record holds, and nothing here asks
   the phone where the file is today. iOS moves the app's container on every
   update, so the only way a stale path heals is the record being rewritten
   from the native index (download-bridge.js's boot reconcile) — this pins
   that the fix lives there, not in a second path rule here.
   MUTATION: in playSource, ignore `record.path` (e.g. `fileUrl("/x")`) -> the
   iPhone assertion is red. */
test("CH3-05 characterization: playSource opens the stored path verbatim, whatever container it names", () => {
  const item = { id: "e1", audio_url: "https://cdn/e1.mp3" };
  const OLD = "/var/mobile/Containers/Data/Application/OLD-UUID/Library/Application Support/foray-downloads/e1.bin";
  const rec = { ...done(10 * MB), path: OLD };
  assert.deepEqual(playSource(item, rec, { platform: "ios" }), {
    audio_url: "file:///var/mobile/Containers/Data/Application/OLD-UUID/Library/Application%20Support/foray-downloads/e1.bin",
    isLocalFile: true,
  });
});

/* CH3-05: download-bridge.js replays the plugin's list() at every boot, so the
   same report arrives again. A report that changes nothing but the clock is
   identity — the refusal shape app.js already skips (no write, no repaint,
   no "Downloaded.") — and `updated_at`, the eviction rank of a never-played
   file, is not restamped. A report that moves anything (today's path after an
   update, a new reason, new bytes) still lands, and `last_played_at` (CH-02)
   rides through it.
   MUTATION: delete the `sameRow` guard line in applyProgress -> the three
   identity assertions are red. */
test("CH3-05: a report that changes nothing is identity; one that moves the path lands and keeps last_played_at", () => {
  const OLD = "/var/mobile/Containers/Data/Application/OLD/Library/Application Support/foray-downloads/e1.bin";
  const NEW = "/var/mobile/Containers/Data/Application/NEW/Library/Application Support/foray-downloads/e1.bin";
  const base = applyProgress(readDownloads(null), { id: "e1", status: "done", path: OLD, bytes: 9 * MB, webSrc: "capacitor://x" + OLD, now: "2026-10-01T00:00:00Z" });
  const played = markPlayed(base, "e1", "2026-10-02T00:00:00Z");
  const again = { id: "e1", status: "done", path: OLD, bytes: 9 * MB, total: 9 * MB, webSrc: "capacitor://x" + OLD, now: "2026-10-09T00:00:00Z" };
  assert.equal(applyProgress(played, again), played, "the same done row, replayed: identity");

  const moved = applyProgress(played, { ...again, path: NEW, webSrc: "capacitor://x" + NEW });
  assert.notEqual(moved, played);
  assert.equal(moved.items.e1.path, NEW);
  assert.equal(moved.items.e1.webSrc, "capacitor://x" + NEW);
  assert.equal(moved.items.e1.last_played_at, "2026-10-02T00:00:00.000Z", "CH-02's stamp survives the rewrite");

  const failed = applyProgress(readDownloads(null), { id: "f", status: "failed", reason: "interrupted", now: "2026-10-01T00:00:00Z" });
  assert.equal(applyProgress(failed, { id: "f", status: "failed", reason: "interrupted", now: "2026-10-09T00:00:00Z" }), failed);
  assert.notEqual(applyProgress(failed, { id: "f", status: "failed", reason: "cancelled" }), failed, "a new reason lands");

  const ticking = applyProgress(readDownloads(null), { id: "g", status: "downloading", bytes: 10, total: 100, now: "2026-10-01T00:00:00Z" });
  assert.equal(applyProgress(ticking, { id: "g", status: "downloading", bytes: 10, total: 100 }), ticking);
  assert.equal(applyProgress(ticking, { id: "g", status: "downloading", bytes: 11, total: 100 }).items.g.bytes, 11);
});
