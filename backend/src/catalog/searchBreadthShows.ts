import { loadBreadthCatalog, type CatalogueShowEntry } from "./breadthCatalog";

/**
 * Search over the FULL breadth catalogue (curated + breadth tiers), the
 * backend half of A3.1/Q3 (kanban t_8d1a6a58): "the user should never
 * notice any limitations based on our own limited curation." Client-side
 * `SearchEngine.searchShows` in `search-engine.js` stays scoped to the
 * curated 220 (`data/catalog-client.json`) as a fast local first pass — this
 * is the same ranking rule (exact title > prefix > substring, case-
 * insensitive), reimplemented server-side over the merged index because the
 * client module has no Node/DOM-free access to the ~10k-show breadth file
 * and shipping it client-side is exactly what CATALOG-PIPELINE.md §5 rules
 * out.
 *
 * Deliberately NOT shared code with search-engine.js: that module is a
 * classic browser script (see its own header) with no import surface for a
 * TS backend module to pull from without a build step this endpoint doesn't
 * have. Duplicating the three-line ranking rule here is cheaper and more
 * legible than inventing a shared-module boundary for one function; if the
 * rule ever needs a fourth rank bucket, update both call sites (this file's
 * header names the twin).
 */

export interface ShowSearchResult extends CatalogueShowEntry {
  rank: number; // 0 = exact title match, 1 = starts-with, 2 = substring elsewhere
}

const DEFAULT_LIMIT = 25;

export function searchBreadthShows(
  query: string,
  limit: number = DEFAULT_LIMIT,
  catalog: CatalogueShowEntry[] = loadBreadthCatalog()
): ShowSearchResult[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const scored: ShowSearchResult[] = [];

  for (const show of catalog) {
    const title = show.title.toLowerCase();
    const idx = title.indexOf(q);
    if (idx === -1) continue;
    const rank = title === q ? 0 : idx === 0 ? 1 : 2;
    scored.push({ ...show, rank });
  }

  /* Ties within a rank: curated tier first (richer metadata, higher editorial
     confidence), then the earliest match index, then alphabetical — a stable,
     deterministic order for a fixed catalogue snapshot, same intent as
     search-engine.js's searchShows stable sort. */
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.tier !== b.tier) return a.tier === "curated" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return scored.slice(0, limit);
}
