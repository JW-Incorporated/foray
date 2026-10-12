import * as fs from "fs";
import * as path from "path";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "../../src/generation/chat/openAICompatProvider";

/**
 * GV-13: a scripted stand-in for global fetch, so the OpenAI-compatible
 * client is tested with zero network (the Spark, Jev and LiteLLM are never
 * called from a test, even when reachable).
 *
 * Deliberately narrow, like fakeAnthropicClient.ts: it replays a status,
 * headers and a body, captures what was sent, and can hang. It does not
 * validate requests, so it cannot paper over a call-site bug.
 *
 *   { body, status?, headers? }  one reply; an object body is JSON-encoded,
 *                                a string body is sent verbatim (non-JSON).
 *   { hang: "honor-signal" }     never answers; rejects when the request's
 *                                signal aborts, as real fetch does.
 *   { hang: "deaf" }             never answers and ignores the signal.
 *   { networkError: true }       rejects at once, like a refused connection.
 */
export type FakeFetchReply =
  | { status?: number; headers?: Record<string, string>; body: unknown }
  | { hang: "honor-signal" | "deaf" }
  | { networkError: true };

export interface FakeFetchCall {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  rawBody: string;
  /** The body parsed as JSON. */
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: FakeFetchCall[];
}

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "openai");

/** A committed synthetic body from backend/test/fixtures/openai/<name>.json. */
export function openAIFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

/** Replies in order (the last one repeats), or one per call from a function. */
export function fakeFetch(script: FakeFetchReply | FakeFetchReply[] | ((call: FakeFetchCall) => FakeFetchReply)): FakeFetch {
  const calls: FakeFetchCall[] = [];
  const fetch: FetchLike = (url: string, init: FetchInitLike) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
    const call: FakeFetchCall = {
      url,
      method: init.method,
      headers,
      rawBody: init.body,
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal
    };
    calls.push(call);
    const reply =
      typeof script === "function" ? script(call) : Array.isArray(script) ? script[Math.min(calls.length - 1, script.length - 1)]! : script;
    if ("networkError" in reply) return Promise.reject(new TypeError("fetch failed"));
    if ("hang" in reply) {
      return new Promise<FetchResponseLike>((_, reject) => {
        if (reply.hang === "deaf") return;
        const fail = (): void => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (init.signal.aborted) fail();
        else init.signal.addEventListener("abort", fail, { once: true });
      });
    }
    return Promise.resolve(makeResponse(reply.status ?? 200, reply.headers ?? {}, reply.body));
  };
  return { fetch, calls };
}

function makeResponse(status: number, headers: Record<string, string>, body: unknown): FetchResponseLike {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(text)
  };
}
