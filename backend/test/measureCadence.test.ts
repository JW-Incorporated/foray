import { describe, it, expect } from "vitest";
import { computeCadence } from "../../tools/foray/measure-cadence.mjs";

/**
 * §4.8 rule 3's own math, unit-tested against a small hand-built
 * fixture (independent of the real `data/forays.json`/`data/segments.json`
 * data `measure-cadence.mjs`'s own file-reading path uses) — this test
 * exists to prove `computeCadence`'s median/mean/cut-gap arithmetic is
 * correct, not to re-verify the real 155.34s/216.06s numbers (those are
 * a property of the committed data, asserted directly in
 * `stitchAct.test.ts` against the hardcoded `TEXTURE_CADENCE_SEC`
 * constant instead).
 */
describe("measure-cadence.mjs computeCadence()", () => {
  it("computes cut-gaps, median and mean correctly against a small fixture", () => {
    // Three segments, two from item A (0-40s, 40-70s: 70s total on A),
    // then one from item B (70-100s: 30s on B). One cut (A -> B) at
    // t=70, plus the trailing gap from 70 to the end (100).
    const segments = {
      segments: [
        { id: "segA#1", item_id: "itemA", start_sec: 0, end_sec: 40 },
        { id: "segA#2", item_id: "itemA", start_sec: 40, end_sec: 70 },
        { id: "segB#1", item_id: "itemB", start_sec: 0, end_sec: 30 }
      ]
    };
    const forays = {
      forays: [
        {
          id: "fixture-foray",
          items: [
            { type: "segment", segment_id: "segA#1" },
            { type: "segment", segment_id: "segA#2" },
            { type: "segment", segment_id: "segB#1" }
          ]
        }
      ]
    };

    const result = computeCadence(forays, segments, "fixture-foray");

    // Cut at t=70 (A -> B): first gap is 70 - 0 = 70. Trailing gap is
    // (70 + 30) - 70 = 30.
    expect(result.cutGaps).toEqual([70, 30]);
    expect(result.totalRuntimeSec).toBe(100);
    // median of [30, 70] = (30+70)/2 = 50
    expect(result.median).toBe(50);
    // mean of [70, 30] = 50
    expect(result.mean).toBe(50);
  });

  it("computes an odd-length median correctly (middle element, not averaged)", () => {
    const segments = {
      segments: [
        { id: "segA#1", item_id: "itemA", start_sec: 0, end_sec: 10 },
        { id: "segB#1", item_id: "itemB", start_sec: 0, end_sec: 20 },
        { id: "segC#1", item_id: "itemC", start_sec: 0, end_sec: 30 }
      ]
    };
    const forays = {
      forays: [
        {
          id: "fixture-foray-2",
          items: [
            { type: "segment", segment_id: "segA#1" },
            { type: "segment", segment_id: "segB#1" },
            { type: "segment", segment_id: "segC#1" }
          ]
        }
      ]
    };

    const result = computeCadence(forays, segments, "fixture-foray-2");
    // Cuts at t=10 (A->B) and t=30 (B->C). Gaps: 10-0=10, 30-10=20, trailing 60-30=30.
    expect(result.cutGaps).toEqual([10, 20, 30]);
    // median of [10, 20, 30] = 20
    expect(result.median).toBe(20);
  });

  it("throws when the requested Foray id is not found", () => {
    expect(() => computeCadence({ forays: [] }, { segments: [] }, "missing")).toThrow();
  });
});
