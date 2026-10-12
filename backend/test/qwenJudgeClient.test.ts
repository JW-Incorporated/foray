import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ChatProviderError, type ChatFinishReason, type ChatRequest, type ChatResponse } from "../src/generation/chat/ChatProvider";
import { OpenAICompatChatProvider } from "../src/generation/chat/openAICompatProvider";
import { parseJevReply } from "../src/generation/jevClient";
import type { JevChoiceQuestion, JevFailure, JevOk, JevQuestion, JevResult } from "../src/generation/jevTypes";
import {
  QWEN_JUDGE_SCHEMA_NAME,
  QwenJudgeClient,
  distributionAt,
  judgeReplySchema,
  readJudgeReply,
  type QwenJudgeClientOptions
} from "../src/generation/qwenJudgeClient";
import { scriptedProvider, type ScriptedReply } from "./helpers/fakeChatProvider";
import { fakeFetch } from "./helpers/fakeFetch";

/**
 * GV-47 (docs/roadmap/generation-v2.md, from W5-19 + W2-12): the Qwen judge
 * behind the JevClient interface. Offline only: a scripted ChatProvider
 * replays the SYNTHETIC OpenAI-format bodies in
 * test/fixtures/jev/qwen-judge-replies.json (one wire-level replay goes
 * through the real OpenAI-compatible client over fakeFetch); no test reaches
 * the Spark, the second box, LiteLLM or Jev. Each test names the mutation
 * that turns it red.
 */

interface OpenAIBody {
  model: string;
  choices: Array<{
    message: { content: string };
    finish_reason: string;
    logprobs?: { content: Array<{ token: string; logprob: number; top_logprobs: Array<{ token: string; logprob: number }> }> };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

interface QwenFixture {
  state: Record<string, unknown>;
  questions: JevQuestion[];
  ambiguousQuestion: JevChoiceQuestion;
  replies: Record<string, OpenAIBody>;
}

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "jev", "qwen-judge-replies.json"), "utf8")) as QwenFixture;
const STATE = fx.state;
const QUESTIONS = fx.questions;

/** A synthetic OpenAI chat.completion body as the scripted provider's reply. */
function fromOpenAI(name: string): ScriptedReply {
  const body = fx.replies[name];
  if (!body) throw new Error(`no fixture reply ${name}`);
  const choice = body.choices[0]!;
  return {
    text: choice.message.content,
    finishReason: (choice.finish_reason === "length" ? "length" : "stop") as ChatFinishReason,
    model: body.model,
    usage: { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens, cachedTokens: null, reasoningTokens: null },
    ...(choice.logprobs
      ? { logprobs: choice.logprobs.content.map((t) => ({ token: t.token, logprob: t.logprob, top: t.top_logprobs.map((a) => ({ ...a })) })) }
      : {})
  };
}

function judge(replies: ScriptedReply[] | ((req: ChatRequest) => ScriptedReply), opts: Partial<QwenJudgeClientOptions> = {}) {
  const provider = scriptedProvider({ complete: replies });
  const client = new QwenJudgeClient({ provider, model: "local-worker", lane: "second", structuredOutput: "json_schema", logprobs: false, ...opts });
  return { client, provider };
}

const ask = (c: QwenJudgeClient, questions: readonly JevQuestion[] = QUESTIONS, signal?: AbortSignal): Promise<JevResult> =>
  c.ask(STATE, questions, { purpose: "sentence-support", ...(signal ? { signal } : {}) });

function expectOk(r: JevResult): JevOk {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.category}/${r.error.reason}`);
  return r;
}

function expectFailure(r: JevResult): JevFailure {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

describe("QwenJudgeClient: each question type round-trips into a JevResult", () => {
  it("noul, choice and score answers come back Jev-shaped, in question order, tagged qwen and uncalibrated", async () => {
    /* MUTATION THAT KILLS THIS: set the choice's confidence to 1 instead of
       the chosen key's probability, or drop the score legend lookup, or drop
       the {judge:'qwen'} tag. Ran all three: red. */
    const { client } = judge([fromOpenAI("all")]);
    const r = expectOk(await ask(client));
    expect(r.answers).toEqual([
      { id: "supported", type: "noul", noul: 0.8 },
      { id: "best_passage", type: "choice", choice: "o2", probabilities: { o1: 0.1, o2: 0.85, none: 0.05 }, confidence: 0.85 },
      { id: "clarity", type: "score", score: 3, legend: "clear", probabilities: { "0": 0, "1": 0, "2": 0.1, "3": 0.7, "4": 0.2 }, confidence: 0.7 }
    ]);
    expect(r).toMatchObject({ judge: "qwen", calibrated: false, model: "qwen3.6-35b-a3b", modelMismatch: false, usage: { inputTokens: 412, outputTokens: 37 } });
  });

  it("the request: lane alias, thinking off, temperature 0, purpose as label, a schema built from the questions, no logprobs on a lane without them", async () => {
    /* MUTATION THAT KILLS THIS: send thinking:true, or build the choice enum
       from the question id, or ask for logprobs when the lane has none. Ran
       all three: red. */
    const { client, provider } = judge([fromOpenAI("all")]);
    await ask(client);
    const req = provider.requests[0]!;
    expect(req).toMatchObject({ model: "local-worker", thinking: false, temperature: 0, label: "sentence-support" });
    expect(req.logprobs).toBeUndefined();
    expect(req.responseFormat).toEqual({ type: "json_schema", name: QWEN_JUDGE_SCHEMA_NAME, schema: judgeReplySchema(QUESTIONS, false), strict: true });
    const answers = (judgeReplySchema(QUESTIONS, false) as { properties: { answers: { properties: Record<string, { properties: Record<string, unknown> }>; required: string[] } } })
      .properties.answers;
    expect(answers.required).toEqual(["supported", "best_passage", "clarity"]);
    expect(answers.properties.supported!.properties).toEqual({ noul: { type: "number" } });
    expect(answers.properties.best_passage!.properties.choice).toEqual({ type: "string", enum: ["o1", "o2", "none"] });
    expect(answers.properties.clarity!.properties.score).toEqual({ type: "integer", enum: [0, 1, 2, 3, 4] });
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[1]!.content).toContain(JSON.stringify(STATE));
  });

  it("a json_object lane gets {type:'json_object'} and a 'none' lane no response_format", async () => {
    /* MUTATION THAT KILLS THIS: always send the json_schema format. Ran it: red. */
    const obj = judge([fromOpenAI("all")], { structuredOutput: "json_object" });
    await ask(obj.client);
    expect(obj.provider.requests[0]!.responseFormat).toEqual({ type: "json_object" });
    const none = judge([fromOpenAI("all")], { structuredOutput: "none" });
    expectOk(await ask(none.client));
    expect(none.provider.requests[0]!.responseFormat).toBeUndefined();
  });

  it("wire-level replay: the OpenAI-compatible client sends enable_thinking false, the json_schema and top_logprobs on a logprobs lane", async () => {
    /* MUTATION THAT KILLS THIS: drop the logprobs request on a lane whose
       profile has logprobs. Ran it: red. */
    const fake = fakeFetch({ body: fx.replies.logprobs });
    const provider = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "test-key", fetchImpl: fake.fetch });
    const client = new QwenJudgeClient({ provider, model: "local-heavy", lane: "spark", structuredOutput: "json_schema", logprobs: true });
    const r = expectOk(await ask(client));
    expect(r.calibrated).toBe(true);
    const body = fake.calls[0]!.body;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(10);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: QWEN_JUDGE_SCHEMA_NAME, strict: true } });
    expect(fake.calls[0]!.url).toBe("http://litellm.invalid:4000/v1/chat/completions");
  });
});

describe("QwenJudgeClient: a malformed reply is {ok:false, malformed}, never a throw", () => {
  it.each([
    ["malformedJson", "malformed_json"],
    ["choiceNotInCriteria", "choice_not_in_criteria"],
    ["missingAnswer", "malformed_answers"],
    ["noulOutOfRange", "noul_out_of_range"],
    ["probabilitiesMismatch", "probabilities_mismatch"],
    ["truncated", "truncated"]
  ])("%s gives malformed/%s", async (name, reason) => {
    /* MUTATION THAT KILLS THIS: skip parseJevReply (W5-01's validator) and
       return the read answers as they are, or drop the finishReason 'length'
       refusal. Ran both: red. */
    const { client } = judge([fromOpenAI(name)]);
    const r = expectFailure(await ask(client));
    expect(r.error).toEqual({ category: "malformed", reason });
    expect(r.judge).toBe("qwen");
  });

  it("an invalid question is refused before any request", async () => {
    /* MUTATION THAT KILLS THIS: drop the validateJevQuestions call. Ran it: red. */
    const { client, provider } = judge([fromOpenAI("all")]);
    const r = expectFailure(await ask(client, [{ id: "x", type: "score", instructions: "?", criteria: ["only one"] }]));
    expect(r.error).toEqual({ category: "malformed", reason: "invalid_question" });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("QwenJudgeClient: probabilities", () => {
  it("self-reported probabilities are renormalised to sum to 1", async () => {
    /* MUTATION THAT KILLS THIS: pass self-reported probabilities through
       unscaled. Ran it: red. */
    const { client } = judge([fromOpenAI("selfReportedUnnormalised")]);
    const choice = expectOk(await ask(client)).answers[1]!;
    expect(choice).toMatchObject({ type: "choice", choice: "o2", probabilities: { o1: 0.25, o2: 0.5, none: 0.25 }, confidence: 0.5 });
  });

  it("on a logprobs lane the probabilities come from top_logprobs and the result is calibrated", async () => {
    /* MUTATION THAT KILLS THIS: never read the logprobs (keep the
       self-report), or skip the renormalisation over the labels (the score
       position has a non-label alternative 'x'). Ran both: red. */
    const { client, provider } = judge([fromOpenAI("logprobs")], { logprobs: true });
    const r = expectOk(await ask(client));
    expect(provider.requests[0]!.logprobs).toEqual({ top: 10 });
    expect(r.calibrated).toBe(true);
    const [noul, choice, score] = r.answers;
    expect(noul).toEqual({ id: "supported", type: "noul", noul: expect.closeTo(0.9, 10) });
    expect(choice).toMatchObject({ choice: "o2", confidence: expect.closeTo(0.7, 10) });
    expect((choice as { probabilities: Record<string, number> }).probabilities.o1).toBeCloseTo(0.2, 10);
    expect((score as { probabilities: Record<string, number> }).probabilities).toEqual({
      "0": 0,
      "1": 0,
      "2": expect.closeTo(0.1, 10),
      "3": expect.closeTo(0.6, 10),
      "4": expect.closeTo(0.3, 10)
    });
  });

  it("a choice whose first token names two keys falls back to the self-report, uncalibrated", async () => {
    /* MUTATION THAT KILLS THIS: let an ambiguous token count toward the first
       key it prefixes (matches.length >= 1). Ran it: red. */
    const { client } = judge([fromOpenAI("ambiguousLogprobs")], { logprobs: true });
    const r = expectOk(await ask(client, [fx.ambiguousQuestion]));
    expect(r.calibrated).toBe(false);
    expect(r.answers[0]).toMatchObject({ choice: "s2", probabilities: { s1: 0.2, s2: 0.6, none: 0.2 } });
  });

  it("distributionAt refuses tokens that do not spell the text", () => {
    /* MUTATION THAT KILLS THIS: drop the token-concatenation check. Ran it: red. */
    const tokens = [{ token: "3", logprob: Math.log(0.6), top: [{ token: "4", logprob: Math.log(0.4) }] }];
    expect(distributionAt(tokens, "3", 0, ["3", "4"])).toEqual({ "3": expect.closeTo(0.6, 10), "4": expect.closeTo(0.4, 10) });
    expect(distributionAt(tokens, "3}", 0, ["3", "4"])).toBeNull();
  });

  it("readJudgeReply's body is exactly what parseJevReply accepts for a good reply", () => {
    /* MUTATION THAT KILLS THIS: drop the `type` field from the translated
       answers (parseJevReply then refuses answer_type_mismatch). Ran it: red. */
    const read = readJudgeReply((fromOpenAI("all") as { text: string }).text, QUESTIONS, undefined);
    expect(read).not.toBeNull();
    expect(parseJevReply(read!.body, QUESTIONS).ok).toBe(true);
  });
});

describe("QwenJudgeClient: transport failures become Jev categories", () => {
  it.each([
    [new ChatProviderError("http", "http_503", { status: 503 }), { category: "http", reason: "http_503", httpStatus: 503 }],
    [new ChatProviderError("timeout", "timeout"), { category: "timeout", reason: "timeout" }],
    [new ChatProviderError("network", "network"), { category: "network", reason: "network" }],
    [new ChatProviderError("malformed", "malformed_json"), { category: "malformed", reason: "malformed_response" }],
    [new Error("boom"), { category: "network", reason: "provider_error" }]
  ])("%s", async (err, error) => {
    /* MUTATION THAT KILLS THIS: map a provider http error to category
       'network' (the status would be lost), or let a non-provider error
       throw. Ran both: red. */
    const { client } = judge([err as Error]);
    const r = expectFailure(await ask(client));
    expect(r.error).toEqual(error);
    expect(r.judge).toBe("qwen");
  });

  it("an ask that outlives its budget is timeout/timeout, even when the provider ignores its signal", async () => {
    /* MUTATION THAT KILLS THIS: stop racing the provider against the abort.
       Ran it: red (the ask hangs past the budget). */
    vi.useFakeTimers();
    try {
      const provider = { name: "deaf", complete: () => new Promise<ChatResponse>(() => undefined) };
      const client = new QwenJudgeClient({ provider, model: "local-worker", lane: "second", structuredOutput: "json_schema", logprobs: false, budgetMs: 500 });
      const pending = ask(client);
      await vi.advanceTimersByTimeAsync(501);
      expect(expectFailure(await pending).error).toEqual({ category: "timeout", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller's cancel is timeout/aborted", async () => {
    /* MUTATION THAT KILLS THIS: report a caller abort as timeout/timeout.
       Ran it: red (the fallback would then treat a cancel as an outage). */
    let sent!: () => void;
    const inFlight = new Promise<void>((resolve) => (sent = resolve));
    const provider = {
      name: "hangs",
      complete: (req: ChatRequest) => {
        sent();
        return new Promise<ChatResponse>((_, reject) => req.signal?.addEventListener("abort", () => reject(new ChatProviderError("aborted", "aborted"))));
      }
    };
    const client = new QwenJudgeClient({ provider, model: "local-worker", lane: "second", structuredOutput: "json_schema", logprobs: false });
    const controller = new AbortController();
    const pending = ask(client, QUESTIONS, controller.signal);
    /* Cancelled while the request is in flight, not before it is sent. */
    await inFlight;
    controller.abort();
    expect(expectFailure(await pending).error).toEqual({ category: "timeout", reason: "aborted" });
  });

  it("at most maxConcurrent asks are in flight on the lane", async () => {
    /* MUTATION THAT KILLS THIS: call askOnce directly instead of through the
       pool. Ran it: red (peak 4). */
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const provider = {
      name: "slow",
      complete: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return { ...(fromOpenAI("all") as object), usage: { promptTokens: 1, completionTokens: 1, cachedTokens: null, reasoningTokens: null }, requestId: null, servedBy: null, timing: { startedAt: 0, firstByteAt: 0, endedAt: 0 } } as ChatResponse;
      }
    };
    const client = new QwenJudgeClient({ provider, model: "local-worker", lane: "second", structuredOutput: "json_schema", logprobs: false, maxConcurrent: 2 });
    let settled = false;
    const all = Promise.all([ask(client), ask(client), ask(client), ask(client)]).finally(() => (settled = true));
    for (let i = 0; i < 50 && !settled; i += 1) {
      await new Promise((r) => setImmediate(r));
      release.splice(0).forEach((go) => go());
    }
    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });
});
