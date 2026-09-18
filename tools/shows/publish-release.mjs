/* tools/shows/publish-release.mjs — S-04b: package S-04a's build output
   into a GitHub Release, idempotently, and produce the pointer payload
   for data/shows-index-pointer.json.

   Every GitHub call goes through an injectable `exec` (default: execFile
   promisified) so this stays unit-testable without a real network call or
   a real repo — see publish-release.test.mjs, which fakes `gh` entirely.
   `run-and-publish.mjs` is the thin orchestration script that calls these
   functions for real inside the Actions job. */
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_SHARD_ASSETS_PER_RELEASE, RELEASE_TAG_PREFIX, REPO_SLUG } from "./config.mjs";

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

/** Lists the exact top-level (non-shard) files a release ships: manifest,
    top, id-map, changed. Shard files are published SEPARATELY, across one
    or more batch releases (`publishShardReleases` below) — this function's
    own scope stays the 4 top-level files per Fable ruling FR-t_30a53ba2-1,
    which is also why `outDir`'s `shards/` directory is never walked here.

    WHY SHARDS ARE A SEPARATE RELEASE, NOT MORE ASSETS ON THIS ONE: GitHub
    Releases hard-caps a single release at 1,000 assets (confirmed via
    GitHub's own docs and a real HTTP 422 "file_count limited to 1000
    assets per release" against this repo); the real build's ~1,298 shard
    files alone exceed that, before even counting these 4 — a fresh-context
    review caught an earlier attempt at batching CREATE+UPLOAD calls
    against the SAME tag (PR #718, reverted) before it could ship a
    permanently-broken publish step: the ceiling is per-release (total
    assets attached), not per-API-call, so no batching trick against one
    tag works around it. `publishShardReleases` instead creates MULTIPLE
    releases (S-04c), each under its own tag and its own 1,000-asset
    budget — see that function's own header. */
export async function listReleaseAssets(outDir) {
  const top = ["manifest.json", "top.json", "id-map.json", "changed.json"];
  return top.map((f) => join(outDir, f));
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
    docs/DECISIONS.md's S-04b entry for the exact redirect chain).

    Per Fable ruling FR-t_30a53ba2-1, `assets` is now always the 4
    top-level files only (listReleaseAssets no longer includes shards/),
    so this never approaches GitHub's 1,000-asset-per-release ceiling and
    needs no batching — an earlier batched design (PR #718) was reverted
    because the ceiling is per-release, not per-API-call, so batching
    create+upload calls against the same tag cannot work around it. */
export async function publishRelease({ tag, title, notes, assets, exec = execFileP, repo = REPO_SLUG }) {
  if (!assets || assets.length === 0) {
    throw new PublishError("NO_ASSETS", "refusing to publish a release with zero assets");
  }
  // maxBuffer: node's execFile default caps combined stdout+stderr at 1MB.
  // Kept even though this call now only ever ships a handful of assets —
  // cheap insurance against ERR_CHILD_PROCESS_STDOUT_MAXBUFFER masking a
  // real gh error behind a useless truncated command-line string (found
  // while verifying this pipeline against the real dump end-to-end,
  // t_30a53ba2). 64MB matches the maxBuffer run-and-publish.mjs's own
  // runBuild() already uses for the build step's stdout, for the same
  // reason.
  await exec("gh", [
    "release", "create", tag,
    ...assets,
    "--repo", repo,
    "--title", title,
    "--notes", notes,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return {
    tag,
    asset_base_url: assetBaseUrlFor(tag, repo),
  };
}

/** The pointer payload for data/shows-index-pointer.json — a plain object
    the caller writes to disk. Kept pure (no I/O) so its shape is
    unit-testable on its own.

    S-04c: `shard_releases` (when non-empty) is the ordered list of shard
    batch releases (see `publishShardReleases` below) that together cover
    every shard key this build produced, each `{ tag, asset_base_url,
    first_key, last_key, count }`. Deliberately RANGES, not a per-key map —
    with ~1,298 keys a flat `key -> release` map would roughly triple this
    file's size for no benefit, since `shard-build.mjs`'s own
    `normalizePrefixKey` output is already lexicographically sortable and
    `listReleaseAssets`'s batches are built in that same sorted order
    (`partitionShardBatches`), so a consumer only needs `first_key <= key
    <= last_key` to resolve which release a shard lives on — see
    `api/shows/index/[...path].ts`'s `resolveShardRelease`, S-04c's own
    file, for the reader. `shards_published` is false until every batch in
    `shard_releases` has actually been created (or already existed) on
    GitHub — see `run-and-publish.mjs`'s caller for how that's guaranteed
    rather than assumed. */
export function buildPointer({
  tag, assetBaseUrl, exportVersion, manifest, publishedAt = new Date().toISOString(),
  shardReleases = [], shardsPublished = false,
}) {
  return {
    version: 1,
    export_version: exportVersion,
    release_tag: tag,
    asset_base_url: assetBaseUrl,
    manifest_url: `${assetBaseUrl}/manifest.json`,
    published_at: publishedAt,
    counts: manifest.counts ?? null,
    shards_published: shardsPublished,
    shard_releases: shardReleases,
  };
}

/** Splits a manifest's `shard_inventory` (already alphabetically sorted by
    `writeBuildOutput`, but re-sorted here defensively — this function's own
    contract does not trust the caller's ordering) into contiguous batches
    of at most `maxPerBatch` entries, so each batch fits under GitHub's
    1,000-asset-per-release ceiling (see `MAX_SHARD_ASSETS_PER_RELEASE`'s
    own comment in config.mjs for the exact number and why). Pure — no I/O,
    unit-testable on a plain array of `{ key, row_count, gz_bytes }`. */
export function partitionShardBatches(shardInventory, maxPerBatch = MAX_SHARD_ASSETS_PER_RELEASE) {
  const sorted = [...(shardInventory || [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const batches = [];
  for (let i = 0; i < sorted.length; i += maxPerBatch) {
    batches.push(sorted.slice(i, i + maxPerBatch));
  }
  return batches;
}

/** Deterministic per-batch release tag, namespaced under the export's own
    top-level tag so `gh release list` groups a shard batch with the run
    that produced it, and so a re-run for the SAME export_version resolves
    to the SAME shard tags (idempotency, exactly like `releaseTagFor`
    itself) — `batchIndex` is 0-based internally, 1-based in the tag for a
    human reading `gh release list`. */
export function shardReleaseTagFor(baseTag, batchIndex) {
  return `${baseTag}-shards-${batchIndex + 1}`;
}

/** Publishes every shard batch as its own release, idempotently — each
    batch's `releaseExists` check and `publishRelease` call mirror the
    top-level release's own idempotency contract exactly (see
    `releaseExists`'s doc comment), so a run interrupted after batch 1 but
    before batch 2 resumes cleanly on the next run: batch 1's `gh release
    view` succeeds and is skipped, batch 2 is created. Returns the ordered
    `shard_releases` array `buildPointer` embeds in the pointer — ordered
    by batch index, which is also alphabetical key order (see
    `partitionShardBatches`), so a consumer never needs to sort it. */
export async function publishShardReleases({
  baseTag, outDir, shardInventory, exec = execFileP, repo = REPO_SLUG, log = () => {},
}) {
  const batches = partitionShardBatches(shardInventory);
  const releases = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const tag = shardReleaseTagFor(baseTag, i);
    const firstKey = batch[0].key;
    const lastKey = batch[batch.length - 1].key;
    let assetBaseUrl;
    if (await releaseExists(tag, { exec, repo })) {
      log(`SKIP: shard release ${tag} already exists on GitHub — nothing new to publish`);
      assetBaseUrl = assetBaseUrlFor(tag, repo);
    } else {
      const assets = batch.map((e) => join(outDir, "shards", `${e.key}.json.gz`));
      const title = `Shows index shards — batch ${i + 1}/${batches.length} (${firstKey}\u2013${lastKey})`;
      const notes = [
        "Automated shows-index shard release (S-04c).",
        `keys: ${firstKey}\u2013${lastKey} (${batch.length} shards)`,
      ].join("\n");
      ({ asset_base_url: assetBaseUrl } = await publishRelease({ tag, title, notes, assets, exec, repo }));
      log(`PUBLISHED: ${tag} (${batch.length} shard assets, ${firstKey}\u2013${lastKey})`);
    }
    releases.push({ tag, asset_base_url: assetBaseUrl, first_key: firstKey, last_key: lastKey, count: batch.length });
  }
  return releases;
}
