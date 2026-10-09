/* The weekly corpus cron wrapper (weekly.mjs; HUMAN-ACTIONS #139,
   docs/roadmap/corpus.md Q2 and PKG-32's "cron wrapper").

   The harness is deliberately NOT a fake of the export or the adapter: each
   test runs the real runExport on the synthetic fixture and the real
   catalog-adapter.mjs CLI (the fake exec hands every `node` spawn to the
   real execFile), so a wrong flag name or a wrong shows.jsonl path fails
   here the way it would on hermes-vm. Only `gh`, `git` and `sh` are faked:
   each call is recorded, `gh release view` answers absent (404 stderr) or
   published, `git diff --cached --name-only` answers the staged set the
   test chooses, and `gh release upload` reads the files it is handed while
   they still exist. Every path is under a tmp root; data/ and data-local/
   are never read or written, nothing touches the network, no credential is
   read. The floor for this suite lives in test/suite-integrity.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { versionDirName } from "./export.mjs";
import { corpusTagFor } from "./publish-release.mjs";
import { ADAPTER_SCRIPT, commitTrailers, pointerRelPath, runWeekly, TRAILERS_ENV } from "./weekly.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const FAKE_REPO = "example-org/example-repo";
const T1 = "2026-10-12T06:00:00.000Z";
const T2 = "2026-10-19T06:00:00.000Z";
const realExec = promisify(execFile);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corpus-weekly-"));
  const catalogPath = join(root, "catalog.json");
  const breadthPath = join(root, "catalog-breadth.json");
  writeFileSync(catalogPath, '{"shows":[]}\n');
  writeFileSync(breadthPath, '{"version":1,"shows":[]}\n');
  return {
    root,
    catalogPath,
    breadthPath,
    outRoot: join(root, "corpus-export"),
    cataloguePath: join(root, "corpus-export", "catalog-breadth-corpus.json"),
    pointerPath: join(root, "data", "corpus-catalogue-pointer.json"),
  };
}

/** Records every call as {cmd, args}. `node` runs for real; gh/git/sh are faked. */
function fakeExec({ release = null, staged = null, uploads = null } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    if (cmd === process.execPath) {
      calls.push({ cmd: "node", args });
      return realExec(cmd, args, opts);
    }
    calls.push({ cmd, args });
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      if (release === null) {
        const err = new Error("gh failed");
        err.stderr = "release not found";
        throw err;
      }
      return { stdout: JSON.stringify(release), stderr: "" };
    }
    if (cmd === "gh" && args[1] === "upload" && uploads) {
      for (const p of args.slice(3, args.indexOf("--repo"))) uploads[basename(p)] = readFileSync(p);
    }
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: "main\n", stderr: "" };
    if (cmd === "git" && args[0] === "diff") return { stdout: staged ?? "", stderr: "" };
    if (cmd === "sh") return { stdout: "https://github.com/example-org/example-repo/pull/1\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const quiet = () => {};
const opts = (fx, fake, iso, extra = {}) => ({
  source: `jsonl:${FIXTURE}`,
  breadthPath: fx.breadthPath,
  catalogPath: fx.catalogPath,
  outRoot: fx.outRoot,
  cataloguePath: fx.cataloguePath,
  pointerPath: fx.pointerPath,
  repo: FAKE_REPO,
  exec: fake.exec,
  now: () => new Date(iso),
  log: quiet,
  warn: quiet,
  sleep: async () => {},
  pauseMs: 0,
  env: {},
  ...extra,
});
const kinds = (calls) => calls.map((c) => (c.cmd === "node" || c.cmd === "sh" ? c.cmd : `${c.cmd} ${c.args[0] === "release" ? c.args[1] : c.args[0]}`));
const sideEffecting = (calls) => calls.filter((c) => c.cmd === "git" || c.cmd === "sh" || (c.cmd === "gh" && !(c.args[0] === "release" && c.args[1] === "view")));

// Mutation: in runWeekly move the publishCorpus call above the adapter exec
// (publish before adapt) -> publish runs first and fails on the missing
// catalogue, or (with one left over) the order below differs; either way red.
// Mutation: drop the `git switch` back in openPointerPr's finally -> the last
// call is `sh`, not `git switch`, and this goes red.
test("step order: export, adapter, release, then fetch/switch/add/diff/commit/push, the PR, and a switch back", async () => {
  const fx = fixture();
  try {
    const rel = pointerRelPath(fx.pointerPath);
    const fake = fakeExec({ staged: `${rel}\n` });
    const r = await runWeekly(opts(fx, fake, T1));
    assert.deepEqual(kinds(fake.calls), [
      "node",
      "gh view", "gh create", "gh upload", "gh edit",
      "git rev-parse", "git fetch", "git switch", "git add", "git diff", "git commit", "git push",
      "sh",
      "git switch",
    ]);
    assert.equal(r.prOpened, true);
    assert.equal(r.branch, `corpus-pointer/${corpusTagFor(T1)}`);
    assert.deepEqual(fake.calls[6].args, ["fetch", "origin", "main"]);
    assert.deepEqual(fake.calls[7].args, ["switch", "--no-track", "-c", r.branch, "origin/main"]);
    assert.deepEqual(fake.calls[11].args, ["push", "-u", "origin", r.branch]);
    assert.match(fake.calls[12].args[1], new RegExp(`^gh pr create --draft .* --head ${r.branch} `));
    assert.deepEqual(fake.calls[13].args, ["switch", "main"]);
    assert.equal(JSON.parse(readFileSync(fx.pointerPath, "utf8")).release_tag, corpusTagFor(T1));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: delete the adapter exec from runWeekly (publish whatever
// catalogue file is lying there) -> the stale seeded catalogue is uploaded,
// its built_at is "stale", and this goes red. Mutation: build `--shows` from
// join(outRoot, "shows.jsonl") instead of the returned versionDir -> the
// argv check fails (and the CLI dies on the missing file).
test("the adapter reads THIS run's version dir shows.jsonl, and the uploaded catalogue is the one it just wrote", async () => {
  const fx = fixture();
  try {
    await runWeekly(opts(fx, fakeExec({ release: null, staged: `${pointerRelPath(fx.pointerPath)}\n` }), T1));
    // A stale catalogue from an older run sits where the adapter writes.
    writeFileSync(fx.cataloguePath, JSON.stringify({ version: 1, built_at: "stale", shows: [] }) + "\n");
    const uploads = {};
    const fake = fakeExec({ release: null, staged: `${pointerRelPath(fx.pointerPath)}\n`, uploads });
    const r = await runWeekly(opts(fx, fake, T2));
    const adapter = fake.calls.find((c) => c.cmd === "node");
    assert.equal(adapter.args[0], ADAPTER_SCRIPT);
    const shows = adapter.args[adapter.args.indexOf("--shows") + 1];
    assert.equal(shows, join(fx.outRoot, versionDirName(T2), "shows.jsonl"));
    assert.equal(r.versionDir, join(fx.outRoot, versionDirName(T2)));
    assert.equal(adapter.args[adapter.args.indexOf("--harvested-at") + 1], T2);
    const catalogue = JSON.parse(gunzipSync(uploads["catalog-breadth-corpus.json.gz"]).toString("utf8"));
    assert.equal(catalogue.built_at, T2);
    assert.equal(catalogue.source, "foraycorpus");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: drop runWeekly's `if (!published.pointerChanged) return` -> git
// fetch/switch/add/commit/push and the sh PR call appear, and this goes red.
test("a pointer that already names this release: no git call, no PR", async () => {
  const fx = fixture();
  try {
    mkdirSync(dirname(fx.pointerPath), { recursive: true });
    writeFileSync(fx.pointerPath, JSON.stringify({ version: 1, release_tag: corpusTagFor(T1) }) + "\n");
    const fake = fakeExec({ release: { isDraft: false, assets: ["manifest.json", "shows.jsonl.gz", "catalog-breadth-corpus.json.gz"].map((name) => ({ name, state: "uploaded" })) } });
    const r = await runWeekly(opts(fx, fake, T1));
    assert.equal(r.pointerChanged, false);
    assert.equal(r.prOpened, false);
    assert.deepEqual(kinds(fake.calls), ["node", "gh view"]);
    assert.deepEqual(sideEffecting(fake.calls), []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: pass `dryRun: false` to publishCorpus in runWeekly -> gh release
// view/create/upload/edit calls appear and the pointer file is written: red.
// Mutation: drop the `outRoot = join(tmp, ...)` redirect -> fx.outRoot
// (the stand-in for data-local/corpus-export) is created: red.
test("--dry-run: no gh, git or sh call, no pointer, nothing under the out root, and the tmp dir is removed", async () => {
  const fx = fixture();
  try {
    const made = [];
    const spyFs = { mkdtempSync: (p) => { const d = fs.mkdtempSync(p); made.push(d); return d; }, rmSync: fs.rmSync };
    const fake = fakeExec({ release: null });
    const r = await runWeekly(opts(fx, fake, T1, { dryRun: true, fs: spyFs }));
    assert.equal(r.dryRun, true);
    assert.deepEqual(kinds(fake.calls), ["node"]);
    assert.ok(!existsSync(fx.pointerPath), "no pointer written");
    assert.ok(!existsSync(fx.outRoot), "nothing written under the real out root");
    assert.equal(made.length, 1);
    assert.ok(!existsSync(made[0]), "tmp dir removed");
    const adapter = fake.calls[0];
    assert.ok(adapter.args[adapter.args.indexOf("--shows") + 1].startsWith(made[0]), "the adapter read the tmp export");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: change `git add -- <pointer>` to `git add -A` (or drop the
// `-- <pointer>` pathspec from the commit) -> the argv checks go red.
// Mutation: delete the staged-set check -> with a stray file staged a commit,
// a push and the PR happen, and the second half goes red.
// Mutation (CH2-30, T1-23): hardcode a Co-Authored-By / Claude-Session
// trailer in commitMessage again -> with no FORAY_COMMIT_TRAILERS the
// message no longer ends with the body line: red.
test("only the pointer path is ever added or committed; any other staged set is refused before the commit", async () => {
  const fx = fixture();
  try {
    const rel = pointerRelPath(fx.pointerPath);
    const fake = fakeExec({ staged: `${rel}\n` });
    await runWeekly(opts(fx, fake, T1));
    const git = fake.calls.filter((c) => c.cmd === "git");
    assert.deepEqual(git.filter((c) => c.args[0] === "add").map((c) => c.args), [["add", "--", rel]]);
    const commit = git.find((c) => c.args[0] === "commit");
    assert.deepEqual(commit.args.slice(-2), ["--", rel]);
    const message = commit.args[commit.args.indexOf("-m") + 1];
    assert.match(message, new RegExp(`^data\\(corpus\\): point ${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at ${corpusTagFor(T1)}\\n`));
    assert.doesNotMatch(message, /Co-Authored-By|Claude-Session/i, "no env -> no attribution trailer");
    assert.match(message, /\(HUMAN-ACTIONS #139\)\.$/, "no env -> the message ends with the body line");

    const fx2 = fixture();
    try {
      const rel2 = pointerRelPath(fx2.pointerPath);
      const bad = fakeExec({ staged: `${rel2}\nsecrets.env\n` });
      await assert.rejects(runWeekly(opts(fx2, bad, T1)), (e) => e.code === "UNEXPECTED_STAGED_SET");
      const after = kinds(bad.calls);
      assert.ok(!after.includes("git commit") && !after.includes("git push") && !after.includes("sh"), after.join(","));
      assert.deepEqual(bad.calls.at(-1).args, ["switch", "main"], "switched back after the refusal");
    } finally {
      rmSync(fx2.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// Mutation: wrap runWeekly's runExport in try/catch and fall back to the
// version latest.json names (publish last week's export) -> the adapter and
// gh run on the old version and this goes red.
test("a failed export publishes nothing: no adapter, no gh, no git, no pointer", async () => {
  const fx = fixture();
  try {
    await runWeekly(opts(fx, fakeExec({ release: null, staged: `${pointerRelPath(fx.pointerPath)}\n` }), T1));
    rmSync(fx.pointerPath);
    writeFileSync(fx.catalogPath, "{not json");
    const fake = fakeExec({ release: null });
    await assert.rejects(runWeekly(opts(fx, fake, T2)), (e) => e.code === "CATALOG_UNREADABLE");
    assert.deepEqual(fake.calls, []);
    assert.ok(!existsSync(fx.pointerPath));
    assert.ok(!existsSync(join(fx.outRoot, versionDirName(T2))));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// CH2-30 (T1-23): the pointer commit's trailers come from
// FORAY_COMMIT_TRAILERS (newline-separated), never from the source.
// Mutation: drop `trailers: commitTrailers(env)` from runWeekly's
// openPointerPr call -> the env's trailers never reach the commit: red.
// Mutation: drop the blank-line `.filter` in commitTrailers -> the
// whitespace-only and blank-line cases read [""] / ["A: 1", "", "B: 2"]: red.
test("FORAY_COMMIT_TRAILERS: exactly the env's trailers end the commit message; blank means none", async () => {
  assert.deepEqual(commitTrailers({}), []);
  assert.deepEqual(commitTrailers({ [TRAILERS_ENV]: "  \n" }), []);
  assert.deepEqual(commitTrailers({ [TRAILERS_ENV]: " A: 1 \r\n\nB: 2\n" }), ["A: 1", "B: 2"]);

  const fx = fixture();
  try {
    const rel = pointerRelPath(fx.pointerPath);
    const fake = fakeExec({ staged: `${rel}\n` });
    const env = { [TRAILERS_ENV]: "Co-Authored-By: Someone <someone@example.com>\nRun-Id: weekly-1" };
    await runWeekly(opts(fx, fake, T1, { env }));
    const commit = fake.calls.find((c) => c.cmd === "git" && c.args[0] === "commit");
    const message = commit.args[commit.args.indexOf("-m") + 1];
    assert.ok(message.endsWith("(HUMAN-ACTIONS #139).\n\nCo-Authored-By: Someone <someone@example.com>\nRun-Id: weekly-1"), message);
    assert.doesNotMatch(message, /Claude-Session/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
