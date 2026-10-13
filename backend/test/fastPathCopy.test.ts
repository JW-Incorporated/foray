import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { forayCopy, preludeItem, runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder, stubFoldedCopy } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import { toChatMessages } from "../src/generation/promptLayout";
import { buildSpinePromptParts, buildSpineFixInstruction, spineReplyText } from "../src/generation/prompts/spine";
import { RawSpineSchema, SPINE_COPY_FIELDS, spineFromReply } from "../src/generation/replySchemas";
import { buildSpineWithReasks } from "../src/generation/buildSpine";
import { InvalidSpineStructureError } from "../src/generation/spineStructure";
import { preSpineIntent as preSpineIntentOrNull, provisionalTitle } from "../src/generation/preSpineIntent";
import { checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { resolvePipelineFlags } from "../src/generation/pipelineFlags";
import { forayIdFor, resetTaxonomyCache } from "../src/generation/resolveTopic";
import { resetTaxonomyFamilyCache } from "../src/generation/taxonomyFamily";
import { houseStyleTitle } from "../src/copy/rules";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { SpineBuilder } from "../src/generation/SpineBuilder";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { GenerationRequest, IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { SpineSchema, type Spine } from "../src/types/spine";

/**
 * GV-67 (docs/roadmap/generation-v2.md, from W4-03): with `foldSpineCopy` on,
 * §4.1 makes no extractIntent call, the spine writes the subject, angle and
 * listener copy, and the Foray's title, summary and id come from the spine.
 * Stubs, a scripted ChatProvider and the in-memory checkpoint store only: no
 * network, no model, no key. Each test names the mutation that turns it red;
 * every one was run.
 */

/** Distinctive on purpose: capitals, stopwords and punctuation, so no
 * keyword list can equal it by accident. */
const PROMPT = "Tell me the WHOLE history of Grilling & Barbecue, smoke pits and all!";

const request: GenerationRequest = { prompt: PROMPT, duration: "short", author_id: "founder-1", visibility: "catalogue" };
const NOW = new Date("2026-10-13T12:00:00.000Z");
const options = { userId: "founder-1", now: () => NOW, topic: "food/grilling-bbq" };
const FOLD = { foldSpineCopy: true };

/** preSpineIntent for a prompt that has keywords (every prompt here does). */
function preSpineIntent(prompt: string): IntentUnderstanding {
  const intent = preSpineIntentOrNull(prompt);
  if (intent === null) throw new Error(`expected keywords in ${JSON.stringify(prompt)}`);
  return intent;
}

function recordingFinalize() {
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

/** The stub understander, with every method it is asked recorded. */
function recordingUnderstander() {
  const calls: string[] = [];
  const stub = new StubPromptUnderstander();
  const understander = new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
  });
  return { understander, calls };
}

/** The stub spine builder with its reply rewritten by `edit` (null: as is;
 * `call` is 0 on the first call), every intent and context it was handed
 * recorded. */
function editingSpineBuilder(edit: ((spine: Spine, call: number) => Spine) | null = null) {
  const builder = new StubSpineBuilder();
  const real = builder.buildSpine.bind(builder);
  const intents: Array<Parameters<SpineBuilder["buildSpine"]>[0]> = [];
  const contexts: Array<Parameters<SpineBuilder["buildSpine"]>[3]> = [];
  builder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
    const call = contexts.length;
    intents.push(args[0]);
    contexts.push(args[3]);
    const spine = await real(...args);
    return edit ? edit(spine, call) : spine;
  };
  return { builder, intents, contexts };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: recordingFinalize().fn,
    ...overrides
  };
}

describe("runForayPipeline with foldSpineCopy: the copy comes from the spine", () => {
  it("never calls extractIntent: the recording understander shows only assessClarity", async () => {
    /* MUTATION THAT KILLS THIS: call `understandPrompt` in the understand
       stage regardless of flags.foldSpineCopy. Ran it: red. */
    const fold = recordingUnderstander();
    const out = await runForayPipeline(request, { ...options, flags: FOLD }, deps({ understander: fold.understander }));
    expect(out.outcome).toBe("generated");
    expect(fold.calls).toEqual(["assessClarity"]);

    /* The flag-off path still asks for the intent. */
    const classic = recordingUnderstander();
    await runForayPipeline(request, options, deps({ understander: classic.understander }));
    expect(classic.calls).toEqual(["assessClarity", "extractIntent"]);
  });

  it("hands the spine call the listener's words and the keyword intent, and only on the folded path", async () => {
    /* MUTATION THAT KILLS THIS: build spineCtx as `ctx` on both paths (no
       listenerPrompt), or have understandPromptFast return extractIntent's
       restatement (the spine is then handed the classic intent). Ran both: red. */
    const fold = editingSpineBuilder();
    await runForayPipeline(request, { ...options, flags: FOLD }, deps({ spineBuilder: fold.builder }));
    expect(fold.contexts.length).toBeGreaterThan(0);
    for (const ctx of fold.contexts) expect(ctx.listenerPrompt).toBe(PROMPT);
    for (const intent of fold.intents) expect(intent).toEqual(preSpineIntent(PROMPT));

    const classic = editingSpineBuilder();
    await runForayPipeline(request, options, deps({ spineBuilder: classic.builder }));
    for (const ctx of classic.contexts) expect(ctx).not.toHaveProperty("listenerPrompt");
    const restated = await new StubPromptUnderstander().extractIntent(PROMPT, { userId: options.userId });
    expect(classic.intents.length).toBeGreaterThan(0);
    for (const intent of classic.intents) expect(intent).toEqual(restated);
  });

  it("takes the title and summary from the spine reply through forayCopy's clamp and house style, and mints the id from the spine title", async () => {
    /* MUTATION THAT KILLS THIS: run forayCopy on the intent on the folded
       path too (the title is then the keyword list's), or seed forayIdFor
       with `title` instead of `mintedFrom`. Ran both: red. */
    const longSummary = "A very long summary that goes on and on about smoke, fire, pits, sauce, wood, coal, and the people who tend them all night long.";
    const { builder } = editingSpineBuilder((spine) => ({ ...spine, title: "the long road of the backyard grill.", summary: longSummary }));
    const out = await runForayPipeline(request, { ...options, flags: FOLD }, deps({ spineBuilder: builder }));
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);

    expect(out.spine.title).toBe("the long road of the backyard grill.");
    const copy = forayCopy({ subject: out.spine.subject, angle: out.spine.angle, title: out.spine.title!, summary: out.spine.summary! });
    expect(copy.title).toBe("The long road of the backyard grill");
    expect(copy.clamped).toEqual(["summary (25 words)"]);
    expect(out.input.summary.split(" ")).toHaveLength(18);
    expect(out.input.title).toBe(copy.title);
    expect(out.input.summary).toBe(copy.summary);
    expect(out.input.id).toBe(forayIdFor(copy.mintedFrom, NOW.toISOString()));
    expect(out.input.id).toBe(forayIdFor("the long road of the backyard grill.", NOW.toISOString()));
  });

  it("the stub spine writes deterministic copy from its own subject, and the Foray carries it", async () => {
    /* MUTATION THAT KILLS THIS: drop `...(folded ?? {})` from the stub's
       spine (the title then falls back to `subject: angle`). Ran it: red. */
    const out = await runForayPipeline(request, { ...options, flags: FOLD }, deps());
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);
    const keywords = preSpineIntent(PROMPT).subject;
    const stubCopy = stubFoldedCopy(keywords);
    expect(out.spine).toMatchObject({ subject: keywords, ...stubCopy });
    expect(SpineSchema.safeParse(out.spine).success).toBe(true);
    expect(out.input.title).toBe(houseStyleTitle(stubCopy.title));
    expect(out.input.summary).toBe(stubCopy.summary);
    /* No act opens on the pre-spine sentinel. */
    expect(out.spine.acts[0]!.startState).toBe(stubCopy.priorKnowledge);
  });

  it("the prelude names spine.subject, not the intent's keyword list, at all three places it is built", async () => {
    /* MUTATION THAT KILLS THIS: pass `intent.subject` to preludeItem at any
       one of its three call sites: the early prelude onItemReady sees
       (`const prelude = preludeItem(...)`), the partial candidate's
       (`itemsWithDisclosure`), or the final items'. Ran each: red. */
    const SUBJECT = "Fire, smoke and the American backyard";
    const { builder } = editingSpineBuilder((spine) => ({ ...spine, subject: SUBJECT }));
    const early: Array<{ index: number; item: unknown }> = [];
    const partials: Array<{ items: unknown[] }> = [];
    const out = await runForayPipeline(
      request,
      { ...options, flags: FOLD, emitPreludeEarly: true },
      deps({
        spineBuilder: builder,
        onItemReady: (ev: { index: number; item: unknown }) => void early.push(ev),
        onActReady: (candidate: { items: unknown[] }) => void partials.push(candidate)
      })
    );
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);
    const expected = preludeItem(SUBJECT, out.spine.overview, out.input.slots[0]!.id);
    /* The early prelude: the first item event, index 0. */
    expect(early[0]!.index).toBe(0);
    expect(early[0]!.item).toEqual(expected);
    /* The first partial candidate's opening item. */
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0]!.items[0]).toEqual(expected);
    /* The final candidate's. */
    const prelude = out.input.items[0]!;
    expect(prelude).toEqual(expected);
    expect((prelude as { script: string }).script).toContain(`This is a Foray about ${SUBJECT}.`);
    expect((prelude as { script: string }).script).not.toContain(`This is a Foray about ${preSpineIntent(PROMPT).subject}`);
  });

  it("the verbatim prompt appears in no banked checkpoint value, no outcome field and no candidate field", async () => {
    /* MUTATION THAT KILLS THIS: bank `understandPrompt`'s result on the
       folded path (the stub understander restates the prompt verbatim), or
       put `listenerPrompt` on the shared run context (a stage after the spine
       is then handed it). Ran both: red. */
    const flags = resolvePipelineFlags(FOLD);
    const fingerprint = checkpointFingerprint({ prompt: PROMPT, duration: request.duration, topic: options.topic, variant: checkpointRunVariant(flags) });
    const store = new FakeCheckpointStore(fingerprint);
    const finalize = recordingFinalize();
    const deepenBuilder = new StubDeepenActBuilder();
    const realDeepen = deepenBuilder.deepenAct.bind(deepenBuilder);
    const deepenContexts: unknown[] = [];
    deepenBuilder.deepenAct = async (...args: Parameters<StubDeepenActBuilder["deepenAct"]>) => {
      deepenContexts.push(args[3]);
      return realDeepen(...args);
    };
    const out = await runForayPipeline(request, { ...options, flags: FOLD, checkpointKey: "gv67" }, deps({ finalize: finalize.fn, checkpoint: store, deepenBuilder }));
    if (out.outcome !== "generated") throw new Error(`expected generated, got ${out.outcome}`);

    /* The listener's words reach the spine call only: the run context every
       other stage is handed never carries them. */
    expect(deepenContexts.length).toBeGreaterThan(0);
    for (const ctx of deepenContexts) expect(JSON.stringify(ctx)).not.toContain(PROMPT);

    const stages = store.files.get("gv67")!.stages;
    expect(Object.keys(stages)).toEqual(expect.arrayContaining(["understand", "topic", "research-shape", "spine", "identity"]));
    for (const [stage, value] of Object.entries(stages)) {
      expect(JSON.stringify(value), `banked ${stage}`).not.toContain(PROMPT);
    }
    expect(JSON.stringify(out)).not.toContain(PROMPT);
    expect(finalize.seen.length).toBeGreaterThan(0);
    for (const candidate of finalize.seen) expect(JSON.stringify(candidate)).not.toContain(PROMPT);

    /* The scan can see the prompt when it is there: the classic stub
       understander restates it verbatim, and the classic run banks that. */
    const classicStore = new FakeCheckpointStore(checkpointFingerprint({ prompt: PROMPT, duration: request.duration, topic: options.topic }));
    await runForayPipeline(request, { ...options, checkpointKey: "gv67" }, deps({ checkpoint: classicStore }));
    expect(JSON.stringify(classicStore.files.get("gv67")!.stages.understand)).toContain(PROMPT);
  });

  it("a folded run resumes its own banked spine to the same title and id", async () => {
    /* MUTATION THAT KILLS THIS: derive the folded copy from the intent rather
       than the (resumed) spine (`forayCopy(intent)` for the post-spine copy).
       Ran it: red. */
    const TITLE = "the pitmaster's long night.";
    const flags = resolvePipelineFlags(FOLD);
    const store = new FakeCheckpointStore(
      checkpointFingerprint({ prompt: PROMPT, duration: request.duration, topic: options.topic, variant: checkpointRunVariant(flags) })
    );
    const firstBuilder = editingSpineBuilder((spine) => ({ ...spine, title: TITLE }));
    const first = await runForayPipeline(request, { ...options, flags: FOLD, checkpointKey: "k" }, deps({ checkpoint: store, spineBuilder: firstBuilder.builder }));
    const spineBuilder = editingSpineBuilder();
    const second = await runForayPipeline(request, { ...options, flags: FOLD, checkpointKey: "k" }, deps({ checkpoint: store, spineBuilder: spineBuilder.builder }));
    if (first.outcome !== "generated" || second.outcome !== "generated") throw new Error("expected both to generate");
    expect(firstBuilder.contexts.length).toBeGreaterThan(0);
    expect(spineBuilder.contexts).toHaveLength(0);
    expect(second.input.title).toBe(houseStyleTitle(TITLE));
    expect(second.input.title).toBe("The pitmaster's long night");
    expect(second.input.title).toBe(first.input.title);
    expect(second.input.id).toBe(first.input.id);
  });

  it("a folded reply still missing a copy field after the re-asks fails the spine stage with the structural error", async () => {
    /* MUTATION THAT KILLS THIS: drop foldedCopyIssues from
       buildSpineWithReasks' issues (the run then publishes forayCopy's
       `subject: angle` fallback title). Ran it: red. */
    const { builder, contexts } = editingSpineBuilder((spine) => {
      const { title: _dropped, ...rest } = spine;
      return rest;
    });
    const run = runForayPipeline(request, { ...options, flags: FOLD, spineStructuralReasks: 1 }, deps({ spineBuilder: builder }));
    await expect(run).rejects.toBeInstanceOf(InvalidSpineStructureError);
    await expect(run).rejects.toThrow(/^Spine failed the structural check before deepening \(F-13\), so no deepen call was made: the reply has no "title"/);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.revision!.violations).toEqual([expect.stringContaining('"title"')]);
  });
});

describe("runForayPipeline with foldSpineCopy: a stop before the spine", () => {
  const REAL_DATA = join(__dirname, "..", "..", "data");
  const roots: string[] = [];

  function emptyCatalogueRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "gv67-pipeline-"));
    mkdirSync(join(root, "data"));
    copyFileSync(join(REAL_DATA, "taxonomy.json"), join(root, "data", "taxonomy.json"));
    copyFileSync(join(REAL_DATA, "semantic-index.json"), join(root, "data", "semantic-index.json"));
    writeFileSync(join(root, "data", "catalog.json"), JSON.stringify({ shows: [] }));
    roots.push(root);
    return root;
  }

  function episodes(showId: string, n: number): TranscriptDigestEntry[] {
    return Array.from({ length: n }, (_, i) => ({ show_id: showId, show_title: showId, guid: `${showId}-${i + 1}`, title: `${showId} episode ${i + 1}`, cues: 100 }));
  }

  beforeEach(() => {
    resetTaxonomyCache();
    resetTaxonomyFamilyCache();
  });
  afterEach(() => {
    resetTaxonomyCache();
    resetTaxonomyFamilyCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("a no-supply outcome reached before the spine carries provisionalTitle, and no spine is built", async () => {
    /* MUTATION THAT KILLS THIS: title the pre-spine no-supply stop with
       forayCopy(intent).title on the folded path. Ran it: red. */
    const root = emptyCatalogueRoot();
    const spineBuilder = editingSpineBuilder();
    const stop = { transcriptArchive: episodes("zz-unknown-show", 10), segmentPool: [] };
    const out = await runForayPipeline(request, { userId: "founder-1", now: options.now, root, flags: FOLD }, deps({ ...stop, spineBuilder: spineBuilder.builder }));
    expect(out.outcome).toBe("no-supply");
    if (out.outcome !== "no-supply") return;
    expect(out.stoppedBefore).toBe("spine");
    expect(out.title).toBe(provisionalTitle(PROMPT));
    expect(spineBuilder.contexts).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain(PROMPT);

    /* The flag-off stop still names the understander's Foray. */
    const classic = await runForayPipeline(request, { userId: "founder-1", now: options.now, root }, deps(stop));
    if (classic.outcome !== "no-supply") throw new Error(`expected no-supply, got ${classic.outcome}`);
    const intent = await new StubPromptUnderstander().extractIntent(PROMPT, { userId: "founder-1" });
    expect(classic.title).toBe(forayCopy(intent).title);
  });
});

describe("runForayPipeline with foldSpineCopy: a stop after the spine", () => {
  beforeEach(() => {
    resetTaxonomyCache();
    resetTaxonomyFamilyCache();
  });
  afterEach(() => {
    resetTaxonomyCache();
    resetTaxonomyFamilyCache();
  });

  it("an unresolved-topic outcome carries the spine's title in the house style, not the provisional one", async () => {
    /* MUTATION THAT KILLS THIS: title the post-spine unresolved-topic stop
       with `preSpineTitle` (the provisional title). Ran it: red. */
    const TITLE = "the wubble nobody could place.";
    const prompt = "qqzzx wubbleflunk zzzqqx";
    const { builder, contexts } = editingSpineBuilder((spine) => ({ ...spine, title: TITLE }));
    const out = await runForayPipeline({ ...request, prompt }, { userId: "founder-1", now: options.now, flags: FOLD }, deps({ spineBuilder: builder }));
    expect(out.outcome).toBe("unresolved-topic");
    if (out.outcome !== "unresolved-topic") return;
    expect(contexts.length).toBeGreaterThan(0);
    expect(out.title).toBe(houseStyleTitle(TITLE));
    expect(out.title).toBe("The wubble nobody could place");
    expect(out.title).not.toBe(provisionalTitle(prompt));
  });
});

describe("the spine builders on the folded path (scripted ChatProvider)", () => {
  const target = targetFor({ provider: "local", lane: "spark", model: "local-heavy" }, DEFAULT_LANE_PROFILES.spark);
  const guard = { checkAndRecord: async () => undefined };
  const intent = preSpineIntent(PROMPT);
  const researchShape: ResearchShape = {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: "2026-10-13T00:00:00.000Z",
    subtopics: [],
    nonObviousAngle: null,
    externalGapsResearched: []
  };
  const plan = {
    overview: "Smoke, fire and patience.",
    voice: { style: "plain", register: "warm", sentenceRhythm: "short", narratorPresence: "light" },
    acts: [{ title: "Pits", thesis: "t", startState: "s", endState: "e", slots: [{ title: "Pit", beats: [{ claim: "Pits came first.", exploration: false }] }] }]
  };
  const copyReply = {
    subject: "American barbecue",
    angle: "how smoke pits became a national ritual",
    priorKnowledge: "knows ribs and sauce",
    disappointment: "a list of regional sauces",
    answersDisappointment: "Each act follows the pit, not the sauce.",
    title: "How the smoke pit won America",
    summary: "Why barbecue is a story about fire and time."
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("asks with the listener's words and the copy contract first, and returns subject, angle and copy from the reply", async () => {
    /* MUTATION THAT KILLS THIS: return `subject: intent.subject` on the
       folded path in spineFromReply, or drop `listenerPrompt` from
       ChatSpineBuilder's buildSpinePromptParts call. Ran both: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify({ ...copyReply, ...plan })] });
    const spine = await new ChatSpineBuilder(provider, target, guard).buildSpine(intent, researchShape, "short", { userId: "u", listenerPrompt: PROMPT });
    expect(spine).toEqual({ ...copyReply, ...plan, duration: "short", generatedAt: NOW.toISOString() });
    expect(SpineSchema.safeParse(spine).success).toBe(true);

    const parts = buildSpinePromptParts(intent, researchShape, "short", PROMPT);
    expect(provider.requests[0]!.messages).toEqual(toChatMessages(parts));
    expect(parts.foray).toContain(`"${PROMPT}"`);
    expect(parts.foray).not.toContain("not yet known");
    const shape = parts.stable.slice(parts.stable.lastIndexOf("\n") + 1);
    expect(shape.indexOf('"subject"')).toBe(1);
    for (const field of SPINE_COPY_FIELDS) expect(shape.indexOf(`"${field}"`), field).toBeLessThan(shape.indexOf('"overview"'));
    /* The listener's words are in the per-Foray half only: the stable half
       is the same bytes for every folded Foray. */
    expect(parts.stable).toBe(buildSpinePromptParts(intent, researchShape, "short", "something else entirely").stable);
  });

  it("a classic call is unchanged: the classic prompt, subject and angle from the intent, no copy fields even when the reply carries them", async () => {
    /* MUTATION THAT KILLS THIS: treat any reply carrying `subject` as folded
       in spineFromReply. Ran it: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify({ ...copyReply, ...plan })] });
    const spine = await new ChatSpineBuilder(provider, target, guard).buildSpine(intent, researchShape, "short", { userId: "u" });
    expect(spine).toEqual({ subject: intent.subject, angle: intent.angle, ...plan, duration: "short", generatedAt: NOW.toISOString() });
    expect(provider.requests[0]!.messages).toEqual(toChatMessages(buildSpinePromptParts(intent, researchShape, "short")));
    expect(buildSpinePromptParts(intent, researchShape, "short").stable).not.toContain("answersDisappointment");
  });

  /** A plan the structural gate passes for the short tier: the stub's own
   * acts, as a reply would carry them. */
  async function passingPlan() {
    const stub = await new StubSpineBuilder().buildSpine(intent, researchShape, "short", { userId: "u" });
    return { overview: stub.overview, voice: stub.voice, acts: stub.acts };
  }

  it("a folded reply that leaves out or blanks a required copy field is re-asked, naming the fields, and never filled from the keyword intent", async () => {
    /* MUTATION THAT KILLS THIS: drop foldedCopyIssues from
       buildSpineWithReasks' issues (no re-ask), fall back to `intent.subject`
       in spineFromReply, or copy a blank `title` through there. Ran each: red. */
    const passing = await passingPlan();
    const firstReply = { ...copyReply, subject: undefined, title: "  ", summary: "", ...passing };
    const provider = scriptedProvider({ complete: [JSON.stringify(firstReply), JSON.stringify({ ...copyReply, ...passing })] });
    const builder = new ChatSpineBuilder(provider, target, guard);

    /* What the builder makes of the first reply: the missing fields stay
       missing (blank subject, no title or summary), never the intent's. */
    const once = spineFromReply(RawSpineSchema.parse(firstReply), intent, "short", true);
    expect(once.subject).toBe("");
    expect(once.angle).toBe(copyReply.angle);
    expect(once).not.toHaveProperty("title");
    expect(once).not.toHaveProperty("summary");

    const { spine, reasks } = await buildSpineWithReasks(intent, researchShape, "short", builder, { userId: "u", listenerPrompt: PROMPT }, { maxStructuralReasks: 1 });
    expect(reasks).toHaveLength(1);
    expect(reasks[0]!.violations).toHaveLength(3);
    ["subject", "title", "summary"].forEach((field, i) => expect(reasks[0]!.violations[i]).toContain(`"${field}"`));
    expect(reasks[0]!.violations.join(" ")).not.toContain('"angle"');

    /* The re-ask: the reply as the model wrote it (no subject, title or
       summary) and the F-86 fix turn naming the fields. */
    expect(provider.requests).toHaveLength(2);
    const [assistant, fix] = provider.requests[1]!.messages.slice(-2);
    expect(fix).toEqual({ role: "user", content: buildSpineFixInstruction(reasks[0]!.violations) });
    expect(assistant!.role).toBe("assistant");
    expect(Object.keys(JSON.parse(String(assistant!.content)))).toEqual(["angle", "priorKnowledge", "disappointment", "answersDisappointment", "overview", "voice", "acts"]);

    /* What passed is the second reply's copy, and it parses as a Spine. */
    expect(spine).toMatchObject(copyReply);
    expect(SpineSchema.safeParse(spine).success).toBe(true);
  });


  it("a folded re-ask repeats the copy fields first in the assistant turn; a classic re-ask is unchanged", async () => {
    /* MUTATION THAT KILLS THIS: ignore `folded` in spineRevisionTurns. Ran it: red. */
    const previous: Spine = { ...copyReply, ...plan, duration: "short", generatedAt: NOW.toISOString() };
    const revision = { previous, violations: ["act 1, slot 1: claim is 2 sentences"], attempt: 1 };
    const provider = scriptedProvider({ complete: [JSON.stringify({ ...copyReply, ...plan })] });
    await new ChatSpineBuilder(provider, target, guard).buildSpine(intent, researchShape, "short", { userId: "u", listenerPrompt: PROMPT, revision });
    const sent = provider.requests[0]!.messages;
    expect(sent.slice(-2)).toEqual([
      { role: "assistant", content: spineReplyText(previous, true) },
      { role: "user", content: buildSpineFixInstruction(revision.violations) }
    ]);
    expect(Object.keys(JSON.parse(spineReplyText(previous, true)))).toEqual([...SPINE_COPY_FIELDS, "overview", "voice", "acts"]);
    expect(Object.keys(JSON.parse(spineReplyText(previous)))).toEqual(["overview", "voice", "acts"]);
  });
});
