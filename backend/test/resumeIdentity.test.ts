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
});
