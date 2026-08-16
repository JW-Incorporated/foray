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
  /** Fire a click. `target` models event delegation (the strip reads e.target). */
  async click(target = this) {
    const ev = { preventDefault() {}, stopPropagation() {}, target };
    for (const fn of [...(this._on.get("click") ?? [])]) await fn(ev);
  }
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
    this.segs = playable.map((_, i) => new StubEl(this, { className: "fy-seg", attrs: { seg: String(i) } }));
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
function fakeBridge(resolved, { resume = null } = {}) {
  const calls = [];
  let onChange = null;
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
    forayResume: () => resume,
    forayResumeList: () => (resume ? [{ id: resolved.id, title: resolved.title, percent: 32, label: "42 min left", finished: false }] : []),
    clearForayResume: record("clearForayResume"),
    // A real credit, so the block is actually emitted and bindSourceLinks has
    // something to bind — an empty list made that binder untested by accident.
    forayCredits: () => ({ credits: [credit], summary: "1 episode from 1 show" }),
    watchForay: (fn) => { onChange = fn; return null; },
    playForay: (r, opts = {}) => { calls.push({ name: "playForay", args: [r, opts] }); onChange = opts.onChange ?? onChange; return null; },
    forayToggle: record("forayToggle"),
    forayNext: record("forayNext"),
    forayPrevious: record("forayPrevious"),
    forayJump: (i) => { calls.push({ name: "forayJump", args: [i] }); },
  };
}

/** Mount the Foray page the way the router does, and hand back everything a
    test needs to poke it. Rejects if `renderForay` throws — which is the whole
    point, and is what the inert build did. */
async function mountForayPage({ resume = null } = {}) {
  const resolved = realResolve();
  const dom = new StubDom(resolved);
  const bridge = fakeBridge(resolved, { resume });
  const store = new Map();

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),          // parks init(), same as app-security
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
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
    URL, URLSearchParams, Math, Date, JSON, Promise, setTimeout, clearTimeout,
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
  return { dom, bridge, ctx, resolved, store, html: dom.el("view").innerHTML };
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
  assert.deepEqual(jumps, [20, 7], "a row and a strip cell must both jump to their own segment");
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
