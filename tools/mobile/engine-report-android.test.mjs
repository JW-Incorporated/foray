/* tools/mobile/engine-report.mjs reads an ANDROID paste (card A-60,
 * docs/plans/android-assessment.md §5.7; docs/android-emulator-measurements.md §16).
 *
 * Three shapes of the Android engine's text ring (EngineLog.java: `<seq> <ISO> <kind> <json>`):
 * the emulator scenarios' `*-engine-rows.txt`, the service's dump (`ForayEngine.row ` before each
 * line), and logcat (`… I ForayEngine: `). And the page's Copy on Android, whose engine rows the
 * ring's gate (DiagGate.java) now stores with their sub-kind as `event`, so Copy prints
 * `deck src=engine attach …` exactly as it does for iOS. The provisional values the M3 verdicts
 * judge are pinned to the Java constants, as NE-38e pins them to the Swift ones. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as report from "./engine-report.mjs";
import { engineLineFor } from "../../player/diagnostic-log.js";

const { parsePaste, analyze, ringCompleteness, ANDROID_TEXT_RING_CAPACITY } = report;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/** A text-ring line, as EngineLog.line writes it. */
const ringLine = (seq, iso, kind, body) => `${seq} ${iso} ${kind} ${typeof body === "string" ? body : JSON.stringify(body)}`;

/* A title-free slice in the shape of run 36779471865's f-foray-engine-rows.txt (A-42's native leg),
   with A-60's class= on the deck rows and the writes that are not diag rows in between. */
const RING = [
  ringLine(250, "2026-09-30T21:37:44.348Z", "session", { kind: "activate", ok: true, activateMs: null, reason: null }),
  ringLine(251, "2026-09-30T21:37:44.349Z", "deck", { kind: "attach", token: 19, startSec: 0, precise: true, host: null, cold: "other-source", idleSec: 8.048, class: "clip" }),
  ringLine(252, "2026-09-30T21:37:44.358Z", "deck", { kind: "time-control", token: 19, status: "paused", reason: null, step: "prepare", positionSec: 0, bufferedAheadSec: 0, suppressed: 0, rate: 1 }),
  ringLine(253, "2026-09-30T21:37:44.477Z", "deck", { kind: "ready", token: 19, landedSec: 0, targetSec: 0, prerolled: true, reuse: false, elapsedMs: 118, attempts: 0, marks: { duration: 87, readiness: 117, ready: 117 }, bufferedAheadSec: 86.544, class: "clip" }),
  ringLine(254, "2026-09-30T21:37:44.535Z", "restore", "write"),
  ringLine(255, "2026-09-30T21:37:44.536Z", "event", { type: "advanced", seq: 3 }),
  ringLine(256, "2026-09-30T21:37:44.540Z", "position", "item=f1#0 sec=0"),
  ringLine(257, "2026-09-30T21:38:14.536Z", "deck", { kind: "attach", token: 20, startSec: 0, precise: false, host: null, cold: "other-source", idleSec: 0.02, class: "line" }),
  ringLine(258, "2026-09-30T21:38:22.536Z", "deck", { kind: "deadline", token: 20, afterMs: 8000, step: "prepare", class: "line", reuse: false, durationKnown: false, playerState: "buffering", loading: true, targetSec: 0, bufferedAheadSec: 0, marks: {} }),
  ringLine(259, "2026-09-30T21:38:22.537Z", "narration", { kind: "fallback", reason: "timeout", item: "f1#1" }),
];

test("an Android text ring reads as engine rows: the sub-kind is the event, the time is epoch, other writes are skipped", () => {
  const p = parsePaste(RING.join("\n"));
  assert.deepEqual(p.engineRows.map((r) => `${r.seq} ${r.kind} ${r.event}`), [
    "250 session activate", "251 deck attach", "252 deck time-control", "253 deck ready",
    "257 deck attach", "258 deck deadline", "259 narration fallback",
  ]);
  const ready = p.engineRows.find((r) => r.event === "ready");
  assert.equal(ready.f.class, "clip");
  assert.equal(ready.f.elapsedMs, 118);
  assert.equal(ready.f.reuse, false);
  assert.equal(ready.f.kind, undefined, "the sub-kind is not a field");
  assert.equal(ready.t, Date.parse("2026-09-30T21:37:44.477Z"));
  assert.equal(ready.epoch, true);
  assert.equal(p.engineRows.find((r) => r.event === "deadline").f.class, "line");
  assert.equal(p.unparsed, 0, "the non-diag writes are not counted as junk");
  /* MUTATION: read the `event` line (the pending-events log) as a row, or drop the kind→event read. */
});

test("the service's dump and logcat carry the same rows", () => {
  const dump = ["ForayEngine {\"engine\":\"android-native\",\"hosting\":true}", ...RING.map((l) => `    ForayEngine.row ${l}`)].join("\n");
  const logcat = RING.map((l) => `09-30 21:37:44.348 12985 12985 I ForayEngine: ${l}`).join("\n");
  const want = parsePaste(RING.join("\n")).engineRows.map((r) => `${r.seq} ${r.kind} ${r.event} ${JSON.stringify(r.f)}`);
  for (const text of [dump, logcat]) {
    assert.deepEqual(parsePaste(text).engineRows.map((r) => `${r.seq} ${r.kind} ${r.event} ${JSON.stringify(r.f)}`), want);
  }
  // Another tag under ForayEngine (the deck's plain log, the drive receiver) is not a ring line.
  assert.equal(parsePaste("09-30 21:51:08.241 12985 12985 I ForayEngine.drive: cmd=keys {\"ok\":true}").engineRows.length, 0);
  assert.equal(parsePaste("09-30 21:51:08.241 12985 12985 I ForayEngine.ExoDeck: 5 2026-09-30T21:37:44.348Z deck {}").engineRows.length, 0);
});

test("the text ring's accounting: seq gaps are other writes, the lines before the first are what the paste lacks", () => {
  const p = parsePaste(RING.join("\n"));
  assert.equal(p.ring.android, true);
  assert.equal(p.ring.capacity, ANDROID_TEXT_RING_CAPACITY);
  assert.equal(p.ring.missing, 0, "254..256 are a restore, an event and a position, not lost rows");
  assert.equal(p.ring.evicted, 249);
  assert.equal(ringCompleteness(p).complete, false, "a seam verdict on it reads incomplete, never a pass");
  assert.match(p.notes.join("\n"), /android text ring: 7 diag rows of lines #250\.\.#259, 249 earlier lines not in the paste/);
  const whole = parsePaste([ringLine(1, "2026-09-30T21:37:44.000Z", "mode", { mode: "native", reason: "build-default", strikes: 0 }), ...RING].join("\n"));
  assert.equal(whole.ring.evicted, 0);
  assert.equal(ringCompleteness(whole).complete, true);
});

test("the page's Copy on Android prints the gated row's sub-kind, and reads back as the same row", () => {
  // A DiagRow as EngineLog stores it since A-60 (DiagGate: `kind` -> `event`).
  const stored = { seq: 12, at: Date.parse("2026-09-30T21:38:22.536Z"), mono: 1000, kind: "deck", event: "deadline", token: 20, afterMs: 8000, step: "prepare", class: "line", reuse: false };
  const line = engineLineFor(stored);
  assert.match(line, /^e#12 +21:38:22\.536 deck +src=engine deadline token=20 afterMs=8000ms step=prepare class=line reuse=n$/);
  const [row] = parsePaste(line).engineRows;
  assert.equal(row.event, "deadline");
  assert.equal(row.f.class, "line");
  assert.equal(row.f.afterMs, 8000);
  // Before A-60 the Android ring dropped the sub-kind (a header shadow): nothing said which deck row it was.
  const before = parsePaste(engineLineFor({ ...stored, event: undefined })).engineRows[0];
  assert.notEqual(before.event, "deadline");
});

test("the CLI reads an Android paste from a file and prints the report; no Copy header is a failed header check, not a crash", () => {
  const a = analyze(RING.join("\n"));
  assert.equal(a.header.ok, false);
  assert.equal(a.parsed.engineRows.length, 7);
  const out = [];
  assert.equal(report.main(["-"], { readFile: () => RING.join("\n"), stdout: { write: (s) => out.push(s) }, stderr: { write() {} } }), 0);
  assert.match(out.join(""), /android text ring: 7 diag rows/);
  const run = spawnSync(process.execPath, [path.join(HERE, "engine-report.mjs"), "-"], { input: RING.join("\n"), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

/* The ids NE-38e's M3 verdicts go by (tools/mobile/engine-report.mjs on engine/m3, PR #899). Once
   that lands here the tool exports M3_TITLES and the ids below are checked against it too. */
const M3_IDS = ["P13-clip", "P13-line", "reuse-idle", "rate-latch"];

test("the Android values the M3 verdicts judge are iOS's, each tagged // MEASURE with its verdict (A-60)", () => {
  const src = (rel) => readFileSync(path.join(ROOT, "mobile", "plugins", "foray-audio", "android", ...rel.split("/")), "utf8");
  const deck = src("src/main/java/ai/jwlabs/foura/audio/engine/ExoDeck.java");
  const constant = (text, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*([\\d_.]+)\\s*;`).exec(text);
    assert.ok(m, `${name} not found`);
    return Number(m[1].replace(/_/g, ""));
  };
  assert.equal(constant(deck, "DEFAULT_LOAD_DEADLINE_SEC"), 20);
  assert.equal(constant(deck, "DEFAULT_LINE_LOAD_DEADLINE_SEC"), 8);
  assert.equal(constant(deck, "DEFAULT_REUSE_MAX_IDLE_SEC"), 600);
  assert.match(deck, /DEFAULT_LOAD_DEADLINE_SEC = 20; \/\/ MEASURE: verdict=P13-clip/);
  assert.match(deck, /DEFAULT_LINE_LOAD_DEADLINE_SEC = 8; \/\/ MEASURE: verdict=P13-line/);
  assert.match(deck, /DEFAULT_REUSE_MAX_IDLE_SEC = 600; \/\/ MEASURE: verdict=reuse-idle/);
  const core = src("foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/EngineCore.java");
  assert.match(core, /BUFFERING_WHILE_WAITING = true; \/\/ MEASURE: verdict=rate-latch/);
  const tagged = [deck, core].flatMap((t) => [...t.matchAll(/MEASURE: verdict=([\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(tagged)].sort(), [...M3_IDS].sort());
  // No bare `// MEASURE` (one that names no verdict) is left on these files: A-68 settles each by its verdict.
  for (const t of [deck, core]) assert.doesNotMatch(t, /\/\/ MEASURE(?!: verdict=)/);
  if (report.M3_TITLES) {
    for (const id of tagged) assert.ok(id in report.M3_TITLES, `// MEASURE: verdict=${id} has no NE-38e verdict`);
    assert.deepEqual(report.P13_CURRENT_SEC, { clip: 20, line: 8 });
    assert.equal(report.REUSE_MAX_IDLE_SEC, 600);
  }
});
