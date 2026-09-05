import { Client } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { ingestShowFeed } from "../../../backend/src/catalog/ingestShowFeed";
import { PostgresShowEpisodesStore, type CatalogShowEpisode } from "../../../backend/src/catalog/showEpisodesStore";
import { fetchFeedConditional } from "../../../backend/src/feeds/conditionalGet";
import { parseFeed, type ParsedEpisode } from "../../../backend/src/feeds/parser";
import { applyCors } from "../../_lib/cors";
import { decodeCursor, paginate } from "../../_lib/episodeCursor";

/**
 * Fetch-on-demand per-show episode list (Stage 3b, kanban t_567b570f,
 * docs/show-pages-plan.md §Stage 3; hardened for production in S-02,
 * kanban t_4bd3c0a3). GET /api/shows/:show_id/episodes.
 *
 * This is the first Vercel serverless function in this repo — vercel.json
 * was previously static-build-only by deliberate choice (docs/DECISIONS.md).
 * Flagged explicitly in the design comment posted on the kanban card and in
 * this PR's description for Wyatt's review; reuses the existing Vercel
 * project/deploy and the already-provisioned Supabase service-role
 * connection, no new hosting account or secrets.
 *
 * Never touches audio bytes — only ever returns metadata pointers
 * (ADR-0007 / product principle #3). Degrades to cached rows on a feed
 * fetch failure, or an explicit error state — never a blank page.
 *
 * NO-DB MODE (D14, S-02): production has no `DATABASE_URL` configured
 * today, so every real request takes this branch. Rather than the old
 * `503 episode store not configured`, fetch the show's feed live
 * (conditional GET, capped body size — see conditionalGet.ts), parse it
 * with the same parser the DB-backed ingest path uses, and paginate the
 * result in memory (100/page, keyset cursor on published_at+guid — see
 * episodeCursor.ts). Nothing is persisted between invocations: this is a
 * plain GET dressed as conditional (no prior etag/last-modified to send),
 * and the CDN edge cache (`s-maxage=3600`) is what actually saves repeat
 * fetches, not the conditional-GET mechanism itself.
 *
 * DB mode (when DATABASE_URL IS set — currently dormant in production) is
 * unchanged from Stage 3b's original behavior.
 */

interface CatalogShowMeta {
  showId: string;
  feedUrl: string;
  title: string | null;
  image: string | null;
}

let showIndex: Map<string, CatalogShowMeta> | null = null; // show_id -> catalog metadata, lazily built from data/catalog*.json

/**
 * Walks up from `startDir` looking for the repo root (identified by
 * `data/catalog.json` existing directly under it). Vercel's bundled
 * runtime resolves `__dirname` to this file's real on-disk location, so
 * the previous fixed `join(__dirname, "..", "..", "..")` worked there —
 * but a dev/test runner using a different module transform (e.g. tsx's
 * ESM loader) does not always give `__dirname` that same on-disk value,
 * which made this function untestable without hardcoding an environment-
 * specific offset. Walking up is correct in both places and does not
 * depend on how many directories deep this file happens to sit.
 */
function findRepoRoot(startDir: string): string {
  // A module transform that doesn't preserve a real on-disk __dirname (seen
  // under tsx's test-runner ESM loader) hands back something that isn't a
  // real path at all (e.g. a `data:` URL string) — existsSync on that is
  // always false, so start from process.cwd() instead in that case. Vercel's
  // bundled runtime gives a real __dirname, so this branch is test-only.
  let dir = existsSync(startDir) ? startDir : process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "data", "catalog.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir; // fall back to the original assumption; catalog reads degrade to empty below, never a crash
}

function loadShowIndex(): Map<string, CatalogShowMeta> {
  if (showIndex) return showIndex;
  const index = new Map<string, CatalogShowMeta>();
  const ROOT = findRepoRoot(__dirname);
  for (const file of ["data/catalog.json", "data/catalog-breadth.json"]) {
    try {
      const raw = readFileSync(join(ROOT, file), "utf8");
      const parsed = JSON.parse(raw) as {
        shows: Array<{
          show_id?: string;
          apple_collection_id?: number;
          feed_url: string | null;
          title?: string | null;
          artwork_url?: string | null;
        }>;
      };
      for (const show of parsed.shows ?? []) {
        const id = show.show_id ?? (show.apple_collection_id !== undefined ? String(show.apple_collection_id) : null);
        if (id && show.feed_url && !index.has(id)) {
          index.set(id, {
            showId: id,
            feedUrl: show.feed_url,
            title: show.title ?? null,
            image: show.artwork_url ?? null
          });
        }
      }
    } catch {
      // Missing/unreadable catalog file degrades to "show not found" below — never a 500.
    }
  }
  showIndex = index;
  return index;
}

/**
 * Minimal structural types for the Vercel Node runtime request/response —
 * avoids adding `@vercel/node` as a new dependency to a root that is
 * deliberately dependency-free by design (root package.json's own
 * description). The runtime object shape (query, method, status().json())
 * is standard across Vercel's Node functions regardless of the SDK type
 * package being installed.
 */
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

const PAGE_SIZE = 100;

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Maps a freshly-parsed feed episode to the same shape the DB path returns.
 * `chapters` is always null here — same lazy-fetch rule as ingestShowFeed.ts
 * (only the pointer is ever stored/returned, the body is fetched separately
 * per-episode). A missing enclosure never fabricates an audio_url — dropped,
 * matching ingestShowFeed's own toCatalogEpisode rule. */
function toLiveEpisode(showId: string, ep: ParsedEpisode, idx: number): CatalogShowEpisode | null {
  if (!ep.enclosureUrl) return null;
  const guid = ep.guid ?? `noguid:${ep.title}:${ep.publishedAt ?? idx}`;
  return {
    show_id: showId,
    guid,
    title: ep.title,
    description_html: ep.descriptionHtml,
    description_text: ep.descriptionText || null,
    published_at: ep.publishedAt,
    duration_seconds: ep.duration.seconds,
    audio_url: ep.enclosureUrl,
    season_number: ep.seasonNumber,
    episode_number: ep.episodeNumber,
    chapters_url: ep.chaptersUrl,
    chapters: null
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const showId = typeof req.query.show_id === "string" ? req.query.show_id : null;
  if (!showId) {
    res.status(400).json({ error: "show_id is required" });
    return;
  }

  const meta = loadShowIndex().get(showId);
  if (!meta) {
    res.status(404).json({ error: "unknown show_id" });
    return;
  }

  const showHeader = { title: meta.title, description: null as string | null, image: meta.image };

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // No-DB mode (D14): fetch the feed live, no persisted cache between
    // invocations. See this file's header for why the conditional-GET
    // mechanism doesn't buy anything here without stored etag state.
    const cursor = decodeCursor(firstParam(req.query.cursor));
    const fetchResult = await fetchFeedConditional(meta.feedUrl, { etag: null, lastModified: null });

    if (fetchResult.error || fetchResult.body === null) {
      // Never a 500, never blank (repo convention — see ingestShowFeed.ts's
      // own degrade rule): 200 with an empty list and the error surfaced.
      // Cache-Control: no-store so a transient feed hiccup is never pinned
      // at the edge for the next hour of visitors to that show.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        show_id: showId,
        show: showHeader,
        episodes: [],
        next_cursor: null,
        source: "live",
        degraded: true,
        error: fetchResult.error ?? `unexpected empty body (status ${fetchResult.status})`
      });
      return;
    }

    const parsed = parseFeed(fetchResult.body);
    const episodes = parsed.episodes
      .map((ep, idx) => toLiveEpisode(showId, ep, idx))
      .filter((ep): ep is CatalogShowEpisode => ep !== null);

    const { page, nextCursor } = paginate(episodes, cursor, PAGE_SIZE);

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      show_id: showId,
      show: { ...showHeader, description: parsed.descriptionText || null },
      episodes: page,
      next_cursor: nextCursor,
      source: "live",
      degraded: false,
      error: null
    });
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const store = new PostgresShowEpisodesStore(client);
    const result = await ingestShowFeed(showId, meta.feedUrl, store);
    const episodes = await store.episodesForShow(showId);

    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({
      show_id: showId,
      // DB mode has no per-show description available without editing
      // ingestShowFeed.ts/showEpisodesStore.ts, which is out of scope for
      // this card (see the design comment on kanban t_4bd3c0a3) — left
      // null rather than guessed. Production has no DATABASE_URL today, so
      // this branch is currently dormant.
      show: showHeader,
      episodes,
      source: "db",
      stale: result.status === "cached_stale",
      error: result.status === "cached_stale" || result.status === "no_cache_error" ? result.error ?? null : null
    });
  } finally {
    await client.end();
  }
}
