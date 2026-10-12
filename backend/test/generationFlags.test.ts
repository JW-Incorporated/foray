import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import {
  FlagValueError,
  booleanParser,
  enumParser,
  readBooleanFlag,
  readEnumFlag,
  readFlag,
  readNumberFlag
} from "../src/generation/generationFlags";

/**
 * GV-15 (decision 5): the one call-time flag-reader module. Each test names
 * the mutation it kills.
 */

const VAR = "FORAY_GV15_TEST_FLAG";

afterEach(() => {
  delete process.env[VAR];
});

describe("generationFlags readers", () => {
  /* Kills: returning the parsed default for an unset variable from anything
     other than `fallback` (e.g. throwing on undefined). */
  it("an unset variable gives the fallback", () => {
    expect(readEnumFlag(VAR, ["a", "b"], "b", {})).toBe("b");
    expect(readNumberFlag(VAR, z.number().int(), 7, {})).toBe(7);
    expect(readBooleanFlag(VAR, true, {})).toBe(true);
  });

  /* Kills: reading process.env at import time (a module-level snapshot), or
     a default `source` bound once. The variable is set AFTER the import. */
  it("reads process.env at call time, not at import", () => {
    expect(readEnumFlag(VAR, ["off", "on"], "off")).toBe("off");
    process.env[VAR] = "on";
    expect(readEnumFlag(VAR, ["off", "on"], "off")).toBe("on");
    process.env[VAR] = "3";
    expect(readNumberFlag(VAR, z.number().int(), 1)).toBe(3);
    process.env[VAR] = "1";
    expect(readBooleanFlag(VAR, false)).toBe(true);
    delete process.env[VAR];
    expect(readBooleanFlag(VAR, false)).toBe(false);
    process.env[VAR] = "x";
    expect(readFlag(VAR, enumParser(["x"]), "y")).toBe("x");
  });

  /* Kills: an enum reader that falls back on an unknown value instead of
     throwing, and an error message that interpolates the value. */
  it("a malformed enum throws naming the variable and not the value", () => {
    let caught: unknown;
    try {
      readEnumFlag(VAR, ["off", "short", "all"], "off", { [VAR]: "s3cret-typo" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlagValueError);
    const message = (caught as Error).message;
    expect(message).toContain(VAR);
    expect(message).not.toContain("s3cret-typo");
    expect((caught as FlagValueError).variable).toBe(VAR);
  });

  /* Kills: treating a present-but-empty (or whitespace-only) value as unset,
     which would turn a blanked variable into the default silently. */
  it("an empty or whitespace-only value is present and malformed", () => {
    expect(() => readBooleanFlag(VAR, false, { [VAR]: "" })).toThrow(FlagValueError);
    expect(() => readNumberFlag(VAR, z.number(), 1, { [VAR]: "   " })).toThrow(FlagValueError);
  });

  /* Kills: skipping the schema (any finite number accepted) or `Number("")`
     style coercions slipping through. */
  it("a number outside the schema throws; one inside it is returned", () => {
    const schema = z.number().int().min(1).max(2);
    expect(readNumberFlag(VAR, schema, 1, { [VAR]: "2" })).toBe(2);
    for (const bad of ["3", "0", "1.5", "two", "NaN"]) {
      expect(() => readNumberFlag(VAR, schema, 1, { [VAR]: bad })).toThrow(new RegExp(VAR));
    }
  });

  /* Kills: a boolean parser that treats any non-"1" as false (a typo would
     turn a flag off silently) or that is case-sensitive. */
  it("booleans accept 1/0/true/false/on/off in any case and nothing else", () => {
    for (const on of ["1", "true", "TRUE", "on", "On"]) expect(booleanParser.parse(on)).toBe(true);
    for (const off of ["0", "false", "False", "off", "OFF"]) expect(booleanParser.parse(off)).toBe(false);
    for (const bad of ["yes", "2", "enable"]) expect(() => readBooleanFlag(VAR, false, { [VAR]: bad })).toThrow(FlagValueError);
  });

  /* Kills: dropping the trim (a value pasted with a trailing newline would
     then be refused). */
  it("trims the value before parsing it", () => {
    expect(readEnumFlag(VAR, ["parallel", "sequential"], "parallel", { [VAR]: " sequential\n" })).toBe("sequential");
  });

  /* Kills: the generic reader passing the untrimmed value to the parser, or
     calling the parser for an unset variable. */
  it("readFlag hands the parser only a present, trimmed value", () => {
    const seen: string[] = [];
    const parser = { parse: (raw: string) => (seen.push(raw), raw.length), expected: "anything" };
    expect(readFlag(VAR, parser, -1, {})).toBe(-1);
    expect(readFlag(VAR, parser, -1, { [VAR]: "  abc " })).toBe(3);
    expect(seen).toEqual(["abc"]);
    expect(enumParser(["x"]).expected).toBe("one of x");
  });
});
