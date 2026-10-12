import * as fs from "fs";
import * as path from "path";
import type {
  JevAskOptions,
  JevChoiceAnswer,
  JevClient,
  JevError,
  JevNoulAnswer,
  JevQuestion,
  JevResult,
  JevScoreAnswer,
  JevState,
  JevUsage
} from "../../src/generation/jevTypes";

/**
 * GV-20: a scripted JevClient for the judged-gate cards, so no test ever
 * reaches Jev (it is hosted off-network and there are no keys on a dev
 * machine). Deliberately narrow, like fakeChatProvider.ts:
 *
 *   byId   answers a question by its id: an answer, or a function of
 *          (state, question) returning one.
 *   rules  answers by a predicate over (state, question); the first match
 *          wins, consulted only when byId has no entry for the question.
 *   fail   a JevError returned instead of answers (or a function deciding
 *          per call; undefined means answer normally), for the unavailable
 *          paths a gate must handle.
 *
 * Every ask is recorded in `calls` (purpose, state, questions), copied so a
 * caller that mutates its objects afterwards cannot rewrite history. A
 * question nothing answers, or an answer of the wrong type, THROWS: that is
 * a mis-scripted test, and it should be loud rather than look like Jev
 * being down.
 */

export type FakeJevAnswer = Omit<JevNoulAnswer, "id"> | Omit<JevChoiceAnswer, "id"> | Omit<JevScoreAnswer, "id">;
export type FakeJevAnswerer = FakeJevAnswer | ((state: JevState, question: JevQuestion) => FakeJevAnswer);

export interface FakeJevRule {
  when: (state: JevState, question: JevQuestion) => boolean;
  answer: FakeJevAnswerer;
}

export interface FakeJevClientOptions {
  byId?: Record<string, FakeJevAnswerer>;
  rules?: FakeJevRule[];
  fail?: JevError | ((state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions) => JevError | undefined);
  model?: string;
  modelMismatch?: boolean;
  usage?: JevUsage;
  requestId?: string | null;
  latencyMs?: number;
}

export interface FakeJevCall {
  purpose: string;
  state: JevState;
  questions: JevQuestion[];
}

export class FakeJevClient implements JevClient {
  readonly calls: FakeJevCall[] = [];

  constructor(private readonly opts: FakeJevClientOptions = {}) {}

  async ask(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
    this.calls.push({ purpose: opts.purpose, state: structuredClone(state), questions: structuredClone([...questions]) });
    const latencyMs = this.opts.latencyMs ?? 0;
    const fail = typeof this.opts.fail === "function" ? this.opts.fail(state, questions, opts) : this.opts.fail;
    if (fail) return { ok: false, error: { ...fail }, latencyMs };
    const answers = questions.map((q) => {
      const answerer = this.opts.byId?.[q.id] ?? this.opts.rules?.find((r) => r.when(state, q))?.answer;
      if (answerer === undefined) throw new Error(`FakeJevClient: no answer scripted for question '${q.id}'`);
      const answer = typeof answerer === "function" ? answerer(state, q) : answerer;
      if (answer.type !== q.type) {
        throw new Error(`FakeJevClient: question '${q.id}' is ${q.type} but the scripted answer is ${answer.type}`);
      }
      return { ...answer, id: q.id } as JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
    });
    return {
      ok: true,
      answers,
      model: this.opts.model ?? "jev-1.13.0",
      modelMismatch: this.opts.modelMismatch ?? false,
      usage: this.opts.usage ?? { inputTokens: null, outputTokens: null },
      requestId: this.opts.requestId === undefined ? `fake-jev-${this.calls.length}` : this.opts.requestId,
      latencyMs
    };
  }

  /** The calls made for one purpose. */
  callsFor(purpose: string): FakeJevCall[] {
    return this.calls.filter((c) => c.purpose === purpose);
  }
}

/* Answer builders, so a test reads as what Jev said. */

export function noulAnswer(noul: number): Omit<JevNoulAnswer, "id"> {
  return { type: "noul", noul };
}

/** A choice with `confidence` = the chosen option's probability unless given. */
export function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence?: number): Omit<JevChoiceAnswer, "id"> {
  return { type: "choice", choice, probabilities, confidence: confidence ?? probabilities[choice] ?? 1 };
}

/** A score on a `levels`-level card, all probability mass on round(score). */
export function scoreAnswer(score: number, levels: number, confidence = 1): Omit<JevScoreAnswer, "id"> {
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i += 1) probabilities[String(i)] = i === Math.round(score) ? 1 : 0;
  return { type: "score", score, legend: null, probabilities, confidence };
}

/* The committed synthetic bodies (backend/test/fixtures/jev/answers.json). */

export interface JevFixtureFile {
  requestId: string;
  state: Record<string, unknown>;
  questions: JevQuestion[];
  success: Record<string, unknown>;
  successKeyedById: Record<string, unknown>;
  corrupted: Record<string, Record<string, unknown>>;
}

export function jevFixtures(): JevFixtureFile {
  const file = path.join(__dirname, "..", "fixtures", "jev", "answers.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as JevFixtureFile;
}
