/* tools/shows/publish-release.mjs — S-04b: package S-04a's build output
   into a GitHub Release, idempotently, and produce the pointer payload
   for data/shows-index-pointer.json.

   Every GitHub call goes through an injectable `exec` (default: execFile
   promisified) so this stays unit-testable without a real network call or
   a real repo — see publish-release.test.mjs, which fakes `gh` entirely.
   `run-and-publish.mjs` is the thin orchestration script that calls these
   functions for real inside the Actions job. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RELEASE_TAG_PREFIX, REPO_SLUG } from "./config.mjs";

const execFileP = promisify(execFile);

export class PublishError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.details = details;
  }
}

/** Deterministic release tag from export_version. export_version is
    normally an HTTP Last-Modified date ("Wed, 03 Sep 2026 06:00:00 GMT")
    or, on a fixture/manual run, `local:<hash>` — both contain characters
    (`,`, `:`, spaces) a git ref / GH release tag cannot hold, so this is a
    real sanitize, not cosmetic. Two different export_versions that
    sanitize to the same tag would silently collide; that cannot happen
    here because every legal export_version differs in its digits, which
    survive sanitization. */
export function releaseTagFor(exportVersion) {
  const safe = String(exportVersion)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) throw new PublishError("BAD_EXPORT_VERSION", `export_version "${exportVersion}" sanitizes to an empty tag`);
  return `${RELEASE_TAG_PREFIX}${safe}`;
}

/** True when a release already exists for this tag — the end-to-end
    idempotency check the card asks for, independent of (and in addition
    to) S-04a's own local state.json skip. Two signals matter: local
    state.json can be lost (fresh checkout, cache eviction, a runner that
    never persists data-local/) while the release still exists on GitHub,
    and this is what stops a second run from creating a duplicate release
    in that case — state.json alone is not the whole idempotency story.

    FAILS CLOSED: `gh release view` on a genuine absence exits non-zero
    with a "release not found" message, which is the only case read as
    `false`. Any other failure (auth, network, rate limit) throws instead
    of being read as "safe to publish" — the fail-open shape that would
    let a transient error produce a duplicate release. */
export async function releaseExists(tag, { exec = execFileP, repo = REPO_SLUG } = {}) {
  try {
    await exec("gh", ["release", "view", tag, "--repo", repo]);
    return true;
  } catch (err) {
    const text = `${err.stderr || err.message || ""}`;
    if (/release not found|HTTP 404/i.test(text)) return false;
    throw new PublishError(
      "RELEASE_CHECK_FAILED",
      `could not determine whether release ${tag} exists: ${text.trim()}`,
      { tag },
    );
  }
}

/** Lists the exact files a release ships — manifest.json, top.json,
    id-map.json, changed.json, plus every shards/<pp>.json.gz. Reads the
    real directory rather than hardcoding shard names so a new token
    prefix is picked up automatically; sorted so asset upload order (and
    therefore any log/summary that lists them) is deterministic. */
export async function listReleaseAssets(outDir) {
  const top = ["manifest.json", "top.json", "id-map.json", "changed.json"];
  const shardDir = join(outDir, "shards");
  const shardFiles = (await readdir(shardDir)).filter((f) => f.endsWith(".json.gz")).sort();
  return [...top.map((f) => join(outDir, f)), ...shardFiles.map((f) => join(shardDir, f))];
}

/** The stable, directly-constructible asset base URL for a tag — no API
    call needed, whether or not THIS run is the one that published it.
    Factored out of publishRelease so the caller can reconcile a pointer
    against an ALREADY-existing release (the recovery path in
    run-and-publish.mjs: a release published on a prior run whose pointer
    PR never landed) without re-deriving this string ad hoc. */
export function assetBaseUrlFor(tag, repo = REPO_SLUG) {
  return `https://github.com/${repo}/releases/download/${tag}`;
}

/** Creates the release and uploads every asset — uploading separately from
    creation would be two points of partial failure (a release created with
    zero assets, e.g.) instead of one atomic-from-the-caller's-view step.
    Returns the asset base URL the pointer file needs:
    `.../releases/download/<tag>/<name>` is a stable, directly-constructible
    URL shape that needs no further API call to resolve per-asset —
    verified against a real release in this repo (see docs/DECISIONS.md's
    S-04b entry for the exact redirect chain).

    BATCHED: GitHub Releases caps a single release at 1,000 assets (HTTP
    422 "file_count limited to 1000 assets per release" — hit for real
    against this repo, verified locally). The real build has ~1,298 shard
    files + 4 top-level files (~1,302 total), over that ceiling.
    `gh release create` cannot take more than 1,000 files in one call, so
    this uploads the first CREATE_BATCH_SIZE assets at creation time and
    the rest via `gh release upload` in further batches against the same
    tag — `gh` returns the same asset URL shape either way, so
    assetBaseUrlFor is unaffected. 900 leaves headroom under 1,000 without
    needing many round trips for a build this size. */
const CREATE_BATCH_SIZE = 900;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

export async function publishRelease({ tag, title, notes, assets, exec = execFileP, repo = REPO_SLUG }) {
  if (!assets || assets.length === 0) {
    throw new PublishError("NO_ASSETS", "refusing to publish a release with zero assets");
  }
  // maxBuffer: node's execFile default caps combined stdout+stderr at 1MB.
  // `gh release create`/`gh release upload` with hundreds of assets print
  // per-file upload progress that blows well past 1MB, throwing
  // ERR_CHILD_PROCESS_STDOUT_MAXBUFFER — which the caller's catch block
  // then reported as a useless truncated command-line string instead of
  // the real gh output, masking every actual upload failure (including
  // the 1,000-asset ceiling this function now handles) behind a fake
  // "release create failed" (found while verifying this pipeline against
  // the real dump end-to-end, t_30a53ba2). 64MB matches the maxBuffer
  // run-and-publish.mjs's own runBuild() already uses for the build
  // step's stdout, for the same reason.
  const execOpts = { maxBuffer: 64 * 1024 * 1024 };
  const [firstBatch, ...restBatches] = chunk(assets, CREATE_BATCH_SIZE);
  await exec("gh", [
    "release", "create", tag,
    ...firstBatch,
    "--repo", repo,
    "--title", title,
    "--notes", notes,
  ], execOpts);
  for (const batch of restBatches) {
    await exec("gh", ["release", "upload", tag, ...batch, "--repo", repo], execOpts);
  }
  return {
    tag,
    asset_base_url: assetBaseUrlFor(tag, repo),
  };
}

/** The pointer payload for data/shows-index-pointer.json — a plain object
    the caller writes to disk. Kept pure (no I/O) so its shape is
    unit-testable on its own. */
export function buildPointer({ tag, assetBaseUrl, exportVersion, manifest, publishedAt = new Date().toISOString() }) {
  return {
    version: 1,
    export_version: exportVersion,
    release_tag: tag,
    asset_base_url: assetBaseUrl,
    manifest_url: `${assetBaseUrl}/manifest.json`,
    published_at: publishedAt,
    counts: manifest.counts ?? null,
  };
}
