import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/**
 * THE SHOWS-INDEX RELEASE, READ ONCE (pi-episodes-cold-open, #690).
 *
 * Everything that reads an asset of the shard-index release S-04b publishes
 * (data/shows-index-pointer.json names it) goes through `fetchIndexAsset`
 * below: the allowlist of asset paths, the pointer, the per-key shard
 * release (S-04c), the bounded upstream fetch, the gunzip and the JSON
 * parse. Two callers:
 *   - `api/shows/index/[...path].ts`, the same-origin proxy the client's
 *     shard search fetches through (its header has the CORS, gzip and
 *     flat-asset-name reasoning); and
 *   - `api/shows/[show_id]/episodes.ts`, which reads ONE shard to find a
 *     `pi:<n>` show's feed (a shared episode of a shard show cold-opening on
 *     a fresh device).
 * It lived inside the proxy until the second caller arrived; it moved here
 * rather than being copied, so the two cannot drift apart.
 */

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

/** Extracts the 2-char (or 1-char+`_`, or `__`) shard key from a
 *  `shards/<pp>.json` request path, or null for a non-shard path (the four
 *  top-level files never resolve through `shard_releases` — see
 *  `resolveShardRelease` below, which only needs this for a shard
 *  request). */
export function shardKeyFromRequestPath(requestPath: string): string | null {
  const m = SHARD_FILE_RE.exec(String(requestPath || ""));
  return m?.[1] ?? null;
}

/** S-04c: resolves which of `pointer.shard_releases` (an ordered list of
 *  `{ tag, asset_base_url, first_key, last_key, count }` ranges —
 *  `tools/shows/publish-release.mjs:buildPointer`'s own doc comment has
 *  the full shape and why it's ranges, not a per-key map) a shard key
 *  lives on, by a simple linear scan (at most a few dozen batches even at
 *  the real build's ~1,298-shard scale with 900/batch) for
 *  `first_key <= key <= last_key`. Returns null when no release covers the
 *  key — either `shard_releases` is empty (pre-S-04c pointer, or a build
 *  whose shard publish step hasn't landed) or the key genuinely has no
 *  shard (a builder bug, never expected against a real pointer). Pure —
 *  no I/O — so the range-resolution logic is unit-testable without a
 *  fixture pointer file. */
export function resolveShardRelease(shardReleases: ShardRelease[] | undefined, key: string): ShardRelease | null {
  for (const r of shardReleases || []) {
    if (key >= r.first_key && key <= r.last_key) return r;
  }
  return null;
}

/* Upstream bounds (round-3 audit, search-api-css-7). Release assets are
   capped by the pipeline's SHARD_TOO_LARGE budget far below these; the caps
   exist so a wrong or hostile upstream cannot hold or exhaust the function. */
export const UPSTREAM_TIMEOUT_MS = 5_000;
export const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const INDEX_CACHE_CONTROL = "public, max-age=300";
let upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS;

/** Test-only: shorten the upstream deadline; no argument restores it. */
export function _setUpstreamTimeoutMsForTests(ms?: number): void {
  upstreamTimeoutMs = ms ?? UPSTREAM_TIMEOUT_MS;
}

/** The response body, refusing more than `cap` bytes (a declared length over
    the cap is refused before reading). */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new Error(`asset is ${declared} bytes, over the ${cap}-byte cap`);
  if (!res.body) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > cap) throw new Error(`asset exceeds the ${cap}-byte cap`);
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`asset exceeds the ${cap}-byte cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

let pointerPath = path.resolve(__dirname, "..", "..", "data", "shows-index-pointer.json");

export function _setPointerPathForTests(absPath?: string): void {
  pointerPath = absPath ?? path.resolve(__dirname, "..", "..", "data", "shows-index-pointer.json");
}

export interface ShardRelease {
  tag: string;
  asset_base_url: string;
  first_key: string;
  last_key: string;
  count: number;
}

interface Pointer {
  asset_base_url?: string;
  release_tag?: string;
  shard_releases?: ShardRelease[];
  shards_published?: boolean;
}

/** Reads the committed pointer file. Returns null (never throws) when it is
 *  missing or unreadable — that is the honest "no release published yet"
 *  state while S-04a/b's `SHARD_TOO_LARGE` bug is open, not an operational
 *  failure of the caller. */
function loadPointer(): Pointer | null {
  try {
    const raw = fs.readFileSync(pointerPath, "utf8");
    return JSON.parse(raw) as Pointer;
  } catch {
    return null;
  }
}
/** A shard key as the release files one: exactly the `<pp>` of
 *  `SHARD_FILE_RE` (two `[a-z0-9]`, one plus `_`, or `__`). */
export function isShardKey(key: unknown): key is string {
  return typeof key === "string" && shardKeyFromRequestPath(`shards/${key}.json`) === key;
}

/** One release asset, or why not. `status` is the HTTP status the proxy
 *  answers with: 400 for a path outside the allowlist, 404 when nothing is
 *  published for it (no pointer, or no shard release covers the key: a real
 *  state, never cached), 502 when the upstream failed. */
export type IndexAssetResult =
  | { ok: true; body: unknown; version: string | null }
  | { ok: false; status: 400 | 404 | 502; error: string };

/** Fetches, gunzips (a shard) and parses one asset of the published
 *  shows-index release. Never throws for an upstream or path problem. */
export async function fetchIndexAsset(requestPath: string): Promise<IndexAssetResult> {
  let upstreamAsset: string;
  try {
    upstreamAsset = resolveUpstreamAsset(requestPath);
  } catch (err) {
    if (err instanceof IndexPathError) return { ok: false, status: 400, error: err.message };
    throw err;
  }

  const pointer = loadPointer();
  if (!pointer || !pointer.asset_base_url) {
    // Honest "nothing published yet" — see the proxy's header. Not cached:
    // the moment a real release lands, the very next request must see it.
    return { ok: false, status: 404, error: "no shows-index release is published yet" };
  }

  // S-04c: a SHARD request resolves its upstream base URL against
  // `pointer.shard_releases` (the shard lives on its own batch release —
  // see `resolveShardRelease`'s own doc comment), never against the
  // top-level `pointer.asset_base_url`, which only ever carries
  // manifest/top/id-map/changed. A top-level file request keeps using
  // `pointer.asset_base_url` unchanged. Honest 404 (not a 502) when shards
  // genuinely aren't published yet for this pointer — the same "absence is a
  // real state" rule the top-level branch above already follows,
  // distinguished from a genuine upstream failure so a client can tell "try
  // again later" apart from "this build has no shards".
  const shardKey = shardKeyFromRequestPath(requestPath);
  let upstreamBase = pointer.asset_base_url;
  if (shardKey !== null) {
    const shardRelease = resolveShardRelease(pointer.shard_releases, shardKey);
    if (!shardRelease) {
      return { ok: false, status: 404, error: `no shard release published for key "${shardKey}" yet` };
    }
    upstreamBase = shardRelease.asset_base_url;
  }

  const upstreamUrl = `${upstreamBase}/${upstreamAsset}`;
  /* BOUNDED (round-3 audit, search-api-css-7). The upstream fetch had no
     timeout, so a hung GitHub redirect held the function until the platform
     killed it, and `arrayBuffer()` sat outside any try, so a body that failed
     mid-read was a 500 instead of the proxy's 502 contract. The fetch AND
     the body read now share one UPSTREAM_TIMEOUT_MS deadline, the bytes read
     are capped, and gunzip is capped too. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  let raw: Buffer;
  try {
    const upstreamRes = await fetch(upstreamUrl, { signal: controller.signal });
    if (!upstreamRes.ok) return { ok: false, status: 502, error: `upstream responded ${upstreamRes.status}` };
    raw = await readCapped(upstreamRes, MAX_UPSTREAM_BYTES);
  } catch (err) {
    return { ok: false, status: 502, error: `upstream fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }

  let jsonText: string;
  try {
    jsonText = (isGzippedAsset(requestPath) ? zlib.gunzipSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES }) : raw).toString("utf8");
  } catch (err) {
    return { ok: false, status: 502, error: `upstream asset failed to decompress: ${(err as Error).message}` };
  }

  try {
    return { ok: true, body: JSON.parse(jsonText) as unknown, version: pointer.release_tag ?? null };
  } catch (err) {
    return { ok: false, status: 502, error: `upstream asset is not valid JSON: ${(err as Error).message}` };
  }
}
