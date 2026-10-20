import type { z } from "zod";
import { BUILDER_MAX_TOKENS, spineMaxTokens } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { IntentUnderstanding } from "../../types/generation";
import type { ResearchShape } from "../../types/research";
import type { DurationTier, Spine } from "../../types/spine";
import type { SpineBuildContext, SpineBuilder } from "../SpineBuilder";
import { readBooleanFlag, type FlagSource } from "../generationFlags";
import { toChatMessages } from "../promptLayout";
import { buildSpinePromptParts, spineRevisionTurns } from "../prompts/spine";
import { TruncatedReplyError } from "../replyErrors";
import { RawSpineFoldDeepenSchema, RawSpineSchema, spineFromReply, spineJsonSchema } from "../replySchemas";
import { withCallContext } from "../runLog";
import type { ChatMessage, ChatProvider, ResponseFormat } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06): §4.3 spine construction
 * on a ChatProvider, the twin of AnthropicSpineBuilder, and per decision 9
 * the ONLY Qwen spine class (W4-18's features land here, GV-100).
 *
 * Same prompt (prompts/spine.ts), sent split as [system: the stable rules
 * and reply shape, user: this Foray's intent, research map and tier]
 * (GV-32, toChatMessages), so a re-ask and the next Foray reuse the cached
 * prefix; same re-ask turns (spineRevisionTurns: a structural or seed-floor
 * re-ask appends [the refused spine, the fix turn]; GV-89: a runtime
 * re-ask's fix turn is buildRuntimeFixInstruction); same schema (RawSpineSchema, sent as the 'spine' json_schema), same
 * cap (BUILDER_MAX_TOKENS.spine), and the same Spine fields back
 * (spineFromReply): subject and angle from the intent, the duration asked
 * for, generatedAt now. GV-67: on the folded path (ctx.listenerPrompt set)
 * the prompt carries the listener's words, the reply leads with the copy
 * fields, and subject and angle come from the reply. GV-86: on the
 * folded-deepen path (ctx.foldDeepen) the prompt asks for each act's
 * introduction and exit and each beat's kind, and the reply is held to
 * 'spine_fold_deepen' (RawSpineFoldDeepenSchema) instead of 'spine'.
 *
 * GV-100 (W4-04 items 2-3, W4-18; covers R1-03, R2-07, GP-02, GP-05): TIER
 * SIZING, under FORAY_SPINE_TIER_SIZING (default off; the constructor's
 * `tierSizing` overrides it). On, the same conversation is sent with
 *   - the per-tier json_schema (replySchemas.ts spineJsonSchema: the act
 *     count bounded to the tier, a beat per slot, bounded claim, title and
 *     summary lengths) in place of the tier-blind one;
 *   - the tier-sized cap (config/outputBudgets.ts spineMaxTokens: 675 short,
 *     1800 medium, 3600 long, plus the fold extras) in place of 8000;
 *   - one shorter re-ask on a 'length' stop: the identical turns plus
 *     SPINE_SHORTER_LINE, at the same cap, recorded with reask 'length'. A
 *     second 'length' stop throws TruncatedReplyError (askStructured).
 * The reply is still parsed with the base schema (RawSpineSchema or
 * RawSpineFoldDeepenSchema). Off, every request is byte-identical to the
 * pre-GV-100 one.
 *
 * DARK: constructed only by the stage factories (GV-37) when the spine routes
 * to 'local'. No Anthropic call and no Anthropic module imported: the prompt
 * text lives in prompts/spine.ts (GV-32, decision 8).
 */

/** GV-100: turns the tier-sized spine call on (boolean, default off). */
export const SPINE_TIER_SIZING_ENV = "FORAY_SPINE_TIER_SIZING";

/** FORAY_SPINE_TIER_SIZING at call time; a malformed value throws
 * FlagValueError naming the variable only (generationFlags.ts). */
export function readSpineTierSizing(source: FlagSource = process.env): boolean {
  return readBooleanFlag(SPINE_TIER_SIZING_ENV, false, source);
}

/** GV-100 (W4-18): the one turn a 'length' stop's re-ask appends. */
export const SPINE_SHORTER_LINE = "Shorter: keep every beat one sentence of at most 25 words";

export interface ChatSpineBuilderOptions {
  /** GV-100: tier sizing for this builder; absent, FORAY_SPINE_TIER_SIZING
   * decides at each call. */
  tierSizing?: boolean;
}

type RawSpineReply = z.infer<typeof RawSpineFoldDeepenSchema>;

export class ChatSpineBuilder implements SpineBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard,
    private readonly options: ChatSpineBuilderOptions = {}
  ) {
    this.providerName = target.providerName;
  }

  async buildSpine(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier, ctx: SpineBuildContext): Promise<Spine> {
    const folded = ctx.listenerPrompt !== undefined;
    /* GV-86: the folded-deepen call asks for, and is held to, the act and
       beat fields deepen would add; a classic call sends today's schema. */
    const foldDeepen = ctx.foldDeepen === true;
    const messages: ChatMessage[] = [
      ...toChatMessages(buildSpinePromptParts(intent, researchShape, duration, ctx.listenerPrompt, foldDeepen)),
      ...spineRevisionTurns(ctx.revision, folded)
    ];
    if (this.options.tierSizing ?? readSpineTierSizing()) {
      return spineFromReply(await this.askTierSized(messages, duration, folded, foldDeepen, ctx), intent, duration, folded);
    }
    const { value: raw } = await askStructured<RawSpineReply>({
      provider: this.provider,
      target: this.target,
      schemaName: foldDeepen ? "spine_fold_deepen" : "spine",
      schema: foldDeepen ? RawSpineFoldDeepenSchema : RawSpineSchema,
      messages,
      maxTokens: BUILDER_MAX_TOKENS.spine,
      operation: "spine_build",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "spine"
    });
    return spineFromReply(raw, intent, duration, folded);
  }

  /**
   * GV-100: the tier-sized call. Every ask carries the per-tier json_schema
   * and the tier's cap; a reply cut at that cap is asked once more with the
   * same turns and SPINE_SHORTER_LINE appended, so the cached prefix covers
   * everything before it. A second cut reply is not caught here:
   * askStructured's TruncatedReplyError reaches the caller.
   */
  private async askTierSized(
    messages: ChatMessage[],
    duration: DurationTier,
    folded: boolean,
    foldDeepen: boolean,
    ctx: SpineBuildContext
  ): Promise<RawSpineReply> {
    const schemaName = foldDeepen ? "spine_fold_deepen" : "spine";
    const responseFormat: Extract<ResponseFormat, { type: "json_schema" }> = {
      type: "json_schema",
      name: schemaName,
      schema: spineJsonSchema(duration, { foldDeepen }),
      strict: true
    };
    /* The tier's cap from the one budget table (decision 10). */
    const maxTokens = spineMaxTokens(duration, { foldCopy: folded, foldDeepen });
    const ask = async (turns: ChatMessage[]): Promise<RawSpineReply> =>
      (
        await askStructured<RawSpineReply>({
          provider: this.provider,
          target: this.target,
          schemaName,
          responseFormat,
          schema: foldDeepen ? RawSpineFoldDeepenSchema : RawSpineSchema,
          messages: turns,
          maxTokens,
          operation: "spine_build",
          budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
          label: "spine"
        })
      ).value;
    try {
      return await ask(messages);
    } catch (error) {
      if (!(error instanceof TruncatedReplyError)) throw error;
      return withCallContext({ reask: "length" }, () => ask([...messages, { role: "user", content: SPINE_SHORTER_LINE }]));
    }
  }
}
