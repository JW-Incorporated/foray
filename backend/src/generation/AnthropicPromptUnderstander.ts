import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";

/**
 * Real §4.1 clarity/intent understanding via the Anthropic API, mirroring
 * AnthropicEnricher's structure and model choice (backend/src/enrich/AnthropicEnricher.ts):
 * claude-haiku-4-5, cheap enough for two short calls per prompt under §9.2's
 * generous ~$5-10/Foray phase-1 ceiling.
 *
 * NEVER instantiate this class in a test — same rule as AnthropicEnricher.
 * Use createPromptUnderstander() everywhere except explicit, human-invoked
 * production code paths.
 */

const MODEL = "claude-haiku-4-5";
const USD_PER_INPUT_TOKEN = 1.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5.0 / 1_000_000;

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

    return parseWithRetry(ClaritySchema, textBlock.text, "Anthropic clarity output");
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

    return parseWithRetry(IntentSchema, textBlock.text, "Anthropic intent output");
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
