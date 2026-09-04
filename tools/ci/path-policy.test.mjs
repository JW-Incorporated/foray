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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

import {
  ALLOWED_PREFIXES,
  APPROVAL_LABEL,
  BLOCKING_LABELS,
  DENIED_PREFIXES,
  automergeDecision,
  formatDecision,
  formatGovernedCheck,
  formatPolicy,
  governedCheck,
  isFreezeActive,
  matchesPrefix,
  parseArgs,
  pathPolicy,
  pathProblem,
  runCli,
  splitList,
} from "./path-policy.mjs";

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
  // ios-ci.mjs is a multi-subcommand CLI (xcode-container, pick-simulator,
  // redact-localstorage, signing-gate, decode-localstorage, verdict) invoked
  // from ios-build.yml. `signing-gate` decides whether the iOS build proceeds
  // unsigned, but — unlike wire-signing.mjs — no step in ios-build.yml passes
  // it a live signing secret; ios-build.yml has no APPLE_* credential env at
  // all today. Revisit and split/deny the signing-gate path specifically the
  // day iOS signing secrets are wired in (kanban t_97e1c5f4).
  "tools/mobile/ios-ci.mjs": "no live signing secret in ios-build.yml today; revisit when iOS signing lands",
  // Diagnostic probes over a live Chrome DevTools socket / device screen —
  // they read app behaviour after the build already happened and can only
  // turn a check red, not change what gets built or signed.
  "tools/mobile/webview-probe.mjs": "post-build diagnostic probe; cannot alter build/signing output",
  "tools/mobile/probe/install-probe.mjs": "post-build diagnostic probe; cannot alter build/signing output",
  // Injects a background-audio capability into Info.plist and verifies with
  // --check, same shape as wire-signing.mjs's own --check re-read — but this
  // one has no keystore/credential exposure, only an Info.plist edit.
  "tools/mobile/inject-background-audio.mjs": "Info.plist capability injection; no credential exposure",
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
};

/* Every `.github/workflows/*.yml` file, not just ci.yml — a gate script run
 * from ANY workflow can be neutered the same way; scoping the scan to ci.yml
 * alone only checked one of the repo's workflow files (kanban t_97e1c5f4). */
function allGateScripts() {
  const dir = path.join(REPO, ".github/workflows");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const found = new Map(); // script -> Set(workflow files that invoke it)
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
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
     `inject-background-audio.mjs` is in ACKNOWLEDGED_UNDENIED_GATES above: an
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
