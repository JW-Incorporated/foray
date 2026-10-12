import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";
import {
  HttpJevClient,
  NullJevClient,
  createJevClient,
  createJevPool,
  estimateJevUsd,
  jevInputChars,
  meteredJevClient,
  parseJevReply,
  validateJevQuestions,
  JEV_DEFAULT_BASE_URL,
  JEV_PINNED_MODEL,
  type HttpJevClientOptions
} from "../src/generation/jevClient";
import type { JevCallInfo, JevChoiceQuestion, JevClient, JevQuestion, JevResult, JevScoreQuestion } from "../src/generation/jevTypes";
import { RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
import { BudgetGuard, EpisodeBudgetExceededError } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { fakeFetch, type FakeFetchReply } from "./helpers/fakeFetch";
import { FakeJevClient, choiceAnswer, jevFixtures, noulAnswer, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-20 (docs/roadmap/generation-v2.md, from W5-01 + W2-11): the typed Jev
 * client. Offline only: every reply is fakeFetch over the synthetic bodies in
 * test/fixtures/jev/answers.json, and no test reaches Jev (TypeSafe), the
 * Spark or LiteLLM. Each test names the mutation that turns it red.
 */

/* env.ts loads the repo-root .env at import; a developer's JEV_API_KEY there
   must not leak into the "no key" cases. */
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
  config: vi.fn()
}));

const KEY = "jev-synthetic-key-never-leaks-7f3a";
const BASE = "http://jev.invalid";
const fx = jevFixtures();
const QUESTIONS = fx.questions;
const STATE = fx.state;

function clock(start = 5_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function client(reply: FakeFetchReply | FakeFetchReply[], opts: Partial<HttpJevClientOptions> = {}) {
  const fake = fakeFetch(reply);
  const warn = vi.fn();
  const c = new HttpJevClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: fake.fetch, warn, ...opts });
  return { c, fake, warn };
}

const okReply = (body: unknown = fx.success): FakeFetchReply => ({ body, headers: { "x-typesafe-request-id": fx.requestId } });

const ask = (c: JevClient, questions: readonly JevQuestion[] = QUESTIONS, purpose = "probe"): Promise<JevResult> =>
  c.ask(STATE, questions, { purpose });

function expectFailure(res: JevResult): Extract<JevResult, { ok: false }> {
  if (res.ok) throw new Error("expected ok:false");
  return res;
}

function expectOk(res: JevResult): Extract<JevResult, { ok: true }> {
  if (!res.ok) throw new Error(`expected ok:true, got ${res.error.category}/${res.error.reason}`);
  return res;
}

const ENV_KEYS = ["JEV_API_KEY", "JEV_KEY_FILE", "FORAY_JEV_BASE_URL", "FORAY_JEV_MODEL", "FORAY_JEV_BUDGET_MS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe("parseJevReply: valid bodies", () => {
  it("a lone noul answer {noul:0.7} parses, with no confidence or probabilities", () => {
    /* MUTATION THAT KILLS THIS: read the noul field as `p` (raw.p). Ran it — red. */
    const q = QUESTIONS[0]!;
    const res = parseJevReply(JSON.stringify({ answers: [{ type: "noul", noul: 0.7 }] }), [q]);
    expect(res).toEqual({ ok: true, answers: [{ id: "supported", type: "noul", noul: 0.7 }], model: null, usage: { inputTokens: null, outputTokens: null } });
  });

  it("the noul, choice and score success body parses into id-tagged answers, model and usage", () => {
    /* MUTATION THAT KILLS THIS: drop `legend` from the score answer, or read
       usage.input_tokens as outputTokens. Ran both — red. */
    const res = parseJevReply(JSON.stringify(fx.success), QUESTIONS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers).toEqual([
      { id: "supported", type: "noul", noul: 0.7 },
      { id: "best_passage", type: "choice", choice: "o2", probabilities: { o1: 0.1, o2: 0.85, none: 0.05 }, confidence: 0.85 },
      { id: "clarity", type: "score", score: 3, legend: "clear", probabilities: { "0": 0, "1": 0.02, "2": 0.08, "3": 0.7, "4": 0.2 }, confidence: 0.7 }
    ]);
    expect(res.model).toBe("jev-1.13.0");
    expect(res.usage).toEqual({ inputTokens: 512, outputTokens: 9 });
  });

  it("answers keyed by question id come back in question order", () => {
    /* MUTATION THAT KILLS THIS: return Object.values(raw) instead of mapping
       over the questions — the keyed fixture lists them in a different
       order once reversed here. Ran it — red. */
    const keyed = fx.successKeyedById as { answers: Record<string, unknown> };
    const reversed = { ...keyed, answers: Object.fromEntries(Object.entries(keyed.answers).reverse()) };
    const res = parseJevReply(JSON.stringify(reversed), QUESTIONS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.answers.map((a) => a.id)).toEqual(["supported", "best_passage", "clarity"]);
  });

  it("a score legend that is not a string is null, not a failure", () => {
    /* MUTATION THAT KILLS THIS: throw malformed when legend is not a string. Ran it — red. */
    const body = structuredClone(fx.success) as { answers: Array<Record<string, unknown>> };
    body.answers[2]!.legend = ["a", "b"];
    const res = parseJevReply(JSON.stringify(body), QUESTIONS);
    expect(res.ok && res.answers[2]).toMatchObject({ type: "score", legend: null });
  });
});

describe("parseJevReply: every malformed variant is ok:false with a fixed reason, never a throw", () => {
  const cases: Array<[string, string]> = [
    ["type_mismatch", "answer_type_mismatch"],
    ["noul_out_of_range", "noul_out_of_range"],
    ["choice_not_in_criteria", "choice_not_in_criteria"],
    ["probabilities_keyed_wrong", "probabilities_mismatch"],
    ["score_out_of_range", "score_out_of_range"],
    ["score_probabilities_wrong_count", "probabilities_mismatch"],
    ["score_probabilities_extra_key", "probabilities_mismatch"],
    ["confidence_out_of_range", "confidence_out_of_range"],
    ["answer_count_mismatch", "malformed_answers"],
    ["answer_id_mismatch", "answer_id_mismatch"],
    ["answers_missing", "malformed_answers"]
  ];
  it("each corrupted fixture maps to its reason", () => {
    /* MUTATIONS THAT KILL THIS (each ran — red): drop the type check; let
       noul accept 1.3; skip the choice-in-criteria check; read the
       probabilities by the reply's own keys with only a count check; let
       score reach `levels`; skip the confidence range check; drop the
       answer-count check; drop the probabilities key-count check, so a
       score reply with an extra level key "5" passes (review finding). */
    expect(Object.keys(fx.corrupted).sort()).toEqual(cases.map(([name]) => name).sort());
    for (const [name, reason] of cases) {
      const res = parseJevReply(JSON.stringify(fx.corrupted[name]), QUESTIONS);
      expect({ name, res }).toEqual({ name, res: { ok: false, reason } });
    }
  });

  it("a non-JSON body, a non-object body and a bad model field are malformed", () => {
    /* MUTATION THAT KILLS THIS: let JSON.parse throw out of parseJevReply. Ran it — red. */
    expect(parseJevReply("<html>Service Unavailable</html>", QUESTIONS)).toEqual({ ok: false, reason: "malformed_json" });
    expect(parseJevReply("[1,2,3]", QUESTIONS)).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseJevReply("null", QUESTIONS)).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseJevReply(JSON.stringify({ ...fx.success, model: 42 }), QUESTIONS)).toEqual({ ok: false, reason: "malformed_model" });
  });

  it("a choice naming an inherited property (toString) is not one of the criteria", () => {
    /* MUTATION THAT KILLS THIS: test the choice with `raw.choice in
       q.criteria` instead of an own-property check. Ran it — red. */
    const body = structuredClone(fx.success) as { answers: Array<Record<string, unknown>> };
    body.answers[1]!.choice = "toString";
    expect(parseJevReply(JSON.stringify(body), QUESTIONS)).toEqual({ ok: false, reason: "choice_not_in_criteria" });
  });
});

describe("validateJevQuestions: choice 2..255 options, score 2..10 levels (W2-11)", () => {
  const choiceWith = (n: number): JevChoiceQuestion => ({
    id: "c",
    type: "choice",
    instructions: "pick",
    criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, { what: `option ${i}` }]))
  });
  const scoreWith = (n: number): JevScoreQuestion => ({ id: "s", type: "score", instructions: "rate", criteria: Array.from({ length: n }, (_, i) => `level ${i}`) });

  it("accepts the bounds and rejects one past them, duplicate ids and empty criteria", () => {
    /* MUTATION THAT KILLS THIS: raise JEV_CHOICE_MAX_OPTIONS to 256, or drop
       the duplicate-id check. Ran both — red. */
    expect(validateJevQuestions(QUESTIONS)).toBeNull();
    expect(validateJevQuestions([choiceWith(2)])).toBeNull();
    expect(validateJevQuestions([choiceWith(255)])).toBeNull();
    expect(validateJevQuestions([choiceWith(256)])).toBe("invalid_question");
    expect(validateJevQuestions([choiceWith(1)])).toBe("invalid_question");
    expect(validateJevQuestions([scoreWith(2)])).toBeNull();
    expect(validateJevQuestions([scoreWith(10)])).toBeNull();
    expect(validateJevQuestions([scoreWith(1)])).toBe("invalid_question");
    expect(validateJevQuestions([scoreWith(11)])).toBe("invalid_question");
    expect(validateJevQuestions([QUESTIONS[0]!, { ...QUESTIONS[0]! }])).toBe("invalid_question_id");
    expect(validateJevQuestions([{ ...QUESTIONS[0]!, criteria: { true: "yes", false: " " } } as JevQuestion])).toBe("invalid_question");
    expect(validateJevQuestions([])).toBe("no_questions");
  });

  it("an invalid question is reported as malformed and never sent", async () => {
    /* MUTATION THAT KILLS THIS: skip validateJevQuestions in ask(). Ran it — red. */
    const { c, fake } = client(okReply());
    const res = expectFailure(await c.ask(STATE, [choiceWith(256)], { purpose: "probe" }));
    expect(res.error).toEqual({ category: "malformed", reason: "invalid_question" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("HttpJevClient.ask: the request", () => {
  it("POSTs {base}/v1/systemone with {state, model, questions} and a Bearer key, trailing slash trimmed", async () => {
    /* MUTATION THAT KILLS THIS: send `prompt` instead of `state`, or drop the
       pinned model from the body. Ran both — red. */
    const { c, fake } = client(okReply(), { baseUrl: `${BASE}//` });
    expectOk(await ask(c));
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/systemone`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ state: STATE, model: JEV_PINNED_MODEL, questions: QUESTIONS });
  });

  it("returns answers, model, usage, the x-typesafe-request-id and a latency on the injected clock", async () => {
    /* MUTATION THAT KILLS THIS: read requestId from x-request-id. Ran it — red. */
    const c0 = clock();
    const fake = fakeFetch((): FakeFetchReply => {
      c0.advance(37);
      return okReply();
    });
    const c = new HttpJevClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: fake.fetch, now: c0.now, warn: vi.fn() });
    const res = expectOk(await ask(c));
    expect(res.answers.map((a) => a.type)).toEqual(["noul", "choice", "score"]);
    expect(res).toMatchObject({ model: "jev-1.13.0", modelMismatch: false, usage: { inputTokens: 512, outputTokens: 9 }, requestId: fx.requestId, latencyMs: 37 });
  });

  it("a reply from another model is still ok, with modelMismatch and one warning naming both", async () => {
    /* MUTATION THAT KILLS THIS: compare the answered model to itself (always
       false), or return ok:false on a mismatch. Ran both — red. */
    const { c, warn } = client(okReply({ ...fx.success, model: "jev-1.14.0" }));
    const res = expectOk(await ask(c));
    expect(res.model).toBe("jev-1.14.0");
    expect(res.modelMismatch).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("jev-1.13.0");
    expect(warn.mock.calls[0]![0]).toContain("jev-1.14.0");
  });

  it("a reply that names no model is the pinned model, no mismatch", async () => {
    /* MUTATION THAT KILLS THIS: treat a missing model as a mismatch. Ran it — red. */
    const noModel: Record<string, unknown> = { ...fx.success };
    delete noModel.model;
    const { c, warn } = client(okReply(noModel));
    expect(expectOk(await ask(c))).toMatchObject({ model: JEV_PINNED_MODEL, modelMismatch: false });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("HttpJevClient.ask: transport failures map to categories and never throw", () => {
  it("a fetch that never resolves (and ignores its signal) is timeout within the budget", async () => {
    /* MUTATION THAT KILLS THIS: stop racing the abort (await the fetch alone)
       — the deaf fetch hangs the ask. Ran it — red (test timeout). */
    const { c } = client({ hang: "deaf" }, { budgetMs: 20 });
    const started = Date.now();
    const res = expectFailure(await ask(c));
    expect(res.error).toEqual({ category: "timeout", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a network error is network; HTTP 503 is http_503 with the status and none of the body", async () => {
    /* MUTATION THAT KILLS THIS: put the response body into the reason. Ran it — red. */
    const net = expectFailure(await ask(client({ networkError: true }).c));
    expect(net.error).toEqual({ category: "network", reason: "network" });
    const http = expectFailure(await ask(client({ status: 503, body: "upstream overloaded, body-secret-text" }).c));
    expect(http.error).toEqual({ category: "http", reason: "http_503", httpStatus: 503 });
    expect(JSON.stringify(http)).not.toContain("body-secret-text");
  });

  it("a non-JSON 200 body is malformed_json", async () => {
    /* MUTATION THAT KILLS THIS: map a parse failure to network. Ran it — red. */
    const res = expectFailure(await ask(client({ body: "<html>ok</html>" }).c));
    expect(res.error).toEqual({ category: "malformed", reason: "malformed_json" });
  });

  it("a caller's abort is timeout/aborted; an already-aborted signal sends nothing", async () => {
    /* MUTATION THAT KILLS THIS: ignore opts.signal. Ran it — red (the hang
       runs to the 4 s budget and the fetch is called). */
    const pre = client(okReply());
    const res = expectFailure(await pre.c.ask(STATE, QUESTIONS, { purpose: "probe", signal: AbortSignal.abort() }));
    expect(res.error).toEqual({ category: "timeout", reason: "aborted" });
    expect(pre.fake.calls).toHaveLength(0);

    const mid = client({ hang: "honor-signal" });
    const controller = new AbortController();
    const pending = mid.c.ask(STATE, QUESTIONS, { purpose: "probe", signal: controller.signal });
    controller.abort();
    expect(expectFailure(await pending).error).toEqual({ category: "timeout", reason: "aborted" });
  });

  it("no key: createJevClient returns NullJevClient and every ask is no_key, with no request", async () => {
    /* MUTATION THAT KILLS THIS: drop createJevClient's no-key branch. Ran it — red. */
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_KEY_FILE;
    const fake = fakeFetch(okReply());
    const c = createJevClient({ fetchImpl: fake.fetch });
    expect(c).toBeInstanceOf(NullJevClient);
    expect(expectFailure(await ask(c)).error).toEqual({ category: "no_key", reason: "no_key" });
    expect(fake.calls).toHaveLength(0);
  });

  it("the key string never appears in any result, warning, CallRecord or the client itself", async () => {
    /* MUTATION THAT KILLS THIS: store the key as a plain field (this.apiKey)
       — util.inspect shows it. Ran it — red. */
    const replies: FakeFetchReply[] = [
      okReply({ ...fx.success, model: "other-model" }),
      { networkError: true },
      { status: 401, body: `bad key ${KEY}` },
      { body: "not json" }
    ];
    const { c, warn } = client(replies);
    const log = new RunLog();
    const results = await runWithRunLog(log, async () => {
      const out: JevResult[] = [];
      for (let i = 0; i < replies.length; i += 1) out.push(await ask(c));
      return out;
    });
    const timeout = await ask(client({ hang: "deaf" }, { budgetMs: 10 }).c);
    const everything = [JSON.stringify(results), JSON.stringify(timeout), JSON.stringify(warn.mock.calls), log.toJsonl(), JSON.stringify(c), util.inspect(c, { depth: 5, showHidden: true })].join("\n");
    expect(everything).not.toContain(KEY);
  });
});

describe("HttpJevClient.ask: one CallRecord per ask (GV-07)", () => {
  it("with a RunLog active each ask appends one CallRecord: provider jev, role judge, label purpose, latency, usage", async () => {
    /* MUTATION THAT KILLS THIS: drop the record() call, or record role from
       the context instead of 'judge'. Ran both — red. */
    const t = clock(0);
    const log = new RunLog({ now: t.now });
    const fake = fakeFetch((): FakeFetchReply => {
      t.advance(120);
      return okReply();
    });
    const c = new HttpJevClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: fake.fetch, warn: vi.fn() });
    await runWithRunLog(log, () => withCallContext({ stage: "understand", role: "writer" }, () => c.ask(STATE, QUESTIONS, { purpose: "clarity" })));
    const calls = log.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "jev",
      role: "judge",
      stage: "understand",
      label: "clarity",
      model: "jev-1.13.0",
      ms: 120,
      promptTokens: 512,
      outputTokens: 9,
      jsonValid: true
    });
    expect(calls[0]!.error).toBeUndefined();
  });

  it("failures are recorded with their category and status; an invalid question and a NullJevClient record nothing", async () => {
    /* MUTATION THAT KILLS THIS: record only successful asks. Ran it — red. */
    const log = new RunLog();
    await runWithRunLog(log, async () => {
      await ask(client({ status: 503, body: "x" }).c);
      await ask(client({ body: "nope" }).c);
      await client(okReply()).c.ask(STATE, [], { purpose: "probe" });
      await ask(new NullJevClient());
    });
    const calls = log.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ provider: "jev", error: { kind: "http", status: 503 }, jsonValid: null, promptTokens: null });
    expect(calls[1]).toMatchObject({ provider: "jev", error: { kind: "malformed" }, jsonValid: false });
  });
});

describe("meteredJevClient: every ask is metered in one place", () => {
  function guardSpy() {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 100, 100);
    const spy = vi.spyOn(guard, "checkAndRecord");
    return { guard, spy, sink };
  }

  it("calls checkAndRecord once per ask with provider jev, the purpose, the session and the char/4 estimate", async () => {
    /* MUTATION THAT KILLS THIS: meter after the ask instead of before, or
       charge 0.042 per token instead of per million. Ran both — red. */
    const { guard, spy } = guardSpy();
    const inner = new FakeJevClient({ byId: { supported: noulAnswer(0.9), best_passage: choiceAnswer("o1", { o1: 0.8, o2: 0.1, none: 0.1 }), clarity: scoreAnswer(4, 5) } });
    const order: string[] = [];
    spy.mockImplementation(async (input) => {
      order.push(`meter:${inner.calls.length}`);
      return { ...input, id: "e", ts: "t" };
    });
    const c = meteredJevClient(inner, { guard, userId: "u1", sessionId: "sess-1" });
    await c.ask(STATE, QUESTIONS, { purpose: "clip-judge" });
    await c.ask(STATE, QUESTIONS.slice(0, 1), { purpose: "clarity" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["meter:0", "meter:1"]);
    const chars = jevInputChars(STATE, QUESTIONS);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      provider: "jev",
      model: "jev-1.13.0",
      operation: "clip-judge",
      userId: "u1",
      sessionId: "sess-1",
      estimatedUsd: (chars / 4) * 0.042e-6
    });
    expect(estimateJevUsd(STATE, QUESTIONS)).toBeCloseTo((chars / 4) * 0.042e-6, 15);
    expect(spy.mock.calls[1]![0].operation).toBe("clarity");
  });

  it("a per-Foray budget stop propagates and the ask is not sent", async () => {
    /* MUTATION THAT KILLS THIS: catch the guard's error inside the metered
       ask. Ran it — red. */
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100, 0);
    const inner = new FakeJevClient({ byId: { supported: noulAnswer(0.5) } });
    const c = meteredJevClient(inner, { guard, userId: "u1", sessionId: "sess-1" });
    await expect(c.ask(STATE, QUESTIONS.slice(0, 1), { purpose: "clarity" })).rejects.toBeInstanceOf(EpisodeBudgetExceededError);
    expect(inner.calls).toHaveLength(0);
  });

  it("a transport failure does not throw, and onCall reports it with its category and judge 'jev'", async () => {
    /* MUTATION THAT KILLS THIS: skip onCall on a failed ask, or drop
       `category`. Ran both — red. */
    const { guard } = guardSpy();
    const seen: JevCallInfo[] = [];
    const http = client({ networkError: true }).c;
    const c = meteredJevClient(http, { guard, userId: "u1", onCall: (info) => seen.push(info) });
    const res = await ask(c, QUESTIONS, "sentence-support");
    expect(expectFailure(res).error.category).toBe("network");
    expect(seen).toEqual([{ purpose: "sentence-support", ok: false, category: "network", latencyMs: res.latencyMs, usage: null, requestId: null, judge: "jev" }]);

    const okSeen: JevCallInfo[] = [];
    const good = meteredJevClient(client(okReply()).c, { guard, userId: "u1", onCall: (info) => okSeen.push(info) });
    await ask(good);
    expect(okSeen[0]).toMatchObject({ ok: true, category: null, usage: { inputTokens: 512, outputTokens: 9 }, requestId: fx.requestId, judge: "jev" });
  });

  it("an ask on a NullJevClient sends nothing and is not charged", async () => {
    /* MUTATION THAT KILLS THIS: drop the NullJevClient check. Ran it — red. */
    const { guard, spy } = guardSpy();
    const c = meteredJevClient(new NullJevClient(), { guard, userId: "u1" });
    expect(expectFailure(await ask(c)).error.category).toBe("no_key");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createJevPool: bounded fan-out", () => {
  function gatedClient() {
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const sent: string[] = [];
    const c: JevClient = {
      async ask(_state, _questions, opts) {
        sent.push(opts.purpose);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return { ok: false, error: { category: "network", reason: "network" }, latencyMs: 0 };
      }
    };
    return { c, gates, sent, peak: () => peak };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it("never runs more than maxInFlight asks at once, and every ask completes in arrival order", async () => {
    /* MUTATIONS THAT KILL THIS: decrement `running` as well as handing the
       slot to a waiter on release (the count drifts below zero); admit an
       ask when running <= max (three run at once). Ran both — red. */
    const g = gatedClient();
    const pool = createJevPool(g.c, { maxInFlight: 2 });
    const all = Promise.all(["a", "b", "c", "d", "e"].map((p) => pool.ask(STATE, QUESTIONS, { purpose: p })));
    await flush();
    expect(pool.inFlight).toBe(2);
    expect(pool.queued).toBe(3);
    while (g.gates.length > 0) {
      g.gates.shift()!();
      await flush();
    }
    await all;
    expect(g.peak()).toBe(2);
    expect(g.sent).toEqual(["a", "b", "c", "d", "e"]);
    expect(pool.inFlight).toBe(0);
  });

  it("a queued ask whose signal aborts leaves the queue unsent with timeout/aborted", async () => {
    /* MUTATION THAT KILLS THIS: ignore the signal while waiting. Ran it — red. */
    const g = gatedClient();
    const pool = createJevPool(g.c, { maxInFlight: 1 });
    const first = pool.ask(STATE, QUESTIONS, { purpose: "first" });
    const controller = new AbortController();
    const second = pool.ask(STATE, QUESTIONS, { purpose: "second", signal: controller.signal });
    await flush();
    controller.abort();
    expect(expectFailure(await second).error).toEqual({ category: "timeout", reason: "aborted" });
    expect(pool.queued).toBe(0);
    g.gates.shift()!();
    await first;
    expect(g.sent).toEqual(["first"]);
    expect(pool.inFlight).toBe(0);
    expect(() => createJevPool(g.c, { maxInFlight: 0 })).toThrow(/maxInFlight/);
  });
});

describe("FakeJevClient (test/helpers/fakeJevClient.ts)", () => {
  it("answers by question id or by a predicate over state, and records every call", async () => {
    /* MUTATION THAT KILLS THIS: consult rules before byId, or record the
       questions by reference. Ran both — red. */
    const fake = new FakeJevClient({
      byId: { supported: noulAnswer(0.2) },
      rules: [
        { when: (state, q) => q.type !== "choice" && typeof state === "object" && "sentence" in state, answer: (_s, q) => (q.type === "noul" ? noulAnswer(0.9) : scoreAnswer(1, 5)) },
        { when: () => true, answer: choiceAnswer("none", { o1: 0, o2: 0, none: 1 }) }
      ]
    });
    const questions = structuredClone(QUESTIONS);
    const res = expectOk(await fake.ask(STATE, questions, { purpose: "probe" }));
    expect(res.answers.map((a) => a.id)).toEqual(["supported", "best_passage", "clarity"]);
    expect(res.answers[0]).toEqual({ id: "supported", type: "noul", noul: 0.2 });
    expect(res.answers[2]).toMatchObject({ type: "score", score: 1 });
    const other = expectOk(await fake.ask("a plain string state", [QUESTIONS[1]!], { purpose: "other" }));
    expect(other.answers[0]).toMatchObject({ type: "choice", choice: "none" });
    questions[0]!.instructions = "mutated afterwards";
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual({ purpose: "probe", state: STATE, questions: QUESTIONS });
    expect(fake.callsFor("other")).toHaveLength(1);
  });

  it("returns a scripted failure, and throws on an unscripted question or a wrong-typed answer", async () => {
    /* MUTATION THAT KILLS THIS: answer an unscripted question with a default
       instead of throwing. Ran it — red. */
    const down = new FakeJevClient({ fail: { category: "http", reason: "http_503", httpStatus: 503 } });
    expect(expectFailure(await down.ask(STATE, QUESTIONS, { purpose: "p" })).error.reason).toBe("http_503");
    await expect(new FakeJevClient().ask(STATE, QUESTIONS, { purpose: "p" })).rejects.toThrow(/no answer scripted/);
    await expect(new FakeJevClient({ byId: { supported: scoreAnswer(1, 5) } }).ask(STATE, [QUESTIONS[0]!], { purpose: "p" })).rejects.toThrow(/noul/);
  });
});

/* The Jev host and path live in jevClient.ts only. Scanned recursively, so a
   copy under a subfolder (chat/, prompts/) fails too. */
function jevEndpointOffenders(root: string): string[] {
  const offenders: string[] = [];
  const walk = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(root, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.name.endsWith(".ts") || rel === "jevClient.ts") continue;
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      if (src.includes("api.typesafe.ai") || src.includes("/v1/systemone")) offenders.push(rel);
    }
  };
  walk("");
  return offenders;
}

describe("structural: only jevClient.ts names the Jev endpoint", () => {
  it("no other generation module names api.typesafe.ai or /v1/systemone", () => {
    /* MUTATION THAT KILLS THIS: move JEV_DEFAULT_BASE_URL into jevTypes.ts. Ran it — red. */
    expect(jevEndpointOffenders(path.join(__dirname, "..", "src", "generation"))).toEqual([]);
    expect(JEV_DEFAULT_BASE_URL).toBe("https://api.typesafe.ai");
  });

  it("the scan reports a planted offender, nested ones included, and exempts only the top-level jevClient.ts", () => {
    /* MUTATION THAT KILLS THIS: make the scan skip every file, or stop
       recursing. Ran both — red. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv20-guard-"));
    try {
      fs.mkdirSync(path.join(dir, "chat"));
      fs.writeFileSync(path.join(dir, "jevClient.ts"), 'const u = "https://api.typesafe.ai/v1/systemone";\n');
      fs.writeFileSync(path.join(dir, "writeAct.ts"), 'fetch("https://api.typesafe.ai");\n');
      fs.writeFileSync(path.join(dir, "chat", "jevClient.ts"), 'post("/v1/systemone");\n');
      fs.writeFileSync(path.join(dir, "clean.ts"), "export const x = 1;\n");
      expect(jevEndpointOffenders(dir).sort()).toEqual(["chat/jevClient.ts", "writeAct.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config/env.ts: the Jev variables", () => {
  it("JEV_API_KEY wins; else JEV_KEY_FILE's trimmed contents; an empty or missing file is no key", async () => {
    /* MUTATION THAT KILLS THIS: read JEV_KEY_FILE as the key itself, or
       return '' for an empty file. Ran both — red. */
    const { env, envPresenceSummary } = await import("../src/config/env");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv20-key-"));
    try {
      const keyFile = path.join(dir, "jev.key");
      fs.writeFileSync(keyFile, `  ${KEY}\n`);
      const emptyFile = path.join(dir, "empty.key");
      fs.writeFileSync(emptyFile, "\n");
      delete process.env.JEV_API_KEY;
      process.env.JEV_KEY_FILE = keyFile;
      expect(env.jevApiKey).toBe(KEY);
      expect(envPresenceSummary()).toMatchObject({ jevApiKeyPresent: true });
      expect(JSON.stringify(envPresenceSummary())).not.toContain(KEY);
      process.env.JEV_API_KEY = "direct-key";
      expect(env.jevApiKey).toBe("direct-key");
      delete process.env.JEV_API_KEY;
      process.env.JEV_KEY_FILE = emptyFile;
      expect(env.jevApiKey).toBeUndefined();
      process.env.JEV_KEY_FILE = path.join(dir, "missing.key");
      expect(env.jevApiKey).toBeUndefined();
      delete process.env.JEV_KEY_FILE;
      expect(env.jevApiKey).toBeUndefined();
      expect(envPresenceSummary()).toMatchObject({ jevApiKeyPresent: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FORAY_JEV_BUDGET_MS defaults to 4000, accepts a valid value, and a malformed one fails startup naming only the variable", async () => {
    /* MUTATION THAT KILLS THIS: read FORAY_JEV_BUDGET_MS with a silent
       fallback (Number(x) || 4000). Ran it — red. */
    const load = async (value: string | undefined) => {
      vi.resetModules();
      if (value === undefined) delete process.env.FORAY_JEV_BUDGET_MS;
      else process.env.FORAY_JEV_BUDGET_MS = value;
      return import("../src/config/env");
    };
    expect((await load(undefined)).env.jevBudgetMs).toBe(4000);
    expect((await load("2500")).env.jevBudgetMs).toBe(2500);
    for (const bad of ["abc4k", "0", "-5", "1.5", "999999", " "]) {
      await expect(load(bad)).rejects.toThrow("Invalid value for environment variable FORAY_JEV_BUDGET_MS");
      if (bad.trim() !== "") await load(bad).catch((err: Error) => expect(err.message).not.toContain(bad));
    }
  });

  it("createJevClient takes the base URL, model and budget from env when a key is present", async () => {
    /* MUTATION THAT KILLS THIS: ignore env.jevBaseUrl / env.jevModel in
       createJevClient. Ran it — red. */
    vi.resetModules();
    process.env.JEV_API_KEY = KEY;
    process.env.FORAY_JEV_BASE_URL = "http://jev-alt.invalid/";
    process.env.FORAY_JEV_MODEL = "jev-1.13.1";
    process.env.FORAY_JEV_BUDGET_MS = "1500";
    const mod = await import("../src/generation/jevClient");
    const fake = fakeFetch(okReply({ ...fx.success, model: "jev-1.13.1" }));
    const c = mod.createJevClient({ fetchImpl: fake.fetch, warn: vi.fn() });
    expect(c).toBeInstanceOf(mod.HttpJevClient);
    const http = c as InstanceType<typeof mod.HttpJevClient>;
    expect(http.url).toBe("http://jev-alt.invalid/v1/systemone");
    expect(http.model).toBe("jev-1.13.1");
    expect(http.budgetMs).toBe(1500);
    expect(expectOk(await ask(c)).modelMismatch).toBe(false);
    expect(fake.calls[0]!.body.model).toBe("jev-1.13.1");
  });
});
