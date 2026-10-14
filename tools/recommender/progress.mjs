/* data/recommender/rating-progress.json: which shows are reserved by an
   unmerged batch and which passes each show has been rated at (RV-02).

   docs/roadmap/recommender-v1.md D10: this module is the ONLY writer of the
   progress file, shared by the Claude, Qwen and Jev rater paths, so every
   path reserves, reclaims and releases the same way. Shape:

     {
       "in_flight": { "<show_key>": { "batch_id": "...", "reserved_at": "<ISO>" } },
       "rated":     { "<show_key>": { "last_batch_id": "...", "passes": [1, 2, 3] } }
     }

   The lifecycle, as tools/classify/ runs it for the breadth classifier:
   prepare reserves a batch's keys (reclaimStale first), an agent rates the
   batch, merge releases the batch and marks its keys rated at the pass. A
   batch abandoned before merge is reclaimed after 12 hours.

   The in-memory functions mutate the progress object they are given and
   return what they changed; only loadProgress and saveProgress touch disk.
   No network, no model call. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STALE_MS = 12 * 3600e3;

const ms = (now) => (now instanceof Date ? now.getTime() : Number(now));

/** An empty progress document. */
export function emptyProgress() {
  return { in_flight: {}, rated: {} };
}

/** The progress file at `path`, or an empty one when the file does not exist.
    A file that exists but does not parse THROWS: resetting it to empty would
    silently drop every reservation and every pass record. */
export function loadProgress(path) {
  if (!existsSync(path)) return emptyProgress();
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return {
    in_flight: doc && typeof doc.in_flight === "object" && doc.in_flight ? doc.in_flight : {},
    rated: doc && typeof doc.rated === "object" && doc.rated ? doc.rated : {},
  };
}

/** Reserve `keys` for `batchId` at `now` (ms or Date). All or nothing: if any
    key is already in flight, under this batch or another, nothing is reserved
    and the call throws an Error with `code: "already_reserved"` and the
    offending `keys`. Two batches never rate the same show at once. */
export function reserve(progress, keys, batchId, now) {
  if (typeof batchId !== "string" || batchId.length === 0) throw new TypeError("reserve needs a batch id");
  const t = ms(now);
  if (!Number.isFinite(t)) throw new TypeError("reserve needs a time (ms or Date)");
  const taken = keys.filter((k) => Object.prototype.hasOwnProperty.call(progress.in_flight, k));
  if (taken.length > 0) {
    const err = new Error(`already in flight: ${taken.map((k) => `${k} (${progress.in_flight[k].batch_id})`).join(", ")}`);
    err.code = "already_reserved";
    err.keys = taken;
    throw err;
  }
  const reservedAt = new Date(t).toISOString();
  for (const k of keys) progress.in_flight[k] = { batch_id: batchId, reserved_at: reservedAt };
  return [...keys];
}

/** Free every reservation at least `staleMs` old (default 12 h) at `now`. A
    reservation whose time does not parse is freed too: it can never age, so
    keeping it would hold the show forever. Returns the freed keys. */
export function reclaimStale(progress, now, { staleMs = STALE_MS } = {}) {
  const t = ms(now);
  const freed = [];
  for (const [k, meta] of Object.entries(progress.in_flight)) {
    const at = Date.parse(meta && meta.reserved_at);
    if (Number.isNaN(at) || t - at >= staleMs) {
      delete progress.in_flight[k];
      freed.push(k);
    }
  }
  return freed;
}

/** Free exactly the reservations held by `batchId`. Returns the freed keys. */
export function release(progress, batchId) {
  const freed = [];
  for (const [k, meta] of Object.entries(progress.in_flight)) {
    if (meta && meta.batch_id === batchId) {
      delete progress.in_flight[k];
      freed.push(k);
    }
  }
  return freed;
}

/** Record that `keys` were rated at `pass` by `batchId`. The pass list stays
    sorted and never holds a pass twice (a re-merged batch is a no-op there);
    `last_batch_id` is always the latest batch. */
export function markRated(progress, keys, { pass, batchId = null } = {}) {
  if (!Number.isInteger(pass) || pass < 1 || pass > 3) throw new RangeError(`markRated needs a pass of 1-3, got ${pass}`);
  for (const k of keys) {
    const entry = progress.rated[k] || { last_batch_id: null, passes: [] };
    const passes = Array.isArray(entry.passes) ? [...entry.passes] : [];
    if (!passes.includes(pass)) passes.push(pass);
    passes.sort((a, b) => a - b);
    progress.rated[k] = { last_batch_id: batchId ?? entry.last_batch_id ?? null, passes };
  }
  return progress;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

/** The progress document as the file holds it: every object's keys sorted,
    two-space indent, one trailing newline, so a diff of the file shows only
    what changed. */
export function serializeProgress(progress) {
  return `${JSON.stringify(sortDeep({ in_flight: progress.in_flight || {}, rated: progress.rated || {} }), null, 2)}\n`;
}

/** Write `progress` to `path` (creating its folder). */
export function saveProgress(path, progress) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeProgress(progress));
}
