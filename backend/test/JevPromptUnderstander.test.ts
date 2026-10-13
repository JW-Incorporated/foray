import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLARITY_JEV_PURPOSE,
  CLARITY_PRODUCT_LINE,
  CLARITY_QUESTION_IDS,
  CLARITY_QUESTIONS,
  CLARITY_THRESHOLDS,
  JevPromptUnderstander,
  clarityVerdict
} from "../src/generation/JevPromptUnderstander";
import { createPromptUnderstander } from "../src/generation/createPromptUnderstander";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { FallbackJudgeClient, HttpJevClient, parseJevReply } from "../src/generation/jevClient";
import { RoutingConfigError, describeStageAssignments } from "../src/config/stageRouting";
import { __setChatProviderForTests } from "../src/generation/chat/providerRegistry";
import { BudgetExceededError, BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { runForayPipeline } from "../src/generation/runPipeline";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import type { PromptUnderstander, PromptUnderstandContext } from "../src/generation/PromptUnderstander";
import type { ClarityResult, GenerationRequest, IntentUnderstanding } from "../src/types/generation";
import type { JevAnswer, JevError, JevResult } from "../src/generation/jevTypes";
import { FakeJevClient, noulAnswer } from "./helpers/fakeJevClient";
import { fakeFetch } from "./helpers/fakeFetch";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-49 (from W4-02; covers R1-02): §4.1's clarity check as one Jev request
 * with two yes/no questions, the text understander answering only when Jev
 * says yes or is unavailable.
 *
 * OFFLINE. Jev is FakeJevClient (keyed by question id) or HttpJevClient on a
 * scripted fetch replaying the synthetic bodies in
 * fixtures/jev/clarity-replies.json; the fallback is a counting double. No
 * test reaches Jev, the Spark or any network model. The factory cases stub
 * JEV_API_KEY with a fake value and only construct the client; none asks it.
 */

const CTX: PromptUnderstandContext = { userId: "founder-1", sessionId: "session-gv49" };

const FALLBACK_CLARITY: ClarityResult = {
  ambiguous: true,
  readings: ["the Apollo program", "the history of jazz"],
  question: "Which one should this Foray be about?"
};

const FALLBACK_INTENT: IntentUnderstanding = {
  subject: "fallback subject",
  angle: "fallback angle",
  priorKnowledge: "fallback prior knowledge",
  disappointment: "fallback disappointment"
};

/** A text understander that counts its calls and answers with fixed values. */
function countingFallback(clarity: ClarityResult = FALLBACK_CLARITY) {
  const calls = { clarity: 0, intent: 0 };
  const understander: PromptUnderstander = {
    providerName: "fallback-double",
    assessClarity: async () => {
      calls.clarity += 1;
      return clarity;
    },
    extractIntent: async () => {
      calls.intent += 1;
      return FALLBACK_INTENT;
    }
  };
  return { understander, calls };
}

function freshGuard() {
  const sink = new InMemoryCostEventSink();
  return { guard: new BudgetGuard(sink, 2.0), sink };
}

function jevSaying(twoSubjects: number, oneEpisode: number): FakeJevClient {
  return new FakeJevClient({
    byId: { [CLARITY_QUESTION_IDS.twoSubjects]: noulAnswer(twoSubjects), [CLARITY_QUESTION_IDS.oneEpisode]: noulAnswer(oneEpisode) }
  });
}

function understanderOn(jev: FakeJevClient | HttpJevClient, fallback: PromptUnderstander = countingFallback().understander) {
  return new JevPromptUnderstander(jev, fallback, CLARITY_THRESHOLDS, freshGuard().guard);
}

interface ClarityFixture {
  questionIds: string[];
  replies: Array<{ name: string; prompt: string; requestId: string; body: Record<string, unknown>; expect: "jev" | "fallback" }>;
}

function clarityFixtures(): ClarityFixture {
  const file = path.join(__dirname, "fixtures", "jev", "clarity-replies.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as ClarityFixture;
}

describe("GV-49: JevPromptUnderstander.assessClarity", () => {
  /* MUTATION THAT KILLS THIS: call the fallback whatever Jev says (drop the
     'clear' early return). Ran: red (the fallback was called once and the
     result was ambiguous). */
  it("both answers below threshold: not ambiguous, decided by Jev, and the fallback is never called", async () => {
    const { understander: fallback, calls } = countingFallback();
    const u = understanderOn(jevSaying(0.1, 0.2), fallback);
    const result = await u.assessClarity("Roman siege weapons", CTX);
    expect(result).toEqual({ ambiguous: false, readings: [], question: null, decidedBy: "jev" });
    expect(calls).toEqual({ clarity: 0, intent: 0 });
  });

  /* MUTATION THAT KILLS THIS: compare with `>` instead of `>=`, or ignore the
     one-episode answer. Ran both: red (the at-threshold and one-episode cases
     came back decided by Jev). */
  it.each([
    ["two-subjects yes", 0.9, 0.1],
    ["one-episode yes", 0.1, 0.9],
    ["two-subjects exactly at threshold", CLARITY_THRESHOLDS.twoSubjects, 0],
    ["one-episode exactly at threshold", 0, CLARITY_THRESHOLDS.oneEpisode]
  ])("%s: the fallback is called exactly once and its verdict is returned unchanged", async (_label, twoSubjects, oneEpisode) => {
    const { understander: fallback, calls } = countingFallback();
    const u = understanderOn(jevSaying(twoSubjects, oneEpisode), fallback);
    const result = await u.assessClarity("the Apollo program and the history of jazz", CTX);
    expect(calls).toEqual({ clarity: 1, intent: 0 });
    expect(result).toEqual({ ...FALLBACK_CLARITY, decidedBy: "fallback" });
  });

  /* MUTATION THAT KILLS THIS: force ambiguous:true on a Jev yes instead of
     returning the fallback's verdict. Ran: red. */
  it("the fallback can overrule a Jev yes to not ambiguous", async () => {
    const { understander: fallback, calls } = countingFallback({ ambiguous: false, readings: [], question: null });
    const result = await understanderOn(jevSaying(0.95, 0.95), fallback).assessClarity("a prompt Jev doubts", CTX);
    expect(calls.clarity).toBe(1);
    expect(result).toEqual({ ambiguous: false, readings: [], question: null, decidedBy: "fallback" });
  });

  /* MUTATION THAT KILLS THIS: ask the two questions in two requests (one per
     question), or put the user id into the state. Ran both: red. */
  it("makes exactly one Jev request carrying both question ids, the prompt and the product line, and nothing else", async () => {
    const jev = jevSaying(0.1, 0.1);
    await understanderOn(jev).assessClarity("Roman siege weapons", CTX);
    expect(jev.calls).toHaveLength(1);
    const call = jev.calls[0]!;
    expect(call.purpose).toBe(CLARITY_JEV_PURPOSE);
    expect(call.questions.map((q) => q.id)).toEqual(["two-subjects", "one-episode"]);
    expect(call.questions.every((q) => q.type === "noul")).toBe(true);
    expect(call.state).toEqual({ request: "Roman siege weapons", product: CLARITY_PRODUCT_LINE });
    expect(JSON.stringify(call.state)).not.toContain(CTX.userId);
  });

  /* MUTATION THAT KILLS THIS: treat a failed ask as 'clear' (return not
     ambiguous on {ok:false}). Ran: red for every category. */
  it.each<[string, JevError]>([
    ["no key", { category: "no_key", reason: "no_key" }],
    ["network", { category: "network", reason: "network" }],
    ["timeout", { category: "timeout", reason: "timeout" }],
    ["http 503", { category: "http", reason: "http_503", httpStatus: 503 }],
    ["malformed reply", { category: "malformed", reason: "malformed_json" }]
  ])("Jev unavailable (%s): the fallback answers and nothing throws", async (_label, error) => {
    const { understander: fallback, calls } = countingFallback();
    const u = understanderOn(new FakeJevClient({ fail: error }), fallback);
    await expect(u.assessClarity("Mercury", CTX)).resolves.toEqual({ ...FALLBACK_CLARITY, decidedBy: "fallback" });
    expect(calls.clarity).toBe(1);
  });

  /* MUTATION THAT KILLS THIS: read a missing answer as p = 0. Ran: red (the
     reply without one-episode came back decided by Jev). */
  it("a reply missing one of the two answers counts as unavailable", () => {
    const answers: JevAnswer[] = [{ id: CLARITY_QUESTION_IDS.twoSubjects, type: "noul", noul: 0.1 }];
    const result: JevResult = {
      ok: true,
      answers,
      model: "jev-1.13.0",
      modelMismatch: false,
      usage: { inputTokens: null, outputTokens: null },
      requestId: null,
      latencyMs: 0
    };
    expect(clarityVerdict(result, CLARITY_THRESHOLDS)).toBe("unavailable");
  });

  /* MUTATION THAT KILLS THIS: drop the try/catch around the ask, or catch
     budget errors too. Ran both: red (the throw escaped; the budget stop was
     swallowed into a fallback call). */
  it("a JevClient that throws routes to the fallback; a budget stop propagates", async () => {
    const throwing = { ask: async (): Promise<JevResult> => Promise.reject(new Error("socket hang up")) };
    const { understander: fallback, calls } = countingFallback();
    const u = new JevPromptUnderstander(throwing, fallback, CLARITY_THRESHOLDS, freshGuard().guard);
    await expect(u.assessClarity("Mercury", CTX)).resolves.toMatchObject({ decidedBy: "fallback" });
    expect(calls.clarity).toBe(1);

    const stopped = new BudgetExceededError(2, 0.01, 2);
    const budgetStop = { ask: async (): Promise<JevResult> => Promise.reject(stopped) };
    const v = new JevPromptUnderstander(budgetStop, fallback, CLARITY_THRESHOLDS, freshGuard().guard);
    await expect(v.assessClarity("Mercury", CTX)).rejects.toBe(stopped);
    expect(calls.clarity).toBe(1);
  });

  /* MUTATION THAT KILLS THIS: ask the raw client instead of the metered one.
     Ran: red (no cost event). */
  it("meters the Jev ask through the budget guard with the call's user and session", async () => {
    const { guard, sink } = freshGuard();
    const u = new JevPromptUnderstander(jevSaying(0.1, 0.1), countingFallback().understander, CLARITY_THRESHOLDS, guard);
    await u.assessClarity("Roman siege weapons", CTX);
    const events = await sink.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "jev", operation: CLARITY_JEV_PURPOSE, userId: CTX.userId, sessionId: CTX.sessionId });
  });

  /* MUTATION THAT KILLS THIS: answer extractIntent from a stub instead of
     the fallback. Ran: red. */
  it("extractIntent delegates to the fallback and never asks Jev", async () => {
    const jev = jevSaying(0.1, 0.1);
    const { understander: fallback, calls } = countingFallback();
    expect(await understanderOn(jev, fallback).extractIntent("Roman siege weapons", CTX)).toEqual(FALLBACK_INTENT);
    expect(calls.intent).toBe(1);
    expect(jev.calls).toHaveLength(0);
  });
});

describe("GV-49: the synthetic Jev clarity replies", () => {
  const fx = clarityFixtures();

  it("the fixture asks exactly the module's two question ids", () => {
    expect(fx.questionIds).toEqual(CLARITY_QUESTIONS.map((q) => q.id));
  });

  /* MUTATION THAT KILLS THIS: swap the two thresholds' questions (compare
     two-subjects with oneEpisode's threshold and drop one-episode). Ran: red
     (the one-episode reply came back decided by Jev). */
  it.each(fx.replies.map((r) => [r.name, r] as const))("%s: parsed through the fake JevClient, reaches its expected decider", async (_name, reply) => {
    const parsed = parseJevReply(JSON.stringify(reply.body), CLARITY_QUESTIONS);
    if (!parsed.ok) throw new Error(`fixture ${reply.name} does not parse: ${parsed.reason}`);
    const byId = Object.fromEntries(parsed.answers.map((a) => [a.id, a.type === "noul" ? noulAnswer(a.noul) : a]));
    const jev = new FakeJevClient({ byId, requestId: reply.requestId });
    const { understander: fallback, calls } = countingFallback();
    const result = await understanderOn(jev, fallback).assessClarity(reply.prompt, CTX);
    expect(result.decidedBy).toBe(reply.expect);
    expect(calls.clarity).toBe(reply.expect === "fallback" ? 1 : 0);
  });

  /* MUTATION THAT KILLS THIS: send the questions in a different order from
     the answers' (reverse CLARITY_QUESTIONS for the request only). Ran: red. */
  it.each(fx.replies.map((r) => [r.name, r] as const))("%s: end to end through HttpJevClient on a scripted fetch", async (_name, reply) => {
    const fake = fakeFetch({ body: reply.body, headers: { "x-typesafe-request-id": reply.requestId } });
    const jev = new HttpJevClient({ apiKey: "jev-synthetic-key", baseUrl: "http://jev.invalid", fetchImpl: fake.fetch, warn: () => undefined });
    const seen: JevResult[] = [];
    const recording = {
      ask: async (...args: Parameters<HttpJevClient["ask"]>) => {
        const r = await jev.ask(...args);
        seen.push(r);
        return r;
      }
    };
    const { understander: fallback } = countingFallback();
    const result = await new JevPromptUnderstander(recording, fallback, CLARITY_THRESHOLDS, freshGuard().guard).assessClarity(reply.prompt, CTX);
    expect(fake.calls).toHaveLength(1);
    expect((fake.calls[0]!.body.questions as Array<{ id: string }>).map((q) => q.id)).toEqual(fx.questionIds);
    expect(seen[0]).toMatchObject({ ok: true, requestId: reply.requestId });
    expect(result.decidedBy).toBe(reply.expect);
  });
});

describe("GV-49: createPromptUnderstander's 'jev' clarity route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __setChatProviderForTests(undefined);
  });

  /* MUTATION THAT KILLS THIS: register 'jev' but keep returning the intent
     understander for it. Ran: red. */
  it("FORAY_STAGE_UNDERSTAND_CLARITY=jev wraps the intent understander in a JevPromptUnderstander", () => {
    vi.stubEnv("JEV_API_KEY", "jev-synthetic-key");
    const u = createPromptUnderstander({ FORAY_GENERATION_MODE: "stub", FORAY_STAGE_UNDERSTAND_CLARITY: "jev" });
    expect(u).toBeInstanceOf(JevPromptUnderstander);
    expect(u.providerName).toBe("jev");
    const inner = u as unknown as { jev: unknown; fallback: unknown };
    expect(inner.jev).toBeInstanceOf(HttpJevClient);
    expect(inner.fallback).toBeInstanceOf(StubPromptUnderstander);
  });

  it("jev:<lane> puts GV-47's Qwen judge behind Jev, and the report names the lane", () => {
    vi.stubEnv("JEV_API_KEY", "jev-synthetic-key");
    __setChatProviderForTests(scriptedProvider({ complete: [] }));
    const source = { FORAY_GENERATION_MODE: "stub", FORAY_LLM_BASE_URL: "http://lane.invalid:4000", FORAY_STAGE_UNDERSTAND_CLARITY: "jev:second" };
    const u = createPromptUnderstander(source);
    expect((u as unknown as { jev: unknown }).jev).toBeInstanceOf(FallbackJudgeClient);
    expect(describeStageAssignments({ source })["understand.clarity"]).toEqual({ impl: "jev", model: "jev", machine: "second" });
  });

  /* MUTATION THAT KILLS THIS: drop the key check (a keyless route then gets
     NullJevClient and silently always falls back). Ran: red. */
  it.each(["jev", "jev:second"])("%s without a Jev key throws RoutingConfigError naming JEV_API_KEY", (value) => {
    vi.stubEnv("JEV_API_KEY", "");
    vi.stubEnv("JEV_KEY_FILE", "");
    let err: unknown;
    try {
      createPromptUnderstander({ FORAY_GENERATION_MODE: "stub", FORAY_LLM_BASE_URL: "http://lane.invalid:4000", FORAY_STAGE_UNDERSTAND_CLARITY: value });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("JEV_API_KEY");
  });

  it("with no clarity route set, the default understander is unchanged", () => {
    vi.stubEnv("JEV_API_KEY", "jev-synthetic-key");
    expect(createPromptUnderstander({ FORAY_GENERATION_MODE: "stub" })).toBeInstanceOf(StubPromptUnderstander);
  });
});

describe("GV-49: runForayPipeline carries the decision and resumes old checkpoints", () => {
  const request: GenerationRequest = { prompt: "the Apollo program and the history of jazz", duration: "short", author_id: "founder-1", visibility: "catalogue" };
  const KEY = "gv49-clarity";
  const FP = checkpointFingerprint({ prompt: request.prompt, duration: request.duration });
  const refusing: PromptUnderstander = {
    providerName: "must-not-run",
    assessClarity: () => Promise.reject(new Error("the understand stage should have resumed")),
    extractIntent: () => Promise.reject(new Error("the understand stage should have resumed"))
  };

  /* MUTATION THAT KILLS THIS: leave clarityDecidedBy off the
     needs-clarification outcome, or off UnderstandCheckpointSchema (zod
     strips it on resume). Ran both: red. */
  it("a Jev-routed clarification carries clarityDecidedBy to the outcome and banks it", async () => {
    const store = new FakeCheckpointStore(FP);
    const understander = understanderOn(jevSaying(0.9, 0.1), countingFallback().understander);
    const outcome = await runForayPipeline(request, { userId: "u", checkpointKey: KEY }, { understander, checkpoint: store });
    expect(outcome).toMatchObject({
      outcome: "needs-clarification",
      question: FALLBACK_CLARITY.question,
      readings: FALLBACK_CLARITY.readings,
      clarityDecidedBy: "fallback"
    });
    expect(store.files.get(KEY)?.stages.understand).toMatchObject({ clarityDecidedBy: "fallback" });

    const resumed = await runForayPipeline(request, { userId: "u", checkpointKey: KEY }, { understander: refusing, checkpoint: store });
    expect(resumed).toMatchObject({ outcome: "needs-clarification", clarityDecidedBy: "fallback" });
  });

  it("an understand checkpoint banked without clarityDecidedBy still parses, and the outcome has no such key", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save(KEY, "understand", { outcome: "needs_clarification", clarification: { question: "Which one?", readings: ["a", "b"] } });
    const outcome = await runForayPipeline(request, { userId: "u", checkpointKey: KEY }, { understander: refusing, checkpoint: store });
    expect(outcome).toMatchObject({ outcome: "needs-clarification", question: "Which one?", readings: ["a", "b"] });
    expect(outcome).not.toHaveProperty("clarityDecidedBy");
  });
});
