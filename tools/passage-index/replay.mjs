#!/usr/bin/env node
/* The retrieval replay and the hybrid go/no-go gate (GV-88, from W3-15;
   docs/roadmap/generation-v2.md).

     node tools/passage-index/replay.mjs run --fixture FILE --topic NODE|none
       [--out FILE] [--mode bm25|hybrid] [--show-share off]
       [--root DIR] [--archive FILE] [--pool FILE]
       [--normalized-root DIR] [--index-root DIR]
     node tools/passage-index/replay.mjs compare BASE.json CAND.json
       [--gate default|hybrid] [--gold FILE] [--out FILE]

   The replay itself is backend/src/cli/replaySourcing.ts: it runs the
   backend's own sourceBeats over a banked deepen output, so it has to be
   backend code. This is only its launcher, the serve.mjs pattern: tools/ is
   ALLOWED in tools/ci/path-policy.mjs, and Node 24 will not spawn npm's .cmd
   without a shell (which would split this checkout's path at a space), so it
   spawns `node <backend tsx> <entry>` directly.

   Every argument passes through unchanged. Relative paths are resolved
   against the directory this launcher was started from, because the child
   runs in backend/. The retrieval server is FORAY_RETRIEVAL_URL (with
   FORAY_RETRIEVAL_TOKEN or FORAY_RETRIEVAL_TOKEN_FILE) in the environment,
   never argv. No model is called.

   Exit: the replay's own code (0 done or pass, 1 compare fail, 2 usage);
   a replay ended by a signal is 128 + n. */
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { describeExit, exitCodeFor } from "../generation/exit-code.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The entry the launcher runs, relative to backend/. */
export const REPLAY_ENTRY = "src/cli/replaySourcing.ts";

/** Flags whose value is a path, resolved against the caller's directory. */
const PATH_FLAGS = new Set(["--fixture", "--out", "--root", "--archive", "--pool", "--normalized-root", "--index-root", "--gold"]);

/** The arguments with every path made absolute against `cwd`: flag values in
 * PATH_FLAGS and compare's two report files. Everything else is unchanged. */
export function replayArgs(argv, cwd = process.cwd()) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (PATH_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, path.resolve(cwd, argv[i + 1]));
      i += 1;
    } else if (argv[0] === "compare" && i > 0 && !arg.startsWith("--") && !PATH_FLAGS.has(argv[i - 1]) && argv[i - 1] !== "--gate") {
      out.push(path.resolve(cwd, arg));
    } else {
      out.push(arg);
    }
  }
  return out;
}

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = replayArgs(process.argv.slice(2));
  const child = spawn(process.execPath, [tsx, REPLAY_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.error(`[replay] replay exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

if (isEntryScript(import.meta.url)) await main();
