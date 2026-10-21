#!/usr/bin/env node
/* The Spark generation worker (GV-105, docs/roadmap/generation-v2.md, #1286):
 * claims queued generation_jobs rows one at a time, runs the generation
 * pipeline for each, publishes item-level snapshots to the row and narration
 * lines to the render spool.
 *
 *     node tools/generation/generation-worker.mjs [--worker <name>] [--out data-local/generation-worker]
 *         [--render-spool <dir>] [--max-resumes N] [--once] [--allow-short-archive]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY_FILE) on the Spark, and FORAY_LLM_BASE_URL for the
 * local Qwen lanes (without it every stage is a Stub: the plumbing run). It
 * refuses to start when ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY or
 * FORAY_ALLOW_ANTHROPIC_LEGACY is set, or when any stage is routed to an
 * Anthropic builder. Nothing starts it automatically. The work and every flag
 * are in `backend/src/cli/generationWorker.ts`; this launcher has none of its
 * own. Paths are read with cwd backend/, so `data-local/...` means
 * backend/data-local/ (gitignored like the root one).
 *
 * WHY A LAUNCHER, as warm-transcript-index.mjs argues it: tools/ is ALLOWED in
 * tools/ci/path-policy.mjs, and Node 24 will not spawn npm's .cmd without a
 * shell (which would split this checkout's path at "Vibe Coding"), so it spawns
 * `node <tsx> <entry>` directly. SIGINT/SIGTERM are passed on: the worker
 * finishes the job in hand and exits.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { describeExit, exitCodeFor } from "./exit-code.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The entry the launcher runs, relative to `backend/`. */
export const WORKER_ENTRY = "src/cli/generationWorker.ts";

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = process.argv.slice(2);

  console.log(`[worker] ${WORKER_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, WORKER_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = (signal) => () => child.kill(signal);
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.log(`[worker] worker exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

const isMain = isEntryScript(import.meta.url);
if (isMain) await main();
