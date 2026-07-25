import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { nextWeight, nextConfidence, dampedDelta } from "../../src/curation/interestLearning";

const NUM_RUNS = 200;

describe("nextWeight — property", () => {
  it("stays within [-1, 1] for any starting weight and any sequence of deltas", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }),
        fc.array(fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }), { maxLength: 50 }),
        (start, deltas) => {
          let weight = start;
          for (const d of deltas) {
            weight = nextWeight(weight, d);
            expect(weight).toBeGreaterThanOrEqual(-1);
            expect(weight).toBeLessThanOrEqual(1);
            expect(Number.isNaN(weight)).toBe(false);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("nextConfidence — property", () => {
  it("stays within [0, 1] and never decreases from a durable signal", () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }), (start) => {
        const next = nextConfidence(start);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThanOrEqual(1);
        expect(next).toBeGreaterThanOrEqual(start);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("dampedDelta — property", () => {
  it("never amplifies a delta, never flips its sign", () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }),
        fc.constantFrom("deep-learn", "stretch", "narrative", "comfort", "continue", null),
        (delta, slot) => {
          const damped = dampedDelta(delta, slot);
          expect(Math.abs(damped)).toBeLessThanOrEqual(Math.abs(delta) + 1e-9);
          if (delta > 0) expect(damped).toBeGreaterThanOrEqual(0);
          if (delta < 0) expect(damped).toBeLessThanOrEqual(0);
          // Object.is-sensitive: delta may legitimately be -0 (float shrinking hits it),
          // and dampedDelta correctly passes it through unchanged — compare magnitude,
          // not signed-zero identity.
          if (delta === 0) expect(Math.abs(damped)).toBe(0);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
