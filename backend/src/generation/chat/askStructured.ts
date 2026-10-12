import type { z } from "zod";
import type { CostEventInput } from "../../cost/costEvents";
import { parseWithRetry } from "../parseWithRetry";
import { TruncatedReplyError } from "../replyErrors";
import type { ReplySchemaName } from "../replySchemas";
import { recordUsage } from "../usageTracking";
import type { ChatMessage, ChatProvider, ChatRequest, ChatResponse, ResponseFormat } from "./ChatProvider";
import { responseFormatFor } from "./jsonSchema";

/**
 * GV-19 (docs/roadmap/generation-v2.md, from W2-04; covers R1-18, GP-06,
 * HW-12): ONE provider-neutral JSON call.
 *
 * anthropicCall.ts's createMessage holds two rules (record every reply's
 * usage; refuse a reply that hit its token ceiling BEFORE anything parses
 * it), and every Anthropic* builder carries its own copy of "meter, ask,
 * parse, metered re-ask" (AnthropicNarrationWriterBuilder.askJson is one).
 * A Chat* builder asks through this function instead, so on the chat path
 * those rules, and a grammar constraint on every JSON reply, hold by
 * construction rather than by each builder remembering them.
 *
 * Per call (the re-ask repeats steps 1-4):
 *   1. Meter: budget.guard.checkAndRecord with an estimate of chars/4 input
 *      tokens plus maxTokens output tokens at the target's rates. Local
 *      targets cost $0 today, so the dollar cap is inert for them; this is
 *      the hook where seconds and Jev unit caps (R1-19) attach.
 *   2. provider.complete, with response_format from the target's
 *      structuredOutput: responseFormatFor(schemaName) for 'json_schema',
 *      {type:'json_object'} for 'json_object', none for 'none'. Thinking is
 *      off unless the target turns it on.
 *   3. recordUsage (usageTracking.ts): one call, its token counts.
 *   4. A finishReason of 'length' throws TruncatedReplyError (replyErrors.ts,
 *      the same class the Anthropic path throws).
 *   5. parseWithRetry with a re-ask that re-sends the messages, the bad reply
 *      and one corrective user turn, with the SAME response_format. Only
 *      the first bad reply is re-asked; a budget refusal while re-asking
 *      stays visible on the thrown error's `cause` (parseWithRetry.ts).
 *
 * No CallRecord is appended here: the provider records its own request
 * (GV-07's PROVIDER_CALL_SITES), and parseWithRetry records the parse
 * outcome and runs the re-ask under withCallContext({reask:'json'}).
 *
 * INERT: no builder calls this yet (W2-06, W2-07 and W2-12 will). It takes no
 * Anthropic client and makes no Anthropic call.
 */

/** The model a structured call goes to. Defined here so this module does not
 * depend on the stage-routing card. */
export interface StructuredTarget {
  /** Recorded on the cost event as `provider`. */
  providerName: string;
  /** The LiteLLM route or served model id. */
  model: string;
  /** How the reply's shape is constrained while it decodes. */
  structuredOutput: "json_schema" | "json_object" | "none";
  usdPerMtokIn: number;
  usdPerMtokOut: number;
  /** Qwen3 thinking mode; off unless set (ChatRequest.thinking). */
  thinking?: boolean;
  temperature?: number;
}

/** The slice of BudgetGuard this function uses. */
export interface StructuredBudgetGuard {
  checkAndRecord(input: CostEventInput): Promise<unknown>;
}

export interface AskStructuredInput<T> {
  provider: ChatProvider;
  target: StructuredTarget;
  /** Names the json_schema response_format (replySchemas.ts). */
  schemaName: ReplySchemaName;
  /** The zod schema the reply is parsed against. */
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  maxTokens: number;
  /** The cost event's operation label. */
  operation: string;
  budget: { guard: StructuredBudgetGuard; userId: string; sessionId?: string };
  /** What the call is for; sent as the request label and used in errors. */
  label: string;
}

export interface AskStructuredResult<T> {
  value: T;
  /** True when the first reply did not parse and one re-ask was made. */
  reasked: boolean;
  /** The reply the value was parsed from (the re-ask's, when reasked). */
  response: ChatResponse;
}

/** The corrective turn a re-ask appends (the Anthropic builders' wording). */
export const REASK_LINE = "Your previous reply was not valid JSON; reply with the JSON object only.";

/** Roughly four characters to a token, as the Anthropic builders estimate. */
function estimateUsd(messages: readonly ChatMessage[], maxTokens: number, target: StructuredTarget): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / 4);
  return (inputTokens * target.usdPerMtokIn + maxTokens * target.usdPerMtokOut) / 1_000_000;
}

function responseFormatOf(target: StructuredTarget, schemaName: ReplySchemaName): ResponseFormat | undefined {
  switch (target.structuredOutput) {
    case "json_schema":
      return responseFormatFor(schemaName);
    case "json_object":
      return { type: "json_object" };
    case "none":
      return undefined;
  }
}

export async function askStructured<T>(input: AskStructuredInput<T>): Promise<AskStructuredResult<T>> {
  const { provider, target, schemaName, schema, maxTokens, operation, budget, label } = input;
  const responseFormat = responseFormatOf(target, schemaName);

  /* Step 1's cost event. The guard is called at each call site (first ask
     and re-ask) so every `reask` closure visibly meters itself, the rule
     parseWithRetry.test.ts checks across backend/src. */
  const costEventFor = (messages: readonly ChatMessage[]): CostEventInput => ({
    userId: budget.userId,
    operation,
    provider: target.providerName,
    model: target.model,
    estimatedUsd: estimateUsd(messages, maxTokens, target),
    ...(budget.sessionId !== undefined ? { sessionId: budget.sessionId } : {})
  });

  /* Steps 2-4: send, record usage, refuse a truncated reply. */
  const send = async (messages: ChatMessage[]): Promise<ChatResponse> => {
    const request: ChatRequest = {
      model: target.model,
      messages,
      maxTokens,
      thinking: target.thinking ?? false,
      label,
      ...(responseFormat ? { responseFormat } : {}),
      ...(target.temperature !== undefined ? { temperature: target.temperature } : {})
    };
    const response = await provider.complete(request);
    recordUsage({
      input_tokens: response.usage.promptTokens ?? undefined,
      output_tokens: response.usage.completionTokens ?? undefined
    });
    if (response.finishReason === "length") {
      throw new TruncatedReplyError(
        `${provider.name} ${label} reply was truncated: the model hit max_tokens (${maxTokens}) before finishing its JSON. ` +
          "A truncated reply would parse as a shorter valid answer (parseOrRepairJson closes the brackets), so it is refused here instead."
      );
    }
    return response;
  };

  await budget.guard.checkAndRecord(costEventFor(input.messages));
  const first = await send(input.messages);
  let last = first;
  let reasked = false;
  const reask = async (): Promise<string> => {
    reasked = true;
    const reaskMessages: ChatMessage[] = [...input.messages, { role: "assistant", content: first.text }, { role: "user", content: REASK_LINE }];
    await budget.guard.checkAndRecord(costEventFor(reaskMessages));
    last = await send(reaskMessages);
    return last.text;
  };
  const value = await parseWithRetry(schema, first.text, label, reask);
  return { value, reasked, response: last };
}
