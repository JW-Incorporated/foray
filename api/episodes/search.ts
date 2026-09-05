import * as fs from "fs";
import * as path from "path";
import { applyCors } from "../_lib/cors";
import { fetchFeedConditional } from "../../backend/src/feeds/conditionalGet";
import { parseFeed, type ParsedEpisode } from "../../backend/src/feeds/parser";
import { appleSearchBucket } from "./appleBucket";
import { loadShowIdMap } from "./showIdMap";
import { episodeSearchCache, normalizeQueryKey } from "./searchCache";

/**
 * GET /api/episodes/search?q=<query>&show=<show_id> — episode search (S-07,
 * kanban t_6baccaa0). See the design comment on t_6baccaa0 for the rationale
 * behind the two deviations from a literal reading of the card (id-map
 * fallback pre-S-04, per-instance-only rate limit/cache).
 *
 * TWO MODES, chosen by whether `show=` is present:
 *
 *   1. GENERAL SEARCH (no `show=`): queries Apple's public, keyless
 *      `itunes.apple.com/search?entity=podcastEpisode` endpoint, rate
 *      limited to <=20/min (appleBucket.ts) and cached 1h by normalized
 *      query (searchCache.ts). Every hit's `collectionId` is mapped back to
 *      a 4a `show_id` via showIdMap.ts; a hit that doesn't map to any known
 *      show is DROPPED (never surfaced with a broken show link) — this is
 *      the card's own explicit rule.
 *
 *   2. SHOW-SCOPED SEARCH (`show=<show_id>`): no Apple call at all. Fetches
 *      that show's live feed (S-02's exact path: fetchFeedConditional +
 *      parseFeed, no persisted state between invocations — same no-DB-mode
 *      shape as `api/shows/[show_id]/episodes.ts`) and filters episodes by
 *      a case-insensitive substring match on title. This is cheap, doesn't
 *      touch the rate-limited Apple endpoint, and gives an exact answer for
 *      a show 4a already knows about.
 *
 * DB-MODE: not implemented. The card asks for it to be "stubbed behind
 * DATABASE_URL presence for a later card" — production has no DATABASE_URL
 * today (S-02's PR), so this always takes the no-DB path regardless of the
 * env var. A later card wires an ingested-index-first path the way S-02's
 * episodes.ts wires DB mode for the per-show list.
 *
 * Never touches audio bytes — only ever returns metadata pointers (ADR-0007
 * / product principle #3), same as every other endpoint in this directory.
 */

const APPLE_SEARCH_URL = "https://itunes.apple.com/search";
const EPISODE_USER_AGENT = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
const APPLE_TIMEOUT_MS = 8_000; // keeps the <1.5s acceptance target reachable even with cache misses
const MAX_RESULTS = 25;

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(): void;
}

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export interface EpisodeSearchResult {
  show_id: string;
  show_title: string | null;
  title: string;
  guid: string | null;
  description_text: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  audio_url: string | null;
  source: "apple" | "live";
}

interface AppleEpisodeHit {
  collectionId?: number;
  collectionName?: string;
  trackName?: string;
  episodeGuid?: string;
  description?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  episodeUrl?: string;
}

/** Maps one Apple search hit to our shape, or null if its collectionId doesn't resolve to a known show. */
function mapAppleHit(hit: AppleEpisodeHit, idMap: Map<number, string>): EpisodeSearchResult | null {
  if (typeof hit.collectionId !== "number") return null;
  const show_id = idMap.get(hit.collectionId);
  if (!show_id) return null; // unmapped — dropped, per the card's own rule
  if (!hit.trackName) return null;
  return {
    show_id,
    show_title: hit.collectionName ?? null,
    title: hit.trackName,
    guid: hit.episodeGuid ?? null,
    description_text: hit.description ?? null,
    published_at: hit.releaseDate ?? null,
    duration_seconds: typeof hit.trackTimeMillis === "number" ? Math.round(hit.trackTimeMillis / 1000) : null,
    audio_url: hit.episodeUrl ?? null,
    source: "apple"
  };
}

/** Maps a freshly-parsed live-feed episode to our shape (show-scoped path). */
function mapLiveEpisode(showId: string, showTitle: string | null, ep: ParsedEpisode): EpisodeSearchResult | null {
  if (!ep.enclosureUrl) return null;
  return {
    show_id: showId,
    show_title: showTitle,
    title: ep.title,
    guid: ep.guid,
    description_text: ep.descriptionText || null,
    published_at: ep.publishedAt,
    duration_seconds: ep.duration.seconds,
    audio_url: ep.enclosureUrl,
    source: "live"
  };
}

async function searchApple(
  query: string,
  limit: number,
  fetchImpl: typeof fetch
): Promise<{ hits: AppleEpisodeHit[]; error: string | null }> {
  const url = `${APPLE_SEARCH_URL}?entity=podcastEpisode&limit=${encodeURIComponent(String(Math.min(limit, 200)))}&term=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPLE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": EPISODE_USER_AGENT, Accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) return { hits: [], error: `Apple search HTTP ${res.status}` };
    const body = (await res.json()) as { results?: AppleEpisodeHit[] };
    return { hits: body.results ?? [], error: null };
  } catch (err) {
    return { hits: [], error: `Apple search fetch error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithinShow(
  showId: string,
  query: string,
  fetchImpl: typeof fetch
): Promise<{ results: EpisodeSearchResult[]; error: string | null }> {
  // Find the show's feed URL. This is a pure local lookup (data/catalog.json,
  // no network) — the show/collectionId id-map (showIdMap.ts) is a different
  // join (Apple collectionId -> show_id) not needed here, so it's not loaded
  // in this path. Loading it unconditionally would trigger a network fetch
  // of S-04's release id-map on every show-scoped query once that release
  // exists, for no benefit to this path.
  const meta = await loadShowMeta(showId);
  if (!meta) return { results: [], error: `unknown show_id: ${showId}` };

  const fetchResult = await fetchFeedConditional(meta.feedUrl, { etag: null, lastModified: null }, {
    fetchImpl,
    userAgent: EPISODE_USER_AGENT
  });
  if (fetchResult.error || fetchResult.body === null) {
    return { results: [], error: fetchResult.error ?? `unexpected empty body (status ${fetchResult.status})` };
  }

  const parsed = parseFeed(fetchResult.body);
  const q = query.trim().toLowerCase();
  const results = parsed.episodes
    .filter((ep) => ep.title.toLowerCase().includes(q))
    .map((ep) => mapLiveEpisode(showId, meta.title, ep))
    .filter((ep): ep is EpisodeSearchResult => ep !== null);
  return { results, error: null };
}

interface ShowMeta {
  feedUrl: string;
  title: string | null;
}

let showMetaIndex: Map<string, ShowMeta> | null = null;

async function loadShowMeta(showId: string): Promise<ShowMeta | null> {
  if (!showMetaIndex) {
    const REPO_ROOT = path.resolve(__dirname, "..", "..");
    const index = new Map<string, ShowMeta>();
    for (const file of ["data/catalog.json", "data/catalog-breadth.json"]) {
      try {
        const raw = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
        const parsed = JSON.parse(raw) as {
          shows: Array<{ show_id?: string; apple_collection_id?: number; feed_url: string | null; title?: string | null }>;
        };
        for (const show of parsed.shows ?? []) {
          const id = show.show_id ?? (show.apple_collection_id !== undefined ? String(show.apple_collection_id) : null);
          if (id && show.feed_url && !index.has(id)) {
            index.set(id, { feedUrl: show.feed_url, title: show.title ?? null });
          }
        }
      } catch {
        // degrades to "show not found" below
      }
    }
    showMetaIndex = index;
  }
  return showMetaIndex.get(showId) ?? null;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const q = firstParam(req.query.q);
  if (!q || !q.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const showScope = firstParam(req.query.show);
  const limitParam = firstParam(req.query.limit);
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : MAX_RESULTS;

  const cacheKey = normalizeQueryKey(q, showScope, limit);
  const cached = episodeSearchCache.get(cacheKey) as { episodes: EpisodeSearchResult[]; source: string[] } | undefined;
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({ query: q, show: showScope, episodes: cached.episodes, source: cached.source, degraded: false, error: null });
    return;
  }

  if (showScope) {
    const { results, error } = await searchWithinShow(showScope, q, fetch);
    const payload = {
      query: q,
      show: showScope,
      episodes: results.slice(0, limit),
      source: ["live"],
      degraded: !!error && results.length === 0,
      error: error && results.length === 0 ? error : null
    };
    if (!error) episodeSearchCache.set(cacheKey, { episodes: payload.episodes, source: payload.source });
    res.setHeader("Cache-Control", error ? "no-store" : "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json(payload);
    return;
  }

  // General (unscoped) search — the rate-limited Apple path.
  if (!appleSearchBucket.tryConsume()) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      query: q,
      show: null,
      episodes: [],
      source: [],
      degraded: true,
      error: "rate limit exceeded — try again shortly"
    });
    return;
  }

  const idMap = await loadShowIdMap({ fetchImpl: fetch });
  const { hits, error } = await searchApple(q, limit, fetch);
  const episodes = hits
    .map((hit) => mapAppleHit(hit, idMap.byCollectionId))
    .filter((ep): ep is EpisodeSearchResult => ep !== null)
    .slice(0, limit);

  const payload = {
    query: q,
    show: null,
    episodes,
    source: episodes.length ? ["apple"] : [],
    degraded: !!error,
    error: error ?? null
  };
  if (!error) episodeSearchCache.set(cacheKey, { episodes: payload.episodes, source: payload.source });
  res.setHeader("Cache-Control", error ? "no-store" : "public, max-age=300, stale-while-revalidate=3600");
  res.status(200).json(payload);
}
