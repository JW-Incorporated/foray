import {
  LLM_BASE_URL_ENV,
  resolveRouting,
  RoutingConfigError,
  type RoutingTable,
  type StageRoute,
} from "../config/stageRouting";
import type { LaneId } from "../config/machineProfiles";
import {
  defaultBudgetGuard,
  findBudgetError,
  type BudgetGuard,
} from "../cost/budgetGuard";
import { findUnitBudgetError, type UnitBudgetGuard } from "../cost/unitBudget";
import {
  isSpineJudgeRegistered,
  registerSpineJudge,
  SPINE_JUDGE_ENV,
  type SpineJudge,
  type SpineJudgeChoice,
  type SpineJudgeInput,
} from "./bestOfSpine";
import { criticalFor } from "./chat/laneScheduler";
import type { ChatProvider } from "./chat/ChatProvider";
import { FORAY_REQUEST_USER } from "./chat/providerRegistry";
import {
  CircuitBreaker,
  createJevClient,
  meteredJevClient,
  type CircuitBreakerOptions,
} from "./jevClient";
import type {
  JevChoiceQuestion,
  JevClient,
  JevErrorCategory,
  JevNoulQuestion,
  JevOk,
  JevQuestion,
  JevResult,
  JevState,
  JudgeId,
} from "./jevTypes";
import { currentCallContext, withCallContext } from "./runLog";
import type { SpineSelectionRecord } from "./SpineBuilder";
import {
  isDraftCriticRegistered,
  registerDraftCritic,
  WRITER_CRITIC_ENV,
  type DraftCritic,
  type DraftCritiqueAnswer,
  type DraftCritiqueQuestion,
} from "./selfCritique";

/**
 * GV-97 (W7-11, with W4-16's judge folded in; covers R2-17;
 * docs/roadmap/generation-v2.md): the REAL judges behind GV-91's best-of-2
 * spine (SpineJudge, bestOfSpine.ts) and GV-94's self-critique (DraftCritic,
 * selfCritique.ts), registered under the names FORAY_SPINE_JUDGE and
 * FORAY_WRITER_CRITIC take:
 *
 *   jev            Jev alone (HttpJevClient; NullJevClient without a key, so
 *                  every question is unavailable and the caller keeps its
 *                  primary / flags nothing).
 *   qwen           the Qwen judge (GV-47's QwenJudgeClient) on the judge
 *                  route's local lane: `local:<lane>` when FORAY_STAGE_JUDGE
 *                  routes it there, the fallback lane of `jev:<lane>`, else
 *                  the judge stage's local default, `second`. Needs
 *                  FORAY_LLM_BASE_URL (refused at build time, naming it).
 *   jev-then-qwen  OQ-05: Jev, and on JevUnavailableError (timeout, an HTTP
 *                  error, a malformed body, no key) the Qwen judge. A circuit
 *                  breaker (W2-12, jevClient.ts CircuitBreaker) skips Jev
 *                  after consecutive outages.
 *
 * ONE PROMPT PER QUESTION (the card's integration note). The Jev adapters ask
 * through the JevClient interface; the Qwen judge implements that interface
 * (decision 7), so QwenSpineJudge and QwenDraftCritic are the same adapters
 * over a Qwen client: the spine is a choice question {A, B} (the Qwen judge
 * grammar-constrains `choice` to that enum, thinking off), the sentence a
 * noul question.
 *
 *   spine    choice: instructions = spineJudgeQuestion's text, options A and
 *            B = renderSpineForJudge of the two plans IN THE PRESENTED ORDER
 *            (GV-91 already applied the session-hash swap; this file never
 *            re-orders). Mapped to {index, probabilities [A, B], confidence,
 *            requestId (x-typesafe-request-id), ms, judge}.
 *   critic   noul: 'Is every fact in this sentence stated in the source
 *            text?' over {sentence, sources: [text...]}; p = the noul.
 *
 * W4-16'S RULES, kept here: a choice whose confidence is under the judge's
 * floor (SPINE_JUDGE_CONFIDENCE_FLOOR, PROPOSED) throws
 * SpineJudgeBelowFloorError, and GV-91's wrapper returns the primary for any
 * judge that throws or passes its timeout, so Jev unavailable, a weak
 * preference and a late judge all end on the primary (`spineDecidedBy` reads
 * that as 'fallback-primary').
 *
 * METERING (#1413 item 11). Neither SpineJudge.choose nor
 * DraftCritic.supported carries a ctx, so every ask is metered from the RUN
 * CONTEXT (runLog.ts): meteredJevClient charges BudgetGuard (the dollar run
 * cap, and the per-Foray cap under the context's `sessionId`, which GV-124
 * made the checkpoint key) and, for an ask sent to Jev, reserves one
 * `jevCalls` unit against the decision-22 per-Foray cap (GV-90). A Qwen ask
 * is a $0 local event; its lane seconds are charged by the lane scheduler
 * (GV-93) under the same session. A budget stop (BudgetExceededError,
 * EpisodeBudgetExceededError, UnitBudgetExceededError) is never turned into
 * "unavailable" and never falls back: it propagates out of choose/supported.
 * The cost event's user is FORAY_REQUEST_USER, because the run context has no
 * user id.
 *
 * LANE PRIORITY. The Qwen judge runs its call under stage 'judge', which the
 * lane scheduler ranks background; each ask here first pins the priority the
 * ENCLOSING stage has (criticalFor), so the spine judge (on the critical path
 * of the 'spine' stage) and an act-0 critique stay critical.
 *
 * NO ANTHROPIC PATH. Nothing here imports anthropicCall.ts, the SDK or the
 * relay; Jev is reached only through jevClient.ts, the Qwen judge only through
 * the ChatProvider (LiteLLM).
 *
 * DARK. Nothing reaches these unless FORAY_SPINE_BEST_OF=2 with
 * FORAY_SPINE_JUDGE, or FORAY_WRITER_SELF_CRITIQUE with FORAY_WRITER_CRITIC,
 * names one; both default off. GV-125 (#1413 item 13): the two stage
 * factories (createSpineBuilder.ts, createNarrationWriterBuilder.ts) import
 * this module for its registration, so the names resolve wherever a builder
 * is made; registering builds nothing and reads no variable.
 */

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** The purposes the asks are metered and recorded under. */
export const SPINE_JUDGE_PURPOSE = "spine-judge";
export const DRAFT_CRITIC_PURPOSE = "draft-critic";

export const SPINE_JUDGE_QUESTION_ID = "better_plan";
export const DRAFT_CRITIC_QUESTION_ID = "supported";

/** The choice keys, in the presented order. */
export const SPINE_OPTION_KEYS = ["A", "B"] as const;

export const DRAFT_CRITIC_INSTRUCTIONS =
  "Is every fact in this sentence stated in the source text?";

/**
 * W4-16's confidence floor, per judge (Jev's choice confidence and the Qwen
 * judge's self-reported or logprob confidence are not comparable). Below it
 * the judge declines and the primary is used. PROPOSED: calibrated in E4
 * against the golden set.
 */
export const SPINE_JUDGE_CONFIDENCE_FLOOR: Readonly<Record<JudgeId, number>> =
  Object.freeze({ jev: 0.6, qwen: 0.6 });

/** The names registered in both registries. */
export const JUDGE_NAMES = ["jev", "qwen", "jev-then-qwen"] as const;
export type JudgeName = (typeof JUDGE_NAMES)[number];

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

/** A judge could not answer: the JevClient returned {ok:false} (timeout,
 * HTTP, network, malformed, no key), answered off-shape, or broke its
 * never-throws contract. The fallback judges try the next judge on it. */
export class JevUnavailableError extends Error {
  constructor(
    readonly category: JevErrorCategory,
    readonly reason: string,
    readonly judge: JudgeId,
  ) {
    super(`judge ${judge} unavailable: ${category} (${reason})`);
    this.name = "JevUnavailableError";
  }
}

/** A spine choice under the judge's confidence floor: the judge declines, so
 * GV-91's wrapper returns the primary. Never a reason to ask another judge. */
export class SpineJudgeBelowFloorError extends Error {
  constructor(
    readonly judge: JudgeId,
    readonly confidence: number,
    readonly floor: number,
  ) {
    super(
      `spine judge ${judge} below its confidence floor: ${confidence.toFixed(3)} < ${floor}`,
    );
    this.name = "SpineJudgeBelowFloorError";
  }
}

const isBudgetStop = (err: unknown): boolean =>
  findBudgetError(err) !== null || findUnitBudgetError(err) !== null;

/** Outages that count against the breaker (GV-47's isJudgeOutage rule): the
 * judge was not reached or did not answer in time. */
const isOutage = (err: JevUnavailableError): boolean =>
  (err.category === "timeout" && err.reason !== "aborted") ||
  err.category === "http" ||
  err.category === "network";

/* ------------------------------------------------------------------------ */
/* Questions                                                                 */
/* ------------------------------------------------------------------------ */

/** The spine choice: options A/B are the plans as presented (never re-ordered here). */
export function spineChoiceQuestion(input: SpineJudgeInput): JevChoiceQuestion {
  return {
    id: SPINE_JUDGE_QUESTION_ID,
    type: "choice",
    instructions: input.question,
    criteria: {
      A: { what: input.candidates[0] },
      B: { what: input.candidates[1] },
    },
  };
}

/** What the spine judge reads besides the question: only how to read the
 * options (the plans are the options; LM-25 keeps the state minimal). */
export function spineChoiceState(): JevState {
  return {
    task: "Two candidate plans for one podcast episode. Option A and option B are the plans; pick the better one for the listener's request.",
  };
}

export const DRAFT_CRITIC_QUESTION: Readonly<JevNoulQuestion> = Object.freeze({
  id: DRAFT_CRITIC_QUESTION_ID,
  type: "noul",
  instructions: DRAFT_CRITIC_INSTRUCTIONS,
  criteria: {
    true: "Every fact in the sentence is stated in the source text.",
    false:
      "At least one fact in the sentence is not stated in the source text.",
  },
});

/** The critic's state: the sentence and the source texts only (no document
 * ids, no listener text; LM-25). */
export function draftCritiqueState(q: DraftCritiqueQuestion): JevState {
  return { sentence: q.sentence, sources: q.sources.map((s) => s.text) };
}

/* ------------------------------------------------------------------------ */
/* Metering from the run context                                             */
/* ------------------------------------------------------------------------ */

export interface JudgeMeterOptions {
  /** Default defaultBudgetGuard. */
  guard?: BudgetGuard;
  /** Default the process's defaultUnitBudgetGuard (meteredJevClient's). */
  unitGuard?: UnitBudgetGuard;
  /** The cost event's user (default FORAY_REQUEST_USER: the run context has none). */
  userId?: string;
}

/**
 * One metered ask under the run context: BudgetGuard and the jevCalls unit
 * under the context's sessionId (meteredJevClient), at the enclosing stage's
 * lane priority. A budget stop propagates; anything else a client throws is
 * that judge being unavailable. GV-125 (#1413 item 19): `judge` is the
 * judge the client is (the adapter's), so a Qwen client's throw is labelled
 * 'qwen', not 'jev'.
 */
async function askInRun(
  client: JevClient,
  judge: JudgeId,
  state: JevState,
  questions: readonly JevQuestion[],
  purpose: string,
  meter: JudgeMeterOptions,
): Promise<JevOk> {
  const ctx = currentCallContext();
  const metered = meteredJevClient(client, {
    guard: meter.guard ?? defaultBudgetGuard,
    userId: meter.userId ?? FORAY_REQUEST_USER,
    ...(ctx.sessionId !== undefined && ctx.sessionId !== ""
      ? { sessionId: ctx.sessionId }
      : {}),
    ...(meter.unitGuard ? { unitGuard: meter.unitGuard } : {}),
  });
  const priority =
    ctx.priority ??
    (criticalFor(ctx.stage, ctx.act) ? "critical" : "background");
  let result: JevResult;
  try {
    result = await withCallContext({ priority }, () =>
      metered.ask(state, questions, { purpose }),
    );
  } catch (err) {
    if (isBudgetStop(err)) throw err;
    throw new JevUnavailableError("network", "threw", judge);
  }
  if (!result.ok)
    throw new JevUnavailableError(
      result.error.category,
      result.error.reason,
      result.judge ?? judge,
    );
  return result;
}

/* ------------------------------------------------------------------------ */
/* The spine judges                                                          */
/* ------------------------------------------------------------------------ */

/** A choice as these judges return it: GV-91's SpineJudgeChoice plus the
 * judge that answered and, for the Qwen judge, whether its probabilities are
 * calibrated (logprobs) or self-reported. */
export interface JudgedSpineChoice extends SpineJudgeChoice {
  judge: JudgeId;
  calibrated?: boolean;
}

export interface ClientJudgeOptions extends JudgeMeterOptions {
  /** Epoch-ms clock for `ms` (default Date.now). */
  now?: () => number;
}

export interface SpineJudgeOptions extends ClientJudgeOptions {
  /** Per-judge confidence floors (default SPINE_JUDGE_CONFIDENCE_FLOOR). */
  floors?: Readonly<Record<JudgeId, number>>;
}

/** Jev's (or any JevClient's) choice between the two presented plans. */
export class JevSpineJudge implements SpineJudge {
  readonly kind: string = "jev";
  /** The judge this adapter's client is (GV-125: the label of a throw). */
  protected readonly judgeId: JudgeId = "jev";
  private readonly now: () => number;
  private readonly floors: Readonly<Record<JudgeId, number>>;

  constructor(
    private readonly client: JevClient,
    private readonly opts: SpineJudgeOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.floors = opts.floors ?? SPINE_JUDGE_CONFIDENCE_FLOOR;
  }

  async choose(input: SpineJudgeInput): Promise<JudgedSpineChoice> {
    const startedAt = this.now();
    const question = spineChoiceQuestion(input);
    const result = await askInRun(
      this.client,
      this.judgeId,
      spineChoiceState(),
      [question],
      SPINE_JUDGE_PURPOSE,
      this.opts,
    );
    const judge: JudgeId = result.judge ?? this.judgeId;
    const answer = result.answers.find((a) => a.id === question.id);
    if (answer === undefined || answer.type !== "choice")
      throw new JevUnavailableError("malformed", "answer_type_mismatch", judge);
    const index = SPINE_OPTION_KEYS.indexOf(
      answer.choice as (typeof SPINE_OPTION_KEYS)[number],
    );
    if (index !== 0 && index !== 1)
      throw new JevUnavailableError(
        "malformed",
        "choice_not_in_criteria",
        judge,
      );
    const floor = this.floors[judge];
    if (answer.confidence < floor)
      throw new SpineJudgeBelowFloorError(judge, answer.confidence, floor);
    return {
      index,
      probabilities: SPINE_OPTION_KEYS.map((k) => answer.probabilities[k]!),
      confidence: answer.confidence,
      ...(result.requestId !== null ? { requestId: result.requestId } : {}),
      ms: Math.max(0, this.now() - startedAt),
      judge,
      ...(result.calibrated !== undefined
        ? { calibrated: result.calibrated }
        : {}),
    };
  }
}

/** The Qwen judge's choice: the same adapter over a QwenJudgeClient (a thin
 * alias, not a second prompt; the card's integration note). */
export class QwenSpineJudge extends JevSpineJudge {
  override readonly kind: string = "qwen";
  protected override readonly judgeId: JudgeId = "qwen";
}

/* ------------------------------------------------------------------------ */
/* The draft critics                                                         */
/* ------------------------------------------------------------------------ */

export interface JudgedCritiqueAnswer extends DraftCritiqueAnswer {
  judge: JudgeId;
  calibrated?: boolean;
}

/** Jev's (or any JevClient's) noul: is every fact in the sentence stated in
 * its sources? p is the noul. */
export class JevDraftCritic implements DraftCritic {
  readonly kind: string = "jev";
  /** The judge this adapter's client is (GV-125: the label of a throw). */
  protected readonly judgeId: JudgeId = "jev";
  private readonly now: () => number;

  constructor(
    private readonly client: JevClient,
    private readonly opts: ClientJudgeOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async supported(q: DraftCritiqueQuestion): Promise<JudgedCritiqueAnswer> {
    const startedAt = this.now();
    const result = await askInRun(
      this.client,
      this.judgeId,
      draftCritiqueState(q),
      [DRAFT_CRITIC_QUESTION],
      DRAFT_CRITIC_PURPOSE,
      this.opts,
    );
    const judge: JudgeId = result.judge ?? this.judgeId;
    const answer = result.answers.find(
      (a) => a.id === DRAFT_CRITIC_QUESTION_ID,
    );
    if (answer === undefined || answer.type !== "noul")
      throw new JevUnavailableError("malformed", "answer_type_mismatch", judge);
    return {
      p: answer.noul,
      ...(result.requestId !== null ? { requestId: result.requestId } : {}),
      ms: Math.max(0, this.now() - startedAt),
      judge,
      ...(result.calibrated !== undefined
        ? { calibrated: result.calibrated }
        : {}),
    };
  }
}

/** The Qwen judge's noul: the same adapter over a QwenJudgeClient. */
export class QwenDraftCritic extends JevDraftCritic {
  override readonly kind: string = "qwen";
  protected override readonly judgeId: JudgeId = "qwen";
}

/* ------------------------------------------------------------------------ */
/* OQ-05: Jev, then Qwen                                                     */
/* ------------------------------------------------------------------------ */

/** Why the fallback judge answered (for the record and the tests). */
export interface JudgeFallbackEvent {
  purpose: string;
  /** 'breaker_open' when Jev was skipped, else Jev's error reason. */
  reason: string;
}

export interface FallbackJudgeOptions {
  breaker?: CircuitBreakerOptions;
  onFallback?: (event: JudgeFallbackEvent) => void;
}

/**
 * Tries `first` (Jev) and, on JevUnavailableError only, `second` (the Qwen
 * judge). A budget stop, a below-floor decline or any other error is the
 * answer, never a reason to ask again. Consecutive outages open the breaker,
 * and while it is open `first` is not asked at all; a malformed reply or a
 * missing key falls back without moving it.
 */
async function firstAvailable<T>(
  first: () => Promise<T>,
  second: () => Promise<T>,
  breaker: CircuitBreaker,
  purpose: string,
  onFallback: ((event: JudgeFallbackEvent) => void) | undefined,
): Promise<T> {
  if (!breaker.allowsPrimary()) {
    onFallback?.({ purpose, reason: "breaker_open" });
    return second();
  }
  let answer: T;
  try {
    answer = await first();
  } catch (err) {
    if (!(err instanceof JevUnavailableError)) throw err;
    if (isOutage(err)) breaker.recordOutage();
    onFallback?.({ purpose, reason: err.reason });
    return second();
  }
  breaker.recordSuccess();
  return answer;
}

export class FallbackSpineJudge implements SpineJudge {
  readonly kind = "jev-then-qwen";
  readonly breaker: CircuitBreaker;

  constructor(
    readonly first: SpineJudge,
    readonly second: SpineJudge,
    private readonly opts: FallbackJudgeOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts.breaker);
  }

  choose(input: SpineJudgeInput): Promise<SpineJudgeChoice> {
    return firstAvailable(
      () => this.first.choose(input),
      () => this.second.choose(input),
      this.breaker,
      SPINE_JUDGE_PURPOSE,
      this.opts.onFallback,
    );
  }
}

export class FallbackDraftCritic implements DraftCritic {
  readonly kind = "jev-then-qwen";
  readonly breaker: CircuitBreaker;

  constructor(
    readonly first: DraftCritic,
    readonly second: DraftCritic,
    private readonly opts: FallbackJudgeOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts.breaker);
  }

  supported(q: DraftCritiqueQuestion): Promise<DraftCritiqueAnswer> {
    return firstAvailable(
      () => this.first.supported(q),
      () => this.second.supported(q),
      this.breaker,
      DRAFT_CRITIC_PURPOSE,
      this.opts.onFallback,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* How a best-of-2 call was decided, in W4-16's words                        */
/* ------------------------------------------------------------------------ */

export type SpineDecidedBy =
  "judge" | "only-one-passed" | "fallback-primary" | "none-valid";

/** W4-16's `decidedBy` read off GV-91's selection record: a judged choice is
 * 'judge'; one valid sample 'only-one-passed'; a late secondary or a judge
 * that threw (unavailable, under its floor) or timed out 'fallback-primary'. */
export function spineDecidedBy(
  record: Pick<SpineSelectionRecord, "reason">,
): SpineDecidedBy {
  switch (record.reason) {
    case "judged":
      return "judge";
    case "only-valid":
      return "only-one-passed";
    case "none-valid":
      return "none-valid";
    default:
      return "fallback-primary";
  }
}

/* ------------------------------------------------------------------------ */
/* Clients and the registries                                                */
/* ------------------------------------------------------------------------ */

export interface JudgeFactoryOptions
  extends SpineJudgeOptions, FallbackJudgeOptions {
  /** The Qwen judge's ChatProvider (default the process's, chatProviderFor). */
  chatProvider?: ChatProvider;
}

const providerOf = (
  opts: Pick<JudgeFactoryOptions, "chatProvider">,
): { chatProvider?: ChatProvider } =>
  opts.chatProvider !== undefined ? { chatProvider: opts.chatProvider } : {};

const withJudgeRoute = (
  routing: RoutingTable,
  judge: StageRoute,
): RoutingTable => ({ ...routing, routes: { ...routing.routes, judge } });

/** Jev alone, whatever FORAY_STAGE_JUDGE says: HttpJevClient with a Jev key
 * (JEV_API_KEY / JEV_KEY_FILE), else NullJevClient. */
export function jevOnlyClient(
  source: NodeJS.ProcessEnv = process.env,
  opts: Pick<JudgeFactoryOptions, "chatProvider"> = {},
): JevClient {
  return createJevClient({
    routing: withJudgeRoute(resolveRouting(source), {
      provider: "jev",
      model: "jev",
    }),
    source,
    ...providerOf(opts),
  });
}

/** The lane the Qwen judge runs on: the judge route's local lane, or the
 * fallback lane of a jev:<lane> route, else the judge stage's local default. */
export function qwenJudgeLane(route: StageRoute | undefined): LaneId {
  if (route?.provider === "local" && route.lane !== undefined)
    return route.lane;
  if (route?.fallback !== undefined) return route.fallback.lane;
  return "second";
}

/** The Qwen judge (GV-47's QwenJudgeClient) on `qwenJudgeLane`. Refuses,
 * naming FORAY_LLM_BASE_URL, when no LiteLLM endpoint is configured. */
export function qwenOnlyClient(
  source: NodeJS.ProcessEnv = process.env,
  opts: Pick<JudgeFactoryOptions, "chatProvider"> = {},
  variable: string = LLM_BASE_URL_ENV,
): JevClient {
  const routing = resolveRouting(source);
  if (routing.llmBaseUrl === null && opts.chatProvider === undefined) {
    throw new RoutingConfigError(
      LLM_BASE_URL_ENV,
      `${variable} names a Qwen judge but ${LLM_BASE_URL_ENV} is not set`,
    );
  }
  const lane = qwenJudgeLane(routing.routes.judge);
  return createJevClient({
    routing: withJudgeRoute(routing, {
      provider: "local",
      lane,
      model: routing.profiles[lane].modelAlias,
    }),
    source,
    ...providerOf(opts),
  });
}

/** The spine judge registered under `name`. */
export function buildSpineJudge(
  name: JudgeName,
  source: NodeJS.ProcessEnv = process.env,
  opts: JudgeFactoryOptions = {},
): SpineJudge {
  switch (name) {
    case "jev":
      return new JevSpineJudge(jevOnlyClient(source, opts), opts);
    case "qwen":
      return new QwenSpineJudge(
        qwenOnlyClient(source, opts, SPINE_JUDGE_ENV),
        opts,
      );
    case "jev-then-qwen":
      return new FallbackSpineJudge(
        new JevSpineJudge(jevOnlyClient(source, opts), opts),
        new QwenSpineJudge(qwenOnlyClient(source, opts, SPINE_JUDGE_ENV), opts),
        opts,
      );
  }
}

/** The draft critic registered under `name`. */
export function buildDraftCritic(
  name: JudgeName,
  source: NodeJS.ProcessEnv = process.env,
  opts: JudgeFactoryOptions = {},
): DraftCritic {
  switch (name) {
    case "jev":
      return new JevDraftCritic(jevOnlyClient(source, opts), opts);
    case "qwen":
      return new QwenDraftCritic(
        qwenOnlyClient(source, opts, WRITER_CRITIC_ENV),
        opts,
      );
    case "jev-then-qwen":
      return new FallbackDraftCritic(
        new JevDraftCritic(jevOnlyClient(source, opts), opts),
        new QwenDraftCritic(
          qwenOnlyClient(source, opts, WRITER_CRITIC_ENV),
          opts,
        ),
        opts,
      );
  }
}

/** Registers 'jev', 'qwen' and 'jev-then-qwen' into both registries (GV-91's
 * and GV-94's). Idempotent; runs when this module is first imported. */
export function registerJudges(): void {
  for (const name of JUDGE_NAMES) {
    if (!isSpineJudgeRegistered(name))
      registerSpineJudge(name, (source) => buildSpineJudge(name, source));
    if (!isDraftCriticRegistered(name))
      registerDraftCritic(name, (source) => buildDraftCritic(name, source));
  }
}

registerJudges();
