import type { ClarityResult, IntentUnderstanding } from "../types/generation";

/**
 * §4.1's "then clarity" / "then intent" steps, behind the same
 * stub/real-provider split as `Enricher` (backend/src/enrich/Enricher.ts) —
 * cheap, deterministic dry-run by default; a real LLM call only when
 * ANTHROPIC_API_KEY is configured. Every call MUST route through the budget
 * guard (src/cost/budgetGuard.ts), exactly like Enricher's contract.
 *
 * Safety is deliberately NOT part of this interface: `checkSafety()` in
 * safetyCheck.ts is synchronous, free, and runs before either method here is
 * ever called (see `understandPrompt.ts`), per §4.1's "safety first, before
 * spending anything" ordering.
 */
export interface PromptUnderstander {
  readonly providerName: string;

  /** §4.1 "then clarity". Decides whether the prompt is genuinely ambiguous
   * and, if so, produces exactly one question with 2-3 concrete readings.
   * The doc's own bar: "'Roman siege weapons' is not ambiguous. 'Mercury' is." */
  assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult>;

  /** §4.1 "then intent". Only called once the prompt is judged unambiguous
   * (or the caller supplies the listener's chosen reading in place of the
   * original prompt). Produces the structured understanding that feeds §4.2. */
  extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding>;
}

export interface PromptUnderstandContext {
  userId: string;
  sessionId?: string;
}
