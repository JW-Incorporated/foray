import * as fs from "fs";
import * as path from "path";
import { tokenizeForCatalogueQuery } from "./catalogueLookup";

/**
 * §4.5 tier-1 lookup: a deterministic (non-LLM) matcher against the
 * existing, already-anchored `data/segments.json` pool (212 segments
 * over 64 sources per docs/curation/segment-extraction-pipeline.md §4).
 * This is the "cheapest possible hit" §4.5's search order names first.
 *
 * §4.5's task brief explicitly asks: check whether
 * `backend/src/generation/catalogueLookup.ts`'s existing matching is
 * reusable before building something new. It is NOT directly reusable —
 * `matchConceptsInText`/`queryTapeAvailability` match against
 * `data/discover.json` catalogue items (title/hook/tags), which is a
 * DIFFERENT file with a different shape than `data/segments.json`'s
 * `topic`/`why`/`start_anchor`/`end_anchor` fields. What IS reused is the
 * shared word-tokenizing approach (`tokenizeForCatalogueQuery`) so a
 * beat's claim is scored against segment text with the same rule used
 * elsewhere in this pipeline, rather than inventing a second tokenizer.
 *
 * Deliberately keyless and LLM-free: a scored, thresholded overlap is
 * the WHOLE tier-1 mechanism, per the task brief's own preference
 * ("prefer a deterministic scorer with a confidence threshold over
 * calling out to the LLM"). No LLM call exists in this module at all.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface SegmentRecord {
  id: string;
  item_id: string;
  topic: string;
  start_sec: number;
  end_sec: number;
  reference_duration_sec: number;
  start_anchor: string;
  end_anchor: string;
  why: string;
  confidence: "high" | "medium" | "low";
  transcript_source?: string;
  dai_suspected?: boolean;
  source?: string;
  batch_id?: string;
  needs_review?: boolean;
}

let cachedSegments: SegmentRecord[] | null = null;

/** Reads `data/segments.json` fresh from disk, cached per-process (same
 * cache-bust convention as `catalogueLookup.ts`'s
 * `loadCatalogueData` — `FORAY_SKIP_CATALOGUE_CACHE=1` disables it). */
export function loadSegmentPool(): SegmentRecord[] {
  if (cachedSegments && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cachedSegments;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path, not external input.
  const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "segments.json"), "utf8");
  const parsed = JSON.parse(raw) as { segments?: SegmentRecord[] };
  cachedSegments = parsed.segments ?? [];
  return cachedSegments;
}

export interface SegmentMatch {
  segment: SegmentRecord;
  score: number;
}

/** Below this token-overlap score a "match" is not trustworthy enough to
 * resolve tier 1 — the beat falls through to tier 2. Deliberately a
 * small positive integer (shared-token COUNT, not a normalized ratio):
 * segment `why` lines are short (copy rules cap them at 18 words) so a
 * ratio would be noisy at this length, and a raw count of 2+ shared
 * non-stopword tokens between a beat's claim and a segment's own
 * topic/why/anchor text is a real, checkable signal a false positive is
 * unlikely to clear by chance. */
export const TIER1_MATCH_THRESHOLD = 2;

/** Scores every segment in `pool` against `claimText`'s tokens by
 * overlap count against the segment's combined topic + why + anchor
 * text (all fields a beat's claim could plausibly echo), highest first.
 */
export function scoreSegmentsAgainstClaim(claimText: string, pool: SegmentRecord[]): SegmentMatch[] {
  const claimTokens = new Set(tokenizeForCatalogueQuery(claimText));
  if (claimTokens.size === 0) return [];

  const scored: SegmentMatch[] = [];
  for (const segment of pool) {
    const haystack = [segment.topic, segment.why, segment.start_anchor, segment.end_anchor].join(" ");
    const haystackTokens = new Set(tokenizeForCatalogueQuery(haystack));
    let score = 0;
    for (const t of claimTokens) {
      if (haystackTokens.has(t)) score += 1;
    }
    if (score > 0) scored.push({ segment, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** The tier-1 decision: best match if it clears `TIER1_MATCH_THRESHOLD`,
 * else `null` (fall through to tier 2). */
export function findTier1Match(
  claimText: string,
  pool: SegmentRecord[] = loadSegmentPool(),
  isUsable: (segment: SegmentRecord) => boolean = () => true
): SegmentMatch | null {
  /* WHY THE CALLER GETS A VETO, AND WHY IT IS APPLIED INSIDE THE SEARCH.
     Scoring is per-claim and stateless, so nothing here knows what the rest of
     the Foray has already committed to. Two constraints in `check-forays.mjs`
     are about the Foray as a whole, and the first end-to-end run of the
     pipeline failed on both:

       - a segment may not play twice ("appears twice in one Foray");
       - segments from the SAME episode must play in ascending time order
         (M3: "plays at 1964.16 s ... after a later segment from the same
         episode"), because a Foray that jumps backwards inside one episode
         reads as a mistake to a listener.

     Filtering at the call site would only ever inspect the top hit and then
     give up, degrading a beat to narration whenever its best segment happened
     to be spoken for. Applying the veto INSIDE the ranked walk lets the search
     fall through to the next candidate that still clears the threshold, so the
     beat keeps real tape. When nothing usable clears the bar the answer is a
     genuine null and §4.5's guardrail takes over: a beat's existence never
     depends on tape. */
  const scored = scoreSegmentsAgainstClaim(claimText, pool);
  for (const candidate of scored) {
    if (candidate.score < TIER1_MATCH_THRESHOLD) return null; // ranked: nothing later can clear it
    if (isUsable(candidate.segment)) return candidate;
  }
  return null;
}

