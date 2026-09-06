import { describe, it, expect, vi } from "vitest";
import { AnthropicEnricher } from "../src/enrich/AnthropicEnricher";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicEnricher — filed
 * as t_550d289f (Fable-driven test-quality audit t_5663c62a). Every test
 * here names its one-line mutation, per that card's own caution: a fake
 * Anthropic client is only acceptable because these branches consume
 * *data shapes* (response content arrays, malformed JSON strings), never
 * live client behavior — see test/helpers/fakeAnthropicClient.ts's doc
 * comment for the full rationale.
 */
describe("AnthropicEnricher", () => {
  const ctx = { userId: "u1", sessionId: "s1" };
  const classificationInput = {
    episodeId: "ep1",
    showTitle: "Show",
    title: "Title",
    descriptionText: "A description",
    durationSeconds: 1800
  };
  const whyLineInput = {
    episodeId: "ep1",
    showTitle: "Show",
    title: "Title",
    gist: "gist",
    archetype: "deep-learn" as const,
    userContext: ["likes fusion"]
  };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    // env.anthropicDryRun is true in this test env (no ANTHROPIC_API_KEY) —
    // constructing without an injected client must throw before `new
    // Anthropic(...)` is ever reached.
    expect(() => new AnthropicEnricher()).toThrow(/AnthropicEnricher constructed without ANTHROPIC_API_KEY/);
  });

  it("does NOT throw the dry-run guard when a client is injected (test-only escape hatch)", () => {
    const { client } = makeFakeAnthropicClient([textBlock('{"whyLine":"x"}')]);
    expect(() => new AnthropicEnricher(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> classifyTier1 calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 100);
    const originalCheckAndRecord = guard.checkAndRecord.bind(guard);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return originalCheckAndRecord(input);
    });

    const { client, create } = makeFakeAnthropicClient([
      textBlock(
        JSON.stringify({
          topics: ["engineering/energy-fusion"],
          format: "interview",
          depth: "medium",
          evergreen: true,
          gist: "gist",
          guests: [],
          sourceConfidence: 0.8
        })
      )
    ]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify({ topics: ["a"], format: "interview", depth: "low", evergreen: false, gist: "g", guests: [], sourceConfidence: 0.5 }))] };
    });

    const enricher = new AnthropicEnricher(guard, client);
    await enricher.classifyTier1(classificationInput, ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(guard.checkAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "tier1_classify", provider: "anthropic", episodeId: "ep1" })
    );
  });

  it("mutation: return a tool_use-only content array with no text block -> classifyTier1 should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(enricher.classifyTier1(classificationInput, ctx)).rejects.toThrow(
      "Anthropic classification response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> classifyTier1 wraps the parse failure with cause", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("not json at all")]);
    const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(enricher.classifyTier1(classificationInput, ctx)).rejects.toThrow(
      /failed schema validation \(no retry available in this build\)/
    );
    try {
      await enricher.classifyTier1(classificationInput, ctx);
      throw new Error("expected classifyTier1 to reject");
    } catch (err) {
      expect((err as Error).cause).toBeDefined();
    }
  });

  it("mutation: response text wrapped in ```json fences -> classifyTier1 still parses (fence-stripping)", async () => {
    const payload = {
      topics: ["engineering/energy-fusion"],
      format: "interview",
      depth: "medium",
      evergreen: true,
      gist: "gist",
      guests: [],
      sourceConfidence: 0.8
    };
    const { client } = makeFakeAnthropicClient([textBlock("```json\n" + JSON.stringify(payload) + "\n```")]);
    const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const result = await enricher.classifyTier1(classificationInput, ctx);
    expect(result.topics).toEqual(["engineering/energy-fusion"]);
  });

  it("mutation: schema-invalid JSON (wrong types) -> classifyTier1 throws even though JSON.parse succeeds", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify({ topics: "not-an-array" }))]);
    const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(enricher.classifyTier1(classificationInput, ctx)).rejects.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> generateWhyLine calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([textBlock(JSON.stringify({ whyLine: "why" }))]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify({ whyLine: "why" }))] };
    });

    const enricher = new AnthropicEnricher(guard, client);
    const result = await enricher.generateWhyLine(whyLineInput, ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(result.whyLine).toBe("why");
  });

  it("mutation: return a tool_use-only content array with no text block -> generateWhyLine should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(enricher.generateWhyLine(whyLineInput, ctx)).rejects.toThrow(
      "Anthropic why-line response had no text block"
    );
  });

  it("documents the response.usage metering gap: messages.create's raw response.usage is never read by the caller", async () => {
    // Bonus finding from t_5663c62a: AnthropicEnricher.ts's own comment claims
    // "actual metering happens after the call using response.usage" but no
    // production code reads response.usage anywhere. This test pins that gap
    // structurally: it asserts the mocked response's `usage` field, if
    // present, has no effect on the recorded cost event (only the pre-call
    // estimate is ever recorded) — so a future PR that starts reading
    // response.usage for real should have to touch this assertion.
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    const recordSpy = vi.spyOn(guard, "checkAndRecord");
    const { client, create } = makeFakeAnthropicClient([textBlock(JSON.stringify({ whyLine: "why" }))]);
    create.mockResolvedValue({
      content: [textBlock(JSON.stringify({ whyLine: "why" }))],
      usage: { input_tokens: 999, output_tokens: 999 }
    });

    const enricher = new AnthropicEnricher(guard, client);
    await enricher.generateWhyLine(whyLineInput, ctx);

    const recordedCall = recordSpy.mock.calls[0]![0];
    // Only the pre-call estimate is recorded; response.usage (999/999) never
    // reaches the recorded event's estimatedUsd.
    expect(recordedCall.estimatedUsd).toBeLessThan(0.01);
  });
});
