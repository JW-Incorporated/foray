import { describe, it, expect, vi } from "vitest";
import { AnthropicExternalResearcher } from "../src/generation/AnthropicExternalResearcher";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicExternalResearcher
 * — see AnthropicEnricher.test.ts for the shared rationale on injected fake
 * clients. This provider is unique among the five in using the server-side
 * web_search tool and in taking the LAST fenced/bare JSON block rather than
 * the whole text (since the model may narrate its search process before the
 * final JSON answer) — both are exercised explicitly below.
 */
describe("AnthropicExternalResearcher", () => {
  const ctx = { userId: "u1", sessionId: "s1" };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    expect(() => new AnthropicExternalResearcher()).toThrow(
      /AnthropicExternalResearcher constructed without ANTHROPIC_API_KEY/
    );
  });

  it("does NOT throw the dry-run guard when a client is injected", () => {
    const { client } = makeFakeAnthropicClient([textBlock('{"notes":"n","controversies":[]}')]);
    expect(() => new AnthropicExternalResearcher(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> research calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify({ notes: "n", controversies: [] }))] };
    });

    const researcher = new AnthropicExternalResearcher(guard, client);
    const result = await researcher.research("some topic", ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(result.notes).toBe("n");
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "external_research" }));
  });

  it("research passes the web_search tool with max_uses to messages.create", async () => {
    const { client, create } = makeFakeAnthropicClient([textBlock('{"notes":"n","controversies":[]}')]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await researcher.research("some topic", ctx);

    const callArgs = create.mock.calls[0]![0];
    expect(callArgs.tools).toEqual([
      expect.objectContaining({ type: "web_search_20250305", name: "web_search", max_uses: 3 })
    ]);
  });

  it("mutation: return a tool_use-only content array with no text block -> research should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(researcher.research("topic", ctx)).rejects.toThrow(
      "Anthropic external-research response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> research wraps the parse failure", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("not json at all")]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(researcher.research("topic", ctx)).rejects.toThrow(
      /failed schema validation \(no retry available in this build\)/
    );
  });

  it("research takes the LAST fenced JSON block when the model narrates its search before answering", async () => {
    const prose = [
      "Let me search for this.",
      "```json",
      JSON.stringify({ notes: "an intermediate guess", controversies: ["wrong one"] }),
      "```",
      "Actually, after further research, here is my final answer:",
      "```json",
      JSON.stringify({ notes: "the real answer", controversies: ["actual controversy"] }),
      "```"
    ].join("\n");
    const { client } = makeFakeAnthropicClient([textBlock(prose)]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const result = await researcher.research("topic", ctx);
    expect(result.notes).toBe("the real answer");
    expect(result.controversies).toEqual(["actual controversy"]);
  });

  it("research falls back to the bare text when no fenced block is present", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify({ notes: "bare", controversies: [] }))]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const result = await researcher.research("topic", ctx);
    expect(result.notes).toBe("bare");
  });

  it("mutation: schema-invalid JSON (controversies not an array) -> research throws", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify({ notes: "n", controversies: "not-array" }))]);
    const researcher = new AnthropicExternalResearcher(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(researcher.research("topic", ctx)).rejects.toThrow();
  });
});
