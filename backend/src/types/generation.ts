import { z } from "zod";

/**
 * Generation pipeline types (docs/curation/generation-architecture.md §3-4.1).
 * §4.0-4.1 only: prompt capture, safety, clarify, intent. Nothing here
 * persists the raw prompt — see §9.4's ruling, enforced structurally by
 * `understandPrompt.ts` never writing to any sink.
 */

/** A generation request, exactly §3's shape. Phase 1: `author_id` is always a
 * founder, but the field is real from day one (§1.3) so phase 2 is a
 * permission change, not a rewrite. */
export const GenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be empty"),
  duration: z.enum(["short", "medium", "long"]),
  author_id: z.string().trim().min(1, "author_id must not be empty"),
  visibility: z.literal("catalogue")
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

/** §4.1's three forbidden categories, verbatim from the doc. */
export const SAFETY_CATEGORIES = [
  "sexual-content-minors",
  "mass-casualty-weapons",
  "targeted-harassment"
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export const SafetyVerdictSchema = z.object({
  allowed: z.boolean(),
  category: z.enum(SAFETY_CATEGORIES).nullable(),
  /** Plain, specific, non-preachy — per §4.1. Null when allowed. */
  explanation: z.string().nullable()
});
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;

/** §4.1's clarify step. `readings` never carries the escape hatch itself —
 * that is fixed wording appended once by whoever renders `question`. */
export const ClarityResultSchema = z.object({
  ambiguous: z.boolean(),
  readings: z.array(z.string()).max(3),
  question: z.string().nullable()
});
export type ClarityResult = z.infer<typeof ClarityResultSchema>;

/** §4.1's structured understanding. All four fields required; `disappointment`
 * is called out in the doc as weighted most heavily of the four. */
export const IntentUnderstandingSchema = z.object({
  subject: z.string().trim().min(1),
  angle: z.string().trim().min(1),
  priorKnowledge: z.string().trim().min(1),
  disappointment: z.string().trim().min(1)
});
export type IntentUnderstanding = z.infer<typeof IntentUnderstandingSchema>;

/** The end-to-end outcome of §4.1, in the doc's mandated order: safety, then
 * clarity, then intent. Exactly one of `rejection` / `clarification` / `intent`
 * is populated, matching `outcome`. */
export type UnderstandPromptResult =
  | { outcome: "rejected"; rejection: { category: SafetyCategory; explanation: string } }
  | { outcome: "needs_clarification"; clarification: { question: string; readings: string[] } }
  | { outcome: "understood"; intent: IntentUnderstanding };
