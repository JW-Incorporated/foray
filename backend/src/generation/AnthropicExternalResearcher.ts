import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseLastJsonBlock } from "./parseWithRetry";
import type {
  ExternalResearcher,
  ExternalResearchContext,
  ExternalResearchResult,
  PassageRetrievalRequest,
  RetrievedPassage
} from "./ExternalResearcher";

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

const PassagesSchema = z.object({
  passages: z.array(
    z.object({
      title: z.string(),
      url: z.string().optional(),
      text: z.string()
    })
  )
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

  /**
   * The same web-search capability, asked a different question: not "what
   * is the shape of this sub-topic" but "give me the TEXT a narration page
   * can quote". WS-A's whole design rests on this call — a writer handed
   * real passages quotes them (run 1's one accidental demonstration of
   * that, I-20, produced the best-grounded page of the run), and a writer
   * handed nothing invents them (F-14/F-27/F-32).
   *
   * Nothing here trusts the model with attribution: `gatherEvidence.ts`
   * turns each passage into a held document, and `writeNarration.ts`
   * derives every `publication` from that document's title. A passage
   * whose text the model wrote rather than retrieved simply becomes a
   * document nothing can be quoted from that is not in it.
   */
  async retrievePassages(request: PassageRetrievalRequest, ctx: ExternalResearchContext): Promise<RetrievedPassage[]> {
    const promptText = buildRetrievalPrompt(request);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "evidence_retrieval",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd:
        roughTokenEstimate(promptText) * USD_PER_INPUT_TOKEN +
        request.maxPassages * request.maxChars * 0.25 * USD_PER_OUTPUT_TOKEN +
        MAX_SEARCHES_PER_TOPIC * USD_PER_SEARCH,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
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
    if (!textBlock) throw new Error("Anthropic evidence-retrieval response had no text block");

    const parsed = parseLastJsonBlock(PassagesSchema, textBlock.text, "Evidence retrieval output");
    const retrievedAt = new Date().toISOString();
    return parsed.passages.slice(0, request.maxPassages).map((p, i) => ({
      docId: `print:${i + 1}`,
      title: p.title,
      ...(p.url ? { url: p.url } : {}),
      retrievedAt,
      text: p.text.slice(0, request.maxChars)
    }));
  }
}


function buildRetrievalPrompt(request: PassageRetrievalRequest): string {
  return [
    `Find published text that bears on this claim: "${request.claim}".`,
    "",
    `Search the web, then COPY passages out of the pages you retrieved — up to ${request.maxPassages}, each at most ${request.maxChars} characters.`,
    "Every passage must be the page's own wording, character for character: do not paraphrase, do not join separated",
    "sentences, do not write a sentence the page does not contain. Prefer a primary or reported source over an",
    "encyclopaedia. If the search finds nothing usable, return an empty array — that is a correct answer.",
    "",
    "Respond with ONLY a single JSON object as your FINAL message, no markdown fences, matching exactly:",
    '{"passages": [{"title": string, "url": string, "text": string}]}'
  ].join("\n");
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
