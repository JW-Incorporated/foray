/**
 * GV-20 (docs/roadmap/generation-v2.md, from W5-01 + W2-11): the typed
 * questions and answers of Jev, TypeSafe's hosted typed-decision model.
 * Types only; the client, its validation and its wrappers are jevClient.ts.
 *
 * Wire contract, ported from hermes-operating-system jevclient.py
 * (@64b63f53 :29-43, :431-530) as the roadmap card records it:
 *
 *   noul    {type:'noul', instructions, criteria:{true, false}}
 *           -> {type:'noul', noul: 0..1}. The field is `noul`, not `p`, and a
 *              noul answer carries no confidence or probabilities.
 *   choice  {type:'choice', instructions, criteria: {<optionId>: {what}}}
 *           -> {type:'choice', choice, probabilities: {<optionId>: p}, confidence}
 *   score   {type:'score', instructions, criteria: string[]}  (levels, 0-based)
 *           -> {type:'score', score in [0, levels-1], legend,
 *               probabilities keyed '0'..'n-1', confidence}.
 *              On a 5-level card, "4 or more" means score >= 3.
 *
 * Every question carries an `id` chosen by the caller; answers come back
 * with the same id so a caller (and FakeJevClient) can look them up.
 */

/** Option counts and level counts the client accepts (W2-11, like jevclient.py). */
export const JEV_CHOICE_MIN_OPTIONS = 2;
export const JEV_CHOICE_MAX_OPTIONS = 255;
export const JEV_SCORE_MIN_LEVELS = 2;
export const JEV_SCORE_MAX_LEVELS = 10;

/** What Jev is asked about. Keep it minimal: it leaves the network (LM-25). */
export type JevState = string | Record<string, unknown>;

export interface JevNoulQuestion {
  id: string;
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface JevChoiceQuestion {
  id: string;
  type: "choice";
  instructions: string;
  criteria: Record<string, { what: string }>;
}

export interface JevScoreQuestion {
  id: string;
  type: "score";
  instructions: string;
  /** One description per level, level 0 first. */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestionType = JevQuestion["type"];

export interface JevNoulAnswer {
  id: string;
  type: "noul";
  /** Probability that the `true` criterion holds, 0..1. */
  noul: number;
}

export interface JevChoiceAnswer {
  id: string;
  type: "choice";
  /** One of the question's criteria keys. */
  choice: string;
  /** Keyed exactly by the question's criteria keys. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  id: string;
  type: "score";
  /** In [0, levels - 1]; may be fractional. */
  score: number;
  /** Jev's label for the answered level, when it sends a string; else null. */
  legend: string | null;
  /** Keyed exactly '0'..'n-1'. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

/** The answer type that belongs to a question type. */
export type JevAnswerFor<Q extends JevQuestion> = Extract<JevAnswer, { type: Q["type"] }>;

/** Token counts Jev reported; a count it did not report is null, never 0. */
export interface JevUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** GV-47: the judges that answer through the JevClient interface: Jev
 * itself, and the Qwen judge (qwenJudgeClient.ts, OQ-05's fallback). */
export const JUDGE_IDS = ["jev", "qwen"] as const;
export type JudgeId = (typeof JUDGE_IDS)[number];

export type JevErrorCategory = "no_key" | "network" | "timeout" | "http" | "malformed";

/** `reason` is always a fixed string chosen by the client (e.g. 'http_503',
 * 'malformed_json'): never a response body, never the key. */
export interface JevError {
  category: JevErrorCategory;
  reason: string;
  httpStatus?: number;
}

export interface JevOk {
  ok: true;
  /** One per question, in question order, each carrying its question's id. */
  answers: JevAnswer[];
  /** The model that answered (the pinned model when the response names none). */
  model: string;
  /** True when the response named a model other than the pinned one (W2-11). */
  modelMismatch: boolean;
  usage: JevUsage;
  /** The x-typesafe-request-id header, or null when absent. */
  requestId: string | null;
  latencyMs: number;
  /** GV-47: which judge answered. Absent means Jev (HttpJevClient does not
   * set it); QwenJudgeClient and FallbackJudgeClient always do, so a
   * consumer reads its thresholds per judge (gateConfig.ts judgeThreshold). */
  judge?: JudgeId;
  /** GV-47: false when the probabilities are the judge's own self-report
   * rather than token logprobs (QwenJudgeClient sets it; absent for Jev). */
  calibrated?: boolean;
}

export interface JevFailure {
  ok: false;
  error: JevError;
  latencyMs: number;
  /** GV-47: the judge whose failure this is (absent means Jev). */
  judge?: JudgeId;
}

export type JevResult = JevOk | JevFailure;

export interface JevAskOptions {
  /** What the call is for (a short label, e.g. 'clarity', 'clip-judge'). It
   * labels the CallRecord and the cost event; it is never sent to Jev. */
  purpose: string;
  signal?: AbortSignal;
}

/**
 * The one interface every Jev caller depends on. `ask` NEVER throws on a
 * transport, HTTP or parse failure: those come back as `{ok:false}` so a
 * gate can treat "Jev unavailable" as a first-class result. The only thing
 * allowed to throw out of an ask is a budget stop (meteredJevClient), which
 * propagates like every other model call's.
 */
export interface JevClient {
  ask(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult>;
}

/** The hook meteredJevClient calls after every ask (R1-14 per-call records,
 * R1-19 Jev-call caps). */
export interface JevCallInfo {
  purpose: string;
  ok: boolean;
  category: JevErrorCategory | null;
  latencyMs: number;
  usage: JevUsage | null;
  requestId: string | null;
  /** Which judge answered (GV-47): 'qwen' when the Qwen judge did. */
  judge: JudgeId;
}
