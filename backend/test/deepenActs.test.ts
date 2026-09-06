import { describe, it, expect } from "vitest";
import { deepenActs, ActDeepeningError, InvalidDeepenedActError } from "../src/generation/deepenActs";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { createDeepenActBuilder } from "../src/generation/createDeepenActBuilder";
import type { DeepenActBuilder, DeepenActContext } from "../src/generation/DeepenActBuilder";
import { isClaimShaped, type Act, type DeepenedAct, type Spine } from "../src/types/spine";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { env } from "../src/config/env";

function makeAct(overrides: Partial<Act> = {}, actLabel = "A"): Act {
  return {
    title: `Act ${actLabel}`,
    thesis: `Act ${actLabel} establishes something new.`,
    startState: `The listener does not yet know about ${actLabel}.`,
    endState: `The listener now understands ${actLabel}.`,
    slots: [
      {
        title: `${actLabel} slot 1`,
        beats: [
          { claim: `Researchers documented ${actLabel} extensively in the 1990s.`, exploration: false },
          { claim: `${actLabel} changed rapidly after a key discovery.`, exploration: true }
        ]
      }
    ],
    ...overrides
  };
}

function makeSpine(overrides: Partial<Spine> = {}): Spine {
  return {
    subject: "the history of grilling",
    angle: "how an industrial waste product became a backyard ritual",
    duration: "medium",
    generatedAt: new Date().toISOString(),
    voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
    acts: [makeAct({}, "1"), makeAct({}, "2"), makeAct({}, "3")],
    ...overrides
  };
}

function guardAndSink() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 10.0);
  return { sink, guard };
}

const ctx: DeepenActContext = { userId: "founder-1" };

describe("deepenActs — StubDeepenActBuilder produces one deepened act per input act", () => {
  it("returns exactly one result per act, in order, satisfying the deepened-act shape", async () => {
    const { guard } = guardAndSink();
    const builder = new StubDeepenActBuilder(guard);
    const spine = makeSpine();

    const deepened = await deepenActs(spine, builder, ctx);

    expect(deepened).toHaveLength(spine.acts.length);
    deepened.forEach((act, i) => {
      expect(act.title).toBe(spine.acts[i]!.title);
      expect(act.introduction.length).toBeGreaterThan(0);
      expect(act.exit.length).toBeGreaterThan(0);
      expect(act.slots).toHaveLength(spine.acts[i]!.slots.length);
      for (const slot of act.slots) {
        for (const beat of slot.beats) {
          expect(isClaimShaped(beat.claim)).toBe(true);
        }
      }
    });
  });

  it("routes every deepen_act call through the budget guard as a recorded cost event", async () => {
    const { sink, guard } = guardAndSink();
    const builder = new StubDeepenActBuilder(guard);
    const spine = makeSpine();
    await deepenActs(spine, builder, ctx);

    const events = await sink.all();
    const deepenEvents = events.filter((e) => e.operation === "deepen_act");
    expect(deepenEvents.length).toBe(spine.acts.length);
  });

  it("works for spines with 3-4 acts (the medium tier's real shape)", async () => {
    const { guard } = guardAndSink();
    const builder = new StubDeepenActBuilder(guard);
    for (const actCount of [3, 4]) {
      const spine = makeSpine({ acts: Array.from({ length: actCount }, (_, i) => makeAct({}, String(i + 1))) });
      const deepened = await deepenActs(spine, builder, ctx);
      expect(deepened).toHaveLength(actCount);
    }
  });
});

describe("deepenActs — full-spine context, not just the act's own slice", () => {
  /** Spy builder that records exactly what context it was given, so a
   * regression that passes only the target act's own slice (rather than
   * the full spine) is caught structurally. */
  class SpyFullSpineBuilder implements DeepenActBuilder {
    readonly providerName = "spy-full-spine";
    seenSpineActCounts: number[] = [];
    seenSiblingTheses: string[][] = [];

    async deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number): Promise<DeepenedAct> {
      this.seenSpineActCounts.push(fullSpine.acts.length);
      const siblingTheses = fullSpine.acts.filter((_, i) => i !== targetActIndex).map((a) => a.thesis);
      this.seenSiblingTheses.push(siblingTheses);
      return {
        ...targetAct,
        introduction: `intro for ${targetAct.title}`,
        exit: `exit for ${targetAct.title}`
      };
    }
  }

  it("passes the FULL spine (including sibling acts' theses) to every builder call, not just the target act's own slice", async () => {
    const spy = new SpyFullSpineBuilder();
    const spine = makeSpine();

    await deepenActs(spine, spy, ctx);

    expect(spy.seenSpineActCounts).toEqual([spine.acts.length, spine.acts.length, spine.acts.length]);
    // For each call, every OTHER act's thesis must be present in the
    // context handed to that call — a regression that only passed the
    // act's own slice would see an empty sibling list here.
    spy.seenSiblingTheses.forEach((siblingTheses, callIndex) => {
      const expectedSiblings = spine.acts.filter((_, i) => i !== callIndex).map((a) => a.thesis);
      expect(siblingTheses.sort()).toEqual(expectedSiblings.sort());
      expect(siblingTheses.length).toBe(spine.acts.length - 1);
    });
  });
});

describe("deepenActs — parallel execution is real, not sequential-disguised-as-parallel", () => {
  /** Builder with intentionally-ordered stub delays: act 0 is slow, acts
   * 1 and 2 are fast. Records each call's START time (not just its
   * completion), so the test can assert on OVERLAP between calls rather
   * than on absolute wall-clock thresholds — a wall-clock budget is
   * flaky under CI load (a busy test runner can inflate every delay
   * uniformly), but "did act 1 start before act 0 finished" is a
   * structural fact true under true parallelism and false under any
   * sequential-disguised-as-parallel implementation, at any speed. */
  class OrderedDelayBuilder implements DeepenActBuilder {
    readonly providerName = "ordered-delay";
    completionOrder: number[] = [];
    startTimes: number[] = [];
    endTimes: number[] = [];
    private readonly delaysMs: number[];

    constructor(delaysMs: number[]) {
      this.delaysMs = delaysMs;
    }

    async deepenAct(_fullSpine: Spine, targetAct: Act, targetActIndex: number): Promise<DeepenedAct> {
      this.startTimes[targetActIndex] = Date.now();
      const delay = this.delaysMs[targetActIndex] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      this.completionOrder.push(targetActIndex);
      this.endTimes[targetActIndex] = Date.now();
      return { ...targetAct, introduction: "intro", exit: "exit" };
    }
  }

  it("completes faster acts before a slower one when run truly in parallel", async () => {
    // Act 0 is deliberately much slower than acts 1 and 2.
    const slowDelayMs = 300;
    const fastDelayMs = 10;
    const builder = new OrderedDelayBuilder([slowDelayMs, fastDelayMs, fastDelayMs]);
    const spine = makeSpine();

    await deepenActs(spine, builder, ctx);

    // A test that would FAIL if calls ran serially: sequential execution
    // could only ever complete in order [0, 1, 2]; true parallelism lets
    // the fast acts (1, 2) finish first, so act 0 is NOT first to finish.
    expect(builder.completionOrder[0]).not.toBe(0);
    expect(builder.completionOrder).toContain(1);
    expect(builder.completionOrder).toContain(2);

    // Structural overlap check, immune to CI load inflating every delay
    // uniformly: acts 1 and 2 must have STARTED before act 0 FINISHED.
    // Under a sequential-disguised-as-parallel implementation (each call
    // awaited before the next starts), act 1/2's start time could only
    // ever be >= act 0's end time — this can never hold there, at any
    // speed, because it depends on relative ordering, not absolute
    // duration.
    expect(builder.startTimes[1]!).toBeLessThan(builder.endTimes[0]!);
    expect(builder.startTimes[2]!).toBeLessThan(builder.endTimes[0]!);
  });
});

describe("deepenActs — failure isolation", () => {
  class FlakyBuilder implements DeepenActBuilder {
    readonly providerName = "flaky";
    callsPerAct: Record<number, number> = {};
    constructor(private readonly failIndices: Set<number>, private readonly failForever: Set<number> = new Set()) {}

    async deepenAct(_fullSpine: Spine, targetAct: Act, targetActIndex: number): Promise<DeepenedAct> {
      this.callsPerAct[targetActIndex] = (this.callsPerAct[targetActIndex] ?? 0) + 1;
      const isFirstAttempt = this.callsPerAct[targetActIndex] === 1;
      if (this.failForever.has(targetActIndex) || (this.failIndices.has(targetActIndex) && isFirstAttempt)) {
        throw new Error(`simulated failure for act ${targetActIndex}`);
      }
      return { ...targetAct, introduction: "intro", exit: "exit" };
    }
  }

  it("retries a failed act once and succeeds if the retry works, without affecting other acts' results", async () => {
    const spine = makeSpine();
    const builder = new FlakyBuilder(new Set([1])); // act 1 fails once, then succeeds on retry

    const deepened = await deepenActs(spine, builder, ctx);

    expect(deepened).toHaveLength(3);
    expect(builder.callsPerAct[1]).toBe(2); // failed once, retried once
    expect(builder.callsPerAct[0]).toBe(1);
    expect(builder.callsPerAct[2]).toBe(1);
    // Other acts' results are untouched by act 1's transient failure.
    expect(deepened[0]!.title).toBe(spine.acts[0]!.title);
    expect(deepened[2]!.title).toBe(spine.acts[2]!.title);
  });

  it("fails the WHOLE build when an act's deepening fails twice (retry exhausted) — a Foray missing an act is not valid", async () => {
    const spine = makeSpine();
    const builder = new FlakyBuilder(new Set(), new Set([1])); // act 1 always fails

    await expect(deepenActs(spine, builder, ctx)).rejects.toThrow(ActDeepeningError);
  });

  it("a persistently-failing act does not silently corrupt or drop the other independently-succeeding acts' work", async () => {
    // Every other act's own deepenAct call still runs to completion even
    // though the whole build ultimately rejects — verified by checking
    // the flaky builder's own call counts rather than relying on
    // deepenActs' return value (which never resolves in this case).
    const spine = makeSpine();
    const builder = new FlakyBuilder(new Set(), new Set([1]));

    await expect(deepenActs(spine, builder, ctx)).rejects.toThrow();

    expect(builder.callsPerAct[0]).toBeGreaterThanOrEqual(1);
    expect(builder.callsPerAct[2]).toBeGreaterThanOrEqual(1);
  });

  it("rejects with InvalidDeepenedActError (wrapped) when a builder changes the slot count — §4.4 refines, it does not add/remove slots", async () => {
    class SlotAddingBuilder implements DeepenActBuilder {
      readonly providerName = "slot-adding";
      async deepenAct(_fullSpine: Spine, targetAct: Act): Promise<DeepenedAct> {
        // Schema-valid (still >= 1 slot) but changes the COUNT, which
        // §4.4 forbids — refining is not adding/removing slots.
        return { ...targetAct, slots: [...targetAct.slots, ...targetAct.slots], introduction: "intro", exit: "exit" };
      }
    }
    const spine = makeSpine({ acts: [makeAct({}, "1")] });
    const builder = new SlotAddingBuilder();

    let thrown: unknown;
    try {
      await deepenActs(spine, builder, ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ActDeepeningError);
    expect((thrown as ActDeepeningError).cause).toBeInstanceOf(InvalidDeepenedActError);
  });
});

describe("createDeepenActBuilder", () => {
  it("returns a StubDeepenActBuilder when ANTHROPIC_API_KEY is absent (repo .env is empty for this build)", () => {
    expect(env.anthropicDryRun).toBe(true);
    const builder = createDeepenActBuilder();
    expect(builder).toBeInstanceOf(StubDeepenActBuilder);
    expect(builder.providerName).toBe("stub");
  });
});
