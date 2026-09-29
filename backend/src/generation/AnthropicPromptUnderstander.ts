import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "./PromptUnderstander";
import { createMessage } from "./anthropicCall";
import { demotedNames, houseStyleTitle, titleStyleProblems } from "../copy/rules";

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
  disappointment: z.string(),
  /* F-64 — see `IntentUnderstandingSchema`. Optional here too: a model that
     drops them costs a clamped fallback, not a re-ask. */
  title: z.string().optional(),
  summary: z.string().optional()
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

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: promptText }]
    }, "prompt-understand");

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

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: 400,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "prompt-understand");
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

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: promptText }]
    }, "prompt-understand");

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

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: 600,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "prompt-understand");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic intent re-ask response had no text block");
      return retryTextBlock.text;
    };

    const intent = await parseWithRetry(IntentSchema, textBlock.text, "Anthropic intent output", reask);
    return this.sentenceCaseTitle(intent, promptText, prompt, ctx);
  }

  /**
   * THE TITLE HOUSE STYLE, ASKED OF THE MODEL (Wyatt, 2026-09-24, qa 146:
   * "Sentence case, no period, though ? And ! Are allowed").
   *
   * Code can strip a closing period and raise a first letter
   * (`houseStyleTitle`), but it cannot lowercase "Actually" without also
   * lowercasing "Venus", so a title still in Title Case after those two fixes
   * goes back to the model ONCE, with the checker's own words for what is
   * wrong, and the answer is kept only if it keeps the style, changes
   * nothing but the case, and lower-cases nothing that may be a name
   * (rules.js `demotedNames`). One Haiku call, gated like every other; a
   * second miss, or a failed call, keeps the first title, which `forayCopy`
   * reports and check-forays warns on (Title Case is a heuristic, so on a
   * generated Foray it is not worth the run's spend). Asked HERE, before a
   * single expensive stage runs, because the gate runs after the spend.
   */
  private async sentenceCaseTitle<T extends { title?: string }>(intent: T, promptText: string, listenerPrompt: string, ctx: PromptUnderstandContext): Promise<T> {
    const title = intent.title?.trim();
    if (!title) return intent;
    const problems = titleStyleProblems(houseStyleTitle(title));
    if (problems.length === 0) return intent;
    const line =
      `The title "${title}" ${problems.join("; ")}. Reply with ONLY a JSON object {"title": string}: the same title in sentence case — ` +
      "the first word, proper nouns and acronyms capitalised, every other word lower case, no closing period.";
    /* A style-only call must never cost the run: the intent is already
       parsed and usable, so a budget refusal, a 429/529 or a network error
       here keeps the original title, exactly as a second miss does (review of
       PR #785). */
    let text: string;
    try {
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "prompt_intent",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: roughTokenEstimate(promptText + line) * USD_PER_INPUT_TOKEN + 60 * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });
      const response = await createMessage(this.client, {
        model: MODEL,
        max_tokens: 120,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: JSON.stringify(intent) },
          { role: "user", content: line }
        ]
      }, "prompt-understand");
      text = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    } catch (error) {
      console.warn(`AnthropicPromptUnderstander: the title re-ask for "${title}" failed (${error instanceof Error ? error.message : String(error)}); keeping it`);
      return intent;
    }
    let restyled: string | undefined;
    try {
      const parsed = z.object({ title: z.string() }).safeParse(JSON.parse(text.replace(/^[^{]*/, "").replace(/[^}]*$/, "")));
      restyled = parsed.success ? parsed.data.title.trim() : undefined;
    } catch {
      restyled = undefined;
    }
    /* Only the CASE may change: a reply that rewords the title is not the
       title the rest of the intent was written around. */
    const letters = (t: string): string => houseStyleTitle(t).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!restyled || letters(restyled) !== letters(title) || titleStyleProblems(houseStyleTitle(restyled)).length > 0) {
      console.warn(`AnthropicPromptUnderstander: the title "${title}" is still not sentence case after one re-ask; keeping it`);
      return intent;
    }
    /* ...and the case change may not demote a name to get past the checker
       ("Why Doctor who still works" keeps the letters and passes it). */
    const demoted = demotedNames(title, restyled, listenerPrompt);
    if (demoted.length > 0) {
      console.warn(`AnthropicPromptUnderstander: the re-ask lower-cased what may be a name (${demoted.join(", ")}) in "${restyled}"; keeping "${title}"`);
      return intent;
    }
    return { ...intent, title: restyled };
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

export function buildIntentPrompt(prompt: string): string {
  return [
    "A user asked for an AI-generated audio documentary (a \"Foray\") on this prompt:",
    "",
    `"${prompt}"`,
    "",
    "Produce a structured understanding of the request with exactly these six fields:",
    "- subject: the concrete subject of the Foray, as a short noun phrase of at most 8 words —",
    "  NOT a restatement of the prompt",
    "- angle: the specific angle or thesis worth taking, not just the topic",
    "- priorKnowledge: what the listener probably already knows about this",
    "- disappointment: what would make this Foray a disappointment to the listener — this is",
    "  the most important field; be concrete, not generic",
    "- title: the Foray's public title, at most 10 words, in SENTENCE CASE: capitalise the first word, proper",
    "  nouns and acronyms, and nothing else (\"How AI actually gets built\", \"How Earth got plate tectonics and",
    "  Venus never did\" — not \"How AI Actually Gets Built\"). No closing period; a closing ? or ! is fine.",
    "- summary: one plain sentence of at most 16 words that a listener sees under the title —",
    "  what they will come away knowing, not a list of subtopics",
    "  Neither the title nor the summary may count or number the Foray's parts (\"eight beats\", \"22 segments\",",
    "  \"three acts\", \"Act one\", \"this act\", \"the running order\"): those are our production words, not a",
    "  listener's. A machine checks that after you answer.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string, ' +
      '"title": string, "summary": string}'
  ].join("\n");
}
