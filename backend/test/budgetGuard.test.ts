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
    expect(await guard.spentThisRun()).toBeCloseTo(0.01);
  });

  it("throws BudgetExceededError when a call would exceed the run budget", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);

    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.9 });

    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.2 })
    ).rejects.toThrow(BudgetExceededError);
  });

  /* CH2-04 (B2-06): the tier cutoff is gone. No production operation was ever
     tier-prefixed, so every call already got the full cap; the next caller to
     name an operation "tier2_..." would have got 60% of it, a number nobody
     chose. The operation is a label for the log, never a share of the cap. */
  it("every operation gets the full run cap, whatever its name", async () => {
    for (const operation of ["tier2_transcript", "tier1_classify", "tier0_normalize", "narrate", "spine_build"]) {
      const guard = new BudgetGuard(new InMemoryCostEventSink(), 1.0);
      /* MUTATION THAT KILLS THIS: re-add a prefix cutoff in checkAndRecordNow,
         `const cap = this.runBudgetUsd * (input.operation.startsWith("tier2") ? 0.6 : 1)`
         — the tier2 operation is refused at 0.95. */
      await expect(guard.checkAndRecord({ userId: "u1", operation, provider: "anthropic", estimatedUsd: 0.95 })).resolves.toBeDefined();
      await expect(guard.checkAndRecord({ userId: "u1", operation, provider: "anthropic", estimatedUsd: 0.1 })).rejects.toThrow(
        BudgetExceededError
      );
    }
  });

  /* CH2-04 (B2-02): RUN_BUDGET_USD is what this PROCESS may spend, so the
     cap is the sink's total, not one user's share of it. It used to be summed
     per user since local midnight, which made a two-user process a 2x cap. */
  it("the run cap is the process total: two users' calls share it", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);

    await guard.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: 0.5 });
    await guard.checkAndRecord({ userId: "u2", operation: "narrate", provider: "anthropic", estimatedUsd: 0.5 });

    expect(await guard.spentThisRun()).toBeCloseTo(1.0);
    /* MUTATION THAT KILLS THIS: sum per user again in checkAndRecordNow,
       `(await this.sink.all()).filter((e) => e.userId === input.userId)` —
       u2's next call sees 0.5 and passes. */
    await expect(
      guard.checkAndRecord({ userId: "u2", operation: "narrate", provider: "anthropic", estimatedUsd: 0.1 })
    ).rejects.toThrow(BudgetExceededError);
  });

  it("remainingThisRun never goes negative", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);
    // directly seed the sink past budget (simulating an out-of-band cost event)
    await sink.record({ userId: "u1", operation: "tts_generate", provider: "elevenlabs", estimatedUsd: 5 });
    expect(await guard.remainingThisRun()).toBe(0);
  });

  it("rejects a single Foray's stages summing past the per-episode ceiling even when the run cap hasn't been hit", async () => {
    const sink = new InMemoryCostEventSink();
    // Run cap is generous ($100) so it never trips; the per-episode cap ($8) is what should fire.
    const guard = new BudgetGuard(sink, 100.0, 8.0);
    const sessionId = "foray-session-1";

    // understandPrompt, researchShape, buildSpine each ~$2 — fine so far ($6 total).
    await guard.checkAndRecord({ userId: "u1", operation: "prompt_understand", provider: "anthropic", estimatedUsd: 2, sessionId });
    await guard.checkAndRecord({ userId: "u1", operation: "external_research", provider: "anthropic", estimatedUsd: 2, sessionId });
    await guard.checkAndRecord({ userId: "u1", operation: "spine_build", provider: "anthropic", estimatedUsd: 2, sessionId });

    // A deepenAct() call for one more act pushes this Foray's session total to $9 > $8 cap — rejected,
    // even though the run cap ($100) is nowhere close to being hit.
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

  it("leaves the run cap alone for callers that don't pass a sessionId", async () => {
    const sink = new InMemoryCostEventSink();
    // Per-episode cap set very low, but since no sessionId is ever passed, it must never fire —
    // only the run cap governs calls that don't opt into episode scoping.
    const guard = new BudgetGuard(sink, 1.0, 0.01);

    await guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.5 });
    await expect(
      guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.4 })
    ).resolves.toBeDefined();

    // Only the run cap ($1.0) blocks the next one, not the (unused) episode cap.
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
      async sumUsd() {
        return this.events.reduce((sum, e) => sum + e.estimatedUsd, 0);
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

/* Round-3 audit, lane L6 (backend-rest-13): concurrent callers cannot all
   pass the cap, because check-and-record is serialised per guard. */
describe("BudgetGuard under concurrency", () => {
  it("four concurrent 0.4 calls against a 1.0 cap: exactly two record, two are refused", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1.0);
    const call = () => guard.checkAndRecord({ userId: "u1", operation: "tier1_classify", provider: "anthropic", estimatedUsd: 0.4 });
    const settled = await Promise.allSettled([call(), call(), call(), call()]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason).toBeInstanceOf(BudgetExceededError);
    expect(await guard.spentThisRun()).toBeCloseTo(0.8);
  });

  it("the per-Foray ceiling holds under concurrency too, and a refusal does not jam later calls", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 100, 1.0);
    const call = (usd: number) =>
      guard.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: usd, sessionId: "s1" });
    const settled = await Promise.allSettled([call(0.6), call(0.6), call(0.6)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((s) => s.status === "rejected").every((s) => (s as PromiseRejectedResult).reason instanceof EpisodeBudgetExceededError)).toBe(true);
    await expect(call(0.3)).resolves.toBeDefined();
  });
});

/* CH2-04 characterization (code-health-2 B2-02): the cap lives in this
   process. The sink is in memory and nothing persists it, so a guard counts
   only what was recorded through it. Both pins survive the change: they are
   the truth the rename to RUN_BUDGET_USD makes the name match. */
describe("BudgetGuard is per-process (CH2-04)", () => {
  it("spend summed across N calls in one process stops at the cap", async () => {
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 1.0);
    let recorded = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await guard.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: 0.3 });
        recorded++;
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        refused++;
      }
    }
    /* MUTATION THAT KILLS THIS: drop the cap comparison in checkAndRecordNow
       — all ten calls record. */
    expect(recorded).toBe(3);
    expect(refused).toBe(7);
  });

  it("a fresh guard over a fresh sink starts at 0: a second process does not share the first one's cap", async () => {
    const first = new BudgetGuard(new InMemoryCostEventSink(), 1.0);
    await first.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: 0.9 });
    await expect(
      first.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: 0.2 })
    ).rejects.toThrow(BudgetExceededError);

    /* What a second `npm run generate-forays` sees: nothing the first one
       spent. This documents the per-process truth; it is not a mutation
       target (a shared sink would be a new feature, see docs/DECISIONS.md). */
    const second = new BudgetGuard(new InMemoryCostEventSink(), 1.0);
    await expect(
      second.checkAndRecord({ userId: "u1", operation: "narrate", provider: "anthropic", estimatedUsd: 0.9 })
    ).resolves.toBeDefined();
  });
});
