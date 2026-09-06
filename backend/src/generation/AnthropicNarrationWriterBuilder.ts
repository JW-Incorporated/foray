import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { MODE_CHAR_BANDS } from "../types/narration";
import type { NarrationBuildContext, NarrationWriteRequest, NarrationWriteResult, NarrationWriterBuilder } from "./NarrationWriterBuilder";

/**
 * Real §4.7 narration writing via the Anthropic API, mirroring
 * AnthropicSpineBuilder/AnthropicDeepenActBuilder's structure. Called
 * ONCE PER PAGE (one narration beat) — §5's stage description groups
 * §4.5-4.7 under "the act's own agent, batched", but this builder's own
 * unit of work is a single page; batching pages within an act is the
 * ORCHESTRATOR's job (`writeNarration.ts`), not this class's.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createNarrationWriterBuilder().
 */

const MODEL = "claude-sonnet-4-5";
const USD_PER_INPUT_TOKEN = 3.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;
const MAX_OUTPUT_TOKENS = 2000;

const SourceSchema = z.object({
  claimText: z.string(),
  quote: z.string(),
  publication: z.string(),
  url: z.string().optional(),
  retrieved: z.string().optional(),
  contested: z.boolean()
});
const PronunciationHintSchema = z.object({ word: z.string(), hint: z.string() });
const RawWriteResultSchema = z.object({
  script: z.string(),
  sources: z.array(SourceSchema),
  pronunciationHints: z.array(PronunciationHintSchema)
});

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationWriterBuilder implements NarrationWriterBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationWriterBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationWriterBuilder() so it falls back to StubNarrationWriterBuilder instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async writePage(request: NarrationWriteRequest, ctx: NarrationBuildContext): Promise<NarrationWriteResult> {
    const promptText = buildWritePrompt(request);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_write",
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
    if (!textBlock) throw new Error("Anthropic narration-write response had no text block");

    return parseWithRetry(RawWriteResultSchema, textBlock.text);
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

function buildWritePrompt(request: NarrationWriteRequest): string {
  const [min, max] = MODE_CHAR_BANDS[request.mode];
  return [
    `You are writing ONE narration page for an audio documentary ("Foray"), in the mode "${request.mode}".`,
    `That mode's budget is ${min}-${max} characters — the script MUST land inside that band.`,
    `Voice (decided once for the whole Foray — do not vary it): style: ${request.voice.style}; register: ${request.voice.register}; ` +
      `sentence rhythm: ${request.voice.sentenceRhythm}; narrator presence: ${request.voice.narratorPresence}`,
    "",
    `What this page must accomplish: ${request.claim}`,
    request.contextNote ? `Additional context: ${request.contextNote}` : "",
    "",
    "Copy rules, unchanged and non-negotiable:",
    "- Never say: fascinating, deep dive, delve, explores.",
    "- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.",
    "- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving — write numbers as words if you must use one at all.",
    "- If a claim is genuinely contested, say so explicitly in the script itself.",
    "",
    "Every factual claim in the script must carry a source: a verbatim quoted span, its publication, and whether it is contested.",
    "Also list any hard-to-pronounce or foreign words in the script with a plain-English pronunciation hint.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"script": string, "sources": [{"claimText": string, "quote": string, "publication": string, "url": string (optional), ' +
      '"retrieved": string (optional, ISO date), "contested": boolean}], ' +
      '"pronunciationHints": [{"word": string, "hint": string}]}'
  ]
    .filter(Boolean)
    .join("\n");
}
