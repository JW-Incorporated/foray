import { describe, it, expect, vi } from "vitest";
import { AnthropicEnricher } from "../src/enrich/AnthropicEnricher";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { costFor } from "../src/config/models";
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

    // The fake client returns the same invalid content on every call, so the
    // one re-ask (see parseWithRetry.ts) also fails and the final error names
    // that.
    await expect(enricher.classifyTier1(classificationInput, ctx)).rejects.toThrow(/failed schema validation after one re-ask/);
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

/**
 * CH2-08 (B2-18, docs/roadmap/code-health-2.md): the re-ask is ONE private
 * helper shared by classifyTier1 and generateWhyLine. These pins were written
 * against the two hand-copied closures first (characterization) and must stay
 * green after the unification, for BOTH methods:
 *  (a) a first reply that fails zod triggers exactly one re-ask whose messages
 *      are [user prompt, assistant bad text, user re-ask line];
 *  (b) the re-ask's checkAndRecord carries the method's operation, the re-ask
 *      call keeps the method's max_tokens (512/128), and its estimate counts
 *      prompt + bad reply + re-ask line at ~4 chars/token plus the method's
 *      output-token estimate (300/60);
 *  (c) a re-ask whose reply has no text block throws, naming the method.
 * Mutations killed: (a) drop the assistant turn from the re-ask messages;
 * (b) leave the assistant turn out of the re-ask's roughTokenEstimate for one
 * method only (pin (b) for that method goes red), or swap a method's
 * 300/60 output estimate or 512/128 max_tokens; (c) return "" instead of
 * throwing when the re-ask reply has no text block.
 */
describe("AnthropicEnricher re-ask (CH2-08 characterization, both methods)", () => {
  const ctx = { userId: "u1", sessionId: "s1" };
  const REASK_LINE = "Your previous reply was not valid JSON; reply with the JSON object only.";
  const haiku = costFor("haiku");
  const validClassification = JSON.stringify({
    topics: ["engineering/energy-fusion"],
    format: "interview",
    depth: "medium",
    evergreen: true,
    gist: "gist",
    guests: [],
    sourceConfidence: 0.8
  });

  const cases = [
    {
      method: "classifyTier1" as const,
      label: "classification",
      operation: "tier1_classify",
      maxTokens: 512,
      outTokenEstimate: 300,
      valid: validClassification,
      run: (e: AnthropicEnricher) =>
        e.classifyTier1(
          { episodeId: "ep1", showTitle: "Show", title: "Title", descriptionText: "A description", durationSeconds: 1800 },
          ctx
        )
    },
    {
      method: "generateWhyLine" as const,
      label: "why-line",
      operation: "why_line",
      maxTokens: 128,
      outTokenEstimate: 60,
      valid: JSON.stringify({ whyLine: "why" }),
      run: (e: AnthropicEnricher) =>
        e.generateWhyLine(
          {
            episodeId: "ep1",
            showTitle: "Show",
            title: "Title",
            gist: "gist",
            archetype: "deep-learn" as const,
            userContext: ["likes fusion"]
          },
          ctx
        )
    }
  ];

  const BAD = "not json at all, sorry";

  for (const c of cases) {
    it(`${c.method}: (a) a zod-failing first reply triggers exactly one re-ask of [user prompt, assistant bad reply, user re-ask line]`, async () => {
      const { client, create } = makeFakeAnthropicClient([]);
      create.mockResolvedValueOnce({ content: [textBlock(BAD)] }).mockResolvedValueOnce({ content: [textBlock(c.valid)] });
      const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

      const result = await c.run(enricher);

      expect(result).toEqual(JSON.parse(c.valid));
      expect(create).toHaveBeenCalledTimes(2);
      const first = create.mock.calls[0]![0];
      const second = create.mock.calls[1]![0];
      expect(first.messages).toHaveLength(1);
      expect(first.messages[0].role).toBe("user");
      const prompt = first.messages[0].content as string;
      expect(second.messages).toEqual([
        { role: "user", content: prompt },
        { role: "assistant", content: BAD },
        { role: "user", content: REASK_LINE }
      ]);
      expect(second.model).toBe(first.model);
    });

    it(`${c.method}: (b) both calls are metered as ${c.operation} with max_tokens ${c.maxTokens} and a ${c.outTokenEstimate}-token output estimate; the re-ask counts prompt + bad reply + re-ask line`, async () => {
      const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
      const spy = vi.spyOn(guard, "checkAndRecord");
      const { client, create } = makeFakeAnthropicClient([]);
      create.mockResolvedValueOnce({ content: [textBlock(BAD)] }).mockResolvedValueOnce({ content: [textBlock(c.valid)] });
      const enricher = new AnthropicEnricher(guard, client);

      await c.run(enricher);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(create.mock.calls.map((call) => call[0].max_tokens)).toEqual([c.maxTokens, c.maxTokens]);
      const prompt = create.mock.calls[0]![0].messages[0].content as string;
      const estimate = (text: string) =>
        Math.ceil(text.length / 4) * haiku.usdPerInputToken + c.outTokenEstimate * haiku.usdPerOutputToken;
      const base = { userId: "u1", sessionId: "s1", operation: c.operation, provider: "anthropic", episodeId: "ep1", model: create.mock.calls[0]![0].model };
      expect(spy.mock.calls[0]![0]).toEqual({ ...base, estimatedUsd: estimate(prompt) });
      expect(spy.mock.calls[1]![0]).toEqual({ ...base, estimatedUsd: estimate(prompt + BAD + REASK_LINE) });
    });

    it(`${c.method}: (c) a re-ask reply with no text block throws, naming the ${c.label} re-ask`, async () => {
      const { client, create } = makeFakeAnthropicClient([]);
      create.mockResolvedValueOnce({ content: [textBlock(BAD)] }).mockResolvedValueOnce({ content: [toolUseBlock()] });
      const enricher = new AnthropicEnricher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

      const err = await c.run(enricher).then(
        () => {
          throw new Error(`expected ${c.method} to reject`);
        },
        (e: Error) => e
      );
      expect(
        err.message.startsWith(
          `Anthropic ${c.label} output failed schema validation (re-ask attempt itself failed: Anthropic ${c.label} re-ask response had no text block)`
        )
      ).toBe(true);
      expect((err.cause as Error).message).toBe(`Anthropic ${c.label} re-ask response had no text block`);
      expect(create).toHaveBeenCalledTimes(2);
    });
  }
});
