#!/usr/bin/env node
/* The one command that starts a keyless generation run.
 *
 *     node tools/generation/start-run.mjs -- --prompts prompts.json --duration medium
 *
 * It brings the relay up, points the Anthropic SDK at it, starts the batch
 * driver, and takes the relay back down when the driver exits.
 *
 * WHY THIS EXISTS (issue #697)
 * Starting a run used to be a remembered ritual: rebuild the relay from a
 * paragraph in a run log, start it, export two environment variables in the
 * right shell, then run the driver from the right directory. The founder's
 * standing rule of 2026-09-14 is that everything the orchestrating session does
 * beyond starting a run and answering requests is a defect. A four-step ritual
 * is four chances to get a run's transport subtly wrong, and one of those ways
 * is silent — see the next paragraph.
 *
 * WHY IT SETS A PLACEHOLDER `ANTHROPIC_API_KEY` — MEASURED, NOT INFERRED
 * `env.anthropicDryRun` is `this.anthropicApiKey === undefined`
 * (`backend/src/config/env.ts`), and every `create*()` factory returns a **Stub**
 * builder when it is true (`createSpineBuilder.ts` and its six siblings). So on
 * a machine with no key — which is every machine on this project — the driver
 * builds stubs, makes ZERO HTTP calls, and the relay sits empty no matter how
 * correctly `ANTHROPIC_BASE_URL` is set. The run prints
 * `MODE: dry-run (no ANTHROPIC_API_KEY)` and produces structurally real,
 * editorially empty Forays.
 *
 * The `--dry-run` FLAG is a different switch entirely: it only suppresses
 * writes (candidates, checkpoints). It does not select stubs, and stubs are not
 * selected by it. Both the run log's §0 prose and #697 read as though a
 * `--dry-run` invocation would exercise the relay; against the code it does
 * not, unless a key is present. So the transport needs a key-shaped value to
 * exist for the live builders to be constructed at all, and this script sets
 * `RELAY_PLACEHOLDER_KEY` when `ANTHROPIC_API_KEY` is unset. No real key is
 * read, written, or required; the value never leaves the machine, because the
 * base URL is 127.0.0.1.
 *
 * WHY `tools/generation/` AND NOT A `backend/package.json` SCRIPT
 *   1. Path policy. `tools/` is ALLOWED in `tools/ci/path-policy.mjs`; `backend/`
 *      is not (only `backend/test/` is). A one-line npm script would drag every
 *      future change to this file out of the auto-merge allowlist for no gain.
 *   2. An npm script cannot portably start a background server, export two
 *      environment variables into a child, and guarantee the server dies with
 *      the run — on Windows and POSIX with one string. A Node script can, and it
 *      is the same command on both.
 *   3. The relay lives here. A launcher on the other side of a package boundary
 *      would hardcode a relative path back across it.
 *
 * EVERYTHING AFTER `--` GOES TO THE DRIVER UNCHANGED, so anything
 * `generateForays.ts` accepts works here and nothing has to be mirrored:
 *
 *     node tools/generation/start-run.mjs -- --prompts p.json --duration medium --limit 1
 *     node tools/generation/start-run.mjs --port 8899 -- --prompts p.json --dry-run
 *     node tools/generation/start-run.mjs --relay-only        # just the transport
 *
 * The floor for this file's suite lives in test/suite-integrity.test.js.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createRelay, DEFAULT_DIR, DEFAULT_PORT } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The value used when no `ANTHROPIC_API_KEY` is set. Deliberately self-
 *  describing: it shows up in a crash log, and it must be obvious there that
 *  nothing was billed and no credential leaked. */
export const PLACEHOLDER_KEY = "sk-ant-relay-placeholder-no-key-required";

/**
 * Split our own flags from the driver's. Everything after the first bare `--`
 * belongs to the driver, verbatim — including its own `--`-prefixed flags,
 * which is why this is a split and not an argument parser.
 */
export function splitArgs(argv) {
  const sep = argv.indexOf("--");
  const mine = sep === -1 ? argv : argv.slice(0, sep);
  const driver = sep === -1 ? [] : argv.slice(sep + 1);
  const val = (flag, fallback) => {
    const i = mine.indexOf(flag);
    return i === -1 || i === mine.length - 1 ? fallback : mine[i + 1];
  };
  return {
    port: Number(val("--port", process.env.RELAY_PORT ?? DEFAULT_PORT)),
    dir: val("--dir", process.env.RELAY_DIR ?? DEFAULT_DIR),
    parkTimeoutMs: Number(val("--park-timeout-ms", 0)),
    relayOnly: mine.includes("--relay-only"),
    quiet: mine.includes("--quiet"),
    driverArgs: driver,
  };
}

/**
 * WHICH FILE THE DRIVER IS, READ OUT OF `backend/package.json` RATHER THAN
 * HARDCODED. The launcher runs `generate-forays` the way `npm run` would, but
 * it cannot run `npm` itself: Node 24 refuses to `spawn` a `.cmd` without a
 * shell (EINVAL, measured on this machine), and `shell: true` concatenates argv
 * instead of escaping it (DEP0190) — which would split a prompts path at its
 * first space, and the founder's checkout lives under "Vibe Coding". So the
 * launcher spawns `node <tsx> <entry>` directly, and takes the entry from the
 * npm script so the two cannot drift apart silently. Test 27 pins that the
 * script still parses; if it stops, the suite goes red instead of the launcher
 * quietly running a file that no longer exists.
 */
export function driverEntryFromPackage(pkg) {
  const script = pkg?.scripts?.["generate-forays"];
  const m = typeof script === "string" ? script.match(/(\S+\.ts)\s*$/) : null;
  if (!m) {
    throw new Error(
      `backend/package.json's "generate-forays" script no longer ends in a .ts entry (found ${JSON.stringify(script)}). ` +
        `tools/generation/start-run.mjs reads it to know what to run.`
    );
  }
  return m[1];
}

/**
 * The environment the driver runs in. A pure function so a test can assert both
 * rules without starting a process: the base URL always points at the relay,
 * and an EXISTING key is never overwritten (a keyed run through a relay is a
 * legitimate thing to want, and clobbering a real key would silently change
 * which transport a run used).
 */
export function driverEnv(base, port, placeholder = PLACEHOLDER_KEY) {
  return {
    ...base,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY ?? placeholder,
  };
}

async function main() {
  const args = splitArgs(process.argv.slice(2));
  const relay = createRelay({ dir: args.dir, parkTimeoutMs: args.parkTimeoutMs, quiet: args.quiet });
  const port = await relay.listen(args.port);

  console.log(`[start-run] relay up on http://127.0.0.1:${port}`);
  console.log(`[start-run] parked requests appear in ${relay.dirs.queueDir}`);
  console.log(`[start-run] answer one by writing <id>.reply.txt beside it, or POST /answer/<id> with "Authorization: Bearer ${relay.token}"`);
  console.log(`[start-run] answer token: ${relay.token} (also in ${relay.dirs.tokenPath})`);
  console.log(`[start-run] kpi.jsonl: ${relay.dirs.kpiPath}`);

  if (args.relayOnly) {
    console.log("[start-run] --relay-only: not starting the driver. Ctrl-C to stop.");
    return;
  }
  if (args.driverArgs.length === 0) {
    console.error("[start-run] nothing after `--`; the driver needs at least `-- --prompts <file>`.");
    await relay.close();
    process.exitCode = 2;
    return;
  }

  const env = driverEnv(process.env, port);
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    console.log("[start-run] ANTHROPIC_API_KEY was unset; using the relay placeholder so the LIVE builders are");
    console.log("[start-run] constructed. Without it every create*() returns a Stub and the relay sees no calls.");
  }

  const backendDir = path.join(REPO_ROOT, "backend");
  const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf8"));
  const entry = driverEntryFromPackage(pkg);
  const tsx = createRequire(path.join(backendDir, "package.json")).resolve("tsx/cli");

  const child = spawn(process.execPath, [tsx, entry, ...args.driverArgs], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });
  console.log(`[start-run] driver: node ${tsx} ${entry} ${args.driverArgs.join(" ")}  (cwd ${backendDir})`);

  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const code = await new Promise((resolve) => child.on("exit", resolve));
  await relay.close();
  console.log(`[start-run] driver exited ${code}; relay stopped. KPI rows: ${relay.dirs.kpiPath}`);
  process.exitCode = code ?? 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
