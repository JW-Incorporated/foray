import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ActDeepeningError,
  capArgumentBeats,
  carryBeatSeeds,
  deepenActs,
  deepenedFromSpineAct,
  foldsDeepen
} from "../src/generation/deepenActs";
import type { DeepenActBuilder, DeepenActContext } from "../src/generation/DeepenActBuilder";
import { buildDeepenActPromptParts, DEEPEN_KIND_RULE, INTRODUCTION_EXIT_RULES } from "../src/generation/prompts/deepen";
import { buildSpinePromptParts } from "../src/generation/prompts/spine";
import { RawSpineFoldDeepenSchema, spineFromReply } from "../src/generation/replySchemas";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { toChatMessages } from "../src/generation/promptLayout";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { SpineBuildContext, SpineBuilder } from "../src/generation/SpineBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest, IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import { toNarrationWords } from "../src/copy/narratorStructure";
import { ActSchema, SpineSchema, validateDeepenedAct, type Act, type DeepenedAct, type Spine } from "../src/types/spine";

/**
 * GV-86 (docs/roadmap/generation-v2.md, from W4-05): with
 * FORAY_SPINE_FOLD_DEEPEN in force for the tier, the spine reply carries each
 * act's introduction and exit and each beat's kind, and §4.4 takes such an act
 * as deepened with no deepen call. Fixtures, stubs and a scripted ChatProvider
 * only: no network, no model, no key. Each test names the mutation that turns
 * it red; every one was run.
 */

const ctx: DeepenActContext = { userId: "founder-1" };

/** Run 2's recorded deepen output (introduction, exit and kinds included). */
const RUN2: DeepenedAct[] = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as { acts: DeepenedAct[] }
).acts;

/** The same acts with their introductions and exits already in narration
 * words: three of run 2's four introductions name the Foray's structure ("This
 * act", "the last act"), which validateDeepenedAct refuses, so they predate
 * Q-08. These pass every gate as they are. */
const CLEAN: DeepenedAct[] = RUN2.map((act) => ({
  ...act,
  introduction: toNarrationWords(act.introduction).text,
  exit: toNarrationWords(act.exit).text
}));

/** A deepened act read back as a spine act: what a folded spine reply holds. */
function asSpineAct(act: DeepenedAct): Act {
  const { warnings: _warnings, ...rest } = act;
  return ActSchema.parse(rest);
}

function spineOf(acts: Act[], duration: Spine["duration"] = "short"): Spine {
  return {
    subject: "how AI systems get built",
    angle: "the engineering, not the research",
    overview: "From the notebook to the pager, told by the people who carry it.",
    duration,
    generatedAt: "2026-10-13T00:00:00.000Z",
    voice: { style: "plain", register: "conversational", sentenceRhythm: "short, then long", narratorPresence: "light" },
    acts
  };
}

/** A deepen builder that counts its calls and replies with `reply(act)`. */
function recordingBuilder(reply: (act: Act, index: number) => DeepenedAct = (act) => act as DeepenedAct) {
  const calls: number[] = [];
  const builder: DeepenActBuilder = {
    providerName: "recording",
    async deepenAct(_spine, act, index) {
      calls.push(index);
      return structuredClone(reply(act, index));
    }
  };
  return { builder, calls };
}

/** A slot of four argument beats: the cap (one third, rounded up) is 2. */
function argumentHeavyAct(): Act {
  return {
    title: "What the pager teaches",
    thesis: "Operations is where a model is finally judged.",
    startState: "The listener thinks launch is the finish line.",
    endState: "The listener sees launch as the start of the work.",
    slots: [
      {
        title: "After launch",
        beats: [
          { claim: "Reliability matters more than accuracy once users arrive.", exploration: false, kind: "argument" },
          { claim: "A model nobody monitors is a liability waiting for a date.", exploration: false, kind: "argument" },
          { claim: "Teams should budget for retraining before they budget for research.", exploration: true, kind: "argument" },
          {
            claim: "The on-call rota decides more about quality than the architecture does.",
            exploration: false,
            kind: "argument",
            seed: { episodeId: "ep-pager", startSec: 120, endSec: 150 }
          }
        ]
      }
    ],
    introduction: "Launch day feels like an ending, and it is the opposite.",
    exit: "Which leaves the question of who pays for all of it."
  };
}

describe("deepenActs with fromSpine: an act the spine already deepened costs no deepen call", () => {
  it("takes every act from the spine, never calls the builder, and returns the spine act with seeds carried and arguments capped", async () => {
    /* MUTATION THAT KILLS THIS: drop the `fromSpine` branch from deepenActs
       (every act then goes to the builder), or drop capArgumentBeats from
       deepenedFromSpineAct's tail. Ran both: red. */
    const acts = [argumentHeavyAct(), asSpineAct(CLEAN[0]!)];
    const { builder, calls } = recordingBuilder();
    const folded: number[] = [];
    const saved: number[] = [];
    const out = await deepenActs(spineOf(acts), builder, ctx, {
      fromSpine: () => true,
      onActFolded: (i) => folded.push(i),
      onActDeepened: (i) => {
        saved.push(i);
      }
    });

    expect(calls).toEqual([]);
    expect(folded).toEqual([0, 1]);
    expect(saved).toEqual([0, 1]);
    for (const [i, act] of acts.entries()) {
      expect(out[i]).toEqual(capArgumentBeats(carryBeatSeeds(act, act as DeepenedAct)));
    }
    /* The cap really fired on act 0: two of four arguments re-tagged, the seed kept. */
    expect(out[0]!.slots[0]!.beats.map((b) => b.kind)).toEqual(["argument", "argument", "account", "account"]);
    expect(out[0]!.slots[0]!.beats[3]!.seed).toEqual({ episodeId: "ep-pager", startSec: 120, endSec: 150 });
    expect(out[0]!.warnings).toHaveLength(1);
    expect(out[0]!.introduction).toBe(acts[0]!.introduction);
  });

  it("a spine act missing its introduction or its exit falls back to exactly one deepen call", async () => {
    /* MUTATION THAT KILLS THIS: return the act unchecked (`act as
       DeepenedAct`) when a field is missing, or skip the builder after a null
       fold. Ran both: red. */
    const complete = asSpineAct(CLEAN[0]!);
    const { exit: _exit, ...noExit } = asSpineAct(CLEAN[1]!);
    const { introduction: _intro, ...noIntro } = asSpineAct(CLEAN[2]!);
    const { builder, calls } = recordingBuilder((_act, index) => CLEAN[index]!);
    const folded: number[] = [];
    const out = await deepenActs(spineOf([complete, noExit, noIntro]), builder, ctx, { fromSpine: () => true, onActFolded: (i) => folded.push(i) });

    expect(calls.sort()).toEqual([1, 2]);
    expect(folded).toEqual([0]);
    expect(out[1]!.exit).toBe(CLEAN[1]!.exit);
    expect(out[2]!.introduction).toBe(CLEAN[2]!.introduction);
  });

  it("only the indexes fromSpine names are folded; the rest go to the builder as before", async () => {
    /* MUTATION THAT KILLS THIS: ignore the index (`options.fromSpine` truthy
       folds every act). Ran it: red. */
    const acts = CLEAN.slice(0, 3).map(asSpineAct);
    const { builder, calls } = recordingBuilder();
    await deepenActs(spineOf(acts), builder, ctx, { fromSpine: (i) => i === 1 });
    expect(calls.sort()).toEqual([0, 2]);
  });

  it("a folded act already banked is not banked again, and a resumed run folds the same acts", async () => {
    /* MUTATION THAT KILLS THIS: save every folded act regardless of the
       resume, or check `resume` before the fold (the second run then reports
       nothing folded). Ran both: red. */
    const acts = CLEAN.slice(0, 2).map(asSpineAct);
    const bank = new Map<number, DeepenedAct>();
    const run = async () => {
      const folded: number[] = [];
      const saved: number[] = [];
      await deepenActs(spineOf(acts), recordingBuilder().builder, ctx, {
        fromSpine: () => true,
        onActFolded: (i) => folded.push(i),
        resume: (i) => bank.get(i),
        onActDeepened: (i, act) => {
          saved.push(i);
          bank.set(i, act);
        }
      });
      return { folded, saved };
    };
    expect(await run()).toEqual({ folded: [0, 1], saved: [0, 1] });
    expect(await run()).toEqual({ folded: [0, 1], saved: [] });
  });
});

describe("deepenedFromSpineAct: the gates a deepen reply faces (parity with deepenOneActWithRetry)", () => {
  /** The deepen path, with a builder that echoes the act as its reply. */
  async function deepenPath(act: Act) {
    const { builder, calls } = recordingBuilder();
    try {
      const [out] = await deepenActs(spineOf([act]), builder, ctx);
      return { out: out!, calls };
    } catch (error) {
      return { error, calls };
    }
  }

  it("on run 2's recorded acts, folding gives exactly what deepening an identical reply gives", async () => {
    /* MUTATION THAT KILLS THIS: drop capArgumentBeats from the fold's tail
       (run 2 tagged 29 of 35 beats argument). Ran it: red. */
    for (const recorded of CLEAN) {
      const act = asSpineAct(recorded);
      const viaDeepen = await deepenPath(act);
      expect(viaDeepen.calls).toEqual([0]);
      expect(deepenedFromSpineAct(act)).toEqual(viaDeepen.out);
    }
    /* The recorded acts as they were: deepen refuses the three that name the
       structure on its first attempt and repairs them on its last; the fold
       arrives at the same acts. */
    const attempts: number[] = [];
    for (const recorded of RUN2) {
      const act = asSpineAct(recorded);
      const viaDeepen = await deepenPath(act);
      attempts.push(viaDeepen.calls.length);
      expect(deepenedFromSpineAct(act)).toEqual(viaDeepen.out);
    }
    expect(attempts).toEqual([2, 2, 2, 1]);
  });

  it("an introduction that names the Foray's structure is repaired exactly as deepen's last attempt repairs it", async () => {
    /* MUTATION THAT KILLS THIS: return null on the first refusal (no
       spokenIntroductionAndExit repair). Ran it: red. */
    const act: Act = { ...asSpineAct(CLEAN[0]!), introduction: "By the end of this act, the notebook is the smallest part of the job." };
    expect(validateDeepenedAct(act, act as DeepenedAct).valid).toBe(false);

    const viaDeepen = await deepenPath(act);
    expect(viaDeepen.calls).toEqual([0, 0]);
    const folded = deepenedFromSpineAct(act);
    expect(folded).toEqual(viaDeepen.out);
    expect(folded!.introduction).toBe("By the end of this story, the notebook is the smallest part of the job.");
  });

  it("an act the repair cannot save is refused, as deepen refuses it, and costs one deepen call instead of the run", async () => {
    /* MUTATION THAT KILLS THIS: skip the re-validation after the repair (the
       refused act is then returned as folded). Ran it: red. */
    const act: Act = { ...asSpineAct(CLEAN[0]!), introduction: "This Foray has four acts." };
    const viaDeepen = await deepenPath(act);
    expect(viaDeepen.error).toBeInstanceOf(ActDeepeningError);
    expect(deepenedFromSpineAct(act)).toBeNull();

    const { builder, calls } = recordingBuilder(() => CLEAN[0]!);
    const [out] = await deepenActs(spineOf([act]), builder, ctx, { fromSpine: () => true });
    expect(calls).toEqual([0]);
    expect(out!.introduction).toBe(CLEAN[0]!.introduction);
  });

  it("a topic-shaped beat is refused on both paths", async () => {
    /* MUTATION THAT KILLS THIS: return the parsed act without
       validateDeepenedAct. Ran it: red. */
    const recorded = asSpineAct(CLEAN[1]!);
    const act: Act = {
      ...recorded,
      slots: [{ ...recorded.slots[0]!, beats: [{ claim: "Feature stores", exploration: false }] }, ...recorded.slots.slice(1)]
    };
    expect((await deepenPath(act)).error).toBeInstanceOf(ActDeepeningError);
    expect(deepenedFromSpineAct(act)).toBeNull();
  });
});

describe("foldsDeepen: which tiers fold", () => {
  it("off never, short on the short tier only, all on every tier", () => {
    /* MUTATION THAT KILLS THIS: drop the `duration === "short"` test. Ran it: red. */
    for (const duration of ["short", "medium", "long"] as const) {
      expect(foldsDeepen("off", duration)).toBe(false);
      expect(foldsDeepen("short", duration)).toBe(duration === "short");
      expect(foldsDeepen("all", duration)).toBe(true);
    }
  });
});

describe("the folded spine contract shares the deepen prompt's rules", () => {
  const intent: IntentUnderstanding = { subject: "s", angle: "a", priorKnowledge: "p", disappointment: "d" } as IntentUnderstanding;
  const researchShape: ResearchShape = {
    subject: "s",
    angle: "a",
    generatedAt: "2026-10-13T00:00:00.000Z",
    subtopics: [],
    nonObviousAngle: null,
    externalGapsResearched: []
  };
  const ruleLines = [...DEEPEN_KIND_RULE, ...INTRODUCTION_EXIT_RULES.flat()];

  it("the deepen prompt and both folded spine prompts carry every line of the one rules constant; the classic spine prompt carries none", () => {
    /* MUTATION THAT KILLS THIS: leave SPINE_FOLD_DEEPEN_LINES out of the
       folded contract, or write the spine's own copy of the introduction
       rule. Ran both: red. */
    const deepen = buildDeepenActPromptParts(spineOf([asSpineAct(RUN2[0]!)]), asSpineAct(RUN2[0]!), 0).stable;
    const folded = buildSpinePromptParts(intent, researchShape, "short", undefined, true).stable;
    const foldedCopy = buildSpinePromptParts(intent, researchShape, "short", "a listener's words", true).stable;
    const classic = buildSpinePromptParts(intent, researchShape, "short").stable;
    for (const line of ruleLines) {
      expect(deepen, line).toContain(line);
      expect(folded, line).toContain(line);
      expect(foldedCopy, line).toContain(line);
      expect(classic, line).not.toContain(line);
    }
    for (const stable of [folded, foldedCopy]) {
      const shape = stable.slice(stable.lastIndexOf("\n") + 1);
      expect(shape).toContain('"kind": "account" | "argument"');
      expect(shape).toContain('"introduction": string, "exit": string');
    }
    expect(classic).not.toContain('"introduction"');
    /* The fold adds to the stable half only: the per-Foray half is the same. */
    expect(buildSpinePromptParts(intent, researchShape, "short", undefined, true).foray).toBe(buildSpinePromptParts(intent, researchShape, "short").foray);
  });
});

describe("ChatSpineBuilder on the folded-deepen path (scripted ChatProvider)", () => {
  const target = targetFor({ provider: "local", lane: "spark", model: "local-heavy" }, DEFAULT_LANE_PROFILES.spark);
  const guard = { checkAndRecord: async () => undefined };
  const intent: IntentUnderstanding = { subject: "AI systems", angle: "the engineering", priorKnowledge: "p", disappointment: "d" } as IntentUnderstanding;
  const researchShape: ResearchShape = {
    subject: "AI systems",
    angle: "the engineering",
    generatedAt: "2026-10-13T00:00:00.000Z",
    subtopics: [],
    nonObviousAngle: null,
    externalGapsResearched: []
  };
  const reply = {
    overview: "From the notebook to the pager.",
    voice: { style: "plain", register: "conversational", sentenceRhythm: "short, then long", narratorPresence: "light" },
    acts: RUN2.slice(0, 2)
  };

  it("asks with the folded contract, is held to spine_fold_deepen, and keeps introduction, exit and kind on the Spine", async () => {
    /* MUTATION THAT KILLS THIS: send schemaName "spine" / RawSpineSchema on
       the folded-deepen call (the fields are then stripped), or drop
       `foldDeepen` from the buildSpinePromptParts call. Ran both: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify(reply)] });
    const spine = await new ChatSpineBuilder(provider, target, guard).buildSpine(intent, researchShape, "short", { userId: "u", foldDeepen: true });
    expect(provider.requests[0]!.responseFormat).toMatchObject({ type: "json_schema", name: "spine_fold_deepen" });
    expect(provider.requests[0]!.messages).toEqual(toChatMessages(buildSpinePromptParts(intent, researchShape, "short", undefined, true)));
    expect(SpineSchema.safeParse(spine).success).toBe(true);
    expect(spine.acts).toEqual(RUN2.slice(0, 2));
  });

  it("a classic call is unchanged: the 'spine' schema, the classic prompt, and the deepen fields stripped", async () => {
    /* MUTATION THAT KILLS THIS: pick the fold schema whenever the reply
       carries the fields. Ran it: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify(reply)] });
    const spine = await new ChatSpineBuilder(provider, target, guard).buildSpine(intent, researchShape, "short", { userId: "u" });
    expect(provider.requests[0]!.responseFormat).toMatchObject({ name: "spine" });
    expect(provider.requests[0]!.messages).toEqual(toChatMessages(buildSpinePromptParts(intent, researchShape, "short")));
    for (const act of spine.acts) {
      expect(act).not.toHaveProperty("introduction");
      expect(act).not.toHaveProperty("exit");
    }
  });

  it("a blank introduction or exit is dropped, so the spine still parses and that act falls back to deepen", () => {
    /* MUTATION THAT KILLS THIS: pass the reply's acts through unfiltered
       (SpineSchema then refuses the blank exit). Ran it: red. */
    const raw = RawSpineFoldDeepenSchema.parse({ ...reply, acts: [{ ...RUN2[0]!, exit: "  " }, RUN2[1]!] });
    const spine = spineFromReply(raw, intent, "short", false);
    expect(SpineSchema.safeParse(spine).success).toBe(true);
    expect(spine.acts[0]).not.toHaveProperty("exit");
    expect(spine.acts[0]!.introduction).toBe(RUN2[0]!.introduction);
    expect(spine.acts[1]).toEqual(RUN2[1]);
    expect(deepenedFromSpineAct(spine.acts[0]!)).toBeNull();
  });
});

describe("runForayPipeline with foldDeepen", () => {
  const NOW = new Date("2026-10-13T12:00:00.000Z");
  const options = { userId: "founder-1", now: () => NOW, topic: "food/grilling-bbq" };
  const request = (duration: GenerationRequest["duration"]): GenerationRequest => ({
    prompt: "The history of grilling and barbecue, smoke pits and all",
    duration,
    author_id: "founder-1",
    visibility: "catalogue"
  });

  /** The stub spine, each act given a clean introduction and exit when the
   * call asked for the fold; every context recorded. */
  function foldingSpineBuilder() {
    const builder = new StubSpineBuilder();
    const real = builder.buildSpine.bind(builder);
    const contexts: SpineBuildContext[] = [];
    builder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
      contexts.push(args[3]);
      const spine = await real(...args);
      if (!args[3].foldDeepen) return spine;
      return {
        ...spine,
        acts: spine.acts.map((act) => ({ ...act, introduction: "Here the story turns to the fire itself.", exit: "Which leaves one question open." }))
      };
    };
    return { builder, contexts };
  }

  function countingDeepen() {
    const stub = new StubDeepenActBuilder();
    const calls: number[] = [];
    const builder: DeepenActBuilder = {
      providerName: "stub",
      deepenAct: (spine, act, index, c) => {
        calls.push(index);
        return stub.deepenAct(spine, act, index, c);
      }
    };
    return { builder, calls };
  }

  function deps(spineBuilder: SpineBuilder, deepenBuilder: DeepenActBuilder) {
    return {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder,
      deepenBuilder,
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize: async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
        ({
          validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
          forayRecord: { id: input.id, generated: true } as never,
          timings: []
        }) as unknown as FinalizeForayResult
    };
  }

  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("short tier, foldDeepen 'short': the spine is asked for the fold and no deepen call is made", async () => {
    /* MUTATION THAT KILLS THIS: pass `fromSpine` only under 'all', or leave
       `foldDeepen` off the spine context. Ran both: red. */
    const spine = foldingSpineBuilder();
    const deepen = countingDeepen();
    const out = await runForayPipeline(request("short"), { ...options, flags: { foldDeepen: "short" } }, deps(spine.builder, deepen.builder));
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);
    expect(spine.contexts.length).toBeGreaterThan(0);
    for (const c of spine.contexts) expect(c.foldDeepen).toBe(true);
    expect(deepen.calls).toEqual([]);
    expect(out.deepenFolded).toEqual(out.spine.acts.map((_, i) => i));
  });

  it("medium tier with foldDeepen 'short' is unchanged: no fold asked, every act deepened, no deepenFolded", async () => {
    /* MUTATION THAT KILLS THIS: fold on any tier when the flag is not 'off'
       (foldsDeepen ignoring the duration). Ran it: red. */
    const spine = foldingSpineBuilder();
    const deepen = countingDeepen();
    const out = await runForayPipeline(request("medium"), { ...options, flags: { foldDeepen: "short" } }, deps(spine.builder, deepen.builder));
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);
    for (const c of spine.contexts) expect(c).not.toHaveProperty("foldDeepen");
    expect(deepen.calls.sort()).toEqual(out.spine.acts.map((_, i) => i));
    expect(out).not.toHaveProperty("deepenFolded");
  });

  it("the default (flag off) is unchanged on the short tier too", async () => {
    /* MUTATION THAT KILLS THIS: default FORAY_SPINE_FOLD_DEEPEN to 'short'
       (pipelineFlags CLASSIC_PIPELINE_FLAGS). Ran it: red. */
    const spine = foldingSpineBuilder();
    const deepen = countingDeepen();
    const out = await runForayPipeline(request("short"), options, deps(spine.builder, deepen.builder));
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);
    for (const c of spine.contexts) expect(c).not.toHaveProperty("foldDeepen");
    expect(deepen.calls.sort()).toEqual(out.spine.acts.map((_, i) => i));
    expect(out).not.toHaveProperty("deepenFolded");
  });
});
