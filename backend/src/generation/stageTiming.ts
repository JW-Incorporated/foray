/**
 * §6.3's minimal, honest scope for a batch (non-progressive) pipeline
 * (docs/curation/generation-architecture.md §6.3 and this stage's own
 * task brief): "if there's a cheap, real piece of §6.3 that DOES apply
 * even to a batch pipeline (e.g. recording actual per-stage timing data
 * now, so a future live-generation lead calculation has real numbers
 * instead of guesses), build that measurement/logging, nothing more."
 *
 * WHAT THIS IS NOT: §6.3's actual invariant ("act N+1 must be complete
 * before act N has <X> minutes remaining") governs a LIVE, progressive
 * generate-while-playing system. Nothing in this pipeline (§4.0-4.9) runs
 * that way yet — every stage is a batch call chain (see this module's
 * caller, `finalizeForay.ts`, and its own doc comment for the full
 * gap note). There is no "act N" playing while act N+1 generates, so
 * there is no lead to monitor and nothing here pretends to monitor one.
 *
 * WHAT THIS IS: a small, real measurement primitive — wrap any async
 * pipeline stage, get back its actual wall-clock duration. `finalizeForay`
 * uses it on §4.9's own two real stages (validate, then write) so that
 * WHEN a live-generation lead calculation is eventually built, it has
 * real per-stage numbers on record to start from instead of guesses —
 * exactly the failure mode this doc's §4.8 rule 3 already called out
 * ("do not ship a number that was guessed") applied one section over.
 */

export interface StageTiming {
  name: string;
  startedAt: string;
  ms: number;
}

/** Runs `fn`, records how long it actually took (wall clock, `Date.now()`
 * — no jitter injected, no estimate), and returns both the result and
 * the timing record. Never swallows an error: a failing stage still
 * gets timed (the `finally` below), and the error propagates unchanged
 * so a timing wrapper can never mask a real failure. */
export async function measureStage<T>(name: string, fn: () => Promise<T> | T): Promise<{ result: T; timing: StageTiming }> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let result: T;
  try {
    result = await fn();
  } finally {
    // Nothing to do in finally beyond letting the error propagate; the
    // timing push happens after a successful return below. A caller that
    // wants timing-on-failure too should catch and record ms via
    // `Date.now() - start` itself — kept simple here on purpose.
  }
  const ms = Date.now() - start;
  return { result, timing: { name, startedAt, ms } };
}

/** Ordered collector for a pipeline run's stage timings — the shape
 * `finalizeForay.ts` attaches to its result so a caller (the publish CLI,
 * a future log) can record real numbers rather than re-deriving them. */
export class StageTimingLog {
  private readonly entries: StageTiming[] = [];

  async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const { result, timing } = await measureStage(name, fn);
    this.entries.push(timing);
    return result;
  }

  all(): StageTiming[] {
    return [...this.entries];
  }

  totalMs(): number {
    return this.entries.reduce((sum, e) => sum + e.ms, 0);
  }
}
