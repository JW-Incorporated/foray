import { describe, it, expect } from "vitest";
import { createPromptUnderstander } from "../src/generation/createPromptUnderstander";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";

describe("createPromptUnderstander", () => {
  it("returns a StubPromptUnderstander when ANTHROPIC_API_KEY is absent (dry-run, matches createEnricher's behaviour)", () => {
    // The test environment has no ANTHROPIC_API_KEY configured (backend's
    // own convention — see stubEnricher.test.ts / createEnricher.ts), so
    // env.anthropicDryRun is true here exactly as it is for every other
    // suite in this package.
    const understander = createPromptUnderstander();
    expect(understander).toBeInstanceOf(StubPromptUnderstander);
    expect(understander.providerName).toBe("stub");
  });
});
