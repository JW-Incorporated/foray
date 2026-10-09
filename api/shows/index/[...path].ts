import { applyCors } from "../../_lib/cors";
import { type ApiRequest, type ApiResponse } from "../../_lib/params";
/* The allowlist, the pointer, the bounded fetch and the gunzip live in
   api/_lib/showsIndexRelease.ts, shared with the per-show resolver's `pi:`
   lookup (pi-episodes-cold-open); this endpoint's suites import them from
   there. */
import { fetchIndexAsset, INDEX_CACHE_CONTROL } from "../../_lib/showsIndexRelease";

/**
 * GET /api/shows/index/<manifest.json|top.json|id-map.json|changed.json|shards/<pp>.json>
 * — S-05's same-origin proxy onto the shard-index release S-04b publishes
 * (4a-shows-pipeline-plan.md §3.2), per the Fable ruling on kanban t_546eac9f
 * (FR-t_546eac9f-1, posted on that card): a client `fetch()` from
 * `capacitor://localhost` (or the GitHub Pages web origin) straight to a
 * GitHub Release asset fails CORS — `release-assets.githubusercontent.com`
 * sends no `Access-Control-Allow-Origin` header at all (measured,
 * `docs/DECISIONS.md`'s S-04b entry). Routing through this repo's own `api/`
 * layer is server-to-server (no CORS problem) and needs zero new secrets,
 * zero new infra, and — because `index.html`'s CSP `connect-src` already
 * names `https://foray-web-seven.vercel.app` (S-03) — zero CSP change,
 * matching S-05's own rule that a `connect-src` widening lands with the code
 * that needs it, never in advance.
 *
 * WHERE THE RELEASE LIVES: `data/shows-index-pointer.json`, committed by
 * S-04b's `tools/shows/run-and-publish.mjs` (`asset_base_url`, a stable
 * `.../releases/download/<tag>` URL — see `tools/shows/publish-release.mjs`;
 * shards on the `shard_releases` batch releases). A pointer has been on
 * `main` since 2026-09-15 (#720), re-pointed 2026-10-05 (#1012) with
 * `shards_published: true`. So a 404 `{ available: false }` from this
 * endpoint is no longer the steady state: it means the pointer was removed,
 * or the shard key falls outside every `shard_releases` range — an incident
 * to look at, still answered as 404 rather than a 500 under the "absence is
 * a real state" rule every endpoint here follows (see `api/shows/search.ts`'s
 * degraded branch).
 *
 * AN ALLOWLISTING PROXY, NOT AN OPEN ONE — the whole reason this file is
 * more than three lines. `req.query.path` is client-controlled, so every
 * requested path is checked against the exact five shapes the shard-index
 * pipeline ever produces (`ALLOWED_TOP_FILES` + `SHARD_FILE_RE`) before it
 * is used to build an upstream URL; anything else is a 400, never forwarded
 * anywhere. Without this a client could ask this endpoint to fetch and
 * relay ANY path on the pinned asset host — an SSRF-shaped open relay
 * wearing this repo's own CORS headers.
 *
 * GZIP: the release's shard files are built as `shards/<pp>.json.gz` on
 * disk (gzip, not HTTP `Content-Encoding`), because that is what
 * `tools/shows/import-dump.mjs` writes and what a plain `fetch()` on
 * `capacitor://localhost` cannot transparently inflate the way an
 * HTTP-negotiated `Content-Encoding: gzip` would — this proxy is the one
 * place that matters: it fetches the `.gz` asset, `zlib.gunzipSync`s it
 * server-side, and answers the client with plain `application/json` — the
 * client-side shard fetch in `app.js` never needs to know the upstream
 * shape gzips at all. `manifest.json`, `top.json`, `id-map.json` and
 * `changed.json` are written as plain (uncompressed) JSON by the same
 * builder (`writeBuildOutput`), so those pass through untouched.
 *
 * ASSET NAMES ARE FLAT ON THE RELEASE, NOT `shards/<pp>.json.gz` — this
 * matters for `resolveUpstreamAsset` (api/_lib/showsIndexRelease.ts) and
 * was the review finding that caught it. `publish-release.mjs:publishRelease` uploads every asset via
 * one `gh release create <tag> <files...>` call; `gh` (like every GitHub
 * Release upload path) names each asset by its LOCAL BASENAME, discarding
 * the directory — verified against `gh`'s own upload implementation. So a
 * shard built at `data-local/shows-import/out/shards/fr.json.gz` is
 * published as the asset `fr.json.gz`, reachable at
 * `<asset_base_url>/fr.json.gz`, never `<asset_base_url>/shards/fr.json.gz`.
 * `resolveUpstreamAsset` therefore returns the bare `<key>.json.gz`
 * basename for a shard request, not a `shards/`-prefixed path — the
 * CLIENT-FACING path (`req.query.path`, `shards/<pp>.json`) still carries
 * the `shards/` segment, because that is the shape S-05's own client code
 * and this file's route pattern use to distinguish a shard request from
 * the four top-level files; only the UPSTREAM asset name drops it.
 */

/** Every value of a catch-all parameter: Vercel hands `[...path]` over as the
 * path segments. Deliberately NOT `_lib/params.ts`'s `firstParam`, which
 * keeps only the first value (code-health CH-17). */
function allParams(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  // `X-Shows-Index-Version` (set below, on a 200) is a CUSTOM response
  // header — per the Fetch spec, a cross-origin caller's JS cannot read
  // any response header outside the CORS-safelisted set (Cache-Control,
  // Content-Type, etc.) unless the server explicitly exposes it via
  // `Access-Control-Expose-Headers`. Every real caller of this endpoint IS
  // cross-origin (the web build at jwlabs.ai/GitHub Pages and the
  // Capacitor shells all call `API_ORIGIN`, a different origin — see
  // `app.js`'s own `API_ORIGIN` comment) — without this, S-04c's client
  // staleness check (`app.js:fetchShardRows`'s `lastSeenShardVersion`)
  // would silently read `null` from every fetch forever and never
  // invalidate a stale Cache Storage entry, exactly the bug this card
  // exists to fix (review finding). Set unconditionally, not only on the
  // 200 path below, so a preflight-less simple GET always carries it
  // regardless of which branch answers.
  res.setHeader("Access-Control-Expose-Headers", "X-Shows-Index-Version");

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const segments = allParams(req.query.path);
  const requestPath = segments.join("/");

  const got = await fetchIndexAsset(requestPath);
  if (!got.ok) {
    if (got.status === 400) {
      res.status(400).json({ error: got.error });
      return;
    }
    // A 404 (nothing published for this path yet) and a 502 (the upstream
    // failed) are both not cached: the next request must see a release the
    // moment it lands, and a transient failure must not be pinned.
    res.setHeader("Cache-Control", "no-store");
    res.status(got.status).json({ available: false, error: got.error });
    return;
  }

  // Every allowed asset is JSON (the gzip ones are gzipped JSON) — parsed
  // and re-served through `res.json` like every other endpoint in this
  // directory, rather than writing raw bytes, so this proxy needs no
  // response-object capability beyond the shared `ApiResponse` interface.
  //
  // NOT immutable (round-3 audit, search-api-css-7). The release behind this
  // URL is immutable, but the URL does not carry the release tag: a pointer
  // bump serves different bytes at the same URL, and `immutable` told a
  // browser never to revalidate it for an hour. A short max-age instead.
  // `X-Shows-Index-Version` carries the pointer's own `release_tag` (S-04c)
  // so the client's Cache Storage layer (`app.js`'s `readShardFromCacheStorage`/
  // `writeShardToCacheStorage`) can tag a cached entry with the version that
  // produced it and detect staleness on a later pointer bump, without a
  // second round trip to fetch `manifest.json`/the pointer separately —
  // see this file's header, FR-t_546eac9f-2.
  res.setHeader("Cache-Control", INDEX_CACHE_CONTROL);
  if (got.version) res.setHeader("X-Shows-Index-Version", got.version);
  res.status(200);
  res.json(got.body);
}
