import { z } from "zod";

/**
 * §4.2 research-shape types (docs/curation/generation-architecture.md §4.2).
 * Output of the research stage that feeds §4.3 (spine building) as its
 * input. "Enough research to know what the acts are, not enough to write
 * them" — this is a MAP, not a spine: candidate sub-topics, a tape-
 * availability signal for each (never a filter — §4.2's explicit
 * guardrail), known controversies, and anything external research
 * surfaced that the catalogue could not answer.
 */

export const TapeSignalSchema = z.enum(["none", "thin", "moderate", "strong"]);
export type TapeSignal = z.infer<typeof TapeSignalSchema>;

/** How much material the LOCAL catalogue (data/discover.json,
 * data/catalog.json, data/semantic-index.json, data/item-tags.json) has for
 * one candidate sub-topic. Always computed — a "none" signal is a real,
 * informative answer, not an absence of one. */
export const TapeAvailabilitySchema = z.object({
  signal: TapeSignalSchema,
  itemCount: z.number().int().min(0),
  showCount: z.number().int().min(0),
  /** Up to 5 discover.json item ids, for a human to spot-check the signal. */
  exampleItemIds: z.array(z.string())
});
export type TapeAvailability = z.infer<typeof TapeAvailabilitySchema>;

/**
 * ONE STRETCH OF TAPE, QUOTED, UNDER A CANDIDATE SUBTOPIC (fix plan WS-L;
 * finding F-63).
 *
 * WHAT WAS MISSING. Until now §4.2 handed §4.3 concept labels and item counts —
 * "Ai (semantic-concept, tape: strong, 761 items)" — and not one line of what
 * those items SAY. So the spine was written from the model's own knowledge of
 * the subject and the tape was asked, four stages later, to illustrate claims it
 * had never been consulted on. Generation run 2 is what that costs: three
 * attempts, three different matchers, 0 tape beats of 35, on the one subject
 * this archive is richest in — every `account` beat reached real *Practical AI*
 * transcripts by text and every one was refused by the relevance floor, because
 * the 63 bodies never say `imagenet`, `hidden technical debt`, `garbage in`,
 * `feature store` or `concept drift`. The matcher was right to refuse. The
 * defect is upstream of it.
 *
 * WHAT THIS IS. The window's own sentences — what a person would hear if they
 * pressed play at `startSec` — with the episode it came from and the score the
 * search gave it. §4.3 lists these under the subtopic and writes `account`
 * beats FROM them, carrying the episode back as the beat's `seed` so §4.5 opens
 * that episode first (`types/spine.ts`'s `BeatSeedSchema`).
 *
 * It is EVIDENCE, never a filter: a subtopic with no windows keeps its full
 * entry in the map exactly as a subtopic with no tape does (§4.2's guardrail),
 * and `windowsUnavailable` says why the list is empty rather than leaving a
 * reader to guess between "nothing was searched" and "nothing was found".
 */
export const ResearchTapeWindowSchema = z.object({
  /** `sourceBeats.ts:deriveItemId`'s id for the episode — the same string a
   * tier-2 pointer's `itemId` carries, so a seed can be matched back to the
   * archive row it names. */
  episodeId: z.string().min(1),
  showTitle: z.string(),
  episodeTitle: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  /** The cues spoken between those two times, joined, trimmed to a sentence
   * boundary under `RESEARCH_TAPE_WINDOW_MAX_CHARS`. The tape's own words —
   * nothing here is generated. */
  text: z.string().min(1),
  /** The window's idf-weighted overlap with the subtopic's terms
   * (`selectTapeWindow`'s own score). Comparable within one subtopic's list,
   * which is all the ranking it is used for. */
  score: z.number()
});
export type ResearchTapeWindow = z.infer<typeof ResearchTapeWindowSchema>;

/** One candidate sub-topic/angle in the research map. */
export const SubtopicCandidateSchema = z.object({
  label: z.string().min(1),
  /** "semantic-concept": matched a data/semantic-index.json concept (the
   * catalogue's own taxonomy already names this sub-topic). "literal-term":
   * no concept matched, so the intent's own wording became the candidate —
   * this is how a genuinely tape-less direction still gets a subtopic entry
   * rather than being silently dropped (§4.2's guardrail). */
  source: z.enum(["semantic-concept", "literal-term"]),
  tape: TapeAvailabilitySchema,
  /** Contested points external research surfaced. Empty (not null) when this
   * subtopic was never externally researched, distinct from "researched and
   * found no controversy" — see `externallyResearched`. */
  controversies: z.array(z.string()),
  /** Free-text external-research summary, or null if this subtopic had
   * catalogue tape and external research was never invoked (the cheap-first
   * ordering — see researchShape.ts). */
  externalNotes: z.string().nullable(),
  /** True only when the external researcher was actually called for this
   * subtopic (tape.signal === "none" at query time). */
  externallyResearched: z.boolean(),
  /**
   * What the tape says about this subtopic (WS-L, F-63) — the top
   * `RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC` windows, best first, at most one per
   * episode.
   *
   * DEFAULTED RATHER THAN REQUIRED, like every other field added to a
   * checkpointed schema on this branch: a research-shape checkpoint written
   * before WS-L still parses on resume, and resumes to a map with no windows —
   * which is exactly what it was.
   */
  tapeWindows: z.array(ResearchTapeWindowSchema).default([]),
  /**
   * Why `tapeWindows` is empty, or null when it is not. Four honest answers,
   * and the distinction between them is the point: no text index on this
   * machine (CI, a fresh checkout — the Null provider), a tape signal too thin
   * to be worth searching, no lineage-admissible episode the index would open,
   * or no transcript body for the episodes it ranked.
   */
  windowsUnavailable: z.string().nullable().default(null)
});
export type SubtopicCandidate = z.infer<typeof SubtopicCandidateSchema>;

export const ResearchShapeSchema = z.object({
  subject: z.string(),
  angle: z.string(),
  generatedAt: z.string(),
  subtopics: z.array(SubtopicCandidateSchema).min(1),
  /** Carried through from §4.1's intent.angle — the non-obvious angle is
   * decided at the understand-prompt stage; this stage does not invent a
   * new one, only reports the tape/controversy landscape around it. */
  nonObviousAngle: z.string().nullable(),
  /** Labels of subtopics that actually triggered an external-research call
   * (empty when the catalogue answered everything) — the caller-visible
   * proof that external research only fires for genuine gaps. */
  externalGapsResearched: z.array(z.string())
});
export type ResearchShape = z.infer<typeof ResearchShapeSchema>;
