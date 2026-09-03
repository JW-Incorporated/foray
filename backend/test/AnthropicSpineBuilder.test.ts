import { describe, it, expect, vi } from "vitest";
import { AnthropicSpineBuilder } from "../src/generation/AnthropicSpineBuilder";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicSpineBuilder — see
 * AnthropicEnricher.test.ts for the shared rationale on injected fake
 * clients.
 */
describe("AnthropicSpineBuilder", () => {
  const ctx = { userId: "u1", sessionId: "s1" };
  const intent: IntentUnderstanding = {
    subject: "Charcoal briquettes",
    angle: "an industrial waste-disposal scheme, not a cookout footnote",
    priorKnowledge: "briquettes are used for grilling",
    disappointment: "no mention of the Ford Motor Company connection"
  };
  const researchShape: ResearchShape = {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: new Date().toISOString(),
    subtopics: [
      {
        label: "Ford waste-disposal origins",
        source: "literal-term",
        tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false
      }
    ],
    nonObviousAngle: null,
    externalGapsResearched: []
  };

  const validRawSpine = {
    voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
    acts: [
      {
        title: "Act 1",
        thesis: "thesis",
        startState: "start",
        endState: "end",
        slots: [{ title: "slot", beats: [{ claim: "A claim happened", exploration: false }] }]
      }
    ]
  };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    expect(() => new AnthropicSpineBuilder()).toThrow(/AnthropicSpineBuilder constructed without ANTHROPIC_API_KEY/);
  });

  it("does NOT throw the dry-run guard when a client is injected", () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    expect(() => new AnthropicSpineBuilder(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> buildSpine calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify(validRawSpine))] };
    });

    const builder = new AnthropicSpineBuilder(guard, client);
    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(spine.subject).toBe(intent.subject);
    expect(spine.angle).toBe(intent.angle);
    expect(spine.duration).toBe("short");
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "spine_build" }));
  });

  it("mutation: return a tool_use-only content array with no text block -> buildSpine should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow(
      "Anthropic spine response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> buildSpine wraps the parse failure", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("not json")]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow(
      /failed schema validation \(no retry available in this build\)/
    );
  });

  it("mutation: response wrapped in ```json fences -> buildSpine still parses", async () => {
    const { client } = makeFakeAnthropicClient([
      textBlock("```json\n" + JSON.stringify(validRawSpine) + "\n```")
    ]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);
    expect(spine.acts).toHaveLength(1);
    expect(spine.voice.style).toBe("s");
  });

  it("mutation: schema-invalid raw spine (acts missing) -> buildSpine throws", async () => {
    const { client } = makeFakeAnthropicClient([
      textBlock(JSON.stringify({ voice: validRawSpine.voice }))
    ]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow();
  });

  it("buildSpine sets generatedAt itself, independent of the LLM's raw output", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    const before = Date.now();
    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);
    const generatedAtMs = new Date(spine.generatedAt).getTime();
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
  });
});
