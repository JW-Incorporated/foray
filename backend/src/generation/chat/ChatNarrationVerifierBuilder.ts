import { BUILDER_MAX_TOKENS } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import { buildActVerifyPrompt } from "../AnthropicNarrationVerifierBuilder";
import type { ActVerifyRequest, ActVerifyResult, NarrationBuildContext, NarrationVerifierBuilder } from "../NarrationVerifierBuilder";
import { RawActVerifySchema, toActVerifyResult } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-31 (docs/roadmap/generation-v2.md, from W2-07; covers R2-21, GP-06,
 * HW-12, R1-18): §4.7 act verification on a ChatProvider, the twin of
 * AnthropicNarrationVerifierBuilder: the same prompt (buildActVerifyPrompt,
 * the beats as the checklist and the act's sources as one set), the same
 * schema (RawActVerifySchema, sent as the 'act_verify' json_schema), the same
 * cap (BUILDER_MAX_TOKENS.verifier) and the same post-parse mapping
 * (toActVerifyResult).
 *
 * A SEPARATE class from ChatNarrationWriterBuilder, as the Anthropic pair
 * are: §4.7 rule 2 ("1 per act, never the writer") is enforced by
 * writeNarration.ts taking two distinct instances, and this file shares no
 * state with the writer. It is the local baseline and the fallback for the
 * Jev verifier (R1-07).
 *
 * DARK: constructed only by the stage factories (GV-37) when the verifier
 * routes to 'local'. No Anthropic call; the Anthropic module is imported for
 * its prompt text only (decision 8).
 */
export class ChatNarrationVerifierBuilder implements NarrationVerifierBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "act_verify",
      schema: RawActVerifySchema,
      messages: [{ role: "user", content: buildActVerifyPrompt(request) }],
      maxTokens: BUILDER_MAX_TOKENS.verifier,
      operation: "narration_verify",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "narration-verify"
    });
    return toActVerifyResult(value);
  }
}
