#!/usr/bin/env node
/* tools/shows/run-and-publish.mjs — S-04b orchestration: run S-04a's
   builder, then publish a GitHub Release and write
   data/shows-index-pointer.json. This is what
   .github/workflows/shows-import.yml actually invokes. Every run builds in
   full (CI is a fresh checkout); `releaseExists` is the one idempotency
   rule — see its doc comment in publish-release.mjs.

   Split from import-dump.mjs's own main() deliberately: import-dump.mjs
   is S-04a's file (owned by that card) and stays a pure offline builder;
   everything GitHub-Release-shaped is new in this card and lives here so
   the two cards' owned files never collide on the same lines.

   CHANGED.JSON'S BASELINE (#1033) RIDES THE RELEASE. import-dump.mjs
   downloads the previous release's newest-snapshot.json.gz through the
   committed pointer BEFORE this script rewrites the pointer, and writes this
   build's own snapshot next to changed.json; listReleaseAssets ships it on
   the top-level release, so the pointer this run writes is exactly where the
   next run looks.

   Usage:
     node tools/shows/run-and-publish.mjs [--dump-file PATH] [--dry-run]
   Flags are forwarded to import-dump.mjs's fetch/build step; --dry-run
   also skips the publish step (nothing to publish without a build). */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { BUILD_OUT_DIR, POINTER_PATH } from "./config.mjs";
import {
  assetBaseUrlFor, buildPointer, listReleaseAssets, publishRelease, publishShardReleases,
  releaseExists, releaseTagFor,
} from "./publish-release.mjs";

const execFileP = promisify(execFile);

/** Runs `node tools/shows/import-dump.mjs` as a child process (not an
    in-process import) so this script measures exactly what the workflow's
    own build step would run, and so a build failure's exit code and
    stdout/stderr are exactly what a human reading Actions logs sees.
    Returns the manifest by reading it back off disk — the build step's
    own contract is "manifest.json exists and is current" whether this
    process or import-dump.mjs's own CLI produced it. */
export async function runBuild(argv, { exec = execFileP, cwd } = {}) {
  // execArgv (not argv) carries process-level V8/Node flags like
  // --experimental-sqlite. Node does NOT inherit these into a spawned
  // child automatically — only argv strings pass through — so without
  // forwarding execArgv explicitly here, a real (non-test) invocation
  // would silently drop the flag and import-dump.mjs's `import("node:sqlite")`
  // would throw on any Node < 23.4, including the Node 22 the workflow
  // pins. Every test in this file injects a fake `exec`, so this exact gap
  // was invisible to the suite until reviewed against the real spawn path
  // — see run-and-publish.test.mjs's own real-subprocess test added for it.
  const scriptArgs = [...process.execArgv, "tools/shows/import-dump.mjs", ...argv];
  try {
    const { stdout } = await exec(process.execPath, scriptArgs, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout };
  } catch (err) {
    // import-dump.mjs's own --dry-run path exits 0; a real build failure
    // exits 1 with FATAL: on stderr, which the caller re-throws unchanged
    // so the workflow step fails loudly instead of silently continuing to
    // a publish step with no fresh manifest.
    throw err;
  }
}

/** The whole run-then-publish flow, fully overridable for tests: every
    path constant and the `gh` exec can be swapped so publish-release's
    idempotency guarantee is exercised end-to-end against a real (small)
    build without touching this repo's own data-local/ or a real GitHub
    repo. Production `main()` below calls this with zero overrides, which
    is exactly the module-level config.mjs constants.

    RECONCILES THE POINTER INDEPENDENTLY OF "did this run publish a new
    release" (fresh-context review finding, 2026-09-05): if a prior run
    published a release but its pointer-PR step never landed (workflow
    interrupted, PR closed, transient failure), a later run for the SAME
    export_version used to hit `releaseExists` -> `published: false` and
    stop — the pointer PR was never re-opened, and the whole run reported
    no work needed while `data/shows-index-pointer.json` silently drifted
    behind the release that actually exists. The function now ALWAYS
    computes the intended pointer for the current build's export_version
    (whether the release was just published or already existed) and
    reports `pointerChanged` against whatever is currently on disk, so the
    workflow can open/refresh the PR on that signal instead of on
    `published`. */
export async function runAndPublish(argv, {
  buildExec = execFileP,
  ghExec = execFileP,
  buildOutDir = BUILD_OUT_DIR,
  pointerPath = POINTER_PATH,
  repo,
  cwd,
  log = console.log,
} = {}) {
  const dryRun = argv.includes("--dry-run");

  const build = await runBuild(argv, { exec: buildExec, cwd });
  log(build.stdout);

  if (dryRun) {
    log("DRY_RUN: not publishing (see import-dump.mjs's own DRY_RUN line above)");
    return { published: false, pointerChanged: false, reason: "dry-run" };
  }

  let manifest = JSON.parse(await readFile(`${buildOutDir}/manifest.json`, "utf8"));
  const exportVersion = manifest.export_version;
  const tag = releaseTagFor(exportVersion);

  // S-04c: publish every shard batch release BEFORE the top-level release,
  // always — independent of whether the top-level release already exists,
  // so the manifest.json this run uploads (or reconciles) can carry the
  // real `shards_published`/`shard_releases` state rather than a stale
  // `false` baked in at build time. `publishShardReleases`'s own
  // `releaseExists` check per batch (mirroring `releaseExists` below)
  // makes re-running this unconditionally cheap and idempotent: an
  // already-published batch is a single `gh release view`, not a
  // re-upload, so a run interrupted after batch 1 resumes cleanly at
  // batch 2 on the next run. The build step above always runs in full, so
  // `buildOutDir`/`manifest.json`'s `shard_inventory` (and the shard .gz
  // files on disk under `buildOutDir/shards/`) are fresh from THIS run.
  const shardReleases = await publishShardReleases({
    baseTag: tag,
    outDir: buildOutDir,
    shardInventory: manifest.shard_inventory || [],
    exec: ghExec,
    repo,
    log,
  });
  manifest = { ...manifest, shards_published: shardReleases.length > 0, shard_releases: shardReleases };
  await writeFile(`${buildOutDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  // The idempotency check (releaseExists's doc comment is the one
  // description of it): a tag that already exists means an earlier run
  // published this export_version, so nothing is published twice.
  //
  // NOTE: if the top-level release ALREADY exists, the manifest.json
  // asset it shipped on the run that created it is now stale relative to
  // the freshly-rewritten one above (that upload cannot be amended
  // in-place without `--clobber`, which risks a partial-release window on
  // a release listReleaseAssets/S-11 already reads) — the POINTER file
  // (written below, which every consumer of shard_releases actually
  // reads — see api/shows/index/[...path].ts) is reconciled every run
  // regardless, so this staleness is confined to the release's own
  // manifest.json asset, not to anything a client's shard fetch depends
  // on.
  let assetBaseUrl;
  let published = false;
  if (await releaseExists(tag, { exec: ghExec, repo })) {
    log(`SKIP: release ${tag} already exists on GitHub — nothing new to publish`);
    assetBaseUrl = assetBaseUrlFor(tag, repo);
  } else {
    const assets = await listReleaseAssets(buildOutDir);
    ({ asset_base_url: assetBaseUrl } = await publishRelease({
      tag,
      title: `Shows index — ${exportVersion}`,
      notes: [
        `Automated shows-index release (S-04b).`,
        `export_version: ${exportVersion}`,
        `rows: read ${manifest.counts.read}, in_4a ${manifest.counts.in_4a}, canonical ${manifest.counts.canonical}`,
        ...(manifest.newest_snapshot
          ? [`changed.json baseline for the next release: ${manifest.newest_snapshot.asset} (${manifest.newest_snapshot.count} ids)`]
          : []),
      ].join("\n"),
      assets,
      exec: ghExec,
      repo,
    }));
    published = true;
    log(`PUBLISHED: ${tag} (${assets.length} assets)`);
  }

  const pointer = buildPointer({
    tag,
    assetBaseUrl,
    exportVersion: exportVersion,
    manifest,
    shardReleases,
    shardsPublished: shardReleases.length > 0,
  });

  // Reconcile against whatever is currently committed, REGARDLESS of
  // `published` — this is the fix. Compare on release_tag AND
  // shards_published/shard_releases (not the whole object, which includes
  // a fresh `published_at` timestamp every run) so re-running against an
  // unchanged release never reports a spurious diff, but a run that
  // finishes publishing shards a PRIOR run left incomplete still updates
  // the pointer even though `release_tag` alone is unchanged.
  let currentPointer = null;
  try {
    currentPointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch {
    // No pointer file yet — this is the first release ever, or it was
    // never committed. Either way, a write is needed.
  }
  // `version` too (round-3 review, L8): a committed v1 pointer for the same
  // release and shard state still has to be rewritten at the bumped
  // POINTER_SCHEMA_VERSION, or the version never describes the shape.
  const pointerChanged = !currentPointer
    || currentPointer.version !== pointer.version
    || currentPointer.release_tag !== pointer.release_tag
    || currentPointer.shards_published !== pointer.shards_published
    || JSON.stringify(currentPointer.shard_releases || []) !== JSON.stringify(pointer.shard_releases);

  if (!pointerChanged) {
    log(`SKIP: data/shows-index-pointer.json already points at ${tag} — nothing to reconcile`);
    return { published, pointerChanged: false, reason: published ? "published-pointer-current" : "release-exists-pointer-current", tag };
  }

  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  log(`POINTER_UPDATED: ${pointerPath} now points at ${tag}${published ? "" : " (release already existed — reconciling a stale/missing pointer)"}`);
  return { published, pointerChanged: true, tag, reason: published ? "published" : "reconciled-existing-release" };
}

/** Turns a thrown error — most usefully an execFile rejection from a
    failed `gh` call — into the lines the workflow log should carry, one
    fact per line (OPS-01). The 2026-09-20 run (35507245541) died with a
    single `FATAL: Command failed: gh release create <tag> <100 paths…>`
    line that the log cut after the paths, so the exit code and stderr
    never appeared. The command head is capped at `maxArgs` tokens and
    stderr/stdout are tail-truncated to `tailChars` so the facts survive
    the log's line limit. Diagnostic only: nothing here changes what the
    run does, only what it says when it fails. */
export function describeExecError(err, { maxArgs = 6, tailChars = 4000 } = {}) {
  const lines = [];
  let head;
  if (typeof err?.cmd === "string") {
    const tokens = err.cmd.split(/\s+/).filter(Boolean);
    head = `Command failed: ${tokens.slice(0, maxArgs).join(" ")}`;
    if (tokens.length > maxArgs) head += ` … (+${tokens.length - maxArgs} more args)`;
  } else {
    head = String(err?.message ?? err).split("\n")[0];
  }
  lines.push(`FATAL: ${head}`);
  if (err?.code !== undefined && err.code !== null) lines.push(`FATAL_CODE: ${err.code}`);
  if (err?.signal) lines.push(`FATAL_SIGNAL: ${err.signal}`);
  if (err?.killed === true) lines.push("FATAL_KILLED: true");
  const tail = (s) => {
    const t = String(s).trim();
    return t ? t.slice(-tailChars) : "(empty)";
  };
  if ("stderr" in Object(err)) lines.push(`FATAL_STDERR: ${tail(err.stderr)}`);
  if ("stdout" in Object(err)) lines.push(`FATAL_STDOUT: ${tail(err.stdout)}`);
  return lines;
}

async function main() {
  await runAndPublish(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    for (const line of describeExecError(e)) console.error(line);
    process.exit(1);
  });
}
