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

/**
 * The `author_id` both generation CLIs (`generate-foray`, `generate-forays`)
 * record when no flag names one (CH2-25 / B2-14). It is the key `BudgetGuard`
 * sums the daily spend by, so the two must agree or one founder's spend is
 * split across two users. "founder-1" is the batch driver's long-standing
 * default — the CLI that spends — so its key does not move.
 */
export const DEFAULT_AUTHOR_ID = "founder-1";

/** The flag both generation CLIs read the author id from. */
export const AUTHOR_ID_FLAG = "--author-id";

/** `generate-forays`' old spelling, kept as an alias for one release so an
 * existing script does not silently change user. Remove it after that. */
export const DEPRECATED_AUTHOR_FLAG = "--author";

/**
 * Reads the author id from a generation CLI's argv: `--author-id` wins, then
 * the deprecated `--author` (with a one-line warning), then
 * `DEFAULT_AUTHOR_ID`. A flag given with no value counts as absent.
 */
export function readAuthorIdFlag(argv: readonly string[], warn: (line: string) => void = (line) => console.error(line)): string {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const authorId = get(AUTHOR_ID_FLAG);
  if (authorId !== undefined) return authorId;
  const legacy = get(DEPRECATED_AUTHOR_FLAG);
  if (legacy !== undefined) {
    warn(`${DEPRECATED_AUTHOR_FLAG} is deprecated and will be removed; use ${AUTHOR_ID_FLAG} ${legacy}`);
    return legacy;
  }
  return DEFAULT_AUTHOR_ID;
}

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
  disappointment: z.string().trim().min(1),
  /* F-64: the public copy, asked for by name. `subject` is the understander's
     working restatement of the request and has no length rule — run 2 attempt 3
     came back with a 26-word one, and `check-forays.mjs` refused the finished
     Foray for a `summary` over 18 words, 76 minutes after the sentence was
     written. `title` and `summary` are the listener-facing lines and are
     bounded (`runPipeline.ts`'s `forayCopy` clamps them regardless). Optional
     so a checkpoint or stub written before they existed still parses. */
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional()
});
export type IntentUnderstanding = z.infer<typeof IntentUnderstandingSchema>;

/** The end-to-end outcome of §4.1, in the doc's mandated order: safety, then
 * clarity, then intent. Exactly one of `rejection` / `clarification` / `intent`
 * is populated, matching `outcome`. */
export type UnderstandPromptResult =
  | { outcome: "rejected"; rejection: { category: SafetyCategory; explanation: string } }
  | { outcome: "needs_clarification"; clarification: { question: string; readings: string[] } }
  | { outcome: "understood"; intent: IntentUnderstanding };
