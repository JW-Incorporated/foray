/**
 * Shared CORS handling for `api/**` serverless functions (S-02, kanban
 * t_4bd3c0a3). Every handler calls `applyCors` first, before its method
 * check: the iOS shell (`Origin: capacitor://localhost`), the Android shell
 * (`https://localhost`) and the web build (`https://jwlabs.ai`,
 * `https://jw-incorporated.github.io`) are all cross-origin to this API, and
 * a 200 without `Access-Control-Allow-Origin` is discarded by the browser/
 * WebView before the caller ever sees the body. The origins it answers are
 * exactly `ALLOWED_ORIGINS` below; no handler sets CORS headers of its own
 * (the shard proxy adds only `Access-Control-Expose-Headers` for its custom
 * version header).
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

import { firstParam as firstHeader, type ApiRequest, type ApiResponse } from "./params";

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
 *
 * `origin` only, lowercase: Node lowercases every incoming header name, so
 * a capitalised `Origin` key never exists on `req.headers` (pinned over a
 * real socket in api/_test/params.test.mjs).
 */
export function applyCors(req: Pick<ApiRequest, "method" | "headers">, res: ApiResponse): boolean {
  const origin = firstHeader(req.headers.origin);
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
