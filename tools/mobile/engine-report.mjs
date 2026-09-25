#!/usr/bin/env node
/* tools/mobile/engine-report.mjs — a 'Playback diagnostics → Copy' paste in, DV
 * verdicts out (docs/native-engine-plan.md §7, §10; card NE-26r).
 *
 *   node tools/mobile/engine-report.mjs paste.txt [--build 2026100101] [--json] [--strict]
 *   pbpaste | node tools/mobile/engine-report.mjs -          (stdin; Windows: Get-Clipboard | node …)
 *
 * WHAT IT READS. The text the founder's Copy produces after a drive: the page's
 * header (with NE-26's one-line engine header,
 *   `engine=native v<ver> proto=<n> caps=<list> reason=<r> strikes=<n> hold=<p> build=<CFBundleVersion> | web=<stamp>`),
 * its `engine rows N of 2000, #a..#b, K older evicted` accounting line, and the
 * rows, the engine's marked `src=engine` (diagnostic-log.js engineLineFor). It
 * also takes the engine's ring file itself (`diag.jsonl`, one DiagRow JSON
 * object a line, DiagRow.swift), so a ring pulled off a tethered phone or a
 * sysdiagnose reads the same. Anything else in the paste is counted, never
 * guessed at.
 *
 * WHAT IT PRINTS (Markdown, for the milestone's GitHub issue):
 *   1. the header check: build number, engine=native, strikes=0, no downgrade
 *   2. a DV-1..DV-13 verdict table: pass / fail / no-data (and `incomplete` for
 *      a seam verdict on a ring that evicted rows), each citing the rows by seq
 *   3. resume latencies after interruptions (calls) and navigation prompts
 *   4. the remote command status and route-type summary
 *   5. the seam distribution: p50/p95 observedGapMs, prepared rate, grace coverage
 *   6. fault counts (implicit-activation, externally-owned) and stop cause=unknown
 *   7. the M1 exit readings (§7): sessionActivated failed, silent remote plays,
 *      interruptions that never ended (possible takeovers)
 *
 * THE RULES ARE CONSERVATIVE ON PURPOSE. A verdict is `pass` only when rows in
 * the paste show the thing happening; the absence of a failure row is never a
 * pass (a ring that lost its rows would pass everything). A row kind no emitter
 * writes yet (M2's `outPoint`, a `resume latencyMs=`) is a `no-data`, said with
 * the row it waits for, so the tool is ready before the engine is.
 *
 * AN EVICTED EARLY SEAM IS NOT A PASS (the card's acceptance). The ring holds
 * 2,000 rows (NE-19); a paste whose ring evicted rows, or whose seqs have gaps,
 * may be missing seam 1. Every seam verdict on such a paste reads `incomplete`
 * (a `fail` stays a fail: a bad seam that survived is still bad).
 *
 * Node only, no dependencies: it runs on Windows as `node` does anywhere. */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** DiagRing.capacity (NE-19). */
export const RING_CAPACITY = 2000;
/** A press or a resume is confirmed audible only by a row inside this window. */
export const AUDIBLE_WINDOW_MS = 15_000;
/** An automatic resume (interruption ended with shouldResume) has this long. */
export const RESUME_WINDOW_MS = 30_000;
/** An interruption shorter than this is read as a navigation prompt, longer as a call. */
export const PROMPT_MAX_MS = 20_000;
/** DV-12: at most this much listening lost to a kill (§7 M1 step 8). */
export const DV12_MAX_LOST_SEC = 15;
/** DV-13: the pause must follow the route loss within this long. */
export const ROUTE_STOP_WINDOW_MS = 2_000;

const DAY_MS = 86_400_000; // a Copy line is a time of day
const PLAY_CMDS = new Set(["play", "togglePlayPause"]);
/** Values the tool keeps as strings even when they look like numbers. */
const STRING_KEYS = new Set(["bundleVersion", "build", "engineVersion", "token", "item", "nextId"]);

export const DV_TITLES = Object.freeze({
  "DV-1": "Car's play after a paused wait resumes 4a (H-1, H-1b)",
  "DV-2": "Screen-off seams are audible and grace-covered (H-2)",
  "DV-3": "A call ends and 4a resumes; a play after one activates (H-3)",
  "DV-4": "Out-points never stop early",
  "DV-5": "Precise loads beat the deadline on real CDNs",
  "DV-6": "iOS delivers one press once (dupCandidate)",
  "DV-7": "DV-7a: a system-terminated 4a relaunches for the car's play",
  "DV-8": "Session category and routeSharing (.longFormAudio trial)",
  "DV-9": "Speech then play: the session probe",
  "DV-10": "Now Playing never shows 4a / Unknown (H6, H-6e)",
  "DV-11": "Battery (Settings → Battery)",
  "DV-12": "Kill mid-listen loses at most 15 s",
  "DV-13": "Headset unplug pauses",
});

// ───────────────────────────── parsing ─────────────────────────────

const ENGINE_LINE = /^#(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\S+)\s+src=engine(?:\s+(.*))?$/;
const PAGE_LINE = /^(?:#(\d+)\s+)?(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\S+)\s*(.*)$/;
const HEADER_LINE = /^engine=(native|js)\b(.*)$/;
const RING_LINE = /^engine rows (\d+) of (\d+)(?:, #(\d+)\.\.#(\d+))?(?:, (\d+) older evicted)?(?:, (\d+) MISSING)?/;

const clockMs = (h, m, s, ms) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;

/** One printed value back (diagnostic-log.js engineValue, reversed). */
export function decodeValue(key, raw) {
  if (raw === "—") return null;
  if (raw === "y") return true;
  if (raw === "n") return false;
  if (STRING_KEYS.has(key)) return raw;
  if (/Ms$/.test(key)) {
    const m = /^(-?\d+(?:\.\d+)?)ms$/.exec(raw);
    if (m) return Number(m[1]);
  }
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) return Number(raw);
  if (key === "stages") return raw.split(">");
  if (key === "dropped" || key === "withheld") return raw.split(",");
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try { return JSON.parse(raw); } catch { /* keep the text */ }
  }
  return raw;
}

/** A raw JSON value as the printed form would decode it ("y"/"n" read as booleans). */
function normalizeRaw(v) {
  if (v === "y") return true;
  if (v === "n") return false;
  return v;
}

/** The body of an engine line into `{event, f}` for its kind. */
function parseEngineBody(kind, body) {
  const f = {};
  let event = null;
  let rest = body ?? "";
  if (kind === "seam") {
    const gap = /^(?:gap (-?\d+(?:\.\d+)?)ms|gap —|NEVER AUDIBLE)\s*/.exec(rest);
    if (gap) {
      f.observedGapMs = gap[1] == null ? null : Number(gap[1]);
      rest = rest.slice(gap[0].length);
    }
    const asked = /^asked (?:(-?\d+(?:\.\d+)?)ms|—)\s*/.exec(rest);
    if (asked) {
      f.askedGapMs = asked[1] == null ? null : Number(asked[1]);
      rest = rest.slice(asked[0].length);
    }
  } else if (kind === "nowplaying") {
    const np = /^"(.*?)" \/ "(.*?)" \/ "(.*?)"\s*/.exec(rest);
    if (np) {
      [f.title, f.artist, f.album] = [np[1], np[2], np[3]].map((s) => (s === "—" ? "" : s));
      rest = rest.slice(np[0].length);
    }
  }
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) {
      const key = tok.slice(0, eq);
      const value = decodeValue(key, tok.slice(eq + 1));
      if (key === "withheld") f.dropped = value;
      else f[key] = value;
    } else if (event == null) {
      event = tok;
    }
  }
  if (kind === "remote" && event != null) { f.cmd = event; event = null; }
  if (kind === "build" && event != null && /^v/.test(event)) { f.engineVersion = event.slice(1); event = null; }
  if (event === "?") event = null;
  return { event, f };
}

/** A ring-file line (`diag.jsonl`) as a row, or null. */
function parseJsonRow(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!Number.isInteger(o.seq) || !Number.isFinite(o.at) || typeof o.kind !== "string" || !o.kind) return null;
  const f = {};
  for (const [k, v] of Object.entries(o)) {
    if (["seq", "at", "mono", "kind", "event"].includes(k)) continue;
    f[k] = normalizeRaw(v);
  }
  return { seq: o.seq, t: o.at, epoch: true, kind: o.kind, event: typeof o.event === "string" ? o.event : null, f };
}

function parseHeaderRest(rest) {
  const out = {};
  const [left, web] = rest.split("|");
  const bare = [];
  for (const tok of left.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else bare.push(tok);
  }
  const v = bare.find((b) => /^v/.test(b));
  if (v) out.version = v.slice(1);
  if (web) {
    const m = /web=(\S+)/.exec(web);
    if (m) out.web = m[1];
  }
  return out;
}

/**
 * The paste as data: `{header, ring, engineRows, pageRows, notes, unparsed}`.
 * Engine rows come back in seq order with `t` in ms (time of day for a Copy
 * line, unwrapped across midnight; epoch for a ring-file line).
 */
export function parsePaste(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const engineRows = [];
  const pageRows = [];
  const notes = [];
  let header = null;
  let ring = null;
  let unparsed = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let m;
    if ((m = HEADER_LINE.exec(line))) {
      if (!header) header = { engine: m[1], ...parseHeaderRest(m[2] ?? ""), line: i + 1 };
      return;
    }
    if ((m = RING_LINE.exec(line))) {
      ring = {
        count: +m[1], capacity: +m[2],
        first: m[3] == null ? null : +m[3], last: m[4] == null ? null : +m[4],
        evicted: m[5] == null ? 0 : +m[5], missing: m[6] == null ? 0 : +m[6],
      };
      return;
    }
    if (/^engine rows /.test(line)) { notes.push(line); return; }
    if (line.startsWith("{")) {
      const row = parseJsonRow(line);
      if (row) { row.line = i + 1; engineRows.push(row); } else unparsed++;
      return;
    }
    if ((m = ENGINE_LINE.exec(line))) {
      const { event, f } = parseEngineBody(m[6], m[7]);
      engineRows.push({ seq: +m[1], t: clockMs(m[2], m[3], m[4], m[5]), kind: m[6], event, f, line: i + 1 });
      return;
    }
    if ((m = PAGE_LINE.exec(line))) {
      pageRows.push({ seq: m[1] == null ? null : +m[1], t: clockMs(m[2], m[3], m[4], m[5]), type: m[6], text: m[7], line: i + 1 });
      return;
    }
    // Header prose ("4a playback diagnostics", counts, "Local only…") is not a row.
  });
  engineRows.sort((a, b) => a.seq - b.seq);
  // A Copy line carries a time of day: unwrap a drive that crossed midnight UTC.
  let offset = 0;
  let prev = null;
  for (const r of engineRows) {
    if (r.epoch) continue;
    if (prev != null && r.t + offset < prev - DAY_MS / 2) offset += DAY_MS;
    r.t += offset;
    prev = r.t;
  }
  return { header, ring, engineRows, pageRows, notes, unparsed };
}

// ──────────────────────────── helpers ─────────────────────────────

const cite = (rows) => rows.filter(Boolean).map((r) => `#${r.seq}`);
const isEvent = (r, kind, event) => r.kind === kind && r.event === event;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Nearest-rank percentile of a sorted list, or null. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** How complete the engine's ring in this paste is. */
export function ringCompleteness(parsed) {
  const rows = parsed.engineRows;
  const seqs = [...new Set(rows.map((r) => r.seq))].sort((a, b) => a - b);
  const first = seqs.length ? seqs[0] : null;
  const last = seqs.length ? seqs[seqs.length - 1] : null;
  /* A Copy's own accounting line wins when it is there: it counted the WHOLE
     ring, while the paste leaves out rows from before the page's Clear and rows
     of kinds it does not print, which would read here as gaps. Without it (a
     ring file, a trimmed paste) the seqs themselves are the evidence. */
  if (parsed.ring) {
    const { evicted, missing } = parsed.ring;
    return { first, last, evicted, missing, complete: evicted === 0 && missing === 0 };
  }
  const evicted = first != null && first > 1 ? first - 1 : 0;
  const missing = seqs.length ? last - first + 1 - seqs.length : 0;
  return { first, last, evicted, missing, complete: evicted === 0 && missing === 0 };
}

/** Is this a row that says the audio was heard? `strong` rows measure it. */
function audibleSignal(r) {
  if (isEvent(r, "grace", "end") && r.f.outcome === "playing") return "strong";
  if (r.kind === "resume" && num(r.f.latencyMs) != null) return "strong";
  if (r.kind === "seam" && num(r.f.observedGapMs) != null) return "strong";
  if (isEvent(r, "deck", "playing")) return "strong";
  return null;
}

/** A row that says the attempt ended silent. */
function silentSignal(r) {
  if (r.kind === "stop" && r.f.cause === "grace-expired") return "grace expired";
  if (isEvent(r, "grace", "end") && r.f.outcome && r.f.outcome !== "playing") return `grace ended ${r.f.outcome}`;
  if (r.kind === "session" && (r.event === "activate" || r.event === "activated") && r.f.ok === false) return "session activation failed";
  if (r.kind === "fault" && r.event === "no-session") return "no session";
  return null;
}

/**
 * After row `i`, was audio heard? `{audible: true|false|null, strength, row, why}`.
 * Strong: a row inside `windowMs` that measured sound. Silent: a row inside the
 * window that says it failed. Otherwise the first later row that carries the
 * engine's `state` answers weakly ("playing" or not); none at all is null.
 */
export function audibleAfter(rows, i, windowMs = AUDIBLE_WINDOW_MS) {
  const start = rows[i];
  for (let j = i + 1; j < rows.length; j++) {
    const r = rows[j];
    const inWindow = r.t - start.t <= windowMs;
    if (inWindow) {
      const strong = audibleSignal(r);
      if (strong) return { audible: true, strength: strong, row: r, latencyMs: num(r.f.latencyMs) ?? r.t - start.t };
      const silent = silentSignal(r);
      if (silent) return { audible: false, strength: "strong", row: r, why: silent };
    }
    if (typeof r.f.state === "string") {
      return r.f.state === "playing"
        ? { audible: true, strength: "state", row: r, latencyMs: null }
        : { audible: false, strength: "state", row: r, why: `next state=${r.f.state}` };
    }
  }
  return { audible: null, strength: null, row: null };
}

const handled = (r) => r.f.status == null || /^success$/i.test(String(r.f.status));

// ─────────────────────────── the analysis ───────────────────────────

/** The Copy header check (§7 step 0). */
export function headerCheck(parsed, { build = null } = {}) {
  const h = parsed.header;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (!h) {
    add("engine header line", false, "no `engine=` line: a Copy from before NE-26, or not a Copy");
    return { ok: false, checks, header: null };
  }
  add("engine=native", h.engine === "native", `engine=${h.engine}${h.reason ? ` reason=${h.reason}` : ""}`);
  add("strikes=0", h.strikes === "0", `strikes=${h.strikes ?? "absent"}`);
  const downgrades = parsed.engineRows.filter((r) => r.kind === "mode" && r.f.reason === "downgrade");
  add("no downgrade", h.reason !== "downgrade" && !downgrades.length,
    downgrades.length ? `mode reason=downgrade at ${cite(downgrades).join(", ")}` : `reason=${h.reason ?? "?"}`);
  const bundles = [...new Set(parsed.engineRows.filter((r) => r.kind === "build" && r.f.bundleVersion != null)
    .map((r) => String(r.f.bundleVersion)))];
  if (build != null) {
    add(`build ${build}`, h.build === String(build), `header build=${h.build ?? "?"}`);
  } else {
    add("build number", h.build != null && h.build !== "?", `build=${h.build ?? "?"} (pass --build to check it against the script)`);
  }
  if (bundles.length > 1) add("one build in the ring", false, `build rows name ${bundles.join(", ")}`);
  return { ok: checks.every((c) => c.ok), checks, header: h };
}

function verdict(id, status, why, rows = []) {
  return { id, title: DV_TITLES[id], verdict: status, why, rows: cite(rows) };
}

/** The resumed-or-not reading for every interruption that began while running. */
export function interruptions(rows) {
  const out = [];
  rows.forEach((r, i) => {
    if (!(isEvent(r, "session", "interruption") && r.f.phase === "began")) return;
    if (r.f.running !== true || r.f.reason === "builtInMicMuted") return;
    let end = null;
    let endIdx = -1;
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j];
      if (isEvent(x, "session", "interruption") && x.f.phase === "began") break;
      const ended = (isEvent(x, "session", "notification") && x.f.type === "ended")
        || (isEvent(x, "session", "interruption") && x.f.phase === "ended");
      if (ended) { end = x; endIdx = j; break; }
    }
    const entry = { began: r, reason: r.f.reason ?? "?", end, durationMs: end ? end.t - r.t : null };
    if (!end) { out.push({ ...entry, outcome: "never-ended" }); return; }
    // Either end row may carry it: the owner's notification (shouldResume) or
    // the core's own (resumed=n why=…) when it declined.
    let shouldResume = end.f.shouldResume ?? null;
    if (end.f.resumed === false) shouldResume = shouldResume ?? true;
    const declined = rows.slice(endIdx, endIdx + 4).find((x) => isEvent(x, "session", "interruption")
      && x.f.phase === "ended" && x.f.resumed === false);
    entry.shouldResume = shouldResume;
    entry.kind = entry.durationMs != null && entry.durationMs < PROMPT_MAX_MS ? "navigation prompt" : "call / long";
    if (declined) { out.push({ ...entry, outcome: "declined", why: declined.f.why ?? "?", declined }); return; }
    const activate = rows.slice(endIdx + 1).find((x) => x.t - end.t <= RESUME_WINDOW_MS
      && x.kind === "session" && (x.event === "activate" || x.event === "activated"));
    entry.activateMs = activate ? num(activate.f.activateMs) : null;
    if (shouldResume === true) {
      const heard = audibleAfter(rows, endIdx, RESUME_WINDOW_MS);
      entry.resumeLatencyMs = heard.audible && heard.strength === "strong" ? heard.latencyMs : null;
      entry.evidence = heard.row;
      out.push({ ...entry, outcome: heard.audible === true ? "resumed" : heard.audible === false ? "not-resumed" : "unconfirmed", why: heard.why });
      return;
    }
    // Ended without shouldResume: the car's (or a tap's) play must still activate (DV-3).
    const nextPlay = rows.slice(endIdx + 1).findIndex((x) => x.kind === "remote" && PLAY_CMDS.has(x.f.cmd));
    if (nextPlay < 0) { out.push({ ...entry, outcome: "no-play-after" }); return; }
    const k = endIdx + 1 + nextPlay;
    const heard = audibleAfter(rows, k);
    entry.play = rows[k];
    entry.evidence = heard.row;
    out.push({ ...entry, outcome: heard.audible === true ? "played-after" : heard.audible === false ? "play-failed-after" : "unconfirmed", why: heard.why });
  });
  return out;
}

/** Every remote press, with whether a play was heard. */
export function remotePresses(rows) {
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "remote").map(({ r, i }) => {
    /* A play that resumes something: not one while already playing, and not
       one with nothing loaded (state=idle: the status probe, §7 step 6, where
       noActionableNowPlayingItem is the right answer). */
    const resuming = PLAY_CMDS.has(r.f.cmd) && r.f.state !== "playing" && r.f.state !== "idle";
    return { row: r, cmd: r.f.cmd ?? "?", resuming, handled: handled(r), heard: resuming ? audibleAfter(rows, i) : null };
  });
}

/** The seam distribution (packed seam rows, NE-19). */
export function seamDistribution(parsed) {
  const seams = parsed.engineRows.filter((r) => r.kind === "seam");
  const gaps = seams.map((r) => num(r.f.observedGapMs)).filter((g) => g != null).sort((a, b) => a - b);
  const background = seams.filter((r) => num(r.f.bgRemainingMs) != null);
  const ring = ringCompleteness(parsed);
  return {
    count: seams.length,
    audible: gaps.length,
    neverAudible: seams.filter((r) => num(r.f.observedGapMs) == null),
    p50: percentile(gaps, 50),
    p95: percentile(gaps, 95),
    worst: gaps.length ? gaps[gaps.length - 1] : null,
    askedMedian: percentile(seams.map((r) => num(r.f.askedGapMs)).filter((g) => g != null).sort((a, b) => a - b), 50),
    prepared: seams.filter((r) => r.f.prepared === true).length,
    graced: seams.filter((r) => r.f.grace === true).length,
    background: background.length,
    backgroundGraced: background.filter((r) => r.f.grace === true).length,
    complete: ring.complete,
    ring,
    rows: seams,
  };
}

/** A seam verdict, demoted on a ring that may have lost seam 1. */
function seamVerdict(id, status, why, rows, ring) {
  if (!ring.complete && status !== "fail") {
    const lost = [ring.evicted ? `${ring.evicted} older rows evicted` : null, ring.missing ? `${ring.missing} seq gaps` : null]
      .filter(Boolean).join(", ");
    return verdict(id, "incomplete", `the ring lost rows (${lost}), so an early seam may be gone; ${why}`, rows);
  }
  return verdict(id, status, why, rows);
}

/** The DV-1..DV-13 table. */
export function verdicts(parsed) {
  const rows = parsed.engineRows;
  const ring = ringCompleteness(parsed);
  const out = [];
  const presses = remotePresses(rows);
  const plays = presses.filter((p) => p.resuming);

  // DV-1: every resuming play from the car / lock screen is heard.
  {
    const refused = plays.filter((p) => !p.handled);
    const silent = plays.filter((p) => p.handled && p.heard.audible === false);
    const heard = plays.filter((p) => p.handled && p.heard.audible === true);
    const unknown = plays.filter((p) => p.handled && p.heard.audible == null);
    const hints = rows.filter((r) => r.kind === "session" && r.f.hint === true);
    const hintNote = hints.length ? `; secondaryAudioShouldBeSilencedHint=y on ${hints.length} session rows` : "";
    if (!plays.length) out.push(verdict("DV-1", "no-data", "no remote play or toggle while paused"));
    else if (refused.length || silent.length) {
      out.push(verdict("DV-1", "fail",
        [refused.length ? `${refused.length} refused (${refused.map((p) => `#${p.row.seq} status=${p.row.f.status}`).join(", ")})` : null,
          silent.length ? `${silent.length} silent (${silent.map((p) => `#${p.row.seq}: ${p.heard.why}`).join(", ")})` : null]
          .filter(Boolean).join("; ") + hintNote,
        [...refused.map((p) => p.row), ...silent.flatMap((p) => [p.row, p.heard.row])]));
    } else if (unknown.length) {
      out.push(verdict("DV-1", "no-data", `${unknown.length} of ${plays.length} plays have no row after them to confirm sound${hintNote}`, unknown.map((p) => p.row)));
    } else {
      const graces = [...new Set(heard.map((p) => p.row.f.grace ?? "?"))].join(",");
      out.push(verdict("DV-1", "pass", `${heard.length} remote plays heard (grace=${graces})${hintNote}`, heard.flatMap((p) => [p.row, p.heard.row])));
    }
  }

  // DV-2: screen-off seams (M2).
  {
    const d = seamDistribution(parsed);
    const expired = rows.filter((r) => r.kind === "stop" && r.f.cause === "grace-expired");
    const uncovered = d.rows.filter((r) => num(r.f.bgRemainingMs) != null && r.f.grace !== true);
    if (!d.count) out.push(seamVerdict("DV-2", "no-data", "no seam rows (Forays play on the old player in M1)", [], ring));
    else if (d.neverAudible.length || expired.length || uncovered.length) {
      out.push(seamVerdict("DV-2", "fail", [d.neverAudible.length ? `${d.neverAudible.length} never audible` : null,
        uncovered.length ? `${uncovered.length} background seams without grace` : null,
        expired.length ? `${expired.length} grace-expired stops` : null].filter(Boolean).join("; "),
      [...d.neverAudible, ...uncovered, ...expired], ring));
    } else {
      out.push(seamVerdict("DV-2", "pass", `${d.count} seams audible, p95 ${d.p95}ms, ${d.backgroundGraced}/${d.background} background seams graced`, [d.rows[0], d.rows[d.rows.length - 1]], ring));
    }
  }

  // DV-3: interruptions (calls and prompts) resume, and a play after one activates.
  {
    const list = interruptions(rows);
    const judged = list.filter((x) => ["resumed", "not-resumed", "played-after", "play-failed-after"].includes(x.outcome));
    const failed = judged.filter((x) => x.outcome === "not-resumed" || x.outcome === "play-failed-after");
    const activateFails = rows.filter((r) => r.kind === "session" && (r.event === "activate" || r.event === "activated") && r.f.ok === false);
    if (failed.length) {
      out.push(verdict("DV-3", "fail", failed.map((x) => `#${x.began.seq} ${x.reason}: ${x.outcome}${x.why ? ` (${x.why})` : ""}`).join("; "),
        failed.flatMap((x) => [x.began, x.end, x.evidence])));
    } else if (!judged.length) {
      const why = list.length ? `${list.length} interruptions, none with a resume to judge (${[...new Set(list.map((x) => x.outcome))].join(", ")})`
        : "no interruption while playing";
      out.push(verdict("DV-3", "no-data", why, list.map((x) => x.began)));
    } else {
      const ms = judged.map((x) => x.activateMs).filter((v) => v != null);
      out.push(verdict("DV-3", "pass", `${judged.length} interruptions resumed or played after${ms.length ? `; activateMs max ${Math.max(...ms)}` : ""}`
        + (activateFails.length ? `; note ${activateFails.length} failed activations elsewhere` : ""),
      judged.flatMap((x) => [x.began, x.end])));
    }
  }

  // DV-4: out-points never early (M2, NE-32's outPoint rows).
  {
    const outs = rows.filter((r) => r.kind === "outPoint");
    const over = (r) => num(r.f.overshootMs) ?? (num(r.f.overshootSec) == null ? null : r.f.overshootSec * 1000);
    const early = outs.filter((r) => over(r) != null && over(r) < 0);
    const measured = outs.filter((r) => over(r) != null);
    if (!measured.length) out.push(seamVerdict("DV-4", "no-data", "no outPoint row with an overshoot (M2, NE-32)", outs, ring));
    else if (early.length) out.push(seamVerdict("DV-4", "fail", `${early.length} out-points stopped early`, early, ring));
    else out.push(seamVerdict("DV-4", "pass", `${measured.length} out-points, none early; max overshoot ${Math.max(...measured.map(over))}ms`, measured, ring));
  }

  // DV-5: precise loads beat the deadline.
  {
    const seams = rows.filter((r) => r.kind === "seam");
    const missed = seams.filter((r) => Array.isArray(r.f.stages) && r.f.stages.some((s) => s === "deadline" || s === "skip"));
    const stops = rows.filter((r) => r.kind === "stop" && r.f.cause === "load-deadline");
    if (!seams.length && !stops.length) out.push(seamVerdict("DV-5", "no-data", "no seam rows (M2)", [], ring));
    else if (missed.length || stops.length) out.push(seamVerdict("DV-5", "fail", `${missed.length} seams hit the deadline or skipped, ${stops.length} load-deadline stops`, [...missed, ...stops], ring));
    else out.push(seamVerdict("DV-5", "pass", `${seams.length} seams, no deadline or skip stage`, [seams[0]], ring));
  }

  // DV-6: one press, one delivery.
  {
    const dups = presses.filter((p) => p.row.f.dupCandidate === true);
    if (!presses.length) out.push(verdict("DV-6", "no-data", "no remote rows"));
    else if (dups.length) out.push(verdict("DV-6", "fail", `${dups.length} of ${presses.length} presses are dupCandidate=y (keep the de-dup guard, OQ-7)`, dups.map((p) => p.row)));
    else out.push(verdict("DV-6", "pass", `${presses.length} presses, no dupCandidate`, [presses[0].row]));
  }

  // DV-7a: a background launch followed by a heard play.
  {
    const launches = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === "build" && r.f.launch === "background");
    if (!launches.length) out.push(verdict("DV-7", "no-data", "no build row with launch=background (DV-7b, force-quit, is a negative control and cannot pass)"));
    else {
      const results = launches.map(({ r, i }) => {
        const k = rows.findIndex((x, j) => j > i && x.kind === "remote" && PLAY_CMDS.has(x.f.cmd));
        if (k < 0) return { r, status: "no-data" };
        const next = rows.findIndex((x, j) => j > i && x.kind === "build");
        if (next >= 0 && next < k) return { r, status: "no-data" };
        const heard = audibleAfter(rows, k);
        return { r, play: rows[k], heard, status: heard.audible === true ? "pass" : heard.audible === false ? "fail" : "no-data" };
      });
      const fail = results.filter((x) => x.status === "fail");
      const pass = results.filter((x) => x.status === "pass");
      if (fail.length) out.push(verdict("DV-7", "fail", `background launch then a silent play (${fail.map((x) => x.heard.why).join(", ")})`, fail.flatMap((x) => [x.r, x.play, x.heard.row])));
      else if (pass.length) out.push(verdict("DV-7", "pass", `launch=background then a heard play (${pass.length})`, pass.flatMap((x) => [x.r, x.play])));
      else out.push(verdict("DV-7", "no-data", "launch=background, but no remote play after it in the same boot", results.map((x) => x.r)));
    }
  }

  // DV-8: the category row and its routeSharing.
  {
    const cats = rows.filter((r) => isEvent(r, "session", "category"));
    const bad = cats.filter((r) => r.f.ok === false);
    if (!cats.length) out.push(verdict("DV-8", "no-data", "no session category row"));
    else if (bad.length) out.push(verdict("DV-8", "fail", `setCategory failed ${bad.length}x`, bad));
    else out.push(verdict("DV-8", "pass", `category applied; routeSharing=${[...new Set(cats.map((r) => r.f.routeSharing ?? "?"))].join(",")}`, [cats[cats.length - 1]]));
  }

  // DV-9: the Developer session probe (NE-25c).
  {
    const probes = rows.filter((r) => isEvent(r, "probe", "speech-then-play"));
    const failed = probes.filter((r) => r.f.result !== "ok");
    if (!probes.length) out.push(verdict("DV-9", "no-data", "no probe speech-then-play row (run the desk pre-flight's Session probe)"));
    else if (failed.length) out.push(verdict("DV-9", "fail", failed.map((r) => `result=${r.f.result ?? "?"} token=${r.f.token ?? "—"}`).join("; ") + " (NE-33 takes the AVAudioEngine path)", failed));
    else out.push(verdict("DV-9", "pass", `speech then play ok (${probes.map((r) => `timeToPlayingMs=${r.f.timeToPlayingMs ?? "—"} held=${r.f.held === true ? "y" : "n"}`).join("; ")})`, probes));
  }

  // DV-10: Now Playing text.
  {
    const nps = rows.filter((r) => r.kind === "nowplaying");
    const blank = (v) => v == null || v === "" || /^(4a|unknown)$/i.test(String(v).trim());
    const bad = nps.filter((r) => ("title" in r.f || "artist" in r.f) && (blank(r.f.title) || blank(r.f.artist)));
    const judged = nps.filter((r) => "title" in r.f || "artist" in r.f);
    if (!judged.length) out.push(verdict("DV-10", "no-data", "no engine nowplaying row"));
    else if (bad.length) out.push(verdict("DV-10", "fail", `${bad.length} Now Playing writes with an empty, "4a" or "Unknown" title or artist`, bad));
    else out.push(verdict("DV-10", "pass", `${judged.length} Now Playing writes, every one titled and credited`, [judged[0]]));
  }

  out.push(verdict("DV-11", "no-data", "not in the rows: read Settings → Battery after the drive (M3)"));

  // DV-12: a kill loses at most 15 s. Only a row that states the loss can judge it.
  {
    const lossRows = rows.filter((r) => (r.kind === "resume" || r.kind === "restore")
      && (num(r.f.lostSec) != null || num(r.f.lostMs) != null));
    const lost = (r) => num(r.f.lostSec) ?? r.f.lostMs / 1000;
    const over = lossRows.filter((r) => lost(r) > DV12_MAX_LOST_SEC);
    // A boot after other rows is a relaunch; the ring's first boot is not.
    const relaunches = rows.filter((r, i) => r.kind === "build" && i > 0);
    if (!lossRows.length) {
      out.push(verdict("DV-12", "no-data", `no resume/restore row states lostSec${relaunches.length ? ` (${relaunches.length} relaunches seen: compare the restored position with the drive note)` : ""}`, relaunches));
    } else if (over.length) out.push(verdict("DV-12", "fail", `lost ${over.map((r) => `${lost(r)}s`).join(", ")} (max ${DV12_MAX_LOST_SEC}s)`, over));
    else out.push(verdict("DV-12", "pass", `lost at most ${Math.max(...lossRows.map(lost))}s over ${lossRows.length} relaunches`, lossRows));
  }

  // DV-13: a lost route while playing pauses, within ROUTE_STOP_WINDOW_MS.
  {
    const lost = [];
    rows.forEach((r, i) => {
      const routeLost = (isEvent(r, "session", "route") && r.f.oldDeviceUnavailable === true);
      if (!routeLost) return;
      let state = null;
      for (let j = i - 1; j >= 0; j--) if (typeof rows[j].f.state === "string") { state = rows[j].f.state; break; }
      const stop = rows.slice(i + 1).find((x) => x.t - r.t <= ROUTE_STOP_WINDOW_MS && x.kind === "stop" && x.f.cause === "route-change");
      if (state === "playing" || stop) lost.push({ r, stop, port: r.f.port ?? "?" });
    });
    const kept = lost.filter((x) => !x.stop);
    if (!lost.length) out.push(verdict("DV-13", "no-data", "no route loss while playing"));
    else if (kept.length) out.push(verdict("DV-13", "fail", `${kept.length} route losses with no stop cause=route-change`, kept.map((x) => x.r)));
    else out.push(verdict("DV-13", "pass", `${lost.length} route losses paused (${[...new Set(lost.map((x) => x.port))].join(",")})`, lost.flatMap((x) => [x.r, x.stop])));
  }

  return out;
}

/** Fault and stop-cause counts. */
export function faultCounts(parsed) {
  const rows = parsed.engineRows;
  const faults = {};
  for (const r of rows.filter((x) => x.kind === "fault")) faults[r.event ?? "?"] = (faults[r.event ?? "?"] ?? 0) + 1;
  const unknownStops = rows.filter((r) => r.kind === "stop" && r.f.cause === "unknown");
  const stops = {};
  for (const r of rows.filter((x) => x.kind === "stop")) stops[r.f.cause ?? "?"] = (stops[r.f.cause ?? "?"] ?? 0) + 1;
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const withheld = rows.filter((r) => Array.isArray(r.f.dropped) && r.f.dropped.length);
  return {
    implicitActivation: faults["implicit-activation"] ?? 0,
    externallyOwned: faults["externally-owned"] ?? 0,
    faults,
    faultRows: rows.filter((r) => r.kind === "fault"),
    stopUnknown: unknownStops.length,
    stopUnknownRows: unknownStops,
    stops,
    kinds,
    withheld,
  };
}

/** Remote status and route-type summary. */
export function remoteSummary(parsed) {
  const presses = remotePresses(parsed.engineRows);
  const byCmd = {};
  const routes = {};
  let bgThread = 0;
  let dup = 0;
  for (const p of presses) {
    const status = p.row.f.status ?? "unrecorded";
    byCmd[p.cmd] = byCmd[p.cmd] ?? {};
    byCmd[p.cmd][status] = (byCmd[p.cmd][status] ?? 0) + 1;
    const route = p.row.f.route ?? "none";
    routes[route] = (routes[route] ?? 0) + 1;
    if (p.row.f.thread === "bg") bgThread++;
    if (p.row.f.dupCandidate === true) dup++;
  }
  const pageRemote = parsed.pageRows.filter((r) => r.type === "remote");
  return { total: presses.length, byCmd, routes, bgThread, dup, pageRemote };
}

/** The M1 exit readings (§7). */
export function m1Exit(parsed) {
  const rows = parsed.engineRows;
  const activationFailed = [
    ...rows.filter((r) => r.kind === "session" && (r.event === "activate" || r.event === "activated") && r.f.ok === false),
  ];
  const pageFailed = parsed.pageRows.filter((r) => /sessionActivated \(failed\)/.test(r.text));
  const silentPlays = remotePresses(rows).filter((p) => p.resuming && p.handled && p.heard.audible === false);
  const neverEnded = interruptions(rows).filter((x) => x.outcome === "never-ended");
  return { activationFailed, pageFailed, silentPlays, neverEnded };
}

/** Everything, as data. */
export function analyze(text, opts = {}) {
  const parsed = parsePaste(text);
  const list = interruptions(parsed.engineRows);
  const explicitResumes = parsed.engineRows.filter((r) => r.kind === "resume" && num(r.f.latencyMs) != null);
  return {
    parsed,
    ring: ringCompleteness(parsed),
    header: headerCheck(parsed, opts),
    verdicts: verdicts(parsed),
    interruptions: list,
    explicitResumes,
    remote: remoteSummary(parsed),
    seams: seamDistribution(parsed),
    faults: faultCounts(parsed),
    exit: m1Exit(parsed),
  };
}

// ─────────────────────────── the report ───────────────────────────

const msText = (v) => (v == null ? "—" : `${Math.round(v)}ms`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : "—");
const tick = (ok) => (ok ? "ok" : "**FAIL**");

/** The Markdown a milestone issue quotes. */
export function formatReport(a) {
  const L = [];
  const p = a.parsed;
  L.push("## Engine report");
  L.push("");
  L.push(`Engine rows ${p.engineRows.length}${a.ring.first != null ? ` (#${a.ring.first}..#${a.ring.last})` : ""}, page rows ${p.pageRows.length}`
    + (p.unparsed ? `, ${p.unparsed} unreadable lines` : "")
    + (a.ring.complete ? ", ring complete." : `. **Ring INCOMPLETE:** ${a.ring.evicted} older rows evicted, ${a.ring.missing} seq gaps.`));
  for (const n of p.notes) L.push(`- ${n}`);
  L.push("");

  L.push("### Header check");
  if (a.header.header) L.push(`\`engine=${a.header.header.engine}${a.header.header.version ? ` v${a.header.header.version}` : ""} reason=${a.header.header.reason ?? "?"} strikes=${a.header.header.strikes ?? "?"} hold=${a.header.header.hold ?? "?"} build=${a.header.header.build ?? "?"} web=${a.header.header.web ?? "?"}\``);
  for (const c of a.header.checks) L.push(`- ${tick(c.ok)} ${c.name}: ${c.detail}`);
  L.push("");

  L.push("### DV verdicts");
  L.push("| DV | Verdict | Why | Rows |");
  L.push("|---|---|---|---|");
  for (const v of a.verdicts) {
    const shown = v.rows.length > 8 ? [...v.rows.slice(0, 8), `+${v.rows.length - 8}`] : v.rows;
    L.push(`| ${v.id} ${v.title} | ${v.verdict === "fail" ? "**fail**" : v.verdict} | ${v.why.replace(/\|/g, "\\|")} | ${shown.join(" ") || "—"} |`);
  }
  L.push("");

  L.push("### Resume latency after interruptions and navigation");
  if (!a.interruptions.length && !a.explicitResumes.length) L.push("No interruption while playing.");
  for (const x of a.interruptions) {
    L.push(`- #${x.began.seq} ${x.kind ?? "never ended"} reason=${x.reason} lasted ${msText(x.durationMs)}`
      + ` shouldResume=${x.shouldResume == null ? "—" : x.shouldResume ? "y" : "n"} activateMs=${msText(x.activateMs)}`
      + ` resume ${msText(x.resumeLatencyMs)} → ${x.outcome}${x.why ? ` (${x.why})` : ""}`);
  }
  for (const r of a.explicitResumes) L.push(`- #${r.seq} resume ${r.event ?? ""} latencyMs=${msText(r.f.latencyMs)} grace=${r.f.grace ?? "—"}`);
  const lat = a.interruptions.map((x) => x.resumeLatencyMs).filter((v) => v != null).sort((x, y) => x - y);
  if (lat.length) L.push(`- resume p50 ${msText(percentile(lat, 50))}, max ${msText(lat[lat.length - 1])}`);
  L.push("");

  L.push("### Remote commands and routes");
  const r = a.remote;
  if (!r.total) L.push("No engine remote rows.");
  else {
    L.push(`${r.total} presses; thread=bg ${r.bgThread}; dupCandidate ${r.dup}`);
    for (const [cmd, st] of Object.entries(r.byCmd)) L.push(`- ${cmd}: ${Object.entries(st).map(([s, n]) => `${s} ${n}`).join(", ")}`);
    L.push(`- routes: ${Object.entries(r.routes).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  if (r.pageRemote.length) L.push(`- **page (WebKit) remote rows ${r.pageRemote.length}**: the web player received presses`);
  L.push("");

  L.push("### Seam distribution");
  const s = a.seams;
  if (!s.count) L.push("No seam rows.");
  else {
    L.push(`${s.count} seams, ${s.audible} audible${s.neverAudible.length ? `, **${s.neverAudible.length} never audible** (${cite(s.neverAudible).join(" ")})` : ""}`);
    L.push(`- observedGapMs p50 ${msText(s.p50)}, p95 ${msText(s.p95)}, worst ${msText(s.worst)}; asked median ${msText(s.askedMedian)}`);
    L.push(`- prepared ${pct(s.prepared, s.count)}; grace ${pct(s.graced, s.count)}; background seams graced ${pct(s.backgroundGraced, s.background)}`);
  }
  if (!s.complete) L.push("- **INCOMPLETE:** the ring lost rows; seam 1 may be missing, so this distribution is not the whole drive.");
  L.push("");

  L.push("### Faults and stops");
  const f = a.faults;
  L.push(`- fault implicit-activation ${f.implicitActivation}, externally-owned ${f.externallyOwned}`
    + (Object.keys(f.faults).length ? ` (all: ${Object.entries(f.faults).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""));
  L.push(`- stop cause=unknown ${f.stopUnknown}${f.stopUnknown ? ` (${cite(f.stopUnknownRows).join(" ")})` : ""}`
    + (Object.keys(f.stops).length ? `; stops: ${Object.entries(f.stops).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""));
  if (f.withheld.length) L.push(`- ${f.withheld.length} rows had fields withheld by DiagGate (${[...new Set(f.withheld.flatMap((x) => x.f.dropped))].join(",")})`);
  L.push("");

  L.push("### M1 exit readings");
  const e = a.exit;
  L.push(`- sessionActivated failed: ${e.activationFailed.length + e.pageFailed.length}`
    + (e.activationFailed.length ? ` (engine ${cite(e.activationFailed).join(" ")})` : "")
    + (e.pageFailed.length ? ` (page lines ${e.pageFailed.map((x) => x.line).join(",")})` : ""));
  L.push(`- remote play handled with no audio: ${e.silentPlays.length}${e.silentPlays.length ? ` (${e.silentPlays.map((x) => `#${x.row.seq}`).join(" ")})` : ""}`);
  L.push(`- interruptions that never ended (possible takeovers; each must match "another app played after 4a" in the drive note): ${e.neverEnded.length}`
    + (e.neverEnded.length ? ` (${e.neverEnded.map((x) => `#${x.began.seq}`).join(" ")})` : ""));
  return L.join("\n") + "\n";
}

/** Did this paste fail anything `--strict` should stop on? */
export function strictFailed(a) {
  return !a.header.ok || a.verdicts.some((v) => v.verdict === "fail");
}

function toJson(a) {
  const slim = (r) => (r && typeof r === "object" && "seq" in r && "kind" in r ? `#${r.seq}` : r);
  return JSON.stringify({
    header: a.header, ring: a.ring, verdicts: a.verdicts,
    interruptions: a.interruptions.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, slim(v)]))),
    remote: { ...a.remote, pageRemote: a.remote.pageRemote.length },
    seams: { ...a.seams, rows: undefined, neverAudible: cite(a.seams.neverAudible) },
    faults: { ...a.faults, faultRows: cite(a.faults.faultRows), stopUnknownRows: cite(a.faults.stopUnknownRows), withheld: cite(a.faults.withheld) },
    exit: {
      activationFailed: cite(a.exit.activationFailed), pageFailedLines: a.exit.pageFailed.map((x) => x.line),
      silentPlays: a.exit.silentPlays.map((x) => `#${x.row.seq}`), neverEnded: a.exit.neverEnded.map((x) => `#${x.began.seq}`),
    },
  }, null, 2);
}

// ───────────────────────────── the CLI ─────────────────────────────

export function main(argv, { readFile = (p) => readFileSync(p, "utf8"), stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = [...argv];
  const opts = {};
  let file = null;
  let json = false;
  let strict = false;
  while (args.length) {
    const a = args.shift();
    if (a === "--build") opts.build = args.shift();
    else if (a === "--json") json = true;
    else if (a === "--strict") strict = true;
    else if (a === "-h" || a === "--help") {
      stdout.write("usage: node tools/mobile/engine-report.mjs <paste.txt|-> [--build <CFBundleVersion>] [--json] [--strict]\n");
      return 0;
    } else file = a;
  }
  let text;
  try {
    text = readFile(file == null || file === "-" ? 0 : file);
  } catch (err) {
    stderr.write(`engine-report: cannot read ${file ?? "stdin"}: ${err.message}\n`);
    return 2;
  }
  const a = analyze(text, opts);
  if (!a.parsed.engineRows.length && !a.parsed.header) {
    stderr.write("engine-report: no engine header and no engine rows: is this a Playback diagnostics Copy?\n");
    return 2;
  }
  stdout.write(json ? `${toJson(a)}\n` : formatReport(a));
  return strict && strictFailed(a) ? 1 : 0;
}

const invoked = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
