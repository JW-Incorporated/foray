import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clipCeilingSec, sourceBeats, SourcingSession, type SourceBeatsOptions } from "../src/generation/sourceBeats";
import { seededBeatCount, tierClipBudgetSec, narrationEstimateSec } from "../src/generation/tierRuntime";
import { FileTranscriptCueProvider, TAPE_WINDOW_MAX_SEC, TAPE_WINDOW_MIN_SEC, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import { RELEVANCE_WINDOW_SEC } from "../src/generation/tapeExtent";
import { computeTierFit, evaluateVeracityGate } from "../src/generation/veracityMetrics";
import { publishGateOptions } from "../src/cli/publishForay";
import { runForayPipeline, type RunPipelineDeps, type RunPipelineOptions } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { PipelineFlags } from "../src/generation/pipelineFlags";
import { loadSegmentPool, type SegmentRecord } from "../src/generation/segmentPoolLookup";
import { allSourcedBeats, type SourceBeatsResult, type SourcingTrace } from "../src/types/tapeSourcing";
import { tierRuntimeBand, type Beat, type DeepenedAct } from "../src/types/spine";
import type { GenerationRequest } from "../src/types/generation";

/**
 * GV-106 (docs/roadmap/generation-v2.md, W4-15; R2-15, QK-28, GP-25): the
 * tier-aware clip ceiling (FORAY_TIER_RUNTIME_CAP) and the MQ-14 tier fit
 * (reported always, gated only under FORAY_GATE_TIER_FIT).
 *
 * THE CORPUS. Synthetic episodes on disk in a tmpdir, read through the REAL
 * `FileTranscriptCueProvider` and `FileTranscriptTextIndex`: `ep-long` speaks
 * one claim for 25 minutes straight (75 cues of 20 s, 60-1,560 s, filler on
 * either side), so its thought rides to 1,500 s uncapped; `ep-kelp` and
 * `ep-glacier` each speak another claim for two minutes. No topic, an empty
 * catalogue stand-in as `root`, no audio resolver: only the ledger and the
 * ceiling decide. Pool rows are metadata-only (their episodes have no body),
 * so tier 1 scores their `why` line.
 *
 * Offline; one named mutation per test.
 */

const SHOW = "tier-ceiling-show";
const FILLER = [
  "anyway let us take a short break for a word from the people who pay for this show",
  "and we are back so thanks again to everybody who wrote in last week with questions",
  "my cousin keeps bees on a rooftop in the city which is a whole other conversation",
  "the weather here has been strange all month with rain every single afternoon"
];
const CUE_SEC = 20;
const PAUSE_SEC = 1;

const LONG_CLAIM = "Tidal turbines in the Pentland Firth survived winter storms because engineers redesigned the blade pitch bearings.";
const KELP_CLAIM = "Kelp forests off Tasmania collapsed after marine heatwaves warmed the coastal currents.";
const GLACIER_CLAIM = "Glacier meltwater lakes in Bhutan are watched by radar gauges that warn villages downstream.";
const GEARBOX_WHY = "Wind turbine gearboxes fail early because bearings take torque reversals";
const GEARBOX_CLAIM = "Wind turbine gearboxes fail early because their bearings take torque reversals.";

function words(claim: string): string {
  return claim
    .replace(/[^A-Za-z0-9' ]+/g, " ")
    .toLowerCase()
    .trim();
}

/** `fillerBefore` cues of filler, `spoken` cues each speaking the whole claim,
 * then filler to `totalSec`. Every cue is one sentence followed by a one-second
 * pause, so every cue edge is a thought boundary `extendToThought` can snap
 * to (`THOUGHT_PAUSE_SEC`) and a clip ends where a sentence does. */
function episodeCues(claim: string, fillerBefore: number, spoken: number, totalSec: number): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let t = 0;
  const push = (text: string) => {
    cues.push({ text: `${text}.`, start_sec: t, end_sec: t + CUE_SEC - PAUSE_SEC });
    t += CUE_SEC;
  };
  for (let k = 0; k < fillerBefore; k++) push(FILLER[k % FILLER.length]!);
  for (let k = 0; k < spoken; k++) push(words(claim));
  for (let k = 0; t < totalSec; k++) push(FILLER[k % FILLER.length]!);
  return cues;
}

const EPISODES: Record<string, TranscriptCue[]> = {
  "ep-long": episodeCues(LONG_CLAIM, 3, 75, 3000),
  "ep-kelp": episodeCues(KELP_CLAIM, 6, 6, 1200),
  "ep-glacier": episodeCues(GLACIER_CLAIM, 6, 6, 1200)
};

const ARCHIVE: TranscriptDigestEntry[] = Object.entries(EPISODES).map(([guid, cues]) => ({
  show_id: SHOW,
  show_title: "Tier Ceiling Show",
  guid,
  title: `Episode ${guid}`,
  cues: cues.length,
  feed_duration_sec: cues[cues.length - 1]!.end_sec + 60,
  enclosure_url: `https://cdn.example/${guid}.mp3`
}));

function poolRow(item: string, startSec: number, durationSec: number, why = GEARBOX_WHY): SegmentRecord {
  return {
    id: `${item}#${startSec}`,
    item_id: item,
    topic: "engineering/energy",
    start_sec: startSec,
    end_sec: startSec + durationSec,
    reference_duration_sec: 3600,
    start_anchor: "so the gearbox is where it all starts",
    end_anchor: "and that is why the bearings went first",
    why,
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  };
}

const seed = (episodeId: string, startSec: number, endSec: number) => ({ episodeId, startSec, endSec });
/** The seed windows: the middle of each episode's spoken stretch. */
const LONG_SEED = seed("ep-long", 600, 680);
const KELP_SEED = seed("ep-kelp", 140, 200);
const GLACIER_SEED = seed("ep-glacier", 140, 200);
/** A seed into an episode the archive does not hold: still a seeded beat
 * sourcing will look for, so the ceiling reserves the floor for it. */
const LOST_SEED = seed("ep-not-here", 100, 160);

function act(beats: Beat[], label = "A"): DeepenedAct {
  return {
    title: `Act ${label}`,
    thesis: "Machines and landscapes under stress.",
    startState: "The listener has not heard of these.",
    endState: "The listener has.",
    slots: [{ title: `${label} slot`, beats }],
    introduction: `Intro for ${label}`,
    exit: `Exit for ${label}`
  };
}

let root = "";
let options: (pool?: SegmentRecord[]) => SourceBeatsOptions;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-tier-ceiling-"));
  const showDir = path.join(root, "normalized", SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [guid, cues] of Object.entries(EPISODES)) {
    fs.writeFileSync(path.join(showDir, `${guid}.json`), JSON.stringify({ show_id: SHOW, guid, cues }));
  }
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(path.join(repoRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "data", "catalog.json"), JSON.stringify({ shows: [] }));
  options = (pool = []) => {
    const cueProvider = new FileTranscriptCueProvider(path.join(root, "normalized"));
    return {
      segmentPool: pool,
      transcriptArchive: ARCHIVE,
      cueProvider,
      textIndex: new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: cueProvider, indexRoot: path.join(root, "index") }),
      topic: null,
      root: repoRoot
    };
  };
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const beats = (result: SourceBeatsResult) => allSourcedBeats(result.acts);
const clipSec = (result: SourceBeatsResult, index: number): number => {
  const beat = beats(result)[index]!;
  if (beat.sourcing !== "tape") throw new Error(`beat ${index} is narrated: ${JSON.stringify(result.sourcingTrace)}`);
  return beat.tape.endSec - beat.tape.startSec;
};
const traceFor = (result: SourceBeatsResult, claim: string): SourcingTrace => {
  const row = result.sourcingTrace.find((t) => t.claim === claim);
  if (!row) throw new Error(`no trace row for "${claim}"`);
  return row;
};
const onCueBoundaries = (episode: string, startSec: number, endSec: number): boolean =>
  EPISODES[episode]!.some((c) => c.start_sec === startSec) && EPISODES[episode]!.some((c) => c.end_sec === endSec);

describe("GV-106: clipCeilingSec", () => {
  it("is undefined with no budget, reserves the floor for every seeded beat ahead, is 0 under the floor, never above 30 min, and a merge gives its old length back", () => {
    /* MUTATIONS THAT KILL THIS: `left <= TAPE_WINDOW_MIN_SEC` (a ceiling of
       exactly 60 s reads 0), drop `Math.min(left, TAPE_WINDOW_MAX_SEC)`, or
       ignore `replacing`. Ran each: red. */
    const at = (runtimeBudgetSec: number | undefined, remainingSeededBeats: number | undefined, placedDurations: number[], replacing?: number) =>
      clipCeilingSec({ runtimeBudgetSec, remainingSeededBeats, placedDurations }, replacing);
    expect(at(undefined, undefined, [900, 900])).toBeUndefined();
    /* The acceptance's own arithmetic: 1,035 - 3 x 60 - 120 placed. */
    expect(at(1035, 3, [120])).toBe(1035 - 3 * TAPE_WINDOW_MIN_SEC - 120);
    expect(at(1035, 0, [975])).toBe(TAPE_WINDOW_MIN_SEC);
    expect(at(1035, 0, [976])).toBe(0);
    expect(at(1035, 1, [1000])).toBe(0);
    expect(at(10_000, 0, [])).toBe(TAPE_WINDOW_MAX_SEC);
    expect(at(1035, 0, [120, 900], 1)).toBe(915);
  });

  it("the tier's tape budget is its ceiling less the narration estimate, and every seeded tape beat counts once (arguments never)", () => {
    /* MUTATIONS THAT KILL THIS: `tierRuntimeBand(tier)[0]` (the band's floor)
       in tierClipBudgetSec, or count an argument beat's seed. Ran both: red. */
    const acts = [
      act([
        { claim: LONG_CLAIM, exploration: false, seed: LONG_SEED },
        { claim: KELP_CLAIM, exploration: false, seed: KELP_SEED },
        { claim: GLACIER_CLAIM, exploration: false, seed: KELP_SEED, kind: "argument" },
        { claim: GEARBOX_CLAIM, exploration: false }
      ])
    ];
    expect(seededBeatCount(acts)).toBe(2);
    expect(tierClipBudgetSec("short", acts)).toBeCloseTo(tierRuntimeBand("short")[1] - narrationEstimateSec(acts), 9);
    expect(tierRuntimeBand("short")[1]).toBe(1035);
    expect(tierClipBudgetSec("short", acts)).toBeLessThan(1035);
  });
});

describe("GV-106: sourcing under the tier's runtime budget (FORAY_TIER_RUNTIME_CAP)", () => {
  /* A pool hit (120 s), then the 25-minute thought, then three more seeded
     beats: kelp, glacier, and one whose episode is not on this machine. */
  const fourSeeded = () => [
    act([
      { claim: GEARBOX_CLAIM, exploration: false },
      { claim: LONG_CLAIM, exploration: false, seed: LONG_SEED },
      { claim: KELP_CLAIM, exploration: false, seed: KELP_SEED },
      { claim: GLACIER_CLAIM, exploration: false, seed: GLACIER_SEED },
      { claim: "A fourth seeded beat whose episode this machine does not hold.", exploration: false, seed: LOST_SEED }
    ])
  ];
  const POOL = [poolRow("pool-gearbox", 100, 120)];

  it("cuts a 25-minute thought at or under 1,035 - 3 x 60 - placed seconds, on cue boundaries; with no budget it rides", () => {
    /* MUTATIONS THAT KILL THIS: pass `undefined` instead of the ceiling to
       `cutExtent` in chooseCutForPlacement (the full thought is cut, then
       refused, and the beat narrates); decrement `remainingSeededBeats` AFTER
       resolving the beat (the ceiling reserves for the beat itself and the cut
       lands a minute short); drop the reserve term from clipCeilingSec (the cut
       runs past 735 s). Ran each: red. */
    const free = sourceBeats(fourSeeded(), options(POOL));
    expect(clipSec(free, 0)).toBe(120);
    expect(clipSec(free, 1)).toBeGreaterThan(1400);

    const capped = sourceBeats(fourSeeded(), { ...options(POOL), runtimeBudgetSec: 1035 });
    expect(clipSec(capped, 0)).toBe(120);
    const ceiling = 1035 - 3 * TAPE_WINDOW_MIN_SEC - 120;
    expect(ceiling).toBe(735);
    const long = beats(capped)[1]!;
    expect(long.sourcing).toBe("tape");
    if (long.sourcing !== "tape") return;
    const sec = long.tape.endSec - long.tape.startSec;
    expect(sec).toBeLessThanOrEqual(ceiling);
    /* It rides to the ceiling, not short of it: the extension walks one
       relevance window (a minute) at a time, so it stops within one of it. */
    expect(sec).toBeGreaterThan(ceiling - RELEVANCE_WINDOW_SEC);
    expect(onCueBoundaries("ep-long", long.tape.startSec, long.tape.endSec)).toBe(true);
    /* The minted row and the pointer agree. */
    const row = capped.newSegments.find((s) => s.id === long.tape.segmentId)!;
    expect(row.endSec - row.startSec).toBe(sec);
    /* The seeded beats after it still get tape inside what is left, and the
       Foray's tape fits the budget. */
    expect(beats(capped)[2]!.sourcing).toBe("tape");
    expect(beats(capped)[3]!.sourcing).toBe("tape");
    const tapeSec = beats(capped).reduce((sum, b) => sum + (b.sourcing === "tape" && !b.mergedInto ? b.tape.endSec - b.tape.startSec : 0), 0);
    expect(tapeSec).toBeLessThanOrEqual(1035);
  });

  it("once the budget is spent, a later beat whose tape is found narrates under tier-budget (tier 2), and an overrunning pool segment is refused under the same gate (tier 1)", () => {
    /* MUTATIONS THAT KILL THIS: drop `?? tierBudgetVetoFor(...)` from
       chooseCutForPlacement (the kelp beat is cut to the floor and placed);
       drop it from tier1VetoFor (the gearbox pool row plays). Ran both: red. */
    const acts = () => [
      act([
        { claim: LONG_CLAIM, exploration: false, seed: LONG_SEED },
        { claim: KELP_CLAIM, exploration: false },
        { claim: GEARBOX_CLAIM, exploration: false }
      ])
    ];
    const free = sourceBeats(acts(), options(POOL));
    expect(beats(free).map((b) => b.sourcing)).toEqual(["tape", "tape", "tape"]);
    expect(free.sourcingTrace).toHaveLength(0);

    const capped = sourceBeats(acts(), { ...options(POOL), runtimeBudgetSec: 1035 });
    /* No seeded beat ahead of it, so the thought takes the whole budget it can. */
    expect(clipSec(capped, 0)).toBeLessThanOrEqual(1035);
    expect(clipSec(capped, 0)).toBeGreaterThan(1035 - TAPE_WINDOW_MIN_SEC);
    expect(beats(capped)[1]!.sourcing).toBe("narration");
    expect(beats(capped)[2]!.sourcing).toBe("narration");
    const kelp = traceFor(capped, KELP_CLAIM);
    expect(kelp.tier2?.gate).toBe("tier-budget");
    expect(kelp.tier2?.bestEpisodeTitle).toBe("Episode ep-kelp");
    const gearbox = traceFor(capped, GEARBOX_CLAIM);
    expect(gearbox.tier1?.gate).toBe("tier-budget");
    expect(gearbox.tier1?.bestSegmentId).toBe("pool-gearbox#100");
    /* The narration reason says why; undershoot is not padded. */
    const narrated = beats(capped)[1]!;
    if (narrated.sourcing === "narration") expect(narrated.narration.reason).toMatch(/length tier has no runtime left/);
    expect(capped.transcriptionQueueCandidates.find((q) => q.claim === KELP_CLAIM)?.reason).toMatch(/Nothing to transcribe/);
  });

  it("a pool segment longer than the ceiling is refused whole (never cut); one that fits is placed", () => {
    /* MUTATION THAT KILLS THIS: in tierBudgetVetoFor, refuse only at a 0
       ceiling (`ceiling === 0 ? "tier-budget" : null`) — the 400 s row plays
       under a 300 s budget. Ran it: red. */
    const one = () => [act([{ claim: GEARBOX_CLAIM, exploration: false }])];
    const long = [poolRow("pool-gearbox", 100, 400)];
    const refused = sourceBeats(one(), { ...options(long), runtimeBudgetSec: 300 });
    expect(beats(refused)[0]!.sourcing).toBe("narration");
    expect(traceFor(refused, GEARBOX_CLAIM).tier1?.gate).toBe("tier-budget");
    const fits = sourceBeats(one(), { ...options(long), runtimeBudgetSec: 500 });
    expect(clipSec(fits, 0)).toBe(400);
    /* Pool segments keep their curated length: never shortened to fit. */
    expect(sourceBeats(one(), options(long)).newSegments).toHaveLength(0);
  });

  it("two seeded beats in one stretch of tape merge into one clip (F-96) that stays at or under the merge's own ceiling; with no budget the merged clip rides", () => {
    /* MUTATION THAT KILLS THIS: in mergeIntoClip, ignore the clip ceiling
       (`const ceiling = undefined`, so the merge keeps Q-01's thirty-minute
       TAPE_WINDOW_MAX_SEC) — the second beat's thought carries the merged
       clip past the 600 s budget. Ran it: red. */
    const BUDGET = 600;
    const SECOND_LONG_CLAIM = "Engineers redesigned the blade pitch bearings so tidal turbines in the Pentland Firth survived winter storms.";
    const sameStretch = () => [
      act([
        { claim: LONG_CLAIM, exploration: false, seed: LONG_SEED },
        { claim: SECOND_LONG_CLAIM, exploration: false, seed: seed("ep-long", 700, 760) }
      ])
    ];
    const free = sourceBeats(sameStretch(), options());
    const freeSecond = beats(free)[1]!;
    expect(freeSecond.sourcing === "tape" ? freeSecond.mergedInto : undefined).toBeDefined();
    expect(free.newSegments).toHaveLength(1);
    expect(clipSec(free, 0)).toBeGreaterThan(1400);

    const capped = sourceBeats(sameStretch(), { ...options(), runtimeBudgetSec: BUDGET });
    const [first, second] = beats(capped);
    expect(first!.sourcing).toBe("tape");
    expect(second!.sourcing).toBe("tape");
    if (first!.sourcing !== "tape" || second!.sourcing !== "tape") return;
    /* One clip: the second beat rides in the first beat's, extended. */
    expect(second!.mergedInto).toEqual({ slot: 0, beat: 0 });
    expect(second!.tape.segmentId).toBe(first!.tape.segmentId);
    expect(capped.newSegments).toHaveLength(1);
    /* The merge's ceiling: the budget, less nothing else placed (the merged
       clip replaces the first), less no seeded beat ahead (0 x 60). */
    const ceiling = BUDGET - 0 - 0 * TAPE_WINDOW_MIN_SEC;
    const sec = clipSec(capped, 0);
    expect(sec).toBeLessThanOrEqual(ceiling);
    const row = capped.newSegments[0]!;
    expect(row.endSec - row.startSec).toBe(sec);
    expect(onCueBoundaries("ep-long", first!.tape.startSec, first!.tape.endSec)).toBe(true);
  });

  it("without a budget the result is byte-identical to sourcing with no budget option at all, and the snapshot carries neither new field", () => {
    /* MUTATION THAT KILLS THIS: default `remainingSeededBeats` to 0 in the
       SourcingSession constructor (the snapshot grows a key). Ran it: red. */
    const plain = sourceBeats(fourSeeded(), options(POOL));
    const explicit = sourceBeats(fourSeeded(), { ...options(POOL), runtimeBudgetSec: undefined });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(plain));
    const session = new SourcingSession(options(POOL));
    session.sourceAct(fourSeeded()[0]!, 0);
    const snapshot = session.exportState();
    expect("runtimeBudgetSec" in snapshot).toBe(false);
    expect("remainingSeededBeats" in snapshot).toBe(false);
  });

  it("act by act, planRuntime re-plans before each act and the snapshot banks the budget, so a resumed session cuts as the live one would", () => {
    /* MUTATION THAT KILLS THIS: leave `runtimeBudgetSec` and
       `remainingSeededBeats` out of exportState (the resumed session sources
       act 1 with no ceiling and the long thought rides). Ran it: red. */
    const acts = [
      act([{ claim: GEARBOX_CLAIM, exploration: false }, { claim: KELP_CLAIM, exploration: false, seed: KELP_SEED }], "A"),
      act([{ claim: LONG_CLAIM, exploration: false, seed: LONG_SEED }, { claim: GLACIER_CLAIM, exploration: false, seed: GLACIER_SEED }], "B")
    ];
    const whole = sourceBeats(acts, { ...options(POOL), runtimeBudgetSec: 900 });

    const live = new SourcingSession(options(POOL));
    live.planRuntime({ budgetSec: 900, actsAhead: acts });
    live.sourceAct(acts[0]!, 0);
    const banked = live.exportState();
    expect(banked.runtimeBudgetSec).toBe(900);
    expect(banked.remainingSeededBeats).toBe(2);
    const resumed = SourcingSession.resume(options(POOL), JSON.parse(JSON.stringify(banked)));
    resumed.sourceAct(acts[1]!, 1);
    expect(JSON.stringify(resumed.result(acts))).toBe(JSON.stringify(whole));
    /* 900 - (120 + kelp's clip) - 1 x 60 bounds the long thought. */
    const longSec = clipSec(whole, 2);
    expect(longSec).toBeLessThanOrEqual(900 - 120 - clipSec(whole, 1) - TAPE_WINDOW_MIN_SEC);

    /* planRuntime(undefined) lifts the cap: the thought rides again. */
    const lifted = SourcingSession.resume(options(POOL), JSON.parse(JSON.stringify(banked)));
    lifted.planRuntime(undefined);
    lifted.sourceAct(acts[1]!, 1);
    expect(clipSec(lifted.result(acts), 2)).toBeGreaterThan(1400);
  });
});

describe("GV-106: MQ-14 tier fit and the FORAY_GATE_TIER_FIT option", () => {
  it("publishGateOptions turns the tier-fit gate on only under FORAY_GATE_TIER_FIT, and the option refuses a 37-minute short", () => {
    /* MUTATION THAT KILLS THIS: return `{ tierFit: true }` unconditionally
       from publishGateOptions. Ran it: red. */
    expect(publishGateOptions({})).toEqual({});
    expect(publishGateOptions({ FORAY_GATE_TIER_FIT: "0" })).toEqual({});
    expect(publishGateOptions({ FORAY_GATE_TIER_FIT: "1" })).toEqual({ tierFit: true });
    expect(() => publishGateOptions({ FORAY_GATE_TIER_FIT: "maybe" })).toThrow(/FORAY_GATE_TIER_FIT/);
    const veracity = { ...passingVeracity(), tierFit: computeTierFit("short", 37 * 60) };
    expect(evaluateVeracityGate(veracity, publishGateOptions({})).ok).toBe(true);
    expect(evaluateVeracityGate(veracity, publishGateOptions({ FORAY_GATE_TIER_FIT: "1" })).ok).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
   Through runForayPipeline: both paths (classic, and GV-102's per-act).
   --------------------------------------------------------------------------- */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "short", author_id: "founder-1", visibility: "catalogue" };
/* The stub spine gives a short Foray one act; the per-act plan needs several. */
const medium: GenerationRequest = { ...request, duration: "medium" };
const baseOptions: RunPipelineOptions = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };

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

async function pipelineRun(flags: Partial<PipelineFlags>, req: GenerationRequest = request, extra: Partial<RunPipelineDeps> = {}) {
  const seen: FinalizeForayInput[] = [];
  const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
    seen.push(input);
    return {
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    } as unknown as FinalizeForayResult;
  };
  const plans: Array<{ budgetSec: number; acts: number } | undefined> = [];
  const real = SourcingSession.prototype.planRuntime;
  vi.spyOn(SourcingSession.prototype, "planRuntime").mockImplementation(function (this: SourcingSession, plan) {
    plans.push(plan ? { budgetSec: plan.budgetSec, acts: plan.actsAhead.length } : undefined);
    return real.call(this, plan);
  });
  const outcome = await runForayPipeline(req, { ...baseOptions, flags }, { ...stubDeps(), finalize, ...extra });
  vi.restoreAllMocks();
  return { outcome, input: seen.at(-1)!, plans };
}

describe("GV-106: runForayPipeline hands sourcing the tier's budget on both paths, and reports the tier fit", () => {
  it("cap on: the classic path plans once with every act, the per-act path once per act with the acts ahead, both ending on the same budget; cap off plans nothing", async () => {
    /* MUTATIONS THAT KILL THIS: read `flags.perActPipeline` instead of
       `flags.tierRuntimeCap` in runtimeBudgetFor (the classic cap-on run
       plans nothing); pass `planned` instead of `planned.slice(i)` as the
       per-act acts ahead. Ran both: red. */
    const classic = await pipelineRun({ tierRuntimeCap: true }, medium);
    const actCount = classic.outcome.outcome === "generated" ? classic.outcome.spine.acts.length : 0;
    expect(actCount).toBeGreaterThan(1);
    expect(classic.plans).toHaveLength(1);
    expect(classic.plans[0]!.acts).toBe(actCount);

    const perAct = await pipelineRun({ tierRuntimeCap: true, perActPipeline: true }, medium);
    expect(perAct.plans.map((p) => p?.acts)).toEqual(Array.from({ length: actCount }, (_v, i) => actCount - i));
    /* At the last act every act is deepened, so the budget is the classic one. */
    expect(perAct.plans.at(-1)!.budgetSec).toBeCloseTo(classic.plans[0]!.budgetSec, 9);

    const off = await pipelineRun({}, medium);
    expect(off.plans).toHaveLength(0);
    const perActOff = await pipelineRun({ perActPipeline: true }, medium);
    expect(perActOff.plans).toEqual(Array.from({ length: actCount }, () => undefined));
  }, 60_000);

  it("tierFit rides on every generated outcome (runtimeSec is the candidate's own); an overlong short is gated only under tierFitGate, and the cap brings its tape under the budget on both paths", async () => {
    /* MUTATIONS THAT KILL THIS: compute the tier fit from `spineRuntime`'s
       estimate instead of the finished runtime; pass `{ tierFit: true }` to
       the pipeline's gate whatever the flag says; build the classic path's
       sourcing options without `runtimeBudgetSec`. Ran each: red. */
    /* The committed pool with every row stretched by 400 s: the stub
       short then plays far past its 1,035 s ceiling — 14 Sep's failure. */
    const stretched = { segmentPool: loadSegmentPool().map((row) => ({ ...row, end_sec: row.end_sec + 400 })) };
    const run = await pipelineRun({}, request, stretched);
    if (run.outcome.outcome !== "generated") throw new Error(run.outcome.outcome);
    const fit = run.input.meta?.veracity?.tierFit;
    expect(fit).toEqual(computeTierFit("short", run.input.runtimeSec));
    expect(fit!.runtimeSec).toBeGreaterThan(tierRuntimeBand("short")[1]);
    /* Off: the verdict is exactly the pre-GV-106 one. */
    expect(run.outcome.gate).toEqual(evaluateVeracityGate(run.input.meta?.veracity));
    expect(run.outcome.gate!.failures.some((f) => f.startsWith("tier runtime above"))).toBe(false);
    const gated = await pipelineRun({ tierFitGate: true }, request, stretched);
    if (gated.outcome.outcome !== "generated") throw new Error(gated.outcome.outcome);
    expect(gated.outcome.gate).toEqual(evaluateVeracityGate(gated.input.meta?.veracity, { tierFit: true }));
    expect(gated.outcome.gate!.ok).toBe(false);
    expect(gated.outcome.gate!.failures.some((f) => f.startsWith("tier runtime above +15%"))).toBe(true);

    /* With the cap, on both paths, the tape placed fits the budget sourcing
       was handed, and the overlong pool rows are refused under tier-budget. */
    const tapeSec = (input: FinalizeForayInput): number =>
      input.items.reduce((sum, item) => {
        if (item.type !== "segment") return sum;
        const row = [...(input.segments ?? []).map((m) => ({ id: m.id, sec: m.endSec - m.startSec })), ...stretched.segmentPool.map((r) => ({ id: r.id, sec: r.end_sec - r.start_sec }))].find(
          (r) => r.id === (item as { segment_id?: string }).segment_id
        );
        return sum + (row?.sec ?? 0);
      }, 0);
    const uncappedTape = tapeSec(run.input);
    for (const flags of [{ tierRuntimeCap: true }, { tierRuntimeCap: true, perActPipeline: true }]) {
      const capped = await pipelineRun(flags, request, stretched);
      if (capped.outcome.outcome !== "generated") throw new Error(capped.outcome.outcome);
      const budget = capped.plans.at(-1)!.budgetSec;
      expect(tapeSec(capped.input)).toBeLessThanOrEqual(budget);
      expect(tapeSec(capped.input)).toBeLessThan(uncappedTape);
      expect(capped.input.meta?.veracity?.tierFit?.runtimeSec).toBeLessThan(fit!.runtimeSec);
    }
  }, 120_000);
});

/** A veracity block every pre-GV-106 floor passes. */
function passingVeracity() {
  return {
    groundedQuoteRate: 1,
    groundedQuoteCounts: { checkable: 1, grounded: 1 },
    ungroundedPages: [],
    attributionStability: 1,
    purposeFidelity: 1,
    tapeRelevance: null,
    tapeRelevanceAnchors: [],
    firstAttemptPassRate: 1,
    firstAttemptUnit: "beats" as const,
    firstAttemptPassRatePages: 1,
    firstAttemptPassRateBeats: 1,
    callsPerBeat: 1,
    narrationCallsPerBeat: 1,
    narrationCalls: { writer: 1, verifier: 1 },
    retryRounds: 0,
    seedLostBeats: 0,
    pagesDropped: 0,
    unverifiedPages: 0,
    unverifiedPageDetails: [],
    synthesisVerifiedPages: 0,
    synthesisVerifiedPageDetails: [],
    purposeRevisedPages: 0,
    tapeCitedPages: 0,
    narrationPagesPerSeam: 1,
    narrationShare: 0.5,
    tapeShare: 0.5,
    tapeOfTapePlusNarration: 0.5,
    narrationOfTapePlusNarration: 0.5,
    introRestates: 0,
    narrationCallsPerAct: 2,
    pipelineTokens: 0,
    stageTimings: []
  };
}
