import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANE_PROFILES, mergeLaneProfiles, type LaneProfiles } from "../src/config/machineProfiles";
import { UnitBudgetExceededError, UnitBudgetGuard } from "../src/cost/unitBudget";
import { ChatProviderError, type ChatProvider, type ChatRequest, type ChatResponse, type ChatStreamEvent } from "../src/generation/chat/ChatProvider";
import { LaneScheduledProvider, criticalFor, priorityOf, type ScheduledChatRequest } from "../src/generation/chat/laneScheduler";
import { OpenAICompatChatProvider, type FetchLike, type FetchResponseLike } from "../src/generation/chat/openAICompatProvider";
import { FORAY_REQUEST_USER, __setChatProviderForTests, getChatProvider } from "../src/generation/chat/providerRegistry";
import { RunLog, currentCallContext, currentRunLog, runWithRunLog, withCallContext, type CallContext } from "../src/generation/runLog";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";

/**
 * GV-93: the lane scheduler (chat/laneScheduler.ts) and its two wire changes
 * in openAICompatProvider.ts (`user`, queueMs). Offline: the inner provider
 * is a hand-driven fake, or the real client over a fake fetch; nothing
 * reaches the Spark, LiteLLM or Jev.
 */

/* ------------------------------------------------------------------------ */
/* A hand-driven inner provider: every call waits until the test settles it. */
/* ------------------------------------------------------------------------ */

interface PendingCall {
  req: ScheduledChatRequest;
  ctx: CallContext;
  resolve: (text?: string) => void;
  reject: (err: Error) => void;
}

function reply(req: ChatRequest, text: string): ChatResponse {
  return {
    text,
    finishReason: "stop",
    usage: { promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null },
    model: req.model,
    requestId: null,
    servedBy: null,
    timing: { startedAt: 0, firstByteAt: 0, endedAt: 0 }
  };
}

function manualProvider(): ChatProvider & { calls: PendingCall[]; inFlight: () => number; maxInFlight: () => number } {
  const calls: PendingCall[] = [];
  let live = 0;
  let peak = 0;
  return {
    name: "manual",
    calls,
    inFlight: () => live,
    maxInFlight: () => peak,
    complete(req: ChatRequest): Promise<ChatResponse> {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise<ChatResponse>((resolve, reject) => {
        calls.push({
          req: req as ScheduledChatRequest,
          ctx: currentCallContext(),
          resolve: (text = req.label) => {
            live -= 1;
            resolve(reply(req, text));
          },
          reject: (err) => {
            live -= 1;
            reject(err);
          }
        });
      });
    }
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function request(label: string, model = "local-heavy", extra: Partial<ChatRequest> = {}): ChatRequest {
  return { model, messages: [{ role: "user", content: "x".repeat(400) }], maxTokens: 64, label, ...extra };
}

/** Spark at 2 slots with 1 reserved for the critical path (the default profile). */
const SPARK_2_1: LaneProfiles = DEFAULT_LANE_PROFILES;

/* withCallContext is a no-op outside a run, so a call made outside one is
   given a run of its own (the scheduler under test is told no session, so
   the RunLog meters nothing). */
const inContext = <T>(ctx: CallContext, fn: () => T): T =>
  currentRunLog() ? withCallContext(ctx, fn) : runWithRunLog(new RunLog(), () => withCallContext(ctx, fn));
const critical = <T>(fn: () => T): T => inContext({ stage: "spine" }, fn);
const background = <T>(fn: () => T): T => inContext({ stage: "evidence" }, fn);

function scheduler(inner: ChatProvider, profiles: LaneProfiles = SPARK_2_1, extra: Partial<ConstructorParameters<typeof LaneScheduledProvider>[1]> = {}) {
  return new LaneScheduledProvider(inner, { profiles, unitGuard: new UnitBudgetGuard(), sessionOf: () => undefined, ...extra });
}

/* ------------------------------------------------------------------------ */

describe("criticalFor(stage, act): the critical-path table", () => {
  /* MUTATION THAT KILLS THIS: drop "source" from CRITICAL_STAGES (or make
     the act-0 rule `act <= 1`) -- the matching row goes red. Ran both -- red. */
  const rows: Array<[string | undefined, number | undefined, boolean]> = [
    ["understand", undefined, true],
    ["topic", undefined, true],
    ["research-shape", undefined, true],
    ["spine", undefined, true],
    ["source", undefined, true],
    ["narrate:0", 0, true],
    ["narrate:1", 1, false],
    ["narrate:2", 2, false],
    ["narrate:3", 3, false],
    ["narrate:0", undefined, true],
    ["narrate:2", undefined, false],
    ["stitch:0", 0, true],
    ["stitch:1", 1, false],
    ["deepen", 0, true],
    ["deepen", 1, false],
    ["deepen", 3, false],
    ["deepen", undefined, false],
    ["evidence", undefined, false],
    ["evidence", 0, false],
    ["clip-scores", undefined, false],
    ["finalize", undefined, false],
    ["judge", undefined, false],
    ["research", undefined, false],
    ["", undefined, false],
    [undefined, undefined, false],
    [undefined, 0, false]
  ];
  it.each(rows)("criticalFor(%s, %s) is %s", (stage, act, expected) => {
    expect(criticalFor(stage, act)).toBe(expected);
  });

  it("an explicit priority on the context wins over the table", () => {
    /* MUTATION THAT KILLS THIS: ignore ctx.priority in priorityOf -- the
       first two expectations flip. Ran it -- red. */
    expect(priorityOf({ stage: "evidence", priority: "critical" })).toBe("critical");
    expect(priorityOf({ stage: "spine", priority: "background" })).toBe("background");
    expect(priorityOf({ stage: "spine" })).toBe("critical");
    expect(priorityOf({})).toBe("background");
  });
});

describe("LaneScheduledProvider: slots, reservation and priority (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("with spark at 2 slots and 1 reserved, five background calls never exceed one in flight and a critical call starts at once", async () => {
    /* MUTATION THAT KILLS THIS: size the background cap as maxConcurrent
       (ignore reservedCritical) -- two background calls run at once.
       Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner);
    const log = new RunLog();
    const bg = runWithRunLog(log, () => Array.from({ length: 5 }, (_, i) => background(() => p.complete(request(`bg${i}`)))));
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["bg0"]);
    expect(p.load("spark")).toEqual({ inFlight: 1, backgroundInFlight: 1, queued: 4 });

    const crit = runWithRunLog(log, () => critical(() => p.complete(request("crit"))));
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["bg0", "crit"]);
    expect(inner.calls[1]!.req.laneQueueMs).toBe(0);

    inner.calls[1]!.resolve();
    await expect(crit).resolves.toMatchObject({ text: "crit" });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      inner.calls.find((c) => c.req.label === `bg${i}`)!.resolve();
      await flush();
      expect(inner.inFlight()).toBeLessThanOrEqual(1);
    }
    await Promise.all(bg);
    expect(inner.maxInFlight()).toBe(2);
    expect(inner.calls.filter((c) => c.req.label.startsWith("bg")).map((c) => c.req.label)).toEqual(["bg0", "bg1", "bg2", "bg3", "bg4"]);
    expect(p.load("spark")).toEqual({ inFlight: 0, backgroundInFlight: 0, queued: 0 });
  });

  it("a queued critical call is served before earlier background calls, and its queueMs is the simulated wait", async () => {
    /* MUTATION THAT KILLS THIS: dispatch one FIFO queue regardless of class
       -- bg1 runs before crit2. Ran it -- red. And measuring queueMs from
       the grant instead of the enqueue reports 0. Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner);
    const crit1 = critical(() => p.complete(request("crit1")));
    const bg0 = background(() => p.complete(request("bg0")));
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["crit1", "bg0"]);
    const bg1 = background(() => p.complete(request("bg1")));
    vi.advanceTimersByTime(50);
    const crit2 = critical(() => p.complete(request("crit2")));
    await flush();
    expect(p.load("spark").queued).toBe(2);

    vi.advanceTimersByTime(250);
    inner.calls[1]!.resolve(); // bg0 frees its slot
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["crit1", "bg0", "crit2"]);
    expect(inner.calls[2]!.req.laneQueueMs).toBe(250);

    inner.calls[0]!.resolve(); // crit1 frees a slot: bg1 may now run beside crit2
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["crit1", "bg0", "crit2", "bg1"]);
    expect(inner.calls[3]!.req.laneQueueMs).toBe(300);
    inner.calls[2]!.resolve();
    inner.calls[3]!.resolve();
    await Promise.all([crit1, bg0, bg1, crit2]);
  });

  it("queueMs reaches the CallRecord through the real client (and is 0 for a call that did not wait)", async () => {
    /* MUTATION THAT KILLS THIS: leave openAICompatProvider.record's queueMs
       at null -- both records read null. Ran it -- red. */
    const gates: Array<() => void> = [];
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], model: "m" });
    const fetchImpl: FetchLike = () =>
      new Promise<FetchResponseLike>((resolve) =>
        gates.push(() => resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(body) }))
      );
    const client = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "k", fetchImpl });
    const p = scheduler(client);
    const log = new RunLog();
    const a = runWithRunLog(log, () => background(() => p.complete(request("a"))));
    const b = runWithRunLog(log, () => background(() => p.complete(request("b"))));
    await flush();
    expect(gates).toHaveLength(1);
    vi.advanceTimersByTime(400);
    gates[0]!();
    await a;
    await flush();
    gates[1]!();
    await b;
    const calls = log.calls();
    expect(calls.map((c) => [c.label, c.queueMs, c.stage])).toEqual([
      ["a", 0, "evidence"],
      ["b", 400, "evidence"]
    ]);
  });

  it("an aborted queued call rejects with kind 'aborted' and leaks no slot", async () => {
    /* MUTATION THAT KILLS THIS: leave the waiter in the queue on abort --
       the dispatch later grants the aborted call a slot that is never
       released, and the load check fails. Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner);
    const running = background(() => p.complete(request("running")));
    await flush();
    const controller = new AbortController();
    const queued = background(() => p.complete(request("queued", "local-heavy", { signal: controller.signal })));
    const after = background(() => p.complete(request("after")));
    await flush();
    expect(p.load("spark").queued).toBe(2);
    controller.abort();
    const err = await queued.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect((err as ChatProviderError).kind).toBe("aborted");
    expect(p.load("spark")).toEqual({ inFlight: 1, backgroundInFlight: 1, queued: 1 });

    inner.calls[0]!.resolve();
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["running", "after"]);
    inner.calls[1]!.resolve();
    await Promise.all([running, after]);
    expect(p.load("spark")).toEqual({ inFlight: 0, backgroundInFlight: 0, queued: 0 });

    const pre = new AbortController();
    pre.abort();
    await expect(background(() => p.complete(request("pre", "local-heavy", { signal: pre.signal })))).rejects.toMatchObject({ kind: "aborted" });
    expect(inner.calls).toHaveLength(2);
  });

  it("a failed call releases its slot", async () => {
    /* MUTATION THAT KILLS THIS: release only on success (no finally) --
       the second call never starts. Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner);
    const first = background(() => p.complete(request("first")));
    const second = background(() => p.complete(request("second")));
    await flush();
    inner.calls[0]!.reject(new ChatProviderError("http", "http_503", { status: 503 }));
    await expect(first).rejects.toMatchObject({ kind: "http" });
    await flush();
    expect(inner.calls.map((c) => c.req.label)).toEqual(["first", "second"]);
    inner.calls[1]!.resolve();
    await second;
  });

  it("each lane has its own slots; a model no lane names passes straight through", async () => {
    /* MUTATION THAT KILLS THIS: one gate for every lane -- the second-box
       call waits behind the Spark's background call. Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner);
    background(() => p.complete(request("spark-bg")));
    background(() => p.complete(request("second-bg", "local-worker")));
    background(() => p.complete(request("second-bg2", "local-worker")));
    background(() => p.complete(request("other", "some-other-model")));
    await flush();
    /* second: maxConcurrent 2, reservedCritical 0, so two background calls run. */
    expect(inner.calls.map((c) => c.req.label).sort()).toEqual(["other", "second-bg", "second-bg2", "spark-bg"]);
    expect(inner.calls.find((c) => c.req.label === "other")!.req.laneQueueMs).toBeUndefined();
    for (const c of inner.calls) c.resolve();
  });

  it("a lane whose reservedCritical equals maxConcurrent still runs one background call", async () => {
    /* MUTATION THAT KILLS THIS: drop the Math.max(1, ...) on the background
       cap -- the call never starts (a deadlock). Ran it -- red. */
    const inner = manualProvider();
    const p = scheduler(inner, mergeLaneProfiles({ spark: { maxConcurrent: 1, reservedCritical: 1 } }));
    const call = background(() => p.complete(request("bg")));
    await flush();
    expect(inner.calls).toHaveLength(1);
    inner.calls[0]!.resolve();
    await call;
  });
});

describe("server priority on the wire, and the Foray user tag", () => {
  function capturingFetch(): { fetchImpl: FetchLike; bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    const fetchImpl: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(body) });
    };
    return { fetchImpl, bodies };
  }

  it("with serverPriority disabled (the default profiles), no priority key is sent", async () => {
    /* MUTATION THAT KILLS THIS: send the profile's value whatever `enabled`
       says -- `priority: 0` appears. Ran it -- red. */
    const { fetchImpl, bodies } = capturingFetch();
    const p = scheduler(new OpenAICompatChatProvider({ baseUrl: "http://x.invalid", apiKey: "k", fetchImpl }));
    await critical(() => p.complete(request("c")));
    await background(() => p.complete(request("b")));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(Object.keys(b)).not.toContain("priority");
  });

  it("with serverPriority enabled, the profile's critical and background values are sent", async () => {
    /* MUTATION THAT KILLS THIS: swap the two values (critical gets
       background's) -- the expectations flip. Ran it -- red. */
    const { fetchImpl, bodies } = capturingFetch();
    const profiles = mergeLaneProfiles({ spark: { serverPriority: { enabled: true, critical: 10, background: -5 } } });
    const p = scheduler(new OpenAICompatChatProvider({ baseUrl: "http://x.invalid", apiKey: "k", fetchImpl }), profiles);
    await critical(() => p.complete(request("c")));
    await background(() => p.complete(request("b")));
    await background(() => p.complete(request("explicit", "local-heavy", { priority: 3 })));
    expect(bodies.map((b) => b.priority)).toEqual([10, -5, 3]);
  });

  it("the registry's provider is the scheduler over a client that tags every request user 'foray-generation'", async () => {
    /* MUTATION THAT KILLS THIS: build the client without `user` in
       getChatProvider -- the registry case finds no user tag. Ran it -- red.
       The registry opens no connection here: complete() is never called on
       its provider. */
    __setChatProviderForTests(undefined);
    try {
      const provider = getChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "k" });
      expect(provider).toBeInstanceOf(LaneScheduledProvider);
      const inner = (provider as LaneScheduledProvider).inner;
      expect(inner).toBeInstanceOf(OpenAICompatChatProvider);
      expect((inner as unknown as { user?: string }).user).toBe(FORAY_REQUEST_USER);
      expect(getChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "k" })).toBe(provider);
    } finally {
      __setChatProviderForTests(undefined);
    }
    const { fetchImpl, bodies } = capturingFetch();
    await new OpenAICompatChatProvider({ baseUrl: "http://x.invalid", apiKey: "k", fetchImpl, user: FORAY_REQUEST_USER }).complete(request("u"));
    await new OpenAICompatChatProvider({ baseUrl: "http://x.invalid", apiKey: "k", fetchImpl }).complete(request("plain"));
    expect(bodies[0]!.user).toBe("foray-generation");
    expect(Object.keys(bodies[1]!)).not.toContain("user");
  });
});

describe("unit caps (GV-90): lane calls are metered in seconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges spark and second-box seconds by lane, wall time inside the slot (queue excluded)", async () => {
    /* MUTATION THAT KILLS THIS: meter outside the slot (wrap acquire in
       metered) -- the queued call is charged its 2 s wait too. Ran it --
       red. And charging every lane to sparkSeconds leaves secondBoxSeconds 0.
       Ran it -- red. */
    const inner = manualProvider();
    const guard = new UnitBudgetGuard({ now: () => Date.now() });
    const p = scheduler(inner, SPARK_2_1, { unitGuard: guard, sessionOf: () => "s1" });
    const a = background(() => p.complete(request("a")));
    const b = background(() => p.complete(request("b")));
    const w = background(() => p.complete(request("w", "local-worker")));
    await flush();
    vi.advanceTimersByTime(2_000);
    inner.calls[0]!.resolve();
    inner.calls[1]!.resolve(); // the worker call
    await flush();
    vi.advanceTimersByTime(500);
    inner.calls[2]!.resolve();
    await Promise.all([a, b, w]);
    expect(inner.calls.map((c) => c.req.label)).toEqual(["a", "w", "b"]);
    const spent = guard.spent("s1");
    expect(spent.sparkSeconds).toBeCloseTo(2.5, 5);
    expect(spent.secondBoxSeconds).toBeCloseTo(2, 5);
    expect(spent.jevCalls).toBe(0);
  });

  it("past the per-Foray cap the call is refused with UnitBudgetExceededError and its slot is freed", async () => {
    /* MUTATION THAT KILLS THIS: skip metered() (call the inner directly) --
       the third call goes through. Ran it -- red. */
    const inner = manualProvider();
    const guard = new UnitBudgetGuard({ now: () => Date.now(), overrides: { sparkSeconds: 3 } });
    const p = scheduler(inner, SPARK_2_1, { unitGuard: guard, sessionOf: () => "s2" });
    for (const label of ["one", "two"]) {
      const call = background(() => p.complete(request(label)));
      await flush();
      vi.advanceTimersByTime(1_600);
      inner.calls.at(-1)!.resolve();
      await call;
    }
    const err = await background(() => p.complete(request("three"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitBudgetExceededError);
    expect((err as UnitBudgetExceededError).unit).toBe("sparkSeconds");
    expect(inner.calls).toHaveLength(2);
    expect(p.load("spark")).toEqual({ inFlight: 0, backgroundInFlight: 0, queued: 0 });
  });

  it("by default the session is the context's sessionId, else one per RunLog; outside a run nothing is metered", async () => {
    /* MUTATION THAT KILLS THIS: return undefined from the default session
       resolver -- no MeterEvent is logged. Ran it -- red. */
    /* Each call takes 700 ms of (fake) wall time. */
    const inner: ChatProvider = {
      name: "slow",
      complete: (req) => {
        vi.advanceTimersByTime(700);
        return Promise.resolve(reply(req, "ok"));
      }
    };
    const guard = new UnitBudgetGuard({ now: () => Date.now() });
    const reserve = vi.spyOn(guard, "reserve");
    const p = new LaneScheduledProvider(inner, { profiles: SPARK_2_1, unitGuard: guard });
    await p.complete(request("outside"));
    expect(reserve).not.toHaveBeenCalled();

    const log = new RunLog();
    await runWithRunLog(log, () => p.complete(request("inside")));
    expect(log.events("meter").map((e) => [e.unit, e.reserved])).toEqual([
      ["sparkSeconds", true],
      ["sparkSeconds", false]
    ]);
    const runLogSession = reserve.mock.calls[0]![0].sessionId;
    expect(runLogSession).toMatch(/^runlog:/);
    expect(guard.spent(runLogSession).sparkSeconds).toBeCloseTo(0.7, 5);

    await runWithRunLog(log, () => withCallContext({ sessionId: "ctx-session" } as CallContext, () => p.complete(request("ctx"))));
    expect(guard.spent("ctx-session").sparkSeconds).toBeCloseTo(0.7, 5);
    expect(guard.spent(runLogSession).sparkSeconds).toBeCloseTo(0.7, 5);
  });
});

describe("streams go through the same slots", () => {
  it("a stream holds its slot until done, and releases it before handing done on", async () => {
    /* MUTATION THAT KILLS THIS: release only in the generator's finally --
       a consumer that stops at `done` without return() keeps the slot and
       the next background call never starts. Ran it -- red. */
    const events: ChatStreamEvent[] = [
      { type: "delta", text: "hi" },
      { type: "done", finishReason: "stop", usage: null, model: null, requestId: null, timing: { startedAt: 0, firstByteAt: 0, endedAt: 0 } }
    ];
    const seen: ScheduledChatRequest[] = [];
    const inner = manualProvider() as ReturnType<typeof manualProvider> & { stream: (req: ChatRequest) => AsyncIterable<ChatStreamEvent> };
    inner.stream = async function* (req: ChatRequest) {
      seen.push(req as ScheduledChatRequest);
      for (const e of events) yield e;
    };
    const p = scheduler(inner);
    expect(typeof p.stream).toBe("function");
    const iter = p.stream!(request("s"))[Symbol.asyncIterator]();
    expect(await background(() => iter.next())).toMatchObject({ value: { type: "delta" } });
    expect(p.load("spark").backgroundInFlight).toBe(1);
    expect(await iter.next()).toMatchObject({ value: { type: "done" } });
    /* The consumer stops here without calling return(). */
    expect(p.load("spark")).toEqual({ inFlight: 0, backgroundInFlight: 0, queued: 0 });
    expect(seen[0]!.laneQueueMs).toBe(0);
    expect(scheduler(manualProvider()).stream).toBeUndefined();
  });

  it("a stream queued behind a background call, through the real client: queueMs is lane wait plus header wait, and the seconds charged are its wall time inside the slot", async () => {
    /* MUTATION THAT KILLS THIS: record a stream's queueMs as the header wait
       alone (openAICompatProvider.ts recordStream, `headerWait` instead of
       `headerWait + (laneWait ?? 0)`) -- queueMs reads 40, not 340. Ran it --
       red. And reconciling the stream's reservation from the enqueue instead
       of from inside the slot (`startMs = this.now() - queueMs` in streamScheduled) charges the
       300 ms wait too -- sparkSeconds reads 0.5. Ran it -- red. */
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    try {
      const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
      let releaseComplete: (() => void) | undefined;
      const completeBody = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], model: "m" });
      const fetchImpl: FetchLike = async (_url, init) => {
        const wire = JSON.parse(init.body) as { stream?: boolean };
        if (!wire.stream) {
          await new Promise<void>((r) => (releaseComplete = r));
          return { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(completeBody) };
        }
        await after(40); // the server's header wait
        async function* body(): AsyncGenerator<string> {
          await after(100);
          yield sse({ model: "m", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] });
          await after(60);
          yield sse({ model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
          yield "data: [DONE]\n\n";
        }
        return { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(""), body: body() };
      };
      const client = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "k", fetchImpl });
      const guard = new UnitBudgetGuard({ now: () => Date.now() });
      /* Two sessions, so the stream's charge is not mixed with the first call's. */
      const p = scheduler(client, SPARK_2_1, {
        unitGuard: guard,
        sessionOf: () => (currentCallContext().stage === "narrate:2" ? "s-stream" : "s-first")
      });
      const log = new RunLog();
      const first = runWithRunLog(log, () => background(() => p.complete(request("first"))));
      const streamed = runWithRunLog(log, () =>
        inContext({ stage: "narrate:2", act: 2 }, async () => {
          const out: ChatStreamEvent[] = [];
          for await (const e of p.stream!(request("streamed"))) out.push(e);
          return out;
        })
      );
      await flush();
      expect(p.load("spark")).toEqual({ inFlight: 1, backgroundInFlight: 1, queued: 1 });

      await vi.advanceTimersByTimeAsync(300);
      releaseComplete!();
      await first;
      await vi.advanceTimersByTimeAsync(200);
      const events = await streamed;
      expect(events.map((e) => e.type)).toEqual(["delta", "done"]);

      const record = log.calls().find((c) => c.label === "streamed")!;
      expect(record.stage).toBe("narrate:2");
      expect(record.queueMs).toBe(340);
      expect(guard.spent("s-stream").sparkSeconds).toBeCloseTo(0.2, 5);
      expect(guard.spent("s-first").sparkSeconds).toBeCloseTo(0.3, 5);
      expect(p.load("spark")).toEqual({ inFlight: 0, backgroundInFlight: 0, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* The pipeline puts {stage, act} on the context; criticalFor maps it.      */
/* ------------------------------------------------------------------------ */

function recordingFinalize() {
  return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
}

describe("criticalFor over the contexts a real pipeline run sets (runForayPipeline with stub deps)", () => {
  it("narrate act 0 and deepen act 0 are critical; narrate acts 1..3 and deepen acts 1+ are background", async () => {
    /* MUTATION THAT KILLS THIS: make narrate critical for every act (drop
       "narrate" from ACT_ZERO_STAGES into CRITICAL_STAGES) -- acts 1..3 read
       critical. Ran it -- red. */
    const medium: GenerationRequest = {
      prompt: "the history of grilling and barbecue",
      duration: "medium",
      author_id: "founder-1",
      visibility: "catalogue"
    };
    const deepenBuilder = new StubDeepenActBuilder();
    const narrationWriter = new StubNarrationWriterBuilder();
    const deepenSeen: CallContext[] = [];
    const writerSeen: CallContext[] = [];
    const log = new RunLog();
    const out = await runWithRunLog(log, () =>
      runForayPipeline(
        medium,
        { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" },
        {
          understander: new StubPromptUnderstander(),
          researcher: new StubExternalResearcher(),
          spineBuilder: new StubSpineBuilder(),
          narrationVerifier: new StubNarrationVerifierBuilder(),
          continuityBuilder: new StubContinuityBuilder(),
          finalize: recordingFinalize(),
          deepenBuilder: {
            providerName: deepenBuilder.providerName,
            deepenAct: async (...args: Parameters<typeof deepenBuilder.deepenAct>) => {
              deepenSeen.push(currentCallContext());
              return deepenBuilder.deepenAct(...args);
            }
          },
          narrationWriter: {
            providerName: narrationWriter.providerName,
            writeAct: async (...args: Parameters<typeof narrationWriter.writeAct>) => {
              writerSeen.push(currentCallContext());
              return narrationWriter.writeAct(...args);
            }
          }
        }
      )
    );
    expect(out.outcome).toBe("generated");

    const narrate = writerSeen.map((c) => [c.act, criticalFor(c.stage, c.act)]);
    const narrateActs = [...new Set(writerSeen.map((c) => c.act))].sort();
    expect(narrateActs).toEqual([0, 1, 2, 3]);
    for (const [act, isCritical] of narrate) expect(isCritical).toBe(act === 0);

    const deepenActs = [...new Set(deepenSeen.map((c) => c.act))].sort();
    expect(deepenActs.length).toBeGreaterThan(1);
    expect(deepenActs[0]).toBe(0);
    for (const c of deepenSeen) {
      expect(c.stage).toBe("deepen");
      expect(criticalFor(c.stage, c.act)).toBe(c.act === 0);
    }
  }, 60_000);
});
