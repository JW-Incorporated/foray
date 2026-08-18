/* The field record's WIRING (#264) — the real player, a real seam, a real record.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `player/diagnostic-log.test.js`
 * That suite drives `PlayerDiagnostics` with strings a human typed, so every one
 * of its assertions would still pass with the player emitting something else
 * entirely, or with `client.js`'s telemetry hook no longer feeding the record at
 * all. This one boots the REAL `player/client.js` over the real
 * `PlayerQueueManager`, the real reducer and the real `HtmlAudioBackend`, plays a
 * real two-segment Foray across two different episodes, and reads what actually
 * landed in `cp_diag`.
 *
 * So the split is: the other suite covers the MECHANISM (ring, cap, eviction,
 * durability, parse table, privacy rule, report text); this one covers that the
 * mechanism is CONNECTED, and that the telemetry FORMATS the parse table depends
 * on are still the formats the player produces. Delete the `diag.note(m)` line
 * from the telemetry hook and every test below fails while the other suite stays
 * green — which is exactly the pair of suites #266's mutation round showed is
 * needed.
 *
 * NO WALL-CLOCK BUDGET ASSERTIONS. `observedGapMs` is asserted to be a NUMBER and
 * non-negative, never to be under some threshold: the widest delivered
 * `timeupdate` interval recorded in this repo is 1,825 ms against a 250 ms
 * nominal, and a budget here would be a flake with a story. The one place a real
 * timer is waited on is the 2.0 s beat, which is the product's own constant and
 * comes from `SEAM_GAP_SEC` rather than from a number typed here.
 *
 * The DOM stub is `player/transport-reconcile.test.js`'s, kept deliberately
 * separate: this file asserts on a different subject, and coupling two suites
 * through a shared harness is how one of them silently stops covering anything.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { __resetInstanceForTests } from "./queue-manager.js";
import { indexSegments, indexSources, resolveForay } from "./foray-resolve.js";
import { SEAM_GAP_SEC } from "./seam-gap.js";
import { DIAG_KEY, formatDiagnosticReport } from "./diagnostic-log.js";

/* ==================================================================== */
/* the DOM, and an <audio> element that behaves like the spec            */
/* ==================================================================== */

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  append(...kids) { for (const k of kids) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  click() { for (const fn of [...(this.listeners.get("click") ?? [])]) fn({}); }
}

/**
 * An `<audio>` element.
 *
 * `pause()` fires `pause` only when the element was not already paused — the spec,
 * and the rule every naive fake in this repo has broken. `load()` resets
 * `currentTime` to 0, which is the media load algorithm and the whole of the
 * second field report.
 *
 * `stall(url)` is the one thing this file adds over the reconcile suite's copy: a
 * source that fires `loadstart` and `stalled` and then NOTHING. That is the shape
 * a cold cross-origin fetch on cellular takes — browsers fire `stalled` and never
 * `error` — and it is the failure the record has to survive.
 */
class Element {
  constructor({ durationSec = 3600 } = {}) {
    this.listeners = new Map();
    this.calls = [];
    this.src = "";
    this.currentSrc = "";
    this.currentTime = 0;
    this.duration = durationSec;
    this.playbackRate = 1;
    this.volume = 1;
    this.preload = "none";
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
    /** url -> "ok" | "error" | "stall". Anything unlisted loads fine. */
    this.loadPlan = new Map();
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  fire(t) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(); }

  load() {
    this.calls.push("load");
    this.currentSrc = this.src;
    this.currentTime = 0;
    this.readyState = 0;
    this.ended = false;
    const plan = this.loadPlan.get(this.src) ?? "ok";
    queueMicrotask(() => {
      if (plan === "error") { this.error = { code: 4 }; return this.fire("error"); }
      if (plan === "stall") { this.fire("stalled"); return; }
      this.readyState = 1;
      this.fire("loadedmetadata");
      queueMicrotask(() => {
        this.readyState = 4;
        if (this.currentTime > 0) this.fire("seeked");
        this.fire("canplay");
      });
    });
  }
  play() {
    this.calls.push("play");
    this.paused = false;
    this.ended = false;
    queueMicrotask(() => { if (!this.paused) this.fire("playing"); });
    return Promise.resolve();
  }
  pause() {
    this.calls.push("pause");
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  removeAttribute(a) { this.calls.push(`removeAttribute:${a}`); this.src = ""; }

  /** The car was switched off while the page was suspended: the audio stopped and
      no event was ever delivered. The founder's case (#263/#266). */
  routeLostUnseen() { this.paused = true; }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

let bootSeq = 0;

/**
 * Boot the real client against the stub.
 *
 * A cache-busting query on the specifier, because `client.js` reads its globals at
 * module scope and Node caches a module for the life of the process — two tests
 * sharing one instance would share a booted player, one storage tier and one
 * diagnostic ring.
 */
async function bootClient(t) {
  const audio = new Element();
  const storage = new MemoryStorage();
  const doc = {
    hidden: false,
    body: new Node("body"),
    createElement: (tag) => (String(tag).toLowerCase() === "audio" ? audio : new Node(tag)),
    querySelectorAll: () => [],
    listeners: new Map(),
    addEventListener(t2, fn) {
      if (!this.listeners.has(t2)) this.listeners.set(t2, new Set());
      this.listeners.get(t2).add(fn);
    },
    removeEventListener(t2, fn) { this.listeners.get(t2)?.delete(fn); },
    fire(t2) { for (const fn of [...(this.listeners.get(t2) ?? [])]) fn(); },
  };
  doc.body.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  const win = {
    listeners: new Map(),
    addEventListener(t2, fn) {
      if (!this.listeners.has(t2)) this.listeners.set(t2, new Set());
      this.listeners.get(t2).add(fn);
    },
    removeEventListener() {},
    dispatchEvent: () => true,
  };

  const names = ["window", "document", "localStorage", "navigator", "Event", "Audio"];
  const prev = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const set = (n, value) =>
    Object.defineProperty(globalThis, n, { value, writable: true, configurable: true });
  const restore = () => {
    for (const [n, d] of prev) {
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  };
  set("window", win);
  set("document", doc);
  set("localStorage", storage);
  set("navigator", { storage: { persisted: async () => false } });
  set("Event", class { constructor(type) { this.type = type; } });
  set("Audio", function Audio() { return audio; });
  __resetInstanceForTests();

  const client = (await import(`./client.js?diag=${++bootSeq}`)).default;
  t.after(restore);

  /** What a founder would read, taken from STORAGE and not from memory — the page
      that would have completed a stalled seam is the page that got suspended. */
  const record = () => {
    const raw = storage.getItem(DIAG_KEY);
    return raw ? JSON.parse(raw) : null;
  };
  const rows = (type) => (record()?.entries ?? []).filter((e) => e.type === type);
  return { client, doc, win, audio, storage, restore, record, rows };
}

/** Two segments from DIFFERENT episodes: the seam is a real cross-episode load,
    which is the shape both field reports were on. */
function crossEpisodeForay() {
  const foray = {
    id: "f264", kind: "deep-dive", title: "A Foray", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: "sb" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-a", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
      { id: "sb", item_id: "ep-b", start_sec: 500, end_sec: 600, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-a", show: "Show A", title: "Ep A", audio_url: "https://cdn.test/a.mp3", duration_sec: 3600, dai_suspected: false },
      { id: "ep-b", show: "Show B", title: "Ep B", audio_url: "https://cdn.test/b.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  return resolveForay(foray, { segments, sources });
}

/** Two segments from the SAME episode, so the second one takes the same-source
    seek shortcut — 15 of Foray #1's 31 seams do. */
function sameSourceForay() {
  const foray = {
    id: "f264s", kind: "deep-dive", title: "A Foray", status: "published",
    slots: [{ id: "one", title: "Slot one" }],
    items: [
      { type: "segment", slot: "one", label: "L1", role: "explanation", segment_id: "sa" },
      { type: "segment", slot: "one", label: "L2", role: "explanation", segment_id: "sb" },
    ],
  };
  const segments = indexSegments({
    segments: [
      { id: "sa", item_id: "ep-a", start_sec: 100, end_sec: 200, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
      { id: "sb", item_id: "ep-a", start_sec: 500, end_sec: 600, reference_duration_sec: 3600, why: "w", topic: "food/grilling-bbq", confidence: "high" },
    ],
  });
  const sources = indexSources({
    sources: [
      { id: "ep-a", show: "Show A", title: "Ep A", audio_url: "https://cdn.test/a.mp3", duration_sec: 3600, dai_suspected: false },
    ],
  });
  return resolveForay(foray, { segments, sources });
}

const settle = () => new Promise((r) => setTimeout(r, 0));
/** The authored beat, from the product's own constant. A seam cannot be completed
    without spending it — `_awaitSeamGap` holds the remainder deliberately. */
const beat = () => new Promise((r) => setTimeout(r, SEAM_GAP_SEC * 1000 + 250));

/** Drive the element past segment sa's out-point, the way playback does. */
function crossTheBoundary(audio, atSec = 200.02) {
  audio.currentTime = atSec;
  audio.fire("timeupdate");
}

/* ==================================================================== */
/* 1. the record exists at all, and it is the whole stream               */
/* ==================================================================== */

test("the record is written by simply playing — no console, no devtools", async (t) => {
  /* THE PREMISE OF #264 IN ONE TEST. Before this, everything diagnostic was
     dropped at `/error|rejected|skipped/` and the survivors went to
     `console.warn`, which is "a console line nobody has open".

     MUTATION: delete `diag.note(m)` from `client.js`'s telemetry hook. Every test
     in this file fails; `player/diagnostic-log.test.js` stays entirely green,
     which is why both suites exist. */
  const { client, record, rows, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  assert.ok(record(), `nothing was recorded under ${DIAG_KEY}`);
  assert.ok(rows("boot").length === 1, "the page's own start is in there");
  assert.ok(record().entries.length > 1, "and so is what playing did");
  restore();
});

test("the first write waits for storage to hydrate", () => {
  /* THE ORDERING THAT CAN LOSE A RECORD, from the client's end. The ring is read
     lazily on its first write, so the first write must land AFTER `hydrate()` has
     pulled the durable tier up — otherwise a page whose localStorage Safari has
     cleared (about seven days without a visit) would overwrite the only surviving
     copy with an empty ring. `player/diagnostic-log.test.js` covers the laziness
     itself; this covers the half only `client.js` can get wrong.

     A SOURCE ASSERTION, and deliberately, because the behaviour is unobservable
     from here: this store has no IndexedDB tier under `node --test`, so `hydrate()`
     settles in the same microtask as the `await import`, and there is no window for
     a test to look into. The same technique `player/foray-playback.test.js` uses on
     this file, and `tools/mobile/probe/install-probe.test.mjs` on listener order.

     MUTATION: replace the `storageReady.then(...)` with a bare `diag.boot()` at
     module scope — which is what an earlier draft of this change actually did. Both
     assertions fail. */
  const src = fs.readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  assert.match(
    code, /storageReady\s*\.then\(\s*\(\)\s*=>\s*diag\.boot\(\)\s*\)/,
    "the boot row must be deferred until storageReady resolves"
  );
  assert.ok(
    !/^\s*diag\.boot\(\);/m.test(code),
    "and must not also be written at module scope, which is the bug this replaced"
  );
});

test("a real cross-episode seam records observedGapMs, the deadline and both ids", async (t) => {
  /* THE MOST VALUABLE ROW IN THE RECORD, produced by the real player rather than
     by a typed string. This is the test that catches a telemetry FORMAT change:
     re-word `load.deadline`, `seam.gap.armed` or `outPoint.reached` and the parse
     table stops matching, the fields go null, and this goes red.

     `observedGapMs` is asserted as a NUMBER and non-negative. Never a budget — the
     widest delivered tick recorded here is 1,825 ms against 250 ms nominal. */
  const { client, audio, rows, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  const seams = rows("seam");
  assert.equal(seams.length, 1, `expected one seam, got ${seams.length}`);
  const seam = seams[0];
  assert.equal(seam.fromId, "f264#0", "the segment that ended");
  assert.equal(seam.toId, "f264#1", "and the one that followed");
  assert.equal(seam.crossEpisode, true, "two different episodes is a cold fetch");
  assert.equal(seam.askedGapMs, SEAM_GAP_SEC * 1000, "the authored beat, from the product's constant");
  assert.equal(seam.deadlineMs, 10_000, "#239's VISIBLE budget, because the page was visible");
  assert.equal(seam.deadlineFor, "visible");
  assert.equal(typeof seam.observedGapMs, "number", "the seam completed and was measured");
  assert.ok(seam.observedGapMs >= 0, `a duration cannot be negative: ${seam.observedGapMs}`);
  assert.equal(seam.lastStage, "playing", "the next segment became audible");
  restore();
});

test("the out-point's overshoot comes from the real backend, per boundary", async (t) => {
  /* A miss costs a median 936.5 s of the wrong episode, and the boundary is the
     single most valuable measured property of this player.
     MUTATION: change `outPoint.reached`'s `overshoot=` wording in
     `html-audio-backend.js` — this fails while the mechanism suite stays green. */
  const { client, audio, rows, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio, 200.021);
  await settle();

  const out = rows("outPoint");
  assert.equal(out.length, 1);
  assert.equal(out[0].targetSec, 200, "the authored end_sec");
  assert.ok(Math.abs(out[0].overshootSec - 0.021) < 1e-6, `overshoot was ${out[0].overshootSec}`);
  restore();
});

test("the same-source shortcut is recorded as NOT cross-episode", async (t) => {
  /* #239's 20 s hidden deadline is a claim about a cold fetch. 15 of Foray #1's 31
     seams re-use a loaded source and take a seek instead, and a record that could
     not tell them apart would average two different mechanisms.
     MUTATION: in `client.js`, feed only `outPoint.reached` to the record and drop
     the rest of the stream — `crossEpisode` goes null and this fails. */
  const { client, audio, rows, restore } = await bootClient(t);
  await client.playForay(sameSourceForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  const seam = rows("seam")[0];
  assert.equal(seam.crossEpisode, false, "one episode, one fetch, a seek at the seam");
  assert.equal(seam.toId, "f264s#1");
  assert.equal(typeof seam.observedGapMs, "number");
  restore();
});

/* ==================================================================== */
/* 2. it survives the thing it measures                                  */
/* ==================================================================== */

test("A LOAD THAT NEVER SETTLES leaves a durable row saying how far it got", async (t) => {
  /* #224, AS IT WOULD ARRIVE FROM A CAR. The next episode's fetch fires `stalled`
     and then nothing — the shape a cold cross-origin fetch takes, where browsers
     fire `stalled`/`suspend` and never `error`. The page is then suspended, so
     nothing later can complete the record.

     Read from STORAGE, deliberately: an assertion against the in-memory ring would
     pass with the write deferred to unload, which is the one thing this record must
     not do.

     MUTATION: move the seam's `log.record` from `_openSeam` to `_closeSeam`. The
     row does not exist and this fails — the record would be empty for exactly the
     failure it was built to explain. */
  const { client, audio, rows, record, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/b.mp3", "stall");
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  const seam = rows("seam")[0];
  assert.ok(seam, "the boundary wrote a row before the load was attempted");
  assert.equal(seam.observedGapMs, null, "and nothing ever became audible");
  assert.equal(seam.crossEpisode, true);
  assert.equal(seam.deadlineMs, 10_000, "against the deadline that was in force");
  assert.equal(seam.askedGapMs, SEAM_GAP_SEC * 1000);
  const trail = seam.stages.map((s) => s.stage);
  assert.ok(trail.includes("load.deadline"), `the load was reached: ${trail.join(" > ")}`);
  assert.ok(trail.includes("stalled"), `and it stalled: ${trail.join(" > ")}`);
  assert.match(formatDiagnosticReport(record()), /NEVER STARTED/);
  restore();
});

test("every entry is sequence-numbered and wall-clocked, in one durable blob", async (t) => {
  /* The probe's lesson: its record ended 976 ms after audio resumed and could not
     separate "time stopped" from "writes stopped" until a sequence-numbered save
     was added. The pair is what makes the CADENCE checkable.
     MUTATION: drop `seq` from `record()` — this fails. */
  const { client, audio, record, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  const entries = record().entries;
  assert.ok(entries.length >= 3);
  const seqs = entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "monotonic");
  assert.equal(new Set(seqs).size, seqs.length, "and never handed out twice");
  for (const e of entries) assert.equal(typeof e.wall, "number", `no wall clock on #${e.seq}`);
  restore();
});

/* ==================================================================== */
/* 3. external stops, visibility, resume — through the real page          */
/* ==================================================================== */

test("THE FOUNDER'S CAR: the stop is recorded, and so is the state it landed in", async (t) => {
  /* The route vanished while the page was suspended, so no event was delivered;
     becoming visible is where the player notices. #266 gave it an `interrupted`
     state, and this records when that lands and why.

     MUTATION 1: delete `diag.reconciled(...)` from `reconcileOnReturn`. `state`
     stays null and this fails — the record would say a stop happened without
     saying what the player concluded.
     MUTATION 2: bind the record's `visibilitychange` inside `bind()` instead of at
     module scope. The `visibility` rows disappear for any page that has not
     pressed play, and the last assertion fails. */
  const { client, doc, audio, rows, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();

  doc.hidden = true;
  doc.fire("visibilitychange");
  audio.currentTime = 161;
  audio.routeLostUnseen();
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();

  const stops = rows("stop").filter((s) => s.source === "reconcile");
  assert.equal(stops.length, 1, "one correction, recorded once");
  assert.equal(stops[0].why, "visible");
  assert.equal(stops[0].state, "interrupted", "the state #266 introduced, named in the record");

  const vis = rows("visibility");
  assert.deepEqual(vis.map((v) => v.to), ["hidden", "visible"]);
  for (const v of vis) assert.equal(typeof v.forMs, "number", "with the length of the window it left");
  restore();
});

test("A WRONG RESUME leaves a row saying nothing was written, and why", async (t) => {
  /* THE SECOND FIELD REPORT. After a failed cross-episode load the element's clock
     has been reset to 0 by the `src` assignment while the manager has already
     moved on, so the playhead is unknown — and `persistForayProgress` correctly
     REFUSES to write. Before this record there was no evidence of that refusal at
     all, which is why "it restarted the segment" could not be diagnosed.

     MUTATION: record only successful resume writes. The row disappears and this
     fails. */
  const { client, audio, doc, rows, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/b.mp3", "error");
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  // He pockets the phone. `pagehide`/`visibilitychange` is the forced write.
  doc.hidden = true;
  doc.fire("visibilitychange");
  await settle();

  const writes = rows("resume").filter((r) => r.phase === "write");
  assert.ok(writes.length >= 1, "a forced write left a row");
  const last = writes[writes.length - 1];
  assert.equal(last.wrote, false, "nothing was written down");
  assert.equal(last.why, "playhead-unknown", "and the reason is the one the code gives");
  restore();
});

test("a resume records what was asked for and which segment and offset it became", async (t) => {
  /* "What was read back, and which item and offset it resolved to." One row,
     because either half alone is unreadable.
     MUTATION: drop `intoSec` from `resumeStart`. This fails — "resume at 1,240 s"
     without "41 s into segment 2" cannot be checked against where audio started. */
  const { client, rows, restore } = await bootClient(t);
  const resolved = crossEpisodeForay();
  await client.playForay(resolved, { startElapsedSec: 141 });
  await settle();

  const start = rows("resume").filter((r) => r.phase === "start");
  assert.equal(start.length, 1);
  assert.equal(start[0].requestedElapsedSec, 141);
  assert.equal(start[0].index, 1, "141 s into a 100 s first segment is the second one");
  assert.equal(start[0].segmentId, "f264#1");
  assert.equal(start[0].intoSec, 41, "and 41 s into it");
  assert.equal(start[0].resolvedBy, "elapsed");
  restore();
});

test("the last segment's boundary is the end of the queue, not a stall", async (t) => {
  /* Otherwise every healthy Foray reports a failure at its final boundary — the
     instrument manufacturing its own finding, which is the thing the probe guards
     against by name.
     MUTATION: delete the `queue.ended` branch. The final seam reads NEVER STARTED
     and this fails. */
  const { client, audio, rows, record, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 1 });
  await settle();
  audio.currentTime = 600.01;
  audio.fire("timeupdate");
  await settle();

  const seams = rows("seam");
  assert.equal(seams.length, 1);
  assert.equal(seams[0].endOfQueue, true);
  assert.doesNotMatch(formatDiagnosticReport(record()), /NEVER STARTED/);
  restore();
});

/* ==================================================================== */
/* 4. what it must never do                                              */
/* ==================================================================== */

test("nothing recorded here reaches cp_events, and no URL reaches the record", async (t) => {
  /* THE DESIGN, ASSERTED. #264's original text said the `cp_events` pipeline has a
     consent gate; it does not — `trySyncEvents()` is called unconditionally at
     `app.js:664` and `:686` — so a richer record of a person's listening must not
     ride it. "We forgot to add it to the sync" and "it must never be in the sync"
     look identical in a diff, so the second one is written down here.

     MUTATION 1: route any of these entries through `window.forayLogEvent`. The
     `cp_events` assertion fails.
     MUTATION 2: add the message text to any entry. The URL scan fails — this run
     includes a real media error whose telemetry line carries `src=https://…`. */
  const { client, audio, storage, restore } = await bootClient(t);
  audio.loadPlan.set("https://cdn.test/b.mp3", "error");
  await client.playForay(crossEpisodeForay(), { startElapsedSec: 141 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  const events = storage.getItem("cp_events");
  if (events) {
    assert.ok(
      !/seam|observedGapMs|deadlineMs|overshoot/i.test(events),
      `the field record leaked into the transmitted pipeline:\n${events}`
    );
  }
  const blob = storage.getItem(DIAG_KEY);
  assert.ok(blob, "there is a record to check");
  assert.ok(!/https?:/i.test(blob), `a URL reached the record:\n${blob}`);
  assert.ok(!/cdn\.test/.test(blob), `a host reached the record:\n${blob}`);
  assert.ok(/audio\.error\.code=/.test(blob), "the error CODE is what was wanted instead");
  restore();
});

test("Delete my data takes the record with it, and the ring cannot put it back", async (t) => {
  /* A `cp_` key is purged by `DurableStore.purge()`, but this module holds the ring
     IN MEMORY — so without the explicit clear the very next `visibilitychange`
     would write every purged entry straight back under a new key. A listener who
     asked for their data to be gone must not get a seam log back for pocketing the
     phone.

     MUTATION: remove `diagLog.clear()` from `stopForDataDeletion()`. The last
     assertion fails — the record returns. */
  const { client, doc, audio, storage, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();
  assert.ok(storage.getItem(DIAG_KEY), "there is a record to delete");

  await client.stopForDataDeletion();
  assert.equal(storage.getItem(DIAG_KEY), null, "the key is gone");

  doc.hidden = true;
  doc.fire("visibilitychange");
  doc.hidden = false;
  doc.fire("visibilitychange");
  await settle();
  const after = storage.getItem(DIAG_KEY);
  const entries = after ? JSON.parse(after).entries : [];
  assert.ok(
    !entries.some((e) => e.type === "seam" || e.type === "outPoint"),
    `purged playback entries came back:\n${after}`
  );
  restore();
});

test("the surface's text is reachable through the bridge app.js actually uses", async (t) => {
  /* app.js is a classic script and cannot import this module, so the report arrives
     over `window` exactly as the storage health record does. A rename here is a
     blank sheet in the drawer, on a phone, which is the one failure mode this whole
     surface exists to remove.

     MUTATION: rename `window.forayDiagnosticReport`. This fails, and so does
     `test/diagnostics-surface.test.js`'s bridge test — the two halves of one wire,
     asserted from both ends. */
  const { client, win, audio, restore } = await bootClient(t);
  await client.playForay(crossEpisodeForay(), { startIndex: 0 });
  await settle();
  crossTheBoundary(audio);
  await beat();

  assert.equal(typeof globalThis.window.forayDiagnosticReport, "function");
  assert.equal(typeof globalThis.window.forayDiagnosticClear, "function");
  const text = globalThis.window.forayDiagnosticReport();
  assert.match(text, /Foray playback diagnostics/);
  assert.match(text, /Local only\. Nothing here is sent anywhere\./);
  assert.match(text, /entries \d+ of 200 \(oldest dropped first\)/);
  assert.match(text, /seams 1: 1 measured/);
  assert.ok(win, "the same window the module was booted against");

  globalThis.window.forayDiagnosticClear();
  assert.match(globalThis.window.forayDiagnosticReport(), /Nothing recorded yet/);
  restore();
});
