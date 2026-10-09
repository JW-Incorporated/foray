import { env } from "../config/env";
import { costEvents, defaultCostEventSink, type CostEventInput, type CostEventSink } from "./costEvents";

/**
 * Spend caps (01_PROMPT.md #8, corner case 33: "A bug queues 500 episodes for
 * transcription overnight"). Two, and both are PER PROCESS:
 *
 *   - the RUN cap (`RUN_BUDGET_USD`): everything this process may spend, on
 *     every metered call alike — no operation gets a smaller or larger share;
 *   - the per-Foray cap (`EPISODE_BUDGET_USD`): one generation run's spend,
 *     for calls that carry a `sessionId`.
 *
 * Per process because the sink is in memory (costEvents.ts): a second
 * process starts at $0. That is by design until a multi-process generator
 * exists (docs/DECISIONS.md 2026-10-07); the run cap used to be called a
 * "daily" cap, and its name now says what it does.
 *
 * Every LLM/TTS call site should call `budgetGuard.checkAndRecord(...)`
 * rather than writing to costEvents directly, so the cap is structurally
 * impossible to bypass by accident.
 */

/** Thrown when a call would push this process's total spend past the RUN cap. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly attemptedUsd: number,
    public readonly capUsd: number
  ) {
    super(
      `Run budget exceeded (RUN_BUDGET_USD): spent $${spentUsd.toFixed(4)} + attempted $${attemptedUsd.toFixed(4)} > cap $${capUsd.toFixed(4)}`
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Thrown when a single Foray's generation run (scoped by `sessionId`) would
 * spend past the founder-approved per-Foray ceiling (docs/curation/
 * generation-architecture.md §9.2, ~$5-10/Foray, default env.episodeBudgetUsd).
 * Distinct from BudgetExceededError (the per-process run cap) — a call can
 * trip either, both, or neither independently.
 */
export class EpisodeBudgetExceededError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly spentUsd: number,
    public readonly attemptedUsd: number,
    public readonly capUsd: number
  ) {
    super(
      `Per-Foray budget exceeded for session ${sessionId}: spent $${spentUsd.toFixed(4)} + attempted $${attemptedUsd.toFixed(4)} > cap $${capUsd.toFixed(4)}`
    );
    this.name = "EpisodeBudgetExceededError";
  }
}

/**
 * Thrown by the pipeline (not by this class) when a budget error escaped a
 * STAGE, so the message names what the raw guard cannot know: which stage was
 * running and how far the Foray got.
 *
 * WHY IT EXISTS. Run 1 needed `DAILY_BUDGET_USD=1000` (now `RUN_BUDGET_USD`)
 * to start at all (F-04 / I-01), and the reason the shipped default was never
 * noticed is that the guard's own message is stage-blind: "spent $1.9970 +
 * attempted $0.0240 > cap $2.0000" is true, is unactionable, and reads
 * identically whether it stopped the spine call or beat 23 of 31. This
 * error carries the stage name, the spend so far, and — because F-17/F-18's
 * checkpoint means the work is on disk — the resume instruction.
 */
export class BudgetStopError extends Error {
  constructor(
    public readonly stage: string,
    public readonly spentUsd: number,
    public readonly capUsd: number,
    public readonly scope: "run" | "per-foray",
    public readonly cause: BudgetExceededError | EpisodeBudgetExceededError,
    resumeHint?: string
  ) {
    super(
      `Budget stop in stage "${stage}": the ${scope} cap of $${capUsd.toFixed(2)} was reached ` +
        `(spent $${spentUsd.toFixed(4)}; this call would have added $${cause.attemptedUsd.toFixed(4)}). ` +
        (resumeHint ? `${resumeHint} ` : "") +
        `Raise the cap with --budget-usd (or ${scope === "run" ? "RUN_BUDGET_USD" : "EPISODE_BUDGET_USD"}) and re-run.`
    );
    this.name = "BudgetStopError";
  }
}

/** True for the two errors this module throws, so a caller can re-wrap them
 * without importing both classes and writing the same `instanceof` pair. */
export function isBudgetError(err: unknown): err is BudgetExceededError | EpisodeBudgetExceededError {
  return err instanceof BudgetExceededError || err instanceof EpisodeBudgetExceededError;
}

/**
 * Finds a budget error inside a wrapper, or returns null.
 *
 * WHY THIS IS NOT JUST `isBudgetError`. §4.4's `deepenOneActWithRetry` catches
 * everything an act's build throws, retries once, and then re-throws its own
 * `ActDeepeningError` with the original on `cause`. A budget stop inside act 2
 * therefore reaches the pipeline as "Deepening act 2 failed after 1 retry",
 * with the dollar figures buried a level down — which is precisely the
 * unactionable message F-04 is about, one wrapper further out. Any stage that
 * wraps its failures gets the same treatment for free by walking the chain.
 */
export function findBudgetError(err: unknown): BudgetExceededError | EpisodeBudgetExceededError | null {
  let current: unknown = err;
  /* Bounded: a `cause` cycle would otherwise hang the process on the way to
     reporting an error, which is a worse failure than the one being reported. */
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (isBudgetError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export class BudgetGuard {
  constructor(
    private readonly sink: CostEventSink = defaultCostEventSink,
    private runBudgetUsd: number = env.runBudgetUsd,
    private episodeBudgetUsd: number = env.episodeBudgetUsd
  ) {}

  /**
   * Re-caps this guard for the rest of the process.
   *
   * WHY A SETTER RATHER THAN A SECOND GUARD. Every `Anthropic*Builder`
   * defaults to `defaultBudgetGuard`, a module-level singleton built from
   * `env` at import time, and the batch driver's `--budget-usd` flag is parsed
   * long after that import has happened. The alternatives were worse: mutating
   * `process.env` before the first import makes the caps depend on module
   * order, and threading a guard instance through seven `create*()` factories
   * changes seven public signatures to move one number.
   *
   * Deliberately NOT a general escape hatch — it only ever RAISES or LOWERS a
   * declared ceiling from a place a human typed a number (a CLI flag), and it
   * cannot remove the ceiling: a non-finite or negative value is ignored.
   */
  setCaps(caps: { runUsd?: number; episodeUsd?: number }): void {
    if (caps.runUsd !== undefined && Number.isFinite(caps.runUsd) && caps.runUsd >= 0) {
      this.runBudgetUsd = caps.runUsd;
    }
    if (caps.episodeUsd !== undefined && Number.isFinite(caps.episodeUsd) && caps.episodeUsd >= 0) {
      this.episodeBudgetUsd = caps.episodeUsd;
    }
  }

  /** The caps currently in force — for a run log, so a report records the
   * ceiling the run actually had rather than the one in `.env`. */
  caps(): { runUsd: number; episodeUsd: number } {
    return { runUsd: this.runBudgetUsd, episodeUsd: this.episodeBudgetUsd };
  }

  /**
   * Throws BudgetExceededError if recording `estimatedUsd` would push this
   * process's total spend past the run cap (every operation alike), or
   * EpisodeBudgetExceededError if `input.sessionId` is set and recording
   * would push that single Foray's generation-run spend past
   * `episodeBudgetUsd` (docs/curation/generation-architecture.md §9.2).
   * The episode check is purely additive: callers that never pass
   * `sessionId`, or a sink that doesn't implement `sumUsdBySession`, see
   * no behavior change from before this check existed.
   */
  checkAndRecord(input: CostEventInput): ReturnType<CostEventSink["record"]> {
    /* backend-rest-13: check and record are serialised per guard. They are
       separate awaited steps, so N concurrent callers (narration acts run
       NARRATION_ACT_CONCURRENCY at once) all read the same `spent`, all
       passed the cap, and all recorded: spend overshot by (N-1) estimates. A
       promise chain makes each call see every earlier call's record. A
       rejected call does not poison the chain. */
    const run = this.lock.then(() => this.checkAndRecordNow(input));
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Tail of the check-and-record chain (see checkAndRecord). */
  private lock: Promise<void> = Promise.resolve();

  private async checkAndRecordNow(input: CostEventInput) {
    const cap = this.runBudgetUsd;
    const spent = await this.sink.sumUsd();

    if (spent + input.estimatedUsd > cap) {
      throw new BudgetExceededError(spent, input.estimatedUsd, cap);
    }

    if (input.sessionId && this.sink.sumUsdBySession && Number.isFinite(this.episodeBudgetUsd)) {
      const spentThisEpisode = await this.sink.sumUsdBySession(input.sessionId);
      if (spentThisEpisode + input.estimatedUsd > this.episodeBudgetUsd) {
        throw new EpisodeBudgetExceededError(input.sessionId, spentThisEpisode, input.estimatedUsd, this.episodeBudgetUsd);
      }
    }

    return this.sink.record(input);
  }

  /** What this guard's sink holds — this process's spend so far. */
  async spentThisRun(): Promise<number> {
    return this.sink.sumUsd();
  }

  async remainingThisRun(): Promise<number> {
    const spent = await this.spentThisRun();
    return Math.max(0, this.runBudgetUsd - spent);
  }

  /** Spend so far for a single Foray's generation run, or 0 if the sink can't scope by session. */
  async spentThisEpisode(sessionId: string): Promise<number> {
    if (!this.sink.sumUsdBySession) return 0;
    return this.sink.sumUsdBySession(sessionId);
  }
}

/** Process-wide default guard, wired to the default in-memory sink and env budget. */
export const defaultBudgetGuard = new BudgetGuard(defaultCostEventSink, env.runBudgetUsd, env.episodeBudgetUsd);

// re-export so call sites can `import { costEvents } from "../cost/budgetGuard"` if preferred
export { costEvents };
