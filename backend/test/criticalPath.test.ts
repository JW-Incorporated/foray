import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { callsStartedBefore, serialCallChain, type TimedCall } from "../src/generation/criticalPath";
import { instrumentDeps, INSTRUMENTED_METHODS } from "../src/generation/callLog";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { ActWriteRequest, NarrationBuildContext, NarrationWriterBuilder, WriterStreamEvent } from "../src/generation/NarrationWriterBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { PartialCandidate } from "../src/generation/partialCandidate";
import { RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
import type { GenerationRequest } from "../src/types/generation";
import { recordingDeps } from "./helpers/recordingDeps";

/**
 * GV-123 (docs/roadmap/generation-v2.md, from W4-01 items 4 and 5; R1-01,
 * GP-03, MT-06): the critical-path probe.
 *
 *   - serialCallChain on synthetic intervals (serial, parallel, diamond,
 *     overlap by 1 ms), and its agreement with the bench reader's seriesDepth
 *     (GV-17) on tools/generation-bench/fixtures/runlog-synth.
 *   - instrumentDeps records one builder-level span per builder-method call,
 *     writeActStream included, and changes no result.
 *   - The baseline: the short tier with stub builders through recordingDeps
 *     (a fake clock with a scripted latency per stage), the serial chain
 *     before onActReady(act 0) pinned. R1-01's cut is measured against it; a
 *     card that changes the default chain updates the pin deliberately.
 *
 * Offline: stubs only, no model, no network.
 */

const call = (id: string, startMs: number, endMs: number, stage = "s"): TimedCall => ({ id, stage, startMs, endMs });

describe("serialCallChain (GV-123, MT-06)", () => {
  it("counts a fully serial run as one link per call, in order, whatever the input order", () => {
    /* MUTATION THAT KILLS THIS: drop the `.sort(...)` in serialCallChain.
       Ran: red here (the shuffled input is no longer read in time order). */
    const calls = [call("c", 200, 300), call("a", 0, 100), call("b", 100, 200)];
    expect(serialCallChain(calls)).toEqual({ length: 3, chain: ["a", "b", "c"] });
    expect(serialCallChain([])).toEqual({ length: 0, chain: [] });
  });

  it("counts fully parallel calls as one link", () => {
    /* MUTATION THAT KILLS THIS: drop the `before.endMs <= call.startMs` test
       (every earlier call a predecessor). Ran: red here, the parallel calls
       chain up. */
    const calls = [call("a", 0, 500), call("b", 0, 500), call("c", 10, 400)];
    expect(serialCallChain(calls).length).toBe(1);
  });

  it("follows the longer arm of a diamond", () => {
    /* a fans out to b -> b2 and to c; both arms join at d. The b arm is one
       call longer, so the chain runs through it; c overlaps b2 and adds
       nothing.
       MUTATION THAT KILLS THIS: keep the FIRST predecessor found rather than
       the deepest (`&& d === 1` added to the predecessor test). Ran: red
       here, b2 and d settle for a as predecessor. */
    const calls = [call("a", 0, 100), call("b", 100, 200), call("c", 100, 250), call("b2", 200, 300), call("d", 300, 400)];
    expect(serialCallChain(calls)).toEqual({ length: 4, chain: ["a", "b", "b2", "d"] });
  });

  it("an overlap of 1 ms is parallel; touching end to start is serial", () => {
    /* MUTATION THAT KILLS THIS: `before.endMs < call.startMs` (strict).
       Ran: red here, the touching pair reads as parallel. */
    expect(serialCallChain([call("a", 0, 100), call("b", 99, 200)]).length).toBe(1);
    expect(serialCallChain([call("a", 0, 100), call("b", 100, 200)]).length).toBe(2);
  });

  it("skips a call nobody timed, and callsStartedBefore keeps only calls started strictly before t", () => {
    /* MUTATION THAT KILLS THIS: `call.startMs <= tMs` in callsStartedBefore.
       Ran: red here, the call starting AT t is kept. */
    const calls = [call("a", 0, 100), call("b", 100, 200), call("c", 200, 300), call("x", Number.NaN, 50)];
    expect(serialCallChain(calls).length).toBe(3);
    expect(callsStartedBefore(calls, 200).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("agrees with tools/generation-bench/runlog.mjs seriesDepth on fixtures/runlog-synth (GV-17)", async () => {
    /* MUTATION THAT KILLS THIS: `before.endMs < call.startMs` (strict) in
       serialCallChain. Ran: the fixture's calls touch end to start
       (understand 0-1000, spine 1000-4000), so the chain drops below the
       reader's 5. */
    const reader = (await import("../../tools/generation-bench/runlog.mjs")) as {
      readRunLog: (file: string) => { events: Array<Record<string, unknown>> };
      seriesDepth: (calls: unknown[]) => number;
      summarizeRunLog: (events: unknown[]) => { seriesDepth: number };
    };
    const file = path.resolve(__dirname, "../../tools/generation-bench/fixtures/runlog-synth/runlogs/synth.1.runlog.jsonl");
    const { events } = reader.readRunLog(file);
    const records = events.filter((e) => e.kind === "call");
    const calls = records.map((e) => call(String(e.seq), e.startMs as number, e.endMs as number, String(e.stage)));
    const ours = serialCallChain(calls);
    expect(ours.length).toBe(reader.seriesDepth(records));
    expect(ours.length).toBe(reader.summarizeRunLog(events).seriesDepth);
    expect(ours.length).toBe(5);
    expect(ours.chain).toEqual(["0", "1", "2", "3", "7"]);
  });
});

/* ------------------------------------------------------------------ */
/* instrumentDeps                                                      */
/* ------------------------------------------------------------------ */

function tickClock(): () => number {
  let t = 0;
  return () => (t += 10);
}

const ctx: NarrationBuildContext = { userId: "u" } as NarrationBuildContext;

describe("instrumentDeps (GV-123, callLog.ts)", () => {
  it("records one span per builder-method call across every instrumented method, results unchanged", async () => {
    /* MUTATION THAT KILLS THIS: delete the `deepenBuilder` row (or any row)
       from INSTRUMENTED_METHODS. Ran: the deepen call records no span, so
       the stage list is short by one. */
    const calls: string[] = [];
    const fake = <T>(name: string, value: T) => async () => {
      calls.push(name);
      return value;
    };
    const deps = {
      understander: { providerName: "u", assessClarity: fake("assessClarity", { clear: true }), extractIntent: fake("extractIntent", { i: 1 }) },
      researcher: { providerName: "r", research: fake("research", { notes: "n" }), retrievePassages: fake("retrievePassages", []) },
      spineBuilder: { providerName: "s", buildSpine: fake("buildSpine", { spine: true }) },
      deepenBuilder: { providerName: "d", deepenAct: fake("deepenAct", { deep: true }) },
      narrationWriter: { providerName: "w", writeAct: fake("writeAct", { seams: [] }) },
      narrationVerifier: { providerName: "v", verifyAct: fake("verifyAct", { ok: true }) },
      continuityBuilder: { providerName: "c", smoothSeam: fake("smoothSeam", { nextIntroduction: "x" }) }
    } as never;
    const { deps: wrapped, spans } = instrumentDeps(deps, tickClock());
    type Fn = (...a: unknown[]) => Promise<unknown>;
    type Fake = { providerName: string } & Record<
      "assessClarity" | "extractIntent" | "research" | "retrievePassages" | "buildSpine" | "deepenAct" | "writeAct" | "verifyAct" | "smoothSeam",
      Fn
    >;
    const w = wrapped as unknown as Record<
      "understander" | "researcher" | "spineBuilder" | "deepenBuilder" | "narrationWriter" | "narrationVerifier" | "continuityBuilder",
      Fake
    >;
    expect(await w.understander.assessClarity("p", {})).toEqual({ clear: true });
    await w.understander.extractIntent("p", {});
    await w.researcher.research("t", {});
    await w.researcher.retrievePassages({}, {});
    await w.spineBuilder.buildSpine({}, {}, "short", {});
    await w.deepenBuilder.deepenAct({}, {}, 2, {});
    await w.narrationWriter.writeAct({ frame: { actIndex: 1 } }, ctx);
    await w.narrationVerifier.verifyAct({}, ctx);
    await withCallContext({ act: 0 }, () => w.narrationVerifier.verifyAct({}, ctx));
    await w.continuityBuilder.smoothSeam({}, {});
    expect(w.spineBuilder.providerName).toBe("s");
    expect(calls).toHaveLength(10);
    expect(spans.map((s) => [s.stage, s.method, s.act])).toEqual([
      ["understand", "assessClarity", null],
      ["understand", "extractIntent", null],
      ["research", "research", null],
      ["evidence", "retrievePassages", null],
      ["spine", "buildSpine", null],
      ["deepen", "deepenAct", 2],
      ["narration", "writeAct", 1],
      ["verify", "verifyAct", null],
      ["verify", "verifyAct", null],
      ["continuity", "smoothSeam", null]
    ]);
    /* withCallContext is a no-op outside a RunLog, so the second verify has
       no act either; inside one, the run context names it (next test). */
    expect(spans.every((s) => s.ok && s.endMs > s.startMs)).toBe(true);
    expect(new Set(spans.map((s) => s.id)).size).toBe(spans.length);
  });

  it("takes the act from the run context first, and numbers repeat calls per method and act", async () => {
    /* MUTATION THAT KILLS THIS: in begin(), ignore currentCallContext() and
       use only the arguments. Ran: red here, the verify spans carry no act. */
    const verifier = { providerName: "v", verifyAct: async () => ({ ok: true }) };
    const { deps, spans } = instrumentDeps({ narrationVerifier: verifier } as never, tickClock());
    const v = (deps as { narrationVerifier: typeof verifier }).narrationVerifier;
    await runWithRunLog(new RunLog(), async () => {
      await withCallContext({ act: 1 }, () => v.verifyAct());
      await withCallContext({ act: 1 }, () => v.verifyAct());
      await withCallContext({ act: 0 }, () => v.verifyAct());
    });
    expect(spans.map((s) => s.id)).toEqual(["verifyAct@a1#1", "verifyAct@a1#2", "verifyAct@a0#1"]);
  });

  it("records writeActStream as ONE span from call to the stream's end, and leaves a writer without it without it", async () => {
    /* MUTATION THAT KILLS THIS: drop the writeActStream row from
       INSTRUMENTED_METHODS' narrationWriter. Ran: the stream records no
       span (spans is empty). And `stream: true` removed (wrapped as an
       async method): the wrapper returns a Promise, not an iterable, and
       `for await` throws. */
    const writer = new StubNarrationWriterBuilder();
    const { deps, spans } = instrumentDeps({ narrationWriter: writer }, tickClock());
    const request = { frame: { actIndex: 0 }, seams: [], clips: [], documents: [], voice: { register: "warm" } } as unknown as ActWriteRequest;
    const events: WriterStreamEvent[] = [];
    for await (const ev of deps.narrationWriter!.writeActStream!(request, ctx)) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["end"]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ stage: "narration", method: "writeActStream", act: 0, ok: true });
    expect(deps.narrationWriter!.providerName).toBe("stub");

    const plain = { providerName: "p", writeAct: async () => ({ seams: [] }) };
    const { deps: d2 } = instrumentDeps({ narrationWriter: plain as NarrationWriterBuilder }, tickClock());
    expect(typeof d2.narrationWriter!.writeActStream).toBe("undefined");
  });

  it("a builder that throws rethrows unchanged and still records its span, ok false", async () => {
    /* MUTATION THAT KILLS THIS: push the span only after a successful await
       (move finish() out of `finally`). Ran: spans is empty. */
    const boom = new Error("spine failed");
    const spine = { providerName: "s", buildSpine: async () => Promise.reject(boom) };
    const { deps, spans } = instrumentDeps({ spineBuilder: spine } as never, tickClock());
    await expect((deps as { spineBuilder: typeof spine }).spineBuilder.buildSpine()).rejects.toBe(boom);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ method: "buildSpine", ok: false });
  });

  it("writes nothing to disk: callLog.ts and criticalPath.ts import no file system module", () => {
    /* MUTATION THAT KILLS THIS: add `import fs from "node:fs";` to callLog.ts
       (the first step of persisting spans). Ran: the regex matches. */
    for (const rel of ["../src/generation/callLog.ts", "../src/generation/criticalPath.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(src).not.toMatch(/from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs/);
    }
    expect(Object.keys(INSTRUMENTED_METHODS).sort()).toEqual(
      ["continuityBuilder", "deepenBuilder", "narrationVerifier", "narrationWriter", "researcher", "spineBuilder", "understander"]
    );
  });
});

/* ------------------------------------------------------------------ */
/* The pinned stub baseline                                            */
/* ------------------------------------------------------------------ */

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "short",
  author_id: "founder-1",
  visibility: "catalogue"
};

const options = {
  userId: "founder-1",
  now: () => new Date("2026-09-05T12:00:00.000Z"),
  topic: "food/grilling-bbq"
};

/** The fake §4.9 (runLogBenchParity.test.ts's passFinalize). */
async function passFinalize(input: FinalizeForayInput): Promise<FinalizeForayResult> {
  return {
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { id: input.id, generated: true } as never,
    timings: []
  } as unknown as FinalizeForayResult;
}

/** Scripted latency per span stage, ms: round numbers in the order of a
 * local Qwen run's stage costs, so the virtual timeline reads like one. The
 * chain's LENGTH does not depend on them as long as parallel calls take the
 * same time; the timestamps do. */
const LATENCIES = { understand: 1000, research: 2000, evidence: 500, spine: 5000, deepen: 3000, narration: 6000, verify: 2000, continuity: 1000 };

afterEach(() => {
  vi.unstubAllEnvs();
});

async function baselineRun() {
  /* The pin is the DEFAULT path: an operator's prefetch override would move
     the evidence waves, so it is cleared for the run. */
  vi.stubEnv("EVIDENCE_PREFETCH_CONCURRENCY", "");
  const rec = recordingDeps(
    {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder()
    },
    LATENCIES
  );
  let firstReadyMs: number | null = null;
  let firstReady: PartialCandidate | null = null;
  /* Under a RunLog, as a production run is (GV-01): the run context then
     names each span's act where the pipeline set one. */
  const out = await runWithRunLog(new RunLog(), () =>
    runForayPipeline(request, options, {
      ...rec.deps,
      finalize: passFinalize,
      onActReady: (candidate) => {
        if (firstReadyMs === null) {
          firstReadyMs = rec.clock.now();
          firstReady = candidate;
        }
      }
    })
  );
  return { out, spans: rec.spans, firstReadyMs: firstReadyMs as number | null, firstReady: firstReady as PartialCandidate | null };
}

describe("the stub baseline chain before act 0 is ready (GV-123, TM-05)", () => {
  it("pins the classic default path's serial chain on the short tier: at least 6 calls", async () => {
    /* MUTATIONS THAT KILL THIS (each ran red here): in recordingDeps.ts,
       advance the clock by the latency instead of sleeping it (a counter
       clock, so the 16 parallel prefetch calls read as serial);
       SETTLE_TURNS = 0 (the clock moves before concurrent work has
       registered its sleep); and dropping the deepenBuilder row from
       INSTRUMENTED_METHODS (the pinned chain loses its deepen link). */
    const { out, spans, firstReadyMs, firstReady } = await baselineRun();
    expect(out.outcome).toBe("generated");
    expect(firstReadyMs).not.toBeNull();
    expect(firstReady!.acts[0]?.status).toBe("ready");
    const before = callsStartedBefore(spans, firstReadyMs!);
    const chain = serialCallChain(before);
    expect(chain.length).toBeGreaterThanOrEqual(6);
    expect({ length: chain.length, chain: chain.chain, firstReadyMs }).toEqual(BASELINE);
  });

  it("is deterministic: a second run gives the same spans", async () => {
    /* MUTATION THAT KILLS THIS: start the virtual clock at Date.now()
       (`new VirtualClock(Date.now())` in recordingDeps). Ran: red here, the
       two runs' timestamps differ. */
    const a = await baselineRun();
    const b = await baselineRun();
    const shape = (r: Awaited<ReturnType<typeof baselineRun>>) => r.spans.map((s) => [s.id, s.startMs, s.endMs]);
    expect(shape(b)).toEqual(shape(a));
  });
});

/**
 * THE PIN (2026-10-13, origin/main aefbb350): the classic default path, short
 * tier (one act), stub builders. Eight calls in series before act 0 is ready:
 *
 *   assessClarity, extractIntent      understand (safety, then intent)
 *   buildSpine                        spine
 *   deepenAct@a0                      deepen (one act, so no parallelism)
 *   retrievePassages x2               the evidence prefetch: 16 pages at the
 *                                     default concurrency of 10, two waves
 *   writeAct@a0, verifyAct@a0         the act, one round
 *
 * firstReadyMs is the sum of the scripted latencies along the chain
 * (1000 + 1000 + 5000 + 3000 + 500 + 500 + 6000 + 2000). R1-01 drives the
 * length toward 3; a card that changes the default chain updates this pin in
 * the same PR and says why.
 */
const BASELINE = {
  length: 8,
  chain: [
    "assessClarity#1",
    "extractIntent#1",
    "buildSpine#1",
    "deepenAct@a0#1",
    "retrievePassages#1",
    "retrievePassages#11",
    "writeAct@a0#1",
    "verifyAct@a0#1"
  ],
  firstReadyMs: 19000
};
