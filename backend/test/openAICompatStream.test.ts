import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";
import {
  OpenAICompatChatProvider,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type StreamBodyLike
} from "../src/generation/chat/openAICompatProvider";
import { ChatProviderError, type ChatRequest, type ChatStreamEvent } from "../src/generation/chat/ChatProvider";
import { RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-40 (docs/roadmap/generation-v2.md, from W2-02; covers HW-12, GP-06):
 * OpenAICompatChatProvider.stream() and the scripted provider's stream
 * scripts. Offline only: the server is a scripted fetch whose body is a web
 * ReadableStream over the synthetic SSE fixtures in test/fixtures/openai/
 * (or literals); no test reaches LiteLLM, the Spark or Jev. Each test names
 * the mutation it kills; every one was applied and seen red.
 */

const KEY = "sk-synthetic-key-never-leaks-0000";
const BASE = "http://litellm.invalid:4000";
const FIXTURE_DIR = path.join(__dirname, "fixtures", "openai");

const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/\r\n/g, "\n");
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The concatenated content of every delta in a fixture (read independently
 * of the provider, from the JSON of each data line). */
function fixtureText(name: string): string {
  let text = "";
  for (const line of fixture(name).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const json = JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> };
    text += json.choices[0]?.delta.content ?? "";
  }
  return text;
}

/** One body step: bytes after an optional delay, a read failure, or a read that never settles. */
type Step = { bytes: string | Uint8Array; delayMs?: number } | { fail: true; delayMs?: number } | { hang: true };

interface StreamServer {
  fetch: FetchLike;
  calls: Array<{ url: string; init: FetchInitLike; body: Record<string, unknown> }>;
  /** True once the provider cancelled the body. */
  cancelled(): boolean;
}

/** A scripted fetch whose 2xx body is a web ReadableStream of `steps`. */
function streamServer(
  steps: Step[],
  opts: { status?: number; headers?: Record<string, string>; headersDelayMs?: number; plainIterable?: boolean } = {}
): StreamServer {
  const calls: StreamServer["calls"] = [];
  let cancelled = false;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    if (opts.headersDelayMs) await sleep(opts.headersDelayMs);
    const lower = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const status = opts.status ?? 200;
    let i = 0;
    const next = async (): Promise<{ done: true } | { done: false; value: Uint8Array }> => {
      const step = steps[i++];
      if (!step) return { done: true };
      if ("hang" in step) return new Promise(() => undefined);
      if (step.delayMs) await sleep(step.delayMs);
      if ("fail" in step) throw new TypeError("terminated");
      return { done: false, value: typeof step.bytes === "string" ? encode(step.bytes) : step.bytes };
    };
    const body: StreamBodyLike = opts.plainIterable
      ? {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              const r = await next();
              return r.done ? { done: true as const, value: undefined } : { done: false as const, value: r.value };
            },
            return: async () => {
              cancelled = true;
              return { done: true as const, value: undefined };
            }
          })
        }
      : (new ReadableStream<Uint8Array>({
          async pull(controller) {
            const r = await next();
            if (r.done) controller.close();
            else controller.enqueue(r.value);
          },
          cancel() {
            cancelled = true;
          }
        }) as unknown as StreamBodyLike);
    const res: FetchResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null },
      text: async () => "upstream body text",
      body
    };
    return res;
  };
  return { fetch, calls, cancelled: () => cancelled };
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "local-heavy",
    messages: [
      { role: "system", content: "Write the seams as JSONL." },
      { role: "user", content: "two seams" }
    ],
    maxTokens: 512,
    label: "narrate act 1",
    ...overrides
  };
}

function provider(server: StreamServer, extra: { timeoutMs?: number } = {}): OpenAICompatChatProvider {
  return new OpenAICompatChatProvider({ baseUrl: BASE, apiKey: KEY, fetchImpl: server.fetch, ...extra });
}

async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** Drains and returns the error thrown, with the events seen before it. */
async function drainToError(stream: AsyncIterable<ChatStreamEvent>): Promise<{ events: ChatStreamEvent[]; err: unknown }> {
  const events: ChatStreamEvent[] = [];
  try {
    for await (const e of stream) events.push(e);
  } catch (err) {
    return { events, err };
  }
  throw new Error("expected the stream to throw");
}

const deltaText = (events: ChatStreamEvent[]): string =>
  events.map((e) => (e.type === "delta" ? e.text : "")).join("");

/** The fixture's SSE events, one step each (the blank line kept with its event). */
function eventSteps(name: string, delayMs = 0): Step[] {
  return fixture(name)
    .split(/(?<=\n\n)/)
    .filter((s) => s.length > 0)
    .map((bytes) => (delayMs ? { bytes, delayMs } : { bytes }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAICompatChatProvider.stream: the request", () => {
  /* Kills: dropping stream_options (usage then never arrives), or spreading
     the stream fields before extraBody (a caller's stream:false would turn
     streaming off under an SSE reader). */
  it("POSTs stream:true and stream_options.include_usage after extraBody, with the key only in the auth header", async () => {
    const server = streamServer(eventSteps("stream-jsonl.txt"));
    await drain(provider(server).stream(request({ extraBody: { stream: false, top_k: 20 } })));
    expect(server.calls).toHaveLength(1);
    const call = server.calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/chat/completions`);
    expect(call.body).toMatchObject({
      model: "local-heavy",
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
      top_k: 20
    });
    expect(call.init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.init.body).not.toContain(KEY);
  });
});

describe("OpenAICompatChatProvider.stream: reading the stream", () => {
  /* Kills: reading delta.reasoning_content into the text, or yielding the
     empty role delta. */
  it("yields every content delta in order, then exactly one done with usage from the include_usage chunk", async () => {
    const server = streamServer(eventSteps("stream-jsonl.txt"), { headers: { "x-litellm-call-id": "litellm-call-7" } });
    const events = await drain(provider(server).stream(request()));
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual([
      '{"seam":1,"script":"Neutral synthetic',
      ' narration for the first seam."}\n{"seam"',
      ':2,"script":"A second line, café',
      '-style — with a dash."}\n'
    ]);
    expect(deltaText(events)).toBe(fixtureText("stream-jsonl.txt"));
    expect(JSON.stringify(events)).not.toContain("Synthetic reasoning");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const done = events[events.length - 1]!;
    expect(done).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 321, completionTokens: 40, cachedTokens: 256, reasoningTokens: null },
      model: "synthetic-heavy-27b",
      requestId: "litellm-call-7"
    });
  });

  /* Kills: assuming one SSE event per network chunk (a JSON.parse of half a
     data line throws malformed_chunk). */
  it("fast-check: the same deltas and done whatever the byte split, and through a plain async-iterable body", async () => {
    const bytes = encode(fixture("stream-jsonl.txt"));
    const reference = await drain(provider(streamServer([{ bytes }])).stream(request()));
    const strip = (es: ChatStreamEvent[]) => es.map((e) => (e.type === "done" ? { ...e, timing: null } : e));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: bytes.length - 1 }), { maxLength: 30 }), async (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b);
        const steps: Step[] = [];
        let start = 0;
        for (const p of [...points, bytes.length]) {
          steps.push({ bytes: bytes.slice(start, p) });
          start = p;
        }
        const events = await drain(provider(streamServer(steps, { plainIterable: cuts.length % 2 === 1 })).stream(request()));
        expect(strip(events)).toEqual(strip(reference));
      }),
      { numRuns: 60 }
    );
  });

  /* Kills: throwing on finish_reason 'length', or defaulting a missing usage
     chunk to zeros. */
  it("finish_reason 'length' is reported on done and not thrown; usage is null when no usage chunk came", async () => {
    const events = await drain(provider(streamServer(eventSteps("stream-length.txt"))).stream(request()));
    expect(deltaText(events)).toBe('{"seam":1,"script":"A reply cut short by the token');
    expect(events[events.length - 1]).toMatchObject({ type: "done", finishReason: "length", usage: null });
  });

  /* Kills: stamping firstByteAt when the headers arrive (or at the empty
     role delta) instead of at the first content delta. */
  it("under fake timers firstByteAt is the first content delta's time; the CallRecord gets queueMs, ttftMs and the decode rate", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const log = new RunLog();
    const server = streamServer(eventSteps("stream-jsonl.txt", 100), {
      headersDelayMs: 50,
      headers: { "x-litellm-model-id": "spark-sglang-a2" }
    });
    const p = provider(server);
    const seen: Array<{ type: string; at: number }> = [];
    let done: ChatStreamEvent | undefined;
    const run = runWithRunLog(log, () =>
      withCallContext({ stage: "narrate:1", act: 1 }, async () => {
        for await (const e of p.stream(request())) {
          seen.push({ type: e.type, at: Date.now() });
          if (e.type === "done") done = e;
        }
      })
    );
    await vi.runAllTimersAsync();
    await run;
    /* Headers at +50; events every 100 ms: comment +150, role +250,
       reasoning +350, first content +450. */
    const firstDeltaAt = seen.find((e) => e.type === "delta")!.at;
    expect(firstDeltaAt).toBe(1_000_450);
    expect(done).toMatchObject({ timing: { startedAt: 1_000_000, firstByteAt: 1_000_450 } });
    const endedAt = (done as Extract<ChatStreamEvent, { type: "done" }>).timing.endedAt;
    expect(endedAt).toBe(seen[seen.length - 1]!.at);
    const calls = log.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stage: "narrate:1",
      act: 1,
      provider: "openai-compat",
      machine: "spark-sglang-a2",
      model: "local-heavy",
      label: "narrate act 1",
      startMs: 0,
      queueMs: 50,
      ttftMs: 450,
      promptTokens: 321,
      cachedTokens: 256,
      outputTokens: 40,
      maxTokens: 512,
      stopReason: "stop"
    });
    expect(calls[0]!.decodeTokPerSec).toBeCloseTo(40 / ((endedAt - 1_000_450) / 1000), 6);
    expect(calls[0]).not.toHaveProperty("error");
    expect(log.toJsonl()).not.toContain(KEY);
  });
});

describe("OpenAICompatChatProvider.stream: failures keep the partial text", () => {
  const steps = eventSteps("stream-jsonl.txt");
  /* Indexes of the steps that carry a content delta, in order. */
  const contentSteps = steps
    .map((s, i) => ("bytes" in s && typeof s.bytes === "string" && s.bytes.includes('"content":"') && !s.bytes.includes('"content":""') ? i : -1))
    .filter((i) => i >= 0);
  const deltaTexts = [
    '{"seam":1,"script":"Neutral synthetic',
    ' narration for the first seam."}\n{"seam"',
    ':2,"script":"A second line, café',
    '-style — with a dash."}\n'
  ];

  /* Kills: a partialText of '' (or of only the last delta), and treating a
     stream that ends without finish_reason or [DONE] as a success. */
  it("fast-check: a drop after N deltas throws ChatProviderError whose partialText is the N deltas, by EOF and by a failed read", async () => {
    expect(contentSteps).toHaveLength(4);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.boolean(), async (n, byFailure) => {
        const cutAt = n === 0 ? contentSteps[0]! : contentSteps[n - 1]! + 1;
        const kept: Step[] = steps.slice(0, cutAt);
        if (byFailure) kept.push({ fail: true });
        const log = new RunLog();
        const { events, err } = await runWithRunLog(log, () => drainToError(provider(streamServer(kept)).stream(request())));
        expect(err).toBeInstanceOf(ChatProviderError);
        const e = err as ChatProviderError;
        expect(e.kind).toBe("network");
        expect(e.message).toBe(byFailure ? "network" : "stream_dropped");
        expect(e.partialText).toBe(deltaTexts.slice(0, n).join(""));
        expect(deltaText(events)).toBe(e.partialText);
        expect(events.some((x) => x.type === "done")).toBe(false);
        expect(log.calls()).toHaveLength(1);
        expect(log.calls()[0]).toMatchObject({ error: { kind: "network" }, outputTokens: null });
      }),
      { numRuns: 30 }
    );
  });

  /* Kills: copying the in-stream error's text into the message, or
     skipping the error check (the stream would end as a silent success). */
  it("an in-stream {error} and a non-JSON chunk throw with the partial text and a fixed reason", async () => {
    const head = steps.slice(0, contentSteps[1]! + 1);
    const upstream = 'data: {"error":{"message":"upstream secret detail","code":500}}\n\n';
    const a = await drainToError(provider(streamServer([...head, { bytes: upstream }])).stream(request()));
    expect(a.err).toMatchObject({ kind: "network", message: "stream_error", partialText: deltaTexts.slice(0, 2).join("") });
    expect(JSON.stringify({ m: (a.err as Error).message, s: String(a.err) })).not.toContain("upstream secret");
    const b = await drainToError(provider(streamServer([...head, { bytes: "data: {not json\n\n" }])).stream(request()));
    expect(b.err).toMatchObject({ kind: "malformed", message: "malformed_chunk", partialText: deltaTexts.slice(0, 2).join("") });
  });

  /* Kills: reading an error body into the message. */
  it("an http error throws http_<status> with no partial text and one CallRecord", async () => {
    const log = new RunLog();
    const { err } = await runWithRunLog(log, () => drainToError(provider(streamServer([], { status: 503 })).stream(request())));
    expect(err).toMatchObject({ kind: "http", status: 503, message: "http_503" });
    expect((err as ChatProviderError).partialText).toBeUndefined();
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]).toMatchObject({ error: { kind: "http", status: 503 }, queueMs: expect.any(Number), ttftMs: null });
  });
});

describe("OpenAICompatChatProvider.stream: cancelling", () => {
  /* Kills: removing the abort race around each body read (a body that never
     answers hangs the stream past the caller's abort). */
  it("the caller's AbortSignal cancels a stalled read: kind 'aborted', partialText kept, body cancelled", async () => {
    const steps = eventSteps("stream-jsonl.txt");
    const server = streamServer([...steps.slice(0, 4), { hang: true }]);
    const controller = new AbortController();
    const stream = provider(server).stream(request({ signal: controller.signal }));
    const events: ChatStreamEvent[] = [];
    const pending = (async () => {
      try {
        for await (const e of stream) {
          events.push(e);
          if (events.length === 1) setTimeout(() => controller.abort(), 0);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    const err = await pending;
    expect(err).toMatchObject({ kind: "aborted", message: "aborted", partialText: '{"seam":1,"script":"Neutral synthetic' });
    expect(server.cancelled()).toBe(true);
  });

  /* Kills: no timeout on the body read (only on the headers). */
  it("the timeout fires mid-stream: kind 'timeout' with the partial text", async () => {
    vi.useFakeTimers({ now: 0 });
    const steps = eventSteps("stream-jsonl.txt");
    const server = streamServer([...steps.slice(0, 4), { hang: true }]);
    const result = drainToError(provider(server, { timeoutMs: 5_000 }).stream(request()));
    await vi.advanceTimersByTimeAsync(5_000);
    const { err } = await result;
    expect(err).toMatchObject({ kind: "timeout", partialText: '{"seam":1,"script":"Neutral synthetic' });
    expect(server.cancelled()).toBe(true);
  });

  /* Kills: not cancelling the body when the consumer stops early, or
     recording that stop as a success (or not at all). */
  it("a consumer that breaks early cancels the body and records one CallRecord with error 'aborted'", async () => {
    const steps = eventSteps("stream-jsonl.txt");
    const server = streamServer([...steps.slice(0, 4), { hang: true }]);
    const log = new RunLog();
    await runWithRunLog(log, async () => {
      for await (const e of provider(server).stream(request())) {
        if (e.type === "delta") break;
      }
    });
    expect(server.cancelled()).toBe(true);
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]).toMatchObject({ error: { kind: "aborted" }, ttftMs: expect.any(Number) });
  });
});

describe("scriptedProvider stream scripts (GV-40 self-test)", () => {
  /* Kills: a fake that yields all chunks at once (the second line would be
     seen at the first line's time), or stamps firstByteAt at the start. */
  it("replays a JSONL writer reply line by line with delays under fake timers, then one done", async () => {
    vi.useFakeTimers({ now: 5_000 });
    const lines = ['{"seam":1,"script":"First synthetic seam."}\n', '{"seam":2,"script":"Second synthetic seam."}\n'];
    const p = scriptedProvider({
      stream: [
        {
          chunks: [
            { text: "", delayMs: 300 },
            { text: lines[0]!.slice(0, 20), delayMs: 200 },
            { text: lines[0]!.slice(20), delayMs: 100 },
            { text: lines[1]!, delayMs: 1_000 }
          ],
          finish: "stop",
          usage: { promptTokens: 10, completionTokens: 24, cachedTokens: null, reasoningTokens: null }
        }
      ]
    });
    const completed: Array<{ line: string; at: number }> = [];
    let done: ChatStreamEvent | undefined;
    const run = (async () => {
      let buf = "";
      for await (const e of p.stream!(request())) {
        if (e.type === "done") {
          done = e;
          continue;
        }
        buf += e.text;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          completed.push({ line: buf.slice(0, nl), at: Date.now() });
          buf = buf.slice(nl + 1);
        }
      }
    })();
    await vi.runAllTimersAsync();
    await run;
    expect(completed).toEqual([
      { line: lines[0]!.trim(), at: 5_600 },
      { line: lines[1]!.trim(), at: 6_600 }
    ]);
    expect(done).toMatchObject({
      type: "done",
      finishReason: "stop",
      model: "local-heavy",
      usage: { completionTokens: 24 },
      timing: { startedAt: 5_000, firstByteAt: 5_500, endedAt: 6_600 }
    });
    expect(p.requests).toHaveLength(1);
  });

  /* Kills: a scripted drop that throws without the partial text. */
  it("a scripted drop throws ChatProviderError with the chunks so far; no stream script means no stream method", async () => {
    const p = scriptedProvider({ stream: [{ chunks: [{ text: "ab" }, { text: "cd" }], drop: {} }] });
    const { events, err } = await drainToError(p.stream!(request()));
    expect(deltaText(events)).toBe("abcd");
    expect(err).toMatchObject({ kind: "network", message: "stream_dropped", partialText: "abcd" });
    expect(() => p.stream!(request())).toThrow(/no stream scripted/);
    expect(scriptedProvider({ complete: ["x"] }).stream).toBeUndefined();
  });
});
