/* The engine half of 'Playback diagnostics → Copy' (card NE-26,
 * docs/native-engine-plan.md §4.1, §10).
 *
 * WHAT THIS SUITE COVERS, and where the rest is:
 *   - the merge of the engine's ring into the page's record, by wall clock,
 *     at the ring's full 2,000 rows (the card's acceptance);
 *   - the engine header line, in both modes;
 *   - the per-kind engine lines (session, remote, mode, the packed seam row,
 *     grace, probe, lifecycle, build) and the rule that nothing is dropped
 *     silently: unknown kinds, unreadable rows, evicted and missing seqs, and
 *     rows from before the page's Clear are all COUNTED on the header;
 *   - the one bounded engineRead, through the real native-engine.js client;
 *   - the pin that every row kind the Swift engine writes has a line here.
 * The sheet's side (Copy takes the merged text, inside the tap) is
 * test/diagnostics-surface.test.js; client.js's wiring is
 * player/diagnostic-record.test.js.
 *
 * Each test names the mutation that kills it. Runs on Windows: no Swift.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDiagnosticReport, mergeEngineRows, normalizeEngineRows, engineHeaderLine, engineLineFor,
  ENGINE_ROW_KINDS, ENGINE_RING_CAP,
} from "./diagnostic-log.js";
import {
  engineDiagnosticReport, readEngineDiagnostics, pageEngineDecision, pageEngineView, engineBridgePresent,
  ENGINE_READ_TIMEOUT_MS,
} from "./engine-diagnostics.js";
import { createNativeEngine, ENGINE_PLUGIN } from "./native-engine.js";
import { manualScheduler } from "./parity/fakes.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

/** A page record with `n` visibility rows, the i-th at `wallOf(i)`. */
function pageRecord(n, wallOf, extra = {}) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ seq: i + 1, wall: wallOf(i), type: "visibility", to: i % 2 ? "visible" : "hidden", forMs: 5 });
  }
  return {
    v: 1, cap: 200, seq: n, dropped: 0, entries,
    build: { web: "2b808ec9d50c5b98", native: "2026092401", version: "1.4.0", shell: true },
    ...extra,
  };
}

/** One engine row as the ring serves it (DiagRow.swift: seq, at, mono, kind, fields). */
const erow = (seq, at, kind, fields = {}) => ({ seq, at, mono: seq * 10, kind, ...fields });

/** The row lines of a report (after the header), as {seq, type, engine}. */
function rowLines(text) {
  /* Engine rows are headed `e#` since 2026-09-26 (L22), page rows `#`; the
     `e` is asserted to agree with `src=engine` so neither can drift alone. */
  return text.split("\n")
    .filter((l) => /^e?#\d/.test(l))
    .map((l) => {
      const m = /^(e?)#(\d+)\s+\S+\s+(\S+)(\s+src=engine)?/.exec(l);
      assert.equal(m[1] === "e", !!m[4], `a row's e# prefix and its src=engine disagree: ${l}`);
      return { seq: Number(m[2]), type: m[3], engine: !!m[4], line: l };
    });
}

const NATIVE_DECISION = {
  mode: "native", reason: "native", relinquish: false,
  hello: {
    mode: "native", reason: "build-default", engineVersion: "1.0.0", protocol: 1,
    capabilities: ["episode", "continuation"], ownedKeyPrefixes: [],
  },
};

/* ==================================================================== */
/* 1. the merge                                                           */
/* ==================================================================== */

test("a fake 2,000-row ring merges with the page's rows in wall-clock order, every row shown", () => {
  /* THE CARD'S ACCEPTANCE. 2,000 engine rows one every 1 s, 200 page rows one
     every 10 s offset by half a second, so they interleave all the way down.
     MUTATION 1: concatenate the engine rows after the page's instead of
     merging. The order assertion fails.
     MUTATION 2: cap what is merged (e.g. `.slice(-200)`). The count fails. */
  const ring = [];
  for (let i = 0; i < ENGINE_RING_CAP; i++) ring.push(erow(i + 1, T0 + i * 1000, "seam", { observedGapMs: 500 + (i % 7), askedGapMs: 500, prepared: true, grace: false, bgRemainingMs: null, stages: ["load", "ready", "playing"] }));
  const record = pageRecord(200, (i) => T0 + i * 10_000 + 500);
  const text = formatDiagnosticReport(record, { decision: NATIVE_DECISION, snapshot: null, rows: ring });
  const lines = rowLines(text);
  assert.equal(lines.filter((l) => l.engine).length, 2000, "every engine row is a line");
  assert.equal(lines.filter((l) => !l.engine).length, 200, "every page row is still a line");
  // Independently computed order: by wall, the page first at a tie.
  const expected = [
    ...record.entries.map((e) => ({ wall: e.wall, engine: false, seq: e.seq })),
    ...ring.map((r) => ({ wall: r.at, engine: true, seq: r.seq })),
  ].sort((a, b) => a.wall - b.wall || (a.engine - b.engine));
  assert.deepEqual(lines.map((l) => [l.engine, l.seq]), expected.map((e) => [e.engine, e.seq]));
  assert.match(text, /^engine rows 2000 of 2000, #1\.\.#2000$/m);
  assert.match(text, /^engine seams 2000: 2000 audible, 2000 prepared, gap median 503ms, worst 506ms$/m);
});

test("a wall clock that stepped backwards inside the ring does not reorder it: a merge, not a sort", () => {
  /* The clock can step under a drive; the ring's seq is the truth.
     MUTATION: sort the merged list by wall. Engine #3 lands before #2 and this
     fails. */
  const ring = [erow(1, T0 + 1000, "mode", { reason: "native" }), erow(2, T0 + 5000, "pause", { event: "forced" }), erow(3, T0 + 2000, "stop", { cause: "remote" })];
  const merged = mergeEngineRows([], normalizeEngineRows(ring).rows);
  assert.deepEqual(merged.map((m) => m.row.seq), [1, 2, 3]);
  const page = [{ seq: 1, wall: T0 + 3000, type: "boot" }];
  const withPage = mergeEngineRows(page, normalizeEngineRows(ring).rows);
  assert.deepEqual(withPage.map((m) => (m.src === "engine" ? `e${m.row.seq}` : `p${m.seq}`)), ["e1", "p1", "e2", "e3"]);
});

test("the ring's seq accounts for what it no longer holds: evicted, and missing in the middle", () => {
  /* NE-26r reads an early seam evicted as an incomplete drive, so the paste
     must say rows are gone.
     MUTATION: drop the `older evicted` / `MISSING` clauses. This fails. */
  const ring = [];
  for (let s = 767; s <= 2766; s++) if (s !== 1000 && s !== 1001) ring.push(erow(s, T0 + s, "deck", { event: "not-ready" }));
  const text = formatDiagnosticReport(pageRecord(0, () => 0), { decision: NATIVE_DECISION, rows: ring });
  assert.match(text, /^engine rows 1998 of 2000, #767\.\.#2766, 766 older evicted, 2 MISSING \(seq gaps\)$/m);
});

/* ==================================================================== */
/* 2. the header line                                                     */
/* ==================================================================== */

test("native mode: the header line names engine, version, protocol, caps, reason, strikes, hold, build and web", () => {
  /* MUTATION 1: read the build from the page's stamp before the engine's own
     build row. `build=` then shows 2026092401, not 2026092499, and this fails.
     MUTATION 2: print the page's verdict ("native") as the reason instead of
     the engine's own (build-default / override), which is the one that says
     why. */
  const rows = [
    erow(1, T0, "build", { engineVersion: "0.9.0", protocol: 1, bundleVersion: "2026092499", launch: "foreground", pitch: "timeDomain", hold: "forever" }),
    erow(2, T0 + 1, "mode", { reason: "native", strikes: 1 }),
  ];
  const text = formatDiagnosticReport(pageRecord(1, () => T0 + 5), {
    decision: NATIVE_DECISION, snapshot: { holdPolicy: "until:60" }, rows,
  });
  assert.equal(text.split("\n")[2],
    "engine=native v1.0.0 proto=1 caps=episode,continuation reason=build-default strikes=1 hold=until:60 build=2026092499 | web=2b808ec9d50c5b98");
});

test("native mode with only the ring to go on: version and protocol from the build row, hold from the newest policy row", () => {
  /* The hello is the fresher source, but a paste from a page whose hello
     carried no version must still say one.
     MUTATION: prefer the build row's `hold` over a later hold-policy row. */
  const rows = [
    erow(1, T0, "build", { engineVersion: "0.9.0", protocol: 1, bundleVersion: "77", launch: "background", pitch: "timeDomain", hold: "forever" }),
    erow(2, T0 + 1, "session", { event: "hold-policy", policy: "none" }),
  ];
  const line = engineHeaderLine({ decision: { mode: "native", reason: "native", hello: {} }, rows }, null);
  assert.equal(line, "engine=native v0.9.0 proto=1 caps=? reason=native strikes=? hold=none build=77 | web=?");
  // And a build row AFTER the policy change (a relaunch) is the policy in force.
  const relaunched = [...rows, erow(3, T0 + 2, "build", { engineVersion: "0.9.0", protocol: 1, bundleVersion: "77", launch: "foreground", pitch: "timeDomain", hold: "forever" })];
  assert.match(engineHeaderLine({ decision: { mode: "native", reason: "native", hello: {} }, rows: relaunched }), / hold=forever /);
});

test("JS mode: the header reads engine=js with the reason, and keeps strikes when the engine's rows carry them", () => {
  /* A crash-loop downgrade is a JS page with strikes behind it.
     MUTATION 1: print the native fields in JS mode (`v? proto=?`). The first
     assertion fails. MUTATION 2: drop strikes in JS mode. The second fails. */
  const record = pageRecord(1, () => T0);
  assert.equal(formatDiagnosticReport(record, { decision: { mode: "js", reason: "not-ios" } }).split("\n")[2],
    "engine=js reason=not-ios build=2026092401 | web=2b808ec9d50c5b98");
  const rows = [erow(1, T0, "mode", { mode: "legacy", reason: "crash-loop", strikes: 3 })];
  assert.equal(formatDiagnosticReport(record, { decision: { mode: "js", reason: "engine-legacy" }, rows }).split("\n")[2],
    "engine=js reason=engine-legacy strikes=3 build=2026092401 | web=2b808ec9d50c5b98");
});

test("no page verdict yet: the engine's own legacy decision supplies the reason, a native one does not", () => {
  /* NE-17's decideOnce row is `mode` with mode, reason, strikes and build.
     MUTATION 1: ignore the row (always `undecided`). The first assertion fails.
     MUTATION 2: take the row's reason whatever its mode. The second fails.
     MUTATION 3: drop the row's build fallback. The third fails. */
  const record = pageRecord(1, () => T0);
  const legacy = [erow(1, T0, "mode", { mode: "legacy", reason: "crash-loop", strikes: 3, build: "2026092401" }),
    erow(2, T0 + 1, "mode", { event: "healthy", marker: "page-alive", strikes: 3 })];
  assert.equal(formatDiagnosticReport(record, { decision: { mode: "js", reason: "undecided" }, rows: legacy }).split("\n")[2],
    "engine=js reason=crash-loop strikes=3 build=2026092401 | web=2b808ec9d50c5b98");
  const native = [erow(1, T0, "mode", { mode: "native", reason: "build-default", strikes: 0, build: "2026092401" })];
  assert.equal(formatDiagnosticReport(record, { decision: { mode: "js", reason: "undecided" }, rows: native }).split("\n")[2],
    "engine=js reason=undecided strikes=0 build=2026092401 | web=2b808ec9d50c5b98");
  assert.equal(engineHeaderLine({ decision: { mode: "js", reason: "undecided" }, rows: legacy }, { web: "w" }),
    "engine=js reason=crash-loop strikes=3 build=2026092401 | web=w");
});

test("a report built with no engine view at all still carries the line, as undecided", () => {
  /* Every caller of formatDiagnosticReport(record) — the older one-argument
     shape — gets the line, because which engine played is the first question.
     MUTATION: print the line only when an engine view is passed. */
  const lines = formatDiagnosticReport(pageRecord(0, () => 0)).split("\n");
  assert.equal(lines[1], "build web 2b808ec9d50c5b98 · native 2026092401 (1.4.0)", "the build line stays second");
  assert.equal(lines[2], "engine=js reason=undecided build=2026092401 | web=2b808ec9d50c5b98");
});

/* ==================================================================== */
/* 3. the lines, and nothing dropped silently                            */
/* ==================================================================== */

test("each engine kind the card names has its line: session, remote, mode, seam, grace, probe, lifecycle, build", () => {
  /* MUTATION (any one): delete a formatter from ENGINE_LINES. That kind falls
     back to the generic shape and its assertion below fails — e.g. a seam with
     no gap reads `observedGapMs=—` instead of NEVER AUDIBLE. */
  const at = T0 + 1234;
  assert.equal(engineLineFor(erow(5, at, "session", { event: "activated", ok: true, token: null, activateMs: 12.34, phase: "active", hint: false })),
    "e#5    12:00:01.234 session    src=engine activated activateMs=12ms ok=y token=— hint=n phase=active");
  assert.equal(engineLineFor(erow(6, at, "session", { event: "activate", ok: false, activateMs: 3, reason: "session-failed:cannot-interrupt-others" })),
    "e#6    12:00:01.234 session    src=engine activate activateMs=3ms ok=n reason=session-failed:cannot-interrupt-others");
  assert.equal(engineLineFor(erow(7, at, "remote", { cmd: "togglePlayPause", dupCandidate: "y", route: "carAudio", grace: "none", thread: "main", state: "playing", status: "success" })),
    "e#7    12:00:01.234 remote     src=engine togglePlayPause status=success route=carAudio thread=main dupCandidate=y grace=none state=playing");
  assert.equal(engineLineFor(erow(8, at, "mode", { reason: "downgrade", cap: "foray" })),
    "e#8    12:00:01.234 mode       src=engine reason=downgrade cap=foray");
  assert.equal(engineLineFor(erow(9, at, "seam", { observedGapMs: 512.4, askedGapMs: 500, prepared: true, grace: true, bgRemainingMs: 28000, stages: ["prepare", "ready", "playing"] })),
    "e#9    12:00:01.234 seam       src=engine gap 512ms asked 500ms prepared=y grace=y bgRemainingMs=28000ms stages=prepare>ready>playing");
  assert.equal(engineLineFor(erow(10, at, "seam", { observedGapMs: null, askedGapMs: 500, prepared: false, grace: false, bgRemainingMs: null, stages: ["prepare"] })),
    "e#10   12:00:01.234 seam       src=engine NEVER AUDIBLE asked 500ms prepared=n grace=n bgRemainingMs=— stages=prepare");
  assert.equal(engineLineFor(erow(11, at, "grace", { event: "begin", reason: "seam", task: "ok", bgRemainingMs: null })),
    "e#11   12:00:01.234 grace      src=engine begin reason=seam task=ok bgRemainingMs=—");
  assert.equal(engineLineFor(erow(12, at, "probe", { event: "speech-then-play", ok: true, activateMs: 40 })),
    "e#12   12:00:01.234 probe      src=engine speech-then-play ok=y activateMs=40ms");
  assert.equal(engineLineFor(erow(13, at, "lifecycle", { event: "didEnterBackground", state: "playing" })),
    "e#13   12:00:01.234 lifecycle  src=engine didEnterBackground state=playing");
  assert.equal(engineLineFor(erow(14, at, "build", { engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026092401", launch: "background", pitch: "timeDomain", hold: "forever" })),
    "e#14   12:00:01.234 build      src=engine v1.0.0 protocol=1 bundleVersion=2026092401 launch=background pitch=timeDomain hold=forever");
});

test("a field no formatter names is still printed, and what the gate withheld is said", () => {
  /* The formatter orders what a reader looks for first; it never decides what
     a reader may not see.
     MUTATION 1: print only the named fields. `newField=7` disappears.
     MUTATION 2: skip `dropped`. `withheld=` disappears. */
  const line = engineLineFor(erow(3, T0, "remote", { cmd: "play", route: "bluetoothA2DP", newField: 7, dropped: ["routeName"] }));
  assert.match(line, / newField=7/);
  assert.match(line, / withheld=routeName$/);
  // A kind with no line of its own (the rest of ENGINE_ROW_KINDS) prints its sub-kind and fields.
  assert.equal(engineLineFor(erow(4, T0, "stop", { cause: "interruption", source: "session", item: "ep-1", positionSec: 61.5, state: "playing" })),
    "e#4    12:00:00.000 stop       src=engine cause=interruption source=session item=ep-1 positionSec=61.5 state=playing");
});

test("unknown row kinds and unreadable rows show as counts, never dropped silently", () => {
  /* THE CARD'S ACCEPTANCE. MUTATION 1: filter unknown kinds without the
     header line. MUTATION 2: skip malformed rows without counting them. */
  const rows = [
    erow(1, T0, "warp", { event: "x" }), erow(2, T0 + 1, "warp", {}), erow(3, T0 + 2, "tachyon", {}),
    erow(4, T0 + 3, "stop", { cause: "remote" }),
    { seq: 5, kind: "stop" }, // no clock
    { seq: "6", at: T0, kind: "stop" }, // seq not a number
    "not a row",
  ];
  const text = formatDiagnosticReport(pageRecord(0, () => 0), { decision: NATIVE_DECISION, rows });
  assert.match(text, /^engine rows of unknown kinds, not shown: warp x2, tachyon x1$/m);
  assert.match(text, /^engine rows unreadable 3$/m);
  const lines = rowLines(text);
  assert.deepEqual(lines.map((l) => l.type), ["stop"], "only the known, well-formed row is a line");
  assert.doesNotMatch(text, /Nothing recorded yet/, "a paste with engine rows is not an empty record");
});

test("engine rows from before the page's Clear are counted, not shown — and the header still reads them", () => {
  /* The founder's loop is clear, drive, copy; the engine's ring outlives the
     page's Clear, so without this the drive under test is buried under
     earlier drives. The build row before the Clear still answers the header.
     MUTATION: ignore the clear mark. Engine #1 and #2 become lines and this
     fails. */
  const rows = [
    erow(1, T0, "build", { engineVersion: "1.0.0", protocol: 1, bundleVersion: "88", launch: "foreground", pitch: "timeDomain", hold: "forever" }),
    erow(2, T0 + 10, "stop", { cause: "remote" }),
    erow(3, T0 + 5000, "stop", { cause: "interruption" }),
  ];
  const record = { ...pageRecord(0, () => 0), seq: 12, cleared: { seq: 12, wall: T0 + 1000 } };
  const text = formatDiagnosticReport(record, { decision: NATIVE_DECISION, rows });
  assert.match(text, /^engine rows before the Clear 2, not shown$/m);
  assert.deepEqual(rowLines(text).map((l) => l.seq), [3]);
  assert.match(text.split("\n")[2], / build=88 /);
});

test("a ring that was asked for and not read says so, with why", () => {
  /* MUTATION: treat `rows: null` like "not asked" and print nothing. */
  const text = formatDiagnosticReport(pageRecord(1, () => T0), { decision: NATIVE_DECISION, rows: null, readError: "timeout" });
  assert.match(text, /^engine rows not read \(timeout\)$/m);
  const notAsked = formatDiagnosticReport(pageRecord(1, () => T0), { decision: { mode: "js", reason: "not-ios" } });
  assert.doesNotMatch(notAsked, /^engine rows/m, "the web has no engine to account for");
});

/** The Swift files whose private `row("…"` names a ROW KIND. The other files
    with a `row(_:)` helper (AudioSessionOwner.swift, SessionProbe.swift) pass
    a SUB-kind, filed under `session`/`probe` — see the test below. */
const ROW_KIND_EMITTERS = new Set(["EngineBridge.swift", "EngineOwnership.swift"]);

test("every row kind the Swift engine writes has a line here", () => {
  /* Pins the page's table to the engine's emitters, so a new kind cannot reach
     a paste only as a count. Scans the shipping Swift (not the tests) for the
     four ways a row kind is named: `diag("kind"`, `DiagEntry(kind: "kind"`, a
     row type's `static let kind = "kind"`, and a file-private `row("kind"`.
     THE FOURTH IS SCOPED BY FILE, and that is not a shortcut (log-gaps
     2026-09-26, L01). EngineBridge.swift's and EngineOwnership.swift's
     `row(_ kind:)` write a ROW KIND (`cmd`, `hello`, `mode`) — the scan missed
     them, which is how 15 `cmd` rows reached the 2026-09-26 paste only as
     `cmd x15`. AudioSessionOwner.swift's and SessionProbe.swift's `row(_:)`
     take a SUB-KIND (`activated`, `armed`, …) that they file under `session`
     and `probe`, so scanning them would demand kinds the engine never writes.
     MUTATION 1: remove "deck" from ENGINE_ROW_KINDS. This fails.
     MUTATION 2: remove "cmd" from ENGINE_ROW_KINDS. This fails. */
  const roots = [
    "mobile/plugins/foray-audio/foray-engine-core/Sources",
    "mobile/plugins/foray-audio/ios/Sources",
  ];
  const kinds = new Set();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".swift")) {
        const src = fs.readFileSync(p, "utf8");
        const res = [/\bdiag\("([^"]+)"/g, /DiagEntry\(kind:\s*"([^"]+)"/g, /static let kind = "([^"]+)"/g];
        if (ROW_KIND_EMITTERS.has(ent.name)) res.push(/\brow\("([^"]+)"/g);
        for (const re of res) {
          for (const m of src.matchAll(re)) kinds.add(m[1]);
        }
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  // Not vacuous: the engine writes at least these today (NE-14s, NE-16, NE-19, L01).
  for (const k of ["build", "seam", "session", "remote", "mode", "grace", "stop", "deck", "cmd", "hello"]) {
    assert.ok(kinds.has(k), `the scan no longer finds the engine's "${k}" rows — has the emitter moved?`);
  }
  const missing = [...kinds].filter((k) => !ENGINE_ROW_KINDS.includes(k));
  assert.deepEqual(missing, [], `the engine writes kinds Copy would only count: add them to ENGINE_ROW_KINDS (diagnostic-log.js), with a line if they need one`);
});

/* ==================================================================== */
/* 3b. log-gaps 2026-09-26: commands, boots, builds, and Lane B's fields  */
/* ==================================================================== */

test("GAPS L01: a cmd row names the command, its source and its place in the page's count; a refusal and a bad hello say so", () => {
  /* The 2026-09-26 paste printed `engine rows of unknown kinds, not shown:
     cmd x15`. MUTATION: remove "cmd" from ENGINE_ROW_KINDS — the rows go back
     to being a count, and the scan test above fails too. */
  assert.equal(engineLineFor(erow(12, T0 + 3100, "cmd", { cmd: "playEpisode", source: "tap", cmdSeq: 7 })),
    "e#12   12:00:03.100 cmd        src=engine playEpisode source=tap cmdSeq=7");
  assert.equal(engineLineFor(erow(13, T0 + 3101, "cmd", { cmd: "playEpisode", cmdSeq: 7, result: "capability-off" })),
    "e#13   12:00:03.101 cmd        src=engine playEpisode cmdSeq=7 result=capability-off");
  assert.equal(engineLineFor(erow(14, T0 + 3200, "cmd", { cmd: "pause", source: "remote", cmdSeq: 9, seqGap: "y" })),
    "e#14   12:00:03.200 cmd        src=engine pause source=remote cmdSeq=9 seqGap=y");
  assert.equal(engineLineFor(erow(15, T0 + 3300, "cmd", { invalid: "y", cmd: null })),
    "e#15   12:00:03.300 cmd        src=engine ? INVALID");
  assert.equal(engineLineFor(erow(16, T0 + 3400, "hello", { invalid: "y" })),
    "e#16   12:00:03.400 hello      src=engine invalid=y");
  const text = formatDiagnosticReport(pageRecord(0, () => 0), {
    decision: NATIVE_DECISION, rows: [erow(1, T0, "cmd", { cmd: "pause", source: "tap", cmdSeq: 1 }), erow(2, T0 + 1, "hello", { invalid: "y" })],
  }, { tzOffsetMin: 0 });
  assert.doesNotMatch(text, /unknown kinds/);
  assert.deepEqual(rowLines(text).map((l) => l.type), ["cmd", "hello"]);
});

test("GAPS L01: the header counts the page's commands by name, the engine's refusals and the count's gaps", () => {
  /* The paste's own mix: 8 setPageVisible, 4 pause, 3 playEpisode, and one
     refusal row (Lane B writes a second cmd row with result= only then).
     MUTATION 1: count the refusal row as a command — the header says 16.
     MUTATION 2: sort by name — pause comes before setPageVisible. */
  const rows = [];
  let seq = 0;
  const add = (cmd, extra = {}) => rows.push(erow(++seq, T0 + seq, "cmd", { cmd, source: "tap", cmdSeq: seq, ...extra }));
  for (let i = 0; i < 3; i++) add("playEpisode");
  for (let i = 0; i < 8; i++) add("setPageVisible");
  for (let i = 0; i < 4; i++) add("pause");
  rows.push(erow(++seq, T0 + seq, "cmd", { cmd: "playEpisode", cmdSeq: 3, result: "capability-off" }));
  const text = formatDiagnosticReport(pageRecord(0, () => 0), { decision: NATIVE_DECISION, rows }, { tzOffsetMin: 0 });
  assert.match(text, /^engine commands 15: setPageVisible x8,\n {2}pause x4, playEpisode x3 · 1 refused · 0 seq gaps$/m);
  for (const l of text.split("\n")) if (/^(engine commands| {2}pause)/.test(l)) assert.ok(l.length <= 52, l);
  /* A skipped cmdSeq is counted. */
  const gapped = formatDiagnosticReport(pageRecord(0, () => 0), {
    decision: NATIVE_DECISION, rows: [erow(1, T0, "cmd", { cmd: "pause", cmdSeq: 1 }), erow(2, T0 + 1, "cmd", { cmd: "pause", cmdSeq: 5, seqGap: "y" })],
  }, { tzOffsetMin: 0 });
  assert.match(gapped, /^engine commands 2: pause x2 · 0 refused · 1 seq gap$/m);
});

test("GAPS L22: each engine boot gets a divider naming its build — an older one says so — and the header lists the boots", () => {
  /* The paste interleaved build 2026092532's rows with 2026092602's and
     nothing said which was which.
     MUTATION 1: drop the divider — `== engine boot` is gone.
     MUTATION 2: mark every boot older — the running build's divider says
     (older build). */
  const rows = [
    erow(1, T0, "build", { engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026092532", launch: "foreground" }),
    erow(2, T0 + 10, "mode", { mode: "native", reason: "build-default", strikes: 0 }),
    erow(35, T0 + 20, "stop", { cause: "remote" }),
    erow(36, T0 + 30, "build", { engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026092401", launch: "background" }),
    erow(80, T0 + 40, "stop", { cause: "remote" }),
  ];
  const text = formatDiagnosticReport(pageRecord(0, () => 0), { decision: NATIVE_DECISION, rows }, { tzOffsetMin: 0 });
  assert.match(text, /^engine boots in ring 2: 2026092532 e#1\.\.e#35,\n {2}2026092401 e#36\.\.e#80$/m);
  const body = text.split("\n").slice(text.split("\n").indexOf("-- 2026-09-24 (UTC) --"));
  assert.deepEqual(body.filter((l) => l.startsWith("==")), [
    "== engine boot 2026092532 v1.0.0 launch=foreground (older build) ==",
    "== engine boot 2026092401 v1.0.0 launch=background ==",
  ]);
  /* Each divider sits directly above its build row. */
  assert.match(body[body.indexOf("== engine boot 2026092401 v1.0.0 launch=background ==") + 1], /^e#36 {3}\S+ build /);
});

test("GAPS L09/L14/L28: Lane B's new engine fields print with no formatter change, and the header names the phone from the build row", () => {
  /* `engineFields` prints every field a row carries; this pins that it still
     does for the fields Lane B adds, and that the device line prefers the
     engine's own hardware model.
     MUTATION: give `build` a skip list that drops unknown fields. */
  const build = erow(1, T0, "build", {
    engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026092401", launch: "foreground",
    hw: "iPhone15.2", os: "18.6.2", lowPower: false, thermal: "fair", availMb: 1800,
  });
  assert.equal(engineLineFor(build),
    "e#1    12:00:00.000 build      src=engine v1.0.0 protocol=1 bundleVersion=2026092401 launch=foreground hw=iPhone15.2 os=18.6.2 lowPower=n thermal=fair availMb=1800");
  const route = erow(2, T0 + 5, "session", { event: "notification", port: "carAudio", prevPort: "speaker", reason: "newDeviceAvailable" });
  assert.equal(engineLineFor(route),
    "e#2    12:00:00.005 session    src=engine notification reason=newDeviceAvailable port=carAudio prevPort=speaker");
  const text = formatDiagnosticReport(pageRecord(0, () => 0), { decision: NATIVE_DECISION, rows: [build, route] }, { tzOffsetMin: 0 });
  assert.match(text, /^device iPhone15\.2 · iOS 18\.6\.2 · lowPower=n\n {2}thermal=fair$/m);
});

test("GAPS L30: a page row the page handled late sorts by when it HAPPENED, and page order never changes", () => {
  /* #1032's route change was handled 38 s after it happened; every engine row
     of those 38 s printed above its cause.
     MUTATION: compare on `wall` alone — the engine row lands first again. */
  const page = [
    { seq: 1, wall: T0, type: "visibility", to: "hidden", forMs: 1 },
    { seq: 2, wall: T0 + 38_041, type: "session", kind: "routeChange", reason: "new-device", producer: "audio", at: T0 + 1000, lagMs: 37_041, hidden: true },
    { seq: 3, wall: T0 + 38_050, type: "visibility", to: "visible", forMs: 38_050 },
  ];
  const engine = [erow(7, T0 + 20_000, "stop", { cause: "route" })];
  const merged = mergeEngineRows(page, engine);
  assert.deepEqual(merged.map((m) => (m.src === "engine" ? `e${m.row.seq}` : `p${m.seq}`)), ["p1", "p2", "e7", "p3"]);
  /* A prompt delivery (lag ≤ 1 s) still sorts by the page's own clock. */
  const prompt = [{ ...page[1], at: T0 + 37_500, lagMs: 541 }];
  assert.deepEqual(mergeEngineRows(prompt, engine).map((m) => (m.src === "engine" ? "e" : "p")), ["e", "p"]);
  /* And the late row says when it happened, beside when it was handled. */
  const text = formatDiagnosticReport({ ...pageRecord(0, () => 0), entries: page, seq: 3 }, { decision: NATIVE_DECISION, rows: engine }, { tzOffsetMin: 0 });
  assert.match(text, /^#2 {4}12:00:38\.041 session {4}audio routeChange @12:00:01\.000 \(new-device\) {2}lag 37041ms {2}hidden=y$/m);
});

/* ==================================================================== */
/* 4. the one bounded read                                               */
/* ==================================================================== */

/** A `window.Capacitor` whose engineRead answers `readReply` (or hangs). */
function fakeCapacitor({ platform = "ios", readReply = { rows: [] }, plugin = true } = {}) {
  const calls = [];
  return {
    calls,
    getPlatform: () => platform,
    isPluginAvailable: (n) => plugin && n === ENGINE_PLUGIN,
    nativePromise(p, method, payload) {
      calls.push({ method, payload: JSON.parse(JSON.stringify(payload ?? null)) });
      if (method !== "engineRead") return Promise.reject(new Error("unexpected " + method));
      if (readReply === "hang") return new Promise(() => {});
      if (readReply instanceof Error) return Promise.reject(readReply);
      return Promise.resolve(JSON.parse(JSON.stringify(readReply)));
    },
  };
}

test("Copy's report reads the engine ONCE, through the real client, and merges what it served", async () => {
  /* MUTATION 1: read the ring twice (e.g. once for the header, once for the
     rows). The call count fails. MUTATION 2: drop `rows` from the view. The
     engine line is missing and this fails. */
  const cap = fakeCapacitor({ readReply: { rows: [erow(1, T0 + 10, "stop", { cause: "remote" })] } });
  const engine = createNativeEngine({ capacitor: cap });
  const text = await engineDiagnosticReport({ record: () => pageRecord(1, () => T0), engine, capacitor: cap });
  assert.deepEqual(cap.calls, [{ method: "engineRead", payload: { what: "diagnostics" } }]);
  assert.match(text, /src=engine cause=remote/);
  assert.match(text.split("\n")[2], /^engine=js reason=undecided /, "no decision yet: undecided, not a guess");
});

test("the page's record is read AFTER the engine answers, so it is at least as fresh", async () => {
  /* MUTATION: read the record before awaiting the engine. The late page row
     is missing. */
  let release;
  const engine = { read: () => new Promise((r) => { release = r; }), latest: () => null };
  const record = pageRecord(1, () => T0);
  const pending = engineDiagnosticReport({ record: () => record, engine, capacitor: null });
  record.entries.push({ seq: 2, wall: T0 + 50, type: "visibility", to: "visible", forMs: 1 });
  record.seq = 2;
  release({ rows: [] });
  const text = await pending;
  assert.equal(rowLines(text).length, 2);
});

test("a read that never answers is bounded: the page's record comes back, saying the engine timed out", async () => {
  /* MUTATION: await the read with no bound. The report never resolves and
     this times out. */
  const sched = manualScheduler();
  const cap = fakeCapacitor({ readReply: "hang" });
  const engine = createNativeEngine({ capacitor: cap });
  let text = null;
  engineDiagnosticReport({ record: () => pageRecord(1, () => T0), engine, capacitor: cap, scheduler: sched }).then((t) => { text = t; });
  await sched.advance(ENGINE_READ_TIMEOUT_MS - 1);
  assert.equal(text, null, "not before the bound");
  await sched.advance(1);
  assert.match(text, /^engine rows not read \(timeout\)$/m);
  assert.equal(rowLines(text).length, 1, "the page's own rows are all there");
});

test("a read that fails or answers nonsense is `failed`, and no engine is `no-engine`", async () => {
  /* MUTATION: resolve a rejected read as an empty ring. `failed` disappears,
     and a broken bridge reads as a quiet engine. */
  const rejected = createNativeEngine({ capacitor: fakeCapacitor({ readReply: new Error("bridge gone") }) });
  assert.deepEqual(await readEngineDiagnostics({ engine: rejected }), { rows: null, readError: "failed" });
  const nonsense = createNativeEngine({ capacitor: fakeCapacitor({ readReply: { rows: "all of them" } }) });
  assert.deepEqual(await readEngineDiagnostics({ engine: nonsense }), { rows: null, readError: "failed" });
  const throwing = { read() { throw new Error("sync throw"); } };
  assert.deepEqual(await readEngineDiagnostics({ engine: throwing }), { rows: null, readError: "failed" });
  assert.deepEqual(await readEngineDiagnostics({ engine: null }), { rows: null, readError: "no-engine" });
});

test("the decision: the client's own when it has one; not-ios and no-method need no hello; else undecided", () => {
  /* MUTATION: answer `no-hello` for an iOS page that has not asked yet — that
     reason means a hello timed out, which did not happen. */
  const ios = fakeCapacitor();
  assert.deepEqual(pageEngineDecision({ engine: { decision: NATIVE_DECISION }, capacitor: ios }), NATIVE_DECISION);
  assert.deepEqual(pageEngineDecision({ capacitor: null }), { mode: "js", reason: "not-ios", hello: null });
  assert.deepEqual(pageEngineDecision({ capacitor: fakeCapacitor({ platform: "android" }) }), { mode: "js", reason: "not-ios", hello: null });
  assert.deepEqual(pageEngineDecision({ capacitor: fakeCapacitor({ plugin: false }) }), { mode: "js", reason: "no-method", hello: null });
  assert.deepEqual(pageEngineDecision({ capacitor: ios }), { mode: "js", reason: "undecided", hello: null });
  assert.equal(engineBridgePresent(ios), true);
  assert.equal(engineBridgePresent(fakeCapacitor({ platform: "web" })), false);
  // The synchronous view carries the client's latest snapshot for `hold=`.
  const view = pageEngineView({ engine: { decision: NATIVE_DECISION, latest: () => ({ snapshot: { holdPolicy: "none" } }) } });
  assert.equal(view.snapshot.holdPolicy, "none");
});

test("no engine to ask (the web, Android): no bridge call, and the header says why", async () => {
  /* MUTATION: read whenever a Capacitor exists. The Android call count fails. */
  const android = fakeCapacitor({ platform: "android" });
  const text = await engineDiagnosticReport({ record: () => pageRecord(1, () => T0), engine: null, capacitor: android });
  assert.equal(android.calls.length, 0);
  assert.match(text.split("\n")[2], /^engine=js reason=not-ios /);
  assert.doesNotMatch(text, /^engine rows/m);
});
