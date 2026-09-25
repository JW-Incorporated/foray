import { episodeIdentity } from "../feeds/episodeIdentity";
import { fetchFeedConditional } from "../feeds/conditionalGet";
import { parseFeed, type ParsedEpisode } from "../feeds/parser";
import type { CatalogShowEpisode, ShowEpisodesStore, ShowFeedState } from "./showEpisodesStore";

/**
 * Stage 3b (docs/show-pages-plan.md §Stage 3, kanban t_567b570f): fetches a
 * show's own RSS feed, parses it with the existing feed parser, and upserts
 * its full episode list into the shared catalogue store. This is the
 * ingestion side of the fetch-on-demand endpoint — see
 * backend/src/catalog/showEpisodesStore.ts for the storage shape and design
 * comment.
 *
 * Reuses `fetchFeedConditional` (conditional GET, ADR-0001) rather than a
 * fresh fetch, so a same-content re-ingest costs a 304 and touches nothing.
 *
 * NEVER touches audio bytes — the produced `audio_url` is always the
 * original enclosure URL exactly as `parser.ts` extracted it (ADR-0007 /
 * product principle #3). Chapters JSON bodies are NOT fetched here — only
 * the `<podcast:chapters url>` pointer is stored; the body is fetched
 * lazily per-episode (see docs comment in showEpisodesStore.ts / the design
 * posted on the kanban card) so a 400-episode show's ingestion pass costs
 * exactly one request, not 401.
 */

export interface IngestShowFeedResult {
  showId: string;
  status: "fresh" | "not_modified" | "cached_stale" | "no_cache_error";
  episodeCount: number;
  error?: string;
}

/** Default freshness window: no per-show cadence signal exists at breadth-tier
 *  scale yet (docs/show-pages-plan.md §Stage 3 notes catalog.json's
 *  `cadence_hint` is the only signal today and isn't reliable enough to
 *  drive a variable TTL) — start flat, revisit once real fetch history
 *  accumulates. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** First back-off window after a failed fetch; doubles per consecutive
 *  failure and is capped at the TTL (backend-rest-12). */
export const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;

/**
 * How long a failed feed is left alone before the next fetch attempt:
 * min(ttl, base * 2^consecutive_failures). Without it a dead feed was
 * refetched (and waited on for up to the 15 s timeout) on every request.
 */
export function failureBackoffMs(consecutiveFailures: number, ttlMs: number): number {
  const n = Math.max(0, Math.min(consecutiveFailures, 30));
  return Math.min(ttlMs, FAILURE_BACKOFF_BASE_MS * 2 ** n);
}

/**
 * Stable per-episode identity: the ONE rule in feeds/episodeIdentity.ts, also
 * used by the live list and search, so both paths mint the same id. No
 * positional index here: the enclosure URL is always present on this path
 * (toCatalogEpisode drops items without one), so an undated guid-less episode
 * is keyed by it rather than by a feed position that shifts on every prepend.
 */
export { episodeIdentity };

function toCatalogEpisode(showId: string, ep: ParsedEpisode): CatalogShowEpisode | null {
  if (!ep.enclosureUrl) return null; // no real audio_url -> not a playable episode, drop it (never a fabricated pointer)
  return {
    show_id: showId,
    guid: episodeIdentity(ep),
    title: ep.title,
    description_html: ep.descriptionHtml,
    description_text: ep.descriptionText || null,
    published_at: ep.publishedAt,
    duration_seconds: ep.duration.seconds,
    audio_url: ep.enclosureUrl,
    season_number: ep.seasonNumber,
    episode_number: ep.episodeNumber,
    chapters_url: ep.chaptersUrl,
    chapters: null // lazy — never populated by this pass
  };
}

/**
 * Serves a show's episode list, fetching/parsing/upserting only when the
 * cached copy is missing or older than `ttlMs`. Never throws: a fetch or
 * parse failure degrades to the last-good cached rows (if any) with
 * `status: "cached_stale"`, or `"no_cache_error"` with an empty episode
 * list when there is nothing cached to fall back to — the endpoint layer
 * turns that into the "couldn't load" UI state, never a blank page.
 *
 * A parse or store failure on a fresh body is recorded as a failed fetch
 * (last_fetch_ok=false, consecutive_failures+1) and falls back the same way
 * (backend-rest-9). After a failure the feed is not refetched until
 * failureBackoffMs() has passed (backend-rest-12).
 *
 * Politeness gap (recorded here rather than in the applied 0016 comment,
 * which must not be edited): 0016 says this path "mirrors ADR-0001's ...
 * per-host politeness discipline", but feeds/politeness.ts PolitenessBudget
 * is NOT wired in. The only backoff is the per-show one above.
 */
export async function ingestShowFeed(
  showId: string,
  feedUrl: string,
  store: ShowEpisodesStore,
  opts: { ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<IngestShowFeedResult> {
  try {
    return await ingestShowFeedUnsafe(showId, feedUrl, store, opts);
  } catch (err) {
    // Last resort: the store itself failed (e.g. the database is down), so
    // there is no cache to fall back to either.
    return { showId, status: "no_cache_error", episodeCount: 0, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ingestShowFeedUnsafe(
  showId: string,
  feedUrl: string,
  store: ShowEpisodesStore,
  opts: { ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<IngestShowFeedResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  const prior = await store.getFeedState(showId);
  const freshEnough =
    prior?.last_fetched_at !== null &&
    prior?.last_fetched_at !== undefined &&
    prior.last_fetch_ok === true &&
    now() - new Date(prior.last_fetched_at).getTime() < ttlMs;

  if (freshEnough) {
    const cached = await store.episodesForShow(showId);
    return { showId, status: "not_modified", episodeCount: cached.length };
  }

  const backingOff =
    prior !== null &&
    prior.last_fetch_ok === false &&
    prior.last_fetched_at !== null &&
    now() - new Date(prior.last_fetched_at).getTime() < failureBackoffMs(prior.consecutive_failures, ttlMs);

  if (backingOff) {
    const cached = await store.episodesForShow(showId);
    const error = prior.last_error ?? "feed failing; backing off";
    if (cached.length > 0) return { showId, status: "cached_stale", episodeCount: cached.length, error };
    return { showId, status: "no_cache_error", episodeCount: 0, error };
  }

  const fetchResult = await fetchFeedConditional(
    feedUrl,
    { etag: prior?.etag ?? null, lastModified: prior?.last_modified ?? null },
    { fetchImpl: opts.fetchImpl }
  );

  const baseState: ShowFeedState = {
    show_id: showId,
    feed_url: feedUrl,
    etag: prior?.etag ?? null,
    last_modified: prior?.last_modified ?? null,
    last_fetched_at: new Date(now()).toISOString(),
    last_fetch_ok: null,
    last_error: null,
    consecutive_failures: prior?.consecutive_failures ?? 0
  };

  if (fetchResult.notModified) {
    await store.recordFeedFetch({
      ...baseState,
      etag: fetchResult.etag ?? baseState.etag,
      last_modified: fetchResult.lastModified ?? baseState.last_modified,
      last_fetch_ok: true,
      consecutive_failures: 0
    });
    const cached = await store.episodesForShow(showId);
    return { showId, status: "not_modified", episodeCount: cached.length };
  }

  if (fetchResult.error || fetchResult.body === null) {
    const failures = (prior?.consecutive_failures ?? 0) + 1;
    await store.recordFeedFetch({
      ...baseState,
      last_fetch_ok: false,
      last_error: fetchResult.error ?? `unexpected empty body (status ${fetchResult.status})`,
      consecutive_failures: failures
    });
    const cached = await store.episodesForShow(showId);
    if (cached.length > 0) {
      return { showId, status: "cached_stale", episodeCount: cached.length, error: fetchResult.error };
    }
    return { showId, status: "no_cache_error", episodeCount: 0, error: fetchResult.error };
  }

  let parsed: ReturnType<typeof parseFeed>;
  let episodes: CatalogShowEpisode[];
  try {
    parsed = parseFeed(fetchResult.body);
    episodes = parsed.episodes
      .map((ep) => toCatalogEpisode(showId, ep))
      .filter((ep): ep is CatalogShowEpisode => ep !== null);
    await store.upsertEpisodes(episodes);
  } catch (err) {
    const error = `ingest failed: ${errorMessage(err)}`;
    await store.recordFeedFetch({
      ...baseState,
      last_fetch_ok: false,
      last_error: error,
      consecutive_failures: (prior?.consecutive_failures ?? 0) + 1
    });
    const cached = await store.episodesForShow(showId);
    if (cached.length > 0) return { showId, status: "cached_stale", episodeCount: cached.length, error };
    return { showId, status: "no_cache_error", episodeCount: 0, error };
  }

  await store.recordFeedFetch({
    ...baseState,
    etag: fetchResult.etag ?? baseState.etag,
    last_modified: fetchResult.lastModified ?? baseState.last_modified,
    last_fetch_ok: true,
    last_error: episodes.length === 0 && parsed.episodes.length > 0
      ? "feed parsed but every episode lacked a usable enclosure URL"
      : null,
    consecutive_failures: 0
  });

  const finalList = await store.episodesForShow(showId);
  return { showId, status: "fresh", episodeCount: finalList.length };
}
