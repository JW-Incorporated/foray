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
  /** Set when the stage did not run: its output came from a checkpoint
   * (F-17/F-18). Optional so every existing reader is unaffected, and present
   * rather than inferred from `ms: 0`, because a report that shows a 0 ms
   * spine without saying why reads as a broken measurement. */
  resumed?: true;
  /** GV-01: set when the stage THREW. `ms` is still its real duration — the
   * time the stage spent before failing — so a failed attempt's report can
   * say where the time went instead of reporting nothing. Optional for the
   * same reason as `resumed`. */
  failed?: true;
}

/** Runs `fn`, records how long it actually took (wall clock, `Date.now()`
 * — no jitter injected, no estimate), and returns both the result and
 * the timing record. Never swallows an error: a throw propagates unchanged
 * so a timing wrapper can never mask a real failure.
 *
 * A FAILING STAGE IS NOT TIMED HERE: there is no result to return beside a
 * timing, so on a throw this function only rethrows. `StageTimingLog.run`
 * below is the wrapper that records failures (GV-01: `failed: true` with the
 * stage's real ms). */
export async function measureStage<T>(name: string, fn: () => Promise<T> | T): Promise<{ result: T; timing: StageTiming }> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  return { result, timing: { name, startedAt, ms } };
}

/** Ordered collector for a pipeline run's stage timings — the shape
 * `finalizeForay.ts` attaches to its result so a caller (the publish CLI,
 * a future log) can record real numbers rather than re-deriving them. */
export class StageTimingLog {
  private readonly entries: StageTiming[] = [];

  /** Times `fn` and records it. A stage that throws is recorded too —
   * `{name, startedAt, ms, failed: true}` with its real duration — and the
   * error is rethrown unchanged (GV-01). */
  async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.entries.push({ name, startedAt, ms: Date.now() - start, failed: true });
      throw err;
    }
    this.entries.push({ name, startedAt, ms: Date.now() - start });
    return result;
  }

  /** Records a stage that was NOT run because its output was resumed from a
   * checkpoint. Kept as its own method rather than a flag on `run` so a stage
   * can never be marked resumed and timed at the same time. */
  markResumed(name: string): void {
    this.entries.push({ name, startedAt: new Date().toISOString(), ms: 0, resumed: true });
  }

  all(): StageTiming[] {
    return [...this.entries];
  }

  totalMs(): number {
    return this.entries.reduce((sum, e) => sum + e.ms, 0);
  }
}

/** GV-01 (the same definition the bench's W1-01 column uses): the TRUE
 * elapsed time of a run's stages — the last end minus the first start — so
 * stages that overlap (G-32's concurrent `narrate:<i>`) are counted once,
 * where `totalMs()` sums them. Resumed entries did not run and are skipped;
 * failed ones did and count. Null when no entry ran. */
export function spanMsOf(timings: readonly StageTiming[]): number | null {
  const ran = timings.filter((t) => !t.resumed);
  if (ran.length === 0) return null;
  const starts = ran.map((t) => Date.parse(t.startedAt));
  const ends = ran.map((t, i) => starts[i]! + t.ms);
  return Math.max(...ends) - Math.min(...starts);
}
