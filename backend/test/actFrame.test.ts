import { describe, it, expect, beforeAll } from "vitest";
import { runForayPipeline, type RunPipelineOptions } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { buildActFrames, type WrittenAct } from "../src/generation/writeNarration";
import { verifiedPageSummaries } from "../src/generation/synthesisVerify";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import type { FinalizeForayResult } from "../src/generation/finalizeForay";
import type { ActWriteRequest } from "../src/generation/NarrationWriterBuilder";
import type { GenerationRequest } from "../src/types/generation";
import type { DeepenedAct, Spine } from "../src/types/spine";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";

/**
 * GV-38 (docs/roadmap/generation-v2.md, W4-08; covers QK-26, GP-24): the act
 * writer sees its act's introduction and exit, the previous act's exit, the
 * spine's start and end states and (act 0) the overview — and under
 * narrationOrder 'sequential' each act is written after the one before, so
 * its `ground` holds the earlier acts' verified pages on every run.
 *
 * Every dependency is a Stub; nothing leaves the process. One medium run is
 * paid in full (about 20 s on this machine); every other run resumes its
 * banked prefix (understand .. source) from the same in-memory checkpoint
 * with the narrate and stitch stages dropped, so only narration and
 * stitching re-run. narrationOrder is not part of the checkpoint variant
 * (pipelineFlags.ts), so 'parallel' and 'sequential' share the prefix.
 *
 * MUTATIONS RUN against this suite (each turned it red, then reverted):
 *   1. runPipeline.ts: the act gate limit stays `narrationActConcurrency`
 *      under 'sequential' — every act starts together, act 1's ground is
 *      empty ("sequential ground" red).
 *   2. runPipeline.ts: `actFrames` built only for 'sequential' (no
 *      `|| flags.fastPath`) — the fast-path run sends no frame.
 *   3. runPipeline.ts: frames built unconditionally — the default run's
 *      requests carry `frame` ("default run" red).
 *   4. writeNarration.ts: `buildActFrames` hands act i its own exit as the
 *      previous exit — the plumbing test's frame differs.
 *   5. writeNarration.ts: `frames` not threaded into writeActNarration —
 *      the sequential requests carry no frame.
 *   Survived, on purpose: restoring the old `p.then` assignment of
 *   `settledActs`. With the gate at 1 the promise reaction that assigns it
 *   runs before the gate's `finally` starts the next act, so today's
 *   microtask order hides the race; the move makes the order explicit
 *   rather than incidental. Removing the assignment altogether is red.
 */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "medium", author_id: "founder-1", visibility: "catalogue" };
const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
const KEY = "gv-38";

const finalize = async (): Promise<FinalizeForayResult> =>
  ({
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { generated: true },
    timings: []
  }) as unknown as FinalizeForayResult;

/** The stub writer, every act request recorded in call order. */
function recordingWriter() {
  const writer = new StubNarrationWriterBuilder();
  const real = writer.writeAct.bind(writer);
  const requests: ActWriteRequest[] = [];
  writer.writeAct = async (req, ctx) => {
    requests.push(req);
    return real(req, ctx);
  };
  return { writer, requests };
}

const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));

/** One run against the shared store, after dropping every narrate and
 * stitch stage, so narration really runs again. Returns the act requests. */
async function narrateOnce(flags: RunPipelineOptions["flags"]): Promise<ActWriteRequest[]> {
  store.drop(KEY, store.stageKeys(KEY).filter((s) => /^(narrate|stitch):/.test(s)));
  const { writer, requests } = recordingWriter();
  const out = await runForayPipeline(
    request,
    { ...options, checkpointKey: KEY, ...(flags ? { flags } : {}) },
    {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: writer,
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize,
      checkpoint: store
    }
  );
  expect(out.outcome).toBe("generated");
  return requests;
}

const banked = <T>(stage: string): T => store.files.get(KEY)!.stages[stage] as T;
let spine: Spine;
let deepened: DeepenedAct[];

/** Each act's FIRST request (its ground is read once, when the act starts). */
function firstRequestPerAct(requests: ActWriteRequest[]): ActWriteRequest[] {
  return deepened.map((act) => requests.find((r) => r.actTitle === act.title)!);
}

beforeAll(async () => {
  await narrateOnce({ narrationOrder: "sequential" });
  spine = banked<Spine>("spine");
  deepened = spine.acts.map((_, i) => banked<DeepenedAct>(`deepen:${i}`));
}, 180_000);

describe("buildActFrames (pure)", () => {
  it("act i gets its own introduction and exit, act i-1's exit, the spine act's states, and act 0 the overview", () => {
    const frames = buildActFrames(spine, deepened);
    expect(deepened.length).toBeGreaterThanOrEqual(3);
    expect(frames).toHaveLength(deepened.length);
    frames.forEach((frame, i) => {
      expect(frame).toEqual({
        actIntroduction: deepened[i]!.introduction,
        actExit: deepened[i]!.exit,
        ...(i > 0 ? { previousActExit: deepened[i - 1]!.exit } : {}),
        startState: spine.acts[i]!.startState,
        endState: spine.acts[i]!.endState,
        ...(i === 0 ? { forayOverview: spine.overview } : {}),
        actIndex: i,
        totalActs: deepened.length
      });
    });
    expect(frames[0]).not.toHaveProperty("previousActExit");
    expect(frames.slice(1).every((f) => !("forayOverview" in f))).toBe(true);
  });
});

describe("runForayPipeline — the act frame reaches the writer (GV-38)", () => {
  it("under 'sequential' every act request carries its frame, on every round", async () => {
    const requests = await narrateOnce({ narrationOrder: "sequential" });
    const frames = buildActFrames(spine, deepened);
    for (const [i, act] of deepened.entries()) {
      const forAct = requests.filter((r) => r.actTitle === act.title);
      expect(forAct.length).toBeGreaterThan(0);
      for (const r of forAct) expect(r.frame).toEqual(frames[i]);
    }
    /* The wrapped stub writer captured the deepened act's own lines. */
    expect(firstRequestPerAct(requests)[1]!.frame).toMatchObject({ actIntroduction: deepened[1]!.introduction, actExit: deepened[1]!.exit, previousActExit: deepened[0]!.exit });
    expect(firstRequestPerAct(requests)[0]!.frame).not.toHaveProperty("previousActExit");
  }, 120_000);

  it("the default run (narrationOrder unset, no fast path) sends no frame, and its first wave sees no ground, as today", async () => {
    const requests = await narrateOnce(undefined);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r).not.toHaveProperty("frame");
    /* G-32: with the default concurrency (4) every act of this run starts
       together, so none reads another act's pages. */
    for (const r of firstRequestPerAct(requests)) expect(r.ground ?? []).toEqual([]);
  }, 120_000);

  it("the fast path sends the frame even with narrationOrder 'parallel'", async () => {
    /* The checkpoint-variant flags are held off so this run resumes the same
       banked prefix; no stage reads the other fast-path flags yet. */
    const requests = await narrateOnce({ fastPath: true, foldSpineCopy: false, foldDeepen: "off", perActPipeline: false, narrationOrder: "parallel" });
    const frames = buildActFrames(spine, deepened);
    firstRequestPerAct(requests).forEach((r, i) => expect(r.frame).toEqual(frames[i]));
  }, 120_000);

  it("under 'sequential' act i's ground is exactly the earlier acts' verified pages, on every one of 20 runs", async () => {
    for (let run = 0; run < 20; run++) {
      const requests = await narrateOnce({ narrationOrder: "sequential" });
      const written = deepened.map((_, i) => banked<WrittenAct>(`narrate:${i}`));
      const first = firstRequestPerAct(requests);
      expect(first[0]!.ground ?? []).toEqual([]);
      for (let i = 1; i < first.length; i++) {
        const expected = verifiedPageSummaries(written.slice(0, i));
        expect(expected.length, `act ${i}: the earlier acts have verified pages`).toBeGreaterThan(0);
        expect(first[i]!.ground, `run ${run}, act ${i}`).toEqual(expected);
      }
      /* Act 2's request holds act 1's pages (foray page ids a0/..). */
      expect(first[1]!.ground!.every((g) => g.pageId.startsWith("a0/"))).toBe(true);
    }
  }, 300_000);
});
