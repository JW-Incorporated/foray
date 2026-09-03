import { describe, it, expect, vi } from "vitest";
import { AnthropicPromptUnderstander } from "../src/generation/AnthropicPromptUnderstander";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicPromptUnderstander —
 * see AnthropicEnricher.test.ts for the shared rationale on why an injected
 * fake client is acceptable here (data-shape only, never live behavior).
 */
describe("AnthropicPromptUnderstander", () => {
  const ctx = { userId: "u1", sessionId: "s1" };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    expect(() => new AnthropicPromptUnderstander()).toThrow(
      /AnthropicPromptUnderstander constructed without ANTHROPIC_API_KEY/
    );
  });

  it("does NOT throw the dry-run guard when a client is injected", () => {
    const { client } = makeFakeAnthropicClient([textBlock('{"ambiguous":false,"readings":[],"question":null}')]);
    expect(() => new AnthropicPromptUnderstander(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> assessClarity calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock('{"ambiguous":false,"readings":[],"question":null}')] };
    });

    const understander = new AnthropicPromptUnderstander(guard, client);
    const result = await understander.assessClarity("Roman siege weapons", ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(result.ambiguous).toBe(false);
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "prompt_clarity" }));
  });

  it("mutation: return a tool_use-only content array with no text block -> assessClarity should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(understander.assessClarity("Mercury", ctx)).rejects.toThrow(
      "Anthropic clarity response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> assessClarity wraps the parse failure", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("definitely not json")]);
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(understander.assessClarity("Mercury", ctx)).rejects.toThrow(
      /failed schema validation \(no retry available in this build\)/
    );
  });

  it("mutation: response wrapped in ```json fences -> assessClarity still parses", async () => {
    const payload = { ambiguous: true, readings: ["planet", "element"], question: "Which Mercury?" };
    const { client } = makeFakeAnthropicClient([textBlock("```json\n" + JSON.stringify(payload) + "\n```")]);
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const result = await understander.assessClarity("Mercury", ctx);
    expect(result.ambiguous).toBe(true);
    expect(result.readings).toEqual(["planet", "element"]);
  });

  it("mutation: delete the checkAndRecord call -> extractIntent calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const payload = {
      subject: "Roman siege weapons",
      angle: "logistics, not just engineering",
      priorKnowledge: "trebuchets exist",
      disappointment: "no discussion of siege logistics"
    };
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify(payload))] };
    });

    const understander = new AnthropicPromptUnderstander(guard, client);
    const result = await understander.extractIntent("Roman siege weapons", ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(result.subject).toBe("Roman siege weapons");
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "prompt_intent" }));
  });

  it("mutation: return a tool_use-only content array with no text block -> extractIntent should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(understander.extractIntent("Roman siege weapons", ctx)).rejects.toThrow(
      "Anthropic intent response had no text block"
    );
  });

  it("mutation: schema-invalid JSON (missing required field) -> extractIntent throws", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify({ subject: "x" }))]);
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(understander.extractIntent("x", ctx)).rejects.toThrow();
  });
});
