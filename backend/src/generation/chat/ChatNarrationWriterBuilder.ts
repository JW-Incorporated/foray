import { defaultBudgetGuard } from "../../cost/budgetGuard";
import { actOutputTokenBudget } from "../AnthropicNarrationWriterBuilder";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, NarrationWriterBuilder } from "../NarrationWriterBuilder";
import { toChatMessages } from "../promptLayout";
import { actWritePromptParts } from "../prompts/actWrite";
import { RawActWriteSchema, toActWriteResult } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-31 (docs/roadmap/generation-v2.md, from W2-07; covers R2-21, GP-06,
 * HW-12, R1-18): §4.7 act writing on a ChatProvider, the twin of
 * AnthropicNarrationWriterBuilder: the same prompt (prompts/actWrite.ts, the
 * whole act in one call; GV-50 sends it as toChatMessages(actWritePromptParts),
 * [system: the rules, the reply contract and the voice slot; user: the voice
 * line + this act], so the system message is the prefix every act, round and
 * Foray shares, where the Anthropic writer sends the same parts joined), the
 * same schema (RawActWriteSchema, sent as the
 * 'act_write' json_schema), the same per-act budget (actOutputTokenBudget,
 * sized from the act's seam bands, floor 12000) and the same post-parse
 * mapping (toActWriteResult). writeAct.ts's quote checks, verifier rounds and
 * gates run on the result exactly as they do on the Anthropic one.
 *
 * NON-STREAMING: one reply per act. This is the correctness baseline and the
 * fallback for the streamed writer (R1-06); a whole act at about 22 tok/s
 * does not meet the 30 s first-audio target on its own.
 *
 * Decision 9: this is the only Qwen writer class; the local writer's features
 * (W4-19) land here rather than in a second class.
 *
 * DARK: constructed only by the stage factories (GV-37) when the writer
 * routes to 'local'. The provider comes in through the constructor, so a test
 * drives it with a scripted provider. No Anthropic call; the Anthropic module
 * is imported for its prompt text and budget only (decision 8).
 */
export class ChatNarrationWriterBuilder implements NarrationWriterBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "act_write",
      schema: RawActWriteSchema,
      messages: toChatMessages(actWritePromptParts(request)),
      maxTokens: actOutputTokenBudget(request),
      operation: "narration_write_act",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "narration_write_act"
    });
    return toActWriteResult(value);
  }
}
