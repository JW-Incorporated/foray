#!/usr/bin/env node
/* Warm the transcript corpus before a run, and print what it cost (issue #703).
 *
 *     node tools/generation/warm-transcript-index.mjs
 *     node tools/generation/warm-transcript-index.mjs --offline
 *     node tools/generation/warm-transcript-index.mjs --show this-podcast-will-kill-you
 *     node tools/generation/warm-transcript-index.mjs --reconcile-only
 *     node tools/generation/warm-transcript-index.mjs --build-only
 *
 * WHY THIS EXISTS (issue #703)
 * On 2026-09-14 a Foray about germ theory was sourced from six *Geology Bites*
 * episodes on banded iron formations and *Being an Engineer* on toothpaste
 * boxes, while 49 of 132 *This Podcast Will Kill You* episodes on the same disk
 * say "Semmelweis", "miasma" or "Pasteur". 4,318 of the machine's 5,041
 * transcribed episodes — 86 % — could not be searched, and the run reported
 * "Medicine (semantic-concept, tape: strong, 304 items)" without a hint that
 * anything was missing.
 *
 * The work itself is `backend/src/cli/warmTranscriptIndex.ts`, and its header
 * carries the diagnosis: the committed digests are a record of the last
 * `fetch-transcripts.mjs` invocation rather than of the corpus, so seven shows
 * had no digest row at all, and a 60-vs-80-character disagreement between the
 * name the fetcher writes and the prefix the reader looks for hid 990 more.
 *
 * WHY `tools/generation/` AND A LAUNCHER, exactly as `start-run.mjs` argues it:
 *   1. Path policy. `tools/` is ALLOWED in `tools/ci/path-policy.mjs`; a run
 *      command that lives here does not drag its every future edit out of the
 *      auto-merge allowlist.
 *   2. This is a RUN command. It belongs beside `start-run.mjs` and `relay.mjs`
 *      because it is the thing you do immediately before them, and a founder
 *      reading that directory should see all three.
 *   3. It cannot run `npm` itself — Node 24 refuses to `spawn` a `.cmd` without
 *      a shell, and `shell: true` concatenates argv (DEP0190), which would split
 *      this checkout's own path at "Vibe Coding". So it spawns `node <tsx>
 *      <entry>` directly, like its neighbour.
 *
 * The floor for this file's suite lives in test/suite-integrity.test.js.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describeExit, exitCodeFor } from "./exit-code.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The entry the launcher runs, relative to `backend/`. Named here rather than
 * read out of a package script because — unlike `generate-forays` — there is no
 * npm script for it to drift from: `tools/` is the only front door. */
export const WARM_ENTRY = "src/cli/warmTranscriptIndex.ts";

/** Every flag belongs to the warmer; this launcher has none of its own, so
 * there is no `--` to split on and nothing to keep in sync. */
export function warmArgs(argv) {
  return argv.slice();
}

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = warmArgs(process.argv.slice(2));

  console.log(`[warm] ${WARM_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, WARM_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  /* Exit 1 means "warmed, and there are still shows nothing can search" — the
     warmer's own verdict, passed through so a caller can gate a run on it.
     data-tools-8: a warmer ended by a signal is 128 + n, never 0. */
  if (signal) console.log(`[warm] warmer exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
