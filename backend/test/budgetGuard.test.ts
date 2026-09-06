import { describe, it, expect } from "vitest";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetExceededError, BudgetGuard, EpisodeBudgetExceededError } from "../src/cost/budgetGuard";

describe("BudgetGuard", () => {
  it("records a cost event when under budget", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 2.0);

    const record = await guard.checkAndRecord({
      userId: "u1",
      operation: "tier1_classify",
      provider: "stub",
      estimatedUsd: 0.01
    });

    expect(record.estimatedUsd).toBe(0.01);
    expect(await guard.spentToday("u1")).toBeCloseTo(0.01);
  });

  it("throws BudgetExceededError when a Tier 1 call would exceed the full daily budget", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);

    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.9 });

    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.2 })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("cuts off Tier 2 (transcript) spend before Tier 1 (corner case 33 / 02_ARCHITECTURE.md)", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);

    // Tier 2 cuts off at 60% of budget by default — spend 0.55, leaving
    // headroom under the full budget but over the tier-2 cutoff.
    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.55 });

    // A further tier-2 spend of 0.1 would push total to 0.65 > 0.6 cutoff — blocked.
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier2_transcript", provider: "anthropic", estimatedUsd: 0.1 })
    ).rejects.toThrow(BudgetExceededError);

    // But Tier 1 spend is still allowed up to the full budget.
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.1 })
    ).resolves.toBeDefined();
  });

  it("never gates Tier 0 (ingestion / free metadata) spend", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 0.0); // zero budget

    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier0_normalize", provider: "none", estimatedUsd: 0 })
    ).resolves.toBeDefined();
  });

  it("tracks spend separately per user", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);

    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.5 });
    await guard.checkAndRecord({ userId: "u2", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.5 });

    expect(await guard.spentToday("u1")).toBeCloseTo(0.5);
    expect(await guard.spentToday("u2")).toBeCloseTo(0.5);
  });

  it("remainingToday never goes negative", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);
    // directly seed the sink past budget (simulating an out-of-band cost event)
    await sink.record({ userId: "u1", operation: "tts_generate", provider: "elevenlabs", estimatedUsd: 5 });
    expect(await guard.remainingToday("u1")).toBe(0);
  });

  it("rejects a single Foray's stages summing past the per-episode ceiling even when the daily user cap hasn't been hit", async () => {
    const sink = new InMemoryCostEventSink();
    // Daily cap is generous ($100) so it never trips; the per-episode cap ($8) is what should fire.
    const guard = new BudgetGuard(sink, 100.0, 8.0);
    const sessionId = "foray-session-1";

    // understandPrompt, researchShape, buildSpine each ~$2 — fine so far ($6 total).
    await guard.checkAndRecord({ userId: "u1", operation: "prompt_understand", provider: "anthropic", estimatedUsd: 2, sessionId });
    await guard.checkAndRecord({ userId: "u1", operation: "external_research", provider: "anthropic", estimatedUsd: 2, sessionId });
    await guard.checkAndRecord({ userId: "u1", operation: "spine_build", provider: "anthropic", estimatedUsd: 2, sessionId });

    // A deepenAct() call for one more act pushes this Foray's session total to $9 > $8 cap — rejected,
    // even though the daily user cap ($100) is nowhere close to being hit.
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "deepen_act", provider: "anthropic", estimatedUsd: 3, sessionId })
    ).rejects.toThrow(EpisodeBudgetExceededError);

    // Spend recorded so far for this Foray is unaffected by the rejected attempt.
    expect(await guard.spentThisEpisode(sessionId)).toBeCloseTo(6);

    // A different Foray (different sessionId) for the same user starts fresh.
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "prompt_understand", provider: "anthropic", estimatedUsd: 1, sessionId: "foray-session-2" })
    ).resolves.toBeDefined();
  });

  it("leaves existing daily-cap behavior unchanged for callers that don't pass a sessionId", async () => {
    const sink = new InMemoryCostEventSink();
    // Per-episode cap set very low, but since no sessionId is ever passed, it must never fire —
    // only the daily cap governs calls that don't opt into episode scoping.
    const guard = new BudgetGuard(sink, 1.0, 0.01);

    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.5 });
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.4 })
    ).resolves.toBeDefined();

    // Only the daily cap ($1.0) blocks the next one, not the (unused) episode cap.
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.2 })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("does not enforce an episode cap when the sink lacks sumUsdBySession (purely additive)", async () => {
    // A minimal sink that implements only the required interface members —
    // simulating a future custom CostEventSink that hasn't added session scoping yet.
    class MinimalSink {
      private events: { userId: string; ts: string; estimatedUsd: number }[] = [];
      async record(input: { userId: string; estimatedUsd: number }) {
        const record = { ...input, id: "x", ts: new Date().toISOString() };
        this.events.push(record as { userId: string; ts: string; estimatedUsd: number });
        return record as never;
      }
      async sumUsdSince(userId: string, sinceIso: string) {
        const since = new Date(sinceIso).getTime();
        return this.events
          .filter((e) => e.userId === userId && new Date(e.ts).getTime() >= since)
          .reduce((sum, e) => sum + e.estimatedUsd, 0);
      }
      async all() {
        return this.events as never;
      }
    }

    const guard = new BudgetGuard(new MinimalSink() as never, 100.0, 0.01);
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "spine_build", provider: "anthropic", estimatedUsd: 5, sessionId: "s1" })
    ).resolves.toBeDefined();
  });
});
