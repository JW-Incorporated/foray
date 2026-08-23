#!/usr/bin/env node
/* Segment batch PREPARE + candidate LINT — the two deterministic halves of
   Lane C, keyless, no LLM, no network. Issue #106's sibling; the stage
   `docs/curation/segment-extraction-pipeline.md` §3 names
   `tools/segments/prepare-segment-batch.mjs` and which has not existed until
   now, plus the tier-P/tier-B rules `docs/curation/segment-length-rules.md` §9
   assigns to "a new reporting mode on the merge, or a separate lint".

   ONE FILE FOR BOTH, deliberately. These are the deterministic steps on either
   side of the extraction agent — everything before it that is not a fetch, and
   everything after it that is not the pool validator. They read the same two
   inputs (a batch file and the digests behind it) and share the whole of the
   cue/duration plumbing below. `merge-segments.mjs` stays narrow on purpose —
   its contract is "the pool file, and only the pool file", which is what lets
   CI run `--check` as a schema gate — so the length rules cannot go there
   without widening exactly the thing that keeps it trustworthy. Two files
   sharing one private module would be three files and one more floor for no
   behavioural difference.

   ------------------------------------------------------------------ PREPARE

   THE GATE THAT MATTERS, and it is not a length rule. Issue #315: a transcript
   whose timeline OVERRUNS its episode's declared duration is describing a
   different copy of the audio than the one a listener will play, and the offset
   is silently absorbed by every check downstream:

     - ADR-0007's anchor tolerance is +/-120 s, and `merge-segments.mjs`'s
       ANCHOR_TIME_TOLERANCE_SEC is the same 120. A 30-100 s offset sits INSIDE
       it, so the anchor resolves, the check passes, and the segment plays the
       wrong words.
     - `span_implausible` will not catch it either. MAX_SPAN_RATIO is 1.5,
       deliberately loose so a rounded `itunes:duration` does not trip it, and a
       100 s overrun on a 50-minute episode is a ratio of ~1.03. Causality's
       *BP Texas City* is the one transcript in this corpus that overruns
       enough to be visible at all and it sits at 1.464 — inside the limit by
       0.036.

   So the overrun is checked HERE, before a cut is ever authored, against the
   only two numbers that can see it: the transcript's last cue and the feed's
   declared duration.

   WHY 5 SECONDS. Measured over all 1,718 transcripts held in
   `data/transcript-digests.json` + `data/breadth-transcript-digests.json`, the
   distribution of `last_cue_sec - feed_duration_sec` is sharply bimodal: the
   95th percentile is +0.4 s, only 58 transcripts exceed +5 s, and 56 of those
   58 exceed +15 s. There is essentially nothing between 5 s and 30 s. A last
   cue a second or two past a rounded `itunes:duration` is arithmetic; a last
   cue a minute past it is a different timeline. 5 s sits in the empty gap
   between those two populations, and it is 24x tighter than the 120 s tolerance
   it exists to protect. It is NOT a tolerance to widen — widening it is the
   failure mode #315 describes.

   THE OTHER DIRECTION IS ALSO A SIGNAL, and a weaker one. A transcript whose
   last cue lands far SHORT of the declared duration is usually just trimmed
   (Geology Bites lands 8-10 s short on 118 of 120 episodes, its outro), but a
   transcript covering half an episode is either truncated or the wrong file.
   Below MIN_TRANSCRIPT_COVERAGE the episode is excluded; above it the shortfall
   is reported and the episode is kept, because a cut inside the covered span is
   unaffected by a missing tail.

   NEITHER GATE IS A "FIX". Nothing here edits a timeline, shifts a cue, or
   widens a tolerance. An episode that fails is excluded and counted, and the
   count is the deliverable — "we did not cut from 55 episodes and here is why"
   is a result, not a gap.

   --------------------------------------------------------------------- LINT

   `merge-segments.mjs` enforces the rules that make a boundary RESOLVABLE
   (verbatim anchors, times inside the episode, a real taxonomy node, copy
   rules). It does not enforce, and should not learn, the rules that make a
   boundary LISTENABLE — §9's L1/L3/L4/L5, S1/S2, M1/M2 and B1. Those live here
   and run before the merge, so a candidate that would make a bad segment never
   reaches the pool.

   Two of them are FLAG-ONLY by the document's own instruction (S1 cold-open,
   S2 clean-out): both are lexical proxies for a judgement, both have real false
   positives, and both carry an extractor override field. They warn; they never
   drop a candidate.

   Usage:
     node tools/segments/prepare-segment-batch.mjs --show <show_id> \
       --batch-id <id> --out <batch.json> [--sources-out <sources.json>] \
       [--render <dir>] [--select <guid,guid,...>] [--limit N]

     node tools/segments/prepare-segment-batch.mjs --lint <results.json> \
       --batch <batch.json>

   Env overrides:
     DIGEST_PATHS       comma-separated (default the two committed digests)
     TRANSCRIPTS_DIR    default data-local/transcripts                        */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import copyRules from "../../backend/src/copy/rules.js";
import { normalize } from "./transcript-normalize.mjs";
import { canonical } from "./merge-segments.mjs";
import { ROLE_MAX_SEC, L4_SOFT_MAX_SEC } from "../foray/check-forays.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { BANNED, wordCount, MAX_WHY_LINE_WORDS } = copyRules;

/* ------------------------------------------------------------ the two gates */

/** How far past the feed's declared duration a transcript's last cue may sit
    before the episode is refused as a cut source. See the header for the
    measured distribution this comes from. */
export const TIMELINE_OVERRUN_TOLERANCE_SEC = 5;

/** How little of the declared duration a transcript may cover and still be
    usable. Half is generous: it admits every trimmed outro in the corpus and
    refuses the files that are a different episode. */
export const MIN_TRANSCRIPT_COVERAGE = 0.5;

/**
 * Does this transcript's timeline describe the episode the feed declares?
 *
 * @param {{last_cue_sec: number, feed_duration_sec: number, cues: number}} row
 *   a digest row from data/transcript-digests.json
 * @returns {{ok: boolean, code: string, detail: string, overrun_sec: number|null,
 *            coverage: number|null}}
 */
export function timelineVerdict(row, opts = {}) {
  const tolerance = opts.overrunToleranceSec ?? TIMELINE_OVERRUN_TOLERANCE_SEC;
  const minCoverage = opts.minCoverage ?? MIN_TRANSCRIPT_COVERAGE;
  const last = Number(row?.last_cue_sec);
  const declared = Number(row?.feed_duration_sec);
  const cues = Number(row?.cues);

  if (!Number.isFinite(cues) || cues <= 0) {
    return { ok: false, code: "no_cues", detail: "transcript normalises to no cues", overrun_sec: null, coverage: null };
  }
  if (!Number.isFinite(declared) || declared <= 0) {
    /* No declared duration means the overrun is UNCHECKABLE, not zero. Treating
       an absent denominator as a pass is how an unmeasured thing gets reported
       as a measured one. */
    return {
      ok: false,
      code: "no_declared_duration",
      detail: "the feed declares no duration, so the timeline cannot be checked against anything",
      overrun_sec: null,
      coverage: null,
    };
  }
  if (!Number.isFinite(last) || last <= 0) {
    return { ok: false, code: "no_last_cue", detail: "transcript has no usable last cue time", overrun_sec: null, coverage: null };
  }

  const overrun = last - declared;
  const coverage = last / declared;
  if (overrun > tolerance) {
    return {
      ok: false,
      code: "timeline_overruns_declared_duration",
      detail:
        `last cue at ${last.toFixed(1)}s runs ${overrun.toFixed(1)}s past the declared ${declared.toFixed(1)}s ` +
        `(ratio ${coverage.toFixed(3)}); over the ${tolerance}s tolerance, and an offset this size hides inside ` +
        "ADR-0007's +/-120s anchor tolerance",
      overrun_sec: overrun,
      coverage,
    };
  }
  if (coverage < minCoverage) {
    return {
      ok: false,
      code: "transcript_covers_too_little",
      detail: `last cue at ${last.toFixed(1)}s covers ${(coverage * 100).toFixed(1)}% of the declared ${declared.toFixed(1)}s`,
      overrun_sec: overrun,
      coverage,
    };
  }
  return { ok: true, code: "ok", detail: "", overrun_sec: overrun, coverage };
}

/**
 * Split digest rows into the episodes a cut may be authored from and the ones
 * excluded, with a reason on every exclusion.
 *
 * @returns {{selected: object[], excluded: Array<object>, byCode: Record<string, number>}}
 */
export function selectTranscripts(rows, opts = {}) {
  const selected = [];
  const excluded = [];
  for (const row of rows || []) {
    const verdict = timelineVerdict(row, opts);
    if (verdict.ok) selected.push({ row, verdict });
    else excluded.push({ guid: row?.guid, title: row?.title, show_id: row?.show_id, ...verdict });
  }
  const byCode = {};
  for (const e of excluded) byCode[e.code] = (byCode[e.code] || 0) + 1;
  return { selected, excluded, byCode };
}

/* ------------------------------------------------------------ episode ids */

/** Slug of an episode title, for a stable item_id. Deterministic and lossy on
    purpose: it is an identifier, not a display string.

    NOT `tools/corpus/paths.mjs`'s slug, and the reason is a hard one rather than
    an oversight: that module sits under a directory carrying its own
    `package.json` and real dependencies, so importing it from here would put
    `tools/segments/` behind an install step it does not have. Its version also
    neither folds diacritics (so "Tōhoku" loses a letter) nor truncates on a word
    boundary, both of which are load-bearing for an id that gets committed. */
export function slugify(text) {
  const full = String(text == null ? "" : text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_MAX_CHARS) return full;
  /* Truncate on a word boundary. A blind slice leaves a half-word in a
     committed id ("...in-the-pigeo"), which reads as a typo forever. */
  const cut = full.slice(0, SLUG_MAX_CHARS);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/** Long enough to stay readable, short enough that an id is not a sentence. */
export const SLUG_MAX_CHARS = 60;

/**
 * `<show_id>--<slug>`, the id shape `data/discover.json` already uses.
 *
 * Collisions are RESOLVED, not tolerated: two episodes of one show whose titles
 * slugify the same would otherwise mint one id, and `merge-segments.mjs` derives
 * segment ids from `item_id` + `start_sec`, so the two episodes' segments would
 * silently share a namespace and overwrite each other.
 */
export function mintItemIds(rows, { prefix } = {}) {
  const out = new Map();
  const used = new Set();
  for (const row of rows) {
    const base = `${prefix || row.show_id}--${slugify(row.title) || "episode"}`;
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    out.set(row.guid, id);
  }
  return out;
}

/** The enclosure's media type, from the URL's own path extension.
 *
 *  DERIVED, NOT INVENTED, and it returns null rather than guessing. The sweep
 *  records `transcript_type` from the feed but not the enclosure's declared
 *  `type` attribute, and this file has no network. An extension is evidence
 *  about the bytes; anything else would be a value written into a committed
 *  file on no evidence at all. A null forces whoever registers the source to
 *  supply it by hand. */
export function enclosureMime(url) {
  let path = String(url == null ? "" : url);
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a malformed escape means the URL is not ours to interpret; fall through
       to the raw string, which still carries the extension when there is one */
  }
  path = path.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return null;
  return (
    {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/opus",
      wav: "audio/wav",
      flac: "audio/flac",
    }[m[1].toLowerCase()] || null
  );
}

/* ---------------------------------------------------------------- the batch */

/**
 * The batch file `merge-segments.mjs` reads: episode provenance plus the exact
 * transcript the anchors will be authored against.
 *
 * `reference_duration_sec` is the FEED's declared duration, never the
 * transcript's last cue. The two disagree by design (an outro is not
 * transcribed), and it is the feed's number that `check-forays.mjs` compares
 * `segment-sources.duration_sec` against, so using the other one puts a
 * two-second disagreement into every record.
 */
export function buildBatch({ batchId, source, episodes }) {
  if (!batchId || typeof batchId !== "string") throw new Error("batchId is required");
  if (!Array.isArray(episodes) || !episodes.length) throw new Error("at least one episode is required");
  return {
    version: 1,
    batch_id: batchId,
    source: source || "agent-v1",
    prepared_by: "tools/segments/prepare-segment-batch.mjs",
    episodes: episodes.map((e) => ({
      item_id: e.item_id,
      show_id: e.show_id,
      show_title: e.show_title,
      title: e.title,
      guid: e.guid,
      reference_duration_sec: e.reference_duration_sec,
      dai_suspected: e.dai_suspected,
      transcript_source: e.transcript_source,
      transcript: { mime_type: e.mime_type, body: e.body },
    })),
  };
}

/**
 * The `data/segment-sources.json` rows for a batch's episodes.
 *
 * Emitted HERE rather than hand-written because `check-forays.mjs` errors when
 * `duration_sec` and a segment's `reference_duration_sec` differ by more than
 * 2 s, and the only way to be sure of that is for one function to write both
 * from one number. `audio_type` is null when the URL does not say; the caller
 * fills it in or drops the episode.
 */
export function buildSources(episodes, { verifiedOn = null } = {}) {
  return episodes.map((e) => ({
    id: e.item_id,
    show: e.show_title,
    title: e.title,
    feed_url: e.feed_url ?? null,
    episode_guid: e.guid,
    audio_url: e.enclosure_url,
    audio_type: enclosureMime(e.enclosure_url),
    duration_sec: e.reference_duration_sec,
    dai_suspected: e.dai_suspected,
    ad_free_ratio: e.ad_free_ratio ?? null,
    audio_verified_on: verifiedOn,
    transcript_url: e.transcript_url ?? null,
    transcript_sha256: e.transcript_sha256 ?? null,
  }));
}

/* --------------------------------------------------------------- rendering */

function hhmmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A cue list as numbered, timestamped lines for a human or an extraction agent
 * to read and quote from.
 *
 * Every line carries its own index and time, because the one thing the agent
 * must not do is retype an anchor from memory: it copies a run of these lines,
 * and the times beside them are the boundary it is choosing.
 *
 * BOTH CLOCKS, and that is not redundancy. `hh:mm:ss` is what a person reads
 * when they are deciding whether a boundary is in a sensible place; the raw
 * seconds are what goes into `start_sec`/`end_sec`, and they are printed to two
 * decimals because rounding them to whole seconds is how an authored boundary
 * drifts away from the cue it was copied from.
 */
export function renderTranscript(cues, { header = "" } = {}) {
  const lines = header ? [header, ""] : [];
  (cues || []).forEach((c, i) => {
    const start = Number(c.start_sec) || 0;
    const end = Number(c.end_sec) || 0;
    lines.push(
      `[${String(i).padStart(4, "0")} ${hhmmss(start)} | ${start.toFixed(2)}-${end.toFixed(2)}] ${String(c.text || "").trim()}`
    );
  });
  return lines.join("\n") + "\n";
}

/* -------------------------------------------------------------------- lint */

/** §9 L1: the floor every role shares, below which nothing is a segment. */
export const MIN_SEGMENT_SEC = 30;

/** §9 L3 / L4, IMPORTED from `check-forays.mjs` rather than restated.
 *
 *  That file already owns the per-role tables and gates a Foray on them; a
 *  second copy here would be a fourth place to edit §9's numbers and would
 *  eventually disagree with the gate it is meant to pre-empt. Importing across
 *  `tools/` costs nothing — both files are dependency-free ESM with no build
 *  step — and it is the same discipline that makes both of them import
 *  `backend/src/copy/rules.js` instead of listing banned phrases twice. */
export { ROLE_FLOOR_SEC, ROLE_MAX_SEC } from "../foray/check-forays.mjs";
export const SOFT_MAX_SEGMENT_SEC = L4_SOFT_MAX_SEC;
export const HARD_MAX_SEGMENT_SEC = Math.max(...Object.values(ROLE_MAX_SEC));

/**
 * The ceiling for a candidate's declared role, falling back to the most
 * permissive one when the role is missing or unknown.
 *
 * A CEILING KEYED ON AN ADVISORY FIELD IS SAFE; A FLOOR IS NOT, and that
 * asymmetry is why L3 is enforced here and L2 is not. `role` is the extractor's
 * own word and `merge-segments.mjs` does not carry it into the pool. Applying
 * the ceiling to it can only reject tape that is too long for the shape it
 * claims to be — a five-minute `quote` is wrong under any label. Applying the
 * 120 s `narrative` FLOOR would reject an 80-second passage for being labelled
 * `narrative` instead of `explanation`, which is a rejection on a word, not on
 * the tape. L1's absolute 30 s floor covers what matters, and `check-forays.mjs`
 * enforces L2 at assembly, where the Foray item's `role` is authored and
 * checkable.
 */
export function roleMaxSec(role) {
  return ROLE_MAX_SEC[role] ?? HARD_MAX_SEGMENT_SEC;
}
/** §9 L5. */
export const MAX_SHARE_OF_EPISODE = 0.2;
/** §6a / §9 M1 + M2: below the first, two same-episode segments must be merged;
    between the two, keeping them apart needs a stated reason. */
export const MUST_MERGE_GAP_SEC = 45;
export const SHOULD_MERGE_GAP_SEC = 180;
/** §9 B1. */
export const BATCH_MEDIAN_MIN_SEC = 75;
export const BATCH_MEDIAN_MAX_SEC = 180;

/** §7's cold-open list, verbatim. */
export const COLD_OPEN_WORDS = new Set([
  "so", "and", "but", "because", "that", "this", "it", "they", "he", "she",
  "which", "then", "right", "yeah", "well", "anyway", "exactly", "again",
  "also", "plus", "or",
]);

const SENTENCE_TERMINALS = /[.!?…]["'”’)\]]*$/;

function words(text) {
  return String(text == null ? "" : text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** S1: does the anchor open on an unbound connective with nothing to bind it? */
export function coldOpenWarning(anchor) {
  const w = words(anchor);
  if (!w.length) return null;
  const first = w[0].toLowerCase().replace(/[^a-z']/g, "");
  if (!COLD_OPEN_WORDS.has(first)) return null;
  /* The escape hatch §7 asks for: a proper noun or a topic term inside the
     first 12 words binds the connective to something the listener can hold. */
  const bound = w.slice(0, 12).some((t, i) => i > 0 && /^[A-Z][a-z]/.test(t));
  return bound ? null : `starts on "${w[0]}" with no proper noun in the first 12 words`;
}

/** S2: does the anchor land on a sentence terminal? */
export function cleanOutWarning(anchor) {
  const t = String(anchor == null ? "" : anchor).trim();
  if (!t) return null;
  return SENTENCE_TERMINALS.test(t) ? null : "does not end on a sentence terminal";
}

/** Cue times are seconds to three decimals in every format the normaliser
    emits, so anything looser than a millisecond here is slack, not tolerance. */
export const CUE_EPSILON_SEC = 0.001;

/** The cues a segment actually plays: those lying wholly inside its interval. */
export function playedRun(cues, startSec, endSec) {
  return (cues || []).filter((c) => c.start_sec >= startSec - CUE_EPSILON_SEC && c.end_sec <= endSec + CUE_EPSILON_SEC);
}

/**
 * A1 — the anchors must BOUND the audio the segment plays.
 *
 * THIS IS THE RULE `merge-segments.mjs` CANNOT MAKE, and it found nine real
 * defects the first time it ran. That validator proves an anchor occurs
 * *somewhere* within ANCHOR_TIME_TOLERANCE_SEC (120 s) of its claimed time,
 * which is the right question for "can this boundary be re-found in another
 * copy of the file" and is NOT the same question as "does the segment play
 * these words".
 *
 * The gap between the two is exactly one boundary-width. An extractor that
 * assembles a clean-reading 8-14 word anchor by trimming *into* the cue on
 * either side, and then sets `start_sec`/`end_sec` to the enclosing cue
 * boundaries, produces a segment whose anchors read perfectly and whose audio
 * starts or stops mid-clause — `... Deficiency Report 001 was considered to be
 * closed and it was` is where one of them actually ended, while its
 * `end_anchor` finished the sentence. Every downstream check passes. Only the
 * listener finds out.
 *
 * So: the canonical text of the played cue run must START with `start_anchor`
 * and END with `end_anchor`. Both directions, because the two failures are
 * different — a start that begins mid-anchor merely loses a few words of
 * sacrificial head, an end that stops mid-anchor is the cut-off listeners
 * report.
 *
 * @returns {string[]} errors, empty when the anchors bound the run
 */
export function anchorBoundsErrors(cues, seg) {
  const run = playedRun(cues, Number(seg?.start_sec), Number(seg?.end_sec));
  if (!run.length) return ["A1 — no cue lies wholly inside the segment, so it plays nothing checkable"];
  const text = canonical(run.map((c) => c.text).join(" "));
  const errors = [];
  const start = canonical(seg?.start_anchor);
  const end = canonical(seg?.end_anchor);
  /* WHOLE-WORD prefix and suffix, matching `merge-segments.mjs`'s whole-word
     subsequence rule. A raw `startsWith` would accept an anchor trimmed into the
     middle of a word — `and it was` against `and it wasnt the pressure` — which
     is the same trimmed-into-the-boundary-cue defect A1 exists to catch, one
     character deeper. */
  const headOk = text === start || text.startsWith(`${start} `);
  const tailOk = text === end || text.endsWith(` ${end}`);
  if (start && !headOk) errors.push("A1 — start_anchor is not the head of the cue run the segment plays");
  if (end && !tailOk) errors.push("A1 — end_anchor is not the tail of the cue run the segment plays");
  return errors;
}

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Tier-P and tier-B rules from `segment-length-rules.md` §9, over one batch of
 * authored candidates.
 *
 * Errors DROP a candidate; warnings never do. The split follows the document:
 * a rule marked "flag only" there is a warning here, and turning one into a
 * gate is a change to that document rather than to this function.
 *
 * @returns {{errors: string[], warnings: string[], dropped: Set<string>,
 *            stats: {candidates: number, kept: number, median_sec: number}}}
 */
export function lintCandidates({ batch, results }) {
  const errors = [];
  const warnings = [];
  const dropped = new Set();
  const episodes = new Map((batch?.episodes || []).map((e) => [e.item_id, e]));
  const authored = results?.results && typeof results.results === "object" ? results.results : {};
  const durations = [];
  let candidates = 0;

  for (const [itemId, entry] of Object.entries(authored)) {
    const list = Array.isArray(entry) ? entry : Array.isArray(entry?.segments) ? entry.segments : [];
    const episode = episodes.get(itemId);
    if (!episode) {
      /* DROPPED, not merely reported. `--write` rewrites the results file from
         `dropped`, so leaving these in would clean a file while quietly keeping
         the candidates nothing can verify — and `merge-segments.mjs` refuses
         them anyway, one stage later and one file further on. */
      errors.push(`${itemId}: authored but absent from the batch, so no transcript can verify it — ${list.length} candidate(s) dropped`);
      for (let i = 0; i < list.length; i += 1) dropped.add(`${itemId}[${i}]`);
      candidates += list.length;
      continue;
    }
    const refDuration = Number(episode.reference_duration_sec);
    /* Normalised once per episode, not once per candidate: a batch holds a
       whole episode's transcript and re-parsing it per segment is the only
       expensive thing this function could do. A batch without transcripts (a
       caller linting shapes alone) simply skips A1 rather than inventing a
       verdict. */
    const cues = episode.transcript?.body ? normalize(episode.transcript.body, episode.transcript.mime_type).cues : null;
    const ok = [];
    for (const [i, seg] of list.entries()) {
      candidates += 1;
      const key = `${itemId}[${i}]`;
      const start = Number(seg?.start_sec);
      const end = Number(seg?.end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        errors.push(`${key}: start_sec/end_sec are not a usable interval`);
        dropped.add(key);
        continue;
      }
      const duration = end - start;
      let bad = false;

      if (duration < MIN_SEGMENT_SEC) {
        errors.push(`${key}: L1 — ${duration.toFixed(1)}s is under the ${MIN_SEGMENT_SEC}s floor`);
        bad = true;
      }
      const ceiling = roleMaxSec(seg?.role);
      if (duration > ceiling) {
        errors.push(`${key}: L3 — ${duration.toFixed(1)}s is over the ${ceiling}s maximum for role \`${seg?.role ?? "unset"}\``);
        bad = true;
      }
      if (Number.isFinite(refDuration) && refDuration > 0 && duration > MAX_SHARE_OF_EPISODE * refDuration) {
        errors.push(
          `${key}: L5 — ${duration.toFixed(1)}s is ${((duration / refDuration) * 100).toFixed(1)}% of the ` +
            `${refDuration.toFixed(0)}s episode, over the ${MAX_SHARE_OF_EPISODE * 100}% cap`
        );
        bad = true;
      }
      if (duration > SOFT_MAX_SEGMENT_SEC) {
        const reason = typeof seg?.long_reason === "string" && seg.long_reason.trim();
        if (!reason) {
          errors.push(`${key}: L4 — ${duration.toFixed(1)}s is over the ${SOFT_MAX_SEGMENT_SEC}s soft maximum and carries no long_reason`);
          bad = true;
        } else if (seg?.needs_review !== true) {
          errors.push(`${key}: L4 — over the soft maximum, so needs_review must be true`);
          bad = true;
        } else {
          for (const rx of BANNED) if (rx.test(reason)) { errors.push(`${key}: long_reason contains banned phrase ${rx}`); bad = true; }
          if (wordCount(reason) > MAX_WHY_LINE_WORDS) {
            errors.push(`${key}: long_reason is ${wordCount(reason)} words, over ${MAX_WHY_LINE_WORDS}`);
            bad = true;
          }
        }
      }

      if (cues) {
        for (const e of anchorBoundsErrors(cues, seg)) {
          errors.push(`${key}: ${e}`);
          bad = true;
        }
      }

      if (seg?.cold_open_ok !== true) {
        const w = coldOpenWarning(seg?.start_anchor);
        if (w) warnings.push(`${key}: S1 — start_anchor ${w}`);
      }
      const c = cleanOutWarning(seg?.end_anchor);
      if (c) warnings.push(`${key}: S2 — end_anchor ${c}`);

      if (bad) dropped.add(key);
      else {
        durations.push(duration);
        ok.push({ key, start, end, seg });
      }
    }

    /* M1/M2 are about a PAIR, so they run after the whole episode is collected,
       and they measure against the last KEPT candidate rather than the last one
       looked at.
       THAT DISTINCTION IS THE WHOLE LOOP. Comparing to `ok[i - 1]` unconditionally
       cascades: three candidates 40 s apart drop the second on M1, then measure
       the third against the segment that is no longer there and drop it too,
       when the gap to the surviving candidate is 150 s and at most an M2
       warning. The rule is "these two must be one segment"; a segment that was
       already rejected is not one of the two. */
    ok.sort((a, b) => a.start - b.start);
    let previous = null;
    for (const cand of ok) {
      if (!previous) {
        previous = cand;
        continue;
      }
      const gap = cand.start - previous.end;
      if (gap < 0) {
        errors.push(`${cand.key}: overlaps ${previous.key} in the same episode`);
        dropped.add(cand.key);
        continue;
      }
      if (gap < MUST_MERGE_GAP_SEC) {
        errors.push(
          `${cand.key}: M1 — ${gap.toFixed(1)}s after ${previous.key} in the same episode; under ${MUST_MERGE_GAP_SEC}s the two must be one segment`
        );
        dropped.add(cand.key);
        continue;
      }
      if (gap < SHOULD_MERGE_GAP_SEC && !(typeof cand.seg?.keep_separate_reason === "string" && cand.seg.keep_separate_reason.trim())) {
        warnings.push(`${cand.key}: M2 — ${gap.toFixed(1)}s after ${previous.key} with no keep_separate_reason`);
      }
      previous = cand;
    }
  }

  const kept = candidates - dropped.size;
  const med = median(durations);
  if (durations.length && (med < BATCH_MEDIAN_MIN_SEC || med > BATCH_MEDIAN_MAX_SEC)) {
    warnings.push(`B1 — batch median ${med.toFixed(1)}s is outside the ${BATCH_MEDIAN_MIN_SEC}-${BATCH_MEDIAN_MAX_SEC}s target band`);
  }
  return { errors, warnings, dropped, stats: { candidates, kept, median_sec: med } };
}

/**
 * A results document with every linted-out candidate removed.
 *
 * Removal, never repair: the same posture as `merge-segments.mjs`. A candidate
 * that breaks a length rule is dropped and reported, because the fix is an
 * editorial one (widen it, merge it, or leave it out) and no function here can
 * make it.
 */
export function applyLint(results, dropped) {
  const out = { ...results, results: {} };
  for (const [itemId, entry] of Object.entries(results?.results || {})) {
    const list = Array.isArray(entry) ? entry : Array.isArray(entry?.segments) ? entry.segments : [];
    const kept = list.filter((_, i) => !dropped.has(`${itemId}[${i}]`));
    if (!kept.length) continue;
    /* An entry may be a bare array or `{segments: [...], ...notes}`. Rewriting
       the second shape to the first would silently drop whatever else the
       extractor said about the episode, which is the opposite of this
       function's job. */
    out.results[itemId] = Array.isArray(entry) ? kept : { ...entry, segments: kept };
  }
  return out;
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    show: get("--show"),
    batchId: get("--batch-id"),
    out: get("--out"),
    sourcesOut: get("--sources-out"),
    render: get("--render"),
    select: get("--select"),
    limit: get("--limit") !== undefined ? Number(get("--limit")) : undefined,
    lint: get("--lint"),
    idPrefix: get("--id-prefix"),
    adFreeRatio: get("--ad-free-ratio") !== undefined ? Number(get("--ad-free-ratio")) : null,
    batch: get("--batch"),
    write: argv.includes("--write"),
  };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function digestPaths() {
  const env = process.env.DIGEST_PATHS;
  if (env) return env.split(",").map((p) => resolvePath(process.cwd(), p.trim()));
  return [join(ROOT, "data", "transcript-digests.json"), join(ROOT, "data", "breadth-transcript-digests.json")];
}

/** guid -> on-disk transcript file, built by reading each normalised file's own
    `guid` rather than by parsing the filename. The filenames carry a hash the
    fetcher chose and this file does not own that convention.

    THE CUES ARE NOT RETAINED HERE. Every file of the show has to be opened to
    learn its guid, but a 120-episode show is ~50 MB of cue arrays and a run
    typically wants 31 of them; `cuesFor` re-reads only the ones that survive
    `--select`/`--limit`. */
function transcriptIndex(dir, showId) {
  const index = new Map();
  const normalisedRoot = join(dir, "normalized");
  if (!existsSync(normalisedRoot)) return index;
  for (const showDir of readdirSync(normalisedRoot)) {
    if (showDir !== showId && !showDir.startsWith(`${showId}-`)) continue;
    for (const file of readdirSync(join(normalisedRoot, showDir))) {
      if (!file.endsWith(".json")) continue;
      const doc = readJson(join(normalisedRoot, showDir, file));
      index.set(String(doc.guid), {
        normalised: join(normalisedRoot, showDir, file),
        raw: join(dir, "raw", showDir, file.replace(/\.json$/, "")),
      });
    }
  }
  return index;
}

function cuesFor(entry) {
  return readJson(entry.normalised).cues || [];
}

function rawBodyFor(entry) {
  for (const ext of [".srt", ".vtt", ".json", ".txt"]) {
    if (existsSync(entry.raw + ext)) {
      return {
        body: readFileSync(entry.raw + ext, "utf8"),
        mime: { ".srt": "application/x-subrip", ".vtt": "text/vtt", ".json": "application/json", ".txt": "text/plain" }[ext],
      };
    }
  }
  return null;
}

/**
 * Per-show `dai_suspected` and `feed_url`, and the PRECEDENCE MATTERS.
 *
 * `data/transcript-availability.json`'s verdict is the SWEEP's, and the sweep
 * says so itself: Geology Bites is filed `true` with the reason
 * `"host:anchor.fm (declared, no resolve needed)"` — a verdict on the feed's
 * enclosure host, taken without walking the redirect chain, because resolving
 * 82,000 enclosures to answer a transcript question is not worth the requests.
 *
 * `data/dai-classification.json` is `tools/refresh/dai.mjs`'s verdict, taken
 * AFTER resolving the chain, and it is what `data/discover.json` actually
 * ships. For the same show it reads `false`, resolved host
 * `d3ctxlq1ktw2nl.cloudfront.net`, and its own ad-inflation probe came back
 * byte-identical over three episodes (median ratio 1.000).
 *
 * Taking the sweep's number put `dai_suspected: true` on 101 segments of a show
 * the shipped catalogue calls non-DAI, which is not a stricter reading — it is a
 * DIFFERENT CLAIM about a different question, and it would have registered a
 * source contradicting `data/discover.json` about the same episode's seek
 * precision (#30). The resolved verdict wins, and the measurement behind it is
 * the repo's standing rule (`breadth-yield.mjs`: a measurement outranks the
 * heuristic). The sweep's number is the fallback for shows the classifier has
 * never seen, which is every breadth show.
 */
export function resolveDaiVerdicts({ availability, yieldDoc, classification } = {}) {
  const map = new Map();
  const put = (id, value) => {
    if (id == null) return;
    const key = String(id);
    if (!map.has(key)) map.set(key, value);
  };

  /* AN UNKNOWN VERDICT STAYS `null`, and this is the point of the whole
     function. `s.dai_suspected === true` would fold `null` — "the DAI probe
     could not resolve", which `transcript-availability.json` ships for
     omega tau and `breadth-transcript-yield.json` ships for 19 shows — into a
     committed `dai_suspected: false`. That is precisely the value
     `merge-segments.mjs` ("a missing verdict would waive the anchor rule") and
     `check-forays.mjs` ("a missing flag reads as falsy") both exist to reject,
     manufactured upstream of both of them. A null propagates and `runPrepare`
     refuses to build a batch on one. */
  const verdict = (v) => (typeof v === "boolean" ? v : null);

  for (const s of availability?.shows || []) {
    put(s.show_id, { dai: verdict(s.dai_suspected), feed_url: s.feed_url, apple_collection_id: s.apple_collection_id, dai_source: "sweep (feed host, unresolved)" });
  }
  for (const s of yieldDoc?.shows || []) {
    put(s.show_id, { dai: verdict(s.dai_suspected), feed_url: s.feed_url, apple_collection_id: s.apple_collection_id, dai_source: "sweep (feed host, unresolved)" });
  }

  const shows = classification?.shows || {};
  for (const [showId, meta] of map) {
    const resolved = shows[String(meta.apple_collection_id)];
    if (!resolved || typeof resolved.dai !== "boolean") continue;
    map.set(showId, {
      ...meta,
      dai: resolved.dai,
      dai_source: "data/dai-classification.json (resolved chain)",
      ad_free_ratio: resolved.ad_inflation?.verdict === "ad-free" ? resolved.ad_inflation.median_ratio : undefined,
    });
  }
  return map;
}

/** The I/O half: read the three committed files, if present, and resolve. */
function daiIndex() {
  const load = (...rel) => {
    const p = join(ROOT, ...rel);
    return existsSync(p) ? readJson(p) : null;
  };
  return resolveDaiVerdicts({
    availability: load("data", "transcript-availability.json"),
    yieldDoc: load("data", "breadth-transcript-yield.json"),
    classification: load("data", "dai-classification.json"),
  });
}

function runPrepare(args) {
  if (!args.show || !args.batchId || !args.out) {
    console.error(
      "Usage: --show <show_id> --batch-id <id> --out <batch.json> [--sources-out <p>] [--render <dir>]" +
        "\n       [--select guid,...] [--limit N] [--id-prefix <slug>] [--ad-free-ratio <n>]"
    );
    process.exit(1);
  }
  const rows = digestPaths()
    .filter((p) => existsSync(p))
    .flatMap((p) => readJson(p).transcripts || [])
    .filter((t) => t.show_id === args.show);
  if (!rows.length) {
    console.error(`FATAL: no digest rows for show "${args.show}"`);
    process.exit(1);
  }

  const { selected, excluded, byCode } = selectTranscripts(rows);
  console.log(`${args.show}: ${rows.length} transcript(s) held, ${selected.length} pass the timeline gates, ${excluded.length} excluded`);
  for (const [code, n] of Object.entries(byCode)) console.log(`  excluded ${String(n).padStart(3)}  ${code}`);
  for (const e of excluded) console.log(`  - ${e.code}: ${e.title} — ${e.detail}`);

  let wanted = selected;
  if (args.select) {
    const want = new Set(args.select.split(",").map((s) => s.trim()).filter(Boolean));
    wanted = wanted.filter((s) => want.has(String(s.row.guid)));
  }
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1) {
      console.error(`FATAL: --limit must be a positive integer (got ${JSON.stringify(args.limit)})`);
      process.exit(1);
    }
    wanted = wanted.slice(0, args.limit);
  }
  if (!wanted.length) {
    console.error("FATAL: no episode survived --select/--limit, so there is nothing to prepare");
    process.exit(1);
  }

  /* The DAI verdict is a property of the SHOW, so it is resolved once and
     refused once. A batch whose episodes would carry `dai_suspected: null` has
     no honest value to write: `false` waives ADR-0007's anchor requirement on
     no evidence, and `true` claims a measurement nobody took. */
  const dai = daiIndex();
  const showMeta = dai.get(String(args.show)) || {};
  if (typeof showMeta.dai !== "boolean") {
    console.error(
      `FATAL: no DAI verdict for show "${args.show}" in data/dai-classification.json, ` +
        "data/transcript-availability.json or data/breadth-transcript-yield.json — refusing to write a batch " +
        "that would claim dai_suspected on no evidence (ADR-0007)"
    );
    process.exit(1);
  }
  console.log(`  dai_suspected=${showMeta.dai} via ${showMeta.dai_source}`);

  const dir = process.env.TRANSCRIPTS_DIR ? resolvePath(process.cwd(), process.env.TRANSCRIPTS_DIR) : join(ROOT, "data-local", "transcripts");
  const index = transcriptIndex(dir, args.show);
  const ids = mintItemIds(wanted.map((s) => s.row), { prefix: args.idPrefix });

  const episodes = [];
  for (const { row } of wanted) {
    const entry = index.get(String(row.guid));
    if (!entry) {
      console.warn(`  ! no transcript body on disk for ${row.guid} (${row.title}) — skipped`);
      continue;
    }
    const raw = rawBodyFor(entry);
    if (!raw) {
      console.warn(`  ! no raw transcript file for ${row.guid} — skipped`);
      continue;
    }
    episodes.push({
      item_id: ids.get(row.guid),
      show_id: row.show_id,
      show_title: row.show_title,
      title: row.title,
      guid: row.guid,
      reference_duration_sec: row.feed_duration_sec,
      /* Already proven boolean above; never coerced. */
      dai_suspected: showMeta.dai,
      transcript_source: "publisher",
      mime_type: raw.mime,
      body: raw.body,
      enclosure_url: row.enclosure_url,
      transcript_url: row.transcript_url,
      transcript_sha256: row.sha256,
      feed_url: showMeta.feed_url || null,
      /* The measured ratio, when one exists, beats anything the operator typed. */
      ad_free_ratio: showMeta.ad_free_ratio ?? args.adFreeRatio,
      cues: cuesFor(entry),
    });
  }

  const batch = buildBatch({ batchId: args.batchId, episodes });
  writeFileSync(resolvePath(process.cwd(), args.out), JSON.stringify(batch, null, 2) + "\n");
  console.log(`wrote ${args.out} — ${episodes.length} episode(s)`);

  if (args.sourcesOut) {
    writeFileSync(resolvePath(process.cwd(), args.sourcesOut), JSON.stringify(buildSources(episodes), null, 2) + "\n");
    console.log(`wrote ${args.sourcesOut}`);
  }
  if (args.render) {
    const outDir = resolvePath(process.cwd(), args.render);
    mkdirSync(outDir, { recursive: true });
    for (const e of episodes) {
      const header = `# ${e.show_title} — ${e.title}\nitem_id: ${e.item_id}\nreference_duration_sec: ${e.reference_duration_sec}\ncues: ${e.cues.length}`;
      writeFileSync(join(outDir, `${e.item_id}.txt`), renderTranscript(e.cues, { header }));
    }
    console.log(`rendered ${episodes.length} transcript(s) into ${args.render}`);
  }
}

function runLint(args) {
  if (!args.batch) {
    console.error("Usage: --lint <results.json> --batch <batch.json> [--write]");
    process.exit(1);
  }
  const batch = readJson(resolvePath(process.cwd(), args.batch));
  const results = readJson(resolvePath(process.cwd(), args.lint));
  const { errors, warnings, dropped, stats } = lintCandidates({ batch, results });
  if (errors.length) console.log("DROPPED:\n  " + errors.join("\n  "));
  if (warnings.length) console.log("FLAGGED:\n  " + warnings.join("\n  "));
  console.log(`LINT ${stats.candidates} candidate(s): ${stats.kept} kept, ${dropped.size} dropped, median ${stats.median_sec.toFixed(1)}s`);
  if (args.write) {
    writeFileSync(resolvePath(process.cwd(), args.lint), JSON.stringify(applyLint(results, dropped), null, 2) + "\n");
    console.log(`rewrote ${args.lint} with the dropped candidates removed`);
  }
  process.exit(errors.length && !args.write ? 1 : 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.lint) runLint(args);
  else runPrepare(args);
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
