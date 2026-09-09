import { describe, it, expect } from "vitest";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { BudgetExceededError, EpisodeBudgetExceededError, BudgetStopError } from "../src/cost/budgetGuard";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { SpineBuilder } from "../src/generation/SpineBuilder";
import type { PromptUnderstander } from "../src/generation/PromptUnderstander";
import type { DeepenActBuilder } from "../src/generation/DeepenActBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import type { NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";

/**
 * F-17/F-18, driven through the real pipeline.
 *
 * "One beat's narration failure kills the whole Foray... seven calls of spine
 * and deepening were discarded. No fallback, no partial candidate." (F-17)
 * "The batch driver is not resumable within a Foray. Its resume key is the
 * prompt's candidate file, which a failed run never writes, so a re-run repeats
 * every stage from the clarity check." (F-18)
 *
 * Every builder here is a Stub, so the whole suite costs nothing and needs no
 * key — the same property that lets the existing `runPipeline.test.ts` run on
 * every PR.
 */

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "short",
  author_id: "founder-1",
  visibility: "catalogue"
};

const KEY = "the-history-of-grilling-and-barbecue-deadbeef";
const FP = checkpointFingerprint({ prompt: request.prompt, duration: request.duration });

function fakeFinalize() {
  const seen: FinalizeForayInput[] = [];
  const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
    seen.push(input);
    return {
      validation: {
        ok: true,
        checkForaysErrors: [],
        checkForaysWarnings: [],
        checkNarrationErrors: [],
        checkNarrationWarnings: []
      },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    } as unknown as FinalizeForayResult;
  };
  return { fn, seen };
}

/** Counts how many times each builder was actually asked to produce something,
 * which is the only measure that matters here: a resumed stage is one that
 * cost nothing. */
function countingDeps() {
  const calls = { understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 };

  const understander = new StubPromptUnderstander();
  const realIntent = understander.extractIntent.bind(understander);
  understander.extractIntent = async (...args: Parameters<PromptUnderstander["extractIntent"]>) => {
    calls.understand++;
    return realIntent(...args);
  };

  const spineBuilder = new StubSpineBuilder();
  const realSpine = spineBuilder.buildSpine.bind(spineBuilder);
  spineBuilder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
    calls.spine++;
    return realSpine(...args);
  };

  const deepenBuilder = new StubDeepenActBuilder();
  const realDeepen = deepenBuilder.deepenAct.bind(deepenBuilder);
  deepenBuilder.deepenAct = async (...args: Parameters<DeepenActBuilder["deepenAct"]>) => {
    calls.deepen++;
    return realDeepen(...args);
  };

  const narrationWriter = new StubNarrationWriterBuilder();
  /* WS-A: the prose call is the one that writes a page, and it takes a whole
     slot at a time — so this counts slot-writes, not page-writes. The
     assertions below only ask whether narration was PAID FOR again after a
     resume, which that answers exactly. */
  const realWrite = narrationWriter.writePages.bind(narrationWriter);
  narrationWriter.writePages = async (...args: Parameters<NarrationWriterBuilder["writePages"]>) => {
    calls.write++;
    return realWrite(...args);
  };

  const continuityBuilder = new StubContinuityBuilder();
  const realSmooth = continuityBuilder.smoothSeam.bind(continuityBuilder);
  continuityBuilder.smoothSeam = async (...args: Parameters<ContinuityBuilder["smoothSeam"]>) => {
    calls.smooth++;
    return realSmooth(...args);
  };

  return {
    calls,
    deps: {
      understander,
      researcher: new StubExternalResearcher(),
      spineBuilder,
      deepenBuilder,
      narrationWriter,
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder
    }
  };
}

describe("per-stage checkpoint and resume inside one Foray (F-17/F-18)", () => {
  it("persists every stage of a successful run, per act", async () => {
    const store = new FakeCheckpointStore(FP);
    const finalize = fakeFinalize();
    const { deps } = countingDeps();

    const outcome = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...deps, finalize: finalize.fn, checkpoint: store }
    );

    expect(outcome.outcome).toBe("generated");
    const staged = store.stageKeys(KEY);
    expect(staged).toContain("understand");
    expect(staged).toContain("research-shape");
    expect(staged).toContain("spine");
    expect(staged).toContain("source");
    expect(staged).toContain("stitch");
    /* Per-ACT keys, not one `deepen`/`narrate` key: F-17 is specifically about
       a failure in one act not costing the acts that already finished. */
    expect(staged.filter((s) => s.startsWith("deepen:")).length).toBeGreaterThan(0);
    expect(staged.filter((s) => s.startsWith("narrate:")).length).toBeGreaterThan(0);
  });

  it("a second run with the same prompt makes no model calls at all", async () => {
    const store = new FakeCheckpointStore(FP);
    const first = countingDeps();
    await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...first.deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    expect(first.calls.spine).toBe(1);

    const second = countingDeps();
    const outcome = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...second.deps, finalize: fakeFinalize().fn, checkpoint: store }
    );

    expect(outcome.outcome).toBe("generated");
    expect(second.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
  });

  it("produces the same Foray whether it was resumed or built", async () => {
    const store = new FakeCheckpointStore(FP);
    const at = () => new Date("2026-09-09T00:00:00Z");

    const fresh = fakeFinalize();
    await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...countingDeps().deps, finalize: fresh.fn, checkpoint: store });

    const resumed = fakeFinalize();
    await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...countingDeps().deps, finalize: resumed.fn, checkpoint: store });

    /* The FORAY is identical. `meta.veracity` is not, and must not be: it
       records the run that produced the candidate (WS-B), and a resumed run
       made no narration calls and paid nothing for the stages it reloaded —
       exactly what F-17/F-18 exist to make true. */
    const stripVeracity = (input: unknown) => {
      const { meta, ...rest } = input as { meta?: { veracity?: unknown } & Record<string, unknown> };
      const { veracity: _veracity, ...metaRest } = meta ?? {};
      return { ...rest, meta: metaRest };
    };
    expect(stripVeracity(resumed.seen[0])).toEqual(stripVeracity(fresh.seen[0]));
    const resumedVeracity = (resumed.seen[0] as { meta: { veracity: { callsPerBeat: number | null; stageTimings: Array<{ name: string; resumed?: boolean }> } } }).meta.veracity;
    expect(resumedVeracity.callsPerBeat).toBe(0);
    expect(resumedVeracity.stageTimings.filter((t) => t.resumed).map((t) => t.name)).toEqual(
      expect.arrayContaining(["understand", "research-shape", "spine", "source", "narrate:0", "stitch"])
    );
  });

  it("a narration failure costs the narration, not the spine or the deepening", async () => {
    /* The F-17 case exactly: run 1 attempt 4 died at beat 23 of 31 and lost
       the spine and three deepened acts with it. */
    const store = new FakeCheckpointStore(FP);
    const failing = countingDeps();
    failing.deps.narrationWriter.writePages = async () => {
      throw new Error("page rejected three times");
    };

    await expect(
      runForayPipeline(request, { userId: "u", checkpointKey: KEY }, { ...failing.deps, finalize: fakeFinalize().fn, checkpoint: store })
    ).rejects.toThrow();

    const staged = store.stageKeys(KEY);
    expect(staged).toContain("spine");
    expect(staged.filter((s) => s.startsWith("deepen:")).length).toBeGreaterThan(0);
    expect(staged.filter((s) => s.startsWith("narrate:"))).toEqual([]);

    // The re-run pays for narration only.
    const retry = countingDeps();
    const outcome = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...retry.deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    expect(outcome.outcome).toBe("generated");
    expect(retry.calls.spine).toBe(0);
    expect(retry.calls.deepen).toBe(0);
    expect(retry.calls.understand).toBe(0);
    expect(retry.calls.write).toBeGreaterThan(0);
  });

  it("marks resumed stages in the timings rather than reporting a 0 ms spine", async () => {
    const store = new FakeCheckpointStore(FP);
    const at = () => new Date("2026-09-09T00:00:00Z");
    await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
    const outcome = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: at },
      { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    const spine = outcome.timings.find((t) => t.name === "spine")!;
    expect(spine.resumed).toBe(true);
    expect(spine.ms).toBe(0);
    /* Finalize always runs — it validates, it does not generate. */
    expect(outcome.timings.find((t) => t.name === "finalize")!.resumed).toBeUndefined();
  });

  it("re-runs everything when the request changed", async () => {
    const store = new FakeCheckpointStore(FP);
    await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store }
    );

    const longer = countingDeps();
    /* A different duration tier is a different Foray. Resuming its spine would
       be a wrong result rather than a slow one. */
    await runForayPipeline(
      { ...request, duration: "medium" },
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...longer.deps, finalize: fakeFinalize().fn, checkpoint: store }
    ).catch(() => undefined);
    expect(longer.calls.spine).toBe(1);
  });

  it("behaves exactly as before when no checkpoint is supplied", async () => {
    const first = countingDeps();
    const a = await runForayPipeline(request, { userId: "u" }, { ...first.deps, finalize: fakeFinalize().fn });
    const second = countingDeps();
    const b = await runForayPipeline(request, { userId: "u" }, { ...second.deps, finalize: fakeFinalize().fn });
    expect(a.outcome).toBe("generated");
    expect(b.outcome).toBe("generated");
    expect(second.calls.spine).toBe(1);
    expect(a.timings.every((t) => t.resumed === undefined)).toBe(true);
  });
});

describe("a budget stop names the stage and the spend (F-04)", () => {
  it("wraps a per-Foray budget error with the stage, the spend and the resume hint", async () => {
    const deps = countingDeps().deps;
    deps.spineBuilder.buildSpine = async () => {
      throw new EpisodeBudgetExceededError("session-1", 9.982, 0.215, 10);
    };

    const err = await runForayPipeline(request, { userId: "u", checkpointKey: KEY }, { ...deps, finalize: fakeFinalize().fn }).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(BudgetStopError);
    const stop = err as BudgetStopError;
    expect(stop.stage).toBe("spine");
    expect(stop.scope).toBe("per-foray");
    expect(stop.message).toContain('stage "spine"');
    expect(stop.message).toContain("$9.9820");
    expect(stop.message).toContain("$10.00");
    expect(stop.message).toContain(KEY);
    expect(stop.message).toContain("--budget-usd");
  });

  it("names the daily cap when that is the one that tripped, through §4.4's own wrapper", async () => {
    /* §4.4 catches everything an act's build throws and re-throws its own
       `ActDeepeningError` with the original on `cause`. Without the cause walk
       this surfaces as "Deepening act 1 failed after 1 retry" and the dollar
       figures never reach the operator — F-04's unactionable message, one
       wrapper further out. */
    const deps = countingDeps().deps;
    deps.deepenBuilder.deepenAct = async () => {
      throw new BudgetExceededError(1, 24.9, 0.2, 25);
    };
    const err = await runForayPipeline(request, { userId: "u" }, { ...deps, finalize: fakeFinalize().fn }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(BudgetStopError);
    expect((err as BudgetStopError).stage).toBe("deepen");
    expect((err as BudgetStopError).scope).toBe("daily");
    expect((err as Error).message).toContain("DAILY_BUDGET_USD");
  });

  it("leaves a non-budget failure exactly as it was", async () => {
    const deps = countingDeps().deps;
    deps.spineBuilder.buildSpine = async () => {
      throw new Error("the model returned nonsense");
    };
    await expect(runForayPipeline(request, { userId: "u" }, { ...deps, finalize: fakeFinalize().fn })).rejects.toThrow(
      "the model returned nonsense"
    );
  });
});
