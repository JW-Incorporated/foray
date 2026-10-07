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
  DiagnosticLog, PlayerDiagnostics, formatDiagnosticReport, stageOf, errorNameOf, tapPhaseOf,
  DIAG_KEY, DIAG_CAP, STAGE_CAP, DIAG_VERSION, MEDIA_STAGES,
  dataTokenOf, dataVersionOf, dataFileTagOf, dataIdOf, DATA_PHASES, DATA_SOURCES,
  nowPlayingFieldOf, NOWPLAYING_FIELD_MAX, NOWPLAYING_VIA, SESSION_KINDS, SESSION_PRODUCERS,
  TRANSPORT_SOURCES, TRANSPORT_ACTIONS, REMOTE_COMMANDS, REMOTE_ORIGINS,
  NARRATION_FALLBACK_REASONS, NARRATION_FALLBACK_AT, audioHostTokenOf, DOWNLOAD_OUTCOMES,
} from "./diagnostic-log.js";
/* The REAL store for the held-write tests below: whether a row written before a
   slow hydration overwrites the durable ring is a fact about `DurableStore`'s
   first-writer rule, and a fake that did not have that rule would prove nothing. */
import { DurableStore, localStorageTier } from "./durable-store.js";

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
  assert.equal(stageOf("seam.gap.armed 0.5s beat: sa -> sb"), "seam.gap.armed");
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
  armed: "seam.gap.armed 0.5s beat: sa -> sb",
  hold: "seam.gap.hold 498ms",
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
  assert.equal(seam.askedGapMs, 500);
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
     seam beat used to leave the seam row OPEN — and then the `playing` that came ten
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
  diag.note("seam.gap.armed 0.5s beat: sb -> sc");
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
  diag.note("seam.gap.armed 0.5s beat: sb -> sc");
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

test("a phase that answers differently each time it is read cannot smuggle text in", () => {
  /* THE HOLE REVIEW FOUND IN THE FIRST DRAFT OF THIS FEATURE, and it is the
     reason `asText` exists. That draft read `String(phase)` once for the
     vocabulary check and a second time for the value it stored, so an object
     whose `toString` answered "control" first and a URL afterwards passed the
     gate and was stored anyway — straight into the report a founder pastes into
     an issue. `window.forayNoteTapFailure` is a public global on a page with no
     import boundary, so "a caller of another vintage" is this record's stated
     threat model, not a hypothetical.

     MUTATION: restore `TAP_PHASES.has(String(phase)) ? String(phase) : "start"`.
     The smuggled string is stored and both of the last two assertions fail. */
  const twoFaced = () => {
    let reads = 0;
    return { toString() { reads += 1; return reads === 1 ? "control" : "https://cdn.test/a.mp3?token=SECRET"; } };
  };

  assert.equal(tapPhaseOf(twoFaced()), "control", "coerced once, so the checked value IS the returned value");

  const { diag, store } = mk();
  diag.tapFailed({ phase: twoFaced(), name: "TypeError" });

  const stored = parse(store).entries[0].phase;
  assert.equal(stored, "control");
  assert.ok(!stored.includes("cdn.test"), `a record built to be pasted into an issue must not carry this: ${stored}`);
});

test("a value that refuses to become text is dropped rather than thrown", () => {
  /* `String(v)` runs `v.toString()`, which can throw — and both sanitisers run
     inside `app.js`'s two failure guards, where a throw is precisely the outage
     this record was built to explain. A record that took the page down would be
     the instrument destroying the measurement.

     MUTATION: drop the try/catch in `asText` and return `String(v ?? "")`. Every
     call below throws and this fails. */
  const hostile = { toString() { throw new Error("no"); } };

  assert.equal(errorNameOf(hostile), null);
  assert.equal(tapPhaseOf(hostile), "start");

  const { diag, store } = mk();
  diag.tapFailed({ phase: hostile, name: hostile });
  assert.deepEqual(parse(store).entries.map((e) => [e.phase, e.error]), [["start", null]]);
});

test("a mashed dead button does not evict the seams that explain why it is dead", () => {
  /* THE FOUNDER'S REPORT IS A MASHED BUTTON: a play control that does nothing
     gets pressed again, and again. Uncoalesced, ~200 taps clear a 200-entry ring
     — measured at 200 of 200 seam entries dropped — so the failure destroys its
     own evidence, and it does it exactly when the `control` phase says a drive
     was already underway.

     MUTATION: delete the coalescing branch so every tap calls `log.record(...)`.
     The ring fills with tapFail rows, the seam is evicted, and the first three
     assertions fail. */
  const { diag, log, store } = mk({ cap: 8 });
  log.record("seam", { fromId: "sa", toId: "sb", observedGapMs: 2000 });
  for (let i = 0; i < 50; i++) diag.tapFailed({ phase: "start", name: "NotAllowedError" });

  const entries = parse(store).entries;
  assert.equal(entries.length, 2, "one seam, one coalesced failure");
  assert.equal(entries[0].type, "seam", "the seam that explains the failure outlives it");
  assert.equal(entries[1].repeated, 50, "and the count is the evidence, not fifty identical rows");
  /* MUTATION: drop the `x${e.repeated}` clause from `lineFor`. This fails, and the
     one surface a founder reads would say a dead button was pressed once. */
  assert.match(formatDiagnosticReport(log.read()), /start failed\s+error=NotAllowedError\s+x50/);
});

test("today's failed taps are never folded into YESTERDAY's entry", () => {
  /* THE DEFECT REVIEW FOUND IN THE FIRST VERSION OF COALESCING, and the reason it
     anchors on identity rather than on the tail's shape.

     The ring is DURABLE. A new session's `PlayerDiagnostics` loads the previous
     session's entries verbatim, and a failed tap that lands before `boot()` has
     written its row sees yesterday's matching `tapFail` sitting at the tail. Shape
     matching folded today's taps into it — keeping YESTERDAY's `wall` and `seq` —
     so a drive on which the play button failed left no row, no clock and no
     sequence number of its own. A button that failed yesterday with
     `NotAllowedError` and fails again today is precisely this feature's case, so
     that was the likely path, not the exotic one.

     MUTATION: match on the tail's fields —
     `last.type === "tapFail" && last.phase === phaseName && last.error === error`
     — instead of on `this._lastTap`. Today's entry is never created and every
     assertion below fails.

     It also fixes the second head of the same defect: a restored row carries no
     live `repeated` binding, and `+= 1` on a missing field yields NaN. */
  const store = fakeStore();
  const c = clock();

  // Yesterday: a session that ended with a coalesced run of failed taps.
  const first = new PlayerDiagnostics({ log: new DiagnosticLog({ storage: store, now: c.now }), now: c.now });
  first.tapFailed({ phase: "start", name: "NotAllowedError" });
  first.tapFailed({ phase: "start", name: "NotAllowedError" });
  assert.equal(parse(store).entries.length, 1, "yesterday coalesced normally");

  // Today: a NEW instance over the SAME durable store, same failure.
  c.tick(15 * 60 * 60 * 1000);
  const today = new PlayerDiagnostics({ log: new DiagnosticLog({ storage: store, now: c.now }), now: c.now });
  today.tapFailed({ phase: "start", name: "NotAllowedError" });
  today.tapFailed({ phase: "start", name: "NotAllowedError" });

  const entries = parse(store).entries;
  assert.equal(entries.length, 2, "today gets its own row rather than incrementing yesterday's");
  assert.equal(entries[0].repeated, 2);
  assert.equal(entries[1].repeated, 2);
  assert.ok(entries[1].wall > entries[0].wall, "and its own clock");
  assert.ok(entries[1].seq > entries[0].seq, "and its own sequence number");
  assert.ok(Number.isFinite(entries[1].repeated), "a restored row never turns a count into NaN");
});

test("a cleared record does not leave a counter pointing at an entry that is gone", () => {
  /* `reset()`'s own stated reason, applied to the new state: a Clear during
     playback drops the ring, and what is in flight has to go with it.

     BE PRECISE ABOUT WHAT THIS PINS, because mutation testing showed the obvious
     version of this test pinned nothing. Removing `this._lastTap = null` from
     `reset()` changes NO behaviour reachable from the public surface: the
     coalescing branch requires `this._lastTap === entries[entries.length - 1]`,
     and an orphan from a cleared ring can never again be the tail of it, so the
     identity check already makes the behavioural assertions below pass either
     way. Those assertions are still worth having — they are the property a reader
     cares about — but the invariant assertion is the one that kills the mutant,
     and it is white-box on purpose, because the line is defence in depth for a
     class whose `_seam` and `_stop` are cleared beside it for the same reason.

     MUTATION: remove `this._lastTap = null` from `reset()`. Only the middle
     assertion fails. */
  const { diag, log, store } = mk();
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });

  log.clear();
  diag.reset();

  assert.equal(diag._lastTap, null, "nothing in flight survives a Clear");

  diag.tapFailed({ phase: "start", name: "NotAllowedError" });
  const entries = parse(store).entries;
  assert.equal(entries.length, 1, "one entry, belonging to the record that exists now");
  assert.equal(entries[0].repeated, 1, "counting from one, not continuing an evicted run");
});

test("a coalesced run says how long it went on, not only how many times", () => {
  /* `x50` alone cannot separate a hand mashing a dead button from a listener
     returning to it four times across five minutes, and those are different bugs.
     The FIRST `wall` stays the entry's stamp — it is when the failure began, and
     it is what keeps this row ordered against the seam rows that explain it — so
     the end of the run needs its own field.

     MUTATION: stop writing `lastWall` on a repeat. The report loses "over …" and
     the last assertion fails. */
  const { diag, log, store } = mk();
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });

  const entry = parse(store).entries[0];
  assert.equal(entry.repeated, 2);
  assert.equal(entry.lastWall, entry.wall, "same instant here, because the clock did not move");

  // And a run that spans real time reports the span.
  const store2 = fakeStore();
  const c = clock();
  const d2 = new PlayerDiagnostics({ log: new DiagnosticLog({ storage: store2, now: c.now }), now: c.now });
  d2.tapFailed({ phase: "start", name: "NotAllowedError" });
  c.tick(9400);
  d2.tapFailed({ phase: "start", name: "NotAllowedError" });

  const log2 = new DiagnosticLog({ storage: store2, now: c.now });
  assert.match(formatDiagnosticReport(log2.read()), /x2 over 9400ms/);
});

test("a different failure starts a new entry, so a coalesced count always means one thing", () => {
  /* A count is only readable if a run means "this, n times, with nothing else in
     between". MUTATION: coalesce on `type` alone, ignoring phase and error. All
     of these collapse into one row and this fails — and "x5" would then mean five
     unrelated failures, which is worse evidence than no count at all. */
  const { diag, store } = mk();
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });
  diag.tapFailed({ phase: "start", name: "NotAllowedError" });
  diag.tapFailed({ phase: "start", name: "TypeError" });      // a different class
  diag.tapFailed({ phase: "control", name: "TypeError" });    // a different phase
  diag.visibility(true);                                      // and something else entirely
  diag.tapFailed({ phase: "control", name: "TypeError" });

  const taps = parse(store).entries.filter((e) => e.type === "tapFail");
  assert.deepEqual(taps.map((e) => [e.phase, e.error, e.repeated]), [
    ["start", "NotAllowedError", 2],
    ["start", "TypeError", 1],
    ["control", "TypeError", 1],
    ["control", "TypeError", 1],
  ], "a run is broken by a different failure OR by anything else reaching the ring");
});

/* ==================================================================== */
/* 7. search (S-01, docs/search-plan.md)                                 */
/* ==================================================================== */

test("a search entry records query LENGTH, never the query text", () => {
  /* THE WHOLE POINT OF THE ENTRY, per docs/search-plan.md S-01 and this
     file's own "WHAT IS NEVER RECORDED" rule. MUTATION: store `query`
     verbatim on the entry instead of (or as well as) `qLen`. Scanning the
     stored blob for the literal query text catches either. */
  const { diag, store } = mk();
  diag.search({ qLen: 4, localMs: 0.05, localHits: 3, netMs: 210, netHits: 5, paintedMs: 12, path: "local+net" });
  const entry = parse(store).entries.find((e) => e.type === "search");
  assert.equal(entry.qLen, 4);
  const blob = JSON.stringify(entry);
  assert.ok(!/lex|radiolab|science/i.test(blob), "no recognisable query text may appear in the stored entry");
});

test("a search entry's numeric fields are guarded — a non-numeric caller value is dropped to null, never stored raw", () => {
  /* MUTATION: store the raw argument instead of running it through the
     Number.isFinite guard. A caller that passes the query string into
     qLen by mistake (an easy transposition at the app.js call site) would
     then store the string itself, defeating the guarantee above. */
  const { diag, store } = mk();
  diag.search({ qLen: "lex", localMs: NaN, localHits: undefined, netMs: null, netHits: Infinity, paintedMs: 5, path: 123 });
  const entry = parse(store).entries.find((e) => e.type === "search");
  assert.equal(entry.qLen, null);
  assert.equal(entry.localMs, null);
  assert.equal(entry.localHits, null);
  assert.equal(entry.netMs, null);
  assert.equal(entry.netHits, null, "Infinity is not finite and must not be stored");
  assert.equal(entry.paintedMs, 5, "a genuinely finite number must still pass through");
  assert.equal(entry.path, null, "a non-string path must not be stored");
});

test("a search entry with no paint timing yet stores paintedMs: null rather than omitting the field or erroring", () => {
  /* \"Absence is a real state\", this file's own rule applied to a caller
     that has not wired paint timing yet (e.g. the network-only half of a
     probe run). MUTATION: throw or omit the key when paintedMs is absent. */
  const { diag, store } = mk();
  diag.search({ qLen: 3, localMs: 0.1, localHits: 1 });
  const entry = parse(store).entries.find((e) => e.type === "search");
  assert.equal(entry.paintedMs, null);
  assert.ok("paintedMs" in entry, "the key must be present even when null");
});

test("formatDiagnosticReport renders a search entry's fields on one legible line", () => {
  /* This is the surface a founder actually copies out — the doc's own
     acceptance line requires a diagnostics copy carrying \"at least one
     search entry with a non-null painted_ms\", so that number has to be
     visible on this text, not only reachable via JSON.parse.
     MUTATION: drop paintedMs (or any other field) from lineFor's \"search\"
     case. The corresponding substring assertion fails. */
  const { diag, log } = mk();
  diag.search({ qLen: 4, localMs: 0.05, localHits: 3, netMs: 210, netHits: 5, paintedMs: 12, path: "local+net" });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /qLen=4/);
  assert.match(text, /local=0ms\/3h/);
  assert.match(text, /net=210ms\/5h/);
  assert.match(text, /painted=12ms/);
  assert.match(text, /path=local\+net/);
});

test("the search entry speaks this file's ONE vocabulary: camelCase keys, and `hidden` like every other row", () => {
  /* Client audit 2026-09-12. This row shipped as the only snake_case entry in
     the file and the only one omitting `hidden` — so a founder reading a pasted
     record had to know which card wrote which row before they could name a
     field, and a slow search could not be told apart from a slow search in a
     BACKGROUNDED tab whose timers were throttled.

     `dirMs`/`dirHits` joined the list for P-02 (docs/search-parity-plan.md):
     the Apple DIRECTORY pass is a second request to `api/shows/search` and the
     slowest of the show passes by construction, so it gets its own pair rather
     than being folded into `netMs` — the two fail independently, and "search
     took 900 ms" is a different finding depending on which pass spent it. This
     assertion is exactly the guard that caught them arriving, which is what it
     is for.

     MUTATION: put `q_len:`/`local_ms:` back, or drop `hidden: this._isHidden()`
     from `search()`. Either turns this red, and the `no_snake` sweep below is
     what stops a later field arriving in the old dialect. */
  const { diag, store } = mk();
  diag.search({ qLen: 4, localMs: 0.05, localHits: 3, netMs: 210, netHits: 5, dirMs: 470, dirHits: 12, epMs: 480, epHits: 2, ctaMs: 1600, paintedMs: 12, path: "local+net" });
  const entry = parse(store).entries.find((e) => e.type === "search");
  assert.equal(entry.hidden, false, "`hidden` is recorded, exactly as voiceProbe/nowplaying record it");
  const snake = Object.keys(entry).filter((k) => k.includes("_"));
  assert.deepEqual(snake, [], `no snake_case key may survive on this entry: ${snake.join(", ")}`);
  assert.deepEqual(
    Object.keys(entry).filter((k) => !["type", "t", "seq", "wall"].includes(k)).sort(),
    ["ctaMs", "dirHits", "dirMs", "epHits", "epMs", "hidden", "localHits", "localMs", "netHits", "netMs", "paintedMs", "path", "qLen"],
    "the whole vocabulary, named once here so a new field cannot arrive unnoticed",
  );
  assert.equal(entry.dirMs, 470, "the directory pass's own timing is stored, not merged into netMs");
  assert.equal(entry.dirHits, 12);
});

test("the search entry measures the EPISODES endpoint and the playlist CTA's scan, not only the shows half", () => {
  /* Client audit 2026-09-12, findings 2 and 4. `createPlaylistCtaHtml` runs the
     same 1.3-8 s relaxation scan `buildPlaylist` does, behind a `setTimeout(0)`
     that bought one paint turn and then blocked the main thread for seconds —
     and `api/episodes/search` (the slower of the two endpoints) was fired on
     every debounce tick with nothing measuring it. Neither could appear in the
     one record built to measure search, so neither could be seen.

     MUTATION: drop `epMs`/`epHits`/`ctaMs` from `search()`, or from `lineFor`'s
     case. The entry assertions or the line assertions go red. */
  const { diag, log, store } = mk();
  diag.search({ qLen: 7, localMs: 0.2, localHits: 0, netMs: 0, netHits: 8, epMs: 910, epHits: 4, ctaMs: 3200, paintedMs: 1, path: "local+cache" });
  const entry = parse(store).entries.find((e) => e.type === "search");
  assert.equal(entry.epMs, 910);
  assert.equal(entry.epHits, 4);
  assert.equal(entry.ctaMs, 3200, "a three-second main-thread scan is the number this field exists to expose");
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /ep=910ms\/4h/);
  assert.match(text, /cta=3200ms/);
  assert.match(text, /hidden=n/);
});

test("formatDiagnosticReport renders a null search field as an em dash, not \"null\" or a blank", () => {
  /* MUTATION: interpolate `e.path` directly instead of through the `n()`
     helper. A null path would print the literal string \"null\", which is
     legible but wrong -- and this repo's own convention elsewhere (ms(),
     lineFor's other cases) is the em dash for \"not recorded\". */
  const { diag, log } = mk();
  diag.search({ qLen: 2 });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /path=—/);
  assert.doesNotMatch(text, /path=null/);
});

/* ==================================================================== */
/* the data entry (FD-01)                                                */
/* ==================================================================== */

test("a data entry admits sources, statuses, versions and ids by vocabulary or shape, and nothing else", () => {
  /* The row that names where `forays.json` came from. Every field is a member of
     a fixed set or a token by shape — the same rule as `STAGE_ROOTS` and
     `errorNameOf` — so a validation REASON (prose naming a file) cannot ride in
     under any field.
     MUTATION: return `asText(v)` from `dataTokenOf`. The sentence passed as
     `code` below lands in the ring; the `code` assertion is red. */
  const { diag, log } = mk();
  const e = diag.dataSource({
    phase: "boot", trigger: "boot", status: "cache", source: "cache", version: "9fc92a61a8896278",
    code: "Foray x: segment y is not in data/segments.json", forayId: "capital-types-1",
    forays: 5, playable: "5",
    files: { forays: "cache@9fc92a61a8896278", segments: "https://evil.test/x", sources: "absent" },
  });
  assert.equal(e.type, "data");
  assert.equal(e.phase, "boot");
  assert.equal(e.source, "cache");
  assert.equal(e.version, "9fc92a61a8896278");
  assert.equal(e.code, null, "a sentence is not a code");
  assert.equal(e.forayId, "capital-types-1");
  assert.equal(e.forays, 5);
  assert.equal(e.playable, null, "a string count is dropped, not coerced");
  assert.deepEqual(e.files, { forays: "cache@9fc92a61a8896278", sources: "absent" }, "a URL is not a file tag");
  assert.equal(log.read().entries.at(-1).type, "data", "and it is in the ring");

  const junk = diag.dataSource({ phase: "reboot", source: "disk", status: "Adopted!", version: "v 1" });
  assert.equal(junk.phase, null);
  assert.equal(junk.source, null);
  assert.equal(junk.status, null);
  assert.equal(junk.version, null);

  assert.equal(dataVersionOf("unknown"), "unknown");
  assert.equal(dataVersionOf("deploy/1"), null);
  assert.equal(dataTokenOf("segment-missing"), "segment-missing");
  assert.equal(dataTokenOf("segment missing"), null);
  assert.equal(dataIdOf("grilling-history-1"), "grilling-history-1");
  assert.equal(dataIdOf("has space"), null);
  assert.equal(dataFileTagOf("bundle@unknown"), "bundle@unknown");
  assert.equal(dataFileTagOf("disk@abc"), null, "the source half is from the vocabulary");
  assert.equal(dataFileTagOf("bundle@a b"), null, "the version half is by shape");
  assert.ok(DATA_PHASES.has("stale-shell") && DATA_SOURCES.has("sw-cache"), "the web's pinned path has words");
});

test("formatDiagnosticReport renders a data entry as one line naming the source of each file", () => {
  /* FD-01's done-when: a Playback-diagnostics copy from a phone NAMES the source
     of `forays.json`. MUTATION: delete the `data` case from `lineFor`. The default
     branch prints a JSON blob and the substring assertions are red. */
  const { diag, log } = mk();
  diag.dataSource({
    phase: "boot", source: "bundle", version: "unknown", forays: 5,
    files: { forays: "bundle@unknown", segments: "bundle@unknown", sources: "bundle@unknown" },
  });
  diag.dataSource({
    phase: "refresh", trigger: "foreground", status: "invalid", version: "deploy-b2",
    code: "segment-missing", forayId: "fd-broken",
  });
  diag.dataSource({ phase: "refresh", trigger: "boot", status: "adopted", version: "deploy-b2", forays: 6, playable: 40, ms: 812 });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /data\s+boot source=bundle v=unknown forays=bundle@unknown segments=bundle@unknown sources=bundle@unknown n=5/);
  assert.match(text, /data\s+refresh\(foreground\) invalid v=deploy-b2 why=segment-missing foray=fd-broken/);
  assert.match(text, /data\s+refresh\(boot\) adopted v=deploy-b2 n=6 playable=40 took 812ms/);
  assert.doesNotMatch(text, /\{"/, "no JSON blob for a known type");
});

/* ==================================================================== */
/* K-01: the voice-engine probe row (docs/bundled-voice-plan.md)         */
/* ==================================================================== */

test("voiceProbe takes only the named fields — a native payload cannot bloat the ring", () => {
  /* The ring re-serialises itself on EVERY write (this module's cost note), so
     a field carried into an entry is re-written up to 200 more times. The probe
     record arrives from `player/kokoro-probe.js` already flattened; naming the
     fields again here is what stops a future native addition from riding in.
     MUTATION: spread the record instead of picking — `junk` appears in the
     stored blob. */
  const { diag, store } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, provider: "cpu", model: "1.0",
    modelLoadColdMs: 1800, modelLoadWarmMs: 90, rtfCold: 0.9, rtfWarm: 0.6,
    audioSec: 77.4, peakMemoryMb: 300, lockedScreenCompleted: true, batteryDeltaPct: -3,
    junk: "x".repeat(5000),
  });
  const blob = store.getItem(DIAG_KEY);
  assert.ok(!blob.includes("junk"), "an unnamed field entered the ring");
  const e = parse(store).entries.at(-1);
  assert.equal(e.type, "voiceProbe");
  assert.equal(e.probeOk, true);
  assert.equal(e.rtfWarm, 0.6);
  assert.equal(e.lockedOk, true);
});

test("voiceProbe stores a refusal as null numbers, not zeroes", () => {
  /* THE LIE THIS ROW EXISTS TO AVOID. A build with no model writing `rtf 0.00,
     peak 0 MB, locked=y` is a record that gets pasted into a decision.
     MUTATION: coerce the numeric fields with `|| 0`. */
  const { diag, store } = mk();
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, reason: "model-absent" });
  const e = parse(store).entries.at(-1);
  assert.equal(e.probeOk, false);
  assert.equal(e.reason, "model-absent");
  assert.equal(e.rtfWarm, null);
  assert.equal(e.peakMemoryMb, null);
  assert.equal(e.lockedOk, false);
});

test("the report prints a probe refusal as one line naming the reason", () => {
  /* Six em-dashes and a hidden reason is not a report. The founder's next
     action is entirely determined by WHICH refusal this is.
     MUTATION: fall through to the `default` JSON.stringify branch — the line
     becomes a blob nobody reads aloud over a phone. */
  const { diag, log } = mk();
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, reason: "engine-absent" });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /voiceProbe kokoro-probe could not measure: engine-absent/);
});

test("the report prints a successful probe with every number K-01 asks for", () => {
  /* MUTATION: drop any of rtf / load / peak / locked / batt from the line —
     the field then exists only in the JSON, and the JSON is not what gets
     pasted into an issue. */
  const { diag, log } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, provider: "coreml", model: "1.0",
    modelLoadColdMs: 1840, modelLoadWarmMs: 120, rtfCold: 0.94, rtfWarm: 0.61,
    audioSec: 77.4, peakMemoryMb: 312, lockedScreenCompleted: true, batteryDeltaPct: -3,
    /* The shape K-01 was written expecting and no build has yet produced: an
       accelerator EP and seconds the phone actually rendered. */
    audioFrom: "rendered", acceleratorWired: true,
  });
  const line = formatDiagnosticReport(log.read()).split("\n").find((l) => l.includes("voiceProbe"));
  assert.match(line, /kokoro-probe\/coreml/);
  assert.match(line, /rtf cold 0\.94 warm 0\.61/);
  assert.match(line, /load 1840ms\/120ms/);
  assert.match(line, /peak 312MB/);
  assert.match(line, /locked=y/);
  assert.match(line, /batt -3%/);
  assert.match(line, /over 77\.4s/);
  assert.doesNotMatch(line, /cpu-only/, "an accelerated run is not tagged as CPU-only");
});

test("the line says whether the seconds were RENDERED or estimated, and flags an impossible RTF", () => {
  /* #685. The reading the founder pasted was `rtf cold 0.00 warm 0.00 ... over
     77.4s`, and every part of that was true and misleading: the 77.4 s was a
     planning estimate the phone never rendered, and 0.00 is what a synthesis
     that never ran divides to. One line read aloud over a phone has no room
     for a sentence, so it carries `(est)` and a `!`.
     MUTATION: drop the `audioFrom` suffix or the `floor()` marker — the line
     becomes byte-for-byte the one that got filed as a pass. */
  const { diag, log } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, provider: "cpu", model: "1.0",
    modelLoadColdMs: 467, modelLoadWarmMs: 388, rtfCold: 0, rtfWarm: 0,
    audioSec: 77.4, audioFrom: "estimated", peakMemoryMb: 290.9,
    lockedScreenCompleted: false, acceleratorWired: false,
  });
  const line = formatDiagnosticReport(log.read()).split("\n").find((l) => l.includes("voiceProbe"));
  assert.match(line, /rtf cold 0\.00! warm 0\.00!/);
  assert.match(line, /over 77\.4s\(est\)/);
  assert.match(line, /\(cpu-only\)/);
});

test("a synthesis-failed refusal keeps the load and memory numbers it DID produce", () => {
  /* Every refusal before this one came from a build with no model in it, so
     printing the code alone lost nothing. `synthesis-failed` comes from a
     phone that loaded the model in 467 ms and reached 290.9 MB — the numbers
     PR #675 existed to obtain. Printing the code alone would make the next
     failed probe less informative than the broken one was.
     MUTATION: return the bare reason line — the load and peak assertions go
     red, and so does the founder's next trip to a locked phone. */
  const { diag, log } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: false, reason: "synthesis-failed", synthReason: "session-absent",
    modelLoadColdMs: 467, modelLoadWarmMs: 388, peakMemoryMb: 290.9,
  });
  const line = formatDiagnosticReport(log.read()).split("\n").find((l) => l.includes("voiceProbe"));
  assert.match(line, /could not measure: synthesis-failed\/session-absent/);
  assert.match(line, /load 467ms\/388ms/);
  assert.match(line, /peak 290\.9MB/);
  /* And a refusal that truly has no numbers still prints no dashes — only
     `hidden=`, which every probe line ends with since 2026-09-26 (L06: it was
     the only line type without one). */
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, reason: "model-absent" });
  const bare = formatDiagnosticReport(log.read()).split("\n").filter((l) => l.includes("voiceProbe")).at(-1);
  assert.match(bare, /voiceProbe kokoro-probe could not measure: model-absent {2}hidden=n$/);
});

test("a probe-v2 row names its pass, whether it was finite, and ORT's error tokens (KV-R2)", () => {
  /* The founder pastes the RING, so §6a is read off these lines: per pass,
     warm RTF, peak, finite y/n and the error tokens. A row written before
     probe v2 must print exactly what it did (the tests above).
     MUTATION: drop `pass` or `finite` from voiceProbe()'s picked fields — the
     two passes' rows become indistinguishable, or a NaN pass reads clean. */
  const { diag, log } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, pass: "cpu", provider: "cpu", model: "kokoro-82m-v1.0-fp32",
    modelLoadColdMs: 2100, modelLoadWarmMs: 900, rtfCold: 1.0, rtfWarm: 0.8, audioSec: 78,
    audioFrom: "rendered", peakMemoryMb: 900, lockedScreenCompleted: true, finite: true,
    nonFiniteLines: 0, lines: 15,
  });
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, pass: "coreml", provider: "coreml", providerBasis: "requested", acceleratorWired: true,
    modelLoadColdMs: 41000, modelLoadWarmMs: 9000, rtfCold: 0.7, rtfWarm: 0.5, audioSec: 63,
    audioFrom: "rendered", peakMemoryMb: 700, lockedScreenCompleted: true, synthFailures: 3, synthReason: "non-finite",
    finite: false, nonFiniteLines: 2, lines: 15, ortCode: "ep-fail", ortOp: "Conv", ortStage: "run",
    prevKilledPass: "coreml", prevKilledStage: "synth", prevKilledChunksDone: 6, prevKilledPeakMb: 1400,
  });
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, pass: "coreml", provider: "coreml", reason: "coreml-unavailable", loadErr: "ep-fail" });
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, pass: "cpu", provider: "cpu", reason: "synthesis-failed",
    prevKilledPass: "coreml", prevKilledStage: "load", prevKilledChunksDone: 0, prevKilledPeakMb: 600 });
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => l.includes("voiceProbe"));
  assert.equal(lines.length, 4, "one row per pass");
  /* A kill inside the CoreML compile is the load's, not the CPU pass's last
     chunk. MUTATION: drop `killedStage` from the row — it reads "after 0 chunks". */
  assert.match(lines[3], /LAST-RUN-KILLED coreml load peak 600MB/);
  assert.match(lines[0], /kokoro-probe\/cpu \[pass cpu\]\(cpu-only\)  rtf cold 1\.00 warm 0\.80/);
  assert.match(lines[0], /peak 900MB/);
  assert.match(lines[0], /  finite=y  hidden=n$/);
  /* `(requested)`: ORT 1.20 cannot say which nodes CoreML took. MUTATION:
     drop `providerBasis` from the row — `/coreml` reads as a fact. */
  assert.match(lines[1], /kokoro-probe\/coreml\(requested\) \[pass coreml\]  rtf cold 0\.70 warm 0\.50/);
  assert.match(lines[1], /  nan 2\/15  finite=n  ort=ep-fail op=Conv at=run  LAST-RUN-KILLED coreml after 6 chunks peak 1400MB  hidden=n$/);
  assert.match(lines[2], /voiceProbe kokoro-probe\/coreml \[pass coreml\] could not measure: coreml-unavailable  load FAILED\(ep-fail\) —\/—  hidden=n$/);
});

test("a probe-v3 row names its pass AND speed, the content RTF, the route, stages and screen (KV-R3)", () => {
  /* One row per pass x speed, read aloud off the paste: which pass at which
     Kokoro speed, the content-basis RTF (the 1.5x decision number) beside the
     wall one, what the Core ML chain spent per stage, CPU-s per content
     second, and whether the screen was locked. MUTATION: drop `speed` from
     the picked fields — the two speeds of a pass print identically. */
  const { diag, log, store } = mk();
  diag.voiceProbe({
    engine: "kokoro-probe", ok: true, pass: "ane-cputail", speed: 1.5, provider: "coreml", providerBasis: "requested",
    acceleratorWired: true, modelLoadColdMs: 21000, modelLoadWarmMs: 300, rtfCold: 0.2, rtfWarm: 0.06,
    rtfContentWarm: 0.04, rtfContentCold: 0.13, cpuPerContentSec: 0.021, audioSec: 51, audioFrom: "rendered",
    peakMemoryMb: 210, lockedScreenCompleted: true, finite: true, nonFiniteLines: 0, lines: 15,
    route: "ane,ane,ane,cpu,cpu,ane,cpu", stageMs: [70.4, 40, 5, 60, 120, 300, 20], bgChunks: 15, lockedChunks: 14,
    screen: "locked", keepAlive: "audio",
  });
  diag.voiceProbe({
    engine: "kokoro-probe", ok: false, pass: "ane", speed: 1, provider: "coreml", reason: "synthesis-failed",
    synthReason: "inference-threw", cmlCode: "cml-predict", cmlStage: "vocoder", synthFailures: 15, lines: 15,
  });
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, pass: "cml-cpu", speed: 1.5, reason: "coreml-requires-ios17",
    route: "not,a,route", cmlCode: "cml-made-up", screen: "sideways", stageMs: [1, 2] });
  const rows = parse(store).entries.filter((e) => e.type === "voiceProbe");
  assert.equal(rows[0].speed, 1.5);
  assert.equal(rows[0].rtfContentWarm, 0.04);
  assert.equal(rows[0].stageMs, "70/40/5/60/120/300/20");
  assert.equal(rows[2].route, undefined, "a route outside the shape is dropped");
  assert.equal(rows[2].cmlCode, undefined, "a Core ML code outside the set is dropped");
  assert.equal(rows[2].screen, undefined);
  assert.equal(rows[2].stageMs, undefined, "seven stages or nothing");
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => l.includes("voiceProbe"));
  assert.match(lines[0], /kokoro-probe\/coreml\(requested\) \[pass ane-cputail @1\.5x\]  rtf cold 0\.20 warm 0\.06  content 0\.04  load/);
  assert.match(lines[0], /  route ane,ane,ane,cpu,cpu,ane,cpu  stages 70\/40\/5\/60\/120\/300\/20ms  cpu 0\.02s\/s  screen=locked bg 15\/15 locked 14 keepAlive=audio  hidden=n$/);
  assert.match(lines[1], /\[pass ane @1x\] could not measure: synthesis-failed\/inference-threw  failed 15\/15/);
  assert.match(lines[1], /  cml=cml-predict at=vocoder/);
  assert.match(lines[2], /\[pass cml-cpu @1\.5x\] could not measure: coreml-requires-ios17/);
});

test("the soak is ONE row: loops, the per-minute series with heat, memory drift, the screen (KV-R3)", () => {
  /* Thirty minutes as one line a founder can read aloud. MUTATION: write a
     row per loop — the ring's 200 rows fill with one soak. MUTATION: drop the
     heat letter from the series — a throttling phone reads like a steady one. */
  const { diag, log, store } = mk();
  diag.voiceSoak({
    engine: "kokoro-probe", kind: "soak", ok: true, pass: "ane-cputail", speed: 1.5, soakMinutes: 30, loops: 412,
    elapsedSec: 1805, rtfSeries: [0.05, 0.051, null, 0.07], thermalSeries: ["nominal", "fair", null, "serious"],
    rtfMin: 0.04, rtfMedian: 0.05, rtfMax: 0.07, peakMb: 214, peakFirstMb: 212, peakLastMb: 214,
    bgLoops: 412, lockedLoops: 410, failures: 0, nonFinite: 0, cpuPerContentSec: 0.03, verdict: "go",
    thermalStart: "nominal", thermalEnd: "serious", keepAlive: "audio", device: "iPhone15.2", os: "18.6.2",
  });
  diag.voiceSoak({ engine: "kokoro-probe", kind: "soak", ok: false, reason: "synthesis-failed", synthReason: "calibration",
    prevKilledPass: "ane-cputail", prevKilledStage: "soak", prevKilledChunksDone: 97, prevKilledPeakMb: 230 });
  const rows = parse(store).entries.filter((e) => e.type === "voiceSoak");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].series, "0.05n 0.05f —? 0.07s");
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => l.includes("voiceSoak"));
  assert.match(lines[0], /voiceSoak +kokoro-probe \[pass ane-cputail @1\.5x\] 412 loops 30\.1min verdict=go  rtf 0\.04\/0\.05\/0\.07/);
  assert.match(lines[0], /series 0\.05n 0\.05f —\? 0\.07s  peak 214MB \(212>214\)  locked 410\/412 bg 412  thermal nominal>serious/);
  assert.match(lines[0], /iPhone15\.2 iOS 18\.6\.2  hidden=n$/);
  assert.match(lines[1], /could not soak: synthesis-failed\/calibration  LAST-RUN-KILLED ane-cputail soak after 97 loops peak 230MB/);
  /* KV-R3 review: every field the line prints is asserted, so deleting one
     from the row fails here. */
  assert.match(lines[0], /  cpu 0\.03s\/s  failed 0 nan 0  keepAlive=audio  /);
  assert.equal(rows[0].minutes, 30);
  assert.equal(rows[0].rtfMedian, 0.05);
  assert.equal(rows[0].cpuPerContentSec, 0.03);
  assert.equal(rows[0].verdict, "go");
  assert.equal(rows[0].stopped, undefined, "not stopped: the key is absent, not false");
});

test("a stopped soak and a soak's engine error print on its line (KV-R3 review)", () => {
  /* MUTATION: drop `stopped` or `cmlCode` from the picked fields — a soak the
     founder ended early reads like a full one, and a failing stage is lost. */
  const { diag, log, store } = mk();
  diag.voiceSoak({ engine: "kokoro-probe", kind: "soak", ok: true, pass: "ane-cputail", speed: 1.5, loops: 3,
    elapsedSec: 240, stopped: true, failures: 2, nonFinite: 0, cmlCode: "cml-predict", cmlStage: "vocoder" });
  diag.voiceSoak({ engine: "kokoro-probe", kind: "soak", ok: false, pass: "ort-cpu-t2", reason: "synthesis-failed",
    synthReason: "calibration", loadErr: "ep-fail", ortCode: "not-a-code", cmlCode: "cml-nope" });
  const rows = parse(store).entries.filter((e) => e.type === "voiceSoak");
  assert.equal(rows[0].stopped, true);
  assert.equal(rows[0].cmlStage, "vocoder");
  assert.equal(rows[1].ortCode, undefined, "an ORT code outside the set is dropped");
  assert.equal(rows[1].cmlCode, undefined);
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => l.includes("voiceSoak"));
  assert.match(lines[0], /\[pass ane-cputail @1\.5x\] 3 loops 4\.0min STOPPED-EARLY verdict=/);
  assert.match(lines[0], /failed 2 nan 0  cml=cml-predict at=vocoder/);
  assert.match(lines[1], /could not soak: synthesis-failed\/calibration  load FAILED\(ep-fail\)  hidden=n$/);
});
/* L-06: what the lock screen was actually told (founder feedback F15)  */
/* ==================================================================== */

test("nowPlayingFieldOf caps each field and turns absence into the empty string", () => {
  /* MUTATION: return `null` for a missing field instead of `""`. `lineFor`
     renders both as `—`, so the ROW would look identical and only the stored
     entry can tell them apart — the exact vacuous-test shape §6 of this suite
     was written after. MUTATION 2: raise the cap and the truncation assertion
     is red. */
  assert.equal(nowPlayingFieldOf(null), "");
  assert.equal(nowPlayingFieldOf(undefined), "");
  assert.equal(nowPlayingFieldOf("   "), "");
  assert.equal(nowPlayingFieldOf("  Origin Stories  "), "Origin Stories");
  const long = "x".repeat(NOWPLAYING_FIELD_MAX + 40);
  const out = nowPlayingFieldOf(long);
  assert.equal(out.length, NOWPLAYING_FIELD_MAX);
  assert.ok(out.endsWith("\u2026"), "a truncated field says so rather than looking complete");
});

test("a nowplaying entry stores the three fields, the artwork COUNT and the shim's verdict", () => {
  /* This is the whole of F15's instrumentation half. MUTATION: store
     `artwork[0].src` instead of the count — a publisher's CDN URL, with whatever
     its query string carries, in a record that gets pasted into issues. The
     `doesNotMatch` below goes red. */
  const { diag, log } = mk();
  diag.nowPlaying({
    metadata: {
      title: "Episode 09: Did Cooking Make Us Human?",
      artist: "Origin Stories",
      album: "The history of grilling \u00b7 part 12 of 32",
      artwork: [{ src: "https://is1-ssl.mzstatic.com/image/thumb/x.jpg?token=SECRET" }],
    },
    playbackState: "playing",
    native: { installed: true, sends: 42, lastReason: null },
  });
  const e = log.read().entries[0];
  assert.equal(e.type, "nowplaying");
  assert.equal(e.artist, "Origin Stories");
  assert.equal(e.album, "The history of grilling \u00b7 part 12 of 32");
  assert.equal(e.artworkCount, 1);
  assert.equal(e.state, "playing");
  assert.deepEqual(e.native, { installed: true, sends: 42, reason: null });
  assert.doesNotMatch(JSON.stringify(e), /mzstatic|SECRET|https/, "no artwork URL ever reaches the record");
});

test("F15's own three explanations are each distinguishable in the record", () => {
  /* The card's whole point: "it showed only 4a" had three causes and nothing
     could separate them. MUTATION: drop the `native` block from the entry and
     the third row stops being distinguishable from the first two. */
  const { diag, log } = mk();
  // (1) an empty payload we built
  diag.nowPlaying({ metadata: { title: "4a", artist: "", album: "" }, playbackState: "playing",
    native: { installed: true, sends: 9 } });
  // (2) a real payload that reached native
  diag.nowPlaying({ metadata: { title: "Ep 9", artist: "Origin Stories", album: "F \u00b7 part 1 of 3" },
    playbackState: "playing", native: { installed: true, sends: 10 } });
  // (3) a payload that never crossed the bridge at all
  diag.nowPlaying({ metadata: { title: "Ep 9", artist: "Origin Stories", album: "F \u00b7 part 1 of 3" },
    playbackState: "playing", native: { installed: false, sends: 0 } });
  const [a, b, c] = log.read().entries;
  assert.equal(a.artist, "", "(1) reads as an empty credit we generated");
  assert.equal(b.native.sends, 10, "(2) reads as sent");
  assert.equal(c.native.installed, false, "(3) reads as never installed, so never sent");
  assert.notEqual(a.artist, b.artist);
});

test("a nowplaying entry admits the shim's reason only as an identifier, never as prose", () => {
  /* MUTATION: pass `native.lastReason` straight through. `foray-media-session.js`
     sets it from `String(e.message)` on an arbitrary throw, which is unbounded
     text from a layer this record does not control. */
  const { diag, log } = mk();
  diag.nowPlaying({ metadata: { title: "t" }, native: { installed: true, sends: 1, lastReason: "TypeError" } });
  diag.nowPlaying({ metadata: { title: "u" }, native: { installed: true, sends: 2, lastReason: "cannot read property src of https://cdn/x?t=1" } });
  const [ok, prose] = log.read().entries;
  assert.equal(ok.native.reason, "TypeError");
  assert.equal(prose.native.reason, null, "a sentence is dropped, not stored");
});

test("formatDiagnosticReport renders a nowplaying row and counts empty credits in the header", () => {
  /* MUTATION: delete the `nowplaying` case from `lineFor` — the default branch
     prints a JSON blob and the `doesNotMatch` is red. MUTATION 2: delete the
     header line and the founder loses the one answer readable without scrolling
     200 rows on a phone. */
  const { diag, log } = mk();
  diag.nowPlaying({ metadata: { title: "Ep 9", artist: "", album: "F" }, playbackState: "playing",
    native: { installed: true, sends: 3 } });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /now playing 1 written, 1 with an empty credit/);
  assert.match(text, /nowplaying\s+"Ep 9" \/ "\u2014" \/ "F"/);
  assert.match(text, /native=on\/sent=3/);
  assert.doesNotMatch(text, /\{"/, "no JSON blob for a known type");
});

/* ==================================================================== */
/* M-03: why did it stop? (founder feedback F16 / #548)                 */
/* ==================================================================== */

test("a session event is admitted only from the closed vocabulary the Swift writes", () => {
  /* MUTATION: store an unrecognised `kind` as "unknown" instead of dropping the
     row. A native plugin's string would then reach a record that is pasted into
     issues, which is the rule `STAGE_ROOTS` and the `knownCar` handler already
     keep for the same reason. */
  const { diag, log } = mk();
  assert.ok(diag.sessionEvent({ kind: "interruptionBegan", reason: "began", producer: "audio" }));
  assert.equal(diag.sessionEvent({ kind: "somethingNew", reason: "began" }), null);
  assert.equal(diag.sessionEvent({ kind: "routeChange", reason: "Wyatt's Civic" }).reason, "",
    "a route NAME is not a token and is dropped — it is somebody's name");
  assert.equal(diag.sessionEvent({ kind: "routeChange", reason: "old-device-gone" }).reason, "old-device-gone");
  assert.equal(log.read().entries.length, 3);
  for (const k of ["interruptionBegan", "interruptionEnded", "routeChange", "mediaServicesReset",
    "background", "foreground"]) {
    assert.ok(SESSION_KINDS.has(k), k);
  }
});

test("a session event keeps the NATIVE clock beside the page's, and the lag between them", () => {
  /* The measurement M-03 exists for: a suspended WKWebView handles a background
     event late by exactly the length of the suspension. MUTATION: drop `at` and
     keep only `wall` — the lag is unrecoverable and the record answers "when we
     noticed" instead of "when it happened". */
  const { diag, log, clock: c } = mk();
  const firedAt = c.now() - 30_000;
  const e = diag.sessionEvent({ kind: "background", reason: "did-enter", producer: "audio", at: firedAt });
  assert.equal(e.at, firedAt);
  assert.equal(e.lagMs, 30_000);
  assert.equal(diag.sessionEvent({ kind: "foreground", reason: "will-enter" }).lagMs, null,
    "no native stamp is honestly null, never zero");
});

test("an unknown producer falls back to audio rather than storing a native string", () => {
  const { diag } = mk();
  assert.equal(diag.sessionEvent({ kind: "background", producer: "tts" }).producer, "tts");
  assert.equal(diag.sessionEvent({ kind: "background", producer: "whatever" }).producer, "audio");
  assert.ok(SESSION_PRODUCERS.has("page"));
});

test("transport records WHO asked, from closed sets on both halves", () => {
  /* MUTATION: accept any string for `source`. `client.js` passes it from a
     surface, and a record that could hold arbitrary text there is a record with
     no rule at all. MUTATION 2: swap `source` and `action` at the call site —
     both drop, because neither vocabulary accepts the other's words. */
  const { diag, log } = mk();
  assert.ok(diag.transport("remote", "play"));
  assert.ok(diag.transport("tap", "pause"));
  assert.equal(diag.transport("siri", "play"), null);
  assert.equal(diag.transport("remote", "rewind"), null);
  assert.equal(diag.transport("play", "remote"), null, "transposed arguments are refused, not stored");
  assert.equal(log.read().entries.length, 2);
  assert.ok(TRANSPORT_SOURCES.has("reconcile") && TRANSPORT_ACTIONS.has("stop"));
});

test("the record can answer \"why did it stop?\" — the cause sits one row above the stop", () => {
  /* The card's acceptance, as a property of the record rather than a claim: a
     stop is preceded by the session event that caused it, or by nothing, and
     nothing is itself the finding. MUTATION: record the session event without a
     `type` of its own (fold it into `stop`) and the two become indistinguishable,
     which is the state the F16 record was already in. */
  const { diag, log } = mk();
  diag.transport("tap", "play");
  diag.sessionEvent({ kind: "interruptionBegan", reason: "began", producer: "audio" });
  diag.note("audio.pausedUnexpectedly — nobody asked for this pause");
  const types = log.read().entries.map((e) => e.type);
  assert.deepEqual(types, ["transport", "session", "stop"]);
  const text = formatDiagnosticReport(log.read());
  /* Since 2026-09-26 (L31) the header counts each kind rather than listing
     the kinds it saw. */
  assert.match(text, /^session events 1:\n {2}interruptionBegan 1$/m);
  assert.match(text, /session\s+audio interruptionBegan \(began\)/);
  assert.match(text, /transport\s+play from tap/);
});

/* ==================================================================== */
/* founder 2026-09-23: "I started playing 4a, paused and turned off my   */
/* screen, got in my car, then my car resumed Spotify. This is still     */
/* wrong." What the NEXT record has to be able to say.                    */
/* ==================================================================== */

test("REPORT 2026-09-23: a remote command the native side received is a row of its own", () => {
  /* `transport … from remote` is written by the page's HANDLER, so a command
     that reached the plugin and found no handler, or a page too asleep to run
     one, was invisible. MUTATION: drop the `remote` type and fold it into
     `transport` — `handled=n` has nowhere to live and the two readings of "the
     car's play did nothing" collapse again. */
  const { diag, log, clock: c } = mk();
  const e = diag.remoteCommand({
    command: "toggle-play-pause", action: "pause", origin: "command-center", handled: true, at: c.now() - 250,
  });
  assert.equal(e.type, "remote");
  assert.equal(e.command, "toggle-play-pause");
  assert.equal(e.action, "pause");
  assert.equal(e.origin, "command-center");
  assert.equal(e.handled, true);
  assert.equal(e.lagMs, 250);
  const miss = diag.remoteCommand({ command: "play", action: "play", origin: "media-session", handled: false });
  assert.equal(miss.handled, false);
  assert.equal(miss.lagMs, null, "no native stamp is honestly null");
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /remote\s+toggle-play-pause -> pause from command-center  handled=y  lag 250ms/);
  assert.match(text, /remote\s+play -> play from media-session  handled=n/);
  assert.match(text, /remote commands 2, 1 unhandled/);
});

test("REPORT 2026-09-23: the remote row admits closed vocabularies and drops the rest", () => {
  /* MUTATION: store `command` as sent. Both natives hand over strings, and this
     record is pasted into issues. */
  const { diag, log } = mk();
  assert.equal(diag.remoteCommand({ command: "playPause", action: "play", origin: "command-center" }), null);
  assert.equal(diag.remoteCommand({ command: "play", action: "play", origin: "carplay" }), null);
  assert.equal(diag.remoteCommand({ command: "play", action: "PLAY; drop", origin: "notification" }).action, "");
  assert.equal(log.read().entries.length, 1);
  for (const c of ["play", "pause", "toggle-play-pause", "skip-backward", "skip-forward", "close"]) {
    assert.ok(REMOTE_COMMANDS.has(c), c);
  }
  assert.deepEqual([...REMOTE_ORIGINS].sort(), ["command-center", "media-session", "notification", "webkit"]);
});

test("REVIEW 2026-09-23: a skip through WebKit's door is a row when named by the record's word, and the spec action is NOT that word", () => {
  /* The founder's phone shows WebKit's client during tape, so a lock-screen skip
     arrives as `seekforward` through the `webkit` door — and the tee named the
     command by that spec action, which this set does not hold: `remoteCommand`
     returned null for every skip, next and previous from that door, so the
     record could never say whether a press arrived twice. The record's word is
     the dashed one; the translation is the shim's (`REMOTE_COMMAND_FOR_ACTION`)
     and `shell-invariants.test.mjs` pins its range into `REMOTE_COMMANDS`. This
     pins both halves of the contract from the record's side: the dashed row is
     written and rendered, and the action spelling is refused rather than
     admitted — so a shim that stopped translating would be caught by the row's
     absence, never papered over by a widened set.
     MUTATION: add "seekforward" to REMOTE_COMMANDS — the second half goes red;
     drop "skip-forward" — the first half does. */
  const { diag, log, clock: c } = mk();
  const row = diag.remoteCommand({ command: "skip-forward", action: "seekforward", origin: "webkit", handled: true, at: c.now() - 40 });
  assert.ok(row, "a webkit-door skip is a row");
  assert.equal(row.command, "skip-forward");
  assert.equal(row.origin, "webkit");
  assert.match(formatDiagnosticReport(log.read()), /remote\s+skip-forward -> seekforward from webkit  handled=y  lag 40ms/);
  for (const [spec, door] of [
    ["seekforward", "webkit"], ["seekbackward", "webkit"], ["nexttrack", "webkit"], ["previoustrack", "webkit"],
    ["nexttrack", "media-session"], ["seekbackward", "notification"], ["seekto", "media-session"],
  ]) {
    assert.equal(diag.remoteCommand({ command: spec, action: spec, origin: door }), null,
      `"${spec}" is an action, not a command; the shim must translate it before it reaches the record`);
    assert.ok(!REMOTE_COMMANDS.has(spec), `REMOTE_COMMANDS must not be widened to admit the spec action "${spec}"`);
  }
  for (const dashed of ["next-track", "previous-track", "skip-backward", "skip-forward", "change-position"]) {
    assert.ok(REMOTE_COMMANDS.has(dashed), dashed);
  }
  assert.equal(log.read().entries.length, 1, "exactly the one translated row landed");
});

test("REPORT 2026-09-23: a dropped duplicate is a remote row saying dup=y, counted on the header and never as unhandled", () => {
  /* On iOS one lock-screen press can arrive through two doors — WebKit's own
     MediaSession (the tee) and the plugin's MPRemoteCommandCenter — and the shim
     applies it once, dropping the second copy with `deduped: true`. The row
     must say so (a skip that moved once while two rows say it arrived is the
     mechanism working) and the header must count it apart from `unhandled`
     (the OTHER copy ran). MUTATION: drop `deduped` from the entry, or count a
     deduped row as unhandled — the header reads "1 unhandled" for a press that
     was handled. */
  const { diag, log } = mk();
  const a = diag.remoteCommand({ command: "skip-forward", action: "seekforward", origin: "webkit", handled: true, deduped: false });
  const b = diag.remoteCommand({ command: "skip-forward", action: "seekforward", origin: "command-center", handled: false, deduped: true });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(diag.remoteCommand({ command: "play", action: "play", origin: "webkit", handled: true }).deduped, false,
    "absent reads as not a duplicate, never as one");
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /remote\s+skip-forward -> seekforward from webkit  handled=y  lag/);
  assert.match(text, /remote\s+skip-forward -> seekforward from command-center  handled=n  dup=y  lag/);
  assert.match(text, /remote commands 3, 1 duplicate dropped\n/);
  assert.doesNotMatch(text, /unhandled/, "a dropped copy is not an unhandled press");
  diag.remoteCommand({ command: "play", action: "play", origin: "command-center", handled: false, deduped: true });
  assert.match(formatDiagnosticReport(log.read()), /remote commands 4, 2 duplicates dropped\n/);
});

test("REPORT 2026-09-23: zero remote commands is stated on the header, because it is the finding", () => {
  /* Against a drive that resumed Spotify, `remote commands 0` says the car's
     play never reached 4a's native side — the OS gave it to somebody else —
     which is a different bug from a play that arrived and found nobody awake.
     MUTATION: omit the line at zero. */
  const { diag, log } = mk();
  diag.transport("tap", "pause");
  assert.match(formatDiagnosticReport(log.read()), /remote commands 0\n/);
});

test("REPORT 2026-09-23: a nowplaying row says WHICH write it was, and a pause reads via=state", () => {
  /* The pause used to leave no row: `media-session.js` reported only when the
     three strings changed. MUTATION: drop `via` from the entry — a pause row and
     a metadata row become the same row, and the line loses the `via=` that
     makes a pause findable. */
  const { diag, log } = mk();
  const meta = { title: "Ep 9", artist: "Origin Stories", album: "F" };
  const a = diag.nowPlaying({ metadata: meta, playbackState: "playing" });
  const b = diag.nowPlaying({ metadata: meta, playbackState: "paused", via: "state" });
  const c = diag.nowPlaying({ metadata: null, playbackState: "none", via: "clear" });
  const d = diag.nowPlaying({ metadata: meta, playbackState: "playing", via: "whatever" });
  assert.deepEqual([a.via, b.via, c.via, d.via], ["metadata", "state", "clear", "metadata"]);
  assert.ok(NOWPLAYING_VIA.has("state") && NOWPLAYING_VIA.has("clear"));
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => /nowplaying/.test(l));
  assert.doesNotMatch(lines[0], /via=/, "a metadata write keeps the shape every older row has");
  assert.match(lines[1], /state=paused  via=state/);
  assert.match(lines[2], /state=none  via=clear/);
});

test("REPORT 2026-09-23: what the plugin DID about the session is a session row too", () => {
  /* `sessionActivated` / `sessionReleased` / `nowPlayingReasserted` are the
     plugin's own acts, so a drive that still resumed Spotify can say whether
     4a had let go (no rows) or was holding on and lost anyway. MUTATION:
     remove them from SESSION_KINDS — `sessionEvent` returns null and the
     record is back to silence. */
  const { diag, log } = mk();
  assert.ok(diag.sessionEvent({ kind: "sessionActivated", reason: "paused", producer: "audio" }));
  assert.ok(diag.sessionEvent({ kind: "nowPlayingReasserted", reason: "background", producer: "audio" }));
  assert.ok(diag.sessionEvent({ kind: "sessionReleased", reason: "closed", producer: "audio" }));
  assert.ok(diag.sessionEvent({ kind: "interruptionBegan", reason: "began-while-held", producer: "audio" }));
  assert.equal(log.read().entries.length, 4);
  assert.match(formatDiagnosticReport(log.read()), /session\s+audio sessionActivated \(paused\)/);
});

test("no session events at all is stated on the header, because silence is the finding", () => {
  /* MUTATION: omit the `session events` header line when the count is zero. A
     founder reading a stop with no cause could not then tell "the plugins saw
     nothing" from "this build does not report". */
  const { diag, log } = mk();
  diag.note("audio.pausedUnexpectedly — nobody asked for this pause");
  assert.match(formatDiagnosticReport(log.read()), /session events 0/);
});

/* ==================================================================== */
/* founder report 2 (2026-09-22): "playback stops itself while           */
/* backgrounded" — eight unexplained stops, all hidden, and nothing to   */
/* tell them apart. What the NEXT record has to be able to say.          */
/* ==================================================================== */

test("REPORT 2: an unexplained stop carries how long the page had been hidden and the element's state", () => {
  /* The three leading causes leave different fingerprints: a starvation that
     ends in a suspension (low `readyState`, long `hiddenFor`), an interruption
     or route loss taking a healthy element (`rs=4`), a media failure (`err`).
     KILLING MUTATION: drop `hiddenForMs` or the four parsed fields from the
     `pausedUnexpectedly` row. */
  const c = clock();
  const { diag, log, store } = mk({ now: c });
  store.hidden = true;
  diag.visibility(true);
  c.tick(42_000);
  diag.note("audio.pausedUnexpectedly t=1234.5 rs=2 ns=2 err=0 — nobody asked for this pause");
  const stop = log.read().entries.find((e) => e.type === "stop");
  assert.equal(stop.hiddenForMs, 42_000);
  assert.equal(stop.atSec, 1234.5);
  assert.equal(stop.readyState, 2);
  assert.equal(stop.networkState, 2);
  assert.equal(stop.errorCode, 0);
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /pausedUnexpectedly {2}state=\? {2}hidden=y {2}hiddenFor 42000ms at 1234\.5s rs=2 ns=2/);
});

test("REPORT 2: a stop line from an older build still records, with the new fields null — never zero", () => {
  /* `readyState` 0 is a real value (HAVE_NOTHING); a missing field must not
     masquerade as it. KILLING MUTATION: default the parsed fields to 0. */
  const { diag, log } = mk();
  diag.note("audio.pausedUnexpectedly — nobody asked for this pause");
  const stop = log.read().entries.find((e) => e.type === "stop");
  assert.equal(stop.readyState, null);
  assert.equal(stop.atSec, null);
  assert.equal(stop.hiddenForMs, null, "the page was visible");
});

test("REPORT 2: a stall with NO seam in flight is a row of its own, coalesced per run", () => {
  /* On an ordinary episode there is never a seam, and `_stage` dropped every
     `waiting`/`stalled` — so a starvation that ended in a suspension left no
     trace before its stop. KILLING MUTATION: delete the no-seam branch in
     `mediaEvent`. */
  const { diag, log } = mk();
  diag.mediaEvent("waiting");
  diag.mediaEvent("waiting");
  diag.mediaEvent("waiting");
  diag.mediaEvent("stalled");
  const media = log.read().entries.filter((e) => e.type === "media");
  assert.deepEqual(media.map((e) => [e.name, e.repeated]), [["waiting", 3], ["stalled", 1]]);
  assert.match(formatDiagnosticReport(log.read()), /media\s+waiting x3/);
});

test("REPORT 1/2: a play the page did not make is recorded as one, from `reconcile`", () => {
  /* The manager's towards-playing reconcile says the element was resumed from
     outside (a lock-screen or car press WebKit honoured). KILLING MUTATION:
     delete the `externalPlay` handler in `note()`. */
  const { diag, log } = mk();
  diag.note("reconcile.externalPlay why=elementPlaying — the element is playing and we said interrupted");
  const row = log.read().entries.find((e) => e.type === "transport");
  assert.ok(row, "a transport row");
  assert.equal(row.source, "reconcile");
  assert.equal(row.action, "play");
});

test("REPORT 2: a native session row says how long the page had been hidden when it was handled", () => {
  /* Paired with `lagMs`, this separates "the event fired late" from "the page
     was asleep". KILLING MUTATION: drop `hiddenForMs` from `sessionEvent`. */
  const c = clock();
  const { diag, log, store } = mk({ now: c });
  store.hidden = true;
  diag.visibility(true);
  c.tick(5_000);
  diag.sessionEvent({ kind: "interruptionBegan", reason: "began", producer: "audio", at: c.now() - 1_000 });
  const row = log.read().entries.find((e) => e.type === "session");
  assert.equal(row.hiddenForMs, 5_000);
  assert.equal(row.lagMs, 1_000);
});

/* ==================================================================== */
/* founder report 3 (2026-09-22): which build wrote this record?         */
/* ==================================================================== */

test("REPORT 3: the report's second line names the build, from the newest `build` row", () => {
  /* A ring spans app updates, so it is the NEWEST row that describes the
     running build. KILLING MUTATION: delete the `build …` header line. */
  const { diag, log } = mk();
  diag.build({ shell: true, web: "1111111111111111", native: "2026092101", version: "1.3.0" });
  diag.boot();
  diag.build({ shell: true, web: "2B808EC9D50C5B98", native: "2026092224", version: "1.4.0" });
  const lines = formatDiagnosticReport(log.read()).split("\n");
  assert.equal(lines[1], "build web 2b808ec9d50c5b98 · native 2026092224 (1.4.0)");
  assert.match(lines.join("\n"), /build\s+web 1111111111111111 · native 2026092101 \(1\.3\.0\)/,
    "and each boot's row stays in the record");
});

test("REPORT 3: the website says so, an unknown half is `?`, and nothing unshaped gets in", () => {
  /* KILLING MUTATION: store `native` without `buildTokenOf`. */
  const { diag, log } = mk();
  assert.match(formatDiagnosticReport(log.read()), /^build unknown/m, "a record from before any build row says so");
  diag.build({ shell: false, web: "2b808ec9d50c5b98" });
  assert.match(formatDiagnosticReport(log.read()), /^build web 2b808ec9d50c5b98 · website$/m);
  diag.build({ shell: true, web: null, native: "Wyatt's iPhone" });
  const row = log.read().entries.at(-1);
  assert.equal(row.native, null);
  assert.match(formatDiagnosticReport(log.read()), /^build web \? · native \?$/m);
});

/* ==================================================================== */
/* 2026-09-23: the founder's empty record                                */
/* ==================================================================== */

/** A store shaped like `DurableStore` for the one thing the header asks it:
    which tiers it has and whether it hydrated. Everything else is `fakeStore`. */
function tieredStore({ tiers = ["local", "native", "idb"], hydrated = true } = {}) {
  const s = fakeStore();
  s.health = () => ({ hydrated, tiers: Object.fromEntries(tiers.map((t) => [t, {}])) });
  return s;
}

test("REPORT 2026-09-23: `recorded 939 · entries 0 · dropped 0` is stated as MISSING rows, naming the key and the tiers", () => {
  /* THE FOUNDER'S RECORD, VERBATIM IN ITS NUMBERS. The blob a build before this
     one left behind after a Clear — `seq` kept, the ring empty, no mark — read
     as an instrument that had recorded 939 rows and shown none, and nothing on
     the header said which. The arithmetic  seq − cleared.seq == entries + dropped
     has to hold, and when it does not the header says so and names WHERE the
     ring was read from, because "cleared or lost" is only actionable with a key
     and a tier list beside it.

     KILLING MUTATION: delete `gapLine` from the header. The first assertion fails.
     MUTATION 2: print the gap without `where`. The second fails. */
  const store = tieredStore();
  store.map.set(DIAG_KEY, JSON.stringify({
    v: 1, cap: 200, seq: 939, dropped: 0, entries: [], updatedAt: "2026-09-23T12:00:00.000Z",
  }));
  const log = new DiagnosticLog({ storage: store, now: clock().now });
  const text = formatDiagnosticReport(log.read());
  assert.match(text, /^MISSING 939 of 939 recorded rows: not in this ring, not dropped/m);
  assert.match(text, /cp_diag \(local\+native\+idb, hydrated=y\) was cleared or lost/);
  assert.match(text, /recorded 939/, "the counter is still printed; it is now explained");
});

test("the counters that DO add up print no warning — a wrapped ring is not a loss", () => {
  /* The other direction, so the line cannot become noise: 205 recorded, 5
     dropped, 200 in the ring is the ring working as designed.
     MUTATION: compute `missing` without subtracting `dropped`. This fails. */
  const { log } = mk({ cap: 200 });
  for (let i = 0; i < 205; i++) log.record("outPoint", {});
  const text = formatDiagnosticReport(log.read());
  assert.doesNotMatch(text, /MISSING|INCONSISTENT/);
  assert.match(text, /dropped 5 · recorded 205/);
});

test("a Clear is WRITTEN DOWN: the header says cleared at #N and how many rows since", () => {
  /* `seq` survives a Clear on purpose (a wrapped ring must stay distinguishable
     from a cleared one), and until now that was left for a reader to infer from
     `entries[0].seq > 1` — which the founder's record, with no entries at all,
     could not even offer.
     KILLING MUTATION: stop setting `_cleared` in `clear()`. Both the `cleared at`
     line and the `MISSING` suppression fail. */
  const { log, diag, clock: c } = mk();
  for (let i = 0; i < 5; i++) diag.boot();
  c.tick(1000);
  log.clear();
  let text = formatDiagnosticReport(log.read());
  /* With its DATE and a Z since 2026-09-26 (L21): a time of day alone could
     not say which day the Clear was. */
  assert.match(text, /^cleared at #5 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z\n {2}· 0 recorded since$/m);
  assert.match(text, /Nothing recorded yet since the record was cleared at #5\./);
  assert.doesNotMatch(text, /MISSING/, "a cleared ring is empty on purpose, not lost");
  diag.boot();
  text = formatDiagnosticReport(log.read());
  assert.match(text, /cleared at #5 .*\n {2}· 1 recorded since/);
  assert.match(text, /entries 1 of 200/);
  assert.doesNotMatch(text, /MISSING/);
});

test("forget() — Delete my data — leaves no count and no clock of the deletion behind (persist-5)", () => {
  /* `clear()` writes the clear down for the founder's loop; a deletion reused it,
     so the next background row wrote `cp_diag` back as `recorded 940 · cleared at
     #939 14:07:31` — how much the listener did and when they deleted it.
     KILLING MUTATION: make `forget()` just `this.clear()` (or point
     `forayForgetDiagnostics` back at `clear()`, which data-deletion's wiring test
     catches). */
  const store = fakeStore();
  const c = clock();
  const log = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now });
  diag.build({ shell: false, web: "2b808ec9d50c5b98" });
  for (let i = 0; i < 5; i++) diag.boot();
  c.tick(1000);
  log.forget();
  assert.equal(store.getItem(DIAG_KEY), null, "the key is removed, as a Clear removes it");
  diag.boot();
  const blob = JSON.parse(store.getItem(DIAG_KEY));
  assert.equal(blob.cleared, null, "the moment of the deletion is not written back");
  assert.equal(blob.seq, 1, "the pre-deletion count is not carried forward");
  assert.equal(blob.dropped, 0);
  const text = formatDiagnosticReport(log.read());
  assert.doesNotMatch(text, /cleared at/);
  assert.doesNotMatch(text, /MISSING/, "a record that starts again at #1 is whole");
  assert.match(text, /build web 2b808ec9d50c5b98/, "the running page's build is not the listener's data");
});

test("the build SURVIVES a Clear: the header names it with no build row left in the ring", () => {
  /* The founder's second line read `build unknown (no build row yet)` on a page
     that had learned its build at boot — the row was a row, and the Clear took
     it. The stamp now lives on the log, outside the ring.
     KILLING MUTATION: null `_build` in `clear()`, or make the header read only
     the newest `build` row. */
  const { log, diag } = mk();
  diag.build({ shell: true, web: "2b808ec9d50c5b98", native: "2026092326", version: "1.4.0" });
  log.clear();
  assert.equal(log.entries.length, 0, "the ring really is empty");
  const lines = formatDiagnosticReport(log.read()).split("\n");
  assert.equal(lines[1], "build web 2b808ec9d50c5b98 · native 2026092326 (1.4.0)");
});

test("the clear mark and the build stamp ride the blob, so a reload of the ring keeps both", () => {
  /* A page killed after a Clear must not come back saying `build unknown` and
     `MISSING 939` on its next boot. Both fields are persisted by the next
     `save()` and restored by `_load`, admitted by shape like every other field.
     `read()` also carries `key` and `store`, which `save()` must NOT persist —
     a store's description inside the store it describes would be nonsense.
     KILLING MUTATION 1: drop `cleared`/`build` from `_blob()`.
     KILLING MUTATION 2: drop `clearedMarkOf`/`buildStampOf` from `_load`.
     MUTATION 3: have `save()` write `read()` — the last assertion fails. */
  const store = fakeStore();
  const c = clock();
  const first = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log: first, now: c.now });
  diag.build({ shell: false, web: "2b808ec9d50c5b98" });
  diag.boot();
  first.clear();
  assert.equal(store.getItem(DIAG_KEY), null, "a Clear still removes the key");
  diag.boot();                                   // the next write carries both down
  const reloaded = new DiagnosticLog({ storage: store, now: c.now });
  assert.deepEqual(reloaded.cleared, { seq: 2, wall: c.now() });
  assert.deepEqual(reloaded.build, { shell: false, web: "2b808ec9d50c5b98", native: null, version: null });
  const text = formatDiagnosticReport(reloaded.read());
  assert.match(text, /^build web 2b808ec9d50c5b98 · website$/m);
  assert.match(text, /cleared at #2/);
  assert.doesNotMatch(text, /MISSING/);
  const persisted = parse(store);
  assert.ok(!("store" in persisted) && !("key" in persisted), "the store's description is read-side only");
  /* And a corrupt mark reads as "never cleared" — the direction that makes the
     gap line fire rather than hide a loss behind a forged clear. */
  store.map.set(DIAG_KEY, JSON.stringify({ ...persisted, cleared: { seq: "3", wall: 1 }, entries: [] }));
  const corrupt = new DiagnosticLog({ storage: store, now: c.now });
  assert.equal(corrupt.cleared, null);
  assert.match(formatDiagnosticReport(corrupt.read()), /MISSING 3 of 3/);
});

test("rows `_load` refused are counted as MISSING, never silently absent", () => {
  /* The other way a ring can hold fewer rows than `seq` says: rows the loader
     dropped because they could not be rendered. That is a finding about the
     writer and the header must not round it down to a quiet short ring.
     MUTATION: count `entries.length` before the loader's filter. This fails. */
  const store = tieredStore({ tiers: ["local"], hydrated: false });
  store.map.set(DIAG_KEY, JSON.stringify({
    v: 1, cap: 200, seq: 3, dropped: 0,
    entries: [
      { seq: 1, wall: 1_700_000_000_000, type: "boot", hidden: false },
      { seq: 2, wall: "not a clock", type: "seam" },
      { seq: 3, wall: 1_700_000_001_000, type: "outPoint", overshootSec: 0.02 },
    ],
  }));
  const log = new DiagnosticLog({ storage: store, now: clock().now });
  assert.match(formatDiagnosticReport(log.read()), /^MISSING 1 of 3 recorded rows: .* cp_diag \(local, hydrated=n\)/m);
});

test("the boot row says when the page wrote BEFORE the store had hydrated", () => {
  /* `client.js` now bounds its wait on hydration (a durable tier that never
     answered used to cost the whole record). A row written after the bound is
     the one case an older durable copy of the ring can have been superseded, so
     the row says so — and a healthy boot's line is unchanged.
     KILLING MUTATION: drop `hydrated` from `boot()`'s row or from `lineFor`. */
  const { log, diag } = mk();
  diag.boot({ hydrated: false });
  diag.boot({ hydrated: true });
  diag.boot();
  const lines = formatDiagnosticReport(log.read()).split("\n").filter((l) => /\bboot\b/.test(l) && l.startsWith("#"));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /hidden=n  storage=not-hydrated$/);
  assert.match(lines[1], /hidden=n$/);
  assert.match(lines[2], /hidden=n$/);
  assert.equal(log.entries[2].hydrated, undefined, "a caller that did not say stores nothing");
});

/* ==================================================================== */
/* REVIEW 2026-09-23: a write before a SLOW hydration must not overwrite  */
/* the older ring. The store adopts a durable row only if nothing wrote   */
/* the key first; the boot row used to be that first writer.              */
/* ==================================================================== */

/** A `Storage` the local tier can walk: what a swept WebView leaves behind. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/** A durable tier whose `readAll` answers only when released — a cold
    Preferences read over the bridge, six seconds in, not a hang. */
function gatedDurable(rows = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = new Map(Object.entries(rows));
  const tier = {
    name: "native", sync: false, durable: true,
    async readAll(prefix) {
      await gate;
      const out = new Map();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(k, v) { store.set(k, String(v)); },
    async remove(k) { store.delete(k); },
  };
  return { tier, store, release: () => release() };
}

/** Three rows from an earlier drive, in the durable tier and nowhere else. */
function olderRing(c) {
  const wall = c.now() - 60 * 60 * 1000;
  return JSON.stringify({
    v: DIAG_VERSION, cap: DIAG_CAP, seq: 3, dropped: 0, cleared: null, build: null,
    saveErrors: 0, loadError: null, updatedAt: new Date(wall).toISOString(),
    entries: [
      { seq: 1, wall, type: "boot", hidden: false },
      { seq: 2, wall: wall + 1000, type: "transport", source: "tap", action: "play", hidden: false },
      { seq: 3, wall: wall + 2000, type: "seam", openedBy: "boundary", stages: [], hidden: false },
    ],
  });
}

test("REVIEW 2026-09-23: a row written before a slow hydration is HELD, then written after the adopted ring", async () => {
  /* The branch bounded the record's wait on hydration at five seconds and wrote
     the boot row at the bound. `record()` -> `_load()` read the swept
     localStorage (empty), `save()` marked `cp_diag` dirty, and when the durable
     read landed at six seconds `DurableStore` skipped the durable ring (dirty:
     "this session wins") and pushed the fresh one-row ring down over it. The
     older ring was gone and the only trace was `storage=not-hydrated`. The
     comment called the case "a durable tier that hung"; a merely slow one lost
     the ring the same way, and a timer cannot tell the two apart. Now the write
     is held while the store says it has not hydrated, and `flush()` re-reads
     the ring — the adopted one — and appends the held rows after it.
     KILLING MUTATION: drop the `_deferring()` check from `save()`. The first
     assertion fails (the boot row reaches localStorage at once) and so does the
     fourth (the durable ring is skipped as dirty and the write holds one row).
     MUTATION 2: skip the re-read in `flush()` — the held row is written over an
     in-memory ring that never saw the adopted one; the fourth assertion fails. */
  const c = clock();
  const local = memoryStorage();
  const durable = gatedDurable({ [DIAG_KEY]: olderRing(c) });
  const store = new DurableStore({ tiers: [localStorageTier(local), durable.tier], now: c.now });
  const hydration = store.hydrate();
  const log = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now });

  const boot = diag.boot({ hydrated: false });
  assert.equal(store.getItem(DIAG_KEY), null, "nothing is written while the store has not hydrated");
  assert.equal(log.read().entries.length, 1, "but the sheet shows the row at once");
  assert.equal(log.read().store.hydrated, false, "and the header says why it is not on disk yet");
  assert.match(formatDiagnosticReport(log.read()), /storage=not-hydrated/);

  durable.release();
  await hydration;
  assert.match(store.getItem(DIAG_KEY) ?? "", /"type":"seam"/, "the durable ring was ADOPTED, not skipped as this session's");

  assert.equal(log.flush(), true, "hydration landed: the held row is written");
  const written = JSON.parse(store.getItem(DIAG_KEY));
  assert.deepEqual(written.entries.map((e) => e.type), ["boot", "transport", "seam", "boot"], "the older ring first, the held row after it");
  assert.equal(boot.seq, 4, "the held row continues the adopted sequence rather than restarting it");
  assert.equal(written.seq, 4);
  assert.equal(log.read().entries[3], boot, "the same live object, so a caller's reference still points at its row");
  await store.flush();
  assert.deepEqual(JSON.parse(durable.store.get(DIAG_KEY)).entries.map((e) => e.type), ["boot", "transport", "seam", "boot"],
    "and the durable tier holds the merged ring, not the one-row one");
  assert.equal(log.flush(), false, "nothing left to write");
});

test("REVIEW 2026-09-23: the next write after hydration carries the held rows by itself, and keeps the running build over the disk's", async () => {
  /* Nobody has to call `flush()`: `record()` does, first. And the build stamp
     set while the write was held is the RUNNING build; the disk's is an older
     boot's. KILLING MUTATION: drop the `this.flush()` at the top of `record()`
     — the transport row is written and the boot row is lost with the older
     ring's sequence; or drop the `if (build)` restore in `flush()`. */
  const c = clock();
  const durable = gatedDurable({ [DIAG_KEY]: olderRing(c) });
  const store = new DurableStore({ tiers: [localStorageTier(memoryStorage()), durable.tier], now: c.now });
  const hydration = store.hydrate();
  const log = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now });
  diag.boot({ hydrated: false });
  diag.build({ web: "deadbeefcafef00d", shell: false });
  assert.equal(store.getItem(DIAG_KEY), null);
  durable.release();
  await hydration;
  diag.transport("tap", "play");
  const written = JSON.parse(store.getItem(DIAG_KEY));
  assert.deepEqual(written.entries.map((e) => e.type), ["boot", "transport", "seam", "boot", "build", "transport"]);
  assert.deepEqual(written.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(written.build?.web, "deadbeefcafef00d", "the running build, not null from the older ring");
});

test("REVIEW 2026-09-23: a store that never hydrates still gets the held rows once the page gives up waiting", () => {
  /* The documented trade, kept, but at a distance a slow read cannot reach:
     `client.js` calls `flush({ force: true })` a minute after the bound, and a
     tier that has not answered by then has earned the name "hung". Without
     the force the rows would stay in memory forever and a reload would lose
     them. KILLING MUTATION: ignore `force` in `flush()`. */
  const c = clock();
  const durable = gatedDurable({});
  const local = memoryStorage();
  const store = new DurableStore({ tiers: [localStorageTier(local), durable.tier], now: c.now });
  store.hydrate();
  const log = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now });
  diag.boot({ hydrated: false });
  diag.transport("tap", "play");
  assert.equal(local.map.get(DIAG_KEY), undefined, "held");
  assert.equal(log.flush(), false, "a plain flush still waits for hydration");
  assert.equal(log.flush({ force: true }), true, "the give-up writes what was held");
  assert.deepEqual(JSON.parse(local.map.get(DIAG_KEY)).entries.map((e) => e.type), ["boot", "transport"]);
  diag.transport("tap", "pause");
  assert.equal(JSON.parse(local.map.get(DIAG_KEY)).entries.length, 3, "and every write after the give-up lands at once");
});

test("REVIEW 2026-09-23: a Clear while writes are held drops them, and a plain Storage holds nothing", () => {
  /* A clear is the listener's word and removes the key at once; nothing held
     for hydration may come back on the next flush. And a store with no
     hydration state — a page with no durable store, every fake in this file —
     writes on `record()` as it always did (the durability test above pins the
     other half). KILLING MUTATION: leave `_buffered` alone in `clear()`. */
  const c = clock();
  const durable = gatedDurable({});
  const store = new DurableStore({ tiers: [localStorageTier(memoryStorage()), durable.tier], now: c.now });
  store.hydrate();
  const log = new DiagnosticLog({ storage: store, now: c.now });
  log.record("boot", { hidden: false });
  log.clear();
  assert.equal(log.flush({ force: true }), false, "nothing held survives a clear");
  assert.equal(store.getItem(DIAG_KEY), null);

  const plain = mk();
  plain.log.record("boot", { hidden: false });
  assert.ok(plain.store.map.get(DIAG_KEY), "no hydration state: written on record(), as before");
  assert.equal(plain.log.flush(), false);
});

/* ==================================================================== */
/* log-gaps 2026-09-26 (docs/diagnostics/log-gaps-2026-09-26.md): what   */
/* the paste itself has to say — which day, which boot, which build,     */
/* which phone — and every fact Lanes A and B now send.                  */
/* ==================================================================== */

/** A clock at the founder's #1032, 2026-09-25 00:46:00.551 UTC. */
const AT_1032 = Date.UTC(2026, 8, 25, 0, 46, 0, 551);

/** The line of the newest entry of `type`, from a report at a fixed zone. */
function lineOf(log, type) {
  const re = new RegExp(`^#\\d+\\s+\\S+ ${type}\\b`);
  return formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 }).split("\n").filter((l) => re.test(l)).at(-1);
}

test("GAPS: a record with NONE of the new fields renders exactly as before, except the intended changes", () => {
  /* The contract that lets the lanes merge in any order: every new field is
     optional, and a row from an older build prints the line it always did.
     The intended changes, and only these: the device and clock lines under
     the engine line, the `session events N:` count list, the `-- day --` and
     `== page boot ==` dividers, and `hidden=` on every voiceProbe line. Every
     row line below was diffed against origin/main's formatter byte for byte.
     MUTATION: print any new field unconditionally (e.g. `state=? item=—`) and
     a row here changes. */
  const T = Date.UTC(2026, 8, 24, 12, 0, 0);
  let seq = 0;
  const row = (dt, type, f) => ({ ...f, seq: ++seq, wall: T + dt, type });
  const entries = [
    row(0, "boot", { hidden: false, hydrated: true }),
    row(10, "build", { shell: true, web: "2b808ec9d50c5b98", native: "2026092401", version: "1.4.0" }),
    row(20, "data", { phase: "boot", trigger: null, status: null, source: "bundle", version: "seed-9fc92a61", code: null, forayId: null, forays: 6, playable: 40, ms: null, files: { forays: "bundle@seed-9fc92a61" }, hidden: false }),
    row(30, "data", { phase: "refresh", trigger: "foreground", status: "offline", source: null, version: null, code: "timeout", forayId: null, forays: null, playable: null, ms: 4001, files: null, hidden: false }),
    row(40, "transport", { source: "tap", action: "play", hidden: false }),
    row(50, "outPoint", { targetSec: 200, atSec: 200.1, overshootSec: 0.1, hidden: false }),
    row(60, "seam", { openedBy: "outPoint", fromId: "a", toId: "b", crossEpisode: true, askedGapMs: 500, holdMs: null, deadlineMs: 20000, deadlineFor: "hidden", observedGapMs: 812, lastStage: "playing", hiddenAtBoundary: true, hiddenAtStart: true, endOfQueue: false, stages: [] }),
    row(70, "media", { name: "stalled", repeated: 3, lastWall: T + 1070, hidden: true, hiddenForMs: 1616 }),
    row(80, "session", { kind: "interruptionBegan", reason: "began-while-held", producer: "audio", at: T + 66, lagMs: 14, hidden: false, hiddenForMs: null }),
    row(90, "remote", { command: "play", action: "play", origin: "command-center", handled: true, deduped: false, at: T + 85, lagMs: 5, hidden: true }),
    row(100, "stop", { source: "element", why: "pausedUnexpectedly", state: null, hidden: false, hiddenForMs: null, atSec: 494.4, readyState: 4, networkState: 2, errorCode: 0 }),
    row(110, "stop", { source: "reconcile", why: "visible", state: "interrupted", hidden: false }),
    row(120, "visibility", { to: "hidden", forMs: 38472 }),
    row(130, "resume", { phase: "write", wrote: true, forayId: "f1", index: 3, elapsedSec: 812 }),
    row(140, "nowplaying", { via: "metadata", title: "Ep", artist: "Show", album: "Foray", artworkCount: 1, state: "playing", writeOk: true, writeError: "", native: { installed: true, sends: 4, reason: null }, hidden: true }),
    row(150, "tapFail", { phase: "start", error: "NotAllowedError", repeated: 2, lastWall: T + 950, hidden: false }),
    row(160, "search", { qLen: 4, localMs: 1, localHits: 3, netMs: 118, netHits: 7, dirMs: null, dirHits: null, epMs: 300, epHits: 12, ctaMs: null, paintedMs: 2, path: "shows", hidden: false }),
    row(170, "voiceProbe", { engine: "kokoro-probe", probeOk: true, reason: null, provider: "cpu", model: "kokoro-82m-v1.0-q8f16", loadColdMs: 1840, loadWarmMs: 120, rtfCold: 0.94, rtfWarm: 0.61, audioSec: 77.4, audioFrom: "rendered", synthReason: null, synthFailures: 0, acceleratorWired: false, peakMemoryMb: 312, lockedOk: true, batteryPct: -3, hidden: false }),
    row(180, "voiceProbe", { engine: "kokoro-probe", probeOk: false, reason: "synthesis-failed", provider: null, model: null, loadColdMs: 457, loadWarmMs: 374, rtfCold: null, rtfWarm: null, audioSec: null, audioFrom: null, synthReason: "inference-threw", synthFailures: null, acceleratorWired: false, peakMemoryMb: 280.3, lockedOk: false, batteryPct: null, hidden: false }),
    row(190, "voiceProbe", { engine: "kokoro-probe", probeOk: false, reason: "model-absent", provider: null, model: null, loadColdMs: null, loadWarmMs: null, rtfCold: null, rtfWarm: null, audioSec: null, audioFrom: null, synthReason: null, synthFailures: null, acceleratorWired: false, peakMemoryMb: null, lockedOk: false, batteryPct: null, hidden: false }),
  ];
  const record = {
    v: 1, cap: 200, seq, dropped: 0, entries, saveErrors: 0, updatedAt: "2026-09-24T12:00:01.000Z",
    build: { shell: true, web: "2b808ec9d50c5b98", native: "2026092401", version: "1.4.0" },
    key: "cp_diag", store: { tiers: ["local"], hydrated: true },
  };
  assert.equal(formatDiagnosticReport(record, null, { tzOffsetMin: 420 }), [
    "4a playback diagnostics — v1",
    "build web 2b808ec9d50c5b98 · native 2026092401 (1.4.0)",
    "engine=js reason=undecided build=2026092401 | web=2b808ec9d50c5b98",
    "device unknown",
    "clock UTC (device UTC-07:00)",
    "  2026-09-24",
    "Local only. Nothing here is sent anywhere.",
    "",
    "entries 20 of 200 (oldest dropped first)",
    "dropped 0 · recorded 20 · writeErrors 0",
    "seams 1: 1 measured, 0 never started",
    "gap median 812ms, worst 812ms",
    "now playing 1 written, 0 with an empty credit",
    "session events 1:",
    "  interruptionBegan 1",
    "remote commands 1",
    "updated 2026-09-24T12:00:01.000Z",
    "",
    "-- 2026-09-24 (UTC) --",
    "== page boot ? ==",
    "#1    12:00:00.000 boot       hidden=n",
    "#2    12:00:00.010 build      web 2b808ec9d50c5b98 · native 2026092401 (1.4.0)",
    "#3    12:00:00.020 data       boot source=bundle v=seed-9fc92a61 forays=bundle@seed-9fc92a61 n=6 playable=40  hidden=n",
    "#4    12:00:00.030 data       refresh(foreground) offline why=timeout took 4001ms  hidden=n",
    "#5    12:00:00.040 transport  play from tap  hidden=n",
    "#6    12:00:00.050 outPoint   overshoot 0.100s  target 200s  at 200.1s  hidden=n",
    "#7    12:00:00.060 seam       a -> b  gap 812ms  asked 500ms  deadline 20000ms (hidden)  cross-episode  last=playing  hidden=y->y",
    "#8    12:00:00.070 media      stalled x3 over 1000ms  hidden=y  hiddenFor 1616ms",
    "#9    12:00:00.080 session    audio interruptionBegan (began-while-held)  lag 14ms  hidden=n",
    "#10   12:00:00.090 remote     play -> play from command-center  handled=y  lag 5ms  hidden=y",
    "#11   12:00:00.100 stop       element pausedUnexpectedly  state=?  hidden=n  at 494.4s rs=4 ns=2",
    "#12   12:00:00.110 stop       reconcile visible  state=interrupted  hidden=n",
    "#13   12:00:00.120 visibility -> hidden  after 38472ms",
    "#14   12:00:00.130 resume     write wrote=true forayId=f1 index=3 elapsedSec=812",
    "#15   12:00:00.140 nowplaying \"Ep\" / \"Show\" / \"Foray\"  art=1  state=playing  native=on/sent=4  hidden=y",
    "#16   12:00:00.150 tapFail    start failed  error=NotAllowedError  x2 over 800ms  hidden=n",
    "#17   12:00:00.160 search     qLen=4 local=1ms/3h net=118ms/7h dir=—/—h ep=300ms/12h cta=— painted=2ms path=shows  hidden=n",
    "#18   12:00:00.170 voiceProbe kokoro-probe/cpu(cpu-only)  rtf cold 0.94 warm 0.61  load 1840ms/120ms  peak 312MB  locked=y  batt -3%  over 77.4s(rendered)  hidden=n",
    "#19   12:00:00.180 voiceProbe kokoro-probe could not measure: synthesis-failed/inference-threw  load 457ms/374ms  peak 280.3MB  hidden=n",
    "#20   12:00:00.190 voiceProbe kokoro-probe could not measure: model-absent  hidden=n",
  ].join("\n"));
});

/* ---------- L21: which day, whose clock ---------- */

test("GAPS L21: the header says the clock is UTC, the phone's zone, and the days the rows span; a divider marks each new UTC day", () => {
  /* The paste's rows ran 00:41, 15:29, 23:44 with no date on any of them.
     MUTATION 1: drop the divider when the day changes — the second
     `-- 2026-09-25 (UTC) --` goes missing.
     MUTATION 2: flip the zone's sign — the header reads UTC+07:00. */
  const { log, diag, clock: c } = mk();
  c.set(Date.UTC(2026, 8, 24, 23, 59, 59, 900));
  diag.transport("tap", "play");
  c.set(Date.UTC(2026, 8, 25, 0, 0, 0, 100));
  diag.transport("tap", "pause");
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 });
  assert.match(text, /^clock UTC \(device UTC-07:00\)\n {2}2026-09-24\.\.2026-09-25$/m);
  const rows = text.split("\n").slice(text.split("\n").indexOf("-- 2026-09-24 (UTC) --"));
  assert.deepEqual(rows, [
    "-- 2026-09-24 (UTC) --",
    "#1    23:59:59.900 transport  play from tap  hidden=n",
    "-- 2026-09-25 (UTC) --",
    "#2    00:00:00.100 transport  pause from tap  hidden=n",
  ]);
  /* East of UTC, a half-hour zone, and a zone nobody could read. */
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: -330 }), /^clock UTC \(device UTC\+05:30\)$/m);
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: NaN }), /^clock UTC \(device zone unknown\)$/m);
});

test("GAPS L21: the clear mark prints its DATE, not only a time of day", () => {
  /* MUTATION: go back to `clockOf(cleared.wall)` — the date and the Z vanish. */
  const { log, diag, clock: c } = mk();
  c.set(Date.UTC(2026, 8, 23, 18, 4, 5, 6));
  diag.boot();
  log.clear();
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 }),
    /^cleared at #1 2026-09-23 18:04:05\.006Z\n {2}· 0 recorded since$/m);
});

/* ---------- L32: a Clear from before the mark is not a loss ---------- */

/** The founder's 2026-09-26 ring: seq 1208, 69 dropped, 200 rows #1009..#1208. */
function ringOf2026_09_26({ skip = null } = {}) {
  const entries = [];
  for (let s = 1009; s <= 1208; s++) {
    if (s === skip) continue;
    entries.push({ seq: s, wall: AT_1032 + s, type: "visibility", to: "hidden", forMs: 1 });
  }
  return { v: 1, cap: 200, seq: 1208, dropped: 69, entries, cleared: null, build: null, saveErrors: 0 };
}

test("GAPS L32: the 2026-09-26 MISSING 939 was the founder's own Clear from a pre-#746 build, and says so", () => {
  /* 1208 − 69 − 200 = 939, and the oldest kept row is #1009 = 939 + 69 + 1:
     the ring is whole from its first row up, so the only rows unaccounted for
     come before everything it ever dropped — an unmarked Clear.
     MUTATION 1: drop the unmarked-Clear branch. MISSING 939 comes back.
     MUTATION 2: take it for ANY gap. The mid-ring case below stops saying
     MISSING, and a real loss is hidden. */
  const text = formatDiagnosticReport(ringOf2026_09_26(), null, { tzOffsetMin: 420 });
  assert.match(text, /^939 rows before an unmarked Clear\n {2}\(pre-#746 build\), not lost$/m);
  assert.doesNotMatch(text, /MISSING/);
  /* A gap INSIDE the ring is still a loss, said as one. */
  const gap = formatDiagnosticReport(ringOf2026_09_26({ skip: 1100 }), null, { tzOffsetMin: 420 });
  assert.match(gap, /^MISSING 940 of 1208 recorded rows: not in this ring, not dropped/m);
  assert.doesNotMatch(gap, /unmarked Clear/);
});

test("GAPS L32: the log writes the inferred mark back ONCE, and the header names it as inferred", () => {
  /* MUTATION 1: skip the back-fill in `_load` — `cleared` reads null.
     MUTATION 2: let `clearedMarkOf` refuse `wall: null` — the mark is lost on
     the next load and the header goes back to the unmarked-Clear reading. */
  const store = fakeStore();
  store.setItem(DIAG_KEY, JSON.stringify(ringOf2026_09_26()));
  const c = clock(AT_1032 + 5000);
  const log = new DiagnosticLog({ storage: store, now: c.now });
  assert.deepEqual(log.cleared, { seq: 939, wall: null, inferred: true });
  let text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 });
  assert.match(text, /^cleared at #939 \(inferred, time unknown\)\n {2}· 269 recorded since$/m);
  assert.doesNotMatch(text, /MISSING|unmarked/);
  log.save();
  const again = new DiagnosticLog({ storage: store, now: c.now });
  assert.deepEqual(again.cleared, { seq: 939, wall: null, inferred: true }, "the mark round-trips");
  /* A real mid-ring gap is never back-filled. */
  const lossy = fakeStore();
  lossy.setItem(DIAG_KEY, JSON.stringify(ringOf2026_09_26({ skip: 1100 })));
  assert.equal(new DiagnosticLog({ storage: lossy, now: c.now }).cleared, null);
  /* And a clock-less mark that does NOT say inferred is not a mark. */
  const forged = fakeStore();
  forged.setItem(DIAG_KEY, JSON.stringify({ ...ringOf2026_09_26({ skip: 1100 }), cleared: { seq: 5, wall: null } }));
  assert.equal(new DiagnosticLog({ storage: forged, now: c.now }).cleared, null);
  text = formatDiagnosticReport(again.read(), null, { tzOffsetMin: 420 });
  assert.match(text, /entries 200 of 200/);
});

/* ---------- L22: which page boot ---------- */

test("GAPS L22: every page boot is numbered, survives a Clear, and heads its rows with a divider", () => {
  /* MUTATION 1: reset `_boots` in `clear()` — the third boot reads 1.
     MUTATION 2: drop the divider — `== page boot 3 ==` is gone. */
  const { log, diag, store } = mk();
  diag.boot();
  diag.boot();
  log.clear();
  diag.boot();
  assert.equal(parse(store).boots, 3);
  assert.equal(log.entries.at(-1).bootN, 3);
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 });
  assert.match(text, /^== page boot 3 ==\n#3 {4}\S+ boot {7}hidden=n$/m);
  /* A reload continues the count; "Delete my data" resets it. */
  const next = new PlayerDiagnostics({ log: new DiagnosticLog({ storage: store }), now: () => 1 });
  assert.equal(next.boot().bootN, 4);
  log.forget();
  assert.equal(log.boots, 0);
});

test("GAPS L22: where the engine decision landed is a row, from a closed set of lanes", () => {
  /* MUTATION: store the mode unchecked — `legacy` becomes a row. */
  const { log, diag } = mk();
  diag.engineMode({ mode: "native", reason: "build-default" });
  assert.equal(diag.engineMode({ mode: "legacy", reason: "x" }), null);
  diag.engineMode({ mode: "js", reason: "Bridge Error!" });
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 420 });
  assert.match(text, /^#1 {4}\S+ engineMode native \(build-default\)$/m);
  assert.match(text, /^#2 {4}\S+ engineMode js \(\?\)$/m, "prose is not a reason");
});

/* ---------- L09: which phone ---------- */

test("GAPS L09: the header names the phone and its OS from the freshest source, and never guesses", () => {
  /* MUTATION 1: skip the page's own OS — the first reading is `device unknown`.
     MUTATION 2: prefer the page's UA over the probe's device — iPhone15.2 is lost. */
  const { log, diag } = mk();
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /^device unknown$/m);
  diag.build({ shell: true, web: "2b808ec9d50c5b98", native: "2026092602", version: "1.0", os: "18.6.2", platform: "ios" });
  assert.equal(log.build.os, "18.6.2", "the running stamp keeps the OS across a Clear");
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /^device \? · iOS 18\.6\.2$/m);
  diag.voiceProbe({ engine: "kokoro-probe", ok: false, reason: "model-absent", device: "iPhone15.2", os: "18.6.2", platform: "ios", lowPower: false });
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 });
  assert.match(text, /^device iPhone15\.2 · iOS 18\.6\.2 · lowPower=n$/m);
  /* The device line sits right under the engine line, inside the phone width. */
  const lines = text.split("\n");
  assert.ok(lines[3].startsWith("device "));
  assert.ok(lines[3].length <= 44, lines[3]);
  /* An OS that is not a version is not stored. */
  diag.build({ shell: false, web: "2b808ec9d50c5b98", os: "18.6.2; rm -rf" });
  assert.equal(log.build.os, undefined);
});

/* ---------- Lane B: session and remote facts (L13-L20, L27) ---------- */

test("GAPS Lane B: a session row prints every fact the plugin sends, in the contract's order", () => {
  /* One exact line per fact. MUTATION: drop any one part from the session
     line (e.g. `raw=`) — its line here changes. */
  const { log, diag, clock: c } = mk();
  c.set(AT_1032);
  diag.sessionEvent({
    kind: "routeChange", reason: "unknown", producer: "audio", at: AT_1032 - 38041,
    from: "speaker", to: "carplay", rawReason: 8, cat: "playback", mode: "spoken-audio", mix: false,
    other: true, hint: true, nseq: 12, nboot: 1_758_000_000_000,
  });
  assert.equal(lineOf(log, "session"),
    "#1    00:46:00.551 session    audio routeChange @00:45:22.510 (unknown) speaker->carplay raw=8 cat=playback/spoken-audio mix=n other=y hint=y  lag 38041ms  hidden=n");
  diag.sessionEvent({ kind: "sessionActivated", reason: "failed", at: AT_1032 - 1, err: "insufficient-priority", app: "bg", cat: "ambient", mode: "default", mix: true, other: true });
  assert.equal(lineOf(log, "session"),
    "#2    00:46:00.551 session    audio sessionActivated (failed) err=insufficient-priority app=bg cat=ambient/default mix=y other=y  lag 1ms  hidden=n");
  diag.sessionEvent({ kind: "interruptionBegan", reason: "began-while-held", at: AT_1032, why: "app-suspended" });
  assert.match(lineOf(log, "session"), / interruptionBegan \(began-while-held\) why=app-suspended {2}lag 0ms/);
  diag.sessionEvent({ kind: "interruptionEnded", reason: "should-resume", at: AT_1032, durMs: 41_234 });
  assert.match(lineOf(log, "session"), / interruptionEnded \(should-resume\) dur 41\.2s {2}lag/);
  diag.sessionEvent({ kind: "nowPlayingReasserted", reason: "background", at: AT_1032, np: "paused", cmds: "play,pause,toggle,skipf,skipb", info: true });
  assert.match(lineOf(log, "session"), / nowPlayingReasserted \(background\) np=paused cmds=play,pause,toggle,skipf,skipb info=y {2}lag/);
  /* L27: the phone's pressure is admitted as session kinds. */
  diag.sessionEvent({ kind: "memoryWarning", reason: "warning", at: AT_1032, availMb: 212 });
  assert.match(lineOf(log, "session"), / memoryWarning \(warning\) avail 212MB {2}lag/);
  assert.ok(diag.sessionEvent({ kind: "thermal", reason: "serious", at: AT_1032 }));
  assert.ok(diag.sessionEvent({ kind: "lowPower", reason: "on", at: AT_1032 }));
  assert.ok(SESSION_KINDS.has("thermal") && SESSION_KINDS.has("lowPower") && SESSION_KINDS.has("memoryWarning"));
  /* nseq/nboot are stored, never printed. */
  assert.equal(log.entries[0].nseq, 12);
  assert.doesNotMatch(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /nseq|nboot|1758000000000/);
  /* L31: the header counts each kind, and the failed ones, packed to the
     phone's width — no item is split across lines. */
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 });
  const at = text.split("\n").indexOf("session events 8:");
  assert.deepEqual(text.split("\n").slice(at, at + 6), [
    "session events 8:",
    "  routeChange 1,",
    "  sessionActivated 1 (1 failed),",
    "  interruptionBegan 1, interruptionEnded 1,",
    "  nowPlayingReasserted 1, memoryWarning 1,",
    "  thermal 1, lowPower 1",
  ]);
  /* An engine-owned skip is counted as one, beside the failures. */
  diag.sessionEvent({ kind: "sessionActivated", reason: "skipped-engine-owned", at: AT_1032 });
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /^ {2}sessionActivated 2 \(1 failed, 1 skipped\),$/m);
});

test("GAPS Lane B: every fact outside its vocabulary is dropped — a car's NAME never enters the record", () => {
  /* PORT TYPES ONLY: `portName` is often a person's name.
     MUTATION: admit `to` by a token shape instead of the closed port set —
     `Wyatt's Car` fails the shape, but `bluetoothA2DP` would get in. */
  const { log, diag, store } = mk();
  const e = diag.sessionEvent({
    kind: "routeChange", reason: "new-device", at: 1,
    to: "Wyatt's Car", from: "bluetoothA2DP", rawReason: "8", cat: "Playback", mode: "voiceChat",
    mix: "y", err: "failed: busy", app: "background", why: "Siri", durMs: -5, np: "Playing",
    cmds: "play,volume", info: 1, other: "yes", hint: null, availMb: NaN, nseq: 1.5, nboot: -1,
  });
  for (const k of ["to", "from", "rawReason", "cat", "mode", "mix", "err", "app", "why", "durMs", "np", "cmds", "info", "other", "hint", "availMb", "nseq", "nboot"]) {
    assert.ok(!(k in e), `${k} was admitted off-vocabulary`);
  }
  assert.doesNotMatch(store.getItem(DIAG_KEY), /Wyatt|bluetoothA2DP|volume|Siri/);
  assert.doesNotMatch(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /Wyatt|->/);
  const r = diag.remoteCommand({ command: "play", action: "play", origin: "command-center", handled: true, at: 1, route: "Wyatt's Car", app: "fg" });
  assert.ok(!("route" in r) && !("app" in r));
});

test("GAPS L19: a remote row names the route TYPE and the app's state before handled=", () => {
  /* MUTATION: drop ` route=` from the remote line. */
  const { log, diag, clock: c } = mk();
  c.set(AT_1032);
  diag.remoteCommand({ command: "play", action: "play", origin: "command-center", handled: true, at: AT_1032 - 5, route: "carplay", app: "bg", nseq: 3, nboot: 7 });
  assert.equal(lineOf(log, "remote"),
    "#1    00:46:00.551 remote     play -> play from command-center route=carplay app=bg  handled=y  lag 5ms  hidden=n");
});

test("GAPS L20: native events lost are counted per process from the plugin's own numbers", () => {
  /* Process A numbered 1,2,3,5 (one lost), process B 1 and 4 (two lost).
     MUTATION 1: pool the processes — {1..5} reads as nothing lost.
     MUTATION 2: count remote rows out — A reads 2 lost. */
  const { log, diag } = mk();
  assert.doesNotMatch(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /native events lost/, "silent with no nseq");
  const A = 1_758_000_000_000;
  const B = A + 3_600_000;
  diag.sessionEvent({ kind: "background", at: 1, nseq: 1, nboot: A });
  diag.sessionEvent({ kind: "foreground", at: 1, nseq: 2, nboot: A });
  diag.remoteCommand({ command: "play", origin: "command-center", at: 1, nseq: 3, nboot: A });
  diag.sessionEvent({ kind: "background", at: 1, nseq: 5, nboot: A });
  diag.sessionEvent({ kind: "background", at: 1, nseq: 1, nboot: B });
  diag.sessionEvent({ kind: "foreground", at: 1, nseq: 4, nboot: B });
  diag.sessionEvent({ kind: "foreground", at: 1 });
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /^native events lost 3 \(nseq gaps\)$/m);
  /* Whole numbering prints nothing: the line is a finding, not a status. */
  const whole = mk();
  whole.diag.sessionEvent({ kind: "background", at: 1, nseq: 7, nboot: A });
  whole.diag.sessionEvent({ kind: "foreground", at: 1, nseq: 8, nboot: A });
  assert.doesNotMatch(formatDiagnosticReport(whole.log.read(), null, { tzOffsetMin: 0 }), /native events lost/);
});

test("GAPS L33: what a vocabulary refuses is COUNTED by door, persisted, and survives a Clear — the text never is", () => {
  /* The log's own rule is "nothing is dropped silently"; these three returned
     null and said nothing.
     MUTATION 1: return null without counting — the header line is missing.
     MUTATION 2: reset `_refused` in `clear()` — the counts after the Clear are 0. */
  const { log, diag, store } = mk();
  assert.equal(diag.sessionEvent({ kind: "carPlayConnected", reason: "Wyatt's Car" }), null);
  assert.equal(diag.sessionEvent({ kind: "siri" }), null);
  assert.equal(diag.remoteCommand({ command: "like", origin: "webkit" }), null);
  assert.equal(diag.transport("siri", "play"), null);
  assert.deepEqual(log.refused, { session: 2, remote: 1, transport: 1 });
  diag.boot();
  assert.deepEqual(parse(store).refused, { session: 2, remote: 1, transport: 1 }, "persisted with the next write");
  assert.doesNotMatch(store.getItem(DIAG_KEY), /carPlayConnected|Wyatt|like|siri/);
  assert.match(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }),
    /^refused by vocabulary: session x2,\n {2}remote x1, transport x1$/m);
  log.clear();
  assert.deepEqual(log.refused, { session: 2, remote: 1, transport: 1 });
  log.forget();
  assert.deepEqual(log.refused, { session: 0, remote: 0, transport: 0 });
  assert.doesNotMatch(formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 }), /refused by vocabulary/);
});

/* ---------- L24: what the player believed at a stop ---------- */

test("GAPS L24: an unexplained stop says the player's state, its item, and how long since the last remote and session rows", () => {
  /* `state=?` on every pausedUnexpectedly row was a hard-coded null.
     MUTATION 1: go back to `state: null` — `state=playing` is gone.
     MUTATION 2: measure since the OLDEST remote row — sinceRemote reads 3.2s. */
  const store = fakeStore();
  const c = clock(AT_1032);
  const log = new DiagnosticLog({ storage: store, now: c.now });
  let belief = { state: "playing", item: "seg-12" };
  const diag = new PlayerDiagnostics({ log, now: c.now, getState: () => belief });
  diag.remoteCommand({ command: "play", origin: "command-center", at: c.now() });
  c.tick(2000);
  diag.remoteCommand({ command: "pause", origin: "command-center", at: c.now() });
  c.tick(1160);
  diag.sessionEvent({ kind: "routeChange", reason: "new-device", at: c.now() });
  c.tick(40);
  diag.note("audio.pausedUnexpectedly t=494.4 rs=4 ns=2 err=0 — nobody asked for this pause");
  assert.equal(lineOf(log, "stop"),
    "#4    00:46:03.751 stop       element pausedUnexpectedly  state=playing item=seg-12 sinceRemote 1.2s sinceSession 40ms  hidden=n  at 494.4s rs=4 ns=2");
  /* The audio.error and play.rejected stops carry it too. */
  diag.note("audio.error code=4 src=https://cdn.example/x.mp3?token=abc");
  assert.match(lineOf(log, "stop"), /audio\.error\.code=4 {2}state=playing item=seg-12 sinceRemote 1\.2s sinceSession 40ms/);
  diag.note("play.rejected NotAllowedError");
  assert.match(lineOf(log, "stop"), /play\.rejected\.NotAllowedError {2}state=playing item=seg-12/);
  /* A belief that is not a token or an id is dropped; a throwing one is not the outage. */
  belief = { state: "playing now", item: "https://cdn.example/x?y" };
  diag.note("audio.pausedUnexpectedly");
  assert.match(lineOf(log, "stop"), /pausedUnexpectedly {2}state=\? sinceRemote/);
  const boom = new PlayerDiagnostics({ log, now: c.now, getState: () => { throw new Error("no manager"); } });
  assert.doesNotThrow(() => boom.note("audio.pausedUnexpectedly"));
  assert.doesNotMatch(store.getItem(DIAG_KEY), /cdn\.example|token=abc/);
});

/* ---------- L25: what the element was doing at a stall ---------- */

test("GAPS L25: a stall row carries the element's own state on the FIRST row of a run", () => {
  /* MUTATION 1: drop `ahead` — a starving element and a throttled paused one
     read the same again. MUTATION 2: overwrite the facts on a repeat. */
  const { log, diag, clock: c } = mk();
  c.set(AT_1032);
  diag.mediaEvent("stalled", { paused: true, atSec: 312.43, rs: 2, ns: 2, aheadSec: 0, online: true });
  diag.mediaEvent("stalled", { paused: false, atSec: 999, rs: 4, ns: 1, aheadSec: 60, online: false });
  assert.equal(lineOf(log, "media"),
    "#1    00:46:00.551 media      stalled x2 over 0ms paused=y at 312.4s rs=2 ns=2 ahead 0.0s online=y  hidden=n");
  /* A fact of the wrong type is dropped, never stringified. */
  diag.mediaEvent("waiting", { paused: "no", atSec: "312", rs: 2.5, ns: -1, aheadSec: Infinity, online: "y" });
  assert.equal(lineOf(log, "media"), "#2    00:46:00.551 media      waiting  hidden=n");
  /* The native lane's facade has no element to describe: `online` alone
     prints alone, never beside five `?`s.
     MUTATION: gate the element block on `online` too — `paused=?` returns. */
  diag.mediaEvent("stalled", { online: false });
  assert.equal(lineOf(log, "media"), "#3    00:46:00.551 media      stalled online=n  hidden=n");
});

/* ---------- L26: a refresh's bound and stage ---------- */

test("GAPS L26: a data row says the bound its time was held to, which request, the held set, online, and time since foreground", () => {
  /* MUTATION: print `took` without `/limit` — `took 4001ms/4000` reads as a
     plain 4 s, which is exactly the ambiguity the founder's paste had. */
  const { log, diag, clock: c } = mk();
  c.set(AT_1032);
  diag.visibility(true);
  c.tick(5000);
  diag.visibility(false);
  c.tick(120);
  assert.equal(diag.sinceForegroundMs(), 120);
  diag.dataSource({
    phase: "refresh", trigger: "foreground", status: "offline", code: "timeout", ms: 4001,
    stage: "pointer", limitMs: 4000, held: "123", online: true, sinceFgMs: diag.sinceForegroundMs(),
  });
  assert.equal(lineOf(log, "data"),
    "#3    00:46:05.671 data       refresh(foreground) offline why=timeout took 4001ms/4000 stage=pointer held=v123 online=y sinceFg 120ms  hidden=n");
  diag.dataSource({ phase: "refresh", status: "offline", stage: "dns", held: "../a b", online: "yes", sinceFgMs: -1, limitMs: "4000" });
  assert.equal(lineOf(log, "data"), "#4    00:46:05.671 data       refresh offline  hidden=n");
});

/* ---------- L06 + Lane A: the voice probe says why, and on what ---------- */

/** The 2026-09-26 probe, as Lane A's summarizeProbe would hand it over. */
const PROBE_2026_09_26 = Object.freeze({
  engine: "kokoro-probe", ok: false, reason: "synthesis-failed", synthReason: "inference-threw",
  provider: "cpu", model: "kokoro-82m-v1.0-q8f16", modelLoadColdMs: 457, modelLoadWarmMs: 374,
  synthColdMs: 812, synthWarmMs: 2210, elapsedMs: 9000, synthFailures: 4, lines: 4,
  peakMemoryMb: 312, availableMemoryMb: 1104, baseMemoryMb: 142, memWarn: false,
  platform: "ios", ortCode: "not-implemented", ortOp: "ConvTranspose", ortStage: "run", loadErr: null,
  lineOutcomes: "threw,threw,threw,threw", nonFiniteLines: 0, silentLines: 0,
  ortVersion: "1.20.0", intraThreads: 0, cores: 6, modelBytes: 86033585, modelSha8: "04c658ae", modelPin: "ok",
  device: "iPhone15.2", os: "18.6.2", thermalStart: "nominal", thermalEnd: "nominal", lowPower: false, bgAtFail: true,
});

test("GAPS L06/Lane A: the 2026-09-26 probe failure says WHY and ON WHAT, on one line", () => {
  /* The paste said `could not measure: synthesis-failed/inference-threw load
     457ms/374ms peak 280.3MB`. Pinned exactly, so dropping ANY part fails.
     MUTATION: drop any one tail part (ort=, lines, synth, mem, ort, model,
     device, thermal, playing, bgAtFail, hidden=). */
  const { log, diag, store, clock: c } = mk();
  c.set(Date.UTC(2026, 8, 26, 23, 44, 42, 684));
  store.hidden = true;
  diag.voiceProbe(PROBE_2026_09_26, { playing: false });
  assert.equal(lineOf(log, "voiceProbe"),
    "#1    23:44:42.684 voiceProbe kokoro-probe/cpu could not measure: synthesis-failed/inference-threw" +
    " ort=not-implemented op=ConvTranspose at=run  failed 4/4 lines threw,threw,threw,threw" +
    "  load 457ms/374ms  synth 812ms/2210ms  mem base 142 peak 312MB avail 1104MB warn=n" +
    "  ort 1.20.0 t=auto/6c  model q8f16 86033585B sha 04c658ae pin=ok  iPhone15.2 iOS 18.6.2" +
    "  thermal nominal>nominal lowPower=n  playing=n bgAtFail=y  hidden=y");
  /* NaN and silent lines, a failed load, a fixed thread count, Android. */
  diag.voiceProbe({
    ...PROBE_2026_09_26, loadErr: "invalid-protobuf", nonFiniteLines: 2, silentLines: 1,
    intraThreads: 4, platform: "android", device: "Pixel-8", os: "14", bgAtFail: null,
  });
  const line = lineOf(log, "voiceProbe");
  assert.match(line, / {2}load FAILED\(invalid-protobuf\) 457ms\/374ms /);
  assert.match(line, / {2}ort 1\.20\.0 t=4\/6c /);
  assert.match(line, / {2}Pixel-8 Android 14 /);
  assert.match(line, / {2}nan 2\/4 {2}silent 1\/4 {2}hidden=y$/);
});

test("GAPS L06/Lane A: a success line keeps its K-01 numbers and appends the same tail", () => {
  /* MUTATION: build the tail only on the failure path. */
  const { log, diag } = mk();
  diag.voiceProbe({
    ...PROBE_2026_09_26, ok: true, reason: null, synthReason: null, synthFailures: 0, ortCode: null,
    ortOp: null, ortStage: null, lineOutcomes: "ok,ok,ok,ok", rtfCold: 0.94, rtfWarm: 0.61,
    audioSec: 77.4, audioFrom: "rendered", lockedScreenCompleted: true, batteryDeltaPct: -3,
    thermalEnd: "fair", bgAtFail: null,
  }, { playing: true });
  assert.equal(lineOf(log, "voiceProbe").replace(/^#1 {4}\S+ /, ""),
    "voiceProbe kokoro-probe/cpu(cpu-only)  rtf cold 0.94 warm 0.61  load 457ms/374ms  peak 312MB  locked=y" +
    "  batt -3%  over 77.4s(rendered) lines ok,ok,ok,ok  mem base 142 avail 1104MB warn=n  ort 1.20.0 t=auto/6c" +
    "  model q8f16 86033585B sha 04c658ae pin=ok  iPhone15.2 iOS 18.6.2  thermal nominal>fair lowPower=n" +
    "  playing=y  hidden=n");
});

test("GAPS Lane A: a probe value in the wrong shape is dropped, never stored — a path, a comma, a ninth hex digit", () => {
  /* voiceProbe re-validates what summarizeProbe already sanitised: this file
     imports nothing and does not trust a caller.
     MUTATION: store `ortOp` or `device` unchecked — the path or the comma
     reaches the blob. */
  const { log, diag, store } = mk();
  const e = diag.voiceProbe({
    engine: "kokoro-probe", ok: false, reason: "synthesis-failed",
    ortOp: "/var/mobile/Containers/Data/Application/X/model.onnx", ortCode: "segfault", ortStage: "load",
    device: "iPhone15,2", os: "18.6.2 beta", modelSha8: "04c658ae1", modelPin: "yes",
    lineOutcomes: "ok,boom", thermalStart: "hot", lowPower: "n", intraThreads: -1, cores: 6.5,
  });
  for (const k of ["ortOp", "ortCode", "ortStage", "device", "os", "modelSha8", "modelPin", "lineOutcomes", "thermalStart", "lowPower", "intraThreads", "cores"]) {
    assert.ok(!(k in e), `${k} was admitted in a wrong shape`);
  }
  assert.doesNotMatch(store.getItem(DIAG_KEY), /var\/mobile|iPhone15,2|04c658ae1|boom/);
  assert.equal(lineOf(log, "voiceProbe").replace(/^#1 {4}\S+ /, ""),
    "voiceProbe kokoro-probe could not measure: synthesis-failed  hidden=n");
});

/* ==================================================================== */
/* Phase 2 (2026-09-28): the narration fallback row                      */
/* ==================================================================== */

test("a narration fallback line becomes ONE `narration` row: reason, path, item and host — never the URL", () => {
  /* queue-manager.js §14. The line is the manager's own; the row keeps four
     vocabulary-or-shape fields. MUTATION: store `hit[4]` unchecked, or drop the
     RE entry — the row is missing or carries the text. */
  const { log, diag, store } = mk();
  assert.equal(diag.note("narration.fallback reason=timeout at=load item=nar-1 host=audio.jwlabs.ai"), true);
  const row = log.entries.find((e) => e.type === "narration");
  assert.ok(row, "a narration row was recorded");
  assert.equal(row.source, "fallback");
  assert.equal(row.reason, "timeout");
  assert.equal(row.at, "load");
  assert.equal(row.item, "nar-1");
  assert.equal(row.host, "audio.jwlabs.ai");
  assert.equal(row.hidden, false);
  assert.match(formatDiagnosticReport(log.read()), /narration  fallback timeout at=load  item=nar-1  host=audio\.jwlabs\.ai  hidden=n/);
  assert.doesNotMatch(store.getItem(DIAG_KEY), /narration\/|\.m4a/, "no path reaches the record");
});

test("a narration fallback row admits only its vocabulary and a host-shaped host", () => {
  const { log, diag, store } = mk();
  diag.note("narration.fallback reason=https://x.test/?t=1 at=somewhere item=has/slash host=user:pw@x.test/path");
  const row = log.entries.find((e) => e.type === "narration");
  assert.equal(row.reason, null);
  assert.equal(row.at, null);
  assert.equal(row.item, null);
  assert.equal(row.host, null);
  assert.doesNotMatch(store.getItem(DIAG_KEY), /x\.test|pw@/);
  assert.equal(audioHostTokenOf("audio.jwlabs.ai"), "audio.jwlabs.ai");
  assert.equal(audioHostTokenOf("AUDIO.jwlabs.ai"), null, "the manager lower-cases; anything else is refused");
  assert.equal(audioHostTokenOf("-"), null, "no host (a relative asset) is stored as null");
  for (const r of ["timeout", "network", "decode", "unsupported", "play-rejected", "failed"]) assert.ok(NARRATION_FALLBACK_REASONS.has(r));
  for (const a of ["load", "bridge", "playing"]) assert.ok(NARRATION_FALLBACK_AT.has(a));
});

test("the narration stages reach an open seam's trail by name", () => {
  assert.equal(stageOf("narration.fallback reason=timeout at=bridge item=n host=h"), "narration.fallback");
  assert.equal(stageOf("prefetch.narration.started n1 hidden=y"), "prefetch.narration.started");
});

/* ---------- A-09: the Android plugin's session rows ---------- */

test("A-09: every row SessionMonitor.java writes is admitted and printed with its facts", () => {
  /* The Android twin of Lane B's exact-line test: the kinds, reasons and facts
     `SessionMonitor.java` sends (its constants are pinned to these words by
     shell-invariants.test.mjs). MUTATION: drop "focusChange" from
     SESSION_KINDS — the first sessionEvent returns null and the inferred loss
     never reaches the paste. */
  const { log, diag, clock: c } = mk();
  c.set(AT_1032);
  assert.ok(SESSION_KINDS.has("focusChange"));
  diag.sessionEvent({ kind: "focusChange", reason: "lost-inferred", producer: "audio", at: AT_1032, other: true, app: "bg" });
  assert.match(lineOf(log, "session"), / audio focusChange \(lost-inferred\) app=bg other=y {2}lag 0ms/);
  diag.sessionEvent({ kind: "focusChange", reason: "regained-inferred", producer: "audio", at: AT_1032, other: false, durMs: 41_234 });
  assert.match(lineOf(log, "session"), / audio focusChange \(regained-inferred\) dur 41\.2s {2}lag/);
  diag.sessionEvent({ kind: "routeChange", reason: "new-device", producer: "audio", at: AT_1032, from: "speaker", to: "a2dp" });
  assert.match(lineOf(log, "session"), / audio routeChange \(new-device\) speaker->a2dp {2}lag/);
  diag.sessionEvent({ kind: "routeChange", reason: "device-removed", producer: "audio", at: AT_1032, from: "a2dp", to: "speaker" });
  assert.match(lineOf(log, "session"), / audio routeChange \(device-removed\) a2dp->speaker {2}lag/);
  diag.sessionEvent({ kind: "routeChange", reason: "old-device-gone", producer: "audio", at: AT_1032, from: "wired" });
  assert.match(lineOf(log, "session"), / audio routeChange \(old-device-gone\) wired->\? {2}lag/);
  diag.sessionEvent({ kind: "memoryWarning", reason: "running-critical", producer: "audio", at: AT_1032, availMb: 96, app: "active" });
  assert.match(lineOf(log, "session"), / audio memoryWarning \(running-critical\) app=active avail 96MB {2}lag/);
  diag.sessionEvent({ kind: "background", reason: "did-enter", producer: "audio", at: AT_1032 });
  diag.sessionEvent({ kind: "foreground", reason: "will-enter", producer: "audio", at: AT_1032 });
  /* The refusal names the exception's CLASS, as a token. */
  diag.sessionEvent({ kind: "sessionActivated", reason: "refused-foreground-service-start-not-allowed", producer: "audio", at: AT_1032, app: "bg" });
  assert.match(lineOf(log, "session"), / audio sessionActivated \(refused-foreground-service-start-not-allowed\) app=bg {2}lag/);
  /* And the header counts it as a failure. MUTATION: count only `failed`. */
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 });
  assert.match(text, /sessionActivated 1 \(1 failed\)/);
  assert.match(text, /focusChange 2/);
});

/* ---------- #29: a download attempt is a session row (29-part) ----------

   `DownloadStore.swift` raises one `downloadAttempt` per download attempt and
   `download-bridge.js` re-broadcasts it as a `foray:session` row from the
   `downloads` producer. What the device check (docs/downloads-device-check.md
   step 6) reads off it: the host asked for, the host the bytes came from, the
   HTTP status, the byte counts and the outcome. HOSTS ONLY: the enclosure
   URL's path and query never reach the record. */

test("#29: a download attempt keeps two HOSTS, the status, the byte counts and a closed outcome", () => {
  /* MUTATION: drop "downloadAttempt" from SESSION_KINDS -> the row is
     refused and this is null. MUTATION: admit `reqHost` with `asText` instead
     of `audioHostTokenOf` -> the URL below is stored and the first
     `undefined` assertion fails. */
  const { diag, log, clock: c } = mk();
  c.set(AT_1032);
  const e = diag.sessionEvent({
    kind: "downloadAttempt", producer: "downloads", reason: "done", at: AT_1032 - 4,
    reqHost: "dts.podtrac.com", finalHost: "traffic.megaphone.fm", status: 200,
    expected: 52_428_800, received: 52_428_800,
  });
  assert.ok(e, "downloadAttempt is a session kind");
  assert.equal(e.producer, "downloads");
  assert.equal(e.reason, "done");
  assert.equal(e.reqHost, "dts.podtrac.com");
  assert.equal(e.finalHost, "traffic.megaphone.fm");
  assert.equal(e.status, 200);
  assert.equal(e.expected, 52_428_800);
  assert.equal(e.received, 52_428_800);
  assert.equal(e.lagMs, 4);
  const urlish = diag.sessionEvent({
    kind: "downloadAttempt", producer: "downloads", reason: "done",
    reqHost: "https://dts.podtrac.com/redirect.mp3/x?token=abc", finalHost: "Traffic.Megaphone.fm:443",
    status: 99, expected: -1, received: 1.5,
  });
  assert.equal(urlish.reqHost, undefined, "a URL is not a host and is left off");
  assert.equal(urlish.finalHost, undefined, "nor is a host with a port or capitals");
  assert.equal(urlish.status, undefined, "an HTTP status is 100-599");
  assert.equal(urlish.expected, undefined, "an unknown length is absent, never -1");
  assert.equal(urlish.received, undefined, "a byte count is a whole number");
  assert.equal(log.read().entries.length, 2);
});

test("#29: a download outcome comes from its closed set, and the download fields stay off every other kind", () => {
  /* MUTATION: admit the outcome with `dataTokenOf` alone -> "page-wrote-this"
     is stored. MUTATION: attach the download fields to every session kind ->
     the `background` row carries `reqHost`. */
  const { diag } = mk();
  assert.deepEqual([...DOWNLOAD_OUTCOMES].sort(),
    ["cancelled", "done", "network", "not-saved", "refused-redirect", "refused-status"]);
  for (const o of DOWNLOAD_OUTCOMES) {
    assert.equal(diag.sessionEvent({ kind: "downloadAttempt", producer: "downloads", reason: o }).reason, o);
  }
  assert.equal(diag.sessionEvent({ kind: "downloadAttempt", producer: "downloads", reason: "page-wrote-this" }).reason, "");
  const bg = diag.sessionEvent({ kind: "background", reason: "did-enter", reqHost: "a.example", status: 200, received: 4 });
  assert.equal(bg.reqHost, undefined);
  assert.equal(bg.status, undefined);
  assert.equal(bg.received, undefined);
  assert.ok(SESSION_PRODUCERS.has("downloads"));
});

test("#29: a download attempt prints as one line a device check can read", () => {
  /* MUTATION: drop the `req=` part from the session line -> the line changes.
     The header counts it beside the other session kinds. */
  const { diag, log, clock: c } = mk();
  c.set(AT_1032);
  diag.sessionEvent({
    kind: "downloadAttempt", producer: "downloads", reason: "done", at: AT_1032 - 4,
    reqHost: "dts.podtrac.com", finalHost: "traffic.megaphone.fm", status: 200,
    expected: 52_428_800, received: 52_428_800,
  });
  assert.equal(lineOf(log, "session").replace(/^#\d+\s+\S+ /, ""),
    "session    downloads downloadAttempt (done) req=dts.podtrac.com final=traffic.megaphone.fm http=200 bytes 52428800/52428800  lag 4ms  hidden=n");
  diag.sessionEvent({ kind: "downloadAttempt", producer: "downloads", reason: "refused-status", at: AT_1032, reqHost: "dts.podtrac.com", status: 403, received: 0 });
  assert.equal(lineOf(log, "session").replace(/^#\d+\s+\S+ /, ""),
    "session    downloads downloadAttempt (refused-status) req=dts.podtrac.com final=? http=403 bytes 0/?  lag 0ms  hidden=n");
  const text = formatDiagnosticReport(log.read(), null, { tzOffsetMin: 0 });
  assert.match(text, /downloadAttempt 2 \(1 failed\)/);
});

test("#29 + L24: a download row never explains a stop -- sinceSession skips it", () => {
  /* L24's sinceSession points whoever triages a pause the page did not make
     at an audio-session event (a route change, an interruption). A download
     finishing is neither, and the player never acts on one.
     MUTATION: measure sinceSessionMs from the newest `session` row of any
     kind -> the first stop reads 2000ms, the second carries a number. */
  const store = fakeStore();
  const c = clock(AT_1032);
  const log = new DiagnosticLog({ storage: store, now: c.now });
  const diag = new PlayerDiagnostics({ log, now: c.now, getState: () => ({ state: "playing", item: "seg-12" }) });
  diag.sessionEvent({ kind: "routeChange", reason: "new-device", at: c.now() });
  c.tick(5000);
  diag.sessionEvent({ kind: "downloadAttempt", producer: "downloads", reason: "done", at: c.now(), reqHost: "dts.podtrac.com", status: 200 });
  c.tick(2000);
  diag.note("audio.pausedUnexpectedly t=494.4 rs=4 ns=2 err=0");
  const stop = () => log.read().entries.filter((e) => e.type === "stop").at(-1);
  assert.equal(stop().sinceSessionMs, 7000, "measured from the route change, not the download");
  assert.match(lineOf(log, "stop"), /sinceSession 7000ms/);
  /* With only a download row in the ring, the stop has no session to point at. */
  const only = mk();
  only.clock.set(AT_1032);
  only.diag.sessionEvent({ kind: "downloadAttempt", producer: "downloads", reason: "done", at: AT_1032 });
  only.clock.tick(2000);
  only.diag.note("audio.pausedUnexpectedly t=1 rs=4 ns=2 err=0");
  const lone = only.log.read().entries.filter((e) => e.type === "stop").at(-1);
  assert.equal(lone.sinceSessionMs, null);
  assert.doesNotMatch(lineOf(only.log, "stop"), /sinceSession/);
});
