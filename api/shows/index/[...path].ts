import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { applyCors } from "../../_lib/cors";

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
 * WHERE THE RELEASE LIVES: `data/shows-index-pointer.json`, written by
 * S-04b's `tools/shows/run-and-publish.mjs` (`asset_base_url`, a stable
 * `.../releases/download/<tag>` URL — see `tools/shows/publish-release.mjs`).
 * That pipeline is currently failing closed on `SHARD_TOO_LARGE` (the p95
 * shard-size budget in `tools/shows/config.mjs`), so no pointer is committed
 * yet — this endpoint answers 404 `{ available: false }` in that case, the
 * same "absence is a real state, never a 500" rule every other endpoint in
 * this directory follows (see `api/shows/search.ts`'s degraded branch). That
 * is a separate, tracked bug in S-04a/b's own files (see this card's Fable
 * ruling), not something this proxy works around.
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
 * matters for `resolveUpstreamAsset` below and was the review finding that
 * caught it. `publish-release.mjs:publishRelease` uploads every asset via
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

/** The non-shard files the pipeline publishes verbatim — exact names, no
 *  wildcard. */
const ALLOWED_TOP_FILES = new Set(["manifest.json", "top.json", "id-map.json", "changed.json"]);

/** A shard file request: `shards/<pp>.json`, where `<pp>` is exactly the
 *  shape `tools/shows/shard-build.mjs:normalizePrefixKey` ever produces —
 *  two `[a-z0-9]` characters, or one such character plus `_`, or the
 *  literal `__` catch-all bucket. Anchored so `shards/aa/../../etc.json`
 *  cannot slip a path-traversal segment through as a "prefix". */
const SHARD_FILE_RE = /^shards\/([a-z0-9]{2}|[a-z0-9]_|__)\.json$/;

export class IndexPathError extends Error {}

/**
 * Parses the client-facing request path (already joined with `/`) into the
 * exact upstream asset name to fetch from the release, applying the gzip
 * rename AND the flattening every release asset actually has (see this
 * file's header — `gh release create` uploads by basename, so a shard
 * asset lives at `<asset_base_url>/<pp>.json.gz`, never
 * `<asset_base_url>/shards/<pp>.json.gz`). Throws `IndexPathError` for
 * anything outside the allowlist. Pure, so the allowlist logic is testable
 * with no fs/network.
 */
export function resolveUpstreamAsset(requestPath: string): string {
  const p = String(requestPath || "");
  if (ALLOWED_TOP_FILES.has(p)) return p;
  const shardMatch = SHARD_FILE_RE.exec(p);
  if (shardMatch) return `${shardMatch[1]}.json.gz`;
  throw new IndexPathError(`not a recognised shard-index artifact: ${p}`);
}

/** True for a request path that names a gzipped upstream asset (every shard
 *  file) — the proxy gunzips these before responding; every other allowed
 *  path is already plain JSON on the release. */
export function isGzippedAsset(requestPath: string): boolean {
  return SHARD_FILE_RE.test(String(requestPath || ""));
}

/** Repo-relative pointer path, overridable for tests the same way
 *  `api/episodes/search.ts`'s `_setShowMetaRootForTests` overrides its own
 *  root — see that file's convention note. */
let pointerPath = path.resolve(__dirname, "..", "..", "..", "data", "shows-index-pointer.json");

export function _setPointerPathForTests(absPath?: string): void {
  pointerPath = absPath ?? path.resolve(__dirname, "..", "..", "..", "data", "shows-index-pointer.json");
}

interface Pointer {
  asset_base_url?: string;
}

/** Reads the committed pointer file. Returns null (never throws) when it is
 *  missing or unreadable — that is the honest "no release published yet"
 *  state while S-04a/b's `SHARD_TOO_LARGE` bug is open, not an operational
 *  failure of this endpoint. */
function loadPointer(): Pointer | null {
  try {
    const raw = fs.readFileSync(pointerPath, "utf8");
    return JSON.parse(raw) as Pointer;
  } catch {
    return null;
  }
}

function firstParam(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (applyCors(req, res)) return; // OPTIONS preflight already answered

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const segments = firstParam(req.query.path);
  const requestPath = segments.join("/");

  let upstreamAsset: string;
  try {
    upstreamAsset = resolveUpstreamAsset(requestPath);
  } catch (err) {
    if (err instanceof IndexPathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const pointer = loadPointer();
  if (!pointer || !pointer.asset_base_url) {
    // Honest "nothing published yet" — see this file's header. Not cached:
    // the moment S-04a/b's pipeline bug is fixed and a real release lands,
    // the very next request must see it.
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ available: false, error: "no shows-index release is published yet" });
    return;
  }

  const upstreamUrl = `${pointer.asset_base_url}/${upstreamAsset}`;
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ available: false, error: `upstream fetch failed: ${(err as Error).message}` });
    return;
  }
  if (!upstreamRes.ok) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ available: false, error: `upstream responded ${upstreamRes.status}` });
    return;
  }

  const raw = Buffer.from(await upstreamRes.arrayBuffer());
  let jsonText: string;
  try {
    jsonText = (isGzippedAsset(requestPath) ? zlib.gunzipSync(raw) : raw).toString("utf8");
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ available: false, error: `upstream asset failed to decompress: ${(err as Error).message}` });
    return;
  }

  // Every allowed asset is JSON (the gzip ones are gzipped JSON) — parsed
  // and re-served through `res.json` like every other endpoint in this
  // directory, rather than writing raw bytes, so this proxy needs no
  // response-object capability beyond the shared `ApiResponse` interface.
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ available: false, error: `upstream asset is not valid JSON: ${(err as Error).message}` });
    return;
  }

  // Content-addressed by the release tag (one immutable release per
  // export_version, S-04b's idempotency contract) — safe to cache hard.
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.status(200);
  res.json(parsed);
}
