import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { askStructured, REASK_LINE, type StructuredTarget } from "../src/generation/chat/askStructured";
import { responseFormatFor } from "../src/generation/chat/jsonSchema";
import type { ChatMessage } from "../src/generation/chat/ChatProvider";
import { ClaritySchema } from "../src/generation/replySchemas";
import { TruncatedReplyError } from "../src/generation/replyErrors";
import { assertReplyComplete, TruncatedReplyError as AnthropicTruncatedReplyError } from "../src/generation/anthropicCall";
import { getUsageTotals, resetUsageTracking } from "../src/generation/usageTracking";
import { BudgetExceededError, BudgetGuard, findBudgetError } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink, type CostEventInput } from "../src/cost/costEvents";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-19 (docs/roadmap/generation-v2.md, from W2-04): askStructured, the one
 * provider-neutral JSON call. Offline: scriptedProvider replies only, no
 * network, no model.
 */

const target: StructuredTarget = {
  providerName: "spark-litellm",
  model: "local-heavy",
  structuredOutput: "json_schema",
  usdPerMtokIn: 0,
  usdPerMtokOut: 0
};
const messages: ChatMessage[] = [
  { role: "system", content: "You judge whether a podcast prompt is ambiguous." },
  { role: "user", content: "the history of charcoal" }
];
const good = { ambiguous: false, readings: [], question: null };
const usage = (promptTokens: number, completionTokens: number) => ({ promptTokens, completionTokens, cachedTokens: null, reasoningTokens: null });

/** A guard that records every check it is asked for and never refuses. */
function recordingGuard() {
  const checks: CostEventInput[] = [];
  return { checks, guard: { checkAndRecord: async (input: CostEventInput) => void checks.push(input) } };
}

function ask(provider: ReturnType<typeof scriptedProvider>, over: { target?: Partial<StructuredTarget>; guard?: { checkAndRecord(i: CostEventInput): Promise<unknown> } } = {}) {
  const guard = over.guard ?? recordingGuard().guard;
  return askStructured({
    provider,
    target: { ...target, ...over.target },
    schemaName: "clarity",
    schema: ClaritySchema,
    messages,
    maxTokens: 300,
    operation: "clarity",
    budget: { guard, userId: "u1", sessionId: "s1" },
    label: "clarity"
  });
}

beforeEach(() => resetUsageTracking());

describe("askStructured: one metered, constrained call", () => {
  it("a valid reply takes one call, one guard check and one recordUsage, and response_format names the schema", async () => {
    /* MUTATION THAT KILLS THIS: send no responseFormat for 'json_schema'
       (or drop the recordUsage call, or default thinking to undefined).
       Ran all three: red. */
    const provider = scriptedProvider({ complete: [{ text: JSON.stringify(good), usage: usage(120, 15) }] });
    const { checks, guard } = recordingGuard();
    const result = await ask(provider, { guard });
    expect(result.value).toEqual(good);
    expect(result.reasked).toBe(false);
    expect(result.response.text).toBe(JSON.stringify(good));
    expect(provider.requests).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(getUsageTotals()).toEqual({ inputTokens: 120, outputTokens: 15, total: 135, calls: 1 });
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("clarity"));
    expect(req.responseFormat).toMatchObject({ type: "json_schema", name: "clarity", strict: true });
    expect(req).toMatchObject({ model: "local-heavy", maxTokens: 300, label: "clarity", thinking: false, messages });
    expect("temperature" in req).toBe(false);
  });

  it("meters before the call: chars/4 input tokens plus maxTokens at the target's rates, on the target's provider and model", async () => {
    /* MUTATION THAT KILLS THIS: estimate from maxTokens alone (drop the
       input term), or record provider.name instead of target.providerName.
       Ran both: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify(good)] });
    const { checks, guard } = recordingGuard();
    await ask(provider, { guard, target: { usdPerMtokIn: 2, usdPerMtokOut: 10 } });
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    expect(checks[0]).toMatchObject({ userId: "u1", sessionId: "s1", operation: "clarity", provider: "spark-litellm", model: "local-heavy" });
    expect(checks[0]!.estimatedUsd).toBeCloseTo((Math.ceil(chars / 4) * 2 + 300 * 10) / 1_000_000, 12);
  });

  it("a budget refusal before the first call means the provider is never asked", async () => {
    /* MUTATION THAT KILLS THIS: meter after provider.complete. Ran it: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify(good)] });
    const refusing = { checkAndRecord: async () => { throw new BudgetExceededError(1, 1, 1); } };
    await expect(ask(provider, { guard: refusing })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toHaveLength(0);
  });

  it("passes the target's thinking and temperature through when set", async () => {
    /* MUTATION THAT KILLS THIS: hard-code thinking false. Ran it: red. */
    const provider = scriptedProvider({ complete: [JSON.stringify(good)] });
    await ask(provider, { target: { thinking: true, temperature: 0.2 } });
    expect(provider.requests[0]).toMatchObject({ thinking: true, temperature: 0.2 });
  });
});

describe("askStructured: one metered re-ask (MT-07)", () => {
  it("an invalid first reply causes exactly one metered re-ask with the same responseFormat, and reasked is true", async () => {
    /* MUTATION THAT KILLS THIS: drop the meter inside the re-ask (one guard
       check), or send the re-ask without responseFormat. Ran both: red. */
    const provider = scriptedProvider({
      complete: [
        { text: "Sure! The prompt is clear.", usage: usage(100, 8) },
        { text: JSON.stringify(good), usage: usage(130, 12) }
      ]
    });
    const { checks, guard } = recordingGuard();
    const result = await ask(provider, { guard });
    expect(result.value).toEqual(good);
    expect(result.reasked).toBe(true);
    expect(result.response.text).toBe(JSON.stringify(good));
    expect(provider.requests).toHaveLength(2);
    expect(checks).toHaveLength(2);
    expect(checks[1]!.operation).toBe("clarity");
    expect(provider.requests[1]!.responseFormat).toBe(provider.requests[0]!.responseFormat);
    expect(provider.requests[1]!.messages).toEqual([
      ...messages,
      { role: "assistant", content: "Sure! The prompt is clear." },
      { role: "user", content: REASK_LINE }
    ]);
    expect(getUsageTotals()).toEqual({ inputTokens: 230, outputTokens: 20, total: 250, calls: 2 });
  });

  it("a second bad reply fails after exactly one re-ask", async () => {
    /* MUTATION THAT KILLS THIS: loop the re-ask until a reply parses. Ran it
       (the third scripted call throws): red. */
    const provider = scriptedProvider({ complete: ["not json", "still not json"] });
    await expect(ask(provider)).rejects.toThrow(/after one re-ask/);
    expect(provider.requests).toHaveLength(2);
  });

  it("a budget refusal inside the re-ask propagates on `cause`", async () => {
    /* A $10 cap with $1 per output token and 10 output tokens: the first
       call ($10) fits, the re-ask's does not.
       MUTATION THAT KILLS THIS: catch the re-ask's meter error and rethrow a
       plain Error without it. Ran it: red. */
    const provider = scriptedProvider({ complete: ["not json", JSON.stringify(good)] });
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 15);
    const err = await askStructured({
      provider,
      target: { ...target, usdPerMtokOut: 1_000_000 },
      schemaName: "clarity",
      schema: ClaritySchema,
      messages,
      maxTokens: 10,
      operation: "clarity",
      budget: { guard, userId: "u1" },
      label: "clarity"
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBeInstanceOf(BudgetExceededError);
    expect(findBudgetError(err)).toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("askStructured: a reply that hit its token ceiling is refused", () => {
  it("a 'length' finish throws TruncatedReplyError before any parse, with no re-ask", async () => {
    /* The reply is cut inside the last string: parseOrRepairJson could close
       it into a valid shorter answer.
       MUTATION THAT KILLS THIS: check finishReason after parseWithRetry (the
       repaired reply resolves). Ran it: red. */
    const full = JSON.stringify({ ambiguous: true, readings: ["the fuel", "the art medium"], question: "Which charcoal do you mean, the fuel or the drawing stick?" });
    const provider = scriptedProvider({ complete: [{ text: full.slice(0, full.length - 12), finishReason: "length", usage: usage(90, 300) }] });
    await expect(ask(provider)).rejects.toBeInstanceOf(TruncatedReplyError);
    expect(provider.requests).toHaveLength(1);
    expect(getUsageTotals()).toMatchObject({ calls: 1, outputTokens: 300 });
  });

  it("one class: researchShape's instanceof matches a refusal from the chat path and from the Anthropic path", async () => {
    /* MUTATION THAT KILLS THIS: declare a separate TruncatedReplyError class
       in anthropicCall.ts instead of re-exporting replyErrors.ts's, or point
       researchShape.ts's import back at anthropicCall.ts. Ran both: red. */
    const provider = scriptedProvider({ complete: [{ text: '{"ambiguous": tr', finishReason: "length" }] });
    const chatErr = await ask(provider).catch((e: unknown) => e);
    let anthropicErr: unknown;
    try {
      assertReplyComplete("max_tokens", "research", 500);
    } catch (e) {
      anthropicErr = e;
    }
    expect(AnthropicTruncatedReplyError).toBe(TruncatedReplyError);
    expect(chatErr).toBeInstanceOf(TruncatedReplyError);
    expect(anthropicErr).toBeInstanceOf(TruncatedReplyError);
    const researchShapeSrc = fs.readFileSync(path.join(__dirname, "..", "src", "generation", "researchShape.ts"), "utf8");
    expect(researchShapeSrc).toMatch(/import \{ TruncatedReplyError \} from "\.\/replyErrors";/);
    expect(researchShapeSrc).not.toMatch(/from "\.\/anthropicCall"/);
  });
});

describe("askStructured: the target's structuredOutput", () => {
  it("'none' sends no response_format and still parses", async () => {
    /* MUTATION THAT KILLS THIS: send {type:'json_object'} for 'none'. Ran it: red. */
    const provider = scriptedProvider({ complete: ["```json\n" + JSON.stringify(good) + "\n```"] });
    const result = await ask(provider, { target: { structuredOutput: "none" } });
    expect(result.value).toEqual(good);
    expect("responseFormat" in provider.requests[0]!).toBe(false);
  });

  it("'json_object' sends {type:'json_object'}, on the re-ask too", async () => {
    /* MUTATION THAT KILLS THIS: map 'json_object' to responseFormatFor. Ran it: red. */
    const provider = scriptedProvider({ complete: ["oops", JSON.stringify(good)] });
    await ask(provider, { target: { structuredOutput: "json_object" } });
    expect(provider.requests.map((r) => r.responseFormat)).toEqual([{ type: "json_object" }, { type: "json_object" }]);
  });
});
