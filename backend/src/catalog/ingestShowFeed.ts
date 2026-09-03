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

function episodeIdentity(ep: ParsedEpisode, idx: number): string {
  // Composite fallback mirrors ADR-0002's spirit (guid is unreliable alone) —
  // a feed with zero guids still gets stable, order-based identity within a
  // single ingest pass rather than every item colliding on an empty string.
  return ep.guid ?? `noguid:${ep.title}:${ep.publishedAt ?? idx}`;
}

function toCatalogEpisode(showId: string, ep: ParsedEpisode, idx: number): CatalogShowEpisode | null {
  if (!ep.enclosureUrl) return null; // no real audio_url -> not a playable episode, drop it (never a fabricated pointer)
  return {
    show_id: showId,
    guid: episodeIdentity(ep, idx),
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
 */
export async function ingestShowFeed(
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

  const parsed = parseFeed(fetchResult.body);
  const episodes = parsed.episodes
    .map((ep, idx) => toCatalogEpisode(showId, ep, idx))
    .filter((ep): ep is CatalogShowEpisode => ep !== null);

  await store.upsertEpisodes(episodes);
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
