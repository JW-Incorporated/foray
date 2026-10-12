import { describe, it, expect } from "vitest";
import { measureStage, spanMsOf, StageTimingLog, type StageTiming } from "../src/generation/stageTiming";

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

describe("GV-01: a stage that throws is still timed", () => {
  it("records {failed: true} with the stage's real ms, then rethrows the same error", async () => {
    /* MUTATION THAT KILLS THIS: restore `run` to `measureStage` + push — a
       throwing stage leaves no entry at all, so a failed attempt reports no
       time for the stage it died in. Ran it — red. */
    const log = new StageTimingLog();
    await log.run("understand", () => 1);
    const boom = new Error("deepen exhausted its retry");
    await expect(
      log.run("deepen", async () => {
        await sleep(20);
        throw boom;
      })
    ).rejects.toBe(boom);

    const [ok, failed] = log.all();
    expect(ok!.failed).toBeUndefined();
    expect(failed!.name).toBe("deepen");
    expect(failed!.failed).toBe(true);
    expect(failed!.ms).toBeGreaterThanOrEqual(15);
    expect(failed!.ms).toBeLessThan(2000);
  });
});

describe("GV-01: spanMsOf", () => {
  const at = (iso: string, ms: number, extra: Partial<StageTiming> = {}): StageTiming => ({
    name: "s",
    startedAt: `2026-10-11T00:00:${iso}Z`,
    ms,
    ...extra
  });

  it("is last end minus first start, so overlapping stages count once", () => {
    /* MUTATION THAT KILLS THIS: return the sum of `ms` (totalMs) — two
       overlapping 4 s narrations would read 9 s instead of the 6 s that
       passed. */
    const timings = [at("00.000", 1000), at("01.000", 4000, { name: "narrate:0" }), at("02.000", 4000, { name: "narrate:1" })];
    expect(spanMsOf(timings)).toBe(6000);
  });

  it("skips resumed entries, counts failed ones, and is null when nothing ran", () => {
    /* MUTATION THAT KILLS THIS: drop the resumed filter — the resumed entry
       stamped later drags the span's end past the stages that ran. */
    const timings = [at("00.000", 500), at("01.000", 2000, { failed: true }), at("09.000", 0, { resumed: true })];
    expect(spanMsOf(timings)).toBe(3000);
    expect(spanMsOf([at("00.000", 0, { resumed: true })])).toBeNull();
    expect(spanMsOf([])).toBeNull();
  });
});
