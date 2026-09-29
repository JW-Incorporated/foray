import { describe, it, expect } from "vitest";
import { stitchForay } from "../src/generation/stitchForay";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { slotIdsFromSpine, slotsFromSpine } from "../src/generation/runPipeline";
import type { DeepenedAct, Spine } from "../src/types/spine";
import type { WrittenAct } from "../src/generation/writeNarration";

/**
 * Round-3 audit gen-4 (and gen-3's stable-id half): `slotsFromSpine` declared
 * a duplicate slot title's second occurrence as `<slug>-2`, but every item
 * re-slugged its slot's TITLE, so both slots' items said `<slug>` and
 * `<slug>-2` owned nothing: check-forays refused the Foray ("interleaved
 * rather than contiguous") after the spend. Items now carry the declared id
 * by position.
 */
const ctx = { userId: "founder-1" };

function act(title: string, slotTitle: string, n: number): DeepenedAct {
  return {
    title,
    thesis: `${title} thesis.`,
    startState: `Before ${title}.`,
    endState: `After ${title}.`,
    slots: [{ title: slotTitle, beats: [{ claim: `${title} makes a real claim.`, exploration: false }] }],
    introduction: `Opening number ${n}, on its own.`,
    exit: `Closing number ${n}, on its own.`
  };
}
function written(title: string, slotTitle: string): WrittenAct {
  return {
    title,
    slots: [
      {
        title: slotTitle,
        beats: [
          {
            sourcing: "tape",
            claim: `${title} makes a real claim.`,
            exploration: false,
            tape: {
              segmentId: `${title}-ep#0`,
              itemId: `${title}-ep`,
              startSec: 0,
              endSec: 30,
              startAnchor: "so the first thing to understand is",
              endAnchor: "and that changed everything after that",
              tier: 1,
              confidence: "high"
            }
          }
        ]
      }
    ]
  };
}

describe("gen-4: items carry the slot id `slots` declares", () => {
  const deepened = [act("First", "Origins", 1), act("Second", "The middle", 2), act("Third", "Origins", 3)];
  const spine = { acts: deepened } as unknown as Spine;

  it("slotIdsFromSpine suffixes the second 'Origins', and slotsFromSpine declares the same ids", () => {
    expect(slotIdsFromSpine(spine)).toEqual([["origins"], ["the-middle"], ["origins-2"]]);
    expect(slotsFromSpine(spine).map((s) => s.id)).toEqual(["origins", "the-middle", "origins-2"]);
  });

  it("every item's slot is a declared id, and act 3's items are in origins-2", async () => {
    /* MUTATION THAT KILLS THIS: stamp items with slugifySlotTitle(slotTitle)
       again (drop `slotId`) — act 3's items then say `origins`. */
    const result = await stitchForay(
      deepened,
      [written("First", "Origins"), written("Second", "The middle"), written("Third", "Origins")],
      { continuity: { builder: new StubContinuityBuilder() }, slotIds: slotIdsFromSpine(spine) },
      ctx
    );
    const declared = new Set(slotsFromSpine(spine).map((s) => s.id));
    const slotted = result.items.filter((i) => "slot" in i && i.slot !== undefined) as Array<{ slot: string; type: string; id?: string }>;
    expect(slotted.every((i) => declared.has(i.slot))).toBe(true);
    const third = slotted.filter((i) => i.type === "narration" ? i.id?.startsWith("act-3") : false);
    expect(third.map((i) => i.slot)).toEqual(["origins-2", "origins-2"]);
    const thirdSegment = result.items.find((i) => i.type === "segment" && i.segment_id === "Third-ep#0") as { slot: string };
    expect(thirdSegment.slot).toBe("origins-2");
  });
});
