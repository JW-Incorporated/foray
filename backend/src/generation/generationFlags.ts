import type { z } from "zod";

/**
 * GV-15 (docs/roadmap/generation-v2.md, decision 5): the ONE flag-reader
 * module for generation v2. Pipeline flags (`pipelineFlags.ts`), the gate
 * table (`gateConfig.ts`) and every retrieval flag are built on these
 * readers; none of them goes into `config/env.ts`.
 *
 * TWO RULES, both from the existing env readers:
 *
 *   CALL TIME, NOT IMPORT TIME. Every reader takes the source it reads
 *   (`process.env` by default) when it is CALLED, so a test sets
 *   `process.env.X` per case after the module is imported and the next read
 *   sees it. Nothing here caches a value.
 *
 *   FAIL FAST, NAME ONLY THE VARIABLE. An unset variable gives the fallback.
 *   A variable that is PRESENT (an empty or whitespace-only string included)
 *   and malformed throws, naming the variable and never its value: the
 *   `readBoundedNumber` convention in `config/env.ts` and the shape of
 *   `narrationActConcurrency` (`writeNarration.ts`). A typo silently becoming
 *   the default is exactly the surprise an operator set the flag to avoid.
 */

export type FlagSource = Readonly<Record<string, string | undefined>>;

/** The error every reader throws. The message names the variable and what
 * shape was expected; the offending value is never part of it. */
export class FlagValueError extends Error {
  constructor(
    readonly variable: string,
    expected: string
  ) {
    super(`Invalid value for environment variable ${variable}: expected ${expected}`);
    this.name = "FlagValueError";
  }
}

/** A parser turns a present, trimmed, non-empty raw value into a typed one,
 * or returns `undefined` when the value is malformed. It never sees an unset
 * variable. `expected` is the wording the error uses. */
export interface FlagParser<T> {
  parse(raw: string): T | undefined;
  expected: string;
}

/** The generic reader the others are built on: fallback when unset, the
 * parsed value when well-formed, `FlagValueError` otherwise. */
export function readFlag<T>(name: string, parser: FlagParser<T>, fallback: T, source: FlagSource = process.env): T {
  const present = source[name];
  if (present === undefined) return fallback;
  const raw = present.trim();
  const value = raw.length === 0 ? undefined : parser.parse(raw);
  if (value === undefined) throw new FlagValueError(name, parser.expected);
  return value;
}

/** One of `values`, compared exactly (after trimming). */
export function enumParser<T extends string>(values: readonly T[]): FlagParser<T> {
  return {
    parse: (raw) => (values as readonly string[]).includes(raw) ? (raw as T) : undefined,
    expected: `one of ${values.join("|")}`
  };
}

/** A number that passes `schema` (an integer range, a bound, ...). */
export function numberParser(schema: z.ZodType<number>, expected = "a number in range"): FlagParser<number> {
  return {
    parse: (raw) => {
      const result = schema.safeParse(Number(raw));
      return result.success ? result.data : undefined;
    },
    expected
  };
}

/** `1`/`true`/`on` or `0`/`false`/`off`, case-insensitive. */
export const booleanParser: FlagParser<boolean> = {
  parse: (raw) => {
    const v = raw.toLowerCase();
    if (v === "1" || v === "true" || v === "on") return true;
    if (v === "0" || v === "false" || v === "off") return false;
    return undefined;
  },
  expected: "1|0|true|false|on|off"
};

export function readEnumFlag<T extends string>(name: string, values: readonly T[], fallback: T, source: FlagSource = process.env): T {
  return readFlag(name, enumParser(values), fallback, source);
}

export function readNumberFlag(name: string, schema: z.ZodType<number>, fallback: number, source: FlagSource = process.env): number {
  return readFlag(name, numberParser(schema), fallback, source);
}

export function readBooleanFlag(name: string, fallback: boolean, source: FlagSource = process.env): boolean {
  return readFlag(name, booleanParser, fallback, source);
}
