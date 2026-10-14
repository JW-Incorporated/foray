/**
 * GV-85 (docs/roadmap/generation-v2.md, from W1-05; covers MT-08, R1-14):
 * code time BELOW stage level. A stage span (runLog.ts) says sourcing took
 * 9 s; these say how much of that was loading a show's text index, running
 * BM25, reading transcript bodies, counting topic supply or walking tier-2
 * candidates — the "before" number the passage-index work (R1-09) needs.
 *
 * HOW. `codeSpan` / `codeSpanSync` time a function and fold the result into a
 * per-log aggregate keyed by (stage, name), where `stage` is the enclosing
 * call context's stage (runPipeline's `withCallContext({stage})`) at the
 * moment the span starts. `codeHit` counts without timing (a cache hit is too
 * cheap to time and timing it would cost more than the hit). Nothing reaches
 * the log until `flushCodeSpans(log)`, which appends ONE `CodeSpanAggregate`
 * per (stage, name): a hot loop of ten thousand reads is one event, not ten
 * thousand. runPipeline never flushes; the CLI (`cli/generateForays.ts`)
 * flushes each attempt's log just before it serialises it.
 *
 * INCLUSIVE, NOT EXCLUSIVE. Spans nest and each one reports its own wall time,
 * children included: `index.load` includes the `transcript.read`s a cold build
 * does, `index.search` includes the `index.load` it triggers, `sourcing.tier2`
 * includes its searches and `sourcing.all` includes everything under it. So
 * the totals of different names in one stage are NOT additive; read each name
 * on its own, or take the outermost one (`sourcing.all`) for the stage's code
 * time.
 *
 * INERT OUTSIDE A RUN. With no `runWithRunLog` active every helper just runs
 * its function and returns exactly what it returned (or throws exactly what it
 * threw): no clock read, no allocation, no state. Every caller that predates
 * this module — the HTTP routes, every test that opens no log — behaves as
 * before. Inside a run, a span records its time even when the function
 * throws, and never changes what the function returns or throws.
 *
 * WHAT IT IS NOT. It never writes a file, never fetches, and holds names and
 * numbers only — the no-fetch scan in sourceBeats.test.ts covers the modules
 * that import it, and this module adds nothing that scan forbids. It uses only
 * `currentRunLog()` and `currentCallContext()` from runLog.ts.
 */
import { currentCallContext, currentRunLog, type CodeSpanAggregate, type RunLog } from "./runLog";

interface LogSpans {
  /** One aggregate per JSON `[stage, name]` — the very object that is
   * appended to the log on flush. */
  byKey: Map<string, CodeSpanAggregate>;
  /** The aggregates already appended to the log. */
  flushed: Set<CodeSpanAggregate>;
}

/** Per-log state. A WeakMap, so a log that is dropped takes its spans with it
 * and two concurrent runs (two attempts, two prompts) never share one. */
const spansByLog = new WeakMap<RunLog, LogSpans>();

/** A sub-millisecond clock: many of these spans are well under 1 ms each, and
 * an integer-millisecond clock would sum them as zero. Read through
 * `globalThis.performance` so a test can pin it. */
function nowMs(): number {
  return globalThis.performance.now();
}

function spansFor(log: RunLog): LogSpans {
  let spans = spansByLog.get(log);
  if (!spans) {
    spans = { byKey: new Map(), flushed: new Set() };
    spansByLog.set(log, spans);
  }
  return spans;
}

function aggregateFor(log: RunLog, stage: string | null, name: string): CodeSpanAggregate {
  const spans = spansFor(log);
  const key = JSON.stringify([stage, name]);
  let agg = spans.byKey.get(key);
  if (!agg) {
    agg = { kind: "code", stage, name, count: 0, totalMs: 0, maxMs: 0 };
    spans.byKey.set(key, agg);
  }
  return agg;
}

function currentStage(): string | null {
  return currentCallContext().stage ?? null;
}

function record(log: RunLog, stage: string | null, name: string, startMs: number): void {
  const ms = Math.max(0, nowMs() - startMs);
  const agg = aggregateFor(log, stage, name);
  agg.count += 1;
  agg.totalMs += ms;
  if (ms > agg.maxMs) agg.maxMs = ms;
}

/** Times a synchronous `fn` under `name` in the current stage. Outside a run
 * it is exactly `fn()`. */
export function codeSpanSync<T>(name: string, fn: () => T): T {
  const log = currentRunLog();
  if (!log) return fn();
  const stage = currentStage();
  const start = nowMs();
  try {
    return fn();
  } finally {
    record(log, stage, name, start);
  }
}

/** Times an async `fn` until its promise settles. Outside a run it is exactly
 * `fn()` (the same promise). Inside, a synchronous throw is recorded and
 * rethrown synchronously, as `fn()` alone would. */
export function codeSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const log = currentRunLog();
  if (!log) return fn();
  const stage = currentStage();
  const start = nowMs();
  let pending: Promise<T>;
  try {
    pending = fn();
  } catch (err) {
    record(log, stage, name, start);
    throw err;
  }
  return pending.then(
    (value) => {
      record(log, stage, name, start);
      return value;
    },
    (err: unknown) => {
      record(log, stage, name, start);
      throw err;
    }
  );
}

/** Counts one occurrence of `name` in the current stage without timing it
 * (its aggregate's totalMs and maxMs stay 0). A no-op outside a run. */
export function codeHit(name: string): void {
  const log = currentRunLog();
  if (!log) return;
  aggregateFor(log, currentStage(), name).count += 1;
}

/**
 * Appends one `CodeSpanAggregate` per (stage, name) recorded on `log` that is
 * not in the log yet, in first-seen order, and returns how many it appended.
 * Idempotent: a second flush appends nothing new for a key already flushed —
 * a span recorded after the flush folds into the aggregate already in the log
 * (the same object), so the log never holds two aggregates for one
 * (stage, name). Call it before `log.toJsonl()`.
 */
export function flushCodeSpans(log: RunLog): number {
  const spans = spansByLog.get(log);
  if (!spans) return 0;
  let appended = 0;
  for (const agg of spans.byKey.values()) {
    if (spans.flushed.has(agg)) continue;
    log.append(agg);
    spans.flushed.add(agg);
    appended += 1;
  }
  return appended;
}
