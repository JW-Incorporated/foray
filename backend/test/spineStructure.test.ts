import { describe, it, expect } from "vitest";
import {
  checkSpineStructure,
  assertSpineStructure,
  countSentences,
  normalizeClaim,
  InvalidSpineStructureError,
  MAX_BEAT_CLAIM_WORDS
} from "../src/generation/spineStructure";
import { SPINE_MIN_SEEDED_BEATS_PER_ACT, type Act, type Beat, type Spine } from "../src/types/spine";

/**
 * F-13: "No confirmation loop after the spine. §4.3 flows straight into §4.4
 * deepening with no validation of the spine's counts before three more model
 * calls are spent... a cheap structural check between §4.3 and §4.4 would fail
 * fast."
 *
 * The fixtures below are shaped like RUN 1's actual spine — 3 acts, 6 slots,
 * 31 beats for the engineering-disasters prompt at the medium tier — because
 * the check has to pass the one real spine the pipeline has produced before it
 * is allowed to reject anything.
 */

function beat(claim: string, exploration = false): Beat {
  return { claim, exploration };
}

/** Run 1's shape: 3 acts, 6 slots, 31 beats, ~35% exploration. */
function runOneSpine(): Spine {
  const claims = [
    "The Hyatt Regency walkway collapse killed one hundred and fourteen people in 1981",
    "A steel fabricator changed one hanger rod into two during shop drawing review",
    "The doubled connection carried twice the load its original design anticipated",
    "No engineer at either firm checked the revised connection for adequacy",
    "Kansas City building officials approved drawings they had not independently verified",
    "The Missouri board revoked both engineers' licences for gross negligence",
    "Chernobyl's reactor design hid a positive void coefficient from its operators",
    "Soviet operators ran a safety test outside every documented operating envelope",
    "The control rods' graphite tips briefly increased reactivity on insertion",
    "Flint switched water sources without adding the required corrosion inhibitor",
    "Lead leached from service lines into the homes of ninety-nine thousand residents",
    "State regulators dismissed residents' complaints for eighteen months",
    "The Tacoma Narrows bridge deck was eight times more flexible than its predecessor",
    "Aeroelastic flutter was not part of the design vocabulary in 1940",
    "The Challenger O-rings lost resilience below fifty-three degrees Fahrenheit",
    "Thiokol engineers recommended against launch and were overruled that night",
    "NASA's flight readiness process treated recurring erosion as an accepted risk",
    "The Deepwater Horizon negative pressure test was reinterpreted until it passed",
    "Two crews disagreed about the test result and neither escalated the disagreement",
    "The Morandi bridge's stay cables were encased in concrete that hid their corrosion",
    "Inspection regimes measured what was visible rather than what was load-bearing",
    "The I-35W gusset plates were half the thickness the design required",
    "Staged construction material sat over the under-designed nodes on the day it fell",
    "Every one of these failures was preceded by a documented, ignored warning",
    "Organisations reward the engineer who says yes faster than the one who says wait",
    "Normalisation of deviance turns an exception into a standard within three cycles",
    "A checklist only works when someone is accountable for the box being ticked",
    "Redundancy fails when both redundant paths share one unexamined assumption",
    "Post-accident investigation finds the chain, not the culprit, in every case",
    "The safety margins we still use were written in the blood of earlier failures",
    "The next collapse is already documented in someone's ignored inspection report"
  ];
  const explorationAt = new Set([6, 9, 12, 14, 17, 19, 24, 25, 27, 28, 30]);
  const beats = claims.map((c, i) => beat(c, explorationAt.has(i)));

  const slotSizes = [6, 6, 5, 5, 5, 4];
  const slots = [];
  let cursor = 0;
  for (let i = 0; i < slotSizes.length; i++) {
    slots.push({ title: `Slot ${i + 1}`, beats: beats.slice(cursor, cursor + slotSizes[i]!) });
    cursor += slotSizes[i]!;
  }

  const acts: Act[] = [
    { title: "The connection nobody checked", thesis: "Small drawing changes kill", startState: "Disasters look like acts of God", endState: "Disasters look like paperwork", slots: slots.slice(0, 2) },
    { title: "The warning nobody escalated", thesis: "Someone always knew", startState: "Disasters look like paperwork", endState: "Disasters look like silence", slots: slots.slice(2, 4) },
    { title: "The margin nobody defended", thesis: "Margins erode by consent", startState: "Disasters look like silence", endState: "Disasters look like a chain", slots: slots.slice(4, 6) }
  ];

  return {
    subject: "engineering disasters",
    angle: "the chains of small decisions behind collapsed bridges, failed dams and machines that broke",
    duration: "medium",
    generatedAt: "2026-09-09T02:00:00.000Z",
    voice: { style: "forensic", register: "plain", sentenceRhythm: "short then long", narratorPresence: "low" },
    acts
  };
}

describe("checkSpineStructure — the F-13 gate between §4.3 and §4.4", () => {
  it("passes run 1's real spine (3 acts, 6 slots, 31 beats, medium)", () => {
    const spine = runOneSpine();
    expect(spine.acts.length).toBe(3);
    expect(spine.acts.reduce((n, a) => n + a.slots.length, 0)).toBe(6);
    expect(spine.acts.flatMap((a) => a.slots.flatMap((s) => s.beats)).length).toBe(31);
    expect(checkSpineStructure(spine)).toEqual([]);
    expect(() => assertSpineStructure(spine)).not.toThrow();
  });

  it("rejects a beat claim repeated in a different act, naming both places", () => {
    const spine = runOneSpine();
    /* The failure §4.4 would otherwise deepen twice and §4.7 would write two
       near-identical pages for. */
    spine.acts[2]!.slots[0]!.beats[0] = beat(spine.acts[0]!.slots[0]!.beats[0]!.claim);
    const issues = checkSpineStructure(spine);
    expect(issues.map((i) => i.code)).toContain("duplicate-beat-claim");
    const dup = issues.find((i) => i.code === "duplicate-beat-claim")!;
    expect(dup.message).toContain("act 1");
    expect(dup.message).toContain("act 3");
  });

  it("treats punctuation and casing differences as the same claim", () => {
    const spine = runOneSpine();
    const original = spine.acts[0]!.slots[0]!.beats[0]!.claim;
    spine.acts[2]!.slots[0]!.beats[0] = beat(`${original.toUpperCase()}.`);
    expect(checkSpineStructure(spine).map((i) => i.code)).toContain("duplicate-beat-claim");
  });

  it("rejects a beat carrying a paragraph rather than a claim", () => {
    const spine = runOneSpine();
    const paragraph = Array.from({ length: MAX_BEAT_CLAIM_WORDS + 5 }, (_, i) => `word${i}`).join(" ");
    spine.acts[0]!.slots[0]!.beats[0] = beat(`The report said ${paragraph}`);
    const issues = checkSpineStructure(spine);
    expect(issues.map((i) => i.code)).toContain("beat-claim-too-long");
  });

  it("rejects a beat carrying two claims in two sentences", () => {
    const spine = runOneSpine();
    spine.acts[0]!.slots[0]!.beats[0] = beat("The walkway collapsed in 1981. The fabricator had doubled the rod.");
    const issues = checkSpineStructure(spine);
    expect(issues.map((i) => i.code)).toContain("beat-claim-not-single-sentence");
  });

  it("rejects an act with no start or end state", () => {
    const spine = runOneSpine();
    spine.acts[1]!.startState = "   ";
    spine.acts[1]!.endState = "";
    const codes = checkSpineStructure(spine).map((i) => i.code);
    expect(codes).toContain("act-missing-start-state");
    expect(codes).toContain("act-missing-end-state");
  });

  it("rejects a spine outside the medium tier's beat range", () => {
    const spine = runOneSpine();
    /* 31 -> 43 beats, past the 28-36 range even with the ±15% tolerance the
       shape budgets carry (36 x 1.15 = 41.4). Acts and slots are untouched, so
       the beat count is the only thing that can trip. */
    const extra = Array.from({ length: 12 }, (_, i) => beat(`An additional documented failure number ${i} reached the same conclusion`));
    spine.acts[2]!.slots[1]!.beats.push(...extra);
    const codes = checkSpineStructure(spine).map((i) => i.code);
    expect(codes).toEqual(["beat-count-out-of-budget"]);
  });

  it("reports every defect in one pass, so one re-ask can fix them all", () => {
    const spine = runOneSpine();
    spine.acts[0]!.endState = "";
    spine.acts[2]!.slots[0]!.beats[0] = beat("One thing happened. Then another thing happened.");
    const codes = checkSpineStructure(spine).map((i) => i.code);
    expect(new Set(codes)).toEqual(new Set(["act-missing-end-state", "beat-claim-not-single-sentence"]));
  });

  it("throws a message that names the finding and says nothing was deepened", () => {
    const spine = runOneSpine();
    spine.acts[0]!.endState = "";
    try {
      assertSpineStructure(spine);
      throw new Error("expected assertSpineStructure to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSpineStructureError);
      expect((err as Error).message).toContain("F-13");
      expect((err as Error).message).toContain("no deepen call was made");
    }
  });
});

describe("countSentences — accept-biased, like every heuristic in this pipeline", () => {
  it("counts one sentence for an ordinary claim, with or without a full stop", () => {
    expect(countSentences("The walkway collapsed in 1981")).toBe(1);
    expect(countSentences("The walkway collapsed in 1981.")).toBe(1);
  });

  it("counts two when a claim really carries two", () => {
    expect(countSentences("It collapsed. Nobody had checked it.")).toBe(2);
    expect(countSentences("Did anyone check? Nobody did.")).toBe(2);
  });

  it("does not split on an abbreviation or on dotted initials", () => {
    expect(countSentences("No. 3 reactor ran the test outside its envelope")).toBe(1);
    expect(countSentences("U.S. Steel supplied the box beams that failed")).toBe(1);
    expect(countSentences("The Hyatt Regency vs. Havens ruling revoked both licences")).toBe(1);
  });

  it("is empty-safe", () => {
    expect(countSentences("   ")).toBe(0);
  });
});

describe("normalizeClaim", () => {
  it("collapses everything that is not a word", () => {
    expect(normalizeClaim("  The Hyatt-Regency WALKWAY, 1981!  ")).toBe("the hyatt regency walkway 1981");
  });
});

/* WS-L (F-63): the spine has to be written from the tape the research map
   quoted, and "at least N beats an act, naming a window the map actually
   listed" is the form of that rule a machine can check. Run 1's real spine is
   the fixture here for the same reason it is above — the rule has to leave a
   good spine alone. */
describe("checkSpineStructure — WS-L: the per-act seeded-beat floor (F-63)", () => {
  const listed = ["practical-ai--episode-900", "practical-ai--episode-901"];

  /** Run 1's spine with the first `perAct[i]` beats of act i seeded from
   * `episodeIds` (cycling), everything else untouched. */
  function seeded(perAct: number[], episodeIds: string[] = listed): Spine {
    const spine = runOneSpine();
    let cursor = 0;
    spine.acts.forEach((act, actIndex) => {
      let left = perAct[actIndex] ?? 0;
      for (const slot of act.slots) {
        slot.beats = slot.beats.map((b) => {
          if (left <= 0) return b;
          left -= 1;
          return { ...b, seed: { episodeId: episodeIds[cursor++ % episodeIds.length]!, startSec: 100, endSec: 180 } };
        });
      }
    });
    return spine;
  }

  function floorIssues(spine: Spine, seedableEpisodeIds?: string[]) {
    const options = seedableEpisodeIds === undefined ? {} : { seedableEpisodeIds };
    return checkSpineStructure(spine, options).filter((i) => i.code === "act-below-seeded-beat-floor");
  }

  it("refuses an act that carries fewer seeded beats than the floor, naming the act and the floor", () => {
    const issues = floorIssues(seeded([1, 2, 2]), listed);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("act 1");
    expect(issues[0]!.message).toContain(`at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT}`);
  });

  it("passes a spine whose every act meets the floor", () => {
    expect(floorIssues(seeded([2, 2, 3]), listed)).toEqual([]);
  });

  it("does not apply the floor at all when the research map quoted no windows", () => {
    /* §4.2's guardrail, carried one stage forward: a subject the archive is
       silent on is narrated by design, and refusing its spine for the archive's
       silence would be the opposite of what F-63 asks for. */
    expect(floorIssues(runOneSpine())).toEqual([]);
    expect(floorIssues(runOneSpine(), [])).toEqual([]);
    expect(checkSpineStructure(runOneSpine(), { seedableEpisodeIds: [] })).toEqual([]);
  });

  it("does not count a seed naming an episode the research map never listed, and says how many there were", () => {
    /* The rule is only worth having if it cannot be satisfied by inventing an
       episode id — the failure mode of every "cite your source" instruction
       given to a model with no lookup behind it. */
    const spine = seeded([2, 2, 2], ["practical-ai--invented-episode"]);
    const issues = floorIssues(spine, listed);
    expect(issues).toHaveLength(3);
    expect(issues[0]!.message).toContain("0 beat(s) seeded");
    expect(issues[0]!.message).toContain("2 further beat(s)");
  });

  it("throws through assertSpineStructure, so the gate stops the run rather than reporting", () => {
    expect(() => assertSpineStructure(seeded([0, 2, 2]), { seedableEpisodeIds: listed })).toThrow(InvalidSpineStructureError);
    expect(() => assertSpineStructure(seeded([2, 2, 2]), { seedableEpisodeIds: listed })).not.toThrow();
  });
});
