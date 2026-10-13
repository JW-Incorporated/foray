import { describe, it, expect, vi, afterEach } from "vitest";
import { runForayPipeline } from "../src/generation/runPipeline";
import { buildResearchShape } from "../src/generation/researchShape";
import { NullExternalResearcher } from "../src/generation/NullExternalResearcher";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { routeFor } from "../src/config/stageRouting";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { ExternalResearcher } from "../src/generation/ExternalResearcher";
import type { GenerationRequest, IntentUnderstanding } from "../src/types/generation";

/**
 * GV-61 (OQ-04, GP-06): clip transcripts only on the timed path; outside facts
 * only from precomputed dossiers. Two stages used web search: ST-03 (the
 * research-shape fan-out) and ST-07 (the evidence gatherer). Under the 'none'
 * research route neither may make a call, and the pipeline must still finish.
 */

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "short",
  author_id: "founder-1",
  visibility: "catalogue"
};

const options = {
  userId: "founder-1",
  now: () => new Date("2026-09-05T12:00:00.000Z"),
  topic: "food/grilling-bbq"
};

/* The fake §4.9: reports a clean pass so the chain runs to the end. */
async function passingFinalize(input: FinalizeForayInput): Promise<FinalizeForayResult> {
  return {
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { id: input.id, generated: true } as never,
    timings: []
  } as unknown as FinalizeForayResult;
}

function depsWith(researcher: ExternalResearcher) {
  return {
    understander: new StubPromptUnderstander(),
    researcher,
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: passingFinalize
  };
}

/* A catalogue with one genuine gap (a concept with zero tape), so the §4.2
   fan-out has something it WOULD research under any other route. */
function gapCatalogue(): CatalogueData {
  return {
    items: [{ id: "show-a--fusion-ep", show: "Show A", title: "Inside a Tokamak", topics: ["engineering/energy-fusion"], hook: "A deep look at fusion reactors." }],
    itemTags: { "show-a--fusion-ep": ["fusion", "tokamak"] },
    concepts: {
      fusion: { terms: ["fusion", "tokamak"], topics: ["engineering/energy-fusion"], related: [] },
      "sound-symbolism": { terms: ["onomatopoeia", "phonaesthetics", "sound-symbolism"], topics: ["language/linguistics"], related: [] }
    },
    shows: [{ show_id: "show-a", title: "Show A", taxonomy_node_ids: ["engineering/energy-fusion"] }]
  };
}

const gapIntent: IntentUnderstanding = {
  subject: "onomatopoeia",
  angle: "sound symbolism and phonaesthetics, a linguistics curiosity with thin real-world tape",
  priorKnowledge: "knows the name, not the mechanism",
  disappointment: "stays surface-level"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GV-61: local mode routes research to 'none'", () => {
  /* MUTATION THAT KILLS THIS: make the local-mode research default 'stub' in
     stageRouting.ts. Ran: red. */
  it("FORAY_GENERATION_MODE=local resolves the research route to 'none' (OQ-04)", () => {
    expect(routeFor("research", { FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: "http://127.0.0.1:4000" })?.provider).toBe("none");
  });
});

describe("GV-61: ST-03 — the research-shape fan-out asks nothing under 'none'", () => {
  /* MUTATION THAT KILLS THIS: drop the providerName === "none" early return in
     fanOutExternalResearch. Ran: red (research() called once per gap, and
     each gap marked externallyResearched with an empty note). */
  it("a catalogue gap is not researched, not marked researched, and one skip line names OQ-04", async () => {
    const researcher = new NullExternalResearcher();
    const research = vi.spyOn(researcher, "research");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const shape = await buildResearchShape(gapIntent, { researcher, ctx: { userId: "founder-1" }, catalogue: gapCatalogue() });

    expect(shape.subtopics.some((s) => s.tape.signal === "none")).toBe(true);
    expect(research).not.toHaveBeenCalled();
    for (const subtopic of shape.subtopics) {
      expect(subtopic.externallyResearched, subtopic.label).toBe(false);
      expect(subtopic.externalNotes, subtopic.label).toBeNull();
    }
    const skipLines = log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("external research skipped"));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain("OQ-04");
  });

  /* MUTATION THAT KILLS THIS: skip the fan-out for every researcher (the
     early return's condition made `true`). Ran: red. */
  it("any other route still fans out (today's behaviour)", async () => {
    const researcher = new StubExternalResearcher();
    const research = vi.spyOn(researcher, "research");
    await buildResearchShape(gapIntent, { researcher, ctx: { userId: "founder-1" }, catalogue: gapCatalogue() });
    expect(research).toHaveBeenCalled();
  });
});

describe("GV-61: a whole run under 'none' makes no research and no retrieval call, and completes", () => {
  /* MUTATION THAT KILLS THIS: build the evidence gatherer without the
     pipeline's researcher (`createEvidenceGatherer(cueProvider ? {...} : {})`,
     the pre-GV-61 line). The gatherer then builds its own Stub researcher and
     the Stub's retrievePassages is called for every content page. Ran: red. */
  it("zero research() and zero retrievePassages() calls on any researcher; the run is generated", async () => {
    const researcher = new NullExternalResearcher();
    const research = vi.spyOn(researcher, "research");
    const stubResearch = vi.spyOn(StubExternalResearcher.prototype, "research");
    const stubRetrieve = vi.spyOn(StubExternalResearcher.prototype, "retrievePassages");

    const out = await runForayPipeline(request, options, depsWith(researcher));

    expect(out.outcome).toBe("generated");
    expect(research).not.toHaveBeenCalled();
    expect(stubResearch).not.toHaveBeenCalled();
    expect(stubRetrieve).not.toHaveBeenCalled();
    expect((researcher as ExternalResearcher).retrievePassages).toBeUndefined();
  });

  /* MUTATION THAT KILLS THIS: drop the counting wrapper in writeNarration
     (hand writeActNarration the bare gatherer). Ran: red (printEvidenceSkipped
     0 under 'none'). */
  it("veracity.printEvidenceSkipped counts the content pages left without print under 'none', and is 0 when print arrived", async () => {
    const none = await runForayPipeline(request, options, depsWith(new NullExternalResearcher()));
    const stub = await runForayPipeline(request, options, depsWith(new StubExternalResearcher()));
    expect(none.outcome).toBe("generated");
    expect(stub.outcome).toBe("generated");
    if (none.outcome !== "generated" || stub.outcome !== "generated") return;

    expect(none.input.meta?.veracity?.printEvidenceSkipped).toBeGreaterThan(0);
    expect(stub.input.meta?.veracity?.printEvidenceSkipped).toBe(0);
  });
});
