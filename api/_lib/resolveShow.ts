import { fetchIndexAsset, isShardKey } from "./showsIndexRelease";
import { showMetaById, ensureCorpusCatalogue, CatalogFilesUnavailableError, type ShowMeta } from "./showCatalog";

/**
 * THE ONE SHOW RESOLVER for the two endpoints that read a show's episodes
 * (code-health-2 CH2-35: A1-03's server half): the per-show list
 * (`api/shows/[show_id]/episodes.ts`) and its search box
 * (`api/episodes/search.ts?show=`). Both ask `resolveShow(showId, k)` and
 * answer what it says, so the two cannot disagree about which shows exist.
 *
 *   resolveShow(showId, k) = the catalogue (api/_lib/showCatalog.ts, CH2-24)
 *                            ?? the `pi:` shard row named by `k`.
 *
 * Before this the list resolved a `pi:` show through its shard and the search
 * asked only the catalogue, so every in-show search on a shard-index show
 * (most of the directory) was a doomed round trip answering `unknown show_id`.
 *
 * Feeds are NOT fetched here: the answer is the feed URL, and every feed fetch
 * still goes through the destination guard in api/_lib/feedCache.ts
 * (feedGuard.ts, SEC-01). The only request this makes is the one shard read,
 * through the shows-index release reader, besides the corpus catalogue's
 * once-per-instance fetch, which only happens when its pointer exists
 * (showCatalog.ts `ensureCorpusCatalogue`, PKG-33).
 */

/** What either endpoint answers when there is no show to read: the status the
 *  list serves and the error both carry. `noStore` is false only for an id the
 *  catalogue simply does not know (its 404 has always been edge-cacheable);
 *  a `pi:` miss, a release that could not be read and a deploy without the
 *  catalogue pair must be seen again at once. */
export type ShowLookup =
  | { meta: ShowMeta }
  | { meta: null; status: 404 | 502 | 503; error: string; noStore: boolean };

export const UNKNOWN_SHOW_ID = "unknown show_id";

/* A `pi:<n>` SHOW (pi-episodes-cold-open, #690; follows SH-COLD #1141).

   A show found through the shard index has a raw PodcastIndex row id,
   `pi:<n>` (app.js mapShardRow), and is in neither catalogue file, so
   the catalogue never knew it: its episodes answered 404 and a shared link
   to one of them could not open. The row (`{ id, t, a, i, u, img, n, c }`,
   tools/shows/shard-build.mjs toShardRow) carries the feed url, but the
   shards are filed by title/author token prefix, not by id, and there is no
   id -> row map to ask. So the caller names the shard: `?k=<key>`, the same
   key a shared show link already carries as `/k/<key>` (app.js shareLinkFor).
   ONE shard is read, through the same release reader the shard proxy uses
   (api/_lib/showsIndexRelease.ts: the committed pointer, bounded fetch,
   gunzip), and the row with that id gives the feed. No new secret, service
   or store: the pointer is already bundled (vercel.json includeFiles).

   Answers: a malformed id or key, or a shard without the row, is the same 404
   `unknown show_id` an unknown catalogue id gets (no request for the first
   two). A release that could not be read is a 502, so the client offers Try
   again rather than "not found". Both are no-store: a pointer bump or a
   recovered upstream must be seen at once. A resolved row is kept per warm
   instance (bounded), keyed by id AND key, so the answer for one request
   never depends on what another one asked before it, and the pages of one
   show read their shard once. The answer is the catalogue's `ShowMeta`. */
const PI_SHOW_RE = /^pi:(\d{1,15})$/;
export const PI_SHOW_CACHE_MAX = 500;
const piShowMeta = new Map<string, ShowMeta>();

/** True for an id that only the shard index can answer. */
export function isPiShowId(showId: string): boolean {
  return showId.startsWith("pi:");
}

const piMiss = (): ShowLookup => ({ meta: null, status: 404, error: UNKNOWN_SHOW_ID, noStore: true });

async function resolvePiShow(showId: string, key: string | null): Promise<ShowLookup> {
  const id = PI_SHOW_RE.exec(showId)?.[1];
  if (!id || !isShardKey(key)) return piMiss();
  const cacheKey = `${showId} ${key}`;
  const kept = piShowMeta.get(cacheKey);
  if (kept) return { meta: kept };

  const got = await fetchIndexAsset(`shards/${key}.json`);
  if (!got.ok) {
    return got.status === 502
      ? { meta: null, status: 502, error: `shows index unavailable: ${got.error}`, noStore: true }
      : piMiss();
  }
  const rows: unknown[] = Array.isArray(got.body) ? got.body : [];
  const row = rows.find((r): r is Record<string, unknown> =>
    !!r && typeof r === "object" && String((r as Record<string, unknown>).id) === id);
  /* Only an http(s) feed is fetched: the url comes from our own release, but
     the endpoints fetch whatever it names (through the feed guard). */
  const feedUrl = row && typeof row.u === "string" && /^https?:\/\//i.test(row.u) ? row.u : null;
  if (!row || !feedUrl) return piMiss();

  const meta: ShowMeta = {
    showId,
    feedUrl,
    title: typeof row.t === "string" ? row.t : null,
    image: typeof row.img === "string" ? row.img : null,
  };
  if (piShowMeta.size >= PI_SHOW_CACHE_MAX) piShowMeta.delete(piShowMeta.keys().next().value as string);
  piShowMeta.set(cacheKey, meta);
  return { meta };
}

/**
 * The show `showId` names, for reading its episodes: the catalogue's answer
 * (an `in_curated` alias answers as its curated twin), else, for a `pi:` id,
 * the shard row `key` names. A deploy without the catalogue pair is a 503 for
 * a catalogue id; a `pi:` show never came from the catalogue, so its shard
 * still answers.
 */
export async function resolveShow(showId: string, key: string | null): Promise<ShowLookup> {
  let meta: ShowMeta | null = null;
  const corpus = ensureCorpusCatalogue(); // PKG-33: the corpus catalogue, if its pointer names one (showCatalog.ts)
  if (corpus) await corpus;
  try {
    meta = showMetaById(showId);
  } catch (err) {
    if (!(err instanceof CatalogFilesUnavailableError)) throw err;
    if (!isPiShowId(showId)) return { meta: null, status: 503, error: err.message, noStore: true };
  }
  if (meta) return { meta };
  if (isPiShowId(showId)) return resolvePiShow(showId, key);
  return { meta: null, status: 404, error: UNKNOWN_SHOW_ID, noStore: false };
}

/** Test-only: forget every resolved `pi:` show. */
export function _resetPiShowCacheForTests(): void {
  piShowMeta.clear();
}

/** Test-only: how many resolved `pi:` shows this instance keeps. */
export function _piShowCacheSizeForTests(): number {
  return piShowMeta.size;
}
