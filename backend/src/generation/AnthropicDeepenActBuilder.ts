import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { BUILDER_MAX_TOKENS } from "../config/outputBudgets";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { Act, DeepenedAct, Spine } from "../types/spine";
import type { DeepenActBuilder, DeepenActContext } from "./DeepenActBuilder";
import { createMessage } from "./anthropicCall";
import { RawDeepenedActSchema } from "./replySchemas";
import { buildDeepenActPrompt } from "./prompts/deepen";

/**
 * Real §4.4 act-deepening via the Anthropic API, mirroring
 * AnthropicSpineBuilder's structure. Called ONCE PER ACT (§5: "1 per act
 * (3-7)"), always with the FULL spine attached to the prompt so the model
 * never has to guess what a sibling act already established.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createDeepenActBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;
/* GV-25 (decision 10): the cap lives in config/outputBudgets.ts, value unchanged. */
const MAX_OUTPUT_TOKENS = BUILDER_MAX_TOKENS.deepen;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicDeepenActBuilder implements DeepenActBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicDeepenActBuilder constructed without ANTHROPIC_API_KEY set — use createDeepenActBuilder() so it falls back to StubDeepenActBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    const promptText = buildDeepenActPrompt(fullSpine, targetAct, targetActIndex);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "deepen_act",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: promptText }]
    }, "deepen-act");

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic deepen-act response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "deepen_act",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "deepen-act");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic deepen-act re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(RawDeepenedActSchema, textBlock.text, "Anthropic deepen-act output", reask);
  }
}


/* GV-32 (decision 8): the deepen prompt (now [stable][foray][call], the act
   marker in the call part) moved to prompts/deepen.ts, which both this
   builder and its Chat twin import. Re-exported here so existing importers
   compile until GV-96 deletes this module. */
export { buildDeepenActPrompt, buildDeepenActPromptParts } from "./prompts/deepen";
