/**
 * Shared CORS handling for `api/**` serverless functions (S-02, kanban
 * t_4bd3c0a3). Neither `api/shows/search.ts` nor
 * `api/shows/[show_id]/episodes.ts` sets any CORS headers today, so a
 * request from the iOS shell (`Origin: capacitor://localhost`) or the
 * Android shell (`https://localhost`) or the web build
 * (`https://jwlabs.ai`, `https://jw-incorporated.github.io`) gets a normal
 * 200 with no `Access-Control-Allow-Origin` header, which the browser/
 * WebView then discards before the caller ever sees the body.
 *
 * `search.ts` is not named in this card's file list but sits in the exact
 * same `api/` directory with the identical gap — pulled in here rather than
 * left half-fixed; see the PR description for why.
 *
 * SECURITY NOTE: this is a public, read-only, unauthenticated API (podcast
 * metadata only — no per-user data, no cookies). Exact-origin-echo CORS
 * with no `Access-Control-Allow-Credentials` is safe here specifically
 * because there is nothing origin-scoped to steal: reflecting any of the
 * five allowed origins back is equivalent to serving the response
 * unauthenticated to the whole internet, which this API already does for
 * a matching Origin. Never add `Access-Control-Allow-Credentials: true`
 * to this module without re-deriving that argument from scratch.
 */

/**
 * Exact-match allowlist — never a wildcard, never a suffix/prefix match.
 * `https://jw-incorporated.github.io` is org-wide (CORS cannot path-scope
 * to `/foray/`), which is acceptable because every repo under that org is
 * ours. `https://foray-web-seven.vercel.app` is the Vercel production alias
 * this API itself is served from (docs/jwlabs-dev-domain-inventory.md,
 * confirmed live) — needed for same-origin-looking calls made through the
 * Vercel preview/production host directly (e.g. manual testing, previews).
 */
export const ALLOWED_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
  "https://jwlabs.ai",
  "https://jw-incorporated.github.io",
  "https://foray-web-seven.vercel.app"
];

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(): void;
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Applies CORS headers for one request and, on an `OPTIONS` preflight,
 * finishes the response itself and returns `true` so the caller returns
 * immediately without running its normal handler body.
 *
 * `Vary: Origin` is set on EVERY response, not only ones that match —
 * otherwise a shared/edge cache (this API sets `Cache-Control` with
 * `s-maxage`/`max-age` on every 200) could serve a response carrying
 * `Access-Control-Allow-Origin: https://jwlabs.ai` to a
 * `jw-incorporated.github.io` visitor from cache, silently breaking that
 * origin's own fetch until the cache entry expires.
 */
export function applyCors(req: ApiRequest, res: ApiResponse): boolean {
  const origin = firstHeader(req.headers.origin ?? req.headers.Origin);
  res.setHeader("Vary", "Origin");

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204);
    res.end();
    return true;
  }

  return false;
}
