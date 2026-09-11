import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runForayPipeline, slotsFromSpine, runtimeSecFor, forayCopy, clampWords, MAX_COPY_WORDS } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { finalizeForay, type FinalizeForayInput, type FinalizeForayResult } from "../src/generation/finalizeForay";
import { stitchForay } from "../src/generation/stitchForay";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { resetTaxonomyCache } from "../src/generation/resolveTopic";
import { resetTaxonomyFamilyCache, taxonomyRoot } from "../src/generation/taxonomyFamily";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import type { GenerationRequest } from "../src/types/generation";
import type { DeepenedAct, Spine } from "../src/types/spine";
import type { WrittenAct } from "../src/generation/writeNarration";
import type { EvidenceBeat, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type { SpineBuilder } from "../src/generation/SpineBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import type { PartialCandidate } from "../src/generation/partialCandidate";

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
       before any act is narrated. */
    expect(names).toEqual([
      "understand", "research-shape", "spine", "deepen", "source", "evidence", "narrate:0", "stitch:0", "finalize"
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
    expect(out.input.items[0]).toMatchObject({ type: "narration", id: "disclosure" });
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
    const copy = forayCopy({ subject: "grilling", angle: "the surprising origin story" });
    expect(copy.title).toBe("grilling: the surprising origin story");
    expect(copy.summary).toBe("grilling");
    expect(copy.clamped).toEqual([]);
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
  function latchedWriter(isLater: (slotTitle: string) => boolean) {
    const writer = new StubNarrationWriterBuilder();
    /* G-34: a clean slot's prose is requested through the merged
       select+prose call, so that is the request to log. */
    const realSelectAndWrite = writer.selectAndWrite.bind(writer);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    writer.selectAndWrite = async (...args: Parameters<StubNarrationWriterBuilder["selectAndWrite"]>) => {
      events.push(`narrate:${args[0].slotTitle}`);
      if (isLater(args[0].slotTitle)) await held;
      return realSelectAndWrite(...args);
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
    const isLater = (slotTitle: string) => captured.spine!.acts.slice(1).some((a) => a.slots.some((s) => s.title === slotTitle));
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

    /* The slot title is the join between the latch and the act structure.
       If the spine ever reuses one across acts this test would read a false
       pass, so it says that out loud rather than assuming it. */
    const allSlotTitles = spine.acts.flatMap((a) => a.slots.map((s) => s.title));
    expect(new Set(allSlotTitles).size).toBe(allSlotTitles.length);

    const laterActSlots = new Set(spine.acts.slice(1).flatMap((a) => a.slots.map((s) => s.title)));
    expect(events.some((e) => e.startsWith("narrate:") && laterActSlots.has(e.slice("narrate:".length)))).toBe(true);

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
    const isLater = (slotTitle: string) => captured.spine!.acts.slice(1).some((a) => a.slots.some((s) => s.title === slotTitle));
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
    expect(out.input.items[0]).toMatchObject({ type: "narration", id: "disclosure" });
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
      selectClaims: (request, narrationCtx) => {
        if (callsWhenNarrationStarted < 0) callsWhenNarrationStarted = calls.length;
        return stub.selectClaims(request, narrationCtx);
      },
      writePages: (request, narrationCtx) => stub.writePages(request, narrationCtx)
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
    /* Nothing past §4.1 ran: no research, no spine, one timed stage. */
    expect(buildSpine).not.toHaveBeenCalled();
    expect(researchCalls).toBe(0);
    expect(out.timings.map((t) => t.name)).toEqual(["understand"]);
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
