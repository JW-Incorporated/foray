import { BUILDER_MAX_TOKENS } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { IntentUnderstanding } from "../../types/generation";
import type { ResearchShape } from "../../types/research";
import type { DurationTier, Spine } from "../../types/spine";
import type { SpineBuildContext, SpineBuilder } from "../SpineBuilder";
import { toChatMessages } from "../promptLayout";
import { buildSpinePromptParts, spineRevisionTurns } from "../prompts/spine";
import { RawSpineSchema } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06): §4.3 spine construction
 * on a ChatProvider, the twin of AnthropicSpineBuilder, and per decision 9
 * the ONLY Qwen spine class (W4-18's features land here later, GV-100).
 *
 * Same prompt (prompts/spine.ts), sent split as [system: the stable rules
 * and reply shape, user: this Foray's intent, research map and tier]
 * (GV-32, toChatMessages), so a re-ask and the next Foray reuse the cached
 * prefix; same re-ask turns (spineRevisionTurns: a structural or seed-floor
 * re-ask appends [the refused spine, the fix turn]); same schema (RawSpineSchema, sent as the 'spine' json_schema), same
 * cap (BUILDER_MAX_TOKENS.spine), and the same Spine fields back: subject and
 * angle from the intent, the duration asked for, generatedAt now.
 *
 * DARK: constructed only by the stage factories (GV-37) when the spine routes
 * to 'local'. No Anthropic call and no Anthropic module imported: the prompt
 * text lives in prompts/spine.ts (GV-32, decision 8).
 */
export class ChatSpineBuilder implements SpineBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  async buildSpine(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier, ctx: SpineBuildContext): Promise<Spine> {
    const { value: raw } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "spine",
      schema: RawSpineSchema,
      messages: [...toChatMessages(buildSpinePromptParts(intent, researchShape, duration)), ...spineRevisionTurns(ctx.revision)],
      maxTokens: BUILDER_MAX_TOKENS.spine,
      operation: "spine_build",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "spine"
    });
    return {
      subject: intent.subject,
      angle: intent.angle,
      overview: raw.overview,
      duration,
      generatedAt: new Date().toISOString(),
      voice: raw.voice,
      acts: raw.acts
    };
  }
}
