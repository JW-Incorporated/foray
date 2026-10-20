import { LANE_IDS, type LaneId, type LaneProfile, type LaneProfiles } from "../../config/machineProfiles";
import { defaultUnitBudgetGuard, type MeterUnit, type UnitBudgetGuard, type UnitReservation } from "../../cost/unitBudget";
import { currentCallContext, currentRunLog, type CallContext, type RunLog } from "../runLog";
import { ChatProviderError, type ChatProvider, type ChatRequest, type ChatResponse, type ChatStreamEvent } from "./ChatProvider";

/**
 * GV-93 (docs/roadmap/generation-v2.md, from W2-09; covers R1-08, R1-12,
 * GP-10): the lane scheduler. One LaneScheduledProvider wraps the process's
 * ChatProvider (providerRegistry.ts builds it there), so every local call,
 * from every stage and the Qwen judge, goes through it.
 *
 * WHY. Each stage has its own concurrency gate (narration writes 4 acts at
 * once, deepen all acts, evidence 6 x 2 raced queries, research up to 8
 * calls), and those gates add up past what one shared Spark should take from
 * a single Foray. The Spark is treated as ONE critical stream plus limited
 * background work (R1-08), and a Foray's critical-path calls are first in
 * line (R1-12); the wait is made visible as queueMs on the CallRecord (GP-10).
 *
 * WHAT IT DOES, per call:
 *   - LANE. The request's model names its lane: a local route's model is
 *     always its lane's LiteLLM alias (stageRouting.ts buildRoute), so the
 *     lane whose profile has `modelAlias === req.model` serves it. A model no
 *     lane names passes straight through, unscheduled and unmetered.
 *   - PRIORITY. The call context's explicit `priority` wins; otherwise
 *     criticalFor(stage, act) on the {stage, act} that runPipeline's timed()
 *     and deepenActs already put on the context (GV-01, GV-07). This card
 *     edits neither (roadmap decision 22).
 *   - SLOTS. Each lane has one semaphore of LaneProfile.maxConcurrent slots.
 *     A critical call takes any free slot. A background call also needs the
 *     lane's background in-flight count under maxConcurrent - reservedCritical,
 *     so `reservedCritical` slots are always left for a critical arrival. A
 *     lane always admits at least one background call (a profile with
 *     reservedCritical === maxConcurrent would otherwise never run its
 *     background stages, a deadlock, not a policy).
 *   - QUEUE. Waiting calls are served critical first, FIFO within each class.
 *     A queued call whose AbortSignal fires leaves the queue and rejects with
 *     ChatProviderError kind 'aborted'; it never held a slot.
 *   - queueMs. The wait in acquire rides to the provider as `laneQueueMs` on
 *     the request (ScheduledChatRequest); openAICompatProvider.ts puts it on
 *     the CallRecord's queueMs.
 *   - SERVER PRIORITY. When the lane's profile has serverPriority.enabled,
 *     the request carries `priority` = the profile's critical or background
 *     value (a priority the caller set itself is kept). Off in the default
 *     profiles: lane A2 runs without --enable-priority-scheduling and SGLang's
 *     sign convention is unverified (the card's live step).
 *   - UNIT CAPS (GV-90). Inside its slot, each call runs in
 *     UnitBudgetGuard.metered() with unit sparkSeconds (spark) or
 *     secondBoxSeconds (second), so the per-Foray seconds caps are live on the
 *     local path. The estimate reserved up front is the prompt's prefill time
 *     at the lane's prefill rate (a lower bound: an upper bound from
 *     maxTokens would refuse calls that fit); reconcile charges the call's
 *     wall time, which excludes the queue because metering starts inside the
 *     slot, or the provider's server-side seconds when `serverSeconds` gives
 *     them. A cap refusal releases the slot and throws
 *     UnitBudgetExceededError, which timed() names as a UnitBudgetStopError.
 *
 * THE SESSION a call is metered under: the call context's `sessionId` when
 * one is set there, else one key per RunLog (one pipeline attempt), else none
 * (outside a run nothing is metered). The batch driver does not put its
 * sessionId on the context yet, so today the seconds caps bind per attempt
 * and the report's `unitSpend` (keyed by the checkpoint key) does not include
 * them; the MeterEvents in the run log do.
 *
 * SCOPE. The semaphores govern this process only: other users of the Spark
 * still contend, which is why the server-side priority is the card's live
 * step. The scheduler is active only on local routes (the chat provider is
 * built only for them); the anthropic and stub paths never reach it.
 *
 * KNOWN GAP (#1411): a stream waits for its slot inside its first next(),
 * with no event, and the streamed-writer consumers (writeAct.ts
 * drainWriterStream, ChatNarrationWriterBuilder's chunk bound) count that
 * wait toward their idle bounds, so a background stream queued past 120 s is
 * cut as a stall. Only the streamed writer (FORAY_WRITER_STREAM, or the fast
 * path) is exposed, and it is off by default; #1411 blocks those flips.
 */

/** Stages on the critical path whatever the act. */
const CRITICAL_STAGES: ReadonlySet<string> = new Set(["understand", "topic", "research-shape", "spine", "source"]);

/** Per-act stages whose act 0 is on the critical path (the first act is what
 * plays first); later acts are background. */
const ACT_ZERO_STAGES: ReadonlySet<string> = new Set(["narrate", "stitch", "deepen"]);

/**
 * Is a call made under {stage, act} on the Foray's critical path? Critical
 * for understand, topic, research-shape, spine and source, and for act 0 of
 * narrate, stitch and deepen; background for everything else (evidence,
 * clip-scores, finalize, the judge, later acts, no stage at all). A stage
 * name with an act suffix (`narrate:2`) counts by its base name, and the
 * suffix stands in for a missing `act`.
 */
export function criticalFor(stage: string | null | undefined, act?: number | null): boolean {
  if (typeof stage !== "string" || stage === "") return false;
  const [base = stage, suffix] = stage.split(":");
  if (CRITICAL_STAGES.has(base)) return true;
  if (!ACT_ZERO_STAGES.has(base)) return false;
  const actIndex = act ?? (suffix !== undefined && /^\d+$/.test(suffix) ? Number(suffix) : undefined);
  return actIndex === 0;
}

export type LanePriority = "critical" | "background";

/** The priority of a call made under `ctx`: its explicit `priority`, else criticalFor. */
export function priorityOf(ctx: CallContext): LanePriority {
  if (ctx.priority === "critical" || ctx.priority === "background") return ctx.priority;
  return criticalFor(ctx.stage, ctx.act) ? "critical" : "background";
}

/** A ChatRequest as the scheduler hands it on: `laneQueueMs` is the time it
 * waited for its slot (openAICompatProvider.ts records it as queueMs). */
export interface ScheduledChatRequest extends ChatRequest {
  laneQueueMs?: number;
}

const UNIT_BY_LANE: Readonly<Record<LaneId, MeterUnit>> = { spark: "sparkSeconds", second: "secondBoxSeconds" };

export interface LaneScheduledProviderOptions {
  /** The lane profiles (maxConcurrent, reservedCritical, serverPriority, modelAlias, prefill rate). */
  profiles: LaneProfiles;
  /** The guard the seconds are charged to (default defaultUnitBudgetGuard). */
  unitGuard?: UnitBudgetGuard;
  /** Epoch-milliseconds clock for queueMs (default Date.now; vitest's fake timers drive it). */
  now?: () => number;
  /** The session a call is metered under (default: see the module comment). */
  sessionOf?: () => string | undefined;
  /** The provider's server-side seconds for a reply, when it reports them; wall time otherwise. */
  serverSeconds?: (response: ChatResponse) => number | null | undefined;
}

interface Waiter {
  priority: LanePriority;
  enqueuedAt: number;
  grant: (queueMs: number) => void;
}

/** One lane's slots and queue. */
class LaneGate {
  private inFlight = 0;
  private backgroundInFlight = 0;
  private readonly critical: Waiter[] = [];
  private readonly background: Waiter[] = [];
  private readonly maxConcurrent: number;
  private readonly backgroundCap: number;

  constructor(
    profile: LaneProfile,
    private readonly now: () => number
  ) {
    this.maxConcurrent = Math.max(1, profile.maxConcurrent);
    this.backgroundCap = Math.max(1, this.maxConcurrent - profile.reservedCritical);
  }

  /** Calls in flight now, and of them background (tests and diagnostics). */
  load(): { inFlight: number; backgroundInFlight: number; queued: number } {
    return { inFlight: this.inFlight, backgroundInFlight: this.backgroundInFlight, queued: this.critical.length + this.background.length };
  }

  /** Resolves with the queue wait once a slot is held; the caller must release() it. */
  acquire(priority: LanePriority, signal: AbortSignal | undefined): Promise<number> {
    if (signal?.aborted) return Promise.reject(new ChatProviderError("aborted", "aborted"));
    const enqueuedAt = this.now();
    if (this.queueEmpty(priority) && this.admits(priority)) {
      this.take(priority);
      return Promise.resolve(0);
    }
    return new Promise<number>((resolve, reject) => {
      const queue = priority === "critical" ? this.critical : this.background;
      const onAbort = (): void => {
        const i = queue.indexOf(waiter);
        if (i < 0) return;
        queue.splice(i, 1);
        reject(new ChatProviderError("aborted", "aborted"));
        /* A background waiter leaving can unblock nothing, but a dispatch is
           cheap and keeps the invariant obvious. */
        this.dispatch();
      };
      const waiter: Waiter = {
        priority,
        enqueuedAt,
        grant: (queueMs) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(queueMs);
        }
      };
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(priority: LanePriority): void {
    this.inFlight -= 1;
    if (priority === "background") this.backgroundInFlight -= 1;
    this.dispatch();
  }

  /** FIFO within a class: a new arrival does not jump its own class's queue. */
  private queueEmpty(priority: LanePriority): boolean {
    return priority === "critical" ? this.critical.length === 0 : this.critical.length === 0 && this.background.length === 0;
  }

  private admits(priority: LanePriority): boolean {
    if (this.inFlight >= this.maxConcurrent) return false;
    return priority === "critical" || this.backgroundInFlight < this.backgroundCap;
  }

  private take(priority: LanePriority): void {
    this.inFlight += 1;
    if (priority === "background") this.backgroundInFlight += 1;
  }

  /** Critical waiters first, then background, while slots allow. */
  private dispatch(): void {
    for (;;) {
      const queue = this.critical.length > 0 ? this.critical : this.background;
      const next = queue[0];
      if (next === undefined || !this.admits(next.priority)) {
        /* A blocked critical head must not let background past it: the
           freed slot is its. */
        return;
      }
      queue.shift();
      this.take(next.priority);
      next.grant(Math.max(0, this.now() - next.enqueuedAt));
    }
  }
}

const runLogKeys = new WeakMap<RunLog, string>();
let runLogCounter = 0;

/** The default session: the context's `sessionId`, else one key per RunLog. */
function defaultSessionOf(): string | undefined {
  const fromCtx = currentCallContext().sessionId;
  if (typeof fromCtx === "string" && fromCtx !== "") return fromCtx;
  const log = currentRunLog();
  if (log === undefined) return undefined;
  let key = runLogKeys.get(log);
  if (key === undefined) {
    runLogCounter += 1;
    key = `runlog:${log.t0Iso}#${runLogCounter}`;
    runLogKeys.set(log, key);
  }
  return key;
}

/** Roughly four characters to a token, as askStructured estimates. */
function prefillSeconds(req: ChatRequest, profile: LaneProfile): number {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4) / profile.prefillTokPerSec;
}

export class LaneScheduledProvider implements ChatProvider {
  readonly name: string;
  readonly stream?: (req: ChatRequest) => AsyncIterable<ChatStreamEvent>;
  private readonly profiles: LaneProfiles;
  private readonly gates = new Map<LaneId, LaneGate>();
  private readonly unitGuard: UnitBudgetGuard;
  private readonly now: () => number;
  private readonly sessionOf: () => string | undefined;
  private readonly serverSeconds: ((response: ChatResponse) => number | null | undefined) | undefined;

  constructor(
    readonly inner: ChatProvider,
    opts: LaneScheduledProviderOptions
  ) {
    this.name = inner.name;
    this.profiles = opts.profiles;
    this.unitGuard = opts.unitGuard ?? defaultUnitBudgetGuard;
    this.now = opts.now ?? (() => Date.now());
    this.sessionOf = opts.sessionOf ?? defaultSessionOf;
    this.serverSeconds = opts.serverSeconds;
    for (const lane of LANE_IDS) this.gates.set(lane, new LaneGate(this.profiles[lane], () => this.now()));
    if (typeof inner.stream === "function") this.stream = (req) => this.streamScheduled(req);
  }

  /** The lane whose model alias the request names, or undefined. */
  laneOf(req: ChatRequest): LaneId | undefined {
    return LANE_IDS.find((lane) => this.profiles[lane].modelAlias === req.model);
  }

  /** A lane's current load (tests and diagnostics). */
  load(lane: LaneId): { inFlight: number; backgroundInFlight: number; queued: number } {
    return this.gates.get(lane)!.load();
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const lane = this.laneOf(req);
    if (lane === undefined) return this.inner.complete(req);
    const profile = this.profiles[lane];
    const gate = this.gates.get(lane)!;
    const priority = priorityOf(currentCallContext());
    const queueMs = await gate.acquire(priority, req.signal);
    try {
      const scheduled = this.scheduledRequest(req, profile, priority, queueMs);
      const sessionId = this.sessionOf();
      if (sessionId === undefined) return await this.inner.complete(scheduled);
      const serverSeconds = this.serverSeconds;
      return await this.unitGuard.metered<ChatResponse>(
        {
          sessionId,
          unit: UNIT_BY_LANE[lane],
          estimate: prefillSeconds(req, profile),
          ...(serverSeconds ? { serverSeconds } : {})
        },
        () => this.inner.complete(scheduled)
      );
    } finally {
      gate.release(priority);
    }
  }

  /**
   * The streamed form: the slot is held from the first `next()` until the
   * stream ends. It is released, and the seconds reconciled, just before
   * `done` is handed on, because a consumer that stops at `done` without
   * calling return() leaves this generator suspended and its `finally`
   * unrun (the same reason openAICompatProvider.ts records before `done`).
   */
  private async *streamScheduled(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const innerStream = this.inner.stream!.bind(this.inner);
    const lane = this.laneOf(req);
    if (lane === undefined) {
      yield* innerStream(req);
      return;
    }
    const profile = this.profiles[lane];
    const gate = this.gates.get(lane)!;
    const priority = priorityOf(currentCallContext());
    const queueMs = await gate.acquire(priority, req.signal);
    let settled = false;
    let reservation: UnitReservation | undefined;
    let startMs = this.now();
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (reservation !== undefined) this.unitGuard.reconcile(reservation, (this.now() - startMs) / 1000);
      gate.release(priority);
    };
    try {
      const sessionId = this.sessionOf();
      if (sessionId !== undefined) {
        reservation = await this.unitGuard.reserve({ sessionId, unit: UNIT_BY_LANE[lane], amount: prefillSeconds(req, profile) });
      }
      startMs = this.now();
      for await (const event of innerStream(this.scheduledRequest(req, profile, priority, queueMs))) {
        if (event.type === "done") settle();
        yield event;
      }
    } finally {
      settle();
    }
  }

  private scheduledRequest(req: ChatRequest, profile: LaneProfile, priority: LanePriority, queueMs: number): ScheduledChatRequest {
    const serverPriority = profile.serverPriority;
    const wirePriority =
      req.priority ?? (serverPriority.enabled ? (priority === "critical" ? serverPriority.critical : serverPriority.background) : undefined);
    return { ...req, ...(wirePriority !== undefined ? { priority: wirePriority } : {}), laneQueueMs: queueMs };
  }
}
