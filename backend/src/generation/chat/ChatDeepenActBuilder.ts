import { BUILDER_MAX_TOKENS } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { Act, DeepenedAct, Spine } from "../../types/spine";
import { buildDeepenActPrompt } from "../AnthropicDeepenActBuilder";
import type { DeepenActBuilder, DeepenActContext } from "../DeepenActBuilder";
import { RawDeepenedActSchema } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06): §4.4 act deepening on a
 * ChatProvider, the twin of AnthropicDeepenActBuilder: the same prompt
 * (buildDeepenActPrompt, the full spine attached), the same schema
 * (RawDeepenedActSchema, sent as the 'deepen_act' json_schema), the same cap
 * (BUILDER_MAX_TOKENS.deepen). deepenActs.ts's seed and claim restoration
 * runs on the result exactly as it does on the Anthropic one.
 *
 * DARK: constructed only by the stage factories (GV-37) when deepen routes to
 * 'local' (the second box by default). No Anthropic call; the Anthropic
 * module is imported for its prompt text only (decision 8).
 */
export class ChatDeepenActBuilder implements DeepenActBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  async deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "deepen_act",
      schema: RawDeepenedActSchema,
      messages: [{ role: "user", content: buildDeepenActPrompt(fullSpine, targetAct, targetActIndex) }],
      maxTokens: BUILDER_MAX_TOKENS.deepen,
      operation: "deepen_act",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "deepen-act"
    });
    return value;
  }
}
