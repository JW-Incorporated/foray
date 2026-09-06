import * as fs from "fs";
import * as path from "path";

/**
 * Full-breadth show catalogue loader (A3.1/Q3, kanban t_8d1a6a58,
 * docs/curation/CATALOG-PIPELINE.md's two-tier architecture).
 *
 * `data/catalog.json` (curated, ~220 shows, editorial notes + taxonomy) and
 * `data/catalog-breadth.json` (~10k shows, genre/chart-rank only, per
 * CATALOG-PIPELINE.md "deliberately never shipped to the client") are both
 * read here, server-side only, and merged into one flat, searchable index —
 * the client never fetches catalog-breadth.json directly (CATALOG-PIPELINE.md
 * §5's "client isolation" rule still holds; only this backend module reads
 * it, and only a thin per-query result crosses to the client).
 *
 * Identity: curated shows keep their existing `show_id`. Breadth shows have
 * no `show_id` field (`apple_collection_id` is their primary key per
 * CATALOG-PIPELINE.md §"Forward-compatibility requirements") — this mints
 * `String(apple_collection_id)` as the id, matching the join
 * `api/shows/[show_id]/episodes.ts` (kanban t_567b570f) already uses, so a
 * breadth show found here resolves to the same id that card's episode
 * endpoint expects.
 *
 * Dedupe: a breadth entry marked `in_curated: true` is dropped from the
 * merged index — the curated record for the same show already carries a
 * richer editorial note/taxonomy and is present under its own show_id, so
 * keeping both would surface the same show twice in one search result list.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// BUNDLING NOTE (kanban t_7d1a82d2): readJson() below reads data/catalog.json
// and data/catalog-breadth.json via a runtime path.join(), which Vercel's
// bundler does not auto-include for any deployed function that imports this
// module (currently api/shows/search.ts). They only ship in production
// because vercel.json's `functions["api/shows/**/*.ts"].includeFiles` glob
// names them explicitly — see the matching note on
// api/shows/[show_id]/episodes.ts's findRepoRoot(), which reads the same two
// files independently. Keep both in sync with vercel.json if either moves.

export type CatalogueTier = "curated" | "breadth";

export interface CatalogueShowEntry {
  show_id: string;
  title: string;
  artwork_url: string | null;
  feed_url: string | null;
  tier: CatalogueTier;
  taxonomy_node_ids: string[];
  editorial_note: string | null;
}

interface CuratedShowRaw {
  show_id: string;
  title: string;
  artwork_url?: string | null;
  feed_url?: string | null;
  taxonomy_node_ids?: string[];
  editorial_note?: string | null;
}

interface BreadthShowRaw {
  apple_collection_id: number;
  title: string;
  feed_url: string | null;
  artwork_url?: string | null;
  in_curated?: boolean;
}

let cached: CatalogueShowEntry[] | null = null;

/**
 * Reads catalog.json + catalog-breadth.json fresh from disk and returns the
 * merged, deduped index. Cached per-process (module scope) — both files are
 * static build artifacts, not something that changes within a running
 * server — mirrors `backend/src/generation/catalogueLookup.ts`'s cache
 * pattern. `FORAY_SKIP_CATALOGUE_CACHE=1` disables the cache for tests that
 * mutate fixture files on disk between reads.
 */
export function loadBreadthCatalog(): CatalogueShowEntry[] {
  if (cached && process.env.FORAY_SKIP_CATALOGUE_CACHE !== "1") return cached;

  const curated = readJson<{ shows: CuratedShowRaw[] }>("data/catalog.json");
  const breadth = readJson<{ shows: BreadthShowRaw[] }>("data/catalog-breadth.json");

  const entries: CatalogueShowEntry[] = [];
  const seenIds = new Set<string>();

  for (const show of curated.shows ?? []) {
    if (!show.show_id || !show.title) continue;
    if (seenIds.has(show.show_id)) continue;
    seenIds.add(show.show_id);
    entries.push({
      show_id: show.show_id,
      title: show.title,
      artwork_url: show.artwork_url ?? null,
      feed_url: show.feed_url ?? null,
      tier: "curated",
      taxonomy_node_ids: show.taxonomy_node_ids ?? [],
      editorial_note: show.editorial_note ?? null,
    });
  }

  for (const show of breadth.shows ?? []) {
    if (show.in_curated) continue; // already present via the curated entry above
    if (show.apple_collection_id === undefined || show.apple_collection_id === null || !show.title) continue;
    const id = String(show.apple_collection_id);
    if (seenIds.has(id)) continue; // guards a breadth/curated id collision, belt-and-suspenders
    seenIds.add(id);
    entries.push({
      show_id: id,
      title: show.title,
      artwork_url: show.artwork_url ?? null,
      feed_url: show.feed_url ?? null,
      tier: "breadth",
      taxonomy_node_ids: [],
      editorial_note: null,
    });
  }

  cached = entries;
  return entries;
}

function readJson<T>(relPath: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- relPath is one of two hardcoded catalogue filenames, not external input.
  const raw = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return JSON.parse(raw) as T;
}
