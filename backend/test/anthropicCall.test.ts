import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnthropicDeepenActBuilder } from "../src/generation/AnthropicDeepenActBuilder";
import { AnthropicPromptUnderstander } from "../src/generation/AnthropicPromptUnderstander";
import {
  assertReplyComplete,
  createMessage,
  createWebSearchTurn,
  TruncatedReplyError,
  webSearchAnswerText
} from "../src/generation/anthropicCall";
import { PROVIDER_CALL_SITES, RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
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

/* GV-07: the CallRecord guard. A model call is recorded where it is made:
   only the modules in PROVIDER_CALL_SITES may append one. Scanned
   recursively, so a provider under chat/ is held to the same rule. */
function recordModelCallOffenders(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.name.endsWith(".ts") || rel === "runLog.ts" || PROVIDER_CALL_SITES.includes(rel)) continue;
      if (/\brecordModelCall\(/.test(fs.readFileSync(path.join(dir, rel), "utf8"))) offenders.push(rel);
    }
  };
  walk("");
  return offenders;
}

describe("anthropicCall: GV-07, one CallRecord per request at the choke point", () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
  });
  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
  });

  /** A log on a hand-driven clock; `advance` moves it. */
  function fakeClockLog() {
    let t = 1_000_000;
    const log = new RunLog({ now: () => t });
    return { log, advance: (ms: number) => void (t += ms) };
  }
  const params = { model: "m-1", max_tokens: 700, messages: [{ role: "user" as const, content: "q" }] };

  it("records tokens (cached from cache_read_input_tokens), stop reason, ms and label under the active stage context", async () => {
    /* MUTATION THAT KILLS THIS: drop the success-path recordAnthropicCall in
       createMessage — the log has no call. Or read cachedTokens from
       cache_creation_input_tokens — 40 reads 7. Ran both — red. */
    const { log, advance } = fakeClockLog();
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      advance(250);
      return reply("{}", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 7 } as never });
    });
    advance(5);
    await runWithRunLog(log, () => withCallContext({ stage: "spine", act: 2 }, () => createMessage(client, params, "spine")));
    expect(log.calls()).toEqual([
      {
        kind: "call",
        seq: 0,
        stage: "spine",
        act: 2,
        seam: null,
        attempt: null,
        role: null,
        reask: null,
        provider: "anthropic",
        machine: "anthropic-api",
        model: "m-1",
        label: "spine",
        startMs: 5,
        endMs: 255,
        ms: 250,
        queueMs: null,
        ttftMs: null,
        promptTokens: 100,
        cachedTokens: 40,
        outputTokens: 10,
        decodeTokPerSec: null,
        maxTokens: 700,
        outputBudget: null,
        overBudget: null,
        stopReason: "end_turn",
        jsonValid: null
      }
    ]);
    expect(log.callTotals()).toEqual({ calls: 1, ms: 250, promptTokens: 100, cachedTokens: 40, outputTokens: 10 });
  });

  it("names the relay as the machine when ANTHROPIC_BASE_URL is set, and leaves unreported token counts null", async () => {
    /* MUTATION THAT KILLS THIS: hard-code machine 'anthropic-api'. Ran it — red. */
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8787";
    const { log } = fakeClockLog();
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue({ content: [textBlock("{}")], stop_reason: "end_turn" });
    await runWithRunLog(log, () => createMessage(client, params, "x"));
    expect(log.calls()[0]).toMatchObject({ machine: "relay", promptTokens: null, cachedTokens: null, outputTokens: null, stage: null });
  });

  it("a truncated reply is still refused, and its record says max_tokens", async () => {
    /* MUTATION THAT KILLS THIS: record AFTER assertReplyComplete — the
       refused reply leaves no record. Ran it — red. */
    const { log } = fakeClockLog();
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue(reply('{"a": "cut', { stop_reason: "max_tokens" }));
    await expect(runWithRunLog(log, () => createMessage(client, params, "deepen"))).rejects.toBeInstanceOf(TruncatedReplyError);
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]).toMatchObject({ label: "deepen", stopReason: "max_tokens", maxTokens: 700, outputTokens: 10 });
    expect(log.calls()[0]!.error).toBeUndefined();
  });

  it("a transport error is recorded with its name and status, then rethrown unchanged", async () => {
    /* MUTATION THAT KILLS THIS: drop the catch's recordAnthropicCall — a
       failed request vanishes from the log. Ran it — red. */
    const { log, advance } = fakeClockLog();
    const { client, create } = makeFakeAnthropicClient([]);
    const boom = Object.assign(new Error("overloaded"), { name: "APIError", status: 529 });
    create.mockImplementation(async () => {
      advance(40);
      throw boom;
    });
    await expect(runWithRunLog(log, () => createMessage(client, params, "writer"))).rejects.toBe(boom);
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]).toMatchObject({ error: { kind: "APIError", status: 529 }, ms: 40, stopReason: null, promptTokens: null });
    expect(getUsageTotals().calls).toBe(0);
  });

  it("a pause_turn continuation is recorded as its own request with reask 'continuation'", async () => {
    /* MUTATION THAT KILLS THIS: drop the withCallContext({reask:
       'continuation'}) around the continuation — both records read reask
       null. Ran it — red. */
    const { log } = fakeClockLog();
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValueOnce(reply("part one", { stop_reason: "pause_turn" })).mockResolvedValueOnce(reply("part two"));
    const content = await runWithRunLog(log, () =>
      withCallContext({ stage: "research-shape" }, () => createWebSearchTurn(client, params, "research", async () => undefined))
    );
    expect(content).toHaveLength(2);
    expect(log.calls().map((c) => [c.seq, c.stage, c.reask, c.stopReason])).toEqual([
      [0, "research-shape", null, "pause_turn"],
      [1, "research-shape", "continuation", "end_turn"]
    ]);
  });

  it("outside a RunLog nothing is recorded and the call behaves exactly as before", async () => {
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockResolvedValue(reply("{}"));
    await expect(createMessage(client, params, "x")).resolves.toMatchObject({ stop_reason: "end_turn" });
    expect(getUsageTotals().calls).toBe(1);
  });
});

describe("anthropicCall: GV-07, only a provider call site records a model call", () => {
  it("PROVIDER_CALL_SITES is the Anthropic choke point plus the provider and Jev slots", () => {
    expect(PROVIDER_CALL_SITES).toEqual(["anthropicCall.ts", "chat/openAICompatProvider.ts", "jevClient.ts"]);
  });

  it("no generation module outside PROVIDER_CALL_SITES calls recordModelCall", () => {
    expect(recordModelCallOffenders(path.join(__dirname, "..", "src", "generation"))).toEqual([]);
  });

  it("the guard fails on a planted call in a non-allowlisted module, nested ones included", () => {
    /* MUTATION THAT KILLS THIS: make the scan skip every file (or stop
       recursing) — the planted offenders are not reported. Ran it — red. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv07-guard-"));
    try {
      fs.mkdirSync(path.join(dir, "chat"));
      fs.writeFileSync(path.join(dir, "anthropicCall.ts"), "recordModelCall({});\n");
      fs.writeFileSync(path.join(dir, "writeAct.ts"), "recordModelCall({});\n");
      fs.writeFileSync(path.join(dir, "chat", "openAICompatProvider.ts"), "recordModelCall({});\n");
      fs.writeFileSync(path.join(dir, "chat", "sneaky.ts"), "export const x = () => recordModelCall({});\n");
      expect(recordModelCallOffenders(dir).sort()).toEqual(["chat/sneaky.ts", "writeAct.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
