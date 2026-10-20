#!/usr/bin/env node
/* Judge calibration (GV-103, docs/roadmap/generation-v2.md): labelled examples
 * in, an agreement-by-threshold table out, for page support and clip scores.
 *
 *     node tools/generation/calibrate-judges.mjs --extract data-local/calibration --out data-local/judge-calibration/to-label.jsonl
 *     node tools/generation/calibrate-judges.mjs --labels data-local/judge-calibration/labelled.jsonl \
 *         --kind page-support --judge jev --out data-local/judge-calibration/page-support.jev.json
 *
 * The exports come from `generate-forays --keep-calibration data-local/calibration`
 * (one per prompt, written just before its checkpoint is discarded). The work
 * and every flag are in `backend/src/cli/calibrateJudges.ts`; this launcher has
 * none of its own. Paths are read with cwd backend/, so `data-local/...`
 * means backend/data-local/ (gitignored like the root one).
 *
 * WHY A LAUNCHER, as warm-transcript-index.mjs argues it: tools/ is ALLOWED in
 * tools/ci/path-policy.mjs, and Node 24 will not spawn npm's .cmd without a
 * shell (which would split this checkout's path at "Vibe Coding"), so it spawns
 * `node <tsx> <entry>` directly.
 *
 * Nothing here calls Anthropic. --judge jev needs JEV_API_KEY or JEV_KEY_FILE;
 * --judge qwen needs FORAY_LLM_BASE_URL (LiteLLM).
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
export const CALIBRATE_ENTRY = "src/cli/calibrateJudges.ts";

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = process.argv.slice(2);

  console.log(`[calibrate] ${CALIBRATE_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, CALIBRATE_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.log(`[calibrate] calibrator exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

const isMain = isEntryScript(import.meta.url);
if (isMain) await main();
