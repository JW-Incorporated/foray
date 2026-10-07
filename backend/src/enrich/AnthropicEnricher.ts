import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
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
 * cascade). Model choice: the `haiku` tier — the cheapest current model
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

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). This file is not part of
 * the §4 generation pipeline F-03 was raised against, but it was the seventh
 * hardcoded copy of the same id — leaving it behind would have made "one
 * place" false on the day it was written. Same tier, same rates, so routing
 * it through the map changes nothing about what this class does. */
const MODEL = modelFor("haiku");
const USD_PER_INPUT_TOKEN = costFor("haiku").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("haiku").usdPerOutputToken;

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
    // corner case 32: schema-validated JSON, retry once on failure, then throw
    // (caller is responsible for dead-lettering — this module only guarantees
    // "never return malformed data").
    return this.askJson(
      ClassificationSchema,
      buildClassificationPrompt(input),
      { operation: "tier1_classify", label: "classification", maxTokens: 512, outTokenEstimate: 300, episodeId: input.episodeId },
      ctx
    );
  }

  async generateWhyLine(input: WhyLineInput, ctx: EnrichContext): Promise<WhyLineResult> {
    return this.askJson(
      WhyLineSchema,
      buildWhyLinePrompt(input),
      { operation: "why_line", label: "why-line", maxTokens: 128, outTokenEstimate: 60, episodeId: input.episodeId },
      ctx
    );
  }

  /**
   * The one metered ask both methods make (CH2-08, B2-18 — these steps used
   * to be copied verbatim into each method, re-ask included, so a change to
   * the re-ask's metering could land in one copy only). One prompt, a
   * pre-call budget check, the call, then `parseWithRetry` with exactly one
   * re-ask that re-sends [prompt, bad reply, re-ask line] as its own metered
   * call. `label` names the method in every error ("classification",
   * "why-line"); `outTokenEstimate` is the output side of both estimates.
   */
  private async askJson<T>(
    schema: z.ZodType<T>,
    prompt: string,
    opts: { operation: string; label: string; maxTokens: number; outTokenEstimate: number; episodeId: string },
    ctx: EnrichContext
  ): Promise<T> {
    // The spend row for a call that sends `inputText`. Both calls below pass
    // it to this.budgetGuard.checkAndRecord themselves, so each `reask`
    // closure meters its own spend in plain sight (parseWithRetry.test.ts).
    const spend = (inputText: string) => ({
      userId: ctx.userId,
      operation: opts.operation,
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: roughTokenEstimate(inputText) * USD_PER_INPUT_TOKEN + opts.outTokenEstimate * USD_PER_OUTPUT_TOKEN,
      episodeId: opts.episodeId,
      sessionId: ctx.sessionId
    });

    // pre-call budget check with a conservative estimate; keeps the guard
    // structurally impossible to bypass even though it can't know the real
    // cost until the response comes back.
    await this.budgetGuard.checkAndRecord(spend(prompt));

    // Note: this build's pinned @anthropic-ai/sdk version predates
    // `output_config.format` (server-enforced structured outputs) in its
    // TypeScript types, so JSON validity is enforced by prompt instruction
    // + zod parsing below (parseWithRetry) rather than server-side schema
    // enforcement. Upgrading the SDK to a version with structured-output
    // types would let this switch to output_config directly — see ADR-worthy
    // note in backend/README.md.
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: prompt }]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error(`Anthropic ${opts.label} response had no text block`);

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      await this.budgetGuard.checkAndRecord(spend(prompt + textBlock.text + reaskLine));

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error(`Anthropic ${opts.label} re-ask response had no text block`);
      return retryTextBlock.text;
    };

    return await parseWithRetry(schema, textBlock.text, `Anthropic ${opts.label} output`, reask);
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
