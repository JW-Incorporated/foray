import { describe, it, expect } from "vitest";
import { GenerationRequestSchema } from "../src/types/generation";

describe("GenerationRequestSchema — §3's input shape", () => {
  it("accepts a well-formed request", () => {
    const result = GenerationRequestSchema.safeParse({
      prompt: "the history of grilling",
      duration: "medium",
      author_id: "founder-wyatt",
      visibility: "catalogue"
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty prompt", () => {
    const result = GenerationRequestSchema.safeParse({
      prompt: "   ",
      duration: "medium",
      author_id: "founder-wyatt",
      visibility: "catalogue"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duration outside short/medium/long", () => {
    const result = GenerationRequestSchema.safeParse({
      prompt: "the history of grilling",
      duration: "extra-long",
      author_id: "founder-wyatt",
      visibility: "catalogue"
    });
    expect(result.success).toBe(false);
  });

  it("requires author_id — phase 1 always sets it to a founder, but the field must be real, not hardcoded away", () => {
    const result = GenerationRequestSchema.safeParse({
      prompt: "the history of grilling",
      duration: "medium",
      visibility: "catalogue"
    });
    expect(result.success).toBe(false);
  });

  it("accepts all three duration tiers", () => {
    for (const duration of ["short", "medium", "long"] as const) {
      const result = GenerationRequestSchema.safeParse({
        prompt: "x",
        duration,
        author_id: "founder-wyatt",
        visibility: "catalogue"
      });
      expect(result.success).toBe(true);
    }
  });
});
