import { describe, it, expect } from "vitest";
import { buildResearchShape, tapeSignalFor } from "../src/generation/researchShape";
import { loadCatalogueData, type CatalogueData } from "../src/generation/catalogueLookup";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import type { ExternalResearcher, ExternalResearchContext, ExternalResearchResult } from "../src/generation/ExternalResearcher";
import type { IntentUnderstanding } from "../src/types/generation";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";

function makeIntent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return {
    subject: "nuclear fusion reactors",
    angle: "how tokamak confinement actually works",
    priorKnowledge: "knows the name, not the mechanism",
    disappointment: "stays surface-level",
    ...overrides
  };
}

/**
 * A catalogue fixture that guarantees a genuine no-tape concept, unlike the
 * real on-disk catalogue where "onomatopoeia"-style subjects can drift onto
 * a well-covered concept (e.g. "language") as the catalogue grows over
 * time. Used only by the "no tape" test group below — the "against the
 * REAL catalogue" tests still exercise `loadCatalogueData()` directly.
 */
function noTapeFixtureCatalogue(): CatalogueData {
  return {
    items: [
      { id: "show-a--fusion-ep", show: "Show A", title: "Inside a Tokamak", topics: ["engineering/energy-fusion"], hook: "A deep look at fusion reactors." }
    ],
    itemTags: { "show-a--fusion-ep": ["fusion", "tokamak"] },
    concepts: {
      fusion: { terms: ["fusion", "tokamak"], topics: ["engineering/energy-fusion"], related: [] },
      // A real semantic-index concept with zero matching tape — this is the
      // genuine catalogue gap the "no tape" tests need, independent of
      // whatever the live on-disk catalogue happens to contain today.
      "sound-symbolism": {
        terms: ["onomatopoeia", "phonaesthetics", "sound-symbolism"],
        topics: ["language/linguistics"],
        related: []
      }
    },
    shows: [{ show_id: "show-a", title: "Show A", taxonomy_node_ids: ["engineering/energy-fusion"] }]
  };
}

function noTapeIntent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return makeIntent({
    subject: "onomatopoeia",
    angle: "sound symbolism and phonaesthetics, a linguistics curiosity with thin real-world tape",
    ...overrides
  });
}

/** Spy researcher: records every topic it was asked about, so tests can
 * assert the "cheap first" ordering — it must NOT fire for a topic the
 * catalogue already answered. */
class SpyExternalResearcher implements ExternalResearcher {
  readonly providerName = "spy";
  calls: string[] = [];
  constructor(private readonly guard: BudgetGuard) {}

  async research(topic: string, ctx: ExternalResearchContext): Promise<ExternalResearchResult> {
    this.calls.push(topic);
    await this.guard.checkAndRecord({
      userId: ctx.userId,
      operation: "external_research",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });
    return { notes: `spy notes for ${topic}`, controversies: [`spy controversy for ${topic}`] };
  }
}

function guardAndSink() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 5.0);
  return { sink, guard };
}

describe("tapeSignalFor", () => {
  it("maps item counts to the documented signal buckets", () => {
    expect(tapeSignalFor(0)).toBe("none");
    expect(tapeSignalFor(1)).toBe("thin");
    expect(tapeSignalFor(4)).toBe("thin");
    expect(tapeSignalFor(5)).toBe("moderate");
    expect(tapeSignalFor(19)).toBe("moderate");
    expect(tapeSignalFor(20)).toBe("strong");
    expect(tapeSignalFor(500)).toBe("strong");
  });
});

describe("buildResearchShape — §4.2 against the REAL catalogue (data/discover.json, data/catalog.json, data/semantic-index.json, data/item-tags.json)", () => {
  it("finds real tape for a subject the catalogue is known to be deep on (fusion)", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(makeIntent(), { researcher, ctx: { userId: "founder-1" } });

    expect(shape.subtopics.length).toBeGreaterThan(0);
    const fusionSubtopic = shape.subtopics.find((s) => s.label.toLowerCase() === "fusion");
    expect(fusionSubtopic).toBeDefined();
    expect(fusionSubtopic!.tape.signal).not.toBe("none");
    expect(fusionSubtopic!.tape.itemCount).toBeGreaterThan(0);
    // Accuracy check against real data: every example id returned must
    // actually exist in the real discover.json, so a wrong answer here
    // (a hallucinated id) is caught rather than silently accepted.
    const catalogue = loadCatalogueData();
    const realIds = new Set(catalogue.items.map((i) => i.id));
    for (const id of fusionSubtopic!.tape.exampleItemIds) {
      expect(realIds.has(id)).toBe(true);
    }
  });

  it("still produces a real, non-empty subtopic entry for a subject the catalogue has NO tape for — the guardrail against silent exclusion", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    expect(shape.subtopics.length).toBeGreaterThan(0);
    // A "no tape" subtopic must still be a first-class entry: present,
    // labeled, and carrying an honest "none" signal — never dropped.
    const noTapeEntries = shape.subtopics.filter((s) => s.tape.signal === "none");
    expect(noTapeEntries.length).toBeGreaterThan(0);
    for (const entry of noTapeEntries) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.tape.itemCount).toBe(0);
    }
  });

  it("carries the intent's subject and angle through unchanged", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const intent = makeIntent();
    const shape = await buildResearchShape(intent, { researcher, ctx: { userId: "founder-1" } });
    expect(shape.subject).toBe(intent.subject);
    expect(shape.angle).toBe(intent.angle);
    expect(shape.nonObviousAngle).toBe(intent.angle);
  });
});

describe("buildResearchShape — cheap-first ordering: external research fires ONLY for genuine catalogue gaps", () => {
  it("does NOT call the external researcher for a subtopic the catalogue already answers", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    // "fusion" is deep in the real catalogue — every matched subtopic here
    // should have real tape, so the spy must never fire.
    await buildResearchShape(makeIntent(), { researcher: spy, ctx: { userId: "founder-1" } });

    const catalogue = loadCatalogueData();
    // Sanity precondition: prove the fixture assumption is true against
    // real data before trusting the zero-calls assertion below.
    const fusionTerms = catalogue.concepts["fusion"]?.terms ?? [];
    expect(fusionTerms.length).toBeGreaterThan(0);

    expect(spy.calls).not.toContain("Fusion");
  });

  it("DOES call the external researcher for a subtopic with zero catalogue tape", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    const noTapeLabels = shape.subtopics.filter((s) => s.tape.signal === "none").map((s) => s.label);
    expect(noTapeLabels.length).toBeGreaterThan(0);
    for (const label of noTapeLabels) {
      expect(spy.calls).toContain(label);
    }
  });

  it("records externallyResearched=true only for subtopics that were actually gaps", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    for (const subtopic of shape.subtopics) {
      expect(subtopic.externallyResearched).toBe(subtopic.tape.signal === "none");
    }
  });

  it("externalGapsResearched lists exactly the labels that triggered external research", async () => {
    const { guard } = guardAndSink();
    const spy = new SpyExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher: spy,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });

    expect(shape.externalGapsResearched.sort()).toEqual([...spy.calls].sort());
  });

  it("populates controversies/externalNotes from a real (dry-run) research call for a gap subtopic", async () => {
    const { guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    const shape = await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });
    const gap = shape.subtopics.find((s) => s.tape.signal === "none");
    expect(gap).toBeDefined();
    expect(gap!.externalNotes).not.toBeNull();
  });
});

describe("buildResearchShape — budget guard wiring", () => {
  it("routes every external-research call through the budget guard (recorded as a cost event)", async () => {
    const { sink, guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    await buildResearchShape(noTapeIntent(), {
      researcher,
      ctx: { userId: "founder-1" },
      catalogue: noTapeFixtureCatalogue()
    });
    const events = await sink.all();
    expect(events.some((e) => e.operation === "external_research")).toBe(true);
  });

  it("records zero external_research cost events when every subtopic has real tape", async () => {
    const { sink, guard } = guardAndSink();
    const researcher = new StubExternalResearcher(guard);
    await buildResearchShape(makeIntent(), { researcher, ctx: { userId: "founder-1" } });
    const events = await sink.all();
    expect(events.filter((e) => e.operation === "external_research")).toHaveLength(0);
  });
});
