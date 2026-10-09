import { QUERY_MAX_CHARS, QUERY_TOO_LONG_ERROR } from "./clientLimit";

/**
 * Request reading for `api/**` handlers: the request/response shapes, query
 * parameters (and headers), the `limit` rule and the `q` rule (code-health
 * CH-17, X1-13; code-health-2 CH2-40, A1-10).
 *
 * `?q=a&q=b` arrives as `req.query.q = ["a", "b"]`, and a repeated header the
 * same way. Every single-value parameter in this API answers the FIRST value.
 * That rule used to be a private copy in each handler, so a change to one
 * copy would leave the endpoints disagreeing about the same URL; it lives
 * here now and every caller imports it (`_lib/cors.ts` imports it as
 * `firstHeader`).
 *
 * The catch-all shard route (`api/shows/index/[...path].ts`) is the one
 * caller that wants EVERY value (the path segments); its helper is named
 * `allParams` there so the two rules cannot be mistaken for each other.
 */

/**
 * Minimal structural types for the Vercel Node runtime request/response,
 * declared once for every handler and `_lib/cors.ts`. They avoid adding
 * `@vercel/node` as a dependency to a root that is deliberately
 * dependency-free (root package.json's own description); the runtime shape
 * (query, headers, method, status().json()) is standard across Vercel's Node
 * functions whether or not the SDK's type package is installed. `headers` is
 * Node's `IncomingMessage.headers`, so every name in it is lowercase.
 */
export interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(): void;
}

export function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/* THE LIMIT RULE for the two search handlers (`api/episodes/search.ts`,
   `api/shows/search.ts`). It was copied into each, so the cap or the default
   could change in one and not the other; both now call this with no options.
   The options exist for a caller that genuinely needs another range. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** The first value read as a positive integer (`parseInt`, so `"7abc"` is 7),
 *  capped at `max`; anything else (absent, empty, `0`, negative, not a number)
 *  is `default`. */
export function parseLimit(
  v: string | string[] | undefined,
  { default: fallback = DEFAULT_LIMIT, max = MAX_LIMIT }: { default?: number; max?: number } = {}
): number {
  const raw = firstParam(v);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** THE QUERY RULE for the two search handlers: `q` (its first value) must be
 *  present, not blank, and at most QUERY_MAX_CHARS (clientLimit.ts) long.
 *  Returns it, or answers the 400 itself and returns null so the caller
 *  returns at once. `missing` is the 400's message for an absent `q`
 *  (the show search accepts `id` instead, and says so). */
export function requireQuery(
  req: ApiRequest,
  res: ApiResponse,
  { missing = "q is required" }: { missing?: string } = {}
): string | null {
  const q = firstParam(req.query.q);
  if (!q || !q.trim()) {
    res.status(400).json({ error: missing });
    return null;
  }
  if (q.length > QUERY_MAX_CHARS) {
    res.status(400).json({ error: QUERY_TOO_LONG_ERROR });
    return null;
  }
  return q;
}
