import { currentRunLog, recordModelCall } from "../runLog";
import {
  ChatProviderError,
  type ChatFinishReason,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTokenLogprob,
  type ChatUsage,
  type ResponseFormat
} from "./ChatProvider";

/**
 * GV-13 (docs/roadmap/generation-v2.md, from W2-01): a NON-STREAMING client
 * for an OpenAI-compatible chat endpoint: LiteLLM on the Spark (:4000),
 * which fronts SGLang and the second box's llama-server; llama.cpp and
 * SGLang directly speak the same shape. Built on Node's global fetch, no
 * SDK and no new dependency, so later cards can move stages off
 * anthropicCall.ts without adding one.
 *
 * INERT: nothing imports this module outside generation/chat/ (the
 * openAICompatProvider test greps for it). A stage reaches it only through a
 * later routing card.
 *
 * What it does, once per complete():
 *   - POSTs `${baseUrl}/v1/chat/completions` with `Authorization: Bearer <key>`.
 *     The key goes in that header and nowhere else: not the body, not an
 *     error message, not a CallRecord.
 *   - Sends `chat_template_kwargs: {enable_thinking: false}` unless the
 *     request asks for thinking (the Spark parses Qwen3 reasoning).
 *   - Reads choices[0].message.content; `reasoning_content` is ignored.
 *   - Times out with an AbortController after `timeoutMs` (default 120 s).
 *     There are NO retries: a retry is a caller's policy, with a budget.
 *   - Records exactly one CallRecord per call, success or failure, with
 *     runLog's recordModelCall (GV-07; this file is in PROVIDER_CALL_SITES),
 *     which merges the enclosing withCallContext. queueMs, ttftMs and
 *     decodeTokPerSec stay null: a non-streaming call cannot measure them
 *     (the headers arrive only when decoding is done), and GV-40's streamed
 *     calls fill them.
 *
 * Every failure is a ChatProviderError whose message is a fixed reason
 * ('http_<status>', 'timeout', 'network', 'malformed_json',
 * 'malformed_choice', 'aborted'); the upstream body is never read into it.
 */

/** The slice of a fetch Response this client reads. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Node's global fetch satisfies this; tests inject backend/test/helpers/fakeFetch.ts. */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface OpenAICompatChatProviderOptions {
  /** e.g. http://192.168.0.72:4000 (no trailing /v1). */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Epoch-milliseconds clock for ChatResponse.timing (injectable for tests). */
  now?: () => number;
  /** The provider name recorded on each CallRecord. */
  name?: string;
}

export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

export class OpenAICompatChatProvider implements ChatProvider {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: OpenAICompatChatProviderOptions) {
    if (typeof opts.baseUrl !== "string" || opts.baseUrl.trim() === "") {
      throw new Error("OpenAICompatChatProvider: baseUrl is required");
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new Error("OpenAICompatChatProvider: timeoutMs must be a positive number");
    }
    const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof fetchImpl !== "function") throw new Error("OpenAICompatChatProvider: no fetch implementation");
    this.name = opts.name ?? "openai-compat";
    this.url = `${opts.baseUrl.trim().replace(/\/+$/, "")}/v1/chat/completions`;
    this.apiKey = opts.apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = opts.now ?? Date.now;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const logStartMs = currentRunLog()?.nowMs() ?? 0;
    const startedAt = this.now();
    let rawFinish: string | null = null;
    let response: ChatResponse | undefined;
    let failure: { kind: string; status?: number } | undefined;
    try {
      response = await this.send(req, startedAt, (finish) => (rawFinish = finish));
      return response;
    } catch (err) {
      /* A ChatProviderError is recorded by kind; anything else (a bug, not a
         transport failure) by its name, and rethrown unchanged. */
      failure =
        err instanceof ChatProviderError
          ? { kind: err.kind, ...(err.status !== undefined ? { status: err.status } : {}) }
          : { kind: err instanceof Error ? err.name : typeof err };
      throw err;
    } finally {
      this.record(req, logStartMs, rawFinish, response, failure);
    }
  }

  private async send(req: ChatRequest, startedAt: number, onFinish: (raw: string | null) => void): Promise<ChatResponse> {
    const body = JSON.stringify(buildRequestBody(req));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const callerSignal = req.signal;
    const onCallerAbort = (): void => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    /* Why the abort is raced as well as passed: a fetch (or a body read) that
       ignores its signal would otherwise hang past timeoutMs. */
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error("aborted"));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined);
    const classify = (): ChatProviderError =>
      timedOut
        ? new ChatProviderError("timeout", "timeout")
        : callerSignal?.aborted
          ? new ChatProviderError("aborted", "aborted")
          : new ChatProviderError("network", "network");

    try {
      /* A request cancelled before it started never reaches the server. */
      if (controller.signal.aborted) throw classify();
      let res: FetchResponseLike;
      try {
        res = await Promise.race([
          aborted,
          this.fetchImpl(this.url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body,
            signal: controller.signal
          })
        ]);
      } catch {
        throw classify();
      }
      const firstByteAt = this.now();
      if (!res.ok) {
        /* The body is drained and dropped, never read into the error. */
        void res.text().catch(() => undefined);
        throw new ChatProviderError("http", `http_${res.status}`, { status: res.status });
      }
      let raw: string;
      try {
        raw = await Promise.race([aborted, res.text()]);
      } catch {
        throw classify();
      }
      const parsed = parseReply(raw);
      onFinish(parsed.rawFinish);
      return {
        text: parsed.text,
        finishReason: parsed.finishReason,
        usage: parsed.usage,
        model: parsed.model,
        requestId: res.headers.get("x-request-id") ?? res.headers.get("x-litellm-call-id") ?? null,
        servedBy: res.headers.get("x-litellm-model-id") ?? null,
        timing: { startedAt, firstByteAt, endedAt: this.now() },
        ...(req.logprobs && parsed.logprobs ? { logprobs: parsed.logprobs } : {})
      };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** GV-07: one CallRecord per call, success or failure; a no-op outside a RunLog. */
  private record(
    req: ChatRequest,
    logStartMs: number,
    rawFinish: string | null,
    response: ChatResponse | undefined,
    failure: { kind: string; status?: number } | undefined
  ): void {
    const log = currentRunLog();
    if (!log) return;
    recordModelCall({
      provider: this.name,
      machine: response?.servedBy ?? null,
      model: req.model,
      label: req.label,
      startMs: logStartMs,
      endMs: log.nowMs(),
      queueMs: null,
      ttftMs: null,
      promptTokens: response?.usage.promptTokens ?? null,
      cachedTokens: response?.usage.cachedTokens ?? null,
      outputTokens: response?.usage.completionTokens ?? null,
      maxTokens: req.maxTokens,
      stopReason: rawFinish,
      ...(failure ? { error: failure } : {})
    });
  }
}

/** The OpenAI chat-completions body. Unset optional fields are left out;
 * `extraBody` is spread last, so a caller's explicit field wins. */
export function buildRequestBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: req.maxTokens
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop !== undefined) body.stop = req.stop;
  if (req.responseFormat !== undefined) body.response_format = wireResponseFormat(req.responseFormat);
  body.chat_template_kwargs = { enable_thinking: req.thinking ?? false };
  if (req.priority !== undefined) body.priority = req.priority;
  if (req.logprobs !== undefined) {
    body.logprobs = true;
    body.top_logprobs = req.logprobs.top;
  }
  return { ...body, ...(req.extraBody ?? {}) };
}

function wireResponseFormat(format: ResponseFormat): Record<string, unknown> {
  if (format.type === "json_object") return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
}

function mapFinishReason(raw: unknown): ChatFinishReason {
  return raw === "stop" || raw === "length" || raw === "content_filter" ? raw : "other";
}

const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

interface ParsedReply {
  text: string;
  finishReason: ChatFinishReason;
  rawFinish: string | null;
  usage: ChatUsage;
  model: string | null;
  logprobs: ChatTokenLogprob[] | undefined;
}

function parseReply(raw: string): ParsedReply {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ChatProviderError("malformed", "malformed_json");
  }
  if (!isRecord(json) || !Array.isArray(json.choices)) throw new ChatProviderError("malformed", "malformed_choice");
  const choice: unknown = json.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw new ChatProviderError("malformed", "malformed_choice");
  /* `reasoning_content` (SGLang's qwen3 parser, llama-server) is never read. */
  const content = choice.message.content;
  if (content !== null && content !== undefined && typeof content !== "string") {
    throw new ChatProviderError("malformed", "malformed_choice");
  }
  const usage = isRecord(json.usage) ? json.usage : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return {
    text: typeof content === "string" ? content : "",
    finishReason: mapFinishReason(choice.finish_reason),
    rawFinish: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: {
      promptTokens: count(usage.prompt_tokens),
      completionTokens: count(usage.completion_tokens),
      cachedTokens: count(promptDetails.cached_tokens),
      reasoningTokens: count(completionDetails.reasoning_tokens)
    },
    model: typeof json.model === "string" ? json.model : null,
    logprobs: parseLogprobs(choice.logprobs)
  };
}

function parseLogprobs(raw: unknown): ChatTokenLogprob[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.content)) return undefined;
  const out: ChatTokenLogprob[] = [];
  for (const entry of raw.content) {
    if (!isRecord(entry) || typeof entry.token !== "string" || typeof entry.logprob !== "number") continue;
    const top = Array.isArray(entry.top_logprobs)
      ? entry.top_logprobs
          .filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.token === "string" && typeof t.logprob === "number")
          .map((t) => ({ token: t.token as string, logprob: t.logprob as number }))
      : [];
    out.push({ token: entry.token, logprob: entry.logprob, top });
  }
  return out;
}
