import { describe, it, expect, beforeEach } from "vitest";
import { recordUsage, resetUsageTracking, getUsageTotals } from "../src/generation/usageTracking";

/**
 * WS-B: `pipelineTokens` sums `usage` off every Anthropic reply across a
 * whole pipeline run (see `usageTracking.ts`'s own doc comment on why this
 * is a single process-wide counter). These pin the arithmetic and the
 * reset boundary; `runPipeline.test.ts` pins that a real run actually
 * calls `resetUsageTracking()`/`getUsageTotals()` at the right points.
 */
describe("usageTracking", () => {
  beforeEach(() => {
    resetUsageTracking();
  });

  it("starts at zero", () => {
    expect(getUsageTotals()).toEqual({ inputTokens: 0, outputTokens: 0, total: 0 });
  });

  it("sums input and output tokens across multiple recorded replies", () => {
    /* MUTATION THAT KILLS THIS: overwrite instead of accumulate
       (`totalInputTokens = usage.input_tokens`). The second call would
       then erase the first. Ran it — red. */
    recordUsage({ input_tokens: 100, output_tokens: 40 });
    recordUsage({ input_tokens: 25, output_tokens: 10 });
    expect(getUsageTotals()).toEqual({ inputTokens: 125, outputTokens: 50, total: 175 });
  });

  it("tolerates a missing or partial usage object rather than throwing", () => {
    recordUsage(undefined);
    recordUsage(null);
    recordUsage({});
    recordUsage({ input_tokens: 7 });
    expect(getUsageTotals()).toEqual({ inputTokens: 7, outputTokens: 0, total: 7 });
  });

  it("resets to zero for a new run", () => {
    recordUsage({ input_tokens: 500, output_tokens: 500 });
    resetUsageTracking();
    expect(getUsageTotals().total).toBe(0);
  });
});
