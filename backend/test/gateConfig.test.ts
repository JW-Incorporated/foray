import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { GATE_TABLE, defineGateTable, readGateConfig, resolveGateConfig, type GateTableEntry } from "../src/generation/gateConfig";
import { FlagValueError, enumParser, numberParser } from "../src/generation/generationFlags";

/**
 * GV-15 (W5-02): the gate-config mechanism. No gate key exists yet, so the
 * reader is tested through test-only table entries. Each test names the
 * mutation it kills.
 */

const TEST_ENV = "FORAY_GV15_TEST_GATE";
const testEntry: GateTableEntry<"warn" | "block"> = { key: "testGate", env: TEST_ENV, parse: enumParser(["warn", "block"] as const), default: "warn" };
const testTable = defineGateTable([testEntry, { key: "testBand", env: "FORAY_GV15_TEST_BAND", parse: numberParser(z.number().int().min(1).max(9)), default: 6 }]);

afterEach(() => {
  delete process.env[TEST_ENV];
});

describe("readGateConfig", () => {
  /* Kills: a reader that adds anything of its own, or uses anything but each
     row's default when nothing is set. (Empty today: each gate card adds its
     row, and this stays true as they do.) */
  it("returns the default config with nothing set", () => {
    expect(readGateConfig({})).toEqual(Object.fromEntries(GATE_TABLE.map((e) => [e.key, e.default])));
  });

  /* Kills: a reader ignoring `default` or the variable. */
  it("uses each entry's default when unset and the parsed value when set", () => {
    expect(readGateConfig({}, testTable)).toEqual({ testGate: "warn", testBand: 6 });
    expect(readGateConfig({ [TEST_ENV]: "block", FORAY_GV15_TEST_BAND: "8" }, testTable)).toEqual({ testGate: "block", testBand: 8 });
  });

  /* Kills: a malformed value falling back to the default, or the error
     carrying the value. */
  it("a malformed value throws naming the variable and not the value", () => {
    let caught: unknown;
    try {
      readGateConfig({ [TEST_ENV]: "blokc-xyz" }, testTable);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlagValueError);
    expect((caught as Error).message).toContain(TEST_ENV);
    expect((caught as Error).message).not.toContain("blokc-xyz");
    expect(() => readGateConfig({ FORAY_GV15_TEST_BAND: "12" }, testTable)).toThrow(/FORAY_GV15_TEST_BAND/);
  });

  /* Kills: binding `source = process.env` at import. */
  it("reads process.env at call time by default", () => {
    expect(readGateConfig(undefined, testTable)).toMatchObject({ testGate: "warn" });
    process.env[TEST_ENV] = "block";
    expect(readGateConfig(undefined, testTable)).toMatchObject({ testGate: "block" });
  });
});

describe("defineGateTable", () => {
  /* Kills: the duplicate-env check (a later row silently shadowing one). */
  it("rejects a duplicate env name", () => {
    expect(() => defineGateTable([testEntry, { ...testEntry, key: "other" }])).toThrow(/duplicate env name FORAY_GV15_TEST_GATE/);
  });

  /* Kills: the duplicate-key check. */
  it("rejects a duplicate key", () => {
    expect(() => defineGateTable([testEntry, { ...testEntry, env: "FORAY_GV15_OTHER" }])).toThrow(/duplicate key testGate/);
  });
});

describe("resolveGateConfig", () => {
  /* Kills: overrides losing to env (`{ ...overrides, ...readGateConfig(source) }`),
     an undefined override erasing an env value (dropping the `!== undefined`
     guard), or resolveGateConfig ignoring its `table`. */
  it("merges overrides over the env, ignoring undefined ones", () => {
    expect(resolveGateConfig({}, {})).toEqual({});
    expect(resolveGateConfig({ extra: 1, gone: undefined } as never, {})).toStrictEqual({ extra: 1 });
    expect(resolveGateConfig({}, { [TEST_ENV]: "block" }, testTable)).toEqual({ testGate: "block", testBand: 6 });
    expect((resolveGateConfig({ testGate: "block" } as never, { [TEST_ENV]: "warn" }, testTable) as Record<string, unknown>).testGate).toBe("block");
    expect((resolveGateConfig({ testGate: undefined } as never, { [TEST_ENV]: "block" }, testTable) as Record<string, unknown>).testGate).toBe("block");
  });
});
