import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { BUILDER_MAX_TOKENS } from "../config/outputBudgets";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";
import { createMessage } from "./anthropicCall";
import { ClaritySchema, IntentSchema } from "./replySchemas";
import { buildClarityPrompt, buildIntentPrompt, recaseIntentTitle } from "./prompts/understand";

/**
 * Real §4.1 clarity/intent understanding via the Anthropic API, mirroring
 * AnthropicEnricher's structure and model choice (backend/src/enrich/AnthropicEnricher.ts):
 * the `haiku` tier, cheap enough for two short calls per prompt under §9.2's
 * generous ~$5-10/Foray phase-1 ceiling. The id that tier resolves to lives in
 * `src/config/models.ts`, never here (F-03).
 *
 * NEVER instantiate this class in a test — same rule as AnthropicEnricher.
 * Use createPromptUnderstander() everywhere except explicit, human-invoked
 * production code paths.
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("haiku");
const USD_PER_INPUT_TOKEN = costFor("haiku").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("haiku").usdPerOutputToken;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicPromptUnderstander implements PromptUnderstander {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicPromptUnderstander constructed without ANTHROPIC_API_KEY set — use createPromptUnderstander() so it falls back to StubPromptUnderstander instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult> {
    const promptText = buildClarityPrompt(prompt);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "prompt_clarity",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + 200 * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: BUILDER_MAX_TOKENS.clarity,
      messages: [{ role: "user", content: promptText }]
    }, "prompt-understand");

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic clarity response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "prompt_clarity",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + 200 * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: BUILDER_MAX_TOKENS.clarity,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "prompt-understand");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic clarity re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(ClaritySchema, textBlock.text, "Anthropic clarity output", reask);
  }

  async extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
    const promptText = buildIntentPrompt(prompt);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "prompt_intent",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + 400 * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: BUILDER_MAX_TOKENS.intent,
      messages: [{ role: "user", content: promptText }]
    }, "prompt-understand");

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic intent response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "prompt_intent",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + 400 * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: BUILDER_MAX_TOKENS.intent,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "prompt-understand");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic intent re-ask response had no text block");
      return retryTextBlock.text;
    };

    const intent = await parseWithRetry(IntentSchema, textBlock.text, "Anthropic intent output", reask);
    return this.sentenceCaseTitle(intent, promptText, prompt, ctx);
  }

  /**
   * THE TITLE HOUSE STYLE, ASKED OF THE MODEL (Wyatt, 2026-09-24, qa 146:
   * "Sentence case, no period, though ? And ! Are allowed").
   *
   * Code can strip a closing period and raise a first letter
   * (`houseStyleTitle`), but it cannot lowercase "Actually" without also
   * lowercasing "Venus", so a title still in Title Case after those two fixes
   * goes back to the model ONCE, with the checker's own words for what is
   * wrong, and the answer is kept only if it keeps the style, changes
   * nothing but the case, and lower-cases nothing that may be a name
   * (rules.js `demotedNames`). One Haiku call, gated like every other; a
   * second miss, or a failed call, keeps the first title, which `forayCopy`
   * reports and check-forays warns on (Title Case is a heuristic, so on a
   * generated Foray it is not worth the run's spend). Asked HERE, before a
   * single expensive stage runs, because the gate runs after the spend.
   */
  private async sentenceCaseTitle<T extends { title?: string }>(intent: T, promptText: string, listenerPrompt: string, ctx: PromptUnderstandContext): Promise<T> {
    return recaseIntentTitle(intent, promptText, listenerPrompt, "AnthropicPromptUnderstander", async ({ messages, line }) => {
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "prompt_intent",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: roughTokenEstimate(promptText + line) * USD_PER_INPUT_TOKEN + 60 * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });
      const response = await createMessage(this.client, {
        model: MODEL,
        max_tokens: BUILDER_MAX_TOKENS.title,
        messages
      }, "prompt-understand");
      return response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    });
  }
}


/* GV-32 (decision 8): the clarity and intent prompts, the title re-ask turn
   and recaseIntentTitle moved to prompts/understand.ts, which both this
   builder and its Chat twin import. Re-exported here so existing importers
   compile until GV-96 deletes this module. */
export { buildClarityPrompt, buildIntentPrompt, recaseIntentTitle } from "./prompts/understand";
export type { TitleRecaseAsk, TitleTurn } from "./prompts/understand";
