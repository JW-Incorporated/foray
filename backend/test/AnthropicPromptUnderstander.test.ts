import { describe, it, expect, vi } from "vitest";
import { AnthropicPromptUnderstander, buildIntentPrompt } from "../src/generation/AnthropicPromptUnderstander";
import { INTERNAL_VOCABULARY, titleStyleProblems } from "../src/copy/rules";
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

    // The fake client returns the same invalid content on every call, so the
    // one re-ask (see parseWithRetry.ts) also fails and the final error names
    // that.
    await expect(understander.assessClarity("Mercury", ctx)).rejects.toThrow(/failed schema validation after one re-ask/);
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

  it("tells the model the title and summary may not use the pipeline's own words, with examples the gate refuses", () => {
    /* PR #741 review: check-forays refuses rules.js INTERNAL_VOCABULARY in a
       Foray's title and summary, and nothing told the understander, which
       writes both. Every example the prompt quotes must be one the list
       catches, so the instruction and the gate cannot drift apart.
       MUTATION THAT KILLS THIS: delete the "Neither the title nor the summary"
       lines from buildIntentPrompt -> red. */
    const prompt = buildIntentPrompt("the history of barbecue");
    const rule = prompt.slice(prompt.indexOf("Neither the title nor the summary"), prompt.indexOf("A machine checks that after you answer"));
    expect(rule.length).toBeGreaterThan(0);
    const examples = [...rule.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const text of examples) expect(INTERNAL_VOCABULARY.some((rx) => rx.test(text)), `"${text}" must be caught`).toBe(true);
  });

  /* THE TITLE HOUSE STYLE (Wyatt, 2026-09-24, qa 146): "Sentence case, no
     period, though ? And ! Are allowed". The understander writes the title,
     so it is the one asked. */
  const intentJson = (title: string): string =>
    JSON.stringify({ subject: "AI systems", angle: "the engineering", priorKnowledge: "p", disappointment: "d", title, summary: "Why most of a model is plumbing." });

  it("asks for a sentence-case title by name, with examples the house-style check agrees with", () => {
    /* MUTATION THAT KILLS THIS: put back "no trailing punctuation" (which
       forbade the ? and ! the ruling allows) or drop the sentence-case lines ->
       red. */
    const prompt = buildIntentPrompt("how AI gets built");
    expect(prompt).toContain("SENTENCE CASE");
    expect(prompt).toContain("a closing ? or ! is fine");
    expect(prompt).not.toContain("no trailing punctuation");
    expect(titleStyleProblems("How AI actually gets built")).toEqual([]);
    expect(titleStyleProblems("How AI Actually Gets Built")).not.toEqual([]);
  });

  it("re-asks ONCE for a title still in Title Case, and keeps the answer only if it changed nothing but the case", async () => {
    /* MUTATION THAT KILLS THIS: return the parsed intent without
       `sentenceCaseTitle` -> the first title stays Title Case and there is one
       call, not two; drop the same-letters guard -> the reworded reply is
       taken. */
    const { client, create } = makeFakeAnthropicClient([]);
    create
      .mockResolvedValueOnce({ content: [textBlock(intentJson("How AI Actually Gets Built"))] })
      .mockResolvedValueOnce({ content: [textBlock('{"title": "How AI actually gets built"}')] });
    const understander = new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    const intent = await understander.extractIntent("how AI gets built", ctx);
    expect(intent.title).toBe("How AI actually gets built");
    expect(create).toHaveBeenCalledTimes(2);

    const reworded = makeFakeAnthropicClient([]);
    reworded.create
      .mockResolvedValueOnce({ content: [textBlock(intentJson("How AI Actually Gets Built"))] })
      .mockResolvedValueOnce({ content: [textBlock('{"title": "Inside the AI factory"}')] });
    const kept = await new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), reworded.client).extractIntent("how AI gets built", ctx);
    expect(kept.title).toBe("How AI Actually Gets Built");
  });

  it("a failed title re-ask (budget, 429/529, network) keeps the parsed intent instead of failing intent extraction (review of PR #785)", async () => {
    /* MUTATION THAT KILLS THIS: take the budget check and the API call back
       out of the try/catch in sentenceCaseTitle -> extractIntent rejects. */
    const { client, create } = makeFakeAnthropicClient([]);
    create
      .mockResolvedValueOnce({ content: [textBlock(intentJson("How AI Actually Gets Built"))] })
      .mockRejectedValueOnce(new Error("529 overloaded_error"));
    const intent = await new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client).extractIntent("how AI gets built", ctx);
    expect(intent.title).toBe("How AI Actually Gets Built");
    expect(intent.subject).toBe("AI systems");

    const refusing = makeFakeAnthropicClient([textBlock(intentJson("How AI Actually Gets Built"))]);
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    const real = guard.checkAndRecord.bind(guard);
    let calls = 0;
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (event) => {
      calls += 1;
      if (calls > 1) throw new Error("budget exceeded");
      return real(event);
    });
    const kept = await new AnthropicPromptUnderstander(guard, refusing.client).extractIntent("how AI gets built", ctx);
    expect(kept.title).toBe("How AI Actually Gets Built");
    expect(refusing.create).toHaveBeenCalledTimes(1);
  });

  it("does not take a restyle that lower-cases half a name to get past the checker (review of PR #785)", async () => {
    /* "Why Doctor who still works" keeps the letters and passes
       titleStyleProblems. MUTATION THAT KILLS THIS: drop the demotedNames
       guard from sentenceCaseTitle -> the corrupted title is taken. */
    const { client, create } = makeFakeAnthropicClient([]);
    create
      .mockResolvedValueOnce({ content: [textBlock(intentJson("Why Doctor Who Still Works"))] })
      .mockResolvedValueOnce({ content: [textBlock('{"title": "Why Doctor who still works"}')] });
    const intent = await new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client).extractIntent("why does Doctor Who still work", ctx);
    expect(titleStyleProblems("Why Doctor who still works")).toEqual([]);
    expect(intent.title).toBe("Why Doctor Who Still Works");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not re-ask for a title that keeps the style, or one only a closing period away from it", async () => {
    /* The period is code's job (houseStyleTitle), not a second model call.
       MUTATION THAT KILLS THIS: check `titleStyleProblems(title)` instead of
       `titleStyleProblems(houseStyleTitle(title))` -> two calls. */
    for (const title of ["How Earth got plate tectonics and Venus never did", "Was it worth it?", "How AI actually gets built."]) {
      const { client, create } = makeFakeAnthropicClient([textBlock(intentJson(title))]);
      const intent = await new AnthropicPromptUnderstander(new BudgetGuard(new InMemoryCostEventSink(), 100), client).extractIntent("x", ctx);
      expect(intent.title).toBe(title);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });
});
