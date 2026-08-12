/* Segment batch merge — STATIC machinery (committed, never regenerated),
   keyless, no LLM. Track A of epic #102, issue #106; schema per
   docs/adr/0007-segment-anchoring.md (accepted 2026-08-11).

   Reads one batch INPUT file (episode metadata + the transcript the extractor
   was given) plus the matching agent-authored RESULTS file, validates every
   candidate segment hard, and merges the survivors into data/segments.json.

   Same posture as tools/classify/merge-results.mjs, which is the proven shape:
   VALIDATE HARD, REJECT RATHER THAN REPAIR, LEAVE THE RECORD UNTOUCHED on a
   violation, IDEMPOTENT on a re-run. That validator caught a real copy-rule
   violation in its own hand-written fixtures; this one exists before any
   extraction runs for exactly that reason — an army running for a day against
   a missing validator produces a day of data nobody can trust and nobody wants
   to hand-audit.

   THE CHECK THAT MATTERS. An anchor is the durable half of a segment boundary
   (ADR-0007): timestamps are a cache scoped to one copy of one file, the
   anchor is a claim about content. An LLM that paraphrases an anchor produces
   a boundary that can never be resolved, and it FAILS SILENTLY AT PLAYBACK —
   nothing throws, the seek policy just degrades to `approximate` forever and
   the segment is skipped. There is no later moment at which that gets caught,
   which is why it is check #1 here and why it rejects rather than repairs.

   WHAT COUNTS AS VERBATIM — the anchor-matching rule, and why.

   Both sides are canonicalised (see `canonical()`) and compared as a WHOLE-WORD
   SUBSEQUENCE: every word of the anchor, in order, with nothing added, dropped
   or substituted. Canonicalisation is deliberately narrow — it forgives only
   the differences that are artefacts of *how text was written down*, never the
   differences that are artefacts of *someone rewriting it*:

     forgiven                          | rejected
     ----------------------------------|---------------------------------------
     case ("So the" / "so the")         | any word changed, added or dropped
     double / newline / tab whitespace  | reordering
     punctuation, incl. hyphens and     | "that is" for "that's" (a word added)
       em-dashes ("hand-waving" ==      | "30 years" for "thirty years"
       "hand waving")                   | synonyms, tense, plurals
     smart vs straight apostrophes      | truncation to fewer than
     apostrophe elision ("that's" ==      MIN_ANCHOR_WORDS words
       "thats")                         | a match nowhere near the claimed time
     NFKC width/ligature variants       |

   The two decisions inside that worth naming:

   - Punctuation becomes a SPACE, not nothing, so `hand-waving` and
     `hand waving` agree — a transcript's hyphenation is a caption-writer's
     choice. Apostrophes are the one exception and are DELETED, so `that's` and
     `thats` agree instead of becoming `that s`. Getting this backwards is the
     easy bug: it would either reject every contraction or silently accept
     `handwaving` as `hand waving`.
   - Digits are NOT spelled out and words are NOT stemmed. "30" for "thirty" is
     a rewrite of what was said; a resolver searching the listener's own
     transcript would miss it exactly as this check does. Matching what the
     resolver can actually find is the whole point.

   Whole-word matching (not raw substring) is what stops a short anchor
   resolving inside a longer word — `the tok` must not match `tokamak`.

   TWO GUARDS ON TOP OF VERBATIM-NESS, both cheap once the transcript is
   indexed and both catching a boundary that is unresolvable in practice:
   an anchor shorter than MIN_ANCHOR_WORDS words (ADR-0007 asks for 8-12; four
   is the floor below which a phrase is not a location), and an anchor whose
   only occurrences are nowhere near the timestamp it claims (see
   ANCHOR_TIME_TOLERANCE_SEC). An anchor that resolves twenty minutes from its
   own start_sec means the timeline cache is junk even though the words are
   real.

   ANCHORS AND DAI (ADR-0007's relaxation of #65's hard rule). #65 rejected any
   segment on a `dai_suspected` item outright. ADR-0007 replaces that with: a
   DAI source is permitted if and only if both anchors are present and
   non-empty — that is a hard reject here. Non-DAI sources "may omit anchors,
   but should not" (ADR-0007, Decision), so an omitted anchor there is not a
   rejection; it is merged with `needs_review: true` and a note, because a
   publisher can re-upload a static file too and that segment will rot. An
   anchor that is PRESENT is always checked, DAI or not.

   Pure module + thin CLI: everything below `mergeSegments` is I/O, so the
   validation is importable and testable without touching disk. Dependency-free
   like the rest of tools/ — no package.json, no install step, runs from a bare
   checkout in a keyless Action.

   Usage:
     node tools/segments/merge-segments.mjs --batch data-local/seg-batch-<id>.json \
       --results data-local/seg-results-<id>.json

     node tools/segments/merge-segments.mjs --check [data/segments.json]
       Schema-only validation of an existing segments file (what CI runs).
       Everything except verbatim-ness is re-checkable offline, because each
       record carries the provenance it was validated against.

   Env overrides:
     SEGMENTS_PATH   (default data/segments.json)
     TAXONOMY_PATH   (default data/taxonomy.json)                            */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import copyRules from "../../backend/src/copy/rules.js";
import { normalize } from "./transcript-normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { BANNED, wordCount, MAX_WHY_LINE_WORDS } = copyRules;

export const SEGMENTS_VERSION = 1;

/** Which transcript the anchors were authored against. It is provenance, not
    an agent choice: an anchor is only verbatim with respect to one transcript,
    and A13 needs to know which one before it re-resolves anything. */
export const TRANSCRIPT_SOURCES = new Set(["publisher", "asr-local"]);

export const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

/** Below this an anchor stops being a location. ADR-0007 asks the extractor
    for 8-12 words; four is the floor at which we refuse, so a slightly terse
    anchor is not rejected for style. */
export const MIN_ANCHOR_WORDS = 4;

/** How far an anchor may resolve from the timestamp it claims. Generous on
    purpose — cue granularity is seconds and the token inherits its cue's time
    — so this only fires when the timeline cache is genuinely wrong. */
export const ANCHOR_TIME_TOLERANCE_SEC = 120;

/* ----------------------------------------------------------- canonical form */

/** Every apostrophe variant a transcript ships: ASCII, curly, modifier letter,
    prime, backtick, acute. Deleted rather than spaced — see the header. */
const APOSTROPHES = /['‘’ʼʹ′`´]/gu;

/**
 * Canonical form for anchor comparison: lowercase, NFKC, apostrophes elided,
 * every other non-alphanumeric run collapsed to a single space.
 *
 * Forgives how text was written down; never forgives a rewrite. See the header
 * for the full rule and the reasoning behind the two odd bits (punctuation
 * becomes a space, apostrophes become nothing).
 */
export function canonical(text) {
  return String(text == null ? "" : text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function canonicalWords(text) {
  const c = canonical(text);
  return c ? c.split(" ") : [];
}

/**
 * Index a normalised cue list for whole-word anchor search.
 *
 * Cues are flattened into one token stream — an anchor legitimately straddles
 * a cue boundary, and a per-cue search would miss exactly the anchors the
 * extractor is most likely to choose. Each token keeps the start/end of the
 * cue it came from; that is the resolution a caption format can express.
 */
export function buildTranscriptIndex(cues) {
  const tokens = [];
  const startTimes = [];
  const endTimes = [];
  for (const cue of cues || []) {
    const start = Number(cue?.start_sec);
    const end = Number(cue?.end_sec);
    for (const w of canonicalWords(cue?.text)) {
      tokens.push(w);
      startTimes.push(Number.isFinite(start) ? start : 0);
      endTimes.push(Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0);
    }
  }
  // First-token postings list: an episode transcript is ~8k tokens and a batch
  // holds many segments, so the naive scan is worth avoiding for free.
  const first = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const at = first.get(tokens[i]);
    if (at) at.push(i);
    else first.set(tokens[i], [i]);
  }
  return { tokens, startTimes, endTimes, first };
}

/**
 * Every place an anchor occurs, verbatim, in an indexed transcript.
 *
 * @returns {{words: string[], occurrences: Array<{start_sec: number, end_sec: number}>}}
 */
export function findAnchorOccurrences(index, anchorText) {
  const words = canonicalWords(anchorText);
  const occurrences = [];
  if (!words.length || !index || !index.tokens.length) return { words, occurrences };

  for (const i of index.first.get(words[0]) || []) {
    if (i + words.length > index.tokens.length) continue;
    let ok = true;
    for (let j = 1; j < words.length; j += 1) {
      if (index.tokens[i + j] !== words[j]) {
        ok = false;
        break;
      }
    }
    if (ok) occurrences.push({ start_sec: index.startTimes[i], end_sec: index.endTimes[i + words.length - 1] });
  }
  return { words, occurrences };
}

/* -------------------------------------------------------------- validation */

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Copy rules on the one Foray-authored string a segment carries. Imported
    from backend/src/copy/rules.js, never reimplemented — `deep dive` is banned
    and trips on segment prose more than anyone expects. */
function copyErrors(label, text) {
  const errors = [];
  if (!isNonEmptyString(text)) {
    errors.push(`${label}: missing`);
    return errors;
  }
  const words = wordCount(text);
  if (words > MAX_WHY_LINE_WORDS) errors.push(`${label}: ${words} words > ${MAX_WHY_LINE_WORDS}`);
  for (const rx of BANNED) {
    if (rx.test(text)) errors.push(`${label}: banned phrase ${rx}`);
  }
  return errors;
}

/** Stable, derivable id. Deriving rather than trusting the agent is what makes
    a re-run of the same batch land on the same records instead of duplicating
    them, and it makes two segments claiming the same boundary a detectable
    collision instead of two rows. */
export function segmentId(itemId, startSec) {
  return `${itemId}#${Math.round(startSec)}`;
}

/**
 * Validate one agent-authored segment against its episode and transcript.
 *
 * Collects every error rather than failing fast: an agent re-run is expensive,
 * and a report listing one problem at a time wastes a whole pass per problem.
 *
 * @returns {{ok: boolean, segment: object|null, errors: string[], notes: string[]}}
 */
export function validateSegment(raw, ctx) {
  const { itemId, episode, index, taxonomyNodeIds, batchId, source } = ctx;
  const errors = [];
  const notes = [];
  const where = `${itemId}`;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, segment: null, errors: [`${where}: segment is not an object`], notes };
  }

  /* --- 2. timing. Checked before anchors only because the anchor's own
     time-proximity guard needs start_sec/end_sec to be numbers at all. */
  const startSec = raw.start_sec;
  const endSec = raw.end_sec;
  const refDuration = episode.reference_duration_sec;
  let timesUsable = true;
  if (!isFiniteNumber(startSec) || startSec < 0) {
    errors.push(`${where}: start_sec must be a number >= 0 (got ${JSON.stringify(startSec)})`);
    timesUsable = false;
  }
  if (!isFiniteNumber(endSec)) {
    errors.push(`${where}: end_sec must be a number (got ${JSON.stringify(endSec)})`);
    timesUsable = false;
  }
  if (timesUsable) {
    if (endSec <= startSec) errors.push(`${where}: end_sec (${endSec}) must be greater than start_sec (${startSec})`);
    if (endSec > refDuration) {
      errors.push(`${where}: end_sec (${endSec}) is past reference_duration_sec (${refDuration})`);
    }
    if (startSec > refDuration) {
      errors.push(`${where}: start_sec (${startSec}) is past reference_duration_sec (${refDuration})`);
    }
  }

  /* --- 4. topic must be a real taxonomy node. A topic nobody can select is a
     segment nobody will ever be shown. */
  if (!isNonEmptyString(raw.topic) || !taxonomyNodeIds.has(raw.topic)) {
    errors.push(`${where}: unknown taxonomy node ${JSON.stringify(raw.topic)}`);
  }

  /* --- 3. copy rules on `why`. */
  errors.push(...copyErrors(`${where}: why`, raw.why));

  if (!CONFIDENCE_LEVELS.has(raw.confidence)) {
    errors.push(`${where}: confidence must be one of ${[...CONFIDENCE_LEVELS].join("/")} (got ${JSON.stringify(raw.confidence)})`);
  }
  if (raw.needs_review !== undefined && typeof raw.needs_review !== "boolean") {
    errors.push(`${where}: needs_review must be boolean when present`);
  }

  /* --- 1 + 5. anchors. THE check. */
  let needsReview = raw.needs_review === true;
  const anchors = {};
  for (const [field, claimedTime] of [["start_anchor", startSec], ["end_anchor", endSec]]) {
    const value = raw[field];
    const present = isNonEmptyString(value);

    if (!present) {
      if (episode.dai_suspected) {
        // ADR-0007: a DAI source is permitted if and only if BOTH anchors are
        // present and non-empty. There is no resolvable boundary without them.
        errors.push(`${where}: ${field} is required on a dai_suspected item (ADR-0007) — got ${JSON.stringify(value)}`);
      } else {
        notes.push(`${field}: omitted on a non-DAI item; the segment rots if the publisher re-uploads`);
        needsReview = true;
      }
      anchors[field] = null;
      continue;
    }

    const { words, occurrences } = findAnchorOccurrences(index, value);
    if (words.length < MIN_ANCHOR_WORDS) {
      errors.push(`${where}: ${field} is ${words.length} word(s); at least ${MIN_ANCHOR_WORDS} are needed to locate a boundary`);
    } else if (occurrences.length === 0) {
      // The silent-failure case. Never repaired, never nearest-matched — a
      // repaired anchor is a guess presented as a quotation.
      errors.push(
        `${where}: ${field} does not appear verbatim in the ${episode.transcript_source} transcript ` +
          `(paraphrase?): ${JSON.stringify(value)}`
      );
    } else if (timesUsable) {
      const near = occurrences.some((o) => {
        const at = field === "end_anchor" ? o.end_sec : o.start_sec;
        return Math.abs(at - claimedTime) <= ANCHOR_TIME_TOLERANCE_SEC;
      });
      if (!near) {
        const at = occurrences.map((o) => Math.round(field === "end_anchor" ? o.end_sec : o.start_sec)).join(", ");
        errors.push(
          `${where}: ${field} appears in the transcript at ${at}s but the segment claims ${claimedTime}s ` +
            `(> ${ANCHOR_TIME_TOLERANCE_SEC}s away) — the timeline cache does not match the anchor`
        );
      }
      if (occurrences.length > 1) {
        notes.push(`${field}: occurs ${occurrences.length} times in this transcript; resolution is ambiguous`);
        needsReview = true;
      }
    }
    anchors[field] = String(value);
  }

  if (errors.length) return { ok: false, segment: null, errors, notes };

  // Field order is fixed so the committed file diffs cleanly.
  const segment = {
    id: segmentId(itemId, startSec),
    item_id: itemId,
    topic: raw.topic,
    start_sec: startSec,
    end_sec: endSec,
    reference_duration_sec: refDuration,
    start_anchor: anchors.start_anchor,
    end_anchor: anchors.end_anchor,
    why: raw.why.trim(),
    confidence: raw.confidence,
    transcript_source: episode.transcript_source,
    dai_suspected: episode.dai_suspected === true,
    source,
    batch_id: batchId,
    needs_review: needsReview,
  };
  if (notes.length) segment.review_notes = notes;
  return { ok: true, segment, errors, notes };
}

/** Batch-level shape. A malformed batch or results file is fatal, not
    per-segment: nothing in it can be trusted to describe the transcript the
    anchors were authored against. */
function validateEpisode(ep) {
  const errors = [];
  if (!ep || typeof ep !== "object") return ["batch episode is not an object"];
  const id = ep.item_id;
  if (!isNonEmptyString(id)) errors.push("batch episode is missing item_id");
  if (!isFiniteNumber(ep.reference_duration_sec) || ep.reference_duration_sec <= 0) {
    errors.push(`${id}: reference_duration_sec must be a positive number`);
  }
  if (typeof ep.dai_suspected !== "boolean") {
    // Same reasoning as the CI invariant on data/discover.json: a missing flag
    // reads as falsy and silently waives the anchor requirement.
    errors.push(`${id}: dai_suspected must be a boolean (a missing verdict would waive the anchor rule)`);
  }
  if (!TRANSCRIPT_SOURCES.has(ep.transcript_source)) {
    errors.push(`${id}: transcript_source must be one of ${[...TRANSCRIPT_SOURCES].join("/")}`);
  }
  return errors;
}

/**
 * Merge one validated batch into a segments document. Pure — no I/O, no clock.
 *
 * @param {object} args.batch     batch input file (episodes + transcripts)
 * @param {object} args.results   agent-authored results file
 * @param {Set<string>} args.taxonomyNodeIds
 * @param {object} [args.existing] current data/segments.json
 * @returns {{doc: object, changed: boolean, merged: number, rejected: number,
 *            unchanged: number, episodesWithNoSegments: number,
 *            errors: string[], notes: string[]}}
 */
export function mergeSegments({ batch, results, taxonomyNodeIds, existing }) {
  if (!batch || typeof batch !== "object") throw new Error("batch file is not an object");
  if (!results || typeof results !== "object") throw new Error("results file is not an object");
  if (!Array.isArray(batch.episodes)) throw new Error("batch.episodes must be an array");
  if (results.batch_id !== batch.batch_id) {
    throw new Error(
      `results.batch_id ("${results.batch_id}") does not match batch.batch_id ("${batch.batch_id}") — refusing to merge mismatched files`
    );
  }
  if (!isNonEmptyString(batch.batch_id)) throw new Error("batch.batch_id is required");

  const source = isNonEmptyString(batch.source) ? batch.source : "agent-v1";
  const authored = results.results && typeof results.results === "object" ? results.results : {};

  const prior = Array.isArray(existing?.segments) ? existing.segments : [];
  const byId = new Map(prior.map((s) => [s.id, s]));
  const before = JSON.stringify(prior);

  const errors = [];
  const notes = [];
  let merged = 0;
  let rejected = 0;
  let unchanged = 0;
  let episodesWithNoSegments = 0;

  const batchItemIds = new Set();

  for (const episode of batch.episodes) {
    const shapeErrors = validateEpisode(episode);
    if (shapeErrors.length) {
      errors.push(...shapeErrors);
      continue;
    }
    const itemId = episode.item_id;
    batchItemIds.add(itemId);

    const entry = authored[itemId];
    const authoredSegments = Array.isArray(entry) ? entry : Array.isArray(entry?.segments) ? entry.segments : null;
    if (!authoredSegments || authoredSegments.length === 0) {
      // Zero segments is a first-class, unpenalised answer: most episodes hold
      // nothing worth a Foray, and a pipeline that treats silence as failure
      // manufactures filler. Counted, never an error.
      episodesWithNoSegments += 1;
      continue;
    }

    const { cues, warnings } = normalize(episode.transcript?.body, episode.transcript?.mime_type);
    if (!cues.length) {
      // No transcript, no way to verify an anchor. Rejecting the whole episode
      // is the only honest move — merging unverified anchors is precisely the
      // silent failure this file exists to prevent.
      errors.push(
        `${itemId}: transcript produced no cues, so no anchor can be verified — ${authoredSegments.length} segment(s) rejected` +
          (warnings.length ? ` (normaliser: ${warnings.join("; ")})` : "")
      );
      rejected += authoredSegments.length;
      continue;
    }
    const index = buildTranscriptIndex(cues);

    const seenInEpisode = new Set();
    for (const raw of authoredSegments) {
      const result = validateSegment(raw, {
        itemId,
        episode,
        index,
        taxonomyNodeIds,
        batchId: batch.batch_id,
        source,
      });
      if (!result.ok) {
        rejected += 1;
        errors.push(...result.errors);
        continue; // the existing record for this id, if any, is left untouched
      }
      if (seenInEpisode.has(result.segment.id)) {
        rejected += 1;
        errors.push(`${itemId}: two segments claim the same boundary (${result.segment.id}) — both rejected`);
        byId.delete(result.segment.id);
        continue;
      }
      seenInEpisode.add(result.segment.id);

      const existingSegment = byId.get(result.segment.id);
      if (existingSegment && JSON.stringify(existingSegment) === JSON.stringify(result.segment)) {
        unchanged += 1;
      } else {
        merged += 1;
      }
      byId.set(result.segment.id, result.segment);
      notes.push(...result.notes.map((n) => `${result.segment.id}: ${n}`));
    }
  }

  for (const itemId of Object.keys(authored)) {
    if (!batchItemIds.has(itemId)) {
      errors.push(`${itemId}: authored in results but absent from the batch — no transcript to verify anchors against; skipped`);
    }
  }

  // Sorted by item then start time: a stable order is what makes the committed
  // file diff readably and a re-run byte-identical.
  const segments = [...byId.values()].sort(
    (a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : a.start_sec - b.start_sec)
  );

  // `version` first, `segments` last, everything else the file already said
  // about itself (built_at, provenance) carried through in between.
  const doc = {
    version: SEGMENTS_VERSION,
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? stripDocKeys(existing) : {}),
    segments,
  };

  return {
    doc,
    changed: JSON.stringify(segments) !== before,
    merged,
    rejected,
    unchanged,
    episodesWithNoSegments,
    errors,
    notes,
  };
}

/** Carry forward everything the existing doc says about itself except the two
    keys this function owns. */
function stripDocKeys(existing) {
  const copy = { ...existing };
  delete copy.version;
  delete copy.segments;
  return copy;
}

/**
 * Schema-only validation of a segments document. Everything except
 * verbatim-ness, which needs the transcript — each record carries the
 * provenance it was validated against so the rest is re-checkable offline,
 * which is what lets CI reject a malformed data/segments.json.
 *
 * @returns {string[]} errors, empty when the document is valid
 */
export function validateSegmentsDocument(doc, taxonomyNodeIds) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["segments document is not an object"];
  if (doc.version !== SEGMENTS_VERSION) errors.push(`version must be ${SEGMENTS_VERSION} (got ${JSON.stringify(doc.version)})`);
  if (!Array.isArray(doc.segments)) return errors.concat("segments must be an array");

  const seen = new Set();
  for (const s of doc.segments) {
    if (!s || typeof s !== "object") {
      errors.push("segment entry is not an object");
      continue;
    }
    const where = s.id || s.item_id || "<unidentified>";
    if (!isNonEmptyString(s.item_id)) errors.push(`${where}: item_id is required`);
    if (!isNonEmptyString(s.id)) errors.push(`${where}: id is required`);
    if (seen.has(s.id)) errors.push(`${where}: duplicate segment id`);
    seen.add(s.id);

    if (!isFiniteNumber(s.start_sec) || !isFiniteNumber(s.end_sec) || !isFiniteNumber(s.reference_duration_sec)) {
      errors.push(`${where}: start_sec, end_sec and reference_duration_sec must all be numbers`);
    } else {
      if (isNonEmptyString(s.item_id) && isNonEmptyString(s.id) && s.id !== segmentId(s.item_id, s.start_sec)) {
        errors.push(`${where}: id does not match its item_id + start_sec (expected ${segmentId(s.item_id, s.start_sec)})`);
      }
      if (s.start_sec < 0) errors.push(`${where}: start_sec must be >= 0`);
      if (s.end_sec <= s.start_sec) errors.push(`${where}: end_sec must be greater than start_sec`);
      if (s.end_sec > s.reference_duration_sec) errors.push(`${where}: end_sec is past reference_duration_sec`);
    }

    if (taxonomyNodeIds && !taxonomyNodeIds.has(s.topic)) errors.push(`${where}: unknown taxonomy node ${JSON.stringify(s.topic)}`);
    errors.push(...copyErrors(`${where}: why`, s.why));
    if (!CONFIDENCE_LEVELS.has(s.confidence)) errors.push(`${where}: bad confidence ${JSON.stringify(s.confidence)}`);
    if (!TRANSCRIPT_SOURCES.has(s.transcript_source)) errors.push(`${where}: bad transcript_source ${JSON.stringify(s.transcript_source)}`);
    if (typeof s.dai_suspected !== "boolean") errors.push(`${where}: dai_suspected must be boolean`);
    if (typeof s.needs_review !== "boolean") errors.push(`${where}: needs_review must be boolean`);
    if (!isNonEmptyString(s.source)) errors.push(`${where}: source is required`);
    if (!isNonEmptyString(s.batch_id)) errors.push(`${where}: batch_id is required`);

    for (const field of ["start_anchor", "end_anchor"]) {
      const v = s[field];
      if (v === null) {
        if (s.dai_suspected === true) errors.push(`${where}: ${field} is required on a dai_suspected item (ADR-0007)`);
        continue;
      }
      if (!isNonEmptyString(v)) {
        errors.push(`${where}: ${field} must be a non-empty string or null`);
      } else if (canonicalWords(v).length < MIN_ANCHOR_WORDS) {
        errors.push(`${where}: ${field} is shorter than ${MIN_ANCHOR_WORDS} words`);
      }
    }
  }
  return errors;
}

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const get = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    batchPath: get("--batch"),
    resultsPath: get("--results"),
    check: argv.includes("--check"),
    checkPath: get("--check"),
  };
}

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function taxonomyIds(path) {
  return new Set(readJson(path).nodes.map((n) => n.id));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const SEGMENTS_PATH = envPath("SEGMENTS_PATH", ["data", "segments.json"]);
  const TAXONOMY_PATH = envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]);

  if (args.check) {
    const path = args.checkPath && !args.checkPath.startsWith("--") ? resolvePath(process.cwd(), args.checkPath) : SEGMENTS_PATH;
    if (!existsSync(path)) {
      console.error(`FATAL: ${path} does not exist.`);
      process.exit(1);
    }
    const errors = validateSegmentsDocument(readJson(path), taxonomyIds(TAXONOMY_PATH));
    if (errors.length) {
      console.error(`INVALID ${path}:\n  ` + errors.join("\n  "));
      process.exit(1);
    }
    const doc = readJson(path);
    console.log(`ok ${path} — ${doc.segments.length} segment(s), schema v${doc.version}`);
    return;
  }

  if (!args.batchPath || !args.resultsPath) {
    console.error(
      "Usage: node tools/segments/merge-segments.mjs --batch <path> --results <path>\n" +
        "       node tools/segments/merge-segments.mjs --check [segments.json]"
    );
    process.exit(1);
  }

  const batch = readJson(resolvePath(process.cwd(), args.batchPath));
  const results = readJson(resolvePath(process.cwd(), args.resultsPath));
  const existing = existsSync(SEGMENTS_PATH) ? readJson(SEGMENTS_PATH) : { version: SEGMENTS_VERSION, segments: [] };

  let outcome;
  try {
    outcome = mergeSegments({ batch, results, taxonomyNodeIds: taxonomyIds(TAXONOMY_PATH), existing });
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  if (outcome.errors.length) console.warn("REJECTED:\n  " + outcome.errors.join("\n  "));
  if (outcome.notes.length) console.warn("FLAGGED (needs_review):\n  " + outcome.notes.join("\n  "));

  if (outcome.changed) {
    outcome.doc.built_at = new Date().toISOString();
    outcome.doc.provenance = {
      produced_by: "tools/segments/merge-segments.mjs",
      method: "Claude Code segment-extraction agent (Max-plan routine) — see docs/curation/segment-extraction-pipeline.md",
      schema: "docs/adr/0007-segment-anchoring.md",
      last_batch_id: batch.batch_id,
    };
    writeFileSync(SEGMENTS_PATH, JSON.stringify(outcome.doc, null, 2) + "\n");
  } else {
    // Nothing changed, so nothing is written — not even a fresh built_at.
    // "Re-running the same batch changes nothing" has to mean the bytes.
    console.log("no change — segments file left untouched");
  }

  console.log(
    `MERGED ${outcome.merged} segment(s). ${outcome.unchanged} unchanged, ${outcome.rejected} rejected, ` +
      `${outcome.episodesWithNoSegments} episode(s) yielded none.`
  );
  console.log(`SEGMENT_MERGE_COMPLETE: batch_id=${batch.batch_id} merged=${outcome.merged} rejected=${outcome.rejected}`);
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
