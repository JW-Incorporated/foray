import { env } from "../config/env";
import { currentCallContext, currentRunLog } from "../generation/runLog";

/**
 * GV-90 (docs/roadmap/generation-v2.md, from W1-08; R1-19, MT-10): per-Foray
 * UNIT caps for the local pipeline.
 *
 * WHY A SECOND GUARD. BudgetGuard (budgetGuard.ts) caps DOLLARS, and every
 * local model call is priced at $0: a runaway rewrite loop on the Spark would
 * spend nothing and never stop, taking the next listener's Spark slot. This
 * guard caps what local work actually costs, per Foray (per `sessionId`):
 *
 *   - sparkSeconds      seconds of the DGX Spark (Qwen behind LiteLLM);
 *   - secondBoxSeconds  seconds of the second box (the P40 / V100 host);
 *   - jevCalls          asks sent to Jev (TypeSafe's hosted judge).
 *
 * The dollar guard stays as it is and keeps metering Jev's input tokens at
 * $0.042 per million (provider 'jev'); this guard counts Jev CALLS beside it.
 *
 * INERT UNTIL CALLED. Nothing here runs unless a caller reserves: the lane
 * scheduler (GV-93) wraps Spark and second-box calls in `metered()`, and
 * `meteredJevClient` (jevClient.ts) reserves one `jevCalls` unit per ask that
 * goes to Jev under a session. The Anthropic / relay path never meters
 * seconds. With no caller, no run changes.
 *
 * PER PROCESS, like the dollar sink: spend lives in memory, keyed by session.
 * The batch driver's session is the checkpoint key, stable across a resume,
 * so the automatic resumes of one prompt share that prompt's caps.
 */

export type MeterUnit = "sparkSeconds" | "secondBoxSeconds" | "jevCalls";

export const METER_UNITS: readonly MeterUnit[] = ["sparkSeconds", "secondBoxSeconds", "jevCalls"];

export type UnitTier = "short" | "medium" | "long";

export type UnitAmounts = Record<MeterUnit, number>;

/**
 * The caps by duration tier. INITIAL GUESSES, to be retuned after the first
 * golden-set run on the Spark (the card's live step: spark_s per tier).
 */
export const DEFAULT_UNIT_CAPS: Readonly<Record<UnitTier, Readonly<UnitAmounts>>> = {
  short: { sparkSeconds: 120, secondBoxSeconds: 180, jevCalls: 250 },
  medium: { sparkSeconds: 600, secondBoxSeconds: 900, jevCalls: 1000 },
  long: { sparkSeconds: 1500, secondBoxSeconds: 2400, jevCalls: 2500 }
};

/** A call that names no tier (and runs outside a tiered call context) is
 * held to the most generous tier's caps: bounded, but never stopped earlier
 * than a real tier would be. */
export const UNTIERED_CAPS_TIER: UnitTier = "long";

/** The variable that overrides each unit's cap (read in config/env.ts). */
export const UNIT_CAP_ENV_VAR: Readonly<Record<MeterUnit, string>> = {
  sparkSeconds: "FORAY_SPARK_SECONDS_PER_FORAY",
  secondBoxSeconds: "FORAY_SECOND_BOX_SECONDS_PER_FORAY",
  jevCalls: "FORAY_JEV_CALLS_PER_FORAY"
};

function isTier(value: unknown): value is UnitTier {
  return value === "short" || value === "medium" || value === "long";
}

/** Seconds units are charged what the call took; a count unit its estimate. */
function isSecondsUnit(unit: MeterUnit): boolean {
  return unit !== "jevCalls";
}

function figure(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Thrown by `reserve` when a reservation would take a session past its cap. */
export class UnitBudgetExceededError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly unit: MeterUnit,
    public readonly spent: number,
    public readonly attempted: number,
    public readonly cap: number
  ) {
    super(
      `Per-Foray ${unit} cap exceeded for session ${sessionId}: spent ${figure(spent)} + attempted ${figure(attempted)} > cap ${figure(cap)}`
    );
    this.name = "UnitBudgetExceededError";
  }
}

/**
 * Thrown by the pipeline (runPipeline.ts `timed()`) when a unit cap error
 * escaped a STAGE, so the message names the stage that was running and how to
 * resume, the way BudgetStopError does for the dollar caps.
 */
export class UnitBudgetStopError extends Error {
  public readonly unit: MeterUnit;
  public readonly spent: number;
  public readonly cap: number;

  constructor(
    public readonly stage: string,
    public readonly cause: UnitBudgetExceededError,
    public readonly resumeHint?: string
  ) {
    super(
      `Unit cap stop in stage "${stage}": the per-Foray ${cause.unit} cap of ${figure(cause.cap)} was reached ` +
        `(spent ${figure(cause.spent)}; this call would have added ${figure(cause.attempted)}). ` +
        (resumeHint ? `${resumeHint} ` : "") +
        `Raise the cap with ${UNIT_CAP_ENV_VAR[cause.unit]} and re-run.`
    );
    this.name = "UnitBudgetStopError";
    this.unit = cause.unit;
    this.spent = cause.spent;
    this.cap = cause.cap;
  }
}

/** Finds a unit cap error inside a wrapper (an act's ActDeepeningError, ...),
 * or returns null. Walks `cause` like findBudgetError, bounded the same way. */
export function findUnitBudgetError(err: unknown): UnitBudgetExceededError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (current instanceof UnitBudgetExceededError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** One reservation; `reconcile` settles it once. */
export interface UnitReservation {
  readonly sessionId: string;
  readonly unit: MeterUnit;
  readonly amount: number;
  /** The stage on the call context when it was reserved (null outside one). */
  readonly stage: string | null;
  settled: boolean;
}

export interface UnitReserveRequest {
  sessionId: string;
  /** The duration tier; defaults to the call context's tier (GV-01), then the
   * untiered caps. */
  tier?: string;
  unit: MeterUnit;
  amount: number;
}

export interface MeteredRequest<T> extends Omit<UnitReserveRequest, "amount"> {
  /** What is reserved before the call (seconds, or calls for jevCalls). */
  estimate: number;
  /** The provider's server-side decode seconds for this result, when it
   * reports them; wall time is charged otherwise. */
  serverSeconds?: (value: T) => number | null | undefined;
}

export interface UnitBudgetGuardOptions {
  /** A set cap replaces that unit's cap for EVERY tier. */
  overrides?: Partial<Record<MeterUnit, number | undefined>>;
  /** Epoch-milliseconds clock, injected so a test can pin time. */
  now?: () => number;
}

function zero(): UnitAmounts {
  return { sparkSeconds: 0, secondBoxSeconds: 0, jevCalls: 0 };
}

function cleanAmount(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class UnitBudgetGuard {
  private readonly overrides: Partial<UnitAmounts>;
  private readonly now: () => number;
  private readonly bySession = new Map<string, UnitAmounts>();
  /** Tail of the reserve chain (see reserve). */
  private lock: Promise<void> = Promise.resolve();

  constructor(opts: UnitBudgetGuardOptions = {}) {
    const overrides: Partial<UnitAmounts> = {};
    for (const unit of METER_UNITS) {
      const v = opts.overrides?.[unit];
      if (v !== undefined && Number.isFinite(v) && v >= 0) overrides[unit] = v;
    }
    this.overrides = overrides;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The tier a request is capped at: its own, else the call context's. */
  tierOf(tier: string | undefined): UnitTier {
    const t = tier ?? currentCallContext().tier;
    return isTier(t) ? t : UNTIERED_CAPS_TIER;
  }

  /** Every unit's cap on `tier`, overrides applied. */
  caps(tier?: string): UnitAmounts {
    const base = DEFAULT_UNIT_CAPS[this.tierOf(tier)];
    return { ...base, ...this.overrides };
  }

  capFor(unit: MeterUnit, tier?: string): number {
    return this.caps(tier)[unit];
  }

  /** What a session has spent (reconciled) and holds (outstanding reservations). */
  spent(sessionId: string): UnitAmounts {
    return { ...(this.bySession.get(sessionId) ?? zero()) };
  }

  /**
   * Reserves `amount` of `unit` for the session, or throws
   * UnitBudgetExceededError when spent + amount would pass the cap.
   * Serialised through a promise chain like BudgetGuard.checkAndRecord, so N
   * concurrent callers each see every earlier reservation; a refused call
   * does not poison the chain.
   */
  reserve(req: UnitReserveRequest): Promise<UnitReservation> {
    const stage = currentCallContext().stage ?? null;
    const tier = this.tierOf(req.tier);
    const run = this.lock.then(() => this.reserveNow(req, tier, stage));
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private reserveNow(req: UnitReserveRequest, tier: UnitTier, stage: string | null): UnitReservation {
    const amount = cleanAmount(req.amount);
    const cap = this.capFor(req.unit, tier);
    const totals = this.bySession.get(req.sessionId) ?? zero();
    const spent = totals[req.unit];
    if (spent + amount > cap) {
      throw new UnitBudgetExceededError(req.sessionId, req.unit, spent, amount, cap);
    }
    totals[req.unit] = spent + amount;
    this.bySession.set(req.sessionId, totals);
    currentRunLog()?.append({ kind: "meter", unit: req.unit, amount, reserved: true, stage });
    return { sessionId: req.sessionId, unit: req.unit, amount, stage, settled: false };
  }

  /**
   * Settles a reservation at what it actually cost: frees the surplus when
   * `actual` is under the reservation, charges the excess when it is over.
   * Settles once; a second call is ignored.
   */
  reconcile(reservation: UnitReservation, actual: number): void {
    if (reservation.settled) return;
    reservation.settled = true;
    const charged = cleanAmount(actual);
    const totals = this.bySession.get(reservation.sessionId) ?? zero();
    totals[reservation.unit] = Math.max(0, totals[reservation.unit] - reservation.amount + charged);
    this.bySession.set(reservation.sessionId, totals);
    currentRunLog()?.append({ kind: "meter", unit: reservation.unit, amount: charged, reserved: false, stage: reservation.stage });
  }

  /**
   * Reserves `estimate`, runs `fn`, then reconciles. A seconds unit is charged
   * the provider's server-side seconds when `serverSeconds` gives them, else
   * the wall time; a throw is charged its elapsed time. A count unit
   * (jevCalls) is charged its estimate either way: the call was made.
   */
  async metered<T>(req: MeteredRequest<T>, fn: () => Promise<T>): Promise<T> {
    const reservation = await this.reserve({ sessionId: req.sessionId, unit: req.unit, amount: req.estimate, ...(req.tier !== undefined ? { tier: req.tier } : {}) });
    const startMs = this.now();
    const elapsed = (): number => (this.now() - startMs) / 1000;
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      this.reconcile(reservation, isSecondsUnit(req.unit) ? elapsed() : reservation.amount);
      throw err;
    }
    if (!isSecondsUnit(req.unit)) {
      this.reconcile(reservation, reservation.amount);
      return value;
    }
    let server: number | null | undefined;
    try {
      server = req.serverSeconds?.(value);
    } catch {
      server = undefined;
    }
    this.reconcile(reservation, typeof server === "number" && Number.isFinite(server) && server >= 0 ? server : elapsed());
    return value;
  }

  /** Forgets one session's spend, or every session's (tests). */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.bySession.clear();
    else this.bySession.delete(sessionId);
  }
}

/** The report row's unit block (generateForays.ts): what the session spent
 * and the caps it ran under. */
export interface UnitSpend extends UnitAmounts {
  caps: UnitAmounts;
}

export function unitSpendOf(guard: UnitBudgetGuard, sessionId: string, tier?: string): UnitSpend {
  return { ...guard.spent(sessionId), caps: guard.caps(tier) };
}

/** Process-wide default guard, capped by the env overrides (config/env.ts). */
export const defaultUnitBudgetGuard = new UnitBudgetGuard({
  overrides: {
    sparkSeconds: env.sparkSecondsPerForay,
    secondBoxSeconds: env.secondBoxSecondsPerForay,
    jevCalls: env.jevCallsPerForay
  }
});
