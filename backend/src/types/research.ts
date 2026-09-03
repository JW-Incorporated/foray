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
  externallyResearched: z.boolean()
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
