/* DEPRECATED entry point — thin wrapper. All real logic now lives in
   tools/refresh/scan.mjs (adds audio provenance fields + configurable
   STATE_PATH/PENDING_PATH; see that file's header). This wrapper exists
   only so the documented command (.claude/commands/nightly-refresh.md)
   and the permission allowlist (.claude/settings.json) that name this
   path keep working unchanged — it simply re-execs scan.mjs with the
   same argv and forwards its exit code and output verbatim.

   Usage: node tools/refresh-feeds.mjs [--limit N] [--window-hours H]
   Prefer calling tools/refresh/scan.mjs directly in new code/docs.      */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = join(ROOT, "refresh", "scan.mjs");

const child = spawn(process.execPath, [SCAN_SCRIPT, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", (e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
