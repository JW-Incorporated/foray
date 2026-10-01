/* tools/shows/publish-release.mjs — S-04b: package S-04a's build output
   into a GitHub Release, idempotently, and produce the pointer payload
   for data/shows-index-pointer.json.

   Every GitHub call goes through an injectable `exec` (default: execFile
   promisified) so this stays unit-testable without a real network call or
   a real repo — see publish-release.test.mjs, which fakes `gh` entirely.
   `run-and-publish.mjs` is the thin orchestration script that calls these
   functions for real inside the Actions job. */
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_SHARD_ASSETS_PER_RELEASE, POINTER_SCHEMA_VERSION, RELEASE_TAG_PREFIX, REPO_SLUG } from "./config.mjs";

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

const GH_MAX_BUFFER = 64 * 1024 * 1024;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The observed stderr of GitHub's upload throttle (OPS-02, issue #969,
    runs 36852145618 / 36853224459): `HTTP 403: You have exceeded a
    secondary rate limit. Please wait a few minutes before you try again.`
    from uploads.github.com, after ~500 assets in one minute. It is a
    RATE limit, not an auth failure — the same token had just created the
    release and uploaded hundreds of assets — so it is the one 403 that
    is retried, and it is retried after a long wait (the message's own
    "a few minutes"), not the short generic backoff. */
const SECONDARY_RATE_LIMIT = /secondary rate limit/i;
export const RATE_LIMIT_WAIT_MS = 90_000;

/** What GitHub holds for a tag right now: `absent` (no release at all),
    `draft` (created, possibly with some assets, not yet published — the
    shape an interrupted `publishRelease` leaves behind on purpose, see
    its header), or `published`, plus the names of the assets already on
    it. One `gh release view --json isDraft,assets` call; `gh` resolves a
    draft by tag for a token with write access, which is what makes the
    resume path work at all (OPS-02 verified `--json isDraft,assets`
    against this repo: 4 assets on the 12 Sep release).

    FAILS CLOSED, exactly as `releaseExists` always has: a genuine absence
    (`release not found` / HTTP 404) is the only error read as `absent`.
    Any other failure (auth, network, rate limit) throws
    RELEASE_CHECK_FAILED instead of being read as "safe to publish" — the
    fail-open shape that would let a transient error produce a duplicate
    release. */
export async function releaseState(tag, { exec = execFileP, repo = REPO_SLUG } = {}) {
  let stdout;
  try {
    ({ stdout } = await exec("gh", [
      "release", "view", tag,
      "--repo", repo,
      "--json", "isDraft,assets",
      "--jq", "{isDraft: .isDraft, assets: [.assets[].name]}",
    ]));
  } catch (err) {
    const text = `${err.stderr || err.message || ""}`;
    if (/release not found|HTTP 404/i.test(text)) return { state: "absent", assetNames: [] };
    throw new PublishError(
      "RELEASE_CHECK_FAILED",
      `could not determine whether release ${tag} exists: ${text.trim()}`,
      { tag },
    );
  }
  const parsed = JSON.parse(String(stdout));
  return {
    state: parsed.isDraft === true ? "draft" : "published",
    assetNames: Array.isArray(parsed.assets) ? parsed.assets.map(String) : [],
  };
}

/** True when a PUBLISHED release already exists for this tag — the
    end-to-end idempotency check the card asks for, independent of (and in
    addition to) S-04a's own local state.json skip. Two signals matter:
    local state.json can be lost (fresh checkout, cache eviction, a runner
    that never persists data-local/) while the release still exists on
    GitHub, and this is what stops a second run from creating a duplicate
    release in that case — state.json alone is not the whole idempotency
    story.

    A DRAFT IS "NOT YET THERE". Since OPS-03 a release is created as a
    draft, filled in chunks, then published, so a draft under this tag is
    an upload that was interrupted part-way — reading it as "exists" here
    would make `publishShardReleases` / run-and-publish.mjs SKIP a
    half-full batch forever. Returning false sends the caller into
    `publishRelease`, whose resume path uploads only what the draft is
    missing and then publishes it.

    Fails closed via `releaseState`: only a real absence is `false`
    without a release; any other error throws. */
export async function releaseExists(tag, opts = {}) {
  return (await releaseState(tag, opts)).state === "published";
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

/** Publishes a release in three resumable steps — DRAFT, CHUNKED UPLOADS,
    PUBLISH — instead of the one `gh release create <tag> <every asset>`
    call this used to be:

      1. `gh release create <tag> --draft --title --notes` with NO asset
         paths (skipped when a draft under this tag already exists);
      2. `gh release upload <tag> <chunk> --clobber`, `chunkSize` files
         per call, only for the assets the draft does not already carry,
         a `pauseMs` breath between chunks, and each chunk retried after
         a failure up to `attempts` tries in total;
      3. `gh release edit <tag> --draft=false`.

    WHY (OPS-02's reading of the weekly run, issue #969). Every scheduled
    run since 2026-09-20 died inside the monolithic create of batch 1
    (900 shard paths), and for weeks nobody could read why: the one
    FATAL line was cut at the log's 65,565-character cap before the exit
    code. With OPS-01's lines the cause is `HTTP 403: You have exceeded a
    secondary rate limit` from uploads.github.com after ~500 assets in
    about a minute — `gh` uploads 5 in flight and bursts at ~500/min, and
    the upload throttle is a per-minute window (two dispatches 9 minutes
    apart each got ~500 through). A bigger retry budget cannot fix a
    burst that always trips the limit, and the monolithic call is not
    resumable either: on an upload error `gh release create` deletes its
    own draft, so every run started again from zero. Small chunks with a
    pause between them keep the sustained rate ~4x under the observed
    cut (10 files / 5 s = 120/min; 1,298 shards ≈ 11-14 min, inside the
    job's 40); the draft is created WITHOUT assets so an interrupted run
    leaves a draft behind on purpose; and the next run (`releaseState` →
    `draft`) diffs the draft's asset names against `assets`, uploads only
    the missing ones, and publishes. A draft that already carries every
    asset is just published. A `published` release is left alone with no
    further call (`uploaded: 0`), which is also what keeps the callers'
    `releaseExists` → SKIP branches cheap and idempotent.

    THE RETRY. Any failed upload chunk is retried after `attempt * 5000`
    ms (5 s, then 10 s); the one error that gets a longer wait is the
    secondary-rate-limit 403 itself (`RATE_LIMIT_WAIT_MS`, 90 s — the
    message says "wait a few minutes", and the budget is back within
    minutes). `--clobber` on every upload is what makes the retry safe:
    some files in the chunk may already be on the release. After the
    last failed attempt the original error is rethrown unchanged, so
    run-and-publish.mjs's OPS-01 FATAL lines print its real stderr. No
    other 403 is reinterpreted as an auth failure here; `releaseState`
    still fails closed on it before any write.

    Returns the asset base URL the pointer file needs:
    `.../releases/download/<tag>/<name>` is a stable, directly-
    constructible URL shape that needs no further API call to resolve
    per-asset — verified against a real release in this repo (see
    docs/DECISIONS.md's S-04b entry for the exact redirect chain).

    THE 1,000-ASSET CEILING STILL STANDS. Chunking uploads against ONE
    tag does not change how many assets that tag holds: GitHub's ceiling
    is per-release (total assets attached), not per-API-call, which is
    exactly the lesson of the reverted PR #718 — so `publishShardReleases`
    still splits the ~1,298 shards across releases and
    `MAX_SHARD_ASSETS_PER_RELEASE` still bounds every one of them; the
    chunking here is only about the rate at which one release is filled.

    `state` is an already-fetched `releaseState` result, so a caller that
    just checked the tag itself (`publishShardReleases`) does not spend a
    second `gh release view` per batch; without it this function checks.
    `exec`, `sleep`, `chunkSize`, `attempts` and `pauseMs` are injectable
    for publish-release.test.mjs, which fakes every `gh` call and both
    sleeps. */
export async function publishRelease({
  tag, title, notes, assets, exec = execFileP, repo = REPO_SLUG,
  chunkSize = 10, attempts = 3, sleep = defaultSleep, pauseMs = 5000, state,
}) {
  if (!assets || assets.length === 0) {
    throw new PublishError("NO_ASSETS", "refusing to publish a release with zero assets");
  }
  const st = state ?? await releaseState(tag, { exec, repo });
  if (st.state === "published") {
    return { tag, asset_base_url: assetBaseUrlFor(tag, repo), uploaded: 0, resumed: false };
  }
  // maxBuffer: node's execFile default caps combined stdout+stderr at 1MB.
  // Cheap insurance against ERR_CHILD_PROCESS_STDOUT_MAXBUFFER masking a
  // real gh error behind a useless truncated command-line string (found
  // while verifying this pipeline against the real dump end-to-end,
  // t_30a53ba2). 64MB matches the maxBuffer run-and-publish.mjs's own
  // runBuild() already uses for the build step's stdout, for the same
  // reason.
  if (st.state === "absent") {
    await exec("gh", [
      "release", "create", tag,
      "--draft",
      "--repo", repo,
      "--title", title,
      "--notes", notes,
    ], { maxBuffer: GH_MAX_BUFFER });
  }
  const missing = assets.filter((p) => !st.assetNames.includes(basename(p)));
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    for (let attempt = 1; ; attempt++) {
      try {
        await exec("gh", ["release", "upload", tag, ...chunk, "--repo", repo, "--clobber"], { maxBuffer: GH_MAX_BUFFER });
        break;
      } catch (err) {
        if (attempt >= attempts) throw err;
        const text = `${err?.stderr || err?.message || ""}`;
        await sleep(SECONDARY_RATE_LIMIT.test(text) ? Math.max(attempt * 5000, RATE_LIMIT_WAIT_MS) : attempt * 5000);
      }
    }
    if (i + chunkSize < missing.length && pauseMs > 0) await sleep(pauseMs);
  }
  await exec("gh", ["release", "edit", tag, "--draft=false", "--repo", repo]);
  return {
    tag,
    asset_base_url: assetBaseUrlFor(tag, repo),
    uploaded: missing.length,
    resumed: st.state === "draft",
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
    version: POINTER_SCHEMA_VERSION,   // the shard shape is v2 (arch-drift-7)
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
    batch's `releaseState` check (the same published-means-done rule as
    `releaseExists`, see its doc comment) and `publishRelease` call mirror
    the top-level release's own idempotency contract exactly, so a run
    interrupted after batch 1 but before batch 2 resumes cleanly on the
    next run: batch 1's `gh release view` says published and is skipped,
    batch 2 is created — and (OPS-03) a batch left as a half-filled DRAFT
    is not "existing": `publishRelease` is handed that state and resumes
    the draft, uploading only its missing shards before publishing it.
    One `gh release view` per batch either way. Returns the ordered
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
    const state = await releaseState(tag, { exec, repo });
    if (state.state === "published") {
      log(`SKIP: shard release ${tag} already exists on GitHub — nothing new to publish`);
      assetBaseUrl = assetBaseUrlFor(tag, repo);
    } else {
      if (state.state === "draft") {
        log(`RESUME: shard release ${tag} is a stranded draft with ${state.assetNames.length}/${batch.length} shard assets — uploading the rest`);
      }
      const assets = batch.map((e) => join(outDir, "shards", `${e.key}.json.gz`));
      const title = `Shows index shards — batch ${i + 1}/${batches.length} (${firstKey}\u2013${lastKey})`;
      const notes = [
        "Automated shows-index shard release (S-04c).",
        `keys: ${firstKey}\u2013${lastKey} (${batch.length} shards)`,
      ].join("\n");
      ({ asset_base_url: assetBaseUrl } = await publishRelease({ tag, title, notes, assets, exec, repo, state }));
      log(`PUBLISHED: ${tag} (${batch.length} shard assets, ${firstKey}\u2013${lastKey})`);
    }
    releases.push({ tag, asset_base_url: assetBaseUrl, first_key: firstKey, last_key: lastKey, count: batch.length });
  }
  return releases;
}
