import { BUILDER_MAX_TOKENS } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { ContinuityBuildContext, ContinuityBuilder, ContinuitySmoothRequest, ContinuitySmoothResult } from "../ContinuityBuilder";
import { toChatMessages } from "../promptLayout";
import { buildSmoothPromptParts } from "../prompts/continuity";
import { RawSmoothResultSchema } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06): §4.8 act-boundary
 * smoothing on a ChatProvider, the twin of AnthropicContinuityBuilder: the
 * same prompt (prompts/continuity.ts), sent split as [system: the rules and
 * reply shape, user: this seam] (GV-32, toChatMessages); the same schema (RawSmoothResultSchema,
 * sent as the 'continuity_smooth' json_schema), the same cap
 * (BUILDER_MAX_TOKENS.continuity). The return shape is still only the next
 * act's introduction, so forward-only holds by construction.
 *
 * DARK: constructed only by the stage factories (GV-37) when continuity
 * routes to 'local'. No Anthropic call and no Anthropic module imported: the
 * prompt text lives in prompts/continuity.ts (GV-32, decision 8).
 */
export class ChatContinuityBuilder implements ContinuityBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  async smoothSeam(request: ContinuitySmoothRequest, ctx: ContinuityBuildContext): Promise<ContinuitySmoothResult> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "continuity_smooth",
      schema: RawSmoothResultSchema,
      messages: toChatMessages(buildSmoothPromptParts(request)),
      maxTokens: BUILDER_MAX_TOKENS.continuity,
      operation: "continuity_smooth",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "continuity-smooth"
    });
    return value;
  }
}
