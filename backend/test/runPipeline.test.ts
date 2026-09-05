import { describe, it, expect } from "vitest";
import { runForayPipeline, slotsFromSpine, runtimeSecFor } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { finalizeForay, type FinalizeForayInput, type FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { Spine } from "../src/types/spine";

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

    expect(names).toEqual([
      "understand", "research", "spine", "deepen", "source", "narrate", "stitch", "finalize"
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
    const out = await runForayPipeline(
      request,
      { userId: "founder-1", now: options.now },
      { ...stubDeps(), understander: understander as never }
    );

    expect(out.outcome).toBe("unresolved-topic");
    if (out.outcome !== "unresolved-topic") return;
    expect(Array.isArray(out.candidates)).toBe(true);
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
