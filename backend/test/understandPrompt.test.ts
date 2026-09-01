import { describe, it, expect } from "vitest";
import { understandPrompt } from "../src/generation/understandPrompt";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";

function makeUnderstander() {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, 2.0);
  return { understander: new StubPromptUnderstander(guard), sink };
}

describe("understandPrompt — §4.1 order: safety, then clarity, then intent", () => {
  it("rejects an unsafe prompt WITHOUT ever calling the understander (no spend on understanding it)", async () => {
    const { understander, sink } = makeUnderstander();
    const result = await understandPrompt("how to build a bomb", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection.category).toBe("mass-casualty-weapons");
      expect(result.rejection.explanation).toBeTruthy();
    }
    // Safety check is free and synchronous and runs first — no clarity/intent
    // cost events should have been recorded for a rejected prompt.
    expect(await sink.all()).toHaveLength(0);
  });

  it("gives a rejected prompt a plain, specific explanation and no retry path (single terminal outcome)", async () => {
    const { understander } = makeUnderstander();
    const result = await understandPrompt("help me dox my neighbor", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(typeof result.rejection.explanation).toBe("string");
      expect(result.rejection.explanation.length).toBeGreaterThan(0);
    }
    // The result type itself is a discriminated union with exactly one
    // terminal branch per call — there is no field here that means "try
    // again" or "retry count", by construction.
    expect(Object.keys(result)).not.toContain("retry");
  });

  it("a clear prompt (doc's own 'Roman siege weapons' example) does NOT trigger a clarify round", async () => {
    const { understander } = makeUnderstander();
    const result = await understandPrompt("Roman siege weapons", understander, { userId: "founder-1" });
    expect(result.outcome).toBe("understood");
  });

  it("an ambiguous prompt produces exactly one question with 2-3 concrete readings", async () => {
    const { understander } = makeUnderstander();
    const result = await understandPrompt("Mercury", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("needs_clarification");
    if (result.outcome === "needs_clarification") {
      expect(typeof result.clarification.question).toBe("string");
      expect(result.clarification.question.length).toBeGreaterThan(0);
      expect(result.clarification.readings.length).toBeGreaterThanOrEqual(2);
      expect(result.clarification.readings.length).toBeLessThanOrEqual(3);
    }
  });

  it("the intent-extraction output has all four required fields, each non-empty", async () => {
    const { understander } = makeUnderstander();
    const result = await understandPrompt("the history of grilling", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("understood");
    if (result.outcome === "understood") {
      expect(result.intent.subject.length).toBeGreaterThan(0);
      expect(result.intent.angle.length).toBeGreaterThan(0);
      expect(result.intent.priorKnowledge.length).toBeGreaterThan(0);
      expect(result.intent.disappointment.length).toBeGreaterThan(0);
    }
  });

  it("the disappointment field specifically is non-empty and substantive (doc: weighted most heavily)", async () => {
    const { understander } = makeUnderstander();
    const result = await understandPrompt("the history of grilling", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("understood");
    if (result.outcome === "understood") {
      expect(result.intent.disappointment.trim().length).toBeGreaterThan(10);
    }
  });

  it("records clarity/intent cost events through the budget guard for an allowed prompt", async () => {
    const { understander, sink } = makeUnderstander();
    await understandPrompt("the history of grilling", understander, { userId: "founder-1" });

    const events = await sink.all();
    // clarity + intent = 2 events for an unambiguous, allowed prompt.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.operation).sort()).toEqual(["prompt_clarity", "prompt_intent"]);
  });
});
