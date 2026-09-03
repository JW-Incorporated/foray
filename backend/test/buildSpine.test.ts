import { describe, it, expect } from "vitest";
import { buildSpine, InvalidSpineError } from "../src/generation/buildSpine";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import type { SpineBuilder, SpineBuildContext } from "../src/generation/SpineBuilder";
import { DURATION_SHAPE_BUDGETS, EXPLORATION_FLOOR, allBeats, countActs, countSlots, isClaimShaped, type DurationTier, type Spine } from "../src/types/spine";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";

function makeIntent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return {
    subject: "the history of grilling",
    angle: "how an industrial waste product became a backyard ritual",
    priorKnowledge: "knows charcoal grilling exists, not where briquettes came from",
    disappointment: "stays surface-level and never mentions Ford",
    ...overrides
  };
}

function makeResearchShape(overrides: Partial<ResearchShape> = {}): ResearchShape {
  return {
    subject: "the history of grilling",
    angle: "how an industrial waste product became a backyard ritual",
    generatedAt: new Date().toISOString(),
    subtopics: [
      {
        label: "Ford briquette scheme",
        source: "semantic-concept",
        tape: { signal: "strong", itemCount: 30, showCount: 5, exampleItemIds: [] },
        controversies: ["whether Henry Ford or Edward Kingsford deserves credit"],
        externalNotes: null,
        externallyResearched: false
      },
      {
        label: "postwar suburban grilling culture",
        source: "semantic-concept",
        tape: { signal: "moderate", itemCount: 12, showCount: 3, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false
      },
      {
        label: "briquette chemistry",
        source: "literal-term",
        tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false
      },
      {
        label: "grill design evolution",
        source: "literal-term",
        tape: { signal: "none", itemCount: 0, showCount: 0, exampleItemIds: [] },
        controversies: [],
        externalNotes: "no external research available in dry-run",
        externallyResearched: true
      }
    ],
    nonObviousAngle: "how an industrial waste product became a backyard ritual",
    externalGapsResearched: ["grill design evolution"],
    ...overrides
  };
}

function guardAndSink() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 10.0);
  return { sink, guard };
}

const ctx: SpineBuildContext = { userId: "founder-1" };

describe("buildSpine — StubSpineBuilder produces a valid spine per duration tier", () => {
  const tiers: DurationTier[] = ["short", "medium", "long"];

  for (const tier of tiers) {
    it(`hits ${tier}'s act/slot/item budget within tolerance and passes all quality gates`, async () => {
      const { guard } = guardAndSink();
      const builder = new StubSpineBuilder(guard);
      const spine = await buildSpine(makeIntent(), makeResearchShape(), tier, builder, ctx);

      const budget = DURATION_SHAPE_BUDGETS[tier];
      const acts = countActs(spine);
      const slots = countSlots(spine);
      const beats = allBeats(spine);

      expect(acts).toBeGreaterThanOrEqual(budget.acts[0]);
      expect(acts).toBeLessThanOrEqual(budget.acts[1]);
      expect(slots).toBeGreaterThanOrEqual(Math.floor(budget.slots[0] * 0.85));
      expect(slots).toBeLessThanOrEqual(Math.ceil(budget.slots[1] * 1.15));
      expect(beats.length).toBeGreaterThanOrEqual(Math.floor(budget.items[0] * 0.85));
      expect(beats.length).toBeLessThanOrEqual(Math.ceil(budget.items[1] * 1.15));

      // Every beat is claim-shaped, not topic-shaped.
      for (const beat of beats) {
        expect(isClaimShaped(beat.claim)).toBe(true);
      }

      // Exploration floor actually met, not just present.
      const explorationCount = beats.filter((b) => b.exploration).length;
      expect(explorationCount / beats.length).toBeGreaterThanOrEqual(EXPLORATION_FLOOR);

      // Voice specified once, at the spine level.
      expect(spine.voice).toBeDefined();
      expect((spine.acts[0] as unknown as { voice?: unknown }).voice).toBeUndefined();
    });
  }

  it("routes the builder call through the budget guard as a recorded cost event", async () => {
    const { sink, guard } = guardAndSink();
    const builder = new StubSpineBuilder(guard);
    await buildSpine(makeIntent(), makeResearchShape(), "short", builder, ctx);
    const events = await sink.all();
    expect(events.some((e) => e.operation === "spine_build")).toBe(true);
  });

  it("carries subject, angle, and duration through unchanged", async () => {
    const { guard } = guardAndSink();
    const builder = new StubSpineBuilder(guard);
    const intent = makeIntent();
    const spine = await buildSpine(intent, makeResearchShape(), "medium", builder, ctx);
    expect(spine.subject).toBe(intent.subject);
    expect(spine.angle).toBe(intent.angle);
    expect(spine.duration).toBe("medium");
  });
});

describe("buildSpine — rejects an invalid spine rather than silently accepting it", () => {
  class OvershootingBuilder implements SpineBuilder {
    readonly providerName = "broken-overshoot";
    async buildSpine(intent: IntentUnderstanding, _shape: ResearchShape, duration: DurationTier): Promise<Spine> {
      // Deliberately produces a "short" spine with 40%+ more acts than the
      // budget allows — §3's own framing of what a defect looks like.
      const oneAct = {
        title: "Act",
        thesis: "thesis",
        startState: "start",
        endState: "end",
        slots: [
          {
            title: "slot",
            beats: [
              { claim: "This subject changed rapidly after a key discovery.", exploration: true },
              { claim: "Researchers documented this subject extensively in the 1990s.", exploration: false }
            ]
          }
        ]
      };
      return {
        subject: intent.subject,
        angle: intent.angle,
        duration,
        generatedAt: new Date().toISOString(),
        voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
        acts: [oneAct, oneAct] // short tier wants exactly 1 act — this is 2, well past ±15%
      };
    }
  }

  class TopicShapedBuilder implements SpineBuilder {
    readonly providerName = "broken-topic-shaped";
    async buildSpine(intent: IntentUnderstanding, _shape: ResearchShape, duration: DurationTier): Promise<Spine> {
      return {
        subject: intent.subject,
        angle: intent.angle,
        duration,
        generatedAt: new Date().toISOString(),
        voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
        acts: [
          {
            title: "Act",
            thesis: "thesis",
            startState: "start",
            endState: "end",
            slots: [
              {
                title: "slot",
                beats: [
                  { claim: "Briquettes", exploration: false },
                  { claim: "Grilling", exploration: true }
                ]
              }
            ]
          }
        ]
      };
    }
  }

  it("throws InvalidSpineError when act count overshoots the tier budget", async () => {
    await expect(buildSpine(makeIntent(), makeResearchShape(), "short", new OvershootingBuilder(), ctx)).rejects.toThrow(InvalidSpineError);
  });

  it("throws InvalidSpineError when a beat is topic-shaped rather than claim-shaped", async () => {
    await expect(buildSpine(makeIntent(), makeResearchShape(), "short", new TopicShapedBuilder(), ctx)).rejects.toThrow(InvalidSpineError);
  });

  it("InvalidSpineError carries the structured validation result for diagnostics", async () => {
    try {
      await buildSpine(makeIntent(), makeResearchShape(), "short", new TopicShapedBuilder(), ctx);
      expect.unreachable("expected buildSpine to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSpineError);
      const invalidErr = err as InvalidSpineError;
      expect(invalidErr.validation.valid).toBe(false);
      expect(invalidErr.validation.issues.length).toBeGreaterThan(0);
    }
  });
});
