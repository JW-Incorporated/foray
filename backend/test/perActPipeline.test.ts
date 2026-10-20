import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runForayPipeline, type RunPipelineDeps, type RunPipelineOptions, type RunPipelineOutcome } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { DeepenActBuilder, DeepenActContext } from "../src/generation/DeepenActBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { PartialCandidate } from "../src/generation/partialCandidate";
import type { BuilderSpan } from "../src/generation/callLog";
import { RunLog, currentCallContext, runWithRunLog, type CallContext, type StageSpan } from "../src/generation/runLog";
import { checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { resolvePipelineFlags, type PipelineFlags } from "../src/generation/pipelineFlags";
import { resolveRouting } from "../src/config/stageRouting";
import { joinCheckpointVariant, readSelfCritique } from "../src/generation/selfCritique";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { RetrievalService } from "../src/cli/retrievalServer";
import type { CueStore } from "../src/generation/manifestBodySource";
import { HydratingCueProvider, PrecomputedTextIndex, RemoteRetrieval, type RetrievalFetch, type RetrievalFetchInit } from "../src/generation/retrievalClient";
import { RETRIEVAL_URL_ENV } from "../src/generation/generationFlags";
import { createEvidenceGatherer, type EvidenceBeat, type EvidenceGatherer } from "../src/generation/gatherEvidence";
import type { ExternalResearchContext } from "../src/generation/ExternalResearcher";
import { loadCatalogueData } from "../src/generation/catalogueLookup";
import { deriveItemId, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import type { SourcingSnapshot } from "../src/generation/sourceBeats";
import type { Act, Beat, DeepenedAct, Spine } from "../src/types/spine";
import type { GenerationRequest } from "../src/types/generation";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { recordingDeps } from "./helpers/recordingDeps";

/**
 * GV-102 (docs/roadmap/generation-v2.md, from W4-07; R1-04, R1-01, GP-03):
 * the per-act pipeline driver (FORAY_PER_ACT_PIPELINE, or the FORAY_FAST_PATH
 * umbrella). Act 1's deepen, source, evidence, write and stitch run first and
 * later acts behind it; only timing differs from the classic path.
 *
 *   - ordering on the GV-123 fake clock (recordingDeps): narrate:0 starts
 *     before source:1 ends and before act 3's deepen ends, and act 0 is ready
 *     before narrate:1 ends; the classic path, for contrast, deepens every act
 *     first;
 *   - equivalence: the candidate's items, segments and veracity (clocks
 *     aside) deep-equal the flag-off run on the same stubs;
 *   - FORAY_EVIDENCE_PREFETCH=first-act is subsumed: same candidate, and
 *     narrate:0 still starts before evidence:1 ends;
 *   - resume: a run killed after source:1 resumes from the banked snapshot,
 *     and a corpus that would now source differently does not move acts 0-1;
 *   - the no-tape stop waits for the last act on a multi-act Foray and is
 *     the classic stop on a one-act one;
 *   - remote retrieval (GV-95): with the fake server, no search misses and no
 *     body is read unhydrated, and the candidate equals the classic remote
 *     run's.
 *
 * Offline: stub builders, an injected finalize, an in-process retrieval
 * server; no model, no network.
 */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "medium", author_id: "founder-1", visibility: "catalogue" };
const baseOptions: RunPipelineOptions = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
const PER_ACT: Partial<PipelineFlags> = { perActPipeline: true };

/** Scripted latency per builder stage, ms (criticalPath.test.ts's table). */
const LATENCIES = { understand: 1000, research: 2000, evidence: 500, spine: 5000, deepen: 3000, narration: 6000, verify: 2000, continuity: 1000 };

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubDeps(): RunPipelineDeps {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder()
  };
}

function capturingFinalize() {
  const seen: FinalizeForayInput[] = [];
  const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
    seen.push(input);
    return {
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    } as unknown as FinalizeForayResult;
  };
  return { fn, seen };
}

/** The veracity row without what a clock decides. */
function withoutClocks(veracity: unknown): Record<string, unknown> {
  const v = JSON.parse(JSON.stringify(veracity)) as Record<string, unknown>;
  delete v.stageTimings;
  const retrieval = v.retrieval as Record<string, unknown> | undefined;
  if (retrieval) {
    delete retrieval.prefetchMs;
    delete retrieval.narrationRetrievalMs;
  }
  return v;
}

const timingNames = (outcome: RunPipelineOutcome): string[] => outcome.timings.map((t) => t.name);

/* ---------------------------------------------------------------------------
   Ordering and equivalence on the fake clock
   --------------------------------------------------------------------------- */

interface TimedRun {
  outcome: RunPipelineOutcome;
  input: FinalizeForayInput;
  spans: BuilderSpan[];
  stages: StageSpan[];
  /** Virtual time each act's onActReady fired. */
  readyAt: number[];
  /** The call context each deepen and evidence call was made under. */
  contexts: Array<{ method: "deepenAct" | "retrievePassages"; act?: number; ctx: CallContext }>;
}

/** One medium run on the GV-123 fake clock: builder spans, and the RunLog's
 * stage spans on the same virtual clock. */
async function timedRun(flags: Partial<PipelineFlags> | undefined): Promise<TimedRun> {
  vi.stubEnv("EVIDENCE_PREFETCH_CONCURRENCY", "");
  const contexts: TimedRun["contexts"] = [];
  const deps = stubDeps();
  const deepen = deps.deepenBuilder as StubDeepenActBuilder;
  const realDeepen = deepen.deepenAct.bind(deepen);
  deepen.deepenAct = (spine, act, index, ctx) => {
    contexts.push({ method: "deepenAct", act: index, ctx: { ...currentCallContext() } });
    return realDeepen(spine, act, index, ctx);
  };
  const researcher = deps.researcher as StubExternalResearcher;
  const realRetrieve = researcher.retrievePassages.bind(researcher);
  researcher.retrievePassages = (req, ctx) => {
    contexts.push({ method: "retrievePassages", ctx: { ...currentCallContext() } });
    return realRetrieve(req, ctx);
  };
  const rec = recordingDeps(deps, LATENCIES);
  const finalize = capturingFinalize();
  const readyAt: number[] = [];
  const log = new RunLog({ now: rec.clock.now });
  const outcome = await runWithRunLog(log, () =>
    runForayPipeline(request, { ...baseOptions, ...(flags ? { flags } : {}) }, {
      ...rec.deps,
      finalize: finalize.fn,
      onActReady: (candidate: PartialCandidate) => {
        readyAt[candidate.acts.filter((a) => a.status === "ready").length - 1] = rec.clock.now();
      }
    })
  );
  return { outcome, input: finalize.seen.at(-1)!, spans: rec.spans, stages: log.stages(), readyAt, contexts };
}

const stageSpan = (run: TimedRun, name: string): StageSpan => {
  const span = run.stages.find((s) => s.name === name && s.status === "ok");
  if (!span) throw new Error(`no ok stage span ${name}: ${run.stages.map((s) => s.name).join(", ")}`);
  return span;
};
const builderSpan = (run: TimedRun, id: string): BuilderSpan => {
  const span = run.spans.find((s) => s.id === id);
  if (!span) throw new Error(`no builder span ${id}`);
  return span;
};

/* Each run is made once and shared by the cases that read it. */
const memo = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let held: Promise<T> | null = null;
  return () => (held ??= make());
};
const classicRun = memo(() => timedRun(undefined));
const perActRun = memo(() => timedRun(PER_ACT));

describe("GV-102: act 1 runs ahead of the later acts (fake clock)", () => {
  it("flag on, medium: narrate:0 starts before source:1 ends and before act 3's deepen ends; act 0 is ready before narrate:1 ends", async () => {
    /* MUTATIONS THAT KILL THIS: in perActRun, make source:<i> wait for every
       act's deepen (`await deepenSettled;` at the top of its chain): narrate:0
       then starts after act 3's deepen. Deepen every act at once
       (`createActGate(actCount)` for the deepen gate): act 1 is sourced
       before act 0 is written, and act 0 is no longer first in line. Ran
       both: red. */
    const run = await perActRun();
    expect(run.outcome.outcome).toBe("generated");
    expect(run.input.items.length).toBeGreaterThan(0);
    const narrate0 = stageSpan(run, "narrate:0");
    expect(narrate0.startMs).toBeLessThan(stageSpan(run, "source:1").endMs);
    const deepen3 = builderSpan(run, "deepenAct@a3#1");
    /* The RunLog clock starts with the virtual clock at 0. */
    expect(narrate0.startMs).toBeLessThan(deepen3.endMs);
    expect(run.readyAt[0]).toBeDefined();
    expect(run.readyAt[0]!).toBeLessThan(stageSpan(run, "narrate:1").endMs);

    /* The per-act stages ran, one per act, and the whole-Foray ones did not. */
    const names = timingNames(run.outcome);
    for (let i = 0; i < 4; i++) {
      expect(names).toContain(`source:${i}`);
      expect(names).toContain(`evidence:${i}`);
    }
    expect(names).not.toContain("source");
    expect(names).not.toContain("evidence");
    /* Deepen keeps act 0 first: its call starts no later than any other. */
    const deepenStarts = [0, 1, 2, 3].map((a) => builderSpan(run, `deepenAct@a${a}#1`).startMs);
    expect(deepenStarts[0]).toBe(Math.min(...deepenStarts));
    expect(deepenStarts[1]!).toBeGreaterThanOrEqual(builderSpan(run, "deepenAct@a0#1").endMs);
  }, 300_000);

  it("act 0's deepen and evidence calls are marked critical for the lane scheduler; later acts' are not, and the classic path marks none", async () => {
    /* MUTATION THAT KILLS THIS: drop `actZeroPriority(i)` from evidence:<i>
       (act 0's pages go unmarked). Ran it: red. */
    const run = await perActRun();
    const deepenCtx = (act: number) => run.contexts.filter((c) => c.method === "deepenAct" && c.act === act).map((c) => c.ctx);
    expect(deepenCtx(0).length).toBeGreaterThan(0);
    for (const ctx of deepenCtx(0)) expect(ctx).toMatchObject({ act: 0, priority: "critical" });
    for (const act of [1, 2, 3]) {
      expect(deepenCtx(act).length).toBeGreaterThan(0);
      for (const ctx of deepenCtx(act)) {
        expect(ctx.act).toBe(act);
        expect(ctx.priority).toBeUndefined();
      }
    }
    const evidenceCtx = (stage: string) => run.contexts.filter((c) => c.method === "retrievePassages" && c.ctx.stage === stage).map((c) => c.ctx);
    expect(evidenceCtx("evidence:0").length).toBeGreaterThan(0);
    for (const ctx of evidenceCtx("evidence:0")) expect(ctx.priority).toBe("critical");
    expect(evidenceCtx("evidence:1").length).toBeGreaterThan(0);
    for (const ctx of evidenceCtx("evidence:1")) expect(ctx.priority).toBeUndefined();

    const classic = await classicRun();
    expect(classic.contexts.length).toBeGreaterThan(0);
    expect(classic.contexts.every((c) => c.ctx.priority === undefined)).toBe(true);
  }, 300_000);

  it("the classic path, for contrast, deepens every act before act 0 is written", async () => {
    const run = await classicRun();
    expect(run.outcome.outcome).toBe("generated");
    expect(stageSpan(run, "narrate:0").startMs).toBeGreaterThanOrEqual(builderSpan(run, "deepenAct@a3#1").endMs);
    expect(timingNames(run.outcome)).toContain("source");
    expect(timingNames(run.outcome)).not.toContain("source:0");
  }, 300_000);

  it("flag on: the finished candidate's items, segments and veracity deep-equal the flag-off run on the same stubs", async () => {
    /* MUTATION THAT KILLS THIS: return `super.metrics()` alone from
       PerActEvidenceGatherer.metrics (the report keeps only the last act's
       page counts). Ran it: red (veracity.retrieval.pages differs). */
    const [classic, perAct] = [await classicRun(), await perActRun()];
    expect(perAct.input.items).toEqual(classic.input.items);
    expect(perAct.input.slots).toEqual(classic.input.slots);
    expect(perAct.input.segments).toEqual(classic.input.segments);
    expect(perAct.input.segmentSources).toEqual(classic.input.segmentSources);
    expect(perAct.input.runtimeSec).toBe(classic.input.runtimeSec);
    expect(withoutClocks(perAct.input.meta?.veracity)).toEqual(withoutClocks(classic.input.meta?.veracity));
    if (perAct.outcome.outcome !== "generated" || classic.outcome.outcome !== "generated") throw new Error("expected both to generate");
    expect(perAct.outcome.tapeRelevance).toEqual(classic.outcome.tapeRelevance);
    expect(perAct.outcome.narration.concurrency).toBe(classic.outcome.narration.concurrency);
    /* Not vacuous: tape was sourced and evidence gathered. */
    expect(classic.outcome.tapeRelevance.length).toBeGreaterThan(0);
    expect((classic.input.meta?.veracity?.retrieval as { pages: number }).pages).toBeGreaterThan(0);
  }, 300_000);

  it("FORAY_EVIDENCE_PREFETCH=first-act is subsumed: the same candidate as the default prefetch, and narrate:0 starts before evidence:1 ends", async () => {
    /* MUTATION THAT KILLS THIS: let first-act turn the per-act path off
       (`if (flags.perActPipeline && evidencePrefetch !== "first-act")` at the
       branch): the run is GV-98's classic first-act run, with no evidence:1.
       Ran it: red. */
    const perAct = await perActRun();
    vi.stubEnv("FORAY_EVIDENCE_PREFETCH", "first-act");
    const firstAct = await timedRun(PER_ACT);
    expect(firstAct.outcome.outcome).toBe("generated");
    expect(stageSpan(firstAct, "narrate:0").startMs).toBeLessThan(stageSpan(firstAct, "evidence:1").endMs);
    expect(firstAct.input.items).toEqual(perAct.input.items);
    expect(firstAct.input.segments).toEqual(perAct.input.segments);
    expect(withoutClocks(firstAct.input.meta?.veracity)).toEqual(withoutClocks(perAct.input.meta?.veracity));
    /* No background fan-out ran: the report row has no GV-98 phase split. */
    expect(firstAct.input.meta?.veracity?.retrieval).not.toHaveProperty("backgroundPages");
  }, 300_000);
});

/* ---------------------------------------------------------------------------
   Resume from the banked snapshot, and the no-tape stop
   --------------------------------------------------------------------------- */

const KEY = "gv-102";
const fingerprintFor = (flags: Partial<PipelineFlags>): string =>
  checkpointFingerprint({
    prompt: request.prompt,
    duration: request.duration,
    topic: baseOptions.topic,
    variant: joinCheckpointVariant(checkpointRunVariant(resolvePipelineFlags(flags), resolveRouting()), readSelfCritique())
  });

/** A store that says when a stage is banked. */
class WatchedStore extends FakeCheckpointStore {
  private readonly waiters = new Map<string, Array<() => void>>();
  banked(stage: string): Promise<void> {
    if (this.stageKeys(KEY).includes(stage)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(stage, [...(this.waiters.get(stage) ?? []), resolve]));
  }
  override save(key: string, stage: string, data: unknown): void {
    super.save(key, stage, data);
    for (const resolve of this.waiters.get(stage) ?? []) resolve();
    this.waiters.delete(stage);
  }
}

/** Act 2's deepen fails, but only once act 1's sourcing is banked: the run
 * dies with acts 0-1 sourced. */
class DeepenKilledAfterSource1 implements DeepenActBuilder {
  readonly providerName = "killed";
  private readonly inner = new StubDeepenActBuilder();
  constructor(private readonly store: WatchedStore) {}
  async deepenAct(spine: Spine, act: Act, index: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    if (index === 2) {
      await this.store.banked("source:1");
      throw new Error("killed after source:1");
    }
    return this.inner.deepenAct(spine, act, index, ctx);
  }
}

async function plainRun(flags: Partial<PipelineFlags> | undefined, deps: RunPipelineDeps): Promise<{ outcome: RunPipelineOutcome; input: FinalizeForayInput | undefined }> {
  const finalize = capturingFinalize();
  const outcome = await runForayPipeline(request, { ...baseOptions, checkpointKey: KEY, ...(flags ? { flags } : {}) }, { ...stubDeps(), finalize: finalize.fn, ...deps });
  return { outcome, input: finalize.seen.at(-1) };
}

describe("GV-102: resume from the banked snapshot", () => {
  it("a per-act run killed after source:1 resumes from the banked snapshot; a corpus that would now source differently does not change acts 0-1", async () => {
    /* MUTATION THAT KILLS THIS: never resume a banked source:<i> (the
       resume loop's condition `k < 0`): the resumed run re-sources acts 0-1
       against the empty pool and they lose their tape. Ran it: red. */
    const store = new WatchedStore(fingerprintFor(PER_ACT));
    await expect(plainRun(PER_ACT, { checkpoint: store, deepenBuilder: new DeepenKilledAfterSource1(store) })).rejects.toThrow(/killed after source:1/);
    const keys = store.stageKeys(KEY);
    expect(keys).toEqual(expect.arrayContaining(["source:0", "source:1"]));
    expect(keys).not.toContain("source:2");
    const banked = store.files.get(KEY)!.stages["source:1"] as { snapshot: SourcingSnapshot };
    expect(banked.snapshot.acts).toHaveLength(2);
    const bankedRows = banked.snapshot.tapeRelevance;
    expect(bankedRows.length).toBeGreaterThan(0);

    /* The corpus changed: no pool, so tier 1 (the stub run's only tape) has
       nothing to offer. A fresh run on it sources no tape at all. */
    const fresh = await plainRun(PER_ACT, { segmentPool: [] });
    expect(fresh.outcome.outcome).toBe("no-tape");

    const savesBefore = store.saves.length;
    const resumed = await plainRun(PER_ACT, { checkpoint: store, segmentPool: [] });
    expect(resumed.outcome.outcome).toBe("generated");
    if (resumed.outcome.outcome !== "generated") return;
    /* Acts 0-1 are the banked ones, row for row; acts 2-3 were sourced now,
       against the empty pool. */
    const early = resumed.outcome.tapeRelevance.filter((r) => r.actIndex <= 1);
    expect(early).toEqual(bankedRows);
    expect(resumed.outcome.tapeRelevance.filter((r) => r.actIndex >= 2)).toEqual([]);
    const newSaves = store.saves.slice(savesBefore).map((s) => s.stage);
    expect(newSaves).not.toContain("source:0");
    expect(newSaves).not.toContain("source:1");
    expect(newSaves).toEqual(expect.arrayContaining(["source:2", "source:3"]));
    const resumedSource = resumed.outcome.timings.filter((t) => /^source:[01]$/.test(t.name));
    expect(resumedSource.map((t) => t.resumed)).toEqual([true, true]);
  }, 300_000);
});

describe("GV-102: the no-tape stop", () => {
  it("on a multi-act Foray it fires after the last act is sourced, with the classic outcome; an earlier act with no tape only logs", async () => {
    /* MUTATION THAT KILLS THIS: stop on an act with no tape before the last
       (`if (actTape === 0) throw new PerActNoTapeStop()` for i < last): the
       run below then stops at act 1, and source:3 never runs. Ran it: red. */
    const classic = await plainRun(undefined, { segmentPool: [] });
    const perAct = await plainRun(PER_ACT, { segmentPool: [] });
    expect(classic.outcome.outcome).toBe("no-tape");
    expect(perAct.outcome.outcome).toBe("no-tape");
    if (classic.outcome.outcome !== "no-tape" || perAct.outcome.outcome !== "no-tape") return;
    expect(perAct.outcome.sourcing).toEqual(classic.outcome.sourcing);
    expect(perAct.outcome.title).toBe(classic.outcome.title);
    const names = timingNames(perAct.outcome);
    for (let i = 0; i < 4; i++) expect(names).toContain(`source:${i}`);
    /* The last act's evidence and narration never start. */
    expect(names).not.toContain("evidence:3");
    expect(names).not.toContain("narrate:3");
    expect(perAct.input).toBeUndefined();
  }, 300_000);

  it("on a one-act Foray it is the classic stop: no evidence and no narration", async () => {
    const short: GenerationRequest = { ...request, duration: "short" };
    const finalize = capturingFinalize();
    const outcome = await runForayPipeline(short, { ...baseOptions, flags: PER_ACT }, { ...stubDeps(), finalize: finalize.fn, segmentPool: [] });
    expect(outcome.outcome).toBe("no-tape");
    const names = timingNames(outcome);
    expect(names).toContain("source:0");
    expect(names.some((n) => n.startsWith("evidence") || n.startsWith("narrate") || n.startsWith("stitch"))).toBe(false);
    expect(finalize.seen).toHaveLength(0);
  }, 300_000);
});

/* ---------------------------------------------------------------------------
   Remote retrieval (GV-95): the fake server, as runPipelineRemoteRetrieval
   builds it (a RemoteRetrieval whose fetch is routed into an in-process
   RetrievalService over a synthetic corpus held in memory).
   --------------------------------------------------------------------------- */

const TOPIC = "history/military-ancient";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv102-remote-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const remoteRequest: GenerationRequest = { prompt: "how the armies of the ancient world marched and fought", duration: "medium", author_id: "founder-1", visibility: "catalogue" };
const remoteOptions: RunPipelineOptions = { userId: "founder-1", now: () => new Date("2026-10-19T12:00:00.000Z"), topic: TOPIC };

const VOCAB = [
  "hannibal", "elephants", "carthage", "alpine", "phalanx", "hoplites", "sarissa", "macedon",
  "triremes", "salamis", "rowers", "bronze", "legions", "centurions", "gladius", "pilum",
  "testudo", "shields", "siege", "ramparts", "ballista", "torsion", "catapults", "sinew",
  "chariots", "kadesh", "hittites", "archers", "cavalry", "stirrups", "horsemen", "parthian",
  "aqueducts", "masonry", "arches", "concrete", "garrisons", "frontier", "hadrian", "limes",
  "javelins", "skirmishers", "slingers", "balearic", "spartans", "thermopylae", "pass", "persians",
  "longships", "oars", "raiders", "lindisfarne", "crossbows", "bolts", "qin", "terracotta",
  "trebuchets", "counterweight", "fortresses", "walls", "fire", "greek", "naphtha", "siphons",
  "camels", "caravans", "nabataeans", "petra", "forts", "palisades", "ditches", "earthworks",
  "standards", "eagles", "aquilifer", "cohorts", "marches", "roads", "milestones", "paving",
  "scouts", "signals", "beacons", "torches", "rations", "grain", "mules", "baggage",
  "surgeons", "wounds", "bandages", "vinegar"
];
const ACTS = 4;
const SLOTS = 6;
const wordsFor = (a: number, s: number): string[] => {
  const i = ((a * SLOTS + s) * 4) % VOCAB.length;
  return VOCAB.slice(i, i + 4);
};
const spokenClaim = (a: number, s: number): string => {
  const [w1, w2, w3, w4] = wordsFor(a, s);
  return `The ${w1} and ${w2} were recorded with ${w3} beside the ${w4} in the old accounts.`;
};
const unspokenClaim = (a: number, s: number): string => `A quartermaster number ${a}${s} was paid in salt for a long winter on the northern road.`;
const SHOWS = [
  { show_id: "hardcore-history", show_title: "Hardcore History" },
  { show_id: "fall-of-civilizations", show_title: "Fall of Civilizations" },
  { show_id: "titans-of-nuclear", show_title: "Titans of Nuclear" }
];
const FILLER = [
  "anyway let us take a short break for a word from the people who pay for this show",
  "and we are back so thanks again to everybody who wrote in last week with questions",
  "my cousin keeps bees on a rooftop in the city which is a whole other conversation",
  "the weather here has been strange all month with rain every single afternoon"
];

function claimCues(claim: string, startSec: number): TranscriptCue[] {
  const words = claim.replace(/[^A-Za-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const per = Math.ceil(words.length / 4);
  return Array.from({ length: 4 }, (_, i) => ({
    text: words.slice(i * per, (i + 1) * per).join(" ").toLowerCase() || "right",
    start_sec: startSec + i * 20,
    end_sec: startSec + (i + 1) * 20,
    speaker: null
  }));
}

/** Eight episodes over three shows; every (act, slot)'s spoken claim is dealt
 * round-robin between filler. Plus an episode under a pool row only. */
function buildCorpus(): { archive: TranscriptDigestEntry[]; cuesByGuid: Map<string, TranscriptCue[]>; firstSpoken: Map<string, { guid: string; startSec: number }> } {
  const EPISODES = 8;
  const cuesByGuid = new Map<string, TranscriptCue[]>();
  const archive: TranscriptDigestEntry[] = [];
  const firstSpoken = new Map<string, { guid: string; startSec: number }>();
  const perEpisode: Array<Array<{ a: number; s: number }>> = Array.from({ length: EPISODES }, () => []);
  let k = 0;
  for (let a = 0; a < ACTS; a++) for (let s = 0; s < SLOTS; s++) perEpisode[k++ % EPISODES]!.push({ a, s });
  for (let e = 0; e < EPISODES; e++) {
    const show = SHOWS[e % SHOWS.length]!;
    const guid = `gv102-ep-${e}`;
    const cues: TranscriptCue[] = [];
    let t = 0;
    const filler = (n: number) => {
      for (let i = 0; i < n; i++) {
        cues.push({ text: FILLER[(t / 20) % FILLER.length]!, start_sec: t, end_sec: t + 20, speaker: null });
        t += 20;
      }
    };
    if (e === 0) {
      cues.push({ text: "today the armies of the ancient world and how they marched and fought", start_sec: t, end_sec: t + 20, speaker: null });
      t += 20;
    }
    filler(3);
    for (const { a, s } of perEpisode[e]!) {
      for (const c of claimCues(spokenClaim(a, s), t)) cues.push(c);
      firstSpoken.set(`${a}:${s}`, { guid, startSec: t });
      t += 80;
      filler(8);
    }
    cuesByGuid.set(guid, cues);
    const first = perEpisode[e]![0]!;
    archive.push({
      show_id: show.show_id,
      show_title: show.show_title,
      guid,
      title: wordsFor(first.a, first.s).join(" "),
      cues: cues.length,
      feed_duration_sec: Math.max(3600, t + 60),
      enclosure_url: `https://cdn.example/${guid}.mp3`
    });
  }
  const poolOnly = "gv102-pool-only";
  const poolCues: TranscriptCue[] = Array.from({ length: 12 }, (_, i) => ({
    text: "amphorae of olive oil and wine filled the ostia harbour warehouses",
    start_sec: i * 20,
    end_sec: i * 20 + 20,
    speaker: null
  }));
  cuesByGuid.set(poolOnly, poolCues);
  archive.push({
    show_id: "fall-of-civilizations",
    show_title: "Fall of Civilizations",
    guid: poolOnly,
    title: "Ostia harbour warehouses",
    cues: poolCues.length,
    feed_duration_sec: 3600,
    enclosure_url: `https://cdn.example/${poolOnly}.mp3`
  });
  return { archive, cuesByGuid, firstSpoken };
}

const CORPUS = buildCorpus();
const ARCHIVE = CORPUS.archive;
const entryOf = (guid: string): TranscriptDigestEntry => ARCHIVE.find((e) => e.guid === guid)!;
/** A committed pool row over act 1 slot 0's spoken stretch, and one under the
 * pool-only episode, so tier 1 reads window text from hydrated bodies. */
const POOL_AT = CORPUS.firstSpoken.get("1:0")!;
const poolRow = (guid: string, startSec: number, endSec: number, anchors: [string, string], why: string): SegmentRecord =>
  ({
    id: `${deriveItemId(entryOf(guid))}#${startSec}`,
    item_id: deriveItemId(entryOf(guid)),
    topic: TOPIC,
    start_sec: startSec,
    end_sec: endSec,
    reference_duration_sec: 3600,
    start_anchor: anchors[0],
    end_anchor: anchors[1],
    why,
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  }) as SegmentRecord;
const POOL: SegmentRecord[] = [
  poolRow(POOL_AT.guid, POOL_AT.startSec, POOL_AT.startSec + 80, [wordsFor(1, 0).slice(0, 2).join(" "), "in the old accounts"], spokenClaim(1, 0)),
  poolRow("gv102-pool-only", 60, 160, ["amphorae of olive oil", "ostia harbour warehouses"], "Amphorae of olive oil and wine filled the Ostia harbour warehouses")
];
const SHOW_META = new Map(SHOWS.map((s) => [s.show_id, { dai: false, feedUrl: `https://feeds.example/${s.show_id}.xml`, appleCollectionId: null }]));

/** The stub's act with each slot's beats replaced by the corpus's spoken
 * claim of (act, slot) and a claim spoken nowhere. */
class ScriptedDeepen implements DeepenActBuilder {
  readonly providerName = "scripted";
  private readonly inner = new StubDeepenActBuilder();
  async deepenAct(spine: Spine, act: Act, index: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    const base = await this.inner.deepenAct(spine, act, index, ctx);
    return {
      ...base,
      slots: base.slots.map((slot, s) => {
        const spokenBeat: Beat = { claim: spokenClaim(index, s), exploration: false, kind: "account" };
        return { title: slot.title, beats: [spokenBeat, { claim: unspokenClaim(index, s), exploration: false, kind: "account" }] };
      })
    };
  }
}

const keyOf = (e: TranscriptDigestEntry): string => `${e.show_id}\u0000${e.guid}`;
function memoryStore(): CueStore & { bodyStat(entry: TranscriptDigestEntry): { mtimeMs: number; size: number } | null } {
  const byKey = new Map(ARCHIVE.map((e) => [keyOf(e), CORPUS.cuesByGuid.get(e.guid)!]));
  return {
    getCues: (entry) => byKey.get(keyOf(entry)) ?? null,
    readCuesUncached: (entry) => byKey.get(keyOf(entry)) ?? null,
    transcriptSource: (entry) => (byKey.has(keyOf(entry)) ? "asr-local" : null),
    bodyStat: (entry) => (byKey.has(keyOf(entry)) ? { mtimeMs: 1_760_000_000_000, size: 4096 } : null)
  };
}

let serviceCount = 0;
function service(): RetrievalService {
  serviceCount += 1;
  return new RetrievalService({
    loadArchive: () => ({ rows: ARCHIVE, generatedAt: "2026-10-18T00:00:00.000Z" }),
    loadManifest: () => null,
    createCueStore: memoryStore,
    indexRoot: path.join(tmp, `index-${serviceCount}`),
    logger: { info: () => undefined, error: () => undefined }
  });
}

/** The injected fetch: into the in-process server, never a network. */
function fakeFetch(svc: RetrievalService): RetrievalFetch {
  return async (url: string, init: RetrievalFetchInit) => {
    const u = new URL(url);
    const reply = (status: number, json: unknown) => {
      const text = JSON.stringify(json);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    };
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    try {
      if (u.pathname === "/healthz") return reply(200, svc.health());
      if (u.pathname === "/v1/episodes") return reply(200, svc.episodes());
      if (u.pathname === "/v1/scopes") return reply(200, svc.createScope(body.episodes));
      if (u.pathname === "/v1/search") return reply(200, { results: svc.search(body.scopeId, body.queries) });
      if (u.pathname === "/v1/cues") return reply(200, svc.cues(u.searchParams.get("show_id"), u.searchParams.get("guid")));
    } catch (error) {
      return reply((error as { status?: number }).status ?? 500, { error: String(error) });
    }
    return reply(404, { error: "not found" });
  };
}

async function remoteRun(
  flags: Partial<PipelineFlags> | undefined,
  store?: FakeCheckpointStore
): Promise<{ outcome: RunPipelineOutcome; input: FinalizeForayInput; retrieval: RemoteRetrieval; tapeDocs: number }> {
  vi.stubEnv(RETRIEVAL_URL_ENV, "http://127.0.0.1:7311");
  const retrieval = new RemoteRetrieval({ baseUrl: "http://127.0.0.1:7311", token: "t0ken", fetchFn: fakeFetch(service()), archive: ARCHIVE });
  await retrieval.loadManifest();
  const finalize = capturingFinalize();
  const cueProvider = new HydratingCueProvider(retrieval);
  /* The evidence gatherer over the synthetic archive, so a tape page reads
     its clip's body through the hydrating provider (as GV-95's test does). */
  const inner = createEvidenceGatherer({ researcher: new StubExternalResearcher(), cueProvider, transcriptArchive: ARCHIVE, catalogue: loadCatalogueData(), cacheDir: null });
  let tapeDocs = 0;
  const evidence: EvidenceGatherer = {
    gather: async (beat: EvidenceBeat, ctx: ExternalResearchContext) => {
      const pack = await inner.gather(beat, ctx);
      tapeDocs += pack.docs.filter((d) => d.kind === "tape").length;
      return pack;
    },
    tapeEvidenceMetrics: () => inner.tapeEvidenceMetrics!()
  };
  const outcome = await runForayPipeline(remoteRequest, { ...remoteOptions, ...(store ? { checkpointKey: KEY } : {}), ...(flags ? { flags } : {}) }, {
    ...stubDeps(),
    deepenBuilder: new ScriptedDeepen(),
    finalize: finalize.fn,
    transcriptArchive: ARCHIVE,
    segmentPool: POOL,
    audioSourceFor: (entry, itemId) => mintSegmentSource(entry, itemId, SHOW_META),
    cueProvider,
    evidence,
    textIndex: new PrecomputedTextIndex(retrieval),
    retrieval,
    ...(store ? { checkpoint: store } : {})
  });
  return { outcome, input: finalize.seen.at(-1)!, retrieval, tapeDocs };
}

describe("GV-102: remote retrieval (GV-95) under the per-act pipeline", () => {
  it("with FORAY_RETRIEVAL_URL set: no search misses, no body read unhydrated, and the candidate equals the classic remote run's", async () => {
    /* MUTATION THAT KILLS THIS: drop retrieval:source:<i>'s `prepare` (every
       sourcing search misses PrecomputedTextIndex). Ran it: red (16 misses). */
    const classic = await remoteRun(undefined);
    const perAct = await remoteRun(PER_ACT);
    expect(classic.outcome.outcome).toBe("generated");
    expect(perAct.outcome.outcome).toBe("generated");
    const stats = perAct.retrieval.stats();
    expect(stats.misses).toBe(0);
    expect(stats.hydrationMisses).toBe(0);
    expect(stats.degraded).toBe(0);
    expect(stats.hits).toBeGreaterThan(0);

    const names = timingNames(perAct.outcome);
    for (let i = 0; i < 4; i++) {
      expect(names).toContain(`retrieval:source:${i}`);
      expect(names).toContain(`retrieval:evidence:${i}`);
    }
    expect(names).not.toContain("retrieval:source");

    expect(perAct.input.items).toEqual(classic.input.items);
    expect(perAct.input.segments).toEqual(classic.input.segments);
    expect(perAct.input.segmentSources).toEqual(classic.input.segmentSources);
    const strip = (veracity: unknown) => {
      const v = withoutClocks(veracity);
      delete (v.retrieval as Record<string, unknown>).remote;
      return v;
    };
    expect(strip(perAct.input.meta?.veracity)).toEqual(strip(classic.input.meta?.veracity));
    if (perAct.outcome.outcome !== "generated" || classic.outcome.outcome !== "generated") return;
    expect(perAct.outcome.tapeRelevance).toEqual(classic.outcome.tapeRelevance);
    /* Not vacuous: both tiers placed tape, and the classic run missed nothing either. */
    expect(classic.outcome.tapeRelevance.some((r) => r.tier === 1)).toBe(true);
    expect(classic.outcome.tapeRelevance.some((r) => r.tier === 2)).toBe(true);
    expect(classic.retrieval.stats().misses).toBe(0);
    expect(perAct.tapeDocs).toBeGreaterThan(0);
    expect(perAct.tapeDocs).toBe(classic.tapeDocs);
  }, 300_000);

  it("a per-act run that resumed its sourcing fetches every clip's episode before evidence: no hydration miss, the same candidate", async () => {
    /* On a fresh run source:<i>'s fetch already holds every clip's body; on a
       resume nothing is sourced, so evidence:<i> must fetch them itself.
       MUTATION THAT KILLS THIS: drop retrieval:evidence:<i>'s hydrate (the
       resumed acts' clips are read unhydrated). Ran it: red. */
    const store = new FakeCheckpointStore(
      checkpointFingerprint({
        prompt: remoteRequest.prompt,
        duration: remoteRequest.duration,
        topic: TOPIC,
        variant: joinCheckpointVariant(checkpointRunVariant(resolvePipelineFlags(PER_ACT), resolveRouting()), readSelfCritique())
      })
    );
    const first = await remoteRun(PER_ACT, store);
    expect(first.outcome.outcome).toBe("generated");
    const banked = store.stageKeys(KEY);
    expect(banked).toEqual(expect.arrayContaining(["source:0", "source:3"]));
    /* Narration and stitching are dropped, so the resumed run gathers
       evidence again; deepen and sourcing stay banked. */
    store.drop(KEY, banked.filter((k) => k.startsWith("narrate:") || k.startsWith("stitch:")));

    const resumed = await remoteRun(PER_ACT, store);
    expect(resumed.outcome.outcome).toBe("generated");
    const names = timingNames(resumed.outcome);
    expect(names.some((n) => n.startsWith("retrieval:source"))).toBe(false);
    for (let i = 0; i < 4; i++) expect(names).toContain(`retrieval:evidence:${i}`);
    expect(resumed.retrieval.stats().hydrationMisses).toBe(0);
    expect(resumed.tapeDocs).toBeGreaterThan(0);
    expect(resumed.tapeDocs).toBe(first.tapeDocs);
    expect(resumed.input.items).toEqual(first.input.items);
  }, 300_000);
});
