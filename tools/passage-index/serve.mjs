#!/usr/bin/env node
/* Start the retrieval server (GV-16, from W3-08; docs/roadmap/generation-v2.md).

     node tools/passage-index/serve.mjs [--host 127.0.0.1] [--port 7311] [--shows a,b]
       [--index-root d] [--manifest f] [--normalized-root d]

   The server itself is backend/src/cli/retrievalServer.ts: it reuses
   FileTranscriptTextIndex byte for byte, so it has to be backend code. This
   is only its launcher, the warm-transcript-index.mjs pattern: tools/ is
   ALLOWED in tools/ci/path-policy.mjs, and Node 24 will not spawn npm's .cmd
   without a shell (which would split this checkout's path at a space), so it
   spawns `node <backend tsx> <entry>` directly.

   Every flag belongs to the server; nothing is consumed here. The bearer
   token comes from FORAY_RETRIEVAL_TOKEN or FORAY_RETRIEVAL_TOKEN_FILE in the
   environment, never from argv (argv shows in a process list). The server
   refuses a bind other than 127.0.0.1 without one.

   Exit: the server's own code; a server ended by a signal is 128 + n. */
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { describeExit, exitCodeFor } from "../generation/exit-code.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The entry the launcher runs, relative to backend/. */
export const SERVE_ENTRY = "src/cli/retrievalServer.ts";

/** Every flag passes through unchanged and in order. */
export function serveArgs(argv) {
  return argv.slice();
}

async function main() {
  const backendDir = path.join(REPO_ROOT, "backend");
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");
  const args = serveArgs(process.argv.slice(2));
  console.log(`[serve] ${SERVE_ENTRY} ${args.join(" ")}  (cwd ${backendDir})`);
  const child = spawn(process.execPath, [tsx, SERVE_ENTRY, ...args], {
    cwd: backendDir,
    env: process.env,
    stdio: "inherit",
  });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, sig) => resolve({ code: c, signal: sig })));
  if (signal) console.log(`[serve] server exited ${describeExit(code, signal)}`);
  process.exitCode = exitCodeFor(code, signal);
}

if (isEntryScript(import.meta.url)) await main();
