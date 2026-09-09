import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseWithRetry, parseLastJsonBlock } from "../src/generation/parseWithRetry";

/**
 * Direct unit coverage for the shared parseWithRetry/parseLastJsonBlock
 * helper extracted from the five private per-file copies (see this file's
 * own doc comment and t_550d289f). Testing this once here is the whole
 * point of the extraction — previously each of the five private copies was
 * untested and free to drift independently.
 */
describe("parseWithRetry", () => {
  const schema = z.object({ a: z.string() });

  it("parses plain JSON", () => {
    expect(parseWithRetry(schema, JSON.stringify({ a: "x" }))).toEqual({ a: "x" });
  });

  it("strips ```json fences before parsing", () => {
    expect(parseWithRetry(schema, "```json\n" + JSON.stringify({ a: "x" }) + "\n```")).toEqual({ a: "x" });
  });

  it("strips bare ``` fences (no json language tag)", () => {
    expect(parseWithRetry(schema, "```\n" + JSON.stringify({ a: "x" }) + "\n```")).toEqual({ a: "x" });
  });

  it("throws a wrapped error with cause on invalid JSON", () => {
    expect(() => parseWithRetry(schema, "not json")).toThrow(/failed schema validation \(no retry available in this build\)/);
    try {
      parseWithRetry(schema, "not json");
      throw new Error("expected parseWithRetry to throw");
    } catch (err) {
      expect((err as Error).cause).toBeDefined();
    }
  });

  it("throws on schema-valid JSON with the wrong shape", () => {
    expect(() => parseWithRetry(schema, JSON.stringify({ a: 123 }))).toThrow();
  });

  it("uses the custom errorPrefix in the thrown message", () => {
    expect(() => parseWithRetry(schema, "bad", "Custom prefix")).toThrow(/^Custom prefix failed schema validation/);
  });
});

describe("parseLastJsonBlock", () => {
  const schema = z.object({ notes: z.string() });

  it("takes the LAST fenced block when multiple are present", () => {
    const raw = [
      "```json",
      JSON.stringify({ notes: "first" }),
      "```",
      "some prose in between",
      "```json",
      JSON.stringify({ notes: "second" }),
      "```"
    ].join("\n");
    expect(parseLastJsonBlock(schema, raw)).toEqual({ notes: "second" });
  });

  it("falls back to the bare text when no fenced block exists", () => {
    expect(parseLastJsonBlock(schema, JSON.stringify({ notes: "bare" }))).toEqual({ notes: "bare" });
  });

  it("throws when the last fenced block is invalid JSON", () => {
    const raw = "```json\nnot json\n```";
    expect(() => parseLastJsonBlock(schema, raw)).toThrow();
  });
});

describe("parseWithRetry — F-39: a reply truncated before its closing brackets is repaired, not failed", () => {
  it("closes a missing final brace (generation run 1, verifier call #34)", async () => {
    const { z } = await import("zod");
    const { parseWithRetry, parseOrRepairJson } = await import("../src/generation/parseWithRetry");
    const schema = z.object({ verified: z.boolean(), verifierNotes: z.string() });
    const truncated = '{"verified": false, "verifierNotes": "No sources are declared for this page (\'(none declared)\')."';
    expect(parseWithRetry(schema, truncated)).toEqual({ verified: false, verifierNotes: "No sources are declared for this page ('(none declared)')." });
    expect(parseOrRepairJson('{"a": [1, 2')).toBe('{"a": [1, 2]}');
    expect(parseOrRepairJson('{"a": "unterminated')).toBe('{"a": "unterminated"}');
  });
  it("leaves genuinely broken JSON to fail with the original error", async () => {
    const { z } = await import("zod");
    const { parseWithRetry } = await import("../src/generation/parseWithRetry");
    expect(() => parseWithRetry(z.object({ a: z.number() }), "not json at all")).toThrow(/failed schema validation/);
  });
});
