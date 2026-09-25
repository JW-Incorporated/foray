/* tools/mobile/engine-report.mjs (card NE-26r): synthetic pastes in, verdicts out.
 *
 * The pastes are built the way Copy builds them. `line()` below mirrors
 * player/diagnostic-log.js engineLineFor (NE-26: `#<seq> <clock> <kind> src=engine`,
 * y/n booleans, `…Ms` numbers as `123ms`, `—` for null, a seam's stages joined
 * by `>`, `withheld=` for DiagGate's dropped list); when the real formatter is
 * exported, the round-trip test runs through IT, so a drift in either
 * direction is red here. Every verdict has a pass, a fail and a no-data case,
 * and a ring that evicted rows turns a seam pass into `incomplete`. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePaste, analyze, verdicts, formatReport, percentile, seamDistribution, headerCheck,
  audibleAfter, interruptions, main, DV_TITLES, strictFailed,
} from "./engine-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

// ───────────── a paste, built like Copy builds one ─────────────

const BASE = Date.UTC(2026, 9, 1, 15, 0, 0); // 15:00:00.000
const clock = (at) => new Date(at).toISOString().slice(11, 23);
const HEADER_KEYS = new Set(["seq", "at", "mono", "kind", "event", "dropped"]);

function value(key, v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "y" : "n";
  if (typeof v === "number") return /Ms$/.test(key) ? `${Math.round(v)}ms` : String(v);
  if (Array.isArray(v)) return v.length ? v.join(key === "stages" ? ">" : ",") : "—";
  return String(v);
}
function fields(r, skip = []) {
  return Object.keys(r).filter((k) => !HEADER_KEYS.has(k) && !skip.includes(k)).map((k) => `${k}=${value(k, r[k])}`);
}
/** A mirror of engineLineFor for one DiagRow-shaped object. */
function line(r) {
  const head = `#${String(r.seq).padEnd(4)} ${clock(r.at)} ${String(r.kind).padEnd(10)} src=engine`;
  let body;
  switch (r.kind) {
    case "build": body = [`v${r.engineVersion}`, ...fields(r, ["engineVersion"])]; break;
    case "mode": body = fields(r); break;
    case "remote": body = [r.cmd, ...fields(r, ["cmd"])]; break;
    case "seam": body = [r.observedGapMs == null ? "NEVER AUDIBLE" : `gap ${Math.round(r.observedGapMs)}ms`,
      `asked ${Math.round(r.askedGapMs)}ms`, ...fields(r, ["observedGapMs", "askedGapMs"])]; break;
    case "nowplaying": body = [`"${r.title || "—"}" / "${r.artist || "—"}" / "${r.album || "—"}"`,
      ...fields(r, ["title", "artist", "album"])]; break;
    case "session": case "grace": case "probe": body = [r.event ?? "?", ...fields(r)]; break;
    default: body = [r.event ?? null, ...fields(r)].filter((p) => p != null);
  }
  const withheld = Array.isArray(r.dropped) && r.dropped.length ? [`withheld=${r.dropped.join(",")}`] : [];
  return [head, ...body, ...withheld].join(" ");
}

/** A Copy: the page header, the engine header line, the ring line, the rows. */
function paste(rows, { engine = "native", strikes = 0, reason = "build-default", build = "2026100101", ring = null, format = line } = {}) {
  let seq = 0;
  let at = BASE;
  const full = rows.map((r) => {
    seq = r.seq ?? seq + 1;
    at = r.at ?? at + (r.dt ?? 1000);
    const { dt, ...rest } = r;
    return { ...rest, seq, at };
  });
  const first = full.length ? full[0].seq : 0;
  const last = full.length ? full[full.length - 1].seq : 0;
  const ringLine = ring ?? (full.length ? `engine rows ${full.length} of 2000, #${first}..#${last}` + (first > 1 ? `, ${first - 1} older evicted` : "") : "engine rows 0 of 2000");
  const headerLine = engine === "native"
    ? `engine=native v1.0.0 proto=1 caps=episode,continuation,restore reason=${reason} strikes=${strikes} hold=forever build=${build} | web=67dbe3ce9009ef58`
    : `engine=js reason=${reason} strikes=${strikes} build=${build} | web=67dbe3ce9009ef58`;
  return [
    "4a playback diagnostics — v3",
    "build web 67dbe3ce9009ef58 · native 1.0 (2026100101)",
    headerLine,
    "Local only. Nothing here is sent anywhere.",
    "",
    "entries 0 of 200 (oldest dropped first)",
    ringLine,
    "updated 2026-10-01T15:30:00Z",
    "",
    ...full.map(format),
  ].join("\n");
}

const bootRow = (extra = {}) => ({ kind: "build", engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026100101", launch: "foreground", pitch: "timeDomain", hold: "forever", ...extra });
const remote = (cmd, extra = {}) => ({ kind: "remote", cmd, status: "success", dupCandidate: "n", route: "carAudio", grace: "remote-play", thread: "main", state: "interrupted", ...extra });
const activate = (ok = true, extra = {}) => ({ kind: "session", event: "activate", ok, activateMs: 12, reason: null, ...extra });
const graceEnd = (outcome = "playing", extra = {}) => ({ kind: "grace", event: "end", outcome, ...extra });
const began = (extra = {}) => ({ kind: "session", event: "interruption", phase: "began", reason: "default", running: true, ...extra });
const ended = (shouldResume, extra = {}) => ({ kind: "session", event: "notification", type: "ended", shouldResume, phase: "inactive", hint: false, dropped: ["name"], ...extra });
const seam = (gap, extra = {}) => ({ kind: "seam", observedGapMs: gap, askedGapMs: 500, prepared: true, grace: true, bgRemainingMs: 25000, stages: ["attach", "readiness", "preroll", "playing"], ...extra });
const byId = (list, id) => list.find((v) => v.id === id);
const dv = (text, id) => byId(analyze(text).verdicts, id);

// ───────────── parsing ─────────────

test("parses every engine line shape Copy prints back into fields", () => {
  const p = parsePaste(paste([
    bootRow(),
    { kind: "session", event: "activated", ok: true, token: null, activateMs: 14.4, phase: "active", hint: true },
    remote("play"),
    seam(612, { stages: ["attach", "deadline"] }),
    seam(null, { prepared: false }),
    { kind: "nowplaying", title: "The long episode title", artist: "A show", album: "" },
    { kind: "fault", event: "implicit-activation", at: undefined },
    { kind: "stop", cause: "pause", source: "remote", item: "ep-1", positionSec: 812.4, state: "playing" },
    { kind: "session", event: "notification", type: "began", reason: "default", phase: "active", hint: false, dropped: ["name"] },
  ]));
  const rows = p.engineRows;
  assert.equal(rows.length, 9);
  assert.equal(p.header.engine, "native");
  assert.equal(p.header.build, "2026100101");
  assert.equal(p.header.strikes, "0");
  assert.equal(p.header.web, "67dbe3ce9009ef58");
  assert.deepEqual(p.ring, { count: 9, capacity: 2000, first: 1, last: 9, evicted: 0, missing: 0 });
  assert.equal(rows[0].f.engineVersion, "1.0.0");
  assert.equal(rows[0].f.bundleVersion, "2026100101", "a build number stays a string");
  assert.equal(rows[1].event, "activated");
  assert.equal(rows[1].f.activateMs, 14);
  assert.equal(rows[1].f.token, null);
  assert.equal(rows[1].f.hint, true);
  assert.equal(rows[2].f.cmd, "play");
  assert.equal(rows[2].f.dupCandidate, false, "the string n reads as false, as the raw row's does");
  assert.equal(rows[2].f.route, "carAudio");
  assert.equal(rows[3].f.observedGapMs, 612);
  assert.equal(rows[3].f.askedGapMs, 500);
  assert.deepEqual(rows[3].f.stages, ["attach", "deadline"]);
  assert.equal(rows[4].f.observedGapMs, null, "NEVER AUDIBLE is a null gap");
  assert.equal(rows[5].f.title, "The long episode title");
  assert.equal(rows[5].f.album, "");
  assert.equal(rows[6].event, "implicit-activation");
  assert.equal(rows[7].f.positionSec, 812.4);
  assert.deepEqual(rows[8].f.dropped, ["name"], "withheld= is DiagGate's dropped list");
  assert.equal(rows[1].t - rows[0].t, 1000);
});

test("reads the ring file (diag.jsonl) as well as a Copy, and counts what is neither", () => {
  const text = [
    JSON.stringify({ seq: 1, at: BASE, mono: 1, kind: "build", engineVersion: "1.0.0", protocol: 1, bundleVersion: "2026100101", launch: "background", pitch: "timeDomain", hold: "forever" }),
    JSON.stringify({ seq: 2, at: BASE + 500, mono: 501, kind: "remote", cmd: "play", dupCandidate: "n", route: "carAudio", grace: "cold-play", thread: "main", state: "interrupted" }),
    JSON.stringify({ seq: 3, at: BASE + 900, mono: 901, kind: "grace", event: "end", outcome: "playing" }),
    "{\"seq\":4,\"at\":", // a torn last write
  ].join("\n");
  const p = parsePaste(text);
  assert.equal(p.engineRows.length, 3);
  assert.equal(p.unparsed, 1);
  assert.equal(p.engineRows[1].f.dupCandidate, false);
  const a = analyze(text);
  assert.equal(byId(a.verdicts, "DV-7").verdict, "pass", "launch=background then a heard play");
  assert.equal(a.header.ok, false, "a ring file has no Copy header");
});

test("a drive across midnight UTC keeps its order and its durations", () => {
  const text = paste([
    { ...remote("play"), at: Date.UTC(2026, 9, 1, 23, 59, 59, 500) },
    { ...graceEnd(), at: Date.UTC(2026, 9, 2, 0, 0, 0, 300) },
  ]);
  const rows = parsePaste(text).engineRows;
  assert.equal(rows[1].t - rows[0].t, 800);
  assert.equal(audibleAfter(rows, 0).latencyMs, 800);
});

// ───────────── the header check ─────────────

test("header check: native, strikes=0, the script's build, no downgrade", () => {
  const good = analyze(paste([bootRow()]), { build: "2026100101" }).header;
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  const wrongBuild = analyze(paste([bootRow()]), { build: "2026100202" }).header;
  assert.equal(wrongBuild.ok, false);
  assert.match(wrongBuild.checks.find((c) => !c.ok).name, /build 2026100202/);
  const js = analyze(paste([], { engine: "js", reason: "crash-loop", strikes: 3 })).header;
  assert.equal(js.checks.find((c) => c.name === "engine=native").ok, false);
  assert.equal(js.checks.find((c) => c.name === "strikes=0").ok, false);
  const down = analyze(paste([bootRow(), { kind: "mode", reason: "downgrade", cap: "all" }])).header;
  assert.equal(down.checks.find((c) => c.name === "no downgrade").ok, false);
  const twoBuilds = analyze(paste([bootRow(), bootRow({ bundleVersion: "2026100202" })])).header;
  assert.equal(twoBuilds.checks.find((c) => c.name === "one build in the ring").ok, false);
  const none = headerCheck(parsePaste("#1    15:00:00.000 remote     src=engine play state=interrupted"));
  assert.equal(none.ok, false);
  assert.match(none.checks[0].detail, /before NE-26/);
});

// ───────────── DV-1 ─────────────

test("DV-1: a remote play from pause is a pass only when sound follows it", () => {
  assert.equal(dv(paste([remote("play"), graceEnd()]), "DV-1").verdict, "pass");
  // Heard, read from the next state-bearing row (the pause press 20 min later).
  assert.equal(dv(paste([remote("play"), { ...remote("pause", { state: "playing" }), dt: 1_200_000 }]), "DV-1").verdict, "pass");
  const silent = dv(paste([remote("play"), { kind: "stop", cause: "grace-expired", item: "ep", positionSec: 1, state: "loadingItem" }]), "DV-1");
  assert.equal(silent.verdict, "fail");
  assert.match(silent.why, /silent/);
  assert.deepEqual(silent.rows, ["#1", "#2"]);
  const refused = dv(paste([remote("play", { status: "commandFailed" }), graceEnd()]), "DV-1");
  assert.equal(refused.verdict, "fail");
  assert.match(refused.why, /refused/);
  assert.equal(dv(paste([activate()]), "DV-1").verdict, "no-data");
  // Nothing after the press: unconfirmed is no-data, never a pass.
  assert.equal(dv(paste([remote("play")]), "DV-1").verdict, "no-data");
  // A play with nothing loaded (the status probe) is not a DV-1 press.
  assert.equal(dv(paste([remote("play", { state: "idle", status: "noActionableNowPlayingItem" })]), "DV-1").verdict, "no-data");
});

// ───────────── DV-2, DV-4, DV-5 and the seam distribution ─────────────

test("seam distribution: nearest-rank p50/p95, prepared rate, grace coverage", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
  const rows = [bootRow(), ...Array.from({ length: 10 }, (_, i) => seam(500 + i * 10, { prepared: i < 7, grace: i < 9, bgRemainingMs: i < 8 ? 20000 : null }))];
  const d = seamDistribution(parsePaste(paste(rows)));
  assert.equal(d.count, 10);
  assert.equal(d.p50, 540);
  assert.equal(d.p95, 590);
  assert.equal(d.prepared, 7);
  assert.equal(d.graced, 9);
  assert.equal(d.background, 8);
  assert.equal(d.backgroundGraced, 8);
  assert.equal(d.complete, true);
  const report = formatReport(analyze(paste(rows)));
  assert.match(report, /p50 540ms, p95 590ms/);
  assert.match(report, /prepared 70% \(7\/10\)/);
});

test("DV-2: seams audible and graced pass; a never-audible or ungraced background seam fails", () => {
  assert.equal(dv(paste([bootRow(), seam(510), seam(530)]), "DV-2").verdict, "pass");
  assert.equal(dv(paste([bootRow(), seam(510), seam(null)]), "DV-2").verdict, "fail");
  assert.equal(dv(paste([bootRow(), seam(510, { grace: false })]), "DV-2").verdict, "fail");
  assert.equal(dv(paste([bootRow(), seam(510), { kind: "stop", cause: "grace-expired", state: "transitioning" }]), "DV-2").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-2").verdict, "no-data");
});

test("an early seam evicted from the ring is INCOMPLETE, never a pass", () => {
  // The Copy's own accounting line says 1,700 older rows were evicted.
  const evicted = paste([seam(510, { seq: 1701 }), seam(530)], { ring: "engine rows 2000 of 2000, #1701..#3700, 1700 older evicted" });
  const a = analyze(evicted);
  for (const id of ["DV-2", "DV-5"]) assert.equal(byId(a.verdicts, id).verdict, "incomplete", id);
  assert.match(byId(a.verdicts, "DV-2").why, /1700 older rows evicted/);
  assert.equal(a.seams.complete, false);
  assert.match(formatReport(a), /INCOMPLETE/);
  // A ring file that starts past seq 1, and one with a seq gap, the same.
  const jsonl = [5, 6].map((seq) => JSON.stringify({ seq, at: BASE + seq, mono: seq, kind: "seam", observedGapMs: 500, askedGapMs: 500, prepared: true, grace: true, bgRemainingMs: null, stages: [] })).join("\n");
  assert.equal(dv(jsonl, "DV-2").verdict, "incomplete");
  const gap = [1, 2, 4].map((seq) => JSON.stringify({ seq, at: BASE + seq, mono: seq, kind: "seam", observedGapMs: 500, askedGapMs: 500, prepared: true, grace: true, bgRemainingMs: null, stages: [] })).join("\n");
  assert.equal(dv(gap, "DV-2").verdict, "incomplete");
  // A fail stays a fail: a bad seam that survived eviction is still bad.
  assert.equal(dv(paste([seam(null, { seq: 50 })], { ring: "engine rows 1 of 2000, #50..#50, 49 older evicted" }), "DV-2").verdict, "fail");
  // Rows before the page's Clear are not eviction: the accounting line decides.
  assert.equal(dv(paste([seam(510, { seq: 40 })], { ring: "engine rows 1 of 2000, #40..#40" }), "DV-2").verdict, "pass");
});

test("DV-4: out-points never early; DV-5: no seam reaches the deadline", () => {
  assert.equal(dv(paste([bootRow(), { kind: "outPoint", overshootMs: 40 }]), "DV-4").verdict, "pass");
  assert.equal(dv(paste([bootRow(), { kind: "outPoint", overshootSec: -0.2 }]), "DV-4").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-4").verdict, "no-data");
  assert.equal(dv(paste([bootRow(), seam(520)]), "DV-5").verdict, "pass");
  assert.equal(dv(paste([bootRow(), seam(520, { stages: ["attach", "deadline", "skip"] })]), "DV-5").verdict, "fail");
  assert.equal(dv(paste([bootRow(), { kind: "stop", cause: "load-deadline", state: "loadingItem" }]), "DV-5").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-5").verdict, "no-data");
});

// ───────────── DV-3 and the resume latencies ─────────────

test("DV-3: a call that ends with shouldResume resumes by itself, with its latency", () => {
  const text = paste([
    remote("play", { state: "interrupted" }), graceEnd(),
    { ...began(), dt: 60_000 },
    { ...ended(true), dt: 45_000 },
    { ...activate(true, { activateMs: 18 }), dt: 100 },
    { ...graceEnd(), dt: 600 },
  ]);
  const a = analyze(text);
  assert.equal(byId(a.verdicts, "DV-3").verdict, "pass");
  const [x] = a.interruptions;
  assert.equal(x.kind, "call / long");
  assert.equal(x.durationMs, 45_000);
  assert.equal(x.activateMs, 18);
  assert.equal(x.resumeLatencyMs, 700);
  assert.match(formatReport(a), /call \/ long reason=default lasted 45000ms shouldResume=y activateMs=18ms resume 700ms → resumed/);
});

test("DV-3: no resume after shouldResume fails; a failed play after a no-resume end fails", () => {
  const notResumed = paste([began(), { ...ended(true), dt: 30_000 }, { ...activate(false, { reason: "session-failed:cannot-start-playing" }), dt: 50 }]);
  const v = dv(notResumed, "DV-3");
  assert.equal(v.verdict, "fail");
  assert.match(v.why, /not-resumed \(session activation failed\)/);
  const playFailed = paste([began(), { ...ended(false), dt: 30_000 }, { ...remote("play"), dt: 5_000 }, { ...activate(false), dt: 20 }]);
  assert.equal(dv(playFailed, "DV-3").verdict, "fail");
  const playOk = paste([began(), { ...ended(false), dt: 30_000 }, { ...remote("play"), dt: 5_000 }, activate(true), graceEnd()]);
  assert.equal(dv(playOk, "DV-3").verdict, "pass");
});

test("DV-3 no-data: nothing interrupted, a muted mic, a listener's pause, an interruption that never ended", () => {
  assert.equal(dv(paste([bootRow()]), "DV-3").verdict, "no-data");
  assert.equal(dv(paste([began({ reason: "builtInMicMuted" })]), "DV-3").verdict, "no-data");
  const declined = paste([began(), { ...ended(true), dt: 5_000 },
    { kind: "session", event: "interruption", phase: "ended", resumed: false, why: "listener-paused" }]);
  assert.equal(interruptions(parsePaste(declined).engineRows)[0].outcome, "declined");
  assert.equal(dv(declined, "DV-3").verdict, "no-data");
  const takeover = analyze(paste([began(), { ...remote("pause", { state: "interrupted" }), dt: 600_000 }]));
  assert.equal(byId(takeover.verdicts, "DV-3").verdict, "no-data");
  assert.deepEqual(takeover.exit.neverEnded.map((x) => x.began.seq), [1]);
});

test("a navigation prompt reads as a prompt, with its resume latency", () => {
  const a = analyze(paste([began(), { ...ended(true), dt: 4_000 }, { ...activate(), dt: 30 }, { ...graceEnd(), dt: 400 }]));
  assert.equal(a.interruptions[0].kind, "navigation prompt");
  assert.equal(a.interruptions[0].resumeLatencyMs, 430);
  const withExplicit = analyze(paste([{ kind: "resume", latencyMs: 380, grace: "interruption-resume" }]));
  assert.match(formatReport(withExplicit), /resume\s+latencyMs=380ms grace=interruption-resume/);
});

// ───────────── DV-6..DV-13 ─────────────

test("DV-6: dupCandidate=y fails, clean presses pass, no presses is no-data", () => {
  assert.equal(dv(paste([remote("nextTrack", { state: "playing" })]), "DV-6").verdict, "pass");
  const dup = dv(paste([remote("nextTrack", { state: "playing" }), { ...remote("nextTrack", { dupCandidate: "y", state: "playing" }), dt: 100 }]), "DV-6");
  assert.equal(dup.verdict, "fail");
  assert.deepEqual(dup.rows, ["#2"]);
  assert.equal(dv(paste([bootRow()]), "DV-6").verdict, "no-data");
});

test("DV-7a: a background launch must be followed by a heard play", () => {
  assert.equal(dv(paste([bootRow({ launch: "background" }), remote("play", { grace: "cold-play" }), graceEnd()]), "DV-7").verdict, "pass");
  assert.equal(dv(paste([bootRow({ launch: "background" }), remote("play"), graceEnd("expired")]), "DV-7").verdict, "fail");
  assert.equal(dv(paste([bootRow({ launch: "background" })]), "DV-7").verdict, "no-data");
  assert.equal(dv(paste([bootRow({ launch: "background" }), bootRow(), remote("play"), graceEnd()]), "DV-7").verdict, "no-data",
    "a play after a LATER boot is not the relaunch's");
  assert.equal(dv(paste([bootRow(), remote("play"), graceEnd()]), "DV-7").verdict, "no-data");
});

test("DV-8: the category row; DV-9: the session probe; DV-11 is never in the rows", () => {
  assert.equal(dv(paste([{ kind: "session", event: "category", why: "boot", ok: true, routeSharing: "default", phase: "inactive", hint: false }]), "DV-8").verdict, "pass");
  assert.equal(dv(paste([{ kind: "session", event: "category", why: "boot", ok: false, routeSharing: "default" }]), "DV-8").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-8").verdict, "no-data");
  const probe = (result, token = null) => ({ kind: "probe", event: "speech-then-play", result, token, activated: false, activateMs: null, timeToPlayingMs: 240, speechMs: 1800, grace: "none", held: true, session: "active" });
  const ok = dv(paste([probe("ok")]), "DV-9");
  assert.equal(ok.verdict, "pass");
  assert.match(ok.why, /timeToPlayingMs=240/);
  assert.equal(dv(paste([probe("failed", "cannot-start-playing")]), "DV-9").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-9").verdict, "no-data");
  assert.equal(dv(paste([bootRow(), probe("ok")]), "DV-11").verdict, "no-data");
});

test("DV-10: Now Playing text is never blank, 4a or Unknown", () => {
  const np = (title, artist) => ({ kind: "nowplaying", title, artist, album: "Show" });
  assert.equal(dv(paste([np("Episode 12", "The show")]), "DV-10").verdict, "pass");
  assert.equal(dv(paste([np("Episode 12", "The show"), np("4a", "Unknown")]), "DV-10").verdict, "fail");
  assert.equal(dv(paste([np("Episode 12", "")]), "DV-10").verdict, "fail");
  assert.equal(dv(paste([bootRow()]), "DV-10").verdict, "no-data");
});

test("DV-12: only a row that states the loss judges a kill", () => {
  assert.equal(dv(paste([bootRow(), { kind: "resume", event: "restored", lostSec: 9 }]), "DV-12").verdict, "pass");
  assert.equal(dv(paste([bootRow(), { kind: "restore", event: "restored", lostMs: 22_000 }]), "DV-12").verdict, "fail");
  const relaunch = dv(paste([bootRow(), { kind: "stop", cause: "pause", state: "playing" }, bootRow()]), "DV-12");
  assert.equal(relaunch.verdict, "no-data");
  assert.match(relaunch.why, /1 relaunches seen/, "the ring's first boot is not a relaunch");
});

test("DV-13: a lost route while playing must pause within 2 s", () => {
  const route = (extra = {}) => ({ kind: "session", event: "route", oldDeviceUnavailable: true, port: "headphones", ...extra });
  const playing = remote("play", { state: "interrupted" });
  const pass = paste([playing, graceEnd(), remote("skipForward", { state: "playing" }), route(), { kind: "stop", cause: "route-change", state: "playing", dt: 50 }]);
  assert.equal(dv(pass, "DV-13").verdict, "pass");
  const fail = paste([playing, graceEnd(), remote("skipForward", { state: "playing" }), route()]);
  assert.equal(dv(fail, "DV-13").verdict, "fail");
  const paused = paste([remote("pause", { state: "interrupted" }), route()]);
  assert.equal(dv(paused, "DV-13").verdict, "no-data", "a route lost while already paused is not a DV-13 trial");
});

test("every DV has a no-data path, and an empty paste passes nothing", () => {
  const v = verdicts(parsePaste(paste([])));
  assert.deepEqual(v.map((x) => x.id), Object.keys(DV_TITLES));
  assert.equal(v.length, 13);
  for (const x of v) assert.ok(["no-data", "incomplete"].includes(x.verdict), `${x.id} ${x.verdict}`);
});

// ───────────── faults, remote summary, M1 exit, report, CLI ─────────────

test("fault counts, stop cause=unknown, withheld fields, and the remote summary", () => {
  const a = analyze(paste([
    { kind: "fault", event: "implicit-activation", at: undefined },
    { kind: "fault", event: "externally-owned" },
    { kind: "fault", event: "externally-owned" },
    { kind: "stop", cause: "unknown", state: "playing" },
    { kind: "stop", cause: "pause", state: "playing" },
    remote("play", { route: "carAudio" }),
    remote("nextTrack", { route: "bluetoothA2DP", thread: "bg", status: "commandFailed", state: "playing" }),
    { kind: "session", event: "notification", type: "began", reason: "default", phase: "active", hint: false, dropped: ["name"] },
  ]));
  assert.equal(a.faults.implicitActivation, 1);
  assert.equal(a.faults.externallyOwned, 2);
  assert.equal(a.faults.stopUnknown, 1);
  assert.equal(a.faults.withheld.length, 1);
  assert.equal(a.remote.total, 2);
  assert.equal(a.remote.bgThread, 1);
  assert.deepEqual(a.remote.routes, { carAudio: 1, bluetoothA2DP: 1 });
  assert.deepEqual(a.remote.byCmd.nextTrack, { commandFailed: 1 });
  const text = formatReport(a);
  assert.match(text, /fault implicit-activation 1, externally-owned 2/);
  assert.match(text, /stop cause=unknown 1 \(#4\)/);
  assert.match(text, /routes: carAudio 1, bluetoothA2DP 1/);
  assert.match(text, /withheld by DiagGate \(name\)/);
});

test("M1 exit readings: failed activations (engine and page), silent plays, page remote rows", () => {
  const text = paste([activate(false), remote("play"), { kind: "stop", cause: "grace-expired", state: "loadingItem" }])
    + "\n#12   15:09:22.755 session    audio sessionActivated (failed)  hidden=y"
    + "\n#13   15:24:04.942 remote     play -> play from webkit  handled=y  hidden=n";
  const a = analyze(text);
  assert.equal(a.exit.activationFailed.length, 1);
  assert.equal(a.exit.pageFailed.length, 1);
  assert.equal(a.exit.silentPlays.length, 1);
  assert.equal(a.remote.pageRemote.length, 1);
  const report = formatReport(a);
  assert.match(report, /sessionActivated failed: 2/);
  assert.match(report, /remote play handled with no audio: 1 \(#2\)/);
  assert.match(report, /page \(WebKit\) remote rows 1/);
  assert.equal(strictFailed(a), true);
});

test("the report is a Markdown table with all thirteen DVs, citing rows", () => {
  const report = formatReport(analyze(paste([bootRow(), remote("play"), graceEnd()]), { build: "2026100101" }));
  assert.match(report, /^## Engine report/);
  assert.match(report, /\| DV \| Verdict \| Why \| Rows \|/);
  for (const id of Object.keys(DV_TITLES)) assert.match(report, new RegExp(`\\| ${id} `));
  assert.match(report, /\| DV-1 [^|]*\| pass \| [^|]*\| #2 #3 \|/);
  assert.match(report, /- ok build 2026100101/);
});

test("the CLI reads a file or stdin, prints Markdown or JSON, and --strict exits 1 on a fail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "engine-report-"));
  try {
    const file = path.join(dir, "paste.txt");
    writeFileSync(file, paste([bootRow(), remote("play"), graceEnd()]));
    const out = [];
    assert.equal(main([file, "--build", "2026100101"], { stdout: { write: (s) => out.push(s) } }), 0);
    assert.match(out.join(""), /\| DV-1 [^|]*\| pass/);
    const json = [];
    main([file, "--json"], { stdout: { write: (s) => json.push(s) } });
    assert.equal(JSON.parse(json.join("")).verdicts.length, 13);
    const failing = path.join(dir, "fail.txt");
    writeFileSync(failing, paste([remote("play"), graceEnd("expired")]));
    assert.equal(main([failing, "--strict"], { stdout: { write() {} } }), 1);
    const err = [];
    assert.equal(main([path.join(dir, "nope.txt")], { stderr: { write: (s) => err.push(s) } }), 2);
    assert.equal(main([file], { readFile: () => "hello", stderr: { write: (s) => err.push(s) } }), 2);
    // The real process, stdin in, as the founder's clipboard pipe runs it.
    const run = spawnSync(process.execPath, [path.join(HERE, "engine-report.mjs"), "-"], { input: paste([bootRow(), remote("play"), graceEnd()]), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /### DV verdicts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round-trips through the page's real Copy formatter when it is there (NE-26)", async (t) => {
  const mod = await import(new URL(`file:///${path.join(ROOT, "player", "diagnostic-log.js").replace(/\\/g, "/")}`).href);
  if (typeof mod.engineLineFor !== "function") {
    t.skip("player/diagnostic-log.js has no engineLineFor yet (NE-26 not merged); the mirror above stands in");
    return;
  }
  const rows = [bootRow(), remote("play"), graceEnd(), seam(512), seam(null),
    { kind: "session", event: "activated", ok: true, token: null, activateMs: 14, phase: "active", hint: false },
    { kind: "nowplaying", title: "Episode 12", artist: "The show", album: "" }];
  const viaReal = parsePaste(paste(rows, { format: mod.engineLineFor })).engineRows;
  const viaMirror = parsePaste(paste(rows)).engineRows;
  assert.deepEqual(viaReal.map((r) => [r.kind, r.event, r.f]), viaMirror.map((r) => [r.kind, r.event, r.f]));
});
