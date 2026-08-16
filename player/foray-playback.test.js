/* Foray #1, end to end, against a fake backend and the REAL committed data
   (issues #128, #133, #111).

   WHY THIS SUITE EXISTS
   Every layer under it is already tested in isolation: the reducer, the
   builder, the out-point watch, the join. None of that answers the question the
   founder is actually asking — "does the grilling Foray play, all of it, in
   order, in the app?" That question is only answerable by running the shipped
   documents through the shipped code, so this suite reads `data/*.json` off
   disk rather than using fixtures.

   Reading real data in a test has one real cost: an unrelated content change
   can turn it red. That is deliberate here and the assertions are written for
   it — they pin the CONTRACT (every authored segment resolves, the order is the
   authored order, nothing plays past its out-point) rather than the specific 32
   segments, with one exception that names the count, because "Foray #1 lost a
   segment and nobody noticed" is exactly the regression worth a red build.

   The fake backend is the one from queue-manager.test.js, reduced to what a
   Foray needs. Nothing here touches the network: `audio_url` is asserted on,
   never fetched. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { END_OUT_POINT } from "./queue-state.js";
import {
  resolveForay, indexSegments, indexSources, findForay,
  forayElapsed, segmentAtElapsed, fmtClock,
} from "./foray-resolve.js";
import { ForayProgressStore, resumePoint } from "./foray-progress.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const FORAY_ID = "grilling-history-1";
const FORAYS = readJson("data/forays.json");
const SEGMENTS = readJson("data/segments.json");
const SOURCES = readJson("data/segment-sources.json");

/** The founder's way in: the id is named, so the draft resolves. */
function realForay() {
  const foray = findForay(FORAYS, FORAY_ID, { unlocked: [FORAY_ID] });
  assert.ok(foray, `${FORAY_ID} must exist in data/forays.json`);
  return foray;
}

function realResolve() {
  return resolveForay(realForay(), {
    segments: indexSegments(SEGMENTS),
    sources: indexSources(SOURCES),
  });
}

/* ---------- the fake ---------- */

/** Records every call, so the assertions are about SEQUENCE — which is where a
    Foray goes wrong (a missed out-point, a segment loaded at 0:00, a same-
    episode pair collapsing into one). */
class FakeBackend {
  constructor({ durationById = {} } = {}) {
    this.calls = [];
    this.currentTime = 0;
    this._duration = 3600;
    this.durationById = durationById;
    this._loadedId = null;
    this.outPoint = null;
    this.onItemEnded = null;
    this.onError = null;
  }
  get duration() { return this.durationById[this._loadedId] ?? this._duration; }
  async load(item, { startOffset = 0 } = {}) {
    this._loadedId = item.source_item_id ?? item.id;
    this.outPoint = null;               // contract: a load drops any armed boundary
    this.currentTime = startOffset;
    this.calls.push(`load:${item.id}@${round(startOffset)}`);
  }
  play() { this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  seek(s) { this.currentTime = s; this.calls.push(`seek:${round(s)}`); }
  setOutPoint(s) { this.outPoint = s; this.calls.push(`outPoint:${s == null ? "null" : round(s)}`); }
  setRate(r) { this.calls.push(`rate:${r}`); }
  release() { this.calls.push("release"); }
  loads() { return this.calls.filter((c) => c.startsWith("load:")).map((c) => c.split("@")[0].slice(5)); }
  /** The out-point landing: the playhead reaches the boundary and the backend
      reports the same end a finished file reports. */
  async reachOutPoint() {
    assert.ok(this.outPoint != null, "nothing armed — this segment would run to the end of its episode");
    this.currentTime = this.outPoint;
    await this.onItemEnded(END_OUT_POINT);
  }
}

const round = (n) => Math.round(Number(n) || 0);

/** The resume store writes to a Storage; there is no browser here. Only the
    three methods it actually calls, so a change to what it needs fails loudly. */
class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

function make(opts = {}) {
  __resetInstanceForTests();
  const backend = new FakeBackend(opts);
  const log = [];
  const m = new PlayerQueueManager({ backend, telemetry: (t) => log.push(t) });
  return { m, backend, log };
}

/** Play the Foray the way the app does: hydrated document in, resolveItem
    supplied from the source index. */
function startForay(m, resolved) {
  return m.playForay(resolved.hydrated, {
    resolveItem: (id) => resolved.sources.get(id) ?? null,
  });
}

/* ---------- the shipped documents resolve ---------- */

test("Foray #1 is in data/forays.json, is a draft, and has 32 ordered items", () => {
  const foray = realForay();
  assert.equal(foray.status, "draft", "if this is published, the UI's draft gate is moot — say so on purpose");
  assert.equal(foray.items.length, 32);
  assert.ok(foray.items.every((i) => i.type === "segment"));
});

test("every authored segment of Foray #1 resolves to real audio", () => {
  const r = realResolve();
  assert.deepEqual(r.unplayable, [], "a segment that cannot play is a shorter Foray — fix the data or the join");
  assert.equal(r.playable.length, 32);
  assert.ok(r.playable.every((i) => /^https:/.test(i.audio_url)), "every source must be https (the CSP is media-src https:)");
});

test("the running order is the authored order, slot by slot", () => {
  const r = realResolve();
  const foray = realForay();
  assert.deepEqual(r.entries.map((e) => e.label), foray.items.map((i) => i.label));
  assert.deepEqual(r.slots.map((s) => s.id), foray.slots.map((s) => s.id));
  assert.equal(r.slots.reduce((n, s) => n + s.entries.length, 0), 32);
});

test("the total runtime matches what the Foray document declares", () => {
  const r = realResolve();
  assert.ok(Math.abs(r.totalSec - realForay().runtime_sec) < 1, `${r.totalSec} vs declared`);
  assert.equal(fmtClock(r.totalSec), "1:01:13");
});

test("every why-line the UI will render is inside the copy budget", () => {
  // CLAUDE.md product principle 4. These lines are authored in data/segments.json
  // and rendered verbatim; a surface that has to trim them is a surface lying
  // about the segment.
  const long = realResolve().entries
    .filter((e) => e.why.trim().split(/\s+/).length > 18)
    .map((e) => `${e.label}: ${e.why}`);
  assert.deepEqual(long, []);
});

test("the segments come from more than one show — that is the point of a Foray", () => {
  const r = realResolve();
  assert.ok(r.shows.length >= 4, `only ${r.shows.length} shows`);
  assert.ok(r.entries.every((e) => e.show), "every row needs a show name to render");
});

/* ---------- it plays ---------- */

test("pressing play loads segment 1 at its in-point and arms its out-point", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);

  const first = r.playable[0];
  assert.deepEqual(backend.calls.slice(0, 4), [
    `load:${first.id}@${round(first.start_sec)}`,
    "rate:1",
    `outPoint:${round(first.end_sec)}`,
    "play",
  ]);
  assert.equal(m.state.type, "playing");
});

test("all 32 segments play through, in order, and the Foray then ends", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);

  for (let i = 0; i < 32; i++) {
    assert.equal(m.currentIndex, i, `expected to be on segment ${i + 1}`);
    await backend.reachOutPoint();
  }

  assert.equal(m.state.type, "ended", "the queue must end, not loop or stall");
  assert.deepEqual(backend.loads(), r.playable.map((i) => i.id));
  assert.equal(backend.calls.filter((c) => c === "play").length, 32);
});

test("every segment is loaded at its own in-point, never at 0:00", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  for (let i = 0; i < 32; i++) await backend.reachOutPoint();

  const offsets = backend.calls.filter((c) => c.startsWith("load:")).map((c) => Number(c.split("@")[1]));
  assert.deepEqual(offsets, r.playable.map((i) => round(i.start_sec)));
});

test("consecutive segments of the SAME episode are two loads, not one", async () => {
  // This Foray does it repeatedly (12 segments of one episode in one slot). If
  // the two collapsed, the second would never play and the first would repeat.
  const r = realResolve();
  const pairs = r.playable.filter((it, i) => i > 0 && r.playable[i - 1].source_item_id === it.source_item_id);
  assert.ok(pairs.length > 0, "the fixture premise is gone — this Foray no longer repeats an episode");

  const { m, backend } = make();
  await startForay(m, r);
  for (let i = 0; i < 32; i++) await backend.reachOutPoint();
  assert.equal(new Set(backend.loads()).size, 32, "every queue item must be distinct");
});

test("the out-point armed for each segment is that segment's own end", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  for (let i = 0; i < 32; i++) await backend.reachOutPoint();

  const armed = backend.calls.filter((c) => c.startsWith("outPoint:")).map((c) => Number(c.slice(9)));
  assert.deepEqual(armed, r.playable.map((i) => round(i.end_sec)));
});

/* ---------- transport ---------- */

test("next skips to the following segment without playing the rest of the episode", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  await m.skipToNext();

  assert.equal(m.currentIndex, 1);
  assert.equal(backend.outPoint, r.playable[1].end_sec, "the new segment's out-point must be armed");
  assert.ok(backend.calls.includes(`load:${r.playable[1].id}@${round(r.playable[1].start_sec)}`));
});

test("previous restarts the current segment at its in-point, not at 0:00 of the episode", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  await m.skipToNext();
  backend.currentTime = r.playable[1].start_sec + 20;
  backend.calls.length = 0;
  await m.skipToPrevious();

  assert.equal(m.currentIndex, 1);
  assert.ok(backend.calls.includes(`load:${r.playable[1].id}@${round(r.playable[1].start_sec)}`));
});

test("clicking a row jumps straight to that segment", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  await m.play(20);

  assert.equal(m.currentIndex, 20);
  assert.ok(backend.calls.includes(`load:${r.playable[20].id}@${round(r.playable[20].start_sec)}`));
  assert.equal(backend.outPoint, r.playable[20].end_sec);
  assert.equal(m.state.type, "playing");
});

test("a jump while playing pauses the outgoing segment first (no two audible at once)", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  backend.calls.length = 0;
  await m.play(9);
  assert.equal(backend.calls[0], "pause", `expected a pause first, got ${backend.calls[0]}`);
});

test("pause and resume keep the listener inside the segment", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  backend.currentTime = r.playable[0].start_sec + 40;
  await m.pause();
  assert.equal(m.state.type, "interrupted");

  backend.calls.length = 0;
  await m.resume();
  assert.equal(m.state.type, "playing");
  // Resuming in place, not restarting: the load carries the playhead, not the
  // in-point (queue-manager's `resumingInPlace`).
  assert.ok(
    backend.calls.includes(`load:${r.playable[0].id}@${round(r.playable[0].start_sec + 40)}`),
    backend.calls.join(" | ")
  );
});

/* ---------- the number a listener recognises ---------- */

test("elapsed is Foray time, not a position inside somebody else's episode", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);

  // 30 seconds into the first segment is 30 seconds into the Foray, even though
  // the audio element reads ~177 s.
  backend.currentTime = r.playable[0].start_sec + 30;
  assert.equal(round(forayElapsed(r.playable, m.currentIndex, backend.currentTime)), 30);

  await m.play(20);
  backend.currentTime = r.playable[20].start_sec + 5;
  const elapsed = forayElapsed(r.playable, 20, backend.currentTime);
  assert.ok(elapsed > 1500 && elapsed < r.totalSec, `${elapsed} out of range`);
  assert.equal(segmentAtElapsed(r.playable, elapsed).index, 20);
});

test("elapsed never exceeds the Foray's total, at any segment", async () => {
  const r = realResolve();
  const last = r.playable.length - 1;
  const past = forayElapsed(r.playable, last, r.playable[last].end_sec + 999);
  assert.ok(past <= r.totalSec + 0.001, `${past} > ${r.totalSec}`);
});

/* ---------- degrading honestly ---------- */

test("a missing source file costs its segments and nothing else", async () => {
  // Simulates a partial deploy: segment-sources.json is stale and one episode
  // has gone. The Foray must still play the rest and say what it lost.
  const sources = indexSources(SOURCES);
  const dropped = "moreish-jerk-jamaica";
  sources.delete(dropped);
  const r = resolveForay(realForay(), { segments: indexSegments(SEGMENTS), sources });

  assert.ok(r.playable.length > 0 && r.playable.length < 32);
  assert.ok(r.unplayable.length > 0);
  assert.ok(r.unplayable.every((u) => u.reason.includes(dropped)));
  assert.ok(r.totalSec < realForay().runtime_sec);

  const { m, backend } = make();
  await startForay(m, r);
  for (let i = 0; i < r.playable.length; i++) await backend.reachOutPoint();
  assert.equal(m.state.type, "ended");
  assert.equal(backend.loads().length, r.playable.length);
});

test("segments.json going missing entirely leaves an empty, non-crashing Foray", async () => {
  const r = resolveForay(realForay(), { segments: indexSegments(null), sources: indexSources(SOURCES) });
  assert.equal(r.playable.length, 0);
  assert.equal(r.unplayable.length, 32);

  const { m } = make();
  const report = await startForay(m, r);
  assert.equal(report.items.length, 0);
  assert.equal(m.state.type, "idle", "an empty Foray must not pretend to play");
});

test("the manager builds exactly the queue the surface rendered", async () => {
  // The running order is resolved once for rendering and once by the manager at
  // play time. They must be the same list, or the highlighted row is not the
  // audible segment.
  const r = realResolve();
  const { m } = make();
  const report = await startForay(m, r);
  assert.deepEqual(report.items.map((i) => i.id), r.playable.map((i) => i.id));
  assert.deepEqual(report.items.map((i) => i.start_sec), r.playable.map((i) => i.start_sec));
  assert.deepEqual(report.skipped, []);
});

/* ---------- closing the tab and coming back ----------

   The bar: 20 minutes into a 61-minute Foray, close the tab, come back, land in
   the same second. Three things have to line up for that — the clock we store
   (`forayElapsed`), the segment we map it back to (`segmentAtElapsed`), and the
   two-step load-then-seek the client performs, because the manager loads a
   bounded segment at its IN-POINT by contract and no start offset changes that.
   Each is tested alone elsewhere; this is the round trip, on the real Foray.

   The client's own resume path is `ForayPlayer.playForay({ startElapsedSec })`,
   which cannot run here (it builds DOM). What is reproduced below is exactly the
   sequence it performs, so a change to that sequence has to change this file. */

/** What player/client.js does with a stored elapsed, minus the DOM. */
async function resumeAt(m, r, elapsedSec) {
  const at = segmentAtElapsed(r.playable, elapsedSec);
  await m.play(at.index);
  const item = r.playable[at.index];
  await m.seek(item.start_sec + at.into, { precise: true });
  return at;
}

test("a position stored mid-Foray comes back to the same segment and the same second", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);

  // Listen into segment 17, then "close the tab".
  await m.play(17);
  const playhead = r.playable[17].start_sec + 40;
  backend.currentTime = playhead;
  const stored = forayElapsed(r.playable, 17, playhead);

  const store = new ForayProgressStore({ storage: new FakeStorage() });
  store.save({ forayId: r.id, title: r.title, elapsedSec: stored, totalSec: r.totalSec, index: 17 });

  // A fresh page load: nothing in memory, only the row in storage.
  const point = resumePoint(store.get(r.id), { totalSec: r.totalSec });
  assert.ok(point, "20 minutes of listening must be offered back");
  assert.equal(point.index, 17);

  const fresh = make();
  await startForay(fresh.m, r);
  const at = await resumeAt(fresh.m, r, point.elapsedSec);
  assert.equal(at.index, 17, "the resume point must resolve to the segment it was taken from");
  assert.equal(fresh.m.currentIndex, 17);
  assert.ok(Math.abs(fresh.backend.currentTime - playhead) < 0.001,
    `resumed at ${fresh.backend.currentTime}, left at ${playhead}`);
});

test("resuming loads the segment at its in-point and only then seeks", async () => {
  // Not a style point. The manager arms the out-point from the item's bounds at
  // load; a load placed straight at the resume offset would be a load into the
  // middle of somebody else's episode with no boundary behind it.
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  backend.calls.length = 0;

  const target = forayElapsed(r.playable, 12, r.playable[12].start_sec + 25);
  await resumeAt(m, r, target);

  const item = r.playable[12];
  const loadAt = backend.calls.indexOf(`load:${item.id}@${round(item.start_sec)}`);
  const seekAt = backend.calls.findIndex((c) => c.startsWith("seek:"));
  assert.ok(loadAt >= 0, `no in-point load: ${backend.calls.join(" | ")}`);
  assert.ok(seekAt > loadAt, "the seek must follow the load, never replace it");
  assert.equal(backend.outPoint, item.end_sec, "the resumed segment still needs its own out-point armed");
});

test("resuming keeps the rest of the Foray intact — it plays on to the end from there", async () => {
  const r = realResolve();
  const { m, backend } = make();
  await startForay(m, r);
  const at = await resumeAt(m, r, forayElapsed(r.playable, 29, r.playable[29].start_sec + 10));
  assert.equal(at.index, 29);

  for (let i = 29; i < r.playable.length; i++) await backend.reachOutPoint();
  assert.equal(m.state.type, "ended");
  assert.equal(m.currentIndex, r.playable.length - 1);
});

test("a stored position in the closing segment is treated as finished, not resumed", async () => {
  const r = realResolve();
  const store = new ForayProgressStore({ storage: new FakeStorage() });
  store.save({ forayId: r.id, elapsedSec: r.totalSec - 10, totalSec: r.totalSec, index: 31 });
  const point = resumePoint(store.get(r.id), { totalSec: r.totalSec });
  assert.equal(point.finished, true, "resuming 10 seconds before the end drops the listener into a goodbye");
});

test("a position stored against a longer version of the Foray does not resume past its end", async () => {
  // A repaired data file makes the Foray shorter. The live document is the
  // authority, and the clamp must land on a segment that still exists.
  const r = realResolve();
  const store = new ForayProgressStore({ storage: new FakeStorage() });
  store.save({ forayId: r.id, elapsedSec: r.totalSec + 600, totalSec: r.totalSec + 900, index: 99 });
  const point = resumePoint(store.get(r.id), { totalSec: r.totalSec });
  assert.equal(point.elapsedSec, r.totalSec);

  const { m } = make();
  await startForay(m, r);
  const at = await resumeAt(m, r, point.elapsedSec);
  assert.equal(at.index, r.playable.length - 1, "clamped to the last real segment, never to nothing");
});

test("every second of the Foray maps back to the segment it came from", async () => {
  // The property behind resume, checked across the whole hour rather than at one
  // point: whatever we store, we come back to the same place.
  const r = realResolve();
  let checked = 0;
  for (let i = 0; i < r.playable.length; i++) {
    const item = r.playable[i];
    const into = Math.min(5, (item.authored_end_sec ?? item.end_sec) - item.start_sec - 0.5);
    const elapsed = forayElapsed(r.playable, i, item.start_sec + into);
    const back = segmentAtElapsed(r.playable, elapsed);
    assert.equal(back.index, i, `segment ${i} resumed as ${back.index}`);
    assert.ok(Math.abs(back.into - into) < 0.001);
    checked++;
  }
  assert.equal(checked, 32);
});

test("a backend with no out-point watch refuses the Foray instead of playing whole episodes", () => {
  const r = realResolve();
  __resetInstanceForTests();
  const backend = new FakeBackend();
  backend.setOutPoint = undefined;
  const m = new PlayerQueueManager({ backend });
  assert.throws(
    () => m.setQueueFromForay(r.hydrated, { resolveItem: (id) => r.sources.get(id) ?? null }),
    /setOutPoint/
  );
});
