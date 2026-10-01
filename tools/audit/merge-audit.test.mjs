/**
 * tools/audit/merge-audit.mjs — the weekly merge audit (#129, OPS-07).
 *
 * Inline fixtures throughout; nothing here touches the network or the real
 * suite-integrity file. Each `auditMergedPrs` test names the mutation that
 * turns it red, because the function is three `||` terms and a window
 * comparison and every one of them is a way to under-count unread merges.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  auditMergedPrs,
  floorDrops,
  governedReason,
  parseFloors,
  renderFailure,
  renderReport,
  run,
} from "./merge-audit.mjs";

const SCRIPT = fileURLToPath(new URL("./merge-audit.mjs", import.meta.url));

const SINCE = "2026-09-21T00:00:00Z";
const UNTIL = "2026-09-28T00:00:00Z";

/** A bot PR merged by the bot, unread, inside the window — the baseline. */
function pr(over = {}) {
  return {
    number: 900,
    title: "chore: a bot change",
    html_url: "https://github.com/JW-Incorporated/foray/pull/900",
    user: { login: "github-actions[bot]" },
    merged_by: { login: "github-actions[bot]" },
    merged_at: "2026-09-24T12:00:00Z",
    labels: [],
    files: ["data/shows.json"],
    reviews: [],
    ...over,
  };
}

const window = { since: SINCE, until: UNTIL };

/* ───────────────────────────── auditMergedPrs ───────────────────────────── */

test("auditMergedPrs: a merged PR with an APPROVED review is human-reviewed", () => {
  // MUTATION: drop the `reviews.some(APPROVED)` term -> humanReviewed false here.
  const { rows, zeroReview } = auditMergedPrs(
    [pr({ reviews: [{ state: "COMMENTED", user: { login: "x" } }, { state: "APPROVED", user: { login: "reader" } }] })],
    window
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].humanReviewed, true);
  assert.equal(zeroReview, 0);
  // A review that is not APPROVED is not a read that counts.
  const r2 = auditMergedPrs([pr({ reviews: [{ state: "COMMENTED", user: { login: "x" } }] })], window);
  assert.equal(r2.rows[0].humanReviewed, false);
});

test("auditMergedPrs: the founder-approved label counts as human review, as object or as string", () => {
  // MUTATION: drop the label term -> both false.
  const asObject = auditMergedPrs([pr({ labels: [{ name: "founder-approved" }] })], window);
  assert.equal(asObject.rows[0].humanReviewed, true);
  const asString = auditMergedPrs([pr({ labels: ["founder-approved"] })], window);
  assert.equal(asString.rows[0].humanReviewed, true);
  const other = auditMergedPrs([pr({ labels: [{ name: "hold" }] })], window);
  assert.equal(other.rows[0].humanReviewed, false);
  // The label name is injectable, so a renamed label is one argument away.
  const custom = auditMergedPrs([pr({ labels: ["read-by-a-person"] })], { ...window, approvalLabel: "read-by-a-person" });
  assert.equal(custom.rows[0].humanReviewed, true);
});

test("auditMergedPrs: merged by a founder login (isFounderLogin) counts; merged by the bot does not", () => {
  // MUTATION: drop the `founderFn(mergedBy)` term -> the founder merge reads as unread.
  const founder = auditMergedPrs([pr({ merged_by: { login: "wjduvall-cmd" } })], window);
  assert.equal(founder.rows[0].humanReviewed, true);
  assert.equal(founder.rows[0].mergedBy, "wjduvall-cmd");
  const bot = auditMergedPrs([pr({ merged_by: { login: "github-actions[bot]" } })], window);
  assert.equal(bot.rows[0].humanReviewed, false);
  // And it is the injected function that decides, not a hard-coded list.
  const stub = auditMergedPrs([pr({ merged_by: { login: "anyone" } })], { ...window, founderFn: (l) => l === "anyone" });
  assert.equal(stub.rows[0].humanReviewed, true);
});

test("auditMergedPrs: an unreviewed bot PR is zero-review, and the row carries the ledger fields", () => {
  const { rows, zeroReview, governed } = auditMergedPrs([pr()], window);
  assert.equal(zeroReview, 1);
  assert.equal(governed, 0);
  assert.deepEqual(rows[0], {
    number: 900,
    title: "chore: a bot change",
    url: "https://github.com/JW-Incorporated/foray/pull/900",
    author: "github-actions[bot]",
    mergedBy: "github-actions[bot]",
    mergedAt: "2026-09-24T12:00:00Z",
    files: 1,
    humanReviewed: false,
    governed: [],
  });
  // Missing optional fields degrade to empty, never throw.
  const bare = auditMergedPrs([{ number: 1, merged_at: "2026-09-22T00:00:00Z", url: "u" }], window);
  assert.deepEqual(bare.rows[0], {
    number: 1, title: "", url: "u", author: "", mergedBy: "", mergedAt: "2026-09-22T00:00:00Z",
    files: 0, humanReviewed: false, governed: [],
  });
});

test("auditMergedPrs: a PR touching .github/ is governed, one touching data/ is not", () => {
  // Uses the REAL default (pathPolicy's deny list), not a stub: this is the
  // test that notices the plan's `pathProblem` would have said "not governed"
  // for .github/ (it only rejects malformed paths).
  const { rows, governed } = auditMergedPrs(
    [
      pr({ number: 1, files: [".github/workflows/ci.yml", "docs/notes.md"] }),
      pr({ number: 2, files: ["data/shows.json", "docs/notes.md"] }),
    ],
    window
  );
  assert.deepEqual(rows[0].governed, [".github/workflows/ci.yml"]);
  assert.deepEqual(rows[1].governed, []);
  assert.equal(governed, 1);
  // The three non-null reasons, and the one null.
  assert.equal(governedReason(".github/workflows/ci.yml"), "denied: .github/");
  assert.match(governedReason("docs/../.github/x.yml"), /^malformed: /);
  assert.equal(governedReason("Makefile"), "outside the allow-list");
  assert.equal(governedReason("data/shows.json"), null);
  // Injectable: a stub decides, and only a non-null answer governs.
  const stub = auditMergedPrs([pr({ files: ["a", "b"] })], { ...window, pathProblemFn: (f) => (f === "b" ? "why" : null) });
  assert.deepEqual(stub.rows[0].governed, ["b"]);
});

test("auditMergedPrs: PRs outside the window or never merged are ignored; rows sort by number", () => {
  // MUTATION: `t < until` -> `t <= until` admits the one merged exactly at `until`;
  // `t >= since` -> `t > since` drops the one merged exactly at `since`.
  const { rows } = auditMergedPrs(
    [
      pr({ number: 5, merged_at: "2026-09-27T23:59:59Z" }),
      pr({ number: 4, merged_at: UNTIL }), // exactly `until`: next week's
      pr({ number: 3, merged_at: SINCE }), // exactly `since`: this week's
      pr({ number: 2, merged_at: "2026-09-20T23:59:59Z" }),
      pr({ number: 1, merged_at: null }), // closed, never merged
      pr({ number: 0, merged_at: "not a date" }),
    ],
    window
  );
  assert.deepEqual(rows.map((r) => r.number), [3, 5]);
  assert.deepEqual(auditMergedPrs([], window).rows, []);
  assert.throws(() => auditMergedPrs([pr()], {}), /since.*until/);
});

/* ─────────────────────────────────── floors ─────────────────────────────── */

const FLOORS_FILE = (entries) => `// header
const DECOY = {
  "x": 3,
};
const FLOORS = {
  /* a comment with "not/a/floor": 99 in it, no trailing comma */
${entries}
};
const BACKEND_FLOORS = {
  "backend/test/other.test.js": 7,
};
`;

test('parseFloors: reads only the FLOORS block and every "path": N line in it', () => {
  // MUTATION: parse the whole file -> "x" and "backend/test/other.test.js" appear.
  const floors = parseFloors(
    FLOORS_FILE(`  "tools/a.test.mjs": 12,
  "tools/b.test.mjs": 3, // audit round 3: 2 -> 3
  "test/c.test.js": 40,`)
  );
  assert.deepEqual(
    [...floors.entries()],
    [["tools/a.test.mjs", 12], ["tools/b.test.mjs", 3], ["test/c.test.js", 40]]
  );
  assert.equal(floors.has("x"), false);
  assert.equal(floors.has("backend/test/other.test.js"), false);
  assert.equal(floors.has("not/a/floor"), false);
});

test("parseFloors: throws when either block marker is missing", () => {
  assert.throws(() => parseFloors("const OTHER = {\n  \"a\": 1,\n};\n"), /no `const FLOORS = \{` marker/);
  assert.throws(() => parseFloors("const FLOORS = {\n  \"a\": 1,\n"), /no closing/);
  assert.throws(() => parseFloors(undefined), /expected the file's text/);
});

test("floorDrops: reports a lowered floor and a removed suite, never a raised one or a new one", () => {
  const before = FLOORS_FILE(`  "tools/raised.test.mjs": 5,
  "tools/lowered.test.mjs": 10,
  "tools/removed.test.mjs": 4,
  "tools/same.test.mjs": 8,`);
  const after = FLOORS_FILE(`  "tools/raised.test.mjs": 9,
  "tools/lowered.test.mjs": 7, // "fixed" the floor
  "tools/same.test.mjs": 8,
  "tools/new.test.mjs": 2,`);
  assert.deepEqual(floorDrops(before, after), [
    { suite: "tools/lowered.test.mjs", before: 10, after: 7 },
    { suite: "tools/removed.test.mjs", before: 4, after: null },
  ]);
  assert.deepEqual(floorDrops(before, before), []);
});

/* ────────────────────────────────── rendering ───────────────────────────── */

test('renderReport: the headline counts, the table, the floors, the freeze line and the trailing "audit ok"', () => {
  const audit = auditMergedPrs(
    [
      pr({ number: 1, title: "a | pipe", files: [".github/workflows/ci.yml", "data/x.json"] }),
      pr({ number: 2, reviews: [{ state: "APPROVED", user: { login: "r" } }], html_url: "https://x/2" }),
    ],
    window
  );
  const body = renderReport({
    since: SINCE, until: UNTIL, audit,
    drops: [{ suite: "tools/a.test.mjs", before: 10, after: 7 }, { suite: "tools/b.test.mjs", before: 4, after: null }],
    freeze: "true",
  });
  const lines = body.trimEnd().split("\n");
  assert.equal(lines[0], "## Weekly merge audit — 2026-09-21 → 2026-09-28");
  assert.equal(lines[2], "**2 PRs merged, 1 with zero human review, 1 touching a governed path.**");
  assert.equal(lines[4], "| PR | title | author | merged by | files | human review | governed paths |");
  assert.equal(
    lines[6],
    "| [#1](https://github.com/JW-Incorporated/foray/pull/900) | a \\| pipe | github-actions[bot] | github-actions[bot] | 2 | **none** | .github/workflows/ci.yml |"
  );
  assert.equal(lines[7], "| [#2](https://x/2) | chore: a bot change | github-actions[bot] | github-actions[bot] | 1 | yes | — |");
  assert.ok(body.includes("\n### Floors\n- `tools/a.test.mjs`: 10 → 7\n- `tools/b.test.mjs`: 4 → removed\n"));
  assert.ok(body.includes('\n### Kill switch\nAUTOMERGE_FREEZE is set ("true") — auto-merge is halted\n'));
  assert.equal(lines.at(-1), "_audit ok_");
  assert.ok(body.endsWith("\n"));

  // The quiet week: no PRs, no drops, no freeze.
  const quiet = renderReport({ since: SINCE, until: UNTIL, audit: auditMergedPrs([], window), drops: [], freeze: "" });
  assert.ok(quiet.includes("**0 PRs merged, 0 with zero human review, 0 touching a governed path.**"));
  assert.ok(quiet.includes("| — | no PRs merged in this window |"));
  assert.ok(quiet.includes("\n### Floors\n- none lowered or removed\n"));
  assert.ok(quiet.includes("\n### Kill switch\nAUTOMERGE_FREEZE is not set\n"));
  assert.ok(quiet.trimEnd().endsWith("_audit ok_"));
  // "off" and "0" are not a freeze (isFreezeActive's rule), undefined neither.
  for (const v of ["off", "0", "false", undefined]) {
    assert.ok(renderReport({ since: SINCE, until: UNTIL, audit: auditMergedPrs([], window), drops: [], freeze: v }).includes("AUTOMERGE_FREEZE is not set"), String(v));
  }
});

test("renderFailure: says FAILED, names the step, keeps the first line of the message, and never says audit ok", () => {
  const body = renderFailure(new Error("ENOENT: no such file\nsecond line"), { step: "read prs" });
  assert.equal(body.split("\n")[0], "## Weekly merge audit — FAILED");
  assert.ok(body.includes("The audit did not run to completion at step `read prs`: ENOENT: no such file\n"));
  assert.ok(!body.includes("second line"));
  assert.ok(body.includes("A false all-clear is worse than no audit; treat this week as unaudited."));
  assert.ok(!body.includes("audit ok"));
  // Non-Error throwables and a missing step still render.
  assert.ok(renderFailure("boom", {}).includes("at step `unknown`: boom"));
});

/* ───────────────────────────── the workflow's shape ─────────────────────── */

test("merge-audit.yml comments on issue 129 on success and on failure", () => {
  /* #129's hard requirement is that a week is never SILENT: the ledger is one
     comment on #129, and a run that died before it could render one still
     leaves a comment that says FAILED. Two `gh issue comment 129` calls, one of
     them under `if: failure()`. MUTATION: drop the failure step, or point either
     comment at another issue -> red here. */
  const yml = fs.readFileSync(fileURLToPath(new URL("../../.github/workflows/merge-audit.yml", import.meta.url)), "utf8");
  const comments = yml.match(/gh issue comment 129\b/g) ?? [];
  assert.equal(comments.length, 2, "one comment on success, one on failure — both on #129");
  assert.ok(yml.includes("if: failure()"), "the failure comment runs under `if: failure()`");
  // And the one the issue reads is the body the script wrote.
  assert.ok(yml.includes("--body-file body.md"));
  assert.ok(yml.includes("Treat this week as unaudited."));
});

/* ───────────────────────────────────── CLI ──────────────────────────────── */

function tmpWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-audit-test-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const BEFORE = FLOORS_FILE(`  "tools/a.test.mjs": 10,\n  "tools/b.test.mjs": 4,`);
const AFTER = FLOORS_FILE(`  "tools/a.test.mjs": 7,`);

test("CLI: writes body.md, prints the headline, exits 0; --json adds the machine-readable audit", () => {
  const dir = tmpWith({
    "prs.json": JSON.stringify([pr(), pr({ number: 901, reviews: [{ state: "APPROVED", user: { login: "r" } }] })]),
    "before.js": BEFORE,
    "after.js": AFTER,
  });
  try {
    const args = [SCRIPT, "--prs", "prs.json", "--floors-before", "before.js", "--floors-after", "after.js",
      "--since", SINCE, "--until", UNTIL, "--freeze", "", "--out", "body.md", "--json"];
    const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const [head, json] = r.stdout.trimEnd().split("\n");
    assert.equal(head, "**2 PRs merged, 1 with zero human review, 0 touching a governed path.**");
    const parsed = JSON.parse(json);
    assert.equal(parsed.zeroReview, 1);
    assert.equal(parsed.governed, 0);
    assert.deepEqual(parsed.rows.map((x) => x.number), [900, 901]);
    assert.deepEqual(parsed.drops, [
      { suite: "tools/a.test.mjs", before: 10, after: 7 },
      { suite: "tools/b.test.mjs", before: 4, after: null },
    ]);
    const body = fs.readFileSync(path.join(dir, "body.md"), "utf8");
    assert.ok(body.startsWith("## Weekly merge audit — 2026-09-21 → 2026-09-28\n"));
    assert.ok(body.includes("- `tools/b.test.mjs`: 4 → removed"));
    assert.ok(body.trimEnd().endsWith("_audit ok_"));
    // Without --json: the headline only.
    const plain = spawnSync(process.execPath, args.slice(0, -1), { cwd: dir, encoding: "utf8" });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, head + "\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a missing input writes a FAILED body naming the step and exits 1", () => {
  const dir = tmpWith({ "before.js": BEFORE, "after.js": AFTER });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--prs", "missing.json", "--floors-before", "before.js",
      "--floors-after", "after.js", "--since", SINCE, "--until", UNTIL, "--out", "body.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /::error::merge audit FAILED at step read prs: /);
    const body = fs.readFileSync(path.join(dir, "body.md"), "utf8");
    assert.equal(body.split("\n")[0], "## Weekly merge audit — FAILED");
    assert.ok(body.includes("at step `read prs`: "));
    assert.ok(!body.includes("audit ok"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run(): each phase names its step on failure, and a bad --out still exits 1 with the failure on stderr", () => {
  const files = { "prs.json": "[]", "before.js": BEFORE, "after.js": AFTER, "noblock.js": "nothing here" };
  const io = {
    readFile: (p) => {
      if (!(p in files)) { const e = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
      return files[p];
    },
    writeFile: (p, s) => { files[p] = s; },
  };
  const base = ["--since", SINCE, "--until", UNTIL, "--out", "body.md"];
  const step = (argv) => { const r = run(argv, io); return [r.code, /at step ([a-z ]+):/.exec(r.err)?.[1]]; };
  assert.deepEqual(step(["--prs", "prs.json", "--floors-before", "before.js", "--floors-after", "after.js", "--until", UNTIL]), [1, "arguments"]);
  assert.deepEqual(step(["--prs", "prs.json", "--floors-before", "before.js", "--floors-after", "after.js", "--since", "yesterday", "--until", UNTIL]), [1, "arguments"]);
  assert.deepEqual(step(["--prs", "nope.json", "--floors-before", "before.js", "--floors-after", "after.js", ...base]), [1, "read prs"]);
  assert.deepEqual(step(["--prs", "prs.json", "--floors-before", "nope.js", "--floors-after", "after.js", ...base]), [1, "read floors"]);
  assert.deepEqual(step(["--prs", "prs.json", "--floors-before", "noblock.js", "--floors-after", "after.js", ...base]), [1, "parse floors"]);
  assert.ok(files["body.md"].startsWith("## Weekly merge audit — FAILED"));
  assert.deepEqual(step(["--prs", "prs.json", "--floors-before", "before.js", "--floors-after", "after.js", ...base]), [0, undefined]);
  assert.ok(files["body.md"].trimEnd().endsWith("_audit ok_"));
  // --out unwritable: still exit 1, and stderr says the body could not be written.
  const broken = run(["--prs", "nope.json", "--floors-before", "before.js", "--floors-after", "after.js", ...base], {
    ...io, writeFile: () => { throw new Error("EACCES"); },
  });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /could not write the FAILED body to body\.md: EACCES/);
  // No --out at all: nothing written, still a clear exit code either way.
  const noOut = run(["--prs", "prs.json", "--floors-before", "before.js", "--floors-after", "after.js", "--since", SINCE, "--until", UNTIL], io);
  assert.equal(noOut.code, 0);
  assert.equal(noOut.out, "**0 PRs merged, 0 with zero human review, 0 touching a governed path.**\n");
});
