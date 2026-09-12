import { searchBreadthShows } from "../../backend/src/catalog/searchBreadthShows";
import { loadBreadthCatalog } from "../../backend/src/catalog/breadthCatalog";
import { applyCors } from "../_lib/cors";
import { appleShowSearch } from "./appleShowSearch";

/**
 * GET /api/shows/search?q=<query>&limit=<n> — the backend half of A3.1/Q3
 * (kanban t_8d1a6a58): show search that reaches 4a's FULL breadth
 * catalogue (curated 220 + ~10k breadth), not just the 220-show curated
 * set `data/catalog-client.json` ships to the client. See
 * `backend/src/catalog/searchBreadthShows.ts` for the ranking rule and
 * `backend/src/catalog/breadthCatalog.ts` for the merged-index shape.
 *
 * Same "first Vercel serverless function" territory `api/shows/[show_id]/
 * episodes.ts` (kanban t_567b570f) already opened and flagged for Wyatt's
 * review — this endpoint reuses that same api/ directory rather than
 * inventing a second one, and needs no new secrets/infra beyond what that
 * card already named (no DB connection here at all: this endpoint is a
 * pure in-memory read over the two catalogue JSON files already committed
 * to the repo, so it has a materially smaller infra footprint than the
 * episodes endpoint).
 *
 * CORS (S-02, kanban t_4bd3c0a3): this endpoint had the identical missing-
 * CORS-header gap `episodes.ts` did, so it's wired to the same shared
 * `api/_lib/cors.ts` allowlist in the same change rather than left half-fixed.
 *
 * Degrades honestly: an unreadable catalogue file (missing/corrupt) yields
 * a 200 with an empty result list plus `degraded: true`, never a 500 or a
 * blank crash — matches this repo's "absence is a real state" rule
 * (renderShow's own not-found guard, this card's constraint re: breadth-tier
 * show pages).
 *
 * ---------------------------------------------------------------------------
 * S-05 / S-06 (docs/search-plan.md) added three things to this endpoint.
 *
 * (1) `?id=<apple_collection_id|show_id>` — THE LINKABILITY FIX (#560 item 7,
 *     requirements §6.8). `app.js:showById` resolves `state.catalog` then
 *     `state.breadthShowCache`, which is in-memory and populated ONLY by a
 *     search response this session — so a cold open on `#/show/1234567890`, a
 *     shared link, a reload or a restored tab rendered "Show not found." This
 *     returns the single merged-catalogue row for an id. It is a LOOKUP, not a
 *     scan: `loadBreadthCatalog()` is already resident (module-scope cache) and
 *     an id index is built once beside it. `q` and `id` are mutually
 *     exclusive; neither present is still a 400.
 *
 *     WHICH PATH WINS, and the card asks for this to be said rather than
 *     assumed: once S-03's index is on the device it can answer most of these
 *     with no network at all — but only once it is LOADED, which on a cold open
 *     of a shared `#/show/:id` link it is not. Fetching 436 KB of index to
 *     render one show page would be a worse trade than one ~200 ms round trip
 *     for one row, so `app.js` prefers the loaded index when it has it and this
 *     endpoint otherwise. The index is never fetched FOR this.
 *
 * (2) `?fallthrough=1` — THE APPLE FALL-THROUGH (S-06a). Ask Apple's public
 *     directory only when nothing anywhere we hold matches. TWO INDEPENDENT
 *     GATES, and neither is optional: the CLIENT sets this flag only when its
 *     own local pass found nothing, and this endpoint performs the call only
 *     when the full 19,904-row merged catalogue ALSO found nothing. Without
 *     the second gate, the client's `chart_rank <= 100` index cut would make
 *     "zero hits" mean "not in 10,113" and every query for a mid-chart show we
 *     already have would burn a slot in a 20/min bucket. The rate limiter, the
 *     cache, the timeout and the argument for doing this server-side all live
 *     in `./appleShowSearch.ts`.
 *
 * (3) THE DEGRADED BRANCH'S MISSING HEADER (S-05, #560 item 10,
 *     requirements §6.12). The catch branch below set NO `Cache-Control` at
 *     all, so an empty degraded response could be edge-cached under Vercel's
 *     default while `api/episodes/search.ts` sets `no-store` on its own
 *     degraded answers. A cached "the catalogue file is unreadable" is a
 *     five-minute outage for every client behind that edge. It is `no-store`
 *     now.
 *
 * (4) WHAT THE ROWS CARRY, AND WHY THE ORDER THEY ARRIVE IN MATTERS EVEN
 *     THOUGH THE CLIENT RE-RANKS THEM (client audit 2026-09-12). `app.js`'s
 *     `mergeBreadth` re-buckets every row it receives with
 *     `SearchEngine.rankShows`, so the order this endpoint replies in is never
 *     the order displayed - but `limit` is applied by `searchBreadthShows`
 *     BEFORE the reply, and what it cuts there no client can recover. Ranking
 *     server-side by a different rule therefore kept the best 25 under a rule
 *     nobody displays. The two rules are now one rule, pinned by a test on
 *     each side; see `backend/src/catalog/searchBreadthShows.ts`'s header for
 *     the measurement and the pin.
 *
 *     Two consequences for this response's SHAPE, both deliberate:
 *       - the `rank` field is gone. It was serialised on every row and read by
 *         nobody, for the reason above.
 *       - `chart_rank` is present (null for a curated row). That one IS read:
 *         `search-engine.js:popularityBand` bands it when it re-ranks. Rows
 *         from here used to arrive without it and were banded UNRANKED, the
 *         worst band, which cost exactly the chart_rank 101-200 shows that the
 *         client's `<=100` index cut means only this endpoint has.
 *
 * MEASURED, AND THE SOURCE SHOULD NOT MISLEAD THE NEXT READER: the success
 * header below sets `public, max-age=300, stale-while-revalidate=3600`, and the
 * response as received from production carries only `public, max-age=300`.
 * Observed three times independently — docs/search-plan.md §1.4 (2026-09-09),
 * §1.6 (2026-09-10) and §1.7 (2026-09-12), each time with the full header set
 * recorded beside an `X-Vercel-Cache` value. The `stale-while-revalidate`
 * directive does NOT arrive. Whether Vercel's edge strips it or rewrites it has
 * not been established, and S-05 deliberately did not add an `s-maxage` to
 * "fix" it: that would be a second unverified directive beside the first. Two
 * decks already assumed this token was in effect; it is not. Do not plan
 * against it without re-measuring.
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

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** The id -> row index over the merged catalogue, built once per warm
    instance beside `loadBreadthCatalog`'s own module-scope cache. Rebuilt when
    the catalogue array identity changes, which is the only way that cache can
    be invalidated (`FORAY_SKIP_CATALOGUE_CACHE=1` in tests) — keying on
    identity rather than on a boolean means this can never go stale against a
    reloaded catalogue without anyone remembering to clear it. */
let idIndex: Map<string, ReturnType<typeof loadBreadthCatalog>[number]> | null = null;
let idIndexSource: ReturnType<typeof loadBreadthCatalog> | null = null;

function showByIdFromCatalog(id: string) {
  const catalog = loadBreadthCatalog();
  if (idIndex === null || idIndexSource !== catalog) {
    idIndex = new Map(catalog.map((s) => [s.show_id, s]));
    idIndexSource = catalog;
  }
  return idIndex.get(id) ?? null;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const q = firstParam(req.query.q);
  const id = firstParam(req.query.id);

  /* MUTUALLY EXCLUSIVE, and rejected rather than silently preferred. Answering
     one and ignoring the other would make a caller's bug look like a working
     request returning the wrong thing — the hardest kind to notice from the
     client side. */
  if (q && id) {
    res.status(400).json({ error: "q and id are mutually exclusive" });
    return;
  }

  if (id && id.trim()) {
    try {
      const show = showByIdFromCatalog(id.trim());
      /* A genuinely unknown id is a 200 with `show: null`, NOT a 404: "this id
         is not in our catalogue" is a real, renderable answer (app.js's own
         "Show not found." state), and a 404 would make `fetchApiJson` — which
         returns null for any non-ok response — unable to tell it apart from a
         dead endpoint. The two need different UI. */
      res.setHeader("Cache-Control", "public, max-age=300");
      res.status(200).json({ id: id.trim(), show, degraded: false });
    } catch {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ id: id.trim(), show: null, degraded: true });
    }
    return;
  }

  if (!q || !q.trim()) {
    res.status(400).json({ error: "q or id is required" });
    return;
  }

  const limitParam = firstParam(req.query.limit);
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 25;
  const fallthroughAsked = firstParam(req.query.fallthrough) === "1";

  let results;
  try {
    results = searchBreadthShows(q, limit);
  } catch {
    // A missing/corrupt catalogue file degrades to an honest empty result,
    // never a 500 — the client's local catalog-client.json first pass still
    // has results to show even when this endpoint can't.
    // S-05: `no-store`, so an edge cannot hold this answer for five minutes.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ query: q, shows: [], degraded: true });
    return;
  }

  /* S-06's SECOND GATE. `results.length === 0` here means "not in the full
     19,904-row merged catalogue", which is the only definition of a miss this
     fall-through may act on — see this file's header for why the client's own
     gate is not sufficient on its own. */
  if (fallthroughAsked && results.length === 0) {
    const apple = await appleShowSearch(q, limit);
    /* A rate-limited or failed fall-through returns the local results (empty,
       here) with a flag — never an error. The listener gets the honest empty
       state they would have got anyway, and the flag lets a caller say so. */
    res.setHeader("Cache-Control", apple.error ? "no-store" : "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({
      query: q,
      shows: apple.shows,
      degraded: false,
      source: apple.shows.length ? ["apple"] : [],
      fallthrough: { attempted: true, error: apple.error, cached: apple.cached },
    });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  res.status(200).json({
    query: q,
    shows: results,
    degraded: false,
    source: results.length ? ["catalogue"] : [],
    fallthrough: { attempted: false, error: null, cached: false },
  });
}
