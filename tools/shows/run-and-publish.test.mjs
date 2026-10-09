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
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { NEWEST_SNAPSHOT_ASSET } from "./config.mjs";
import { buildNewestSnapshot, loadPreviousNewest } from "./import-dump.mjs";
import { describeExecError, runAndPublish } from "./run-and-publish.mjs";

/** Writes a minimal but real S-04a build output tree (manifest.json +
    top/id-map/changed.json + one shard) so listReleaseAssets
    and publishRelease exercise the real file-reading code path, not a
    stub. Mirrors writeBuildOutput's shape exactly. */
async function seedBuildOutput({ buildOutDir, exportVersion }) {
  await mkdir(join(buildOutDir, "shards"), { recursive: true });
  await writeFile(join(buildOutDir, "shards", "sh.json.gz"), "fake-gzip-bytes");
  await writeFile(join(buildOutDir, "top.json"), "[]");
  await writeFile(join(buildOutDir, "id-map.json"), "{}");
  await writeFile(join(buildOutDir, "changed.json"), "[]");
  const manifest = {
    export_version: exportVersion,
    counts: { read: 10, in_4a: 8, canonical: 7 },
    shard_inventory: [{ key: "sh", row_count: 1, gz_bytes: 16 }],
  };
  await writeFile(join(buildOutDir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function fakeGhRegistry({ published = [] } = {}) {
  // Mirrors a real GitHub repo's release list across the four calls the
  // publish path makes since OPS-03: `gh release view <tag> --json
  // isDraft,assets`, `gh release create <tag> --draft` (no assets),
  // `gh release upload <tag> <files>` and `gh release edit <tag>
  // --draft=false`. `created` still records each tag exactly once, at its
  // create call — the acceptance test below counts it. `published`
  // pre-seeds tags that a PRIOR run already published.
  const created = new Set();
  const releases = new Map(published.map((tag) => [tag, { draft: false, assets: [] }]));
  const ghExec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.equal(args[0], "release");
    const [, verb, tag] = args;
    if (verb === "view") {
      const r = releases.get(tag);
      // The shape the real call's --jq projection prints: [{ name, state }].
      if (r) return { stdout: JSON.stringify({ isDraft: r.draft, assets: r.assets.map((name) => ({ name, state: "uploaded" })) }) };
      const e = new Error("not found"); e.stderr = "release not found"; throw e;
    }
    if (verb === "create") {
      // Real gh refuses a second release under a tag that already has one
      // (draft or not); a fake that accepted it would hide a duplicate create.
      if (releases.has(tag)) {
        const e = new Error("Command failed: gh release create"); e.stderr = `a release with tag ${tag} already exists`; throw e;
      }
      created.add(tag);
      releases.set(tag, { draft: args.includes("--draft"), assets: [] });
      return { stdout: "created" };
    }
    if (verb === "upload") {
      const r = releases.get(tag);
      assert.ok(r, `upload to a release that was never created: ${tag}`);
      for (const a of args.slice(3)) if (/\.json(\.gz)?$/.test(a)) r.assets.push(basename(a));
      return { stdout: "" };
    }
    if (verb === "edit") {
      const r = releases.get(tag);
      assert.ok(r, `edit of a release that was never created: ${tag}`);
      if (args.includes("--draft=false")) r.draft = false;
      return { stdout: "" };
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { ghExec, created, releases };
}

test("acceptance: two runs against the same dump version publish exactly one release", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const logs = [];
  const log = (msg) => logs.push(msg);

  try {
    // ---- Run 1: the build ran on a fresh checkout ----
    const manifest = await seedBuildOutput({ buildOutDir, exportVersion: "local:abc123" });
    const buildExecRan = async () => ({ stdout: "read 10 rows; D1 kept 8; D13 canonical 7\nBUILD_COMPLETE: out (export_version local:abc123)" });

    const result1 = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result1.published, true);
    assert.equal(result1.pointerChanged, true);
    assert.equal(result1.tag, "shows-index-local-abc123");
    // S-04c: one top-level release (manifest/top/id-map/changed) PLUS one
    // shard batch release (the fixture's single-entry shard_inventory fits
    // in one batch) — see seedBuildOutput's own shard_inventory.
    assert.equal(created.size, 2);

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.release_tag, "shows-index-local-abc123");
    assert.equal(pointer.export_version, "local:abc123");
    assert.equal(pointer.counts.canonical, 7);
    assert.equal(pointer.shards_published, true);
    assert.equal(pointer.shard_releases.length, 1);
    assert.equal(pointer.shard_releases[0].tag, "shows-index-local-abc123-shards-1");

    // ---- Run 2: SAME dump version. The build runs again in full (CI is a
    // fresh checkout; nothing remembers run 1), but the release already
    // exists on GitHub from run 1 AND the pointer already matches it. Must
    // not create a second release, and must not report a pointer change. ----
    const result2 = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result2.published, false);
    assert.equal(result2.pointerChanged, false);
    assert.equal(result2.reason, "release-exists-pointer-current");
    assert.equal(created.size, 2, "still exactly one top-level + one shard batch release after the release-already-exists path");
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
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};

  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:abc123" });
    const buildExecRan = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:abc123)" });

    const result1 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result1.published, true);
    assert.equal(result1.pointerChanged, true);
    assert.equal(created.size, 2, "one top-level + one shard batch release");

    // Simulate the pointer PR never landing: the pointer file this run just
    // wrote is now gone from a "fresh checkout" perspective on the next run.
    await rm(pointerPath, { force: true });

    const result2 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result2.published, false, "the release already exists — must not publish a duplicate");
    assert.equal(result2.pointerChanged, true, "the pointer was missing and MUST be reconciled even though nothing new was published");
    assert.equal(result2.reason, "reconciled-existing-release");
    assert.equal(created.size, 2, "still exactly one top-level + one shard batch release");

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.release_tag, "shows-index-local-abc123");

    // ---- Run 3: pointer now matches — no further change reported. ----
    const result3 = await runAndPublish(["--dump-file", "a"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    assert.equal(result3.pointerChanged, false, "pointer already reconciled — nothing left to do");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* Round-3 review (L8): pointerChanged compared the tag and shard state but not
   `version`, so a committed v1 pointer for the current release was never
   rewritten at POINTER_SCHEMA_VERSION.
   MUTATION: drop the `version` clause -- run 2 reports nothing to reconcile
   and the file stays at version 1. */
test("a pointer at an older schema version for the same release is rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec } = fakeGhRegistry();
  const log = () => {};
  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:abc123" });
    const buildExecRan = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:abc123)" });
    await runAndPublish(["--dump-file", "a"], { buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });
    const written = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.ok(written.version > 1, "the builder writes the bumped schema version");
    await writeFile(pointerPath, JSON.stringify({ ...written, version: 1 }, null, 2));

    const result = await runAndPublish(["--dump-file", "a"], { buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(result.pointerChanged, true);
    assert.equal(JSON.parse(await readFile(pointerPath, "utf8")).version, written.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a genuinely new dump version (different export_version) DOES publish a second release", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};

  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:v1" });
    const buildExecV1 = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:v1)" });
    await runAndPublish(["--dump-file", "a"], { buildExec: buildExecV1, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(created.size, 2, "one top-level + one shard batch release");

    await seedBuildOutput({ buildOutDir, exportVersion: "local:v2" });
    const buildExecV2 = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:v2)" });
    const result = await runAndPublish(["--dump-file", "b"], { buildExec: buildExecV2, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(result.published, true);
    assert.equal(result.pointerChanged, true);
    assert.equal(created.size, 4, "a second top-level + a second shard batch release");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--dry-run never publishes even on a fresh build", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry();
  const log = () => {};
  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:v1" });
    const buildExec = async () => ({ stdout: "DRY_RUN: not writing build output" });
    const result = await runAndPublish(["--dry-run"], { buildExec, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });
    assert.equal(result.published, false);
    assert.equal(result.pointerChanged, false);
    assert.equal(result.reason, "dry-run");
    assert.equal(created.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ==================================================================== */
/* S-04c: shard batch release publishing, end to end                     */
/* ==================================================================== */

test("shards_published is true and shard_releases is populated in the written pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec } = fakeGhRegistry();
  const log = () => {};
  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:abc123" });
    const buildExec = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:abc123)" });
    await runAndPublish(["--dump-file", "a"], { buildExec, ghExec, buildOutDir, pointerPath, repo: "org/repo", log });

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.shards_published, true);
    assert.equal(pointer.shard_releases.length, 1);
    const batch = pointer.shard_releases[0];
    assert.equal(batch.first_key, "sh");
    assert.equal(batch.last_key, "sh");
    assert.equal(batch.count, 1);
    assert.match(batch.asset_base_url, /^https:\/\/github\.com\/org\/repo\/releases\/download\//);

    // The manifest.json written back to buildOutDir must carry the same
    // shards_published/shard_releases values it uploads as the release
    // asset — a run that already knows shards published must not still
    // ship a manifest claiming shards_published: false.
    const manifestOnDisk = JSON.parse(await readFile(join(buildOutDir, "manifest.json"), "utf8"));
    assert.equal(manifestOnDisk.shards_published, true);
    assert.equal(manifestOnDisk.shard_releases.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run that publishes the top-level release but not the shard batch (interrupted) reconciles on the next run", async () => {
  // Simulates a prior run that created the top-level release but never got
  // to the shard batch (process killed between the two publish steps) —
  // the NEXT run for the SAME export_version must still publish the
  // missing shard batch and update the pointer's shards_published, even
  // though the top-level release_tag is unchanged.
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const log = () => {};

  // Pre-seed GitHub with the top-level release already PUBLISHED, but no
  // shard batch release yet (same view/create/upload/edit fake as above).
  const { ghExec, created } = fakeGhRegistry({ published: ["shows-index-local-abc123"] });

  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:abc123" });
    const buildExec = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:abc123)" });

    const result = await runAndPublish(["--dump-file", "a"], {
      buildExec, ghExec, buildOutDir, pointerPath, repo: "org/repo", log,
    });
    // The top-level release itself was NOT re-published (releaseExists was
    // true for it), but the pointer still changes because shard publishing
    // just completed for the first time.
    assert.equal(result.published, false);
    assert.equal(result.pointerChanged, true);
    assert.ok(created.has("shows-index-local-abc123-shards-1"), "the missing shard batch must be published this run");

    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    assert.equal(pointer.shards_published, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* OPS-01 — the FATAL line carries the facts. The 2026-09-20 shows-import
   run (35507245541) died with one `FATAL: Command failed: gh release
   create <tag> <100 shard paths>` line that the Actions log cut after the
   paths; the exit code and stderr never appeared. describeExecError puts
   each fact on its own short line so none of them can be truncated away. */
function fakeExecFailure(overrides = {}) {
  return Object.assign(
    new Error("Command failed: gh release create t a b c d e f g h\nsome stderr"),
    { cmd: "gh release create t a b c d e f g h", code: 1, signal: null, killed: false, stderr: "some stderr", stdout: "created" },
    overrides,
  );
}

test("describeExecError: an execFile failure prints code, signal, stderr and stdout on their own lines", () => {
  const lines = describeExecError(fakeExecFailure());
  // 12 tokens in the cmd; maxArgs = 6 keeps `gh release create t a b` and counts the rest.
  assert.equal(lines[0], "FATAL: Command failed: gh release create t a b … (+6 more args)");
  assert.ok(lines.includes("FATAL_CODE: 1"), `missing FATAL_CODE in ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("FATAL_STDERR: some stderr"), `missing FATAL_STDERR in ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("FATAL_STDOUT: created"), `missing FATAL_STDOUT in ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => l.startsWith("FATAL_SIGNAL")), `signal was null; got ${JSON.stringify(lines)}`);
});

test("describeExecError: an empty stderr is said out loud", () => {
  const lines = describeExecError(fakeExecFailure({ stderr: "" }));
  assert.ok(lines.includes("FATAL_STDERR: (empty)"), `expected (empty) marker in ${JSON.stringify(lines)}`);
});

test("describeExecError: a non-exec error keeps its first message line only", () => {
  assert.deepEqual(describeExecError(new Error("boom\nsecond")), ["FATAL: boom"]);
});

test("#1033 the baseline snapshot ships on the release the pointer names, at the URL the next run fetches", async () => {
  /* The publish half of changed.json's baseline: the next run's import-dump
     downloads `<pointer.asset_base_url>/newest-snapshot.json.gz`, so the
     snapshot has to be an asset of the TOP-LEVEL release this run points
     at. Served here only if the fake registry actually holds it.
     MUTATION THAT KILLS THIS: drop NEWEST_SNAPSHOT_ASSET from
     listReleaseAssets' list. The release ships without it, the next run's
     download 404s, and the baseline stays false forever. Ran it: red. */
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, releases } = fakeGhRegistry();
  try {
    await seedBuildOutput({ buildOutDir, exportVersion: "local:snap01" });
    const snapshot = buildNewestSnapshot([{ id: 11, newestItemPubdate: 1000 }, { id: 12, newestItemPubdate: 2000 }], { exportVersion: "local:snap01" });
    await writeFile(join(buildOutDir, NEWEST_SNAPSHOT_ASSET), gzipSync(Buffer.from(JSON.stringify(snapshot))));
    const buildExecRan = async () => ({ stdout: "BUILD_COMPLETE: out (export_version local:snap01)" });

    const result = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec: buildExecRan, ghExec, buildOutDir, pointerPath, repo: "org/repo", log: () => {},
    });
    assert.equal(result.published, true);
    assert.ok(releases.get(result.tag).assets.includes(NEWEST_SNAPSHOT_ASSET), "the snapshot is a top-level release asset");

    // Next week's run: download through the pointer this run wrote.
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    const fetchImpl = async (url) => {
      const prefix = `${pointer.asset_base_url}/`;
      const name = url.startsWith(prefix) ? url.slice(prefix.length) : null;
      if (!name || !releases.get(result.tag).assets.includes(name)) return new Response("Not Found", { status: 404 });
      return new Response(await readFile(join(buildOutDir, name)), { status: 200 });
    };
    const loaded = await loadPreviousNewest({ pointerPath, fetchImpl });
    assert.equal(loaded.reason, null);
    assert.deepEqual(loaded.previousNewest, { 11: 1000, 12: 2000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* CH2-31 (T1-15): the contract that survived deleting state.mjs. CI is
   always a fresh checkout, so the build step always runs in full, and
   `releaseExists` is the one thing that stops a second release for the same
   export_version. The fake build writes its output only when it is called,
   exactly as import-dump.mjs does, so nothing from a previous run is on disk.
   MUTATIONS THAT KILL THIS (both run, both red):
   - skip the `releaseExists` check before `publishRelease` (always take the
     publish branch): the fake registry, like real gh, refuses a second create
     under an existing tag and the run throws;
   - read the export_version from a local marker file again instead of the
     manifest this build just wrote: there is none on a fresh checkout and
     the run throws ENOENT. */
test("a fresh checkout runs the full build and releaseExists alone stops a duplicate release", async () => {
  const root = await mkdtemp(join(tmpdir(), "shows-e2e-"));
  const buildOutDir = join(root, "out");
  const pointerPath = join(root, "shows-index-pointer.json");
  const { ghExec, created } = fakeGhRegistry({
    published: ["shows-index-local-fresh1", "shows-index-local-fresh1-shards-1"],
  });
  let builds = 0;
  const buildExec = async () => {
    builds += 1;
    await seedBuildOutput({ buildOutDir, exportVersion: "local:fresh1" });
    return { stdout: "BUILD_COMPLETE: out (export_version local:fresh1)" };
  };
  try {
    const result = await runAndPublish(["--dump-file", "fixture.db"], {
      buildExec, ghExec, buildOutDir, pointerPath, repo: "org/repo", log: () => {},
    });
    assert.equal(builds, 1, "the build ran in full");
    assert.equal(result.published, false, "the release already exists on GitHub");
    assert.equal(result.reason, "reconciled-existing-release");
    assert.equal(created.size, 0, "no release of either kind was created");
    assert.equal(JSON.parse(await readFile(pointerPath, "utf8")).release_tag, "shows-index-local-fresh1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
