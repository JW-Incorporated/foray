import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { countingNarrationWriterOf, runForayPipeline, slotsFromSpine, runtimeSecFor, showVarietyItemsFor, forayCopy, clampWords, MAX_COPY_WORDS, preludeItem, type RetrievalPreparer } from "../src/generation/runPipeline";
import { sourcingSearches } from "../src/generation/sourceBeats";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { finalizeForay, type FinalizeForayInput, type FinalizeForayResult } from "../src/generation/finalizeForay";
import { stitchForay } from "../src/generation/stitchForay";
import { computeShowVariety, evaluateVeracityGate } from "../src/generation/veracityMetrics";
import { showKeyForItem } from "../src/generation/showIdentity";
import { CheckpointSession, checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { forayIdFor, resetTaxonomyCache } from "../src/generation/resolveTopic";
import { resetTaxonomyFamilyCache, taxonomyLineage, taxonomyRoot } from "../src/generation/taxonomyFamily";
import type { ExternalResearchContext, PassageRetrievalRequest } from "../src/generation/ExternalResearcher";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import type { GenerationRequest } from "../src/types/generation";
import { slugifySlotTitle } from "../src/generation/forayItems";
import { INTERNAL_VOCABULARY, titleStyleProblems } from "../src/copy/rules";
import { SpineSchema, type DeepenedAct, type Spine } from "../src/types/spine";
import type { WrittenAct } from "../src/generation/writeNarration";
import type { EvidenceBeat, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { NarrationWriterBuilder, SeamEditRequest } from "../src/generation/NarrationWriterBuilder";
import type { SpineBuildContext, SpineBuilder } from "../src/generation/SpineBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import { servableThroughAct, servableView, type PartialCandidate } from "../src/generation/partialCandidate";
import { itemKeyOf } from "../src/generation/itemReadiness";
import type { NarrationVerifierBuilder } from "../src/generation/NarrationVerifierBuilder";
import { RunLog, currentCallContext, runWithRunLog, type CallContext } from "../src/generation/runLog";
import { FlagValueError } from "../src/generation/generationFlags";
import { createMessage } from "../src/generation/anthropicCall";
import { getUsageTotals } from "../src/generation/usageTracking";
import { makeFakeAnthropicClient, textBlock } from "./helpers/fakeAnthropicClient";
import { DeliveryTimeline, type ItemReadyEvent } from "../src/generation/deliveryTimeline";
import { PRE_SPINE_SENTINEL, preSpineIntent } from "../src/generation/preSpineIntent";
import { loadCatalogueData, type CatalogueData } from "../src/generation/catalogueLookup";
import { loadSegmentPool, type SegmentRecord } from "../src/generation/segmentPoolLookup";
import { loadTranscriptArchive } from "../src/generation/transcriptArchiveLookup";
import { UnitBudgetExceededError, UnitBudgetGuard, UnitBudgetStopError } from "../src/cost/unitBudget";
import type { DeepenActBuilder } from "../src/generation/DeepenActBuilder";
import { BestOfTwoSpineBuilder } from "../src/generation/bestOfSpine";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import type { DurationTier } from "../src/types/spine";
import { generateOneCandidate, DEFAULT_MAX_RESUMES, type CliArgs } from "../src/cli/generateForays";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { FakeSpineJudge } from "./helpers/fakeSpineJudge";
import { FakeDraftCritic } from "./helpers/fakeDraftCritic";
import { SelfCritiquingNarrationWriter, __swapDraftCriticForTests, joinCheckpointVariant } from "../src/generation/selfCritique";
import { resolvePipelineFlags } from "../src/generation/pipelineFlags";
import { resolveRouting } from "../src/config/stageRouting";
import type { WriterObservation } from "../src/generation/NarrationWriterBuilder";
import { evidenceMemoKey } from "../src/generation/evidencePrefetch";
import { BudgetExceededError, BudgetStopError } from "../src/cost/budgetGuard";

/**
 * THE GAP THIS SUITE COVERS. Every stage §4.0-§4.9 was built and tested on its
 * own, and `docs/curation/generation-pipeline-status.md` recorded that nothing
 * drove them end to end. Per-stage tests cannot catch a chain that does not
 * join: a stage whose output shape drifted from the next stage's input would
 * stay green in isolation forever. These run the whole chain.
 *
 * Every dependency is a Stub, so the suite costs nothing, needs no key, and is
 * deterministic — the same property that lets CI run it on every PR.
 */

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "short",
  author_id: "founder-1",
  visibility: "catalogue"
};

/* The fake §4.9. It records what the chain handed it and reports a clean pass —
   it does NOT re-implement check-forays, and no test below claims it does. Its
   whole job is to let the chaining and mapping tests run on a checkout where
   Vitest cannot load the real `.mjs` checkers (see RunPipelineDeps.finalize).
   The real validator has its own suite, and the last test in this file runs it. */
function recordingFinalize() {
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

/** Can this checkout load the real `.mjs` checkers? CI can; a Windows path with
    a space in it cannot. Probed once so the skip states a fact, not a guess. */
async function checkersLoadable(): Promise<boolean> {
  try {
    await finalizeForay(
      { id: "probe-only", title: "t", topic: "food/grilling-bbq", summary: "s", slots: [], items: [], runtimeSec: 0 }
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A validation refusal means the checkers LOADED and did their job.
    return !/Failed to load url|Invalid or unexpected token|dynamic import callback/.test(msg);
  }
}

function stubDeps() {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: recordingFinalize().fn
  };
}

const options = {
  userId: "founder-1",
  now: () => new Date("2026-09-05T12:00:00.000Z"),
  topic: "food/grilling-bbq"
};

describe("runForayPipeline", () => {
  it("drives all nine stages and produces a finalizable Foray", async () => {
    /* MUTATION THAT KILLS THIS: delete the `stitch` stage's call and pass
       `written` straight to finalize. `items` is then the wrong shape and
       finalize's validation fails. Ran it — red. */
    const out = await runForayPipeline(request, options, stubDeps());

    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    expect(out.input.id).toMatch(/^[a-z0-9-]+$/);
    expect(out.input.topic).toBe("food/grilling-bbq");
    expect(out.input.items.length).toBeGreaterThan(0);
    expect(out.input.slots.length).toBeGreaterThan(0);
  });

  it("records a timing for every stage it ran, in order", async () => {
    /* The one piece of §6.3 that IS built (`StageTimingLog`) is only useful if
       the orchestrator actually feeds it, and a chain that silently skipped a
       stage would still return a Foray.

       MUTATION THAT KILLS THIS: call `sourceBeats(...)` directly instead of
       through `timings.run("source", ...)`. The stage vanishes from the log
       while the pipeline still succeeds. Ran it — red. */
    const out = await runForayPipeline(request, options, stubDeps());
    const names = out.timings.map((t) => t.name);

    /* `narrate` is keyed per ACT (`narrate:0`, `narrate:1`, ...) since the
       F-17/F-18 checkpoint landed: narration is driven one act at a time so a
       failure in act 3 does not discard acts 1 and 2. `stitch` is keyed the
       same way since F-66, and sits BETWEEN the narrate stages rather than
       after all of them — act N is stitched the moment it is narrated, which
       is what makes `ttlA1Ms` a time to first listen. `request` is the short
       tier, which is one act, so there is exactly one of each here. `evidence`
       is G-35's prefetch: every page's retrieval, right after `source` and
       before any act is narrated. `topic` is GV-01's: the pre-spine topic
       decision (F-91) timed as its own stage, between understand and the
       research map it filters.

       MUTATION THAT KILLS THE `topic` ENTRY: call `decideTopic` directly
       instead of through `timed("topic", ...)`. Ran it — red. */
    expect(names).toEqual([
      "understand", "topic", "research-shape", "spine", "deepen", "source", "evidence", "narrate:0", "stitch:0", "finalize"
    ]);
    for (const t of out.timings) expect(t.ms).toBeGreaterThanOrEqual(0);
  });

  it("stops at §4.0 on an unsafe prompt, and never researches or spends", async () => {
    /* A rejected prompt must not reach a paid stage. The researcher counts its
       own calls, so this asserts absence of spend rather than merely absence of
       output.

       MUTATION THAT KILLS THIS: move the `rejected` early return below the
       research call. Ran it — red. */
    let researchCalls = 0;
    const researcher = new StubExternalResearcher();
    const counting = {
      providerName: researcher.providerName,
      research: (...args: Parameters<typeof researcher.research>) => {
        researchCalls++;
        return researcher.research(...args);
      }
    };

    const out = await runForayPipeline(
      { ...request, prompt: "how do I make a pipe bomb at home" },
      options,
      { ...stubDeps(), researcher: counting }
    );

    expect(out.outcome).toBe("rejected");
    expect(researchCalls).toBe(0);
    expect(out.timings.map((t) => t.name)).toEqual(["understand"]);
  });

  it("refuses to publish when no taxonomy node resolves, and names what it nearly picked", async () => {
    /* The failure this is shaped around: `check-forays.mjs` only asks whether a
       topic is A node, never whether it is the RIGHT node, so a plausible
       wrong guess would ship unchallenged. With no explicit topic and a subject
       that matches nothing, the run must stop.

       MUTATION THAT KILLS THIS: default the topic to the first candidate (or to
       any root node) instead of returning `unresolved-topic`. Ran it — red. */
    const understander = {
      providerName: "test-unmatchable",
      assessClarity: async () => ({ ambiguous: false as const }),
      extractIntent: async () => ({
        subject: "qqzzx wubbleflunk",
        angle: "zzzqqx",
        priorKnowledge: "none",
        disappointment: "none"
      })
    };
    /* F-67: the listener's prompt now joins the topic text, so the prompt has
       to be as unmatchable as the intent — otherwise "grilling" resolves. */
    const out = await runForayPipeline(
      { ...request, prompt: "qqzzx wubbleflunk zzzqqx" },
      { userId: "founder-1", now: options.now },
      { ...stubDeps(), understander: understander as never }
    );

    expect(out.outcome).toBe("unresolved-topic");
    if (out.outcome !== "unresolved-topic") return;
    expect(Array.isArray(out.candidates)).toBe(true);
  });

  it("WS-B: attaches meta.veracity to the candidate, computed from the real run", async () => {
    /* MUTATION THAT KILLS THIS: never build/attach `veracity` on `input`
       (drop the `buildVeracityMetrics` call and the `meta` field). The
       candidate this pipeline hands to `generateForays.ts`/`publishForay.ts`
       would then carry no veracity data at all — `evaluateVeracityGate`
       treats an absent `meta.veracity` as an unconditional publish refusal,
       so this is load-bearing, not decorative. Ran the mutant — red. */
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    const veracity = out.input.meta?.veracity;
    expect(veracity).toBeDefined();
    if (!veracity) return;

    // Stub builders make no real Anthropic calls, so real token spend is 0 —
    // a genuine computed number, not a stand-in for "unmeasured" (null).
    expect(veracity.pipelineTokens).toBe(0);
    /* WS-A: the verifier answers F-41's question per page and
       `purposeAccomplished` carries it, so this is a real number now. It
       reads 1.0 on a healthy run by construction — a page that never gets a
       yes is retried, then dropped or fatal — which is what makes it a
       regression alarm rather than a score (see veracityMetrics.ts). */
    expect(veracity.purposeFidelity).toBe(1);
    /* WS-A x WS-B, joined: every page carries the documents it quoted from,
       so the grounded-quote rate is computed rather than null — and it is 1,
       BY CONSTRUCTION, because writeNarration.ts refuses in code any quote
       that is not a verbatim span of a held document. This is the assertion
       that fails if the two workstreams ever stop agreeing on the shape of
       `NarratedBeat.evidence`. */
    expect(veracity.groundedQuoteRate).toBe(1);
    expect(veracity.firstAttemptPassRate).toBe(1);
    expect(typeof veracity.pagesDropped).toBe("number");
    expect(Array.isArray(veracity.tapeRelevanceAnchors)).toBe(true);
    // Stage timings are attached AFTER `finalize` runs (its own internal
    // breakdown, when present, is folded in with a `finalize.` prefix —
    // the stubbed `finalize` here returns none, but the outer pipeline
    // stages, including "finalize" itself, must all be present).
    expect(veracity.stageTimings.map((t) => t.name)).toEqual(
      expect.arrayContaining(["understand", "research-shape", "spine", "deepen", "source", "narrate:0", "stitch:0", "finalize"])
    );
  });

  it("GV-26: the generated outcome carries the publish gate's verdict on its own meta.veracity, and refuses nothing", async () => {
    /* MUTATION THAT KILLS THIS: return a constant verdict instead of
       evaluating it — `{ ok: true, failures: [] }` goes red on the refusing
       run below, `{ ok: false, ... }` on the clean stub run. Ran both — red. */
    const clean = await runForayPipeline(request, options, stubDeps());
    expect(clean.outcome).toBe("generated");
    if (clean.outcome !== "generated") return;
    expect(clean.gate).toEqual(evaluateVeracityGate(clean.input.meta?.veracity));
    expect(clean.gate?.ok).toBe(true);

    /* A verifier that confirms no seam: every page is kept unverified (F-51),
       which the gate refuses — and the run still finishes `generated`. */
    const stub = new StubNarrationVerifierBuilder();
    const refusing = {
      providerName: "stub",
      verifyAct: async (req: Parameters<NarrationVerifierBuilder["verifyAct"]>[0], ctx: Parameters<NarrationVerifierBuilder["verifyAct"]>[1]) => {
        const result = await stub.verifyAct(req, ctx);
        return { ...result, seams: result.seams.map((seam) => ({ ...seam, claimsSupported: false, notes: "rests on nothing held" })) };
      }
    } as NarrationVerifierBuilder;
    const refused = await runForayPipeline(request, options, { ...stubDeps(), narrationVerifier: refusing });
    expect(refused.outcome).toBe("generated");
    if (refused.outcome !== "generated") return;
    expect(refused.gate).toEqual(evaluateVeracityGate(refused.input.meta?.veracity));
    expect(refused.gate?.ok).toBe(false);
  }, 120_000);

  it("GV-26: meta.veracity carries MQ-09 tape yield from §4.5's own rows, and MQ-11 beat coverage", async () => {
    /* MUTATION THAT KILLS THIS: stop passing `sourcingTrace: sourced.sourcingTrace`
       to buildVeracityMetrics — tapeYield comes back null. Ran it — red. */
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const veracity = out.input.meta?.veracity;
    expect(veracity?.tapeYield).not.toBe(null);
    expect(veracity?.tapeYield?.tapeBeats).toBe(veracity?.tapeRelevanceAnchors.length);
    expect(veracity?.tapeYield?.wantedBeats).toBeGreaterThanOrEqual(veracity?.tapeYield?.tapeBeats ?? Infinity);
    expect(veracity && "beatCoverage" in veracity).toBe(true);
  });

  it("gives the Foray a house-style title and mints its id from the title as the understander left it (qa 146)", async () => {
    /* The stub understander gives no title, so the Foray is titled from the
       lower-case prompt: the listener gets "The history of ...", the id is
       the one the pre-style title always minted. MUTATION THAT KILLS THIS:
       seed `forayIdFor` with `title` instead of `mintedFrom` in
       runForayPipeline -> the id expectation goes red. */
    const out = await runForayPipeline(request, options, stubDeps());
    if (out.outcome !== "generated") throw new Error("expected the stub run to generate");
    const intent = await new StubPromptUnderstander().extractIntent(request.prompt, { userId: options.userId });
    const copy = forayCopy(intent);
    expect(out.input.title).toBe(copy.title);
    expect(out.input.title.charAt(0)).toBe("T");
    expect(titleStyleProblems(out.input.title)).toEqual([]);
    expect(out.input.id).toBe(forayIdFor(copy.mintedFrom, options.now().toISOString()));
  });

  it("is deterministic: the same request and clock produce the same Foray id", async () => {
    /* A batch driver that retries a failed prompt must not create a second,
       differently-identified Foray for the same work.

       MUTATION THAT KILLS THIS: seed `forayIdFor` with `Date.now()` instead of
       the passed `generatedAt`. Ran it — red. */
    const a = await runForayPipeline(request, options, stubDeps());
    const b = await runForayPipeline(request, options, stubDeps());
    if (a.outcome !== "generated" || b.outcome !== "generated") throw new Error("expected both to generate");
    expect(a.input.id).toBe(b.input.id);
  });
});

describe("slotsFromSpine", () => {
  const spineWith = (slotTitles: string[][]): Spine =>
    ({
      subject: "s",
      angle: "a",
      duration: "short",
      generatedAt: "2026-09-05T12:00:00.000Z",
      voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
      acts: slotTitles.map((titles, i) => ({
        title: `Act ${i + 1}`,
        thesis: "t",
        slots: titles.map((title) => ({ title }))
      }))
    }) as unknown as Spine;

  it("gives two identically-titled slots distinct ids, keeping the first stable", () => {
    /* check-forays joins items to slots by id, so a duplicate id silently
       reassigns tape to the wrong section. The FIRST occurrence keeps the bare
       slug so a re-run that adds a later duplicate cannot renumber it.

       MUTATION THAT KILLS THIS: drop the `seen` set and return the bare slug
       every time. Ran it — red. */
    const slots = slotsFromSpine(spineWith([["Origins"], ["Origins"]]));
    expect(slots.map((s) => s.id)).toEqual(["origins", "origins-2"]);
    expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
  });

  it("rewrites the pipeline's own words out of a slot title, keeping the raw title's id", () => {
    /* PR #741 review: check-forays refuses "the last act" or "Act one" in a slot
       title (rules.js INTERNAL_VOCABULARY) at the per-act partial check and at
       finalize — after the spend — and the spine model writes slot titles
       freely. The listener's title is rewritten here; the id is NOT, because
       stitchAct and partialProjection slugify the spine's own slot.title to
       join items to slots.

       MUTATION THAT KILLS THIS: push `slot.title` instead of the rewrite ->
       red on the title; slug the rewrite instead of the raw title -> red on
       the id. */
    const slots = slotsFromSpine(spineWith([["The last act: who got the credit", "When regulators failed to act"]]));
    expect(slots[0]).toEqual({ id: slugifySlotTitle("The last act: who got the credit"), title: "The last part: who got the credit" });
    expect(slots[1]).toEqual({ id: slugifySlotTitle("When regulators failed to act"), title: "When regulators failed to act" });
    for (const slot of slots) for (const rx of INTERNAL_VOCABULARY) expect(slot.title).not.toMatch(rx);
  });
});

describe("runtimeSecFor", () => {
  const pool = [
    { id: "ep#100", item_id: "ep", start_sec: 100, end_sec: 190 },
    { id: "ep#400", item_id: "ep", start_sec: 400, end_sec: 430 }
  ] as never;

  it("resolves a tape item's length from the segment pool, not from the item", () => {
    /* THE BUG THIS PINS. A `ForayItem` carries no duration — `forayItems.ts`
       strips startSec/endSec on the way out, because forays.json REFERENCES a
       segment rather than restating it. A first version read `duration_sec`
       straight off the items and summed every Foray to zero; check-forays said
       so on all three prompts of the first end-to-end run
       ("`runtime_sec` says 0.00 but the items sum to 1047.65").

       MUTATION THAT KILLS THIS: read `rec.duration_sec` for a segment item
       instead of looking it up in the pool. Every sum returns 0. Ran it — red. */
    const items = [{ type: "segment", segment_id: "ep#100", slot: "s" }] as never;
    expect(runtimeSecFor(items, pool)).toBe(90);
  });

  it("estimates narration from its script at the one shared rate", () => {
    /* 17 chars/sec is `NARRATION_CHARS_PER_SEC`, the single constant
       player/foray-queue.js, check-forays.mjs and forayItems.ts all derive from.
       A second rate here would drift and surface as a publish-blocking runtime
       mismatch rather than as an obviously wrong number.

       MUTATION THAT KILLS THIS: divide by 20 instead of the shared constant.
       Ran it — red. */
    const script = "x".repeat(170);
    const items = [{ type: "narration", id: "n1", script, mode: "marker", slot: "s" }] as never;
    expect(runtimeSecFor(items, pool)).toBe(10);
  });

  it("contributes nothing for a segment the pool does not have, rather than guessing", () => {
    /* An unresolvable reference is check-forays' error to report, with a far
       better message than a runtime mismatch. Inventing a length here would
       hide it behind a second, wronger failure.

       MUTATION THAT KILLS THIS: fall back to a default duration when the
       lookup misses. Ran it — red. */
    const items = [{ type: "segment", segment_id: "not-in-pool#1", slot: "s" }] as never;
    expect(runtimeSecFor(items, pool)).toBe(0);
  });

  it("sums tape and narration together — the listener's clock, not the tape's", () => {
    const items = [
      { type: "narration", id: "n1", script: "x".repeat(170), mode: "marker", slot: "s" },
      { type: "segment", segment_id: "ep#100", slot: "s" },
      { type: "segment", segment_id: "ep#400", slot: "s" }
    ] as never;
    expect(runtimeSecFor(items, pool)).toBe(130);
  });
});

describe("runForayPipeline — the tier-2 tape the candidate has to carry (F-49)", () => {
  it("hands finalize the segments and source rows §4.5 minted this run", async () => {
    /* A tier-2 pointer names a segment that is in no file on disk yet. Unless
       the candidate carries the minted rows, `check-forays.mjs` cannot resolve
       the id, drops the item before every ordering rule and counts its seconds
       nowhere — so the Foray fails §4.9 the first time sourcing finds any
       tier-2 tape. The stub pipeline mints none, so what is pinned here is the
       PLUMBING: both arrays reach `FinalizeForayInput`.

       MUTATION THAT KILLS THIS: drop `segments`/`segmentSources` from the
       `FinalizeForayInput` literal. Ran it — red (undefined, not an array). */
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(Array.isArray(out.input.segments)).toBe(true);
    expect(Array.isArray(out.input.segmentSources)).toBe(true);
    /* Every minted segment's episode is registered exactly once — the join
       `check-forays.mjs` makes between a pool row and the audio registry. */
    const itemIds = new Set((out.input.segments ?? []).map((s) => s.itemId));
    for (const id of itemIds) {
      expect((out.input.segmentSources ?? []).filter((s) => s.id === id)).toHaveLength(1);
    }
  });
});

describe("runForayPipeline against the REAL §4.9 validator", () => {
  it("produces a candidate the real check-forays/check-narration act on, on their own terms", async () => {
    /* THE ONE TEST THAT DOES NOT FAKE FINALIZE. Everything above proves the
       chain joins and the mapping is right; only this proves the thing the
       chain produces is something §4.9 will actually look at.

       It is skipped — loudly, naming the cause — where Vitest cannot load the
       `.mjs` checkers, which is a Windows checkout under a path containing a
       space (Vite percent-encodes it and then cannot find the file). CI's Linux
       runner has neither problem and runs this. Skipping on a known, named
       environment defect is honest; asserting something weaker so the suite
       goes green everywhere would not be.

       Note it does NOT assert `validation.ok`. Whether a stub-authored Foray
       clears the D-tier editorial rules is a fact about the 212-segment pool,
       not about this module; asserting it would make this test a hostage to
       curation data. What it pins is that the candidate reaches the real
       checkers and comes back with their verdict.

       MUTATION THAT KILLS THIS: return `items: []` from the stitch stage. The
       real check-forays rejects "`items` must be a non-empty ordered array"
       and the errors array stops being empty-or-editorial. Ran it — red. */
    if (!(await checkersLoadable())) {
      console.warn(
        "SKIPPED: this checkout cannot load tools/foray/*.mjs under Vitest " +
        "(path contains a space; see RunPipelineDeps.finalize). CI runs this test."
      );
      return;
    }
    /* Drop the fake finalize so the REAL one runs; `delete` rather than a
       rest-destructure because the discarded binding is an unused variable. */
    const deps = stubDeps();
    delete (deps as { finalize?: unknown }).finalize;
    const out = await runForayPipeline(request, options, deps);
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(out.result.validation).toBeDefined();
    expect(Array.isArray(out.result.validation.checkForaysErrors)).toBe(true);
    expect(out.input.items[0]).toMatchObject({ type: "narration", id: "prelude" });
  });
});

describe("runForayPipeline — the record's own copy cannot fail the copy rule (F-64)", () => {
  const twentySix =
    "The end-to-end engineering pipeline of building and operating machine learning systems in production: " +
    "data preparation, model development, deployment infrastructure, monitoring, and the iterative cycle of refinement";

  it("clamps a summary the understander wrote past 18 words, at a word boundary, and says so", () => {
    /* Run 2 attempt 3: `summary` was this exact 26-word restatement and
       `check-forays.mjs` refused the Foray at finalize, 76 minutes after the
       line was written. MUTATION THAT KILLS THIS: return `intent.subject`
       unclamped from `forayCopy`. Ran it — red on the word count. */
    const copy = forayCopy({ subject: twentySix, angle: "how it is really done" });
    expect(copy.summary.split(/\s+/).length).toBeLessThanOrEqual(MAX_COPY_WORDS);
    expect(copy.summary.endsWith(",")).toBe(false);
    expect(copy.summary.endsWith(":")).toBe(false);
    expect(twentySix.startsWith(copy.summary)).toBe(true);
    expect(copy.clamped.some((c) => c.startsWith("summary (26 words)"))).toBe(true);
  });

  it("keeps the pre-F-64 title shape when the understander gives no title, so minted ids do not move", () => {
    /* The id is minted from `mintedFrom`, the title BEFORE the house style
       (2026-09-24), so raising the first letter for the listener does not move
       an id. The pipeline test below pins that the id really is minted from it. */
    const copy = forayCopy({ subject: "grilling", angle: "the surprising origin story" });
    expect(copy.mintedFrom).toBe("grilling: the surprising origin story");
    expect(copy.title).toBe("Grilling: the surprising origin story");
    expect(copy.summary).toBe("grilling");
    expect(copy.clamped).toEqual([]);
  });

  it("puts the title in the house style — no closing period, a capital first letter — lowercases nothing, and reports what it could not fix", () => {
    /* Wyatt, 2026-09-24, qa 146: "Sentence case, no period, though ? And !
       Are allowed". Code does the safe half (rules.js houseStyleTitle); a
       Title Case title the understander wrote anyway is REPORTED, because code
       cannot tell "Venus" from "Actually". MUTATION THAT KILLS THIS: return
       `mintedFrom` as the title from forayCopy -> the first two cases go red;
       drop the `unstyled` report -> the last goes red. */
    const period = forayCopy({ subject: "s", title: "How Earth got plate tectonics and Venus never did." });
    expect(period.title).toBe("How Earth got plate tectonics and Venus never did");
    expect(period.styled).toHaveLength(1);
    expect(period.unstyled).toEqual([]);
    expect(forayCopy({ subject: "s", title: "Was it worth it?" }).title).toBe("Was it worth it?");
    const titleCase = forayCopy({ subject: "s", title: "How AI Actually Gets Built" });
    expect(titleCase.title).toBe("How AI Actually Gets Built");
    expect(titleCase.unstyled.join(" ")).toMatch(/Title Case/);
  });

  it("prefers the understander's own bounded title and summary when it gave them", () => {
    const copy = forayCopy({
      subject: twentySix,
      angle: "x",
      title: "How Machine Learning Really Ships",
      summary: "Why most of an ML system is plumbing, and what the plumbing has to get right."
    });
    expect(copy.title).toBe("How Machine Learning Really Ships");
    expect(copy.summary).toBe("Why most of an ML system is plumbing, and what the plumbing has to get right.");
    expect(copy.clamped).toEqual([]);
  });

  it("rewrites the pipeline's own words out of the title and summary, and says so", () => {
    /* PR #741 review: nothing told the understander that check-forays refuses
       "eight beats" or "22 segments" in a title or summary, and nothing
       repaired it, so the Foray was refused at the partial check or at
       finalize, after the spend. MUTATION THAT KILLS THIS: drop the
       toListenerWords call from forayCopy -> red on both lines. */
    const copy = forayCopy({
      subject: "barbecue",
      title: "Barbecue: eight beats of a forty-beat history",
      summary: "Nine segments from five shows on how fire made us."
    });
    expect(copy.title).toBe("Barbecue: eight stories of a forty-part history");
    expect(copy.summary).toBe("Nine clips from five shows on how fire made us.");
    expect(copy.rewritten).toHaveLength(2);
    for (const rx of INTERNAL_VOCABULARY) {
      expect(copy.title).not.toMatch(rx);
      expect(copy.summary).not.toMatch(rx);
    }
  });

  it("leaves plain-English uses of beat and act alone (no false positives)", () => {
    const copy = forayCopy({ subject: "the Beat Generation poets", angle: "how underdogs beat incumbents", summary: "When regulators failed to act, poets did." });
    expect(copy.title).toBe("The Beat Generation poets: how underdogs beat incumbents");
    expect(copy.summary).toBe("When regulators failed to act, poets did.");
    expect(copy.rewritten).toEqual([]);
  });

  it("clampWords never invents a word and leaves a short line untouched", () => {
    expect(clampWords("one two three", 5)).toBe("one two three");
    expect(clampWords("one two three four five six", 3)).toBe("one two three");
    expect(clampWords("a b c — d", 3)).toBe("a b c");
  });
});

describe("runForayPipeline — no tape, no Foray, said before narration (F-65)", () => {
  it("stops after §4.5 with a `no-tape` outcome when every beat sourced to narration", async () => {
    /* A grilling spine sourced under a fusion-energy topic: the lineage gate
       (WS-C) refuses every pool segment, so §4.5 hands back zero tape. Before
       F-65 the run went on to narrate, stitch and finalize, and the real
       checker then refused the Foray for "no resolvable segment items" — the
       stop only moved earlier; the verdict is the checker's. MUTATION THAT
       KILLS THIS: delete the `tapeBeats === 0` return in runPipeline.ts —
       the outcome comes back "generated". Ran it — red. */
    const out = await runForayPipeline(request, { ...options, topic: "engineering/energy-fusion" }, stubDeps());
    expect(out.outcome).toBe("no-tape");
    if (out.outcome !== "no-tape") return;
    expect(out.title.length).toBeGreaterThan(0);
    expect(out.sourcing.length).toBeGreaterThan(0);
    expect(out.sourcing.every((line) => /0 tape/.test(line))).toBe(true);
    /* It stopped where it said: no narration stage was timed. */
    expect(out.timings.some((t) => t.name.startsWith("narrate"))).toBe(false);
    expect(out.timings.some((t) => t.name === "source")).toBe(true);
  });

  it("still generates when at least one beat has tape", async () => {
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
  });
});

/**
 * F-66 (docs/curation/generation-run-2026-09-09.md): the streaming partial
 * candidate and `ttlA1Ms` were wired one stage too late.
 *
 * THE MEASUREMENT THAT NAMED IT. Run 2 attempt 3 checkpointed act 1's
 * narration at 18 minutes and did not write a partial candidate until the
 * single `stitch` stage ran at 76 minutes — so `ttlA1Ms`, WS-D2's "time to
 * first listen", came back 4,579,741 ms: the whole run. Nothing about act 1's
 * items needed act 4 to exist; §4.8 was simply the stage after all of §4.7.
 * Now act N is stitched inside the narration loop, the instant act N is
 * narrated.
 *
 * These run the MEDIUM tier deliberately: the short tier is one act, and a
 * one-act Foray cannot tell "stitched as it is narrated" from "stitched at the
 * end" — the two are the same run.
 */
describe("runForayPipeline — each act is stitched as soon as it is narrated (F-66)", () => {
  const multiAct: GenerationRequest = { ...request, duration: "medium" };

  /** A stub narration writer that logs the moment each slot's prose is
   * REQUESTED and HOLDS every slot of every act after the first until
   * `release()` is called. Since G-32 all acts' narration is requested at
   * once, so "act 2 was not yet requested" no longer separates act 1's
   * readiness from the run's; "act 2 could not have finished" does, and a
   * latch is what makes that a fact rather than a race. `isLater` needs the
   * captured spine, so it is consulted per call, not at construction. */
  function latchedWriter(isLater: (actTitle: string) => boolean) {
    const writer = new StubNarrationWriterBuilder();
    /* Q-03: an act's prose is requested through the per-act call, so that
       is the request to log — one per act, keyed by the act's title. */
    const realWriteAct = writer.writeAct.bind(writer);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    writer.writeAct = async (...args: Parameters<StubNarrationWriterBuilder["writeAct"]>) => {
      events.push(`narrate:${args[0].actTitle}`);
      if (isLater(args[0].actTitle)) await held;
      return realWriteAct(...args);
    };
    return { writer, events, release };
  }

  /** Polls `events` for `ready:0`, failing with a sentence rather than a
   * hang when a mutation makes act 1's readiness wait on the held acts. */
  async function waitForAct1Ready(events: string[]): Promise<number> {
    const until = Date.now() + 20_000;
    while (!events.includes("ready:0")) {
      if (Date.now() > until) throw new Error("act 1 never became ready while the later acts' narration was held");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return Date.now();
  }

  /** Captures the frozen spine, which is the only thing that can say which act
   * a slot title belongs to. */
  function capturingSpineBuilder() {
    const builder = new StubSpineBuilder();
    const realBuildSpine = builder.buildSpine.bind(builder);
    const captured: { spine: Spine | null } = { spine: null };
    builder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
      captured.spine = await realBuildSpine(...args);
      return captured.spine;
    };
    return { builder, captured };
  }

  /** `PartialCandidate` carries act statuses, not an index; the act just
   * finished is the last one marked "ready". */
  const readyActIndex = (candidate: PartialCandidate): number =>
    candidate.acts.filter((a) => a.status === "ready").length - 1;

  it("fires onActReady for act 1 while every later act's narration is still held", async () => {
    /* MUTATION THAT KILLS THIS: move the `stitch:<i>` block out of the
       ordered loop in runPipeline.ts and run it over `written` afterwards —
       i.e. exactly the pre-F-66 code. `ready:0` then waits on the held acts,
       which are released only after `ready:0`, and `waitForAct1Ready` fails.
       Ran it — red. */
    const { builder: spineBuilder, captured } = capturingSpineBuilder();
    const isLater = (actTitle: string) => captured.spine!.acts.slice(1).some((a) => a.title === actTitle);
    const { writer, events, release } = latchedWriter(isLater);

    const run = runForayPipeline(multiAct, options, {
      ...stubDeps(),
      spineBuilder,
      narrationWriter: writer,
      onActReady: (candidate) => {
        events.push(`ready:${readyActIndex(candidate)}`);
      }
    });
    await waitForAct1Ready(events);

    /* The whole finding, in one line: act 1 is listenable while act 2 is
       still being written. (G-32: act 2's narration was REQUESTED long
       before this — that is the point of G-32 — but it cannot have finished.) */
    expect(events.filter((e) => e.startsWith("ready:"))).toEqual(["ready:0"]);
    release();

    const out = await run;
    expect(out.outcome).toBe("generated");
    const spine = captured.spine;
    expect(spine).not.toBeNull();
    if (!spine) return;
    expect(spine.acts.length).toBeGreaterThan(1);

    /* The act title is the join between the latch and the act structure
       (Q-03: the writer is called once per act). If the spine ever reuses
       one this test would read a false pass, so it says that out loud
       rather than assuming it. */
    const allActTitles = spine.acts.map((a) => a.title);
    expect(new Set(allActTitles).size).toBe(allActTitles.length);

    const laterActs = new Set(spine.acts.slice(1).map((a) => a.title));
    expect(events.some((e) => e.startsWith("narrate:") && laterActs.has(e.slice("narrate:".length)))).toBe(true);

    // And every act still emits, once, in order — streaming did not lose one.
    expect(events.filter((e) => e.startsWith("ready:"))).toEqual(spine.acts.map((_a, i) => `ready:${i}`));
  }, 60_000);

  it("reports a ttlA1Ms that is act 1's time, not the run's", async () => {
    /* Run 2 attempt 3's ttlA1Ms was the whole run because the clock was read
       inside a stage that could not start until the last act was written.

       MUTATION THAT KILLS THIS: the same one as the test above — stitch after
       the loop instead of inside it. `ready:0` never fires while the later
       acts are held, and the wait fails. Ran it — red. */
    const holdMs = 40;
    const { builder: spineBuilder, captured } = capturingSpineBuilder();
    const isLater = (actTitle: string) => captured.spine!.acts.slice(1).some((a) => a.title === actTitle);
    const { writer, events, release } = latchedWriter(isLater);

    const startedMs = Date.now();
    const run = runForayPipeline(multiAct, options, {
      ...stubDeps(),
      spineBuilder,
      narrationWriter: writer,
      onActReady: (candidate) => {
        events.push(`ready:${readyActIndex(candidate)}`);
      }
    });
    const readyAtMs = await waitForAct1Ready(events);
    /* The later acts stay held a while longer AFTER act 1 is ready, so the
       run's clock and act 1's clock are never within granularity of each
       other. */
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    release();
    const out = await run;
    const totalMs = Date.now() - startedMs;

    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(out.ttlA1Ms).not.toBeNull();
    const ttlA1Ms = out.ttlA1Ms ?? Number.POSITIVE_INFINITY;

    expect(events.filter((e) => e.startsWith("narrate:")).length).toBeGreaterThan(2);

    /* The claim the finding is about: `ttlA1Ms` is act 1's clock. It was read
       at or before the instant `ready:0` was observed (`startedMs` is read
       outside the call, so it is at or before the pipeline's own
       `pipelineStartMs` — conservative rather than flattering), and the run
       went on for at least `holdMs` after that. */
    expect(ttlA1Ms).toBeLessThanOrEqual(readyAtMs - startedMs);
    expect(totalMs - ttlA1Ms).toBeGreaterThanOrEqual(holdMs);
  }, 60_000);

  it("assembles exactly the items one whole-Foray stitchForay call would have, in the same order", async () => {
    /* Act-at-a-time assembly must not move a seam, a jingle or an item. This
       replays §4.8 the OLD way — one `stitchForay` call over the whole Foray —
       against the very inputs this run used, read back out of the checkpoint
       (`deepen:<i>` holds §4.4's acts, `narrate:<i>` §4.7's), and demands the
       same list.

       WHAT IT CAN AND CANNOT CATCH, said plainly: both sides now share
       `ForayStitcher`, so a change to what an act's items ARE moves both
       lists together and this test stays green (`stitchForay.test.ts` and
       `stitchAct.test.ts` are the gates for that). What it does catch is
       everything the new per-act LOOP added: an act paired with the wrong
       narration, an act stitched twice or not at all, items concatenated out
       of act order, a checkpoint round-trip that drops one.

       MUTATION THAT KILLS THIS: hand `stitcher.stitchNextAct` the FIRST
       written act on every pass (`written[0] ?? writtenAct`) instead of the
       act just narrated — the act/index mis-pairing this loop makes newly
       possible. Ran it — red. */
    const key = "f-66-items-unchanged";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: multiAct.prompt, duration: multiAct.duration, topic: options.topic }));

    const out = await runForayPipeline(multiAct, { ...options, checkpointKey: key }, { ...stubDeps(), checkpoint: store });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    const stages = store.files.get(key)?.stages ?? {};
    const perAct = (prefix: string): unknown[] =>
      Object.keys(stages)
        .map((k) => new RegExp(`^${prefix}:(\\d+)$`).exec(k))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((m) => stages[m[0]]);

    const deepened = perAct("deepen") as DeepenedAct[];
    const written = perAct("narrate") as WrittenAct[];
    expect(written.length).toBeGreaterThan(1);
    expect(deepened).toHaveLength(written.length);

    const reference = await stitchForay(
      deepened,
      written,
      { continuity: { builder: new StubContinuityBuilder() } },
      { userId: options.userId }
    );

    /* The disclosure is the one item §4.8 never produces — §4.9 prepends it
       (see `disclosureItem`), on both paths, exactly once. */
    expect(out.input.items[0]).toMatchObject({ type: "narration", id: "prelude" });
    expect(out.input.items.slice(1)).toEqual(reference.items);
  });

  it("a resumed run re-pays for no act's stitching and builds the same Foray (F-17/F-18)", async () => {
    /* Per-act stitch keys must not weaken resume. The continuity agent is the
       only paid call in §4.8, so counting it is counting the bill.

       MUTATION THAT KILLS THIS: call `stitcher.stitchNextAct` directly instead
       of through `stageDetail`, so no `stitch:<i>` key is ever written. The
       second run smooths every boundary again. Ran it — red. */
    const key = "f-66-resume";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: multiAct.prompt, duration: multiAct.duration, topic: options.topic }));

    const first = await runForayPipeline(multiAct, { ...options, checkpointKey: key }, { ...stubDeps(), checkpoint: store });
    expect(first.outcome).toBe("generated");
    if (first.outcome !== "generated") return;

    const actCount = store.stageKeys(key).filter((k) => /^narrate:\d+$/.test(k)).length;
    expect(actCount).toBeGreaterThan(1);
    expect(store.stageKeys(key).filter((k) => /^stitch:\d+$/.test(k))).toHaveLength(actCount);

    let smoothCalls = 0;
    const continuityBuilder = new StubContinuityBuilder();
    const realSmoothSeam = continuityBuilder.smoothSeam.bind(continuityBuilder);
    continuityBuilder.smoothSeam = async (...args: Parameters<ContinuityBuilder["smoothSeam"]>) => {
      smoothCalls++;
      return realSmoothSeam(...args);
    };

    const second = await runForayPipeline(multiAct, { ...options, checkpointKey: key }, { ...stubDeps(), continuityBuilder, checkpoint: store });
    expect(second.outcome).toBe("generated");
    if (second.outcome !== "generated") return;

    expect(smoothCalls).toBe(0);
    expect(second.input.items).toEqual(first.input.items);
  });

  it("validates every partial candidate against the same minted tier-2 tape the final one gets (F-71)", async () => {
    /* THE FINDING. Run 2 attempt 4b's partial candidate reported five `unknown
       segment_id ... — not in data/segments.json` errors and then "no
       resolvable segment items", while the FINAL candidate resolved all five
       and failed on M3/M4 instead. Same items, same checker, different input:
       `buildPartialCandidate`'s finalize call was not handed `sourced.newSegments`
       / `sourced.newSegmentSources`, and a segment cut from a transcript during
       the run is in neither `data/segments.json` nor the registry on disk.

       IDENTITY, NOT EQUALITY. Both calls must be handed the very arrays this
       run's §4.5 produced — asserting `toBe` against `out.input.segments` says
       the partial path reads the same source as the whole-Foray path rather
       than something reconstructed beside it, and it says so on a stub run that
       mints nothing (where every other assertion would be two empty arrays
       agreeing by accident).

       MUTATION THAT KILLS THIS: drop `segments`/`segmentSources` from the
       `buildPartialCandidate` meta literal in `runPipeline.ts` — the pre-F-71
       code. The partial inputs then carry `undefined` while the final one
       carries the arrays. Ran it — red. */
    const finalize = recordingFinalize();
    let partials = 0;
    const out = await runForayPipeline(multiAct, options, {
      ...stubDeps(),
      finalize: finalize.fn,
      onActReady: () => {
        partials++;
      }
    });

    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(partials).toBeGreaterThan(1);
    /* One finalize per act (the partial candidates), one more per NON-FINAL
       act for F-79's projected whole (the last act's partial is the whole, so
       it is not projected), plus the whole-Foray one at the end — every one
       of them handed the same pool. That is 2 × partials. */
    expect(finalize.seen).toHaveLength(partials * 2);
    for (const input of finalize.seen) {
      expect(input.segments).toBe(out.input.segments);
      expect(input.segmentSources).toBe(out.input.segmentSources);
    }
  });
});

describe("runForayPipeline — evidence is prefetched after source, off narration's path (G-35)", () => {
  it("gathers every page's evidence in the `evidence` stage and narration then retrieves nothing of its own; report carries the hit rate", async () => {
    /* MUTATION THAT KILLS THIS: hand `writeNarration` no `evidence` option
       (its pre-G-35 default). It then builds its own gatherer, the injected
       one sees no narration-time calls at all, `retrieval.narrationGathers`
       is 0 and `hitRate` is null. Or: drop the `timed("evidence", ...)` call
       — the injected gatherer is first reached during `narrate:0`, so the
       calls-before-narration count below is 0. */
    const calls: EvidenceBeat[] = [];
    let callsWhenNarrationStarted = -1;
    const evidence: EvidenceGatherer = {
      async gather(beat): Promise<EvidencePack> {
        calls.push(beat);
        return { purpose: beat.claim, beatKind: "account", docs: [] };
      }
    };
    const stub = new StubNarrationWriterBuilder();
    const writer: NarrationWriterBuilder = {
      providerName: stub.providerName,
      writeAct: (request, narrationCtx) => {
        if (callsWhenNarrationStarted < 0) callsWhenNarrationStarted = calls.length;
        return stub.writeAct(request, narrationCtx);
      }
    };

    /* A clock that ticks one millisecond per reading. The report carries the
       fan-out's wall time twice — `timings[].evidence` and
       `retrieval.prefetchMs` — and they must be ONE measurement: with a real
       clock two independent `Date.now()` pairs bracketing the same work agree
       except when a tick lands between their starts, which is a flake (PR
       #623's CI run: `evidence` 1 ms, `prefetchMs` 0). Under this clock every
       reading is distinct, so a second measurement can never coincide with
       the first by luck. MUTATION THAT KILLS THIS: have `prefetch()` keep its
       own `Date.now() - start` as `prefetchMs` instead of taking the stage's
       number (`recordStageMs`) — the two then differ by exactly the readings
       taken between the stage's start and the fan-out's. */
    const realNow = Date.now();
    let tick = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow + tick++);
    let out: Awaited<ReturnType<typeof runForayPipeline>>;
    try {
      out = await runForayPipeline(request, options, { ...stubDeps(), evidence, narrationWriter: writer });
    } finally {
      clock.mockRestore();
    }
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    const names = out.timings.map((t) => t.name);
    expect(names.indexOf("evidence")).toBe(names.indexOf("source") + 1);
    expect(names.indexOf("evidence")).toBeLessThan(names.indexOf("narrate:0"));

    const retrieval = out.input.meta?.veracity?.retrieval;
    expect(retrieval).toBeDefined();
    expect(retrieval!.prefetched).toBeGreaterThan(0);
    expect(retrieval!.failed).toBe(0);
    /* Everything the wrapped gatherer was ever asked for, it was asked for
       BEFORE the first writer call — narration added nothing. */
    expect(callsWhenNarrationStarted).toBe(retrieval!.prefetched);
    expect(calls).toHaveLength(retrieval!.prefetched);
    expect(retrieval!.narrationGathers).toBeGreaterThan(0);
    expect(retrieval!.narrationHits).toBe(retrieval!.narrationGathers);
    expect(retrieval!.hitRate).toBe(1);
    /* One measurement, reported twice — see the ticking clock above. */
    const evidenceStage = out.timings.find((t) => t.name === "evidence")!;
    expect(evidenceStage.ms).toBeGreaterThan(0);
    expect(retrieval!.prefetchMs).toBe(evidenceStage.ms);
  });
});

/**
 * F-91 (docs/curation/generation-run-2026-09-09.md): the topic is decided
 * BEFORE the research map and the spine, with the archive in view.
 *
 * Run 8 resolved "how engineering careers really work" to `business/careers`
 * on one token, the lineage gate then refused the only show about the subject,
 * and the run spent an Opus call and four Sonnet calls before §4.5 could say
 * NO TAPE. Three things have to hold now: a subject the archive cannot carry
 * stops before any builder is asked; a subject the archive carries under a
 * lower-scoring candidate proceeds under THAT candidate, and the record says
 * so; a resolution the archive can carry is left alone.
 *
 * Each test runs against a fixture root that holds the REAL taxonomy and
 * semantic index with a catalogue of exactly the shows the test names, so
 * what a show is classified as is the test's own statement and not whatever
 * `data/catalog.json` says this week. The module-level catalogue caches are
 * reset around each test so the fixture root neither inherits the real
 * catalogue from an earlier test nor leaks into a later one.
 */
describe("runForayPipeline — supply-aware topic, decided before the spine (F-91)", () => {
  const REAL_DATA = join(__dirname, "..", "..", "data");
  const RUN_8_PROMPT =
    "What engineers actually do all day: how engineering careers really work, from the first job and the first failure to leading a team, told by working engineers";
  const roots: string[] = [];

  function fixtureRoot(shows: Array<{ show_id: string; taxonomy_node_ids: string[] }>): string {
    const root = mkdtempSync(join(tmpdir(), "f91-pipeline-"));
    mkdirSync(join(root, "data"));
    copyFileSync(join(REAL_DATA, "taxonomy.json"), join(root, "data", "taxonomy.json"));
    copyFileSync(join(REAL_DATA, "semantic-index.json"), join(root, "data", "semantic-index.json"));
    writeFileSync(join(root, "data", "catalog.json"), JSON.stringify({ shows: shows.map((s) => ({ ...s, title: s.show_id })) }));
    roots.push(root);
    return root;
  }

  function episodes(showId: string, n: number): TranscriptDigestEntry[] {
    return Array.from({ length: n }, (_, i) => ({ show_id: showId, show_title: showId, guid: `${showId}-${i + 1}`, title: `${showId} episode ${i + 1}`, cues: 100 }));
  }

  /** The stub spine builder, with its one call counted. */
  function countingSpineBuilder() {
    const builder = new StubSpineBuilder();
    const buildSpine = vi.fn(builder.buildSpine.bind(builder));
    builder.buildSpine = buildSpine as unknown as SpineBuilder["buildSpine"];
    return { builder, buildSpine };
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

  it("stops BEFORE the research map and the spine with a `no-supply` outcome when no candidate topic's family has tape", async () => {
    /* A grilling prompt resolves (`food/grilling-bbq`), but the archive holds
       only a show the catalogue knows nothing about — the gate fails closed on
       it — and the pool is empty. MUTATION THAT KILLS THIS: delete the
       `no-supply` return before `research-shape` in runPipeline.ts — the
       spine builder is called and the run ends `no-tape` five stages later. */
    const root = fixtureRoot([]);
    const { builder, buildSpine } = countingSpineBuilder();
    let researchCalls = 0;
    const researcher = new StubExternalResearcher();
    const realResearch = researcher.research.bind(researcher);
    researcher.research = async (...args: Parameters<typeof realResearch>) => {
      researchCalls++;
      return realResearch(...args);
    };
    const out = await runForayPipeline(
      request,
      { userId: "founder-1", now: options.now, root },
      { ...stubDeps(), spineBuilder: builder, researcher, transcriptArchive: episodes("zz-unknown-show", 10), segmentPool: [] }
    );

    expect(out.outcome).toBe("no-supply");
    if (out.outcome !== "no-supply") return;
    expect(out.stoppedBefore).toBe("spine");
    expect(out.reason).toMatch(/^NO SUPPLY: no transcript in the archive is in any candidate topic's family/);
    expect(out.reason).toContain("food/grilling-bbq=0");
    expect(out.topicDecision).toMatchObject({ reason: "no-supply", resolved: "food/grilling-bbq", topic: "food/grilling-bbq", basis: "archive" });
    expect(out.title.length).toBeGreaterThan(0);
    /* Nothing past §4.1 ran: no research, no spine — understand, then the
       topic decision that refused (GV-01 times it as its own stage). */
    expect(buildSpine).not.toHaveBeenCalled();
    expect(researchCalls).toBe(0);
    expect(out.timings.map((t) => t.name)).toEqual(["understand", "topic"]);
  });

  it("run 8: proceeds under the engineering candidate the archive can carry, and the record says what moved it", async () => {
    /* The show nodes are the six run 8's machine reported for *Being an
       Engineer*; 334 episodes of it and nothing else. The resolver still picks
       `business/careers`; the decision moves to the engineering root, the
       spine IS built, and the outcome carries the decision. MUTATION THAT
       KILLS THIS: use `resolvedTopic.resolved` for `topic` instead of
       `topicDecision.topic` — the gate then refuses all 334 and the decision
       on the outcome contradicts the topic sourcing ran under (asserted via
       `reason`). */
    const root = fixtureRoot([
      {
        show_id: "being-an-engineer",
        taxonomy_node_ids: ["engineering", "engineering/energy-fusion", "engineering/precision-mfg", "engineering/disasters", "engineering/energy-grid", "engineering/ai-robotics"]
      }
    ]);
    const { builder, buildSpine } = countingSpineBuilder();
    const out = await runForayPipeline(
      { ...request, prompt: RUN_8_PROMPT },
      { userId: "founder-1", now: options.now, root },
      { ...stubDeps(), spineBuilder: builder, transcriptArchive: episodes("being-an-engineer", 334), segmentPool: [] }
    );

    expect(out.outcome).not.toBe("no-supply");
    expect(out.outcome).not.toBe("unresolved-topic");
    expect(buildSpine).toHaveBeenCalledTimes(1);
    expect("topicDecision" in out).toBe(true);
    if (!("topicDecision" in out)) return;
    expect(out.topicDecision.reason).toBe("supply-aware");
    expect(out.topicDecision.resolved).toBe("business/careers");
    expect(taxonomyRoot(out.topicDecision.topic)).toBe("engineering");
    expect(out.topicDecision.considered.find((c) => c.id === out.topicDecision.topic)?.supply).toBe(334);
    expect(out.topicDecision.considered.find((c) => c.id === "business/careers")?.supply).toBe(0);
  });

  it("leaves a resolution the archive can carry alone, and records it as `best`", async () => {
    /* MUTATION THAT KILLS THIS: skip the `supplyOf(best) >= minSupply` early
       return in `chooseTopic` — with a stand-in or a sibling in play the pick
       could move off a topic that had tape all along. */
    const root = fixtureRoot([{ show_id: "grill-show", taxonomy_node_ids: ["food/grilling-bbq"] }]);
    const { builder, buildSpine } = countingSpineBuilder();
    const out = await runForayPipeline(
      request,
      { userId: "founder-1", now: options.now, root },
      { ...stubDeps(), spineBuilder: builder, transcriptArchive: episodes("grill-show", 5), segmentPool: [] }
    );

    expect(buildSpine).toHaveBeenCalledTimes(1);
    expect("topicDecision" in out).toBe(true);
    if (!("topicDecision" in out)) return;
    expect(out.topicDecision).toMatchObject({ topic: "food/grilling-bbq", resolved: "food/grilling-bbq", reason: "best" });
    expect(out.topicDecision.considered[0]).toMatchObject({ id: "food/grilling-bbq", supply: 5 });
  });
});

describe("runForayPipeline under a RunLog (GV-01)", () => {
  it("records one ok span per stage it timed, and each stage's code runs with its stage, act and tier on the context", async () => {
    /* The deepen fan-out (Promise.all inside deepenActs) and the narration
       gate (createActGate) are the two places an AsyncLocalStorage context
       could be lost; a spy builder in each reads the context it was called
       under.

       MUTATION THAT KILLS THIS: drop the `withCallContext({stage, act})`
       wrapper in `timed()` — the writer sees `stage` undefined. Ran it — red.
       And dropping `appendSpan(name, spanStart, "ok")` leaves the log with no
       spans. Ran it — red. */
    const deps = stubDeps();
    const deepenSeen: CallContext[] = [];
    const writerSeen: CallContext[] = [];
    const deepenBuilder = deps.deepenBuilder;
    const narrationWriter = deps.narrationWriter;
    const log = new RunLog();
    const out = await runWithRunLog(log, () =>
      runForayPipeline(request, options, {
        ...deps,
        deepenBuilder: {
          providerName: deepenBuilder.providerName,
          deepenAct: async (...args: Parameters<typeof deepenBuilder.deepenAct>) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            deepenSeen.push(currentCallContext());
            return deepenBuilder.deepenAct(...args);
          }
        },
        narrationWriter: {
          providerName: narrationWriter.providerName,
          writeAct: async (...args: Parameters<typeof narrationWriter.writeAct>) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            writerSeen.push(currentCallContext());
            return narrationWriter.writeAct(...args);
          }
        }
      })
    );
    expect(out.outcome).toBe("generated");

    const spans = log.stages();
    expect(spans.map((s) => s.name)).toEqual(out.timings.map((t) => t.name));
    expect(spans.every((s) => s.status === "ok" && s.ms === s.endMs - s.startMs && s.ms >= 0)).toBe(true);
    expect(spans.find((s) => s.name === "narrate:0")!.act).toBe(0);
    expect(spans.find((s) => s.name === "deepen")!.act).toBeUndefined();

    expect(deepenSeen.length).toBeGreaterThan(0);
    for (const ctx of deepenSeen) expect(ctx).toMatchObject({ stage: "deepen", tier: "short" });
    expect(writerSeen.length).toBeGreaterThan(0);
    for (const ctx of writerSeen) expect(ctx).toMatchObject({ stage: "narrate:0", act: 0, tier: "short" });
  }, 60_000);

  it("a stage that throws leaves a failed span with its real duration, after the ok spans before it", async () => {
    /* MUTATION THAT KILLS THIS: append the span only on success (drop the
       `appendSpan(name, spanStart, "failed")` in timed's catch) — an aborted
       attempt's log then ends at `spine` and says nothing about where the
       time went. Ran it — red. */
    const log = new RunLog();
    const failingDeepen = {
      providerName: "throwing-deepen",
      deepenAct: async (): Promise<never> => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error("deepen fixture: refused");
      }
    };
    await expect(
      runWithRunLog(log, () => runForayPipeline(request, options, { ...stubDeps(), deepenBuilder: failingDeepen }))
    ).rejects.toThrow(/deepen fixture: refused/);

    const spans = log.stages();
    expect(spans.map((s) => `${s.name}:${s.status}`)).toEqual([
      "understand:ok", "topic:ok", "research-shape:ok", "spine:ok", "deepen:failed"
    ]);
    const deepen = spans.at(-1)!;
    /* The act retries once, so two 15 ms refusals ran before the stage gave up. */
    expect(deepen.ms).toBeGreaterThanOrEqual(20);
    expect(log.spanMs()).toBeGreaterThanOrEqual(deepen.ms);
  }, 60_000);
});

describe("runForayPipeline under a RunLog: per-call records (GV-07)", () => {
  /* Test-local builders: each wraps a Stub and ALSO sends one request through
     the real choke point (createMessage) on a fake client, so the records
     come from where production records them. The Stubs themselves are not
     modified. `tokens` sets each run's usage so two runs can be told apart. */
  function meteredDeps(tokens: { input: number; output: number }) {
    const base = stubDeps();
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => ({
      content: [textBlock("{}")],
      stop_reason: "end_turn",
      usage: { input_tokens: tokens.input, output_tokens: tokens.output }
    }));
    const call = (label: string) =>
      createMessage(client, { model: "fake-model", max_tokens: 64, messages: [{ role: "user", content: label }] }, label);
    const spine = base.spineBuilder;
    const deepen = base.deepenBuilder;
    const writer = base.narrationWriter;
    const verifier = base.narrationVerifier;
    return {
      ...base,
      spineBuilder: {
        providerName: spine.providerName,
        buildSpine: async (...args: Parameters<typeof spine.buildSpine>) => {
          await call("spine");
          return spine.buildSpine(...args);
        }
      },
      deepenBuilder: {
        providerName: deepen.providerName,
        deepenAct: async (...args: Parameters<typeof deepen.deepenAct>) => {
          await call("deepen");
          return deepen.deepenAct(...args);
        }
      },
      narrationWriter: {
        providerName: writer.providerName,
        writeAct: async (...args: Parameters<typeof writer.writeAct>) => {
          await call("writer");
          return writer.writeAct(...args);
        }
      },
      narrationVerifier: {
        providerName: verifier.providerName,
        verifyAct: async (...args: Parameters<typeof verifier.verifyAct>) => {
          await call("verifier");
          return verifier.verifyAct(...args);
        }
      }
    };
  }

  it("each stage's requests are recorded with its stage, act, round and role", async () => {
    /* MUTATION THAT KILLS THIS: drop deepenActs.ts's withCallContext({act:
       index}) — the deepen records carry no act. Ran it — red. */
    const log = new RunLog();
    const out = await runWithRunLog(log, () => runForayPipeline(request, options, meteredDeps({ input: 100, output: 10 })));
    expect(out.outcome).toBe("generated");
    const calls = log.calls();
    expect(calls.map((c) => c.seq)).toEqual(calls.map((_, i) => i));

    const spine = calls.filter((c) => c.label === "spine");
    expect(spine.map((c) => [c.stage, c.reask])).toEqual([["spine", null]]);
    const deepen = calls.filter((c) => c.label === "deepen");
    expect(deepen.length).toBeGreaterThan(0);
    for (const c of deepen) expect(c).toMatchObject({ stage: "deepen", attempt: 0 });
    expect(deepen.map((c) => c.act).sort()).toEqual(deepen.map((_, i) => i));
    const writers = calls.filter((c) => c.label === "writer");
    expect(writers.length).toBeGreaterThan(0);
    for (const c of writers) expect(c).toMatchObject({ role: "writer", attempt: 1, provider: "anthropic", model: "fake-model" });
    for (const c of writers) expect(c.stage).toBe(`narrate:${c.act}`);
    const verifiers = calls.filter((c) => c.label === "verifier");
    expect(verifiers.length).toBeGreaterThan(0);
    for (const c of verifiers) expect(c).toMatchObject({ role: "verifier", attempt: 1 });
    for (const c of verifiers) expect(c.stage).toBe(`narrate:${c.act}`);
  }, 60_000);

  it("pipelineTokens is this run's own log total, even with a second run in the same process", async () => {
    /* Two runs at once, each in its own log, with different usage. The
       process-wide counter is reset by whichever starts last and sums both,
       so only the per-run log gives each run its own number.

       MUTATION THAT KILLS THIS: read pipelineTokens from getUsageTotals()
       again — each run reports the two runs' mixed total. Ran it — red. */
    const logA = new RunLog();
    const logB = new RunLog();
    const [a, b] = await Promise.all([
      runWithRunLog(logA, () => runForayPipeline(request, options, meteredDeps({ input: 100, output: 10 }))),
      runWithRunLog(logB, () => runForayPipeline(request, options, meteredDeps({ input: 7, output: 3 })))
    ]);
    if (a.outcome !== "generated" || b.outcome !== "generated") throw new Error("both runs should generate");
    const totalsA = logA.callTotals();
    const totalsB = logB.callTotals();
    expect(totalsA.calls).toBeGreaterThan(0);
    expect(totalsA.promptTokens).toBe(100 * totalsA.calls);
    expect(totalsB.promptTokens).toBe(7 * totalsB.calls);
    expect(a.input.meta?.veracity?.pipelineTokens).toBe(totalsA.promptTokens + totalsA.outputTokens);
    expect(b.input.meta?.veracity?.pipelineTokens).toBe(totalsB.promptTokens + totalsB.outputTokens);
  }, 120_000);

  it("one run alone: the log total and the process-wide counter agree", async () => {
    const log = new RunLog();
    const out = await runWithRunLog(log, () => runForayPipeline(request, options, meteredDeps({ input: 20, output: 2 })));
    if (out.outcome !== "generated") throw new Error("should generate");
    const totals = log.callTotals();
    expect(out.input.meta?.veracity?.pipelineTokens).toBe(totals.promptTokens + totals.outputTokens);
    expect(getUsageTotals().total).toBe(totals.promptTokens + totals.outputTokens);
    expect(getUsageTotals().calls).toBe(totals.calls);
  }, 60_000);
});

/**
 * GV-14 review: a malformed FORAY_OUTPUT_BUDGETS fails the run LOUDLY at run
 * start, before any builder is asked, because recordModelCall (which runs
 * after a paid reply) deliberately swallows a bad flag rather than cost the
 * reply. Every stub builder is wrapped so any method call is seen.
 */
describe("runForayPipeline — FORAY_OUTPUT_BUDGETS is validated at run start (GV-14)", () => {
  const savedFlag = process.env.FORAY_OUTPUT_BUDGETS;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FORAY_OUTPUT_BUDGETS;
    else process.env.FORAY_OUTPUT_BUDGETS = savedFlag;
  });

  it("rejects with FlagValueError before any builder is called", async () => {
    /* MUTATION THAT KILLS THIS: drop the `outputBudgetMode()` call next to
       resolvePipelineFlags in runParsedPipeline — the run goes on to call the
       understander (and, with the recording guard in place, never fails on
       the flag at all). Ran it — red. */
    process.env.FORAY_OUTPUT_BUDGETS = "bogus";
    const called: string[] = [];
    const spy = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const value = Reflect.get(t, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            called.push(`${name}.${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
      });
    const deps = stubDeps();
    const finalize = deps.finalize;
    const spied = {
      understander: spy("understander", deps.understander),
      researcher: spy("researcher", deps.researcher),
      spineBuilder: spy("spineBuilder", deps.spineBuilder),
      deepenBuilder: spy("deepenBuilder", deps.deepenBuilder),
      narrationWriter: spy("narrationWriter", deps.narrationWriter),
      narrationVerifier: spy("narrationVerifier", deps.narrationVerifier),
      continuityBuilder: spy("continuityBuilder", deps.continuityBuilder),
      finalize: async (input: FinalizeForayInput) => {
        called.push("finalize");
        return finalize(input);
      }
    };
    const log = new RunLog();
    await expect(runWithRunLog(log, () => runForayPipeline(request, options, spied))).rejects.toThrow(FlagValueError);
    expect(called).toEqual([]);
    expect(log.calls()).toEqual([]);
  });
});

describe("runForayPipeline — per-act servability on partial candidates (GV-21)", () => {
  const multiAct: GenerationRequest = { ...request, duration: "medium" };

  function capturingSpine() {
    const builder = new StubSpineBuilder();
    const real = builder.buildSpine.bind(builder);
    const captured: { spine: Spine | null } = { spine: null };
    builder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
      captured.spine = await real(...args);
      return captured.spine;
    };
    return { builder, captured };
  }

  it("every partial carries delivery aligned 1:1 with its items (prelude included), and the final items are unchanged", async () => {
    /* MUTATION THAT KILLS THIS: hand buildPartialCandidate `provenanceSoFar`
       without the prelude record. Every delivery is then misaligned by one
       and alignDelivery serves the prelude only. Ran it — red. */
    const partials: PartialCandidate[] = [];
    const baseline = await runForayPipeline(multiAct, options, stubDeps());
    const out = await runForayPipeline(multiAct, options, { ...stubDeps(), onActReady: (c) => void partials.push(c) });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated" || baseline.outcome !== "generated") return;
    expect(partials.length).toBeGreaterThan(1);
    for (const p of partials) {
      expect(p.delivery).toBeDefined();
      expect(p.delivery!.items.map((d) => d.itemId)).toEqual(p.items.map((it, k) => itemKeyOf(it, k)));
      expect(p.delivery!.items[0]).toMatchObject({ itemId: "prelude", act: -1, check: "prelude" });
      for (const item of p.items) {
        expect(item).not.toHaveProperty("verified");
        expect(item).not.toHaveProperty("pronunciationHints");
      }
      /* The stub verifier passes every page, and unchecked seams play by
         default: the whole partial is servable. */
      expect(p.delivery!.servableThrough).toBe(p.items.length);
      expect(p.acts.filter((a) => a.status === "ready").every((a) => a.served === true && a.veracity?.ok === true)).toBe(true);
    }
    expect(out.input.items).toEqual(baseline.input.items);
  }, 120_000);

  it("a verifier that refuses act 0's seams makes act 0 unservable — and the run, its validation and the abort policy are untouched", async () => {
    /* MUTATION THAT KILLS THIS: make assessAct call every act servable
       (`servable: true`). Act 0 comes back servable. Ran it — red. Second:
       feed the servability verdict into the refusal (`!validation.ok ||
       servableThrough !== items.length` before the abort) — refusedPartial
       "abort" then throws RefusedPartialError and the run never completes.
       Ran it — red. */
    const { builder: spineBuilder, captured } = capturingSpine();
    const stub = new StubNarrationVerifierBuilder();
    const refusing: NarrationVerifierBuilder = {
      providerName: "stub",
      verifyAct: async (request, ctx) => {
        const result = await stub.verifyAct(request, ctx);
        if (request.actTitle !== captured.spine?.acts[0]?.title) return result;
        return {
          ...result,
          seams: result.seams.map((seam) => ({ ...seam, claimsSupported: false, notes: `"${request.seams.find((s) => s.seamId === seam.seamId)?.script.slice(0, 40) ?? ""}" rests on nothing held` }))
        };
      }
    } as NarrationVerifierBuilder;

    const partials: PartialCandidate[] = [];
    const out = await runForayPipeline(multiAct, { ...options, refusedPartial: "abort" }, {
      ...stubDeps(),
      spineBuilder,
      narrationVerifier: refusing,
      onActReady: (c) => void partials.push(c)
    });

    expect(out.outcome).toBe("generated");
    expect(partials.length).toBeGreaterThan(1);
    for (const p of partials) {
      expect(p.validation.ok).toBe(true);
      expect(p.delivery!.acts[0]!.servable).toBe(false);
      expect(p.delivery!.acts[0]!.blockers.some((b) => b.reason === "unverified")).toBe(true);
      expect(p.delivery!.servableThrough).toBe(1);
      expect(servableThroughAct(p.delivery!)).toBe(-1);
      expect(servableView(p)).toEqual([p.items[0]]);
      expect(p.acts[0]!.served).toBe(false);
      expect(p.acts[0]!.veracity?.ok).toBe(false);
    }
  }, 60_000);
});

describe("runForayPipeline — item-ready events and RunLog readiness (GV-33)", () => {
  const multiAct: GenerationRequest = { ...request, duration: "medium" };

  /** A finalize that counts its calls, so a partial build (two finalize runs
   * per act) cannot hide. */
  function countingFinalize() {
    const inner = recordingFinalize();
    let calls = 0;
    const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
      calls++;
      return inner.fn(input);
    };
    return { fn, calls: () => calls };
  }

  it("onItemReady alone: one event per item, indexes 0..n-1 with the prelude first, and no partial finalize", async () => {
    /* MUTATION THAT KILLS THIS: drop the wrapper's `if (!deps.onActReady)`
       early return. The partial path then runs without a callback: a partial
       is finalized and the run fails. Ran it — red. Second: emit the
       prelude with every act (drop `preludeEmitted = true`). The indexes are
       then not strictly increasing and the run throws. Ran it — red. */
    const finalize = countingFinalize();
    const events: ItemReadyEvent[] = [];
    const out = await runForayPipeline(multiAct, options, { ...stubDeps(), finalize: finalize.fn, onItemReady: (ev) => void events.push(ev) });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    expect(new Set(events.map((e) => e.actIndex)).size - 1).toBeGreaterThanOrEqual(3);
    expect(events.map((e) => e.index)).toEqual(out.input.items.map((_it, k) => k));
    expect(events.map((e) => e.itemId)).toEqual(out.input.items.map((it, k) => itemKeyOf(it, k)));
    expect(events.map((e) => e.item)).toEqual(out.input.items);
    expect(events[0]).toMatchObject({ itemId: "prelude", actIndex: -1, check: "prelude", servable: true, playStartSec: 0 });
    expect(events.every((e) => e.forayId === out.input.id && e.servable && e.granularity === "act")).toBe(true);
    /* Each item starts where the items before it end, on the listener's
       clock, and the last one ends at the Foray's runtime (both timed on the
       run's own pool, minted tier-2 rows included). */
    events.slice(1).forEach((e, k) => expect(e.playStartSec).toBeCloseTo(events[k]!.playStartSec + events[k]!.durationSec, 2));
    const last = events[events.length - 1]!;
    expect(last.playStartSec + last.durationSec).toBeCloseTo(out.input.runtimeSec, 2);
    expect(events.filter((e) => e.item.type === "segment").every((e) => e.durationSec > 0)).toBe(true);
    expect(finalize.calls()).toBe(1);
    expect(out.ttlA1Ms).toBeNull();
  }, 120_000);

  it("an injected wallClockMs pins readyAtMs per act, the lead is the hand-computed value, and the Foray id does not move", async () => {
    /* MUTATION THAT KILLS THIS: read the act's ready time from `Date.now()`
       instead of `deps.wallClockMs`. readyAtMs is then wall time, not the
       scripted 5 s steps. Ran it — red. */
    let tick = 0;
    const wallClockMs = () => 1_000_000 + 5_000 * tick++;
    const timeline = new DeliveryTimeline();
    const baseline = await runForayPipeline(multiAct, options, stubDeps());
    const out = await runForayPipeline(multiAct, options, { ...stubDeps(), wallClockMs, onItemReady: (ev) => timeline.record(ev) });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated" || baseline.outcome !== "generated") return;
    expect(out.input.id).toBe(baseline.input.id);
    expect(out.input.items).toEqual(baseline.input.items);

    const events = timeline.events();
    // The start reads tick 0; act k's wrapper reads tick k + 1: ready at 5 s x (k + 1).
    for (const e of events) expect(e.readyAtMs).toBe(5_000 * (Math.max(e.actIndex, 0) + 1));
    /* Playback starts at 5 s with the prelude and act 0. Act 1's first item
       plays at 5 s + its start and was ready at 10 s; every later act is 5 s
       later still and further along, so act 1's first item is the minimum. */
    const act1First = events.find((e) => e.actIndex === 1)!;
    const later = events.filter((e) => e.actIndex >= 1).map((e) => 5 + e.playStartSec - e.readyAtMs / 1000);
    expect(timeline.leadReport().minLeadSec).toBeCloseTo(Math.min(...later), 3);
    expect(timeline.leadReport().minLeadSec).toBeCloseTo(5 + act1First.playStartSec - 10, 3);
  }, 120_000);

  it("without onActReady the RunLog carries one act ReadyEvent per act, in order, whose ids concatenate to the final items", async () => {
    /* MUTATION THAT KILLS THIS: construct the stitcher wrapper only when
       `deps.onActReady` is supplied (the pre-GV-33 code). No ReadyEvent is
       logged. Ran it — red. Second: leave the prelude out of act 0's ids.
       The concatenation is then one short. Ran it — red. */
    const log = new RunLog();
    const out = await runWithRunLog(log, () => runForayPipeline(multiAct, options, stubDeps()));
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const ready = log.events("ready");
    expect(ready.every((r) => r.granularity === "act" && r.partialOk === null)).toBe(true);
    expect(ready.map((r) => r.actIndex)).toEqual(ready.map((_r, k) => k));
    expect(ready.length).toBeGreaterThanOrEqual(3);
    expect(ready.flatMap((r) => r.itemIds)).toEqual(out.input.items.map((it, k) => itemKeyOf(it, k)));
    expect(ready[0]!.itemIds[0]).toBe("prelude");
    // Stamped on the log's clock, in order.
    expect(ready.map((r) => r.readyMs)).toEqual([...ready.map((r) => r.readyMs)].sort((a, b) => a - b));
  }, 120_000);

  it("with onActReady each act ReadyEvent carries its partial's verdict", async () => {
    /* MUTATION THAT KILLS THIS: log `partialOk: null` on the partial path
       too. Every verdict then reads null. Ran it — red. */
    const log = new RunLog();
    const partials: PartialCandidate[] = [];
    const out = await runWithRunLog(log, () => runForayPipeline(multiAct, options, { ...stubDeps(), onActReady: (c) => void partials.push(c) }));
    expect(out.outcome).toBe("generated");
    const ready = log.events("ready");
    expect(ready).toHaveLength(partials.length);
    expect(ready.map((r) => r.partialOk)).toEqual(partials.map((p) => p.validation.ok));
    expect(ready.every((r) => r.partialOk === true)).toBe(true);
  }, 120_000);

  it("a resumed run emits no ReadyEvent and no item event for its banked acts", async () => {
    /* MUTATION THAT KILLS THIS: log an act ReadyEvent beside
       `acceptStitchedAct` for a resumed act. The resumed run then logs one
       event per act. Ran it — red. */
    const key = "gv-33-resume";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: multiAct.prompt, duration: multiAct.duration, topic: options.topic }));
    const first = await runForayPipeline(multiAct, { ...options, checkpointKey: key }, { ...stubDeps(), checkpoint: store });
    expect(first.outcome).toBe("generated");

    const log = new RunLog();
    const events: ItemReadyEvent[] = [];
    const second = await runWithRunLog(log, () =>
      runForayPipeline(multiAct, { ...options, checkpointKey: key }, { ...stubDeps(), checkpoint: store, onItemReady: (ev) => void events.push(ev) })
    );
    expect(second.outcome).toBe("generated");
    expect(log.events("ready")).toEqual([]);
    expect(events).toEqual([]);
  }, 120_000);

  it("emitPreludeEarly sends the prelude before deepen, and act 0's ReadyEvent then leaves it out", async () => {
    /* MUTATION THAT KILLS THIS: ignore `options.emitPreludeEarly`. The
       prelude then arrives after deepen, with act 0. Ran it — red. */
    const order: string[] = [];
    const deepenBuilder = new StubDeepenActBuilder();
    const realDeepen = deepenBuilder.deepenAct.bind(deepenBuilder);
    deepenBuilder.deepenAct = async (...args: Parameters<StubDeepenActBuilder["deepenAct"]>) => {
      order.push("deepen");
      return realDeepen(...args);
    };
    const log = new RunLog();
    const out = await runWithRunLog(log, () =>
      runForayPipeline(multiAct, { ...options, emitPreludeEarly: true }, { ...stubDeps(), deepenBuilder, onItemReady: (ev) => void order.push(`item:${ev.index}`) })
    );
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(order[0]).toBe("item:0");
    expect(order.filter((o) => o.startsWith("item:"))).toEqual(out.input.items.map((_it, k) => `item:${k}`));
    const ready = log.events("ready");
    expect(ready[0]).toMatchObject({ granularity: "item", actIndex: -1, itemIds: ["prelude"] });
    expect(ready[1]!.itemIds).not.toContain("prelude");
    expect(ready.flatMap((r) => r.itemIds)).toEqual(out.input.items.map((it, k) => itemKeyOf(it, k)));
  }, 120_000);

  it("an unservable act 0 marks its items unservable, so the timeline pauses at index 1 and act 0 is no lead sample", async () => {
    /* MUTATION THAT KILLS THIS: send `servable: true` for every item. The
       timeline then never pauses. Ran it — red. */
    const spine = new StubSpineBuilder();
    const realSpine = spine.buildSpine.bind(spine);
    let act0Title: string | undefined;
    spine.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
      const built = await realSpine(...args);
      act0Title = built.acts[0]?.title;
      return built;
    };
    const stub = new StubNarrationVerifierBuilder();
    const refusing: NarrationVerifierBuilder = {
      providerName: "stub",
      verifyAct: async (req, c) => {
        const result = await stub.verifyAct(req, c);
        if (req.actTitle !== act0Title) return result;
        return { ...result, seams: result.seams.map((seam) => ({ ...seam, claimsSupported: false, notes: "rests on nothing held" })) };
      }
    } as NarrationVerifierBuilder;
    const timeline = new DeliveryTimeline();
    const out = await runForayPipeline(multiAct, options, { ...stubDeps(), spineBuilder: spine, narrationVerifier: refusing, onItemReady: (ev) => timeline.record(ev) });
    expect(out.outcome).toBe("generated");
    const events = timeline.events();
    expect(events.filter((e) => e.actIndex === 0).every((e) => !e.servable)).toBe(true);
    expect(events.filter((e) => e.actIndex === 1).every((e) => e.servable)).toBe(true);
    expect(timeline.pausedAtIndex).toBe(1);
    expect(timeline.leadReport()).toMatchObject({ pausedAtIndex: 1, samples: 0, minLeadSec: null });
  }, 120_000);
});

describe("runForayPipeline — the specifics gate reaches the act writer (GV-34, decision 34; threaded by GV-38)", () => {
  /** The stub writer, except that round 1 of every act opens its first
   * written seam with a year no source of the act carries. Under `enforce`
   * writeAct refuses that sentence in code and re-asks, naming GV-34. */
  function yearWriter() {
    const writer = new StubNarrationWriterBuilder();
    const real = writer.writeAct.bind(writer);
    const requests: Parameters<NarrationWriterBuilder["writeAct"]>[0][] = [];
    writer.writeAct = async (req, buildCtx) => {
      requests.push(req);
      const reply = await real(req, buildCtx);
      if (req.retryNote) return reply;
      const k = reply.seams.findIndex((s) => s.script.trim().length > 0);
      return { seams: reply.seams.map((s, i) => (i === k ? { ...s, script: `In 1847 the pits were dug. ${s.script}` } : s)) };
    };
    return { writer, requests };
  }
  const gv34Retries = (requests: Array<{ retryNote?: string }>) => requests.filter((r) => r.retryNote?.includes("GV-34") && r.retryNote.includes('"1847"'));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("FORAY_SPECIFICS_CHECK=enforce re-asks the seam in a real run; report (the default) leaves the rounds alone", async () => {
    /* MUTATION THAT KILLS THIS: drop the threading — leave `specifics` out of
       the narrate stage's writeNarration options in runPipeline.ts (or out of
       writeNarration's writeActNarration call). Enforce is then inert again:
       no GV-34 re-ask. Ran both — red. */
    const byDefault = yearWriter();
    const plain = await runForayPipeline(request, options, { ...stubDeps(), narrationWriter: byDefault.writer });
    expect(plain.outcome).toBe("generated");
    expect(byDefault.requests.length).toBeGreaterThan(0);
    expect(gv34Retries(byDefault.requests)).toEqual([]);

    vi.stubEnv("FORAY_SPECIFICS_CHECK", "enforce");
    const enforced = yearWriter();
    const out = await runForayPipeline(request, options, { ...stubDeps(), narrationWriter: enforced.writer });
    expect(out.outcome).toBe("generated");
    expect(gv34Retries(enforced.requests).length).toBeGreaterThan(0);
    if (out.outcome === "generated") {
      for (const item of out.input.items) if (item.type === "narration") expect(item.script ?? "").not.toContain("1847");
    }
  }, 120_000);

  it("options.gates.specifics overrides the env the same way", async () => {
    const enforced = yearWriter();
    const out = await runForayPipeline(request, { ...options, gates: { specifics: "enforce" } }, { ...stubDeps(), narrationWriter: enforced.writer });
    expect(out.outcome).toBe("generated");
    expect(gv34Retries(enforced.requests).length).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * GV-61: one researcher governs both §4.2 and the evidence stage, and it is
 * scoped by the resolved topic's lineage (W3-16 item 4).
 */
describe("runForayPipeline — the shared researcher and its topic scope (GV-61)", () => {
  /* Records every context it is called with; answers like the Stub. */
  class RecordingResearcher extends StubExternalResearcher {
    retrieveContexts: ExternalResearchContext[] = [];
    override async retrievePassages(req: PassageRetrievalRequest, researchCtx: ExternalResearchContext) {
      this.retrieveContexts.push({ ...researchCtx });
      return super.retrievePassages(req, researchCtx);
    }
  }

  /* MUTATION THAT KILLS THIS: build the evidence gatherer from
     createExternalResearcher() again (drop `researcher` from the
     createEvidenceGatherer call). The injected researcher then sees no
     retrieval at all. Ran: red (0 retrieve calls). */
  it("an injected deps.researcher is the one the evidence stage retrieves through", async () => {
    const researcher = new RecordingResearcher();
    const out = await runForayPipeline(request, options, { ...stubDeps(), researcher });
    expect(out.outcome).toBe("generated");
    expect(researcher.retrieveContexts.length).toBeGreaterThan(0);
  });

  /* MUTATION THAT KILLS THIS: drop the scopeResearchToTopic(topic) call after
     the pre-spine topic decision. Ran: red (topicNodeIds undefined on every
     retrieval context). */
  it("ctx.topicNodeIds is the resolved topic's lineage once the topic decision resolves", async () => {
    const researcher = new RecordingResearcher();
    await runForayPipeline(request, options, { ...stubDeps(), researcher });
    const lineage = taxonomyLineage("food/grilling-bbq");
    expect(lineage).toContain("food/grilling-bbq");
    expect(researcher.retrieveContexts.length).toBeGreaterThan(0);
    for (const seen of researcher.retrieveContexts) expect(seen.topicNodeIds).toEqual(lineage);
  });

  /* MUTATION THAT KILLS THIS: scope an unresolved topic to an empty lineage
     (`if (!resolved) { ctx.topicNodeIds = []; return; }`). Ran: red. */
  it("ctx.topicNodeIds is absent while the topic is unresolved", async () => {
    const understander = {
      providerName: "test-unmatchable",
      assessClarity: async () => ({ ambiguous: false as const }),
      extractIntent: async () => ({ subject: "qqzzx wubbleflunk", angle: "zzzqqx", priorKnowledge: "none", disappointment: "none" })
    };
    const spineContexts: Array<Record<string, unknown>> = [];
    const stub = new StubSpineBuilder();
    const spineBuilder: SpineBuilder = {
      providerName: stub.providerName,
      buildSpine: (intent, shape, duration, spineCtx) => {
        spineContexts.push({ ...spineCtx });
        return stub.buildSpine(intent, shape, duration, spineCtx);
      }
    };
    const out = await runForayPipeline(
      { ...request, prompt: "qqzzx wubbleflunk zzzqqx" },
      { userId: "founder-1", now: options.now },
      { ...stubDeps(), understander: understander as never, spineBuilder }
    );
    expect(out.outcome).toBe("unresolved-topic");
    expect(spineContexts.length).toBeGreaterThan(0);
    for (const seen of spineContexts) expect("topicNodeIds" in seen).toBe(false);
  });
});

/**
 * GV-67 (W4-03): the fold-copy path is dark. With `foldSpineCopy` off (the
 * default) the run is the one main has always run: the understander writes
 * the intent, the copy comes from it, the prelude names the same subject and
 * the spine carries none of the new fields. The folded path has its own suite
 * (fastPathCopy.test.ts).
 */
describe("runForayPipeline — flag off, GV-67 changes nothing", () => {
  it("the classic prelude is byte-identical to the one built from the understander's subject", async () => {
    /* MUTATION THAT KILLS THIS: pass `spine.angle` to the final preludeItem
       call. Ran it: red. */
    const out = await runForayPipeline(request, options, stubDeps());
    if (out.outcome !== "generated") throw new Error("expected the stub run to generate");
    const intent = await new StubPromptUnderstander().extractIntent(request.prompt, { userId: options.userId });
    expect(out.spine.subject).toBe(intent.subject);
    expect(out.input.items[0]).toEqual(preludeItem(intent.subject, out.spine.overview, out.input.slots[0]!.id));
  });

  it("the classic spine carries no copy field, and its title and id come from the understander's intent", async () => {
    /* MUTATION THAT KILLS THIS: hand the spine call `listenerPrompt` on the
       classic path (the stub then writes the copy fields and the title moves).
       Ran it: red. */
    const out = await runForayPipeline(request, options, stubDeps());
    if (out.outcome !== "generated") throw new Error("expected the stub run to generate");
    for (const field of ["priorKnowledge", "disappointment", "answersDisappointment", "title", "summary"]) {
      expect(out.spine, field).not.toHaveProperty(field);
    }
    const intent = await new StubPromptUnderstander().extractIntent(request.prompt, { userId: options.userId });
    expect(out.input.title).toBe(forayCopy(intent).title);
    expect(out.input.id).toBe(forayIdFor(forayCopy(intent).mintedFrom, options.now().toISOString()));
  });

  it("a spine banked without the new fields still parses and resumes to the same Foray", async () => {
    /* MUTATION THAT KILLS THIS: make `title` required in SpineSchema. Ran it: red. */
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));
    const first = await runForayPipeline(request, { ...options, checkpointKey: "gv67-classic" }, { ...stubDeps(), checkpoint: store });
    const banked = store.files.get("gv67-classic")!.stages.spine as Record<string, unknown>;
    expect(Object.keys(banked).sort()).toEqual(["acts", "angle", "duration", "generatedAt", "overview", "subject", "voice"]);
    expect(SpineSchema.safeParse(banked).success).toBe(true);
    let spineCalls = 0;
    const spineBuilder = new StubSpineBuilder();
    const real = spineBuilder.buildSpine.bind(spineBuilder);
    spineBuilder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
      spineCalls++;
      return real(...args);
    };
    const second = await runForayPipeline(request, { ...options, checkpointKey: "gv67-classic" }, { ...stubDeps(), spineBuilder, checkpoint: store });
    if (first.outcome !== "generated" || second.outcome !== "generated") throw new Error("expected both to generate");
    expect(spineCalls).toBe(0);
    expect(second.input.id).toBe(first.input.id);
    expect(second.input.title).toBe(first.input.title);
  });
});

/**
 * GV-79 (W5-03, MQ-05): the clip-on-subject scorer, shadow mode. Off (the
 * default) nothing starts; on, a checkpointed `clip-scores` stage starts
 * after sourcing and is awaited only before the veracity metrics.
 *
 * The stub run's tape is tier-1 pool cuts with no transcript wired, so the
 * test's cue provider hands back synthetic cues ONLY inside the `clip-scores`
 * stage (read from the call context): sourcing, evidence and narration see
 * no transcript, exactly as in every other stub run, and the judge sees a
 * passage. Every judge is scripted; nothing reaches Jev or a network model.
 */
describe("runForayPipeline — GV-79 clip-on-subject scorer (shadow mode)", () => {
  const clipOnlyCues = {
    getCues: (entry: TranscriptDigestEntry) =>
      currentCallContext().stage === "clip-scores" && entry.guid.startsWith("gv79-")
        ? [{ start_sec: 0, end_sec: 1_000_000, text: "Pitmasters argue about smoke, wood and low heat for barbecue brisket." }]
        : null
  };
  /* The pool's items have no transcript digest on a checkout, so each gets a
     synthetic digest row (a show the catalogue does not list, so the lineage
     gate never admits it to sourcing) and a catalogue title the clip stage's
     lookup can match it by. Built once: the same deps for every run below. */
  let clipDeps: { transcriptArchive: TranscriptDigestEntry[]; clipCatalogue: CatalogueData; cueProvider: typeof clipOnlyCues } | null = null;
  function clipFixture() {
    if (clipDeps) return clipDeps;
    const ids = [...new Set(loadSegmentPool().map((seg) => seg.item_id))];
    const title = (id: string) => `Pitmaster smoke stories ${id.replace(/[^a-z0-9]+/gi, " ")}`;
    const real = loadCatalogueData();
    clipDeps = {
      transcriptArchive: [
        ...loadTranscriptArchive(),
        ...ids.map((id) => ({ show_id: id.includes("--") ? id.slice(0, id.indexOf("--")) : id, show_title: "x", guid: `gv79-${id}`, title: title(id), cues: 10 }))
      ],
      clipCatalogue: { ...real, items: [...ids.map((id) => ({ id, show: "x", title: title(id), topics: [], hook: "" })), ...real.items] },
      cueProvider: clipOnlyCues
    };
    return clipDeps;
  }
  /** One run inside a RunLog, so the call context (and the stage name the
   * cue provider reads) is live. */
  const run = (...args: Parameters<typeof runForayPipeline>) => runWithRunLog(new RunLog(), () => runForayPipeline(...args));

  type Asked = { subjectSentence: string; claim: string; windowText: string; key: string };
  function scriptedJudge(answer: (q: Asked) => { subject: number; claim: number } = () => ({ subject: 4, claim: 4 })) {
    const calls: Asked[][] = [];
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    return {
      name: "scripted",
      calls,
      /** Holds every score() until the returned opener is called. */
      hold(): () => void {
        gate = new Promise<void>((resolve) => (release = resolve));
        return () => release();
      },
      async score(qs: readonly Asked[]) {
        calls.push([...qs]);
        if (gate) await gate;
        return new Map(qs.map((q) => [q.key, { ...answer(q), judge: "jev" as const }]));
      }
    };
  }

  /* MUTATION THAT KILLS THIS: start the stage whatever `gates.clipJudge`
     says. Ran it: red (the judge is asked and the fields appear). */
  it("off (the default): no clip-scores stage, no judge call, no new field; shadow leaves the Foray as it was", async () => {
    const judge = scriptedJudge();
    const off = await run(request, options, { ...stubDeps(), ...clipFixture(), clipJudge: judge });
    const shadow = await run(
      request,
      { ...options, gates: { clipJudge: "shadow" } },
      { ...stubDeps(), ...clipFixture(), clipJudge: scriptedJudge() }
    );
    if (off.outcome !== "generated" || shadow.outcome !== "generated") throw new Error("expected both to generate");
    expect(judge.calls).toHaveLength(0);
    expect(off.timings.some((t) => t.name === "clip-scores")).toBe(false);
    const veracity = off.input.meta!.veracity!;
    for (const field of ["clipOnSubjectRate", "clipOnSubjectJudge", "clipOnSubjectDetails"]) expect(veracity, field).not.toHaveProperty(field);
    expect(off.tapeRelevance.some((r) => "clipScores" in r || "windowTruncated" in r)).toBe(false);
    /* Shadow mode measures; it changes nothing the listener gets. */
    expect(shadow.input.items).toEqual(off.input.items);
    expect(shadow.input.segments).toEqual(off.input.segments);
    const withoutScores = shadow.tapeRelevance.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      delete copy.clipScores;
      delete copy.windowTruncated;
      return copy;
    });
    expect(withoutScores).toEqual(off.tapeRelevance);
  }, 120_000);

  /* MUTATION THAT KILLS THIS: pass `sourced.tapeRelevance` (not the scored
     rows) to buildVeracityMetrics. Ran it: red (scored 0, rate null). */
  it("shadow: every placed clip is scored against the spine's subject sentence, recorded on the rows and reported", async () => {
    const judge = scriptedJudge((q) => (q.key === "0:0:0" ? { subject: 1, claim: 4 } : { subject: 4, claim: 4 }));
    const out = await run(
      request,
      { ...options, gates: { clipJudge: "shadow" } },
      { ...stubDeps(), ...clipFixture(), clipJudge: judge }
    );
    if (out.outcome !== "generated") throw new Error("expected the stub run to generate");
    expect(judge.calls).toHaveLength(1);
    const asked = judge.calls[0]!;
    const clips = out.tapeRelevance.filter((r) => !r.mergedInto);
    expect(asked.map((q) => q.key)).toEqual(clips.map((r) => `${r.actIndex}:${r.slotIndex}:${r.beatIndex}`));
    expect(asked.every((q) => q.subjectSentence === `${out.spine.subject} (${out.spine.angle})`)).toBe(true);
    expect(clips.every((r) => r.clipScores !== undefined)).toBe(true);
    const veracity = out.input.meta!.veracity!;
    expect(veracity.clipOnSubjectJudge).toBe("jev");
    expect(veracity.clipOnSubjectDetails?.scored).toBe(clips.length);
    expect(veracity.clipOnSubjectRate).toBeCloseTo((clips.length - 1) / clips.length, 10);
    expect(veracity.clipOnSubjectDetails?.offSubject.map((c) => c.claim)).toEqual([clips[0]!.claim]);
    expect(out.timings.some((t) => t.name === "clip-scores")).toBe(true);
  }, 120_000);

  /* MUTATION THAT KILLS THIS: `await` the clip-scores stage where it starts.
     Ran it: red (the held judge waits for narration, narration waits for the
     judge, and the run never finishes: the test times out). */
  it("is off the timed path: a judge still pending does not delay the narrate:0 start", async () => {
    const judge = scriptedJudge();
    const open = judge.hold();
    const writer = new StubNarrationWriterBuilder();
    const realWrite = writer.writeAct.bind(writer);
    let narrationStartedWhileJudgePending = false;
    writer.writeAct = async (...args: Parameters<StubNarrationWriterBuilder["writeAct"]>) => {
      if (judge.calls.length === 1) narrationStartedWhileJudgePending = true;
      open();
      return realWrite(...args);
    };
    const out = await run(
      request,
      { ...options, gates: { clipJudge: "shadow" } },
      { ...stubDeps(), narrationWriter: writer, ...clipFixture(), clipJudge: judge }
    );
    if (out.outcome !== "generated") throw new Error("expected the stub run to generate");
    expect(narrationStartedWhileJudgePending).toBe(true);
    const at = (name: string) => out.timings.find((t) => t.name === name)!;
    const clip = at("clip-scores");
    const narrate = at("narrate:0");
    expect(Date.parse(clip.startedAt)).toBeLessThanOrEqual(Date.parse(narrate.startedAt));
    expect(Date.parse(clip.startedAt) + clip.ms).toBeGreaterThanOrEqual(Date.parse(narrate.startedAt));
    expect(out.input.meta!.veracity!.clipOnSubjectRate).toBe(1);
  }, 120_000);

  /* MUTATION THAT KILLS THIS: build the sentence from the understood intent
     (`subjectSentenceFor(null, intent)`). Ran it: red (the keyword list
     reaches the judge). */
  it("fold-on: the judge gets spine.subject (spine.angle), never the keyword intent or its sentinel", async () => {
    const judge = scriptedJudge();
    const stub = new StubSpineBuilder();
    const spineBuilder = {
      providerName: stub.providerName,
      buildSpine: async (...args: Parameters<SpineBuilder["buildSpine"]>) => ({
        ...(await stub.buildSpine(...args)),
        subject: "Barbecue in America",
        angle: "how smoke and low heat made a regional craft"
      })
    } as SpineBuilder;
    const out = await run(
      request,
      { ...options, flags: { foldSpineCopy: true }, gates: { clipJudge: "shadow" } },
      { ...stubDeps(), spineBuilder, ...clipFixture(), clipJudge: judge }
    );
    if (out.outcome !== "generated") throw new Error("expected the folded stub run to generate");
    const sentences = [...new Set(judge.calls.flat().map((q) => q.subjectSentence))];
    expect(sentences).toEqual(["Barbecue in America (how smoke and low heat made a regional craft)"]);
    const keywords = preSpineIntent(request.prompt)!.subject;
    for (const s of sentences) {
      expect(s).not.toContain(keywords);
      expect(s).not.toContain(PRE_SPINE_SENTINEL);
    }
  }, 120_000);
});

/**
 * GV-83 (W3-12; MQ-07, QK-21): show variety on every run. Measure-only: no
 * flag, no gate; the stitched tape items are timed on the same pool join
 * `runtimeSecFor` makes and keyed by `showKeyForItem`.
 */
describe("runForayPipeline — GV-83 show variety (MQ-07)", () => {
  /* MUTATION THAT KILLS THIS: drop the `showItems` argument to
     buildVeracityMetrics in runForayPipeline (showVariety is then absent).
     Ran it: red. */
  it("a stub run's report veracity carries showVariety, with its tape seconds equal to the runtime's tape seconds", async () => {
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const veracity = out.input.meta?.veracity;
    const variety = veracity?.showVariety;
    expect(variety).toBeDefined();
    if (!variety) return;
    const pool = loadSegmentPool();
    const tapeItems = out.input.items.filter((i) => (i as unknown as { type: string }).type === "segment");
    expect(tapeItems.length).toBeGreaterThan(0);
    const tapeSec = Object.values(variety.tapeSecByShow).reduce((a, b) => a + b, 0);
    expect(tapeSec).toBeCloseTo(runtimeSecFor(tapeItems, pool), 3);
    const byId = new Map(pool.map((s) => [s.id, s]));
    const itemIds = new Set(tapeItems.map((i) => byId.get(String((i as unknown as { segment_id: string }).segment_id))?.item_id));
    expect(variety.distinctEpisodes).toBe(itemIds.size);
    expect(variety.distinctShows).toBe(new Set([...itemIds].map((id) => showKeyForItem(String(id)))).size);
    expect(variety.largestShowTapeShare).toBeGreaterThan(0);
    expect(variety.largestShowTapeShare).toBeLessThanOrEqual(1);
    /* Gate behaviour is unchanged: the verdict does not read the field. */
    expect(out.gate).toEqual(evaluateVeracityGate({ ...veracity!, showVariety: undefined }));
  });

  /* MUTATION THAT KILLS THIS: key the pool with the FIRST row under an id
     (`if (!byId.has(s.id)) byId.set(...)`) — the minted cut's 100 s is
     measured instead of the committed row's 40 s, which is not what
     runtimeSecFor charges. Ran it: red. */
  it("showVarietyItemsFor times each segment on the runtimeSecFor join and skips narration and unresolvable segments", () => {
    const row = (id: string, item_id: string, start_sec: number, end_sec: number) => ({ id, item_id, start_sec, end_sec }) as SegmentRecord;
    const pool = [row("seg-a", "show-x--ep-1", 0, 100), row("seg-a", "show-x--ep-1", 10, 50), row("seg-b", "show-y--ep-2", 5, 35)];
    const items = [
      { type: "narration", id: "n1", script: "Hello there." },
      { type: "segment", segment_id: "seg-a" },
      { type: "segment", segment_id: "seg-missing" },
      { type: "segment", segment_id: "seg-b" }
    ] as unknown as Parameters<typeof showVarietyItemsFor>[0];
    /* An empty root: no catalogue, so every key is the id prefix. */
    const root = mkdtempSync(join(tmpdir(), "gv83-"));
    let rows: ReturnType<typeof showVarietyItemsFor>;
    try {
      rows = showVarietyItemsFor(items, pool, { root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(rows).toEqual([
      { showKey: "show-x", itemId: "show-x--ep-1", durationSec: 40 },
      { showKey: "show-y", itemId: "show-y--ep-2", durationSec: 30 }
    ]);
    const tapeSec = rows.reduce((a, r) => a + r.durationSec, 0);
    expect(tapeSec).toBe(runtimeSecFor(items.filter((i) => (i as unknown as { type: string }).type === "segment"), pool));
    expect(computeShowVariety(rows).largestShowTapeShare).toBeCloseTo(40 / 70, 12);
  });
});

describe("runForayPipeline — GV-90 per-Foray unit caps stop a run naming the stage", () => {
  /* MUTATION THAT KILLS THIS: drop the findUnitBudgetError re-throw in
     timed() — the run ends on deepen's own ActDeepeningError, with the unit
     figures buried in its cause and no stage named. Ran it — red. */
  it("a deepen builder whose metered() call passes the Spark-seconds cap ends the run with UnitBudgetStopError naming 'deepen'", async () => {
    const units = new UnitBudgetGuard({ overrides: { sparkSeconds: 10 } });
    const stub = new StubDeepenActBuilder();
    const deepenBuilder: DeepenActBuilder = {
      providerName: "metered-deepen",
      deepenAct: (spine, act, i, ctx) =>
        units.metered({ sessionId: ctx.sessionId ?? "none", unit: "sparkSeconds", estimate: 25 }, () => stub.deepenAct(spine, act, i, ctx))
    };
    const err = await runForayPipeline(request, { ...options, sessionId: "gv90-session", checkpointKey: "gv90-key" }, { ...stubDeps(), deepenBuilder }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitBudgetStopError);
    const stop = err as UnitBudgetStopError;
    expect(stop.stage).toBe("deepen");
    expect(stop.unit).toBe("sparkSeconds");
    expect(stop.cap).toBe(10);
    expect(stop.cause).toBeInstanceOf(UnitBudgetExceededError);
    expect(stop.message).toContain('"gv90-key"');
    expect(units.spent("gv90-session").sparkSeconds).toBe(0);
  });

  it("with the caps unreached a metered deepen runs to a generated Foray, and the session's spend is its wall time", async () => {
    const units = new UnitBudgetGuard();
    const stub = new StubDeepenActBuilder();
    const deepenBuilder: DeepenActBuilder = {
      providerName: "metered-deepen",
      deepenAct: (spine, act, i, ctx) =>
        units.metered({ sessionId: ctx.sessionId ?? "none", unit: "sparkSeconds", estimate: 25 }, () => stub.deepenAct(spine, act, i, ctx))
    };
    const out = await runForayPipeline(request, { ...options, sessionId: "gv90-ok" }, { ...stubDeps(), deepenBuilder });
    expect(out.outcome).toBe("generated");
    /* Every reservation was settled at its (tiny) wall time, not the estimate. */
    expect(units.spent("gv90-ok").sparkSeconds).toBeLessThan(25);
  });
});

describe("runForayPipeline — GV-91 best-of-2 spine selection reaches the outcome and the report", () => {
  /** A Stub spine whose overview names the sample, so the test can see which
   * one the pipeline kept. */
  class MarkedSpineBuilder implements SpineBuilder {
    readonly providerName: string;
    private readonly stub = new StubSpineBuilder();
    constructor(private readonly label: string) {
      this.providerName = `marked-${label}`;
    }
    async buildSpine(i: IntentUnderstanding, r: ResearchShape, d: DurationTier, c: SpineBuildContext): Promise<Spine> {
      const spine = await this.stub.buildSpine(i, r, d, c);
      return { ...spine, overview: `Plan ${this.label}: ${spine.overview}` };
    }
  }

  const bestOf = (judge: FakeSpineJudge) =>
    new BestOfTwoSpineBuilder({ primary: new MarkedSpineBuilder("A"), secondary: new MarkedSpineBuilder("B"), judge, graceMs: 60_000 });

  function cliArgs(out: string): CliArgs {
    return {
      prompts: null,
      out,
      duration: "short",
      limit: null,
      dryRun: true,
      authorId: "founder-1",
      budgetUsd: null,
      noResume: true,
      maxResumes: DEFAULT_MAX_RESUMES,
      continueOnRefusedPartial: false,
      notify: null
    };
  }

  it("the judged choice is the run's spine, spineSelection is on the generated outcome and on the report row, with levers recorded", async () => {
    /* MUTATION THAT KILLS THIS: drop the `spineSelection` spread from the
       generated outcome in runPipeline.ts (or from the report entry in
       generateForays.ts). Ran both: red. */
    const judge = new FakeSpineJudge([{ choose: 1 }]);
    const out = await runForayPipeline(request, options, { ...stubDeps(), spineBuilder: bestOf(judge) });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(out.spine.overview).toMatch(/^Plan B: /);
    expect(judge.calls).toBe(1);
    expect(out.spineSelection).toMatchObject({ chosen: "secondary", reason: "judged" });
    expect(out.spineSelection!.samples.map((x) => x.impl)).toEqual(["marked-A", "marked-B"]);

    const dir = mkdtempSync(join(tmpdir(), "gv91-"));
    try {
      const reportJudge = new FakeSpineJudge([{ choose: 1 }]);
      const result = await generateOneCandidate({ prompt: request.prompt, topic: "food/grilling-bbq" }, cliArgs(dir), {
        cueProvider: new FileTranscriptCueProvider(),
        runPipeline: (req, opts, deps = {}) => runForayPipeline(req, opts, { ...stubDeps(), ...deps, spineBuilder: bestOf(reportJudge) })
      });
      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.entry?.outcome).toBe("generated");
      expect(result.entry?.spineSelection).toMatchObject({ chosen: "secondary", reason: "judged" });
      expect(result.entry?.levers).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a single-sample spine builder leaves spineSelection absent on the outcome", async () => {
    /* MUTATION THAT KILLS THIS: always spread `spineSelection` (undefined
       becomes a present key). Ran it: red. */
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    expect("spineSelection" in out).toBe(false);
  }, 60_000);

  it("fold on: the judge's question is the listener's prompt, never the keyword intent or the sentinel, and spineSelection carries no prompt text", async () => {
    /* MUTATION THAT KILLS THIS: hand the judge `intent` alone (ignore
       ctx.listenerPrompt in spineJudgeQuestion). Ran it: red. */
    const judge = new FakeSpineJudge([{ choose: 0 }]);
    const out = await runForayPipeline(request, { ...options, flags: { foldSpineCopy: true } }, { ...stubDeps(), spineBuilder: bestOf(judge) });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const keyword = preSpineIntent(request.prompt)!;
    const question = judge.inputs[0]!.question;
    expect(question).toContain(request.prompt);
    expect(question).not.toContain(keyword.subject);
    expect(question).not.toContain(PRE_SPINE_SENTINEL);
    const recorded = JSON.stringify(out.spineSelection);
    expect(out.spineSelection).toMatchObject({ chosen: "primary", reason: "judged" });
    for (const word of ["grilling", "barbecue", "history"]) expect(recorded).not.toContain(word);
  }, 60_000);
});

describe("runForayPipeline — GV-94 the writer sees its act's index and its observations reach the outcome and the report", () => {
  /** A Stub writer that records the act index of every call and, on every
   * act but act 0, reports one edit call through ctx.observe. */
  function observingWriter() {
    const stub = new StubNarrationWriterBuilder();
    const actIndexes: Array<number | undefined> = [];
    const writer: NarrationWriterBuilder = {
      providerName: "observing",
      writeAct: async (req, ctx) => {
        actIndexes.push(ctx.actIndex);
        const reply = await stub.writeAct(req, ctx);
        if ((ctx.actIndex ?? 0) > 0) {
          const e: WriterObservation = { kind: "self-critique", acts: 1, sentences: 3, flagged: 1, editedSeams: 1, editCalls: 1, editErrors: 0, critiqueCalls: 2, critiqueErrors: 0, ms: 7, pValues: [0.1, 0.8] };
          ctx.observe?.(e);
        }
        return reply;
      }
    };
    return { writer, actIndexes };
  }

  it("each narrate:<i> stage hands the writer actIndex i, the observations are summed onto the outcome, and the edit calls join narrationCalls.writer", async () => {
    /* MUTATION THAT KILLS THIS: pass the pipeline ctx to writeNarration
       without `actIndex: i` (every act reads undefined), drop the
       `narrationWriterCalls += e.editCalls`, or drop the selfCritique spread
       from the generated outcome. Ran all three: red. */
    /* Medium: the stub spine has more than one act there. */
    const multiAct: GenerationRequest = { ...request, duration: "medium" };
    const baseline = await runForayPipeline(multiAct, options, stubDeps());
    expect(baseline.outcome).toBe("generated");
    if (baseline.outcome !== "generated") return;
    expect("selfCritique" in baseline).toBe(false);

    const { writer, actIndexes } = observingWriter();
    const out = await runForayPipeline(multiAct, options, { ...stubDeps(), narrationWriter: writer });
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const acts = out.narration.acts.length;
    expect(acts).toBeGreaterThan(1);
    expect([...new Set(actIndexes)].sort()).toEqual(Array.from({ length: acts }, (_, i) => i));
    expect(out.selfCritique).toEqual({
      acts: acts - 1,
      sentences: 3 * (acts - 1),
      flagged: acts - 1,
      editedSeams: acts - 1,
      editCalls: acts - 1,
      editErrors: 0,
      critiqueCalls: 2 * (acts - 1),
      critiqueErrors: 0,
      ms: 7 * (acts - 1),
      pValues: Array.from({ length: acts - 1 }, () => [0.1, 0.8]).flat()
    });
    const writerCalls = (o: typeof out) => (o.outcome === "generated" ? o.input.meta?.veracity?.narrationCalls?.writer : undefined);
    expect(writerCalls(baseline)).toBeGreaterThan(0);
    expect(writerCalls(out)).toBe(writerCalls(baseline)! + (acts - 1));
  }, 240_000);

  it("levers.selfCritique (the configuration) and selfCritique (what the run did) reach the report row", async () => {
    /* MUTATION THAT KILLS THIS: leave selfCritique out of `levers` in
       generateForays.ts, or drop the row's selfCritique spread. Ran both:
       red. */
    const critic = new FakeDraftCritic([], 0);
    const restore = __swapDraftCriticForTests("fake-gv94", () => critic);
    vi.stubEnv("FORAY_WRITER_SELF_CRITIQUE", "behind-playhead");
    vi.stubEnv("FORAY_WRITER_CRITIC", "fake-gv94");
    const dir = mkdtempSync(join(tmpdir(), "gv94-"));
    try {
      const writer = new SelfCritiquingNarrationWriter({ inner: new StubNarrationWriterBuilder(), critic, mode: "behind-playhead" });
      const args: CliArgs = {
        prompts: null,
        out: dir,
        duration: "medium",
        limit: null,
        dryRun: true,
        authorId: "founder-1",
        budgetUsd: null,
        noResume: true,
        maxResumes: DEFAULT_MAX_RESUMES,
        continueOnRefusedPartial: false,
        notify: null
      };
      let passed: unknown;
      const result = await generateOneCandidate({ prompt: request.prompt, topic: "food/grilling-bbq" }, args, {
        cueProvider: new FileTranscriptCueProvider(),
        runPipeline: (req, opts, deps = {}) => {
          passed = opts.selfCritique;
          return runForayPipeline(req, opts, { ...stubDeps(), ...deps, narrationWriter: writer });
        }
      });
      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(passed).toEqual({ mode: "behind-playhead", critic: "fake-gv94" });
      expect(result.entry?.outcome).toBe("generated");
      expect(result.entry?.levers).toEqual({ selfCritique: { mode: "behind-playhead", critic: "fake-gv94", flagP: 0.3, sourceBudgetTokens: 2000 } });
      expect(result.entry?.selfCritique?.acts).toBeGreaterThanOrEqual(1);
      expect(result.entry?.selfCritique?.editCalls).toBe(result.entry?.selfCritique?.acts);
      expect(critic.calls).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("runForayPipeline — GV-94 decision 20: the self-critique part of the checkpoint variant at BOTH call sites", () => {
  /** A deepen builder that throws: the driver records an `error` row and
   * keeps the checkpoint (GV-15's "killed after spine"), so the file the
   * FileCheckpointStore wrote can be read back. */
  class KilledAfterSpine extends StubDeepenActBuilder {
    override async deepenAct(): Promise<never> {
      throw new Error("killed after spine");
    }
  }

  /** One real (not dry) batch-driver run into a temp dir, killed after its
   * spine: the session's fingerprint (what runForayPipeline handed
   * CheckpointSession.open) and the store's (what it wrote into the file). */
  async function fingerprintsUnder(env: Record<string, string>): Promise<{ session: string; store: string }> {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const open = vi.spyOn(CheckpointSession, "open");
    const dir = mkdtempSync(join(tmpdir(), "gv94-fp-"));
    try {
      const args: CliArgs = {
        prompts: null,
        out: dir,
        duration: "short",
        limit: null,
        dryRun: false,
        authorId: "founder-1",
        budgetUsd: null,
        noResume: true,
        maxResumes: 0,
        continueOnRefusedPartial: false,
        notify: null
      };
      const result = await generateOneCandidate({ prompt: request.prompt, topic: options.topic }, args, {
        cueProvider: new FileTranscriptCueProvider(),
        runPipeline: (req, opts, deps = {}) => runForayPipeline(req, opts, { ...stubDeps(), ...deps, deepenBuilder: new KilledAfterSpine() })
      });
      expect(result.skipped).toBe(false);
      if (result.skipped) throw new Error("skipped");
      expect(result.entry?.outcome).toBe("error");
      expect(open).toHaveBeenCalledTimes(1);
      const files = readdirSync(dir).filter((f) => f.endsWith(".checkpoint.json"));
      expect(files).toHaveLength(1);
      const store = (JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as { fingerprint: string }).fingerprint;
      return { session: open.mock.calls[0]![2], store };
    } finally {
      open.mockRestore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the store's and the session's fingerprints agree and carry the critique's part only when it is on; off leaves the classic fingerprint unchanged", async () => {
    /* MUTATION THAT KILLS THIS: revert either site to plain
       `checkpointRunVariant(flags, routing)` -- generateForays.ts (the
       FileCheckpointStore's fingerprint) or runPipeline.ts (the
       CheckpointSession's). Ran both: red (the store's and the session's
       fingerprints differ, and the reverted one is not the joined value). */
    const critic = new FakeDraftCritic();
    const restore = __swapDraftCriticForTests("fake-gv94", () => critic);
    try {
      const classicVariant = checkpointRunVariant(resolvePipelineFlags(), resolveRouting());
      const fingerprintFor = (variant: string | undefined) =>
        checkpointFingerprint({ prompt: request.prompt, duration: "short", topic: options.topic, ...(variant !== undefined ? { variant } : {}) });

      const off = await fingerprintsUnder({ FORAY_WRITER_SELF_CRITIQUE: "off" });
      expect(off.store).toBe(off.session);
      expect(off.session).toBe(fingerprintFor(classicVariant));
      expect(joinCheckpointVariant(classicVariant, { mode: "off" })).toBe(classicVariant);

      const on = await fingerprintsUnder({ FORAY_WRITER_SELF_CRITIQUE: "behind-playhead", FORAY_WRITER_CRITIC: "fake-gv94" });
      expect(on.store).toBe(on.session);
      expect(on.session).toBe(fingerprintFor(joinCheckpointVariant(classicVariant, { mode: "behind-playhead", critic: "fake-gv94" })));
      expect(on.session).not.toBe(off.session);
      /* Killed before narrate: the critic was never asked. */
      expect(critic.calls).toBe(0);
    } finally {
      restore();
    }
  }, 240_000);
});

/* GV-124 (#1413 item 10): the pipeline's counting proxy over the writer
   (`countingNarrationWriterOf`, what runForayPipeline hands the narration
   stage) forwards `editSeams`, so the seam edit GV-80 built can reach the
   writer through the pipeline. It was dropped: writeAct.ts checks for the
   method, found none, and a timed round 2 would have been a whole-act
   rewrite. */
describe("GV-124 — the counting writer forwards editSeams", () => {
  it("offers exactly the writer's optional methods, forwards each, and counts every request once", async () => {
    /* MUTATION THAT KILLS THIS: drop the editSeams forward from
       countingNarrationWriterOf (the pre-GV-124 proxy). Ran it: red (the
       proxy has no editSeams). Or: forward it without counting. Ran it: red
       (the count reads 1 after the edit and the act). */
    const stub = new StubNarrationWriterBuilder();
    let count = 0;
    const proxy = countingNarrationWriterOf(stub, () => void count++);
    expect(proxy.providerName).toBe(stub.providerName);
    expect(typeof proxy.writeActStream).toBe("function");
    expect(typeof proxy.editSeams).toBe("function");
    const voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" } as const;
    const edit: SeamEditRequest = { actTitle: "Act 1", voice, seams: [], neighbours: [], clips: [], documents: [], retryNote: "r" };
    const ctx = { userId: "founder-1" };
    expect(await proxy.editSeams!(edit, ctx)).toEqual(await stub.editSeams(edit, ctx));
    expect(count).toBe(1);
    await proxy.writeAct({ actTitle: "Act 1", voice, seams: [], clips: [], documents: [] }, ctx);
    expect(count).toBe(2);

    /* A writer without the optional methods: the proxy has none either. */
    const plain: NarrationWriterBuilder = { providerName: "plain", writeAct: async () => ({ seams: [] }) };
    const plainProxy = countingNarrationWriterOf(plain, () => void count++);
    expect(plainProxy.editSeams).toBeUndefined();
    expect(plainProxy.writeActStream).toBeUndefined();
  });
});

describe("runForayPipeline — GV-95 the retrieval server is asked ahead of research, sourcing and evidence, and only when supplied", () => {
  /** A scripted RetrievalPreparer: records what the pipeline asked, in order,
   * and the stage each call ran under. */
  function scriptedRetrieval() {
    const calls: Array<{ op: string; stage: string | undefined; detail?: unknown }> = [];
    /* Counts from the instance's birth, as RemoteRetrieval's do: 4 hits are
       an earlier prompt's, and this run's `prepare` adds 7 (GV-125). */
    const counts = { prepared: 0, hits: 4, misses: 0, degraded: 0, hydrated: 0, hydrationMisses: 0, hydrationAbsent: 0, unmapped: 0, unprepared: 0, evictions: 0, evictedPinned: 0, heldBytes: 0, pinned: 0, scopeMismatches: 0, reasons: [] as string[] };
    /* This run's share, which is what meta.veracity.retrieval.remote reports. */
    const stats = { ...counts, hits: 7, reasons: [] as string[] };
    const retrieval: RetrievalPreparer = {
      prepareScope: async (topic) => {
        calls.push({ op: "prepareScope", stage: currentCallContext()?.stage, detail: topic });
        return true;
      },
      prepare: async (requests) => {
        calls.push({ op: "prepare", stage: currentCallContext()?.stage, detail: requests });
        counts.hits += 7;
        return requests.length;
      },
      answerFor: () => undefined,
      hydrate: async (entries) => {
        calls.push({ op: "hydrate", stage: currentCallContext()?.stage, detail: entries.length });
        return 0;
      },
      stats: () => ({ ...counts, reasons: [...counts.reasons] })
    };
    return { retrieval, calls, stats };
  }

  it("prepares the topic's scope once, every sourcing search before 'source' and every clip's body before evidence, each in its own timed stage; its stats ride in meta.veracity.retrieval.remote", async () => {
    /* MUTATION THAT KILLS THIS: prepare sourcing's searches from the deepen
       acts' theses only (drop the claim queries). Ran it: red. Or (GV-125):
       report `retrieval.stats()` whole instead of `retrievalStatsSince`.
       Ran it: red (hits 11, the earlier prompt's 4 included). */
    const { retrieval, calls, stats } = scriptedRetrieval();
    let deepened: DeepenedAct[] = [];
    const deepenBuilder = new StubDeepenActBuilder();
    const real = deepenBuilder.deepenAct.bind(deepenBuilder);
    deepenBuilder.deepenAct = async (...args: Parameters<DeepenActBuilder["deepenAct"]>) => {
      const act = await real(...args);
      deepened[args[2]] = act;
      return act;
    };
    /* Under a RunLog, so each call can be read off the call context's stage. */
    const out = await runWithRunLog(new RunLog(), () => runForayPipeline(request, options, { ...stubDeps(), deepenBuilder, retrieval }));
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    deepened = deepened.filter(Boolean);
    /* The stub run has no text index, so research-shape asks nothing ahead. */
    expect(calls.map((c) => `${c.op}@${c.stage}`)).toEqual([
      "prepareScope@retrieval:source",
      "prepare@retrieval:source",
      "hydrate@retrieval:source",
      "hydrate@retrieval:evidence"
    ]);
    expect(calls[0]!.detail).toBe(options.topic);
    expect(calls[1]!.detail).toEqual(sourcingSearches(deepened));
    expect((calls[1]!.detail as unknown[]).length).toBeGreaterThan(deepened.length);
    const names = out.timings.map((t) => t.name);
    expect(names.indexOf("retrieval:source")).toBeLessThan(names.indexOf("source"));
    expect(names.indexOf("retrieval:evidence")).toBeLessThan(names.indexOf("evidence"));
    expect((out.input.meta?.veracity?.retrieval as { remote?: unknown }).remote).toEqual(stats);
  });

  it("without deps.retrieval no retrieval stage runs and meta.veracity.retrieval has no remote key", async () => {
    /* MUTATION THAT KILLS THIS: add `remote` to meta.veracity.retrieval
       unconditionally. Ran it: red. */
    const out = await runForayPipeline(request, options, stubDeps());
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(out.timings.map((t) => t.name).filter((n) => n.startsWith("retrieval:"))).toEqual([]);
    expect(out.input.meta?.veracity?.retrieval).toBeDefined();
    expect(out.input.meta?.veracity?.retrieval).not.toHaveProperty("remote");
  });
});

/**
 * GV-98 (W3-17, R1-05): FORAY_EVIDENCE_PREFETCH=first-act. The `evidence`
 * stage awaits act 1's packs only; every later act's are gathered behind it
 * while act 1 is written, and settled on every exit path. The gatherer is a
 * scripted fake that reads the stage it was called in off the call context
 * (so each run is inside a RunLog) and answers every gather outside the
 * `evidence` stage 30 ms late: the "slower act-2 gathers".
 */
describe("runForayPipeline — GV-98 act 1's evidence on the timed path, the rest behind it", () => {
  const multiAct: GenerationRequest = { ...request, duration: "medium" };

  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn().finally(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  function stagedGatherer() {
    const calls: Array<{ key: string; stage: string | undefined; claim: string }> = [];
    const log: string[] = [];
    let inFlight = 0;
    const evidence: EvidenceGatherer = {
      async gather(beat): Promise<EvidencePack> {
        const stage = currentCallContext().stage;
        calls.push({ key: evidenceMemoKey(beat), stage, claim: beat.claim });
        inFlight += 1;
        try {
          if (stage !== "evidence") await new Promise((resolve) => setTimeout(resolve, 30));
          log.push(`landed@${stage === "evidence" ? "evidence" : "behind"}`);
          return { purpose: beat.claim, beatKind: "account", docs: [] };
        } finally {
          inFlight -= 1;
        }
      }
    };
    return { evidence, calls, log, inFlight: () => inFlight };
  }

  function loggingWriter(log: string[], fail = false): NarrationWriterBuilder {
    const stub = new StubNarrationWriterBuilder();
    return {
      providerName: stub.providerName,
      writeAct: async (req, narrationCtx) => {
        log.push(`write:${req.actTitle}`);
        if (fail) throw new Error("writer down");
        return stub.writeAct(req, narrationCtx);
      }
    };
  }

  /* MUTATION THAT KILLS THIS: drop the `acts: i => i === 0` filter from the
     evidence stage (every page lands inside `evidence`, so nothing is left
     to land behind act 1's first write); or have buildQueue ignore
     `options.acts` (the same, from the gatherer's side). */
  it("first-act: the stage gathers act 1's pages only, act 1 is written before the later acts' slower packs land, and every page is gathered once", async () => {
    const { evidence, calls, log } = stagedGatherer();
    const claimsByAct = new Map<string, Set<string>>();
    const base = loggingWriter(log);
    const narrationWriter: NarrationWriterBuilder = {
      providerName: base.providerName,
      writeAct: async (req, narrationCtx) => {
        const claims = claimsByAct.get(req.actTitle) ?? new Set<string>();
        for (const seam of req.seams) for (const b of seam.beats) claims.add(b.claim);
        claimsByAct.set(req.actTitle, claims);
        return base.writeAct(req, narrationCtx);
      }
    };
    const out = await withEnv({ FORAY_EVIDENCE_PREFETCH: "first-act" }, () =>
      runWithRunLog(new RunLog(), () => runForayPipeline(multiAct, options, { ...stubDeps(), evidence, narrationWriter }))
    );
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    /* Which act each page belongs to, off the briefs the writer was handed
       (a seam beat's claim is the gathered beat's claim). Act 1 is the
       first act written. */
    const [firstAct, ...laterActs] = [...claimsByAct.keys()];
    expect(laterActs.length).toBeGreaterThan(1);
    const act1Claims = claimsByAct.get(firstAct!)!;
    const laterClaims = new Set(laterActs.flatMap((t) => [...claimsByAct.get(t)!]).filter((c) => !act1Claims.has(c)));
    expect(laterClaims.size).toBeGreaterThan(0);
    const timedClaims = calls.filter((c) => c.stage === "evidence").map((c) => c.claim);
    const backgroundClaims = new Set(calls.filter((c) => c.stage === "evidence:background").map((c) => c.claim));
    /* The timed stage gathered act 1's pages and no page of any later act... */
    expect(timedClaims.some((c) => act1Claims.has(c))).toBe(true);
    expect(timedClaims.filter((c) => laterClaims.has(c))).toEqual([]);
    /* ...and the background carries the later acts' pages (act 2's among
       them) and none that only act 1 holds. */
    expect([...claimsByAct.get(laterActs[0]!)!].some((c) => backgroundClaims.has(c))).toBe(true);
    expect([...backgroundClaims].some((c) => laterClaims.has(c))).toBe(true);
    expect([...backgroundClaims].filter((c) => act1Claims.has(c) && !laterClaims.has(c))).toEqual([]);

    const names = out.timings.map((t) => t.name);
    expect(names.indexOf("evidence")).toBe(names.indexOf("source") + 1);
    expect(names.indexOf("evidence")).toBeLessThan(names.indexOf("narrate:0"));
    expect(names.filter((n) => /^narrate:\d+$/.test(n)).length).toBeGreaterThan(1);

    const retrieval = out.input.meta!.veracity!.retrieval!;
    const timedCalls = calls.filter((c) => c.stage === "evidence");
    expect(retrieval.timedPages).toBe(timedCalls.length);
    expect(retrieval.timedPages).toBeGreaterThan(0);
    expect(retrieval.backgroundPages).toBeGreaterThan(0);
    expect(retrieval.timedPages! + retrieval.backgroundPages!).toBe(retrieval.pages);
    expect(retrieval.backgroundMs).toBeGreaterThanOrEqual(0);
    /* The background's own calls are tagged for the lane scheduler. */
    expect(calls.some((c) => c.stage === "evidence:background")).toBe(true);
    /* Exactly once: no key reached the wrapped gatherer twice, and every
       page either phase listed was gathered. */
    expect(new Set(calls.map((c) => c.key)).size).toBe(calls.length);
    expect(calls).toHaveLength(retrieval.pages);
    expect(retrieval.failed).toBe(0);
    /* Act 1's writer started before the later acts' packs had all landed. */
    const firstWrite = log.findIndex((l) => l.startsWith("write:"));
    expect(firstWrite).toBeGreaterThan(-1);
    expect(log.slice(firstWrite).some((l) => l === "landed@behind")).toBe(true);
    expect(log.slice(0, firstWrite).every((l) => l === "landed@evidence" || l === "landed@behind")).toBe(true);
  }, 60_000);

  /* MUTATION THAT KILLS THIS: default FORAY_EVIDENCE_PREFETCH to first-act.
     Pages then land outside the stage and the phase keys appear. */
  it("all (the default): every page is gathered inside the evidence stage and the report carries no phase keys", async () => {
    const { evidence, calls, log } = stagedGatherer();
    const out = await withEnv({ FORAY_EVIDENCE_PREFETCH: undefined }, () =>
      runWithRunLog(new RunLog(), () => runForayPipeline(multiAct, options, { ...stubDeps(), evidence, narrationWriter: loggingWriter(log) }))
    );
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.stage === "evidence")).toBe(true);
    const retrieval = out.input.meta!.veracity!.retrieval!;
    expect(retrieval).not.toHaveProperty("timedPages");
    expect(retrieval).not.toHaveProperty("backgroundPages");
    expect(retrieval).not.toHaveProperty("backgroundMs");
  }, 60_000);

  /* MUTATION THAT KILLS THIS: drop the `settleBackground` calls from the
     narration loop's catch and finally. The run then rejects with a
     background gather still in flight, and the background keeps taking the
     later acts' pages after the run has returned. */
  it("first-act, narration throws: the run rejects with the writer's error only after the background has settled, and gathers nothing afterwards", async () => {
    const { evidence, calls, log, inFlight } = stagedGatherer();
    /* Every background page that STARTED after the writer threw. */
    let writerThrown = false;
    let backgroundStartedAfterThrow = 0;
    const gather = evidence.gather.bind(evidence);
    evidence.gather = async (beat, ctx) => {
      if (writerThrown && currentCallContext().stage === "evidence:background") backgroundStartedAfterThrow += 1;
      return gather(beat, ctx);
    };
    const failingWriter = loggingWriter(log, true);
    const writeAct = failingWriter.writeAct.bind(failingWriter);
    failingWriter.writeAct = async (req, narrationCtx) => {
      writerThrown = true;
      return writeAct(req, narrationCtx);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let caught: unknown;
      await withEnv({ FORAY_EVIDENCE_PREFETCH: "first-act", EVIDENCE_PREFETCH_CONCURRENCY: "1" }, () =>
        runWithRunLog(new RunLog(), () =>
          runForayPipeline(multiAct, { ...options, narrationActConcurrency: 1 }, { ...stubDeps(), evidence, narrationWriter: failingWriter })
        ).catch((err: unknown) => {
          caught = err;
        })
      );
      expect(caught).toBeInstanceOf(Error);
      expect(String((caught as Error).message)).toMatch(/writer down/);
      expect(inFlight()).toBe(0);
      /* The failure stopped the background: no background page was STARTED
         after the writer threw (merely settling lets the queue drain). */
      expect(writerThrown).toBe(true);
      expect(calls.some((c) => c.stage === "evidence:background")).toBe(true);
      expect(backgroundStartedAfterThrow).toBe(0);
      const atRejection = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls.length).toBe(atRejection);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 60_000);

  /* MUTATION THAT KILLS THIS: start the background outside the
     `evidence:background` call context (the refused gathers are then never
     made and the run completes; ran: red). The deferred throw itself is
     pinned by evidencePrefetch.test.ts: here a narration gather that shares
     the refused in-flight promise carries the stop too, so dropping the
     throw alone leaves this green (ran). */
  it("first-act: a budget stop in the background surfaces from the next narration gather and stops the run naming a narrate stage", async () => {
    const calls: Array<string | undefined> = [];
    const evidence: EvidenceGatherer = {
      async gather(beat): Promise<EvidencePack> {
        const stage = currentCallContext().stage;
        calls.push(stage);
        /* Only the background fan-out is refused; a narration-time re-ask
           would be answered. */
        if (stage === "evidence:background") throw new BudgetExceededError(9.9, 0.2, 10);
        return { purpose: beat.claim, beatKind: "account", docs: [] };
      }
    };
    let caught: unknown;
    await withEnv({ FORAY_EVIDENCE_PREFETCH: "first-act" }, () =>
      runWithRunLog(new RunLog(), () => runForayPipeline(multiAct, options, { ...stubDeps(), evidence })).catch((err: unknown) => {
        caught = err;
      })
    );
    expect(calls).toContain("evidence:background");
    expect(caught).toBeInstanceOf(BudgetStopError);
    expect((caught as BudgetStopError).stage).toMatch(/^narrate:\d+$/);
  }, 60_000);
});
