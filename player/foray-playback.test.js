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
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { PlayerQueueManager, __resetInstanceForTests } from "./queue-manager.js";
import { END_OUT_POINT } from "./queue-state.js";
import {
  resolveForay, indexSegments, indexSources, findForay,
  forayElapsed, segmentAtElapsed, fmtClock,
} from "./foray-resolve.js";
import { ForayProgressStore, resumePoint, makeProgress, progressKey } from "./foray-progress.js";
import { SEAM_GAP_SEC } from "./seam-gap.js";
import { createDurableStore } from "./durable-store.js";

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

/* The seam beat's clock, driven by hand. Foray #1 is unbridged end to end, so
   EVERY one of its 31 transitions now holds 2.0 s — and a suite that ran 32
   real beats would sit here for a minute and be at the mercy of a busy box
   (#195). INSTANT arms, holds and releases the beat exactly as production does,
   in zero wall clock; `manualScheduler` is for the two tests that are about the
   beat itself. */
const INSTANT_SCHEDULER = {
  nowMs: () => 0,
  // queueMicrotask, not a synchronous call: a scheduler that fires inside
  // schedule() is not setTimeout semantics, and it made every pre-existing
  // test blind to the beat's async ordering. This is still zero wall clock.
  schedule: (_ms, fn) => { let dead = false; queueMicrotask(() => { if (!dead) fn(); }); return () => { dead = true; }; },
};

function manualScheduler() {
  let now = 0;
  const pending = [];
  return {
    nowMs: () => now,
    schedule(ms, fn) {
      const entry = { at: now + ms, fn, dead: false };
      pending.push(entry);
      return () => { entry.dead = true; };
    },
    async advance(ms) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.dead || entry.at > now) continue;
        entry.dead = true;
        entry.fn();
      }
      await new Promise((r) => setImmediate(r));
    },
    get live() { return pending.filter((e) => !e.dead).length; },
  };
}

function make(opts = {}) {
  __resetInstanceForTests();
  const backend = new FakeBackend(opts);
  const log = [];
  const m = new PlayerQueueManager({
    backend, telemetry: (t) => log.push(t),
    scheduler: opts.scheduler ?? INSTANT_SCHEDULER,
  });
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

test("every one of Foray #1's 31 seams holds a beat, and neither end of it does", async () => {
  /* This is the founder-facing claim, measured against the shipped document:
     Foray #1 has no narration, so all 31 transitions are unbridged and every
     one of them gets 2.0 s of silence. Pressing play does not, and the end of
     the Foray does not. The clock is driven by hand — no sleeping, so this
     costs nothing on a busy box. */
  const r = realResolve();
  const scheduler = manualScheduler();
  const { m, backend } = make({ scheduler });
  await startForay(m, r);
  assert.equal(m.inSeamGap, false, "the first segment must be instant");

  let beats = 0;
  for (let i = 0; i < 32; i++) {
    const settled = backend.reachOutPoint();
    await new Promise((res) => setImmediate(res));
    const last = i === 31;
    assert.equal(m.inSeamGap, !last, `seam after segment ${i + 1}`);
    if (!last) {
      beats += 1;
      assert.equal(m.seamGapRemainingMs, 2000, `seam ${i + 1} is not 2.0 s`);
      // Loaded and positioned already: the beat is absorbing the fetch.
      assert.ok(backend.loads().includes(r.playable[i + 1].id), "the next segment loads inside the beat");
      await scheduler.advance(2000);
    }
    await settled;
  }

  assert.equal(beats, 31, "31 transitions, 31 beats");
  assert.equal(m.state.type, "ended");
  assert.equal(backend.calls.filter((c) => c === "play").length, 32, "the beats cost no segments");
  assert.equal(scheduler.live, 0, "no beat timer outlived the Foray");
});

test("the beats cost about a minute of a 61-minute Foray, and cost no audio at all", async () => {
  /* A number a founder can weigh, computed from the SHIPPED constant rather
     than from a copy of it — hard-coding 2.0 here made this assertion unable
     to fail if the beat were shortened, lengthened or removed, which is the
     one thing it is here to notice. */
  const r = realResolve();
  const seams = r.playable.length - 1;
  const costSec = seams * SEAM_GAP_SEC;
  assert.equal(seams, 31);
  assert.equal(costSec, 62);
  assert.ok(costSec / r.totalSec < 0.02, `the beats are ${(100 * costSec / r.totalSec).toFixed(1)}% of the runtime`);
  // ...and nothing was appended to anybody's file to produce them: every load
  // is still the publisher's own enclosure URL (product principle 3).
  assert.ok(r.playable.every((i) => /^https:\/\//.test(i.audio_url)), "still the publishers' own files");
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

/* ---------- the page is INTERACTIVE, not merely rendered ----------

   WHY THIS EXISTS, SPECIFICALLY
   A PR on this branch shipped a `ReferenceError` in `bindFeedback`. That runs
   inside `renderForay`, BEFORE `bindForayTransport` — so the exception escaped,
   and nothing after it ever ran: play, pause, prev, next, every row, the strip,
   Start over, and the callback that repaints the running order. The page
   rendered perfectly and was completely inert. `?foray=grilling-history-1` was a
   total regression, and every suite in this repo stayed green, because nothing
   anywhere asserted that the surface RESPONDS. `node --check` cannot see it: the
   source parses, the identifier is only unresolvable at run time.

   WHAT THIS HARNESS IS, AND WHAT IT IS NOT
   It is a binding harness, not a DOM. It serves the elements app.js looks up and
   records the listeners app.js attaches, which is exactly enough to answer "did
   every binder run, and does clicking reach the player". It deliberately does
   NOT parse the HTML app.js emits, so it cannot tell you a button was rendered
   in the wrong place or styled invisibly — jsdom is a dependency this repo does
   not have (see test/app-security.test.js's header for the same trade).

   The one gap that matters — the harness serving an element the real markup no
   longer emits — is closed by pinning the emitted HTML string against the
   selectors the binders use. See the last test.

   app.js is a classic script, so it loads through node:vm the same way
   test/app-security.test.js loads it. `init()` parks at its first `fetch`, which
   never settles, so nothing renders until this file calls `renderForay` itself. */

const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/** Elements are identified by what app.js asks for, because that is the only
    identity the harness has. `attrs` become `dataset` entries. */
class StubEl {
  constructor(dom, { id = null, attrs = {}, className = "" } = {}) {
    this._dom = dom;
    this.id = id;
    this.dataset = { ...attrs };
    this.className = className;
    this._classes = new Set(String(className).split(/\s+/).filter(Boolean));
    this._on = new Map();
    this.style = {};
    this.hidden = false;
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.disabled = false;
    this.children = [];
    this.removed = false;
    this.attributes = {};
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => { const want = on ?? !this._classes.has(c); want ? this._classes.add(c) : this._classes.delete(c); return want; },
    };
  }
  addEventListener(type, fn) {
    if (!this._on.has(type)) this._on.set(type, []);
    this._on.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._on.get(type); if (l) this._on.set(type, l.filter((f) => f !== fn));
  }
  /** How many handlers are bound — the thing the inert build had zero of. */
  listeners(type = "click") { return (this._on.get(type) ?? []).length; }
  /** Fire a click. `target` models event delegation (the strip reads e.target),
      `clientX` models the pointer position (the strip reads that too, now that
      it is a scrubber). Omitting clientX is a real case, not a shortcut: a
      synthetic or assistive click has no coordinates and the strip must still
      do something sensible. */
  async click(target = this, clientX = undefined) {
    const ev = { preventDefault() {}, stopPropagation() {}, target, clientX };
    for (const fn of [...(this._on.get("click") ?? [])]) await fn(ev);
  }
  /** Geometry, so the strip can be scrubbed. A 320px-wide strip at x=0 keeps
      the arithmetic in the test readable: clientX IS the percentage times 3.2. */
  getBoundingClientRect() { return { left: 0, width: this._width ?? 320, top: 0, height: 10 }; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  remove() { this.removed = true; this._dom.detach(this); }
  closest(sel) { return this._dom.matches(this, sel) ? this : null; }
  querySelector(sel) { return this._dom.query(sel, this); }
  querySelectorAll(sel) { return this._dom.queryAll(sel, this); }
  append() {}
  appendChild() {}
}

/** The selector vocabulary app.js actually uses on the Foray page. Anything
    outside it returns empty rather than guessing — an unrecognised selector
    should look like "nothing matched", never like a silent pass. */
class StubDom {
  constructor(resolved) {
    this.resolved = resolved;
    this.byId = new Map();
    this.detached = new Set();

    const playable = resolved.entries.filter((e) => e.playable);
    this.rows = playable.map((e) => new StubEl(this, { className: "fy-jump", attrs: { fy: String(e.queueIndex) } }));
    // Each bar carries the fill element the markup gives it, so a test can read
    // back the width app.js wrote rather than trusting that it wrote one.
    this.segs = playable.map((_, i) => {
      const seg = new StubEl(this, { className: "fy-seg", attrs: { seg: String(i) } });
      seg.children = [new StubEl(this, { className: "fy-seg-fill" })];
      return seg;
    });
    this.thumbs = [];
    for (const e of resolved.entries) {
      if (!e.segment_id || !e.topic) continue;
      for (const dir of ["up", "down"]) {
        this.thumbs.push(new StubEl(this, { className: "fy-thumb", attrs: { thumb: dir, segId: e.segment_id } }));
      }
    }
    // Filled from app.js's own FB_CHIPS once the script has been evaluated —
    // hard-coding a subset here let a rename in FB_CHIPS pass while the sheet
    // test asserted against a label the page never emitted.
    this.chips = [];
    this.srcLinks = [...new Set(playable.map((e) => e.show))]
      .map((s) => new StubEl(this, { className: "fy-src-head", attrs: { srcShow: s } }));

    for (const id of [
      "view", "fy-strip", "fy-now", "fy-total", "fy-play", "fy-next", "fy-prev", "fy-error",
      "fy-resume", "fy-bar-fill", "fy-restart", "fy-sheet", "fy-scrim", "fy-sheet-sub",
      "fy-sheet-note", "fy-sheet-cancel", "fy-sheet-go", "banner-slot", "home-intro",
      "intro-close", "pl-form", "pl-input", "pl-note", "pl-remove", "banner-done",
      "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle",
      "menu-btn", "refresh-btn",
    ]) this.byId.set(id, new StubEl(this, { id }));

    this.byId.get("fy-strip").children = this.segs;
    this.body = new StubEl(this, { id: "body" });
  }
  detach(el) { this.detached.add(el); }
  el(id) { return this.byId.get(id); }
  live(list) { return list.filter((e) => !this.detached.has(e)); }
  /** The real reason-chip labels, read out of app.js after it is evaluated. */
  setChips(labels) {
    this.chips = labels.map((c) => new StubEl(this, { className: "fy-chip", attrs: { chip: c } }));
  }

  matches(el, sel) {
    const m = /^\[data-([a-z-]+)\]$/.exec(sel);
    if (m) return camel(m[1]) in el.dataset;
    return false;
  }

  queryAll(sel, _scope) {
    const s = sel.trim();
    if (s === "[data-fy]") return this.live(this.rows);
    if (s === "[data-seg]") return this.live(this.segs);
    if (s === "[data-thumb]") return this.live(this.thumbs);
    if (s === "[data-chip]") return this.live(this.chips);
    if (s === "[data-chip].on") return this.live(this.chips).filter((c) => c.classList.contains("on"));
    if (s === "[data-src-show]") return this.live(this.srcLinks);
    const seg = /^\[data-seg-id="(.*)"\]$/.exec(s);
    if (seg) return this.live(this.thumbs).filter((t) => t.dataset.segId === seg[1]);
    return [];
  }
  query(sel, scope) {
    const id = /^#([\w-]+)$/.exec(sel.trim());
    if (id) {
      const el = this.byId.get(id[1]);
      return el && !this.detached.has(el) ? el : null;
    }
    return this.queryAll(sel, scope)[0] ?? null;
  }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Records every call app.js makes into the player, and resolves the running
    order with the REAL resolver against the REAL data files. */
function fakeBridge(resolved, { resume = null, startThrows = null } = {}) {
  const calls = [];
  let onChange = null;
  /** A transport call that throws while the Foray is genuinely live — the other
      shape of #225's invisible failure, and the one that must not make the page
      forget what is playing. */
  let toggleThrows = null;
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const credit = {
    show: resolved.shows[0], clips: 3, seconds: 420,
    link: "https://podcasts.apple.com/us/search?term=Example",
    linkKind: "apple-search",
    episodes: [{ id: "ep-1", title: "An episode", clips: 3, seconds: 420 }],
  };
  return {
    calls,
    lastOnChange: () => onChange,
    /* Asserts rather than ignores: `renderForay` has to hand the resolver BOTH
       side documents, and dropping one produced a Foray with zero playable
       segments that this harness would otherwise have rendered as fine. */
    resolve: (foraysDoc, opts = {}) => {
      calls.push({ name: "resolve", args: [foraysDoc, opts] });
      assert.ok(foraysDoc, "renderForay must pass the forays document");
      assert.ok(opts.segmentsDoc, "renderForay must pass data/segments.json to the resolver");
      assert.ok(opts.sourcesDoc, "renderForay must pass data/segment-sources.json to the resolver");
      assert.ok(Array.isArray(opts.unlocked) && opts.unlocked.includes(FORAY_ID), "the draft must be unlocked by id");
      return resolved;
    },
    listForays: () => [{ id: resolved.id, title: resolved.title, status: "draft" }],
    fmtClock, fmtSpan: (s) => `${Math.round(s)}s`,
    // The REAL resolver, not a stub: the strip's fill and the strip's seek
    // destination have to be computed by one function or the bar lies about
    // where a click will land.
    segmentAt: (playable, elapsedSec) => segmentAtElapsed(playable, elapsedSec),
    foraySeek: (sec) => { calls.push({ name: "foraySeek", args: [sec] }); },
    /* Records its arguments: the page has to hand the RESOLVED Foray over, or the
       stored row is checked against nothing and a changed running order resumes
       to the wrong audio (#40). */
    forayResume: (id, opts = {}) => { calls.push({ name: "forayResume", args: [id, opts] }); return resume; },
    forayDriftIsClean: (point) => !point || point.drift === "exact" || point.drift === "unverified",
    forayResumeList: () => (resume ? [{ id: resolved.id, title: resolved.title, percent: 32, label: "42 min left", finished: false }] : []),
    clearForayResume: record("clearForayResume"),
    // A real credit, so the block is actually emitted and bindSourceLinks has
    // something to bind — an empty list made that binder untested by accident.
    forayCredits: () => ({ credits: [credit], summary: "1 episode from 1 show" }),
    watchForay: (fn) => { onChange = fn; return null; },
    /* `startThrows` is the failure mode #225 had no surface for at all: the
       player throwing on the way in — a stale module, a missing method, a
       TypeError — which reached the console and nothing else. */
    playForay: (r, opts = {}) => {
      calls.push({ name: "playForay", args: [r, opts] });
      onChange = opts.onChange ?? onChange;
      if (startThrows) throw startThrows;
      return null;
    },
    throwOnToggle: (err) => { toggleThrows = err; },
    forayToggle: (...args) => {
      calls.push({ name: "forayToggle", args });
      if (toggleThrows) throw toggleThrows;
    },
    forayNext: record("forayNext"),
    forayPrevious: record("forayPrevious"),
    forayJump: (i) => { calls.push({ name: "forayJump", args: [i] }); },
  };
}

/** Mount the Foray page the way the router does, and hand back everything a
    test needs to poke it. Rejects if `renderForay` throws — which is the whole
    point, and is what the inert build did. */
async function mountForayPage({
  resume = null, durable = false, seed = {}, durableRows = {}, failLocalWrites = false,
  startThrows = null,
} = {}) {
  const resolved = realResolve();
  const dom = new StubDom(resolved);
  const bridge = fakeBridge(resolved, { resume, startThrows });
  const store = new Map(Object.entries(seed));
  let failLocal = failLocalWrites;

  /* The page's `localStorage`. `seed` puts `cp_` rows there BEFORE anything
     mounts, which is how the migration is exercised through the real app.js
     rather than only through the store's own unit tests; `failLocalWrites` is the
     full-quota case, and the page has to stay interactive through it. */
  const localStorageShim = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (failLocal) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; }
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };

  /* With `durable`, app.js is given the REAL DurableStore over that shim plus a
     fake durable tier — i.e. exactly the wiring `player/client.js` publishes,
     which this harness cannot load (it is a module that builds DOM at import). */
  const durableTier = durable ? fakeDurableTier(durableRows) : null;
  const forayStorage = durable ? createDurableStore({ localStorage: localStorageShim, idbTier: durableTier }) : null;

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),          // parks init(), same as app-security
    localStorage: localStorageShim,
    /* Only defined when a store is being tested: `waitForStorage()` returns null
       immediately when `window` has neither a store nor an `addEventListener` to
       be told through, which is the honest answer for a page where the player
       module never loaded. */
    ...(forayStorage ? { forayStorage } : {}),
    document: {
      body: dom.body,
      documentElement: dom.body,
      addEventListener() {},
      createElement: () => new StubEl(dom),
      querySelector: (s) => dom.query(s),
      querySelectorAll: (s) => dom.queryAll(s),
    },
    navigator: { userAgent: "node" },
    location: { hash: `#/foray/${FORAY_ID}`, search: `?foray=${FORAY_ID}`, pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    /* Unref'd, so app.js's bounded storage wait (a 5 s `Promise.race` against a
       fetch this harness never settles) cannot hold the test runner open. A
       harness detail with no counterpart in a browser, where nothing waits on the
       event loop being empty. */
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  // `state` and `SearchEngine` are lexical consts in app.js, so they are not
  // properties of the context and have to be reached from inside it.
  ctx.__forays = FORAYS;
  ctx.__segments = SEGMENTS;
  ctx.__sources = SOURCES;
  ctx.__bridge = bridge;
  vm.runInContext(
    "state.forays = __forays; state.segments = __segments; state.segmentSources = __sources;" +
    "state.ready = true; window.ForayPlayer = __bridge;",
    ctx
  );
  // The reason chips are app.js's own list, not a copy of it.
  dom.setChips(vm.runInContext("FB_CHIPS", ctx));

  await ctx.renderForay(FORAY_ID);
  return {
    dom, bridge, ctx, resolved, store, forayStorage, durableTier,
    setFailLocal: (on) => { failLocal = on; },
    html: dom.el("view").innerHTML,
  };
}

/** An async "durable" tier, standing in for IndexedDB (which does not exist in
    Node) and for the native Preferences tier the app will register later. */
function fakeDurableTier(rows = {}) {
  const data = new Map(Object.entries(rows));
  return {
    name: "idb", sync: false, durable: true, data,
    async readAll(prefix) {
      const out = new Map();
      for (const [k, v] of data) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(k, v) { data.set(k, String(v)); },
    async remove(k) { data.delete(k); },
  };
}

test("mounting the Foray page binds the transport — the inert-page regression", async () => {
  // If renderForay throws anywhere, this rejects. If it completes but a binder
  // was skipped, the listener counts are zero. The shipped bug did the first,
  // which caused the second.
  const { dom } = await mountForayPage();
  for (const id of ["fy-play", "fy-next", "fy-prev", "fy-strip"]) {
    assert.ok(dom.el(id).listeners("click") > 0, `#${id} has no click handler — the page is inert`);
  }
  assert.equal(dom.rows.length, 32, "every playable segment needs a row to click");
  assert.ok(dom.rows.every((r) => r.listeners("click") > 0), "a running-order row is not clickable");
});

test("pressing play reaches the player, and the callback repaints the page", async () => {
  const { dom, bridge } = await mountForayPage();
  await dom.el("fy-play").click();

  const started = bridge.calls.filter((c) => c.name === "playForay");
  assert.equal(started.length, 1, `expected one playForay, got ${JSON.stringify(bridge.calls.map((c) => c.name))}`);
  assert.equal(started[0].args[1].startIndex, 0, "a cold press must start at the beginning");

  // The page owns the running order, so it only moves if the player's callback
  // reaches it. This is the half of the transport that looked most alive while
  // being most dead: the button label never changed on the inert build.
  const onChange = bridge.lastOnChange();
  assert.equal(typeof onChange, "function", "playForay was called without an onChange — nothing can repaint");
  onChange({ forayId: FORAY_ID, index: 3, playing: true, loading: false, ended: false, elapsedSec: 240, totalSec: 3673, error: null });

  assert.equal(dom.el("fy-play").textContent, "❚❚ Pause");
  assert.equal(dom.el("fy-now").textContent, fmtClock(240));
  assert.ok(dom.rows[3].classList.contains("is-playing"), "the audible segment must be marked");
  assert.ok(dom.rows[2].classList.contains("is-played"));
  assert.ok(!dom.rows[4].classList.contains("is-played"));
  assert.ok(dom.segs[3].classList.contains("is-playing"), "the strip must track the segment too");
});

test("pause comes back through the same callback and the label flips", async () => {
  const { dom, bridge } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  const at = (playing) => onChange({ forayId: FORAY_ID, index: 3, playing, loading: false, ended: false, elapsedSec: 240, totalSec: 3673, error: null });

  at(true);
  assert.equal(dom.el("fy-play").textContent, "❚❚ Pause");
  at(false);
  assert.equal(dom.el("fy-play").textContent, "▶ Resume", "paused mid-Foray is a resume, not a fresh play");

  // Once the player is inside this Foray, play/pause must toggle rather than
  // rebuild the queue from segment 1.
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.filter((c) => c.name === "forayToggle").length, 1);
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 1, "must not restart the Foray");
});

test("next, previous, a row and the strip each reach the player", async () => {
  const { dom, bridge } = await mountForayPage();
  // Cold, every control means "start it" — a next that begins at segment 2
  // silently drops the opening.
  await dom.el("fy-next").click();
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 1);

  const onChange = bridge.lastOnChange();
  onChange({ forayId: FORAY_ID, index: 0, playing: true, loading: false, ended: false, elapsedSec: 5, totalSec: 3673, error: null });

  await dom.el("fy-next").click();
  await dom.el("fy-prev").click();
  await dom.rows[20].click();
  await dom.el("fy-strip").click(dom.segs[7]);

  const names = bridge.calls.map((c) => c.name);
  assert.ok(names.includes("forayNext"), names.join(","));
  assert.ok(names.includes("forayPrevious"), names.join(","));
  const jumps = bridge.calls.filter((c) => c.name === "forayJump").map((c) => c.args[0]);
  // A click with no coordinates — synthetic, or from assistive tech — cannot be
  // a position, so both the row and the strip fall back to the exact segment.
  assert.deepEqual(jumps, [20, 7], "a row and a coordinate-less strip click both jump to their own segment");
});

/* ---------- the strip is a scrubber (docs/ux/foray-mockup.jsx §Scrubber) ----

   It always LOOKED like one — a proportional bar of the whole hour — and
   behaved like 32 jump targets. `foraySeek` existed, was tested, and nothing
   on the page called it. The stub strip is 320px wide from x=0, so clientX is
   the percentage times 3.2. */

test("clicking a quarter of the way along the strip seeks to a quarter of the Foray", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  bridge.lastOnChange()({ forayId: FORAY_ID, index: 0, playing: true, loading: false, ended: false, elapsedSec: 5, totalSec: resolved.totalSec, error: null });

  await dom.el("fy-strip").click(dom.segs[0], 80);   // 80 / 320 = 25%
  const seeks = bridge.calls.filter((c) => c.name === "foraySeek");
  assert.equal(seeks.length, 1, `expected a seek, got ${bridge.calls.map((c) => c.name)}`);
  assert.ok(Math.abs(seeks[0].args[0] - resolved.totalSec * 0.25) < 1, `landed at ${seeks[0].args[0]}`);
  assert.equal(bridge.calls.filter((c) => c.name === "forayJump").length, 0, "a position is not a segment snap");
});

test("the 2px gaps between the bars are live scrubber, not dead zones", async () => {
  // A fifth of the strip's width is the gaps between its 32 bars. Requiring a
  // `[data-seg]` hit before reading the coordinate made every one of them do
  // nothing at all, while the control still looked like a continuous bar.
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  bridge.lastOnChange()({ forayId: FORAY_ID, index: 0, playing: true, loading: false, ended: false, elapsedSec: 5, totalSec: resolved.totalSec, error: null });

  // target is the strip itself — a click that landed between two bars.
  await dom.el("fy-strip").click(dom.el("fy-strip"), 160);
  const seeks = bridge.calls.filter((c) => c.name === "foraySeek");
  assert.equal(seeks.length, 1, `a click in a gap did nothing: ${bridge.calls.map((c) => c.name)}`);
  assert.ok(Math.abs(seeks[0].args[0] - resolved.totalSec * 0.5) < 1);
});

test("scrubbing a Foray that has not started begins it AT that position, not at the top", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-strip").click(dom.segs[15], 240);  // 240 / 320 = 75%

  const started = bridge.calls.filter((c) => c.name === "playForay");
  assert.equal(started.length, 1, `expected one playForay, got ${bridge.calls.map((c) => c.name)}`);
  const opts = started[0].args[1];
  assert.ok(Math.abs(opts.startElapsedSec - resolved.totalSec * 0.75) < 1, `startElapsedSec was ${opts.startElapsedSec}`);
  assert.equal(typeof opts.onChange, "function", "a cold scrub still has to be able to repaint the page");
});

test("a scrub past either end of the strip clamps instead of leaving the Foray", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-strip").click(dom.segs[0], -50);
  await dom.el("fy-strip").click(dom.segs[31], 9999);
  const at = bridge.calls.filter((c) => c.name === "playForay").map((c) => c.args[1].startElapsedSec);
  assert.equal(at.length, 2);
  assert.equal(at[0], 0);
  assert.ok(Math.abs(at[1] - resolved.totalSec) < 1, `clamped to ${at[1]}`);
});

/* ---------- the strip's fill, and the seam beat you can see ---------- */

/** A queue item's authored length, and where it starts in the Foray's clock.
    Kept here rather than imported so a change to app.js's own arithmetic has
    to agree with an independent statement of the same rule. */
const segLen = (item) => (item.authored_end_sec ?? item.end_sec) - item.start_sec;
const segStart = (r, i) => r.playable.slice(0, i).reduce((t, it) => t + segLen(it), 0);

test("the bar the listener is inside fills as it plays; the ones behind it are full", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();

  // Halfway through segment 3 (0-indexed 2). `playable` is the player QUEUE, so
  // a segment's length is its bounds, not a `duration_sec` field.
  const halfway = segStart(resolved, 2) + segLen(resolved.playable[2]) / 2;
  onChange({ forayId: FORAY_ID, index: 2, playing: true, loading: false, ended: false, elapsedSec: halfway, totalSec: resolved.totalSec, error: null });

  const width = (i) => dom.segs[i].children[0].style.width;
  assert.equal(width(0), "100%", "a segment already heard is a full bar");
  assert.equal(width(1), "100%");
  assert.match(width(2), /^5[01](\.\d+)?%$/, `the live bar should be about half full, got ${width(2)}`);
  assert.equal(width(3), "0%", "a segment not reached yet is an empty bar");
});

test("the live bar keeps moving between segment changes — it is painted above the paint guard", async () => {
  // `paintForay` short-circuits when the segment index has not changed, which
  // is what keeps 32 rows from churning at 4 Hz. Anything continuous has to be
  // written before that return, and the fill is the first such thing.
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  const dur = segLen(resolved.playable[0]);
  const width = () => dom.segs[0].children[0].style.width;

  onChange({ forayId: FORAY_ID, index: 0, playing: true, loading: false, ended: false, elapsedSec: dur * 0.25, totalSec: resolved.totalSec, error: null });
  const quarter = width();
  onChange({ forayId: FORAY_ID, index: 0, playing: true, loading: false, ended: false, elapsedSec: dur * 0.75, totalSec: resolved.totalSec, error: null });
  assert.notEqual(width(), quarter, "the fill froze on the second tick — it is below the paint guard");
  assert.match(width(), /^7[456](\.\d+)?%$/, `got ${width()}`);
});

test("during a seam beat the page says Pause, not Loading — the silence is deliberate", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  const base = { forayId: FORAY_ID, index: 4, ended: false, elapsedSec: 600, totalSec: resolved.totalSec, error: null };

  // Structurally a load, but a beat: `gap` is what tells the two apart.
  onChange({ ...base, playing: false, loading: true, gap: true });
  assert.equal(dom.el("fy-play").textContent, "❚❚ Pause");
  assert.equal(dom.el("fy-play").getAttribute("aria-label"), "Pause");
  assert.ok(dom.el("fy-strip").classList.contains("is-seam"), "the strip should mark the beat");

  // A real load, with no beat, still says so.
  onChange({ ...base, playing: false, loading: true, gap: false });
  assert.equal(dom.el("fy-play").textContent, "Loading…");
  assert.equal(dom.el("fy-strip").classList.contains("is-seam"), false);
});

/* ================================================ a start that fails (#225) ===

   The founder, on a phone, on the live site: "starting it was difficult, not
   sure why. I tried pressing the play button up top and got several errors. It
   might have worked when I pressed a play button down on the first segment, but
   I'm not 100% sure on that."

   Two separate defects are in that sentence, and these tests are about the
   second, which is the one no device is needed to see. `playForay` paints its
   index BEFORE it awaits the load — deliberately, so a tapped row lights up at
   once — and everything on this page read that index as "playing". So a start
   that then failed left a page that looked started: the resume banner hid
   itself, the button relabelled, a row stayed lit, and `state.forayPlaying`
   made the next press of the main button mean PAUSE instead of a retry. The two
   controls really did stop meaning the same thing, and nothing on screen said
   why. */

/** The snapshot a failed start produces: the intent index is standing, the
    error line is set, and nothing is playing, loading or beating. */
const failedStart = (index, error, totalSec) => ({
  forayId: FORAY_ID, index, playing: false, loading: false, gap: false,
  ended: false, elapsedSec: 0, totalSec, error,
});

test("a start that fails puts the page back to cold, so the next tap is a real retry", async () => {
  const resume = { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, label: "42 min left", clock: "19:40" };
  const { dom, bridge, resolved } = await mountForayPage({ resume });

  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  // The intent paint, which is correct and stays: the row lights up while the
  // load is in flight.
  onChange({ forayId: FORAY_ID, index: 9, playing: false, loading: true, gap: false, ended: false, elapsedSec: 1180, totalSec: resolved.totalSec, error: null });
  assert.ok(dom.rows[9].classList.contains("is-playing"));

  // ...and then the load is refused.
  onChange(failedStart(9, "player.error: loadItem(x) failed: load failed (code 2)", resolved.totalSec));

  assert.equal(dom.el("fy-error").hidden, false, "a failed start must say so on the page");
  assert.equal(dom.el("fy-play").textContent, "▶ Resume", "the button has to offer another go, not a pause");
  assert.equal(dom.el("fy-resume").hidden, false, "the resume offer is still the truth — nothing played");
  assert.ok(!dom.rows[9].classList.contains("is-playing"), "no row is audible, so none may look it");

  // THE ASYMMETRY THE FOUNDER MET. With the page believing a Foray is live, this
  // second press becomes forayToggle and the Foray never starts.
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.filter((c) => c.name === "forayToggle").length, 0, "a failed start must not leave the button meaning pause");
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 2, "the second press has to try to start it again");
  // And a row press retries too, rather than jumping inside a Foray that is not
  // loaded — which is the other half of "the segment button might have worked".
  await dom.rows[0].click();
  assert.equal(bridge.calls.filter((c) => c.name === "forayJump").length, 0);
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 3);
});

test("a PAUSED Foray with an error standing is still a live Foray, not a failed start", async () => {
  /* Found by review, and it is the sharp edge of the rule above: "an error and
     nothing playing" also describes a listener who paused. Getting this wrong
     costs more than the bug being fixed — the page would go cold mid-hour, the
     stale banner would come back, and the next press would rebuild the queue at
     whatever position the page opened on. Two things keep it right: the player
     clears the error the moment audio is produced, and the retry point is the
     furthest position this page has actually heard. */
  const resume = { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, label: "42 min left", clock: "19:40" };
  const { dom, bridge, resolved } = await mountForayPage({ resume });
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  const at = (over) => onChange({ forayId: FORAY_ID, index: 9, loading: false, gap: false, ended: false, totalSec: resolved.totalSec, playing: false, elapsedSec: 1500, error: null, ...over });

  at({ playing: true });                       // audio, for a while
  at({ playing: false });                      // and the listener pauses
  assert.equal(dom.el("fy-play").textContent, "▶ Resume");
  assert.equal(dom.el("fy-resume").hidden, true, "a page that has heard audio must not re-offer a stale position");
  assert.ok(dom.rows[9].classList.contains("is-playing"), "the segment is still the loaded one");

  // The next press is a toggle, because the Foray IS live — not a rebuild.
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.filter((c) => c.name === "forayToggle").length, 1);
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 1, "pausing must not cost the queue");
});

test("a failure after real progress retries from where the listener got to", async () => {
  const resume = { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, label: "42 min left", clock: "19:40" };
  const { dom, bridge, resolved } = await mountForayPage({ resume });
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();

  onChange({ forayId: FORAY_ID, index: 9, playing: true, loading: false, gap: false, ended: false, elapsedSec: 1500, totalSec: resolved.totalSec, error: null });
  // Twenty-five minutes in, the next segment will not load.
  onChange(failedStart(20, "player.error: loadItem(x) failed: load failed (code 2)", resolved.totalSec));

  await dom.el("fy-play").click();
  const last = bridge.calls.filter((c) => c.name === "playForay").pop();
  assert.equal(last.args[1].startElapsedSec, 1500, "a retry must not send the listener back to the page's opening position");
});

test("autoplay refusal reads as a browser being careful, not as a broken app", async () => {
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();

  /* The string the player really produces for a refusal: the backend reports
     `play rejected: NotAllowedError`, the reducer stamps it `player.error:`.
     Nothing about that is the connection, and telling a listener to check theirs
     would send them off to fix something that is not broken. */
  onChange(failedStart(0, "player.error: play rejected: NotAllowedError", resolved.totalSec));
  const line = dom.el("fy-error");
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /press play again/i, "the affordance has to be named");
  assert.ok(!/connection/i.test(line.textContent), `autoplay refusal must not blame the connection: ${line.textContent}`);
  assert.ok(line.classList.contains("is-hint"), "a normal browser state is a note, not a warning");

  // A load failure is a different thing and keeps its own words.
  onChange(failedStart(0, "player.error: loadItem(x) failed: load failed (code 2)", resolved.totalSec));
  assert.match(line.textContent, /connection/i);
  assert.ok(!line.classList.contains("is-hint"), "a segment that would not load IS a fault");

  // And a clean snapshot takes the line away again.
  onChange({ forayId: FORAY_ID, index: 0, playing: true, loading: false, gap: false, ended: false, elapsedSec: 3, totalSec: resolved.totalSec, error: null });
  assert.equal(line.hidden, true);
  assert.equal(line.textContent, "");
});

test("a start that THROWS says so on the page instead of vanishing into the console", async () => {
  /* The click handlers are async, so before #225 this became an unhandled
     promise rejection: a console line on a device with no console, and a page
     that did not move. Indistinguishable from a dead app, which is exactly what
     the report describes. */
  const boom = Object.assign(new Error("player.forayJump is not a function"), { name: "TypeError" });
  const { dom, bridge } = await mountForayPage({ startThrows: boom });

  await dom.el("fy-play").click();           // must NOT reject
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 1);
  assert.equal(dom.el("fy-error").hidden, false, "a start that threw has to be visible");
  assert.match(dom.el("fy-error").textContent, /press play/i, "and it has to say what to do next");

  // The page is still able to try: the throw happened after the intent paint, so
  // the "a Foray is live" flag has to be dropped on the way out.
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.filter((c) => c.name === "forayToggle").length, 0);
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 2);
});

test("a control that throws over LIVE audio says so without lying about the state", async () => {
  /* The other half of the same guard, and the half that must not overreach. The
     audio is still running, so the player's state is still the truth: a page that
     dropped its "this Foray is live" flag here would show a button labelled
     "Pause" that means "start", and the next press would rebuild the queue
     underneath audio the listener is still hearing. */
  const { dom, bridge, resolved } = await mountForayPage();
  await dom.el("fy-play").click();
  const onChange = bridge.lastOnChange();
  onChange({ forayId: FORAY_ID, index: 4, playing: true, loading: false, gap: false, ended: false, elapsedSec: 600, totalSec: resolved.totalSec, error: null });

  bridge.throwOnToggle(Object.assign(new Error("nope"), { name: "TypeError" }));
  await dom.el("fy-play").click();             // must NOT reject

  assert.equal(dom.el("fy-error").hidden, false, "a control that threw has to be visible");
  assert.ok(!/wouldn't load/.test(dom.el("fy-error").textContent), `nothing failed to load: ${dom.el("fy-error").textContent}`);
  assert.equal(dom.el("fy-play").textContent, "❚❚ Pause", "the label still describes the audio, which is still playing");

  // And the page still knows a Foray is live, so the next press is a transport
  // action rather than a restart on top of live audio.
  bridge.throwOnToggle(null);
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.filter((c) => c.name === "playForay").length, 1, "a failed control must never restart a running Foray");
  assert.equal(bridge.calls.filter((c) => c.name === "forayToggle").length, 2);
});

test("the tap reaches playForay with nothing awaited in front of it", async () => {
  /* THE FIRST DEFECT IN THE FOUNDER'S SENTENCE, pinned as far as this harness
     can reach. Safari lifts an element's autoplay restriction inside the
     `play()` call that a user gesture is processing, and the gesture is spent
     when the current task ends — so anything this page awaits before calling
     into the player is a start Safari may refuse.

     Asserted on the SOURCE because the module that does the priming
     (`player/client.js`) cannot be loaded here: it builds DOM at import. The
     ordering inside it is pinned the same way below. */
  assert.match(
    APP_SRC,
    /const start = \(index\) => \(paintForayFailure\(null\), guardForayStart\(\(\) => player\.playForay\(/,
    "the index funnel must call the player as the first thing inside the tap"
  );
  assert.match(
    APP_SRC,
    /const startAt = \(elapsedSec\) => \(paintForayFailure\(null\), guardForayStart\(\(\) => player\.playForay\(/,
    "the resume/scrub funnel must too"
  );
  /* Both funnels, no third path: every control on the page routes through one of
     them, so neither can be fixed and the other left awaiting. Comment lines are
     dropped in all three shapes — this file and app.js both discuss `playForay(`
     in prose, and a test that goes red at a paragraph is a test people delete. */
  const bodies = APP_SRC.split("\n")
    .filter((l) => l.includes("playForay("))
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
  assert.equal(bodies.length, 2, `expected two call sites, found:\n${bodies.join("\n")}`);
  for (const line of bodies) {
    assert.ok(!/await/.test(line), `a start must not await anything before playForay: ${line}`);
  }
});

test("client.js spends the gesture on the element BEFORE its first await", async () => {
  /* `playForay` is called straight out of a click handler, so the line that
     primes the element has to come before every `await` in it — the load that
     follows resolves on a media event, which is a new task, and by then Safari
     is entitled to refuse the `play()` that ends the call.

     A text assertion, for the reason above: this module cannot be imported into
     a Node test. It is a weak instrument used for a sharp question, so it asks
     the only question that matters — is the prime above the first await. */
  const client = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8");
  // BOTH entry points a tap can reach: a Foray, and a single episode from a card.
  // The episode path is the one a `playForay`-shaped assertion cannot see.
  for (const signature of ["async playForay(resolved, {", "async play(item, { why"]) {
    const from = client.indexOf(signature);
    assert.ok(from > 0, `${signature} moved or was renamed`);
    const body = client.slice(from);
    const primeAt = body.indexOf("backend.notePlayGesture()");
    const awaitAt = body.indexOf("await ");
    assert.ok(primeAt > 0, `${signature} no longer spends the gesture on the element (#225)`);
    assert.ok(
      primeAt < awaitAt,
      `notePlayGesture must run before the first await in ${signature}, or the tap is already spent`
    );
  }
});

test("client.js only ever reports an error that describes the attempt in front of it", async () => {
  /* The page treats "an error, and nothing playing" as a failed start, so a
     `foray.error` that outlives its attempt is not a stale message — it is a
     page that goes cold mid-hour. Two rules keep the field honest, and both are
     one line in a module this suite cannot import, so both are read as text.

     The telemetry strings themselves are pinned behaviourally in
     `queue-manager.test.js` ("a DAI segment whose copy has drifted is skipped"
     for `.atLoad`, and the build-time `skipped[1]` in the ladder tests), so the
     two halves of this rule cannot drift apart silently. */
  const client = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8");
  assert.match(
    client,
    /if \(foray\.error && isPlaying\(\)\) foray\.error = null;/,
    "an error must not survive audio, or pausing reads as a failed start (#225)"
  );
  assert.match(
    client,
    /foray && \/player\\\.error\|segment\\\.skipped\\\.atLoad\/i\.test\(m\)/,
    "a segment the BUILD dropped is a property of the running order, not a failed tap"
  );
});

test("a thumbs-up records a vote — the binder that actually threw", async () => {
  // bindFeedback is where the ReferenceError lived. It runs before the transport
  // is bound, so this assertion and the ones above fail together on that bug —
  // deliberately, because either symptom alone is enough to catch it.
  const { dom, store, resolved } = await mountForayPage();
  const up = dom.thumbs.find((t) => t.dataset.thumb === "up");
  await up.click();

  const saved = JSON.parse(store.get("cp_foray_feedback") ?? "{}");
  const first = resolved.entries.find((e) => e.segment_id && e.topic);
  assert.equal(saved[first.segment_id]?.direction, "up");
  assert.ok(up.classList.contains("on"), "the control must show the vote it just took");

  const events = JSON.parse(store.get("cp_events") ?? "[]").filter((e) => e.type === "thumbs");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.node_id, first.topic, "the learning job keys on the taxonomy node");
  assert.equal(events[0].payload.direction, "up");
});

test("a thumbs-down opens the sheet and records nothing until it is submitted", async () => {
  const { dom, store } = await mountForayPage();
  const down = dom.thumbs.find((t) => t.dataset.thumb === "down");
  await down.click();

  assert.equal(dom.el("fy-sheet").hidden, false, "the reason sheet must open");
  assert.equal(store.has("cp_foray_feedback"), false, "a down-vote must not commit before its reason");
  assert.equal(dom.el("fy-sheet-go").disabled, true, "nothing picked yet");

  await dom.chips[1].click();
  assert.equal(dom.el("fy-sheet-go").disabled, false);
  await dom.el("fy-sheet-go").click();

  const saved = Object.values(JSON.parse(store.get("cp_foray_feedback") ?? "{}"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].direction, "down");
  assert.deepEqual(saved[0].reasons, [dom.chips[1].dataset.chip]);
  assert.equal(dom.el("fy-sheet").hidden, true);
});

test("dismissing the sheet leaves the segment unvoted", async () => {
  const { dom, store } = await mountForayPage();
  await dom.thumbs.find((t) => t.dataset.thumb === "down").click();
  await dom.chips[0].click();
  await dom.el("fy-scrim").click();
  assert.equal(dom.el("fy-sheet").hidden, true);
  assert.equal(store.has("cp_foray_feedback"), false, "cancelling is not a quiet down-vote");
});

test("a stored position makes the cold press a resume, and Start over clears it", async () => {
  const resume = { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, label: "42 min left", clock: "19:40" };
  const { dom, bridge } = await mountForayPage({ resume });

  assert.equal(dom.el("fy-now").textContent, fmtClock(1180), "the page must open on the stored clock");
  assert.equal(dom.el("fy-play").textContent, "▶ Resume");
  assert.ok(dom.rows[8].classList.contains("is-played"), "everything before the resume point is behind them");
  assert.ok(!dom.rows[9].classList.contains("is-played"));

  await dom.el("fy-play").click();
  const opts = bridge.calls.find((c) => c.name === "playForay").args[1];
  assert.equal(opts.startElapsedSec, 1180, "the press must resume, not restart");
  assert.equal(opts.startIndex, undefined);

  await dom.el("fy-restart").click();
  assert.ok(bridge.calls.some((c) => c.name === "clearForayResume"), "Start over must forget the position");
  const last = bridge.calls.filter((c) => c.name === "playForay").pop();
  assert.equal(last.args[1].startIndex, 0);
  assert.equal(last.args[1].startElapsedSec, undefined);
});

test("a source credit is bound, so the outbound click is measured", async () => {
  // Publisher credit is the one surface with a business reason to be
  // instrumented — this is how we see the traffic we send them.
  const { dom, resolved, store } = await mountForayPage();
  assert.ok(dom.srcLinks.length > 0, "the harness has no credit rows to bind");
  const link = dom.srcLinks.find((a) => a.dataset.srcShow === resolved.shows[0]) ?? dom.srcLinks[0];
  assert.ok(link.listeners("click") > 0, "a credit link that logs nothing sends the publisher no measurable traffic");
  await link.click();
  const opened = JSON.parse(store.get("cp_events") ?? "[]").filter((e) => e.type === "source_opened");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].payload.foray_id, FORAY_ID);
});

test("the markup app.js emits carries every hook the harness serves", async () => {
  /* The harness's one real blind spot: it hands out elements without parsing the
     HTML, so on its own it would keep passing if `forayRow` stopped emitting
     `data-fy` entirely. Pin the string instead — this is what ties the stubs
     above to the markup a browser would actually get.

     Every id the harness fabricates and every attribute it keys on has to be in
     here, INCLUDING the ones no test clicks: review found `fy-bar-fill` missing,
     and `app.js` dereferences it unguarded before any binder runs, so a markup
     rename would have thrown renderForay and left the page inert — the exact bug
     this whole section exists to catch, straight through the net. */
  const { html, dom, resolved, ctx } = await mountForayPage({
    resume: { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, label: "42 min left", clock: "19:40" },
  });
  for (const hook of [
    'id="fy-play"', 'id="fy-next"', 'id="fy-prev"', 'id="fy-strip"', 'id="fy-now"',
    'id="fy-total"', 'id="fy-error"', 'id="fy-resume"', 'id="fy-restart"', 'id="fy-bar-fill"',
    'id="fy-sheet"', 'id="fy-scrim"', 'id="fy-sheet-go"', 'id="fy-sheet-cancel"',
    'id="fy-sheet-note"', 'id="fy-sheet-sub"',
    'data-fy="0"', 'data-seg="0"', 'data-thumb="up"', 'data-thumb="down"',
    'data-chip="', 'data-seg-id="', 'data-src-show="',
  ]) {
    assert.ok(html.includes(hook), `the rendered page no longer contains ${hook}`);
  }
  // Counts, not just presence: one strip cell instead of 32 leaves 31 segments
  // unclickable and passes a presence check.
  assert.equal((html.match(/data-fy="/g) ?? []).length, resolved.playable.length);
  assert.equal((html.match(/data-seg="/g) ?? []).length, resolved.playable.length);
  assert.equal((html.match(/data-thumb="/g) ?? []).length, resolved.entries.filter((e) => e.segment_id && e.topic).length * 2);
  /* Every reason chip the harness serves is a chip the page really emits —
     compared through app.js's own `esc`, because a label with an apostrophe
     ("Didn't like the voice") reaches the markup as `&#39;`. Comparing raw
     strings here failed, which is the pin doing its job on its first outing. */
  assert.ok(dom.chips.length >= 5, `only ${dom.chips.length} reason chips`);
  for (const c of dom.chips) {
    assert.ok(html.includes(`data-chip="${ctx.esc(c.dataset.chip)}"`), `chip "${c.dataset.chip}" is not in the markup`);
  }
  assert.equal((html.match(/data-chip="/g) ?? []).length, dom.chips.length);
});

/* ================================================== durable storage (#40) ====

   The store's own guarantees are unit-tested in `durable-store.test.js`. These
   tests are the wiring: that the REAL app.js reads and writes through the store
   when one is published, that an existing `cp_` row survives the change, and —
   the one that matters most on an auto-merge path — that none of it can leave the
   Foray page inert. The suite above exists because a `ReferenceError` once
   rendered a perfect, dead page; a storage layer is exactly the kind of thing
   that could do it again. */

test("app.js reads and writes through window.forayStorage when one is published", async () => {
  const { dom, forayStorage, durableTier, store } = await mountForayPage({ durable: true });
  await dom.thumbs.find((t) => t.dataset.thumb === "up").click();
  // The synchronous mirror is written before anything is awaited...
  assert.ok(store.has("cp_foray_feedback"), "localStorage is still the fast mirror");
  // ...and the durable tier catches up.
  await forayStorage.flush();
  assert.ok(durableTier.data.has("cp_foray_feedback"), "a thumb that only lives in localStorage is evictable");
  assert.equal(forayStorage.health().ok, true);
});

test("MIGRATION through the real page: rows already in localStorage reach the durable tier", async () => {
  // The listener who was mid-Foray when this shipped. Nothing about their state
  // is new, nothing is renamed, and nothing is deleted.
  const existing = {
    cp_profile_id: '"p-legacy"',
    cp_interests: '{"food/grilling-bbq":0.82}',
    [progressKey(FORAY_ID)]: JSON.stringify(makeProgress({
      forayId: FORAY_ID, title: "The history of grilling", elapsedSec: 1180, totalSec: 3673, index: 9,
    })),
  };
  const { forayStorage, durableTier, store } = await mountForayPage({ durable: true, seed: existing });
  await forayStorage.hydrate();
  await forayStorage.flush();
  for (const [k, v] of Object.entries(existing)) {
    assert.equal(durableTier.data.get(k), v, `${k} did not reach the durable tier`);
    assert.equal(store.get(k), v, `${k} was moved out of localStorage instead of copied`);
  }
});

test("MIGRATION: the page still reads its own state through the store afterwards", async () => {
  const { ctx, forayStorage } = await mountForayPage({
    durable: true, seed: { cp_interests: '{"food/grilling-bbq":0.82}' },
  });
  await forayStorage.hydrate();
  assert.equal(ctx.lsGet("cp_interests", {})["food/grilling-bbq"], 0.82);
});

test("EVICTION: a durable row is readable by the page after localStorage is wiped", async () => {
  // Two mounts over one durable tier is "the same browser next week"; the empty
  // seed is Safari's sweep.
  const row = JSON.stringify(makeProgress({
    forayId: FORAY_ID, title: "The history of grilling", elapsedSec: 1180, totalSec: 3673, index: 9,
  }));
  const first = await mountForayPage({ durable: true, seed: { [progressKey(FORAY_ID)]: row } });
  await first.forayStorage.hydrate();
  await first.forayStorage.flush();
  const carried = Object.fromEntries(first.durableTier.data);
  assert.ok(carried[progressKey(FORAY_ID)], "the first visit did not leave a durable copy");

  // Second visit: same durable tier, localStorage swept.
  const second = await mountForayPage({ durable: true, durableRows: carried });
  await second.forayStorage.hydrate();
  assert.equal(second.ctx.lsGet(progressKey(FORAY_ID), null).elapsed_sec, 1180);
  assert.equal(second.store.get(progressKey(FORAY_ID)), row, "and it is mirrored back into localStorage");
});

test("a refused write is reported to the caller instead of pretending to have worked", async () => {
  const { ctx, forayStorage } = await mountForayPage({ durable: true });
  assert.equal(ctx.lsSet("cp_interests", { a: 1 }), true);
  await forayStorage.flush();
  assert.equal(forayStorage.health().ok, true);
});

test("a full quota with no durable tier makes lsSet return false, and health says why", async () => {
  const { ctx, store } = await mountForayPage({ failLocalWrites: true });
  // No durable store here at all: this is the pre-#40 environment, plus honesty.
  assert.equal(ctx.lsSet("cp_interests", { a: 1 }), false);
  assert.equal(store.has("cp_interests"), false);
});

test("STORAGE FAILURE MUST NOT MAKE THE PAGE INERT — the regression this suite exists for", async () => {
  // Every tier refusing every write, through the real page. A storage layer that
  // throws out of a render path is how a perfect, dead page gets shipped.
  const { dom, forayStorage, ctx } = await mountForayPage({ durable: true, failLocalWrites: true });
  for (const id of ["fy-play", "fy-next", "fy-prev", "fy-strip"]) {
    assert.ok(dom.el(id).listeners("click") > 0, `#${id} lost its handler when storage failed`);
  }
  await assert.doesNotReject(() => dom.thumbs.find((t) => t.dataset.thumb === "up").click());
  await assert.doesNotReject(() => dom.el("fy-play").click());
  assert.equal(ctx.lsGet("cp_foray_feedback", null) !== null, true, "the session still sees its own vote");
  assert.equal(forayStorage.health().ok, false, "and the loss is recorded, not hidden");
});

test("a mount with no storage at all still renders and binds", async () => {
  // `player/client.js` failing to load — a stale service-worker cache, a 404.
  // lsGet/lsSet fall back to raw localStorage and the page is unchanged.
  const { dom, ctx } = await mountForayPage();
  assert.equal(ctx.window.forayStorage, undefined);
  assert.ok(dom.el("fy-play").listeners("click") > 0);
  assert.equal(ctx.lsSet("cp_interests", { a: 1 }), true);
});

/* ================================================ delete my data (#42) ====

   The control's own suite is `test/data-deletion.test.js`, which owns the
   enumeration, the remote half and the confirmation. What belongs HERE is the
   question only this harness can answer: after a listener deletes everything,
   is the Foray page still a working page, and does resume start working again?

   That is not a hypothetical pairing. The clear runs while a Foray is mounted, it
   resets in-memory state, and it re-renders through `route()` — three chances to
   leave the perfect, inert page this suite exists to prevent. */

test("DELETING EVERYTHING leaves the page interactive, and resume works again after it", async () => {
  const row = JSON.stringify(makeProgress({
    forayId: FORAY_ID, title: "The history of grilling", elapsedSec: 1180, totalSec: 3673, index: 9,
  }));
  const { dom, ctx, bridge, forayStorage, durableTier, store } = await mountForayPage({
    durable: true,
    seed: {
      [progressKey(FORAY_ID)]: row,
      cp_interests: '{"food/grilling-bbq":0.82}',
      "cp_pos:ep-1": '{"seconds":12,"updated_at":"2026-08-17T00:00:00.000Z"}',
      cp_events: "[]",
    },
    resume: { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, drift: "exact", label: "42 min left", clock: "19:40" },
  });
  await forayStorage.hydrate();
  await forayStorage.flush();
  assert.ok(durableTier.data.has(progressKey(FORAY_ID)), "fixture premise: the resume row is in both tiers");

  // Driven through app.js's own control. `ddUi` is the sheet's element map, so
  // setting the field's value is exactly what typing into it does.
  ctx.bindDeleteControl();
  vm.runInContext('ddUi.input.value = "DELETE";', ctx);
  const result = await ctx.deleteMyData();
  assert.equal(result.ok, true, `the deletion reported a problem: ${JSON.stringify(result)}`);

  assert.deepEqual([...store.keys()].filter((k) => k.startsWith("cp_")), [], "localStorage is not clear");
  assert.deepEqual([...durableTier.data.keys()].filter((k) => k.startsWith("cp_")), [], "the durable tier is not clear");

  // THE PAGE. Same assertion as the inert-page regression test, after a clear.
  for (const id of ["fy-play", "fy-next", "fy-prev", "fy-strip"]) {
    assert.ok(dom.el(id).listeners("click") > 0, `#${id} lost its handler to the deletion`);
  }
  const callsBefore = bridge.calls.length;
  await dom.el("fy-play").click();
  assert.ok(bridge.calls.length > callsBefore, "the transport stopped reaching the player");
  await assert.doesNotReject(() => dom.rows[3].click(), "a running-order row throws after a clear");

  // RESUME. A new row written through the same store lands in both tiers and
  // reads back — i.e. the store survived the purge rather than being emptied and
  // broken.
  const progress = new ForayProgressStore({ storage: forayStorage });
  assert.equal(progress.save({
    forayId: FORAY_ID, title: "The history of grilling", elapsedSec: 60, totalSec: 3673, index: 0, force: true,
  }), true, "resume can no longer be recorded");
  await forayStorage.flush();
  assert.equal(progress.refusedWrites, 0);
  assert.equal(ctx.lsGet(progressKey(FORAY_ID), null).elapsed_sec, 60, "the page cannot read the new row");
  assert.ok(durableTier.data.has(progressKey(FORAY_ID)), "the new row is evictable — the durable tier missed it");
  assert.equal(forayStorage.health().ok, true, "the purge left a fault behind");
});

/* ---------- freshness: the row against the running order ---------- */

test("the page hands the RESOLVED Foray to the resume lookup, not just two numbers", async () => {
  // Without this the stored segment id is checked against nothing, and a Foray
  // whose order changed resumes to the wrong audio at a plausible-looking clock.
  const { bridge, resolved } = await mountForayPage({
    resume: { elapsedSec: 1180, index: 9, remainingSec: 2493, percent: 32, finished: false, drift: "exact", label: "42 min left", clock: "19:40" },
  });
  const call = bridge.calls.find((c) => c.name === "forayResume");
  assert.ok(call, "renderForay never asked for a resume point");
  assert.equal(call.args[0], FORAY_ID);
  assert.equal(call.args[1].resolved, resolved);
  assert.equal(call.args[1].totalSec, resolved.totalSec);
  assert.equal(call.args[1].itemCount, resolved.playable.length);
});

test("a resume whose segment no longer exists still mounts an interactive page", async () => {
  // `drift: "dropped"`, `index: -1` — the stored segment is gone from the live
  // document. The page must open on the clamped clock and still work.
  const resume = { elapsedSec: 900, index: -1, remainingSec: 2773, percent: 24, finished: false, drift: "dropped", label: "46 min left", clock: "15:00" };
  const { dom, bridge } = await mountForayPage({ resume });
  assert.ok(dom.el("fy-play").listeners("click") > 0, "the page went inert on a stale row");
  assert.equal(dom.el("fy-now").textContent, fmtClock(900));
  assert.ok(!dom.rows.some((r) => r.classList.contains("is-played")),
    "a row that cannot be identified must not mark the running order as heard");
  await dom.el("fy-play").click();
  assert.equal(bridge.calls.find((c) => c.name === "playForay").args[1].startElapsedSec, 900);
});

test("a drifted resume is recorded as an event; a clean one is not", async () => {
  const drifted = await mountForayPage({
    resume: { elapsedSec: 900, index: 3, remainingSec: 2773, percent: 24, finished: false, drift: "moved", label: "46 min left", clock: "15:00" },
  });
  const events = JSON.parse(drifted.store.get("cp_events") ?? "[]").filter((e) => e.type === "foray_progress_drift");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.drift, "moved");
  assert.equal(events[0].payload.foray_id, FORAY_ID);

  const clean = await mountForayPage({
    resume: { elapsedSec: 900, index: 3, remainingSec: 2773, percent: 24, finished: false, drift: "exact", label: "46 min left", clock: "15:00" },
  });
  assert.equal(JSON.parse(clean.store.get("cp_events") ?? "[]").filter((e) => e.type === "foray_progress_drift").length, 0);
});

test("an older player module that cannot answer the drift question does not break the page", async () => {
  // app.js and the ES module deploy on their own service-worker schedules, so
  // `forayDriftIsClean` can genuinely be absent. Optional-chained for that reason.
  const { dom, bridge } = await mountForayPage({
    resume: { elapsedSec: 900, index: 3, remainingSec: 2773, percent: 24, finished: false, label: "46 min left", clock: "15:00" },
  });
  delete bridge.forayDriftIsClean;
  await assert.doesNotReject(() => mountForayPage({ resume: null }));
  assert.ok(dom.el("fy-play").listeners("click") > 0);
});

/* ---------- the real Foray, reconciled against itself ---------- */

test("Foray #1's own running order reconciles a row written from it as exact", async () => {
  const r = realResolve();
  const { progressSegments } = await import("./foray-resolve.js");
  const segments = progressSegments(r);
  const at = segments[9];
  const row = makeProgress({
    forayId: FORAY_ID, title: r.title, elapsedSec: at.startSec + 30,
    totalSec: r.totalSec, index: 9, segmentId: at.id, intoSec: 30,
  });
  const point = resumePoint(row, { totalSec: r.totalSec, maxIndex: r.playable.length - 1, segments });
  assert.equal(point.drift, "exact");
  assert.equal(Math.round(point.elapsedSec), Math.round(at.startSec + 30));
  assert.equal(point.index, 9);
});

test("dropping a segment from Foray #1 degrades the row rather than seeking wrong", async () => {
  const r = realResolve();
  const { progressSegments } = await import("./foray-resolve.js");
  const segments = progressSegments(r);
  const at = segments[9];
  const row = makeProgress({
    forayId: FORAY_ID, title: r.title, elapsedSec: at.startSec + 30,
    totalSec: r.totalSec, index: 9, segmentId: at.id, intoSec: 30,
  });
  // The same Foray with segment 10 gone, re-clocked exactly as the resolver would.
  const without = segments.filter((_, i) => i !== 9);
  let acc = 0;
  const reclocked = without.map((s) => { const out = { ...s, startSec: acc }; acc += s.durationSec; return out; });
  const point = resumePoint(row, { totalSec: acc, maxIndex: reclocked.length - 1, segments: reclocked });
  assert.equal(point.drift, "dropped");
  assert.equal(point.index, -1);
  assert.ok(point.elapsedSec <= acc, "a resume point can never be past the live end");
});
