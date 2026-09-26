import { describe, expect, it } from "vitest";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";

/**
 * Round-3 audit gen-13: the Foray id (seeded from the start stamp) and the
 * topic were re-derived on every resume, so a resumed run published under a
 * different id than its streamed partials, and could gate sourcing on a
 * topic the banked spine was not built for.
 */
describe("gen-13: a resumed run keeps the Foray's identity", () => {
  const request = { prompt: "the history of grilling and barbecue", duration: "short" as const, author_id: "founder-1", visibility: "catalogue" as const };
  const okFinalize = async (i: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: i.id, generated: true },
      timings: []
    }) as unknown as FinalizeForayResult;
  const deps = (checkpoint: FakeCheckpointStore) => ({
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: okFinalize,
    checkpoint
  });

  it("the same Foray id and start stamp on a resume the next day, from the banked identity stage", async () => {
    /* MUTATION THAT KILLS THIS: derive startedAt/forayId from now() on every
       attempt again — the second run mints a different id, so the partial a
       listener was polling changes id mid-run. */
    const key = "gen-13-identity";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration }));
    const first = await runForayPipeline(request, { userId: "founder-1", checkpointKey: key, now: () => new Date("2026-09-05T12:00:00.000Z") }, deps(store));
    const second = await runForayPipeline(request, { userId: "founder-1", checkpointKey: key, now: () => new Date("2026-09-06T09:30:00.000Z") }, deps(store));
    if (first.outcome !== "generated" || second.outcome !== "generated") throw new Error("fixture: expected generated Forays");
    expect(store.stageKeys(key)).toContain("identity");
    expect(second.input.id).toBe(first.input.id);
    expect(second.input.topic).toBe(first.input.topic);
  });

  /* Round-3 review (L5): the identity (with the topic) was banked only after
     the spine, but research-shape, filtered by that topic, was banked before
     it. A run stopped during the spine resumed with the banked map and a topic
     re-decided against the supply as it now stood.
     MUTATION: drop the "topic" checkpoint (save or resume) -- the resumed run
     re-decides and publishes under the undoctored topic. */
  it("a run stopped during the spine resumes with the topic research-shape was built for", async () => {
    const key = "gen-13-topic-before-spine";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration }));
    const failingSpine = { providerName: "failing", buildSpine: async () => { throw new Error("spine call interrupted"); } };
    await expect(
      runForayPipeline(request, { userId: "founder-1", checkpointKey: key, now: () => new Date("2026-09-05T12:00:00.000Z") }, { ...deps(store), spineBuilder: failingSpine as never })
    ).rejects.toThrow(/spine call interrupted/);
    expect(store.stageKeys(key)).toEqual(expect.arrayContaining(["topic", "research-shape"]));
    expect(store.stageKeys(key)).not.toContain("identity");
    const saves = store.saves.filter((x) => x.key === key).map((x) => x.stage);
    expect(saves.indexOf("topic")).toBeLessThan(saves.indexOf("research-shape"));

    /* Stand in for "the supply changed overnight": the decision a fresh
       decideTopic would make is not the one banked. The resume must use the
       banked one, the topic the research map was filtered by. */
    const file = store.files.get(key)!;
    const banked = file.stages.topic as { topicDecision: { topic: string } };
    const original = banked.topicDecision.topic;
    const other = original === "food" ? "cooking" : "food";
    store.files.set(key, { ...file, stages: { ...file.stages, topic: { topicDecision: { ...banked.topicDecision, topic: other } } } });

    const resumed = await runForayPipeline(request, { userId: "founder-1", checkpointKey: key, now: () => new Date("2026-09-06T09:30:00.000Z") }, deps(store));
    if (resumed.outcome !== "generated") throw new Error(`fixture: expected a generated Foray, got ${resumed.outcome}`);
    expect(resumed.input.topic).toBe(other);
  });
});
