import * as fs from "fs";
import * as path from "path";
import { tokenizeForSourcing } from "./catalogueLookup";
import { claimTermWeigher, TIER2_DISTINCTIVE_WEIGHT, TIER2_WINDOW_MIN_SHARE, TIER2_WINDOW_MIN_TERMS } from "./transcriptArchiveLookup";

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
  /** WHICH TEXT the score was measured against — the segment's own transcript
   * window when the cue provider had one, else its curator-written
   * topic/why/anchor metadata. The two carry different amounts of evidence per
   * shared word, so they do not share a threshold (see `requiredOverlapFor`). */
  matchedIn: "transcript" | "metadata";
  /** How many distinct content words the CLAIM contributed — the denominator the
   * transcript-window bar is a fraction of. */
  claimTokenCount: number;
  /** The claim's content words the haystack says, in the claim's order. */
  matchedTerms: string[];
  /** The share of the claim's DISTINCTIVENESS the haystack speaks — each word
   * weighted by its corpus rarity (`claimTermWeigher`), the same number tier 2's
   * window is judged on (G-24 R2). Equals `score / claimTokenCount` when no idf
   * was supplied. */
  weightedShare: number;
  /** Those matched words the corpus considers rare for this claim
   * (`TIER2_DISTINCTIVE_WEIGHT`) — every matched word when no idf was supplied. */
  distinctiveTerms: string[];
}

/** Supplies the transcript text spoken inside a pool segment's own
 * `[start_sec, end_sec]` window, or `null` when no transcript body is on this
 * machine. Injected rather than read here so this module keeps its "reads
 * `data/segments.json` and nothing else" property: the only thing that can
 * reach a transcript body is a `TranscriptCueProvider` the caller supplies
 * (see `sourceBeats.ts`). */
export type SegmentWindowText = (segment: SegmentRecord) => string | null;

/** Below this token-overlap score a "match" is not trustworthy enough to
 * resolve tier 1 — the beat falls through to tier 2. Deliberately a
 * small positive integer (shared-token COUNT, not a normalized ratio):
 * segment `why` lines are short (copy rules cap them at 18 words) so a
 * ratio would be noisy at this length, and a raw count of 2+ shared
 * non-stopword tokens between a beat's claim and a segment's own
 * topic/why/anchor text is a real, checkable signal a false positive is
 * unlikely to clear by chance. */
export const TIER1_MATCH_THRESHOLD = 3;

/**
 * The bar for a TRANSCRIPT-WINDOW match, as a fraction of the claim's own
 * content words.
 *
 * A why-line is capped at 18 words, so three shared content words with it is a
 * strong signal. A two-minute transcript window holds two to four HUNDRED
 * words, and three of a claim's words turning up somewhere in it is close to
 * free — the same arithmetic that let a four-word run "match" an hour of tape
 * (F-24). A count bar cannot serve both haystacks, so the window's bar is
 * coverage of the claim instead: a quarter of what the claim actually says has
 * to be said in the window. On a 20-content-word claim that is five words, and
 * an unrelated window rarely carries five of them.
 */
export const TIER1_WINDOW_COVERAGE = 0.25;

/** The overlap a match must reach, given where it was measured. */
export function requiredOverlapFor(matchedIn: "transcript" | "metadata", claimTokenCount: number): number {
  if (matchedIn === "metadata") return TIER1_MATCH_THRESHOLD;
  return Math.max(TIER1_MATCH_THRESHOLD, Math.ceil(claimTokenCount * TIER1_WINDOW_COVERAGE));
}

/**
 * WHETHER A MATCH CLEARS TIER 1'S BAR — the count bar above, and, for a
 * transcript window, THE SAME WEIGHTED FLOOR TIER 2'S WINDOW FACES (G-24 R2;
 * tape-yield brief §4 cause 4).
 *
 * The coverage bar counts words with every word weighing the same, and inside
 * one subject every episode shares the trade's vocabulary (F-33): on generation
 * run 2 attempt 6 a *Causality* segment about the 1981 Hyatt Regency walkway
 * collapse cleared a 15-word agent-engineering claim's bar of 4 on
 * `engineering, good, enough, step` — four words the corpus says everywhere —
 * and played under it, the product's worst failure and run 1's
 * Chernobyl-for-Hyatt class of false positive back in the accepted set. Tier 2
 * retired that arithmetic with F-61: a window is about a claim when it speaks
 * `TIER2_WINDOW_MIN_SHARE` of the claim's DISTINCTIVENESS (idf-weighted) and
 * `TIER2_WINDOW_MIN_TERMS` of its RARE words. A pool segment's transcript
 * window is a window, and it now faces the same two conditions, with the same
 * constants — nothing here is a third floor. The count bar stays as well: it
 * is never looser than the weighted one and it is what every pre-index caller
 * measured against.
 *
 * WITHOUT AN IDF (CI, a caller with no text index) every word weighs one, so
 * the weighted share is the plain coverage and every matched word is "rare":
 * the bar is then coverage ≥ 0.35 and three shared words, which is the count
 * bar raised from a quarter to a third. A metadata match — an 18-word curator
 * note — faces only the count bar, as before: a note is not a window.
 */
export function tier1BarClears(match: SegmentMatch): boolean {
  if (match.score < requiredOverlapFor(match.matchedIn, match.claimTokenCount)) return false;
  if (match.matchedIn === "metadata") return true;
  return match.weightedShare >= TIER2_WINDOW_MIN_SHARE && match.distinctiveTerms.length >= TIER2_WINDOW_MIN_TERMS;
}

/**
 * Scores every segment in `pool` against `claimText`'s content words.
 *
 * WHAT CHANGED AFTER RUN 1 (F-06, F-29, F-33): the haystack is the segment's
 * own TRANSCRIPT WINDOW whenever `options.windowText` can supply one — the
 * words actually spoken between `start_sec` and `end_sec` — and only falls back
 * to topic/why/anchor metadata when it cannot. Matching a claim against an
 * 18-word curator note was never going to separate "this tape is about this
 * event" from "this tape is about engineering"; run 1 anchored a Kansas City
 * walkway claim to a British hearth-cooking segment on `have, one, people,
 * would`, and the patched stopword list only moved the same failure one word
 * to the left (F-33). The tape's own words are the evidence; everything else is
 * a proxy for them.
 */
export function scoreSegmentsAgainstClaim(
  claimText: string,
  pool: SegmentRecord[],
  options: { windowText?: SegmentWindowText; idf?: ReadonlyMap<string, number> } = {}
): SegmentMatch[] {
  /* In the claim's own order, deduplicated — so `matchedTerms` reads the way
     tier 2's does in a trace row. */
  const claimTerms: string[] = [];
  const claimTokens = new Set<string>();
  for (const t of tokenizeForSourcing(claimText)) {
    if (claimTokens.has(t)) continue;
    claimTokens.add(t);
    claimTerms.push(t);
  }
  if (claimTokens.size === 0) return [];
  /* G-24 R2: the corpus's rarity for each claim word, normalised exactly as
     tier 2 normalises it (`claimTermWeigher`). */
  const weightOf = claimTermWeigher(claimTerms, options.idf);
  let totalWeight = 0;
  for (const t of claimTerms) totalWeight += weightOf(t);

  const scored: SegmentMatch[] = [];
  for (const segment of pool) {
    const window = options.windowText ? options.windowText(segment) : null;
    const matchedIn: "transcript" | "metadata" = window ? "transcript" : "metadata";
    const haystack = window ?? [segment.topic, segment.why, segment.start_anchor, segment.end_anchor].join(" ");
    const haystackTokens = new Set(tokenizeForSourcing(haystack));
    const matchedTerms = claimTerms.filter((t) => haystackTokens.has(t));
    const score = matchedTerms.length;
    if (score === 0) continue;
    let matchedWeight = 0;
    for (const t of matchedTerms) matchedWeight += weightOf(t);
    scored.push({
      segment,
      score,
      matchedIn,
      claimTokenCount: claimTokens.size,
      matchedTerms,
      weightedShare: totalWeight > 0 ? matchedWeight / totalWeight : 0,
      distinctiveTerms: matchedTerms.filter((t) => weightOf(t) >= TIER2_DISTINCTIVE_WEIGHT)
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** The tier-1 decision: best match if it clears `TIER1_MATCH_THRESHOLD`,
 * else `null` (fall through to tier 2). */
export function findTier1Match(
  claimText: string,
  pool: SegmentRecord[] = loadSegmentPool(),
  isUsable: (segment: SegmentRecord) => boolean = () => true,
  options: { windowText?: SegmentWindowText; idf?: ReadonlyMap<string, number> } = {}
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
  /* The walk SKIPS a candidate under its own bar rather than stopping at the
     first one, because the two haystacks no longer share a threshold: a
     transcript-window candidate scoring 4 can be below its coverage bar while a
     lower-scoring metadata candidate is comfortably over 3. Skipping keeps the
     ranked walk honest across a mixed pool; nothing is admitted that its own
     bar would not admit. */
  const scored = scoreSegmentsAgainstClaim(claimText, pool, options);
  for (const candidate of scored) {
    if (!tier1BarClears(candidate)) continue;
    if (isUsable(candidate.segment)) return candidate;
  }
  return null;
}

