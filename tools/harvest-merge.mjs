/* Re-harvest merge for data/catalog-breadth.json — see docs/CATALOG-PIPELINE.md
   § "Re-harvests keep shows that left the charts".

   WHY THIS EXISTS. `tools/harvest-catalog.mjs` is chart-driven: it only ever
   sees the shows that sit in some US top-200 TODAY. Until 2026-10-07 it wrote
   that set straight over the committed file, so the PKG-14 re-harvest (#1148)
   silently dropped the 6,632 shows that had left every chart since the July
   harvest — and with them their server-search row, their breadth show page
   (a shared `#/show/<apple id>` link to one, which now cold-opens, went
   nowhere) and their topics (16,736 -> 11,145 rows with subjects). Falling off
   a chart says the show is less popular this quarter, not that it stopped
   existing; our copy of it was still true.

   THE RULE. A re-harvest is a UNION with the file it replaces:
     - a show still charting gets the harvest's fresh row (rank, artist_name,
       title, feed, artwork, episode count, ...) and `last_charted_at` = when
       this harvest saw it on a chart; any field the harvest does not write
       (`taxonomy_node_ids`, folded later) is carried over from the old row;
     - a show that LEFT the charts keeps its old row, with `chart_rank: null`
       (it has no position now; every consumer already reads null as UNRANKED,
       the worst band) and `last_charted_at` recording when it was last seen
       charting. `chart_genre_id` / `chart_genre_name` are kept: they name the
       chart it was last on, which the classifier still reads as a genre signal.
       `harvested_at` is kept too — it is when its metadata was last fetched;
     - a show new to the charts is added.
   `in_curated` is recomputed for every row against today's data/catalog.json,
   kept rows included, so a show promoted to curated since it fell off the
   charts is not emitted twice.

   Nothing is ever removed by a re-harvest. Pruning shows that have been off
   every chart for a long time is a deliberate, separate decision — `--replace`
   on the harvester restores the old replace-the-file behaviour for that.

   KEY ORDER. Rows are emitted in one canonical key order (`ROW_KEYS`, then any
   other key in its existing order) so a row's bytes do not depend on which
   path wrote it. The file stays single-line `JSON.stringify(doc) + "\n"`, the
   form `tools/refresh/fold-breadth-topics.mjs` round-trips byte for byte.

   CLI (the one-off repair of #1148, and any future re-merge):
     node tools/harvest-merge.mjs --prev <old.json> --fresh <new.json> --out <path>
                                  [--catalog data/catalog.json] [--backfill-artist]
   `--backfill-artist` looks up, through Apple's `lookup` endpoint at >= 3 s
   between requests (docs/CATALOG-PIPELINE.md politeness), the kept rows that
   carry no `artist_name` key at all (rows harvested before P-03a), and sets
   only that field.                                                           */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { UA } from "./segments/politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The harvester's row literal, in its order, with `last_charted_at` after the rank it dates. */
export const ROW_KEYS = [
  "apple_collection_id", "title", "feed_url", "artwork_url", "apple_genre", "apple_genre_ids",
  "artist_name", "episode_count", "explicit", "chart_genre_id", "chart_genre_name", "chart_rank",
  "last_charted_at", "in_curated", "podcastindex_id", "tier", "region", "harvest_source", "harvested_at",
];

export const THROTTLE_MS = 3000;
export const LOOKUP_BATCH = 150;

/** A usable chart position: a finite number > 0 (the same test every consumer applies). */
export const isChartRank = (raw) => raw !== null && raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) > 0;

/** The breadth rank join both builders read (tools/build-show-index.mjs,
    tools/build-catalog-client.mjs): String(apple_collection_id) -> the usable
    rank as a number. Every row counts, `in_curated` or not — the curated
    shows' twins ARE the in_curated rows. `breadth` null joins nothing. One
    join, so the TSV and the client JSON cannot disagree about a rank. */
export function rankByAppleId(breadth) {
  const ranks = new Map();
  for (const row of breadth?.shows ?? []) {
    if (isChartRank(row?.chart_rank)) ranks.set(String(row?.apple_collection_id), Number(row.chart_rank));
  }
  return ranks;
}

/** `row` with its keys in canonical order: ROW_KEYS first, then the rest as they were. */
export function canonicalRow(row) {
  const out = {};
  for (const k of ROW_KEYS) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  for (const k of Object.keys(row)) if (!(k in out)) out[k] = row[k];
  return out;
}

/* When an OLD row was last seen charting. A row written before this merge
   existed has no `last_charted_at`, but every such row came off a chart (the
   harvester only harvests charting shows), so its `harvested_at` IS that
   moment — provided it actually carries a rank. A rankless row with no
   record says nothing about when it charted, so null rather than a guess. */
function lastChartedOf(prev) {
  if (prev.last_charted_at) return prev.last_charted_at;
  return isChartRank(prev.chart_rank) ? prev.harvested_at ?? null : null;
}

/**
 * Union `fresh` (a harvest's output document) with `prev` (the file it would
 * replace; null/undefined = first harvest). Pure.
 *
 * @param {object|null} prev   `{ shows: [...] }` or null
 * @param {object}      fresh  `{ shows: [...], built_at, ... }`
 * @param {object}      [opts]
 * @param {Set<number|string>} [opts.curatedIds]  today's curated apple_collection_ids;
 *                              when given, `in_curated` is recomputed on every row
 * @returns {{ doc: object, stats: { refreshed: number, added: number, kept_off_chart: number, total: number } }}
 */
export function mergeBreadthHarvest(prev, fresh, { curatedIds } = {}) {
  if (!fresh || !Array.isArray(fresh.shows)) throw new Error("fresh harvest did not parse to { shows: [...] }");
  if (prev !== null && prev !== undefined && !Array.isArray(prev.shows)) {
    throw new Error("previous breadth file did not parse to { shows: [...] } — refusing to merge over it");
  }
  const curatedKeys = curatedIds ? new Set([...curatedIds].map(String)) : null;
  const prevById = new Map();
  for (const row of prev?.shows ?? []) {
    if (row?.apple_collection_id === undefined || row?.apple_collection_id === null) continue;
    if (!prevById.has(String(row.apple_collection_id))) prevById.set(String(row.apple_collection_id), row);
  }

  const stats = { refreshed: 0, added: 0, kept_off_chart: 0, total: 0 };
  const shows = [];
  const seen = new Set();
  const finish = (row) => {
    if (curatedKeys) row.in_curated = curatedKeys.has(String(row.apple_collection_id));
    shows.push(canonicalRow(row));
  };

  /* The harvest's rows first, in harvest order. */
  for (const row of fresh.shows) {
    const key = String(row?.apple_collection_id);
    if (row?.apple_collection_id === undefined || row?.apple_collection_id === null || seen.has(key)) continue;
    seen.add(key);
    const old = prevById.get(key);
    const merged = { ...(old ?? {}), ...row };
    if (isChartRank(row.chart_rank)) {
      merged.last_charted_at = row.last_charted_at ?? row.harvested_at ?? fresh.built_at ?? null;
    } else {
      // Looked up but not charting (not a path the harvester takes today): the
      // fresh metadata wins, the chart history does not move.
      merged.chart_rank = null;
      merged.last_charted_at = old ? lastChartedOf(old) : row.last_charted_at ?? null;
    }
    if (old) stats.refreshed++;
    else stats.added++;
    finish(merged);
  }

  /* Then every old row the harvest did not see, in the old file's order. */
  for (const [key, old] of prevById) {
    if (seen.has(key)) continue;
    seen.add(key);
    finish({ ...old, chart_rank: null, last_charted_at: lastChartedOf(old) });
    stats.kept_off_chart++;
  }

  stats.total = shows.length;
  const { shows: _drop, ...head } = fresh;
  return { doc: { ...head, shows }, stats };
}

/** Kept rows that predate P-03a: no `artist_name` key at all (null means "looked up, Apple has none"). */
export const rowsMissingArtist = (doc) => doc.shows.filter((s) => !Object.prototype.hasOwnProperty.call(s, "artist_name"));

/**
 * Sets `artist_name` on `rows` (mutates) from Apple `lookup`, `LOOKUP_BATCH`
 * ids per request. `fetchJson(url)` is injected: the CLI passes a polite one
 * (>= THROTTLE_MS before every request), tests pass a stub. An id Apple no
 * longer returns gets `artist_name: null`. Returns request/answer counts.
 */
export async function backfillArtistNames(rows, fetchJson) {
  const byId = new Map(rows.map((r) => [Number(r.apple_collection_id), r]));
  const ids = [...byId.keys()].sort((a, b) => a - b);
  const counts = { requests: 0, failed_batches: 0, filled: 0, absent: 0 };
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const batch = ids.slice(i, i + LOOKUP_BATCH);
    counts.requests++;
    let data;
    try {
      data = await fetchJson(`https://itunes.apple.com/lookup?id=${batch.join(",")}&entity=podcast`);
    } catch (e) {
      counts.failed_batches++;
      console.warn(`   lookup batch at ${i} failed: ${e.message}`);
      continue; // leave the key absent: a later run can still fill it
    }
    const answered = new Set();
    for (const r of data?.results || []) {
      if (r.kind !== "podcast" || !r.collectionId || !byId.has(r.collectionId)) continue;
      byId.get(r.collectionId).artist_name = r.artistName ?? null;
      answered.add(r.collectionId);
    }
    for (const id of batch) {
      if (!answered.has(id)) byId.get(id).artist_name = null;
    }
    for (const id of answered) if (byId.get(id).artist_name) counts.filled++;
    counts.absent += batch.length - answered.size;
  }
  return counts; // the caller re-canonicalizes key order (`artist_name` was appended)
}

/**
 * The harvester's last step: union `harvest` with the file at `outPath`
 * (unless `replace`, or there is no file yet), backfill `artist_name` on kept
 * rows that predate it, write single-line JSON + "\n". Returns the written doc.
 * An existing file that does not parse is FATAL, not "no previous file":
 * treating it as empty is exactly the silent drop this merge exists to prevent.
 */
export async function writeMergedHarvest(harvest, { outPath, replace = false, curatedIds = null, fetchJson, log = console.log } = {}) {
  let doc = harvest;
  if (!replace && existsSync(outPath)) {
    const prev = JSON.parse(readFileSync(outPath, "utf8"));
    const merged = mergeBreadthHarvest(prev, harvest, { curatedIds });
    doc = merged.doc;
    log(`   merged with ${outPath}: ${JSON.stringify(merged.stats)}`);
    const missing = rowsMissingArtist(doc);
    if (missing.length) {
      const counts = await backfillArtistNames(missing, fetchJson);
      log(`   artist_name backfill for ${missing.length} kept rows: ${JSON.stringify(counts)}`);
      doc.shows = doc.shows.map(canonicalRow);
    }
  }
  writeFileSync(outPath, JSON.stringify(doc) + "\n");
  return doc;
}

/** A fetch that sleeps THROTTLE_MS before every request and records request start times. */
export function politeFetchJson({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = [] } = {}) {
  const fetchJson = async (url, attempt = 1) => {
    await sleep(THROTTLE_MS);
    log.push(Date.now());
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(THROTTLE_MS * 2 ** attempt);
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  };
  return fetchJson;
}

export const curatedIdsFrom = (catalogPath) =>
  existsSync(catalogPath)
    ? new Set(JSON.parse(readFileSync(catalogPath, "utf8")).shows.map((s) => s.apple_collection_id).filter((x) => x != null))
    : null;

async function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const prevPath = opt("--prev");
  const freshPath = opt("--fresh");
  const outPath = opt("--out");
  if (!prevPath || !freshPath || !outPath) {
    console.error("usage: node tools/harvest-merge.mjs --prev <old.json> --fresh <new.json> --out <path> [--catalog <catalog.json>] [--backfill-artist]");
    return 2;
  }
  const prev = JSON.parse(readFileSync(resolvePath(prevPath), "utf8"));
  const fresh = JSON.parse(readFileSync(resolvePath(freshPath), "utf8"));
  const curatedIds = curatedIdsFrom(resolvePath(opt("--catalog") ?? join(ROOT, "data", "catalog.json")));
  const { doc, stats } = mergeBreadthHarvest(prev, fresh, { curatedIds });
  console.log(JSON.stringify(stats));
  if (argv.includes("--backfill-artist")) {
    const missing = rowsMissingArtist(doc);
    const log = [];
    const counts = await backfillArtistNames(missing, politeFetchJson({ log }));
    const gaps = log.slice(1).map((t, i) => t - log[i]);
    console.log(JSON.stringify({ backfill_rows: missing.length, ...counts, min_gap_ms: gaps.length ? Math.min(...gaps) : null }));
    doc.shows = doc.shows.map(canonicalRow);
  }
  writeFileSync(resolvePath(outPath), JSON.stringify(doc) + "\n");
  console.log(`WROTE ${outPath}: ${doc.shows.length} shows`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error("FATAL:", e); process.exitCode = 1; });
}
