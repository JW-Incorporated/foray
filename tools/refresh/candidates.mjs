/* S-11: curation reads the change stream instead of polling all feeds
   nightly (4a-shows-pipeline-plan.md, card S-11).

   Two things live here, both pure over already-fetched data so they stay
   fixture-testable without a real GitHub Release:

     loadChangeIndex()          fetches S-04's published changed.json,
                                 id-map.json and top.json for THIS nightly
                                 run. Fails soft (never throws) — every
                                 caller gets an { ok:false, reason } instead,
                                 because "the release isn't up yet" must
                                 degrade to the old full-scan behaviour, not
                                 crash the nightly.
     selectChangedCuratedShows() intersects the curated catalogue with the
                                 changed set via S-04's id-map, per scan.mjs
                                 --source index.
     curationCandidates()       intersects the changed set with top.json's
                                 NOT-curated rows, for the digest's
                                 curation-candidates section — fresh activity
                                 from shows nobody has curated in.

   S-04's release layout (tools/shows/shard-build.mjs, publish-release.mjs):
     changed.json  — JSON array of dump-row pi_ids whose newestItemPubdate
                     advanced since the previous release.
     id-map.json   — { <catalog show_id>: <pi_id> }, one entry per curated
                     show that resolved (tools/shows/shard-build.mjs's
                     buildIdMap; a curated show that did NOT resolve is
                     named in manifest.json's `curated.unmapped`, never
                     silently dropped from id-map.json — it is simply
                     absent as a key).
     top.json      — curated (all of them) + top N non-curated by
                     popularity, each row shaped { id, t, a, i, u, img, n, c }
                     (shard-build.mjs's toShardRow; `c` is the curated flag,
                     `id` is the pi_id). */

import { readFileSync } from "node:fs";
import { POINTER_PATH } from "../shows/config.mjs";

/** Fetches and parses the three release assets a change-index run needs.
    Returns { ok:true, changedIds, idMap, topRows } on success or
    { ok:false, reason } on ANY failure — missing pointer (S-04 hasn't
    published yet), missing asset_base_url, a failed fetch, an unexpected
    shape, or a STALE release. Never throws: the whole point of this
    function is to let scan.mjs's --source index fall back to a full scan
    instead of a dark night.

    Staleness (maxAgeHours, default 9 days): S-04b's release runs WEEKLY
    (`.github/workflows/shows-import.yml`, Sun 06:00 UTC), not nightly, so
    the freshness ceiling has to tolerate a full week between releases plus
    slack for a delayed run — an 8-day cadence with a ~24h margin, not
    scan.mjs's own 48h episode WINDOW_H (a much shorter, unrelated clock).
    The failure this guards against is a release run that stalled or
    silently stopped updating the pointer entirely: that pointer is
    otherwise indistinguishable from a healthy weekly one, and trusting it
    once it is well past due would mean `changed.json` no longer reflects
    reality — a curated show whose feed changed after the last real release
    would read as unchanged and get skipped, exactly the "we miss episodes
    if nothing refreshes them" bug this card exists to fix. A pointer with
    no parseable `published_at` degrades to stale (fail open), never
    trusted by default. */
export async function loadChangeIndex({ pointerPath = POINTER_PATH, fetchImpl = fetch, maxAgeHours = 24 * 9, now = Date.now() } = {}) {
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `pointer unreadable (${pointerPath}): ${e.message}` };
  }

  const base = pointer && pointer.asset_base_url;
  if (!base) return { ok: false, reason: "pointer has no asset_base_url" };

  const publishedAt = pointer.published_at ? Date.parse(pointer.published_at) : NaN;
  if (Number.isNaN(publishedAt)) {
    return { ok: false, reason: "pointer has no parseable published_at (cannot verify freshness)" };
  }
  const ageHours = (now - publishedAt) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return { ok: false, reason: `pointer is stale: published_at ${pointer.published_at} is ${ageHours.toFixed(1)}h old (ceiling ${maxAgeHours}h)` };
  }

  let changedRes, idMapRes, topRes;
  try {
    [changedRes, idMapRes, topRes] = await Promise.all([
      fetchImpl(`${base}/changed.json`),
      fetchImpl(`${base}/id-map.json`),
      fetchImpl(`${base}/top.json`),
    ]);
  } catch (e) {
    return { ok: false, reason: `fetch error: ${e.message}` };
  }
  for (const [name, res] of [["changed.json", changedRes], ["id-map.json", idMapRes], ["top.json", topRes]]) {
    if (!res.ok) return { ok: false, reason: `${name} fetch failed: HTTP ${res.status}` };
  }

  let changedRaw, idMap, topRows;
  try {
    [changedRaw, idMap, topRows] = await Promise.all([changedRes.json(), idMapRes.json(), topRes.json()]);
  } catch (e) {
    return { ok: false, reason: `asset did not parse as JSON: ${e.message}` };
  }
  if (typeof idMap !== "object" || idMap === null || !Array.isArray(topRows)) {
    return { ok: false, reason: "unexpected asset shape (expected id-map.json object, top.json array)" };
  }
  /* changed.json is { baseline, changed } (audit round 3, data-tools-14).
     baseline:false means the release had no previous snapshot to diff
     against, so it cannot say what changed: index unavailable, full scan.
     A bare array is the pre-fix shape, and every one ever published was
     diffed against an empty snapshot (every show "changed"), so it is
     treated exactly the same way rather than trusted. */
  if (Array.isArray(changedRaw)) {
    return { ok: false, reason: "changed.json is a bare array (pre-baseline release: every show listed, no real diff) -- index unavailable" };
  }
  if (!changedRaw || typeof changedRaw !== "object" || !("baseline" in changedRaw)) {
    return { ok: false, reason: "unexpected asset shape (expected changed.json { baseline, changed })" };
  }
  if (changedRaw.baseline !== true) {
    return { ok: false, reason: "changed.json has no baseline (no previous-release snapshot) -- index unavailable" };
  }
  if (!Array.isArray(changedRaw.changed)) {
    return { ok: false, reason: "unexpected asset shape (changed.json baseline:true without a changed array)" };
  }

  return { ok: true, changedIds: new Set(changedRaw.changed.map(Number)), idMap, topRows };
}

/** Curated shows to scan tonight: the curated catalogue intersected with
    the changed set, via S-04's id-map. A show with no feed_url is dropped
    (scan.mjs's own pre-existing rule — nothing to poll). A curated show
    ABSENT from id-map (unmapped in this release, per shard-build.mjs's
    fail-open-under-ceiling rule) is scanned unconditionally: absence from
    the map is a join gap in S-04's release, not evidence the show has no
    new episodes, and this function must never let a mapping miss silently
    stop a feed from being polled. */
export function selectChangedCuratedShows(catalogShows, idMap, changedIds) {
  return catalogShows.filter((show) => {
    if (!show.feed_url) return false;
    const piId = idMap[show.show_id];
    if (piId == null) return true; // unmapped -> fail open, always scan
    return changedIds.has(Number(piId));
  });
}

/** changed.json ∩ top-N non-curated shows (top.json's `c: false` rows),
    for the nightly digest's curation-candidates section — fresh activity
    from shows nobody has curated in, so the curation agent sees it without
    a database (S-11's pre-database answer to "we miss episodes if nothing
    refreshes them"). top.json is already sorted by popularity
    (shard-build.mjs's byPopularityThenId), so this stays a filter over
    that order rather than a re-sort — `rank` records each candidate's
    position in the untouched top.json list, not in this filtered output,
    so two nightlies with different curated-vs-candidate mixes stay
    comparable. */
export function curationCandidates(topRows, changedIds, { limit = 50 } = {}) {
  const out = [];
  for (let rank = 0; rank < topRows.length && out.length < limit; rank++) {
    const row = topRows[rank];
    if (!row || row.c) continue; // already curated -- not a candidate
    if (!changedIds.has(Number(row.id))) continue;
    out.push({ id: row.id, title: row.t ?? null, author: row.a ?? null, rank });
  }
  return out;
}
