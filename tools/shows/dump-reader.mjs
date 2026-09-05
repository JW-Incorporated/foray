/* node:sqlite streaming reader for the PodcastIndex dump's `podcasts`
   table. Deliberately thin: a generator that yields one row object at a
   time via a prepared statement's iterator, never materialising the 4.7M
   rows the card explicitly forbids buffering. */
import { DUMP_COLUMNS } from "./config.mjs";

/** Opens the dump db read-only and yields plain row objects in `id` order
    (the table's own primary-key order — no ORDER BY needed, and adding one
    would force a full sort the card's memory budget can't afford). Caller
    owns the DatabaseSync lifecycle; this function closes it when the
    generator is exhausted OR the caller stops iterating early (try/finally). */
export function* streamPodcasts(db, { columns = DUMP_COLUMNS } = {}) {
  const stmt = db.prepare(`SELECT ${columns.join(", ")} FROM podcasts`);
  const iter = stmt.iterate ? stmt.iterate() : stmt.all();
  try {
    for (const row of iter) yield row;
  } finally {
    // node:sqlite's iterator has no explicit close; DatabaseSync.close() is
    // the caller's responsibility once this generator returns/throws.
  }
}

/** Row count without reading every row into JS — used for the manifest's
    "read" count sanity check against the filter's own tally. */
export function countPodcasts(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM podcasts").get();
  return Number(row?.n ?? 0);
}
