import { describe, it, expect, vi } from "vitest";
import {
  buildSpine,
  buildSpineWithReasks,
  spineStructuralReasks,
  SPINE_STRUCTURAL_REASKS_ENV,
  DEFAULT_SPINE_STRUCTURAL_REASKS
} from "../src/generation/buildSpine";
import { StubSpineBuilder, STUB_TWO_SENTENCE_CLAIM } from "../src/generation/StubSpineBuilder";
import { InvalidSpineStructureError, countSentences } from "../src/generation/spineStructure";
import { AnthropicSpineBuilder, buildSpineFixInstruction, buildSpinePrompt, spineReplyText } from "../src/generation/AnthropicSpineBuilder";
import { runForayPipeline } from "../src/generation/runPipeline";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { makeFakeAnthropicClient, textBlock } from "./helpers/fakeAnthropicClient";
import { allBeats, type DurationTier, type Spine } from "../src/types/spine";
import type { IntentUnderstanding, GenerationRequest } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateOneCandidate, parseArgs } from "../src/cli/generateForays";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import { buildRuntimeFixInstruction, spineConversation, spineRevisionTurns } from "../src/generation/prompts/spine";
import type { SpineBuildContext, SpineBuilder } from "../src/generation/SpineBuilder";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * F-86 (generation run 7 attempt 2, 2026-09-11 ~13:00Z, engineering
 * disasters): after understand and research-shape, the spine's reply failed
 * the structural check (F-13) on ONE beat — act 2 ("The Anatomy of a
 * Defensible Shortcut"), slot "Specs are guesses about the future": a claim of
 * two sentences — and the driver recorded `error` and ended the run. One Opus
 * call lost to a reply a single sentence would have fixed, on a run of 70-odd
 * calls.
 *
 * The rule now: a reply that fails the gate is re-asked ONCE (the env
 * `SPINE_STRUCTURAL_REASKS`, default 1) with the exact violations named,
 * the gate runs again, and only then does the run fail — with the same F-13
 * message. The gate itself is untouched: one sentence per claim stays.
 */

const intent: IntentUnderstanding = {
  subject: "engineering disasters",
  angle: "how defensible shortcuts become catastrophes",
  priorKnowledge: "knows a few famous collapses by name",
  disappointment: "a list of disasters with no mechanism"
};

const researchShape: ResearchShape = {
  subject: intent.subject,
  angle: intent.angle,
  generatedAt: new Date().toISOString(),
  subtopics: [
    {
      label: "the Big Dig ceiling collapse",
      source: "literal-term",
      tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
      controversies: [],
      externalNotes: null,
      externallyResearched: false,
      tapeWindows: [],
      windowsUnavailable: "no transcript text index in this fixture"
    }
  ],
  nonObviousAngle: null,
  externalGapsResearched: []
};

const ctx = { userId: "founder-1", sessionId: "s1" };

function guardAndSink() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 100);
  return { sink, guard };
}

const twoSentenceViolation = /beat claim is 2 sentences, must be one/;

describe("F-86 — the spine is re-asked once with the structural violations named before the run fails", () => {
  it("mutation: a first reply with a two-sentence claim is re-asked once, the re-ask names the violation, and the passing reply is returned with spineReasks = 1", async () => {
    /* MUTATION THAT KILLS THIS: in `buildSpineWithReasks`, throw on the first
       refusal (the pre-F-86 `assertSpineStructure` call). The stub's first
       reply carries the two-sentence claim and the build rejects. Ran it — red. */
    const { sink, guard } = guardAndSink();
    const builder = new StubSpineBuilder(guard, { twoSentenceClaimReplies: 1 });

    const { spine, reasks } = await buildSpineWithReasks(intent, researchShape, "short", builder, ctx, { maxStructuralReasks: 1 });

    expect(reasks).toHaveLength(1);
    expect(reasks[0]!.attempt).toBe(1);
    expect(reasks[0]!.violations).toHaveLength(1);
    expect(reasks[0]!.violations[0]).toMatch(twoSentenceViolation);
    /* The violation names the beat the way the gate does — act, slot, the
       claim's own words — which is what makes it findable in the reply. */
    expect(reasks[0]!.violations[0]).toContain(STUB_TWO_SENTENCE_CLAIM.slice(0, 60));

    /* The builder was handed exactly that, as a revision of the refused reply. */
    expect(builder.revisions).toHaveLength(1);
    expect(builder.revisions[0]!.attempt).toBe(1);
    expect(builder.revisions[0]!.violations).toEqual(reasks[0]!.violations);
    expect(allBeats(builder.revisions[0]!.previous).some((b) => b.claim === STUB_TWO_SENTENCE_CLAIM)).toBe(true);

    /* What came back passed: no beat carries two sentences. */
    for (const beat of allBeats(spine)) expect(countSentences(beat.claim)).toBe(1);

    /* The budget guard saw the re-ask as one more spine call — not zero, not
       a different operation. */
    const events = await sink.all();
    expect(events.filter((e) => e.operation === "spine_build")).toHaveLength(2);
  });

  it("mutation: a second failure fails the run with the same F-13 message, after exactly one re-ask", async () => {
    /* MUTATION THAT KILLS THIS: loop without the `attempt >= maxReasks`
       check. The stub is told to fail twice and then pass, so an uncapped loop
       returns a spine on the third call and the rejection below never comes.
       Ran it — red. */
    const { sink, guard } = guardAndSink();
    const builder = new StubSpineBuilder(guard, { twoSentenceClaimReplies: 2 });

    const run = buildSpineWithReasks(intent, researchShape, "short", builder, ctx, { maxStructuralReasks: 1 });
    await expect(run).rejects.toBeInstanceOf(InvalidSpineStructureError);
    await expect(run).rejects.toThrow(/^Spine failed the structural check before deepening \(F-13\), so no deepen call was made: /);
    await expect(run).rejects.toThrow(twoSentenceViolation);

    expect(builder.revisions).toHaveLength(1);
    expect((await sink.all()).filter((e) => e.operation === "spine_build")).toHaveLength(2);
  });

  it("mutation: re-asks are capped by SPINE_STRUCTURAL_REASKS — 0 fails on the first refusal, 2 survives two", async () => {
    /* MUTATION THAT KILLS THIS: read the default instead of the env in
       `spineStructuralReasks`. `0` below then behaves as `1` and the first
       expectation — no re-ask at all — fails. Ran it — red. */
    expect(spineStructuralReasks(undefined)).toBe(DEFAULT_SPINE_STRUCTURAL_REASKS);
    expect(DEFAULT_SPINE_STRUCTURAL_REASKS).toBe(1);
    expect(spineStructuralReasks("0")).toBe(0);
    expect(spineStructuralReasks(" 2 ")).toBe(2);
    /* A present-but-malformed value throws, naming the variable and never the
       value (`env.ts`'s convention). */
    for (const bad of ["x", "-1", "1.5", ""]) {
      expect(() => spineStructuralReasks(bad)).toThrow(
        `Invalid value for environment variable ${SPINE_STRUCTURAL_REASKS_ENV}: expected a non-negative integer`
      );
    }

    /* Through the environment itself, with no override: 0 restores the
       pre-F-86 behaviour exactly — one call, one refusal, no revision. */
    const before = process.env[SPINE_STRUCTURAL_REASKS_ENV];
    try {
      process.env[SPINE_STRUCTURAL_REASKS_ENV] = "0";
      const zero = new StubSpineBuilder(guardAndSink().guard, { twoSentenceClaimReplies: 1 });
      await expect(buildSpine(intent, researchShape, "short", zero, ctx)).rejects.toBeInstanceOf(InvalidSpineStructureError);
      expect(zero.revisions).toHaveLength(0);

      process.env[SPINE_STRUCTURAL_REASKS_ENV] = "2";
      const two = new StubSpineBuilder(guardAndSink().guard, { twoSentenceClaimReplies: 2 });
      const { reasks } = await buildSpineWithReasks(intent, researchShape, "short", two, ctx);
      expect(reasks.map((r) => r.attempt)).toEqual([1, 2]);
      expect(two.revisions).toHaveLength(2);
    } finally {
      if (before === undefined) delete process.env[SPINE_STRUCTURAL_REASKS_ENV];
      else process.env[SPINE_STRUCTURAL_REASKS_ENV] = before;
    }
  });

  it("mutation: a clean first reply never re-asks", async () => {
    /* MUTATION THAT KILLS THIS: re-ask unconditionally (drop the
       `issues.length === 0` return). The stub is then asked twice for a spine
       that passed the first time. Ran it — red. */
    const { sink, guard } = guardAndSink();
    const builder = new StubSpineBuilder(guard);

    const { reasks } = await buildSpineWithReasks(intent, researchShape, "short", builder, ctx, { maxStructuralReasks: 1 });

    expect(reasks).toEqual([]);
    expect(builder.revisions).toEqual([]);
    expect((await sink.all()).filter((e) => e.operation === "spine_build")).toHaveLength(1);
  });

  it("mutation: the pipeline banks only the passing spine, reports spineReasks and logs the re-ask on the run", async () => {
    /* MUTATION THAT KILLS THIS: bank the builder's raw reply before the gate
       (call `checkpoint.stage` around `builder.buildSpine` instead of around
       `buildSpineWithReasks`). The checkpoint then holds the two-sentence
       claim and the last expectation fails. Ran it — red. */
    const request: GenerationRequest = {
      prompt: "the history of grilling and barbecue",
      duration: "short",
      author_id: "founder-1",
      visibility: "catalogue"
    };
    const options = { userId: "founder-1", now: () => new Date("2026-09-11T13:00:00.000Z"), topic: "food/grilling-bbq", checkpointKey: "f86" };
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));
    const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
      ({
        validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
        forayRecord: { id: input.id, generated: true } as never,
        timings: []
      }) as unknown as FinalizeForayResult;
    const spineBuilder = new StubSpineBuilder(guardAndSink().guard, { twoSentenceClaimReplies: 1 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const out = await runForayPipeline(request, options, {
        understander: new StubPromptUnderstander(),
        researcher: new StubExternalResearcher(),
        spineBuilder,
        deepenBuilder: new StubDeepenActBuilder(),
        narrationWriter: new StubNarrationWriterBuilder(),
        narrationVerifier: new StubNarrationVerifierBuilder(),
        continuityBuilder: new StubContinuityBuilder(),
        finalize,
        checkpoint: store
      });

      expect(out.outcome).toBe("generated");
      if (out.outcome !== "generated") return;
      expect(out.spineReasks).toHaveLength(1);
      expect(out.spineReasks[0]!.violations[0]).toMatch(twoSentenceViolation);

      /* The run log line, at the moment the re-ask was decided on. */
      const lines = log.mock.calls.map((c) => String(c[0]));
      const reaskLine = lines.find((l) => /re-asking once with the violations named \(F-86\)/.test(l));
      expect(reaskLine).toBeDefined();
      expect(reaskLine).toMatch(twoSentenceViolation);

      /* One spine banked, and it is the one that passed. */
      expect(store.saves.filter((s) => s.stage === "spine")).toHaveLength(1);
      const banked = store.files.get("f86")!.stages["spine"] as Spine;
      expect(allBeats(banked).some((b) => b.claim === STUB_TWO_SENTENCE_CLAIM)).toBe(false);
      for (const beat of allBeats(banked)) expect(countSentences(beat.claim)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("mutation: AnthropicSpineBuilder re-sends the prompt, the refused reply and one fix-only-these turn naming the violation, metered as a spine call", async () => {
    /* MUTATION THAT KILLS THIS: ignore `ctx.revision` and send the one-turn
       prompt. The message count below is then 1 and the violation reaches no
       model. Ran it — red. */
    const { sink, guard } = guardAndSink();
    const previous = await new StubSpineBuilder(guard).buildSpine(intent, researchShape, "short", ctx);
    const validRawSpine = { overview: previous.overview, voice: previous.voice, acts: previous.acts };
    const { client, create } = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    const violation =
      'act 2 ("The Anatomy of a Defensible Shortcut"), slot "Specs are guesses about the future": beat claim is 2 sentences, must be one — "The epoxy that held the Big Dig\'s ceiling panels wasn\'t chosen recklessly; it passed the tests it was given. The failure"';

    const builder = new AnthropicSpineBuilder(guard, client);
    const spine = await builder.buildSpine(intent, researchShape, "short", { ...ctx, revision: { previous, violations: [violation], attempt: 1 } });

    expect(spine.acts).toEqual(previous.acts);
    expect(create).toHaveBeenCalledTimes(1);
    const messages = (create.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toBe(buildSpinePrompt(intent, researchShape, "short"));
    expect(messages[1]!.content).toBe(spineReplyText(previous));
    expect(JSON.parse(messages[1]!.content)).toEqual(validRawSpine);
    expect(messages[2]!.content).toBe(buildSpineFixInstruction([violation]));
    expect(messages[2]!.content).toContain(violation);
    expect(messages[2]!.content).toMatch(/FIX ONLY THE FOLLOWING/);
    expect(messages[2]!.content).toMatch(/keep\s+everything else/);

    /* Metered like any spine call: one guard event for the stub's reply, one
       for the re-ask, both `spine_build`. */
    expect((await sink.all()).filter((e) => e.operation === "spine_build")).toHaveLength(2);

    /* And a first call is still the one-turn prompt — the revision shape is
       not sent when there is nothing to revise. */
    const fresh = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    await new AnthropicSpineBuilder(guard, fresh.client).buildSpine(intent, researchShape, "short", ctx);
    expect((fresh.create.mock.calls[0]![0] as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("buildSpineFixInstruction names every violation and restates the rule without loosening it", () => {
    /* MUTATION THAT KILLS THIS: drop the violations from the instruction and
       say "fix the structural problems". The model would then be guessing
       which of thirty beats to touch. */
    const text = buildSpineFixInstruction(["first violation here", "second violation here"]);
    expect(text).toContain("- first violation here");
    expect(text).toContain("- second violation here");
    expect(text).toMatch(/ONE sentence/);
    expect(text).toMatch(/no markdown fences/);
    expect(text.split("\n").length).toBeLessThan(12);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   GV-89 (W4-14): the post-spine runtime check in the pipeline, under
   FORAY_TIER_RUNTIME_CAP, and the runtime fix turn the builders send.
   ──────────────────────────────────────────────────────────────────────────── */

const RUNTIME_CLAIMS = [
  "Pitmasters in Lockhart smoked brisket over post oak for fourteen hours.",
  "Ford turned sawdust from Model T body shops into charcoal briquettes.",
  "Kingsford bought the briquette plant from Ford after the war.",
  "Kansas City sauce leaned on molasses and tomato for its sweetness.",
  "Carolina whole hog cooks mopped the pig with vinegar and red pepper.",
  "Memphis rib joints rubbed their racks with paprika before the dry smoke.",
  "Weber built the kettle grill from a cut marine buoy in Chicago.",
  "Argentine asado cooks raked embers under parrilla grates of iron.",
  "Korean galbi marinated short ribs in pear juice and soy.",
  "Japanese yakitori chefs fanned binchotan under skewered chicken."
];
const RUNTIME_UNRELATED = [
  "Suburban patios signalled prosperity during postwar housing booms.",
  "Hardware stores marketed lighter fluid aggressively nationwide.",
  "Television cooking programmes popularized outdoor entertaining.",
  "Propane tanks displaced older backyard stoves gradually."
];

/** The research map the runtime fixtures are written against: ten 120 s
 * windows from ten episodes, each window's text one of RUNTIME_CLAIMS. */
const runtimeShape: ResearchShape = {
  subject: "the history of grilling",
  angle: "how regional craft and industry met at the grill",
  generatedAt: "2026-10-14T00:00:00.000Z",
  subtopics: [
    {
      label: "barbecue",
      source: "literal-term",
      tape: { signal: "strong", itemCount: 10, showCount: 1, exampleItemIds: [] },
      controversies: [],
      externalNotes: null,
      externallyResearched: false,
      windowsUnavailable: null,
      tapeWindows: RUNTIME_CLAIMS.map((text, i) => ({
        episodeId: `ep-${i}`,
        showTitle: "Smoke Talk",
        episodeTitle: `Episode ${i}`,
        startSec: 100,
        endSec: 220,
        text,
        score: 1
      }))
    }
  ],
  nonObviousAngle: null,
  externalGapsResearched: []
};

type RuntimeBeat = Spine["acts"][number]["slots"][number]["beats"][number];

function runtimeBeat(i: number, seed: boolean): RuntimeBeat {
  return { claim: RUNTIME_CLAIMS[i]!, exploration: i % 3 === 0, ...(seed ? { seed: { episodeId: `ep-${i}`, startSec: 100, endSec: 220 } } : {}) };
}

function runtimeSpine(beats: RuntimeBeat[]): Spine {
  const half = Math.ceil(beats.length / 2);
  return {
    subject: "the history of grilling",
    angle: "how regional craft and industry met at the grill",
    overview: "Smoke, sauce and steel: how a handful of backyard habits travelled the world and back.",
    duration: "short",
    generatedAt: "2026-10-14T00:00:00.000Z",
    voice: { style: "curious", register: "conversational", sentenceRhythm: "varied", narratorPresence: "light" },
    acts: [
      {
        title: "Act 1: Smoke and fire",
        thesis: "Grilling grew out of industry as much as out of regional craft.",
        startState: "The listener thinks of grilling as a timeless backyard habit.",
        endState: "The listener sees the factories and pits behind it.",
        slots: [
          { title: "Pits and sauces", beats: beats.slice(0, half) },
          { title: "Kettles and coals", beats: beats.slice(half) }
        ]
      }
    ]
  };
}

/** As the model wrote it: 4 beats seeded, 6 unseeded whose claims are word
 * for word what a window says. It FITS as written (480 s of tape + 120 s of
 * narration); post-seeding attaches the other 6 windows and it no longer
 * does (1,200 s of tape). */
const fitsUntilPostSeeded = runtimeSpine(RUNTIME_CLAIMS.map((_, i) => runtimeBeat(i, i < 4)));
/** 8 beats, 4 seeded and 4 no window speaks to: fits after post-seeding too. */
const fittingPlan = runtimeSpine([
  ...[0, 1, 2, 3].map((i) => runtimeBeat(i, true)),
  ...RUNTIME_UNRELATED.map((claim, i) => ({ claim, exploration: i % 2 === 0 }))
]);

/** The recording spine builder: scripted replies in order, every context kept. */
class RecordingSpineBuilder implements SpineBuilder {
  readonly providerName = "recording";
  readonly calls: SpineBuildContext[] = [];
  constructor(private readonly replies: Spine[]) {}
  async buildSpine(_i: IntentUnderstanding, _r: ResearchShape, _d: DurationTier, ctx: SpineBuildContext): Promise<Spine> {
    this.calls.push(ctx);
    const next = this.replies.shift();
    if (!next) throw new Error("RecordingSpineBuilder: no reply left");
    return next;
  }
}

describe("GV-89 — the post-spine runtime check re-asks only a spine that cannot fit (FORAY_TIER_RUNTIME_CAP)", () => {
  const request: GenerationRequest = {
    prompt: "the history of grilling and barbecue",
    duration: "short",
    author_id: "founder-1",
    visibility: "catalogue"
  };
  const topic = "food/grilling-bbq";
  const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;

  /** A store with the research map already banked, so §4.3 is asked against
   * the fixture's windows (the stub researcher quotes none). */
  function storeWithMap(key: string): FakeCheckpointStore {
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic }));
    store.save(key, "research-shape", runtimeShape);
    return store;
  }

  async function run(spineBuilder: SpineBuilder, store: FakeCheckpointStore, key: string, tierRuntimeCap: boolean) {
    return runForayPipeline(
      request,
      { userId: "founder-1", now: () => new Date("2026-10-14T08:00:00.000Z"), topic, checkpointKey: key, flags: { tierRuntimeCap } },
      {
        understander: new StubPromptUnderstander(),
        researcher: new StubExternalResearcher(),
        spineBuilder,
        deepenBuilder: new StubDeepenActBuilder(),
        narrationWriter: new StubNarrationWriterBuilder(),
        narrationVerifier: new StubNarrationVerifierBuilder(),
        continuityBuilder: new StubContinuityBuilder(),
        finalize,
        checkpoint: store
      }
    );
  }

  it("mutation: with the cap on, a spine that post-seeding pushes over the ceiling is re-asked exactly once, recorded as a 'runtime' re-ask, and the kept plan is banked", async () => {
    /* MUTATION THAT KILLS THIS: run the runtime check on `built.spine` (before
       postSeedWithFloor) instead of on the post-seeded spine. The plan as
       written fits, so no re-ask is made. Ran it: red. */
    const builder = new RecordingSpineBuilder([fitsUntilPostSeeded, fittingPlan]);
    const store = storeWithMap("gv89-on");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const out = await run(builder, store, "gv89-on", true);
      expect(builder.calls).toHaveLength(2);
      expect(builder.calls[1]!.revision?.kind).toBe("runtime");
      expect("spineReasks" in out).toBe(true);
      if (!("spineReasks" in out)) return;
      expect(out.spineReasks).toHaveLength(1);
      expect(out.spineReasks[0]).toMatchObject({ attempt: 1, kind: "runtime" });
      expect(out.spineReasks[0]!.violations[0]).toMatch(/^the plan's minimum runtime is \d+ s — 10 distinct seeded window\(s\) at 1200 s/);

      /* The banked spine is the plan that fits, and the report carries its numbers. */
      const banked = store.files.get("gv89-on")!.stages["spine"] as Spine;
      expect(allBeats(banked)).toHaveLength(8);
      expect(out.spineRuntime).toBeDefined();
      expect(out.spineRuntime!.lowerBoundSec).toBeLessThanOrEqual(1035);
      expect(out.spineRuntime!.estimateSec).toBeGreaterThanOrEqual(out.spineRuntime!.lowerBoundSec);

      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /re-asking once to drop or merge beats \(GV-89\)/.test(l))).toBe(true);
      expect(lines.some((l) => /^ {2}spine runtime: lower bound \d+s, estimate \d+s, tier band \[765,1035\]$/.test(l))).toBe(true);

      /* A RESUMED spine reports no re-asks (F-86) and spends no call, and
         reports the same runtime numbers, read off the banked spine. */
      const resumedBuilder = new RecordingSpineBuilder([]);
      const resumed = await run(resumedBuilder, store, "gv89-on", true);
      expect(resumedBuilder.calls).toHaveLength(0);
      if (!("spineReasks" in resumed)) throw new Error("resumed run stopped before the spine");
      expect(resumed.spineReasks).toEqual([]);
      expect(resumed.spineRuntime).toEqual(out.spineRuntime);
    } finally {
      log.mockRestore();
    }
  });

  it("mutation: with the cap off (the default), the same spine is not re-asked, but its runtime is still reported", async () => {
    /* MUTATION THAT KILLS THIS: drop the `flags.tierRuntimeCap` test in the
       spine stage. The default run then spends a second spine call. Ran it: red. */
    const builder = new RecordingSpineBuilder([fitsUntilPostSeeded]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const out = await run(builder, storeWithMap("gv89-off"), "gv89-off", false);
      expect(builder.calls).toHaveLength(1);
      if (!("spineReasks" in out)) throw new Error("run stopped before the spine");
      expect(out.spineReasks).toEqual([]);
      expect(out.spineRuntime!.lowerBoundSec).toBeGreaterThanOrEqual(1200);
    } finally {
      log.mockRestore();
    }
  });

  it("mutation: with the cap on, a short spine whose lower bound fits makes no extra call", async () => {
    /* MUTATION THAT KILLS THIS: re-ask whenever the cap is on (drop the
       `spineCannotFit` return in reaskForRuntime). The recording builder then
       shows two calls. Ran it: red. */
    const builder = new RecordingSpineBuilder([fittingPlan]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const out = await run(builder, storeWithMap("gv89-fits"), "gv89-fits", true);
      expect(builder.calls).toHaveLength(1);
      if (!("spineReasks" in out)) throw new Error("run stopped before the spine");
      expect(out.spineReasks).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("mutation: both spine builders send buildRuntimeFixInstruction as the fix turn of a 'runtime' re-ask", async () => {
    /* MUTATION THAT KILLS THIS: drop the `runtime` branch in prompts/spine.ts's
       revisionInstruction (the structural fix turn is then sent). Ran it: red. */
    const violations = ["the plan's minimum runtime is 1205 s", 'act 1, slot 1, beat 1: seeded from [ep-0 100-220s], at least 120 s of tape — "x"'];
    const revision = { previous: fittingPlan, violations, attempt: 1, kind: "runtime" as const };
    const turns = spineRevisionTurns(revision);
    expect(turns).toEqual([
      { role: "assistant", content: spineReplyText(fittingPlan) },
      { role: "user", content: buildRuntimeFixInstruction(violations) }
    ]);
    expect(turns[1]!.content).not.toBe(buildSpineFixInstruction(violations));
    expect(turns[1]!.content).toMatch(/DROP OR MERGE BEATS/);
    expect(turns[1]!.content).toMatch(/Keep the seeds you keep exactly as they are/);
    for (const v of violations) expect(turns[1]!.content).toContain(`- ${v}`);

    /* The Chat builder (decision 9: the only Qwen spine class) appends exactly
       those turns; the Anthropic builder sends spineConversation, which is
       built from the same function. */
    const reply = JSON.stringify({ overview: fittingPlan.overview, voice: fittingPlan.voice, acts: fittingPlan.acts });
    const provider = scriptedProvider({ complete: [reply] });
    const target = targetFor({ provider: "local", lane: "spark", model: "local-heavy" }, DEFAULT_LANE_PROFILES.spark);
    await new ChatSpineBuilder(provider, target, { checkAndRecord: async () => undefined }).buildSpine(intent, researchShape, "short", { ...ctx, revision });
    expect(provider.requests[0]!.messages.slice(-2)).toEqual(turns);
    expect(spineConversation("prompt", revision).slice(1)).toEqual(turns);
  });
});

describe("GV-89 — generateForays writes spineRuntime into the report row", () => {
  it("mutation: an outcome that reached the spine carries spineRuntime into report.json's row; one that did not has none", async () => {
    /* MUTATION THAT KILLS THIS: leave the spineRuntime spread out of the
       report entry in generateOneCandidate. Ran it: red. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-gv89-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const args = parseArgs(["--out", dir, "--duration", "short", "--dry-run"], {});
      const spineRuntime = { lowerBoundSec: 1205, estimateSec: 1290 };
      const reached = await generateOneCandidate({ prompt: "gv-89 reached the spine" }, args, {
        cueProvider: new FileTranscriptCueProvider(),
        runPipeline: async () => ({ outcome: "unresolved-topic", title: "t", candidates: [], spineReasks: [], spineRuntime, timings: [] })
      });
      expect(reached.entry?.spineRuntime).toEqual(spineRuntime);

      const rejected = await generateOneCandidate({ prompt: "gv-89 never reached the spine" }, args, {
        cueProvider: new FileTranscriptCueProvider(),
        runPipeline: async () => ({ outcome: "rejected", category: "c", explanation: "e", timings: [] })
      });
      expect(rejected.entry).toBeDefined();
      expect(rejected.entry).not.toHaveProperty("spineRuntime");
    } finally {
      log.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
