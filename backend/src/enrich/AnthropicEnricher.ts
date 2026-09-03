import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "../generation/parseWithRetry";
import type {
  ClassificationInput,
  ClassificationResult,
  Enricher,
  EnrichContext,
  WhyLineInput,
  WhyLineResult
} from "./Enricher";

/**
 * Real Tier-1 enrichment via the Anthropic API (02_ARCHITECTURE.md cheap-first
 * cascade). Model choice: claude-haiku-4-5 — the cheapest current model
 * ($1.00/$5.00 per MTok), appropriate for metadata-only classification and
 * short why-line generation per the cost-discipline constraint
 * (01_PROMPT.md #8). Tier-2 (transcript-based) enrichment would warrant a
 * stronger model and is out of scope for this pass (see ADR 0004).
 *
 * NEVER instantiate this class in a test — tests must run with zero network
 * calls regardless of whether ANTHROPIC_API_KEY happens to be set in the
 * environment. Use createEnricher() everywhere except explicit,
 * human-invoked production code paths, and pass an explicit StubEnricher in
 * tests rather than relying on env-based selection.
 */

const MODEL = "claude-haiku-4-5";
// Pricing as of the model catalog consulted for this build (USD per token).
const USD_PER_INPUT_TOKEN = 1.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5.0 / 1_000_000;

const ClassificationSchema = z.object({
  topics: z.array(z.string()).min(1).max(4),
  format: z.enum(["interview", "narrative", "how-to", "news", "comedy", "debate", "solo", "panel", "documentary", "hang"]),
  depth: z.enum(["low", "medium", "high"]),
  evergreen: z.boolean(),
  gist: z.string(),
  guests: z.array(z.string()),
  sourceConfidence: z.number().min(0).max(1)
});

const WhyLineSchema = z.object({
  whyLine: z.string()
});

function roughTokenEstimate(text: string): number {
  // Conservative pre-call estimate for budget gating (~4 chars/token);
  // actual metering happens after the call using response.usage.
  return Math.ceil(text.length / 4);
}

export class AnthropicEnricher implements Enricher {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /**
   * `client` is an optional injection point for tests: a fake client
   * returning canned `content` arrays exercises the no-text-block throw,
   * fence-stripping, and the zod-failure wrapped error entirely offline —
   * see backend/test/AnthropicEnricher.test.ts. When omitted (the only
   * production path — createEnricher() never passes one), the dry-run
   * guard below still fires exactly as before, so production code can
   * never construct a live client without ANTHROPIC_API_KEY set.
   */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicEnricher constructed without ANTHROPIC_API_KEY set — use createEnricher() so it falls back to StubEnricher instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async classifyTier1(input: ClassificationInput, ctx: EnrichContext): Promise<ClassificationResult> {
    const prompt = buildClassificationPrompt(input);
    const estimatedInputTokens = roughTokenEstimate(prompt);
    // pre-call budget check with a conservative estimate; keeps the guard
    // structurally impossible to bypass even though it can't know the real
    // cost until the response comes back.
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "tier1_classify",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + 300 * USD_PER_OUTPUT_TOKEN,
      episodeId: input.episodeId,
      sessionId: ctx.sessionId
    });

    // Note: this build's pinned @anthropic-ai/sdk version predates
    // `output_config.format` (server-enforced structured outputs) in its
    // TypeScript types, so JSON validity is enforced by prompt instruction
    // + zod parsing below (parseWithRetry) rather than server-side schema
    // enforcement. Upgrading the SDK to a version with structured-output
    // types would let this switch to output_config directly — see ADR-worthy
    // note in backend/README.md.
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic classification response had no text block");

    // corner case 32: schema-validated JSON, retry once on failure, then throw
    // (caller is responsible for dead-lettering — this module only guarantees
    // "never return malformed data").
    const parsed = parseWithRetry(ClassificationSchema, textBlock.text, "Anthropic classification output");
    return parsed;
  }

  async generateWhyLine(input: WhyLineInput, ctx: EnrichContext): Promise<WhyLineResult> {
    const prompt = buildWhyLinePrompt(input);
    const estimatedInputTokens = roughTokenEstimate(prompt);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "why_line",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + 60 * USD_PER_OUTPUT_TOKEN,
      episodeId: input.episodeId,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic why-line response had no text block");

    return parseWithRetry(WhyLineSchema, textBlock.text, "Anthropic why-line output");
  }
}


function buildClassificationPrompt(input: ClassificationInput): string {
  return [
    "Classify this podcast episode from its metadata only. Return topics as taxonomy node ids",
    'like "engineering/energy-fusion" (slash-separated, lowercase, hyphenated).',
    "",
    `Show: ${input.showTitle}`,
    `Title: ${input.title}`,
    `Duration seconds: ${input.durationSeconds ?? "unknown"}`,
    `Description: ${input.descriptionText.slice(0, 2000)}`,
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"topics": string[], "format": "interview"|"narrative"|"how-to"|"news"|"comedy"|"debate"|"solo"|"panel"|"documentary"|"hang",',
    '"depth": "low"|"medium"|"high", "evergreen": boolean, "gist": string, "guests": string[], "sourceConfidence": number}'
  ].join("\n");
}

function buildWhyLinePrompt(input: WhyLineInput): string {
  return [
    `Write a <=18 word why-line for the "${input.archetype}" card recommending this episode.`,
    "No generic praise (banned: 'fascinating deep dive'). Reference the listener's actual context.",
    input.bridgeFrom ? `This is the stretch/serendipity slot — explicitly state the bridge from "${input.bridgeFrom}".` : "",
    "",
    `Show: ${input.showTitle}`,
    `Title: ${input.title}`,
    `Gist: ${input.gist}`,
    `Listener context: ${input.userContext.join("; ")}`,
    "",
    'Respond with ONLY a single JSON object, no markdown fences, no other text: {"whyLine": string}'
  ]
    .filter(Boolean)
    .join("\n");
}
