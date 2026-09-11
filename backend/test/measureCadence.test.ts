import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

/**
 * §4.8 rule 3's own math, unit-tested against a small hand-built
 * fixture (independent of the real `data/forays.json`/`data/segments.json`
 * data `measure-cadence.mjs`'s own file-reading path uses) — this test
 * exists to prove `computeCadence`'s median/mean/cut-gap arithmetic is
 * correct, not to re-verify the real 155.34s/216.06s numbers (those are
 * a property of the committed data, asserted directly in
 * `stitchAct.test.ts` against the hardcoded `TEXTURE_CADENCE_SEC`
 * constant instead).
 *
 * NOT a static/direct import of measure-cadence.mjs: see
 * `test/writeNarration.test.ts`'s "round-trips through check-forays.mjs's
 * own DISCLOSURE_RX" test for the fuller account — Vitest's own vite-node
 * loader mishandles a space in the checkout path (this repo lives under
 * "Vibe Coding") whenever it re-resolves an import of a `.mjs` module. A
 * *static* top-level `import { computeCadence } from "...mjs"` hits the
 * identical defect even earlier, at module-collection time, before any
 * test body runs, and fails with "Invalid or unexpected token". A plain
 * Node subprocess started outside vite-node does not have that problem,
 * so computeCadence() is called there instead, with its arguments and
 * result round-tripped as JSON.
 */
interface CadenceResult {
  cutGaps: number[];
  totalRuntimeSec: number;
  median: number;
  mean: number;
}

function computeCadence(forays: unknown, segments: unknown, forayId: string): CadenceResult {
  const moduleUrl = pathToFileURL(resolvePath(__dirname, "../../tools/foray/measure-cadence.mjs")).href;
  const script =
    `import(${JSON.stringify(moduleUrl)}).then((mod) => {` +
    `try {` +
    `const result = mod.computeCadence(${JSON.stringify(forays)}, ${JSON.stringify(segments)}, ${JSON.stringify(forayId)});` +
    `process.stdout.write(JSON.stringify({ ok: true, result }));` +
    `} catch (err) {` +
    `process.stdout.write(JSON.stringify({ ok: false, message: String((err && err.message) || err) }));` +
    `}` +
    `});`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const parsed = JSON.parse(stdout) as { ok: true; result: CadenceResult } | { ok: false; message: string };
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.result;
}
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
