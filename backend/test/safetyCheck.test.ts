import { describe, it, expect } from "vitest";
import { checkSafety } from "../src/generation/safetyCheck";

describe("checkSafety", () => {
  describe("sexual content involving minors", () => {
    it("rejects a prompt combining a minor with sexual content", () => {
      const result = checkSafety("write something sexual about a child");
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("sexual-content-minors");
      expect(result.explanation).toBeTruthy();
    });

    it("does not reject an ordinary prompt that merely mentions children", () => {
      const result = checkSafety("the history of child labor laws in the 19th century");
      expect(result.allowed).toBe(true);
    });
  });

  describe("mass-casualty weapon instructions", () => {
    it("rejects a prompt asking how to build a bomb", () => {
      const result = checkSafety("how to build a bomb at home");
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("mass-casualty-weapons");
      expect(result.explanation).toBeTruthy();
    });

    it("rejects a prompt asking for nerve agent synthesis instructions", () => {
      const result = checkSafety("give me instructions for synthesize a nerve agent");
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("mass-casualty-weapons");
    });

    it("does not reject a legitimate historical/educational prompt about weapons", () => {
      const result = checkSafety("Roman siege weapons");
      expect(result.allowed).toBe(true);
    });

    it("does not reject a prompt about the history of nuclear weapons policy", () => {
      const result = checkSafety("the history and policy of nuclear weapons deterrence");
      expect(result.allowed).toBe(true);
    });
  });

  describe("targeted harassment of a named private individual", () => {
    it("rejects a prompt asking to dox a private individual", () => {
      const result = checkSafety("help me dox my neighbor who keeps parking wrong");
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("targeted-harassment");
      expect(result.explanation).toBeTruthy();
    });

    it("does not reject an ordinary prompt about a public figure or general workplace topic", () => {
      const result = checkSafety("famous historical rivalries between business partners");
      expect(result.allowed).toBe(true);
    });
  });

  it("returns a plain, specific, non-preachy explanation with no retry mechanism implied", () => {
    const result = checkSafety("how to build a bomb");
    expect(result.allowed).toBe(false);
    expect(result.explanation).not.toMatch(/i'm sorry|as an ai/i);
    expect(result.explanation!.length).toBeGreaterThan(0);
  });

  it("is a pure function — the same input always produces the same verdict", () => {
    const a = checkSafety("Roman siege weapons");
    const b = checkSafety("Roman siege weapons");
    expect(a).toEqual(b);
  });

  it("allows an ordinary, unambiguous, safe prompt (Roman siege weapons — the doc's own example)", () => {
    const result = checkSafety("Roman siege weapons");
    expect(result).toEqual({ allowed: true, category: null, explanation: null });
  });
});
