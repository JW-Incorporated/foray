#!/usr/bin/env node
/* The weekly corpus cron wrapper (PKG-32's "cron wrapper", HUMAN-ACTIONS
   #139; docs/roadmap/corpus.md Q2: weekly cron on hermes-vm as
   `wyatt_readonly`, GitHub Releases plus a pointer PR, no Actions+Tailscale).

   One run, in this order, each step only after the one before succeeded:
   1. EXPORT. export.mjs runExport({source, out, catalogPath, breadthPath}),
      in this process. `--source pg` reads FORAYCORPUS_DATABASE_URL from the
      environment (the cron line sources ~/.foray/foraycorpus.env). A throw
      here ends the run: nothing is adapted or published.
   2. ADAPT. The catalog-adapter.mjs CLI, spawned as `node <path> --shows
      <THIS version dir>/shows.jsonl ...`. The version directory is the one
      step 1 returned, never latest.json and never a file left by an earlier
      run: publish-release.mjs's header warns that nothing downstream can
      tell a stale catalogue from a fresh one, so this is where it is made
      fresh. `--harvested-at` is the export version, so a rerun of the same
      version adapts to the same bytes.
   3. PUBLISH. publish-release.mjs publishCorpus({versionDir, catalogPath,
      pointerPath, exec}). It creates or resumes the Release and writes
      data/corpus-catalogue-pointer.json; it never commits or pushes.
   4. POINTER PR, only when publishCorpus says `pointerChanged`:
        git fetch origin main
        git switch --no-track -c corpus-pointer/<tag> origin/main
        git add -- data/corpus-catalogue-pointer.json
        git diff --cached --name-only   (must be exactly that one path)
        git commit -m <message + attribution trailers> -- data/corpus-catalogue-pointer.json
        git push -u origin corpus-pointer/<tag>
        sh -c <publishCorpus's prCommand>   (`gh pr create --draft ...`)
      then `git switch` back to the branch the run started on, even when a
      step failed, so next week's `git pull --ff-only` runs on main. Only the
      pointer path is ever added or committed, and a staged set that is not
      exactly that path (something else was already staged, or the pointer
      is byte-identical to main's) is refused before the commit, so the
      cron never opens an empty PR or ships a stray file. The PR command is
      publishCorpus's own string, run through `sh -c`, so the printed and
      the run command cannot drift; its `--head` must name the branch made
      here, or the run stops before any git call.

   `--dry-run`: no git, no gh, no sh. The export and the adapter write only
   into a fresh tmp directory (so data-local/'s state.json and the delta
   chain are untouched, and the delta printed is a full export), then
   publishCorpus runs with dryRun (it prints the tag, assets, pointer and PR
   command and writes no pointer), and the tmp directory is removed. With
   `--source pg` this is the hermes-vm smoke test: it reads the database and
   proves the chain end to end without publishing anything.

   exec, now, log and fs (mkdtempSync/rmSync, for the dry run's tmp
   directory) are injected; weekly.test.mjs runs the real export and the
   real adapter CLI on the synthetic fixture and fakes git/gh/sh.

   CLI: node tools/foraycorpus-export/weekly.mjs
     [--source pg|jsonl:<dir>]   default: pg
     [--breadth <file>]          default: data/catalog-breadth.json
     [--catalog <file>]          default: data/catalog.json
     [--out <dir>]               default: data-local/corpus-export/
     [--dry-run]
   The crontab line hermes-vm runs is in HUMAN-ACTIONS #139 and this
   package's README. */
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { DEFAULT_OUT as DEFAULT_CATALOGUE } from "./catalog-adapter.mjs";
import { EXPORT_OUT_DIR, POINTER_PATH, ROOT } from "./config.mjs";
import { DEFAULT_CATALOG_PATH, runExport } from "./export.mjs";
import { publishCorpus } from "./publish-release.mjs";

const execFileP = promisify(execFile);
const defaultExec = (cmd, args, opts = {}) => execFileP(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts });

export const ADAPTER_SCRIPT = join(ROOT, "tools", "foraycorpus-export", "catalog-adapter.mjs");
export const DEFAULT_BREADTH = join(ROOT, "data", "catalog-breadth.json");
export const POINTER_BRANCH_PREFIX = "corpus-pointer/";
/** The attribution trailers every pointer commit ends with. */
export const COMMIT_TRAILERS = Object.freeze([
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  "Claude-Session: https://claude.ai/code/session_01NGYodoWJ8oQbVycZhxg1AE",
]);

export class WeeklyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "WeeklyError";
    this.code = code;
  }
}

/** The pointer path as git names it: relative to ROOT, forward slashes. */
export function pointerRelPath(pointerPath = POINTER_PATH, root = ROOT) {
  return relative(root, resolvePath(pointerPath)).split("\\").join("/");
}

/** argv for the adapter spawn (after `node`): this version's shows.jsonl. */
export function adapterArgs({ versionDir, breadthPath, catalogPath, cataloguePath, harvestedAt }) {
  return [
    ADAPTER_SCRIPT,
    "--shows", join(versionDir, "shows.jsonl"),
    "--breadth", breadthPath,
    "--catalog", catalogPath,
    "--out", cataloguePath,
    "--harvested-at", harvestedAt,
  ];
}

/** The pointer commit's message: subject, one body line, the trailers. */
export function commitMessage({ tag, pointerRel, exportVersion }) {
  return [
    `data(corpus): point ${pointerRel} at ${tag}`,
    "",
    `Weekly corpus export ${exportVersion}, published by tools/foraycorpus-export/weekly.mjs (HUMAN-ACTIONS #139).`,
    "",
    ...COMMIT_TRAILERS,
  ].join("\n");
}

const out = (r) => String(r?.stdout ?? "").trim();

/** Step 4: commit the pointer on corpus-pointer/<tag> and open the PR. */
async function openPointerPr({ exec, tag, pointerRel, exportVersion, prCommand, log }) {
  const branch = POINTER_BRANCH_PREFIX + tag;
  if (!prCommand.includes(` --head ${branch} `)) {
    throw new WeeklyError("PR_HEAD_MISMATCH", `the PR command does not name --head ${branch}: ${prCommand}`);
  }
  const git = (args) => exec("git", args, { cwd: ROOT });
  const startBranch = out(await git(["rev-parse", "--abbrev-ref", "HEAD"]));
  const startSha = startBranch === "HEAD" ? out(await git(["rev-parse", "HEAD"])) : null;
  let switched = false;
  try {
    await git(["fetch", "origin", "main"]);
    await git(["switch", "--no-track", "-c", branch, "origin/main"]);
    switched = true;
    await git(["add", "--", pointerRel]);
    const staged = out(await git(["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean);
    if (staged.length !== 1 || staged[0] !== pointerRel) {
      throw new WeeklyError(
        "UNEXPECTED_STAGED_SET",
        `expected exactly ${pointerRel} staged, got [${staged.join(", ")}] (an empty set means the pointer equals main's)`,
      );
    }
    await git(["commit", "-m", commitMessage({ tag, pointerRel, exportVersion }), "--", pointerRel]);
    await git(["push", "-u", "origin", branch]);
    const pr = await exec("sh", ["-c", prCommand], { cwd: ROOT });
    log(`POINTER_PR: ${out(pr) || prCommand}`);
    return { branch };
  } finally {
    if (switched) {
      try {
        await git(startSha ? ["switch", "--detach", startSha] : ["switch", startBranch]);
      } catch (e) {
        log(`warning: could not switch back to ${startSha ?? startBranch}: ${e?.message ?? e}`);
      }
    }
  }
}

/**
 * One weekly run. Returns `{exportVersion, versionDir, tag, pointerChanged,
 * prOpened, branch, dryRun}`.
 */
export async function runWeekly({
  source = "pg",
  breadthPath = DEFAULT_BREADTH,
  catalogPath = DEFAULT_CATALOG_PATH,
  outRoot = EXPORT_OUT_DIR,
  cataloguePath = DEFAULT_CATALOGUE,
  pointerPath = POINTER_PATH,
  repo,
  dryRun = false,
  exec = defaultExec,
  now = () => new Date(),
  log = console.log,
  warn = console.error,
  fs = nodeFs,
  sourceFactory,
  sleep,
  pauseMs,
} = {}) {
  let tmp = null;
  if (dryRun) {
    tmp = fs.mkdtempSync(join(tmpdir(), "foraycorpus-weekly-dry-"));
    outRoot = join(tmp, "corpus-export");
    cataloguePath = join(tmp, "catalog-breadth-corpus.json");
  }
  try {
    // 1. Export.
    const exportOptions = { now, log, warn };
    if (sourceFactory) exportOptions.sourceFactory = sourceFactory;
    const { exportVersion, versionDir } = await runExport({ source, out: outRoot, dryRun: false, catalogPath, breadthPath }, exportOptions);

    // 2. Adapt THIS version's shows.jsonl.
    const adapted = await exec(process.execPath, adapterArgs({ versionDir, breadthPath, catalogPath, cataloguePath, harvestedAt: exportVersion }), { cwd: ROOT });
    if (out(adapted)) log(out(adapted));

    // 3. Publish (dryRun: no gh call, no pointer written).
    const published = await publishCorpus({ versionDir, catalogPath: cataloguePath, pointerPath, repo, exec, sleep, pauseMs, dryRun, now, log });
    const result = { exportVersion, versionDir, tag: published.tag, pointerChanged: published.pointerChanged, prOpened: false, branch: null, dryRun };
    if (dryRun) {
      log("DRY RUN: no git or gh call made; the export and the catalogue were written to a tmp directory and removed");
      return result;
    }
    if (!published.pointerChanged) {
      log(`SKIP: pointer already names ${published.tag}; no branch, no PR`);
      return result;
    }

    // 4. Pointer PR.
    const { branch } = await openPointerPr({ exec, tag: published.tag, pointerRel: pointerRelPath(pointerPath), exportVersion, prCommand: published.prCommand, log });
    return { ...result, prOpened: true, branch };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string", default: "pg" },
      breadth: { type: "string" },
      catalog: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  await runWeekly({
    source: values.source,
    breadthPath: values.breadth ? resolvePath(values.breadth) : DEFAULT_BREADTH,
    catalogPath: values.catalog ? resolvePath(values.catalog) : DEFAULT_CATALOG_PATH,
    outRoot: values.out ? resolvePath(values.out) : EXPORT_OUT_DIR,
    dryRun: values["dry-run"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
