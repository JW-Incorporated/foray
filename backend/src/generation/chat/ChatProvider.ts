/**
 * GV-13 (docs/roadmap/generation-v2.md, from W2-01; covers HW-12, GP-06): the
 * provider-neutral contract a generation stage will use to ask an
 * OpenAI-compatible model (LiteLLM on the Spark at :4000, which fronts SGLang
 * and the second box's llama-server) for one reply.
 *
 * Types only, plus the one error class every provider throws. The
 * OpenAI-compatible client is chat/openAICompatProvider.ts; the streaming
 * half (`stream`) is GV-40's. Nothing on the default generation path imports
 * this module yet.
 *
 * Call context is NOT here (decision 3): stage, act, seam, attempt, priority
 * and lane come from runLog.ts's `withCallContext`, and a provider records
 * each request with runLog's `recordModelCall` (GV-07), which merges that
 * context in. There is no CallObserver and no chat/callContext.ts.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Grammar-constrained output. The json_schema shape is the one
 * chat/jsonSchema.ts's `responseFormatFor(name)` returns (GV-02); the
 * provider translates it to OpenAI's wire shape
 * `{type:'json_schema', json_schema:{name, schema, strict}}`.
 */
export type ResponseFormat =
  | { readonly type: "json_schema"; readonly name: string; readonly schema: object; readonly strict: boolean }
  | { readonly type: "json_object" };

export interface ChatRequest {
  /** The LiteLLM route (local-heavy, local-worker, ...) or a served model id. */
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  responseFormat?: ResponseFormat;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /**
   * Qwen3's thinking mode. Defaults to false, sent as
   * `chat_template_kwargs: {enable_thinking: false}`, because the Spark runs
   * SGLang with `--reasoning-parser qwen3`: left on, the model reasons before
   * every reply and the output budget goes to text nobody reads.
   */
  thinking?: boolean;
  /** SGLang request priority (sent as `priority`); omitted when unset. */
  priority?: number;
  /** Extra body fields, spread LAST over the request body (so they win). */
  extraBody?: Record<string, unknown>;
  /** What the call is for ('spine', 'narrate act 2'); recorded on the CallRecord. */
  label: string;
  /** Cancels the request; the provider then throws kind 'aborted'. */
  signal?: AbortSignal;
  /** Ask for token logprobs with the `top` alternatives per position. */
  logprobs?: { top: number };
}

export type ChatFinishReason = "stop" | "length" | "content_filter" | "other";

/** Every count the server did not report is null, never 0: an absent
 * measurement must not read as a cheap or uncached call. */
export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

/** Epoch milliseconds on the provider's clock. For a non-streaming call
 * `firstByteAt` is when the response headers arrived (for a streamed one,
 * GV-40, the first content delta). */
export interface ChatTiming {
  startedAt: number;
  firstByteAt: number | null;
  endedAt: number;
}

export interface ChatTokenLogprob {
  token: string;
  logprob: number;
  top: Array<{ token: string; logprob: number }>;
}

export interface ChatResponse {
  text: string;
  finishReason: ChatFinishReason;
  usage: ChatUsage;
  /** The model the server says answered, or null when it did not say. */
  model: string | null;
  /** x-request-id, else x-litellm-call-id; null when neither header came. */
  requestId: string | null;
  /** x-litellm-model-id (the LiteLLM deployment that served it); unverified
   * against a live LiteLLM, so null when absent. */
  servedBy: string | null;
  timing: ChatTiming;
  /** Present only when the request asked for logprobs and the server sent them. */
  logprobs?: ChatTokenLogprob[];
}

/** GV-40 implements `stream`; the event shape is fixed here so consumers and
 * the scripted fake agree on it. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      finishReason: ChatFinishReason;
      usage: ChatUsage | null;
      model: string | null;
      requestId: string | null;
      timing: ChatTiming;
    };

export interface ChatProvider {
  readonly name: string;
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream?(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export type ChatProviderErrorKind = "http" | "timeout" | "network" | "malformed" | "aborted";

/**
 * Every failure a provider reports. The message is a FIXED reason
 * ('http_429', 'timeout', 'malformed_json', ...): it never carries the API
 * key, the upstream response body or the prompt, so it is safe to log and to
 * put in a report. `partialText` is for a stream that died midway (GV-40).
 */
export class ChatProviderError extends Error {
  readonly kind: ChatProviderErrorKind;
  readonly status?: number;
  readonly partialText?: string;

  constructor(kind: ChatProviderErrorKind, reason: string, extra: { status?: number; partialText?: string } = {}) {
    super(reason);
    this.name = "ChatProviderError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.partialText !== undefined) this.partialText = extra.partialText;
  }
}
