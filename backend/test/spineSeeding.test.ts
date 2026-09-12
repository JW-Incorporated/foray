import { describe, it, expect } from "vitest";
import { SPINE_SEED_REPEAT_MIN, SPINE_SEED_THIRD_MIN, SpineSeedLedger, summarizeSeeding } from "../src/generation/spineSeeding";
import { M4_ITEM_SHARE_MAX, m4SegmentCapFor } from "../src/generation/sourceBeats";
import type { Act } from "../src/types/spine";
import type { SourceBeatsResult } from "../src/types/tapeSourcing";

/* G-25 (tape-yield brief §5 R3): the M4 cap, stated to seeding in the sourcing
   ledger's own arithmetic. These cases pin the two numbers the spine prompt
   quotes to the function §4.5 actually gates on, and the ledger the stub seeds
   with to the same rule. */
describe("spineSeeding — the M4 cap visible to seeding (G-25, R3)", () => {
  it("SPINE_SEED_REPEAT_MIN is the smallest seeded count at which m4SegmentCapFor admits an episode's second segment", () => {
    /* MUTATION THAT KILLS THIS: write `8` into `spineSeeding.ts` instead of
       deriving it, then change `M4_ITEM_SHARE_MAX` — the pin below moves with
       the share and the literal does not. Ran it with the share at 0.2 — red. */
    expect(SPINE_SEED_REPEAT_MIN).toBe(8);
    expect(SPINE_SEED_THIRD_MIN).toBe(12);
    expect(m4SegmentCapFor(SPINE_SEED_REPEAT_MIN)).toBeGreaterThanOrEqual(2);
    expect(m4SegmentCapFor(SPINE_SEED_REPEAT_MIN - 1)).toBe(1);
    expect(m4SegmentCapFor(SPINE_SEED_THIRD_MIN)).toBeGreaterThanOrEqual(3);
    expect(m4SegmentCapFor(SPINE_SEED_THIRD_MIN - 1)).toBe(2);
    expect(SPINE_SEED_REPEAT_MIN).toBe(Math.ceil(2 / M4_ITEM_SHARE_MAX));
  });

  it("admits every episode's first seed, and a second from the same episode only once the spine carries eight", () => {
    /* The run-2 bug in miniature: two seeds of one episode among the first
       eight, and the sourcing ledger refuses the second at `m4-share` before
       its body is opened (brief §4 cause 3).
       MUTATION THAT KILLS THIS: make `shareAllows` return true. Ran it — red. */
    const ledger = new SpineSeedLedger();
    ledger.record("ep-a", 100);
    expect(ledger.allows("ep-a", 900)).toBe(false);
    expect(ledger.allows("ep-b", 0)).toBe(true);
    for (const id of ["ep-b", "ep-c", "ep-d", "ep-e", "ep-f", "ep-g"]) ledger.record(id, 0);
    expect(ledger.seeded).toBe(7);
    /* The eighth seed may be a repeat: it makes the spine carry 8, and
       floor(8 × 0.25) = 2. */
    expect(ledger.allows("ep-a", 900)).toBe(true);
    ledger.record("ep-a", 900);
    /* But not a third of the same episode until twelve. */
    expect(ledger.allows("ep-a", 1500)).toBe(false);
    for (const id of ["ep-h", "ep-i", "ep-j"]) ledger.record(id, 0);
    expect(ledger.seeded).toBe(11);
    expect(ledger.allows("ep-a", 1500)).toBe(true);
  });

  it("keeps one episode's seeds in tape order — a later seed may not start earlier than the one before it (M3)", () => {
    /* MUTATION THAT KILLS THIS: make `orderAllows` return true. Ran it — red. */
    const ledger = new SpineSeedLedger();
    for (const id of ["ep-a", "ep-b", "ep-c", "ep-d", "ep-e", "ep-f", "ep-g"]) ledger.record(id, 500);
    expect(ledger.shareAllows("ep-a")).toBe(true);
    expect(ledger.allows("ep-a", 499)).toBe(false);
    expect(ledger.allows("ep-a", 500)).toBe(true);
    expect(ledger.allows("ep-a", 501)).toBe(true);
  });
});

describe("summarizeSeeding — the driver's one Foray-wide seeding line (G-25)", () => {
  const act = (beats: Array<{ claim: string; seeded?: boolean }>): Act => ({
    title: "Act",
    thesis: "t",
    startState: "s",
    endState: "e",
    slots: [
      {
        title: "Slot",
        beats: beats.map((b) => ({
          claim: b.claim,
          exploration: false,
          ...(b.seeded ? { seed: { episodeId: "practical-ai--episode-900", startSec: 100, endSec: 200 } } : {})
        }))
      }
    ]
  });

  const sourced = (tapeFlags: boolean[], throughSeed: number): SourceBeatsResult => ({
    acts: [
      {
        title: "Act",
        thesis: "t",
        startState: "s",
        endState: "e",
        introduction: "i",
        exit: "x",
        slots: [
          {
            title: "Slot",
            beats: tapeFlags.map((tape, i) =>
              tape
                ? {
                    sourcing: "tape" as const,
                    claim: `claim ${i}`,
                    exploration: false,
                    tape: {
                      tier: 2 as const,
                      itemId: "practical-ai--episode-900",
                      startSec: 100,
                      endSec: 200,
                      startAnchor: "a",
                      endAnchor: "b",
                      why: "why this tape carries the claim for the listener"
                    }
                  }
                : { sourcing: "narration" as const, claim: `claim ${i}`, exploration: false, narration: { mode: "Carry" as const, reason: "slot has none" } }
            )
          }
        ]
      }
    ],
    newSegments: [],
    transcriptionQueueCandidates: [],
    tapeRelevance: Array.from({ length: tapeFlags.filter(Boolean).length }, (_, i) => ({
      actIndex: 0,
      slotIndex: 0,
      beatIndex: i,
      claim: `claim ${i}`,
      itemId: "practical-ai--episode-900",
      startSec: 100,
      endSec: 200,
      tier: 2 as const,
      seedWindowWon: i < throughSeed
    })) as unknown as SourceBeatsResult["tapeRelevance"],
    sourcingTrace: [],
    newSegmentSources: []
  }) as unknown as SourceBeatsResult;

  it("counts seeded beats from the deepened spine and tape beats from the sourcing result, side by side", () => {
    /* MUTATION THAT KILLS THIS: count `seeded` from `sourced.tapeRelevance`
       instead of from the beats' `seed` fields — the seeded count would read 2,
       not 3. Ran it — red. */
    const deepened = [act([{ claim: "a", seeded: true }, { claim: "b", seeded: true }, { claim: "c", seeded: true }, { claim: "d" }])];
    const line = summarizeSeeding(deepened, sourced([true, true, false, false], 2));
    expect(line).toBe("source: 3 of 4 beats seeded from the research map — 2 tape (2 through the seed) / 2 narration");
  });

  it("appends the merged beats and the pool cuts reused short of their extent only when there were any (F-96)", () => {
    /* Run 9's line could not say that four of its ten clips were run 8's
       pre-Q-01 cuts reused at their old length. MUTATION THAT KILLS THIS:
       count `mergedInto` rows as tape through the seed instead. */
    const deepened = [act([{ claim: "a", seeded: true }, { claim: "b", seeded: true }, { claim: "c" }])];
    const result = sourced([true, true, true], 2);
    const rows = result.tapeRelevance as unknown as Array<Record<string, unknown>>;
    rows[1]!.mergedInto = { slot: 0, beat: 0 };
    rows[2]!.poolCut = "reused";
    rows[2]!.poolCutShortBySec = 81.091;
    expect(summarizeSeeding(deepened, result)).toBe(
      "source: 2 of 3 beats seeded from the research map — 3 tape (2 through the seed) / 0 narration" +
        "; 1 beat(s) carried by an earlier beat's clip (F-96); 1 pool cut(s) reused 81 s short of this run's extent (F-84/F-96)"
    );
  });

  it("says 0 tape in the same words the per-slot lines use, so a no-tape run's every line still reads `0 tape`", () => {
    /* `runPipeline.test.ts` asserts that EVERY sourcing line of a no-tape
       outcome matches /0 tape/; this line joins that list. */
    const deepened = [act([{ claim: "a", seeded: true }, { claim: "b" }])];
    const line = summarizeSeeding(deepened, sourced([false, false], 0));
    expect(line).toMatch(/0 tape/);
    expect(line).toBe("source: 1 of 2 beats seeded from the research map — 0 tape (0 through the seed) / 2 narration");
  });
});
