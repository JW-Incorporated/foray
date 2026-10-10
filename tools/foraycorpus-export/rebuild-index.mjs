#!/usr/bin/env node
/* Sync the R2 transcript mirror, then warm the transcript index for exactly
   the shows that sync left bodies for (PKG-14, docs/roadmap/corpus.md §3
   "PKG-14 · rebuild-index.mjs launcher").

     node tools/foraycorpus-export/rebuild-index.mjs
     node tools/foraycorpus-export/rebuild-index.mjs --offline
     node tools/foraycorpus-export/rebuild-index.mjs --show <dir|show_id> --offline
     node tools/foraycorpus-export/rebuild-index.mjs --dry-run

   Every flag except --offline belongs to sync-r2.mjs and goes to its
   parseSyncArgs (an unknown flag throws before any credential is read).
   --offline belongs to the warmer and is passed through to it.

   1. Sync. sync-r2.mjs runSync(argv) runs in this process and returns
      {state, summary}; the returned state is used as it is (the state file is
      not re-read). --dry-run writes nothing, so it prints the sync summary and
      stops: there is nothing new on disk to warm.
   2. Warm. warmArgsFor(state, {offline}) names every `state.shows` directory
      with bodies > 0 as one `--show <name>` pair. The name is NOT the state
      key: sync keys `shows` by localDirFor(show_id) = safeKey(show_id) =
      '<slug>-<10 hex>' (show-map.mjs, tools/segments/fetch-transcripts.mjs
      safeKey), while the warmer filters on showId = the directory name with
      /-[0-9a-f]{10}$/ stripped (backend/src/generation/transcriptCorpus.ts
      SHOW_DIR_HASH; backend/src/cli/warmTranscriptIndex.ts onlyShows /
      args.shows). So the hash is stripped, and two directories that strip to
      one name give one pair. The pairs are sorted.
      parseWarmArgs collects repeated `--show` into shows[], so ONE spawn of
      tools/generation/warm-transcript-index.mjs carries them all. It is
      spawned as `node <absolute launcher path>`; that launcher resolves tsx
      and its own cwd (backend/). Its exit code is passed through exitCodeFor
      (tools/generation/exit-code.mjs), so a warmer ended by a signal is never 0.
   3. No show has bodies: the warm is SKIPPED, exit 0. An empty `--show` list
      is not "warm nothing" to the warmer, it is "warm EVERY show on this
      machine" (warmTranscriptIndex.ts onlyShows.length > 0 guard), which on a
      16 GB machine is the expensive run this launcher exists to narrow.

   Corpus supply only: this file spawns the warmer and edits nothing in
   tools/generation/ or backend/. The floor for its suite lives in
   test/suite-integrity.test.js. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { isEntryScript } from "../ci/entry.mjs";

import { describeExit, exitCodeFor } from "../generation/exit-code.mjs";
import { ROOT } from "./config.mjs";
import { parseSyncArgs, runSync } from "./sync-r2.mjs";

/** The warmer launcher, absolute, so the spawn does not depend on the cwd. */
export const WARM_LAUNCHER = join(ROOT, "tools", "generation", "warm-transcript-index.mjs");

/** transcriptCorpus.ts SHOW_DIR_HASH: the hash safeKey appends to a show directory. */
const SHOW_DIR_HASH = /-[0-9a-f]{10}$/;

const OFFLINE = "--offline";

/**
 * The warmer's argv for a sync state: `--show <name>` for every `state.shows`
 * key with bodies > 0, the name being the key with its 10-hex hash stripped,
 * deduped and sorted; then `--offline` when set. No show with bodies gives no
 * `--show` pair at all, which the caller must NOT spawn (the warmer would
 * warm every show).
 */
export function warmArgsFor(state, { offline = false } = {}) {
  const names = new Set();
  for (const [localDir, show] of Object.entries(state?.shows ?? {})) {
    if (show && show.bodies > 0) names.add(localDir.replace(SHOW_DIR_HASH, ""));
  }
  const args = [];
  for (const name of [...names].sort()) args.push("--show", name);
  if (offline) args.push(OFFLINE);
  return args;
}

async function main(argv) {
  const offline = argv.includes(OFFLINE);
  const syncArgv = argv.filter((a) => a !== OFFLINE);
  const { dryRun } = parseSyncArgs(syncArgv);
  const { state } = await runSync(syncArgv);
  if (dryRun) {
    console.log("rebuild-index: --dry-run; warm skipped");
    return;
  }
  const args = warmArgsFor(state, { offline });
  if (!args.includes("--show")) {
    console.log("rebuild-index: no synced show has bodies; warm skipped");
    return;
  }

  console.log(`[rebuild-index] ${WARM_LAUNCHER} ${args.join(" ")}`);
  const child = spawn(process.execPath, [WARM_LAUNCHER, ...args], { cwd: ROOT, env: process.env, stdio: "inherit" });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c, sig) => resolve({ code: c, signal: sig }));
  });
  if (signal) console.log(`[rebuild-index] warmer exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
