import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ContinuityBuilder, ContinuityBuildContext, ContinuitySmoothRequest, ContinuitySmoothResult } from "./ContinuityBuilder";

/**
 * Real §4.8 cross-act continuity smoothing via the Anthropic API,
 * mirroring AnthropicNarrationWriterBuilder's structure. Called ONCE PER
 * ACT BOUNDARY (§5's topology table: "1 continuity agent", invoked at
 * every seam, forward-only per §6.2 — see ContinuityBuilder.ts's doc
 * comment for why the return shape itself enforces that).
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createContinuityBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;
const MAX_OUTPUT_TOKENS = 500;

const RawSmoothResultSchema = z.object({
  nextIntroduction: z.string()
});

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicContinuityBuilder implements ContinuityBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicContinuityBuilder constructed without ANTHROPIC_API_KEY set — use createContinuityBuilder() so it falls back to StubContinuityBuilder instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async smoothSeam(request: ContinuitySmoothRequest, ctx: ContinuityBuildContext): Promise<ContinuitySmoothResult> {
    const promptText = buildSmoothPrompt(request);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "continuity_smooth",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: promptText }]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic continuity-smooth response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "continuity_smooth",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic continuity-smooth re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(RawSmoothResultSchema, textBlock.text, "LLM output", reask);
  }
}


function buildSmoothPrompt(request: ContinuitySmoothRequest): string {
  return [
    `You are the continuity editor for an audio documentary ("Foray"), working ONLY at the seam between two acts.`,
    `The act that just played, "${request.previousActTitle}", ended with this exit line (already played — DO NOT rewrite it, it is given for context only):`,
    `"""${request.previousActExit}"""`,
    ``,
    `The next act, "${request.nextActTitle}", currently opens with this introduction (NOT yet played — this is the ONLY text you may change):`,
    `"""${request.nextActIntroduction}"""`,
    ``,
    `Rewrite the next act's introduction so it genuinely connects to how the previous act ended — a real callback or handoff, not mere concatenation.`,
    `Keep it a real introduction to "${request.nextActTitle}" — do not drop its own content, only smooth the seam into it.`,
    `Never mention or restate the previous act's exit text verbatim; reference it naturally.`,
    ``,
    `Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:`,
    '{"nextIntroduction": string}'
  ].join("\n");
}
