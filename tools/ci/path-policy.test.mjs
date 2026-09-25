/* Tests for the merge path policy.
 *
 * The policy used to be two heredocs and a `case`-glob loop inside
 * .github/workflows/automerge-nightly.yml, which no test could reach. Every
 * assertion below is a thing that was previously verified by reading YAML.
 *
 * The ones that pin measured incidents are marked with the PR number, so a
 * future reader can tell "this is the rule" from "this is why the rule".
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

import {
  ALLOWED_PREFIXES,
  APPROVAL_LABEL,
  AUTOMERGE_AUTHORS,
  BLOCKING_LABELS,
  DENIED_PATTERNS,
  DENIED_PREFIXES,
  automergeDecision as rawAutomergeDecision,
  formatDecision,
  formatGovernedCheck,
  formatPolicy,
  governedCheck,
  isFreezeActive,
  matchesPrefix,
  parseArgs,
  pathPolicy,
  pathProblem,
  runCli as rawRunCli,
  isTrustedAuthor,
  disarmDecision,
  isFounderLogin,
  splitList,
} from "./path-policy.mjs";

/* security-1 made `author` a required input: an unknown author is refused.
 * Most tests below are about PATHS, so they decide as one of our own agents;
 * the tests about authors call rawAutomergeDecision / rawRunCli directly. */
const OURS = "github-actions[bot]";
const automergeDecision = (input = {}) => rawAutomergeDecision({ author: OURS, ...input });
const runCli = (argv, io) =>
  rawRunCli(argv[0] === "decide" && !argv.includes("--author") ? [...argv, "--author", OURS] : argv, io);

/* ------------------------------------------------------------ the matcher */

test("a trailing slash matches anything under the directory", () => {
  assert.equal(matchesPrefix("backend/test/foo.test.ts", "backend/test/"), true);
  assert.equal(matchesPrefix("backend/test/deep/nested/x.ts", "backend/test/"), true);
});

test("a trailing slash does NOT match a sibling with the same leading letters", () => {
  // The reason precision matters here: `backend/test/` is newly allowlisted and
  // `backend/src/` is denied, so a path that sneaks past the boundary would be
  // production code landing unread.
  assert.equal(matchesPrefix("backend/testing-src/evil.ts", "backend/test/"), false);
  assert.equal(matchesPrefix("backend/tests/evil.ts", "backend/test/"), false);
  assert.equal(matchesPrefix("backend/test-utils.ts", "backend/test/"), false);
});

test("a trailing slash does not match the bare directory name", () => {
  assert.equal(matchesPrefix("backend/test", "backend/test/"), false);
});

test("a file entry matches only itself", () => {
  assert.equal(matchesPrefix("app.js", "app.js"), true);
  assert.equal(matchesPrefix("app.json", "app.js"), false);
  assert.equal(matchesPrefix("app.js.bak", "app.js"), false);
  assert.equal(matchesPrefix("app.jsx", "app.js"), false);
  assert.equal(matchesPrefix("STATE.mdx", "STATE.md"), false);
});

test("a file entry does not match a same-named file in a subdirectory", () => {
  assert.equal(matchesPrefix("docs/app.js", "app.js"), false);
});

test("an empty prefix matches nothing", () => {
  assert.equal(matchesPrefix("app.js", ""), false);
});

test("a non-string file or prefix matches nothing rather than throwing", () => {
  assert.equal(matchesPrefix(undefined, "app.js"), false);
  assert.equal(matchesPrefix("app.js", undefined), false);
});

/* --------------------------------------------------------- path hygiene */

test("a well-formed repo-relative path has no problem", () => {
  assert.equal(pathProblem("data/session.json"), null);
  assert.equal(pathProblem("app.js"), null);
});

test("traversal, absolute and backslash paths are rejected", () => {
  // `docs/../.github/workflows/ci.yml` is a .github write that starts with docs/.
  assert.match(pathProblem("docs/../.github/workflows/ci.yml"), /relative/);
  assert.match(pathProblem("/etc/passwd"), /absolute/);
  assert.match(pathProblem("docs\\roles.md"), /backslash/);
});

test("empty, blank-padded, double-slashed and NUL paths are rejected", () => {
  assert.match(pathProblem(""), /empty path/);
  assert.match(pathProblem(" app.js"), /whitespace/);
  assert.match(pathProblem("docs//x.md"), /empty path segment/);
  assert.match(pathProblem("app\0.js"), /NUL/);
  assert.match(pathProblem("./app.js"), /relative/);
});

test("a non-string path is rejected, not coerced", () => {
  assert.match(pathProblem(42), /not a string/);
  assert.match(pathProblem(null), /not a string/);
});

/* ----------------------------------------------------------- the lists */

test("every prefix in both lists is a directory prefix or an exact file", () => {
  for (const p of [...DENIED_PREFIXES, ...ALLOWED_PREFIXES]) {
    assert.equal(pathProblem(p.endsWith("/") ? p + "x" : p), null, `bad prefix: ${p}`);
  }
});

test("backend/test/ is allowlisted and backend/src/ is denied", () => {
  // PR #175 (2026-08-16) was blocked from auto-merge by exactly one file,
  // backend/test/dataSchemaCompliance.test.ts, because backend/ was in neither
  // list. Its production counterpart must be on the other side of the line.
  assert.ok(ALLOWED_PREFIXES.includes("backend/test/"));
  assert.ok(DENIED_PREFIXES.includes("backend/src/"));
});

test("mobile/ auto-merges, but the signing scripts under tools/mobile/ still don't", () => {
  /* Founder ruling 2026-09-05: mobile/ (the native shell's app code) is on the
     allowlist so a mobile-only PR auto-merges when green, like other app areas.

     The load-bearing subtlety this pins: "mobile/" as a prefix must NOT reach the
     signing/asset scripts under tools/mobile/, which stay DENIED. They are a
     different path root ("tools/mobile/..." starts with "tools/", never "mobile/"),
     and DENIED is checked first regardless.

     MUTATION: remove "mobile/" from ALLOWED_PREFIXES -> the first assert fails.
     MUTATION: move "tools/mobile/wire-signing.mjs" out of DENIED -> the last fails. */
  assert.ok(ALLOWED_PREFIXES.includes("mobile/"));
  const shell = pathPolicy(["mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"]);
  assert.equal(shell.denied.length, 0, "a mobile app-code file must not be denied");
  assert.equal(shell.unlisted.length, 0, "a mobile app-code file must be allowlisted, not unlisted");

  const signing = pathPolicy(["tools/mobile/wire-signing.mjs"]);
  assert.equal(signing.denied.length, 1, "the signing script stays governed");
  assert.ok(DENIED_PREFIXES.includes("tools/mobile/wire-signing.mjs"));
});

test("tools/release/ is denied: the release watchdog, the trigger and the upload retry all run with live power", () => {
  // 2026-09-22. watch-release.mjs decides from an `actions: write` job when a
  // release is dispatched and whether the release alarm is raised; upload-retry
  // runs beside the App Store Connect key. MUTATION: drop the entry and a bot PR
  // that neuters either lands unread under the `tools/` allowance.
  assert.ok(DENIED_PREFIXES.includes("tools/release/"));
  for (const f of ["tools/release/watch-release.mjs", "tools/release/upload-retry.mjs"]) {
    const p = pathPolicy([f]);
    assert.equal(p.denied.length, 1, `${f} must be denied`);
    assert.equal(p.allowed.length, 0, `${f} must not also read as allowed`);
  }
});

test("tools/ci/ is denied even though tools/ is allowed", () => {
  // This directory is the gate: without the deny entry, the first PR editing
  // the policy would auto-merge under the policy it was rewriting.
  assert.ok(ALLOWED_PREFIXES.includes("tools/"));
  assert.ok(DENIED_PREFIXES.includes("tools/ci/"));
  const p = pathPolicy(["tools/ci/path-policy.mjs"]);
  assert.equal(p.denied.length, 1);
  assert.equal(p.denied[0].prefix, "tools/ci/");
});

test("the governance paths from the original workflow are all still denied", () => {
  for (const f of [
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    "CLAUDE.md",
    "docs/DECISIONS.md",
    "docs/adr/0007-segment-anchoring.md",
    "docs/roles.md",
    "docs/agents/routine-invariants.md",
  ]) {
    assert.equal(pathPolicy([f]).denied.length, 1, `${f} should be denied`);
  }
});

/* Scripts `ci.yml` invokes directly ARE gates: a one-line `process.exit(0)` in
 * any of them neuters a check with no human in the loop, which is exactly what
 * the `tools/ci/` deny entry exists to prevent — one directory over. This test
 * makes the exposure impossible to acquire silently: a NEW gate script must
 * either be denied or be added to the acknowledgement list below, in a diff
 * someone reads.
 *
 * The acknowledged ones are a deliberate, stated trade, not an oversight. */
const ACKNOWLEDGED_UNDENIED_GATES = {
  // Actively developed by the segments workstream (epic #115), and its own
  // suite carries a floor of 39. Denying it would put a founder merge on every
  // segment-pipeline PR — the friction pointing the wrong way that #167 was
  // about. Revisit if that workstream finishes.
  "tools/segments/merge-segments.mjs": "active workstream; own suite floored at 39",
  // Issue #701: ci.yml builds dist/ with prepare-dist.mjs so a PR that would
  // break the Vercel build is red before merge. The script was ALREADY the
  // production build (vercel.json's buildCommand) on an allowed path; running it
  // in CI adds a check, not an exposure. What would make a neutered copy
  // dangerous — a torn deploy stamp — is re-derived independently by the very
  // next command in the same step, `tools/ci/generate-manifest.mjs --verify
  // dist`, which is on a DENIED path.
  "tools/web/prepare-dist.mjs": "already the Vercel build; the stamp it writes is re-verified by denied tools/ci/generate-manifest.mjs --verify",
  // Diagnostic probes over a live Chrome DevTools socket / device screen —
  // they read app behaviour after the build already happened and can only
  // turn a check red, not change what gets built or signed.
  "tools/mobile/webview-probe.mjs": "post-build diagnostic probe; cannot alter build/signing output",
  "tools/mobile/probe/install-probe.mjs": "post-build diagnostic probe; cannot alter build/signing output",
  // nightly-refresh.yml / nightly-watch.yml run with `contents: write` (they
  // commit refreshed data), not a founder-merge decision — an accepted T3
  // trade per the file's own tiering above, bounded by main's branch
  // protection.
  "tools/refresh/watch-nightly.mjs": "nightly data-refresh pipeline; contents:write, no auto-merge decision at stake",
  "tools/refresh/scan.mjs": "nightly data-refresh pipeline; contents:write, no auto-merge decision at stake",
  "tools/refresh/resolve.mjs": "nightly data-refresh pipeline; contents:write, no auto-merge decision at stake",
  // Re-invokes THIS policy (decide/check) from automerge-nightly.yml and
  // path-policy.yml — it cannot expose itself, it IS the gate under test.
  "tools/ci/path-policy.mjs": "the policy script itself; already covered by tools/ci/ in DENIED_PREFIXES",
  // Drives the PR-hygiene labelling sweep (needs-founder queue etc.) — it
  // reads/labels PRs, it does not gate what auto-merges or what CI asserts.
  "tools/ci/pr-triage.mjs": "PR labelling/triage only; does not gate auto-merge or CI checks",
  // release.yml calls `marketing-version` (tag-name-vs-tracked-version check)
  // and `pair` (the MARKETING_VERSION/BUILD_NUMBER both stores ship). Unlike
  // release-ci.mjs (denied above), a neutered version.mjs cannot bypass the
  // main-only guard or reach a live secret it didn't already have: the worst
  // outcome is a mislabeled version string or a colliding build number, which
  // either fails the App Store Connect / Play upload outright (a red run, not
  // a silent bad deploy) or ships a release under the wrong human-readable
  // version — a governance/labelling defect, not an auth or secrets bypass.
  // `mobile/` (where mobile/VERSION lives) already requires a founder merge
  // per CLAUDE.md's "A NOTE ON THE TWO WORDS", so the number this script reads
  // is itself human-reviewed; this script only formats/validates it. Same
  // risk class as the tools/refresh/* nightly entries above: real but bounded
  // to a bad build, not an unread security-relevant change. Found while fixing
  // PR #501's gate scan (kanban t_5458c0a2).
  "tools/mobile/version.mjs": "no auth/secret bypass; worst case is a mislabeled version or a failed (red) upload, not a silent bad deploy",
  // ios-ci.mjs, inject-background-audio.mjs and ios-embedded-frameworks.mjs
  // were acknowledged here as "no secret" until the round-3 review showed all
  // three run inside the release composite that holds the p12 and the App Store
  // Connect key (ios-ci.mjs `signing-gate` with the secrets in its own env).
  // They are DENIED now; see "everything a signing job executes" below.
};

/* Every `.github/workflows/*.yml` file, not just ci.yml — a gate script run
 * from ANY workflow can be neutered the same way; scoping the scan to ci.yml
 * alone only checked one of the repo's workflow files (kanban t_97e1c5f4). */
function workflowAndActionFiles() {
  const wf = path.join(REPO, ".github/workflows");
  const files = fs.readdirSync(wf).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).map((f) => `.github/workflows/${f}`);
  // Composite actions (round-3 review): the release composites run gate
  // scripts too, and a scan of workflows alone never saw them.
  const actions = path.join(REPO, ".github/actions");
  if (fs.existsSync(actions)) {
    for (const d of fs.readdirSync(actions, { withFileTypes: true })) {
      for (const n of ["action.yml", "action.yaml"]) {
        if (d.isDirectory() && fs.existsSync(path.join(actions, d.name, n))) files.push(`.github/actions/${d.name}/${n}`);
      }
    }
  }
  return files;
}

function allGateScripts() {
  const found = new Map(); // script -> Set(workflow/action files that invoke it)
  for (const f of workflowAndActionFiles()) {
    const text = fs.readFileSync(path.join(REPO, f), "utf8");
    for (const m of text.matchAll(/\bnode\s+(tools\/[\w./-]+\.mjs)/g)) {
      const script = m[1];
      if (!found.has(script)) found.set(script, new Set());
      found.get(script).add(f);
    }
  }
  return found;
}

test("every gate script run by ANY workflow is denied, or explicitly acknowledged", () => {
  const found = allGateScripts();
  assert.ok(found.size >= 3, `expected to find gate scripts across workflows, found ${found.size}`);

  const exposed = [...found.keys()]
    .filter((s) => !pathPolicy([s]).denied.length)
    .filter((s) => !(s in ACKNOWLEDGED_UNDENIED_GATES))
    .sort();

  assert.deepStrictEqual(
    exposed,
    [],
    "these scripts are invoked by a workflow as gates but sit on an ALLOWED " +
      "path, so a bot PR could neuter them and auto-merge unread. Add each to " +
      "DENIED_PREFIXES in tools/ci/path-policy.mjs, or to " +
      "ACKNOWLEDGED_UNDENIED_GATES here with the reason:\n" +
      exposed.map((s) => `${s} (invoked by ${[...found.get(s)].join(", ")})`).join("\n")
  );
});

test("review: the gate scan reads the composite actions as well as the workflows", () => {
  /* MUTATION: go back to scanning .github/workflows only -> the release
     composite's own scripts vanish from the scan. */
  const found = allGateScripts();
  assert.ok([...found.get("tools/mobile/ios-embedded-frameworks.mjs") ?? []].includes(".github/actions/ios-archive/action.yml"));
  assert.ok(found.has("tools/release/upload-retry.mjs"), "upload-retry.mjs is run only by the ios-archive composite");
});

test("the acknowledgement list has not gone stale", () => {
  // An entry for a script no workflow runs any more is a licence nobody needs.
  const found = allGateScripts();
  const stale = Object.keys(ACKNOWLEDGED_UNDENIED_GATES).filter((s) => !found.has(s));
  assert.deepStrictEqual(stale, [], `no longer invoked by any workflow: ${stale.join(", ")}`);
});

test("STATE.md and HUMAN-ACTIONS.md are allowlisted", () => {
  // #167: an instruction every session must obey (announce in STATE.md) whose
  // every obedience cost a founder merge. HUMAN-ACTIONS.md is the same shape.
  assert.equal(pathPolicy(["STATE.md"]).allowed.length, 1);
  assert.equal(pathPolicy(["HUMAN-ACTIONS.md"]).allowed.length, 1);
});

test("deploy-manifest.json and sw.js are allowlisted, so a nightly PR can arm", () => {
  // HUMAN-ACTIONS #37, 2026-09-03. The nightly rewrites data/discover.json and
  // data/item-tags.json, both of which deploy-manifest.json hashes; sw.js's
  // BUILD_ID is stamped with the resulting deploy_id. Both were on NEITHER
  // list, so every nightly PR fell through to "unlisted" and auto-merge
  // declined even with every required check green.
  // KILLED BY: removing either `"deploy-manifest.json",` or `"sw.js",` from
  // ALLOWED_PREFIXES in path-policy.mjs (both run 2026-09-03).
  assert.equal(pathPolicy(["deploy-manifest.json"]).allowed.length, 1);
  assert.equal(pathPolicy(["sw.js"]).allowed.length, 1);
});

test("THE #37 REPRODUCTION: the exact four-file nightly PR is ARMED", () => {
  // These are the four paths PR #443 and PR #456 changed. Before the two
  // entries above, this decision was NOT ARMED / UNLISTED_PATH, and because the
  // decision is per-PR and all-or-nothing the whole PR waited for a human.
  // This is the assertion that would notice either entry being removed for a
  // reason that sounded good at the time.
  // KILLED BY: removing either new entry from ALLOWED_PREFIXES — the decision
  // reverts to NOT ARMED / UNLISTED_PATH (both run 2026-09-03).
  const d = automergeDecision({
    files: ["data/discover.json", "data/item-tags.json", "deploy-manifest.json", "sw.js"],
    labels: [],
  });
  assert.equal(d.armed, true, d.reason);
  assert.equal(d.code, "OK");
  assert.equal(d.needsFounder, false);
});

test("allowlisting sw.js did not widen to its neighbours", () => {
  // sw.js is a FILE entry, not a prefix, and the matcher's two rules are what
  // keep it that way — `sw.js.map`, `sw.json` and a `sw.js/` directory must all
  // still fall through to a human. The old bash matcher would have taken all
  // three.
  // KILLED BY: `file === prefix` -> `file.startsWith(prefix)` in matchesPrefix
  // (path-policy.mjs) — sw.js.map, sw.js/inner.js and the .bak all become
  // allowed (run 2026-09-03).
  const p = pathPolicy(["sw.js.map", "sw.json", "sw.js/inner.js", "deploy-manifest.json.bak"]);
  assert.equal(p.allowed.length, 0);
  assert.equal(p.unlisted.length, 4);
  // A same-named file one directory down is a different file, and `sw.js` must
  // not reach it. (`tools/sw.js` is allowed here, but by `tools/` — a directory
  // prefix that predates this change — never by the new entry.)
  assert.equal(pathPolicy(["tools/sw.js"]).allowed[0].prefix, "tools/");
});

test("the manifest pair is allowed, not denied — and denial would still win if it changed", () => {
  // Defence in depth, in the direction the file's own header asks for: this
  // asserts the two entries live on ALLOWED and nowhere on DENIED, so a future
  // reader cannot conclude from a green suite that they are governed.
  // KILLED BY: removing `"deploy-manifest.json",` from ALLOWED_PREFIXES (run
  // 2026-09-03); moving either entry onto DENIED_PREFIXES kills it the same way.
  for (const f of ["deploy-manifest.json", "sw.js"]) {
    assert.ok(ALLOWED_PREFIXES.includes(f), `${f} must be on ALLOWED_PREFIXES`);
    assert.ok(!DENIED_PREFIXES.includes(f), `${f} must not be on DENIED_PREFIXES`);
  }
});

test("tools/events-server.mjs is denied even though tools/ is allowed", () => {
  // scripts/events-server.vbs runs `node tools/events-server.mjs` at every
  // Windows login on the founder's always-on workstation, with the
  // founder's real user privileges, in the checkout that also holds the
  // root .env and data-local/. No test suite covers it, so it must stay
  // off the auto-merge allow path (kanban t_5663c62a / t_85e1b1ba).
  assert.ok(ALLOWED_PREFIXES.includes("tools/"));
  assert.ok(DENIED_PREFIXES.includes("tools/events-server.mjs"));
  const p = pathPolicy(["tools/events-server.mjs"]);
  assert.equal(p.denied.length, 1);
  assert.equal(p.denied[0].prefix, "tools/events-server.mjs");
});

test("tools/mobile/inject-app-icon.mjs is denied, not merely acknowledged", () => {
  /* IT SITS ON THE OTHER SIDE OF A LINE ITS NEIGHBOUR DOES NOT.
     `inject-background-audio.mjs` WAS acknowledged (until round 3 denied it as release-job code): an
     Info.plist capability edit with no credential exposure, whose worst silent
     failure is audio stopping on the lock screen — bad, and fixable in the next
     build. `inject-app-icon.mjs` writes the asset catalog, and since Xcode 14 App
     Store Connect EXTRACTS the PUBLIC LISTING icon from the uploaded binary's
     catalog with no manual upload available. A one-line `process.exit(0)` here
     neuters both the write and the `--check` that proves it, ios-build stays
     green, and Capacitor's placeholder goes on the App Store product page — which
     is not hypothetical; a TestFlight build shipped that way on 2026-09-03.

     Pinned as a NAMED test rather than left to the gate-script scan above,
     because that scan is satisfied either way: moving this file from
     DENIED_PREFIXES into ACKNOWLEDGED_UNDENIED_GATES would keep it green while
     re-opening the exposure.
     MUTATION: move "tools/mobile/inject-app-icon.mjs" out of DENIED_PREFIXES and
     into ACKNOWLEDGED_UNDENIED_GATES -> fails here, and only here. RUN. */
  assert.ok(ALLOWED_PREFIXES.includes("tools/"));
  assert.ok(DENIED_PREFIXES.includes("tools/mobile/inject-app-icon.mjs"));
  const p = pathPolicy(["tools/mobile/inject-app-icon.mjs"]);
  assert.equal(p.denied.length, 1);
  assert.equal(p.denied[0].prefix, "tools/mobile/inject-app-icon.mjs");
  assert.equal(p.allowed.length, 0, "deny must win over the tools/ allow entry");
  assert.equal(
    "tools/mobile/inject-app-icon.mjs" in ACKNOWLEDGED_UNDENIED_GATES,
    false,
    "acknowledging it instead of denying it re-opens the exposure with every check green"
  );
});

/* --------------------------------------------------------- pathPolicy() */

test("denied wins over allowed, always", () => {
  // docs/ is allowlisted; docs/roles.md is denied. Deny is checked first.
  const p = pathPolicy(["docs/roles.md"]);
  assert.equal(p.denied.length, 1);
  assert.equal(p.allowed.length, 0);
});

test("deny matching is case-insensitive", () => {
  const p = pathPolicy(["Backend/Src/index.ts", ".GITHUB/workflows/ci.yml"]);
  assert.equal(p.denied.length, 2);
});

test("allow matching is case-sensitive, and a mis-cased path falls through to unlisted", () => {
  const p = pathPolicy(["Data/session.json"]);
  assert.equal(p.allowed.length, 0);
  assert.equal(p.unlisted.length, 1);
});

test("a path in neither list is unlisted, not allowed", () => {
  const p = pathPolicy(["index.html", "manifest.json", "backend/package.json"]);
  assert.equal(p.unlisted.length, 3);
  assert.equal(p.allowed.length, 0);
});

test("malformed paths land in their own bucket and are never allowed", () => {
  const p = pathPolicy(["docs/../.github/workflows/ci.yml", "docs/ok.md"]);
  assert.equal(p.malformed.length, 1);
  assert.equal(p.allowed.length, 1);
  assert.equal(p.denied.length, 0);
});

test("pathPolicy reports which prefix matched", () => {
  const p = pathPolicy(["data/session.json"]);
  assert.equal(p.allowed[0].prefix, "data/");
});

test("pathPolicy accepts custom lists", () => {
  const p = pathPolicy(["x/y.txt"], { denied: [], allowed: ["x/"] });
  assert.equal(p.allowed.length, 1);
});

test("pathPolicy on no files returns four empty buckets", () => {
  const p = pathPolicy([]);
  assert.deepEqual(p, { malformed: [], denied: [], allowed: [], unlisted: [] });
});

/* ------------------------------------------------------------- freeze */

test("the freeze switch is on for any value except the falsey spellings", () => {
  assert.equal(isFreezeActive("1"), true);
  assert.equal(isFreezeActive("true"), true);
  assert.equal(isFreezeActive("yes please"), true);
  assert.equal(isFreezeActive("false"), false);
  assert.equal(isFreezeActive("FALSE"), false);
  assert.equal(isFreezeActive("0"), false);
  assert.equal(isFreezeActive("off"), false);
  assert.equal(isFreezeActive(""), false);
  assert.equal(isFreezeActive("   "), false);
  assert.equal(isFreezeActive(undefined), false);
  assert.equal(isFreezeActive(null), false);
});

/* -------------------------------------------------- automergeDecision() */

test("a content-only PR with no blocking label is armed", () => {
  const d = automergeDecision({ files: ["data/discover.json", "docs/x.md"] });
  assert.equal(d.armed, true);
  assert.equal(d.code, "OK");
  assert.equal(d.needsFounder, false);
});

test("PR #175's blocker is now armed", () => {
  // The whole diff was allowlisted except this one test file.
  const d = automergeDecision({
    files: [
      "docs/taxonomy-review.md",
      "data/taxonomy.json",
      "backend/test/dataSchemaCompliance.test.ts",
    ],
  });
  assert.equal(d.armed, true, d.reason);
});

test("a backend/src/ change is not armed even alongside allowlisted files", () => {
  const d = automergeDecision({
    files: ["backend/test/x.test.ts", "backend/src/ingest.ts"],
  });
  assert.equal(d.armed, false);
  assert.equal(d.code, "DENIED_PATH");
  assert.match(d.reason, /backend\/src\/ingest\.ts/);
});

test("the freeze kill switch beats everything", () => {
  const d = automergeDecision({ files: ["data/x.json"], freeze: "1" });
  assert.equal(d.armed, false);
  assert.equal(d.code, "FREEZE_ACTIVE");
  assert.equal(d.needsFounder, false, "a founder set the switch and knows");
});

test("hold blocks without putting the PR in the founder queue", () => {
  const d = automergeDecision({ files: ["data/x.json"], labels: ["hold"] });
  assert.equal(d.code, "BLOCKING_LABEL");
  assert.equal(d.needsFounder, false);
  assert.match(d.reason, /hold/);
});

test("founder-decision blocks AND queues", () => {
  const d = automergeDecision({ files: ["data/x.json"], labels: ["founder-decision"] });
  assert.equal(d.code, "BLOCKING_LABEL");
  assert.equal(d.needsFounder, true);
});

test("labels are accepted as strings or as {name} objects", () => {
  const d = automergeDecision({ files: ["data/x.json"], labels: [{ name: "hold" }] });
  assert.equal(d.code, "BLOCKING_LABEL");
});

test("both blocking labels are recognised", () => {
  for (const l of BLOCKING_LABELS) {
    assert.equal(automergeDecision({ files: ["data/x.json"], labels: [l] }).armed, false);
  }
});

test("an unrelated label does not block", () => {
  assert.equal(
    automergeDecision({ files: ["data/x.json"], labels: ["documentation", "data-integrity"] }).armed,
    true
  );
});

test("a draft is not armed and does not need a founder", () => {
  const d = automergeDecision({ files: ["data/x.json"], draft: true });
  assert.equal(d.code, "DRAFT");
  assert.equal(d.needsFounder, false);
});

test("a PR against a non-main base is not armed", () => {
  const d = automergeDecision({ files: ["data/x.json"], baseRef: "refresh-digest" });
  assert.equal(d.code, "WRONG_BASE");
  assert.equal(d.needsFounder, false);
});

test("an empty changed-file list refuses to guess", () => {
  const d = automergeDecision({ files: [] });
  assert.equal(d.code, "NO_FILES");
  assert.equal(d.needsFounder, true);
});

test("a truncated changed-file list refuses, even when every path it saw is allowed", () => {
  // The one input that makes an allowlist lie. The files endpoint caps at 3000
  // including pagination and truncates SILENTLY, so "everything I could see is
  // allowlisted" is worthless if the file I could not see is a workflow.
  const d = automergeDecision({ files: ["data/a.json", "data/b.json"], truncated: true });
  assert.equal(d.armed, false);
  assert.equal(d.code, "TRUNCATED_FILE_LIST");
  assert.equal(d.needsFounder, true);
});

test("truncation is reported ahead of the paths it could see", () => {
  const d = automergeDecision({ files: ["data/a.json"], truncated: true });
  assert.match(d.reason, /truncated/i);
});

test("a blocking label still outranks truncation in the reported reason", () => {
  const d = automergeDecision({ files: ["data/a.json"], truncated: true, labels: ["hold"] });
  assert.equal(d.code, "BLOCKING_LABEL");
});

test("governedCheck cannot certify a truncated list as clean", () => {
  const c = governedCheck({ files: ["data/a.json"], truncated: true, enforce: true });
  assert.equal(c.verdict, "UNAPPROVED");
  assert.equal(c.exitCode, 1);
  assert.match(c.governed[0].file, /truncated/);
});

test("CLI --truncated reaches the decision", () => {
  const h = harness({ f: "data/a.json\n" });
  runCli(["decide", "--files-from", "f", "--truncated", "--github-output", "O"], h.io);
  assert.match(h.appended.O, /code=TRUNCATED_FILE_LIST/);
});

test("an unlisted path is not armed and does need a founder", () => {
  // #167 in its general form: neither allowed nor denied means a human merges.
  const d = automergeDecision({ files: ["index.html"] });
  assert.equal(d.code, "UNLISTED_PATH");
  assert.equal(d.needsFounder, true);
});

test("a malformed path is not armed", () => {
  const d = automergeDecision({ files: ["docs/../CLAUDE.md"] });
  assert.equal(d.code, "MALFORMED_PATH");
  assert.equal(d.needsFounder, true);
});

test("denied beats unlisted in the reported reason", () => {
  const d = automergeDecision({ files: ["index.html", ".github/workflows/ci.yml"] });
  assert.equal(d.code, "DENIED_PATH");
});

test("findings list every blocker, not just the reported one", () => {
  // The bash version exited on the first failing file, so a PR with three
  // problems reported one, the author fixed it, and hit the next.
  const d = automergeDecision({
    files: ["index.html", "manifest.json", "docs/roles.md"],
    labels: ["hold"],
  });
  assert.ok(d.findings.length >= 4, d.findings.join(" | "));
  assert.ok(d.findings.some((f) => f.includes("index.html")));
  assert.ok(d.findings.some((f) => f.includes("manifest.json")));
  assert.ok(d.findings.some((f) => f.includes("docs/roles.md")));
  assert.ok(d.findings.some((f) => f.includes("hold")));
});

test("the reason counts the extra offenders rather than listing all of them", () => {
  const d = automergeDecision({ files: [".github/a.yml", ".github/b.yml", "CLAUDE.md"] });
  assert.match(d.reason, /and 2 more/);
});

test("the decision carries the full per-file policy for the report", () => {
  const d = automergeDecision({ files: ["data/x.json", "index.html"] });
  assert.equal(d.policy.allowed.length, 1);
  assert.equal(d.policy.unlisted.length, 1);
});

/* ---------------------------------------------------- governedCheck() */

test("a PR touching no governed path is CLEAN", () => {
  const c = governedCheck({ files: ["data/x.json", "backend/test/y.test.ts"] });
  assert.equal(c.verdict, "CLEAN");
  assert.equal(c.exitCode, 0);
});

test("an unlisted path is not a governed path — the check is about DENIED only", () => {
  // Unlisted means "auto-merge will not touch it"; it is not a policy breach,
  // and failing a required check on it would block every ordinary human PR.
  assert.equal(governedCheck({ files: ["index.html"] }).verdict, "CLEAN");
});

test("a governed path without the approval label is UNAPPROVED", () => {
  const c = governedCheck({ files: [".github/workflows/ci.yml"] });
  assert.equal(c.verdict, "UNAPPROVED");
});

test("report-only is the default: UNAPPROVED does not fail the job", () => {
  const c = governedCheck({ files: ["CLAUDE.md"] });
  assert.equal(c.exitCode, 0);
  assert.equal(c.enforced, false);
  assert.match(c.reason, /not enforcing yet/);
});

test("enforcing turns UNAPPROVED into a failure", () => {
  const c = governedCheck({ files: ["CLAUDE.md"], enforce: true });
  assert.equal(c.exitCode, 1);
  assert.equal(c.enforced, true);
});

test("the approval label clears it, enforcing or not", () => {
  for (const enforce of [false, true]) {
    const c = governedCheck({ files: ["CLAUDE.md"], labels: [APPROVAL_LABEL], enforce });
    assert.equal(c.verdict, "APPROVED");
    assert.equal(c.exitCode, 0);
  }
});

test("the approval label is configurable", () => {
  const c = governedCheck({
    files: ["CLAUDE.md"],
    labels: ["ok-by-wyatt"],
    approvalLabel: "ok-by-wyatt",
  });
  assert.equal(c.verdict, "APPROVED");
});

test("a malformed path counts as governed", () => {
  const c = governedCheck({ files: ["docs/../CLAUDE.md"], enforce: true });
  assert.equal(c.verdict, "UNAPPROVED");
  assert.equal(c.exitCode, 1);
  assert.match(c.governed[0].prefix, /relative/);
});

test("governedCheck lists every governed path it found", () => {
  const c = governedCheck({ files: [".github/a.yml", "docs/roles.md", "data/x.json"] });
  assert.equal(c.governed.length, 2);
});

/* --------------------------------------------------------- formatting */

test("the decision report leads with ARMED or NOT ARMED", () => {
  // PR #175 reported a green check named `enable-automerge` while auto-merge
  // was never armed. The headline is the fix for that.
  assert.match(formatDecision(automergeDecision({ files: ["data/x.json"] })), /^## automerge-decision: ARMED/);
  assert.match(formatDecision(automergeDecision({ files: ["CLAUDE.md"] })), /^## automerge-decision: NOT ARMED/);
});

test("a NOT ARMED report says a green check does not mean it will merge", () => {
  const md = formatDecision(automergeDecision({ files: ["CLAUDE.md"] }));
  assert.match(md, /green check here does not mean this PR will merge/);
});

test("the decision report names the failing path and the prefix that matched", () => {
  const md = formatDecision(automergeDecision({ files: ["backend/src/ingest.ts"] }), { prNumber: 9 });
  assert.match(md, /PR #9/);
  assert.match(md, /backend\/src\/ingest\.ts/);
  assert.match(md, /backend\/src\//);
});

test("the decision report tells you how to allowlist an unlisted path", () => {
  const md = formatDecision(automergeDecision({ files: ["index.html"] }));
  assert.match(md, /ALLOWED_PREFIXES/);
  assert.match(md, /index\.html/);
});

test("the governed-check report distinguishes blocking from report-only", () => {
  assert.match(formatGovernedCheck(governedCheck({ files: ["CLAUDE.md"] })), /report-only/);
  assert.match(
    formatGovernedCheck(governedCheck({ files: ["CLAUDE.md"], enforce: true })),
    /blocking/
  );
});

test("the governed-check report states the limit rather than overselling it", () => {
  const md = formatGovernedCheck(governedCheck({ files: ["CLAUDE.md"] }));
  assert.match(md, /admin with a token can override/);
  assert.match(md, /agent with write access can apply this label/);
});

test("formatPolicy prints both lists and the matching rule", () => {
  const s = formatPolicy();
  assert.match(s, /DENIED_PREFIXES/);
  assert.match(s, /ALLOWED_PREFIXES/);
  assert.match(s, /case-insensitive/);
});

/* ---------------------------------------------------------------- CLI */

test("parseArgs rejects an unknown command and an unknown flag", () => {
  assert.throws(() => parseArgs(["frobnicate"]), /unknown command/);
  assert.throws(() => parseArgs(["decide", "--lst"]), /unknown option/);
  assert.throws(() => parseArgs(["decide", "--labels"]), /needs a value/);
});

test("parseArgs collects repeated --file and camel-cases long flags", () => {
  const { opts } = parseArgs(["decide", "--file", "a", "--file", "b", "--files-from", "f"]);
  assert.deepEqual(opts.files, ["a", "b"]);
  assert.equal(opts.filesFrom, "f");
});

test("splitList accepts commas and newlines and drops blanks", () => {
  assert.deepEqual(splitList("a, b\nc,,\n"), ["a", "b", "c"]);
  assert.deepEqual(splitList(undefined), []);
});

function harness(files = {}) {
  const written = {};
  const appended = {};
  const out = [];
  return {
    written,
    appended,
    out,
    io: {
      readFile: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      readStdin: () => files["-"] ?? "",
      write: (p, s) => (written[p] = s),
      writeFile: (p, s) => (written[p] = s),
      append: (p, s) => (appended[p] = (appended[p] ?? "") + s),
      log: (s) => out.push(String(s)),
      err: (s) => out.push(String(s)),
    },
  };
}

test("CLI usage error exits 2", () => {
  const h = harness();
  assert.equal(runCli(["nope"], h.io), 2);
  assert.match(h.out.join("\n"), /unknown command/);
});

test("CLI explain prints the policy and exits 0", () => {
  const h = harness();
  assert.equal(runCli(["explain"], h.io), 0);
  assert.match(h.out.join("\n"), /DENIED_PREFIXES/);
});

test("CLI decide reads a newline-separated file list and exits 0 when armed", () => {
  const h = harness({ "files.txt": "data/x.json\ndocs/y.md\n" });
  assert.equal(runCli(["decide", "--files-from", "files.txt"], h.io), 0);
  assert.match(h.out.join("\n"), /ARMED/);
});

test("CLI decide exits 0 even when NOT armed — not arming is a decision, not a failure", () => {
  const h = harness({ "files.txt": "CLAUDE.md\n" });
  assert.equal(runCli(["decide", "--files-from", "files.txt"], h.io), 0);
  assert.match(h.out.at(-1), /^NOT ARMED: /);
});

test("CLI decide reads the file list from stdin", () => {
  const h = harness({ "-": "data/x.json\n" });
  assert.equal(runCli(["decide", "--files-from", "-"], h.io), 0);
  assert.match(h.out.at(-1), /^ARMED: /);
});

test("CLI decide writes GitHub outputs the workflow branches on", () => {
  const h = harness({ "files.txt": "CLAUDE.md\n" });
  runCli(["decide", "--files-from", "files.txt", "--github-output", "OUT"], h.io);
  assert.match(h.appended.OUT, /armed=false/);
  assert.match(h.appended.OUT, /code=DENIED_PATH/);
  assert.match(h.appended.OUT, /needs_founder=true/);
  assert.doesNotMatch(h.appended.OUT, /reason=[^\n]*\n[^a-z]/, "reason must stay on one line");
});

test("CLI decide appends markdown to the step summary and JSON to --json", () => {
  const h = harness({ "files.txt": "data/x.json\n" });
  runCli(["decide", "--files-from", "files.txt", "--summary", "SUM", "--json", "J"], h.io);
  assert.match(h.appended.SUM, /## automerge-decision: ARMED/);
  assert.equal(JSON.parse(h.written.J).code, "OK");
});

test("CLI decide honours --labels, --freeze and --draft", () => {
  const h = harness({ "files.txt": "data/x.json\n" });
  runCli(["decide", "--files-from", "files.txt", "--labels", "hold", "--github-output", "O"], h.io);
  assert.match(h.appended.O, /code=BLOCKING_LABEL/);

  const h2 = harness({ "files.txt": "data/x.json\n" });
  runCli(["decide", "--files-from", "files.txt", "--freeze", "1", "--github-output", "O"], h2.io);
  assert.match(h2.appended.O, /code=FREEZE_ACTIVE/);

  const h3 = harness({ "files.txt": "data/x.json\n" });
  runCli(["decide", "--files-from", "files.txt", "--draft", "--github-output", "O"], h3.io);
  assert.match(h3.appended.O, /code=DRAFT/);
});

test("CLI check exits 0 on a clean PR and reports the verdict", () => {
  const h = harness({ "f": "data/x.json\n" });
  assert.equal(runCli(["check", "--files-from", "f", "--github-output", "O"], h.io), 0);
  assert.match(h.appended.O, /verdict=CLEAN/);
});

test("CLI check exits 1 only when enforcing", () => {
  const files = { f: ".github/workflows/ci.yml\n" };
  assert.equal(runCli(["check", "--files-from", "f"], harness(files).io), 0);
  assert.equal(runCli(["check", "--files-from", "f", "--enforce"], harness(files).io), 1);
});

test("CLI check exits 0 when enforcing and the approval label is present", () => {
  const h = harness({ f: ".github/workflows/ci.yml\n" });
  assert.equal(
    runCli(["check", "--files-from", "f", "--enforce", "--labels", APPROVAL_LABEL], h.io),
    0
  );
  assert.match(h.out.at(-1), /APPROVED/);
});

test("CLI accepts labels from a file as well as a flag", () => {
  const h = harness({ f: "CLAUDE.md\n", l: `${APPROVAL_LABEL}\n` });
  assert.equal(runCli(["check", "--files-from", "f", "--labels-from", "l", "--enforce"], h.io), 0);
});

test("CLI treats a filename containing a comma as one path", () => {
  // --files-from splits on newlines only, because a path may contain a comma.
  const h = harness({ f: "data/a,b.json\n" });
  runCli(["decide", "--files-from", "f", "--json", "J"], h.io);
  assert.deepEqual(
    JSON.parse(h.written.J).policy.allowed.map((a) => a.file),
    ["data/a,b.json"]
  );
});

/* ------------------------------------------ security-1: who may merge unread */

test("security-1: a clean fork PR touching only data/ is NOT armed, and goes to a founder", () => {
  /* The live hole (round-3 audit): the repo is public, protect-main needs zero
     approvals, and the hourly sweep armed any green PR whose paths were
     allowlisted - including a returning outside contributor's fork PR.
     MUTATION: delete the `if (foreign) return not("FOREIGN_AUTHOR", ...)` line
     in automergeDecision -> this is ARMED / OK and the test fails. */
  const d = rawAutomergeDecision({ files: ["data/discover.json"], author: "stranger", crossRepo: true });
  assert.equal(d.armed, false);
  assert.equal(d.code, "FOREIGN_AUTHOR");
  assert.equal(d.needsFounder, true);
  assert.match(d.reason, /fork/);
});

test("security-1: a fork PR is refused even when its author's login is on the list", () => {
  // A fork's head branch is code nobody here pushed, whoever opened the PR.
  const d = rawAutomergeDecision({ files: ["data/x.json"], author: "wjduvall-cmd", crossRepo: true });
  assert.equal(d.code, "FOREIGN_AUTHOR");
});

test("security-1: a same-repo PR from an author not on AUTOMERGE_AUTHORS is refused", () => {
  const d = rawAutomergeDecision({ files: ["sw.js"], author: "someone-else" });
  assert.equal(d.armed, false);
  assert.equal(d.code, "FOREIGN_AUTHOR");
  assert.ok(d.findings.some((f) => /AUTOMERGE_AUTHORS/.test(f)));
});

test("security-1: an unknown author is refused, never assumed to be ours", () => {
  // MUTATION: make isTrustedAuthor return true for an empty/undefined login.
  for (const author of [undefined, null, "", "   "]) {
    assert.equal(rawAutomergeDecision({ files: ["data/x.json"], author }).code, "FOREIGN_AUTHOR", String(author));
  }
});

test("security-1: our own agents still arm, under either spelling of the Actions bot and any case", () => {
  for (const author of AUTOMERGE_AUTHORS) {
    assert.equal(rawAutomergeDecision({ files: ["data/x.json"], author }).armed, true, author);
  }
  assert.equal(isTrustedAuthor("WJDuvall-CMD"), true, "logins compare case-insensitively, as GitHub does");
  assert.equal(isTrustedAuthor("wjduvall-cmd-evil"), false, "exact login, not a prefix");
});

test("security-1: CLI decide without --author is FOREIGN_AUTHOR; with it, it arms", () => {
  const h = harness({ f: "data/a.json\n" });
  rawRunCli(["decide", "--files-from", "f", "--github-output", "O"], h.io);
  assert.match(h.appended.O, /code=FOREIGN_AUTHOR/);
  assert.match(h.appended.O, /needs_founder=true/);

  const h2 = harness({ f: "data/a.json\n" });
  rawRunCli(["decide", "--files-from", "f", "--author", "github-actions[bot]", "--github-output", "O"], h2.io);
  assert.match(h2.appended.O, /armed=true/);

  const h3 = harness({ f: "data/a.json\n" });
  rawRunCli(["decide", "--files-from", "f", "--author", "github-actions[bot]", "--cross-repo", "--github-output", "O"], h3.io);
  assert.match(h3.appended.O, /code=FOREIGN_AUTHOR/);
});

test("security-1: automerge-nightly passes the PR author and fork-ness to decide", () => {
  /* The CLI refuses without --author, so a workflow that stopped passing it
     would silently arm nothing - fail-safe, but the pin says it on purpose.
     MUTATION: drop `--author "$AUTHOR"` from the Decide step. */
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/automerge-nightly.yml"), "utf8");
  const decide = yml.slice(yml.indexOf("node tools/ci/path-policy.mjs decide"));
  assert.match(decide.slice(0, 600), /--author "\$AUTHOR"/);
  assert.match(yml, /AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(decide.slice(0, 600), /\$\{CROSS_REPO:-\}/);
});

/* ------------------------------------------ ci-release-2: renames are two paths */

/* The files API's shape for `git mv CLAUDE.md docs/CLAUDE-old.md` (ONE entry)
 * beside an ordinary change. The old tests handed the policy a list that
 * already contained CLAUDE.md, so they passed with or without the gatherer
 * fix; these run the gatherers' OWN jq, lifted out of the workflow files. */
const RENAME_FIXTURE = [
  { filename: "docs/CLAUDE-old.md", previous_filename: "CLAUDE.md", status: "renamed" },
  { filename: "tools/old-ci/path-policy.mjs", previous_filename: "tools/ci/path-policy.mjs", status: "renamed" },
  { filename: "data/discover.json", status: "modified" },
];

/** jq, or null. CI's ubuntu runner has it; a dev machine may not. */
function findJq() {
  for (const bin of [process.env.JQ, "jq"].filter(Boolean)) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return bin;
  }
  return null;
}
const JQ = findJq();
function needJq(t) {
  if (JQ) return true;
  // Never a silent pass where it matters: on CI a missing jq is a failure.
  assert.ok(!process.env.CI, "jq is required on CI to execute the workflows' own file gatherers");
  t.skip("jq not installed here (set JQ=/path/to/jq); CI runs this for real");
  return false;
}
const runJq = (args, input) => {
  const r = spawnSync(JQ, args, { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** The two jq programs one of the automerge/path-policy gatherers runs: the
 *  `--jq` on the files API, then the flatten to changed-files.txt. */
function gathererJq(workflow) {
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows", workflow), "utf8");
  const perEntry = /pulls\/\$PR\/files" \\\s*\n\s*--jq '([^']+)' > file-entries\.jsonl/.exec(yml);
  const flatten = /jq -r '([^']+)' file-entries\.jsonl > changed-files\.txt/.exec(yml);
  assert.ok(perEntry && flatten, `${workflow}: the file gatherer changed shape; update this test`);
  return { perEntry: perEntry[1], flatten: flatten[1] };
}

for (const workflow of ["automerge-nightly.yml", "path-policy.yml"]) {
  test(`ci-release-2: ${workflow}'s own gatherer turns a rename out of CLAUDE.md or tools/ci/ into a governed path`, (t) => {
    /* MUTATION: revert the gatherer's --jq to `.[].filename` (the pre-fix
       shape) -> only the allowlisted destinations reach the policy, the PR
       arms, and this is red. */
    if (!needJq(t)) return;
    const { perEntry, flatten } = gathererJq(workflow);
    // `gh api --jq` prints strings raw, like `jq -r`.
    const entries = runJq(["-r", perEntry], JSON.stringify(RENAME_FIXTURE));
    // A Windows jq writes CRLF; the runner's writes LF.
    assert.equal(entries.trim().split(/\r?\n/).length, RENAME_FIXTURE.length, "one line per API entry, for the truncation count");
    const files = runJq(["-r", flatten], entries).split(/\r?\n/).filter(Boolean);
    assert.ok(files.includes("CLAUDE.md") && files.includes("tools/ci/path-policy.mjs"), files.join(", "));
    const d = automergeDecision({ files });
    assert.equal(d.code, "DENIED_PATH");
    assert.equal(governedCheck({ files }).verdict, "UNAPPROVED");
  });
}

test("ci-release-2: pr-hygiene's gatherer shape reaches the sweep's policy with both sides of a rename", async (t) => {
  /* pr-hygiene keeps entries as objects and pr-triage's normalizePr expands
     them. MUTATION: drop previous_filename from its --jq -> red. */
  if (!needJq(t)) return;
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/pr-hygiene.yml"), "utf8");
  const m = /pulls\/\$n\/files" \\\s*\n\s*--jq '([^']+)'/.exec(yml);
  assert.ok(m, "pr-hygiene's file gatherer changed shape; update this test");
  const entries = JSON.parse(runJq(["-c", m[1]], JSON.stringify(RENAME_FIXTURE)));
  const { normalizePr } = await import("./pr-triage.mjs");
  const files = normalizePr({ files: entries }).files;
  assert.equal(automergeDecision({ files }).code, "DENIED_PATH", files.join(", "));
});

/* Every workflow step that lists a PR's changed files. A gatherer that reads
 * only `.filename` shows the policy the DESTINATION of a rename and never the
 * governed path it came from. */
function fileGatherers() {
  const dir = path.join(REPO, ".github/workflows");
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!(/pulls\/\$\{?\w+\}?\/files/.test(l) && /gh api/.test(l))) return;
      // A command continued with a trailing backslash is one command.
      let text = l;
      for (let j = i; /\\\s*$/.test(lines[j]) && j + 1 < lines.length; j++) text += "\n" + lines[j + 1];
      out.push({ f, line: i + 1, text });
    });
  }
  return out;
}

test("ci-release-2: every workflow gatherer of a PR's files reads previous_filename too", () => {
  /* MUTATION: revert any one gatherer to `--jq '.[].filename'` -> it is listed
     here. automerge-nightly, path-policy and pr-hygiene each have one. */
  const gatherers = fileGatherers();
  assert.ok(gatherers.length >= 3, `expected the three gatherers, found ${gatherers.length}`);
  const blind = gatherers.filter((g) => !/previous_filename/.test(g.text));
  assert.deepStrictEqual(blind.map((g) => `${g.f}:${g.line}`), [], "these gatherers cannot see the old side of a rename");
});

test("ci-release-2: the truncation check counts file ENTRIES, not the expanded path list", () => {
  /* With renames expanded to two paths, comparing the path list's length with
     changed_files would call every rename a truncation (fail-safe but wrong),
     and a check that counts the wrong thing can be wrong the other way too.
     MUTATION: go back to `wc -l < changed-files.txt` in either workflow. */
  for (const f of ["automerge-nightly.yml", "path-policy.yml"]) {
    const yml = fs.readFileSync(path.join(REPO, ".github/workflows", f), "utf8");
    assert.doesNotMatch(yml, /actual=\$\(wc -l < changed-files\.txt/, `${f} still counts expanded paths`);
    assert.match(yml, /actual=\$\(wc -l < file-entries\.jsonl/, `${f} must count one line per API entry`);
  }
});

/* ------------------------------------------ ci-release-5: mobile/ build inputs */

test("ci-release-5: the signing Gradle include and mobile's npm manifests are denied", () => {
  /* MUTATION: remove any of the three new DENIED_PREFIXES entries. */
  for (const f of ["mobile/gradle/foray-signing.gradle", "mobile/package.json", "mobile/package-lock.json"]) {
    assert.equal(pathPolicy([f]).denied.length, 1, f);
  }
  // The directory is denied whole, not just its .gradle files: anything the
  // signing include reads beside it (a properties file) is the same exposure.
  assert.equal(pathPolicy(["mobile/gradle/signing.properties"]).denied.length, 1);
  for (const p of ["mobile/gradle/", "mobile/package.json", "mobile/package-lock.json"]) {
    assert.ok(DENIED_PREFIXES.includes(p), `${p} is named in DENIED_PREFIXES, not only caught by a pattern`);
  }
});

test("ci-release-5: every plugin build manifest is denied by name, at any depth", () => {
  /* MUTATION: empty DENIED_PATTERNS -> every one of these is allowlisted under
     `mobile/` again and would auto-merge into a keystore-holding build step. */
  const manifests = [
    "mobile/plugins/foray-audio/android/build.gradle",
    "mobile/plugins/foray-audio/Package.swift",
    "mobile/plugins/foray-audio/foray-engine-core/Package.swift",
    "mobile/plugins/foray-tts/package.json",
    "mobile/plugins/new-plugin/android/settings.gradle.kts",
    "mobile/plugins/new-plugin/NewPlugin.podspec",
  ];
  for (const f of manifests) assert.equal(pathPolicy([f]).denied.length, 1, f);
});

test("ci-release-5: mobile/ APP code still auto-merges (the founder ruling of 2026-09-05 stands)", () => {
  for (const f of [
    "mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift",
    "mobile/plugins/foray-tts/web/foray-tts.js",
    "mobile/web/foray-type-scale.js",
  ]) {
    assert.equal(pathPolicy([f]).allowed.length, 1, f);
  }
});

/* Tracked files under mobile/ that are neither APP SOURCE nor denied, each with
 * the reason it cannot run on a build machine. App source is a source-file
 * extension inside a source directory (Sources/, Tests/, src/, web/). Anything
 * else — a new manifest, a config file, a dotfile — fails the walk below until
 * it is denied or added here, in a diff someone reads. */
const ACKNOWLEDGED_MOBILE_NON_SOURCE = {
  "mobile/.gitignore": "git metadata; no build tool executes it",
  "mobile/plugins/foray-audio/foray-engine-core/.gitignore": "git metadata; no build tool executes it",
  "mobile/README.md": "documentation",
  "mobile/plugins/foray-tts/README.md": "documentation",
  "mobile/VERSION": "a version string version.mjs validates; a bad one fails the upload, red",
  "mobile/ENGINE_DEFAULT.json": "JSON data the plist injector writes and --checks; parsed, never executed",
  "mobile/capacitor.config.json": "JSON config, parsed not executed (a .js/.ts config IS code and is denied by name); its decisions are pinned by shell-invariants.test.mjs",
  "mobile/plugins/foray-tts/lexicon/hard-terms.json": "pronunciation data bundled into the app",
  "mobile/plugins/foray-audio/ios/Tests/ForayAudioPluginTests/Fixtures/ClickTracks/click-tracks.json": "XCTest fixture data",
};
const APP_SOURCE_DIR = /\/(Sources|Tests|src|web)\//;
const APP_SOURCE_EXT = /\.(swift|java|kt|js|css|xml|png|jpg|svg|mp3|wav)$/i;

function trackedUnder(dir) {
  const r = spawnSync("git", ["ls-files", "-z", "--", dir], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean);
}

test("ci-release-5: every tracked file under mobile/ is app source, denied, or acknowledged with a reason", () => {
  /* The old walk filtered by a regex that duplicated DENIED_PATTERNS and
     skipped dotfiles, so it could only find what was already denied. This is
     the inversion: what is NOT app source must be accounted for.
     MUTATION: remove the Package.swift pattern from DENIED_PATTERNS, or add a
     tracked mobile/capacitor.config.ts / mobile/.npmrc without its deny entry
     -> it is listed here. */
  const files = trackedUnder("mobile");
  assert.ok(files.length >= 100, `expected the mobile tree, found ${files.length} tracked file(s)`);
  const unaccounted = files.filter(
    (f) =>
      !pathPolicy([f]).denied.length &&
      !(APP_SOURCE_DIR.test(f) && APP_SOURCE_EXT.test(f)) &&
      !(f in ACKNOWLEDGED_MOBILE_NON_SOURCE)
  );
  assert.deepStrictEqual(unaccounted, [], "not app source, not denied, not acknowledged: a build input nobody has classified");
  const stale = Object.keys(ACKNOWLEDGED_MOBILE_NON_SOURCE).filter((f) => !files.includes(f));
  assert.deepStrictEqual(stale, [], "acknowledged but no longer tracked");
});

test("review: the config files a build tool executes are denied by name under mobile/", () => {
  /* MUTATION: drop either new DENIED_PATTERNS entry. */
  for (const f of ["mobile/.npmrc", "mobile/plugins/foray-tts/.npmrc", "mobile/capacitor.config.ts", "mobile/capacitor.config.js", "mobile/capacitor.config.mjs"]) {
    assert.equal(pathPolicy([f]).denied.length, 1, f);
  }
  assert.equal(pathPolicy(["mobile/capacitor.config.json"]).allowed.length, 1, "the JSON config is data and stays app-owned");
});

/* ------------- round-3 review of ci-release-5: everything a signing job executes ------------- */

/* A job that can read a signing secret: the release jobs (and android-release's
 * bundle job) pass these to their composite actions or steps. */
const SIGNING_SECRET = /secrets\.(IOS_DIST_CERT|IOS_PROVISIONING_PROFILE|APP_STORE_CONNECT_|APPLE_TEAM_ID|ANDROID_KEYSTORE|ANDROID_KEY_ALIAS|PLAY_SERVICE_ACCOUNT)/;

/* App code the signing jobs execute at BUILD time that cannot be denied: it is
 * the app. prepare-webdir.mjs imports it to build the webDir. Listed so a new
 * one is a visible diff, and because this is the honest residual of the fix:
 * code here runs in the same job as the signing secrets and can reach later
 * steps through $GITHUB_ENV. The real closure is building the app in a job
 * that holds no signing secret, which is a release-pipeline change of its own. */
const ACKNOWLEDGED_RELEASE_APP_CODE = {
  "player/build-stamp.js": "app code imported by prepare-webdir.mjs; closes only with a secret-free build job",
  "player/foray-queue.js": "app code imported by prepare-webdir.mjs; closes only with a secret-free build job",
  "player/foray-resolve.js": "app code imported by prepare-webdir.mjs; closes only with a secret-free build job",
  "player/foray-sources.js": "app code imported by prepare-webdir.mjs; closes only with a secret-free build job",
  "player/seek-policy.js": "app code imported by prepare-webdir.mjs; closes only with a secret-free build job",
};

const stripComments = (text) => text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
const norm = (wd, rel) => path.posix.normalize(path.posix.join(wd, rel)).replace(/^\.\//, "");

/** The jobs of one workflow, as text. */
function jobsOf(text) {
  const at = text.search(/^jobs:\s*$/m);
  if (at < 0) return [];
  return text.slice(at).split(/\n(?=  [A-Za-z0-9_-]+:\s*$)/m).slice(1);
}

/** Files one command line executes, run from `wd`. Follows `npm run` into
 *  `wd`/package.json and `npm ci` (with or without --prefix) to its manifests. */
function executedBy(cmd, wd, out, seenScripts = new Set()) {
  for (const m of cmd.matchAll(/\bnode\s+(?:--test\s+)?((?:\.\.?\/)*[\w@./-]+\.(?:mjs|cjs|js))\b/g)) out.add(norm(wd, m[1]));
  for (const m of cmd.matchAll(/\bnpm\s+ci\b([^\n&;|]*)/g)) {
    const prefix = /--prefix\s+(\S+)/.exec(m[1]);
    const dir = prefix ? norm(wd, prefix[1]) : wd;
    for (const f of ["package.json", "package-lock.json"]) out.add(norm(dir, f));
  }
  for (const m of cmd.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)) {
    const key = `${wd}:${m[1]}`;
    if (seenScripts.has(key)) continue;
    seenScripts.add(key);
    out.add(norm(wd, "package.json"));
    const script = JSON.parse(fs.readFileSync(path.join(REPO, wd, "package.json"), "utf8")).scripts?.[m[1]];
    assert.ok(script, `${wd}/package.json has no "${m[1]}" script`);
    executedBy(script, wd, out, seenScripts);
  }
}

/** Every file a signing job reaches: its steps, the composite actions it uses,
 *  the npm scripts they call, and (transitively) what those modules import. */
function signingJobExecutables() {
  const out = new Set();
  const jobs = [];
  for (const f of workflowAndActionFiles().filter((f) => f.startsWith(".github/workflows/"))) {
    for (const job of jobsOf(fs.readFileSync(path.join(REPO, f), "utf8"))) {
      if (SIGNING_SECRET.test(job)) jobs.push({ f, job });
    }
  }
  const texts = [];
  for (const { job } of jobs) {
    texts.push(job);
    for (const m of job.matchAll(/uses:\s*\.\/(\.github\/actions\/[\w-]+)/g)) {
      texts.push(fs.readFileSync(path.join(REPO, m[1], "action.yml"), "utf8"));
    }
  }
  for (const text of texts) {
    for (const chunk of stripComments(text).split(/\n(?=\s*- (?:name|uses|run):)/)) {
      const wd = /working-directory:\s*(\S+)/.exec(chunk)?.[1] ?? ".";
      executedBy(chunk, wd, out);
    }
  }
  // Transitive relative imports of every module reached.
  const queue = [...out];
  while (queue.length) {
    const f = queue.shift();
    if (!/\.(mjs|cjs|js)$/.test(f) || !fs.existsSync(path.join(REPO, f))) continue;
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g),
      ...src.matchAll(/(?:^|\n)\s*import\s*["'](\.{1,2}\/[^"']+)["']/g),
      ...src.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
      ...src.matchAll(/\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ].map((m) => norm(path.posix.dirname(f), m[1]));
    for (const dep of specs) {
      if (!out.has(dep)) {
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return { files: out, jobs };
}

test("review: every file a signing job executes is DENIED (or is app code, listed with the residual)", () => {
  /* The deny list used to be built by hand from the scripts a reviewer thought
     of, and the gate-script scan never read .github/actions/** or followed an
     `npm run`. So ios-ci.mjs (signing-gate, with every iOS secret in its env),
     ios-embedded-frameworks.mjs, prepare-webdir.mjs and tools/mobile's npm
     manifests all sat on ALLOWED paths inside the job holding the App Store
     Connect key. An allowlisted file there lands unread and runs at the next
     2-hourly release.
     MUTATION: remove any of the round-3 entries from DENIED_PREFIXES (e.g.
     "tools/mobile/ios-ci.mjs" or "tools/mobile/package.json") -> listed here. */
  const { files, jobs } = signingJobExecutables();
  assert.ok(jobs.length >= 3, `expected release.yml's ios and android jobs and android-release's bundle job, found ${jobs.map((j) => j.f)}`);
  for (const expected of [
    "tools/mobile/ios-ci.mjs",
    "tools/mobile/ios-embedded-frameworks.mjs",
    "tools/mobile/prepare-webdir.mjs",
    "tools/mobile/package.json",
    "mobile/package.json",
    "test/release-gates.test.js",
    "tools/release/upload-retry.mjs",
  ]) {
    assert.ok(files.has(expected), `the walk no longer reaches ${expected}: it has gone blind somewhere`);
  }
  const exposed = [...files]
    .filter((f) => fs.existsSync(path.join(REPO, f)))
    .filter((f) => !pathPolicy([f]).denied.length && !(f in ACKNOWLEDGED_RELEASE_APP_CODE))
    .sort();
  assert.deepStrictEqual(exposed, [], "run by a job that holds a signing secret, and not denied");
  const stale = Object.keys(ACKNOWLEDGED_RELEASE_APP_CODE).filter((f) => !files.has(f));
  assert.deepStrictEqual(stale, [], "acknowledged but no longer executed by a signing job");
});

test("review: nothing a signing job executes may be ACKNOWLEDGED as a gate instead of denied", () => {
  /* The acknowledgement list is for gates whose worst case is a red run. A
     script in a job holding a signing key has no such worst case.
     MUTATION: put "tools/mobile/ios-ci.mjs" back in ACKNOWLEDGED_UNDENIED_GATES. */
  const { files } = signingJobExecutables();
  const both = Object.keys(ACKNOWLEDGED_UNDENIED_GATES).filter((s) => files.has(s));
  assert.deepStrictEqual(both, []);
});

/* ------------- round-3 review of security-1: a founder's arming of an outside PR ------------- */

test("review: disarmDecision keeps a founder's arming when foreign-ness is the only blocker", () => {
  /* MUTATION: drop the FOREIGN_AUTHOR exception in disarmDecision -> disarm. */
  const fork = { files: ["data/x.json"], author: "stranger", crossRepo: true };
  const kept = disarmDecision({ ...fork, armedBy: "wjduvall-cmd" });
  assert.deepEqual([kept.disarm, kept.code], [false, "FOUNDER_ARMED"]);
  // The bot never vouches for a stranger, and nobody unknown does either.
  for (const armedBy of ["github-actions[bot]", "app/github-actions", "stranger", "", undefined]) {
    assert.equal(disarmDecision({ ...fork, armedBy }).disarm, true, String(armedBy));
  }
  // Every other blocker still wins over a founder's arming.
  assert.equal(disarmDecision({ ...fork, armedBy: "wjduvall-cmd", freeze: "on" }).disarm, true);
  assert.equal(disarmDecision({ ...fork, armedBy: "wjduvall-cmd", labels: ["hold"] }).disarm, true);
  assert.equal(disarmDecision({ ...fork, armedBy: "wjduvall-cmd", files: ["CLAUDE.md"] }).disarm, true);
  assert.equal(disarmDecision({ ...fork, armedBy: "wjduvall-cmd", truncated: true }).disarm, true);
  assert.equal(isFounderLogin("SFFAN15-SYS"), true);
  assert.equal(isFounderLogin("github-actions[bot]"), false);
});

test("review: CLI decide --armed-by reports founder_armed for the workflow's Disarm step", () => {
  const h = harness({ f: "data/a.json\n" });
  rawRunCli(["decide", "--files-from", "f", "--author", "stranger", "--cross-repo", "--armed-by", "wjduvall-cmd", "--github-output", "O"], h.io);
  assert.match(h.appended.O, /armed=false/);
  assert.match(h.appended.O, /founder_armed=true/);
  const h2 = harness({ f: "data/a.json\n" });
  rawRunCli(["decide", "--files-from", "f", "--author", "stranger", "--armed-by", "github-actions[bot]", "--github-output", "O"], h2.io);
  assert.match(h2.appended.O, /founder_armed=false/);
});
