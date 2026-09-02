import { describe, it, expect } from "vitest";
import { smoothActs, validateSmoothedSeam, SeamSmoothingError } from "../src/generation/smoothSeam";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { ContinuityBuilder, ContinuityBuildContext, ContinuitySmoothRequest, ContinuitySmoothResult } from "../src/generation/ContinuityBuilder";
import type { DeepenedAct } from "../src/types/spine";

const ctx: ContinuityBuildContext = { userId: "founder-1" };

function makeAct(title: string, index: number): DeepenedAct {
  return {
    title,
    thesis: `${title} thesis.`,
    startState: `Before ${title}.`,
    endState: `After ${title}.`,
    slots: [{ title: `${title} slot`, beats: [{ claim: `${title} makes a real claim about something.`, exploration: false }] }],
    introduction: `This is act ${index}'s original introduction, written independently of any other act.`,
    exit: `This is act ${index}'s original exit, written independently of any other act.`
  };
}

describe("smoothActs — cross-act continuity is forward-only (§6.2)", () => {
  it("smooths every boundary after the first act, changing only each next act's introduction", async () => {
    const acts = [makeAct("Act One", 1), makeAct("Act Two", 2), makeAct("Act Three", 3)];
    const builder = new StubContinuityBuilder();

    const smoothed = await smoothActs(acts, { builder }, ctx);

    expect(smoothed).toHaveLength(3);
    // Act 0 is untouched — same object reference, not merely equal content.
    expect(smoothed[0]).toBe(acts[0]);
    // Acts 1 and 2 got a NEW introduction (different from the original).
    expect(smoothed[1]!.introduction).not.toBe(acts[1]!.introduction);
    expect(smoothed[2]!.introduction).not.toBe(acts[2]!.introduction);
    // Every other field passes through unchanged.
    expect(smoothed[1]!.exit).toBe(acts[1]!.exit);
    expect(smoothed[1]!.title).toBe(acts[1]!.title);
    expect(smoothed[1]!.slots).toBe(acts[1]!.slots);
  });

  it("never mutates or rewrites an already-produced act's exit/items after the fact", async () => {
    const acts = [makeAct("Act One", 1), makeAct("Act Two", 2), makeAct("Act Three", 3)];
    const originalExits = acts.map((a) => a.exit);
    const originalSlots = acts.map((a) => a.slots);
    const builder = new StubContinuityBuilder();

    await smoothActs(acts, { builder }, ctx);

    // The INPUT array itself is never mutated in place — smoothActs
    // returns a new array (see its own doc comment: "forward-only... the
    // data structure too, not only the player's behaviour").
    acts.forEach((act, i) => {
      expect(act.exit).toBe(originalExits[i]);
      expect(act.slots).toBe(originalSlots[i]);
    });
  });

  it("invokes the builder with the PREVIOUS act's exit and the NEXT act's own introduction, never a smoothed intermediate", async () => {
    const acts = [makeAct("Act One", 1), makeAct("Act Two", 2), makeAct("Act Three", 3)];
    const seenRequests: ContinuitySmoothRequest[] = [];

    class RecordingBuilder implements ContinuityBuilder {
      readonly providerName = "recording";
      async smoothSeam(request: ContinuitySmoothRequest, _ctx: ContinuityBuildContext): Promise<ContinuitySmoothResult> {
        seenRequests.push(request);
        return { nextIntroduction: `${request.nextActIntroduction} (smoothed callback to "${request.previousActTitle}")` };
      }
    }

    await smoothActs(acts, { builder: new RecordingBuilder() }, ctx);

    expect(seenRequests).toHaveLength(2);
    // Boundary 1: previous = act 0 (ORIGINAL exit, act 0 was never smoothed since it has no predecessor).
    expect(seenRequests[0]!.previousActExit).toBe(acts[0]!.exit);
    expect(seenRequests[0]!.nextActIntroduction).toBe(acts[1]!.introduction);
    // Boundary 2: previous = act 1's ORIGINAL exit (never rewritten by continuity — only introductions are ever touched).
    expect(seenRequests[1]!.previousActExit).toBe(acts[1]!.exit);
    expect(seenRequests[1]!.nextActIntroduction).toBe(acts[2]!.introduction);
  });

  it("throws SeamSmoothingError when a builder returns an empty/invalid introduction", async () => {
    const acts = [makeAct("Act One", 1), makeAct("Act Two", 2)];
    class BrokenBuilder implements ContinuityBuilder {
      readonly providerName = "broken";
      async smoothSeam(): Promise<ContinuitySmoothResult> {
        return { nextIntroduction: "" };
      }
    }

    await expect(smoothActs(acts, { builder: new BrokenBuilder() }, ctx)).rejects.toBeInstanceOf(SeamSmoothingError);
  });

  it("returns an empty array for an empty act list and a single-element array unchanged for one act", async () => {
    const builder = new StubContinuityBuilder();
    expect(await smoothActs([], { builder }, ctx)).toEqual([]);
    const oneAct = [makeAct("Solo", 1)];
    const result = await smoothActs(oneAct, { builder }, ctx);
    expect(result).toEqual([oneAct[0]]);
    expect(result[0]).toBe(oneAct[0]);
  });
});

describe("validateSmoothedSeam", () => {
  it("rejects an empty smoothed introduction", () => {
    const act = makeAct("Act Two", 2);
    const result = validateSmoothedSeam(act, "");
    expect(result.valid).toBe(false);
  });

  it("rejects a suspiciously truncated smoothed introduction", () => {
    const act = makeAct("Act Two", 2);
    const result = validateSmoothedSeam(act, "x");
    expect(result.valid).toBe(false);
  });

  it("accepts a real smoothed introduction", () => {
    const act = makeAct("Act Two", 2);
    const result = validateSmoothedSeam(act, `Coming out of act one — ${act.introduction}`);
    expect(result.valid).toBe(true);
  });
});
