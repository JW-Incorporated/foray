import { checkSafety } from "./safetyCheck";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";
import type { UnderstandPromptResult } from "../types/generation";

/**
 * §4.1 end to end, in the doc's mandated order: safety, then clarity, then
 * intent — "the order matters." Orchestrates `checkSafety` (synchronous,
 * free, always runs first) and a `PromptUnderstander` (clarity, then intent,
 * only reached when the prompt clears safety).
 *
 * NO PERSISTENCE, BY CONSTRUCTION (§9.4 / §4.1's "prompts are discarded"
 * ruling). This function is pure: it takes a prompt string, calls the two
 * collaborators, and returns a result — it never writes to a database, a
 * file, or any other sink. The raw prompt string lives only on the call
 * stack of the session that processes it and is never passed to anything
 * that persists. The caller (the eventual §4.0 UI/API layer) must not
 * persist it either; only the returned `intent` (when `outcome ===
 * "understood"`) may be retained, per the ruling that the structured
 * understanding feeds the next pipeline stage while the verbatim prompt does
 * not survive past this session.
 *
 * A rejected prompt short-circuits with no retry loop (§4.1: "no retry
 * loop") — the caller gets a terminal `rejected` outcome and must ask the
 * user to submit a fresh prompt, not call this function again with the same
 * one expecting a different answer.
 *
 * A prompt needing clarification also short-circuits — never more than one
 * round (§4.1: "One round, never two"). The caller is responsible for not
 * calling this a second time on the same conversation turn; nothing here
 * tracks round count because nothing here is stateful.
 */
export async function understandPrompt(
  prompt: string,
  understander: PromptUnderstander,
  ctx: PromptUnderstandContext
): Promise<UnderstandPromptResult> {
  const safety = checkSafety(prompt);
  if (!safety.allowed) {
    // Both are non-null together on a rejection — checkSafety's contract.
    return {
      outcome: "rejected",
      rejection: { category: safety.category!, explanation: safety.explanation! }
    };
  }

  const clarity = await understander.assessClarity(prompt, ctx);
  if (clarity.ambiguous) {
    return {
      outcome: "needs_clarification",
      clarification: {
        question: clarity.question ?? "Could you say more about what you mean — or something else?",
        readings: clarity.readings
      }
    };
  }

  const intent = await understander.extractIntent(prompt, ctx);
  return { outcome: "understood", intent };
}
