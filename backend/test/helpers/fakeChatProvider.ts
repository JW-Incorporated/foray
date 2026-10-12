import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/generation/chat/ChatProvider";

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
 */
export type ScriptedReply = string | (Partial<ChatResponse> & { text: string }) | Error;

export interface ScriptedProvider extends ChatProvider {
  readonly requests: ChatRequest[];
}

export function scriptedProvider(script: {
  complete: ScriptedReply[] | ((req: ChatRequest) => ScriptedReply);
  name?: string;
}): ScriptedProvider {
  const requests: ChatRequest[] = [];
  let next = 0;
  return {
    name: script.name ?? "scripted",
    requests,
    async complete(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      let reply: ScriptedReply;
      if (typeof script.complete === "function") {
        reply = script.complete(req);
      } else {
        if (next >= script.complete.length) {
          throw new Error(`scriptedProvider: no reply scripted for call ${next + 1} (label ${req.label})`);
        }
        reply = script.complete[next++]!;
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
