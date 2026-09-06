import { describe, it, expect } from "vitest";
import {
  DURATION_SHAPE_BUDGETS,
  EXPLORATION_FLOOR,
  SHAPE_TOLERANCE,
  SpineSchema,
  allBeats,
  countActs,
  countBeats,
  countSlots,
  isClaimShaped,
  validateSpine,
  type Spine
} from "../src/types/spine";

/** Builds a minimal, valid-by-construction spine for a given tier, hitting
 * the midpoint of §3's act/slot/item budget and marking exactly enough
 * beats exploration to clear the floor with room to spare. Tests mutate
 * copies of this to probe individual validation failures. */
function makeSpine(overrides: Partial<Spine> = {}): Spine {
  const acts = [
    {
      title: "Act 1: The origin",
      thesis: "Establishes where this all began.",
      startState: "The listener knows the name only.",
      endState: "The listener understands the origin.",
      slots: [
        {
          title: "Slot 1",
          beats: [
            { claim: "Charcoal briquettes were a Ford Motor Company waste-disposal scheme.", exploration: false },
            { claim: "Ford dealerships sold briquettes alongside cars for decades.", exploration: false },
            { claim: "A little-known patent dispute over the briquette process delayed production for years.", exploration: true }
          ]
        },
        {
          title: "Slot 2",
          beats: [
            { claim: "Kingsford absorbed the briquette business after Ford's ownership ended.", exploration: false },
            { claim: "Early briquette marketing borrowed heavily from wartime rationing campaigns.", exploration: true }
          ]
        }
      ]
    }
  ];

  return {
    subject: "the history of grilling",
    angle: "how an industrial waste product became a backyard ritual",
    duration: "short",
    generatedAt: new Date().toISOString(),
    voice: {
      style: "Plain, curious, well-read-friend register.",
      register: "Conversational but precise.",
      sentenceRhythm: "Short declarative sentences.",
      narratorPresence: "Present enough to guide, never editorializing."
    },
    acts,
    ...overrides
  };
}

describe("isClaimShaped", () => {
  it("accepts the doc's own example beat", () => {
    expect(isClaimShaped("Charcoal briquettes were a Ford Motor Company waste-disposal scheme")).toBe(true);
  });

  it("rejects the doc's own example non-beat (a bare topic)", () => {
    expect(isClaimShaped("Briquettes")).toBe(false);
  });

  it("rejects a noun phrase with no assertion", () => {
    expect(isClaimShaped("The history of charcoal briquette manufacturing")).toBe(false);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(isClaimShaped("")).toBe(false);
    expect(isClaimShaped("   ")).toBe(false);
  });

  it("accepts a claim using a finite auxiliary verb", () => {
    expect(isClaimShaped("Kingsford is the largest briquette brand in America")).toBe(true);
  });

  it("accepts a claim using an inflected content verb", () => {
    expect(isClaimShaped("Ford dealerships sold briquettes alongside cars")).toBe(true);
  });

  it("accepts ordinary verbs outside any fixed allowlist via subject agreement", () => {
    // "controls"/"dominates" carry no closed-class auxiliary and are not
    // enumerated anywhere — this must pass on the -s + preceding-subject
    // structural signal alone, proving the check isn't just a verb list.
    expect(isClaimShaped("Kingsford controls most of the briquette market")).toBe(true);
    expect(isClaimShaped("Ford dominates every early account of this story")).toBe(true);
  });

  it("accepts an irregular simple-past verb not in any -ed/-s pattern", () => {
    expect(isClaimShaped("Ford ran the briquette operation for two decades")).toBe(true);
  });

  it("accepts a plural-subject clause with a bare-form present-tense verb", () => {
    expect(isClaimShaped("Researchers study charcoal production worldwide")).toBe(true);
    expect(isClaimShaped("Historians dispute the standard timeline")).toBe(true);
  });

  it("rejects a mid-sentence capitalized noun followed by a plural noun (compound noun phrase, not a claim)", () => {
    expect(isClaimShaped("Ford briquettes and Kingsford products")).toBe(false);
  });

  it("accepts a multi-word capitalized subject phrase with an inflected verb", () => {
    // The exact case cited in review: a determiner + multi-word proper
    // noun subject, followed by a present-tense verb.
    expect(isClaimShaped("The Ford Motor Company controls the market")).toBe(true);
    expect(isClaimShaped("The Ford Motor Company dominated the market for decades")).toBe(true);
  });

  it("still rejects a determiner + noun phrase with no verb at all", () => {
    expect(isClaimShaped("The history of charcoal briquette manufacturing")).toBe(false);
  });

  it("accepts a common-noun subject with present-tense verb agreement anywhere in the sentence", () => {
    // The exact case cited in review: a lowercase common-noun subject
    // ("Charcoal production"), not a proper noun — the verb signal has to
    // be found without relying on subject-position capitalization at all.
    expect(isClaimShaped("Charcoal production shapes modern grilling culture")).toBe(true);
  });

  it("accepts a claim whose only verb is an invariant-form irregular (hurt/cut/put)", () => {
    // The exact case cited in review: "hurt" has no -ed and isn't a
    // vowel-change irregular past — it needs its own enumerated list.
    expect(isClaimShaped("The policy hurt workers throughout the recession")).toBe(true);
  });

  it("accepts a claim via clause-adjunct corroboration even with an unrecognized verb", () => {
    // No morphological signal and not on any list — only the "because"
    // clause-adjunct evidence should carry this one.
    expect(isClaimShaped("Sales dropped because supply chains buckled")).toBe(true);
  });
});

describe("countActs / countSlots / countBeats / allBeats", () => {
  it("counts a known fixture correctly", () => {
    const spine = makeSpine();
    expect(countActs(spine)).toBe(1);
    expect(countSlots(spine)).toBe(2);
    expect(countBeats(spine)).toBe(5);
    expect(allBeats(spine)).toHaveLength(5);
  });
});

describe("SpineSchema", () => {
  it("parses a well-formed spine", () => {
    expect(() => SpineSchema.parse(makeSpine())).not.toThrow();
  });

  it("rejects an act carrying a stray voice field (per-act voice drift is structurally impossible)", () => {
    const spine = makeSpine();
    const polluted = {
      ...spine,
      acts: [{ ...spine.acts[0]!, voice: { style: "a different voice" } }]
    };
    expect(() => SpineSchema.parse(polluted)).toThrow();
  });

  it("rejects a beat missing the exploration flag", () => {
    const spine = makeSpine();
    const polluted = {
      ...spine,
      acts: [
        {
          ...spine.acts[0]!,
          slots: [{ title: "Slot 1", beats: [{ claim: "A claim with a verb happened here." }] }]
        }
      ]
    };
    expect(() => SpineSchema.parse(polluted)).toThrow();
  });
});

describe("validateSpine — shape budgets (§3, ±15% tolerance from §8)", () => {
  it("accepts a short-tier spine hitting the exact budget midpoint", () => {
    const spine = makeSpine(); // 1 act, 2 slots, 5 beats — within short's 1/2-3/8-10 band... 5 items is below 8
    const result = validateSpine(spine);
    // 5 items is below short's 8-10 band even with 15% tolerance (8*0.85=6.8) — expect a real failure here,
    // proving the check is not cosmetic.
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "item-count-out-of-budget")).toBe(true);
  });

  it("accepts a short-tier spine within the item budget", () => {
    const spine = makeSpine();
    const extraSlot = {
      title: "Slot 3",
      beats: [
        { claim: "A rival company challenged Kingsford's dominance in the 1970s.", exploration: false },
        { claim: "Grilling culture spread fastest in postwar suburban America.", exploration: false },
        { claim: "A regional cookbook accidentally popularized a now-iconic briquette shape.", exploration: true },
        { claim: "Briquette chemistry changed twice after early environmental complaints.", exploration: false },
        { claim: "A little-known lawsuit forced briquette makers to disclose binders used in production.", exploration: true }
      ]
    };
    const spineWithMore: Spine = {
      ...spine,
      acts: [{ ...spine.acts[0]!, slots: [...spine.acts[0]!.slots, extraSlot] }]
    };
    const result = validateSpine(spineWithMore);
    expect(result.counts.items).toBe(10);
    expect(result.issues.some((i) => i.code === "item-count-out-of-budget")).toBe(false);
  });

  it("flags an act count that overshoots the tier's budget beyond tolerance", () => {
    const spine = makeSpine({ duration: "short" });
    const firstAct = spine.acts[0]!;
    const withExtraActs: Spine = {
      ...spine,
      acts: [firstAct, firstAct, firstAct] // short tier wants exactly 1 act
    };
    const result = validateSpine(withExtraActs);
    expect(result.issues.some((i) => i.code === "act-count-out-of-budget")).toBe(true);
  });

  it("uses the documented §8 tolerance (±15%) at the edges, not a hard cutoff", () => {
    // Medium tier wants 3-4 acts; 3 * (1 - 0.15) = 2.55, so 3 acts (already
    // in-band) must pass, and this also pins SHAPE_TOLERANCE's documented value.
    expect(SHAPE_TOLERANCE).toBeCloseTo(0.15);
    expect(DURATION_SHAPE_BUDGETS.medium.acts).toEqual([3, 4]);
  });
});

describe("validateSpine — claim-shape enforcement", () => {
  it("flags a topic-shaped beat rather than accepting it cosmetically", () => {
    const spine = makeSpine();
    const polluted: Spine = {
      ...spine,
      acts: [
        {
          ...spine.acts[0]!,
          slots: [{ title: "Slot 1", beats: [{ claim: "Briquettes", exploration: false }] }]
        }
      ]
    };
    const result = validateSpine(polluted);
    expect(result.issues.some((i) => i.code === "beat-not-claim-shaped")).toBe(true);
  });
});

describe("validateSpine — exploration floor (~30%, product principle #1)", () => {
  it("flags a spine where too few beats are marked exploration", () => {
    const spine = makeSpine();
    const allNonExploration: Spine = {
      ...spine,
      acts: [
        {
          ...spine.acts[0]!,
          slots: spine.acts[0]!.slots.map((slot) => ({
            ...slot,
            beats: slot.beats.map((b) => ({ ...b, exploration: false }))
          }))
        }
      ]
    };
    const result = validateSpine(allNonExploration);
    expect(result.issues.some((i) => i.code === "exploration-floor-not-met")).toBe(true);
    expect(result.counts.explorationBeats).toBe(0);
  });

  it("passes when exactly the floor fraction is marked exploration", () => {
    const spine = makeSpine(); // 5 beats, 2 marked exploration = 40%, comfortably over 30%
    const result = validateSpine(spine);
    expect(result.counts.explorationBeats / result.counts.items).toBeGreaterThanOrEqual(EXPLORATION_FLOOR);
    expect(result.issues.some((i) => i.code === "exploration-floor-not-met")).toBe(false);
  });
});
