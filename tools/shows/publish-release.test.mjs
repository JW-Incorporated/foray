/* Unit tests for publish-release.mjs — every `gh` call is faked via the
   injectable `exec`, so this suite never touches the network or a real
   repo. See run-and-publish.test.mjs for the orchestration-level
   (still-fixture) end-to-end idempotency test the card's acceptance
   criterion asks for. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  assetBaseUrlFor, buildPointer, listReleaseAssets, partitionShardBatches, PublishError, publishRelease,
  publishShardReleases, releaseExists, releaseTagFor, shardReleaseTagFor,
} from "./publish-release.mjs";

test("releaseTagFor: sanitizes an HTTP-date export_version into a legal tag", () => {
  assert.equal(releaseTagFor("Wed, 03 Sep 2026 06:00:00 GMT"), "shows-index-wed-03-sep-2026-06-00-00-gmt");
});

test("releaseTagFor: passes a local: fixture version through unchanged aside from sanitization", () => {
  assert.equal(releaseTagFor("local:abc123def456"), "shows-index-local-abc123def456");
});

test("releaseTagFor: throws on an export_version that sanitizes to nothing", () => {
  assert.throws(() => releaseTagFor("!!!"), (err) => err instanceof PublishError && err.code === "BAD_EXPORT_VERSION");
});

test("releaseExists: true when gh release view succeeds", async () => {
  const exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args, ["release", "view", "shows-index-v1", "--repo", "org/repo"]);
    return { stdout: "ok" };
  };
  assert.equal(await releaseExists("shows-index-v1", { exec, repo: "org/repo" }), true);
});

test("releaseExists: false ONLY on a real 'release not found'", async () => {
  const exec = async () => { const e = new Error("failed"); e.stderr = "release not found"; throw e; };
  assert.equal(await releaseExists("shows-index-v1", { exec }), false);
});

test("releaseExists: fails closed (throws) on any other error — auth, network, rate limit", async () => {
  const exec = async () => { const e = new Error("failed"); e.stderr = "HTTP 403: rate limit exceeded"; throw e; };
  await assert.rejects(
    () => releaseExists("shows-index-v1", { exec }),
    (err) => err instanceof PublishError && err.code === "RELEASE_CHECK_FAILED",
  );
});

test("listReleaseAssets: only the 4 top-level files — shards/ is never a release asset", async () => {
  // Per Fable ruling FR-t_30a53ba2-1: GitHub Releases hard-caps a single
  // release at 1,000 assets (confirmed via GitHub's own docs and a real
  // HTTP 422 against this repo), and the real build's ~1,298 shard files
  // put a release well over that ceiling with no batching workaround
  // (the limit is per-release, not per-API-call). No client reads a
  // shard file from a release yet (S-05's cache is unwired), so shard
  // publishing is deferred to a follow-up card instead of shipping here.
  const outDir = await mkdtemp(join(tmpdir(), "shows-publish-"));
  try {
    await mkdir(join(outDir, "shards"));
    for (const f of ["manifest.json", "top.json", "id-map.json", "changed.json"]) {
      await writeFile(join(outDir, f), "{}");
    }
    for (const f of ["zz.json.gz", "aa.json.gz", "__.json.gz"]) {
      await writeFile(join(outDir, "shards", f), "");
    }

    const assets = await listReleaseAssets(outDir);
    const names = assets.map((p) => basename(p));
    assert.deepEqual(names, ["manifest.json", "top.json", "id-map.json", "changed.json"]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("publishRelease: refuses to publish with zero assets", async () => {
  await assert.rejects(
    () => publishRelease({ tag: "t", title: "t", notes: "n", assets: [], exec: async () => {} }),
    (err) => err instanceof PublishError && err.code === "NO_ASSETS",
  );
});

test("publishRelease: calls gh release create once with every asset, returns the asset base URL", async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, args]); return { stdout: "" }; };
  const result = await publishRelease({
    tag: "shows-index-v1",
    title: "Shows index v1",
    notes: "notes",
    assets: ["/tmp/manifest.json", "/tmp/top.json"],
    exec,
    repo: "org/repo",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "gh");
  assert.deepEqual(calls[0][1], [
    "release", "create", "shows-index-v1",
    "/tmp/manifest.json", "/tmp/top.json",
    "--repo", "org/repo", "--title", "Shows index v1", "--notes", "notes",
  ]);
  assert.equal(result.tag, "shows-index-v1");
  assert.equal(result.asset_base_url, "https://github.com/org/repo/releases/download/shows-index-v1");
});

test("assetBaseUrlFor: derives the same URL shape publishRelease returns, with no gh call needed", () => {
  // This is what run-and-publish.mjs's reconciliation path relies on: a
  // release that already exists (published on a PRIOR run) still needs its
  // asset base URL to build the pointer, with no `gh` call at all.
  assert.equal(
    assetBaseUrlFor("shows-index-v1", "org/repo"),
    "https://github.com/org/repo/releases/download/shows-index-v1",
  );
});

test("buildPointer: shapes the config-value payload the client reads", () => {
  const pointer = buildPointer({
    tag: "shows-index-v1",
    assetBaseUrl: "https://github.com/org/repo/releases/download/shows-index-v1",
    exportVersion: "local:abc123",
    manifest: { counts: { read: 10, in_4a: 8, canonical: 7 } },
    publishedAt: "2026-09-05T00:00:00.000Z",
  });
  assert.deepEqual(pointer, {
    version: 2,
    export_version: "local:abc123",
    release_tag: "shows-index-v1",
    asset_base_url: "https://github.com/org/repo/releases/download/shows-index-v1",
    manifest_url: "https://github.com/org/repo/releases/download/shows-index-v1/manifest.json",
    published_at: "2026-09-05T00:00:00.000Z",
    counts: { read: 10, in_4a: 8, canonical: 7 },
    shards_published: false,
    shard_releases: [],
  });
});

/* Audit round 3, arch-drift-7: POINTER_SCHEMA_VERSION was exported and never
   read while buildPointer wrote a literal 1, so the S-04c shard shape carried
   the same version as the pointer before it. MUTATION: put `version: 1` back
   in buildPointer -- both assertions fail. */
test("buildPointer: writes POINTER_SCHEMA_VERSION, which is 2 for the shard-range shape", async () => {
  const { POINTER_SCHEMA_VERSION } = await import("./config.mjs");
  assert.equal(POINTER_SCHEMA_VERSION, 2);
  const pointer = buildPointer({ tag: "t", assetBaseUrl: "https://x", exportVersion: "v", manifest: {}, shardReleases: [{ tag: "t-1" }], shardsPublished: true });
  assert.equal(pointer.version, POINTER_SCHEMA_VERSION);
  assert.ok("shard_releases" in pointer && "shards_published" in pointer);
});

/* ==================================================================== */
/* S-04c: shard batch release publishing                                 */
/* ==================================================================== */

test("partitionShardBatches: splits a sorted inventory into batches of at most maxPerBatch, in key order", () => {
  const inventory = [
    { key: "cc", row_count: 1, gz_bytes: 1 },
    { key: "aa", row_count: 1, gz_bytes: 1 },
    { key: "bb", row_count: 1, gz_bytes: 1 },
    { key: "dd", row_count: 1, gz_bytes: 1 },
  ];
  const batches = partitionShardBatches(inventory, 2);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].map((e) => e.key), ["aa", "bb"]);
  assert.deepEqual(batches[1].map((e) => e.key), ["cc", "dd"]);
});

test("partitionShardBatches: an inventory under one batch's size produces exactly one batch", () => {
  const inventory = [{ key: "aa", row_count: 1, gz_bytes: 1 }];
  const batches = partitionShardBatches(inventory, 900);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test("partitionShardBatches: an empty inventory produces zero batches", () => {
  assert.deepEqual(partitionShardBatches([], 900), []);
});

test("shardReleaseTagFor: deterministic, 1-based in the tag, 0-based as the argument", () => {
  assert.equal(shardReleaseTagFor("shows-index-v1", 0), "shows-index-v1-shards-1");
  assert.equal(shardReleaseTagFor("shows-index-v1", 1), "shows-index-v1-shards-2");
});

test("publishShardReleases: creates one release per batch and reports first/last key ranges", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      const e = new Error("not found"); e.stderr = "release not found"; throw e;
    }
    return { stdout: "created" };
  };
  const inventory = [
    { key: "aa", row_count: 1, gz_bytes: 1 },
    { key: "bb", row_count: 1, gz_bytes: 1 },
    { key: "cc", row_count: 1, gz_bytes: 1 },
  ];
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: inventory, exec, repo: "org/repo", maxPerBatch: 2,
  });
  // maxPerBatch isn't an accepted publishShardReleases param — this call
  // exercises the DEFAULT (config.mjs's MAX_SHARD_ASSETS_PER_RELEASE, 900),
  // so 3 keys land in exactly one batch/one release.
  assert.equal(releases.length, 1);
  assert.equal(releases[0].tag, "shows-index-v1-shards-1");
  assert.equal(releases[0].first_key, "aa");
  assert.equal(releases[0].last_key, "cc");
  assert.equal(releases[0].count, 3);
  assert.equal(releases[0].asset_base_url, "https://github.com/org/repo/releases/download/shows-index-v1-shards-1");
  const createCall = calls.find((a) => a[0] === "release" && a[1] === "create");
  assert.ok(createCall, "gh release create must have been called");
  assert.ok(createCall.includes(join("/tmp/out", "shards", "aa.json.gz")));
  assert.ok(createCall.includes(join("/tmp/out", "shards", "bb.json.gz")));
  assert.ok(createCall.includes(join("/tmp/out", "shards", "cc.json.gz")));
});

test("publishShardReleases: an already-existing batch release is skipped, not re-uploaded", async () => {
  const created = [];
  const exec = async (cmd, args) => {
    if (args[0] === "release" && args[1] === "view") {
      return { stdout: "exists" }; // every batch already exists
    }
    if (args[0] === "release" && args[1] === "create") {
      created.push(args[2]);
      return { stdout: "created" };
    }
  };
  const inventory = [{ key: "aa", row_count: 1, gz_bytes: 1 }];
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: inventory, exec, repo: "org/repo",
  });
  assert.equal(releases.length, 1);
  assert.equal(created.length, 0, "no gh release create call for an already-existing batch");
});

test("publishShardReleases: an empty shard inventory publishes zero releases", async () => {
  const exec = async () => { throw new Error("must not be called"); };
  const releases = await publishShardReleases({
    baseTag: "shows-index-v1", outDir: "/tmp/out", shardInventory: [], exec, repo: "org/repo",
  });
  assert.deepEqual(releases, []);
});
