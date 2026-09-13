import { searchBreadthShows } from "../../backend/src/catalog/searchBreadthShows";
import { loadBreadthCatalog } from "../../backend/src/catalog/breadthCatalog";
import { applyCors } from "../_lib/cors";
import { appleShowSearch, mergeDirectoryShows } from "./appleShowSearch";

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
 * (2) `?fallthrough=1` — THE APPLE DIRECTORY PASS. Shipped by S-06a as a LAST
 *     RESORT behind two gates: the CLIENT set this flag only when its own
 *     local pass found nothing, and this endpoint performed the call only when
 *     the full 19,904-row merged catalogue ALSO found nothing.
 *
 *     P-02 (docs/search-parity-plan.md) DELETED THE SECOND GATE, and the
 *     original text is kept above rather than overwritten because the argument
 *     it makes is still the right shape — it was just answered by measurement
 *     instead of assumed. Measured against this endpoint on 2026-09-12 over 25
 *     listener queries: passing `fallthrough=1` returned BYTE-IDENTICAL results
 *     to omitting it for 23 of the 25, with `fallthrough: {attempted: false}`
 *     in the body. Only `ira glass` and `hubermann` — the two queries with zero
 *     rows in the full catalogue — got through. Meanwhile every one of the 25
 *     gained rows from the directory after dedup: minimum +2, median +17,
 *     maximum +25. There is no query in that table where our own catalogue was
 *     enough, and a one-exact-hit query is not the exception — `radiolab` (1
 *     exact local hit) gains 18, `crime junkie` (2 exact) gains 24, and what
 *     arrives is the network and the spinoffs a listener is reaching for ("The
 *     99% Invisible Breakdown", "Hard Fork Live", "Business Wars Daily").
 *
 *     So the condition is now simply `fallthroughAsked`. The CLIENT's gate is
 *     the only one left and it is a LENGTH floor, not a strength test:
 *     `app.js` asks on every debounced search of >= 3 characters. Its own
 *     header says why a strength test was rejected — `tim` returns 10 strong
 *     local matches, none of them The Tim Ferriss Show.
 *
 *     THE OTHER HALF OF THE SAME CHANGE, and it is not optional: this branch
 *     used to reply `shows: apple.shows`, REPLACING `results` rather than
 *     merging. That was safe only because `results.length === 0` was a
 *     precondition. With the gate gone, a rate-limited, timed-out or failed
 *     Apple call would have returned `[]` IN PLACE OF the catalogue's rows —
 *     losing precisely the `chart_rank` 101-200 tier that only this endpoint
 *     has. It merges now (`mergeDirectoryShows`), and a failed directory pass
 *     replies with `results` unchanged plus the flag.
 *
 *     The rate limiter, the cache, the (now 2 s) timeout, the dedup rule and
 *     the argument for doing this server-side all live in
 *     `./appleShowSearch.ts`.
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

  /* P-02: the directory is a SECOND PASS, not a last resort. The old
     `&& results.length === 0` is gone — see this file's header (2) for the
     measurement that removed it. The caller's `fallthrough=1` is the only gate
     left, which keeps the refusal S-06 actually needed: a script, a probe or
     `tools/search-probe.mjs`'s forced-MISS samples still never spend a slot,
     because they do not ask. */
  if (fallthroughAsked) {
    const apple = await appleShowSearch(q, limit);
    /* MERGED, NEVER REPLACED. A rate-limited or failed directory pass returns
       the catalogue's own rows with a flag beside them — never an error, and
       never `[]`. Before P-02 this line read `shows: apple.shows`, which was
       only safe because `results.length === 0` was a precondition; with the
       gate gone that would have dropped the catalogue on every Apple failure. */
    const shows = mergeDirectoryShows(results, apple.shows);
    const source: string[] = [];
    if (results.length) source.push("catalogue");
    if (shows.length > results.length) source.push("apple");
    /* A FAILED DIRECTORY PASS IS NOW A CACHEABLE ANSWER, briefly, and the change
       from `no-store` is deliberate rather than a relaxation.

       Under S-06 this branch's failure body was `shows: []` — caching an empty
       for five minutes would have been a five-minute outage for everyone behind
       that edge, so `no-store` was right. Under P-02 the body carries the full
       catalogue answer, so it is a real result that happens to be missing its
       directory half. `no-store` on it is now actively harmful: the directory
       pass fires on EVERY search, so a limiter trip that is never edge-cached
       means every retry re-invokes the function and re-fails — a trip becomes a
       re-invocation storm with no backoff. 10 s is short enough that a listener
       retrying after the 60 s window has moved on does not get a stale refusal,
       and long enough to flatten the storm. `no-store` still belongs on the
       degraded branch above, where the body really is empty. */
    res.setHeader("Cache-Control", apple.error ? "public, max-age=10" : "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({
      query: q,
      shows,
      degraded: false,
      source,
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
