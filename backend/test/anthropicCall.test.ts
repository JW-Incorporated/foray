import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AnthropicDeepenActBuilder } from "../src/generation/AnthropicDeepenActBuilder";
import { AnthropicPromptUnderstander } from "../src/generation/AnthropicPromptUnderstander";
import { assertReplyComplete, createMessage, webSearchAnswerText } from "../src/generation/anthropicCall";
import { getUsageTotals, resetUsageTracking } from "../src/generation/usageTracking";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock } from "./helpers/fakeAnthropicClient";
import type { Spine } from "../src/types/spine";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Round-3 audit gen-10 + gen-14: one call helper for every Anthropic*
 * builder. It records usage on EVERY reply (re-asks included, gen-14) and
 * refuses a reply cut off at max_tokens instead of letting
 * parseOrRepairJson close its brackets into a shorter valid answer (gen-10).
 */
const ctx = { userId: "u1", sessionId: "s1" };
const guard = () => new BudgetGuard(new InMemoryCostEventSink(), 100);

const spine: Spine = {
  subject: "Charcoal briquettes",
  angle: "an industrial waste-disposal scheme",
  overview: "We look at what happens when the thing you built meets the world that has to run it, told by the people who were there.",
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
const deepened = {
  title: "Act 1",
  thesis: "thesis",
  startState: "start",
  endState: "end",
  slots: [{ title: "slot", beats: [{ claim: "A refined claim happened", exploration: false }] }],
  introduction: "The act opens on...",
  exit: "The act hands off to the next act, where the people who ran the kilns"
};

function reply(text: string, extra: Partial<Anthropic.Message> = {}) {
  return { content: [textBlock(text)], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 }, ...extra };
}

beforeEach(() => resetUsageTracking());

describe("anthropicCall: gen-10, a truncated reply is refused, never repaired", () => {
  it("assertReplyComplete throws only on max_tokens", () => {
    expect(() => assertReplyComplete("max_tokens", "x", 500)).toThrow(/truncated/);
    expect(() => assertReplyComplete("end_turn", "x", 500)).not.toThrow();
    expect(() => assertReplyComplete(null, "x", 500)).not.toThrow();
  });

  it("a deepened act cut off inside `exit` is refused, although parseOrRepairJson could close it", async () => {
    // The reply stops mid-string inside the last field: repairable JSON.
    const full = JSON.stringify(deepened);
    const cut = full.slice(0, full.length - 20);
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue(reply(cut, { stop_reason: "max_tokens" }));
    const builder = new AnthropicDeepenActBuilder(guard(), client);
    await expect(builder.deepenAct(spine, spine.acts[0]!, 0, ctx)).rejects.toThrow(/truncated/);
  });

  it("a complete reply still parses", async () => {
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue(reply(JSON.stringify(deepened)));
    const builder = new AnthropicDeepenActBuilder(guard(), client);
    await expect(builder.deepenAct(spine, spine.acts[0]!, 0, ctx)).resolves.toMatchObject({ exit: deepened.exit });
  });
});

describe("anthropicCall: gen-14, every reply's usage is recorded, re-asks included", () => {
  it("createMessage records one call and its tokens", async () => {
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue(reply("{}"));
    await createMessage(client, { model: "m", max_tokens: 10, messages: [{ role: "user", content: "q" }] }, "x");
    expect(getUsageTotals()).toEqual({ inputTokens: 100, outputTokens: 10, total: 110, calls: 1 });
  });

  it("DeepenAct: a malformed first reply plus its re-ask counts as two calls", async () => {
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValueOnce(reply("not json at all")).mockResolvedValueOnce(reply(JSON.stringify(deepened)));
    const builder = new AnthropicDeepenActBuilder(guard(), client);
    await builder.deepenAct(spine, spine.acts[0]!, 0, ctx);
    expect(create).toHaveBeenCalledTimes(2);
    expect(getUsageTotals()).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 20 });
  });

  it("PromptUnderstander clarity: the re-ask is recorded too", async () => {
    const { client, create } = makeFakeAnthropicClient([]);
    create
      .mockResolvedValueOnce(reply("nope"))
      .mockResolvedValueOnce(reply(JSON.stringify({ ambiguous: false, readings: [], question: null })));
    const understander = new AnthropicPromptUnderstander(guard(), client);
    await understander.assessClarity("the history of charcoal", ctx);
    expect(create).toHaveBeenCalledTimes(2);
    expect(getUsageTotals().calls).toBe(2);
  });
});

describe("anthropicCall: the builders cannot drift again", () => {
  it("no generation module calls messages.create or recordUsage except through anthropicCall.ts", () => {
    const dir = path.join(__dirname, "..", "src", "generation");
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "anthropicCall.ts" || name === "usageTracking.ts") continue;
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      if (/\.messages\.create\(/.test(src)) offenders.push(`${name}: messages.create`);
      if (/\brecordUsage\(/.test(src)) offenders.push(`${name}: recordUsage`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("anthropicCall: webSearchAnswerText (gen-1)", () => {
  const block = (b: Record<string, unknown>) => b as unknown as Anthropic.ContentBlock;
  it("takes the text after the last web_search_tool_result, joined in order", () => {
    const content = [
      textBlock("I'll search for that."),
      block({ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }),
      block({ type: "web_search_tool_result", tool_use_id: "s1", content: [] }),
      textBlock('{"passages": [{"title": "T", '),
      textBlock('"text": "cited words"}]}')
    ];
    expect(webSearchAnswerText(content)).toBe('{"passages": [{"title": "T", "text": "cited words"}]}');
  });

  it("a reply that never searched is all answer", () => {
    expect(webSearchAnswerText([textBlock("a"), textBlock("b")])).toBe("ab");
  });
});
