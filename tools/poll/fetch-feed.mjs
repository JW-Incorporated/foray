/* Conditional GET for one feed, for the S-10 watchlist poller's live path
   (PKG-10, docs/roadmap/shows-search.md).

   Port of backend/src/feeds/conditionalGet.ts. The body is read by
   tools/refresh/fetch-limits.mjs's readBodyCapped (the one tools/ feed body
   reader, code-health-2 CH2-28) -- no private copy here.
   backend/test/fetchFeedParity.test.ts runs this module and the TS against the
   same loopback server and asserts identical results; fetch-feed.test.mjs
   additionally pins the constants as text.

   WHY A PORT AND NOT A tsx SHIM. The poller runs from
   .github/workflows/episode-poll.yml, which checks out the repo, sets up Node
   and runs `node tools/poll/*.mjs` with NO `npm install` -- there is no tsx (or
   any other TypeScript loader) on that runner, so the .ts module cannot be
   imported from here. This file therefore re-implements fetchFeedConditional in
   plain ESM with no npm dependencies, and fetch-feed.test.mjs reads the two TS
   files as TEXT so a constant changed on one side alone is a red suite:
   MAX_FEED_BYTES (20 MB), the 15_000 ms default timeout and the User-Agent
   string (backend/src/feeds/userAgent.ts).

   THE RULES, identical to the TypeScript:
   - Request headers: User-Agent (opts.userAgent, else DEFAULT_FEED_USER_AGENT),
     Accept "application/rss+xml, application/xml, text/xml, * /*" (no space in
     the real string), If-None-Match when prior.etag, If-Modified-Since when
     prior.lastModified.
   - 304 -> { status: 304, notModified: true, body: null } with the PRIOR
     validators (a 304 carries none worth trusting over what we stored).
   - Any other non-2xx -> body null, the response's own validators, error
     "HTTP <status>".
   - A declared Content-Length above maxBytes -> rejected before reading a
     byte (the request is aborted), body null, error names the limit.
   - Any other non-2xx also cancels its body stream so the socket is freed.
   - The body is read off the stream with a byte ceiling; crossing maxBytes
     mid-stream aborts the request and the call returns status 0 (it is a
     thrown error inside the try, exactly as in the TS). The decode drops a
     leading UTF-8 BOM (fetch-limits' TextDecoder); the TS still keeps it, a
     divergence fetchFeedParity.test.ts names.
   - A thrown fetch (DNS, refused, timeout abort) -> status 0, body null, the
     PRIOR validators, error "fetch error: <message>".
   Result shape: { status, notModified, body, etag, lastModified, error? }. */

import { UA } from "../segments/politeness.mjs";
import { MAX_FEED_BYTES, readBodyCapped } from "../refresh/fetch-limits.mjs";

// The one tools/ byte ceiling (fetch-limits.mjs), re-exported for the pin.
export { MAX_FEED_BYTES };
export const DEFAULT_TIMEOUT_MS = 15_000;
// The one tools/ User-Agent (#316): imported, never spelled out here.
export const DEFAULT_FEED_USER_AGENT = UA;

export async function fetchFeedConditional(url, prior = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_FEED_BYTES;
  const priorEtag = prior.etag ?? null;
  const priorLastModified = prior.lastModified ?? null;

  const headers = {
    "User-Agent": opts.userAgent ?? DEFAULT_FEED_USER_AGENT,
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  };
  if (priorEtag) headers["If-None-Match"] = priorEtag;
  if (priorLastModified) headers["If-Modified-Since"] = priorLastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });

    if (res.status === 304) {
      return { status: 304, notModified: true, body: null, etag: priorEtag, lastModified: priorLastModified };
    }

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    if (!res.ok) {
      try {
        await res.body?.cancel?.();
      } catch {
        // best-effort: free the socket rather than leave the error body to GC
      }
      return { status: res.status, notModified: false, body: null, etag, lastModified, error: `HTTP ${res.status}` };
    }

    // Guard 1: an honest oversized declaration is rejected before any download.
    const declaredLength = res.headers.get("content-length");
    if (declaredLength !== null) {
      const declared = Number(declaredLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        try {
          await res.body?.cancel?.();
        } catch {
          // best-effort; the abort above is what actually stops the network
        }
        return {
          status: res.status,
          notModified: false,
          body: null,
          etag,
          lastModified,
          error: `declared Content-Length ${declared} exceeds ${maxBytes} byte limit`,
        };
      }
    }

    // Guard 2: a missing/lying Content-Length or an endless body is capped on the stream.
    const body = await readBodyCapped(res, controller, maxBytes);
    return { status: res.status, notModified: false, body, etag, lastModified };
  } catch (err) {
    return {
      status: 0,
      notModified: false,
      body: null,
      etag: priorEtag,
      lastModified: priorLastModified,
      error: `fetch error: ${err?.message ?? String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
