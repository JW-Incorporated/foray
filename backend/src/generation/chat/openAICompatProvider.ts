import { currentRunLog, recordModelCall } from "../runLog";
import {
  ChatProviderError,
  type ChatFinishReason,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
  type ChatTokenLogprob,
  type ChatUsage,
  type ResponseFormat
} from "./ChatProvider";
import { parseSse } from "./sse";

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
 *
 * GV-40 adds stream(): the same POST with `stream: true` and
 * `stream_options: {include_usage: true}` (set last, so extraBody cannot turn
 * streaming off), read as Server-Sent Events by chat/sse.ts. INERT like
 * complete(): nothing calls stream() until the writing workstream's streamed
 * writer. Per stream():
 *   - yields {type:'delta', text} for each non-empty choices[0].delta.content,
 *     in order; `reasoning_content` deltas are dropped;
 *   - then exactly one {type:'done', finishReason, usage, model, requestId,
 *     timing}. usage comes from the include_usage chunk and is null when the
 *     server sent none (some LiteLLM versions drop it). finish_reason
 *     'length' is reported there and never thrown;
 *   - timing.firstByteAt is the first non-empty content delta (true TTFT),
 *     null when the reply had no content;
 *   - a failure after the request was sent (the body read fails, a chunk is
 *     not JSON, the server sends an in-stream error, or the stream ends with
 *     neither a finish_reason nor [DONE]) throws ChatProviderError with
 *     `partialText` = every delta received so far, so a consumer can keep the
 *     seams that finished (R1-06). Reasons: 'network', 'stream_dropped',
 *     'stream_error', 'malformed_chunk', 'malformed_stream', 'timeout',
 *     'aborted';
 *   - the caller's AbortSignal and the timeout cancel the body read, and so
 *     does a consumer that stops iterating early;
 *   - one CallRecord at the end (success, failure or early stop), with
 *     queueMs = request sent to response headers (connection plus proxy
 *     admission; SGLang's own queue and prefill land in ttftMs), ttftMs =
 *     request sent to the first content delta, and decodeTokPerSec =
 *     completion tokens over first delta to end, when usage was reported.
 */

/** The slice of a fetch Response this client reads. `body` is read only by
 * stream() (GV-40): Node's fetch gives a web ReadableStream; a test may give
 * any async iterable of byte chunks. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: StreamBodyLike | null;
}

/** A ReadableStream (its reader surface), or a plain async iterable of chunks. */
export type StreamBodyLike = { getReader(): StreamReaderLike } | AsyncIterable<Uint8Array | string>;

export interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
  cancel(reason?: unknown): Promise<void>;
}

interface AbortScope {
  controller: AbortController;
  aborted: Promise<never>;
  classify(partialText?: string): ChatProviderError;
  close(): void;
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
    const scope = this.openScope(req);
    const { aborted, classify } = scope;
    try {
      const res = await this.post(body, scope);
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
      scope.close();
    }
  }

  /**
   * GV-40: one streamed reply (see the module comment). An async generator,
   * so nothing is sent until the first `next()`.
   */
  async *stream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const log = currentRunLog();
    const logStartMs = log?.nowMs() ?? 0;
    const startedAt = this.now();
    const marks: StreamMarks = { logHeadersMs: null, logFirstDeltaMs: null };
    let rawFinish: string | null = null;
    let usage: ChatUsage | null = null;
    let servedBy: string | null = null;
    let failure: { kind: string; status?: number } | undefined;
    let finished = false;
    let text = "";
    const body = JSON.stringify({ ...buildRequestBody(req), stream: true, stream_options: { include_usage: true } });
    const scope = this.openScope(req);
    try {
      const res = await this.post(body, scope);
      marks.logHeadersMs = log?.nowMs() ?? null;
      if (!res.ok) {
        /* The body is drained and dropped, never read into the error. */
        void res.text().catch(() => undefined);
        throw new ChatProviderError("http", `http_${res.status}`, { status: res.status });
      }
      servedBy = res.headers.get("x-litellm-model-id") ?? null;
      const requestId = res.headers.get("x-request-id") ?? res.headers.get("x-litellm-call-id") ?? null;
      if (!res.body) throw new ChatProviderError("malformed", "malformed_stream", { partialText: text });
      let model: string | null = null;
      let firstByteAt: number | null = null;
      let sawDone = false;
      const events = parseSse(readBody(res.body, scope), { onDone: () => (sawDone = true) });
      try {
        for await (const data of events) {
          const chunk = parseChunk(data, text);
          if (chunk.model !== null) model = chunk.model;
          if (chunk.usage !== null) usage = chunk.usage;
          if (chunk.rawFinish !== null) rawFinish = chunk.rawFinish;
          if (chunk.content !== "") {
            if (firstByteAt === null) {
              firstByteAt = this.now();
              marks.logFirstDeltaMs = log?.nowMs() ?? null;
            }
            text += chunk.content;
            yield { type: "delta", text: chunk.content };
          }
        }
      } catch (err) {
        if (err instanceof ChatProviderError) throw err;
        /* The body read failed: the timeout, the caller's abort or a drop. */
        throw scope.classify(text);
      }
      if (rawFinish === null && !sawDone) throw new ChatProviderError("network", "stream_dropped", { partialText: text });
      finished = true;
      yield {
        type: "done",
        finishReason: rawFinish === null ? "other" : mapFinishReason(rawFinish),
        usage,
        model,
        requestId,
        timing: { startedAt, firstByteAt, endedAt: this.now() }
      };
    } catch (err) {
      failure =
        err instanceof ChatProviderError
          ? { kind: err.kind, ...(err.status !== undefined ? { status: err.status } : {}) }
          : { kind: err instanceof Error ? err.name : typeof err };
      throw err;
    } finally {
      /* A consumer that stopped early (break, return) lands here with
         neither a finish nor a failure: the read is cancelled and recorded
         as aborted. */
      if (!finished && !failure) {
        scope.controller.abort();
        failure = { kind: "aborted" };
      }
      scope.close();
      this.recordStream(req, logStartMs, marks, rawFinish, usage, servedBy, failure);
    }
  }

  /** GV-40: the stream's one CallRecord; a no-op outside a RunLog. */
  private recordStream(
    req: ChatRequest,
    logStartMs: number,
    marks: StreamMarks,
    rawFinish: string | null,
    usage: ChatUsage | null,
    servedBy: string | null,
    failure: { kind: string; status?: number } | undefined
  ): void {
    const log = currentRunLog();
    if (!log) return;
    const endMs = log.nowMs();
    const outputTokens = failure ? null : (usage?.completionTokens ?? null);
    const decodeMs = marks.logFirstDeltaMs === null ? null : endMs - marks.logFirstDeltaMs;
    recordModelCall({
      provider: this.name,
      machine: servedBy,
      model: req.model,
      label: req.label,
      startMs: logStartMs,
      endMs,
      queueMs: marks.logHeadersMs === null ? null : marks.logHeadersMs - logStartMs,
      ttftMs: marks.logFirstDeltaMs === null ? null : marks.logFirstDeltaMs - logStartMs,
      promptTokens: failure ? null : (usage?.promptTokens ?? null),
      cachedTokens: failure ? null : (usage?.cachedTokens ?? null),
      outputTokens,
      decodeTokPerSec: outputTokens !== null && decodeMs !== null && decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null,
      maxTokens: req.maxTokens,
      stopReason: rawFinish,
      ...(failure ? { error: failure } : {})
    });
  }

  /**
   * The timeout and the caller's signal, joined into one AbortController.
   * `aborted` rejects when either fires; `classify` names the cause. Shared
   * by complete() and stream(), so both cancel the same way.
   */
  private openScope(req: ChatRequest): AbortScope {
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
    const classify = (partialText?: string): ChatProviderError => {
      const extra = partialText !== undefined ? { partialText } : {};
      return timedOut
        ? new ChatProviderError("timeout", "timeout", extra)
        : callerSignal?.aborted
          ? new ChatProviderError("aborted", "aborted", extra)
          : new ChatProviderError("network", "network", extra);
    };
    return {
      controller,
      aborted,
      classify,
      close: () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    };
  }

  /** POSTs the body; a request cancelled before it started never reaches the server. */
  private async post(body: string, scope: AbortScope): Promise<FetchResponseLike> {
    if (scope.controller.signal.aborted) throw scope.classify();
    try {
      return await Promise.race([
        scope.aborted,
        this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body,
          signal: scope.controller.signal
        })
      ]);
    } catch {
      throw scope.classify();
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
  return {
    text: typeof content === "string" ? content : "",
    finishReason: mapFinishReason(choice.finish_reason),
    rawFinish: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: parseUsage(isRecord(json.usage) ? json.usage : {}),
    model: typeof json.model === "string" ? json.model : null,
    logprobs: parseLogprobs(choice.logprobs)
  };
}

interface StreamMarks {
  /** Log-clock time the response headers arrived. */
  logHeadersMs: number | null;
  /** Log-clock time of the first non-empty content delta. */
  logFirstDeltaMs: number | null;
}

/**
 * The response body as chunks. Each read is raced against the scope's abort
 * (a body that ignores its signal cannot hang the stream), and the source is
 * cancelled when the iteration ends early, fails or is aborted.
 */
async function* readBody(body: StreamBodyLike, scope: AbortScope): AsyncGenerator<Uint8Array | string, void, undefined> {
  if ("getReader" in body && typeof body.getReader === "function") {
    const reader = body.getReader();
    let drained = false;
    try {
      for (;;) {
        const step = await Promise.race([scope.aborted, reader.read()]);
        if (step.done) {
          drained = true;
          return;
        }
        if (step.value !== undefined) yield step.value;
      }
    } finally {
      if (!drained) void reader.cancel().catch(() => undefined);
    }
  }
  const iterator = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
  let drained = false;
  try {
    for (;;) {
      const step = await Promise.race([scope.aborted, iterator.next()]);
      if (step.done) {
        drained = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!drained) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

interface ParsedChunk {
  content: string;
  rawFinish: string | null;
  usage: ChatUsage | null;
  model: string | null;
}

/** One SSE data payload; `partialText` (the text so far) goes on any error. */
function parseChunk(data: string, partialText: string): ParsedChunk {
  const malformed = (): ChatProviderError => new ChatProviderError("malformed", "malformed_chunk", { partialText });
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw malformed();
  }
  if (!isRecord(json)) throw malformed();
  /* LiteLLM reports an upstream failure mid-stream as {error: {...}}; its
     text is never read into the error. */
  if (json.error !== undefined && json.error !== null) {
    throw new ChatProviderError("network", "stream_error", { partialText });
  }
  let content = "";
  let rawFinish: string | null = null;
  if (json.choices !== undefined) {
    if (!Array.isArray(json.choices)) throw malformed();
    const choice: unknown = json.choices[0];
    if (choice !== undefined) {
      if (!isRecord(choice)) throw malformed();
      /* `reasoning_content` deltas (SGLang's qwen3 parser) are never read. */
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const piece = delta.content;
      if (piece !== null && piece !== undefined && typeof piece !== "string") throw malformed();
      if (typeof piece === "string") content = piece;
      if (typeof choice.finish_reason === "string") rawFinish = choice.finish_reason;
    }
  }
  return {
    content,
    rawFinish,
    usage: isRecord(json.usage) ? parseUsage(json.usage) : null,
    model: typeof json.model === "string" ? json.model : null
  };
}

function parseUsage(usage: Record<string, unknown>): ChatUsage {
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return {
    promptTokens: count(usage.prompt_tokens),
    completionTokens: count(usage.completion_tokens),
    cachedTokens: count(promptDetails.cached_tokens),
    reasoningTokens: count(completionDetails.reasoning_tokens)
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
