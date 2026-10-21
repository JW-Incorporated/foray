import { describe, it, expect, vi } from "vitest";
import { runForayPipeline, type RetrievalPreparer } from "../src/generation/runPipeline";
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
import { createEvidenceGatherer, type EvidenceGatherer } from "../src/generation/gatherEvidence";
import { HANDOFF_SCRIPT, type WrittenAct } from "../src/generation/writeNarration";
import { droppedReasonOf, isStatementSentence, type NarratedBeat } from "../src/types/narration";
import { splitSpokenSentences } from "../src/copy/spokenLine";
import type { SentenceVerdict } from "../src/generation/NarrationVerifierBuilder";
import { SourcingSession } from "../src/generation/sourceBeats";
import type { RetrievalStats } from "../src/generation/retrievalClient";
import type { TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { ResearchShape, ResearchTapeWindow } from "../src/types/research";
import { familyGateAllows, nodesForArchiveEntry } from "../src/generation/taxonomyFamily";

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

/**
 * GV-108 (W5-12b): under FORAY_UNVERIFIED_SEAM_POLICY=cut the `narrate:<i>`
 * stage banks intro-only pages and `droppedReason` beats, and a resumed run
 * reads them back as written, on the classic and the per-act path. The
 * verifier refuses every seam, so every seam is cut; the gatherer names each
 * clip's show and episode (a checkout's pool has no catalogue titles), so a
 * seam into a clip keeps its naming sentence as an intro-only page.
 */
describe("GV-108: a cut act banks and resumes on both pipeline paths", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const CUT = { unverifiedSeamPolicy: "cut" as const };
  /* The cut run's own fingerprint: `seamPolicy=cut` joins the variant
     (orchestrator, #1476 review), so a store keyed without it would not
     resume. */
  const fingerprintFor = (flags: Partial<PipelineFlags>): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant({ ...resolvePipelineFlags(flags), ...CUT }, resolveRouting()), readSelfCritique())
    });

  function cutDeps() {
    const counted = countingDeps();
    const verifier = counted.deps.narrationVerifier;
    const realVerify = verifier.verifyAct.bind(verifier);
    verifier.verifyAct = async (...args: Parameters<typeof realVerify>) => {
      const verdict = await realVerify(...args);
      return { ...verdict, seams: verdict.seams.map((seam) => ({ ...seam, claimsSupported: false, notes: "refused for GV-108" })) };
    };
    const real = createEvidenceGatherer({});
    const evidence: EvidenceGatherer = {
      async gather(beat, buildCtx) {
        const pack = await real.gather(beat, buildCtx);
        if (!beat.tape) return pack;
        const { itemId, startSec, endSec } = beat.tape;
        return { ...pack, tape: { itemId, showTitle: "Pitmaster Radio", episodeTitle: `Smoke stories ${itemId.slice(-6)}`, startSec, endSec } };
      }
    };
    return { calls: counted.calls, deps: { ...counted.deps, evidence } };
  }

  const banked = (store: FakeCheckpointStore) =>
    Object.entries(store.files.get(KEY)!.stages)
      .filter(([k]) => k.startsWith("narrate:"))
      .flatMap(([, v]) => (v as WrittenAct).slots.flatMap((slot) => slot.beats));

  /* MUTATION THAT KILLS THIS: drop `droppedReason` from runPipeline.ts's
     WrittenBeatSchema (the object strips it on resume) -- the resumed act
     loses its drops and `pagesCut` falls. Ran it -- red. And: leave
     NarratedBeatSchema's `verification` synthesis-only -- the banked
     intro-only page no longer parses and the resume fails. Ran it -- red. */
  it("banks intro-only pages and droppedReason beats with no hand-off, and a resumed run writes nothing and reads the same Foray", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const store = new FakeCheckpointStore(fingerprintFor(flags));
      const first = cutDeps();
      const fresh = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: CUT }, { ...first.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (fresh.outcome !== "generated") throw new Error("expected a generated outcome");
      const beats = banked(store);
      const pages = beats.map((b) => (b.sourcing === "tape" ? b.connectiveNarration : b.narration)).filter((p): p is NarratedBeat => p !== undefined);
      expect(pages.some((p) => p.verification?.kind === "intro-only")).toBe(true);
      expect(beats.some((b) => droppedReasonOf(b) === "unverified-cut")).toBe(true);
      expect(pages.every((p) => p.verified)).toBe(true);
      expect(JSON.stringify(store.files.get(KEY)!.stages)).not.toContain(HANDOFF_SCRIPT);
      const pagesCut = fresh.input.meta!.veracity!.pagesCut;
      expect(pagesCut).toBeGreaterThan(0);
      expect(fresh.input.meta!.veracity!.unverifiedPages).toBe(0);

      store.drop(KEY, store.stageKeys(KEY).filter((k) => k.startsWith("stitch:")));
      const second = cutDeps();
      const resumed = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: CUT }, { ...second.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (resumed.outcome !== "generated") throw new Error("expected a generated outcome");
      expect(second.calls.write).toBe(0);
      expect(resumed.input.items).toEqual(fresh.input.items);
      expect(resumed.input.meta!.veracity!.pagesCut).toBe(pagesCut);
    }
  }, 240_000);

  it("the default run under the same refusals keeps today's shape: no pagesCut, no intro-only page, no dropped beat", async () => {
    /* MUTATION THAT KILLS THIS: thread the policy into the writer whatever
       its value (drop the `=== "cut"` test in narrateOneAct) or report
       `pagesCut` unconditionally. Ran both -- red. */
    const store = new FakeCheckpointStore(fingerprintFor({}));
    const out = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at }, { ...cutDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
    if (out.outcome !== "generated") throw new Error("expected a generated outcome");
    expect(Object.prototype.hasOwnProperty.call(out.input.meta!.veracity!, "pagesCut")).toBe(false);
    expect(out.input.meta!.veracity!.unverifiedPages).toBeGreaterThan(0);
    expect(banked(store).some((b) => droppedReasonOf(b) !== undefined)).toBe(false);
  }, 120_000);
});

/**
 * GV-109 (W5-13; MQ-06): the per-edge boundary kinds ride on the banked
 * sourcing rows (`source` on the classic path, `source:<i>`'s snapshot on the
 * per-act path), and the new tier-2 gate `claim-only-open` rides on its trace
 * rows. A checkpoint written before GV-109 carries neither and still resumes;
 * one that carries both round-trips through the stage schemas rather than
 * being stripped or dropped and re-sourced.
 */
describe("GV-109: per-edge kinds and the claim-only-open gate survive a resume, and a pre-GV-109 checkpoint resumes", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const fingerprintFor = (flags: Partial<PipelineFlags>): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant(resolvePipelineFlags(flags), resolveRouting()), readSelfCritique())
    });
  type Rows = { tapeRelevance: Array<Record<string, unknown>>; sourcingTrace: Array<Record<string, unknown>>; newSegments: Array<Record<string, unknown>> };
  /** The banked rows the run's sourcing resumes from, on either path. */
  const bankedRows = (store: FakeCheckpointStore, perAct: boolean): Rows => {
    const stages = store.files.get(KEY)!.stages as Record<string, unknown>;
    if (!perAct) return stages.source as Rows;
    const last = Object.keys(stages)
      .filter((k) => k.startsWith("source:"))
      .sort()
      .pop()!;
    return (stages[last] as { snapshot: Rows }).snapshot;
  };
  const sourceSaves = (store: FakeCheckpointStore) => store.saves.filter((s) => s.stage === "source" || s.stage.startsWith("source:")).length;
  const claimOnlyOpenRow = {
    actIndex: 0,
    slotIndex: 0,
    beatIndex: 0,
    claim: "a beat whose only tape opened mid-thought",
    outcome: "no-tape",
    tier1: null,
    tier2: { bestShowId: "practical-ai", bestEpisodeTitle: "Episode 801", score: 3, requiredScore: 2, gate: "claim-only-open", windowStartSec: 60, boundary: "claim-only" }
  };

  /* MUTATIONS THAT KILL THIS: drop `startBoundary`/`endBoundary` from
     runPipeline.ts's TapeRelevanceInputSchema (the object strips them on
     resume and the resumed row has none: cleanCutDetails reads the row as a
     claim-only legacy one); drop "claim-only-open" from TIER2_GATE_SCHEMA
     (the banked stage no longer parses, is dropped and re-sourced: a new
     source save). Ran both: red. */
  it("a checkpoint carrying the new kinds and gate round-trips on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const perAct = flags.perActPipeline === true;
      const store = new FakeCheckpointStore(fingerprintFor(flags));
      const fresh = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (fresh.outcome !== "generated") throw new Error("expected a generated outcome");
      const rows = bankedRows(store, perAct);
      expect(rows.tapeRelevance.length).toBeGreaterThan(0);
      /* The banked row as GV-109 writes a tier-2 clip that opens on a turn and
         trails off claim-only, and a trace row refused under the new gate. */
      Object.assign(rows.tapeRelevance[0]!, { tier: 2, boundary: "claim-only", startBoundary: "turn", endBoundary: "claim-only", extendedBySec: 12 });
      rows.sourcingTrace.push(claimOnlyOpenRow);

      const savesBefore = sourceSaves(store);
      const second = countingDeps();
      const resumed = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...second.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (resumed.outcome !== "generated") throw new Error("expected a generated outcome");
      expect(sourceSaves(store)).toBe(savesBefore);
      expect(second.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
      expect(resumed.tapeRelevance[0]).toMatchObject({ boundary: "claim-only", startBoundary: "turn", endBoundary: "claim-only" });
      const veracity = resumed.input.meta!.veracity!;
      expect(veracity.cleanCutRate).toBe(0);
      expect(veracity.cleanCutDetails!.known).toBe(1);
      expect(veracity.cleanCutDetails!.openingCleanRate).toBe(1);
      expect(bankedRows(store, perAct).sourcingTrace.at(-1)).toMatchObject({ tier2: { gate: "claim-only-open" } });
    }
  }, 240_000);

  /* The pipeline's own fingerprint site (decision 20; the driver's is
     generateForays.ts, from the same gate config): a refuse run banks under
     `claimOnlyOpening=refuse`, resumes its own stages, and is not resumed by
     an allow run, on both paths. MUTATION THAT KILLS THIS: drop
     `claimOnlyOpening: gates.claimOnlyOpening` from runPipeline.ts's
     checkpointRunVariant call (the refuse run's session fingerprint is the
     allow one, so it never matches its own refuse-keyed store and every
     stage is paid for again). Ran it: red. */
  it("a refuse run resumes only a checkpoint banked under refuse, and an allow run does not resume it", async () => {
    const REFUSE = { claimOnlyOpening: "refuse" as const };
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const refuseFingerprint = checkpointFingerprint({
        prompt: request.prompt,
        duration: request.duration,
        variant: joinCheckpointVariant(checkpointRunVariant({ ...resolvePipelineFlags(flags), ...REFUSE }, resolveRouting()), readSelfCritique())
      });
      expect(refuseFingerprint).not.toBe(fingerprintFor(flags));
      const store = new FakeCheckpointStore(refuseFingerprint);
      const first = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: REFUSE }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(first.outcome).toBe("generated");
      const again = countingDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: REFUSE }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
      const allow = countingDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...allow.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(allow.calls.spine).toBe(1);
    }
  }, 240_000);

  /* MUTATION THAT KILLS THIS: make TapeRelevanceInputSchema's
     `startBoundary` required — a pre-GV-109 stage no longer parses and is
     re-sourced (a new source save). Ran it: red. */
  it("a checkpoint written before GV-109 (boundary only, no per-edge kinds) resumes with nothing re-sourced", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const perAct = flags.perActPipeline === true;
      const store = new FakeCheckpointStore(fingerprintFor(flags));
      const fresh = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (fresh.outcome !== "generated") throw new Error("expected a generated outcome");
      const rows = bankedRows(store, perAct);
      /* A Q-01 row as a build before GV-109 banked it. */
      Object.assign(rows.tapeRelevance[0]!, { tier: 2, boundary: "sentence", extendedBySec: 12 });
      for (const row of rows.tapeRelevance) {
        delete row.startBoundary;
        delete row.endBoundary;
      }
      for (const segment of rows.newSegments) {
        delete segment.startBoundary;
        delete segment.endBoundary;
      }

      const savesBefore = sourceSaves(store);
      const second = countingDeps();
      const resumed = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...second.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (resumed.outcome !== "generated") throw new Error("expected a generated outcome");
      expect(sourceSaves(store)).toBe(savesBefore);
      expect(second.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
      expect(resumed.input.items).toEqual(fresh.input.items);
      expect(resumed.tapeRelevance[0]!.startBoundary).toBeUndefined();
      /* Measured from `boundary` alone: one known clip, clean. */
      expect(resumed.input.meta!.veracity!.cleanCutRate).toBe(1);
    }
  }, 240_000);
});

/**
 * GV-111 (W5-14b; R2-05, MQ-06; orchestrator note, the GV-108/GV-109
 * pattern): FORAY_PAUSE_SNAP=on changes the cuts and anchors `source`
 * (classic) and `source:<i>` (per act) bank, so it joins the variant at the
 * pipeline's own fingerprint site (the driver's is generateForays.ts, from
 * the same gate config), and the one sourcing-options builder hands it to
 * sourcing on both paths. Off adds nothing anywhere.
 */
describe("GV-111: FORAY_PAUSE_SNAP reaches sourcing and the fingerprint on both paths, and off is today's", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const ON = { pauseSnap: "on" as const };
  const fingerprintFor = (flags: Partial<PipelineFlags>, extra: { pauseSnap?: "on" } = {}): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant({ ...resolvePipelineFlags(flags), ...extra }, resolveRouting()), readSelfCritique())
    });

  /* MUTATION THAT KILLS THIS: drop `pauseSnap: gates.pauseSnap` from
     runPipeline.ts's checkpointRunVariant call (the on run's session
     fingerprint is the off one, so it never matches its own on-keyed store
     and every stage is paid for again). Ran it: red. */
  it("an on run resumes only a checkpoint banked under pauseSnap=on, and an off run does not resume it", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const onFingerprint = fingerprintFor(flags, ON);
      expect(onFingerprint).not.toBe(fingerprintFor(flags));
      const store = new FakeCheckpointStore(onFingerprint);
      const first = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: ON }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(first.outcome).toBe("generated");
      const again = countingDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: ON }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
      const off = countingDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...off.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(off.calls.spine).toBe(1);
    }
  }, 240_000);

  /* The default run keeps today's fingerprint: an off run resumes a store
     keyed with the fingerprint computed with no pause-snap part at all.
     MUTATION THAT KILLS THIS: join `pauseSnap=off` under off in
     pauseSnapVariant. Ran it: red. */
  it("an off run resumes a checkpoint keyed with today's fingerprint, on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const store = new FakeCheckpointStore(fingerprintFor(flags));
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: { pauseSnap: "off" } }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      const again = countingDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
    }
  }, 240_000);

  /* MUTATION THAT KILLS THIS: drop the `pauseSnap` spread from
     runPipeline.ts's `sourceOptionsOf` (every session sources with the
     default `off` under FORAY_PAUSE_SNAP=on). Ran it: red. */
  it("the sourcing options carry `on` to every act's session under on, and `off` by default, on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      for (const [gates, want] of [
        [ON, "on"],
        [{}, "off"]
      ] as const) {
        const seen: string[] = [];
        const real = SourcingSession.prototype.sourceAct;
        vi.spyOn(SourcingSession.prototype, "sourceAct").mockImplementation(function (this: SourcingSession, ...args: Parameters<SourcingSession["sourceAct"]>) {
          seen.push((this as unknown as { state: { pauseSnap: string } }).state.pauseSnap);
          return real.apply(this, args);
        });
        try {
          const outcome = await runForayPipeline(request, { userId: "u", now: at, flags, gates }, { ...countingDeps().deps, finalize: fakeFinalize().fn });
          expect(outcome.outcome).toBe("generated");
        } finally {
          vi.restoreAllMocks();
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set([want]));
      }
    }
  }, 240_000);
});

/**
 * GV-113 (W5-11; R2-10; orchestrator note, the GV-108..GV-111 pattern):
 * FORAY_UNSUPPORTED_SENTENCE_POLICY=cut changes what `narrate` / `narrate:<i>`
 * bank (seams trimmed of their unsupported sentences), so it joins the
 * variant at the pipeline's own fingerprint site (the driver's is
 * generateForays.ts, from the same gate config), and the act writer's options
 * carry it on both paths (they share narrateOneAct). The verifier is the stub
 * with W5-09's sentence contract: every seam's last statement, when it has
 * two or more, is refused. `rewrite` adds nothing anywhere.
 */
describe("GV-113: FORAY_UNSUPPORTED_SENTENCE_POLICY reaches the writer and the fingerprint on both paths, and rewrite is today's", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const CUT = { sentencePolicy: "cut" as const };
  const fingerprintFor = (flags: Partial<PipelineFlags>, extra: { sentencePolicy?: "cut" } = {}): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant({ ...resolvePipelineFlags(flags), ...extra }, resolveRouting()), readSelfCritique())
    });

  function sentenceDeps() {
    const counted = countingDeps();
    const verifier = counted.deps.narrationVerifier;
    const realVerify = verifier.verifyAct.bind(verifier);
    verifier.verifyAct = async (...args: Parameters<typeof realVerify>) => {
      const [verifyRequest] = args;
      const verdict = await realVerify(...args);
      return {
        ...verdict,
        seams: verdict.seams.map((seam) => {
          const brief = verifyRequest.seams.find((s) => s.seamId === seam.seamId)!;
          const texts = splitSpokenSentences(brief.script);
          const statements = texts.map((text, index) => ({ text, index })).filter(({ text }) => isStatementSentence(text));
          const refused = statements.length >= 2 ? statements[statements.length - 1]!.index : -1;
          const sentences: SentenceVerdict[] = texts.map((text, index) =>
            !isStatementSentence(text)
              ? { index, text, kind: "imperative", verdict: "exempt" }
              : index === refused
                ? { index, text, kind: "statement", verdict: "unsupported" }
                : { index, text, kind: "statement", verdict: "supported", restsOn: [...seam.restsOn] }
          );
          return refused >= 0 ? { ...seam, sentences, claimsSupported: false, notes: `Unsupported: "${texts[refused]}"` } : { ...seam, sentences };
        })
      };
    };
    return counted;
  }

  const bankedPages = (store: FakeCheckpointStore): NarratedBeat[] =>
    Object.entries(store.files.get(KEY)!.stages)
      .filter(([k]) => k.startsWith("narrate"))
      .flatMap(([, v]) => (Array.isArray(v) ? (v as WrittenAct[]) : [v as WrittenAct]))
      .flatMap((act) => act.slots.flatMap((slot) => slot.beats))
      .map((b) => (b.sourcing === "tape" ? b.connectiveNarration : b.narration))
      .filter((p): p is NarratedBeat => p !== undefined);

  /* MUTATIONS THAT KILL THIS: drop the `sentencePolicy` spread from
     runPipeline.ts's narrateOneAct writer options (no page is trimmed, and
     the act is re-asked); drop `sentencePolicy: gates.sentencePolicy` from
     runPipeline.ts's checkpointRunVariant call (the cut run's session
     fingerprint is the rewrite one, so it never matches its own cut-keyed
     store and every stage is paid for again). Ran both: red. */
  it("a cut run banks trimmed pages, reports the cut, and resumes only its own checkpoint, on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const cutFingerprint = fingerprintFor(flags, CUT);
      expect(cutFingerprint).not.toBe(fingerprintFor(flags));
      const store = new FakeCheckpointStore(cutFingerprint);
      const first = sentenceDeps();
      const fresh = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: CUT }, { ...first.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (fresh.outcome !== "generated") throw new Error("expected a generated outcome");
      const trimmed = bankedPages(store).filter((p) => (p.cutSentences?.length ?? 0) > 0);
      expect(trimmed.length).toBeGreaterThan(0);
      expect(fresh.input.meta!.veracity!.sentencesCut).toBe(bankedPages(store).reduce((n, p) => n + (p.cutSentences?.length ?? 0), 0));
      expect(fresh.input.meta!.veracity!.sentencesSurvivingRate).toBeLessThan(1);

      const again = sentenceDeps();
      const resumed = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: CUT }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (resumed.outcome !== "generated") throw new Error("expected a generated outcome");
      expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
      expect(resumed.input.items).toEqual(fresh.input.items);
      const rewrite = sentenceDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...rewrite.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(rewrite.calls.spine).toBe(1);
    }
  }, 240_000);

  /* The default run keeps today's fingerprint and today's narration: a
     rewrite run resumes a store keyed with no sentence-policy part, banks no
     trimmed page and reports no sentence fields.
     MUTATION THAT KILLS THIS: join `sentencePolicy=rewrite` under rewrite in
     sentencePolicyVariant; or thread the policy to the writer whatever its
     value (drop the `=== "cut"` test in narrateOneAct). Ran both: red. */
  it("a rewrite run resumes a checkpoint keyed with today's fingerprint and cuts nothing, on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      const store = new FakeCheckpointStore(fingerprintFor(flags));
      const out = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, gates: { sentencePolicy: "rewrite" } }, { ...sentenceDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
      if (out.outcome !== "generated") throw new Error("expected a generated outcome");
      expect(bankedPages(store).some((p) => p.cutSentences !== undefined)).toBe(false);
      expect("sentencesCut" in out.input.meta!.veracity!).toBe(false);
      expect("sentencesSurvivingRate" in out.input.meta!.veracity!).toBe(false);
      const again = sentenceDeps();
      await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
      expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
    }
  }, 240_000);
});

/**
 * GV-112 (W3-25; orchestrator note): FORAY_RESEARCH_SHORTLIST=1 with a
 * retrieval server changes what `research-shape` banks (up to two shortlist
 * windows per subtopic), so it joins the checkpoint variant through
 * `flagParts` at the pipeline's own fingerprint site; the driver's site
 * (generateForays.ts) passes the retrieval mode and reads the flag from the
 * same environment (`researchShortlistVariant`). The one research-shape stage
 * serves the classic and the per-act paths, so both are driven here. Off,
 * the shortlist is never asked and the fingerprint is today's.
 *
 * The retrieval server is a fake RetrievalPreparer: it answers no search (so
 * the text index below reports every search as a miss, and the subject probe
 * refuses nothing) and serves a shortlist of synthetic passages under a real
 * catalogue show the pinned topic's lineage admits.
 */
describe("GV-112: FORAY_RESEARCH_SHORTLIST reaches research-shape and the fingerprint on both paths, and off is today's", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const ENV = "FORAY_RESEARCH_SHORTLIST";
  /* Pinned, so the fake shortlist can serve rows the lineage admits: the
     grilling prompt's own node has no transcript row in the committed digest.
     `practical-ai` is a real catalogue show filed under this node. */
  const TOPIC = "engineering/ai-robotics";
  const fingerprintFor = (flags: Partial<PipelineFlags>, extra: { retrievalMode?: "bm25"; researchShortlist?: boolean } = {}): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      topic: TOPIC,
      variant: joinCheckpointVariant(checkpointRunVariant({ ...resolvePipelineFlags(flags), ...extra }, resolveRouting()), readSelfCritique())
    });

  const emptyStats = (): RetrievalStats => ({
    prepared: 0,
    hits: 0,
    misses: 0,
    degraded: 0,
    hydrated: 0,
    hydrationMisses: 0,
    hydrationAbsent: 0,
    unmapped: 0,
    unprepared: 0,
    evictions: 0,
    evictedPinned: 0,
    heldBytes: 0,
    pinned: 0,
    scopeMismatches: 0,
    reasons: []
  });

  function fakeRetrieval() {
    const asked: Array<{ node: string; queryText: string; limit: number }> = [];
    const retrieval: RetrievalPreparer = {
      mode: "bm25",
      prepareScope: async () => true,
      prepare: async () => 0,
      answerFor: () => undefined,
      hydrate: async () => 0,
      stats: emptyStats,
      shortlist: async (node, queryText, limit) => {
        asked.push({ node, queryText, limit });
        const admitted = [1, 2, 3]
          .map(
            (n): TranscriptDigestEntry => ({
              show_id: "practical-ai",
              show_title: "Practical AI",
              guid: `gv112-${n}`,
              title: `Shortlisted ${n}`,
              cues: 10,
              feed_duration_sec: 3600
            })
          )
          .filter((e) => familyGateAllows(node, nodesForArchiveEntry(e)));
        return admitted.map((entry, n) => ({
          entry,
          passageId: `p-${n}`,
          startSec: 200,
          endSec: 320,
          text: `This is shortlisted passage ${n}, spoken about the subject at hand.`,
          rank: n,
          score: 0.5,
          rerankScore: null
        }));
      }
    };
    /* Enabled, but it answers nothing it was asked: every search is a miss. */
    const textIndex: TranscriptTextIndex & { answers(): boolean } = { enabled: true, search: () => [], answers: () => false };
    return { retrieval, textIndex, asked };
  }

  const shortlistWindows = (store: FakeCheckpointStore): ResearchTapeWindow[] => {
    const shape = store.files.get(KEY)?.stages["research-shape"] as ResearchShape | undefined;
    return (shape?.subtopics ?? []).flatMap((s) => s.tapeWindows).filter((w) => w.origin === "shortlist");
  };

  const withEnv = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prior = process.env[ENV];
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env[ENV];
      else process.env[ENV] = prior;
    }
  };

  /* MUTATIONS THAT KILL THIS: (1) drop `researchShortlistVariant(flags)`
     from checkpoint.ts's flagParts (the on run's fingerprint is the off one,
     so it resumes stages banked without the shortlist); (2) drop the
     `shortlist` spread from runPipeline.ts's research-shape call (no window
     is banked). Ran each: red. */
  it("an on run banks shortlist windows in research-shape, resumes only a checkpoint banked under research=shortlist, and an off run does not resume it", async () => {
    await withEnv("1", async () => {
      for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
        const onFingerprint = fingerprintFor(flags, { retrievalMode: "bm25" });
        /* The driver's flags (mode only, the flag read from the environment)
           and the pipeline's (explicit) hash the same. */
        expect(onFingerprint).toBe(fingerprintFor(flags, { retrievalMode: "bm25", researchShortlist: true }));
        expect(onFingerprint).not.toBe(fingerprintFor(flags));
        const store = new FakeCheckpointStore(onFingerprint);
        const remote = fakeRetrieval();
        await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, topic: TOPIC }, {
          ...countingDeps().deps,
          finalize: fakeFinalize().fn,
          checkpoint: store,
          retrieval: remote.retrieval,
          textIndex: remote.textIndex
        });
        expect(remote.asked.length).toBeGreaterThan(0);
        const banked = shortlistWindows(store);
        expect(banked.length).toBeGreaterThan(0);
        expect(banked.every((w) => w.text.startsWith("This is shortlisted passage"))).toBe(true);

        const again = countingDeps();
        const resumedRemote = fakeRetrieval();
        await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, topic: TOPIC }, {
          ...again.deps,
          finalize: fakeFinalize().fn,
          checkpoint: store,
          retrieval: resumedRemote.retrieval,
          textIndex: resumedRemote.textIndex
        });
        expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
        expect(resumedRemote.asked).toEqual([]);

        /* Off (the same server, the flag unset): another fingerprint, so
           nothing banked under on is resumed. */
        await withEnv(undefined, async () => {
          const off = countingDeps();
          const offRemote = fakeRetrieval();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, topic: TOPIC }, {
            ...off.deps,
            finalize: fakeFinalize().fn,
            checkpoint: store,
            retrieval: offRemote.retrieval,
            textIndex: offRemote.textIndex
          });
          expect(off.calls.spine).toBe(1);
          expect(offRemote.asked).toEqual([]);
        });
      }
    });
  }, 240_000);

  /* The default keeps today's fingerprint: with a bm25 server and the flag
     unset (or 0), a run resumes a store keyed with the fingerprint computed
     with no retrieval part at all, the shortlist is never asked, and no
     window carries an origin. MUTATION THAT KILLS THIS: join the shortlist
     part whenever there is a server (`flags.retrievalMode !== undefined` alone
     in researchShortlistVariant). Ran it: red. */
  it("off, with a retrieval server, resumes a checkpoint keyed with today's fingerprint and never asks the shortlist, on both paths", async () => {
    for (const value of [undefined, "0"]) {
      await withEnv(value, async () => {
        for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
          expect(fingerprintFor(flags, { retrievalMode: "bm25" })).toBe(fingerprintFor(flags));
          const store = new FakeCheckpointStore(fingerprintFor(flags));
          const remote = fakeRetrieval();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, topic: TOPIC }, {
            ...countingDeps().deps,
            finalize: fakeFinalize().fn,
            checkpoint: store,
            retrieval: remote.retrieval,
            textIndex: remote.textIndex
          });
          expect(remote.asked).toEqual([]);
          expect(shortlistWindows(store)).toEqual([]);
          expect(JSON.stringify(store.files.get(KEY)?.stages["research-shape"])).not.toContain("origin");
          const again = countingDeps();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags, topic: TOPIC }, {
            ...again.deps,
            finalize: fakeFinalize().fn,
            checkpoint: store,
            retrieval: remote.retrieval,
            textIndex: remote.textIndex
          });
          expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
        }
      });
    }
  }, 240_000);
});

/**
 * GV-115 (W3-14; R2-16; orchestrator note, the GV-112 pattern):
 * FORAY_SHOW_SHARE is a generationFlags flag, so it joins the variant through
 * `flagParts`: the pipeline passes what it resolved, and the driver's store
 * (generateForays.ts, which passes nothing) reads it from the same environment
 * (`showShareVariant`). Either mode changes what `source` / `source:<i>` bank.
 * Off (the default) adds nothing and the fingerprint is today's.
 */
describe("GV-115: FORAY_SHOW_SHARE reaches sourcing and the fingerprint on both paths, and off is today's", () => {
  const at = () => new Date("2026-09-09T00:00:00Z");
  const ENV = "FORAY_SHOW_SHARE";
  /* The driver's view: the flag is read from the environment. */
  const fingerprintFor = (flags: Partial<PipelineFlags>): string =>
    checkpointFingerprint({
      prompt: request.prompt,
      duration: request.duration,
      variant: joinCheckpointVariant(checkpointRunVariant(resolvePipelineFlags(flags), resolveRouting()), readSelfCritique())
    });

  const withEnv = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prior = process.env[ENV];
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env[ENV];
      else process.env[ENV] = prior;
    }
  };

  /* MUTATIONS THAT KILL THIS, each ran red: (1) pass `showShare: null` in
     runPipeline.ts's checkpointRunVariant call (the on run's session hashes
     the off fingerprint, never matches its own on-keyed store, and every
     stage is paid for again); (2) drop showShareVariant from checkpoint.ts's
     flagParts (the on and off fingerprints are equal, so the off run resumes
     the on run's tape). */
  it("an on run resumes only a checkpoint keyed with the driver's on fingerprint, and an off run does not resume it", async () => {
    for (const mode of ["order", "gate"]) {
      for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
        let onFingerprint = "";
        let store = new FakeCheckpointStore("unset");
        await withEnv(mode, async () => {
          onFingerprint = fingerprintFor(flags);
          store = new FakeCheckpointStore(onFingerprint);
          const first = await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
          expect(first.outcome).toBe("generated");
          const again = countingDeps();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
          expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
        });
        await withEnv(undefined, async () => {
          expect(fingerprintFor(flags)).not.toBe(onFingerprint);
          const off = countingDeps();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...off.deps, finalize: fakeFinalize().fn, checkpoint: store });
          expect(off.calls.spine).toBe(1);
        });
      }
    }
  }, 240_000);

  /* The default keeps today's fingerprint: with the flag unset or `off`, a
     run resumes a store keyed with the fingerprint computed with no
     show-share part (the classic FP when nothing else is on). MUTATION THAT
     KILLS THIS: join `showShare=off:0.6` when off in showShareVariant. Ran
     it: red. */
  it("off resumes a checkpoint keyed with today's fingerprint, on both paths", async () => {
    for (const value of [undefined, "off"]) {
      await withEnv(value, async () => {
        expect(fingerprintFor({})).toBe(FP);
        for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
          const store = new FakeCheckpointStore(fingerprintFor(flags));
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
          const again = countingDeps();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
          expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
        }
      });
    }
  }, 240_000);

  /* MUTATION THAT KILLS THIS: drop the `showShare` spread from
     runPipeline.ts's `sourceOptionsOf` (every session sources with no rule
     under FORAY_SHOW_SHARE=gate). Ran it: red. */
  it("every act's sourcing session carries the rule under on, and none by default, on both paths", async () => {
    for (const flags of [{}, { perActPipeline: true }] as Array<Partial<PipelineFlags>>) {
      for (const [value, want] of [
        ["gate", "gate"],
        [undefined, "none"]
      ] as const) {
        const seen: string[] = [];
        const real = SourcingSession.prototype.sourceAct;
        vi.spyOn(SourcingSession.prototype, "sourceAct").mockImplementation(function (this: SourcingSession, ...args: Parameters<SourcingSession["sourceAct"]>) {
          const state = (this as unknown as { state: { showShare?: { mode: string }; placedSecByShow?: unknown } }).state;
          seen.push(state.showShare ? `${state.showShare.mode}${state.placedSecByShow ? "" : " (no ledger)"}` : "none");
          return real.apply(this, args);
        });
        try {
          await withEnv(value, async () => {
            const outcome = await runForayPipeline(request, { userId: "u", now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn });
            expect(outcome.outcome).toBe("generated");
          });
        } finally {
          vi.restoreAllMocks();
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set([want]));
      }
    }
  }, 240_000);

  /* The per-act path banks `source:<i>` through SourcingSnapshotSchema, a
     z.object that strips unknown keys: the ledger must be in it, or every
     resume silently falls back to rebuilding it from the placement log.
     MUTATION THAT KILLS THIS: drop `placedSecByShow` from runPipeline.ts's
     SourcingSnapshotSchema; the resumed snapshot then has no ledger. Ran
     it: red. */
  it("a per-act resume under on hands the session the banked per-show ledger, and off banks none", async () => {
    const flags: Partial<PipelineFlags> = { perActPipeline: true };
    for (const value of ["gate", undefined]) {
      await withEnv(value, async () => {
        const store = new FakeCheckpointStore(fingerprintFor(flags));
        await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...countingDeps().deps, finalize: fakeFinalize().fn, checkpoint: store });
        const sourceKeys = store.stageKeys(KEY).filter((k) => k.startsWith("source:"));
        expect(sourceKeys.length).toBeGreaterThan(0);
        const lastBanked = (store.load(KEY)!.stages[sourceKeys.at(-1)!] as { snapshot: Record<string, unknown> }).snapshot;
        const resumedWith: Array<Record<string, unknown>> = [];
        const real = SourcingSession.resume;
        vi.spyOn(SourcingSession, "resume").mockImplementation((...args: Parameters<typeof SourcingSession.resume>) => {
          resumedWith.push(args[1] as unknown as Record<string, unknown>);
          return real.apply(SourcingSession, args);
        });
        try {
          const again = countingDeps();
          await runForayPipeline(request, { userId: "u", checkpointKey: KEY, now: at, flags }, { ...again.deps, finalize: fakeFinalize().fn, checkpoint: store });
          expect(again.calls).toEqual({ understand: 0, spine: 0, deepen: 0, write: 0, smooth: 0 });
        } finally {
          vi.restoreAllMocks();
        }
        expect(resumedWith).toHaveLength(1);
        if (value === "gate") {
          expect(Array.isArray(lastBanked.placedSecByShow)).toBe(true);
          expect(resumedWith[0]!.placedSecByShow).toEqual(lastBanked.placedSecByShow);
        } else {
          expect(Object.keys(lastBanked)).not.toContain("placedSecByShow");
          expect(resumedWith[0]!.placedSecByShow).toBeUndefined();
        }
      });
    }
  }, 240_000);
});
