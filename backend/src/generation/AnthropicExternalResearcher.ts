import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor, USD_PER_WEB_SEARCH } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseLastJsonBlock } from "./parseWithRetry";
import type {
  ExternalResearcher,
  ExternalResearchContext,
  ExternalResearchResult,
  PassageRetrievalRequest,
  RetrievedPassage
} from "./ExternalResearcher";
import { createMessage, createWebSearchTurn, createWebSearchTurnKeepingTruncation, webSearchAnswerText } from "./anthropicCall";

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
/** WS-A's retrieval returns whole passages rather than a paragraph of
 * notes, so it needs a bigger ceiling than `research()`'s 800: three
 * 1,500-character passages is ~1,125 tokens of text before JSON scaffolding. */
const RETRIEVAL_MAX_OUTPUT_TOKENS = 2000;

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
    const meter = () =>
      this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "external_research",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd:
          estimatedInputTokens * USD_PER_INPUT_TOKEN + 500 * USD_PER_OUTPUT_TOKEN + MAX_SEARCHES_PER_TOPIC * USD_PER_SEARCH,
        sessionId: ctx.sessionId
      });
    await meter();

    /* gen-1 (round-3 audit): a web-search reply is several blocks, and its
       answer is the text AFTER the last web_search_tool_result, not the first
       text block (usually an "I'll search for..." preamble). A pause_turn is
       continued with the same tools (createWebSearchTurn). */
    const content = await createWebSearchTurn(this.client, {
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
    }, "external-research", meter);

    const answer = webSearchAnswerText(content);
    if (!answer) throw new Error("Anthropic external-research response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note). No
      // web_search tool is offered on the re-ask (see messages.create
      // below), so unlike the original call's estimate this one carries no
      // USD_PER_SEARCH cost.
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + answer + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "external_research",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + 800 * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: 800,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: answer },
          { role: "user", content: reaskLine }
        ]
      }, "external-research");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic external-research re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseLastJsonBlock(ResearchSchema, answer, "External research output", reask);
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
   *
   * KNOWN GAP, F-48: what comes back is the retrieval model's
   * transcription of a search result, not bytes fetched from the url. The
   * substring gate downstream therefore proves a quote is consistent with
   * what THIS call wrote, not with the page at that url. The fix is
   * `web_fetch` with `citations` and holding server-attested `cited_text`
   * spans as the document; it lands with the tool-type move in F-47.
   */
  async retrievePassages(request: PassageRetrievalRequest, ctx: ExternalResearchContext): Promise<RetrievedPassage[]> {
    const promptText = buildRetrievalPrompt(request);
    /* Output tokens are bounded by what is being asked for: at most
       `maxPassages` passages of `maxChars` each, at ~4 chars per token,
       plus JSON scaffolding. Estimated rather than assumed so a pack of
       three 1,500-character passages is metered as what it is. */
    const estimatedOutputTokens = Math.min(
      RETRIEVAL_MAX_OUTPUT_TOKENS,
      Math.ceil((request.maxPassages * request.maxChars) / 4) + 200
    );
    const meter = () =>
      this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "evidence_retrieval",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd:
          roughTokenEstimate(promptText) * USD_PER_INPUT_TOKEN +
          estimatedOutputTokens * USD_PER_OUTPUT_TOKEN +
          MAX_SEARCHES_PER_TOPIC * USD_PER_SEARCH,
        sessionId: ctx.sessionId
      });
    await meter();

    const { content, truncated } = await createWebSearchTurnKeepingTruncation(
      this.client,
      {
        model: MODEL,
        max_tokens: RETRIEVAL_MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: promptText }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: MAX_SEARCHES_PER_TOPIC
          } satisfies Anthropic.WebSearchTool20250305
        ]
      },
      "evidence-retrieval",
      meter
    );

    /* gen-1 (round-3 audit). The answer is the text after the last
       web_search_tool_result, joined in order (a cited answer arrives split
       over several text blocks); the first text block is usually only a
       preamble. And retrieval NEVER re-asks: a re-ask cannot carry the search
       results and was sent without the tool, so the model could only answer
       from memory, and those "verbatim" passages became print evidence the
       writer quoted.

       A reply with no parseable answer (prose, or a turn still paused after
       MAX_PAUSE_TURN_CONTINUATIONS, which leaves no answer text) is a FAILED
       retrieval, thrown as RetrievalUnreadableError, never an empty result
       (round-3 review, L5). An empty result is a verdict: gatherEvidence caches
       it as "nothing exists" for a content page and refuses the page. Only a
       parsed `{"passages": []}` says that. A failure is not cached, marks the
       pack retrievalFailed, and is asked again (F-77).

       A reply cut off at max_tokens keeps the passages that FINISHED, parsed
       one by one, never repaired. Refusing it made the gather record a
       failure and re-ask the same prompt at the same ceiling on every later
       page, paying for the search again (round-3 review, L5). Only when not
       one passage finished is it a failure. */
    const answer = webSearchAnswerText(content);
    let passages: z.infer<typeof PassagesSchema>["passages"];
    if (truncated) {
      passages = salvageCompletePassages(answer);
      if (passages.length === 0) {
        throw new RetrievalUnreadableError("evidence retrieval reply hit max_tokens before one passage was complete");
      }
      console.warn(
        `AnthropicExternalResearcher: evidence retrieval reply hit max_tokens (${RETRIEVAL_MAX_OUTPUT_TOKENS}); keeping the ${passages.length} passage(s) that finished`
      );
    } else {
      try {
        passages = (await parseLastJsonBlock(PassagesSchema, answer, "Evidence retrieval output")).passages;
      } catch (err) {
        throw new RetrievalUnreadableError(
          `evidence retrieval reply had no parseable answer (${(err as Error).message.slice(0, 160)})`
        );
      }
    }
    const retrievedAt = new Date().toISOString();
    return passages.slice(0, request.maxPassages).map((p, i) => ({
      docId: `print:${i + 1}`,
      title: p.title,
      ...(p.url ? { url: p.url } : {}),
      retrievedAt,
      text: p.text.slice(0, request.maxChars)
    }));
  }
}


/** A retrieval reply that answered nothing readable. A FAILURE, not an empty
 * result: gatherEvidence records it as failed, caches nothing, and asks again. */
export class RetrievalUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalUnreadableError";
  }
}

const PassageSchema = PassagesSchema.shape.passages.element;

/**
 * The passages of a TRUNCATED `{"passages": [...]}` reply that finished: each
 * complete object in the array, parsed on its own. Nothing is repaired: an
 * object the cut went through is dropped whole, so a half passage can never
 * become print evidence. Reads the LAST `"passages"` array in the text (the
 * model may narrate before its answer).
 */
export function salvageCompletePassages(text: string): Array<z.infer<typeof PassageSchema>> {
  const key = text.lastIndexOf('"passages"');
  if (key < 0) return [];
  const open = text.indexOf("[", key);
  if (open < 0) return [];
  const out: Array<z.infer<typeof PassageSchema>> = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = PassageSchema.safeParse(JSON.parse(text.slice(start, i + 1)));
          if (parsed.success) out.push(parsed.data);
        } catch {
          /* not an object JSON can read: dropped, never repaired */
        }
        start = -1;
      }
    } else if (c === "]" && depth === 0) break;
  }
  return out;
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
