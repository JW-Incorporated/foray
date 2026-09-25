import path from "node:path";
import { describe, expect, it } from "vitest";
import { CandidateRefusedError, buildCandidateFiles, finalizeForay, isMintedPoolCollisionError, type FinalizeForayInput, type FinalizeForayResult } from "../src/generation/finalizeForay";
import { CheckpointSession, checkpointFingerprint } from "../src/generation/checkpoint";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import type { NewSegment } from "../src/types/tapeSourcing";

/**
 * Round-3 audit gen-12: finalizeForay THREW a plain Error on a pool collision,
 * a duplicate Foray id or a bad minted row. The throw escaped the partial gate
 * (so --continue-on-refused-partial could not continue past it and the report
 * had no refusedAtAct), and a resumed run replayed its banked sourcing and hit
 * the same collision on every attempt until someone passed --no-resume.
 */
const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "tools", "foray", "fixtures", "boundary");

const sibling: NewSegment = {
  id: "boundary-ep-a#200",
  itemId: "boundary-ep-a",
  startSec: 200.3,
  endSec: 300,
  referenceDurationSec: 3600,
  startAnchor: "so the first thing we did was",
  endAnchor: "and that is how the pipeline ended up",
  confidence: "medium",
  why: "The first thing the team did was wire the pipeline end to end.",
  transcriptSource: "publisher"
};

const input = (over: Partial<FinalizeForayInput> = {}): FinalizeForayInput =>
  ({ id: "gen-12-test", title: "t", topic: "fixture/boundary", summary: "s", slots: [], items: [], runtimeSec: 0, ...over }) as FinalizeForayInput;

describe("gen-12: a candidate that cannot be assembled is REPORTED, not thrown", () => {
  it("buildCandidateFiles still stops a direct caller, with a typed error carrying each message", () => {
    let caught: unknown;
    try {
      buildCandidateFiles({ id: "x" }, FIXTURE_ROOT, { segments: [sibling], sources: [], topic: "fixture/boundary" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CandidateRefusedError);
    expect((caught as CandidateRefusedError).errors.every(isMintedPoolCollisionError)).toBe(true);
  });

  it("finalizeForay returns validation.ok=false with the collision in checkForaysErrors", async () => {
    /* MUTATION THAT KILLS THIS: let the throw out of the check-forays step
       again — finalizeForay rejects instead of resolving. (The refusal is
       decided before the .mjs checker is imported, so this runs on any path.) */
    const result = await finalizeForay(input({ segments: [sibling], segmentSources: [] }), FIXTURE_ROOT);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.checkForaysErrors.some(isMintedPoolCollisionError)).toBe(true);
  });

  it("a duplicate Foray id is a validation error too", async () => {
    const result = await finalizeForay(input({ id: "boundary-1" }), FIXTURE_ROOT);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.checkForaysErrors.join(" ")).toMatch(/already exists in data\/forays\.json/);
  });
});

describe("gen-12: CheckpointSession.drop", () => {
  it("forgets the matching stages in memory and in the store, and fences later saves of them", async () => {
    const store = new FakeCheckpointStore("fp");
    store.save("k", "spine", { a: 1 });
    store.save("k", "source", { b: 1 });
    store.save("k", "narrate:0", { c: 1 });
    const session = await CheckpointSession.open(store, "k", "fp");
    const dropped = await session.drop((n) => n === "source" || n.startsWith("narrate:"));
    expect(dropped.sort()).toEqual(["narrate:0", "source"]);
    expect(store.stageKeys("k")).toEqual(["spine"]);
    await session.save("narrate:1", { late: true });
    expect(store.stageKeys("k")).toEqual(["spine"]);
    await session.save("spine-extra", { ok: true });
    expect(store.stageKeys("k")).toContain("spine-extra");
  });
});

describe("gen-12: a resumed sourcing that now collides is dropped, so the next attempt re-sources", () => {
  const request = { prompt: "the history of grilling and barbecue", duration: "short" as const, author_id: "founder-1", visibility: "catalogue" as const };
  const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
  const fakeFinalize = (errors: string[]) => async (i: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: errors.length === 0, checkForaysErrors: errors, checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: i.id, generated: true },
      timings: []
    }) as unknown as FinalizeForayResult;
  const deps = (finalize: ReturnType<typeof fakeFinalize>, checkpoint: FakeCheckpointStore) => ({
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize,
    checkpoint
  });

  it("drops source, narrate:* and stitch:* when the RESUMED source's rows collide; keeps them when fresh", async () => {
    /* MUTATION THAT KILLS THIS: remove the dropStaleSourcing calls — the
       banked `source` survives and the next resume replays the collision. */
    const key = "gen-12-resume";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));
    const collision = ["finalizeForay: minted pool collision: minted segment x#1 starts where committed x#1 starts"];

    /* A FRESH run that collides keeps its banked work: nothing was resumed,
       so there is nothing stale to drop. */
    await runForayPipeline(request, { ...options, checkpointKey: key }, deps(fakeFinalize(collision), store));
    expect(store.stageKeys(key)).toContain("source");

    /* The resumed run collides: its sourcing, and what was built on it, go. */
    await runForayPipeline(request, { ...options, checkpointKey: key }, deps(fakeFinalize(collision), store));
    const left = store.stageKeys(key);
    expect(left).not.toContain("source");
    expect(left.filter((k) => /^(narrate|stitch):/.test(k))).toEqual([]);
    expect(left).toContain("spine");
  });

  it("a resumed run refused for any OTHER reason keeps its banked sourcing", async () => {
    const key = "gen-12-other";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));
    await runForayPipeline(request, { ...options, checkpointKey: key }, deps(fakeFinalize([]), store));
    await runForayPipeline(request, { ...options, checkpointKey: key }, deps(fakeFinalize(["some other check-forays error"]), store));
    expect(store.stageKeys(key)).toContain("source");
  });
});
