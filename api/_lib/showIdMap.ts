/**
 * Show id-map for `api/episodes/search.ts`'s Apple fallback (S-07, kanban
 * t_6baccaa0): maps an Apple `collectionId` (from an iTunes search hit) back
 * to a 4a `show_id` so an episode result can link to a show page and reuse
 * the existing episode-row UI.
 *
 * ONE SOURCE: the two committed catalogue files, read through
 * `showCatalog.ts` (code-health-2 CH2-24) — the same one parse, and the same
 * admission rule, every show page lookup uses. A curated show's Apple id maps
 * to its SLUG (curated wins, always: the slug is what `#/show/:id` resolves);
 * a breadth show's maps to its own number; an `in_curated` breadth row adds
 * nothing (its id is its curated twin's Apple id). So every id this map hands
 * out is an id `/api/shows/search?id=` and both episode endpoints answer.
 *
 * WHY BOTH FILES (P-05, docs/search-parity-plan.md §4, 2026-09-12). Curated
 * alone was 220 ids, and measured against Apple's live endpoint over eight
 * probe queries it mapped 21 of 78 hits: FIVE of the eight queries returned
 * zero episodes with `degraded:false` — `tim ferriss`, `sam harris`,
 * `elon musk`, `artificial intelligence`, `the daily`. With the breadth file
 * the same 78 hits map 66. `search.ts:mapAppleHit` still drops a hit this map
 * cannot place (it would link to a show page that does not exist); with both
 * files that rule fires on genuine strangers, not on three quarters of every
 * answer.
 *
 * NOT THE SHOWS-INDEX RELEASE. `data/shows-index-pointer.json` names a
 * published release, but its `id-map.json` is curated slug -> PodcastIndex
 * id (`tools/shows/shard-build.mjs:buildIdMap`), not Apple collectionId ->
 * show_id, and the pointer names no id-map asset. The reader that would
 * have fetched it was unreachable and was deleted (code-health-2 CH2-02,
 * A1-01); `api/_test/show-id-map.test.mjs` pins the shape mismatch.
 *
 * The catalogue files unavailable: an empty map, `source: "none"` — every
 * Apple hit is then dropped, never linked to a show page that cannot open.
 * Nothing is cached here: showCatalog.ts keeps the map per warm instance.
 */

import { appleIdToShowId } from "./showCatalog";

export interface ShowIdMap {
  // collectionId -> show_id
  byCollectionId: ReadonlyMap<number, string>;
  source: "catalog" | "none";
}

const NONE: ShowIdMap = { byCollectionId: new Map(), source: "none" };

/** The map. Async only so `api/episodes/search.ts` keeps its call shape;
 *  nothing here awaits, and nothing here touches the network. */
export async function loadShowIdMap(): Promise<ShowIdMap> {
  let byCollectionId: ReadonlyMap<number, string>;
  try {
    byCollectionId = appleIdToShowId();
  } catch {
    return NONE; // CatalogFilesUnavailableError — see the header
  }
  return byCollectionId.size > 0 ? { byCollectionId, source: "catalog" } : NONE;
}
