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

/** Creates the release and uploads every asset in one `gh release create`
    call — uploading separately from creation would be two points of
    partial failure (a release created with zero assets, e.g.) instead of
    one atomic-from-the-caller's-view step. Returns the asset base URL the
    pointer file needs: `.../releases/download/<tag>/<name>` is a stable,
    directly-constructible URL shape that needs no further API call to
    resolve per-asset — verified against a real release in this repo (see
    docs/DECISIONS.md's S-04b entry for the exact redirect chain). */
export async function publishRelease({ tag, title, notes, assets, exec = execFileP, repo = REPO_SLUG }) {
  if (!assets || assets.length === 0) {
    throw new PublishError("NO_ASSETS", "refusing to publish a release with zero assets");
  }
  await exec("gh", [
    "release", "create", tag,
    ...assets,
    "--repo", repo,
    "--title", title,
    "--notes", notes,
  ]);
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
