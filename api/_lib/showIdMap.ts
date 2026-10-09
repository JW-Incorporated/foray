/**
 * Show id-map for `api/episodes/search.ts`'s Apple fallback (S-07, kanban
 * t_6baccaa0): maps an Apple `collectionId` (from an iTunes search hit) back
 * to a 4a `show_id` so an episode result can link to a show page and reuse
 * the existing episode-row UI.
 *
 * ONE SOURCE: the two committed catalogue files — `data/catalog.json`'s
 * `apple_collection_id` (220 curated shows, slug ids) merged ahead of
 * `data/catalog-breadth.json`'s (~19.7k breadth shows, numeric ids). See
 * loadCatalogFallback() below for the measurement and for why curated must
 * be merged first. ("Fallback" is historical: there is nothing left to fall
 * back from.)
 *
 * NOT THE SHOWS-INDEX RELEASE. `data/shows-index-pointer.json` names a
 * published release, but its `id-map.json` is curated slug -> PodcastIndex
 * id (`tools/shows/shard-build.mjs:buildIdMap`), not Apple collectionId ->
 * show_id, and the pointer names no id-map asset. The reader that would
 * have fetched it was unreachable and was deleted (code-health-2 CH2-02,
 * A1-01); `api/_test/show-id-map.test.mjs` pins the shape mismatch.
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
  source: "catalog" | "none";
}

let cached: ShowIdMap | null = null;

/* BOTH CATALOGUE FILES, CURATED FIRST (P-05, docs/search-parity-plan.md
   §4, 2026-09-12).

   This function read `data/catalog.json` ALONE — 220 ids — which made the
   drop rule in `search.ts:mapAppleHit` the episode path's real defect
   rather than its safety rail. Measured against Apple's live endpoint on
   2026-09-12 over the eight probe queries: 78 hits, 21 mappable, 57
   dropped (73 %), and FIVE of the eight queries returned zero episodes
   with `degraded:false` — `tim ferriss`, `sam harris`, `elon musk`,
   `artificial intelligence`, `the daily`. Adding the breadth file takes
   the same 78 hits to 66 mappable.

   IT COSTS NO WIRE BYTES. `data/catalog-breadth.json` is already named in
   `vercel.json`'s `includeFiles` glob and is already read, in this same
   deployed function, by `search.ts:loadShowMeta()` — the show-scoped path
   has resolved against all 19,787 rows since S-07 while the Apple path
   next to it was stuck on 220. Cost is one lazy 12.5 MB read+parse per
   warm instance: measured 26-29 ms read / 40-46 ms parse / 2-21 ms build
   ≈ 95 ms, ONCE, against a 369 ms median cold Apple round trip. It is not
   paid per request and it is not paid at all on the show-scoped path,
   which never loads this map.

   ORDER IS LOAD-BEARING, and it is the one thing a careless merge gets
   wrong. `backend/src/catalog/breadthCatalog.ts` mints a breadth show's
   `show_id` as `String(apple_collection_id)` but DROPS any breadth row
   flagged `in_curated` — that show is present in the merged catalogue
   only under its curated SLUG. So:
     · curated wins, always — a slug id is what `/api/shows/search?id=`
       and `#/show/:id` will actually resolve for those shows;
     · a breadth row flagged `in_curated` is skipped here for exactly the
       reason breadthCatalog.ts skips it, mirroring that admission rule
       field for field (`in_curated`, numeric id, non-empty title). Minting
       a numeric id for a row the merged catalogue drops would manufacture
       precisely the broken show link the drop rule was written to prevent.
     (Verified on the committed data 2026-09-12: all 103 `in_curated`
     breadth rows have a curated counterpart, so skipping them loses
     nothing today — it is the invariant, not today's numbers, that this
     mirrors.)

   AND THE DROP RULE'S ORIGINAL JUSTIFICATION IS SPENT. `search.ts` drops
   an unmapped hit so a result is "never surfaced with a broken show link".
   That was true when a breadth show page 404'd on a cold open; S-06(b) /
   #560 fixed it, and `api/shows/search.ts:showByIdFromCatalog` now
   resolves any merged-catalogue id. Verified live 2026-09-12:
   `GET /api/shows/search?id=863897795` -> "The Tim Ferriss Show". The rule
   stays (an id that maps to nothing still must not render a dead link) —
   what changes is that it now fires on the handful of hits that genuinely
   are outside our catalogue, not on three quarters of every answer. */
function loadCatalogFallback(): Map<number, string> {
  const map = new Map<number, string>();

  // Pass 1 — curated (220). Its slug id must be set BEFORE the breadth
  // pass so a curated show can never be given a numeric id below.
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

  // Pass 2 — breadth (~19.7k). Same admission rule as
  // breadthCatalog.ts:loadBreadthCatalog, so every id minted here is an id
  // that file will hand back to a show-page lookup.
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "catalog-breadth.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      shows: Array<{ apple_collection_id?: number; title?: string; in_curated?: boolean }>;
    };
    for (const show of parsed.shows ?? []) {
      if (show.in_curated) continue; // present under its curated slug instead
      if (typeof show.apple_collection_id !== "number" || !show.title) continue;
      if (map.has(show.apple_collection_id)) continue; // curated already claimed it
      map.set(show.apple_collection_id, String(show.apple_collection_id));
    }
  } catch {
    // Breadth missing/unreadable degrades to the curated-only map — i.e.
    // exactly the behaviour that shipped before this change, never a crash.
  }

  return map;
}

/** The map, built once per warm instance (`forceReload` rebuilds it). Async
 *  only so `api/episodes/search.ts` keeps its call shape; nothing here awaits.
 *  `fetchImpl` is accepted and unused: the map never touches the network. */
export async function loadShowIdMap(
  opts: { fetchImpl?: typeof fetch; forceReload?: boolean } = {}
): Promise<ShowIdMap> {
  if (!cached || opts.forceReload) {
    const map = loadCatalogFallback();
    cached = { byCollectionId: map, source: map.size > 0 ? "catalog" : "none" };
  }
  return cached;
}

/** Test-only: clears the module-level cache between test files. */
export function _resetShowIdMapCacheForTests(): void {
  cached = null;
}
