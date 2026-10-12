import { BUILDER_MAX_TOKENS } from "../../config/outputBudgets";
import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { ClarityResult, IntentUnderstanding } from "../../types/generation";
import type { PromptUnderstandContext, PromptUnderstander } from "../PromptUnderstander";
import { joinParts, toChatMessages } from "../promptLayout";
import { buildClarityPromptParts, buildIntentPromptParts, recaseIntentTitle } from "../prompts/understand";
import { ClaritySchema, IntentSchema, TitleRecaseSchema } from "../replySchemas";
import type { ChatProvider } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06; covers R2-21, GP-06,
 * HW-12, R1-18): §4.1 clarity and intent on a ChatProvider (a local Qwen lane
 * behind LiteLLM), the twin of AnthropicPromptUnderstander.
 *
 * Same words, same schemas, same caps: the prompts are the Anthropic
 * builder's (prompts/understand.ts), sent split as [system: the rules and
 * the reply shape, user: the listener's prompt] (GV-32, promptLayout.ts's
 * toChatMessages) so the rules are a prefix every call shares; the replies parse
 * against ClaritySchema / IntentSchema / TitleRecaseSchema, and max_tokens is
 * BUILDER_MAX_TOKENS (clarity 400, intent 600, title 120). Every call goes
 * through askStructured: metered, json_schema-constrained, a 'length' reply
 * refused, one re-ask for an invalid reply. The title re-case is the SHARED
 * recaseIntentTitle, so the 3-turn conversation and "a failure keeps the
 * title" are one implementation; the only difference is that a title reply
 * that is not valid JSON costs askStructured's one JSON re-ask before the
 * helper keeps the title.
 *
 * DARK: constructed only by the stage factories (GV-37) when a stage routes
 * to 'local'. No Anthropic call and no Anthropic module imported: the
 * prompt text lives in prompts/understand.ts (GV-32, decision 8).
 */
export class ChatPromptUnderstander implements PromptUnderstander {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard
  ) {
    this.providerName = target.providerName;
  }

  private budget(ctx: PromptUnderstandContext) {
    return { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) };
  }

  async assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "clarity",
      schema: ClaritySchema,
      messages: toChatMessages(buildClarityPromptParts(prompt)),
      maxTokens: BUILDER_MAX_TOKENS.clarity,
      operation: "prompt_clarity",
      budget: this.budget(ctx),
      label: "prompt-understand"
    });
    return value;
  }

  async extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
    const parts = buildIntentPromptParts(prompt);
    const { value: intent } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "intent",
      schema: IntentSchema,
      messages: toChatMessages(parts),
      maxTokens: BUILDER_MAX_TOKENS.intent,
      operation: "prompt_intent",
      budget: this.budget(ctx),
      label: "prompt-understand"
    });
    return recaseIntentTitle(intent, joinParts(parts), prompt, "ChatPromptUnderstander", async ({ messages }) => {
      /* The helper's conversation opens with the intent prompt as one user
         turn; here that turn goes split, exactly as the intent call sent it,
         so the re-ask reuses the intent call's cached prefix (GV-32). The
         assistant turn and the corrective line follow unchanged. */
      const [, ...rest] = messages;
      const { value } = await askStructured({
        provider: this.provider,
        target: this.target,
        schemaName: "title_recase",
        schema: TitleRecaseSchema,
        messages: [...toChatMessages(parts), ...rest],
        maxTokens: BUILDER_MAX_TOKENS.title,
        operation: "prompt_intent",
        budget: this.budget(ctx),
        label: "prompt-understand"
      });
      return JSON.stringify(value);
    });
  }
}
