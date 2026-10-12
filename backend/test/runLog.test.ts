import { afterEach, describe, it, expect } from "vitest";
import {
  RUNLOG_SCHEMA,
  RunLog,
  currentCallContext,
  currentRunLog,
  recordModelCall,
  runWithRunLog,
  withCallContext,
  type CallRecord,
  type StageSpan
} from "../src/generation/runLog";
import { FlagValueError } from "../src/generation/generationFlags";
import { outputBudgetMode } from "../src/config/outputBudgets";

/**
 * GV-01 (docs/roadmap/generation-v2.md): the per-run log every later
 * measurement card appends to. Four claims: concurrent runs never see each
 * other's log or context; context merges down the chain; the log's clock is
 * injectable; `toJsonl()` is the `runlog/1` shape the bench reader requires.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function stageSpan(name: string, startMs: number, endMs: number, status: StageSpan["status"] = "ok"): StageSpan {
  return { kind: "stage", name, startMs, endMs, ms: endMs - startMs, status };
}

function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    kind: "call",
    seq: 0,
    stage: "spine",
    act: null,
    seam: null,
    attempt: null,
    role: null,
    reask: null,
    provider: "fake",
    machine: null,
    model: "fake-model",
    label: "spine",
    startMs: 0,
    endMs: 10,
    ms: 10,
    queueMs: null,
    ttftMs: null,
    promptTokens: 100,
    cachedTokens: null,
    outputTokens: 20,
    decodeTokPerSec: null,
    maxTokens: null,
    outputBudget: null,
    overBudget: null,
    stopReason: null,
    jsonValid: null,
    ...overrides
  };
}

describe("RunLog: AsyncLocalStorage isolation", () => {
  it("two concurrent runs with interleaved awaits and Promise.all fan-outs never see each other's events", async () => {
    /* MUTATION THAT KILLS THIS: replace the AsyncLocalStorage store with one
       module-level `let current` that runWithRunLog sets — the second run
       overwrites the first, and run A's fan-out appends into log B. Ran it —
       red. */
    const a = new RunLog();
    const b = new RunLog();
    const work = async (tag: string) => {
      for (let i = 0; i < 3; i++) {
        await tick();
        currentRunLog()!.append(stageSpan(`${tag}:${i}`, i, i + 1));
      }
      await Promise.all(
        [0, 1, 2].map((j) =>
          withCallContext({ act: j }, async () => {
            await tick();
            const ctx = currentCallContext();
            currentRunLog()!.append(stageSpan(`${tag}-fan:${ctx.act}`, j, j + 1));
          })
        )
      );
    };
    await Promise.all([runWithRunLog(a, () => work("a")), runWithRunLog(b, () => work("b"))]);

    expect(a.stages().map((s) => s.name).sort()).toEqual(["a-fan:0", "a-fan:1", "a-fan:2", "a:0", "a:1", "a:2"]);
    expect(b.stages().map((s) => s.name).sort()).toEqual(["b-fan:0", "b-fan:1", "b-fan:2", "b:0", "b:1", "b:2"]);
  });

  it("is inert outside a run: no log, an empty context, and withCallContext just runs its function", async () => {
    /* MUTATION THAT KILLS THIS: have withCallContext throw (or return
       undefined) when no store is active — every caller that never opened a
       log (the HTTP routes, every older test) would break. */
    expect(currentRunLog()).toBeUndefined();
    expect(currentCallContext()).toEqual({});
    const value = await withCallContext({ stage: "spine" }, async () => {
      expect(currentCallContext()).toEqual({});
      return 7;
    });
    expect(value).toBe(7);
  });
});

describe("RunLog: call context", () => {
  it("merges each withCallContext over its parent, ignores undefined keys, and restores the parent afterwards", async () => {
    /* MUTATION THAT KILLS THIS: store `partial` instead of `{...parent,
       ...partial}` — the inner context loses `tier` and `stage`. Ran it — red. */
    const log = new RunLog();
    const seen: Array<Record<string, unknown>> = [];
    await runWithRunLog(log, () =>
      withCallContext({ tier: "short" }, () =>
        withCallContext({ stage: "narrate:1", act: 1 }, async () => {
          seen.push({ ...currentCallContext() });
          await withCallContext({ attempt: 2, role: "writer", reask: undefined }, async () => {
            await tick();
            seen.push({ ...currentCallContext() });
          });
          seen.push({ ...currentCallContext() });
        })
      )
    );
    expect(seen[0]).toEqual({ tier: "short", stage: "narrate:1", act: 1 });
    expect(seen[1]).toEqual({ tier: "short", stage: "narrate:1", act: 1, attempt: 2, role: "writer" });
    expect(seen[2]).toEqual({ tier: "short", stage: "narrate:1", act: 1 });
  });

  it("currentCallContext returns a copy, so a caller cannot edit the enclosing context", async () => {
    await runWithRunLog(new RunLog(), () =>
      withCallContext({ stage: "spine" }, () => {
        const ctx = currentCallContext();
        ctx.stage = "tampered";
        expect(currentCallContext().stage).toBe("spine");
      })
    );
  });
});

describe("RunLog: clock, queries and totals", () => {
  it("measures on the injected clock, from t0", () => {
    /* MUTATION THAT KILLS THIS: ignore `opts.now` and use Date.now() — the
       readings stop being 0 and 250. */
    const clock = fakeClock(Date.parse("2026-10-11T00:00:00.000Z"));
    const log = new RunLog({ now: clock.now });
    expect(log.t0Iso).toBe("2026-10-11T00:00:00.000Z");
    expect(log.nowMs()).toBe(0);
    clock.advance(250);
    expect(log.nowMs()).toBe(250);
  });

  it("filters events by kind, sums calls with null tokens as nothing, and spans only the stages that ran", () => {
    /* MUTATION THAT KILLS THIS: count resumed spans in spanMs — the resumed
       span at 0 pulls the start back and the span reads 900, not 600. */
    const log = new RunLog({ now: fakeClock().now });
    log.append(stageSpan("understand", 0, 0, "resumed"));
    log.append(stageSpan("topic", 300, 400));
    log.append(callRecord({ ms: 10, promptTokens: 100, cachedTokens: 40, outputTokens: 20 }));
    log.append({ kind: "parse", ok: true, reask: false });
    log.append(stageSpan("narrate:0", 400, 900, "failed"));
    log.append(stageSpan("narrate:1", 450, 700));
    log.append(callRecord({ seq: 1, ms: 30, promptTokens: null, cachedTokens: null, outputTokens: 5 }));

    expect(log.events()).toHaveLength(7);
    expect(log.events("parse")).toEqual([{ kind: "parse", ok: true, reask: false }]);
    expect(log.stages().map((s) => s.name)).toEqual(["understand", "topic", "narrate:0", "narrate:1"]);
    expect(log.calls().map((c) => c.seq)).toEqual([0, 1]);
    expect(log.callTotals()).toEqual({ calls: 2, ms: 40, promptTokens: 100, cachedTokens: 40, outputTokens: 25 });
    expect(log.spanMs()).toBe(600);
    expect(new RunLog().spanMs()).toBeNull();
  });
});

describe("RunLog: toJsonl", () => {
  it("writes the runlog/1 header, then one event per line, newline-terminated", () => {
    /* MUTATION THAT KILLS THIS: drop the header line — the bench reader
       (`readRunLog`) refuses a file without it, and the first line here is an
       event. */
    const clock = fakeClock(Date.parse("2026-10-11T12:00:00.000Z"));
    const log = new RunLog({ now: clock.now });
    log.append(stageSpan("understand", 0, 12));
    log.append({ kind: "ready", granularity: "act", actIndex: 0, itemIds: ["i-1"], readyMs: 50, partialOk: null });
    log.append({ kind: "meter", unit: "spark-seconds", amount: 3, reserved: false, stage: "spine" });

    const text = log.toJsonl();
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(RUNLOG_SCHEMA).toBe("runlog/1");
    expect(lines[0]).toEqual({ schema: "runlog/1", t0Iso: "2026-10-11T12:00:00.000Z" });
    expect(lines.slice(1).map((e) => e.kind)).toEqual(["stage", "ready", "meter"]);
    expect(lines[1]).toEqual({ kind: "stage", name: "understand", startMs: 0, endMs: 12, ms: 12, status: "ok" });
  });
});

describe("RunLog: output budgets (GV-14)", () => {
  const savedFlag = process.env.FORAY_OUTPUT_BUDGETS;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FORAY_OUTPUT_BUDGETS;
    else process.env.FORAY_OUTPUT_BUDGETS = savedFlag;
  });

  const call = (outputTokens: number | null, extra: Partial<Parameters<typeof recordModelCall>[0]> = {}) =>
    recordModelCall({ provider: "openai-compat", model: "m", label: "chat-call", startMs: 0, endMs: 5, outputTokens, ...extra });

  it("stamps a short-tier spine call with 900 output tokens as outputBudget 450, overBudget true, by default", () => {
    /* MUTATION THAT KILLS THIS: drop the budgetStamp spread in
       recordModelCall (back to the provider's own nulls), or stamp from the
       wrong tier (ctx.tier ignored -> null). Ran both — red. */
    delete process.env.FORAY_OUTPUT_BUDGETS;
    const log = new RunLog({ now: fakeClock().now });
    runWithRunLog(log, () =>
      withCallContext({ tier: "short" }, () =>
        withCallContext({ stage: "spine" }, () => {
          call(900);
          call(300);
          call(null);
        })
      )
    );
    expect(log.calls().map((c) => [c.outputBudget, c.overBudget])).toEqual([
      [450, true],
      [450, false],
      [450, null]
    ]);
  });

  it("keeps a provider's own budget and stamps nothing without a tier or under off", () => {
    /* MUTATION THAT KILLS THIS: ignore the `off` mode (off still stamps 450),
       or let the table override a provider's explicit outputBudget. Ran
       both — red. */
    const log = new RunLog({ now: fakeClock().now });
    runWithRunLog(log, () => {
      withCallContext({ stage: "spine" }, () => call(900));
      withCallContext({ stage: "spine", tier: "short" }, () => {
        call(900, { outputBudget: 1000 });
        process.env.FORAY_OUTPUT_BUDGETS = "off";
        call(900);
      });
    });
    expect(log.calls().map((c) => [c.outputBudget, c.overBudget])).toEqual([
      [null, null],
      [1000, false],
      [null, null]
    ]);
    /* Outside a run the flag is never read: recording is a no-op. */
    expect(call(900)).toBeUndefined();
  });

  it("never throws on a bad flag while recording: the call is still appended with the provider-given budget fields", () => {
    /* recordModelCall runs AFTER the paid reply (and on the failure path,
       where a throw would replace the transport error), so a malformed
       FORAY_OUTPUT_BUDGETS must not cost the reply. Bad config fails at run
       start instead (runPipeline.test.ts).
       MUTATION THAT KILLS THIS: drop the try/catch in budgetStamp (call
       outputBudgetMode() unguarded) — recordModelCall throws FlagValueError.
       Ran it — red. */
    process.env.FORAY_OUTPUT_BUDGETS = "bogus";
    expect(() => outputBudgetMode()).toThrow(FlagValueError);
    const log = new RunLog({ now: fakeClock().now });
    const recorded: Array<CallRecord | undefined> = [];
    runWithRunLog(log, () =>
      withCallContext({ stage: "spine", tier: "short" }, () => {
        recorded.push(call(900));
        recorded.push(call(900, { outputBudget: 1000, overBudget: false }));
        recorded.push(call(null, { error: { kind: "transport", status: 503 } }));
      })
    );
    expect(recorded.every((r) => r !== undefined)).toBe(true);
    expect(log.calls().map((c) => [c.outputBudget, c.overBudget])).toEqual([
      [null, null],
      [1000, false],
      [null, null]
    ]);
    expect(log.calls()[2]?.error).toEqual({ kind: "transport", status: 503 });
  });
});
