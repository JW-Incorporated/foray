import { currentRunLog, type ReadyEvent } from "./runLog";

/**
 * GV-33 (docs/roadmap/generation-v2.md, #1286; from W1-06, MT-11): readiness
 * events in the run's RunLog, so a `runlogs/*.runlog.jsonl` file says when
 * each act (and, once a streamed writer emits per seam, each item) became
 * playable.
 *
 * Built on `currentRunLog()`; `runLog.ts` already declares the `ReadyEvent`
 * shape (GV-01) and is not edited. Both helpers are no-ops outside
 * `runWithRunLog`, so a caller that opened no log behaves exactly as before.
 * Ids only, never item text.
 */

/** The run log's clock now, or undefined outside a run. A caller that must
 * stamp an event AFTER work it does not want counted (the partial candidate's
 * two finalize runs) reads this first and passes it as `readyMs`. */
export function readinessNowMs(): number | undefined {
  return currentRunLog()?.nowMs();
}

/** An act became playable. `itemIds` are the items new since the previous act
 * event, in order (act 0 carries the prelude unless it was emitted early).
 * `partialOk` is the partial candidate's verdict when one was built, else
 * null. `readyMs` defaults to the log's clock now. */
export function emitActReady(input: { actIndex: number; itemIds: readonly string[]; partialOk: boolean | null; readyMs?: number }): ReadyEvent | undefined {
  const log = currentRunLog();
  if (!log) return undefined;
  const event: ReadyEvent = {
    kind: "ready",
    granularity: "act",
    actIndex: input.actIndex,
    itemIds: [...input.itemIds],
    readyMs: input.readyMs ?? log.nowMs(),
    partialOk: input.partialOk
  };
  log.append(event);
  return event;
}

/** One item became playable on its own (the early prelude today; a streamed
 * writer's seam items once R1-06 lands). `actIndex` is -1 for the prelude. */
export function emitItemReady(input: { itemId: string; actIndex: number; readyMs?: number }): ReadyEvent | undefined {
  const log = currentRunLog();
  if (!log) return undefined;
  const event: ReadyEvent = {
    kind: "ready",
    granularity: "item",
    actIndex: input.actIndex,
    itemIds: [input.itemId],
    readyMs: input.readyMs ?? log.nowMs(),
    partialOk: null
  };
  log.append(event);
  return event;
}
