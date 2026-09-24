/* The shared rows, as the bytes the Storage receives (NE-10j, plan §6: the
   `rows` and `number-format` families).

   WHY THE FIXTURES HOLD STRINGS, NOT OBJECTS. On iOS the native engine writes
   `cp_pos:<id>`, `cp_foray:<id>` and `cp_last_episode` into the same
   `CapacitorStorage.` rows the page reads (plan §4.6, "positions survive
   switching engines"), and the page parses whatever is there. A parity case
   that returned the row as an object would pass through `codec.encode`, which
   SORTS keys — so a Swift writer that put `updated_at` first, printed `3600` as
   `3600.0`, or escaped `/` as `\/` (Foundation's defaults leave dictionary
   key order unspecified and escape the slash) would still match. The value
   recorded here is the exact string the JS writer hands to `setItem`, so
   NE-10s's JSWriter has to produce it byte for byte.

   WHY THESE GO THROUGH THE REAL WRITERS. Each function below drives the code
   the page actually calls — `PositionStore.save`, `ForayProgressStore.save`,
   `makeLastEpisode` then `writeLastEpisode` (client.js does exactly that pair)
   — against a Storage that only records. Nothing here builds a row itself, so
   a field added to a real builder shows up as a changed fixture on the next
   `record.mjs --check`, instead of as a second, hand-kept copy that drifts.
   Refused writes are part of the row's contract too: a case whose writer
   refuses records `[]`, and the engine must refuse the same inputs.

   Time is the one thing a case supplies that the page does not: every writer
   stamps `updated_at`, so each function takes `nowMs` (epoch milliseconds) and
   hands the writer that instant. `toISOString()`'s shape (always three
   fractional digits, always `Z`) is therefore pinned by the rows too.

   The page never imports this file. It is harness code, like runner.js. */

import { PositionStore } from "../position-store.js";
import { ForayProgressStore } from "../foray-progress.js";
import { makeLastEpisode, writeLastEpisode } from "../episode-progress.js";

/** A Storage that keeps every write, in order, as `{key, value}`. A write the
    real code refused to make never reaches it, so an empty list is a refusal. */
function recordingStorage() {
  const writes = [];
  return {
    writes,
    getItem: () => null,
    setItem(key, value) { writes.push({ key, value }); },
    removeItem(key) { writes.push({ key, removed: true }); },
  };
}

/**
 * `cp_pos:<id>` through `PositionStore.save(id, seconds, meta)`.
 * @returns {{key: string, value: string}[]}  what reached setItem
 */
export function cpPosRow(id, seconds, meta, nowMs) {
  const storage = recordingStorage();
  new PositionStore({ storage, now: () => new Date(nowMs) }).save(id, seconds, meta);
  return storage.writes;
}

/**
 * `cp_foray:<id>` through `ForayProgressStore.save(p)`, forced: the 5-second
 * throttle is foray-progress's rule (NE-29j), not the row's.
 * @returns {{key: string, value: string}[]}
 */
export function cpForayRow(progress, nowMs) {
  const storage = recordingStorage();
  new ForayProgressStore({ storage }).save({ ...progress, force: true, now: new Date(nowMs) });
  return storage.writes;
}

/**
 * `cp_last_episode` the way client.js writes it: `makeLastEpisode(item)`, and
 * only a record is written (a null pointer would CLEAR the row, and playing an
 * id-less item must not).
 * @returns {{key: string, value: string}[]}
 */
export function cpLastEpisodeRow(item, nowMs) {
  const storage = recordingStorage();
  const record = makeLastEpisode(item, { now: nowMs });
  if (record) writeLastEpisode(storage, record);
  return storage.writes;
}

/**
 * `cp_last_episode` the way the ENGINE writes it (plan §5.2, NE-14j). The page
 * sends `playEpisode` a `lastEpisodeRow` — continuation.js's
 * `makeLastEpisode(item)` without `updated_at` — and the engine stores it
 * VERBATIM, stamping `updated_at` itself when the item actually plays. So this
 * is the page's own writer handed `{...row, updated_at}`: every field the page
 * sent, in the page's order, with the play's time (replacing a stale stamp in
 * place, should a row ever carry one). A row with no id is not a pointer and
 * writes nothing, as `cpLastEpisodeRow` refuses an id-less item.
 * @returns {{key: string, value: string}[]}
 */
export function engineLastEpisodeRow(lastEpisodeRow, nowMs) {
  const storage = recordingStorage();
  if (lastEpisodeRow && typeof lastEpisodeRow === "object" && typeof lastEpisodeRow.id === "string" && lastEpisodeRow.id) {
    writeLastEpisode(storage, { ...lastEpisodeRow, updated_at: new Date(nowMs).toISOString() });
  }
  return storage.writes;
}

/**
 * How a number inside any row is printed: `JSON.stringify`, which is
 * ECMAScript Number::toString (the shortest string that round-trips, the
 * exponent form from 1e21 up and below 1e-6, `-0` as `0`) — and `null` for
 * NaN and the infinities, which no row writer should ever let through but
 * which the Swift writer must print the same way if one does.
 */
export function jsonNumber(x) {
  return JSON.stringify(x);
}
