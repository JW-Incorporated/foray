import { describe, it, expect, vi } from "vitest";
import { AnthropicDeepenActBuilder } from "../src/generation/AnthropicDeepenActBuilder";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";
import type { Spine } from "../src/types/spine";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicDeepenActBuilder —
 * see AnthropicEnricher.test.ts for the shared rationale on injected fake
 * clients.
 */
describe("AnthropicDeepenActBuilder", () => {
  const ctx = { userId: "u1", sessionId: "s1" };

  const spine: Spine = {
    subject: "Charcoal briquettes",
    angle: "an industrial waste-disposal scheme",
    duration: "short",
    generatedAt: new Date().toISOString(),
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

  const validDeepenedAct = {
    title: "Act 1",
    thesis: "thesis",
    startState: "start",
    endState: "end",
    slots: [{ title: "slot", beats: [{ claim: "A refined claim happened", exploration: false }] }],
    introduction: "The act opens on...",
    exit: "The act hands off to..."
  };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    expect(() => new AnthropicDeepenActBuilder()).toThrow(
      /AnthropicDeepenActBuilder constructed without ANTHROPIC_API_KEY/
    );
  });

  it("does NOT throw the dry-run guard when a client is injected", () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(validDeepenedAct))]);
    expect(() => new AnthropicDeepenActBuilder(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> deepenAct calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify(validDeepenedAct))] };
    });

    const builder = new AnthropicDeepenActBuilder(guard, client);
    const deepened = await builder.deepenAct(spine, spine.acts[0]!, 0, ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(deepened.introduction).toBe("The act opens on...");
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "deepen_act" }));
  });

  it("mutation: return a tool_use-only content array with no text block -> deepenAct should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const builder = new AnthropicDeepenActBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.deepenAct(spine, spine.acts[0]!, 0, ctx)).rejects.toThrow(
      "Anthropic deepen-act response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> deepenAct wraps the parse failure", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("not json")]);
    const builder = new AnthropicDeepenActBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.deepenAct(spine, spine.acts[0]!, 0, ctx)).rejects.toThrow(
      /failed schema validation \(no retry available in this build\)/
    );
  });

  it("mutation: response wrapped in ```json fences -> deepenAct still parses", async () => {
    const { client } = makeFakeAnthropicClient([
      textBlock("```json\n" + JSON.stringify(validDeepenedAct) + "\n```")
    ]);
    const builder = new AnthropicDeepenActBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const deepened = await builder.deepenAct(spine, spine.acts[0]!, 0, ctx);
    expect(deepened.exit).toBe("The act hands off to...");
  });

  it("mutation: schema-invalid deepened act (missing introduction) -> deepenAct throws", async () => {
    const { title, thesis, startState, endState, slots, exit } = validDeepenedAct;
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify({ title, thesis, startState, endState, slots, exit }))]);
    const builder = new AnthropicDeepenActBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.deepenAct(spine, spine.acts[0]!, 0, ctx)).rejects.toThrow();
  });
});
