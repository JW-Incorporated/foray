#!/usr/bin/env node
/* judge.mjs — the offline judged-metrics pass over one candidate Foray (GV-92).
 *
 *     node tools/generation-bench/judge.mjs --candidate <foray.json>
 *       [--report <report.json> [--entry N (1-based, as score.mjs)]] [--golden tools/generation-bench/golden/golden-v1.json]
 *       [--prompt-id <id>] [--out <file>] [--runlog <file>]
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-92 from W1-18; #1286)
 * score.mjs (GV-24) reads five judged cells it cannot compute from files:
 * MQ-02 supported sentences, MQ-03 attribution, MQ-05 clip on subject, MQ-10
 * prompt fit and MQ-12 seam coherence. This asks the judge (Jev, with the
 * Qwen-judge fallback when the judge route says so) after the run, off the
 * timed path, and writes `<candidate>.judged.json` beside the candidate, the
 * name score.mjs looks for. The file carries numbers, ids and fixed reasons
 * only: no prompt text and no transcript text. Every value is UNCALIBRATED
 * until the founder's listening cards calibrate the thresholds (LM-24).
 *
 * The work is `backend/src/cli/judgeCandidate.ts`. It needs the Jev key (or a
 * routed local judge) and the machine's transcripts in data-local/; with no
 * judge it exits 2 and sends nothing. Every judge call counts against the
 * per-Foray jevCalls cap (GV-90, FORAY_JEV_CALLS_PER_FORAY).
 *
 * WHY A LAUNCHER (the pattern of tools/generation/warm-transcript-index.mjs):
 * `tools/` is the front door for run commands, and it cannot run `npm` itself
 * (Node 24 refuses to spawn a `.cmd` without a shell, and `shell: true` would
 * split a checkout path with a space in it), so it spawns `node <tsx> <entry>`
 * from backend/. Relative paths in the arguments are resolved here, against
 * the directory it was run from, because the child runs in backend/.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { describeExit, exitCodeFor } from "../generation/exit-code.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The entry the launcher runs, relative to `backend/`. */
export const JUDGE_ENTRY = "src/cli/judgeCandidate.ts";

/** The flags whose value is a path. */
export const PATH_FLAGS = new Set(["--candidate", "--report", "--golden", "--out", "--runlog"]);

/** The judge's arguments with every path flag's value made absolute against
 * `cwd`, so the child (which runs in backend/) reads the files meant. */
export function judgeArgs(argv, cwd = process.cwd()) {
  const out = argv.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (PATH_FLAGS.has(out[i]) && !out[i + 1].startsWith("--")) {
      out[i + 1] = path.resolve(cwd, out[i + 1]);
      i++;
    }
  }
  return out;
}

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = judgeArgs(process.argv.slice(2));

  console.log(`[judge] ${JUDGE_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, JUDGE_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.log(`[judge] judge exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

const isMain = isEntryScript(import.meta.url);
if (isMain) await main();
