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
}
