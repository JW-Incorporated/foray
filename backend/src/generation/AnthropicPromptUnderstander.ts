import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";

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

const ClaritySchema = z.object({
  ambiguous: z.boolean(),
  readings: z.array(z.string()).max(3),
  question: z.string().nullable()
});

const IntentSchema = z.object({
  subject: z.string(),
  angle: z.string(),
  priorKnowledge: z.string(),
  disappointment: z.string()
});

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

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: promptText }]
    });

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

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: 400,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
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

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: promptText }]
    });

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

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: 600,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic intent re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(IntentSchema, textBlock.text, "Anthropic intent output", reask);
  }
}


function buildClarityPrompt(prompt: string): string {
  return [
    "A user has asked for an AI-generated audio documentary (a \"Foray\") on this prompt:",
    "",
    `"${prompt}"`,
    "",
    "Decide if this prompt is GENUINELY ambiguous — meaning it names something with two or",
    "more substantially different plausible subjects (e.g. \"Mercury\" could mean the planet,",
    "the element, or the Roman god). Do NOT flag a prompt as ambiguous just because it is broad",
    "or could be narrowed — \"Roman siege weapons\" is NOT ambiguous even though it covers many",
    "devices, because there is one clear subject. The bar is high: only flag it when a wrong",
    "guess would produce a genuinely different Foray.",
    "",
    "If ambiguous, give exactly 2-3 concrete readings (do not include an \"or something else\"",
    "option in `readings` — that is appended separately) and a single one-sentence question",
    "offering those readings.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"ambiguous": boolean, "readings": string[], "question": string|null}'
  ].join("\n");
}

function buildIntentPrompt(prompt: string): string {
  return [
    "A user asked for an AI-generated audio documentary (a \"Foray\") on this prompt:",
    "",
    `"${prompt}"`,
    "",
    "Produce a structured understanding of the request with exactly these four fields:",
    "- subject: the concrete subject of the Foray",
    "- angle: the specific angle or thesis worth taking, not just the topic",
    "- priorKnowledge: what the listener probably already knows about this",
    "- disappointment: what would make this Foray a disappointment to the listener — this is",
    "  the most important field; be concrete, not generic",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string}'
  ].join("\n");
}
