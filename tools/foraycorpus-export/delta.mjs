/* Delta high-water mark for the corpus export (PKG-06, G-10;
   docs/roadmap/corpus.md §3 "PKG-06 · manifest.mjs + delta.mjs").

   The G-10 card (docs/curation/foray-to-spec-roadmap.md:485-511) keys the
   delta on `assets.id` and `episodes.updated_at`: an episode changed since
   the last export if it carries an asset newer than the last max asset id,
   or its `updated_at` is newer than the last max `updated_at`.

   `episodes.updated_at` is ASSUMED (fixtures/synthetic/README.md; PKG-03
   confirms it and has not run yet). The delta therefore degrades instead of
   failing when the column is absent or null: a null `updated_at` is "not
   changed by this half of the test", never a throw, and the high-water mark's
   `max_episode_updated_at` stays null when no row carries one. The asset-id
   half still works on its own, which is the fallback corpus.md PKG-03 names.

   Timestamps are compared as instants (Date.parse), not as strings: the
   synthetic fixture writes `...:00Z`, episodes.mjs writes `...:00.000Z`, and
   pg returns Date objects, and as strings "Z" sorts after ".". State is
   written with tools/segments/sweep-transcripts.mjs writeJsonAtomic (imported;
   that module's CLI is guarded, so the import has no side effect). The
   state-file idiom follows tools/shows/state.mjs (reference only). */
import { existsSync, readFileSync } from "node:fs";

import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";

export class DeltaError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DeltaError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function emptyState() {
  return { version: 1, last_export_version: null, high_water: { max_asset_id: 0, max_episode_updated_at: null } };
}

/** An instant in ms, or null for null / unparsable. Accepts ISO strings and
    Date objects (what pg returns for timestamptz). */
function instant(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * The delta state at `file`, or the defaults when the file is absent. A file
 * that exists but does not parse is reported (DeltaError CORRUPT_STATE), not
 * replaced by defaults: defaults would mark every episode as changed and
 * silently turn a delta export into a full one.
 */
export function readState(file) {
  if (!existsSync(file)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new DeltaError("CORRUPT_STATE", `${file}: ${e.message}`);
  }
  const base = emptyState();
  return {
    version: 1,
    last_export_version: parsed?.last_export_version ?? null,
    high_water: {
      max_asset_id: Number(parsed?.high_water?.max_asset_id ?? base.high_water.max_asset_id) || 0,
      max_episode_updated_at: parsed?.high_water?.max_episode_updated_at ?? null,
    },
  };
}

/**
 * Streams `assets` and `episodes` once each for the high-water mark.
 * `max_asset_id` is 0 for an empty table; `max_episode_updated_at` (an ISO
 * string) stays null when no episode row carries a parsable `updated_at`.
 * Ids are coerced with Number because pg returns int8 columns as strings.
 */
export async function computeHighWater(source) {
  let maxAssetId = 0;
  for await (const a of source.rows("assets")) {
    const id = Number(a.id);
    if (Number.isFinite(id) && id > maxAssetId) maxAssetId = id;
  }
  let maxUpdated = null;
  for await (const e of source.rows("episodes")) {
    const t = instant(e.updated_at);
    if (t !== null && (maxUpdated === null || t > maxUpdated)) maxUpdated = t;
  }
  return { max_asset_id: maxAssetId, max_episode_updated_at: maxUpdated === null ? null : new Date(maxUpdated).toISOString() };
}

/**
 * True when an episodes.jsonl row (episodes.mjs shape: `updated_at`,
 * `asset_ids`) is newer than the high-water mark `hw`. Strictly newer on both
 * halves: a row AT the mark was in the previous export. A null or unparsable
 * `updated_at` on either side makes that half false; missing `asset_ids` is
 * no assets. Never throws on a null.
 */
export function isChanged(episodeRow, hw) {
  const rowT = instant(episodeRow?.updated_at);
  const hwT = instant(hw?.max_episode_updated_at);
  if (rowT !== null && hwT !== null && rowT > hwT) return true;
  const maxAssetId = Number(hw?.max_asset_id ?? 0) || 0;
  const ids = Array.isArray(episodeRow?.asset_ids) ? episodeRow.asset_ids : [];
  return ids.some((id) => Number(id) > maxAssetId);
}

/** Writes the state atomically (tmp + rename, tmp removed on failure). */
export function writeState(file, state, options) {
  writeJsonAtomic(file, state, options);
}
