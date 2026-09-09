import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { argumentCapFor, capArgumentBeats, deepenActs, ActDeepeningError, InvalidDeepenedActError } from "../src/generation/deepenActs";
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

describe("StubDeepenActBuilder — the dry-run path tags beats too (WS-C, F-38)", () => {
  it("emits BOTH kinds so the dry run exercises §4.5's argument branch", async () => {
    /* The stub is a fixture generator, not a judge — but if it only ever
       emitted `account`, the branch that skips tape lookup for an argument
       would never run without an API key, and a regression there would be
       invisible to every keyless test and to `--dry-run`. */
    const builder = new StubDeepenActBuilder();
    const act = makeAct(
      {
        slots: [
          {
            title: "Mixed slot",
            beats: [
              { claim: "The walkway fell into the atrium on a Friday evening.", exploration: false },
              { claim: "Every link in a failure chain is almost always judged against a local question.", exploration: true }
            ]
          }
        ]
      },
      "K"
    );
    const spine = makeSpine({ acts: [act] });
    const deepened = await builder.deepenAct(spine, act, 0, ctx);

    const kinds = deepened.slots[0]!.beats.map((b) => b.kind);
    expect(kinds).toContain("account");
    expect(kinds).toContain("argument");
  });

  it("passes an already-tagged beat's kind through unchanged rather than re-judging it", () => {
    /* §4.4 refines wording; it must not silently retag a beat a caller already
       decided about — the tag is what §4.5 keys off. */
    const builder = new StubDeepenActBuilder();
    const act = makeAct(
      { slots: [{ title: "Slot", beats: [{ claim: "The walkway fell into the atrium.", exploration: false, kind: "argument" }] }] },
      "T"
    );
    return builder.deepenAct(makeSpine({ acts: [act] }), act, 0, ctx).then((deepened) => {
      expect(deepened.slots[0]!.beats[0]!.kind).toBe("argument");
    });
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

describe("deepenActs — the argument cap (F-49)", () => {
  /**
   * Run 2's deepen stage tagged 29 of 35 beats `argument`, §4.5 skipped tape
   * lookup for every one of them, and the Foray shipped as pure narration on
   * the subject this archive holds the most tape about. The fixture below is
   * that run's own deepen output, lifted verbatim from its checkpoint file.
   */
  const RUN2: DeepenedAct[] = (
    JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as { acts: DeepenedAct[] }
  ).acts;

  const kindsOf = (acts: DeepenedAct[]): Array<string | undefined> => acts.flatMap((a) => a.slots.flatMap((s) => s.beats.map((b) => b.kind)));

  function slotOf(beats: Array<{ claim: string; exploration: boolean; kind?: "account" | "argument" }>): DeepenedAct {
    return {
      title: "Act with one slot",
      thesis: "It establishes something.",
      startState: "before",
      endState: "after",
      slots: [{ title: "The only slot", beats }],
      introduction: "intro",
      exit: "exit"
    };
  }

  const argumentBeat = (n: number) => ({ claim: `Every ${n}th failure means the same thing about engineering.`, exploration: false, kind: "argument" as const });

  it("caps a slot's arguments at one third of its beats, rounded up", () => {
    expect(argumentCapFor(1)).toBe(1);
    expect(argumentCapFor(2)).toBe(1);
    expect(argumentCapFor(3)).toBe(1);
    expect(argumentCapFor(4)).toBe(2);
    expect(argumentCapFor(5)).toBe(2);
    expect(argumentCapFor(6)).toBe(2);
    expect(argumentCapFor(35)).toBe(12);
  });

  it("re-tags the beats over the cap `account`, keeping the first ones in slot order", () => {
    const act = slotOf([argumentBeat(1), argumentBeat(2), argumentBeat(3), argumentBeat(4), argumentBeat(5), argumentBeat(6)]);
    const capped = capArgumentBeats(act);
    expect(capped.slots[0]!.beats.map((b) => b.kind)).toEqual(["argument", "argument", "account", "account", "account", "account"]);
    // Nothing but the tag moves: same beats, same order, same claims.
    expect(capped.slots[0]!.beats.map((b) => b.claim)).toEqual(act.slots[0]!.beats.map((b) => b.claim));
  });

  it("records what it did as a WARNING ON THE ACT — a field, not a console line", () => {
    /* Run 2's only symptom was the absence of tape four stages later. A warning
       that travels with the act is checkpointed, survives a resume, and can be
       asserted; a console.warn is none of those. MUTATION THAT KILLS THIS:
       drop the warning and keep the re-tagging — the fix goes silent again. */
    const capped = capArgumentBeats(slotOf([argumentBeat(1), argumentBeat(2), argumentBeat(3)]));
    expect(capped.warnings).toHaveLength(1);
    expect(capped.warnings![0]).toContain('Slot "The only slot"');
    expect(capped.warnings![0]).toMatch(/3 of 3 beats came back tagged "argument"; at most 1 may be/);
    expect(capped.warnings![0]).toMatch(/last 2 were re-tagged "account"/);
  });

  it("returns an act inside the cap untouched, with no warnings and no copy", () => {
    const act = slotOf([argumentBeat(1), { claim: "The walkway fell into the atrium.", exploration: false, kind: "account" }]);
    const capped = capArgumentBeats(act);
    expect(capped).toBe(act);
    expect(capped.warnings).toBeUndefined();
  });

  it("is idempotent — a second pass changes nothing and adds no second warning", () => {
    const once = capArgumentBeats(slotOf([argumentBeat(1), argumentBeat(2), argumentBeat(3)]));
    const twice = capArgumentBeats(once);
    expect(twice).toBe(once);
    expect(twice.warnings).toHaveLength(1);
  });

  it("re-tags run 2's own deepen output from 29 arguments to 12", () => {
    /* The measurement F-49 was written from, replayed against the rule. 35
       beats over 6 slots of 6/6/6/5/6/6 — every slot's cap is 2, so at most 12
       beats can skip tape lookup where 29 did. */
    expect(kindsOf(RUN2).filter((k) => k === "argument")).toHaveLength(29);
    const capped = RUN2.map((a) => capArgumentBeats(a));
    const kinds = kindsOf(capped);
    expect(kinds).toHaveLength(35);
    expect(kinds.filter((k) => k === "argument")).toHaveLength(12);
    expect(kinds.filter((k) => k === "argument").length).toBeLessThan(29);
  });

  it("holds the cap in every single slot of the run-2 fixture, and warns on each one it corrected", () => {
    const capped = RUN2.map((a) => capArgumentBeats(a));
    for (const act of capped) {
      for (const slot of act.slots) {
        const args = slot.beats.filter((b) => b.kind === "argument").length;
        expect(args).toBeLessThanOrEqual(argumentCapFor(slot.beats.length));
      }
    }
    // Every one of the six slots was over the cap in run 2.
    expect(capped.flatMap((a) => a.warnings ?? [])).toHaveLength(6);
  });

  it("applies the cap to a RESUMED act too, so an old checkpoint is corrected rather than replayed", async () => {
    /* F-17's resume exists so a run does not re-pay for finished acts. It must
       not also faithfully reproduce the defect that made the run worth
       redoing. MUTATION THAT KILLS THIS: `if (resumed) return resumed`. */
    const spine = makeSpine({ acts: [makeAct({}, "R")] });
    const stored = slotOf([argumentBeat(1), argumentBeat(2), argumentBeat(3)]);
    const builder = new StubDeepenActBuilder();
    const out = await deepenActs(spine, builder, ctx, { resume: () => stored });
    expect(out[0]!.slots[0]!.beats.map((b) => b.kind)).toEqual(["argument", "account", "account"]);
    expect(out[0]!.warnings).toHaveLength(1);
  });

  it("the stub builder obeys the same cap, so the keyless path cannot regress silently", () => {
    /* Every dry run and every keyless test goes through the stub. If it could
       hand back a slot of six arguments, a regression in the cap would be
       invisible without an API key — which is exactly how run 2 happened. */
    const builder = new StubDeepenActBuilder();
    const act = makeAct(
      {
        slots: [
          {
            title: "All generalisations",
            beats: [1, 2, 3, 4, 5, 6].map((n) => ({ claim: `Every ${n}th deployment always fails in generally the same way.`, exploration: false }))
          }
        ]
      },
      "S"
    );
    return builder.deepenAct(makeSpine({ acts: [act] }), act, 0, ctx).then((deepened) => {
      const kinds = deepened.slots[0]!.beats.map((b) => b.kind);
      expect(kinds.filter((k) => k === "argument")).toHaveLength(2);
      expect(kinds.filter((k) => k === "account")).toHaveLength(4);
    });
  });
});
