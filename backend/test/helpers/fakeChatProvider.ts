import {
  ChatProviderError,
  type ChatFinishReason,
  type ChatProvider,
  type ChatProviderErrorKind,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
  type ChatUsage
} from "../../src/generation/chat/ChatProvider";

/**
 * GV-13: a scripted ChatProvider for builder tests (W2-04, W2-06, W2-07,
 * W2-12 and later), so they never depend on the HTTP client or the
 * streaming card. GV-40 extends it with stream scripts.
 *
 * A reply is the text alone, a partial ChatResponse (missing fields get the
 * defaults below), or an Error, which complete() throws. `complete` is a list
 * consumed in order, or a function of the request. Every request is recorded
 * in `requests`, in order, failures included. Running past the end of a list
 * throws, so a test that makes one call too many fails loudly.
 *
 * It records no CallRecord: only the real provider call sites do (GV-07).
 *
 * GV-40: `stream` scripts, same rules (a list consumed in order, or a
 * function of the request; running past the end throws). One script is
 * `{chunks: [{text, delayMs}], finish, usage}`: each chunk waits delayMs on
 * setTimeout (so vitest fake timers drive it), then yields its text as a
 * delta (an empty text waits but yields nothing, as the real provider drops
 * empty deltas); then one done with finish (default 'stop'), usage (default
 * null) and timing from Date.now (firstByteAt = the first non-empty chunk).
 * `drop` throws ChatProviderError(kind, reason) with partialText = the chunks
 * yielded, instead of done. An aborted req.signal throws kind 'aborted' with
 * the partial text. The provider has a `stream` method only when a stream
 * script is given. Stream requests go into the same `requests` list.
 */
export type ScriptedReply = string | (Partial<ChatResponse> & { text: string }) | Error;

export interface ScriptedStream {
  chunks: Array<{ text: string; delayMs?: number }>;
  finish?: ChatFinishReason;
  usage?: ChatUsage | null;
  /** The model on done; defaults to the request's. */
  model?: string | null;
  requestId?: string | null;
  /** Fail after the chunks instead of finishing. */
  drop?: { kind?: ChatProviderErrorKind; reason?: string };
}

export interface ScriptedProvider extends ChatProvider {
  readonly requests: ChatRequest[];
}

export function scriptedProvider(script: {
  complete?: ScriptedReply[] | ((req: ChatRequest) => ScriptedReply);
  stream?: ScriptedStream[] | ((req: ChatRequest) => ScriptedStream);
  name?: string;
}): ScriptedProvider {
  const requests: ChatRequest[] = [];
  const completeScript = script.complete ?? [];
  let next = 0;
  let nextStream = 0;
  const streamScript = script.stream;
  return {
    name: script.name ?? "scripted",
    requests,
    ...(streamScript
      ? {
          stream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
            requests.push(req);
            let plan: ScriptedStream;
            if (typeof streamScript === "function") {
              plan = streamScript(req);
            } else {
              if (nextStream >= streamScript.length) {
                throw new Error(`scriptedProvider: no stream scripted for call ${nextStream + 1} (label ${req.label})`);
              }
              plan = streamScript[nextStream++]!;
            }
            return playStream(plan, req);
          }
        }
      : {}),
    async complete(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      let reply: ScriptedReply;
      if (typeof completeScript === "function") {
        reply = completeScript(req);
      } else {
        if (next >= completeScript.length) {
          throw new Error(`scriptedProvider: no reply scripted for call ${next + 1} (label ${req.label})`);
        }
        reply = completeScript[next++]!;
      }
      if (reply instanceof Error) throw reply;
      return toResponse(reply, req);
    }
  };
}

function toResponse(reply: Exclude<ScriptedReply, Error>, req: ChatRequest): ChatResponse {
  const partial = typeof reply === "string" ? { text: reply } : reply;
  return {
    finishReason: "stop",
    usage: { promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null },
    model: req.model,
    requestId: null,
    servedBy: null,
    timing: { startedAt: 0, firstByteAt: 0, endedAt: 0 },
    ...partial
  };
}

async function* playStream(plan: ScriptedStream, req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const startedAt = Date.now();
  let firstByteAt: number | null = null;
  let text = "";
  const aborted = (): ChatProviderError => new ChatProviderError("aborted", "aborted", { partialText: text });
  for (const chunk of plan.chunks) {
    if (chunk.delayMs !== undefined && chunk.delayMs > 0) await delay(chunk.delayMs, req.signal);
    if (req.signal?.aborted) throw aborted();
    if (chunk.text === "") continue;
    if (firstByteAt === null) firstByteAt = Date.now();
    text += chunk.text;
    yield { type: "delta", text: chunk.text };
  }
  if (req.signal?.aborted) throw aborted();
  if (plan.drop) {
    throw new ChatProviderError(plan.drop.kind ?? "network", plan.drop.reason ?? "stream_dropped", { partialText: text });
  }
  yield {
    type: "done",
    finishReason: plan.finish ?? "stop",
    usage: plan.usage ?? null,
    model: plan.model === undefined ? req.model : plan.model,
    requestId: plan.requestId ?? null,
    timing: { startedAt, firstByteAt, endedAt: Date.now() }
  };
}

/** Waits on setTimeout; an abort ends the wait early (the caller then throws). */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
