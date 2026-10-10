#!/usr/bin/env node
/* Build the corpus-wide df table and the per-episode terms (PKG-27,
   docs/roadmap/corpus.md §3 "PKG-27 · build-terms.mjs launcher").

     node tools/foraycorpus-export/build-terms.mjs
     node tools/foraycorpus-export/build-terms.mjs --show this-podcast-will-kill-you
     node tools/foraycorpus-export/build-terms.mjs --normalized <dir> --out <dir>

   The work is backend/src/cli/buildCorpusTerms.ts (PKG-26): it writes
   data-local/transcripts/corpus-df.json and episode-terms.jsonl, which the
   topic assignment (PKG-28/29) reads. This file is only the front door, and
   it is a clone of tools/generation/warm-transcript-index.mjs's shape:

   - It cannot run `npm`/`npx` itself: Node 24 refuses to spawn a `.cmd`
     without a shell, and `shell: true` concatenates argv (DEP0190), which
     would split this checkout's own path at "Vibe Coding". So it spawns
     `node <tsx> <entry>` directly from backend/, resolving tsx exactly as the
     warm launcher (and start-run.mjs) does: createRequire(backend/package.json)
     .resolve("tsx/cli").
   - Every flag belongs to buildCorpusTerms.ts (its parseTermsArgs); this
     launcher has none of its own, so there is no `--` to split on.
   - The child's (code, signal) goes through exitCodeFor
     (tools/generation/exit-code.mjs), so a pass ended by a signal is never 0.

   Corpus supply only: this file edits nothing in backend/ or tools/generation/.
   The floor for its suite lives in test/suite-integrity.test.js. */
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { isEntryScript } from "../ci/entry.mjs";

import { describeExit, exitCodeFor } from "../generation/exit-code.mjs";
import { ROOT } from "./config.mjs";

/** The entry the launcher runs, relative to `backend/`. Hardcoded because
 * there is no npm script for it to be read from; build-terms.test.mjs checks
 * that it exists. */
export const TERMS_ENTRY = "src/cli/buildCorpusTerms.ts";

/** Every flag belongs to buildCorpusTerms.ts; a copy, order preserved. */
export function termsArgs(argv) {
  return argv.slice();
}

async function main() {
  const backendDir = path.join(ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = termsArgs(process.argv.slice(2));

  console.log(`[build-terms] ${TERMS_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, TERMS_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.log(`[build-terms] buildCorpusTerms exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

const isMain = isEntryScript(import.meta.url);
if (isMain) await main();
