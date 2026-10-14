import { describe, it, expect } from "vitest";
import {
  NARRATED_BEAT_ESTIMATE_SEC,
  NARRATED_BEAT_FLOOR_SEC,
  TAPE_POOL_MEDIAN_SEC,
  narrationEstimateSec,
  plannedWindows,
  runtimeOverrunSec,
  runtimeViolations,
  spineCannotFit,
  spineRuntimeEstimateSec,
  spineRuntimeLine,
  spineRuntimeLowerBoundSec,
  spineRuntimeOf
} from "../src/generation/tierRuntime";
import { postSeedSpine } from "../src/generation/postSeedSpine";
import { TAPE_WINDOW_MIN_SEC } from "../src/generation/transcriptArchiveLookup";
import { MODE_CHAR_BANDS, NARRATION_CHARS_PER_SEC } from "../src/types/narration";
import {
  DURATION_RUNTIME_TARGET_SEC,
  SHAPE_TOLERANCE,
  TIER_RUNTIME_TOLERANCE,
  tierRuntimeBand,
  type Beat,
  type DeepenedAct,
  type Spine
} from "../src/types/spine";
import type { ResearchShape, ResearchTapeWindow } from "../src/types/research";

/**
 * GV-89 (docs/roadmap/generation-v2.md, W4-14): tier runtime targets and the
 * spine's runtime bound. Synthetic spines only; nothing here calls a model.
 */

const CLAIMS = [
  "Pitmasters in Lockhart smoked brisket over post oak for fourteen hours.",
  "Ford turned sawdust from Model T body shops into charcoal briquettes.",
  "Kingsford bought the briquette plant from Ford after the war.",
  "Kansas City sauce leaned on molasses and tomato for its sweetness.",
  "Carolina whole hog cooks mopped the pig with vinegar and red pepper.",
  "Memphis rib joints rubbed their racks with paprika before the dry smoke.",
  "Weber built the kettle grill from a cut marine buoy in Chicago.",
  "Argentine asado cooks raked embers under parrilla grates of iron.",
  "Korean galbi marinated short ribs in pear juice and soy.",
  "Japanese yakitori chefs fanned binchotan under skewered chicken."
];

const WINDOW_SEC = 120;

function window(i: number, lengthSec: number = WINDOW_SEC): ResearchTapeWindow {
  return { episodeId: `ep-${i}`, showTitle: "Smoke Talk", episodeTitle: `Episode ${i}`, startSec: 100, endSec: 100 + lengthSec, text: CLAIMS[i]!, score: 1 };
}

function seeded(i: number, lengthSec: number = WINDOW_SEC, extra: Partial<Beat> = {}): Beat {
  const w = window(i, lengthSec);
  return { claim: CLAIMS[i]!, exploration: i % 3 === 0, seed: { episodeId: w.episodeId, startSec: w.startSec, endSec: w.endSec }, ...extra };
}

function unseeded(i: number, extra: Partial<Beat> = {}): Beat {
  return { claim: CLAIMS[i]!, exploration: i % 3 === 0, ...extra };
}

const OVERVIEW = "Smoke, sauce and steel: how a handful of backyard habits travelled the world and back.";

function shortSpine(beats: Beat[], act: { introduction?: string; exit?: string } = {}): Spine {
  const half = Math.ceil(beats.length / 2);
  return {
    subject: "the history of grilling",
    angle: "how regional craft and industry met at the grill",
    overview: OVERVIEW,
    duration: "short",
    generatedAt: "2026-10-14T00:00:00.000Z",
    voice: { style: "curious", register: "conversational", sentenceRhythm: "varied", narratorPresence: "light" },
    acts: [
      {
        title: "Act 1: Smoke and fire",
        thesis: "Grilling grew out of industry as much as out of regional craft.",
        startState: "The listener thinks of grilling as a timeless backyard habit.",
        endState: "The listener sees the factories and pits behind it.",
        slots: [
          { title: "Pits and sauces", beats: beats.slice(0, half) },
          { title: "Kettles and coals", beats: beats.slice(half) }
        ],
        ...act
      }
    ]
  };
}

const overviewSec = OVERVIEW.length / NARRATION_CHARS_PER_SEC;

describe("GV-89: tier runtime targets", () => {
  it("each tier has a runtime target from the committed spec and a ±15% band; short is [765, 1035]", () => {
    /* MUTATION THAT KILLS THIS: set TIER_RUNTIME_TOLERANCE to 0.2 (or the
       short target to 600). The band below then reads [720, 1080] (or
       [510, 690]). Ran it: red. */
    expect(DURATION_RUNTIME_TARGET_SEC).toEqual({ short: 900, medium: 3600, long: 10800 });
    expect(TIER_RUNTIME_TOLERANCE).toBe(SHAPE_TOLERANCE);
    expect(tierRuntimeBand("short")).toEqual([765, 1035]);
    expect(tierRuntimeBand("medium")).toEqual([3060, 4140]);
    expect(tierRuntimeBand("long")).toEqual([9180, 12420]);
  });
});

describe("GV-89: the spine's runtime lower bound", () => {
  it("a short spine whose 10 seeded beats use distinct 120 s windows has a lower bound of at least 1,200 s, above the 1,035 s ceiling", () => {
    /* MUTATION THAT KILLS THIS: count the seed windows at TAPE_WINDOW_MIN_SEC
       instead of max(TAPE_WINDOW_MIN_SEC, length). The bound drops to
       600 s + overview and fits. Ran it: red. */
    const spine = shortSpine(CLAIMS.map((_, i) => seeded(i)));
    const bound = spineRuntimeLowerBoundSec(spine);
    expect(bound).toBeGreaterThanOrEqual(1200);
    expect(bound).toBeCloseTo(10 * WINDOW_SEC + overviewSec, 6);
    expect(bound).toBeGreaterThan(tierRuntimeBand("short")[1]);
    expect(spineCannotFit(spine)).toBe(true);
    expect(runtimeOverrunSec(spine)).toBeCloseTo(bound - 1035, 6);
  });

  it("counts each distinct seed window once, never under the tape floor", () => {
    /* MUTATION THAT KILLS THIS: count a window once per BEAT seeded from it
       (drop the seedKey dedupe in plannedWindows). The shared window below is
       then counted twice. Ran it: red. */
    const twice = shortSpine([seeded(0), { ...seeded(0), claim: CLAIMS[1]! }, seeded(2, 30), ...[3, 4, 5, 6, 7].map((i) => unseeded(i))]);
    expect(plannedWindows(twice.acts)).toHaveLength(2);
    expect(plannedWindows(twice.acts)[0]!.beats).toBe(2);
    /* The 30 s window counts at the 60 s floor. */
    expect(spineRuntimeLowerBoundSec(twice)).toBeCloseTo(WINDOW_SEC + TAPE_WINDOW_MIN_SEC + 5 * NARRATED_BEAT_FLOOR_SEC + overviewSec, 6);
  });

  it("an unseeded beat costs the Patch floor, and an argument beat is narrated whatever its seed says", () => {
    /* MUTATION THAT KILLS THIS: count an argument beat's seed window as tape
       (drop the `kind !== "argument"` test in tapesFromSeed). Ran it: red. */
    expect(NARRATED_BEAT_FLOOR_SEC).toBe(MODE_CHAR_BANDS.Patch[0] / NARRATION_CHARS_PER_SEC);
    expect(NARRATED_BEAT_FLOOR_SEC).toBe(20);
    const spine = shortSpine([seeded(0), seeded(1, WINDOW_SEC, { kind: "argument" }), ...[2, 3, 4, 5, 6, 7].map((i) => unseeded(i))]);
    expect(spineRuntimeLowerBoundSec(spine)).toBeCloseTo(WINDOW_SEC + 7 * 20 + overviewSec, 6);
  });

  it("folded introduction and exit characters count at the planning rate", () => {
    /* MUTATION THAT KILLS THIS: leave the acts' introduction and exit out of
       the bound. Ran it: red. */
    const introduction = "x".repeat(170);
    const exit = "y".repeat(85);
    const plain = shortSpine([seeded(0), seeded(1), ...[2, 3, 4, 5, 6, 7].map((i) => unseeded(i))]);
    const folded = shortSpine(plain.acts[0]!.slots.flatMap((s) => s.beats), { introduction, exit });
    expect(spineRuntimeLowerBoundSec(folded) - spineRuntimeLowerBoundSec(plain)).toBeCloseTo(15, 6);
  });

  it("seeds attached by post-seeding count toward the bound: a spine that fits as written cannot fit once post-seeded", () => {
    /* MUTATION THAT KILLS THIS: none in tierRuntime.ts by itself; this pins
       the fixture the pipeline test relies on (spineReask.test.ts), where
       running the check before postSeedWithFloor makes no re-ask. */
    const asWritten = shortSpine([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i < 4 ? seeded(i) : unseeded(i))));
    const shape: ResearchShape = {
      subject: "the history of grilling",
      angle: "how regional craft and industry met at the grill",
      generatedAt: "2026-10-14T00:00:00.000Z",
      subtopics: [
        {
          label: "barbecue",
          source: "literal-term",
          tape: { signal: "strong", itemCount: 10, showCount: 1, exampleItemIds: [] },
          controversies: [],
          externalNotes: null,
          externallyResearched: false,
          windowsUnavailable: null,
          tapeWindows: CLAIMS.map((_, i) => window(i))
        }
      ],
      nonObviousAngle: null,
      externalGapsResearched: []
    };
    expect(spineCannotFit(asWritten)).toBe(false);
    const post = postSeedSpine(asWritten, shape);
    expect(post.assigned).toBe(6);
    expect(spineCannotFit(post.spine)).toBe(true);
  });
});

describe("GV-89: the estimate, the narration estimate and the report line", () => {
  it("seeded windows at max(length, 124 s), unseeded beats at the Patch mid-band; never below the lower bound", () => {
    /* MUTATION THAT KILLS THIS: estimate a seeded window at its own length
       (drop the pool-median max). The 60 s window below then counts 60, not
       124. Ran it: red. */
    expect(TAPE_POOL_MEDIAN_SEC).toBe(124);
    expect(NARRATED_BEAT_ESTIMATE_SEC).toBe(32.5);
    const spine = shortSpine([seeded(0, 60), seeded(1, 200), ...[2, 3, 4, 5, 6, 7].map((i) => unseeded(i))]);
    expect(spineRuntimeEstimateSec(spine)).toBeCloseTo(124 + 200 + 6 * 32.5 + overviewSec, 6);
    expect(spineRuntimeEstimateSec(spine)).toBeGreaterThanOrEqual(spineRuntimeLowerBoundSec(spine));
    expect(spineRuntimeOf(spine)).toEqual({
      lowerBoundSec: Math.round(60 + 200 + 6 * 20 + overviewSec),
      estimateSec: Math.round(124 + 200 + 6 * 32.5 + overviewSec)
    });
  });

  it("narrationEstimateSec sums deepened acts' introduction and exit plus each narrated beat at mid-band", () => {
    /* MUTATION THAT KILLS THIS: count every beat at mid-band, seeded or not.
       The seeded beat below then adds 32.5 s. Ran it: red. */
    const act: DeepenedAct = {
      ...shortSpine([]).acts[0]!,
      introduction: "a".repeat(340),
      exit: "b".repeat(170),
      slots: [{ title: "Pits", beats: [seeded(0), unseeded(1), unseeded(2, { kind: "argument" })] }]
    };
    expect(narrationEstimateSec([act])).toBeCloseTo(20 + 10 + 2 * 32.5, 6);
  });

  it("the violations name the overrun first, then each seed window with its length; the log line has the agreed shape", () => {
    /* MUTATION THAT KILLS THIS: drop the headline (return only the window
       lines). The model would then not be told by how much the plan
       overruns. Ran it: red. */
    const spine = shortSpine(CLAIMS.map((_, i) => seeded(i)));
    const lines = runtimeViolations(spine);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toMatch(/^the plan's minimum runtime is \d+ s — 10 distinct seeded window\(s\) at 1200 s/);
    expect(lines[0]).toMatch(/above the short tier's ceiling of 1035 s \(target 900 s, \+15%\) by \d+ s$/);
    expect(lines[1]).toBe(`act 1, slot 1, beat 1: seeded from [ep-0 100-220s], at least 120 s of tape — "${CLAIMS[0]}"`);
    expect(spineRuntimeLine({ lowerBoundSec: 1205, estimateSec: 1290 }, "short")).toBe(
      "spine runtime: lower bound 1205s, estimate 1290s, tier band [765,1035]"
    );
  });
});
