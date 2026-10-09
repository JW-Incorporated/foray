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
 * product principle #3). A podcasting-2.0 chapters JSON file is never
 * fetched here (only its `<podcast:chapters url>` pointer is stored), so a
 * 400-episode show's ingestion pass costs exactly one request, not 401.
 */

export interface IngestShowFeedResult {
  showId: string;
  status: "fresh" | "not_modified" | "cached_stale" | "no_cache_error";
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
 * THE one ParsedEpisode -> CatalogShowEpisode mapping, used by this ingest
 * (DB mode) and by the live per-show list (api/shows/[show_id]/episodes.ts),
 * so the two branches of one endpoint cannot serve the same feed differently
 * (CH2-01, B1-01: the DB copy hardcoded `chapters: null` while the live one
 * served the feed's chapters).
 *
 * `guid` is minted HERE, after the drop below, with THE identity rule
 * (feeds/episodeIdentity.ts) the show-scoped search also uses, so the list,
 * the search and the DB store serve one id for one episode. Minting it after
 * the drop is what lets that rule need no feed position: every item that
 * reaches it has an enclosure URL (code-health-2 CH2-35, B1-07).
 *
 * `chapters` carries the chapters the feed published INLINE (Podlove Simple
 * Chapters, `psc:chapters` — parser.ts `inlineChapters`), sorted by start, or
 * null when the item has none. A podcasting-2.0 `podcast:chapters` JSON file
 * is never fetched here: only its pointer, `chapters_url`, is carried, and the
 * body is fetched separately per episode (#1071). A missing enclosure never
 * fabricates an audio_url: the item is dropped.
 */
export function toCatalogEpisode(showId: string, ep: ParsedEpisode): CatalogShowEpisode | null {
  const enclosureUrl = ep.enclosureUrl;
  if (!enclosureUrl) return null; // no real audio_url -> not a playable episode, drop it (never a fabricated pointer)
  return {
    show_id: showId,
    guid: episodeIdentity({ guid: ep.guid, title: ep.title, publishedAt: ep.publishedAt, enclosureUrl }),
    title: ep.title,
    description_html: ep.descriptionHtml,
    description_text: ep.descriptionText || null,
    published_at: ep.publishedAt,
    duration_seconds: ep.duration.seconds,
    audio_url: enclosureUrl,
    season_number: ep.seasonNumber,
    episode_number: ep.episodeNumber,
    chapters_url: ep.chaptersUrl,
    chapters: ep.inlineChapters ?? null
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
 * is NOT wired in. The only backoff is the per-show one above. The live
 * per-host budget is its pinned port, tools/poll/politeness.mjs, which the
 * S-10 poller uses (tools/poll/select-due.mjs, poll-cycle.mjs; the daily
 * episode-poll.yml run is a dry run until PKG-10) — not this path.
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
    return { showId, status: "no_cache_error", error: errorMessage(err) };
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

  if (freshEnough) return { showId, status: "not_modified" };

  const backingOff =
    prior !== null &&
    prior.last_fetch_ok === false &&
    prior.last_fetched_at !== null &&
    now() - new Date(prior.last_fetched_at).getTime() < failureBackoffMs(prior.consecutive_failures, ttlMs);

  if (backingOff) {
    const error = prior.last_error ?? "feed failing; backing off";
    return { showId, status: (await store.hasEpisodes(showId)) ? "cached_stale" : "no_cache_error", error };
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
    return { showId, status: "not_modified" };
  }

  if (fetchResult.error || fetchResult.body === null) {
    const failures = (prior?.consecutive_failures ?? 0) + 1;
    await store.recordFeedFetch({
      ...baseState,
      last_fetch_ok: false,
      last_error: fetchResult.error ?? `unexpected empty body (status ${fetchResult.status})`,
      consecutive_failures: failures
    });
    return {
      showId,
      status: (await store.hasEpisodes(showId)) ? "cached_stale" : "no_cache_error",
      error: fetchResult.error
    };
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
    return { showId, status: (await store.hasEpisodes(showId)) ? "cached_stale" : "no_cache_error", error };
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

  return { showId, status: "fresh" };
}
