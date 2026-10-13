import { checkSafety } from "./safetyCheck";
import { preSpineIntent } from "./preSpineIntent";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";
import type { ClarityDecider, UnderstandPromptResult } from "../types/generation";

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
  const gate = await safetyThenClarity(prompt, understander, ctx);
  if ("stop" in gate) return gate.stop;
  const decided = gate.decided;

  const intent = await understander.extractIntent(prompt, ctx);
  return { outcome: "understood", intent, ...decided };
}

/**
 * GV-67 (W4-03): §4.1 on the folded path (`flags.foldSpineCopy`). Safety,
 * then clarity, in the same order and with the same outcomes as
 * `understandPrompt`, and then NO extractIntent call (and so no title
 * re-case call): the intent is `preSpineIntent(prompt)`, the prompt's
 * sourcing keywords, and the spine writes the subject, angle, title and
 * summary later from the listener's own words.
 *
 * Same no-persistence rule as `understandPrompt`: the returned intent holds a
 * keyword list, never the prompt verbatim.
 */
export async function understandPromptFast(
  prompt: string,
  understander: PromptUnderstander,
  ctx: PromptUnderstandContext
): Promise<UnderstandPromptResult> {
  const gate = await safetyThenClarity(prompt, understander, ctx);
  if ("stop" in gate) return gate.stop;
  const decided = gate.decided;
  return { outcome: "understood", intent: preSpineIntent(prompt), ...decided };
}

/** Safety, then clarity: the half of §4.1 both paths share. Either the
 * terminal outcome (rejected, or needs clarification) or, for a clear
 * prompt, the clarity provenance to carry onto the understood result. */
async function safetyThenClarity(
  prompt: string,
  understander: PromptUnderstander,
  ctx: PromptUnderstandContext
): Promise<{ stop: UnderstandPromptResult } | { decided: { clarityDecidedBy?: ClarityDecider } }> {
  const safety = checkSafety(prompt);
  if (!safety.allowed) {
    // Both are non-null together on a rejection — checkSafety's contract.
    return {
      stop: {
        outcome: "rejected",
        rejection: { category: safety.category!, explanation: safety.explanation! }
      }
    };
  }

  const clarity = await understander.assessClarity(prompt, ctx);
  /* GV-49: who decided the clarity verdict, carried only when the
     understander said (a 'jev' clarity route); every other understander
     leaves it unset, so the result is exactly what it was. */
  const decided = clarity.decidedBy !== undefined ? { clarityDecidedBy: clarity.decidedBy } : {};
  if (clarity.ambiguous) {
    return {
      stop: {
        outcome: "needs_clarification",
        clarification: {
          question: clarity.question ?? "Could you say more about what you mean — or something else?",
          readings: clarity.readings
        },
        ...decided
      }
    };
  }
  return { decided };
}
