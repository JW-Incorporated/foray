import { searchBreadthShows } from "../../backend/src/catalog/searchBreadthShows";

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
 * Degrades honestly: an unreadable catalogue file (missing/corrupt) yields
 * a 200 with an empty result list plus `degraded: true`, never a 500 or a
 * blank crash — matches this repo's "absence is a real state" rule
 * (renderShow's own not-found guard, this card's constraint re: breadth-tier
 * show pages).
 */

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default function handler(req: ApiRequest, res: ApiResponse): void {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const q = firstParam(req.query.q);
  if (!q || !q.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const limitParam = firstParam(req.query.limit);
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 25;

  try {
    const results = searchBreadthShows(q, limit);
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({ query: q, shows: results, degraded: false });
  } catch {
    // A missing/corrupt catalogue file degrades to an honest empty result,
    // never a 500 — the client's local catalog-client.json first pass still
    // has results to show even when this endpoint can't.
    res.status(200).json({ query: q, shows: [], degraded: true });
  }
}
