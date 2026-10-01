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
 *   8. the M3 verdicts (NE-38e; plan §14 Track M3): pass / fail / no-coverage
 *      for each value M3 ships provisionally (`// MEASURE`), with the readings
 *      NE-38f settles it from: P13-clip and P13-line (cold time-to-ready, the
 *      deadline rows, a proposal that is printed and never applied),
 *      reuse-idle, rate-latch, resume-latency, route-back, seam-kinds,
 *      suspension-in-seam, narration-fallback and dup
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

import { NARRATION_FALLBACK_CAUSES } from "../../player/engine-vocabulary.js";

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
/* `key` is NE-38rs's 8-hex route key: "12345678" is a key, not a number. */
const STRING_KEYS = new Set(["bundleVersion", "build", "engineVersion", "token", "item", "nextId", "key"]);

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

/* `e#0012` since 2026-09-26 (log-gaps L22: the page's ring and the engine's
   both count from 1, so the engine's rows took an `e`); `#0012` before it.
   Both are read, so a paste from either side of the change still parses. */
const ENGINE_LINE = /^e?#(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\S+)\s+src=engine(?:\s+(.*))?$/;
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

/* AN ANDROID PASTE (card A-60, docs/plans/android-assessment.md §5.7). The Android
 * engine's own text ring (EngineLog.java) is one line per write,
 *   `<seq> <ISO-8601 UTC> <kind> <body>`,
 * as the emulator scenarios save it (`*-engine-rows.txt`), as the service's
 * `dumpsys activity service …ForayPlaybackService` prints it (`ForayEngine.row `
 * before each line), and as logcat carries it (`… I ForayEngine: `). A diag
 * row's body is its JSON with the sub-kind still named `kind` (the ring's gate,
 * DiagGate, writes it as `event` only on the DiagRow the page reads), so it is
 * read here the way the gate would store it: `deck {"kind":"attach",…}` is a
 * `deck` row whose event is `attach`. The other writes (`position`, `row`,
 * `restore`, `emit`, and `event`, the pending-events log) are not diag rows.
 * The page's Copy on Android is the iOS format and needs nothing of this. */
const ANDROID_LINE = /^(?:.*?\bForayEngine(?:\.row|:)\s+)?(\d+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(\S+)\s+(\{.*\})$/;
/** EngineLog.CAPACITY: the Android text ring's size, in LINES (every write, not only diag rows). */
export const ANDROID_TEXT_RING_CAPACITY = 400;

/** An Android text-ring line as a row, or null (not a diag row, or not JSON). */
function parseAndroidRow(m) {
  if (m[3] === "event") return null;
  let o;
  try { o = JSON.parse(m[4]); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const t = Date.parse(m[2]);
  if (!Number.isFinite(t)) return null;
  let event = typeof o.kind === "string" ? o.kind : null;
  const f = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "event" && event == null && typeof v === "string") event = v;
    if (["seq", "at", "mono", "kind", "event"].includes(k)) continue;
    f[k] = normalizeRaw(v);
  }
  return { seq: +m[1], t, epoch: true, android: true, kind: m[3], event, f };
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
  let androidRows = 0;
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
    if ((m = ANDROID_LINE.exec(line))) {
      const row = parseAndroidRow(m);
      if (row) { row.line = i + 1; engineRows.push(row); androidRows++; }
      return;
    }
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
  /* An Android text ring numbers every write, so the seqs between two diag rows
     are positions, restores and events, not lost rows: its accounting is the
     LINES before the first one kept (the 400-line ring's eviction, or a dump's
     tail), never the gaps. Evicted lines make every seam verdict `incomplete`. */
  if (androidRows && !ring) {
    const seqs = engineRows.filter((r) => r.android).map((r) => r.seq);
    const first = Math.min(...seqs);
    ring = {
      count: androidRows, capacity: ANDROID_TEXT_RING_CAPACITY, first, last: Math.max(...seqs),
      evicted: first > 1 ? first - 1 : 0, missing: 0, android: true,
    };
    notes.push(`android text ring: ${androidRows} diag rows of lines #${first}..#${ring.last}`
      + (ring.evicted ? `, ${ring.evicted} earlier lines not in the paste` : ""));
  }
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

// ─────────────────────────── the M3 verdicts ───────────────────────────
/*
 * NE-38e (plan §14 Track M3, re-planned 2026-09-29). M3 ships every value that
 * needs the founder's field rows as a PROVISIONAL value tagged `// MEASURE:
 * verdict=<id>`; each verdict below reads the rows that settle one, and NE-38f
 * settles the value from a drive's paste. The same conservative rule as the DV
 * table, said with its own word: a verdict is `pass` only when rows show the
 * thing, and a paste without those rows is `no-coverage`, never a pass (a Copy
 * from a build before the rows existed must not settle anything).
 *
 * THE ROW GRAMMAR each verdict reads (DiagGate writes a row's own `kind` field
 * as `event`, so `deck kind=ready` is a `deck` row whose event is `ready`):
 *   deck attach   token= cold=<why not reused> idleSec= class=clip|line   (AVDeck, #866, NE-38)
 *   deck reuse    token= idleSec= class=
 *   deck ready    token= reuse=y|n elapsedMs= marks={…} class=
 *   deck deadline token= afterMs= step= class= reuse= …the access fields
 *   deck access|stalled|failed token= … wwan=<media requests over cellular>
 *   nowplaying    … via= state= rate= elapsedSec= buffering= engineState= listenRate=
 *   deck time-control token= status=playing|waiting|paused reason= positionSec=  (#866)
 *   grace begin   reason= low=y|n bgRemainingMs=
 *   grace end|expired outcome= reason= heldMs=
 *   grace late    timer= lateMs= inSeam=y|n bgRemainingMs=                    (NE-46)
 *   route lost|back port= key= known= lostSec= pausedBy= decision=resume|no why=   (NE-38rs)
 *   seam          … from=clip|line to=clip|line prepare=hit|miss|none          (NE-45s)
 *   narration fallback reason= where= cause=<NARRATION_FALLBACK_CAUSES>        (NE-39n)
 *   remote <cmd>  dupCandidate=y|n …                                           (T-8, DV-6)
 * `prepare` (NE-45s): `hit` the standby held the next item and it was
 * promoted, `miss` a prepare was issued and the seam still loaded cold, `none`
 * nothing was prepared.
 */

export const M3_TITLES = Object.freeze({
  "P13-clip": "Clip load deadline (P-13) against cold time-to-ready",
  "P13-line": "Rendered-line load deadline (P-13) against cold time-to-ready",
  "reuse-idle": "Same-source reuse idle limit: the risk and the cost",
  "rate-latch": "Now Playing never shows rate 0 while the clock runs (#866)",
  "resume-latency": "Grace held until sound: remote-play and route-resume, cold vs reuse",
  "route-back": "A car route comes back: the decision and the car's own play",
  "seam-kinds": "Seams by kind (clip/line), prepare hit/miss/none",
  "suspension-in-seam": "No suspension inside a silent seam (NE-46)",
  "narration-fallback": "Rendered-line fallbacks, counted by cause",
  "dup": "One press, one delivery: the de-dup decision (DV-6, NE-39s)",
});

/** The values the verdicts judge, as M3 ships them. A test pins each one to
    its Swift constant, so a change there without one here is red:
    AVDeck.defaultLoadDeadlineSec and AVDeck.defaultLineLoadDeadlineSec. */
export const P13_CURRENT_SEC = Object.freeze({ clip: 20, line: 8 });
/** AVDeck.defaultReuseMaxIdleSec. */
export const REUSE_MAX_IDLE_SEC = 600;
/** A reuse is in trouble when a failed, deadline or stalled row follows it on its token within this long. */
export const REUSE_TROUBLE_WINDOW_MS = 30_000;
/** rate-latch: a rate-0 span while playing longer than this, with the clock advancing, is the #866 regression. */
export const RATE_LATCH_MAX_MS = 3_000;
/** rate-latch: the clock advanced when elapsedSec moved at least this far across the span. */
export const RATE_LATCH_MIN_ADVANCE_SEC = 1;
/** route-back: the car's own play counts as its answer to a route coming back only this soon after it. */
export const ROUTE_BACK_PRESS_WINDOW_MS = 30_000;
/** EngineCore.remoteDuplicateWindowMs: a same-command press inside it is recorded as dupCandidate=y. */
export const REMOTE_DUPLICATE_WINDOW_MS = 500;
/** dup: presses of one command closer than this are the ones a de-dup decision is about. Two presses
    further apart are two presses, so a drive without a closer pair says nothing either way. */
export const DUP_JUDGE_WINDOW_MS = 1_000;
/** dup: closer than this is faster than a hand presses a car's button twice, so it is one press
    delivered twice. Provisional, from the NE-39s evidence (the car's repeated plays are seconds
    apart); NE-38f revisits it with the first close pair a drive records. */
export const DUP_MACHINE_GAP_MS = 150;

const RESUME_GRACE_REASONS = ["remote-play", "route-resume"];
/** The grace spans that cover a silent seam in the background (GraceReason, NE-30s/NE-31s). */
const SEAM_GRACE_REASONS = new Set(["seam", "prepare-miss", "narration-handover"]);
const DECK_TROUBLE = new Set(["failed", "deadline", "stalled"]);

function m3Verdict(id, status, why, rows = []) {
  return { id, title: M3_TITLES[id], verdict: status, why, rows: cite(rows) };
}

/** n, p50, p95 and max of a list of numbers (anything else dropped). */
export function stats(values) {
  const s = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.length ? s[s.length - 1] : null };
}

const statsText = (s) => (s.n ? `n ${s.n}, p50 ${msText(s.p50)}, p95 ${msText(s.p95)}, max ${msText(s.max)}` : "n 0");

function countBy(list, keyOf) {
  const out = {};
  for (const x of list) {
    const k = keyOf(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
const countsText = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
const yn = (v) => (v == null ? "—" : v === true ? "y" : v === false ? "n" : String(v));

/** A deck token is unique within one boot: each row's `<boot>:<token>` key, or null. */
function tokenKeys(rows) {
  let boot = 0;
  return rows.map((r) => {
    if (r.kind === "build") boot++;
    return r.f.token == null ? null : `${boot}:${r.f.token}`;
  });
}

/**
 * P-13's proposal from cold time-to-ready: p95 x 2, rounded up to whole
 * seconds, and never below the observed max (also rounded up). Printed for
 * NE-38f, never applied. null with no loads.
 */
export function deadlineProposalSec(s) {
  if (!s || !s.n) return null;
  return Math.max(Math.ceil((s.p95 * 2) / 1000), Math.ceil(s.max / 1000));
}

/**
 * Cold loads per deadline class, split by network, and every deadline row.
 * A cold load is a token with a `ready` row that is not a reuse (reuse=n, or
 * an `attach` row on the token and no `reuse` one). A load with no `class=`
 * (a row from before NE-38) reads as `clip`: before Spark Phase 1 no rendered
 * line reached a deck, and the count of such loads is printed with the
 * numbers. The network is the first `wwan=` on the token (`deck access`,
 * `stalled`, `failed` or `deadline`): >0 is cellular, 0 Wi-Fi, none unknown.
 */
export function loadTimes(parsed) {
  const rows = parsed.engineRows;
  const keys = tokenKeys(rows);
  const loads = new Map();
  const deadlines = [];
  rows.forEach((r, i) => {
    if (r.kind !== "deck") return;
    if (r.event === "deadline") deadlines.push(r);
    const k = keys[i];
    if (k == null) return;
    const e = loads.get(k) ?? { key: k, attach: null, reuse: null, ready: null, wwan: null };
    if (r.event === "attach" && !e.attach) e.attach = r;
    else if (r.event === "reuse" && !e.reuse) e.reuse = r;
    else if (r.event === "ready" && !e.ready) e.ready = r;
    if (e.wwan == null && num(r.f.wwan) != null) e.wwan = r.f.wwan;
    loads.set(k, e);
  });
  const classOf = (e) => e.ready?.f.class ?? e.attach?.f.class ?? null;
  const cold = [...loads.values()].filter((e) => e.ready && e.ready.f.reuse !== true && !e.reuse
    && (e.attach || e.ready.f.reuse === false));
  const elapsed = (list) => stats(list.map((e) => num(e.ready.f.elapsedMs)));
  const out = {};
  for (const cls of ["clip", "line"]) {
    const mine = cold.filter((e) => (classOf(e) ?? "clip") === cls);
    const all = elapsed(mine);
    out[cls] = {
      cold: mine,
      classless: mine.filter((e) => classOf(e) == null).length,
      all,
      byNet: {
        cellular: elapsed(mine.filter((e) => e.wwan != null && e.wwan > 0)),
        wifi: elapsed(mine.filter((e) => e.wwan === 0)),
        unknown: elapsed(mine.filter((e) => e.wwan == null)),
      },
      deadlines: deadlines.filter((r) => (r.f.class ?? "clip") === cls),
      proposalSec: deadlineProposalSec(all),
      currentSec: P13_CURRENT_SEC[cls],
    };
  }
  return out;
}

function p13Verdict(cls, d) {
  const id = `P13-${cls}`;
  const cur = d.currentSec;
  const readies = d.cold.map((e) => e.ready);
  const summary = d.all.n
    ? `cold time-to-ready ${statsText(d.all)}${d.classless ? ` (${d.classless} without class=, read as clip)` : ""}; `
      + `proposal ${d.proposalSec} s (p95 x 2, never below max; current ${cur} s; printed, never applied)`
    : "no cold load of this class became ready";
  if (!d.all.n && !d.deadlines.length) {
    return m3Verdict(id, "no-coverage", `no \`deck ready\` after a cold \`deck attach\` with class=${cls}, and no \`deck deadline\` with class=${cls}`);
  }
  if (d.deadlines.length) {
    const list = d.deadlines.map((r) => `#${r.seq} step=${r.f.step ?? "?"} class=${r.f.class ?? "—"} afterMs=${msText(num(r.f.afterMs))}`);
    return m3Verdict(id, "fail", `${d.deadlines.length} loads hit the ${cur} s deadline (${list.join("; ")}); ${summary}`, [...d.deadlines, ...readies]);
  }
  if (d.proposalSec > cur) {
    return m3Verdict(id, "fail", `cold loads leave less than 2x headroom under ${cur} s: ${summary}`, readies);
  }
  return m3Verdict(id, "pass", summary, readies);
}

/** Every reuse with its idleSec and whether trouble followed on its token, and every cold=stale attach. */
export function reuseIdle(parsed) {
  const rows = parsed.engineRows;
  const keys = tokenKeys(rows);
  const reuses = [];
  const stale = [];
  rows.forEach((r, i) => {
    if (r.kind !== "deck") return;
    if (r.event === "attach" && r.f.cold === "stale") stale.push({ row: r, idleSec: num(r.f.idleSec) });
    if (r.event !== "reuse") return;
    let trouble = null;
    for (let j = i + 1; j < rows.length && rows[j].t - r.t <= REUSE_TROUBLE_WINDOW_MS; j++) {
      const x = rows[j];
      if (x.kind === "deck" && keys[j] === keys[i] && DECK_TROUBLE.has(x.event)) { trouble = x; break; }
    }
    reuses.push({ row: r, idleSec: num(r.f.idleSec), trouble });
  });
  return { reuses, stale };
}

const idleText = (v) => (v == null ? "—" : `${v}s`);

function reuseVerdict(ri) {
  const cost = ri.stale.length
    ? `${ri.stale.length} cold=stale loads (idleSec ${ri.stale.map((x) => idleText(x.idleSec)).join(", ")}) are what the ${REUSE_MAX_IDLE_SEC} s limit cost`
    : `no cold=stale load (the ${REUSE_MAX_IDLE_SEC} s limit cost nothing here)`;
  if (!ri.reuses.length) return m3Verdict("reuse-idle", "no-coverage", `no \`deck reuse\` row; ${cost}`, ri.stale.map((x) => x.row));
  const bad = ri.reuses.filter((x) => x.trouble);
  if (bad.length) {
    return m3Verdict("reuse-idle", "fail", `${bad.length} of ${ri.reuses.length} reuses were followed on their token within ${REUSE_TROUBLE_WINDOW_MS / 1000} s by trouble: `
      + bad.map((x) => `#${x.row.seq} idleSec=${idleText(x.idleSec)} then ${x.trouble.event} #${x.trouble.seq} after ${x.trouble.t - x.row.t}ms`).join("; ")
      + `; ${cost}`, bad.flatMap((x) => [x.row, x.trouble]));
  }
  const idles = ri.reuses.map((x) => x.idleSec).filter((v) => v != null);
  return m3Verdict("reuse-idle", "pass", `${ri.reuses.length} reuses${idles.length ? ` (idleSec max ${Math.max(...idles)}s)` : ""}, none followed by failed, deadline or stalled within ${REUSE_TROUBLE_WINDOW_MS / 1000} s; ${cost}`,
    [...ri.reuses.map((x) => x.row), ...ri.stale.map((x) => x.row)]);
}

/**
 * The rate-0 spans: a `nowplaying` row with engineState=playing and rate=0, up
 * to the next nowplaying row of the same boot (a relaunch ends a span, since
 * the restored row's elapsedSec says nothing about the rate before it). A span
 * LATCHED when it lasted longer than RATE_LATCH_MAX_MS and either
 *   - the clock ran: elapsedSec moved forward across it by at least
 *     RATE_LATCH_MIN_ADVANCE_SEC (with buffering=y, at least half the span's
 *     wall time too, since an honest stall stands still) and no further than
 *     the span could play (a longer jump is a seek, which says nothing about
 *     the rate); or
 *   - the deck said so: its latest `deck time-control` row read
 *     status=playing for longer than RATE_LATCH_MAX_MS inside the span.
 * buffering=y is judged too, because it is the #866 latch itself: the core's
 * `buffering` stuck on after a stall that landed behind the deck's `playing`,
 * so the lock screen sat at rate 0 while audio played. An honest stall is
 * buffering=y with the deck waiting and the clock still. A span with no later
 * nowplaying row (open, to the end of its boot) is judged by the deck rule only.
 */
export function rateLatch(parsed) {
  const rows = parsed.engineRows;
  const nps = [];
  const tcs = [];
  const bootEnd = [];
  let boot = 0;
  for (const r of rows) {
    if (r.kind === "build") {
      if (bootEnd[boot] === undefined) bootEnd[boot] = r.t;
      boot++;
    }
    if (r.kind === "nowplaying" && "engineState" in r.f) nps.push({ r, boot });
    if (isEvent(r, "deck", "time-control") && typeof r.f.status === "string") tcs.push({ r, boot });
  }
  const lastT = rows.length ? rows[rows.length - 1].t : null;
  /** The longest stretch of [from, to] in which the deck's latest time-control row (this boot) said playing. */
  const deckPlaying = (from, to, b) => {
    let status = null;
    let since = from;
    let best = { ms: 0, row: null };
    let row = null;
    for (const { r, boot: rb } of tcs) {
      if (rb !== b) continue;
      if (r.t <= from) { status = r.f.status; row = r; continue; }
      if (r.t >= to) break;
      if (status === "playing" && r.t - since > best.ms) best = { ms: r.t - since, row };
      status = r.f.status;
      row = r;
      since = r.t;
    }
    if (status === "playing" && to - since > best.ms) best = { ms: to - since, row };
    return best;
  };
  const spans = [];
  nps.forEach(({ r, boot: b }, k) => {
    if (r.f.engineState !== "playing" || num(r.f.rate) !== 0) return;
    const buffering = r.f.buffering === true;
    if (!buffering && r.f.buffering !== false) return;
    const after = nps[k + 1];
    const next = after && after.boot === b ? after.r : null;
    const endT = next ? next.t : (bootEnd[b] ?? lastT);
    const durationMs = endT - r.t;
    let advanceSec = null;
    let clockRan = false;
    if (next) {
      const a = num(r.f.elapsedSec);
      const z = num(next.f.elapsedSec);
      advanceSec = a != null && z != null ? Math.round((z - a) * 1000) / 1000 : null;
      const speed = Math.max(num(r.f.listenRate) ?? 1, 1);
      const floor = buffering ? Math.max(RATE_LATCH_MIN_ADVANCE_SEC, durationMs / 2000) : RATE_LATCH_MIN_ADVANCE_SEC;
      clockRan = advanceSec != null && advanceSec >= floor && advanceSec <= (durationMs / 1000) * speed * 1.1 + 2;
    }
    const deck = deckPlaying(r.t, endT, b);
    const deckRan = deck.ms > RATE_LATCH_MAX_MS;
    spans.push({
      row: r, next, buffering, durationMs, advanceSec, deckPlayingMs: deck.ms, deckRow: deckRan ? deck.row : null,
      latched: durationMs > RATE_LATCH_MAX_MS && (clockRan || deckRan), open: !next,
    });
  });
  const running = nps.map((x) => x.r).filter((r) => r.f.engineState === "playing" && r.f.buffering === false && (num(r.f.rate) ?? 0) > 0);
  return { rows: nps.map((x) => x.r), spans, running };
}

const spanText = (s) => `#${s.row.seq}→${s.next ? `#${s.next.seq}` : "end"} ${s.durationMs}ms buffering=${s.buffering ? "y" : "n"}`
  + `${s.advanceSec == null ? "" : `, elapsedSec +${s.advanceSec}`}${s.deckPlayingMs ? `, deck playing ${s.deckPlayingMs}ms${s.deckRow ? ` (#${s.deckRow.seq})` : ""}` : ""}`;

function rateLatchVerdict(rl) {
  if (!rl.rows.length) return m3Verdict("rate-latch", "no-coverage", "no `nowplaying` row carries engineState= (the #866 rows)");
  const latched = rl.spans.filter((s) => s.latched);
  if (latched.length) {
    return m3Verdict("rate-latch", "fail", `${latched.length} spans published rate=0 while playing for over ${RATE_LATCH_MAX_MS / 1000} s with the clock running or the deck playing: `
      + latched.map(spanText).join("; "),
    latched.flatMap((s) => [s.row, s.next, s.deckRow]));
  }
  if (!rl.running.length) {
    return m3Verdict("rate-latch", "no-coverage", `${rl.rows.length} nowplaying rows, none with engineState=playing buffering=n rate>0: the lock screen was never shown running`, rl.rows.slice(0, 1));
  }
  const open = rl.spans.filter((s) => s.open).length;
  return m3Verdict("rate-latch", "pass", `${rl.running.length} Now Playing writes running; ${rl.spans.length} rate-0 spans while playing, none over ${RATE_LATCH_MAX_MS / 1000} s with the clock running or the deck playing`
    + (open ? ` (${open} open at the end of a boot, judged by the deck rows only)` : ""), [rl.running[0], ...rl.spans.map((s) => s.row)]);
}

/**
 * The grace spans of a remote play and a route resume: begin to its end (or
 * expiry), and whether the load inside was `cold` (a deck attach) or `reuse`
 * (a deck reuse). A span with neither row is unclassified (a Copy from before
 * #866's deck rows) and is listed, not counted.
 */
export function resumeSpans(parsed) {
  const rows = parsed.engineRows;
  const spans = [];
  rows.forEach((r, i) => {
    if (!isEvent(r, "grace", "begin") || !RESUME_GRACE_REASONS.includes(r.f.reason)) return;
    let end = null;
    let load = null;
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j];
      if (x.kind === "build" || isEvent(x, "grace", "begin")) break;
      if (x.kind === "grace" && (x.event === "end" || x.event === "expired")) { end = x; break; }
      if (!load && x.kind === "deck" && (x.event === "attach" || x.event === "reuse")) load = x;
    }
    spans.push({
      begin: r, end, load,
      via: load ? (load.event === "reuse" ? "reuse" : "cold") : null,
      reason: r.f.reason,
      low: r.f.low === true,
      outcome: end ? (end.f.outcome ?? end.event) : null,
      heldMs: end ? num(end.f.heldMs) : null,
    });
  });
  return spans;
}

/** heldMs of the spans that ended playing, by reason and cold/reuse. */
export function resumeBuckets(spans) {
  const out = {};
  for (const reason of RESUME_GRACE_REASONS) {
    for (const via of ["cold", "reuse"]) {
      out[`${reason} ${via}`] = stats(spans.filter((s) => s.reason === reason && s.via === via && s.outcome === "playing").map((s) => s.heldMs));
    }
  }
  return out;
}

function resumeVerdict(spans) {
  const expired = spans.filter((s) => s.outcome === "expired");
  const lows = spans.filter((s) => s.low);
  const lowNote = lows.length ? `; low=y on ${lows.length} (${lows.map((s) => `#${s.begin.seq} → ${s.outcome ?? "open"}`).join(", ")})` : "";
  if (expired.length) {
    return m3Verdict("resume-latency", "fail", `${expired.length} remote-play/route-resume spans expired before sound (`
      + expired.map((s) => `#${s.begin.seq} ${s.reason} ${s.via ?? "unclassified"} heldMs=${msText(s.heldMs)}`).join("; ") + `)${lowNote}`,
    expired.flatMap((s) => [s.begin, s.end]));
  }
  const heard = spans.filter((s) => s.via && s.outcome === "playing");
  if (!heard.length) {
    const why = spans.length
      ? `${spans.length} remote-play/route-resume spans, none both classified by a \`deck attach\`/\`reuse\` row and ended playing (${spans.map((s) => `#${s.begin.seq} ${s.via ?? "unclassified"} → ${s.outcome ?? "open"}`).join(", ")})`
      : "no `grace begin` with reason remote-play or route-resume";
    return m3Verdict("resume-latency", "no-coverage", why + lowNote, spans.map((s) => s.begin));
  }
  const buckets = Object.entries(resumeBuckets(spans)).filter(([, s]) => s.n).map(([k, s]) => `${k} heldMs ${statsText(s)}`);
  return m3Verdict("resume-latency", "pass", `${heard.length} spans heard; ${buckets.join("; ")}${lowNote}`, heard.flatMap((s) => [s.begin, s.end]));
}

/** After row i, within windowMs: a row that measured sound (true), one that says it failed (false), or null. */
function soundAfter(rows, i, windowMs) {
  for (let j = i + 1; j < rows.length && rows[j].t - rows[i].t <= windowMs; j++) {
    if (audibleSignal(rows[j])) return { audible: true, row: rows[j] };
    const silent = silentSignal(rows[j]);
    if (silent) return { audible: false, row: rows[j], why: silent };
  }
  return { audible: null, row: null };
}

/** Every `route back` with its decision, and the ms until the next remote play (the car's own press). */
export function routeBacks(parsed) {
  const rows = parsed.engineRows;
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => isEvent(r, "route", "back")).map(({ r, i }) => {
    let press = null;
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j];
      if (x.kind === "build" || x.kind === "route") break;
      if (x.kind === "remote" && PLAY_CMDS.has(x.f.cmd)) { press = x; break; }
    }
    const decision = r.f.decision ?? null;
    return {
      row: r, decision, why: r.f.why ?? null, known: r.f.known ?? null, lostSec: num(r.f.lostSec),
      pausedBy: r.f.pausedBy ?? null, port: r.f.port ?? null,
      press, pressMs: press ? press.t - r.t : null,
      heard: decision === "resume" ? soundAfter(rows, i, RESUME_WINDOW_MS) : null,
    };
  });
}

const backText = (b) => `#${b.row.seq} ${b.port ?? "?"} decision=${b.decision ?? "—"}${b.why ? ` why=${b.why}` : ""} known=${yn(b.known)}`
  + ` lostSec=${b.lostSec ?? "—"} pausedBy=${b.pausedBy ?? "—"} → car play ${b.pressMs == null ? "none" : `${b.pressMs}ms`}`;

function routeBackVerdict(backs) {
  if (!backs.length) return m3Verdict("route-back", "no-coverage", "no `route back` row (NE-38rs)");
  const inWindow = (b) => b.pressMs != null && b.pressMs <= ROUTE_BACK_PRESS_WINDOW_MS;
  const wrong = backs.filter((b) => b.decision === "resume" && b.pausedBy !== "route");
  const silent = backs.filter((b) => b.decision === "resume" && b.pausedBy === "route" && b.heard?.audible === false);
  const missed = backs.filter((b) => b.decision === "no" && b.why === "bluetooth-off" && b.pausedBy === "route" && b.known === true && !inWindow(b));
  const problems = [
    wrong.length ? `${wrong.length} resumed a pause the route did not cause (Q5: ${wrong.map((b) => `#${b.row.seq} pausedBy=${b.pausedBy ?? "—"}`).join(", ")})` : null,
    silent.length ? `${silent.length} resumed silently (${silent.map((b) => `#${b.row.seq}: ${b.heard.why}`).join(", ")})` : null,
    missed.length ? `${missed.length} known Bluetooth routes came back after a route pause and the car sent no play within ${ROUTE_BACK_PRESS_WINDOW_MS / 1000} s, so the Bluetooth arm is needed (${missed.map((b) => `#${b.row.seq}`).join(", ")})` : null,
  ].filter(Boolean);
  const each = backs.map(backText).join("; ");
  if (problems.length) {
    return m3Verdict("route-back", "fail", `${problems.join("; ")}. Rows: ${each}`, [...wrong, ...silent, ...missed].flatMap((b) => [b.row, b.heard?.row, b.press]));
  }
  return m3Verdict("route-back", "pass", `${backs.length} routes came back, no misfire and no missed resume: ${each}`, backs.flatMap((b) => [b.row, b.press]));
}

const SEAM_KIND_ORDER = ["clip→clip", "clip→line", "line→clip"];

/** The packed seam rows that carry from=/to= (NE-45s), split by kind. */
export function seamKinds(parsed) {
  const seams = parsed.engineRows.filter((r) => r.kind === "seam" && typeof r.f.from === "string" && typeof r.f.to === "string");
  const groups = {};
  for (const r of seams) (groups[`${r.f.from}→${r.f.to}`] ??= []).push(r);
  const rank = (k) => (SEAM_KIND_ORDER.includes(k) ? SEAM_KIND_ORDER.indexOf(k) : SEAM_KIND_ORDER.length);
  const kinds = Object.keys(groups).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const table = kinds.map((kind) => {
    const list = groups[kind];
    return {
      kind, n: list.length, rows: list,
      gap: stats(list.map((r) => num(r.f.observedGapMs))),
      neverAudible: list.filter((r) => num(r.f.observedGapMs) == null),
      prepare: countBy(list, (r) => r.f.prepare ?? "—"),
    };
  });
  return { seams, table };
}

function seamKindsVerdict(sk, ring) {
  if (!sk.seams.length) return m3Verdict("seam-kinds", "no-coverage", "no `seam` row carries from=/to= (NE-45s)");
  const never = sk.seams.filter((r) => num(r.f.observedGapMs) == null);
  const missed = sk.seams.filter((r) => r.f.prepare === "miss");
  const unprepared = sk.seams.filter((r) => r.f.from === "line" && r.f.to === "clip" && r.f.prepare !== "hit" && r.f.prepare !== "miss");
  const table = sk.table.map((g) => `${g.kind} gap ${statsText(g.gap)}, prepare ${countsText(g.prepare)}`).join("; ");
  if (never.length || missed.length || unprepared.length) {
    return m3Verdict("seam-kinds", "fail", [
      never.length ? `${never.length} never audible` : null,
      missed.length ? `${missed.length} prepare=miss (prepared, and still loaded cold)` : null,
      unprepared.length ? `${unprepared.length} line→clip seams not prepared (the M2 leftover NE-45 fixes)` : null,
    ].filter(Boolean).join("; ") + `. ${table}`, [...never, ...missed, ...unprepared]);
  }
  if (!ring.complete) {
    return m3Verdict("seam-kinds", "incomplete", `the ring lost rows (${ring.evicted} older rows evicted, ${ring.missing} seq gaps), so an early seam may be gone; ${table}`, sk.seams.slice(0, 1));
  }
  return m3Verdict("seam-kinds", "pass", `${sk.seams.length} seams, none never audible, no prepare miss, every line→clip prepared: ${table}`, [sk.seams[0], sk.seams[sk.seams.length - 1]]);
}

/**
 * NE-46's detector rows, and whether this paste could have shown one: the
 * build must carry the detector (a `grace late` row, or a `deck` row with
 * `class=`, which NE-38 ships in the same M3 build) and a silent seam must
 * have been held in the background (a `grace begin` of a seam reason with a
 * bgRemainingMs).
 */
export function seamSuspensions(parsed) {
  const rows = parsed.engineRows;
  const late = rows.filter((r) => isEvent(r, "grace", "late"));
  return {
    late,
    inSeam: late.filter((r) => r.f.inSeam === true),
    detector: late.length > 0 || rows.some((r) => r.kind === "deck" && typeof r.f.class === "string"),
    backgroundSeams: rows.filter((r) => isEvent(r, "grace", "begin") && SEAM_GRACE_REASONS.has(r.f.reason) && num(r.f.bgRemainingMs) != null),
  };
}

const lateText = (r) => `#${r.seq} timer=${r.f.timer ?? "?"} lateMs=${msText(num(r.f.lateMs))} inSeam=${yn(r.f.inSeam)} bgRemainingMs=${msText(num(r.f.bgRemainingMs))}`;

function suspensionVerdict(s) {
  if (s.inSeam.length) {
    return m3Verdict("suspension-in-seam", "fail", `${s.inSeam.length} timers fired late inside a silent seam despite grace (${s.inSeam.map(lateText).join("; ")}): NE-46's rule for turning the silence node on is met`, s.inSeam);
  }
  if (!s.detector) return m3Verdict("suspension-in-seam", "no-coverage", "no row shows the build carries NE-46's detector (no `grace late`, no `deck` row with class=)");
  if (!s.backgroundSeams.length) return m3Verdict("suspension-in-seam", "no-coverage", "no silent seam held in the background (`grace begin` reason=seam|prepare-miss|narration-handover with bgRemainingMs)");
  return m3Verdict("suspension-in-seam", "pass", `${s.backgroundSeams.length} background seams under grace, no \`grace late inSeam=y\``
    + (s.late.length ? ` (${s.late.length} late timers outside a seam)` : ""), [s.backgroundSeams[0], ...s.late]);
}

/** The `narration fallback` rows by cause, and the rendered lines the deck loaded. */
export function narrationFallbacks(parsed) {
  const rows = parsed.engineRows;
  const fallbacks = rows.filter((r) => isEvent(r, "narration", "fallback"));
  const withCause = fallbacks.filter((r) => r.f.cause != null);
  return {
    fallbacks,
    withCause,
    byCause: countBy(withCause, (r) => String(r.f.cause)),
    unmapped: withCause.filter((r) => r.f.cause === "other" || !NARRATION_FALLBACK_CAUSES.includes(r.f.cause)),
    lineLoads: rows.filter((r) => r.kind === "deck" && r.f.class === "line" && (r.event === "attach" || r.event === "reuse")),
  };
}

function fallbackVerdict(nf) {
  const old = nf.fallbacks.length - nf.withCause.length;
  const oldNote = old ? `; ${old} fallbacks without cause= (before NE-39n) not counted` : "";
  if (nf.unmapped.length) {
    return m3Verdict("narration-fallback", "fail", `${nf.unmapped.length} fallbacks with an unmapped cause (${nf.unmapped.map((r) => `#${r.seq} cause=${r.f.cause}`).join(", ")}): a mapping for NE-39n to extend from the deck row beside it; by cause: ${countsText(nf.byCause)}${oldNote}`, nf.unmapped);
  }
  if (!nf.withCause.length && !nf.lineLoads.length) {
    return m3Verdict("narration-fallback", "no-coverage", `no rendered line reached a deck (\`deck attach|reuse class=line\`) and no \`narration fallback\` with cause=${oldNote}`, nf.fallbacks);
  }
  return m3Verdict("narration-fallback", "pass", `${nf.lineLoads.length} rendered-line loads, ${nf.withCause.length} fallbacks, every cause mapped; by cause: ${countsText(nf.byCause)}${oldNote}`,
    [...nf.withCause, ...nf.lineLoads.slice(0, 1)]);
}

/** The press rows (the ones that carry dupCandidate) and the ms between presses of one command. */
export function pressGaps(parsed) {
  const presses = [];
  const pairs = [];
  const last = new Map();
  for (const r of parsed.engineRows) {
    if (r.kind === "build") last.clear();
    if (r.kind !== "remote" || !("dupCandidate" in r.f)) continue;
    presses.push(r);
    const cmd = r.f.cmd ?? "?";
    const prev = last.get(cmd);
    if (prev) pairs.push({ cmd, prev, row: r, gapMs: r.t - prev.t });
    last.set(cmd, r);
  }
  const gapsByCmd = {};
  for (const p of pairs) (gapsByCmd[p.cmd] ??= []).push(p.gapMs);
  return {
    presses,
    pairs,
    dups: presses.filter((r) => r.f.dupCandidate === true),
    gaps: Object.fromEntries(Object.entries(gapsByCmd).map(([cmd, g]) => [cmd, { min: Math.min(...g), ...stats(g) }])),
  };
}

function dupVerdict(pg) {
  if (!pg.presses.length) return m3Verdict("dup", "no-coverage", "no remote press row (dupCandidate=)");
  const gaps = Object.entries(pg.gaps).map(([cmd, g]) => `${cmd} min ${msText(g.min)} over ${g.n}`).join(", ") || "no command pressed twice";
  const head = `${pg.presses.length} presses, dupCandidate=y ${pg.dups.length}; between presses of one command: ${gaps}`;
  const machine = pg.pairs.filter((p) => p.gapMs < DUP_MACHINE_GAP_MS);
  if (machine.length) {
    return m3Verdict("dup", "fail", `${machine.length} presses of one command under ${DUP_MACHINE_GAP_MS} ms apart (${machine.map((p) => `#${p.prev.seq}→#${p.row.seq} ${p.cmd} ${p.gapMs}ms`).join(", ")}): one press delivered twice, which record-only lets through (NE-39s: the drop guard); ${head}`,
      machine.flatMap((p) => [p.prev, p.row]));
  }
  const close = pg.pairs.filter((p) => p.gapMs <= DUP_JUDGE_WINDOW_MS);
  if (!close.length) {
    return m3Verdict("dup", "no-coverage", `no two presses of one command within ${DUP_JUDGE_WINDOW_MS} ms, so nothing tells a double delivery from a second press; ${head}`, pg.presses.slice(0, 1));
  }
  return m3Verdict("dup", "pass", `${close.length} pairs within ${DUP_JUDGE_WINDOW_MS} ms, the closest ${Math.min(...close.map((p) => p.gapMs))}ms: a hand's pace, not a double delivery, so record-only holds; ${head}`,
    close.flatMap((p) => [p.prev, p.row]));
}

/** Everything the M3 verdicts read, and the verdicts, in M3_TITLES order. */
export function m3Readings(parsed) {
  const ring = ringCompleteness(parsed);
  const loads = loadTimes(parsed);
  const reuse = reuseIdle(parsed);
  const rate = rateLatch(parsed);
  const resume = resumeSpans(parsed);
  const backs = routeBacks(parsed);
  const seams = seamKinds(parsed);
  const late = seamSuspensions(parsed);
  const narration = narrationFallbacks(parsed);
  const dup = pressGaps(parsed);
  const list = [
    p13Verdict("clip", loads.clip),
    p13Verdict("line", loads.line),
    reuseVerdict(reuse),
    rateLatchVerdict(rate),
    resumeVerdict(resume),
    routeBackVerdict(backs),
    seamKindsVerdict(seams, ring),
    suspensionVerdict(late),
    fallbackVerdict(narration),
    dupVerdict(dup),
  ];
  return { verdicts: list, loads, reuse, rate, resume, backs, seams, late, narration, dup };
}

/** The M3 verdict table alone. */
export function m3Verdicts(parsed) {
  return m3Readings(parsed).verdicts;
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
    m3: m3Readings(parsed),
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
  if (a.header.header) L.push(`\`engine=${a.header.header.engine}${a.header.header.version ? ` v${a.header.header.version}` : ""} reason=${a.header.header.reason ?? "?"} strikes=${a.header.header.strikes ?? "?"} hold=${a.header.header.hold ?? "?"}${a.header.header.routeSharing ? ` routeSharing=${a.header.header.routeSharing}` : ""} build=${a.header.header.build ?? "?"} web=${a.header.header.web ?? "?"}\``);
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
  L.push("");
  m3Section(a.m3, L);
  return L.join("\n") + "\n";
}

const shownRows = (rows) => (rows.length > 8 ? [...rows.slice(0, 8), `+${rows.length - 8}`] : rows);

/** The M3 verdict table, and the readings NE-38f settles the values from. */
function m3Section(m, L) {
  L.push("### M3 verdicts (NE-38e)");
  L.push("| Verdict | Result | Why | Rows |");
  L.push("|---|---|---|---|");
  for (const v of m.verdicts) {
    L.push(`| ${v.id} ${v.title} | ${v.verdict === "fail" ? "**fail**" : v.verdict} | ${v.why.replace(/\|/g, "\\|")} | ${shownRows(v.rows).join(" ") || "—"} |`);
  }
  L.push("");

  L.push("### M3 readings");
  L.push("P-13 cold time-to-ready (`deck ready elapsedMs` after `deck attach cold=`), by class and network:");
  L.push("");
  L.push("| Class | All | Cellular (wwan>0) | Wi-Fi | Network unknown | Deadlines | Proposal (never applied) |");
  L.push("|---|---|---|---|---|---|---|");
  for (const cls of ["clip", "line"]) {
    const d = m.loads[cls];
    L.push(`| ${cls} | ${statsText(d.all)} | ${statsText(d.byNet.cellular)} | ${statsText(d.byNet.wifi)} | ${statsText(d.byNet.unknown)} | ${d.deadlines.length} | `
      + `${d.proposalSec == null ? "—" : `${d.proposalSec} s`} (current ${d.currentSec} s) |`);
  }
  const deadlines = [...m.loads.clip.deadlines, ...m.loads.line.deadlines].sort((x, y) => x.seq - y.seq);
  for (const r of deadlines) {
    L.push(`- deadline #${r.seq} step=${r.f.step ?? "?"} class=${r.f.class ?? "—"} afterMs=${msText(num(r.f.afterMs))} reuse=${yn(r.f.reuse)} wwan=${r.f.wwan ?? "—"}`);
  }
  L.push("");

  L.push(`Reuse (limit ${REUSE_MAX_IDLE_SEC} s): ${m.reuse.reuses.length} reuses, ${m.reuse.stale.length} cold=stale loads`);
  for (const x of m.reuse.reuses) {
    L.push(`- reuse #${x.row.seq} idleSec=${idleText(x.idleSec)} class=${x.row.f.class ?? "—"}`
      + (x.trouble ? ` → **${x.trouble.event}** #${x.trouble.seq} after ${x.trouble.t - x.row.t}ms` : ` → nothing within ${REUSE_TROUBLE_WINDOW_MS / 1000} s`));
  }
  for (const x of m.reuse.stale) L.push(`- cold=stale #${x.row.seq} idleSec=${idleText(x.idleSec)}`);
  L.push("");

  L.push("Grace held until sound (heldMs of the spans that ended playing):");
  for (const [k, st] of Object.entries(resumeBuckets(m.resume))) L.push(`- ${k}: ${statsText(st)}`);
  for (const s of m.resume.filter((x) => x.outcome !== "playing" || !x.via || x.low)) {
    L.push(`- #${s.begin.seq} ${s.reason} ${s.via ?? "unclassified"} low=${s.low ? "y" : "n"} → ${s.outcome ?? "open"} heldMs=${msText(s.heldMs)}`);
  }
  L.push("");

  L.push(`Now Playing rate-0 spans while playing: ${m.rate.spans.length} (buffering=y ${m.rate.spans.filter((x) => x.buffering).length})`);
  for (const s of m.rate.spans) L.push(`- ${spanText(s)}${s.latched ? " **LATCHED**" : ""}`);
  L.push("");

  L.push(`Route back: ${m.backs.length}`);
  for (const b of m.backs) L.push(`- ${backText(b)}`);
  L.push("");

  L.push("Seams by kind:");
  if (!m.seams.table.length) L.push("- no seam row carries from=/to=");
  for (const g of m.seams.table) {
    L.push(`- ${g.kind}: gap ${statsText(g.gap)}; prepare ${countsText(g.prepare)}${g.neverAudible.length ? `; **${g.neverAudible.length} never audible**` : ""}`);
  }
  L.push("");

  L.push(`Late timers (NE-46): ${m.late.late.length}, inside a seam ${m.late.inSeam.length}; background seams under grace ${m.late.backgroundSeams.length}`);
  for (const r of m.late.late) L.push(`- ${lateText(r)}`);
  L.push("");

  L.push(`Narration fallback by cause: ${countsText(m.narration.byCause)}; rendered-line loads ${m.narration.lineLoads.length}`);
  L.push("");

  L.push(`Presses: ${m.dup.presses.length}, dupCandidate=y ${m.dup.dups.length}`);
  for (const [cmd, g] of Object.entries(m.dup.gaps)) L.push(`- ${cmd}: ms between presses min ${msText(g.min)}, p50 ${msText(g.p50)}, over ${g.n} pairs`);
}

/** Did this paste fail anything `--strict` should stop on? */
export function strictFailed(a) {
  return !a.header.ok || a.verdicts.some((v) => v.verdict === "fail") || a.m3.verdicts.some((v) => v.verdict === "fail");
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
    m3: {
      verdicts: a.m3.verdicts,
      loads: Object.fromEntries(Object.entries(a.m3.loads).map(([cls, d]) => [cls, {
        all: d.all, byNet: d.byNet, classless: d.classless, deadlines: cite(d.deadlines),
        proposalSec: d.proposalSec, currentSec: d.currentSec,
      }])),
      resume: resumeBuckets(a.m3.resume),
      seams: a.m3.seams.table.map((g) => ({ kind: g.kind, n: g.n, gap: g.gap, prepare: g.prepare, neverAudible: cite(g.neverAudible) })),
      narrationByCause: a.m3.narration.byCause,
      pressGaps: a.m3.dup.gaps,
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
