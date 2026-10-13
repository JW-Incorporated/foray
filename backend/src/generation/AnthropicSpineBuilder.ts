import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { BUILDER_MAX_TOKENS } from "../config/outputBudgets";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import type { DurationTier, Spine } from "../types/spine";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";
import { createMessage } from "./anthropicCall";
import { RawSpineSchema, spineFromReply } from "./replySchemas";
import { buildSpinePrompt, spineConversation } from "./prompts/spine";

/**
 * Real §4.3 spine construction via the Anthropic API, mirroring
 * AnthropicPromptUnderstander / AnthropicExternalResearcher's structure
 * and model choice. This is the single most consequential LLM call in
 * the pipeline (§4.3: "the highest-leverage artefact... splitting it is
 * the most likely way to produce an incoherent Foray") so it uses a
 * larger model and a larger output budget than the earlier stages, and
 * it is called EXACTLY ONCE per Foray — never per-act, never per-beat.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createSpineBuilder() everywhere
 * except explicit, human-invoked production code paths.
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("opus");
const USD_PER_INPUT_TOKEN = costFor("opus").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("opus").usdPerOutputToken;
/* GV-25 (decision 10): the cap lives in config/outputBudgets.ts, value unchanged. */
const MAX_OUTPUT_TOKENS = BUILDER_MAX_TOKENS.spine;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicSpineBuilder implements SpineBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicSpineBuilder constructed without ANTHROPIC_API_KEY set — use createSpineBuilder() so it falls back to StubSpineBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine> {
    /* GV-67: on the folded path the listener's own words ride in and the
       reply leads with the copy fields; classic calls are unchanged. */
    const folded = ctx.listenerPrompt !== undefined;
    const promptText = buildSpinePrompt(intent, researchShape, duration, ctx.listenerPrompt);
    /* F-86: a structural re-ask is the SAME prompt, the reply the gate refused
       as the assistant's own turn, and one user turn naming what to fix — so
       the model keeps every act, slot and beat the gate did not name and
       changes only the ones it did. A fresh single-turn prompt would cost the
       same Opus call and hand back a different spine with its own defects. */
    const messages: Anthropic.MessageParam[] = spineConversation(promptText, ctx.revision, folded);
    const conversationText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const estimatedInputTokens = roughTokenEstimate(conversationText);
    /* Metered the way any spine call is — a re-ask is a whole Opus call, and
       the guard sees it as one (`buildSpine.ts` adds no second budget). */
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "spine_build",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages
    }, "spine");

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic spine response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(conversationText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "spine_build",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [...messages, { role: "assistant", content: textBlock.text }, { role: "user", content: reaskLine }]
      }, "spine");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic spine re-ask response had no text block");
      return retryTextBlock.text;
    };

    const raw = await parseWithRetry(RawSpineSchema, textBlock.text, "Anthropic spine output", reask);
    return spineFromReply(raw, intent, duration, folded);
  }
}

/* GV-32 (decision 8): the spine prompt (now [stable][foray], rules first),
   the re-ask conversation and the fix turns moved to prompts/spine.ts, which
   both this builder and its Chat twin import. Re-exported here so existing
   importers compile until GV-96 deletes this module. */
export {
  buildSeedFloorInstruction,
  buildSpineFixInstruction,
  buildSpinePrompt,
  buildSpinePromptParts,
  spineConversation,
  spineReplyText,
  spineRevisionTurns
} from "./prompts/spine";
export type { SpineTurn } from "./prompts/spine";
