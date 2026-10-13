import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, NarrationWriterBuilder } from "./NarrationWriterBuilder";
import { assertReplyComplete, createMessage } from "./anthropicCall";
import { RawActWriteSchema, toActWriteResult } from "./replySchemas";
import { buildActWritePrompt } from "./prompts/actWrite";

/**
 * Real §4.7 narration writing via the Anthropic API, mirroring
 * AnthropicSpineBuilder/AnthropicDeepenActBuilder's structure.
 *
 * ONE CALL PER ACT (Q-03, F-100). `writeAct` is the only writing call this
 * class makes: the act's seams, clips, documents and beat checklist go out
 * in one prompt and the act's prose comes back in one reply. Run 1 spent
 * 4.2 narration calls per beat over 31 beats writing a page at a time;
 * runs 1-8's three per-page methods (`selectClaims`, `writePages`, and
 * G-34's merged `selectAndWrite`) and their prompts were superseded by this
 * one and are deleted with F-100 — `createNarrationWriterBuilder()` returns
 * either this class or the stub, both of which write per act, so nothing
 * could reach them.
 *
 * WHAT THE PROMPT DOES NOT SAY is as important as what it does. Run 1's
 * single prompt asked for a verbatim quote, a publication and a contested
 * flag with no text to quote from — so the model reconstructed all three
 * (F-14/F-27/F-30/F-32). It now hands over the DOCUMENTS and asks only
 * which span of which one backs each claim, and never returns a source,
 * because attribution is read off the held document in code. Every rule a
 * substring check can decide lives in `writeNarration.ts`, not here, which
 * is why the prompt is this short.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createNarrationWriterBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;

/* Q-03: the whole act's seams come back in one reply — every seam's script,
 * claims and quotes. Sized for a long act (a dozen beats over half a dozen
 * seams, each seam inside `SEAM_MAX_CHARS`) with room for the quotes;
 * F-47's thinking-allowance caveat applies here as to the others.
 *
 * THE FLOOR, NOT THE SIZE (2026-09-13 audit, defect 1). This was the fixed
 * budget for every act, however many seams it had. An act's reply is at
 * least the sum of its own seams' upper bands plus its quotes, and a
 * fourteen-seam act at the Carry band alone can exceed this number — at
 * which point the reply is cut off mid-array, `parseOrRepairJson` closes
 * the brackets, and the seams that never got written arrive as
 * `undefined`. `actOutputTokenBudget` below sizes the budget from the
 * request; this stays the floor a small act still gets. */
const MAX_ACT_OUTPUT_TOKENS = 12000;
/** The ceiling, so a pathological act cannot ask for an unbounded reply.
 * Sonnet's own output limit is the real bound; this is the budget guard's. */
const ACT_OUTPUT_TOKEN_CEILING = 32000;
/** Roughly four characters to a token, the same estimate `roughTokenEstimate`
 * uses for the input side. Doubled, because a seam's script reaches the reply
 * as JSON alongside its claims, quotes and pronunciation hints. */
const ACT_OUTPUT_TOKENS_PER_SEAM_CHAR = 0.5;

/**
 * How many output tokens THIS act's reply needs (2026-09-13 audit, defect 1):
 * the sum of every seam's upper character band, converted to tokens and
 * doubled for the JSON the scripts are wrapped in, floored at
 * `MAX_ACT_OUTPUT_TOKENS` and capped at `ACT_OUTPUT_TOKEN_CEILING`.
 *
 * Exported for the prompt tests, which are the only place this class's
 * internals may be read from (never instantiate the class in a test).
 */
export function actOutputTokenBudget(request: Pick<ActWriteRequest, "seams">): number {
  const scriptChars = request.seams.reduce((sum, seam) => sum + (seam.band[1] ?? 0), 0);
  const needed = Math.ceil(scriptChars * ACT_OUTPUT_TOKENS_PER_SEAM_CHAR);
  return Math.min(ACT_OUTPUT_TOKEN_CEILING, Math.max(MAX_ACT_OUTPUT_TOKENS, needed));
}

type WriterOperation = "narration_write_act";

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationWriterBuilder implements NarrationWriterBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests (GV-31 added it, the
   * same pattern GV-25 gave the planning builders), so the Chat twin's parity
   * test can drive this class with a fake; without it nothing changes. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationWriterBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationWriterBuilder() so it falls back to StubNarrationWriterBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /** Q-03: the whole act in one call. See `buildActWritePrompt`. */
  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const raw = await this.askJson(RawActWriteSchema, buildActWritePrompt(request), "narration_write_act", ctx, actOutputTokenBudget(request));
    return toActWriteResult(raw);
  }

  /**
   * The one place this class talks to the model, shared by all of its
   * calls: meter, ask, record the usage WS-B's `pipelineTokens` sums, and
   * hand the reply to the shared parser with a re-ask that is metered in
   * its own right (F-39/F-40 — a malformed reply used to cost a whole page
   * attempt, and the re-ask that fixes that is a second real API call).
   */
  private async askJson<T>(
    schema: z.ZodType<T>,
    promptText: string,
    operation: WriterOperation,
    ctx: NarrationBuildContext,
    maxOutputTokens: number
  ): Promise<T> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation,
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: roughTokenEstimate(promptText) * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await createMessage(this.client, {
      model: MODEL,
      max_tokens: maxOutputTokens,
      messages: [{ role: "user", content: promptText }]
    }, operation);

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic narration-write response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation,
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
      }, operation);
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic narration-write re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(schema, textBlock.text, "LLM output", reask);
  }
}

/**
 * THE REPLY RAN OUT OF ROOM (2026-09-13 audit, defect 1). `stop_reason`
 * was never read, and it is the ONLY signal that distinguishes "the model
 * finished" from "the model was cut off". A cut-off act reply is not
 * malformed in any way the parser can see: `parseOrRepairJson` closes its
 * brackets, the short `seams` array satisfies `RawActWriteSchema`, and
 * every seam that never got written reaches `writeAct.ts` as `undefined`
 * — which used to be recorded as the writer CHOOSING silence.
 *
 * Thrown rather than repaired, and thrown BEFORE the parse so a truncated
 * reply can never become a valid-looking short act. `writeActNarration`
 * lets the throw out to `runPipeline`, which is the same treatment any
 * other writer failure gets: a visible failure beats a Foray whose clips
 * lost their introductions. `max_tokens` on a re-ask is checked the same
 * way — the re-ask re-sends the whole prompt, so it is at least as likely
 * to run out of room as the original call.
 */
export function assertNotTruncated(stopReason: string | null | undefined, operation: WriterOperation, maxOutputTokens: number): void {
  /* Round-3 audit gen-10: the check now lives in anthropicCall.ts and runs on
     EVERY builder's reply (createMessage calls it), not only the writer's. */
  assertReplyComplete(stopReason, operation, maxOutputTokens);
}

/* GV-50 (decision 8): the per-act writer prompt (now [stable][foray][call],
   the voice slot at the end of `stable`) moved to prompts/actWrite.ts, which
   both this builder and its Chat twin import. This builder sends the joined
   'json' prompt, buildActWritePrompt, as one user turn. Re-exported here so
   existing importers compile until GV-96 deletes this module. */
export { actFrameBlock, buildActWritePrompt } from "./prompts/actWrite";
