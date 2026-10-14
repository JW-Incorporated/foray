/**
 * GV-123 (docs/roadmap/generation-v2.md, from W4-01 items 4 and 5; R1-01,
 * GP-03, MT-06): the critical-path probe's arithmetic.
 *
 * R1-01 promises to cut the calls a listener waits on before the first act
 * is ready from 7-11 to 3. That is a claim about CALLS IN SERIES (MT-06): two
 * calls that overlap in time cost one wait, not two. This module turns a list
 * of timed calls into the longest chain of calls each of which started at or
 * after the previous one ended, so the cut is measured rather than asserted.
 *
 * Decision 28: the critical path has ONE source, the builder-level spans that
 * callLog.ts's instrumentDeps records. They are provider-independent, so a
 * scripted or fake provider produces them offline; CallRecords (GV-07) stay
 * the source of per-call speed metrics only. The functions here take any
 * `{id, stage, startMs, endMs}` list, so a runlog's CallRecords can be fed in
 * too, and criticalPath.test.ts pins that serialCallChain agrees with
 * tools/generation-bench/runlog.mjs's seriesDepth (GV-17) on its fixture.
 *
 * Pure: no clock, no I/O, no model.
 */

/** One timed call. `stage` is carried for the reader; the chain ignores it. */
export interface TimedCall {
  id: string;
  stage: string;
  startMs: number;
  endMs: number;
}

export interface SerialCallChain {
  /** How many calls the longest serial chain holds (0 for no calls). */
  length: number;
  /** The chain's call ids, earliest first. */
  chain: string[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The longest chain of calls in which each call starts at or after the
 * previous one ended (MT-06, "calls in series"). Calls that overlap are
 * parallel and add one link, not several.
 *
 * DP over the calls sorted by endMs: depth[i] is one more than the deepest
 * earlier call that ended by the time call i started. Any call that can
 * precede i ended no later than i started, so no later than i ended, and
 * sorts before it. Ties (equal end, then equal start) keep input order, and
 * the first-best predecessor wins, so the chain is deterministic. A call
 * without a finite start and end is skipped (nobody measured it).
 */
export function serialCallChain(calls: readonly TimedCall[]): SerialCallChain {
  const xs = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => finite(call.startMs) && finite(call.endMs))
    .sort((a, b) => a.call.endMs - b.call.endMs || a.call.startMs - b.call.startMs || a.index - b.index)
    .map(({ call }) => call);
  const depth: number[] = [];
  const prev: number[] = [];
  let best = -1;
  xs.forEach((call, i) => {
    let d = 1;
    let p = -1;
    for (let j = 0; j < i; j++) {
      const before = xs[j]!;
      const dj = depth[j]!;
      if (before.endMs <= call.startMs && dj + 1 > d) {
        d = dj + 1;
        p = j;
      }
    }
    depth.push(d);
    prev.push(p);
    if (best === -1 || d > depth[best]!) best = i;
  });
  const chain: string[] = [];
  for (let k = best; k !== -1; k = prev[k]!) chain.push(xs[k]!.id);
  chain.reverse();
  return { length: chain.length, chain };
}

/** The calls that started strictly before `tMs` (for "the chain before the
 * first act is ready": a call that starts at the ready instant is not one the
 * listener waited on). Input order is kept. */
export function callsStartedBefore<T extends Pick<TimedCall, "startMs">>(calls: readonly T[], tMs: number): T[] {
  return calls.filter((call) => finite(call.startMs) && call.startMs < tMs);
}
