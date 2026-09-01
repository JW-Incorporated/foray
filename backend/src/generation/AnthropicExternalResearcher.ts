import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ExternalResearcher, ExternalResearchContext, ExternalResearchResult } from "./ExternalResearcher";

/**
 * Real §4.2 external research via the Anthropic API's server-side web
 * search tool. Only invoked for a genuine catalogue gap (see
 * `researchShape.ts`'s "cheap first" ordering) — this is deliberately the
 * most expensive collaborator in the §4.2 stage, so it is also the one
 * most worth gating behind an actual miss rather than calling for every
 * candidate subtopic.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createExternalResearcher().
 */

const MODEL = "claude-haiku-4-5";
const USD_PER_INPUT_TOKEN = 1.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5.0 / 1_000_000;
// Anthropic's server-side web_search tool bills per search in addition to
// tokens; $0.01/search is the published rate at the time of this build.
const USD_PER_SEARCH = 0.01;
const MAX_SEARCHES_PER_TOPIC = 3;

const ResearchSchema = z.object({
  notes: z.string(),
  controversies: z.array(z.string())
});

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicExternalResearcher implements ExternalResearcher {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicExternalResearcher constructed without ANTHROPIC_API_KEY set — use createExternalResearcher() so it falls back to StubExternalResearcher instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult> {
    const promptText = buildResearchPrompt(topic);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    // Pre-call budget check with a conservative estimate covering both
    // token spend and the worst-case search-call cost for this topic.
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "external_research",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd:
        estimatedInputTokens * USD_PER_INPUT_TOKEN + 500 * USD_PER_OUTPUT_TOKEN + MAX_SEARCHES_PER_TOPIC * USD_PER_SEARCH,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: promptText }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_SEARCHES_PER_TOPIC
        } satisfies Anthropic.WebSearchTool20250305
      ]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic external-research response had no text block");

    return parseWithRetry(ResearchSchema, textBlock.text);
  }
}

function parseWithRetry<T>(schema: z.ZodType<T>, raw: string): T {
  // The model may wrap the final JSON answer in prose around its web-search
  // tool calls; take the last fenced or bare JSON object in the text.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidate = fenced && fenced.length > 0
    ? fenced[fenced.length - 1]!.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
    : raw;
  const cleaned = candidate.trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch (err) {
    throw new Error(`External research output failed schema validation (no retry available in this build): ${(err as Error).message}`, {
      cause: err
    });
  }
}

function buildResearchPrompt(topic: string): string {
  return [
    `Research this candidate sub-topic for an audio documentary: "${topic}".`,
    "",
    "Use web search only as much as needed to answer these two questions:",
    "1. What are the genuine controversies or contested points about this sub-topic, if any?",
    "2. What is generally known about it that a researcher without web access could not have guessed?",
    "",
    "Do not write a script or narration — this is research to establish SHAPE, not content.",
    "Be concise. If there is nothing genuinely contested, say so plainly rather than inventing controversy.",
    "",
    "After your research, respond with ONLY a single JSON object as your FINAL message, no markdown",
    'fences, no other text, matching exactly: {"notes": string, "controversies": string[]}'
  ].join("\n");
}
