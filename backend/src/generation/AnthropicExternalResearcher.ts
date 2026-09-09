import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor, USD_PER_WEB_SEARCH } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseLastJsonBlock } from "./parseWithRetry";
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

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("haiku");
const USD_PER_INPUT_TOKEN = costFor("haiku").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("haiku").usdPerOutputToken;
// Anthropic's server-side web_search tool bills per search in addition to
// tokens. The rate lives beside the token rates in `src/config/models.ts` for
// the same reason they do: it is a price, and this stage's estimate is only as
// honest as the prices it is given (F-03).
const USD_PER_SEARCH = USD_PER_WEB_SEARCH;
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

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicExternalResearcher constructed without ANTHROPIC_API_KEY set — use createExternalResearcher() so it falls back to StubExternalResearcher instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
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

    return parseLastJsonBlock(ResearchSchema, textBlock.text, "External research output");
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
