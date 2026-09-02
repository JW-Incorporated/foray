import { describe, it, expect } from "vitest";
import { measureStage, StageTimingLog } from "../src/generation/stageTiming";

/**
 * §6.3's minimal batch-pipeline scope (stageTiming.ts's own doc comment):
 * proves the timing primitive records REAL durations, not placeholders —
 * per this stage's own Tests section ("it's tested for correctness
 * (records real durations, not placeholders)").
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("measureStage", () => {
  it("records a real elapsed duration, not a placeholder", async () => {
    const { result, timing } = await measureStage("sleep-20ms", async () => {
      await sleep(20);
      return "done";
    });
    expect(result).toBe("done");
    expect(timing.name).toBe("sleep-20ms");
    // Real timer, so allow scheduler slack — but it must be nonzero and in
    // the right ballpark, not a hardcoded/guessed constant.
    expect(timing.ms).toBeGreaterThanOrEqual(15);
    expect(timing.ms).toBeLessThan(2000);
    expect(new Date(timing.startedAt).toString()).not.toBe("Invalid Date");
  });

  it("propagates a thrown error unchanged, never swallowing it", async () => {
    await expect(
      measureStage("failing-stage", async () => {
        throw new Error("real failure");
      })
    ).rejects.toThrow("real failure");
  });

  it("times a synchronous function too", async () => {
    const { result, timing } = await measureStage("sync-stage", () => 42);
    expect(result).toBe(42);
    expect(timing.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("StageTimingLog", () => {
  it("collects one entry per run(), in call order, with a correct total", async () => {
    const log = new StageTimingLog();
    const a = await log.run("a", async () => {
      await sleep(10);
      return 1;
    });
    const b = await log.run("b", async () => {
      await sleep(10);
      return 2;
    });
    expect(a).toBe(1);
    expect(b).toBe(2);

    const entries = log.all();
    expect(entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(log.totalMs()).toBe(entries.reduce((sum, e) => sum + e.ms, 0));
    expect(log.totalMs()).toBeGreaterThanOrEqual(15);
  });

  it("all() returns a copy — mutating it does not affect the log", async () => {
    const log = new StageTimingLog();
    await log.run("only", () => "x");
    const snapshot = log.all();
    snapshot.push({ name: "injected", startedAt: new Date().toISOString(), ms: 999 });
    expect(log.all()).toHaveLength(1);
  });
});
