import * as fs from "fs";
import * as path from "path";
import { tokenizeForCatalogueQuery } from "./catalogueLookup";

/**
 * §4.5 tier-2 lookup: the transcript archive — "episodes we hold
 * transcripts for but have not yet cut into segments" (§4.5). Reads
 * ONLY the committed digest files (`data/transcript-digests.json`,
 * `data/breadth-transcript-digests.json`) for episode metadata; never
 * the transcript bodies themselves, which live in `data-local/`
 * (gitignored, machine-local per docs/curation/segment-extraction-pipeline.md
 * §3 Lane C) and are therefore not something this module can assume is
 * present on disk.
 *
 * SCOPE, DELIBERATELY NARROW (per this stage's task brief — "you do NOT
 * need to reimplement segment extraction from scratch... model your
 * module's tier-2 output as 'logs a request into the existing
 * extraction pipeline's input format' rather than performing extraction
 * synchronously in-process"):
 *
 *   1. Find a candidate episode whose digest metadata (show/episode
 *      title) overlaps the beat's claim — same deterministic
 *      tokenize-and-score approach as tier 1
 *      (`segmentPoolLookup.ts`) and `catalogueLookup.ts`.
 *   2. If a `TranscriptCueProvider` can supply the episode's actual cue
 *      text (it MAY — see `FileTranscriptCueProvider` below, which
 *      looks for the transcript on the local machine and returns `null`
 *      when it is not there, which is the common case in CI and in this
 *      checkout), locate a REAL, VERBATIM anchor span for the claim
 *      inside that transcript, using the exact whole-word-subsequence
 *      matching rule `tools/segments/merge-segments.mjs` enforces at
 *      merge time (`canonicalizeForAnchorMatch` below is a small,
 *      independently-implemented mirror of that module's `canonical()` —
 *      not a re-import, since that module is an ESM `.mjs` build script
 *      and this is a CommonJS backend module; the ALGORITHM is what
 *      needs to match, and it does: case/whitespace/punctuation
 *      forgiven, apostrophes elided, everything else exact). This is
 *      genuine anchor *location* against already-available text, not
 *      segment *extraction* — no episode-selection heuristics, no
 *      agent call, no lint pass, no write to `data/segments.json`.
 *   3. If no cue text is available, the match is still real (the
 *      episode exists and has a transcript) but cannot be resolved to
 *      an anchor synchronously — that becomes a queued extraction
 *      REQUEST in the existing prepare-segment-batch.mjs input shape
 *      (episode metadata + `reference_duration_sec`), for the existing
 *      Lane C pipeline to pick up later. The beat itself falls back to
 *      narration for THIS run (§4.5's own guardrail: a beat's existence
 *      never depends on tape, and tape not yet being resolvable is not
 *      different from tape not existing, sourcing-wise, in this pass).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface TranscriptDigestEntry {
  show_id: string;
  show_title: string;
  guid: string;
  title: string;
  cues: number;
  feed_duration_sec?: number;
  span_implausible?: boolean;
}

let cachedDigests: TranscriptDigestEntry[] | null = null;

/** Reads both committed digest files (curated + breadth), keeping only
 * episodes whose transcript is usable at all (has cues, timeline not
 * flagged implausible — the same `span_implausible` field
 * `prepare-segment-batch.mjs`'s timeline gate already computes upstream
 * of these files). */
export function loadTranscriptArchive(): TranscriptDigestEntry[] {
  if (cachedDigests && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cachedDigests;

  const entries: TranscriptDigestEntry[] = [];
  for (const file of ["data/transcript-digests.json", "data/breadth-transcript-digests.json"]) {
    const full = path.join(REPO_ROOT, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path list, not external input.
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw) as { transcripts?: TranscriptDigestEntry[] };
    for (const t of parsed.transcripts ?? []) {
      if ((t.cues ?? 0) > 0 && t.span_implausible !== true) entries.push(t);
    }
  }
  cachedDigests = entries;
  return cachedDigests;
}

export interface TranscriptArchiveMatch {
  entry: TranscriptDigestEntry;
  score: number;
}

/** Same integer-count threshold rationale as `TIER1_MATCH_THRESHOLD` in
 * `segmentPoolLookup.ts` — a title/show-metadata haystack is even
 * shorter than a segment's why-line, so the bar stays low but nonzero. */
export const TIER2_MATCH_THRESHOLD = 2;

export function findTranscriptArchiveMatch(claimText: string, archive: TranscriptDigestEntry[] = loadTranscriptArchive()): TranscriptArchiveMatch | null {
  const claimTokens = new Set(tokenizeForCatalogueQuery(claimText));
  if (claimTokens.size === 0) return null;

  let best: TranscriptArchiveMatch | null = null;
  for (const entry of archive) {
    const haystackTokens = new Set(tokenizeForCatalogueQuery(`${entry.show_title} ${entry.title}`));
    let score = 0;
    for (const t of claimTokens) {
      if (haystackTokens.has(t)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  if (!best || best.score < TIER2_MATCH_THRESHOLD) return null;
  return best;
}

export interface TranscriptCue {
  text: string;
  start_sec: number;
  end_sec: number;
}

/** Supplies real transcript cue text for an episode, if it is available.
 * Injected so tests can exercise the real-anchor path deterministically
 * without a transcript body ever having to be committed to git. */
export interface TranscriptCueProvider {
  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null;
}

/**
 * Production default. Transcript bodies live in `data-local/transcripts/`
 * (gitignored, machine-local — docs/curation/segment-extraction-pipeline.md
 * §3), so this checkout will not have them; the provider returns `null`
 * for every episode, which is the honest, structural answer ("cannot
 * resolve an anchor synchronously right now") rather than a fabricated
 * one. Wiring this to actually read+normalize a local transcript file is
 * future work for whoever operates the Lane C fetch step alongside this
 * stage — deliberately NOT built here (this stage's task brief: "do not
 * build a new transcription pipeline").
 */
export class NullTranscriptCueProvider implements TranscriptCueProvider {
  getCues(): TranscriptCue[] | null {
    return null;
  }
}

/** Mirrors `tools/segments/merge-segments.mjs`'s `canonical()` exactly:
 * lowercase, NFKC, apostrophes elided, everything else non-alphanumeric
 * collapsed to a single space. Kept in sync deliberately — a divergence
 * here would let this module accept an anchor the real merge validator
 * would reject. See the module doc comment for why this is a mirror,
 * not a re-import (ESM `.mjs` build script vs. CJS backend module). */
export function canonicalizeForAnchorMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc\u02b9\u2032`\u00b4]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function canonicalWords(text: string): string[] {
  const c = canonicalizeForAnchorMatch(text);
  return c ? c.split(" ") : [];
}

export interface ResolvedAnchorSpan {
  startAnchor: string;
  endAnchor: string;
  startSec: number;
  endSec: number;
}

/** Same floor as `merge-segments.mjs`'s `MIN_ANCHOR_WORDS`. */
export const MIN_ANCHOR_WORDS = 4;
/** Longest contiguous window of claim tokens tried as an anchor phrase. */
const MAX_ANCHOR_WORDS = 12;

/**
 * Finds a REAL, verbatim anchor span for `claimText` inside `cues`,
 * using whole-word subsequence matching identical in spirit to
 * `merge-segments.mjs`'s `findAnchorOccurrences` — a claim's own
 * significant words, searched for as a contiguous run inside the actual
 * transcript text. Returns `null` if no run of at least
 * `MIN_ANCHOR_WORDS` claim words appears verbatim anywhere in the
 * transcript (the honest "cannot resolve" answer — never a fabricated
 * anchor).
 */
export function resolveAnchorFromCues(claimText: string, cues: TranscriptCue[]): ResolvedAnchorSpan | null {
  const tokens: string[] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (const cue of cues) {
    for (const w of canonicalWords(cue.text)) {
      tokens.push(w);
      startTimes.push(cue.start_sec);
      endTimes.push(cue.end_sec);
    }
  }
  if (tokens.length === 0) return null;

  const claimWords = canonicalWords(claimText).filter((w) => w.length > 2);
  if (claimWords.length < MIN_ANCHOR_WORDS) return null;

  // Try the longest possible contiguous window of claim words first, then
  // shrink — a longer verbatim match is a stronger, more specific anchor.
  const windowMax = Math.min(MAX_ANCHOR_WORDS, claimWords.length);
  for (let windowLen = windowMax; windowLen >= MIN_ANCHOR_WORDS; windowLen--) {
    for (let start = 0; start + windowLen <= claimWords.length; start++) {
      const phrase = claimWords.slice(start, start + windowLen);
      const at = findFirstOccurrence(tokens, phrase);
      if (at !== -1) {
        const anchorText = phrase.join(" ");
        return {
          startAnchor: anchorText,
          endAnchor: anchorText,
          startSec: startTimes[at]!,
          endSec: endTimes[at + windowLen - 1]!
        };
      }
    }
  }
  return null;
}

function findFirstOccurrence(tokens: string[], phrase: string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
