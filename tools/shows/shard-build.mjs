/* Static shard index builder (§3.2 of 4a-shows-pipeline-plan.md).

   Shapes, verbatim from the plan:
     manifest.json  — { export_version, built_at, row_count, shard_count,
                         shard_key: "token-prefix-2",
                         counts: { read, in_4a, canonical } }
     shards/<pp>.json.gz — one per normalised 2-char token prefix,
                         rows { id, t, a, i, u, img, n, c }, sorted by
                         popularity (popularityScore desc; ties by id asc
                         for determinism)
     top.json       — curated (all of them) + top N by popularity among the
                         rest, budget checked by the caller
     changed.json    — pi_ids whose newest_item_at advanced since the
                         previous release
     id-map.json     — slug -> pi_id for the curated catalogue; EVERY
                         curated show must resolve or the whole run fails
                         closed, naming every miss (enforced by the caller,
                         buildIdMap only reports what it found).

   Pure: takes canonical rows + the curated catalogue in memory, returns
   plain objects. gzip and disk I/O are the caller's job so this stays
   fixture-testable. */
import { normalizeFeedUrl } from "./identity.mjs";

/** Token-prefix shard keys for one row: every 2-char normalised prefix of
    every token in title + author. A single-character token still yields a
    key (padded conceptually by "the token itself"), matching the plan's
    "fridman" -> shard "fr" example without requiring 2+ char tokens. */
export function tokenPrefixesFor(row) {
  const text = `${row.title || ""} ${row.itunesAuthor || row.itunesOwnerName || ""}`;
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const prefixes = new Set();
  for (const tok of tokens) {
    const key = tok.length >= 2 ? tok.slice(0, 2) : tok.padEnd(1, "");
    prefixes.add(normalizePrefixKey(key));
  }
  return [...prefixes];
}

/** a-z0-9 pass through; anything else (the token's own non-ascii leftovers,
    or a 1-char token) collapses to "_" per the plan ("plus `_` for
    anything else"). */
export function normalizePrefixKey(raw) {
  const s = String(raw || "");
  if (/^[a-z0-9]{2}$/.test(s)) return s;
  if (/^[a-z0-9]$/.test(s)) return `${s}_`;
  return "__";
}

/** The compact shard row shape, `c` = curated (set by the caller once it
    knows the curated id set — this function is pure over one row and a
    flag). */
export function toShardRow(row, { curated = false } = {}) {
  return {
    id: row.id,
    t: row.title ?? null,
    a: row.itunesAuthor || row.itunesOwnerName || null,
    i: row.itunesId ?? null,
    u: row.url ?? null,
    img: row.imageUrl ?? null,
    n: Number.isFinite(Number(row.episodeCount)) ? Number(row.episodeCount) : null,
    c: !!curated,
  };
}

const byPopularityThenId = (a, b) =>
  (Number(b.popularityScore) || 0) - (Number(a.popularityScore) || 0) ||
  Number(a.id) - Number(b.id);

/** Buckets canonical rows into shards keyed by 2-char token prefix. Returns
    a Map<shardKey, shardRow[]>, each already sorted by popularity desc. */
export function buildShards(canonicalRows, curatedIds) {
  const sorted = [...canonicalRows].sort(byPopularityThenId);
  const shards = new Map();
  for (const row of sorted) {
    const curated = curatedIds.has(Number(row.id));
    const shardRow = toShardRow(row, { curated });
    for (const key of tokenPrefixesFor(row)) {
      if (!shards.has(key)) shards.set(key, []);
      shards.get(key).push(shardRow);
    }
  }
  return shards;
}

/** top.json: every curated show, plus the top N non-curated rows by
    popularity. Curated rows are never displaced by the N cap — the plan's
    "the curated 220 plus the top 2,000 in_4a by popularity". */
export function buildTop(canonicalRows, curatedIds, topN) {
  const sorted = [...canonicalRows].sort(byPopularityThenId);
  const curated = [];
  const rest = [];
  for (const row of sorted) {
    (curatedIds.has(Number(row.id)) ? curated : rest).push(row);
  }
  const topRest = rest.slice(0, topN);
  return [...curated, ...topRest].map((row) =>
    toShardRow(row, { curated: curatedIds.has(Number(row.id)) }));
}

/** changed.json: pi_ids whose newestItemPubdate advanced versus the
    previous manifest's per-id snapshot. `previousNewest` is a
    Map<id, newestItemPubdate> (or plain object) from the prior release; a
    row absent from it counts as changed (new since last release). */
export function buildChanged(canonicalRows, previousNewest) {
  const prevMap = previousNewest instanceof Map ? previousNewest : new Map(Object.entries(previousNewest || {}));
  const changed = [];
  for (const row of canonicalRows) {
    const id = Number(row.id);
    const prev = prevMap.has(String(id)) ? prevMap.get(String(id)) : prevMap.get(id);
    const now = Number(row.newestItemPubdate) || null;
    if (prev == null || (now != null && now > Number(prev))) {
      changed.push(id);
    }
  }
  changed.sort((a, b) => a - b);
  return changed;
}

/** id-map.json builder. Matches curated shows to canonical dump rows by
    normalised feed_url first (D2's join key), falling back to
    apple_collection_id === itunesId when the feed_url doesn't resolve
    (feeds move; Apple id is the plan's explicit cross-reference for
    exactly this case). Returns { idMap, missing } — the caller decides
    whether `missing.length` fails the run closed; this function never
    throws so it stays a pure, fully-testable mapping step. */
export function buildIdMap(canonicalRows, curatedShows) {
  const byFeedUrl = new Map();
  const byItunesId = new Map();
  for (const row of canonicalRows) {
    const norm = normalizeFeedUrl(row.url);
    if (norm && !byFeedUrl.has(norm)) byFeedUrl.set(norm, row);
    if (row.itunesId != null && !byItunesId.has(Number(row.itunesId))) {
      byItunesId.set(Number(row.itunesId), row);
    }
  }

  const idMap = {};
  const missing = [];
  for (const show of curatedShows) {
    const normFeed = normalizeFeedUrl(show.feed_url);
    let match = normFeed ? byFeedUrl.get(normFeed) : null;
    if (!match && show.apple_collection_id != null) {
      match = byItunesId.get(Number(show.apple_collection_id));
    }
    if (match) {
      idMap[show.show_id] = Number(match.id);
    } else {
      missing.push({ show_id: show.show_id, title: show.title });
    }
  }
  return { idMap, missing };
}
