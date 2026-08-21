/* The field record's MECHANISM (#264).
 *
 * WHICH SUITE COVERS WHAT, because "my tests are vacuous" is the default reading
 * in this repo and it has been earned. Two suites, and the split is by what a
 * mutation breaks:
 *
 *   THIS FILE covers the mechanism in isolation — the ring, the sequence number,
 *   the cap and its eviction direction, durability-on-write, the parse table, the
 *   privacy rule, and the report text. Everything here is driven by injected
 *   fakes with an injected clock, so nothing depends on a real player.
 *
 *   `player/diagnostic-record.test.js` covers the WIRING, by booting the real
 *   `player/client.js` over the real manager, the real reducer and the real
 *   `HtmlAudioBackend`, and driving a real cross-episode seam. That is the suite
 *   that fails if the telemetry hook stops feeding the record, if the element
 *   events are bound to the wrong edge, or if a telemetry FORMAT changes under
 *   the patterns below.
 *
 * A test here that pins a pattern would pass with the player emitting something
 * else entirely; a test there that watched only the end state would pass with the
 * ring unbounded. Neither suite is sufficient alone, which is the point.
 *
 * THE MUTATION THAT KILLS EACH TEST is named in the test that catches it. The
 * standing lesson: #266's central mechanism survived mutation in two suites
 * before the third caught it, so a mechanism with one test is a mechanism with
 * none.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DiagnosticLog, PlayerDiagnostics, formatDiagnosticReport, stageOf, errorNameOf,
  DIAG_KEY, DIAG_CAP, STAGE_CAP, DIAG_VERSION, MEDIA_STAGES,
} from "./diagnostic-log.js";

/* ==================================================================== */
/* fakes                                                                */
/* ==================================================================== */

/** A `Storage`-shaped map that can be made to refuse, because a refused write is
    the one storage failure this record has to survive without becoming it. */
function fakeStore({ refuse = false } = {}) {
  const map = new Map();
  return {
    map,
    writes: 0,
    removes: [],
    refuse,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (this.refuse) throw new Error("QuotaExceededError");
      this.writes += 1;
      map.set(k, String(v));
    },
    removeItem(k) { this.removes.push(k); map.delete(k); },
  };
}

/** An injected clock. Never a real one: a suite that measured its own runtime
    would be the wall-clock assertion this repo forbids (#195, and the widest
    delivered `timeupdate` interval recorded here is 1,825 ms against 250 ms
    nominal). */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; return t; }, set: (ms) => { t = ms; } };
}

const parse = (store, key = DIAG_KEY) => JSON.parse(store.getItem(key));

function mk({ cap, storage, now } = {}) {
  const c = now ?? clock();
  const s = storage ?? fakeStore();
  const log = new DiagnosticLog({ storage: s, cap, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now, isHidden: () => s.hidden === true });
  return { log, diag, store: s, clock: c };
}

/* ==================================================================== */
/* 1. the ring: bounded, sequence-numbered, durable on write             */
/* ==================================================================== */

test("the key is cp_-prefixed, so the store owns it and the delete control finds it", () => {
  /* MUTATION: rename to `foray_diag`. `test/data-deletion.test.js` goes red on
     both counts — the key-family scan no longer finds 21, and `DurableStore` would
     no longer own, mirror or purge it. That coupling is deliberate: an unprefixed
     diagnostic is a row "Delete my data" cannot reach. */
  assert.equal(DIAG_KEY, "cp_diag");
  assert.ok(DIAG_KEY.startsWith("cp_"));
});

test("a write reaches storage BEFORE record() returns — the durability requirement", () => {
  /* THE REQUIREMENT, AS ONE ASSERTION. A page suspended mid-seam is exactly when
     the record matters, so nothing may wait for unload. `DurableStore.setItem`
     writes its localStorage tier synchronously, and this proves the record does
     not defer, batch or debounce on top of it.

     MUTATION: move the `save()` in `record()` behind a `queueMicrotask` or a
     timer. This fails immediately — the store is empty at the point of return.
     No `await` anywhere in this test, deliberately: an `await` would let a
     deferred write land and the test would pass with the defect. */
  const { log, store } = mk();
  log.record("seam", { fromId: "sa" });
  assert.equal(store.writes, 1, "one synchronous write");
  assert.equal(parse(store).entries.length, 1, "and it is on disk, not queued");
});

test("every entry carries a monotonic sequence number and a wall clock", () => {
  /* The iOS probe's lesson: its record ended 976 ms after audio resumed and could
     not separate "time stopped" from "writes stopped" until a sequence-numbered
     save was added.

     MUTATION: replace `++this._seq` with a constant, or drop `wall`. Both fail. */
  const { log, clock: c } = mk();
  const a = log.record("boot", {});
  c.tick(500);
  const b = log.record("seam", {});
  c.tick(250);
  const d = log.record("seam", {});
  assert.deepEqual([a.seq, b.seq, d.seq], [1, 2, 3]);
  assert.ok(b.wall - a.wall === 500 && d.wall - b.wall === 250, "wall clock advances with the clock");
});

test("the cap is enforced and evicts the OLDEST, not the newest", () => {
  /* THE DIRECTION IS THE WHOLE ASSERTION, and the probe's `saveTrail` comment
     explains why: a head cap drops the NEWEST, which is the end of the window and
     the only part that says where the record stopped.

     MUTATION 1: change `entries.shift()` to `entries.pop()`. The surviving seqs
     become 1..4 instead of 5..8 and this fails.
     MUTATION 2: delete the `while` loop. `entries.length` becomes 8 and this
     fails on the first assertion — a diagnostic growing without limit on a
     device. */
  const { log, store } = mk({ cap: 4 });
  for (let i = 0; i < 8; i++) log.record("seam", { n: i });
  assert.equal(log.entries.length, 4, "bounded");
  assert.deepEqual(log.entries.map((e) => e.n), [4, 5, 6, 7], "the four most recent");
  assert.equal(log.dropped, 4, "and it says how many it lost");
  assert.deepEqual(parse(store).entries.map((e) => e.n), [4, 5, 6, 7], "on disk too");
});

test("the stated cap is 200 entries — roughly three complete Forays", () => {
  /* Pinned as a number because the policy row and the surface both quote it. A
     32-segment Foray is ~31 seams and one out-point each, so 200 is ~3 Forays.
     MUTATION: change DIAG_CAP without changing `docs/legal/privacy-policy.md`
     §1's "200" — this fails, and the policy row is then a false statement. */
  assert.equal(DIAG_CAP, 200);
  /* 12, down from 24 after review did the arithmetic on `save()`: the ring is
     re-serialised once per stage, so a stage cap is a cost multiplier as much as a
     bound. A healthy seam produces about seven. */
  assert.equal(STAGE_CAP, 12);
});

test("a sequence number SURVIVES eviction, so a wrapped ring is not a cleared one", () => {
  /* This is the one thing the seq/wall pair uniquely buys here, and the probe's
     own comment is careful that it does NOT buy the other thing (a page cannot
     record that its own later write failed to persist). `entries[0].seq > 1` with
     `dropped > 0` is "the ring wrapped"; `dropped === 0` is "it was cleared".

     MUTATION: reset `_seq` to `entries.length` on load. Both readings collapse to
     the same record and this fails. */
  const { log, store, clock: c } = mk({ cap: 3 });
  for (let i = 0; i < 6; i++) log.record("seam", { n: i });
  const reopened = new DiagnosticLog({ storage: store, cap: 3, now: c.now });
  assert.equal(reopened.entries[0].seq, 4, "the surviving entries keep their original numbers");
  assert.equal(reopened.seq, 6, "and the counter continues rather than restarting");
  assert.equal(reopened.dropped, 3);
  reopened.record("seam", { n: 6 });
  assert.equal(reopened.entries[reopened.entries.length - 1].seq, 7, "no number is handed out twice");
});

test("a previous session's entries are kept, not cleared on load", () => {
  /* The founder listens in a car and opens the app later. A log that emptied
     itself at boot would be empty exactly when it is read.
     MUTATION: make `_load()` start from `[]` unconditionally — this fails. */
  const { log, store, clock: c } = mk();
  log.record("seam", { fromId: "sa" });
  const reopened = new DiagnosticLog({ storage: store, now: c.now });
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.entries[0].fromId, "sa");
});

test("storage is read on the FIRST WRITE, not at construction, so hydration lands first", () => {
  /* THE ONE ORDERING THAT CAN LOSE A RECORD. `client.js` builds this at module
     evaluation, before `DurableStore.hydrate()` has pulled the IndexedDB tier up
     into memory — and the case where the two tiers disagree is the case that
     matters: Safari clears script-writable storage after about seven days, so
     localStorage is empty and the durable tier holds the whole record. A log that
     read `[]` at construction would overwrite that durable copy with a fresh short
     ring on its very next write.

     The `store.map.set` below IS hydration: the durable tier's copy arriving in the
     store after this object exists.

     MUTATION: call `this._load()` from the constructor. The earlier drive is gone,
     the surviving entry count is 1 and the sequence restarts — all three fail. An
     earlier draft of `client.js` had exactly this bug by calling `diag.boot()` at
     module scope; `storageReady.then(() => diag.boot())` is the other half of the
     fix and `player/diagnostic-record.test.js` covers that end. */
  const store = fakeStore();
  const log = new DiagnosticLog({ storage: store, now: clock().now });
  store.map.set(DIAG_KEY, JSON.stringify({
    v: 1, cap: 200, seq: 9, dropped: 2,
    entries: [{ seq: 8, wall: 1, type: "seam" }, { seq: 9, wall: 2, type: "outPoint" }],
  }));
  log.record("boot", {});
  assert.strictEqual(log.entries.length, 3, "the earlier drive survived hydration");
  assert.strictEqual(log.entries[2].seq, 10, "and the sequence continued from it");
  assert.strictEqual(log.dropped, 2, "including what it had already lost");
});

test("a corrupt record starts clean and SAYS it could not be read", () => {
  /* An empty log must never be ambiguous between "nothing happened" and "the blob
     was unreadable".
     MUTATION: swallow the parse error without setting `loadError` — this fails. */
  const store = fakeStore();
  store.map.set(DIAG_KEY, "{not json");
  const log = new DiagnosticLog({ storage: store, now: clock().now });
  assert.deepEqual(log.entries, []);
  assert.ok(log.loadError, "the reason survives into the record");
  assert.match(formatDiagnosticReport(log.read()), /earlier record unreadable/);
});

test("a refused write is COUNTED and never thrown — the instrument cannot become the outage", () => {
  /* `durable-store.js` refuses to let its own health record become an outage for
     the same reason; this record sits on the seam-critical path, where a throw
     would propagate into the player's telemetry hook.

     MUTATION: remove the try/catch in `save()`. `record()` throws and this fails.
     MUTATION 2: swallow without incrementing `saveErrors` — the second assertion
     fails, and the one observable half of "did writes stop reaching disk" is lost. */
  const { log } = mk({ storage: fakeStore({ refuse: true }) });
  assert.doesNotThrow(() => log.record("seam", {}));
  log.record("seam", {});
  assert.equal(log.saveErrors, 2);
  assert.match(formatDiagnosticReport(log.read()), /writeErrors 2/);
});

test("the record carries an ISO updatedAt, so hydration does not discard the durable copy", () => {
  /* `durable-store.js`'s `isNewer` reads `updated_at`/`updatedAt`/`ts` and falls
     back to "local wins" when either side is undated — which after a localStorage
     eviction would throw the IndexedDB copy away.
     MUTATION: drop `updatedAt` from `read()`. This fails. */
  const { log } = mk();
  log.record("boot", {});
  const blob = parse(log.storage);
  assert.equal(blob.v, DIAG_VERSION);
  assert.ok(!Number.isNaN(Date.parse(blob.updatedAt)), `not a date: ${blob.updatedAt}`);
});

test("clear() REMOVES the key and empties memory, so a purge cannot be undone", () => {
  /* Two callers, one requirement. "Delete my data" purges the tiers, and
     `stopForDataDeletion()` calls this; a `clear()` that wrote `entries: []` back
     would put a `cp_` key on a device a listener had just emptied, and one that
     left memory alone would let the next `record()` resurrect every purged row.

     MUTATION 1: replace `removeItem` with `save()`. The first assertion fails.
     MUTATION 2: leave `this._entries` populated. The third fails — the resurrected
     entry comes back. */
  const { log, store } = mk();
  log.record("seam", { fromId: "sa" });
  log.record("seam", { fromId: "sb" });
  log.clear();
  assert.equal(store.getItem(DIAG_KEY), null, "the key is gone, not emptied");
  assert.deepEqual(log.entries, []);
  log.record("seam", { fromId: "sc" });
  assert.deepEqual(log.entries.map((e) => e.fromId), ["sc"], "nothing came back");
  assert.equal(log.entries[0].seq, 3, "and the counter still says two rows once existed");
});

/* ==================================================================== */
/* 2. the privacy rule: no text, no URLs, no identity                    */
/* ==================================================================== */

test("stageOf keeps a dotted stage name and drops every word, reason and value after it", () => {
  /* THE RULE THAT MAKES THIS SAFE TO COPY OUT OF THE APP, and all three separators
     are load-bearing against real emitters.

     MUTATION 1: split on whitespace only. `player.error:` then keeps its colon,
     fails the character check, and the most important line in the stream
     contributes NO stage at all — the third assertion fails.
     MUTATION 2: drop `=` from the separator class. `rate.set=1.5` is dropped the
     same way and the fourth fails. */
  assert.equal(stageOf("seam.gap.armed 2.0s beat: sa -> sb"), "seam.gap.armed");
  assert.equal(stageOf("foray.segment.skipped.atLoad seg-x: no audio_url"), "foray.segment.skipped.atLoad");
  assert.equal(stageOf("player.error: media error 4"), "player.error");
  assert.equal(stageOf("rate.set=1.5 (was 1)"), "rate.set");
  assert.equal(stageOf("prefetch.ready sb at 500s — the next seam is a beat"), "prefetch.ready");
});

test("stageOf refuses anything outside the fixed vocabulary", () => {
  /* MUTATION: drop the `STAGE_ROOTS.has(root)` check and return `head`. The
     record then stores the leading token of ANY future message, which is how a
     URL or a listener's typed text gets in. All four of these fail. */
  assert.equal(stageOf("https://cdn.example/ep.mp3?token=abc"), null);
  assert.equal(stageOf("wjduvall@gmail.com asked for this"), null);
  assert.equal(stageOf(""), null);
  assert.equal(stageOf("a".repeat(200)), null);
});

test("a telemetry line's TEXT never reaches the record — only numbers, ids and stages", () => {
  /* The strongest single assertion in this file, and it is written as a scan of
     the serialised blob rather than a field-by-field check, because a field-by-
     field check only covers the fields somebody remembered.

     MUTATION: add `message: m` to any entry in `note()`, the obvious "while we are
     here" change. Every one of these fails. */
  const { diag, store } = mk();
  const secrets = [
    // A boundary first, so the deadline line has a seam to annotate — only a
    // boundary opens one. See `RE.deadline`.
    REAL.outPoint,
    "audio.error code=4 src=https://cdn.example/ep.mp3?token=SECRET",
    "play.rejected NotAllowedError: user gesture required for https://cdn.example/x",
    "foray.warning: listener typed SECRET into the box",
    "load.deadline 20000ms (hidden) for sb",
  ];
  for (const m of secrets) diag.note(m);
  const blob = store.getItem(DIAG_KEY);
  assert.ok(!blob.includes("SECRET"), `text leaked into the record:\n${blob}`);
  assert.ok(!blob.includes("cdn.example"), `a URL leaked into the record:\n${blob}`);
  assert.ok(!blob.includes("http"), `a scheme leaked into the record:\n${blob}`);
  // ...and the diagnostic value is still there.
  assert.ok(blob.includes("audio.error.code=4"), "the error CODE is what was wanted");
  assert.ok(blob.includes("20000"), "and so is the deadline");
});

/* ==================================================================== */
/* 3. the parse table: what each line contributes                        */
/* ==================================================================== */

/** The real strings, copied from the emitters. `diagnostic-record.test.js` is
    what proves they are still the strings the player produces. */
const REAL = {
  outPoint: "outPoint.reached target=200.00 at=200.02 overshoot=0.021s",
  itemEnded: "item.ended.outPoint sa@200s",
  armed: "seam.gap.armed 2.0s beat: sa -> sb",
  hold: "seam.gap.hold 1998ms",
  deadlineFresh: "load.deadline 20000ms (hidden) for sb",
  deadlineSeek: "load.deadline 10000ms (visible) for seek->520s",
  sameSource: "load.sameSource sb -> 520s",
  externalStop: "reconcile.externalStop why=visible — the element is paused and we said playing",
  unexplained: "audio.pausedUnexpectedly — nobody asked for this pause",
  queueEnded: "queue.ended",
};

test("the out-point's overshoot is recorded as its own row, in seconds", () => {
  /* A miss costs a median 936.5 s of the wrong episode, so this is the cheapest
     valuable number in the record.
     MUTATION: change the `overshoot=([\d.]+)s` group to match the target instead.
     `overshootSec` becomes 200 and this fails. */
  const { diag, log } = mk();
  diag.note(REAL.outPoint);
  const row = log.entries.find((e) => e.type === "outPoint");
  assert.equal(row.overshootSec, 0.021);
  assert.equal(row.targetSec, 200);
  assert.equal(row.atSec, 200.02);
});

test("the seam row carries observedGapMs, the deadline in force, and both ids", () => {
  /* THE MOST VALUABLE ROW IN THE RECORD: it is what turns "it stopped" into "the
     load took 14 s against a 20 s deadline". Driven here as the exact sequence the
     player emits, with the clock advanced by hand.

     MUTATION 1: drop the `deadlineMs` assignment from the `RE.deadline` branch —
     the deadline is the denominator and this fails.
     MUTATION 2: compute `observedGapMs` from `now()` instead of from
     `playingWall - seam.wall`. With the clock frozen the number would be 0. */
  const { diag, log, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.itemEnded);
  diag.note(REAL.armed);
  c.tick(3);
  diag.note(REAL.deadlineFresh);
  c.tick(14_019);
  diag.note(REAL.hold);
  c.tick(2);
  diag.mediaEvent("playing");

  const seam = log.entries.find((e) => e.type === "seam");
  assert.equal(seam.observedGapMs, 14_024);
  assert.equal(seam.deadlineMs, 20_000);
  assert.equal(seam.deadlineFor, "hidden");
  assert.equal(seam.askedGapMs, 2000);
  assert.equal(seam.fromId, "sa");
  assert.equal(seam.toId, "sb");
  assert.equal(seam.lastStage, "playing");
});

test("cross-episode is DERIVED, and the same-source shortcut is not counted as one", () => {
  /* 15 of Foray #1's 31 seams take the same-source seek shortcut, and #239's 20 s
     deadline is a claim about the other 16. A record that averaged the two would
     answer neither question.

     MUTATION: set `crossEpisode = true` in the `RE.deadline` branch
     unconditionally, dropping the `seek->` test. The second half fails — the
     same-source seam claims to be a cold fetch. */
  const fresh = mk();
  fresh.diag.note(REAL.outPoint);
  fresh.diag.note(REAL.deadlineFresh);
  const a = fresh.log.entries.find((e) => e.type === "seam");
  assert.equal(a.crossEpisode, true);
  assert.equal(a.toId, "sb");

  const same = mk();
  same.diag.note(REAL.outPoint);
  same.diag.note(REAL.sameSource);
  same.diag.note(REAL.deadlineSeek);
  const b = same.log.entries.find((e) => e.type === "seam");
  assert.equal(b.crossEpisode, false, "a seek inside a loaded source is not a cross-episode load");
  assert.equal(b.toId, "sb");
  assert.equal(b.deadlineMs, 10_000, "and its deadline is still recorded");
});

test("a seam that never starts stays OPEN, with the stage it reached, and is on disk", () => {
  /* THE FAILURE THIS WHOLE FEATURE EXISTS FOR. `lastStage` is the difference
     between "the beat's timer never fired" and "the load never settled", which
     are different bugs with different fixes — and the row has to be readable from
     STORAGE, because the page that would have completed it was suspended.

     MUTATION: move `log.record("seam", …)` from `_openSeam` to `_closeSeam`, the
     tidier-looking version. The record is then empty for exactly the failure it
     was built to explain, and this fails on the first assertion. */
  const { diag, store, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.armed);
  c.tick(2);
  diag.note(REAL.deadlineFresh);
  c.tick(4000);
  diag.mediaEvent("stalled");
  // The page is suspended here. Nothing else runs. Read what a founder would read.
  const seam = parse(store).entries.find((e) => e.type === "seam");
  assert.equal(seam.observedGapMs, null, "it never started");
  assert.equal(seam.lastStage, "stalled", "and it says how far it got");
  assert.equal(seam.deadlineMs, 20_000, "against the deadline in force");
  assert.deepEqual(
    seam.stages.map((s) => s.stage),
    ["outPoint.reached", "seam.gap.armed", "load.deadline", "stalled"],
    "the full trail, in order"
  );
  const text = formatDiagnosticReport(parse(store));
  assert.match(text, /NEVER STARTED/);
  /* THE TRAIL ON THE ONE LINE A FOUNDER READS, and it is not decoration.
     `lastStage` alone is defeated by anything landing inside an open seam: a
     reconcile after a stalled load makes the line read
     `last=reconcile.externalStop`, which is neither of the two diagnoses this row
     exists to separate.
     MUTATION: drop the `trail=` clause from `lineFor`. The stage trail is then only
     in the JSON, the phone-readable line says nothing about how far the load got,
     and this fails. */
  assert.match(text, /trail=.*load\.deadline > stalled/);
});

test("a stop landing inside an open seam does not hide how far the load got", () => {
  /* THE EXACT SHAPE OF THE FOUNDER'S CAR: the load stalls, the page is hidden, the
     route dies, and on becoming visible the reconcile fires — INSIDE the seam that
     never completed. Before the trail, that seam's one-line summary named the
     reconcile and nothing about the load.
     MUTATION: same as above. This fails. */
  const { diag, log, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.armed);
  diag.note(REAL.deadlineFresh);
  c.tick(6000);
  diag.mediaEvent("waiting");
  c.tick(8000);
  diag.mediaEvent("stalled");
  c.tick(21_000);
  diag.note(REAL.externalStop);
  const seam = log.entries.find((e) => e.type === "seam");
  assert.equal(seam.lastStage, "reconcile.externalStop", "the reconcile IS the last thing that happened");
  const line = formatDiagnosticReport(log.read()).split("\n").find((l) => / seam /.test(l));
  assert.match(line, /waiting > stalled/, "and the line still says the load never settled");
});

test("A CUT BEAT CLOSES THE SEAM, so a listener's pause is never measured as a gap", () => {
  /* THE WORST BUG REVIEW FOUND IN THIS CHANGE. `_cutSeamGap` fires from `_transport`
     for pause, next, previous, reconcile and dispose, so pressing pause inside the
     2.0 s beat used to leave the seam row OPEN — and then the `playing` that came ten
     minutes later measured the listener's own pause as `observedGapMs: 600000`. That
     number became the report's `worst` and dragged its median, which are the two
     headline numbers this whole change exists to produce.

     MUTATION: go back to `if (hit && this._seam) { this._seam.cutBy = hit[1]; }` with
     no `_closeSeam`. The gap reads 600000 and this fails on the first assertion. */
  const { diag, log, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.armed);
  c.tick(400);
  diag.note("seam.gap.cut.pause");
  c.tick(600_000);
  diag.mediaEvent("playing");

  const seams = log.entries.filter((e) => e.type === "seam");
  assert.equal(seams.length, 1, "one boundary, one row");
  assert.equal(seams[0].observedGapMs, null, "a beat the listener cut was never measured");
  assert.equal(seams[0].cutBy, "pause", "and the row says what ended it");
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /cut short by pause/);
  /* NOT A STALL EITHER. Counting it as one would make every listener who pauses
     mid-beat produce a failure the instrument invented. */
  assert.match(text, /seams 1: 0 measured, 0 never started, 1 cut short/);
  assert.doesNotMatch(text, /NEVER STARTED/);
});

test("a cut beat does not swallow the NEXT boundary's row", () => {
  /* THE THIRD CONSEQUENCE, and the quietest. `_openSeam` returns an already-open
     seam, so with the cut leaving the row open, the next real boundary overwrote its
     ids, deadline and asked gap — two boundaries collapsed into one row, and the seam
     count came out low. A count that under-reports is worse than no count.

     MUTATION: same as above. `seams.length` is 1 and this fails. */
  const { diag, log, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.armed);
  diag.note("seam.gap.cut.skipToNext");
  c.tick(5000);
  // The skip's own load and boundary, later in the Foray.
  diag.note("outPoint.reached target=300.00 at=300.01 overshoot=0.010s");
  diag.note("seam.gap.armed 2.0s beat: sb -> sc");
  c.tick(2100);
  diag.mediaEvent("playing");

  const seams = log.entries.filter((e) => e.type === "seam");
  assert.equal(seams.length, 2, "two boundaries, two rows");
  assert.equal(seams[0].cutBy, "skipToNext");
  assert.equal(seams[0].toId, "sb", "the cut row keeps the ids it had");
  assert.equal(seams[1].toId, "sc", "and the later boundary gets its own");
  assert.equal(seams[1].observedGapMs, 2100);
});

test("a recognised audio route is recorded as a FACT, never as its name", () => {
  /* `route.autoResume.knownCar=<name>` carries the audio route's name — a device a
     person named. This repo's own tests use "Some Headphones" and "Civic"; a real one
     says somebody's first name. It is not a number, not an authored segment id and
     not a stage name, so it is none of the three classes this record may hold — and
     this record is pasted into issues by hand.

     Latent rather than live today (no JS caller passes a route name yet; the native
     shells will), which is exactly how it would have shipped unnoticed.

     MUTATION: restore the `(\S+)` capture and `why: \`autoResume.${hit[1]}\``. The
     name appears in the blob and this fails. */
  const { diag, log, store } = mk();
  diag.note("route.autoResume.knownCar=Wyatts-Civic");
  const stop = log.entries.find((e) => e.type === "stop");
  assert.equal(stop.source, "route");
  assert.equal(stop.known, true, "the diagnostic fact survives");
  assert.equal(stop.why, "autoResume.knownRoute");
  assert.ok(
    !store.getItem(DIAG_KEY).includes("Wyatts"),
    `a device name reached the record:\n${store.getItem(DIAG_KEY)}`
  );
  assert.ok(!store.getItem(DIAG_KEY).includes("Civic"));
});

test("a caller field cannot overwrite an entry's seq, wall or type", () => {
  /* `record()` spreads `...fields` BEFORE the frame for this reason. Spread after and
     a stray `wall` silently replaces the clock that every ordering, eviction and
     cadence claim in this file rests on. Nothing collides today, which is the only
     reason it was not already a bug.
     MUTATION: move `...fields` to the end of the object literal. All three fail. */
  const { log, clock: c } = mk();
  const e = log.record("seam", { seq: 999, wall: 1, type: "notASeam", fromId: "sa" });
  assert.equal(e.seq, 1);
  assert.equal(e.wall, c.now());
  assert.equal(e.type, "seam");
  assert.equal(e.fromId, "sa", "and the legitimate field still lands");
});

test("one unrenderable row is dropped; the rest of the record still reads", () => {
  /* A row with a missing or non-numeric `wall` used to poison the record
     PERMANENTLY: `lineFor` formats `new Date(e.wall)`, which throws a RangeError, so
     the report threw, the surface said "the record could not be read", `save()`
     faithfully rewrote the bad row, and the only way out was Clear — which discards
     the evidence.

     MUTATION 1: drop the `Number.isFinite(e.wall)` guard from `_load`. `formatDiagnosticReport`
     throws and this fails.
     MUTATION 2: keep the guard but remove `clockOf`'s try/catch — that one is belt to
     these braces and is not covered here, deliberately; it exists for a row this
     guard has not thought of. */
  const store = fakeStore();
  store.map.set(DIAG_KEY, JSON.stringify({
    v: 1, cap: 200, seq: 4, dropped: 0,
    entries: [
      { seq: 1, wall: 1_700_000_000_000, type: "boot", hidden: false },
      { seq: 2, wall: "not a clock", type: "seam" },
      { seq: 3, type: "seam", fromId: "sa" },
      { seq: 4, wall: 1_700_000_001_000, type: "outPoint", overshootSec: 0.02 },
    ],
  }));
  const log = new DiagnosticLog({ storage: store, now: clock().now });
  assert.deepEqual(log.entries.map((e) => e.seq), [1, 4], "the two unrenderable rows are gone");
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /overshoot 0\.020s/, "and the readable rows still read");
  assert.match(text, /entries 2 of 200/);
});

test("reset() drops the seam in flight, so a Clear mid-playback loses nothing after it", () => {
  /* `clear()` removes the ring; this is its other half. Without it, a Clear pressed
     during playback left `_seam` pointing at an entry no longer in `entries` — so
     `_openSeam` handed that orphan back for the NEXT boundary, which was written
     outside the record and never appeared; and the orphan's next stage called
     `save()`, putting `cp_diag` back with `entries: []` one tick after `clear()`
     deliberately removed it.

     MUTATION: delete `this._seam = null` from `reset()`. The seam after the Clear is
     missing and the first assertion fails. */
  const { diag, log, store, clock: c } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.armed);
  // The founder presses Clear while a beat is in flight.
  log.clear();
  diag.reset();
  assert.equal(store.getItem(DIAG_KEY), null, "the key really went");

  // The seam that follows must land in the record like any other.
  diag.note("outPoint.reached target=300.00 at=300.01 overshoot=0.010s");
  diag.note("seam.gap.armed 2.0s beat: sb -> sc");
  c.tick(2100);
  diag.mediaEvent("playing");
  const seams = log.entries.filter((e) => e.type === "seam");
  assert.equal(seams.length, 1, "the seam after the Clear is IN the record");
  assert.equal(seams[0].toId, "sc");
  assert.equal(seams[0].observedGapMs, 2100);
});

test("a Clear mid-seam does not put the key back with an empty record", () => {
  /* The other half of the same bug, and the one that breaks a promise rather than a
     measurement: `clear()`'s own comment says it removes the key so that "Delete my
     data" does not leave a `cp_` row on a device a listener just emptied. An orphan
     seam's next stage undid exactly that.
     MUTATION: delete `this._seam = null` from `reset()`. `cp_diag` comes back and this
     fails. */
  const { diag, log, store } = mk();
  diag.note(REAL.outPoint);
  log.clear();
  diag.reset();
  diag.note(REAL.hold);          // a stage from the seam that was in flight
  assert.equal(store.getItem(DIAG_KEY), null, "no cp_ key came back");
});

test("the end of the queue is not a stall", () => {
  /* The probe makes the same distinction for the same reason: the last segment's
     out-point opens a seam nothing will ever close, and a record that left it
     open would report a failure on every healthy Foray — the instrument
     manufacturing its own finding.

     MUTATION: delete the `RE.queueEnded` branch. `endOfQueue` stays false, the
     report says NEVER STARTED, and both assertions fail. */
  const { diag, log } = mk();
  diag.note(REAL.outPoint);
  diag.note(REAL.queueEnded);
  const seam = log.entries.find((e) => e.type === "seam");
  assert.equal(seam.endOfQueue, true);
  assert.equal(seam.observedGapMs, null);
  assert.match(formatDiagnosticReport(log.read()), /end of queue/);
  assert.doesNotMatch(formatDiagnosticReport(log.read()), /NEVER STARTED/);
});

test("a natural end opens a seam too, because it emits no out-point at all", () => {
  /* A file that runs out before its authored `end_sec` produces no
     `outPoint.reached`. That seam is measured like any other.
     MUTATION: remove `if (n === "ended") this._openSeam("ended")`. No seam row
     exists and this fails. */
  const { diag, log, clock: c } = mk();
  diag.mediaEvent("ended");
  c.tick(2500);
  diag.mediaEvent("playing");
  const seam = log.entries.find((e) => e.type === "seam");
  assert.equal(seam.openedBy, "ended");
  assert.equal(seam.observedGapMs, 2500);
});

test("stages are capped inside a seam, oldest first, and the truncation is declared", () => {
  /* One pathological load can fire `waiting`/`stalled` without limit, so the entry
     is bounded as well as the ring.
     MUTATION: delete the inner `while` in `_stage`. `stages.length` grows past
     STAGE_CAP and this fails. */
  const { diag, log } = mk();
  diag.note(REAL.outPoint);
  for (let i = 0; i < STAGE_CAP + 10; i++) diag.mediaEvent("waiting");
  const seam = log.entries.find((e) => e.type === "seam");
  assert.equal(seam.stages.length, STAGE_CAP);
  assert.ok(seam.stagesDropped >= 10, `truncation must be declared, got ${seam.stagesDropped}`);
});

test("timeupdate is not a diagnostic and cannot enter the record", () => {
  /* `timeupdate` fires at 4 Hz. A record that wrote localStorage on it would be
     the instrument perturbing the measurement — `html-audio-backend.js:1534`
     names that hazard in its own words.
     MUTATION: add "timeupdate" to MEDIA_STAGES. Both assertions fail. */
  const { diag, store } = mk();
  diag.note(REAL.outPoint);
  const before = store.writes;
  for (let i = 0; i < 50; i++) assert.equal(diag.mediaEvent("timeupdate"), false);
  assert.equal(store.writes, before, "fifty ticks wrote nothing");
  assert.ok(!MEDIA_STAGES.has("timeupdate"));
});

/* ==================================================================== */
/* 4. external stops, visibility, resume                                 */
/* ==================================================================== */

test("an external stop is recorded, and the state it landed in is filled in afterwards", () => {
  /* #266 gave the player an `interrupted` state; this records when it lands and
     why. The telemetry line is emitted BEFORE the reducer runs, so stamping the
     state at emit time would record `playing` — a fact about to stop being true.

     MUTATION 1: stamp the state inside the `RE.externalStop` branch. `state`
     reads "playing" and the second assertion fails.
     MUTATION 2: make `reconciled()` fill ANY pending stop rather than matching on
     `why`. The last block fails — a correction the BACKEND made (`why=
     unexplainedPause`, raised from `onUnexplainedPause` inside the player, where
     no caller can read the landed state) would be stamped with the state a LATER
     visibility reconcile happened to see. That is a wrong fact in the record,
     which is worse than a missing one. */
  const { diag, log } = mk();
  diag.note(REAL.externalStop);
  const stop = log.entries.find((e) => e.type === "stop");
  assert.equal(stop.source, "reconcile");
  assert.equal(stop.why, "visible");
  assert.equal(stop.state, null, "not knowable at emit time");
  diag.reconciled("visible", "interrupted");
  assert.equal(stop.state, "interrupted");
  assert.equal(diag.reconciled("visible", "idle"), null, "nothing left to settle");

  const other = mk();
  other.diag.note("reconcile.externalStop why=unexplainedPause — the element is paused");
  const inner = other.log.entries.find((e) => e.type === "stop");
  assert.equal(other.diag.reconciled("visible", "idle"), null, "a different trigger is a different stop");
  assert.equal(inner.state, null, "the backend's own correction is left unstamped, not mis-stamped");
});

test("a visibility transition carries the LENGTH of the state it just left", () => {
  /* The duration is the point. #239's hidden deadline and the probe's ~26 s
     suspension ceiling are both claims about how long a page survives hidden, and
     neither is checkable against a stall unless the window's length is in the
     same record as the stall.

     MUTATION: drop `forMs` (or reset `_visSince` before computing it). The
     hidden window's length becomes 0 or null and this fails — a hidden window
     would have to be guessed at, which is the state #264 describes. */
  const { diag, log, clock: c } = mk();
  diag.boot();
  c.tick(4000);
  diag.visibility(true);
  c.tick(93_000);
  diag.visibility(false);
  const [toHidden, toVisible] = log.entries.filter((e) => e.type === "visibility");
  assert.equal(toHidden.to, "hidden");
  assert.equal(toHidden.forMs, 4000, "how long it had been visible");
  assert.equal(toVisible.to, "visible");
  assert.equal(toVisible.forMs, 93_000, "and how long it was hidden");
});

test("a resume decision records what was written — and the refusal, which is the defect", () => {
  /* The second field report was a WRONG RESUME, and the path that declines to
     write is the path with no record of what it did.
     MUTATION: record only successful writes. The refusal row disappears and this
     fails. */
  const { diag, log } = mk();
  diag.resumeWrite({ forayId: "f1", index: 12, wrote: true, elapsedSec: 1240, segmentId: "sm", intoSec: 41 });
  diag.resumeWrite({ forayId: "f1", index: 13, wrote: false, why: "playhead-unknown" });
  diag.resumeStart({ forayId: "f1", requestedElapsedSec: 1240, index: 12, segmentId: "sm", intoSec: 41 });
  const rows = log.entries.filter((e) => e.type === "resume");
  assert.deepEqual(rows.map((r) => r.phase), ["write", "write", "start"]);
  assert.equal(rows[1].wrote, false);
  assert.equal(rows[1].why, "playhead-unknown");
  assert.equal(rows[2].requestedElapsedSec, 1240);
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /why=playhead-unknown/, "and it is legible in the surface, not only in the JSON");
});

test("a surface whose isHidden throws does not stop the record", () => {
  /* `html-audio-backend.js`'s `_loadDeadlineMs` guards the same call for the same
     reason. MUTATION: remove the try/catch in `_isHidden` — `record()` throws
     out of the player's telemetry hook and this fails. */
  const log = new DiagnosticLog({ storage: fakeStore(), now: clock().now });
  const diag = new PlayerDiagnostics({ log, isHidden: () => { throw new Error("detached"); } });
  assert.doesNotThrow(() => diag.note(REAL.outPoint));
  assert.equal(log.entries.find((e) => e.type === "outPoint").hidden, false);
});

/* ==================================================================== */
/* 5. the report a founder reads                                         */
/* ==================================================================== */

test("the report states the cap and the eviction rule on its own face", () => {
  /* A short log must never be ambiguous between a quiet drive and a full ring.
     MUTATION: drop the cap/dropped line from the header. This fails. */
  const { log, diag } = mk({ cap: 3 });
  diag.boot();
  for (let i = 0; i < 5; i++) log.record("seam", {});
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /entries 3 of 3 \(oldest dropped first\)/);
  assert.match(text, /dropped 3/);
  assert.match(text, /Local only\. Nothing here is sent anywhere\./);
});

test("the report summarises the seams, so the answer is on the first screen", () => {
  /* A phone in a car shows about fifteen lines. The counts and the worst gap have
     to be above the rows, or the record is copied and read later — which is the
     round trip #264 exists to remove.
     MUTATION: compute the median off the unsorted array. With gaps 9000, 2100,
     14000 the median reads 2100 and this fails. */
  const { diag, log, clock: c } = mk();
  for (const ms of [9000, 2100, 14_000]) {
    diag.note(REAL.outPoint);
    c.tick(ms);
    diag.mediaEvent("playing");
  }
  diag.note(REAL.outPoint);      // a fourth seam that never starts
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /seams 4: 3 measured, 1 never started/);
  assert.match(text, /median 9000ms/);
  assert.match(text, /worst 14000ms/);
});

test("an empty record says so rather than showing a blank box", () => {
  /* A blank box reads as "nothing went wrong" when it can also mean "nothing was
     recorded". MUTATION: return early with "" for an empty record. This fails. */
  const { log } = mk();
  assert.match(formatDiagnosticReport(log.read()), /Nothing recorded yet/);
  assert.match(formatDiagnosticReport(null), /Nothing recorded yet/);
});

/* ==================================================================== */
/* 6. a tap the page saw fail (#225)                                    */
/* ==================================================================== */

test("a failed tap is an ENTRY, so a first tap with no seam still leaves evidence", () => {
  /* THE WHOLE REASON `tapFailed` EXISTS, and the trap it was written around.
     #225 is a FIRST tap: nothing has played, so no seam has ever been opened —
     and `_stage` returns early when there is no seam in flight. Routed through
     `note()` like every other line in this record, the one tap the record exists
     to explain would contribute exactly nothing.

     MUTATION: make `tapFailed` call `this._stage("foray.tap.failed")` instead of
     `this.log.record(...)`. The ring stays empty and the first assertion fails,
     which is how this defect would otherwise have shipped looking correct. */
  const { diag, store } = mk();
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });

  const entries = parse(store).entries;
  assert.equal(entries.length, 1, "a failed first tap has to survive as its own entry");
  assert.equal(entries[0].type, "tapFail");
  assert.equal(entries[0].phase, "start");
  assert.equal(entries[0].error, "NotAllowedError");
  assert.equal(entries[0].seq, 1, "and it is sequenced like everything else in the ring");
});

test("the phase is one of two words, and anything else is normalised rather than stored", () => {
  /* The phase is the one thing only the PAGE knows — whether the tap got nowhere
     or failed over audio already playing. It is a vocabulary word, so it obeys the
     same rule as a stage name: never data.

     MUTATION: store `String(phase)` without the `TAP_PHASES` check. The third
     entry keeps the caller's text and this fails — and a caller of another vintage
     could put a Foray id into a record built to be pasted into an issue. */
  const { diag, store } = mk();
  diag.tapFailed({ phase: "start", name: "TypeError" });
  diag.tapFailed({ phase: "control", name: "TypeError" });
  diag.tapFailed({ phase: "segment 4 of grilling-history-1", name: "TypeError" });

  assert.deepEqual(parse(store).entries.map((e) => e.phase), ["start", "control", "start"]);
});

test("an error NAME is kept and an error MESSAGE is refused", () => {
  /* The privacy rule of §2, applied to the one field #225 adds. A `.name` is a
     closed vocabulary and answers the only question asked of it — was the browser
     refusing, or did the code break. A `.message` carries prose and URLs.

     MUTATION: drop the character check and return the trimmed string. Every
     assertion from the third down fails. */
  assert.equal(errorNameOf("NotAllowedError"), "NotAllowedError");
  assert.equal(errorNameOf("TypeError"), "TypeError");

  assert.equal(errorNameOf("load failed (code 4) for https://cdn.test/a.mp3"), null);
  assert.equal(errorNameOf("player.forayJump is not a function"), null);
  assert.equal(errorNameOf("play.rejected"), null, "a dotted stage name is not an error name");
  assert.equal(errorNameOf(""), null);
  assert.equal(errorNameOf(null), null);
  assert.equal(errorNameOf("A".repeat(49)), null, "and it is bounded like a stage name");
});

test("a failure with no error class is recorded as one rather than as a blank", () => {
  /* A rejection carrying nothing is a real outcome, and a different finding from a
     field that was never written — a reader who sees a gap will assume the second.

     THE ASSERTION IS ON THE STORED ENTRY, NOT ON THE REPORT, and that distinction
     is the entire value of this test. `lineFor` renders `e.error ?? "none"`, so a
     MISSING key and a null one produce the identical line. The first draft of this
     test asserted only the report text, and the mutation below SURVIVED it — the
     report cannot tell the two apart, and only the JSON a founder pastes can. Kept
     as written because it is the clearest example in this file of a green test
     pinning nothing.

     MUTATION: omit the `error` key when the name is null —
     `...(errorNameOf(name) ? { error: errorNameOf(name) } : {})`. The `in` check
     below fails; the `match` at the bottom does not. */
  const { diag, store, log } = mk();
  diag.tapFailed({ phase: "control" });

  const entry = parse(store).entries[0];
  assert.ok("error" in entry, "the field is written even with no class, so a reader can tell it was asked");
  assert.equal(entry.error, null);
  assert.match(formatDiagnosticReport(log.read()), /control failed\s+error=none/);
});

test("the report names a failed tap in words rather than dumping its JSON", () => {
  /* This is the surface a founder reads ON A PHONE, so an entry that falls through
     to `lineFor`'s `default` is a brace-and-quote blob in a panel about 340 px wide.

     MUTATION: delete the `tapFail` case from `lineFor`. The default branch
     JSON-stringifies the entry and the second assertion fails. */
  const { diag, log } = mk();
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });
  const line = formatDiagnosticReport(log.read()).split("\n").find((l) => l.includes("tapFail"));

  assert.match(line, /start failed\s+error=NotAllowedError/);
  assert.ok(!line.includes("{"), `the report is read, not parsed: ${line}`);
});
