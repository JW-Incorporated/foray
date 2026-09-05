#!/usr/bin/env node
/* tools/shows/run-and-publish.mjs — S-04b orchestration: run S-04a's
   builder, then (unless it skipped because this export_version is already
   built) publish a GitHub Release and write data/shows-index-pointer.json.
   This is what .github/workflows/shows-import.yml actually invokes.

   Split from import-dump.mjs's own main() deliberately: import-dump.mjs
   is S-04a's file (owned by that card) and stays a pure offline builder;
   everything GitHub-Release-shaped is new in this card and lives here so
   the two cards' owned files never collide on the same lines.

   Usage:
     node tools/shows/run-and-publish.mjs [--dump-file PATH] [--dry-run]
   Flags are forwarded to import-dump.mjs's fetch/build step; --dry-run
   also skips the publish step (nothing to publish without a build). */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BUILD_OUT_DIR, POINTER_PATH, STATE_PATH,
} from "./config.mjs";
import {
  buildPointer, listReleaseAssets, publishRelease, releaseExists, releaseTagFor,
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
  const scriptArgs = ["tools/shows/import-dump.mjs", ...argv];
  try {
    const { stdout } = await exec(process.execPath, scriptArgs, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, skipped: /^SKIP:/m.test(stdout) };
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
    is exactly the module-level config.mjs constants. */
export async function runAndPublish(argv, {
  buildExec = execFileP,
  ghExec = execFileP,
  statePath = STATE_PATH,
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
    return { published: false, reason: "dry-run" };
  }

  if (build.skipped) {
    log("SKIP: build was already current — nothing new to publish (idempotency: no release created)");
    return { published: false, reason: "build-skipped" };
  }

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const manifest = JSON.parse(await readFile(`${buildOutDir}/manifest.json`, "utf8"));
  const tag = releaseTagFor(state.export_version);

  // Belt-and-braces idempotency check, independent of S-04a's own
  // state.json skip above — see releaseExists's doc comment for why both
  // checks matter. A tag that already exists here means state.json was
  // lost (fresh checkout, evicted cache) while the release survived.
  if (await releaseExists(tag, { exec: ghExec, repo })) {
    log(`SKIP: release ${tag} already exists on GitHub — nothing new to publish`);
    return { published: false, reason: "release-exists", tag };
  }

  const assets = await listReleaseAssets(buildOutDir);
  const { asset_base_url: assetBaseUrl } = await publishRelease({
    tag,
    title: `Shows index — ${state.export_version}`,
    notes: [
      `Automated shows-index release (S-04b).`,
      `export_version: ${state.export_version}`,
      `rows: read ${manifest.counts.read}, in_4a ${manifest.counts.in_4a}, canonical ${manifest.counts.canonical}`,
    ].join("\n"),
    assets,
    exec: ghExec,
    repo,
  });

  const pointer = buildPointer({
    tag,
    assetBaseUrl,
    exportVersion: state.export_version,
    manifest,
  });
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  log(`PUBLISHED: ${tag} (${assets.length} assets) — pointer written to ${pointerPath}`);
  return { published: true, tag, assetCount: assets.length };
}

async function main() {
  await runAndPublish(process.argv.slice(2));
}

if (process.argv[1] && process.argv[1].endsWith("run-and-publish.mjs")) {
  main().catch((e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
