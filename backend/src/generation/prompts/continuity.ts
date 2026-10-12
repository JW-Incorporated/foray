import { NARRATOR_STRUCTURE_RULE } from "../../copy/narratorStructure";
import type { ContinuitySmoothRequest } from "../ContinuityBuilder";
import { joinParts, type PromptParts } from "../promptLayout";

/**
 * §4.8's act-boundary smoothing prompt, moved here from
 * AnthropicContinuityBuilder.ts by GV-32 (decision 8: prompt text moves once,
 * into prompts/*.ts; the Anthropic and Chat builders both import it).
 *
 * Layout (promptLayout.ts, W2-13): the role line, the rewrite rules,
 * NARRATOR_STRUCTURE_RULE and the reply shape are `stable`; the boundary (the
 * exit that played, the introduction to smooth, and the "keep it a real
 * introduction to <next act>" line, which names the next act) is `call`;
 * there is no `foray` part. The words are the pre-GV-32 words, reordered so
 * the rules come first.
 */

/** The continuity prompt's static half: the same bytes for every seam of every Foray. */
const CONTINUITY_STABLE = [
  `You are the continuity editor for an audio documentary ("Foray"), working ONLY at the seam between two acts.`,
  `Rewrite the next act's introduction so it genuinely connects to how the previous act ended — a real callback or handoff, not mere concatenation.`,
  `Never mention or restate the previous act's exit text verbatim; reference it naturally.`,
  NARRATOR_STRUCTURE_RULE,
  ``,
  `Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:`,
  '{"nextIntroduction": string}'
].join("\n");

export function buildSmoothPromptParts(request: ContinuitySmoothRequest): PromptParts {
  return {
    stable: CONTINUITY_STABLE,
    foray: "",
    call: [
      `The act that just played, "${request.previousActTitle}", ended with this exit line (already played — DO NOT rewrite it, it is given for context only):`,
      `"""${request.previousActExit}"""`,
      ``,
      `The next act, "${request.nextActTitle}", currently opens with this introduction (NOT yet played — this is the ONLY text you may change):`,
      `"""${request.nextActIntroduction}"""`,
      ``,
      `Keep it a real introduction to "${request.nextActTitle}" — do not drop its own content, only smooth the seam into it.`
    ].join("\n")
  };
}

/** The legacy single-string smoothing prompt (the Anthropic builder sends it). */
export function buildSmoothPrompt(request: ContinuitySmoothRequest): string {
  return joinParts(buildSmoothPromptParts(request));
}
