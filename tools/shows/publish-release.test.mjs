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
  assetBaseUrlFor, buildPointer, listReleaseAssets, PublishError, publishRelease,
  releaseExists, releaseTagFor,
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

test("listReleaseAssets: top-level files plus every shard, sorted", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "shows-publish-"));
  try {
    await mkdir(join(outDir, "shards"));
    for (const f of ["manifest.json", "top.json", "id-map.json", "changed.json"]) {
      await writeFile(join(outDir, f), "{}");
    }
    for (const f of ["zz.json.gz", "aa.json.gz", "__.json.gz"]) {
      await writeFile(join(outDir, "shards", f), "");
    }
    // A stray non-shard file must never be picked up as an asset.
    await writeFile(join(outDir, "shards", "README.md"), "not an asset");

    const assets = await listReleaseAssets(outDir);
    /* `basename`, not `split("/")`: listReleaseAssets returns paths built with
       `join`, which is backslash-separated on Windows, so splitting on a forward
       slash returned the whole absolute path and this test failed for every
       Windows checkout while passing on CI's Linux runner. The assertion was
       always right; the way it reached the filename was not. */
    const names = assets.map((p) => basename(p));
    assert.deepEqual(names, [
      "manifest.json", "top.json", "id-map.json", "changed.json",
      "__.json.gz", "aa.json.gz", "zz.json.gz",
    ]);
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
    version: 1,
    export_version: "local:abc123",
    release_tag: "shows-index-v1",
    asset_base_url: "https://github.com/org/repo/releases/download/shows-index-v1",
    manifest_url: "https://github.com/org/repo/releases/download/shows-index-v1/manifest.json",
    published_at: "2026-09-05T00:00:00.000Z",
    counts: { read: 10, in_4a: 8, canonical: 7 },
  });
});
