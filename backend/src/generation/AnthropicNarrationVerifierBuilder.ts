import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { BUILDER_MAX_TOKENS } from "../config/outputBudgets";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ActVerifyRequest, ActVerifyResult, NarrationBuildContext, NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import { createMessage } from "./anthropicCall";
import { RawActVerifySchema, toActVerifyResult } from "./replySchemas";
import { buildActVerifyPrompt } from "./prompts/actVerify";

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
 * REAL QUESTIONS, NOT ONE (WS-A). Run 1's prompt said "read it against
 * ONLY its declared sources", which made this a consistency check on the
 * writer's own declarations: it passed a page citing Chernobyl interviews
 * for a Kansas City claim in five seconds (F-27), never asked whether a
 * page did the job its beat existed for (F-41), and decided the
 * zero-source case by sampling (F-44). It is now given the act's beats,
 * prose, clips and whole source set, and answers per BEAT whether the
 * prose carries its claim and per SEAM whether every statement is
 * supported and a genuinely contested point handled (F-43 — the keyword
 * detector no longer decides this).
 *
 * It is NOT asked whether a quote exists. `writeNarration.ts` proves that
 * in code, against the held documents, before this is ever called.
 *
 * ONE CALL SINCE F-100. Runs 1-8 asked the same questions of one slot's
 * pages (`verifySlot`) and F-88 asked a fourth of a page whose retrieval
 * had found nothing (`verifySynthesis`). Q-03/F-97 folded both into
 * `verifyAct` — the ground F-88 needed is now part of the act's source set
 * — and both methods, both prompts and their schemas are deleted with
 * F-100. Neither could be reached: `createNarrationVerifierBuilder()`
 * returns this class or the stub, and both verify per act.
 *
 * NEVER instantiate this class in a test. Use createNarrationVerifierBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;
/* GV-25 (decision 10): the cap lives in config/outputBudgets.ts, value unchanged. */
const MAX_ACT_VERIFY_OUTPUT_TOKENS = BUILDER_MAX_TOKENS.verifier;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests (GV-31 added it, the
   * same pattern GV-25 gave the planning builders), so the Chat twin's parity
   * test can drive this class with a fake; without it nothing changes. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationVerifierBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationVerifierBuilder() so it falls back to StubNarrationVerifierBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /** Q-03: the per-beat question for a whole act. See `buildActVerifyPrompt`. */
  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    const raw = await this.ask(buildActVerifyPrompt(request), RawActVerifySchema, ctx, MAX_ACT_VERIFY_OUTPUT_TOKENS);
    return toActVerifyResult(raw);
  }

  private async ask<T>(promptText: string, schema: z.ZodType<T>, ctx: NarrationBuildContext, maxOutputTokens: number): Promise<T> {
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: maxOutputTokens,
      messages: [{ role: "user", content: promptText }]
    }, "narration-verify");

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic narration-verify response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      // Run 1's verifier call #34 returned an unclosed object and charged a
      // page one of its three attempts for it (F-39); this is that fix.
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "narration_verify",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await createMessage(this.client, {
        model: MODEL,
        max_tokens: maxOutputTokens,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      }, "narration-verify");
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic narration-verify re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(schema, textBlock.text, "LLM output", reask);
  }
}

/* GV-50 (decision 8): the per-act verification prompt (now
   [stable][foray][call], the questions first) moved to prompts/actVerify.ts,
   which both this builder and its Chat twin import. This builder sends the
   joined prompt, buildActVerifyPrompt, as one user turn. Re-exported here so
   existing importers compile until GV-96 deletes this module. */
export { buildActVerifyPrompt } from "./prompts/actVerify";
