/* End-to-end (still fixture-level, no real GitHub call) test of the
   run-then-publish orchestration — this is what proves the card's
   acceptance criterion "two full runs on the same dump version -> no new
   release" against the ACTUAL control flow the workflow runs, not just
   each piece in isolation. Also covers the pointer-reconciliation path
   (fresh-context review finding, 2026-09-05): a release can exist from a
   prior run whose pointer PR never landed, and a later run must still
   reconcile the pointer even though it does not publish anything new.

   Both the build step and every `gh` call are faked via injection
   (runAndPublish's own overridable options), so this suite is fast,
   network-free, and does not touch this repo's real data-local/ or
   data/shows-index-pointer.json. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAndPublish } from "./run-and-publish.mjs";

/** Writes a minimal but real S-04a build output tree (state.json +
    manifest.json + top/id-map/changed.json + one shard) so listReleaseAssets
    and publishRelease exercise the real file-reading code path, not a
    stub. Mirrors writeBuildOutput's shape exactly. */
async function seedBuildOutput({ buildOutDir, statePath, exportVersion, checksum }) {
  await mkdir(join(buildOutDir, "shards"), { recursive: true });
  await writeFile(join(buildOutDir, "shards", "sh.json.gz"), "fake-gzip-bytes");
  await writeFile(join(buildOutDir, "top.json"), "[]");
  await writeFile(join(buildOutDir, "id-map.json"), "{}");
  await writeFile(join(buildOutDir, "changed.json"), "[]");
  const manifest = { export_version: exportVersion, counts: { read: 10, in_4a: 8, canonical: 7 } };
  await writeFile(join(buildOutDir, "manifest.json"), JSON.stringify(manifest));
  await mkdir(join(statePath, ".."), { recursive: true });
  await writeFile(statePath, JSON.stringify({ export_version: exportVersion, checksum }));
  return manifest;
}

function fakeGhRegistry() {
  // Mirrors a real GitHub repo's release list across the two calls this
  // test makes: `gh release view <tag>` and `gh release create <tag> ...`.
  const created = new Set();
  const ghExec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    if (args[0] === "release" && args[1] === "view") {
      const tag = args[2];
      if (created.has(tag)) return { stdout: "exists" };
      const e = new Error("not found"); e.stderr = "release not found"; throw e;
    }
    if (args[0] === "release" && args[1] === "create") {
      const tag = args[2];
      created.add(tag);
      return { stdout: "created" };
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { ghExec, created };
}

test("acceptance: two runs against the same dump version publish exactly one release", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const statePath = join(root, "state", "last-build.json");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const logs = [];
  const log = (msg) => logs.push(msg);

  try {
    // ---- Run 1: build "ran" (buildExec emits a non-SKIP line), fresh state ----
    const manifest = await seedBuildOutput({ buildOutDir, statePath, exportVersion: "local:abc123", checksum: "abc123" });
    const buildExecRan = async () => ({ stdout: "read 10 rows; D1 kept 8; D13 canonical 7\nBUILD_COMPLETE: out (export_version local:abc123)" });

    const result1 = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecRan, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result1.published, true);
    assert.equal(result1.pointerChanged, true);
    assert.equal(result1.tag, "shows-index-local-abc123");
    assert.equal(created.size, 1);

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.release_tag, "shows-index-local-abc123");
    assert.equal(pointer.export_version, "local:abc123");
    assert.equal(pointer.counts.canonical, 7);

    // ---- Run 2: SAME dump version. Simulate S-04a's own skip-if-already-built
    // firing (buildExec emits SKIP: — exactly what import-dump.mjs prints and
    // exits 0 on when state.json already matches). ----
    const buildExecSkip = async () => ({ stdout: `SKIP: export_version local:abc123 (checksum abc123abc12…) already built at 2026-09-05T00:00:00.000Z` });
    const result2 = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecSkip, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result2.published, false);
    assert.equal(result2.pointerChanged, false);
    assert.equal(result2.reason, "build-skipped");
    assert.equal(created.size, 1, "no second release was created");

    // ---- Run 3: the OTHER idempotency path — state.json lost (fresh
    // checkout) so the build "ran" again, but the release already exists on
    // GitHub from run 1, AND the pointer already matches it. Must still not
    // create a second release, and must not report a pointer change. ----
    const result3 = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecRan, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result3.published, false);
    assert.equal(result3.pointerChanged, false);
    assert.equal(result3.reason, "release-exists-pointer-current");
    assert.equal(created.size, 1, "still exactly one release after the release-already-exists path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciliation: a release that exists with no landed pointer PR is still reconciled on the next run", async () => {
  // Reproduces the exact gap fresh-context review found: run 1 publishes a
  // release; its pointer write is simulated as lost (e.g. the workflow's
  // PR step failed after the build step succeeded, or a human closed the
  // PR without merging) by deleting the pointer file after run 1. Run 2,
  // for the SAME export_version, must NOT re-publish (release-exists still
  // holds) but MUST still write/report a pointer change — the fix.
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const statePath = join(root, "state", "last-build.json");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};

  try {
    await seedBuildOutput({ buildOutDir, statePath, exportVersion: "local:abc123", checksum: "abc123" });
    const buildExecRan = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:abc123)" });

    const result1 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result1.published, true);
    assert.equal(result1.pointerChanged, true);
    assert.equal(created.size, 1);

    // Simulate the pointer PR never landing: the pointer file this run just
    // wrote is now gone from a "fresh checkout" perspective on the next run.
    await rm(pointerPath, { force: true });

    const result2 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result2.published, false, "the release already exists — must not publish a duplicate");
    assert.equal(result2.pointerChanged, true, "the pointer was missing and MUST be reconciled even though nothing new was published");
    assert.equal(result2.reason, "reconciled-existing-release");
    assert.equal(created.size, 1, "still exactly one release");

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.release_tag, "shows-index-local-abc123");

    // ---- Run 3: pointer now matches — no further change reported. ----
    const result3 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result3.pointerChanged, false, "pointer already reconciled — nothing left to do");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a genuinely new dump version (different export_version) DOES publish a second release", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const statePath = join(root, "state", "last-build.json");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};

  try {
    await seedBuildOutput({ buildOutDir, statePath, exportVersion: "local:v1", checksum: "v1" });
    const buildExecV1 = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:v1)" });
    await runAndPublish(["--dump-file", "a"], { buildExec: buildExecV1, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(created.size, 1);

    await seedBuildOutput({ buildOutDir, statePath, exportVersion: "local:v2", checksum: "v2" });
    const buildExecV2 = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:v2)" });
    const result = await runAndPublish(["--dump-file", "b"], { buildExec: buildExecV2, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(result.published, true);
    assert.equal(result.pointerChanged, true);
    assert.equal(created.size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--dry-run never publishes even on a fresh build", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const statePath = join(root, "state", "last-build.json");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};
  try {
    await seedBuildOutput({ buildOutDir, statePath, exportVersion: "local:v1", checksum: "v1" });
    const buildExec = async () => ({ stdout: "DRY_RUN: not writing build output or state" });
    const result = await runAndPublish(["--dry-run"], { buildExec, ghExec, statePath, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(result.published, false);
    assert.equal(result.pointerChanged, false);
    assert.equal(result.reason, "dry-run");
    assert.equal(created.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
