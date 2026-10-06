/**
 * Query-parameter (and header) reading for `api/**` handlers (code-health
 * CH-17, X1-13).
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
export function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
