import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * env.ts computes `env.dailyBudgetUsd` at module-import time by reading
 * process.env directly (not via a loaded .env file in this test — we set
 * process.env before each import). Each test must reset the module
 * registry and re-import so the module top-level runs fresh with the
 * process.env values this test set.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadEnvWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) {
    delete process.env.DAILY_BUDGET_USD;
  } else {
    process.env.DAILY_BUDGET_USD = value;
  }
  return import("../src/config/env");
}

describe("DAILY_BUDGET_USD parsing", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls back to the default (2.0) when unset", async () => {
    const { env } = await loadEnvWith(undefined);
    expect(env.dailyBudgetUsd).toBe(2.0);
  });

  it("accepts a valid positive value", async () => {
    const { env } = await loadEnvWith("5.5");
    expect(env.dailyBudgetUsd).toBe(5.5);
  });

  it("accepts zero (boundary of non-negative)", async () => {
    const { env } = await loadEnvWith("0");
    expect(env.dailyBudgetUsd).toBe(0);
  });

  it("fails startup fast on a negative value", async () => {
    await expect(loadEnvWith("-1")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("fails startup fast on a NaN (non-numeric) value", async () => {
    await expect(loadEnvWith("not-a-number")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("fails startup fast on an empty string", async () => {
    await expect(loadEnvWith("")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("fails startup fast on a whitespace-only string", async () => {
    await expect(loadEnvWith("   ")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("fails startup fast on an excessively large value", async () => {
    await expect(loadEnvWith("1000000")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("fails startup fast on Infinity", async () => {
    await expect(loadEnvWith("Infinity")).rejects.toThrow(/DAILY_BUDGET_USD/);
  });

  it("error message never includes the offending raw value", async () => {
    try {
      await loadEnvWith("-999.123456");
      throw new Error("expected loadEnvWith to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("DAILY_BUDGET_USD");
      expect(message).not.toContain("-999.123456");
      expect(message).not.toContain("999");
    }
  });
});
