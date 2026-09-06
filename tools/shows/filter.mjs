/* D1 filter — "in 4a" = alive, >= D1_MIN_EPISODES episodes, updated within
   D1_MAX_MONTHS_STALE months (see config.mjs's note on which timestamp
   "updated" reads from). Language filter is explicitly OPEN per the plan's
   decision table: this module stores `language` on every row and never
   filters on it — re-confirming/closing that decision is gate G6 (card
   S-17), not this one. */
import { D1_MAX_MONTHS_STALE, D1_MIN_EPISODES } from "./config.mjs";
import { isCuratedRow } from "./identity.mjs";

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/** Pure, one row. `now` is injectable so "stale" is testable without a
    clock. Returns every reason the row failed (not just the first) so the
    caller's per-filter counts are the real overlap, not a hidden priority
    order. */
export function evaluateD1(row, { now = Date.now(), minEpisodes = D1_MIN_EPISODES, maxMonthsStale = D1_MAX_MONTHS_STALE } = {}) {
  const reasons = [];
  if (row.dead === 1 || row.dead === true) reasons.push("dead");

  const episodeCount = Number(row.episodeCount);
  if (!Number.isFinite(episodeCount) || episodeCount < minEpisodes) reasons.push("too_few_episodes");

  const newest = Number(row.newestItemPubdate);
  if (!Number.isFinite(newest) || newest <= 0) {
    reasons.push("no_newest_item_pubdate");
  } else {
    const ageMs = now - newest * 1000;
    if (ageMs > maxMonthsStale * MS_PER_MONTH) reasons.push("stale");
  }
  return { pass: reasons.length === 0, reasons };
}

/** Applies D1 across an iterable of rows (an array, or a generator over a
    node:sqlite cursor — this function never buffers more than the rows it
    is handed). Returns the rows that pass plus a per-filter-condition count
    (a row failing two conditions is counted once under EACH — that is what
    "report per-filter counts" means; a single combined miss total would
    hide which condition is doing the work). */
export function applyD1Filter(rows, opts = {}) {
  const counts = {
    read: 0, kept: 0,
    dead: 0, too_few_episodes: 0, no_newest_item_pubdate: 0, stale: 0,
    curated_exempt: 0,
  };
  const kept = [];
  const curated = opts.curatedKeys ?? null;
  for (const row of rows) {
    counts.read++;
    const { pass, reasons } = evaluateD1(row, opts);
    for (const r of reasons) counts[r] = (counts[r] || 0) + 1;
    /* THE EXEMPTION. A curated show is in 4a by definition (see identity.mjs's
       `curatedKeys` for the measured reason this exists). Its D1 reasons are
       still counted above — the summary should say that N curated shows would
       have been dropped and why, because that number IS the finding — but the
       row is kept, so it reaches the dedupe, the id-map, the shards and the
       search index like any other.

       Counted separately rather than folded into `kept`: `curated_exempt` is
       the number a reader needs to tell "D1 is tuned about right" from "D1 is
       eating the catalogue". */
    if (pass) {
      counts.kept++; kept.push(row);
    } else if (isCuratedRow(row, curated)) {
      counts.kept++; counts.curated_exempt++; kept.push(row);
    }
  }
  return { kept, counts };
}
