import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  BestOfTwoSpineBuilder,
  createSpineJudge,
  isSpineJudgeRegistered,
  judgeOrderSwapped,
  renderSpineForJudge,
  spineJudgeQuestion,
  type SpineJudgeInput,
} from "../src/generation/bestOfSpine";
import {
  createDraftCritic,
  isDraftCriticRegistered,
  type DraftCritiqueQuestion,
} from "../src/generation/selfCritique";
import {
  DRAFT_CRITIC_INSTRUCTIONS,
  DRAFT_CRITIC_PURPOSE,
  FallbackDraftCritic,
  FallbackSpineJudge,
  JevDraftCritic,
  JevSpineJudge,
  JevUnavailableError,
  QwenDraftCritic,
  QwenSpineJudge,
  SPINE_JUDGE_PURPOSE,
  SpineJudgeBelowFloorError,
  qwenJudgeLane,
  spineDecidedBy,
  type JudgedCritiqueAnswer,
  type JudgedSpineChoice,
} from "../src/generation/judges";
import { HttpJevClient } from "../src/generation/jevClient";
import { QwenJudgeClient } from "../src/generation/qwenJudgeClient";
import type {
  JevChoiceQuestion,
  JevClient,
  JevNoulQuestion,
} from "../src/generation/jevTypes";
import { __setChatProviderForTests } from "../src/generation/chat/providerRegistry";
import type { ChatRequest } from "../src/generation/chat/ChatProvider";
import {
  currentCallContext,
  RunLog,
  runWithRunLog,
  withCallContext,
  type CallContext,
} from "../src/generation/runLog";
import { BudgetExceededError, BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import {
  UnitBudgetExceededError,
  UnitBudgetGuard,
} from "../src/cost/unitBudget";
import { RoutingConfigError } from "../src/config/stageRouting";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import type {
  SpineBuildContext,
  SpineBuilder,
  SpineSelectionRecord,
} from "../src/generation/SpineBuilder";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import type { DurationTier, Spine } from "../src/types/spine";
import { fakeFetch, type FakeFetchReply } from "./helpers/fakeFetch";
import { FakeJevClient } from "./helpers/fakeJevClient";
import {
  scriptedProvider,
  type ScriptedReply,
} from "./helpers/fakeChatProvider";

/**
 * GV-97 (W7-11, W4-16's judge folded in): the Jev and Qwen-judge adapters
 * behind FORAY_SPINE_JUDGE and FORAY_WRITER_CRITIC, and the OQ-05
 * jev-then-qwen fallback. OFFLINE: Jev replies are the synthetic bodies in
 * fixtures/jev-choice-spine.json and fixtures/jev-noul-sentence.json behind
 * fakeFetch, or a FakeJevClient; the Qwen judge is a real QwenJudgeClient
 * over a scripted ChatProvider; clocks and deadlines are injected. No case
 * reaches Jev, LiteLLM, the Spark or any network.
 */

type JevFixture = {
  _comment: string;
  requestId: string;
  success: unknown;
  weak?: unknown;
  corrupted: unknown;
};
const readFixture = (name: string): JevFixture =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"),
  ) as JevFixture;
const choiceFx = readFixture("jev-choice-spine.json");
const noulFx = readFixture("jev-noul-sentence.json");

const KEY = "jev-synthetic-key-gv97";

function httpJev(reply: FakeFetchReply | FakeFetchReply[]) {
  const fake = fakeFetch(reply);
  const client = new HttpJevClient({
    apiKey: KEY,
    baseUrl: "http://jev.invalid",
    fetchImpl: fake.fetch,
    warn: () => undefined,
  });
  return { client, fake };
}

/** A real QwenJudgeClient over a scripted provider (no network). */
function qwenFake(
  replies: ScriptedReply[] | ((req: ChatRequest) => ScriptedReply),
) {
  const provider = scriptedProvider({ complete: replies });
  const client = new QwenJudgeClient({
    provider,
    model: "local-worker",
    lane: "second",
    structuredOutput: "json_schema",
    logprobs: false,
  });
  return { client, provider };
}

const qwenChoice = (choice: "A" | "B", pA: number): string =>
  JSON.stringify({
    answers: { better_plan: { choice, probabilities: { A: pA, B: 1 - pA } } },
  });
const qwenNoul = (noul: number): string =>
  JSON.stringify({ answers: { supported: { noul } } });

/** Metering kept local to each case: a fresh dollar guard and unit guard. */
function meters(opts: { runUsd?: number; jevCalls?: number } = {}) {
  const sink = new InMemoryCostEventSink();
  const guard = new BudgetGuard(sink, opts.runUsd ?? 100, Infinity);
  const unitGuard = new UnitBudgetGuard({
    overrides: { jevCalls: opts.jevCalls },
  });
  return { sink, guard, unitGuard };
}

const input: SpineJudgeInput = {
  question: "Which of the two plans below would make the better listen?",
  candidates: ["Overview: plan one", "Overview: plan two"],
};
const sentenceQ: DraftCritiqueQuestion = {
  sentence: "The keeper lit the lamp every night.",
  sources: [
    {
      docId: "d1",
      text: "A synthetic passage: the keeper lit the lamp at dusk.",
    },
    { docId: "d2", text: "A second synthetic passage." },
  ],
};

/** Runs `fn` inside a run log and a call context (the session and tier the driver sets). */
function inRun<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return runWithRunLog(new RunLog(), () => withCallContext(ctx, fn));
}

const ENV_KEYS = ["JEV_API_KEY", "JEV_KEY_FILE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  __setChatProviderForTests(undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("JevSpineJudge: the recorded choice body", () => {
  it("maps the choice to the presented index, the probabilities [A, B], the confidence and the x-typesafe-request-id", async () => {
    const { client, fake } = httpJev({
      body: choiceFx.success,
      headers: { "x-typesafe-request-id": choiceFx.requestId },
    });
    const { guard, unitGuard } = meters();
    let t = 1000;
    const judge = new JevSpineJudge(client, {
      guard,
      unitGuard,
      now: () => (t += 7),
    });
    const choice = (await judge.choose(input)) as JudgedSpineChoice;
    expect(choice).toEqual({
      index: 1,
      probabilities: [0.22, 0.78],
      confidence: 0.78,
      requestId: choiceFx.requestId,
      ms: 7,
      judge: "jev",
    });
    /* One ask, one choice question: options A/B are the plans as presented. */
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!.body as { questions: JevChoiceQuestion[] };
    expect(sent.questions).toHaveLength(1);
    expect(sent.questions[0]!.type).toBe("choice");
    expect(sent.questions[0]!.instructions).toBe(input.question);
    expect(sent.questions[0]!.criteria).toEqual({
      A: { what: input.candidates[0] },
      B: { what: input.candidates[1] },
    });
  });

  it("a corrupted body raises JevUnavailableError, and jev-then-qwen then asks the Qwen fake", async () => {
    const { client: jev } = httpJev({ body: choiceFx.corrupted });
    const { guard, unitGuard } = meters();
    await expect(
      new JevSpineJudge(jev, { guard, unitGuard }).choose(input),
    ).rejects.toBeInstanceOf(JevUnavailableError);

    const qwen = qwenFake([qwenChoice("A", 0.9)]);
    const fallbacks: string[] = [];
    const judge = new FallbackSpineJudge(
      new JevSpineJudge(jev, { guard, unitGuard }),
      new QwenSpineJudge(qwen.client, { guard, unitGuard }),
      {
        onFallback: (e) => fallbacks.push(e.reason),
      },
    );
    const choice = (await judge.choose(input)) as JudgedSpineChoice;
    expect(qwen.provider.requests).toHaveLength(1);
    expect(choice.index).toBe(0);
    expect(choice.judge).toBe("qwen");
    expect(choice.calibrated).toBe(false);
    expect(fallbacks).toEqual(["choice_not_in_criteria"]);
    expect(judge.kind).toBe("jev-then-qwen");
  });

  it("the Qwen spine judge is the same question on the Qwen judge: json_schema choice enum [A, B], thinking off", async () => {
    const qwen = qwenFake([qwenChoice("B", 0.1)]);
    const { guard, unitGuard } = meters();
    const choice = (await new QwenSpineJudge(qwen.client, {
      guard,
      unitGuard,
    }).choose(input)) as JudgedSpineChoice;
    expect(choice.index).toBe(1);
    expect(choice.probabilities).toEqual([0.1, 0.9]);
    const req = qwen.provider.requests[0]!;
    expect(req.thinking).toBe(false);
    expect(req.label).toBe(SPINE_JUDGE_PURPOSE);
    expect(req.responseFormat?.type).toBe("json_schema");
    const schema = JSON.stringify(
      (req.responseFormat as { schema: unknown }).schema,
    );
    expect(schema).toContain('"enum":["A","B"]');
  });
});

describe("JevDraftCritic: the recorded noul body", () => {
  it("maps the noul to p with the request id, asking the card's question over the sentence and its sources only", async () => {
    const { client, fake } = httpJev({
      body: noulFx.success,
      headers: { "x-typesafe-request-id": noulFx.requestId },
    });
    const { guard, unitGuard } = meters();
    const answer = (await new JevDraftCritic(client, {
      guard,
      unitGuard,
      now: () => 0,
    }).supported(sentenceQ)) as JudgedCritiqueAnswer;
    expect(answer).toEqual({
      p: 0.82,
      requestId: noulFx.requestId,
      ms: 0,
      judge: "jev",
    });
    const sent = fake.calls[0]!.body as {
      state: unknown;
      questions: JevNoulQuestion[];
    };
    expect(sent.questions[0]!.type).toBe("noul");
    expect(sent.questions[0]!.instructions).toBe(DRAFT_CRITIC_INSTRUCTIONS);
    expect(DRAFT_CRITIC_INSTRUCTIONS).toBe(
      "Is every fact in this sentence stated in the source text?",
    );
    /* No document ids leave the network: the sentence and the source texts. */
    expect(sent.state).toEqual({
      sentence: sentenceQ.sentence,
      sources: sentenceQ.sources.map((s) => s.text),
    });
  });

  it("an unavailable result (a 503, a corrupted body) falls back to the Qwen critic", async () => {
    const { guard, unitGuard } = meters();
    for (const reply of [
      { status: 503, body: "busy" },
      { body: noulFx.corrupted },
    ] as FakeFetchReply[]) {
      const { client: jev } = httpJev(reply);
      await expect(
        new JevDraftCritic(jev, { guard, unitGuard }).supported(sentenceQ),
      ).rejects.toBeInstanceOf(JevUnavailableError);
      const qwen = qwenFake([qwenNoul(0.25)]);
      const critic = new FallbackDraftCritic(
        new JevDraftCritic(jev, { guard, unitGuard }),
        new QwenDraftCritic(qwen.client, { guard, unitGuard }),
      );
      const answer = (await critic.supported(
        sentenceQ,
      )) as JudgedCritiqueAnswer;
      expect(answer.p).toBe(0.25);
      expect(answer.judge).toBe("qwen");
      expect(qwen.provider.requests).toHaveLength(1);
      expect(qwen.provider.requests[0]!.label).toBe(DRAFT_CRITIC_PURPOSE);
    }
  });

  it("a Jev answer never asks the Qwen critic", async () => {
    const { client: jev } = httpJev({ body: noulFx.success });
    const qwen = qwenFake([]);
    const { guard, unitGuard } = meters();
    const critic = new FallbackDraftCritic(
      new JevDraftCritic(jev, { guard, unitGuard }),
      new QwenDraftCritic(qwen.client, { guard, unitGuard }),
    );
    expect((await critic.supported(sentenceQ)).p).toBe(0.82);
    expect(qwen.provider.requests).toHaveLength(0);
  });

  it("an off-shape ok reply (a choice under the noul's id, a choice outside A/B) is unavailable, and jev-then-qwen asks Qwen", async () => {
    const { guard, unitGuard } = meters();
    /* A client that says ok but answers off-shape: HttpJevClient and the
     * fake both refuse to build such a reply, so the adapters' own shape
     * guards are the last line. */
    const okWith = (answers: unknown[]): JevClient => ({
      ask: async () => ({
        ok: true,
        answers: answers as never,
        model: "jev-1.13.0",
        modelMismatch: false,
        usage: { inputTokens: null, outputTokens: null },
        requestId: null,
        latencyMs: 0,
      }),
    });
    const wrongType = okWith([
      { id: "supported", type: "choice", choice: "A", probabilities: { A: 1 }, confidence: 1 },
    ]);
    const err = await new JevDraftCritic(wrongType, { guard, unitGuard })
      .supported(sentenceQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevUnavailableError);
    expect((err as JevUnavailableError).reason).toBe("answer_type_mismatch");
    const qwen = qwenFake([qwenNoul(0.3)]);
    const critic = new FallbackDraftCritic(
      new JevDraftCritic(wrongType, { guard, unitGuard }),
      new QwenDraftCritic(qwen.client, { guard, unitGuard }),
    );
    expect((await critic.supported(sentenceQ)).p).toBe(0.3);

    const outside = okWith([
      { id: "better_plan", type: "choice", choice: "C", probabilities: { A: 0.1, B: 0.1, C: 0.8 }, confidence: 0.9 },
    ]);
    const err2 = await new JevSpineJudge(outside, { guard, unitGuard })
      .choose(input)
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(JevUnavailableError);
    expect((err2 as JevUnavailableError).reason).toBe("choice_not_in_criteria");
  });
});

describe("the OQ-05 breaker", () => {
  it("consecutive outages stop asking Jev; a malformed reply falls back without opening it", async () => {
    const { guard, unitGuard } = meters();
    const down = new FakeJevClient({
      fail: { category: "http", reason: "http_503", httpStatus: 503 },
    });
    const qwen = qwenFake(() => qwenNoul(0.6));
    const critic = new FallbackDraftCritic(
      new JevDraftCritic(down, { guard, unitGuard }),
      new QwenDraftCritic(qwen.client, { guard, unitGuard }),
      {
        breaker: { failuresToOpen: 2, coolOffMs: 60_000 },
      },
    );
    for (let i = 0; i < 4; i++) await critic.supported(sentenceQ);
    expect(down.calls).toHaveLength(2);
    expect(qwen.provider.requests).toHaveLength(4);
    expect(critic.breaker.state).toBe("open");

    const garbled = new FakeJevClient({
      fail: { category: "malformed", reason: "malformed_answers" },
    });
    const critic2 = new FallbackDraftCritic(
      new JevDraftCritic(garbled, { guard, unitGuard }),
      new QwenDraftCritic(qwenFake(() => qwenNoul(0.6)).client, {
        guard,
        unitGuard,
      }),
      {
        breaker: { failuresToOpen: 2 },
      },
    );
    for (let i = 0; i < 4; i++) await critic2.supported(sentenceQ);
    expect(garbled.calls).toHaveLength(4);
    expect(critic2.breaker.state).toBe("closed");
  });
});

/* ------------------------------------------------------------------------ */
/* Inside GV-91's wrapper                                                    */
/* ------------------------------------------------------------------------ */

const guardFor = () => new BudgetGuard(new InMemoryCostEventSink(), 100);

const intent: IntentUnderstanding = {
  subject: "the history of grilling",
  angle: "how an industrial waste product became a backyard ritual",
  priorKnowledge: "knows charcoal grilling exists",
  disappointment: "stays surface-level and never mentions Ford",
};

const research: ResearchShape = {
  subject: "the history of grilling",
  angle: "how an industrial waste product became a backyard ritual",
  generatedAt: "2026-10-14T00:00:00.000Z",
  subtopics: [
    {
      label: "Ford briquette scheme",
      source: "semantic-concept",
      tape: {
        signal: "strong",
        itemCount: 30,
        showCount: 5,
        exampleItemIds: [],
      },
      controversies: [],
      externalNotes: null,
      externallyResearched: false,
      tapeWindows: [],
      windowsUnavailable: "no transcript text index in this fixture",
    },
  ],
  nonObviousAngle: "how an industrial waste product became a backyard ritual",
  externalGapsResearched: [],
};

/** A valid Stub spine with a marked overview, optionally held by a gate. */
class Marked implements SpineBuilder {
  readonly providerName: string;
  readonly built: Spine[] = [];
  private readonly stub = new StubSpineBuilder(guardFor());
  constructor(
    private readonly label: string,
    private readonly gate?: Promise<void>,
  ) {
    this.providerName = `marked-${label}`;
  }
  async buildSpine(
    i: IntentUnderstanding,
    r: ResearchShape,
    d: DurationTier,
    c: SpineBuildContext,
  ): Promise<Spine> {
    if (this.gate) await this.gate;
    const spine = {
      ...(await this.stub.buildSpine(i, r, d, c)),
      overview: `Plan ${this.label}`,
    };
    this.built.push(spine);
    return spine;
  }
}

/** A deadline timer that fires only for the listed waits. */
function fakeTime(fire: number[] = []) {
  let t = 1000;
  return {
    now: () => t,
    sleep: (ms: number) =>
      fire.includes(ms)
        ? Promise.resolve().then(() => void (t += ms))
        : new Promise<void>(() => undefined),
  };
}

function sessionWhere(swapped: boolean): string {
  for (let i = 0; i < 64; i++)
    if (judgeOrderSwapped(`foray-${i}`) === swapped) return `foray-${i}`;
  throw new Error("no session id found");
}

async function bestOf(
  judge: JevSpineJudge | FallbackSpineJudge,
  sessionId: string,
  secondaryGate?: Promise<void>,
) {
  const primary = new Marked("P");
  const secondary = new Marked("S", secondaryGate);
  const time = fakeTime([3000]);
  const wrapper = new BestOfTwoSpineBuilder({
    primary,
    secondary,
    judge,
    graceMs: 3000,
    now: time.now,
    sleep: time.sleep,
  });
  const records: SpineSelectionRecord[] = [];
  const spine = await wrapper.buildSpine(intent, research, "short", {
    userId: "founder-1",
    sessionId,
    observe: (r) => records.push(r),
  });
  return { spine, record: records[0]!, primary, secondary };
}

describe("inside the best-of-2 wrapper (W4-16's acceptance)", () => {
  it("the A/B order in the question is GV-91's renderer under the session hash, and the choice maps back through it", async () => {
    for (const swapped of [false, true]) {
      const fake = new FakeJevClient({
        byId: {
          better_plan: {
            type: "choice",
            choice: "A",
            probabilities: { A: 0.9, B: 0.1 },
            confidence: 0.9,
          },
        },
      });
      const { guard, unitGuard } = meters();
      const { spine, record, primary, secondary } = await bestOf(
        new JevSpineJudge(fake, { guard, unitGuard }),
        sessionWhere(swapped),
      );
      const q = fake.calls[0]!.questions[0] as JevChoiceQuestion;
      const first = swapped ? secondary.built[0]! : primary.built[0]!;
      const second = swapped ? primary.built[0]! : secondary.built[0]!;
      expect(q.criteria).toEqual({
        A: { what: renderSpineForJudge(first) },
        B: { what: renderSpineForJudge(second) },
      });
      expect(q.instructions).toBe(spineJudgeQuestion(intent, {}));
      /* 'A' is the first presented plan: the secondary when swapped. */
      expect(spine.overview).toBe(swapped ? "Plan S" : "Plan P");
      expect(record.chosen).toBe(swapped ? "secondary" : "primary");
      expect(spineDecidedBy(record)).toBe("judge");
    }
  });

  it("Jev unavailable: the primary, decidedBy 'fallback-primary'", async () => {
    const { client } = httpJev({ status: 503, body: "busy" });
    const { guard, unitGuard } = meters();
    const { spine, record } = await bestOf(
      new JevSpineJudge(client, { guard, unitGuard }),
      sessionWhere(true),
    );
    expect(spine.overview).toBe("Plan P");
    expect(record.reason).toBe("judge-failed");
    expect(spineDecidedBy(record)).toBe("fallback-primary");
  });

  it("below the confidence floor: the primary, and jev-then-qwen does not ask Qwen", async () => {
    const { client } = httpJev({ body: choiceFx.weak });
    const { guard, unitGuard } = meters();
    await expect(
      new JevSpineJudge(client, { guard, unitGuard }).choose(input),
    ).rejects.toBeInstanceOf(SpineJudgeBelowFloorError);
    const qwen = qwenFake([]);
    const judge = new FallbackSpineJudge(
      new JevSpineJudge(client, { guard, unitGuard }),
      new QwenSpineJudge(qwen.client, { guard, unitGuard }),
    );
    /* Weak Jev answer 'B' would pick the secondary unswapped; the floor keeps the primary. */
    const { spine, record } = await bestOf(judge, sessionWhere(false));
    expect(spine.overview).toBe("Plan P");
    expect(spineDecidedBy(record)).toBe("fallback-primary");
    expect(qwen.provider.requests).toHaveLength(0);
  });

  it("the secondary past its timeout on the fake clock: the primary, and the judge is never asked", async () => {
    const fake = new FakeJevClient({
      byId: {
        better_plan: {
          type: "choice",
          choice: "B",
          probabilities: { A: 0.1, B: 0.9 },
          confidence: 0.9,
        },
      },
    });
    const { guard, unitGuard } = meters();
    const { spine, record } = await bestOf(
      new JevSpineJudge(fake, { guard, unitGuard }),
      sessionWhere(false),
      new Promise<void>(() => undefined),
    );
    expect(spine.overview).toBe("Plan P");
    expect(record.reason).toBe("secondary-late");
    expect(spineDecidedBy(record)).toBe("fallback-primary");
    expect(fake.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Metering through the run context (#1413 item 11)                          */
/* ------------------------------------------------------------------------ */

describe("metering through the run context and BudgetGuard", () => {
  it("every Jev ask is charged under the context's session and reserves a jevCalls unit; past the cap nothing is sent", async () => {
    const { sink, guard, unitGuard } = meters({ jevCalls: 2 });
    const fake = new FakeJevClient({
      byId: { supported: { type: "noul", noul: 0.9 } },
    });
    const critic = new JevDraftCritic(fake, { guard, unitGuard });
    await inRun({ sessionId: "foray-key-1", tier: "short" }, async () => {
      await critic.supported(sentenceQ);
      await critic.supported(sentenceQ);
      await expect(critic.supported(sentenceQ)).rejects.toBeInstanceOf(
        UnitBudgetExceededError,
      );
    });
    expect(fake.calls).toHaveLength(2);
    expect(unitGuard.spent("foray-key-1").jevCalls).toBe(2);
    const events = await sink.all();
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (e) =>
          e.provider === "jev" &&
          e.sessionId === "foray-key-1" &&
          e.operation === DRAFT_CRITIC_PURPOSE &&
          e.userId === "foray-generation",
      ),
    ).toBe(true);
  });

  it("a Qwen ask is a $0 local event and takes no jevCalls unit", async () => {
    const { sink, guard, unitGuard } = meters({ jevCalls: 0 });
    const qwen = qwenFake(() => qwenNoul(0.7));
    const critic = new QwenDraftCritic(qwen.client, { guard, unitGuard });
    await inRun({ sessionId: "foray-key-2" }, async () => {
      for (let i = 0; i < 3; i++) await critic.supported(sentenceQ);
    });
    expect(unitGuard.spent("foray-key-2").jevCalls).toBe(0);
    const events = await sink.all();
    expect(events).toHaveLength(3);
    expect(
      events.every(
        (e) =>
          e.provider === "local:second" &&
          e.estimatedUsd === 0 &&
          e.sessionId === "foray-key-2",
      ),
    ).toBe(true);
  });

  it("a budget stop propagates through jev-then-qwen: never 'unavailable', never a Qwen ask", async () => {
    const { guard, unitGuard } = meters({ runUsd: 0 });
    const fake = new FakeJevClient({
      byId: {
        better_plan: {
          type: "choice",
          choice: "A",
          probabilities: { A: 0.9, B: 0.1 },
          confidence: 0.9,
        },
      },
    });
    const qwen = qwenFake([]);
    const judge = new FallbackSpineJudge(
      new JevSpineJudge(fake, { guard, unitGuard }),
      new QwenSpineJudge(qwen.client, { guard, unitGuard }),
    );
    await expect(
      inRun({ sessionId: "foray-key-3" }, () => judge.choose(input)),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fake.calls).toHaveLength(0);
    expect(qwen.provider.requests).toHaveLength(0);

    const { guard: g2, unitGuard: u2 } = meters({ jevCalls: 0 });
    const critic = new FallbackDraftCritic(
      new JevDraftCritic(fake, { guard: g2, unitGuard: u2 }),
      new QwenDraftCritic(qwen.client, { guard: g2, unitGuard: u2 }),
    );
    await expect(
      inRun({ sessionId: "foray-key-4" }, () => critic.supported(sentenceQ)),
    ).rejects.toBeInstanceOf(UnitBudgetExceededError);
    expect(qwen.provider.requests).toHaveLength(0);
  });

  it("the Qwen judge's call keeps the enclosing stage's lane priority (the spine and act 0 critical, later acts background)", async () => {
    const seen: Array<Pick<CallContext, "stage" | "priority">> = [];
    const qwen = qwenFake((req) => {
      const ctx = currentCallContext();
      seen.push({ stage: ctx.stage, priority: ctx.priority });
      return req.label === SPINE_JUDGE_PURPOSE
        ? qwenChoice("A", 0.9)
        : qwenNoul(0.7);
    });
    const { guard, unitGuard } = meters();
    await inRun({ stage: "spine" }, () =>
      new QwenSpineJudge(qwen.client, { guard, unitGuard }).choose(input),
    );
    await inRun({ stage: "narrate:0", act: 0 }, () =>
      new QwenDraftCritic(qwen.client, { guard, unitGuard }).supported(
        sentenceQ,
      ),
    );
    await inRun({ stage: "narrate:2", act: 2 }, () =>
      new QwenDraftCritic(qwen.client, { guard, unitGuard }).supported(
        sentenceQ,
      ),
    );
    expect(seen).toEqual([
      { stage: "judge", priority: "critical" },
      { stage: "judge", priority: "critical" },
      { stage: "judge", priority: "background" },
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* The registries                                                            */
/* ------------------------------------------------------------------------ */

describe("registered names", () => {
  it("'jev', 'qwen' and 'jev-then-qwen' are registered as spine judges and draft critics", () => {
    for (const name of ["jev", "qwen", "jev-then-qwen"]) {
      expect(isSpineJudgeRegistered(name)).toBe(true);
      expect(isDraftCriticRegistered(name)).toBe(true);
    }
  });

  it("'jev' is Jev alone through the TS Jev client: the 4 s budget with a key", () => {
    process.env.JEV_API_KEY = KEY;
    const judge = createSpineJudge("jev", {});
    expect(judge.kind).toBe("jev");
    const client = (judge as unknown as { client: JevClient }).client;
    expect(client).toBeInstanceOf(HttpJevClient);
    expect((client as HttpJevClient).budgetMs).toBe(4000);
    expect(createDraftCritic("jev", {}).kind).toBe("jev");
  });

  it("'qwen' without FORAY_LLM_BASE_URL is refused, naming the variable", () => {
    expect(() => createSpineJudge("qwen", {})).toThrow(RoutingConfigError);
    expect(() => createSpineJudge("qwen", {})).toThrow(/FORAY_LLM_BASE_URL/);
    expect(() => createDraftCritic("jev-then-qwen", {})).toThrow(
      /FORAY_LLM_BASE_URL/,
    );
  });

  it("'jev-then-qwen' with no Jev key answers through the routed Qwen judge lane", async () => {
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_KEY_FILE;
    const provider = scriptedProvider({ complete: () => qwenChoice("B", 0.2) });
    __setChatProviderForTests(provider);
    const judge = createSpineJudge("jev-then-qwen", {
      FORAY_LLM_BASE_URL: "http://litellm.invalid:4000",
      FORAY_STAGE_JUDGE: "local:spark",
    });
    expect(judge.kind).toBe("jev-then-qwen");
    const choice = (await judge.choose(input)) as JudgedSpineChoice;
    expect(choice).toMatchObject({ index: 1, judge: "qwen" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.thinking).toBe(false);
    /* FORAY_STAGE_JUDGE=local:spark puts the Qwen judge on the Spark's alias. */
    expect(provider.requests[0]!.model).toBe("local-heavy");
  });

  it("qwenJudgeLane reads the judge route: its local lane, a jev route's fallback lane, else second", () => {
    expect(
      qwenJudgeLane({ provider: "local", lane: "spark", model: "x" }),
    ).toBe("spark");
    expect(
      qwenJudgeLane({
        provider: "jev",
        model: "jev",
        fallback: { provider: "local", lane: "spark", model: "x" },
      }),
    ).toBe("spark");
    expect(qwenJudgeLane({ provider: "none", model: "none" })).toBe("second");
    expect(qwenJudgeLane(undefined)).toBe("second");
  });
});

/* ------------------------------------------------------------------------ */
/* GV-125: the #1413 wave-21 follow-ups                                      */
/* ------------------------------------------------------------------------ */

describe("GV-125: the judges are reachable from the stage factories (#1413 item 13)", () => {
  /* Each case loads ONE factory into a fresh module registry, so this file's
     own import of judges.ts above cannot register the names for it. */
  afterEach(() => {
    vi.resetModules();
  });

  it("importing createSpineBuilder registers the spine judges, and FORAY_SPINE_JUDGE=jev resolves", async () => {
    /* MUTATION THAT KILLS THIS: drop `import "./judges"` from
       createSpineBuilder.ts. Ran it: red (no spine judge is registered and
       createSpineBuilder refuses, naming FORAY_SPINE_JUDGE). */
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_KEY_FILE;
    vi.resetModules();
    const { createSpineBuilder } = await import(
      "../src/generation/createSpineBuilder"
    );
    const fresh = await import("../src/generation/bestOfSpine");
    for (const name of ["jev", "qwen", "jev-then-qwen"])
      expect(fresh.isSpineJudgeRegistered(name)).toBe(true);
    const built = createSpineBuilder({
      FORAY_SPINE_BEST_OF: "2",
      FORAY_STAGE_SPINE_ALT: "stub",
      FORAY_SPINE_JUDGE: "jev",
    });
    expect(built).toBeInstanceOf(fresh.BestOfTwoSpineBuilder);
    expect((built as BestOfTwoSpineBuilder).judge.kind).toBe("jev");
  });

  it("importing createNarrationWriterBuilder registers the draft critics, and FORAY_WRITER_CRITIC=jev-then-qwen resolves", async () => {
    /* MUTATION THAT KILLS THIS: drop `import "./judges"` from
       createNarrationWriterBuilder.ts. Ran it: red (no critic is registered
       and the factory refuses, naming FORAY_WRITER_CRITIC). */
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_KEY_FILE;
    vi.resetModules();
    const { createNarrationWriterBuilder } = await import(
      "../src/generation/createNarrationWriterBuilder"
    );
    const fresh = await import("../src/generation/selfCritique");
    for (const name of ["jev", "qwen", "jev-then-qwen"])
      expect(fresh.isDraftCriticRegistered(name)).toBe(true);
    const built = createNarrationWriterBuilder({
      FORAY_WRITER_SELF_CRITIQUE: "behind-playhead",
      FORAY_WRITER_CRITIC: "jev-then-qwen",
      FORAY_LLM_BASE_URL: "http://litellm.invalid:4000",
    });
    expect(built).toBeInstanceOf(fresh.SelfCritiquingNarrationWriter);
    expect(
      (built as unknown as { critic: { kind: string } }).critic.kind,
    ).toBe("jev-then-qwen");
  });
});

describe("GV-125: the record and the labels", () => {
  it("under jev-then-qwen the selection record names the judge that answered and whether it is calibrated (#1413 item 15)", async () => {
    /* MUTATION THAT KILLS THIS: drop the `answeredBy` spread in
       bestOfSpine.ts's judged record. Ran it: red (answeredBy missing). */
    const { client: jev } = httpJev({ status: 503, body: "busy" });
    const qwen = qwenFake(() => qwenChoice("A", 0.9));
    const { guard, unitGuard } = meters();
    const { record } = await bestOf(
      new FallbackSpineJudge(
        new JevSpineJudge(jev, { guard, unitGuard }),
        new QwenSpineJudge(qwen.client, { guard, unitGuard }),
      ),
      sessionWhere(false),
    );
    expect(record.reason).toBe("judged");
    expect(record.judge).toMatchObject({
      kind: "jev-then-qwen",
      answeredBy: "qwen",
      calibrated: false,
    });

    const fake = new FakeJevClient({
      byId: {
        better_plan: {
          type: "choice",
          choice: "A",
          probabilities: { A: 0.9, B: 0.1 },
          confidence: 0.9,
        },
      },
    });
    const jevAnswered = await bestOf(
      new JevSpineJudge(fake, meters()),
      sessionWhere(false),
    );
    expect(jevAnswered.record.judge).toMatchObject({
      kind: "jev",
      answeredBy: "jev",
    });
  });

  it("a client that throws is labelled with the adapter's own judge: 'qwen' on the Qwen adapters, 'jev' on Jev's (#1413 item 19)", async () => {
    /* MUTATION THAT KILLS THIS: label askInRun's thrown error 'jev' again
       (ignore its `judge` argument). Ran it: red (the Qwen adapters report
       'jev'). */
    const throwing: JevClient = {
      ask: () => Promise.reject(new Error("broke its never-throws contract")),
    };
    const judged = async (p: Promise<unknown>): Promise<unknown> => {
      try {
        await p;
      } catch (err) {
        expect(err).toBeInstanceOf(JevUnavailableError);
        return (err as JevUnavailableError).judge;
      }
      throw new Error("expected a throw");
    };
    const opts = meters();
    expect(
      await judged(new QwenSpineJudge(throwing, opts).choose(input)),
    ).toBe("qwen");
    expect(
      await judged(new QwenDraftCritic(throwing, opts).supported(sentenceQ)),
    ).toBe("qwen");
    expect(
      await judged(new JevSpineJudge(throwing, opts).choose(input)),
    ).toBe("jev");
    expect(
      await judged(new JevDraftCritic(throwing, opts).supported(sentenceQ)),
    ).toBe("jev");
  });
});

describe("no Anthropic path", () => {
  it("judges.ts imports neither the Anthropic SDK, anthropicCall.ts nor the relay", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "generation", "judges.ts"),
      "utf8",
    );
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b|require\(/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/@anthropic-ai|anthropicCall|relay|Anthropic/);
    }
  });
});
