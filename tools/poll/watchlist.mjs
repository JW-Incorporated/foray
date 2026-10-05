/* The S-10 watchlist (PKG-07, docs/roadmap/shows-search.md §3).

   WHAT THIS IS FOR. The poller (PKG-08 dry-run, PKG-10 live) does not poll the
   whole 884k-show dump; it polls a WATCHLIST: every curated show, plus the
   top-N most popular non-curated shows that the weekly change index says just
   published. This module assembles that list from data the repo already has —
   `data/catalog.json`'s curated rows and the change index that
   `tools/refresh/candidates.mjs`'s `loadChangeIndex()` returns — and seeds each
   row's cadence tier with PKG-05's `seedTier`. It does no I/O and imports only
   `./tiers.mjs`; the CLI that reads files and writes `data/watchlist-seed.json`
   is `./build-watchlist-seed.mjs`.

   THE RULES (buildWatchlist), so a reader can check them against the tests:
   (a) Every curated show becomes a row, in catalogue order: reasons
       ["curated"], `feed_url` / `title` from the catalogue row, `pi_id` =
       `idMap[show_id] ?? null`. A curated show the release did not map keeps
       its row with `pi_id: null` and the extra reason "unmapped" — absence from
       id-map.json is a join gap in the release, never a reason to stop polling
       a curated feed (the same fail-open rule as
       candidates.mjs's selectChangedCuratedShows). When the change index is
       unavailable (`ok: false`) there is no idMap at all; a curated row that
       already carries a numeric `pi_id` (a seed row, PKG-08's case) keeps it,
       and every other one is unmapped.
   (b) A curated row whose `pi_id` is in `changedIds` also gets
       "changed_in_dump" (its feed published since the previous release).
   (c) top.json's NON-curated rows (`c` falsy), in top.json order (it is
       already sorted by popularity), are cut at the first `topN` of them —
       "the top-N non-curated shows" — and of those, the ones whose `id` is in
       `changedIds` are added with reasons ["changed_in_dump"], `feed_url = u`,
       `title = t`, `episode_count = n`. A `pi_id` that is already a row (a
       release that marked a curated show `c: false`) merges into that row
       instead of duplicating it. Every reason appears on a row at most once.
   (d) Tier: `seedTier({ episodeCount, oldestItemPubdate: null,
       newestItemPubdate: null, watchReasons })`. top.json carries no pubdates,
       so the gap is unknown and every row seeds `weekly`, lifted to `daily` by
       the "curated" reason. The poller corrects tiers from observed publish
       times later (PKG-05 correctTier); the seed is a starting point.
   (e) `changeIndex.ok === false` -> rows from (a) only; nothing throws.

   Every row has the shape PKG-06's selectDue reads:
     { pi_id: number|null, show_id: string|null, title, feed_url,
       watch_reasons: string[], episode_count: number|null, tier,
       next_due_at_ms: null, state: "active" }

   expireOpened is the "a non-curated show the listener opened stays watched
   for 90 days" rule. The dry-run does not use it (nothing records opens yet);
   it is here so the live path (PKG-10) has the rule and its test in one place. */

import { seedTier } from "./tiers.mjs";

const DAY_MS = 86_400_000;

function addReason(row, reason) {
  if (!row.watch_reasons.includes(reason)) row.watch_reasons.push(reason);
}

function finiteOrNull(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function buildWatchlist({ curatedShows, changeIndex, topN = 5000, nowMs = Date.now() }) {
  const ok = Boolean(changeIndex && changeIndex.ok === true);
  const idMap = ok && changeIndex.idMap ? changeIndex.idMap : {};
  const changedIds = ok && changeIndex.changedIds ? changeIndex.changedIds : new Set();
  const topRows = ok && Array.isArray(changeIndex.topRows) ? changeIndex.topRows : [];

  const rows = [];
  const byPiId = new Map();

  // (a) + (b): every curated show.
  for (const show of curatedShows) {
    const mapped = ok ? idMap[show.show_id] : finiteOrNull(show.pi_id);
    const pi_id = mapped == null ? null : Number(mapped);
    const row = {
      pi_id,
      show_id: show.show_id ?? null,
      title: show.title ?? null,
      feed_url: show.feed_url ?? null,
      watch_reasons: ["curated"],
      episode_count: finiteOrNull(show.episode_count),
      tier: null,
      next_due_at_ms: null,
      state: "active",
    };
    if (pi_id === null) addReason(row, "unmapped");
    else {
      if (changedIds.has(pi_id)) addReason(row, "changed_in_dump");
      if (!byPiId.has(pi_id)) byPiId.set(pi_id, row);
    }
    rows.push(row);
  }

  // (c): changed ∩ the first topN non-curated rows of top.json.
  let rank = 0;
  for (const top of topRows) {
    if (rank >= topN) break;
    if (!top || top.c) continue;
    rank++;
    const pi_id = Number(top.id);
    if (!changedIds.has(pi_id)) continue;
    const existing = byPiId.get(pi_id);
    if (existing) {
      addReason(existing, "changed_in_dump");
      continue;
    }
    const row = {
      pi_id,
      show_id: null,
      title: top.t ?? null,
      feed_url: top.u ?? null,
      watch_reasons: ["changed_in_dump"],
      episode_count: finiteOrNull(top.n),
      tier: null,
      next_due_at_ms: null,
      state: "active",
    };
    byPiId.set(pi_id, row);
    rows.push(row);
  }

  // (d): seed the tier once every reason is known.
  for (const row of rows) {
    row.tier = seedTier(
      {
        episodeCount: row.episode_count,
        oldestItemPubdate: null,
        newestItemPubdate: null,
        watchReasons: row.watch_reasons,
      },
      nowMs,
    ).tier;
  }
  return rows;
}

/** Pure. Drops rows whose `opened_at_ms` is set and is MORE than `days` days
    before `nowMs`; exactly `days` days old is kept. Rows without
    `opened_at_ms` (curated, changed_in_dump) are always kept. Unused by the
    dry-run (PKG-08); the live path (PKG-10) will call it. */
export function expireOpened(rows, nowMs, days = 90) {
  const ttl = days * DAY_MS;
  return rows.filter((row) => {
    if (typeof row.opened_at_ms !== "number") return true;
    return !(nowMs - row.opened_at_ms > ttl);
  });
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function summarize(rows) {
  let mapped = 0;
  const byReason = new Map();
  const byTier = new Map();
  for (const row of rows) {
    if (row.pi_id !== null && row.pi_id !== undefined) mapped++;
    for (const r of row.watch_reasons) byReason.set(r, (byReason.get(r) ?? 0) + 1);
    byTier.set(row.tier, (byTier.get(row.tier) ?? 0) + 1);
  }
  return {
    total: rows.length,
    mapped,
    unmapped: rows.length - mapped,
    byReason: sortedCounts(byReason),
    byTier: sortedCounts(byTier),
  };
}

export function assertSeedSize(rows, min = 200) {
  if (rows.length < min) {
    throw new RangeError(`watchlist seed has ${rows.length} rows; refusing below ${min}`);
  }
}
