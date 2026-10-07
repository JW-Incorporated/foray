import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * env.ts computes `env.runBudgetUsd` / `env.episodeBudgetUsd` at module-import
 * time by reading process.env directly. Its top-level side effect also calls
 * `dotenv.config()` against the repo-root/backend .env files if they
 * exist — on a real developer machine those files may set the budget
 * variables (see .env.example), which would silently leak into these tests
 * and make them depend on local filesystem state instead of the process.env
 * values each test explicitly sets. Mock dotenv.config to a no-op so these
 * tests are fully isolated from any real .env file.
 */
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
  config: vi.fn()
}));

const ORIGINAL_ENV = { ...process.env };
const BUDGET_VARS = ["RUN_BUDGET_USD", "EPISODE_BUDGET_USD", "DAILY_BUDGET_USD"] as const;

/** Imports env.ts fresh with exactly `vars` set among the budget variables. */
async function loadEnvWithVars(vars: Partial<Record<(typeof BUDGET_VARS)[number], string>>) {
  vi.resetModules();
  for (const name of BUDGET_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) process.env[name] = value;
  return import("../src/config/env");
}

async function loadEnvWith(value: string | undefined) {
  return loadEnvWithVars(value === undefined ? {} : { RUN_BUDGET_USD: value });
}

async function loadEnvWithEpisode(value: string | undefined) {
  return loadEnvWithVars(value === undefined ? {} : { EPISODE_BUDGET_USD: value });
}

/* CH2-04: the per-process cap was called DAILY_BUDGET_USD; it is RUN_BUDGET_USD
   now (docs/DECISIONS.md 2026-10-07). These are the DAILY cases, renamed. */
describe("RUN_BUDGET_USD parsing", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /* The default moved 2.0 -> 25.0 when the §4 generation pipeline landed
     (F-04): $2.00 was sized for the enrichment pipeline alone and stops a
     medium Foray mid-run. The number is asserted, not just its existence,
     because the whole point of F-04 is that a default nobody checks against
     a real workload is how a run halts in production. env.ts carries the
     arithmetic. */
  it("falls back to the default (25.0 — one medium Foray plus headroom) when unset", async () => {
    const { env } = await loadEnvWith(undefined);
    expect(env.runBudgetUsd).toBe(25.0);
  });

  it("keeps the run default at or above the per-Foray ceiling", async () => {
    const { env } = await loadEnvWith(undefined);
    /* Every metered call counts against the whole run cap. A run default
       below the episode default would make the per-Foray cap unreachable. */
    expect(env.runBudgetUsd).toBeGreaterThanOrEqual(env.episodeBudgetUsd);
  });

  it("accepts a valid positive value", async () => {
    const { env } = await loadEnvWith("5.5");
    expect(env.runBudgetUsd).toBe(5.5);
  });

  it("accepts zero (boundary of non-negative)", async () => {
    const { env } = await loadEnvWith("0");
    expect(env.runBudgetUsd).toBe(0);
  });

  it("fails startup fast on a negative value", async () => {
    await expect(loadEnvWith("-1")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("fails startup fast on a NaN (non-numeric) value", async () => {
    await expect(loadEnvWith("not-a-number")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("fails startup fast on an empty string", async () => {
    await expect(loadEnvWith("")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("fails startup fast on a whitespace-only string", async () => {
    await expect(loadEnvWith("   ")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("fails startup fast on an excessively large value", async () => {
    await expect(loadEnvWith("1000000")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("fails startup fast on Infinity", async () => {
    await expect(loadEnvWith("Infinity")).rejects.toThrow(/RUN_BUDGET_USD/);
  });

  it("error message never includes the offending raw value", async () => {
    try {
      await loadEnvWith("-999.123456");
      throw new Error("expected loadEnvWith to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("RUN_BUDGET_USD");
      expect(message).not.toContain("-999.123456");
      expect(message).not.toContain("999");
    }
  });
});

/* CH2-04 (B2-03): EPISODE_BUDGET_USD used to be read by a lenient rule — `-1`
   was kept as -1, so every metered Foray call threw and told the operator to
   raise a cap that was never positive; `1O` silently became $10. It now goes
   through the same bounded schema as RUN_BUDGET_USD; these mirror its cases.
   MUTATION THAT KILLS THE REJECTING CASES: read EPISODE_BUDGET_USD through a
   lenient `Number.isFinite(n) ? n : fallback` (the deleted `readNumber`)
   instead of `readBoundedNumber` — "-1" loads as -1 and "1O" as 10. */
describe("EPISODE_BUDGET_USD parsing", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls back to the default (10.0, the top of §9.2's ~$5-10/Foray range) when unset", async () => {
    const { env } = await loadEnvWithEpisode(undefined);
    expect(env.episodeBudgetUsd).toBe(10.0);
  });

  it("accepts a valid positive value", async () => {
    const { env } = await loadEnvWithEpisode("7.5");
    expect(env.episodeBudgetUsd).toBe(7.5);
  });

  it("accepts zero (boundary of non-negative)", async () => {
    const { env } = await loadEnvWithEpisode("0");
    expect(env.episodeBudgetUsd).toBe(0);
  });

  it("fails startup fast on a negative value (was: kept as -1)", async () => {
    await expect(loadEnvWithEpisode("-1")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on a typo like '1O' (was: silently the $10 default)", async () => {
    await expect(loadEnvWithEpisode("1O")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on a NaN (non-numeric) value", async () => {
    await expect(loadEnvWithEpisode("not-a-number")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on an empty string", async () => {
    await expect(loadEnvWithEpisode("")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on a whitespace-only string", async () => {
    await expect(loadEnvWithEpisode("   ")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on an excessively large value", async () => {
    await expect(loadEnvWithEpisode("1000000")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("fails startup fast on Infinity", async () => {
    await expect(loadEnvWithEpisode("Infinity")).rejects.toThrow(/EPISODE_BUDGET_USD/);
  });

  it("error message never includes the offending raw value", async () => {
    try {
      await loadEnvWithEpisode("-999.123456");
      throw new Error("expected loadEnvWithEpisode to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("EPISODE_BUDGET_USD");
      expect(message).not.toContain("-999.123456");
      expect(message).not.toContain("999");
    }
  });
});

describe("the DAILY_BUDGET_USD -> RUN_BUDGET_USD rename (CH2-04)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails startup when the old name is set, naming RUN_BUDGET_USD and never the value", async () => {
    /* MUTATION THAT KILLS THIS: delete the `refuseRenamedDailyBudget()` call
       in env.ts — the old variable is silently ignored and the import loads. */
    await expect(loadEnvWithVars({ DAILY_BUDGET_USD: "123.45" })).rejects.toThrow(/DAILY_BUDGET_USD was renamed to RUN_BUDGET_USD/);
    try {
      await loadEnvWithVars({ DAILY_BUDGET_USD: "123.45", RUN_BUDGET_USD: "30" });
      throw new Error("expected the old name to fail startup even beside the new one");
    } catch (err) {
      expect((err as Error).message).toContain("DAILY_BUDGET_USD was renamed to RUN_BUDGET_USD");
      expect((err as Error).message).not.toContain("123.45");
    }
  });
});

describe("envPresenceSummary (CH2-04)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports both caps in force, the per-Foray one included", async () => {
    const { envPresenceSummary } = await loadEnvWithVars({ RUN_BUDGET_USD: "30", EPISODE_BUDGET_USD: "6" });
    /* MUTATION THAT KILLS THIS: drop `episodeBudgetUsd` from envPresenceSummary. */
    expect(envPresenceSummary()).toMatchObject({ runBudgetUsd: 30, episodeBudgetUsd: 6 });
  });
});
