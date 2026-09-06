/**
 * Show id-map for `api/episodes/search.ts`'s Apple fallback (S-07, kanban
 * t_6baccaa0): maps an Apple `collectionId` (from an iTunes search hit) back
 * to a 4a `show_id` so an episode result can link to a show page and reuse
 * the existing episode-row UI.
 *
 * TWO SOURCES, PREFERRING THE REAL RELEASE:
 *   1. S-04's shard-index release (`data/shows-index-pointer.json` ->
 *      released `id-map.json`, itunes_id -> show_id, built from the full
 *      PodcastIndex-derived catalogue). This is the intended long-term
 *      source and covers far more than the 220 curated shows.
 *   2. FALLBACK: `data/catalog.json`'s own `apple_collection_id` field
 *      (220 curated shows). S-04 has not shipped yet as of this card
 *      (t_319a554f's children t_c175e965/t_d27f78d9 are still unclaimed) —
 *      see the design note on t_6baccaa0. Without this fallback, episode
 *      search would return zero results for every query until S-04 lands,
 *      which is a materially worse interim state than a narrower id-map.
 *      Once a real release exists, source 1 is used and covers a superset
 *      of source 2 naturally (every curated show is required to be in
 *      S-04's id-map, per that card's own fail-closed acceptance rule).
 *
 * Cached in-memory per warm instance (same per-instance caveat as
 * appleBucket.ts) — rebuilt lazily on first use, not on every request.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface ShowIdMap {
  // collectionId -> show_id
  byCollectionId: Map<number, string>;
  source: "release" | "catalog-fallback" | "none";
}

let cached: ShowIdMap | null = null;

interface ShowsIndexPointer {
  id_map_url?: string;
  // Other fields (manifest_url, version, etc.) are S-04b's concern; only
  // id_map_url matters here. Absent/malformed pointer degrades to the
  // catalog fallback, never a throw.
}

function loadCatalogFallback(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "catalog.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      shows: Array<{ show_id?: string; apple_collection_id?: number }>;
    };
    for (const show of parsed.shows ?? []) {
      if (show.show_id && typeof show.apple_collection_id === "number") {
        map.set(show.apple_collection_id, show.show_id);
      }
    }
  } catch {
    // Missing/unreadable catalog degrades to an empty map — search still
    // works, results are just unmapped-and-dropped (never a crash).
  }
  return map;
}

/**
 * Attempts to read the S-04 release pointer and fetch its id-map. Network
 * fetch (the release asset lives on GitHub Releases, not in this repo) —
 * failure of any kind degrades to `null` so the caller falls back to the
 * catalog-derived map rather than erroring the whole search request.
 */
async function tryLoadReleaseIdMap(fetchImpl: typeof fetch): Promise<Map<number, string> | null> {
  let pointer: ShowsIndexPointer;
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "shows-index-pointer.json"), "utf8");
    pointer = JSON.parse(raw) as ShowsIndexPointer;
  } catch {
    return null; // S-04 hasn't shipped a pointer yet — expected today
  }
  if (!pointer.id_map_url) return null;

  try {
    const res = await fetchImpl(pointer.id_map_url);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, string> | Array<{ itunes_id: number; show_id: string }>;
    const map = new Map<number, string>();
    if (Array.isArray(body)) {
      for (const row of body) {
        if (typeof row.itunes_id === "number" && typeof row.show_id === "string") {
          map.set(row.itunes_id, row.show_id);
        }
      }
    } else {
      for (const [k, v] of Object.entries(body)) {
        const id = Number(k);
        if (Number.isFinite(id) && typeof v === "string") map.set(id, v);
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

export async function loadShowIdMap(opts: { fetchImpl?: typeof fetch; forceReload?: boolean } = {}): Promise<ShowIdMap> {
  if (cached && !opts.forceReload) return cached;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const fromRelease = await tryLoadReleaseIdMap(fetchImpl);
  if (fromRelease) {
    cached = { byCollectionId: fromRelease, source: "release" };
    return cached;
  }

  const fallback = loadCatalogFallback();
  cached = { byCollectionId: fallback, source: fallback.size > 0 ? "catalog-fallback" : "none" };
  return cached;
}

/** Test-only: clears the module-level cache between test files. */
export function _resetShowIdMapCacheForTests(): void {
  cached = null;
}
