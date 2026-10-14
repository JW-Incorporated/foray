import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEFAULT_UNIT_CAPS,
  UnitBudgetExceededError,
  UnitBudgetGuard,
  UnitBudgetStopError,
  findUnitBudgetError,
  unitSpendOf
} from "../src/cost/unitBudget";
import { BudgetGuard, EpisodeBudgetExceededError } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { NullJevClient, meteredJevClient } from "../src/generation/jevClient";
import { RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
import { FakeJevClient, jevFixtures, noulAnswer } from "./helpers/fakeJevClient";

/**
 * GV-90 (docs/roadmap/generation-v2.md, R1-19): the per-Foray unit caps —
 * Spark seconds, second-box seconds, Jev calls. Everything runs on a fake
 * clock and in-memory guards; nothing here reaches a model.
 */

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    }
  };
}

const ENV_KEYS = ["FORAY_SPARK_SECONDS_PER_FORAY", "FORAY_SECOND_BOX_SECONDS_PER_FORAY", "FORAY_JEV_CALLS_PER_FORAY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("UnitBudgetGuard: caps", () => {
  it("reads the tier's caps, the call context's tier when none is given, and the long caps when neither names one", async () => {
    /* MUTATION THAT KILLS THIS: ignore currentCallContext().tier in tierOf
       (every untiered call gets the long caps). Ran it — red. */
    const g = new UnitBudgetGuard();
    expect(g.caps("short")).toEqual({ sparkSeconds: 120, secondBoxSeconds: 180, jevCalls: 250 });
    expect(g.caps("medium")).toEqual({ sparkSeconds: 600, secondBoxSeconds: 900, jevCalls: 1000 });
    expect(g.caps("long")).toEqual({ sparkSeconds: 1500, secondBoxSeconds: 2400, jevCalls: 2500 });
    expect(g.caps()).toEqual(DEFAULT_UNIT_CAPS.long);
    expect(g.caps("bogus")).toEqual(DEFAULT_UNIT_CAPS.long);
    const inShort = await runWithRunLog(new RunLog(), () => withCallContext({ tier: "short" }, async () => g.caps()));
    expect(inShort).toEqual(DEFAULT_UNIT_CAPS.short);
  });

  it("an override replaces that unit's cap for every tier and leaves the others alone", () => {
    /* MUTATION THAT KILLS THIS: apply the overrides only to the medium tier.
       Ran it — red. */
    const g = new UnitBudgetGuard({ overrides: { sparkSeconds: 42, jevCalls: undefined } });
    for (const tier of ["short", "medium", "long"] as const) {
      expect(g.caps(tier)).toEqual({ ...DEFAULT_UNIT_CAPS[tier], sparkSeconds: 42 });
    }
  });
});

describe("UnitBudgetGuard: reserve and reconcile", () => {
  it("reserving beyond the cap throws UnitBudgetExceededError with the unit and its figures, and charges nothing", async () => {
    /* MUTATION THAT KILLS THIS: compare with >= instead of > (a reservation
       that lands exactly on the cap is refused). Ran it — red. */
    const g = new UnitBudgetGuard();
    await g.reserve({ sessionId: "s1", tier: "short", unit: "sparkSeconds", amount: 100 });
    await g.reserve({ sessionId: "s1", tier: "short", unit: "sparkSeconds", amount: 20 });
    const err = await g.reserve({ sessionId: "s1", tier: "short", unit: "sparkSeconds", amount: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitBudgetExceededError);
    expect(err).toMatchObject({ sessionId: "s1", unit: "sparkSeconds", spent: 120, attempted: 5, cap: 120 });
    expect((err as Error).message).toContain("sparkSeconds");
    expect(g.spent("s1")).toEqual({ sparkSeconds: 120, secondBoxSeconds: 0, jevCalls: 0 });
  });

  it("concurrent reserves under one session never overshoot the cap", async () => {
    /* MUTATION THAT KILLS THIS: read the session's spend in reserve() before
       joining the lock and hand that snapshot to the check — every concurrent
       caller sees 0 and all 30 pass. Ran it — red. */
    const g = new UnitBudgetGuard({ overrides: { jevCalls: 10 } });
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => g.reserve({ sessionId: "s1", unit: "jevCalls", amount: 1 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(20);
    for (const r of refused) expect(r.reason).toBeInstanceOf(UnitBudgetExceededError);
    expect(g.spent("s1").jevCalls).toBe(10);
  });

  it("sessions are isolated, and reconcile frees the surplus once", async () => {
    /* MUTATION THAT KILLS THIS: key the spend by unit only (one pool for every
       session). Ran it — red. A second: drop the `settled` guard, so a second
       reconcile frees the surplus twice. Ran it — red. */
    const g = new UnitBudgetGuard();
    const r = await g.reserve({ sessionId: "a", tier: "short", unit: "secondBoxSeconds", amount: 180 });
    await expect(g.reserve({ sessionId: "a", tier: "short", unit: "secondBoxSeconds", amount: 1 })).rejects.toBeInstanceOf(UnitBudgetExceededError);
    /* Another Foray has its own cap. */
    await g.reserve({ sessionId: "b", tier: "short", unit: "secondBoxSeconds", amount: 180 });
    g.reconcile(r, 30);
    expect(g.spent("a").secondBoxSeconds).toBe(30);
    g.reconcile(r, 0);
    expect(g.spent("a").secondBoxSeconds).toBe(30);
    await g.reserve({ sessionId: "a", tier: "short", unit: "secondBoxSeconds", amount: 150 });
    expect(g.spent("a").secondBoxSeconds).toBe(180);
    expect(g.spent("b").secondBoxSeconds).toBe(180);
  });

  it("a refused reservation does not poison the lock", async () => {
    const g = new UnitBudgetGuard({ overrides: { sparkSeconds: 1 } });
    await expect(g.reserve({ sessionId: "s", unit: "sparkSeconds", amount: 5 })).rejects.toBeInstanceOf(UnitBudgetExceededError);
    await expect(g.reserve({ sessionId: "s", unit: "sparkSeconds", amount: 1 })).resolves.toMatchObject({ amount: 1 });
  });
});

describe("UnitBudgetGuard.metered", () => {
  it("charges a seconds unit its wall time, or the provider's server seconds when given, and a throw its elapsed time", async () => {
    /* MUTATION THAT KILLS THIS: reconcile with the estimate instead of the
       measured seconds. Ran it — red. A second: skip the reconcile on a
       throw (the estimate stays charged). Ran it — red. */
    const clock = fakeClock();
    const g = new UnitBudgetGuard({ now: clock.now });
    const wall = await g.metered({ sessionId: "s", tier: "medium", unit: "sparkSeconds", estimate: 30 }, async () => {
      clock.advance(4_500);
      return "done";
    });
    expect(wall).toBe("done");
    expect(g.spent("s").sparkSeconds).toBeCloseTo(4.5, 9);

    await g.metered({ sessionId: "s", tier: "medium", unit: "sparkSeconds", estimate: 30, serverSeconds: (v: { decodeSec: number }) => v.decodeSec }, async () => {
      clock.advance(9_000);
      return { decodeSec: 2 };
    });
    expect(g.spent("s").sparkSeconds).toBeCloseTo(6.5, 9);

    const boom = new Error("transport");
    await expect(
      g.metered({ sessionId: "s", tier: "medium", unit: "sparkSeconds", estimate: 30 }, async () => {
        clock.advance(1_000);
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(g.spent("s").sparkSeconds).toBeCloseTo(7.5, 9);
  });

  it("charges a count unit (jevCalls) its estimate, and refuses before running past the cap", async () => {
    const g = new UnitBudgetGuard({ overrides: { jevCalls: 2 } });
    const fn = vi.fn(async () => "ok");
    await g.metered({ sessionId: "s", unit: "jevCalls", estimate: 1 }, fn);
    await g.metered({ sessionId: "s", unit: "jevCalls", estimate: 1 }, fn);
    await expect(g.metered({ sessionId: "s", unit: "jevCalls", estimate: 1 }, fn)).rejects.toBeInstanceOf(UnitBudgetExceededError);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(g.spent("s").jevCalls).toBe(2);
  });

  it("appends a MeterEvent for the reservation and the settlement, tagged with the stage on the call context", async () => {
    /* MUTATION THAT KILLS THIS: append nothing on reconcile. Ran it — red. */
    const clock = fakeClock();
    const g = new UnitBudgetGuard({ now: clock.now });
    const log = new RunLog();
    await runWithRunLog(log, () =>
      withCallContext({ stage: "deepen", tier: "short" }, () =>
        g.metered({ sessionId: "s", unit: "secondBoxSeconds", estimate: 10 }, async () => {
          clock.advance(3_000);
        })
      )
    );
    expect(log.events("meter")).toEqual([
      { kind: "meter", unit: "secondBoxSeconds", amount: 10, reserved: true, stage: "deepen" },
      { kind: "meter", unit: "secondBoxSeconds", amount: 3, reserved: false, stage: "deepen" }
    ]);
  });
});

describe("findUnitBudgetError and UnitBudgetStopError", () => {
  it("finds the error through a cause chain, and the stop names the stage, the unit and the variable", () => {
    /* MUTATION THAT KILLS THIS: check only the top-level error (no cause
       walk). Ran it — red. */
    const inner = new UnitBudgetExceededError("s", "sparkSeconds", 118, 5, 120);
    const wrapped = Object.assign(new Error("Deepening act 2 failed after 1 retry"), { cause: inner });
    expect(findUnitBudgetError(wrapped)).toBe(inner);
    expect(findUnitBudgetError(new Error("plain"))).toBeNull();
    expect(findUnitBudgetError(new EpisodeBudgetExceededError("s", 1, 1, 1))).toBeNull();
    const stop = new UnitBudgetStopError("deepen", inner, "Checkpointed under k.");
    expect(stop).toMatchObject({ stage: "deepen", unit: "sparkSeconds", spent: 118, cap: 120, resumeHint: "Checkpointed under k." });
    expect(stop.message).toMatch(/stage "deepen"/);
    expect(stop.message).toMatch(/FORAY_SPARK_SECONDS_PER_FORAY/);
    expect(stop.cause).toBe(inner);
  });

  it("unitSpendOf reports the session's spend and its tier's caps", async () => {
    const g = new UnitBudgetGuard();
    await g.reserve({ sessionId: "s", tier: "short", unit: "jevCalls", amount: 3 });
    expect(unitSpendOf(g, "s", "short")).toEqual({ sparkSeconds: 0, secondBoxSeconds: 0, jevCalls: 3, caps: DEFAULT_UNIT_CAPS.short });
  });
});

describe("env: the cap overrides", () => {
  const load = async (vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) => {
    vi.resetModules();
    for (const k of ENV_KEYS) {
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const envMod = await import("../src/config/env");
    const unitMod = await import("../src/cost/unitBudget");
    return { env: envMod.env, guard: unitMod.defaultUnitBudgetGuard };
  };

  it("unset keeps the tier defaults; a set override reaches the default guard for every tier", async () => {
    /* MUTATION THAT KILLS THIS: leave env.secondBoxSecondsPerForay out of
       defaultUnitBudgetGuard's overrides. Ran it — red. */
    const unset = await load({});
    expect(unset.env.sparkSecondsPerForay).toBeUndefined();
    expect(unset.guard.caps("short")).toEqual(DEFAULT_UNIT_CAPS.short);
    const set = await load({ FORAY_SPARK_SECONDS_PER_FORAY: "90.5", FORAY_SECOND_BOX_SECONDS_PER_FORAY: "0", FORAY_JEV_CALLS_PER_FORAY: "40" });
    expect(set.env.sparkSecondsPerForay).toBe(90.5);
    for (const tier of ["short", "medium", "long"]) {
      expect(set.guard.caps(tier)).toEqual({ sparkSeconds: 90.5, secondBoxSeconds: 0, jevCalls: 40 });
    }
  });

  it("a malformed FORAY_SPARK_SECONDS_PER_FORAY fails startup naming only the variable; a fractional Jev-call cap fails too", async () => {
    /* MUTATION THAT KILLS THIS: read the override with a silent fallback
       (Number(x) || undefined). Ran it — red. */
    for (const bad of ["abc", "-1", "1e9", " "]) {
      await expect(load({ FORAY_SPARK_SECONDS_PER_FORAY: bad })).rejects.toThrow("Invalid value for environment variable FORAY_SPARK_SECONDS_PER_FORAY");
      if (bad.trim() !== "") await load({ FORAY_SPARK_SECONDS_PER_FORAY: bad }).catch((err: Error) => expect(err.message).not.toContain(bad));
    }
    await expect(load({ FORAY_JEV_CALLS_PER_FORAY: "2.5" })).rejects.toThrow("Invalid value for environment variable FORAY_JEV_CALLS_PER_FORAY");
    await expect(load({ FORAY_SECOND_BOX_SECONDS_PER_FORAY: "NaN" })).rejects.toThrow("FORAY_SECOND_BOX_SECONDS_PER_FORAY");
  });
});

describe("meteredJevClient: one jevCalls unit per Jev ask (GV-90)", () => {
  const fx = jevFixtures();
  const Q = fx.questions.slice(0, 1);
  const dollarGuard = (episodeUsd = 100) => new BudgetGuard(new InMemoryCostEventSink(), 100, episodeUsd);

  it("reserves one unit per ask under a session; past the cap it throws before sending or charging", async () => {
    /* MUTATION THAT KILLS THIS: reserve after the ask is sent (the third ask
       reaches Jev). Ran it — red. */
    const units = new UnitBudgetGuard({ overrides: { jevCalls: 2 } });
    const guard = dollarGuard();
    const spy = vi.spyOn(guard, "checkAndRecord");
    const inner = new FakeJevClient({ byId: { [Q[0]!.id]: noulAnswer(0.9) } });
    const c = meteredJevClient(inner, { guard, userId: "u1", sessionId: "foray-1", unitGuard: units, tier: "short" });
    await c.ask(fx.state, Q, { purpose: "clarity" });
    await c.ask(fx.state, Q, { purpose: "clarity" });
    await expect(c.ask(fx.state, Q, { purpose: "clarity" })).rejects.toBeInstanceOf(UnitBudgetExceededError);
    expect(inner.calls).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(units.spent("foray-1").jevCalls).toBe(2);
  });

  it("reserves nothing without a session or on a NullJevClient, and a dollar refusal gives its unit back", async () => {
    /* MUTATION THAT KILLS THIS: drop the reconcile(unit, 0) on a dollar
       refusal — the refused ask keeps its unit. Ran it — red. */
    const units = new UnitBudgetGuard({ overrides: { jevCalls: 5 } });
    const inner = new FakeJevClient({ byId: { [Q[0]!.id]: noulAnswer(0.9) } });
    await meteredJevClient(inner, { guard: dollarGuard(), userId: "u1", unitGuard: units }).ask(fx.state, Q, { purpose: "p" });
    await meteredJevClient(new NullJevClient(), { guard: dollarGuard(), userId: "u1", sessionId: "s", unitGuard: units }).ask(fx.state, Q, { purpose: "p" });
    expect(units.spent("s").jevCalls).toBe(0);

    const refusing = meteredJevClient(inner, { guard: dollarGuard(0), userId: "u1", sessionId: "s", unitGuard: units });
    await expect(refusing.ask(fx.state, Q, { purpose: "p" })).rejects.toBeInstanceOf(EpisodeBudgetExceededError);
    expect(units.spent("s").jevCalls).toBe(0);
  });
});
