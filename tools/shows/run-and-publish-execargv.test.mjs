/* Real-subprocess test for runBuild's execArgv forwarding — the exact gap
   a fully-faked `exec` (as every test in run-and-publish.test.mjs uses)
   cannot catch. This spawns node for real (no fixture, no fake exec) and
   proves the parent's execArgv (e.g. --experimental-sqlite) actually
   reaches the child's argv, rather than trusting that node inherits
   process-level flags into a spawned child on its own — it does not. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "./run-and-publish.mjs";

const execFileP = promisify(execFile);

test("runBuild: forwards this process's execArgv to the spawned import-dump.mjs child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runbuild-execargv-"));
  // A stand-in "import-dump.mjs" that does nothing but print its own argv —
  // this proves what actually reaches the child process, independent of
  // the real builder's own logic.
  const stub = join(dir, "tools", "shows", "import-dump.mjs");
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "tools", "shows"), { recursive: true }));
  await writeFile(stub, "console.log(JSON.stringify(process.execArgv));\n");

  try {
    // Simulate the parent having been launched with a real execArgv flag
    // (as the real workflow launches run-and-publish.mjs with
    // --experimental-sqlite) by spawning a real node subprocess with a
    // flag and running runBuild from inside it — this exercises the true
    // parent-execArgv -> child-argv path, not a mocked one. `--no-warnings`
    // is used here rather than `--experimental-sqlite` itself so this test
    // passes on every Node major version this repo's CI/dev machines run
    // (`--experimental-sqlite` doesn't exist before Node 22.5); the
    // forwarding mechanism under test (process.execArgv) does not care
    // which flag it is.
    const harness = join(dir, "harness.mjs");
    await writeFile(harness, `
      import { runBuild } from ${JSON.stringify(new URL("./run-and-publish.mjs", import.meta.url).pathname)};
      const result = await runBuild([], { cwd: ${JSON.stringify(dir)} });
      console.log(result.stdout);
    `);
    const { stdout } = await execFileP(process.execPath, ["--no-warnings", harness]);
    const childExecArgv = JSON.parse(stdout.trim().split("\n").pop());
    assert.ok(
      childExecArgv.includes("--no-warnings"),
      `expected the spawned import-dump.mjs child to inherit --no-warnings, got execArgv: ${JSON.stringify(childExecArgv)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
