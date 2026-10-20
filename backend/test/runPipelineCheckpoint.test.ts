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
import { CHECKPOINT_VERSION, checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { resolvePipelineFlags, type PipelineFlags } from "../src/generation/pipelineFlags";
import { resolveRouting } from "../src/config/stageRouting";
import { joinCheckpointVariant, readSelfCritique } from "../src/generation/selfCritique";
import { BudgetExceededError, BudgetGuard, EpisodeBudgetExceededError, BudgetStopError } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { SpineBuilder } from "../src/generation/SpineBuilder";
import type { PromptUnderstander } from "../src/generation/PromptUnderstander";
import type { DeepenActBuilder } from "../src/generation/DeepenActBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import { RunLog, currentCallContext, runWithRunLog } from "../src/generation/runLog";
import type { ClipJudge, ClipQuestion } from "../src/generation/clipJudge";
import { loadCatalogueData } from "../src/generation/catalogueLookup";
import { loadSegmentPool } from "../src/generation/segmentPoolLookup";
import { loadTranscriptArchive, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { PartialCandidate } from "../src/generation/partialCandidate";

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
  /* Q-03: the call that writes narration takes a whole ACT at a time — so
     this counts act-writes. (WS-A made it a slot, G-34 the merged
     select+prose request on a clean slot.) The assertions below only ask
     whether narration was PAID FOR again after a resume, which that
     answers exactly. */
  const realWrite = narrationWriter.writeAct.bind(narrationWriter);
  narrationWriter.writeAct = async (...args: Parameters<StubNarrationWriterBuilder["writeAct"]>) => {
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
    expect(staged).toContain("stitch:0");
    /* Per-ACT keys, not one `deepen`/`narrate` key: F-17 is specifically about
       a failure in one act not costing the acts that already finished. */
    expect(staged.filter((s) => s.startsWith("deepen:")).length).toBeGreaterThan(0);
    expect(staged.filter((s) => s.startsWith("narrate:")).length).toBeGreaterThan(0);
    /* Q-03: the act is the unit of writing, so a fresh run banks the act
       under `narrate:<i>` and writes NO per-slot key — F-51's
       `narrate:<i>:<slot>` keys are the per-page path's, still read (the
       test below) and still written by that fallback. */
    expect(staged.filter((s) => /^narrate:\d+:\d+$/.test(s))).toEqual([]);
  });

  it("F-100: a pre-version-2 checkpoint is REJECTED whole rather than half-understood, and no per-slot narration key is ever written", async () => {
    /* WHAT THIS REPLACES. Until F-100 this test drove a per-page run that
       banked `narrate:<i>:<slot>` keys and then resumed an act from them.
       Q-03 made the ACT the unit of writing — a seam spans slots, so half
       an act's slots are not a resumable state — and F-100 deleted both
       the per-page path that wrote those keys and the branch that read
       them, bumping `CHECKPOINT_VERSION` to 2 in the same PR. What is
       pinned now is the guarantee that replaces them: a file written by an
       older build is discarded, so no stage is ever resumed from a shape
       this code would read differently than the code that wrote it.

       MUTATION THAT KILLS THIS: leave `CHECKPOINT_VERSION` at 1 (the old
       file resumes and the run reports stages it never ran), or start
       writing a per-slot narration key again. Ran the first — red. */
    const store = new FakeCheckpointStore(FP);

    const first = countingDeps();
    const written = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...first.deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    expect(written.outcome).toBe("generated");
    expect(store.stageKeys(KEY)).toContain("narrate:0");
    expect(store.stageKeys(KEY).filter((s) => /^narrate:\d+:\d+$/.test(s))).toEqual([]);

    /* The same file, stamped with the version a pre-F-100 build wrote. */
    const file = store.files.get(KEY)!;
    store.files.set(KEY, { ...file, version: CHECKPOINT_VERSION - 1 });

    const second = countingDeps();
    const rerun = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z") },
      { ...second.deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    expect(rerun.outcome).toBe("generated");
    /* Nothing was resumed: every stage ran again, which is the cost of a
       version bump and the whole of its point. */
    expect(second.calls.spine).toBeGreaterThan(0);
    expect(second.calls.write).toBeGreaterThan(0);
  }, 120_000);

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
      expect.arrayContaining(["understand", "topic", "research-shape", "spine", "source", "narrate:0", "stitch:0"])
    );
  });

  it("a narration failure costs the narration, not the spine or the deepening", async () => {
    /* The F-17 case exactly: run 1 attempt 4 died at beat 23 of 31 and lost
       the spine and three deepened acts with it. */
    const store = new FakeCheckpointStore(FP);
    const failing = countingDeps();
    failing.deps.narrationWriter.writeAct = async () => {
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

  it("GV-01: a banked topic is a RESUMED `topic` stage, in the timings and in the RunLog, whether the identity or only the topic was banked", async () => {
    /* Run 1 dies in the spine, after the topic was banked and before the
       identity was: run 2 resumes from `topic` alone. Run 3 then finds the
       identity banked too. Neither re-decides the topic, so neither may time
       a `topic` stage as if it ran.

       MUTATION THAT KILLS THIS: drop `markResumed("topic")` from the
       banked-topic branch — run 2's timings carry no `topic` entry at all.
       Ran it — red. Dropping it from the identity branch fails run 3 the same
       way. Swapping `stageDetail`'s `markResumed(name)` back to
       `timings.markResumed(name)` drops every other resumed span from the
       RunLog (understand, research-shape, spine, source, narrate:0,
       stitch:0) and fails run 3's resumed-span check. Ran it — red. */
    const store = new FakeCheckpointStore(FP);
    const at = () => new Date("2026-09-09T00:00:00Z");
    const dying = countingDeps();
    dying.deps.spineBuilder.buildSpine = async () => {
      throw new Error("spine fixture: transport died");
    };
    await expect(
      runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...dying.deps, finalize: fakeFinalize().fn, checkpoint: store })
    ).rejects.toThrow(/transport died/);
    expect(store.stageKeys(KEY)).toContain("topic");
    expect(store.stageKeys(KEY)).not.toContain("identity");

    const topicOnly = new RunLog();
    const second = await runWithRunLog(topicOnly, () =>
      runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store })
    );
    expect(second.timings.find((t) => t.name === "topic")).toMatchObject({ ms: 0, resumed: true });
    expect(second.timings.find((t) => t.name === "spine")!.resumed).toBeUndefined();
    expect(topicOnly.stages().find((s) => s.name === "topic")).toMatchObject({ status: "resumed", ms: 0 });

    const identity = new RunLog();
    const third = await runWithRunLog(identity, () =>
      runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store })
    );
    expect(third.timings.filter((t) => t.name === "topic")).toEqual([expect.objectContaining({ ms: 0, resumed: true })]);
    expect(identity.stages().find((s) => s.name === "topic")!.status).toBe("resumed");
    /* Resumed spans are not time this attempt spent. `deepen` resumes per
       act INSIDE its stage (`deepen:<i>`), so the stage itself still runs. */
    expect(identity.stages().filter((s) => s.status === "ok").map((s) => s.name)).toEqual(["deepen", "evidence", "finalize"]);
    /* Every other banked stage comes back through `stageDetail`, which must
       append its own resumed span — not just tick the timings. */
    const resumedSpans = identity.stages().filter((s) => s.status === "resumed");
    expect(resumedSpans.map((s) => s.name)).toEqual(
      expect.arrayContaining(["understand", "topic", "research-shape", "spine", "source", "narrate:0", "stitch:0"])
    );
    expect(resumedSpans.every((s) => s.ms === 0)).toBe(true);
  }, 60_000);

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

  it("names the run cap when that is the one that tripped, through §4.4's own wrapper", async () => {
    /* §4.4 catches everything an act's build throws and re-throws its own
       `ActDeepeningError` with the original on `cause`. Without the cause walk
       this surfaces as "Deepening act 1 failed after 1 retry" and the dollar
       figures never reach the operator — F-04's unactionable message, one
       wrapper further out. */
    const deps = countingDeps().deps;
    deps.deepenBuilder.deepenAct = async () => {
      throw new BudgetExceededError(24.9, 0.2, 25);
    };
    const err = await runForayPipeline(request, { userId: "u" }, { ...deps, finalize: fakeFinalize().fn }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(BudgetStopError);
    expect((err as BudgetStopError).stage).toBe("deepen");
    expect((err as BudgetStopError).scope).toBe("run");
    expect((err as Error).message).toContain("RUN_BUDGET_USD");
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


describe("the per-Foray cap only exists when the run carries a sessionId (requirements §8.10)", () => {
  /** A pipeline whose FIRST stage bills against a guard that already holds
   * more per-Foray spend than the cap allows. Nothing else is changed. */
  function overspentDeps(sessionId: string) {
    const sink = new InMemoryCostEventSink();
    /* Recorded straight onto the sink rather than through the guard: this
       is spend the Foray already made, not a call being authorised now. */
    void sink.record({ userId: "u", operation: "spine_build", provider: "anthropic", estimatedUsd: 5, sessionId });
    const guard = new BudgetGuard(sink, 1000, 1);
    const deps = countingDeps().deps;
    return { ...deps, understander: new StubPromptUnderstander(guard) };
  }

  it("stops the run when one Foray has spent past EPISODE_BUDGET_USD", async () => {
    const session = "the-history-of-grilling-and-barbecue-deadbeef";
    const err = await runForayPipeline(
      request,
      { userId: "u", sessionId: session },
      { ...overspentDeps(session), finalize: fakeFinalize().fn }
    ).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(BudgetStopError);
    const stop = err as BudgetStopError;
    expect(stop.scope).toBe("per-foray");
    expect(stop.cause).toBeInstanceOf(EpisodeBudgetExceededError);
    expect(stop.stage).toBe("understand");
  });

  it("and does not, with the same spend, when no sessionId is carried — the inert case this fixes", async () => {
    const session = "the-history-of-grilling-and-barbecue-deadbeef";
    const outcome = await runForayPipeline(
      request,
      { userId: "u" },
      { ...overspentDeps(session), finalize: fakeFinalize().fn }
    );
    expect(outcome.outcome).toBe("generated");
  });
});

describe("per-act servability survives a resume (GV-21)", () => {
  const medium: GenerationRequest = { ...request, duration: "medium" };
  const MEDIUM_FP = checkpointFingerprint({ prompt: medium.prompt, duration: medium.duration });
  const at = () => new Date("2026-09-09T00:00:00Z");

  it("a banked act's provenance and veracity equal a fresh run's, so the next act's partial is the same", async () => {
    /* MUTATION THAT KILLS THIS (provenance): make acceptStitchedAct record
       the banked act with unverifiedProvenanceFor(...) instead of
       recomputing it. Act 0 then reads unservable on the resumed run and the
       deliveries differ. Ran it — red.
       MUTATION THAT KILLS THIS (veracity): compute actVeracity inside the
       onActReady wrapper instead of the stitch loop. The resumed act 0 never
       fires the callback, so its `veracity` is missing. Ran it — red. */
    const store = new FakeCheckpointStore(MEDIUM_FP);
    const freshPartials: PartialCandidate[] = [];
    const fresh = await runForayPipeline(
      medium,
      { userId: "u", checkpointKey: KEY, now: at },
      { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store, onActReady: (c) => void freshPartials.push(c) }
    );
    expect(fresh.outcome).toBe("generated");
    expect(freshPartials.length).toBeGreaterThan(1);

    /* Keep act 0's stitch banked, forget every later one: the second run
       accepts act 0 from the checkpoint and stitches act 1 onward fresh. */
    store.drop(KEY, store.stageKeys(KEY).filter((k) => /^stitch:\d+$/.test(k) && k !== "stitch:0"));

    const resumedPartials: PartialCandidate[] = [];
    const resumed = await runForayPipeline(
      medium,
      { userId: "u", checkpointKey: KEY, now: at },
      { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store, onActReady: (c) => void resumedPartials.push(c) }
    );
    expect(resumed.outcome).toBe("generated");
    /* Act 0 was accepted, not stitched: no partial for it on this run. */
    expect(resumedPartials).toHaveLength(freshPartials.length - 1);

    const freshAct1 = freshPartials[1]!;
    const resumedAct1 = resumedPartials[0]!;
    expect(resumedAct1.items).toEqual(freshAct1.items);
    expect(resumedAct1.delivery).toEqual(freshAct1.delivery);
    expect(resumedAct1.delivery!.items.filter((d) => d.act === 0).length).toBeGreaterThan(0);
    expect(resumedAct1.acts[0]!.veracity).toBeDefined();
    expect(resumedAct1.acts[0]!.veracity).toEqual(freshAct1.acts[0]!.veracity);
    expect(resumedAct1.acts[0]!.served).toBe(freshAct1.acts[0]!.served);
  }, 120_000);
});

/**
 * GV-79 (W5-03, MQ-05): the `clip-scores` stage resumes like every other.
 * The pool's items have no transcript digest on a checkout, so each gets a
 * synthetic digest row and catalogue title, and the cue provider answers
 * only inside the `clip-scores` stage (the run is inside a RunLog so the
 * call context is live): sourcing and narration see no transcript, exactly
 * as in every other stub run. The judge is scripted and counts its calls.
 */
describe("GV-79 clip-scores checkpoint", () => {
  const SHADOW = { clipJudge: "shadow" as const };
  const at = () => new Date("2026-09-09T00:00:00Z");

  function clipFixture() {
    const ids = [...new Set(loadSegmentPool().map((seg) => seg.item_id))];
    const title = (id: string) => `Pitmaster smoke stories ${id.replace(/[^a-z0-9]+/gi, " ")}`;
    const real = loadCatalogueData();
    return {
      transcriptArchive: [
        ...loadTranscriptArchive(),
        ...ids.map((id) => ({ show_id: id.includes("--") ? id.slice(0, id.indexOf("--")) : id, show_title: "x", guid: `gv79-${id}`, title: title(id), cues: 10 }))
      ],
      clipCatalogue: { ...real, items: [...ids.map((id) => ({ id, show: "x", title: title(id), topics: [], hook: "" })), ...real.items] },
      cueProvider: {
        getCues: (entry: TranscriptDigestEntry) =>
          currentCallContext().stage === "clip-scores" && entry.guid.startsWith("gv79-")
            ? [{ start_sec: 0, end_sec: 1_000_000, text: "Pitmasters argue about smoke, wood and low heat for barbecue brisket." }]
            : null
      }
    };
  }

  function countingJudge(): ClipJudge & { calls: number; questions: number } {
    const judge = {
      name: "counting",
      calls: 0,
      questions: 0,
      async score(qs: readonly ClipQuestion[]) {
        judge.calls++;
        judge.questions += qs.length;
        return new Map(qs.map((q, i) => [q.key, { subject: i === 0 ? 1 : 4, claim: 4, judge: "jev" as const }]));
      }
    };
    return judge;
  }

  const run = (gates: { clipJudge: "off" | "shadow" }, deps: Record<string, unknown>) =>
    runWithRunLog(new RunLog(), () =>
      runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, gates }, { ...deps, finalize: fakeFinalize().fn } as never)
    );

  /* MUTATION THAT KILLS THIS: feed `gates.clipJudge` into the checkpoint
     variant (gates are never fingerprinted, W5-02): the judge-off file no
     longer matches and every stage is paid for again. Ran it: red. */
  it("a checkpoint banked before GV-79 (judge off) resumes under shadow: only the clip scores are new work", async () => {
    const store = new FakeCheckpointStore(FP);
    const fixture = clipFixture();
    const first = countingDeps();
    const off = await run({ clipJudge: "off" }, { ...first.deps, ...fixture, checkpoint: store, clipJudge: countingJudge() });
    expect(off.outcome).toBe("generated");
    expect(store.stageKeys(KEY)).not.toContain("clip-scores");

    const second = countingDeps();
    const judge = countingJudge();
    const resumed = await run(SHADOW, { ...second.deps, ...fixture, checkpoint: store, clipJudge: judge });
    if (resumed.outcome !== "generated" || off.outcome !== "generated") throw new Error("expected both to generate");
    expect(second.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
    expect(judge.calls).toBe(1);
    expect(judge.questions).toBeGreaterThan(0);
    expect(store.stageKeys(KEY)).toContain("clip-scores");
    expect(resumed.input.items).toEqual(off.input.items);
    expect(resumed.input.meta!.veracity!.clipOnSubjectDetails?.scored).toBe(judge.questions);
  }, 120_000);

  /* MUTATION THAT KILLS THIS: run the scorer outside `stage` (no
     checkpoint). Ran it: red (the resumed run asks the judge again). */
  it("a checkpoint with clip-scores banked resumes with zero judge calls and the same report", async () => {
    const store = new FakeCheckpointStore(FP);
    const fixture = clipFixture();
    const firstJudge = countingJudge();
    const first = await run(SHADOW, { ...countingDeps().deps, ...fixture, checkpoint: store, clipJudge: firstJudge });
    expect(firstJudge.calls).toBe(1);
    expect(store.stageKeys(KEY)).toContain("clip-scores");

    const judge = countingJudge();
    const resumed = await run(SHADOW, { ...countingDeps().deps, ...fixture, checkpoint: store, clipJudge: judge });
    if (first.outcome !== "generated" || resumed.outcome !== "generated") throw new Error("expected both to generate");
    expect(judge.calls).toBe(0);
    expect(resumed.timings.find((t) => t.name === "clip-scores")?.resumed).toBe(true);
    const v1 = first.input.meta!.veracity!;
    const v2 = resumed.input.meta!.veracity!;
    expect(v2.clipOnSubjectRate).toBe(v1.clipOnSubjectRate);
    expect(v2.clipOnSubjectDetails).toEqual(v1.clipOnSubjectDetails);
    expect(v1.clipOnSubjectRate).toBeLessThan(1);
    expect(resumed.tapeRelevance).toEqual(first.tapeRelevance);
  }, 120_000);
});

/* GV-102 (W4-07): the per-act pipeline banks per-act sourcing (`source:<i>`)
   and its fingerprint carries the `perAct` variant (GV-15), so a classic
   checkpoint and a per-act one never resume each other's stages. */
describe("GV-102: classic and per-act checkpoints do not resume each other", () => {
  /** The fingerprint the run computes for `flags`, from the same env-read
   * routing and self-critique the run reads. */
  const fingerprintFor = (flags: Partial<PipelineFlags>): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant(resolvePipelineFlags(flags), resolveRouting()), readSelfCritique())
    });
  const PER_ACT = { perActPipeline: true };

  async function countedRun(store: FakeCheckpointStore, flags: Partial<PipelineFlags> | undefined) {
    const { calls, deps } = countingDeps();
    const outcome = await runForayPipeline(
      request,
      { userId: "u", checkpointKey: KEY, now: () => new Date("2026-09-09T00:00:00Z"), ...(flags ? { flags } : {}) },
      { ...deps, finalize: fakeFinalize().fn, checkpoint: store }
    );
    expect(outcome.outcome).toBe("generated");
    return calls;
  }

  /* MUTATION THAT KILLS THIS: drop `if (flags.perActPipeline)
     parts.push("perAct")` from pipelineFlags.ts checkpointVariant (the two
     fingerprints agree, so the per-act run resumes the classic run's
     understand, spine and deepen). Ran it: red. */
  it("a classic checkpoint is not resumed by a per-act run, and the reverse; each resumes its own", async () => {
    const classicStore = new FakeCheckpointStore(fingerprintFor({}));
    await countedRun(classicStore, undefined);
    expect(classicStore.stageKeys(KEY)).toContain("source");
    const perActOverClassic = await countedRun(classicStore, PER_ACT);
    expect(perActOverClassic.understand).toBeGreaterThan(0);
    expect(perActOverClassic.spine).toBe(1);
    expect(perActOverClassic.deepen).toBeGreaterThan(0);
    expect(perActOverClassic.write).toBeGreaterThan(0);

    const perActStore = new FakeCheckpointStore(fingerprintFor(PER_ACT));
    await countedRun(perActStore, PER_ACT);
    expect(perActStore.stageKeys(KEY)).toContain("source:0");
    expect(perActStore.stageKeys(KEY)).not.toContain("source");
    const classicOverPerAct = await countedRun(perActStore, undefined);
    expect(classicOverPerAct.spine).toBe(1);
    expect(classicOverPerAct.deepen).toBeGreaterThan(0);
    expect(classicOverPerAct.write).toBeGreaterThan(0);

    /* Not vacuous: each store resumes its own kind of run for nothing. */
    const perActAgain = await countedRun(perActStore, PER_ACT);
    expect(perActAgain).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
    const classicAgain = await countedRun(classicStore, undefined);
    expect(classicAgain).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
    expect(fingerprintFor(PER_ACT)).not.toBe(fingerprintFor({}));
  }, 240_000);
});
