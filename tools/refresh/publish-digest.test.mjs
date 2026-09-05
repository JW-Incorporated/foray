/* S-01 acceptance test: "publish step passes with a synthetic 2 MB
 * resolved.json." Argument list too long since 09-01 came from
 * `-f content="$(base64 -w0 "$path")"` in nightly-refresh.yml's publish step —
 * the WHOLE base64'd file landed on the process's argv, which blows past the
 * kernel's ARG_MAX once the digest is real-sized. The fix moves the payload
 * into a request-body FILE via `gh api --input`, so nothing about the file's
 * size ever touches an argument vector.
 *
 * This test does not re-implement the fix — re-implementing it in JS and
 * testing THAT would prove nothing about the YAML. It extracts the actual
 * `run:` block for the "Publish digest to refresh-digest branch" step out of
 * the real workflow file, executes it as bash with `gh`/`jq` shimmed out, and
 * asserts a 2 MB `resolved.json` round-trips through it. If someone reverts
 * the step to inline `-f content=`, this test still passes the extraction but
 * the mock `gh` fails it (see MOCK_GH_REQUIRES_INPUT below) — the two things
 * this suite has to prove are "the step runs" and "the step never puts the
 * payload on argv", and only running the REAL step text proves either one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "nightly-refresh.yml");

/** Pull the `run:` block for a named step out of the workflow's YAML, without
 *  a YAML parser dependency this repo does not otherwise have. The step names
 *  are unique strings in the file, and `run: |` bodies are fixed-indent block
 *  scalars, so a small state machine is exact here without pulling in `yaml`. */
function extractStepRun(workflowText, stepName) {
  const lines = workflowText.split("\n");
  const nameIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(nameIdx >= 0, `step "${stepName}" not found in ${WORKFLOW}`);
  let runIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) break; // next step, no `run:` found
    if (/^\s*run:\s*\|/.test(lines[i])) { runIdx = i; break; }
  }
  assert.ok(runIdx >= 0, `no "run: |" block under step "${stepName}"`);
  const runIndent = lines[runIdx].match(/^\s*/)[0].length;
  const bodyIndent = runIndent + 2; // conventional two-space step body indent
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { body.push(""); continue; }
    const indent = line.match(/^\s*/)[0].length;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join("\n");
}

function writeMock(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode: 0o755 });
  return p;
}

test("the real 'Publish digest' step passes a synthetic 2MB resolved.json without hitting argv limits", () => {
  const workflowText = fs.readFileSync(WORKFLOW, "utf8");
  let script = extractStepRun(workflowText, "Publish digest to refresh-digest branch");

  // `${{ github.sha }}` is a GitHub Actions expression, substituted by the
  // runner BEFORE bash ever sees the script — it is not valid bash and never
  // executes as one in production. Stand in a fixed value here, the same way
  // Actions would, so this test exercises the step's actual logic rather than
  // failing on a syntax error that can never happen in CI.
  script = script.replace(/\$\{\{\s*github\.sha\s*\}\}/g, "0000000000000000000000000000000000000000");

  // The step must use a request-body FILE, never inline -f content= on a real
  // command line. (The step's own header COMMENT mentions the old
  // `-f content=` invocation for context, so the check strips comment lines
  // before asserting — matching the string anywhere would flag its own
  // explanation of the bug it fixed.)
  assert.match(script, /--input/, "step no longer uses gh api --input — regression to the argv-based payload");
  const codeOnly = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(codeOnly, /-f content=/, "step reintroduced -f content=... on argv");

  // NOTE: `os.tmpdir()` (/tmp) is mounted noexec in some sandboxes, which would
  // make the shimmed `gh`/`jq` unexecutable for a reason that has nothing to do
  // with the fix under test. Use a directory under this repo instead — CI
  // runners don't have this restriction, but a local sandbox might.
  const scratchRoot = path.join(REPO, ".scratch-publish-digest-test");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const workdir = fs.mkdtempSync(path.join(scratchRoot, "work-"));
  const mockBin = fs.mkdtempSync(path.join(scratchRoot, "bin-"));

  // A synthetic resolved.json comfortably over the ARG_MAX (~2MB on Linux)
  // that made `-f content="$(base64 -w0 resolved.json)"` fail since 09-01.
  const resolved = { generated_at: new Date().toISOString(), resolved: [] };
  let i = 0;
  while (Buffer.byteLength(JSON.stringify(resolved)) < 2 * 1024 * 1024) {
    resolved.resolved.push({
      id: `show-${i}--title-${i}`,
      apple_track_id: 1000000000 + i,
      show: `Show ${i}`,
      title: `Title number ${i} padded to grow the payload realistically`,
      release_date: "2026-09-04",
      _description: "x".repeat(200),
    });
    i++;
  }
  fs.writeFileSync(path.join(workdir, "resolved.json"), JSON.stringify(resolved));
  fs.writeFileSync(path.join(workdir, "refresh-state.json"), JSON.stringify({ seen: {} }));

  // Mock `gh`: GETs report "not found" (first publish), PUTs must arrive with
  // --input pointing at a real file whose `content` decodes back to the
  // original bytes. No network, no token — this is a shell-contract test.
  writeMock(
    mockBin,
    "gh",
    `#!/bin/bash
set -euo pipefail
if [ "$1" = "api" ]; then
  shift
  method="GET"; endpoint=""; input_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -X) method="$2"; shift 2 ;;
      --input) input_file="$2"; shift 2 ;;
      --jq) shift 2 ;;
      -f) shift 2 ;;
      *) endpoint="$1"; shift ;;
    esac
  done
  if [[ "$endpoint" == *"/contents/"* && "$method" == "GET" ]]; then
    echo "not found" >&2
    exit 1
  fi
  if [ "$method" = "PUT" ]; then
    if [ -z "$input_file" ]; then
      echo "MOCK_GH_REQUIRES_INPUT: no --input given, regression to inline content" >&2
      exit 1
    fi
    node "${path.join(mockBin, "verify-payload.js")}" "$endpoint" "$input_file" "${workdir}"
    exit $?
  fi
  exit 0
fi
echo "mock gh: unsupported invocation: $*" >&2
exit 1
`
  );

  writeMock(
    mockBin,
    "verify-payload.js",
    `const fs = require("fs");
const [, , endpoint, inputFile, workdir] = process.argv;
const body = JSON.parse(fs.readFileSync(inputFile, "utf8"));
if (typeof body.content !== "string" || body.content.length < 4) {
  console.error("payload content missing or implausibly small");
  process.exit(1);
}
const decoded = Buffer.from(body.content, "base64");
const sourcePath = endpoint.includes("resolved.json")
  ? require("path").join(workdir, "resolved.json")
  : require("path").join(workdir, "refresh-state.json");
const original = fs.readFileSync(sourcePath);
if (!decoded.equals(original)) {
  console.error("decoded payload does not match the source file bytes");
  process.exit(1);
}
console.error("OK:", endpoint, decoded.length, "bytes round-tripped");
`
  );

  // A minimal jq shim covering exactly the invocation shape the step uses:
  // \`jq -n --arg k v ... --rawfile k file '<object literal>'\`. Real CI runners
  // ship jq; this only fills the gap in sandboxes that do not have it.
  writeMock(
    mockBin,
    "jq",
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const vars = {};
let i = 0, filter = null, nullInput = false;
while (i < args.length) {
  const a = args[i];
  if (a === "-n") { nullInput = true; i++; continue; }
  if (a === "--arg") { vars[args[i+1]] = args[i+2]; i += 3; continue; }
  if (a === "--rawfile") { vars[args[i+1]] = fs.readFileSync(args[i+2], "utf8"); i += 3; continue; }
  filter = a; i++;
}
if (!nullInput) throw new Error("jq shim only supports -n");
const obj = {};
const re = /(\\w+):\\s*\\$(\\w+)/g;
let m;
while ((m = re.exec(filter))) obj[m[1]] = vars[m[2]];
process.stdout.write(JSON.stringify(obj));
`
  );

  const env = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH}`,
    REPO: "jw-labs/foray",
    DIGEST_BRANCH: "refresh-digest",
    GITHUB_STEP_SUMMARY: path.join(workdir, "summary.md"),
  };

  const scriptPath = path.join(workdir, "publish-step.sh");
  fs.writeFileSync(scriptPath, script);

  let stdout;
  try {
    stdout = execFileSync("bash", [scriptPath], { cwd: workdir, env, encoding: "utf8" });
    assert.match(stdout, /published digest: \d+ resolved episodes/);
    assert.ok(fs.existsSync(path.join(workdir, "summary.md")), "job summary was not written");
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});
