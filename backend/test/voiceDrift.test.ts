import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_DRIFT_ENV,
  VOICE_DRIFT_PURPOSE,
  VOICE_DRIFT_QUESTION,
  VOICE_DRIFT_STAGE,
  actSeamScripts,
  voiceDriftMode,
  voiceDriftReference,
  voiceDriftScores,
  voiceDriftState
} from "../src/generation/voiceDrift";
import type { LoadedVoiceExemplars, VoiceExemplarsFile } from "../src/generation/voiceExemplars";
import type { WrittenAct } from "../src/generation/writeNarration";
import type { JevAskOptions, JevClient, JevQuestion, JevResult, JevState } from "../src/generation/jevTypes";
import { NullJevClient } from "../src/generation/jevClient";
import { FlagValueError } from "../src/generation/generationFlags";
import { BudgetExceededError, BudgetStopError } from "../src/cost/budgetGuard";
import { UnitBudgetExceededError } from "../src/cost/unitBudget";
import { buildVeracityMetrics, evaluateVeracityGate } from "../src/generation/veracityMetrics";
import { runForayPipeline, type RunPipelineDeps } from "../src/generation/runPipeline";
import type { PipelineFlags } from "../src/generation/pipelineFlags";
import type { GateConfig } from "../src/generation/gateConfig";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import { FakeJevClient, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-116 (docs/roadmap/generation-v2.md, #1286; from W4-12, covers R2-08 and
 * GP-24): the voice drift alarm. One Jev "same narrator as the exemplar?"
 * Score per act after narration, report only, behind FORAY_VOICE_DRIFT
 * (default off). Offline: the GV-20 Jev fake (or a hand-written JevClient),
 * synthetic exemplars and written acts, and the stub pipeline on the classic
 * and per-act paths. No test reaches Jev, the Spark or any network. Each test
 * names the mutation that turns it red; every one was run.
 */

const EXEMPLAR_A = "It held for a year. Then the hotel threw a party, and the walkways filled with people watching the dancers below.";
const EXEMPLAR_B = "Which leaves the question the engineers never put on paper: who checks the change after the drawing leaves the office?";

function selectedFile(overrides: Partial<VoiceExemplarsFile> = {}): VoiceExemplarsFile {
  const exemplar = (text: string, forayId: string, itemId: string) => ({
    role: "act-introduction" as const,
    text,
    forayId,
    itemIds: [itemId],
    sourceKind: "candidate" as const,
    provenance: "qwen-pipeline",
    selectedBy: "Wyatt",
    listenedOn: "2026-10-18"
  });
  return {
    version: 1,
    voiceCard: { text: "Plain words, one idea a sentence.", words: 6 },
    exemplars: [exemplar(EXEMPLAR_A, "the-hyatt-walkway-ab12cd34", "act-0-introduction"), exemplar(EXEMPLAR_B, "the-hyatt-walkway-ab12cd34", "act-1-exit")],
    ...overrides
  };
}

const EXEMPLARS: LoadedVoiceExemplars = { file: selectedFile(), fileSha: "f".repeat(64) };

/** A written act whose narration pages carry `scripts`, one beat a page. */
function actOf(title: string, scripts: string[]): WrittenAct {
  return {
    title,
    slots: [
      {
        title: `${title} slot`,
        beats: scripts.map((script, i) =>
          i % 2 === 0
            ? ({ sourcing: "narration", claim: `c${i}`, exploration: false, narration: { script } } as never)
            : ({ sourcing: "tape", claim: `c${i}`, exploration: false, tape: {} as never, connectiveNarration: { script } } as never)
        )
      }
    ]
  };
}

const ACTS: WrittenAct[] = [
  actOf("One", ["The bridge opened in May.", "Nobody checked the rods."]),
  actOf("Two", ["The inquiry took a year."]),
  actOf("Three", ["What changed after?", "The stamp.", "And the drawings."])
];

const scoreFor = (state: JevState): number => {
  const narration = (state as { narration: string }).narration;
  if (narration.startsWith("The bridge")) return 3.5;
  if (narration.startsWith("The inquiry")) return 1.25;
  return 4;
};

const scriptedJudge = () => new FakeJevClient({ byId: { [VOICE_DRIFT_QUESTION.id]: (state) => scoreAnswer(scoreFor(state), 5) } });

/** A voice block without its `drift` key. */
function withoutDrift<T extends { drift?: unknown }>(voice: T): Omit<T, "drift"> {
  const copy: Partial<T> = { ...voice };
  delete copy.drift;
  return copy as Omit<T, "drift">;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GV-116: the flag, the reference and the state", () => {
  it("FORAY_VOICE_DRIFT defaults to off, reads on, and a malformed value throws naming only the variable", () => {
    /* MUTATION: default `on` in voiceDriftMode. Ran it: red. */
    expect(voiceDriftMode({})).toBe("off");
    expect(voiceDriftMode({ [VOICE_DRIFT_ENV]: "on" })).toBe("on");
    expect(voiceDriftMode({ [VOICE_DRIFT_ENV]: "off" })).toBe("off");
    let thrown: unknown;
    try {
      voiceDriftMode({ [VOICE_DRIFT_ENV]: "loud-secret" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FlagValueError);
    expect((thrown as Error).message).toContain(VOICE_DRIFT_ENV);
    expect((thrown as Error).message).not.toContain("loud-secret");
  });

  it("the reference is the exemplar seams in file order; a voice card alone is none", () => {
    /* MUTATION: fall back to the voice card's text when there is no
       exemplar seam. Ran it: red. */
    expect(voiceDriftReference(selectedFile())).toBe(`${EXEMPLAR_A}\n\n${EXEMPLAR_B}`);
    expect(voiceDriftReference(selectedFile({ exemplars: [] }))).toBeNull();
    expect(actSeamScripts(ACTS[2]!)).toEqual(["What changed after?", "The stamp.", "And the drawings."]);
  });

  it("the state holds only the reference and the act's seams, capped: the seam that does not fit is cut and the rest dropped", () => {
    /* MUTATION: push every seam whole (no budget), or drop the reference's
       half-budget cap. Ran both: red. */
    const small = voiceDriftState("ref", ["a".repeat(10), "b".repeat(10)], 100);
    expect(Object.keys(small.state).sort()).toEqual(["narration", "reference"]);
    expect(small.state).toEqual({ reference: "ref", narration: `${"a".repeat(10)}\n\n${"b".repeat(10)}` });
    expect(small.seams).toBe(2);

    const budget = 40;
    const capped = voiceDriftState("r".repeat(100), ["a".repeat(12), "b".repeat(12), "c".repeat(12)], budget);
    expect(capped.state.reference).toBe("r".repeat(20));
    expect(capped.state.narration).toBe(`${"a".repeat(12)}\n\n${"b".repeat(6)}`);
    expect(capped.seams).toBe(2);
    expect(capped.state.reference.length + capped.state.narration.length).toBe(budget);
  });
});

describe("GV-116: voiceDriftScores", () => {
  it("asks one Score per act and reports the fake's scores on a 1-5 scale, with the lowest act named", async () => {
    /* MUTATION: report Jev's level as is (no +1), or take `minAct` from the
       highest score. Ran both: red. */
    const jev = scriptedJudge();
    const drift = await voiceDriftScores(ACTS, EXEMPLARS, jev);
    expect(drift.acts.map((a) => a.score)).toEqual([4.5, 2.25, 5]);
    expect(drift.acts.map((a) => a.seams)).toEqual([2, 1, 3]);
    expect(drift).toMatchObject({ question: "same-narrator", scale: [1, 5], measured: 3, unmeasured: 0, min: 2.25, minAct: 1 });
    expect(drift.mean).toBeCloseTo((4.5 + 2.25 + 5) / 3, 10);
    expect(drift.exemplarIds).toEqual(["the-hyatt-walkway-ab12cd34:act-0-introduction", "the-hyatt-walkway-ab12cd34:act-1-exit"]);
    expect(drift.fileSha).toBe(EXEMPLARS.fileSha);
    expect(jev.calls).toHaveLength(3);
    for (const call of jev.calls) {
      expect(call.purpose).toBe(VOICE_DRIFT_PURPOSE);
      expect(call.questions).toEqual([VOICE_DRIFT_QUESTION]);
      expect((call.state as { reference: string }).reference).toBe(`${EXEMPLAR_A}\n\n${EXEMPLAR_B}`);
    }
    expect(jev.calls.map((c) => (c.state as { narration: string }).narration).sort()).toEqual(
      ["The bridge opened in May.\n\nNobody checked the rods.", "The inquiry took a year.", "What changed after?\n\nThe stamp.\n\nAnd the drawings."].sort()
    );
  });

  it("a judge failure, a throwing ask or a malformed answer is recorded as unmeasured and never fails the alarm", async () => {
    /* MUTATION: rethrow every error from the ask (not only a budget stop).
       Ran it: red (the alarm rejects). */
    let n = 0;
    const flaky: JevClient = {
      async ask(state): Promise<JevResult> {
        n += 1;
        const narration = (state as { narration: string }).narration;
        if (narration.startsWith("The bridge")) return { ok: false, error: { category: "http", reason: "http_503", httpStatus: 503 }, latencyMs: 1 };
        if (narration.startsWith("The inquiry")) throw new Error("socket hang up");
        return {
          ok: true,
          answers: [{ ...scoreAnswer(2, 5), id: "another-question" }],
          model: "jev-1.13.0",
          modelMismatch: false,
          usage: { inputTokens: null, outputTokens: null },
          requestId: null,
          latencyMs: 1,
          judge: "qwen"
        } satisfies JevResult;
      }
    };
    const drift = await voiceDriftScores(ACTS, EXEMPLARS, flaky);
    expect(n).toBe(3);
    expect(drift.acts).toEqual([
      { act: 0, score: null, seams: 2, unmeasured: "http", judge: "jev" },
      { act: 1, score: null, seams: 1, unmeasured: "error" },
      { act: 2, score: null, seams: 3, unmeasured: "malformed", judge: "qwen" }
    ]);
    expect(drift).toMatchObject({ measured: 0, unmeasured: 3, min: null, minAct: null, mean: null });
  });

  it("an act with no narration page is unmeasured without an ask", async () => {
    /* MUTATION: ask Jev with an empty narration. Ran it: red. */
    const jev = scriptedJudge();
    const drift = await voiceDriftScores([actOf("Empty", []), ACTS[1]!], EXEMPLARS, jev);
    expect(jev.calls).toHaveLength(1);
    expect(drift.acts[0]).toEqual({ act: 0, score: null, seams: 0, unmeasured: "no-narration" });
    expect(drift.acts[1]!.score).toBe(2.25);
  });

  it("a budget stop (dollar or unit cap) is rethrown and no further act is asked", async () => {
    /* MUTATION: record a budget stop as unmeasured like any other error.
       Ran it: red (the alarm resolves). */
    for (const stop of [new BudgetExceededError(1.99, 0.01, 2), new UnitBudgetExceededError("s", "jevCalls", 10, 1, 10)]) {
      let asked = 0;
      const capped: JevClient = {
        async ask() {
          asked += 1;
          throw stop;
        }
      };
      await expect(voiceDriftScores(ACTS, EXEMPLARS, capped, { concurrency: 1 })).rejects.toBe(stop);
      expect(asked).toBe(1);
    }
  });

  it("once the run's signal aborts, the acts still waiting are not asked and the ask in flight carries the abort", async () => {
    /* MUTATION: ask without checking the signal (and without passing it).
       Ran it: red (three asks, none aborted). */
    const run = new AbortController();
    const signals: AbortSignal[] = [];
    const held: JevClient = {
      ask(_state: JevState, _q: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
        signals.push(opts.signal!);
        run.abort();
        return Promise.resolve({ ok: false, error: { category: "timeout", reason: "aborted" }, latencyMs: 0 });
      }
    };
    const drift = await voiceDriftScores(ACTS, EXEMPLARS, held, { signal: run.signal, concurrency: 1 });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(drift.acts.map((a) => a.unmeasured)).toEqual(["timeout", "aborted", "aborted"]);
  });

  it("the drift rides on voice and leaves evaluateVeracityGate's verdict unchanged", async () => {
    /* MUTATION: add `voice.drift` to the veracity block without
       `narrationScripts`, or let the gate fail on a low drift. Ran both: red. */
    const drift = await voiceDriftScores(ACTS, EXEMPLARS, scriptedJudge());
    const base = { sourcedActs: [], writtenActs: [] as WrittenAct[], topic: "engineering/software", writerCalls: 3, verifierCalls: 3, pipelineTokens: 0, stageTimings: [] };
    const scripts = [{ script: "The bridge opened in May.", hasTape: false }];
    const plain = buildVeracityMetrics({ ...base, narrationScripts: scripts });
    const withDrift = buildVeracityMetrics({ ...base, narrationScripts: scripts, voiceDrift: drift });
    expect(plain.voice).toBeDefined();
    expect(plain.voice!.drift).toBeUndefined();
    expect(withDrift.voice!.drift).toEqual(drift);
    expect(withoutDrift(withDrift.voice!)).toEqual(plain.voice);
    expect(buildVeracityMetrics({ ...base, voiceDrift: drift }).voice).toBeUndefined();
    expect(evaluateVeracityGate(withDrift)).toEqual(evaluateVeracityGate(plain));
    const lowest = { ...drift, acts: drift.acts.map((a) => ({ ...a, score: 1 })), min: 1, mean: 1 };
    expect(evaluateVeracityGate({ ...plain, voice: { ...plain.voice!, drift: lowest } })).toEqual(evaluateVeracityGate(plain));
  });
});

/* ------------------------------------------------------------------------ */
/* The stub pipeline, classic and per-act                                    */
/* ------------------------------------------------------------------------ */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "short", author_id: "founder-1", visibility: "catalogue" };

function fakeFinalize() {
  return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
}

function stubDeps(): RunPipelineDeps {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: fakeFinalize()
  };
}

const PATHS: Array<Partial<PipelineFlags>> = [{}, { perActPipeline: true }];
const pathName = (flags: Partial<PipelineFlags>) => (flags.perActPipeline ? "per-act" : "classic");

async function run(flags: Partial<PipelineFlags>, extra: Partial<RunPipelineDeps> = {}, gates?: Partial<GateConfig>) {
  const out = await runForayPipeline(
    request,
    { userId: "u", now: () => new Date("2026-10-21T00:00:00Z"), topic: "food/grilling-bbq", flags, ...(gates ? { gates } : {}) },
    { ...stubDeps(), ...extra }
  );
  if (out.outcome !== "generated") throw new Error(`expected a generated outcome, got ${out.outcome}`);
  return out;
}

const narrateStages = (out: Awaited<ReturnType<typeof run>>) => out.timings.filter((t) => /^narrate:\d+$/.test(t.name)).length;

describe("GV-116: the alarm in the pipeline", () => {
  it("off by default: with a judge and exemplars injected nothing is asked and the Foray and its voice block are today's", async () => {
    /* MUTATION: `const voiceDriftOn = voiceDriftMode() !== "on"` (on by
       default). Ran it: red (the judge is asked, voice.drift appears). */
    for (const flags of PATHS) {
      const jev = scriptedJudge();
      const today = await run(flags);
      const offWithDeps = await run(flags, { voiceDriftJudge: jev, voiceDriftExemplars: EXEMPLARS });
      expect(jev.calls, pathName(flags)).toHaveLength(0);
      expect(offWithDeps.input.items).toEqual(today.input.items);
      expect(offWithDeps.input.meta!.veracity!.voice).toEqual(today.input.meta!.veracity!.voice);
      expect(offWithDeps.input.meta!.veracity!.voice!.drift).toBeUndefined();
      expect(offWithDeps.timings.some((t) => t.name === VOICE_DRIFT_STAGE)).toBe(false);
      expect(offWithDeps.gate).toEqual(today.gate);
    }
  }, 120_000);

  it("on, with a judge and exemplars: one Score per written act lands in voice.drift, the Foray and the gate unchanged", async () => {
    /* MUTATION: drop `...(voiceDrift ? { voiceDrift } : {})` from the
       buildVeracityMetrics input. Ran it: red (voice.drift absent). */
    for (const flags of PATHS) {
      const off = await run(flags);
      vi.stubEnv(VOICE_DRIFT_ENV, "on");
      const jev = new FakeJevClient({ byId: { [VOICE_DRIFT_QUESTION.id]: scoreAnswer(1, 5) } });
      const on = await run(flags, { voiceDriftJudge: jev, voiceDriftExemplars: EXEMPLARS });
      vi.unstubAllEnvs();
      const acts = narrateStages(on);
      expect(acts, pathName(flags)).toBeGreaterThan(0);
      expect(jev.calls).toHaveLength(acts);
      for (const call of jev.calls) {
        expect(call.purpose).toBe(VOICE_DRIFT_PURPOSE);
        expect((call.state as { reference: string }).reference).toBe(`${EXEMPLAR_A}\n\n${EXEMPLAR_B}`);
        expect((call.state as { narration: string }).narration.length).toBeGreaterThan(0);
      }
      const drift = on.input.meta!.veracity!.voice!.drift!;
      expect(drift.acts.map((a) => a.score)).toEqual(Array.from({ length: acts }, () => 2));
      expect(drift).toMatchObject({ measured: acts, unmeasured: 0, min: 2, minAct: 0 });
      expect(on.timings.some((t) => t.name === VOICE_DRIFT_STAGE)).toBe(true);
      expect(on.input.items).toEqual(off.input.items);
      expect(withoutDrift(on.input.meta!.veracity!.voice!)).toEqual(off.input.meta!.veracity!.voice);
      expect(on.gate).toEqual(off.gate);
    }
  }, 120_000);

  it("on, but no judge that can answer, no exemplar seam or the voice scorecard off: voice.drift is absent, never zero", async () => {
    /* MUTATION: run the alarm whatever the judge (drop the NullJevClient
       check), or without an exemplar seam. Ran both: red. */
    vi.stubEnv(VOICE_DRIFT_ENV, "on");
    for (const flags of PATHS) {
      const nullJudge = await run(flags, { voiceDriftJudge: new NullJevClient(), voiceDriftExemplars: EXEMPLARS });
      expect(nullJudge.input.meta!.veracity!.voice).toBeDefined();
      expect(nullJudge.input.meta!.veracity!.voice!.drift, pathName(flags)).toBeUndefined();

      for (const exemplars of [null, { file: selectedFile({ exemplars: [] }), fileSha: "e".repeat(64) }]) {
        const jev = scriptedJudge();
        const none = await run(flags, { voiceDriftJudge: jev, voiceDriftExemplars: exemplars });
        expect(jev.calls).toHaveLength(0);
        expect(none.input.meta!.veracity!.voice!.drift).toBeUndefined();
      }

      const jev = scriptedJudge();
      const voiceOff = await run(flags, { voiceDriftJudge: jev, voiceDriftExemplars: EXEMPLARS }, { voice: "off" });
      expect(jev.calls).toHaveLength(0);
      expect(voiceOff.input.meta!.veracity!.voice).toBeUndefined();
    }
  }, 120_000);

  it("on, a judge that fails every ask: the run still generates, every act unmeasured", async () => {
    /* MUTATION: let a {ok:false} answer throw out of voiceDriftScores. Ran
       it: red (the run rejects). */
    vi.stubEnv(VOICE_DRIFT_ENV, "on");
    for (const flags of PATHS) {
      const jev = new FakeJevClient({ fail: { category: "network", reason: "network" } });
      const out = await run(flags, { voiceDriftJudge: jev, voiceDriftExemplars: EXEMPLARS });
      const drift = out.input.meta!.veracity!.voice!.drift!;
      expect(drift.acts.length, pathName(flags)).toBe(narrateStages(out));
      expect(drift.acts.every((a) => a.score === null && a.unmeasured === "network")).toBe(true);
      expect(drift).toMatchObject({ measured: 0, min: null, mean: null });
    }
  }, 120_000);

  it("on, a budget stop inside the alarm ends the run with a BudgetStopError naming the voice-drift stage", async () => {
    /* MUTATION: start the alarm outside `timed` (the raw guard error
       escapes, stage-blind). Ran it: red. */
    vi.stubEnv(VOICE_DRIFT_ENV, "on");
    for (const flags of PATHS) {
      const capped: JevClient = {
        async ask() {
          throw new BudgetExceededError(1.99, 0.01, 2);
        }
      };
      const err = await runForayPipeline(
        request,
        { userId: "u", now: () => new Date("2026-10-21T00:00:00Z"), topic: "food/grilling-bbq", flags },
        { ...stubDeps(), voiceDriftJudge: capped, voiceDriftExemplars: EXEMPLARS }
      ).then(
        () => null,
        (e: unknown) => e
      );
      expect(err, pathName(flags)).toBeInstanceOf(BudgetStopError);
      expect((err as BudgetStopError).stage).toBe(VOICE_DRIFT_STAGE);
    }
  }, 120_000);
});
