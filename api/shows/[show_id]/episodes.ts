import { Client } from "pg";
import { ingestShowFeed, toCatalogEpisode } from "../../../backend/src/catalog/ingestShowFeed";
import { PostgresShowEpisodesStore, type CatalogShowEpisode } from "../../../backend/src/catalog/showEpisodesStore";
import { applyCors } from "../../_lib/cors";
import { firstParam, type ApiRequest, type ApiResponse } from "../../_lib/params";
import { decodeCursor, paginate } from "../../_lib/episodeCursor";
import { sharedFeedReader } from "../../_lib/feedCache";
import { type ShowMeta } from "../../_lib/showCatalog";
import { resolveShow } from "../../_lib/resolveShow";

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
 * episodeCursor.ts). The parsed feed is kept per show in the warm instance
 * for a few minutes and then revalidated with the etag/last-modified it holds
 * (api/_lib/feedCache.ts, shared with the show-scoped search; round-3 audit,
 * search-api-css-3), so the pages of one show cost one fetch, not one each,
 * and a feed that just failed is not fetched again for 90 s (CH2-38).
 * The CDN edge cache (`s-maxage=3600`) still saves repeat URLs.
 *
 * DB mode (when DATABASE_URL IS set — currently dormant in production) is
 * unchanged from Stage 3b's original behavior.
 */

/* THE SHOW comes from the one show resolver, api/_lib/resolveShow.ts
   (code-health-2 CH2-35), which the show-scoped search shares: the one
   catalogue reader (api/_lib/showCatalog.ts, CH2-24), then, for a `pi:<n>`
   shard-index show, the shard row the caller names with `?k=<key>`
   (pi-episodes-cold-open, #690; the resolver's header has the whole rule).
   How the catalogue files reach a deployed function at all (vercel.json's
   `includeFiles` for the api functions glob) is the BUNDLING NOTE in
   backend/src/catalog/breadthCatalog.ts. An `in_curated` breadth id is
   answered as its curated twin: the response's show_id, the episodes'
   show_id and the feed are the twin's. Answers when there is no show: an
   unknown catalogue id 404 `unknown show_id`; a `pi:` miss the same 404,
   no-store; a release that could not be read 502, no-store; a deploy
   without the catalogue pair 503, no-store (the client's Try again). */

const PAGE_SIZE = 100;

/**
 * The row as the LIST is served: everything except `description_html`.
 *
 * FOUNDER, 2026-09-21: "I'm still confused why it takes so long to load all
 * these episodes compared to other podcast apps."
 *
 * Measured against production on 2026-09-21, one page of Lex Fridman:
 * 709 KB for 100 episodes, 7.1 KB each. NINETY-THREE PER CENT of it was
 * description — `description_html` 412 KB (58 %) and `description_text` 251 KB
 * (35 %). Everything the list actually renders — title, date, duration, audio
 * url, guid — came to under 25 KB combined.
 *
 * `description_html` is the half that is pure waste: NOTHING reads it. The
 * client maps `description_text` into `hook` and `description`
 * (`fullCatalogueRowToEpRowItem` in app.js) and has never touched the HTML. It
 * was serialised because `toLiveEpisode` builds a whole `CatalogShowEpisode`
 * and the handler serialised the object it had.
 *
 * Dropping it takes a page from 709 KB to ~297 KB with no behaviour change at
 * all — and a show like Lex is five pages, so it is ~2 MB off loading one show.
 *
 * `description_text` STAYS. It is what the episode page renders, and removing
 * it would trade this round trip for a second one per episode.
 *
 * Applied at the RESPONSE boundary rather than by narrowing
 * `CatalogShowEpisode`: the type is shared with the store, which genuinely
 * holds the HTML, and a store that stopped persisting it could not serve it
 * later without a re-ingest.
 */
function toListRow(ep: CatalogShowEpisode) {
  const { description_html: _dropped, ...rest } = ep;
  return rest;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  /* The first value, like every single-value parameter in this API
     (_lib/params.ts); a repeated show_id was refused with this 400 before
     code-health-2 CH2-40. */
  const showId = firstParam(req.query.show_id);
  if (!showId) {
    res.status(400).json({ error: "show_id is required" });
    return;
  }

  const lookup = await resolveShow(showId, firstParam(req.query.k));
  if (!lookup.meta) {
    if (lookup.noStore) res.setHeader("Cache-Control", "no-store");
    res.status(lookup.status).json({ error: lookup.error });
    return;
  }
  const meta = lookup.meta;
  const servedId = meta.showId; // the twin's slug when asked by alias, else the id asked for

  const showHeader = { title: meta.title, description: null as string | null, image: meta.image };
  const cursor = decodeCursor(firstParam(req.query.cursor));

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    /* ONE ENDPOINT, ONE SHAPE (round-3 audit, arch-drift-13). The DB branch
       had drifted from the live one: it returned every episode unpaginated
       with no `next_cursor` (which app.js reads as "this is the whole show"),
       had no `degraded`, and ran `connect()` outside any try, so an
       unreachable database was a 500. It now paginates with the same cursor
       and emits the same fields, and a database it cannot use degrades to
       the live branch instead of failing the request. Dormant in production
       (no DATABASE_URL today). */
    let session: DbSession | null = null;
    try {
      session = await openDbSession(databaseUrl);
      const result = await session.refresh(servedId, meta.feedUrl);
      const episodes = await session.episodes(servedId);
      const { page, nextCursor } = paginate(episodes, cursor, PAGE_SIZE);
      const stale = result.status === "cached_stale";
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
      res.status(200).json(listBody({
        show_id: servedId,
        // DB mode has no per-show description without editing the store;
        // left null rather than guessed.
        show: showHeader,
        episodes: page.map(toListRow),
        next_cursor: nextCursor,
        source: "db",
        degraded: false,
        stale,
        error: stale || result.status === "no_cache_error" ? result.error ?? null : null,
      }));
      return;
    } catch {
      /* Fall through to the live branch below: the listener still gets the
         show, the same shape, from the feed. */
    } finally {
      if (session) await session.end().catch(() => {});
    }
  }

  await serveLive(res, servedId, meta, showHeader, cursor);
}

/** Every list response, both branches, has exactly these keys (the contract
    test in api/_test/episodes-shape.test.mjs runs both through one assertion). */
export const LIST_RESPONSE_KEYS = ["show_id", "show", "episodes", "next_cursor", "source", "degraded", "stale", "error"] as const;

function listBody(body: {
  show_id: string;
  show: { title: string | null; description: string | null; image: string | null };
  episodes: unknown[];
  next_cursor: string | null;
  source: "live" | "db";
  degraded: boolean;
  stale: boolean;
  error: string | null;
}) {
  return body;
}

/** No-DB mode (D14): the feed, read through the per-show parsed-feed cache. */
async function serveLive(
  res: ApiResponse,
  showId: string,
  meta: ShowMeta,
  showHeader: { title: string | null; description: string | null; image: string | null },
  cursor: ReturnType<typeof decodeCursor>
): Promise<void> {
  // No-DB mode (D14): the feed is read through the per-show parsed-feed
  // cache the show-scoped search shares (round-3 audit, search-api-css-3):
  // each cursor page used to re-download and re-parse the whole feed. Kept
  // per warm instance, revalidated with the etag/last-modified it holds.
  const feed = await sharedFeedReader.read(showId, meta.feedUrl);

  if (!feed.parsed) {
    // Never a 500, never blank (repo convention — see ingestShowFeed.ts's
    // own degrade rule): 200 with an empty list and the error surfaced.
    // Cache-Control: no-store so a transient feed hiccup is never pinned
    // at the edge for the next hour of visitors to that show. A feed whose
    // fetch just failed is answered from the reader's 90 s failure memory
    // rather than fetched again for every visitor, the same memory the
    // show-scoped search answers from (feedCache.ts, code-health-2 CH2-38).
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(listBody({
      show_id: showId,
      show: showHeader,
      episodes: [],
      next_cursor: null,
      source: "live",
      degraded: true,
      stale: false,
      error: feed.error ?? "feed unavailable",
    }));
    return;
  }

  const parsed = feed.parsed;
  const episodes = parsed.episodes
    .map((ep) => toCatalogEpisode(showId, ep))
    .filter((ep): ep is CatalogShowEpisode => ep !== null);

  const { page, nextCursor } = paginate(episodes, cursor, PAGE_SIZE);

  /* A KEPT copy served because the refresh was refused (per-show budget) or
     failed is stale, and says so, like the DB branch's cached_stale (round-3
     review, L4). It is not pinned at the edge for an hour either: no-store, as
     the degraded branch above, so the next visitor gets a fresh try. */
  const stale = feed.source === "stale";
  res.setHeader("Cache-Control", stale ? "no-store" : "s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json(listBody({
    show_id: showId,
    show: { ...showHeader, description: parsed.descriptionText || null },
    episodes: page.map(toListRow),
    next_cursor: nextCursor,
    source: "live",
    degraded: false,
    stale,
    error: null,
  }));
}

/* The database, behind one small seam so the DB branch can be exercised
   without a database (its tests inject a session). */
interface DbSession {
  refresh(showId: string, feedUrl: string): Promise<{ status: string; error?: string | null }>;
  episodes(showId: string): Promise<CatalogShowEpisode[]>;
  end(): Promise<void>;
}

async function realDbSession(databaseUrl: string): Promise<DbSession> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  const store = new PostgresShowEpisodesStore(client);
  return {
    refresh: (showId, feedUrl) => ingestShowFeed(showId, feedUrl, store),
    episodes: (showId) => store.episodesForShow(showId),
    end: () => client.end(),
  };
}

let openDbSession: (databaseUrl: string) => Promise<DbSession> = realDbSession;

/** Test-only: replace how the DB branch opens its session; no argument
    restores the real Postgres client. */
export function _setDbSessionForTests(open?: (databaseUrl: string) => Promise<DbSession>): void {
  openDbSession = open ?? realDbSession;
}
