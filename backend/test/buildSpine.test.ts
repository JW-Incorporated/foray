import { describe, it, expect } from "vitest";
import { buildSpine, InvalidSpineError } from "../src/generation/buildSpine";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import type { SpineBuilder, SpineBuildContext } from "../src/generation/SpineBuilder";
import {
  DURATION_SHAPE_BUDGETS,
  EXPLORATION_FLOOR,
  SPINE_MIN_SEEDED_BEATS_PER_ACT,
  allBeats,
  countActs,
  countSlots,
  isClaimShaped,
  type DurationTier,
  type Spine
} from "../src/types/spine";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { m4SegmentCapFor } from "../src/generation/sourceBeats";
import { SPINE_SEED_REPEAT_MIN } from "../src/generation/spineSeeding";
import { tokenizeForSourcing } from "../src/generation/catalogueLookup";

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
        externallyResearched: false,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
      },
      {
        label: "postwar suburban grilling culture",
        source: "semantic-concept",
        tape: { signal: "moderate", itemCount: 12, showCount: 3, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
      },
      {
        label: "briquette chemistry",
        source: "literal-term",
        tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
      },
      {
        label: "grill design evolution",
        source: "literal-term",
        tape: { signal: "none", itemCount: 0, showCount: 0, exampleItemIds: [] },
        controversies: [],
        externalNotes: "no external research available in dry-run",
        externallyResearched: true,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
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

/* WS-L (F-63): the dry-run path has to be able to produce the thing the real
   path is now asked for — a spine whose account beats were written FROM quoted
   tape — or every keyless test of the seed path would be testing an empty
   feature. */
describe("buildSpine — WS-L: the stub writes beats from the research map's tape windows (F-63)", () => {
  const windowText =
    "the labels in that benchmark were wrong more often than anyone admitted. " +
    "An audit found thousands of mislabelled validation images across the whole benchmark. " +
    "Those wrong labels put a ceiling on the accuracy anyone could report.";

  function shapeWithWindows(): ResearchShape {
    const base = makeResearchShape();
    return {
      ...base,
      subtopics: base.subtopics.map((s, i) =>
        i > 0
          ? s
          : {
              ...s,
              windowsUnavailable: null,
              tapeWindows: [
                {
                  episodeId: "practical-ai--episode-900",
                  showTitle: "Practical AI",
                  episodeTitle: "Episode 900",
                  startSec: 100,
                  endSec: 165,
                  text: windowText,
                  score: 3.2
                },
                {
                  episodeId: "practical-ai--episode-901",
                  showTitle: "Practical AI",
                  episodeTitle: "Episode 901",
                  startSec: 300,
                  endSec: 380,
                  text:
                    "we retrain on a fixed calendar rather than on a signal. " +
                    "The inventory feed goes stale on a Friday and nobody notices until Monday. " +
                    "That is the whole of what monitoring buys you in practice.",
                  score: 2.1
                }
              ]
            }
      )
    };
  }

  it("gives every act its seeded beats, each naming a window the map actually listed", async () => {
    const { guard } = guardAndSink();
    const shape = shapeWithWindows();
    const spine = await buildSpine(makeIntent(), shape, "medium", new StubSpineBuilder(guard), ctx);

    const listed = new Set(shape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId)));
    for (const [i, act] of spine.acts.entries()) {
      const seeded = act.slots.flatMap((s) => s.beats).filter((b) => b.seed && listed.has(b.seed.episodeId));
      expect(seeded.length, `act ${i + 1}`).toBeGreaterThanOrEqual(SPINE_MIN_SEEDED_BEATS_PER_ACT);
    }
  });

  it("writes those beats out of the window's own words, not out of a template about them", async () => {
    /* The property that makes the seed worth anything downstream: §4.5's
       relevance floor asks whether the tape says the claim, so a claim assembled
       from the window's own sentences can pass it and a claim generated about
       the window cannot. This is run 2's failure in miniature. */
    const { guard } = guardAndSink();
    const spine = await buildSpine(makeIntent(), shapeWithWindows(), "medium", new StubSpineBuilder(guard), ctx);
    const seededClaims = spine.acts
      .flatMap((a) => a.slots.flatMap((s) => s.beats))
      .filter((b) => b.seed?.episodeId === "practical-ai--episode-900")
      .map((b) => b.claim);

    expect(seededClaims.length).toBeGreaterThan(0);
    for (const claim of seededClaims) {
      const words = claim.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
      const spoken = windowText.toLowerCase();
      const shared = words.filter((w) => w.length > 3 && spoken.includes(w)).length;
      expect(shared, claim).toBeGreaterThanOrEqual(5);
    }
    /* And they are distinct claims, which the duplicate-claim gate requires. */
    expect(new Set(seededClaims).size).toBe(seededClaims.length);
  });

  it("leaves the spine seedless — and valid — when the research map quoted nothing", async () => {
    const { guard } = guardAndSink();
    const spine = await buildSpine(makeIntent(), makeResearchShape(), "medium", new StubSpineBuilder(guard), ctx);
    expect(allBeats(spine).every((b) => b.seed === undefined)).toBe(true);
  });
});

/* G-25 (tape-yield brief §5 R4 + R3): the stub seeds every beat an admissible
   window exists for, admissible meaning what §4.5's M4/M3 ledger will admit,
   and every seeded claim is the window's own words. The fixture generator is
   what the offline run-2 replay measures with, so these are the properties
   that make its number mean something. */
describe("buildSpine — G-25: the stub seeds every beat it can, one episode at a time until eight (R4, R3)", () => {
  /** Three claim-shaped sentences about `topic`, distinct per topic so no two
   * windows can produce the same claim. */
  function windowText(topic: string): string {
    return (
      `The ${topic} pipeline failed on a Friday and nobody noticed the ${topic} outage until Monday morning. ` +
      `The ${topic} retraining job ran on a fixed calendar rather than on any signal from the data itself. ` +
      `An audit of the ${topic} labels found thousands of mislabelled validation images across the whole benchmark.`
    );
  }

  function shapeWith(windows: Array<{ episode: string; startSec: number; topic: string }>): ResearchShape {
    const base = makeResearchShape();
    return {
      ...base,
      subtopics: base.subtopics.map((s, i) =>
        i > 0
          ? s
          : {
              ...s,
              windowsUnavailable: null,
              tapeWindows: windows.map((w) => ({
                episodeId: `practical-ai--${w.episode}`,
                showTitle: "Practical AI",
                episodeTitle: w.episode,
                startSec: w.startSec,
                endSec: w.startSec + 100,
                text: windowText(w.topic),
                score: 2
              }))
            }
      )
    };
  }

  const tenEpisodes = ["inventory", "payments", "fraud", "search", "ranking", "speech", "vision", "logistics", "billing", "weather"].map(
    (topic, i) => ({ episode: `episode-${900 + i}`, startSec: 100 + i * 10, topic })
  );

  it("seeds EVERY beat when the map's windows come from enough episodes — not the floor's two per act", async () => {
    /* Run 2's spine seeded 14 of 32 beats and the unseeded 18 yielded nothing
       at any floor (brief §3). The floor stays a floor; the ask is every beat.
       MUTATION THAT KILLS THIS: put `seededThisAct < SPINE_MIN_SEEDED_BEATS_PER_ACT`
       back as the condition on seeding in `StubSpineBuilder.ts`. Ran it — red
       (8 of 32 seeded). */
    const { guard } = guardAndSink();
    const spine = await buildSpine(makeIntent(), shapeWith(tenEpisodes), "medium", new StubSpineBuilder(guard), ctx);
    const beats = allBeats(spine);
    expect(beats.length).toBeGreaterThanOrEqual(DURATION_SHAPE_BUDGETS.medium.items[0]);
    expect(beats.filter((b) => b.seed).length).toBe(beats.length);
    expect(beats.filter((b) => b.seed).length).toBeGreaterThan(SPINE_MIN_SEEDED_BEATS_PER_ACT * spine.acts.length);
  });

  it("names eight DIFFERENT episodes before it seeds any episode twice, and never runs one episode's tape backwards", async () => {
    /* The run-2 spine seeded two episodes twice among fourteen seeds and lost
       an on-claim window at `m4-share` (brief §4 cause 3). The map here is
       adversarial: three windows of episode-900 come FIRST — the second LATER
       on the tape (so only the share rule can refuse it), the third EARLIER
       (so only the order rule can) — and a fourth window of it comes last.
       MUTATIONS THAT KILL THIS: (a) make `SpineSeedLedger.shareAllows` return
       true — the second seed is episode-900's 600 s window and the first eight
       are no longer distinct; (b) make `orderAllows` return true — the 500 s
       window is seeded again after the 700 s one, backwards. Ran both — red. */
    const { guard } = guardAndSink();
    const others = tenEpisodes.slice(1, 8); // seven more episodes: eight distinct in all
    const shape = shapeWith([
      { episode: "episode-900", startSec: 500, topic: "inventory" },
      { episode: "episode-900", startSec: 600, topic: "returns" },
      { episode: "episode-900", startSec: 100, topic: "checkout" },
      ...others,
      { episode: "episode-900", startSec: 700, topic: "shipping" }
    ]);
    const spine = await buildSpine(makeIntent(), shape, "medium", new StubSpineBuilder(guard), ctx);
    const seeds = allBeats(spine).flatMap((b) => (b.seed ? [b.seed] : []));

    const firstEight = seeds.slice(0, 8).map((s) => s.episodeId);
    expect(new Set(firstEight).size).toBe(8);
    /* At every prefix, no episode is over the share §4.5 would allow it if
       every seed became a segment. */
    const count = new Map<string, number>();
    seeds.forEach((seed, i) => {
      count.set(seed.episodeId, (count.get(seed.episodeId) ?? 0) + 1);
      expect(count.get(seed.episodeId)!, `seed ${i + 1} (${seed.episodeId})`).toBeLessThanOrEqual(m4SegmentCapFor(i + 1));
    });
    /* The earlier-on-tape window of the repeated episode is never seeded... */
    expect(seeds.some((s) => s.episodeId === "practical-ai--episode-900" && s.startSec === 100)).toBe(false);
    /* ...and the later one is, once the spine carries eight. */
    const lateRepeat = seeds.findIndex((s) => s.episodeId === "practical-ai--episode-900" && s.startSec === 700);
    expect(lateRepeat).toBeGreaterThanOrEqual(SPINE_SEED_REPEAT_MIN - 1);
    const starts900 = seeds.filter((s) => s.episodeId === "practical-ai--episode-900").map((s) => s.startSec);
    for (let i = 1; i < starts900.length; i++) expect(starts900[i]!).toBeGreaterThanOrEqual(starts900[i - 1]!);
  });

  it("still meets the per-act floor when the map's tape lives in one episode — the ledger is a preference, the floor a gate", async () => {
    /* "A subject whose tape lives in one episode still gets a spine." With one
       episode the ledger refuses every seed after the first, and an act still
       under its floor takes the next window regardless — otherwise
       `assertSpineStructure` would refuse the dry-run spine for the archive's
       thinness.
       MUTATION THAT KILLS THIS: delete the floor fallback (the `??` branch on
       `seededThisAct`) in `StubSpineBuilder.ts`. Ran it — red
       (act-below-seeded-beat-floor). */
    const { guard } = guardAndSink();
    const shape = shapeWith([{ episode: "episode-900", startSec: 100, topic: "inventory" }]);
    const spine = await buildSpine(makeIntent(), shape, "medium", new StubSpineBuilder(guard), ctx);
    for (const [i, act] of spine.acts.entries()) {
      const seeded = act.slots.flatMap((s) => s.beats).filter((b) => b.seed);
      expect(seeded.length, `act ${i + 1}`).toBeGreaterThanOrEqual(SPINE_MIN_SEEDED_BEATS_PER_ACT);
    }
  });

  it("every seeded claim's words are its own window's words — claim faithfulness, by §4.5's tokenizer", async () => {
    /* The seed is a claim that the tape SAYS the claim (F-63), and §4.5 checks
       it by the claim's content words against the window's. A stub that put
       words in a seeded claim the window never said — a template, a framing
       phrase — would be run 2's failure with a seed attached. Every seeded
       beat, including the ones written after a window's sentences were spent
       (32 beats from 10 windows), is held to it.
       MUTATIONS THAT KILL THIS: (a) in `claimFromWindow`, return
       `claimFor(...)` — red on the first beat; (b) put the "The tape says: …"
       framing back into `runClaims` — red on the first reused window. Ran
       both — red. */
    const { guard } = guardAndSink();
    const shape = shapeWith(tenEpisodes);
    const windows = shape.subtopics[0]!.tapeWindows;
    const spine = await buildSpine(makeIntent(), shape, "medium", new StubSpineBuilder(guard), ctx);
    const seeded = allBeats(spine).filter((b) => b.seed);
    expect(seeded.length).toBe(allBeats(spine).length);
    for (const beat of seeded) {
      const window = windows.find(
        (w) => w.episodeId === beat.seed!.episodeId && w.startSec === beat.seed!.startSec && w.endSec === beat.seed!.endSec
      );
      expect(window, `seed ${JSON.stringify(beat.seed)} names a window the map listed`).toBeDefined();
      const spoken = new Set(tokenizeForSourcing(window!.text));
      const claimWords = tokenizeForSourcing(beat.claim);
      expect(claimWords.length).toBeGreaterThan(0);
      const foreign = claimWords.filter((w) => !spoken.has(w));
      expect(foreign, `"${beat.claim}" carries words its window never said`).toEqual([]);
    }
  });
});
