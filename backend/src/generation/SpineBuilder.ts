import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import type { DurationTier, Spine } from "../types/spine";

/**
 * §4.3's LLM collaborator, behind the same stub/real-provider split as
 * every other generation-stage collaborator (`PromptUnderstander`,
 * `ExternalResearcher`): cheap, deterministic dry-run by default; a real
 * LLM call only when ANTHROPIC_API_KEY is configured. Every call MUST
 * route through the budget guard (src/cost/budgetGuard.ts).
 *
 * Deliberately a SINGLE call per Foray (§5's topology table: "1, always"
 * for this stage) — there is no per-act or per-beat method on this
 * interface, because splitting spine construction across calls is exactly
 * the "actively destructive" parallelism §5 warns against.
 */
export interface SpineBuilder {
  readonly providerName: string;

  /**
   * Produces the raw spine (acts, slots, beats, voice, exploration marks)
   * from §4.1's intent, §4.2's research shape, and the requested duration
   * tier. Does NOT itself guarantee the result passes `validateSpine` —
   * see `buildSpine.ts`, which calls this and then validates the output;
   * a builder is expected to aim for the tier's budget but the validator
   * is the actual gate.
   */
  buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine>;
}

export interface SpineBuildContext {
  userId: string;
  sessionId?: string;
  /**
   * F-86: present when this call is a RE-ASK — the previous reply failed the
   * structural gate (`spineStructure.ts`, F-13) and `buildSpine.ts` is asking
   * once more with the violations named. A builder that honours it re-sends its
   * own prompt, the previous reply, and one "fix only these" turn, so the model
   * keeps everything the gate did not refuse; a builder that ignores it simply
   * produces a fresh spine, which the gate judges the same way. Absent on every
   * first call.
   */
  revision?: SpineRevisionRequest;
}

/** F-86: what a re-ask carries — see `SpineBuildContext.revision`. */
export interface SpineRevisionRequest {
  /** The reply the gate refused, already schema-parsed. */
  previous: Spine;
  /** The gate's messages, verbatim — each names the act, the slot and the beat. */
  violations: string[];
  /** 1-based: the first re-ask is 1. */
  attempt: number;
}
