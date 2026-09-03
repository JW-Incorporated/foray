import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { NarrationBuildContext, NarrationVerifierBuilder, NarrationVerifyRequest, NarrationVerifyResult } from "./NarrationVerifierBuilder";

/**
 * Real §4.7 verification via the Anthropic API — a SEPARATE call, and
 * this file is a SEPARATE class, from `AnthropicNarrationWriterBuilder`.
 * §4.7 rule 2 / §5's topology table ("1 per act, never the writer") is
 * enforced at the orchestrator level (`writeNarration.ts` constructs two
 * distinct builder instances and never lets a caller pass the same
 * instance for both roles — see that file's doc comment), but this class
 * existing as its own file with its own prompt is what makes "a
 * genuinely different agent" true rather than aspirational: it never
 * imports, calls, or shares any state with
 * `AnthropicNarrationWriterBuilder`.
 *
 * NEVER instantiate this class in a test. Use createNarrationVerifierBuilder().
 */

const MODEL = "claude-sonnet-4-5";
const USD_PER_INPUT_TOKEN = 3.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;
const MAX_OUTPUT_TOKENS = 1000;

const RawVerifyResultSchema = z.object({
  verified: z.boolean(),
  verifierNotes: z.string().optional()
});

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationVerifierBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationVerifierBuilder() so it falls back to StubNarrationVerifierBuilder instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async verifyPage(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult> {
    const promptText = buildVerifyPrompt(request);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
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
    if (!textBlock) throw new Error("Anthropic narration-verify response had no text block");

    return parseWithRetry(RawVerifyResultSchema, textBlock.text);
  }
}

function parseWithRetry<T>(schema: z.ZodType<T>, raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch (err) {
    throw new Error(`LLM output failed schema validation (no retry available in this build): ${(err as Error).message}`, {
      cause: err
    });
  }
}

function buildVerifyPrompt(request: NarrationVerifyRequest): string {
  const sourcesText = request.sources
    .map(
      (s, i) =>
        `Source ${i + 1}: claim="${s.claimText}" quote="${s.quote}" publication="${s.publication}"` +
        (s.contested ? " [marked contested]" : "")
    )
    .join("\n");
  return [
    "You are the FACT-VERIFICATION pass for a narration page in an audio documentary (\"Foray\").",
    "You did NOT write this page. Read it against ONLY its declared sources below, and decide whether every",
    "factual claim the script makes is actually supported by a source's quoted span.",
    "",
    `Mode: ${request.mode}`,
    `Script:\n${request.script}`,
    "",
    `Sources:\n${sourcesText || "(none declared)"}`,
    "",
    "Fail verification if: any factual claim in the script has no supporting source; a source's quote does not actually",
    "support the claim text it is attached to; or a source is marked contested but the script does not say so explicitly.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"verified": boolean, "verifierNotes": string (required and specific when verified is false, describing exactly what is unsupported)}'
  ].join("\n");
}
