#!/usr/bin/env node
/* Offline anchor-resolution report per Foray (GV-78, docs/roadmap/generation-v2.md;
   original id W6-14). Two jobs, both offline, both producing the per-Foray
   MQ rows:

   1. SIMULATED ANCHOR RESOLUTION. The phone cannot resolve anchors yet
      (player/seek-policy.js `locateStep()` is `{ implemented: false }`), so
      this measures now whether a Foray's clips WOULD resolve after an ad
      shift. Per segment, over K seeded scenarios:
        a. insert an ad of L in AD_LENGTHS_SEC (30, 60, 120 s, cycled by
           scenario) at a seeded time before the segment's start_sec: every cue
           that starts at or after the insertion moves L seconds later;
        b. apply seeded word noise (each word dropped or substituted with
           probability WORD_NOISE_P = 0.05), or, with `--asr-cues`, use the
           farm's real ASR cues of the same episode instead of the noise;
        c. take only the cues inside the fetch window of
           player/locate-window.js `locateWindow` (pure, imported) — what a
           device would transcribe;
        d. locate the start anchor with tools/transcribe/anchor-match.mjs
           `anchorMatch` in `search_start`, and the end anchor across the
           window (its match must END inside `search_end`); both must land
           within RESOLVE_TOLERANCE_SEC (1 s) of the shifted truth (authored
           time + L), and `locatedBounds` must accept the pair.
      A scenario resolves only if BOTH anchors resolve: a clip needs both
      bounds. resolveRate = resolved scenarios / scenarios, over every segment
      whose transcript is on this machine (`unmeasured[]` lists the rest and
      they are left out of the rate; an anchor too short to match is counted,
      as all-failed, in `unresolvable[]`).

      Uniqueness: an anchor whose canonical form (merge-segments.mjs
      `canonical`) occurs more than once, verbatim, in the episode is counted
      in `nonUnique`. A repeat that an ad shift pushes into the search window
      ahead of the truth wins the match (anchorMatch breaks ties to the
      earliest token) and that scenario is a failure.

      Output per Foray: `{forayId, segments, resolveRate, nonUnique,
      unresolvable[], ...}` and one JSONL row
      `{metric:'anchor_resolve_simulated', forayId, rate, target:0.98}`.

      THE ROW IS NAMED 'simulated' AND IS NOT "ANCHORS RESOLVED AT PLAY". The
      word noise is a proxy for the device's recogniser, not the locate step
      itself; never present this rate as the phone's.

   2. THE FOUNDER'S PASTED PHONE RECORD (`--diag <record.txt>`). GV-63
      (W6-15) writes per-Foray clip tally lines into the copied diagnostic
      record (player/diagnostic-log.js `clipTallyLines`):
        `clips <forayId>: N static, N exact, N padded, N skipped, N dropped, N load-failed; X% at authored time`
      Each becomes `{metric:'clip_authored_time', forayId, static, exact,
      padded, skipped, dropped, loadFailed, authoredTimeRate}`, the rate
      recomputed from the counts as a fraction (static + exact + padded over
      all clips). A Foray whose tally line was not pasted is rebuilt from its
      `clip` rows (`#<seq> <clock> clip <kind>  item=<forayId>#<n>`), the
      newest row per item winning, as the tally does. The engine lane's line
      (`clips engine: …`) becomes a row with `lane:'engine'` and forayId null.

   WHAT IT NEVER DOES. No network: it reads local files only (the candidate,
   the normalized transcripts, the committed data/ indexes, the paste). It
   writes no transcript text: reports carry ids, counts, seconds and reasons,
   never a cue or an anchor. It never writes data/. The record is local-only
   by design (#264); nothing here transmits it.

   TRANSCRIPTS. `--transcripts <dir>` is the normalized layout
   FileTranscriptCueProvider (backend/src/generation/transcriptArchiveLookup.ts)
   reads: `<dir>/<show_id>[-<hash>]/<safeKey(guid)>.json`, each
   `{ show_id, guid, cues: [{ start_sec, end_sec, text }] }`. A segment's
   episode is found from its item id: the candidate's `segmentSources` or
   data/segment-sources.json give the episode guid, and the transcript digests
   give the show. `--asr-cues <dir>` is the same layout holding farm ASR cues.

   USAGE
     node tools/transcribe/anchor-resolve-report.mjs <candidate.json>... \
       --transcripts data-local/transcripts/normalized \
       [--asr-cues <dir>] [--scenarios 30] [--seed 1] \
       [--delta-max-sec 120] [--spread-sec 5] [--root .] \
       [--diag <pasted record.txt>] [--out rows.jsonl] [--report report.json]
   JSONL rows go to stdout unless --out is given; --report writes the full
   per-Foray reports. Nothing runs this automatically. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isEntryScript } from "../ci/entry.mjs";

import { locateWindow, locatedBounds } from "../../player/locate-window.js";
import { MIN_ANCHOR_WORDS, buildTranscriptIndex, canonical, findAnchorOccurrences } from "../segments/merge-segments.mjs";
import { anchorMatch } from "./anchor-match.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The MQ row's target (GV-78). */
export const RESOLVE_TARGET = 0.98;
/** Simulated ad lengths, cycled by scenario index. */
export const AD_LENGTHS_SEC = Object.freeze([30, 60, 120]);
/** Per-word probability of a drop or a substitution. */
export const WORD_NOISE_P = 0.05;
/** A located anchor resolves only this close to the shifted truth. */
export const RESOLVE_TOLERANCE_SEC = 1;
/** Defaults: K scenarios per segment, and the locate window. delta_max covers
    the longest simulated ad; the margin (= spread) absorbs cue granularity. */
export const DEFAULTS = Object.freeze({ scenarios: 30, seed: 1, delta_max_sec: 120, spread_sec: 5 });

/** Substitutes for a misheard word: fillers a recogniser emits, none of them a
    word an anchor is likely to need. */
const SUBSTITUTES = Object.freeze(["uh", "um", "mm", "er", "hmm"]);

/* ------------------------------------------------------------------ seeded rng */

/** FNV-1a over a string: a 32-bit seed per (seed, Foray, segment), so a
    segment's scenarios do not depend on which segments came before it. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic generator in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ inputs */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One segment in the report's own shape, from a pool row (snake_case) or a
    minted `NewSegment` (camelCase). */
export function normalizeSegment(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: str(raw.id),
    itemId: str(raw.item_id ?? raw.itemId),
    start_sec: num(raw.start_sec ?? raw.startSec),
    end_sec: num(raw.end_sec ?? raw.endSec),
    start_anchor: str(raw.start_anchor ?? raw.startAnchor),
    end_anchor: str(raw.end_anchor ?? raw.endAnchor),
  };
}

/** The pool rows of a segments.json-shaped document (an array or `{segments}`). */
function rowsOf(doc, key) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc[key])) return doc[key];
  return [];
}

/**
 * The Foray id and its segments, from a candidate JSON: the minted segments
 * (`newSegments` or `segments`), plus every segment item's `segment_id` looked
 * up in `pool` when the candidate does not carry it. Items name the Foray's
 * clips in order; with no items, every carried segment is the Foray's.
 */
export function candidateSegments(candidate, { pool = [], fallbackId = null } = {}) {
  const forayId = str(candidate?.id) ?? str(candidate?.forayId) ?? fallbackId;
  const list = (v) => (Array.isArray(v) ? v : []);
  const carried = [...list(candidate?.newSegments), ...list(candidate?.segments)]
    .map(normalizeSegment)
    .filter((s) => s && s.id);
  const byId = new Map(carried.map((s) => [s.id, s]));
  const items = Array.isArray(candidate?.items) ? candidate.items : null;
  if (!items) return { forayId, segments: [...byId.values()], missing: [] };
  const poolById = new Map(pool.map(normalizeSegment).filter((s) => s && s.id).map((s) => [s.id, s]));
  const segments = [];
  const missing = [];
  const seen = new Set();
  for (const it of items) {
    if (it?.type !== "segment") continue;
    const id = str(it.segment_id ?? it.segmentId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const seg = byId.get(id) ?? poolById.get(id);
    if (seg) segments.push(seg);
    else missing.push(id);
  }
  return { forayId, segments, missing };
}

/** item id -> episode guid, from source rows (`segmentSources` arrays, the
    `[id, source]` pairs a run report holds, or data/segment-sources.json). */
export function guidByItem(...sourceLists) {
  const out = new Map();
  for (const list of sourceLists) {
    for (const entry of Array.isArray(list) ? list : []) {
      const row = Array.isArray(entry) ? entry[1] : entry;
      const id = str(Array.isArray(entry) ? entry[0] : row?.id) ?? str(row?.id);
      const guid = str(row?.episode_guid ?? row?.guid);
      if (id && guid && !out.has(id)) out.set(id, guid);
    }
  }
  return out;
}

/** guid -> show_id, from transcript digest rows. */
export function showByGuid(...digestLists) {
  const out = new Map();
  for (const list of digestLists) {
    for (const row of Array.isArray(list) ? list : []) {
      const guid = str(row?.guid);
      const show = str(row?.show_id);
      if (guid && show && !out.has(guid)) out.set(guid, show);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ transcripts */

/** The on-disk key for an episode body. Byte-identical to
    tools/segments/fetch-transcripts.mjs `safeKey` (pinned by the test);
    mirrored rather than imported because that module carries the fetcher. */
export function safeKey(guid) {
  const slug = String(guid || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha1").update(String(guid || "")).digest("hex").slice(0, 10);
  return slug ? `${slug}-${hash}` : hash;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cuesOf(doc) {
  const cues = Array.isArray(doc?.cues) ? doc.cues : [];
  return cues.filter((c) => c && typeof c.text === "string" && Number.isFinite(c.start_sec));
}

/**
 * The cues of one episode under a normalized root, or null. The show
 * directory is `<show_id>` or `<show_id>-<hash>`; the body is
 * `<safeKey(guid)>.json`, else the legacy `<slug>.json`, else the one body in
 * that directory whose own `guid` field is this guid (FileTranscriptCueProvider's
 * order). With no show id, only the exact names are tried, in every directory.
 */
export function readEpisodeCues(root, { showId = null, guid }) {
  if (!root || !guid || !fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!showId || d.name === showId || d.name.startsWith(`${showId}-`)))
    .map((d) => path.join(root, d.name));
  const key = safeKey(guid);
  const slug = String(guid).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const names = [`${key}.json`, ...(slug ? [`${slug}.json`] : [])];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return cuesOf(readJson(file));
    }
  }
  if (!showId) return null;
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      try {
        const doc = readJson(path.join(dir, name));
        if (doc?.guid === guid) return cuesOf(doc);
      } catch {
        /* an unreadable neighbour is not this episode */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ simulation */

/** Cues with every cue starting at or after `atSec` moved `bySec` later. */
export function shiftCues(cues, atSec, bySec) {
  return cues.map((c) =>
    c.start_sec >= atSec ? { ...c, start_sec: c.start_sec + bySec, end_sec: (num(c.end_sec) ?? c.start_sec) + bySec } : c,
  );
}

/** Seeded word noise: each word dropped or substituted with probability `p`. */
export function noisyCues(cues, rand, p = WORD_NOISE_P) {
  return cues.map((c) => {
    const words = String(c.text).split(/\s+/).filter(Boolean);
    const kept = [];
    for (const w of words) {
      if (rand() < p) {
        if (rand() < 0.5) continue;
        kept.push(SUBSTITUTES[Math.floor(rand() * SUBSTITUTES.length)]);
      } else kept.push(w);
    }
    return { ...c, text: kept.join(" ") };
  });
}

/**
 * K seeded scenarios for one segment. `cues` is the clean episode on the
 * authored timeline; `asrCues`, when given, replaces the word noise
 * (`noise_p`, default WORD_NOISE_P; 0 only in tests). Returns
 * per-scenario details (no text) and the count resolved.
 */
export function simulateSegment(segment, cues, opts = {}) {
  const {
    scenarios = DEFAULTS.scenarios,
    seed = DEFAULTS.seed,
    forayId = "",
    asrCues = null,
    delta_max_sec = DEFAULTS.delta_max_sec,
    spread_sec = DEFAULTS.spread_sec,
    noise_p = WORD_NOISE_P,
  } = opts;
  const { start_sec, end_sec, start_anchor, end_anchor } = segment;
  const window = locateWindow({ start_sec, end_sec, delta_max_sec, spread_sec });
  const rand = seededRandom(hash32(`${seed}\u0000${forayId}\u0000${segment.id}`));
  const heardBase = asrCues ?? cues;
  const details = [];
  let resolved = 0;
  for (let k = 0; k < scenarios; k += 1) {
    const L = AD_LENGTHS_SEC[k % AD_LENGTHS_SEC.length];
    const at = rand() * start_sec;
    const shifted = shiftCues(heardBase, at, L);
    const inWindow = shifted.filter((c) => c.start_sec >= window.fetch_start_sec && c.start_sec <= window.fetch_end_sec);
    const heard = asrCues ? inWindow : noisyCues(inWindow, rand, noise_p);
    const s = anchorMatch(heard, start_anchor, window.search_start);
    const e = anchorMatch(heard, end_anchor, { from_sec: window.search_start.from_sec, to_sec: window.search_end.to_sec });
    const startOk = s.hit && Math.abs(s.start_sec - (start_sec + L)) <= RESOLVE_TOLERANCE_SEC;
    const endOk = e.hit && Math.abs(e.end_sec - (end_sec + L)) <= RESOLVE_TOLERANCE_SEC;
    let ok = startOk && endOk;
    if (ok) {
      const b = locatedBounds({ start_hit_sec: s.start_sec, end_hit_sec: e.end_sec, authored: { start_sec, end_sec }, window });
      ok = !b.refused;
    }
    if (ok) resolved += 1;
    details.push({
      k,
      adSec: L,
      insertAtSec: Math.round(at * 1000) / 1000,
      startHitSec: s.hit ? s.start_sec : null,
      endHitSec: e.hit ? e.end_sec : null,
      resolved: ok,
    });
  }
  return { scenarios, resolved, details };
}

/** Verbatim occurrences of each anchor in the clean episode. */
export function anchorOccurrences(segment, cues) {
  const index = buildTranscriptIndex(cues);
  return {
    start: findAnchorOccurrences(index, segment.start_anchor ?? "").occurrences.length,
    end: findAnchorOccurrences(index, segment.end_anchor ?? "").occurrences.length,
  };
}

const anchorTooShort = (text) => canonical(text ?? "").split(" ").filter(Boolean).length < MIN_ANCHOR_WORDS;

/**
 * The per-Foray report. `cuesFor(segment)` returns the clean cues of the
 * segment's episode or null; `asrCuesFor(segment)` the ASR cues or null.
 */
export function forayReport({ forayId, segments, missing = [] }, { cuesFor, asrCuesFor = () => null, ...opts } = {}) {
  const unresolvable = [];
  const unmeasured = missing.map((segmentId) => ({ segmentId, reason: "segment not found" }));
  const nonUniqueAnchors = [];
  let scenarios = 0;
  let resolved = 0;
  let asrSegments = 0;
  for (const seg of segments) {
    if (seg.start_sec === null || seg.end_sec === null || !(seg.end_sec > seg.start_sec)) {
      unmeasured.push({ segmentId: seg.id, reason: "no usable start_sec/end_sec" });
      continue;
    }
    const cues = cuesFor(seg);
    if (!cues || cues.length === 0) {
      unmeasured.push({ segmentId: seg.id, reason: "no transcript on this machine" });
      continue;
    }
    const occ = anchorOccurrences(seg, cues);
    for (const [which, n] of Object.entries(occ)) if (n > 1) nonUniqueAnchors.push({ segmentId: seg.id, which, occurrences: n });
    const k = opts.scenarios ?? DEFAULTS.scenarios;
    if (!seg.start_anchor || !seg.end_anchor || anchorTooShort(seg.start_anchor) || anchorTooShort(seg.end_anchor)) {
      scenarios += k;
      unresolvable.push({ segmentId: seg.id, reason: "anchor missing or too short", resolved: 0, scenarios: k });
      continue;
    }
    const asr = asrCuesFor(seg);
    if (asr && asr.length) asrSegments += 1;
    const sim = simulateSegment(seg, cues, { ...opts, forayId: forayId ?? "", asrCues: asr && asr.length ? asr : null });
    scenarios += sim.scenarios;
    resolved += sim.resolved;
    if (sim.resolved < sim.scenarios) {
      unresolvable.push({ segmentId: seg.id, reason: "scenarios failed", resolved: sim.resolved, scenarios: sim.scenarios });
    }
  }
  return {
    forayId,
    segments: segments.length + missing.length,
    measuredSegments: segments.length - unmeasured.filter((u) => u.reason !== "segment not found").length,
    asrSegments,
    scenarios,
    resolved,
    resolveRate: scenarios ? resolved / scenarios : null,
    nonUnique: nonUniqueAnchors.length,
    nonUniqueAnchors,
    unresolvable,
    unmeasured,
  };
}

/** The MQ row for one report. */
export function resolveRow(report, { seed = DEFAULTS.seed } = {}) {
  return {
    metric: "anchor_resolve_simulated",
    forayId: report.forayId,
    rate: report.resolveRate,
    target: RESOLVE_TARGET,
    segments: report.segments,
    scenarios: report.scenarios,
    seed,
  };
}

/* ------------------------------------------------------------------ pasted record */

const KINDS = ["static", "exact", "padded", "skipped", "dropped", "load-failed"];
const AUTHORED = new Set(["static", "exact", "padded"]);
const TALLY_RE =
  /clips (\S+): (\d+) static, (\d+) exact, (\d+) padded, (\d+) skipped, (\d+) dropped, (\d+) load-failed; (?:\d+%|—) at authored time/;
const ENGINE_RE = /clips engine: (\d+) exact\|padded, (\d+) skipped, (\d+) load-failed;/;
const ROW_RE = /^\s*#(\d+)\s+\S+\s+clip\s+(\S+)\s+item=(\S+)\s*$/;

function clipRow(forayId, c) {
  const total = KINDS.reduce((n, k) => n + c[k], 0);
  const authored = KINDS.filter((k) => AUTHORED.has(k)).reduce((n, k) => n + c[k], 0);
  return {
    metric: "clip_authored_time",
    forayId,
    static: c.static,
    exact: c.exact,
    padded: c.padded,
    skipped: c.skipped,
    dropped: c.dropped,
    loadFailed: c["load-failed"],
    authoredTimeRate: total ? authored / total : null,
  };
}

/**
 * Rows from a pasted phone record. Tally lines win; a Foray with clip rows and
 * no tally line is tallied from its rows (newest `#seq` per item). A Foray
 * pasted twice keeps its last tally line.
 */
export function parseDiagRecord(text) {
  const tallies = new Map();
  const rowsByForay = new Map();
  let engine = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = ENGINE_RE.exec(line);
    if (m) {
      engine = { noted: Number(m[1]), skipped: Number(m[2]), loadFailed: Number(m[3]) };
      continue;
    }
    const t = TALLY_RE.exec(line);
    if (t) {
      if (t[1] === "?" || t[1] === "engine") continue;
      const c = Object.fromEntries(KINDS.map((k, i) => [k, Number(t[i + 2])]));
      tallies.delete(t[1]);
      tallies.set(t[1], c);
      continue;
    }
    const r = ROW_RE.exec(line);
    if (r && KINDS.includes(r[2])) {
      const at = r[3].lastIndexOf("#");
      if (at <= 0) continue;
      const forayId = r[3].slice(0, at);
      if (!rowsByForay.has(forayId)) rowsByForay.set(forayId, new Map());
      const items = rowsByForay.get(forayId);
      const seq = Number(r[1]);
      const held = items.get(r[3]);
      if (!held || held.seq < seq) items.set(r[3], { seq, kind: r[2] });
    }
  }
  const rows = [];
  for (const [forayId, c] of tallies) rows.push(clipRow(forayId, c));
  for (const [forayId, items] of rowsByForay) {
    if (tallies.has(forayId)) continue;
    const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const { kind } of items.values()) c[kind] += 1;
    rows.push(clipRow(forayId, c));
  }
  if (engine) {
    const total = engine.noted + engine.skipped + engine.loadFailed;
    rows.push({
      metric: "clip_authored_time",
      forayId: null,
      lane: "engine",
      exactOrPadded: engine.noted,
      skipped: engine.skipped,
      loadFailed: engine.loadFailed,
      authoredTimeRate: total ? engine.noted / total : null,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ CLI */

function readOptionalJson(file) {
  try {
    return fs.existsSync(file) ? readJson(file) : null;
  } catch {
    return null;
  }
}

const positiveInt = (name, v, dflt) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`--${name} must be a positive integer`);
  return n;
};
const nonNegative = (name, v, dflt) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`--${name} must be a number >= 0`);
  return n;
};

/** Runs the report; returns `{ rows, reports }`. Writes only --out / --report. */
export function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      transcripts: { type: "string" },
      "asr-cues": { type: "string" },
      scenarios: { type: "string" },
      seed: { type: "string" },
      "delta-max-sec": { type: "string" },
      "spread-sec": { type: "string" },
      root: { type: "string" },
      diag: { type: "string" },
      out: { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help: true, rows: [], reports: [] };
  if (positionals.length && !values.transcripts) throw new Error("--transcripts <normalized dir> is required with a candidate");
  if (!positionals.length && !values.diag) throw new Error("give a candidate JSON, --diag <record.txt>, or both");
  const root = path.resolve(values.root ?? ROOT);
  const opts = {
    scenarios: positiveInt("scenarios", values.scenarios, DEFAULTS.scenarios),
    seed: nonNegative("seed", values.seed, DEFAULTS.seed),
    delta_max_sec: nonNegative("delta-max-sec", values["delta-max-sec"], DEFAULTS.delta_max_sec),
    spread_sec: nonNegative("spread-sec", values["spread-sec"], DEFAULTS.spread_sec),
  };
  const rows = [];
  const reports = [];
  if (positionals.length) {
    const pool = rowsOf(readOptionalJson(path.join(root, "data", "segments.json")), "segments");
    const committedSources = rowsOf(readOptionalJson(path.join(root, "data", "segment-sources.json")), "sources");
    const shows = showByGuid(
      rowsOf(readOptionalJson(path.join(root, "data", "transcript-digests.json")), "transcripts"),
      rowsOf(readOptionalJson(path.join(root, "data", "breadth-transcript-digests.json")), "transcripts"),
    );
    const cueCache = new Map();
    const cached = (dir, guid) => {
      const key = `${dir}\u0000${guid}`;
      if (!cueCache.has(key)) cueCache.set(key, readEpisodeCues(dir, { showId: shows.get(guid) ?? null, guid }));
      return cueCache.get(key);
    };
    for (const file of positionals) {
      const candidate = readJson(file);
      const guids = guidByItem(candidate.segmentSources, candidate.newSegmentSources, committedSources);
      const parsed = candidateSegments(candidate, { pool, fallbackId: path.basename(file).replace(/\.json$/i, "") });
      const guidOf = (seg) => guids.get(seg.itemId) ?? null;
      const report = forayReport(parsed, {
        ...opts,
        cuesFor: (seg) => (guidOf(seg) ? cached(values.transcripts, guidOf(seg)) : null),
        asrCuesFor: (seg) => (values["asr-cues"] && guidOf(seg) ? cached(values["asr-cues"], guidOf(seg)) : null),
      });
      reports.push(report);
      rows.push(resolveRow(report, opts));
    }
  }
  if (values.diag) rows.push(...parseDiagRecord(fs.readFileSync(values.diag, "utf8")));
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  if (values.out) fs.writeFileSync(values.out, jsonl);
  else process.stdout.write(jsonl);
  if (values.report) fs.writeFileSync(values.report, `${JSON.stringify({ reports }, null, 2)}\n`);
  return { rows, reports };
}

if (isEntryScript(import.meta.url)) {
  try {
    const r = run(process.argv.slice(2));
    if (r.help) process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]}*/\n`);
  } catch (err) {
    process.stderr.write(`anchor-resolve-report: ${err.message}\n`);
    process.exitCode = 1;
  }
}
