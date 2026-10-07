/* release-env-check.mjs (HUMAN-ACTIONS #115, PR #822): the read-only check
   that says whether the `release` environment is ready for #822 to merge.
   Every `gh` call is faked from canned JSON, so the suite is offline. Each
   test names the mutation that kills it. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REPO, EXIT, SIGNING_SECRETS, evaluate, formatReport, gatherFacts, main, parseArgs,
} from "./release-env-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "o/r";
const BASE = `repos/${REPO}`;
const ENV = `${BASE}/environments/release`;
const SENTINEL = "s3cr3t-VALUE-must-never-print";

const secrets = (names) => ({
  total_count: names.length,
  // A `value` field the real API never sends: if any of it reaches the
  // report, the report is copying more than names.
  secrets: names.map((name) => ({ name, value: SENTINEL, created_at: "2026-10-01T00:00:00Z" })),
});

const TAG_RULESET = {
  id: 7, name: "release tags", target: "tag", enforcement: "active",
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules: [{ type: "creation" }, { type: "deletion" }],
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
};

/** The state HA #115 asks for: every check passes. */
function readyResponses() {
  return {
    [ENV]: { name: "release", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    [`${ENV}/deployment-branch-policies?per_page=100`]: {
      total_count: 2,
      branch_policies: [{ id: 1, name: "main", type: "branch" }, { id: 2, name: "v*", type: "tag" }],
    },
    [`${ENV}/secrets?per_page=100`]: secrets([...SIGNING_SECRETS]),
    [`${BASE}/actions/secrets?per_page=100`]: secrets(["VERCEL_TOKEN", "R2_SECRET"]),
    [`${BASE}/rulesets?per_page=100&includes_parents=true`]: [
      { id: 3, name: "main protection", target: "branch", enforcement: "active" },
      { id: 7, name: "release tags", target: "tag", enforcement: "active" },
    ],
    [`${BASE}/rulesets/7`]: TAG_RULESET,
  };
}

function ghError(stderr) {
  return Object.assign(new Error("Command failed: gh api"), { code: 1, stderr });
}
const NOT_FOUND = ghError("gh: Not Found (HTTP 404)");
const FORBIDDEN = ghError("gh: Resource not accessible by integration (HTTP 403)");

/** Fake gh over a path -> JSON (or Error to throw) map; unknown paths 404. */
function fakeGh(responses) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const r = responses[args[1]];
    if (r === undefined) throw NOT_FOUND;
    if (r instanceof Error) throw r;
    return JSON.stringify(r);
  };
  return { gh, calls };
}

async function run(patch = (r) => r) {
  const responses = patch(readyResponses());
  const { gh, calls } = fakeGh(responses);
  const result = evaluate(await gatherFacts({ repo: REPO, gh }));
  return { result, calls, byId: Object.fromEntries(result.checks.map((c) => [c.id, c])) };
}

test("the HA #115 end state is READY: exit 0, every check passes", async () => {
  /* MUTATION: make evaluate() return NOT_READY unconditionally (or invert
     any check's ok) -> this test fails. */
  const { result } = await run();
  assert.equal(result.exitCode, EXIT.READY);
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.map((c) => [c.id, c.ok]), [
    ["environment", true], ["deployment-branches", true], ["environment-secrets", true],
    ["repo-secrets", true], ["tag-ruleset", true],
  ]);
});

test("today's state (no environment, secrets at repo level, no tag ruleset) is NOT READY", async () => {
  /* MUTATION: treat a 404 on the environment as an unreadable (null) check
     instead of a failure -> exit becomes 2 and this fails. */
  const { result, byId } = await run((r) => {
    delete r[ENV];
    r[`${BASE}/actions/secrets?per_page=100`] = secrets([...SIGNING_SECRETS, "VERCEL_TOKEN"]);
    r[`${BASE}/rulesets?per_page=100&includes_parents=true`] = [{ id: 3, target: "branch", enforcement: "active" }];
    return r;
  });
  assert.equal(result.exitCode, EXIT.NOT_READY);
  for (const id of ["environment", "deployment-branches", "environment-secrets", "repo-secrets", "tag-ruleset"]) {
    assert.equal(byId[id].ok, false, id);
  }
  assert.match(byId["tag-ruleset"].detail, /no tag ruleset/);
});

test("no deployment-branch policy (any branch may deploy) fails", async () => {
  /* MUTATION: drop the `p == null` guard in checkBranchPolicy -> reading
     p.protected_branches on null throws and this test fails. */
  const { result, byId } = await run((r) => { r[ENV].deployment_branch_policy = null; return r; });
  assert.equal(result.exitCode, EXIT.NOT_READY);
  assert.equal(byId["deployment-branches"].ok, false);
  assert.match(byId["deployment-branches"].detail, /any branch/);
});

test("\"protected branches\" is not main + v*: fails", async () => {
  /* MUTATION: drop the protected_branches check -> custom_branch_policies is
     false here, so the detail changes; pinned by the message. */
  const { byId } = await run((r) => {
    r[ENV].deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
    return r;
  });
  assert.equal(byId["deployment-branches"].ok, false);
  assert.match(byId["deployment-branches"].detail, /protected branches/);
});

test("the policy list must be exactly branch:main + tag:v* (missing, extra, or v* as a branch all fail)", async () => {
  /* MUTATION: drop the `extra` comparison -> the `release/*` case passes.
     MUTATION: compare names only (ignore type) -> the branch-typed v* case passes. */
  const P = `${ENV}/deployment-branch-policies?per_page=100`;
  const cases = {
    "missing v*": [{ name: "main", type: "branch" }],
    "extra branch": [{ name: "main", type: "branch" }, { name: "v*", type: "tag" }, { name: "release/*", type: "branch" }],
    "v* as a branch": [{ name: "main", type: "branch" }, { name: "v*", type: "branch" }],
  };
  for (const [label, list] of Object.entries(cases)) {
    const { result, byId } = await run((r) => { r[P] = { total_count: list.length, branch_policies: list }; return r; });
    assert.equal(byId["deployment-branches"].ok, false, label);
    assert.equal(result.exitCode, EXIT.NOT_READY, label);
  }
  // An entry with no `type` (older API shape) is a branch policy.
  const { byId } = await run((r) => {
    r[P] = { total_count: 2, branch_policies: [{ name: "main" }, { name: "v*", type: "tag" }] };
    return r;
  });
  assert.equal(byId["deployment-branches"].ok, true);
});

test("a signing secret missing at environment level fails and is named", async () => {
  /* MUTATION: check only that the environment secret list is non-empty ->
     this passes as ready. */
  const { result, byId } = await run((r) => {
    r[`${ENV}/secrets?per_page=100`] = secrets(SIGNING_SECRETS.filter((n) => n !== "PLAY_SERVICE_ACCOUNT_JSON"));
    return r;
  });
  assert.equal(result.exitCode, EXIT.NOT_READY);
  assert.equal(byId["environment-secrets"].ok, false);
  assert.match(byId["environment-secrets"].detail, /PLAY_SERVICE_ACCOUNT_JSON/);
});

test("a signing secret left at repository level fails and is named; other repo secrets are fine", async () => {
  /* MUTATION: skip checkRepoSecrets (always true) -> the first half passes.
     MUTATION: fail on ANY repo secret -> the ready baseline (VERCEL_TOKEN,
     R2_SECRET at repo level) goes red in the first test. */
  const { result, byId } = await run((r) => {
    r[`${BASE}/actions/secrets?per_page=100`] = secrets(["VERCEL_TOKEN", "IOS_DIST_CERT_PASSWORD"]);
    return r;
  });
  assert.equal(result.exitCode, EXIT.NOT_READY);
  assert.equal(byId["repo-secrets"].ok, false);
  assert.match(byId["repo-secrets"].detail, /IOS_DIST_CERT_PASSWORD/);
  assert.doesNotMatch(byId["repo-secrets"].detail, /VERCEL_TOKEN/);
});

test("a tag ruleset only counts when active, aimed at v*, not excluding it, and restricting creation", async () => {
  /* MUTATION: drop the enforcement check -> "evaluate"/"disabled" pass.
     MUTATION: drop the `creation` rule check -> "deletion only" passes.
     MUTATION: drop the exclude check -> "excludes v*" passes. */
  const cases = {
    disabled: { enforcement: "disabled" },
    "evaluate only": { enforcement: "evaluate" },
    "other pattern": { conditions: { ref_name: { include: ["refs/tags/release-*"], exclude: [] } } },
    "excludes v*": { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v*"] } } },
    "deletion only": { rules: [{ type: "deletion" }] },
  };
  for (const [label, over] of Object.entries(cases)) {
    const { result, byId } = await run((r) => { r[`${BASE}/rulesets/7`] = { ...TAG_RULESET, ...over }; return r; });
    assert.equal(byId["tag-ruleset"].ok, false, label);
    assert.equal(result.exitCode, EXIT.NOT_READY, label);
  }
  // `~ALL` restricts every tag, v* included.
  const { byId } = await run((r) => {
    r[`${BASE}/rulesets/7`] = { ...TAG_RULESET, conditions: { ref_name: { include: ["~ALL"], exclude: [] } } };
    return r;
  });
  assert.equal(byId["tag-ruleset"].ok, true);
});

test("an unreadable setting is UNDETERMINED (exit 2), never READY", async () => {
  /* MUTATION: read a non-404 gh failure as "absent"/empty (e.g. return
     { names: new Set() } from secretNames on error) -> the 403 on repo
     secrets reads as "none left" and the result is READY. */
  const { result, byId } = await run((r) => { r[`${BASE}/actions/secrets?per_page=100`] = FORBIDDEN; return r; });
  assert.equal(byId["repo-secrets"].ok, null);
  assert.match(byId["repo-secrets"].detail, /HTTP 403/);
  assert.equal(result.exitCode, EXIT.UNDETERMINED);
  assert.equal(result.ready, false);
});

test("a definite failure outranks an unreadable one: exit 1", async () => {
  /* MUTATION: check `unknown` before `failed` in evaluate() -> exit 2. */
  const { result } = await run((r) => {
    r[`${BASE}/actions/secrets?per_page=100`] = FORBIDDEN;
    delete r[ENV];
    return r;
  });
  assert.equal(result.exitCode, EXIT.NOT_READY);
});

test("a truncated secret list is undetermined, not a smaller set", async () => {
  /* MUTATION: drop the total_count comparison in secretNames -> the repo
     list of 100 shown (of 101) contains no signing secret and reads READY. */
  const { result, byId } = await run((r) => {
    const shown = Array.from({ length: 100 }, (_, i) => `OTHER_${i}`);
    r[`${BASE}/actions/secrets?per_page=100`] = { total_count: 101, secrets: shown.map((name) => ({ name })) };
    return r;
  });
  assert.equal(byId["repo-secrets"].ok, null);
  assert.match(byId["repo-secrets"].detail, /truncated/);
  assert.equal(result.exitCode, EXIT.UNDETERMINED);
});

test("an unreadable tag ruleset detail is undetermined unless another ruleset already passes", async () => {
  /* MUTATION: skip unreadable details (`continue` without counting) -> the
     only tag ruleset is unreadable and the result says "no tag ruleset"
     (a definite FAIL) instead of undetermined. */
  const { byId } = await run((r) => { r[`${BASE}/rulesets/7`] = FORBIDDEN; return r; });
  assert.equal(byId["tag-ruleset"].ok, null);
  const both = await run((r) => {
    r[`${BASE}/rulesets?per_page=100&includes_parents=true`] = [
      { id: 6, target: "tag", enforcement: "active" }, { id: 7, target: "tag", enforcement: "active" },
    ];
    r[`${BASE}/rulesets/6`] = FORBIDDEN;
    return r;
  });
  assert.equal(both.byId["tag-ruleset"].ok, true);
});

test("read-only: every gh call is a bare `gh api <GET path>` under the repo, no method, field or body flag", async () => {
  /* MUTATION: add a "-X", "PUT" (or any -f/--input) to any call -> fails. */
  const { calls } = await run();
  assert.ok(calls.length >= 6, `expected every endpoint read, got ${calls.length}`);
  for (const args of calls) {
    assert.equal(args.length, 2, JSON.stringify(args));
    assert.equal(args[0], "api");
    assert.ok(args[1].startsWith(`${BASE}/`), args[1]);
    assert.ok(!args[1].startsWith("-"), args[1]);
  }
});

test("names never values: neither the text nor the JSON report carries any other response field", async () => {
  /* MUTATION: put the raw environment-secrets response into the result (or
     list `${s.name}=${s.value}`) -> the sentinel shows up. */
  for (const state of [(r) => r, (r) => { r[`${BASE}/actions/secrets?per_page=100`] = secrets([...SIGNING_SECRETS]); return r; }]) {
    const { gh } = fakeGh(state(readyResponses()));
    const out = [];
    await main(["--repo", REPO], { gh, out: (s) => out.push(s), err: () => {} });
    await main(["--repo", REPO, "--json"], { gh, out: (s) => out.push(s), err: () => {} });
    const text = out.join("\n");
    assert.ok(!text.includes(SENTINEL), "a secret value field reached the output");
    assert.ok(!text.includes("created_at") && !text.includes("2026-10-01"), "a non-name secret field reached the output");
  }
});

test("main exits with the decision's code and says whether #822 may merge", async () => {
  /* MUTATION: return 0 from main regardless of the result -> the NOT_READY
     case exits 0. */
  const out = [];
  const ready = fakeGh(readyResponses());
  assert.equal(await main(["--repo", REPO], { gh: ready.gh, out: (s) => out.push(s) }), EXIT.READY);
  assert.match(out.pop(), /READY: HA #115 is done; PR #822/);
  const r = readyResponses();
  delete r[ENV];
  const notReady = fakeGh(r);
  assert.equal(await main(["--repo", REPO], { gh: notReady.gh, out: (s) => out.push(s) }), EXIT.NOT_READY);
  assert.match(out.pop(), /NOT READY: do not merge PR #822/);
});

test("argument parsing: defaults, --repo/--env/--json, and a bad argument is a usage error (exit 2, no gh call)", async () => {
  /* MUTATION: ignore unknown flags -> `--force` parses and gh is called. */
  assert.deepEqual(parseArgs([]).opts, { repo: DEFAULT_REPO, env: "release", json: false });
  assert.deepEqual(parseArgs(["--repo", "a/b", "--env", "prod", "--json"]).opts, { repo: "a/b", env: "prod", json: true });
  for (const bad of [["--force"], ["--repo"], ["--repo", "not-a-repo"], ["--env", "--json"]]) {
    assert.ok(parseArgs(bad).error, JSON.stringify(bad));
  }
  const { gh, calls } = fakeGh(readyResponses());
  const errs = [];
  assert.equal(await main(["--force"], { gh, out: () => {}, err: (s) => errs.push(s) }), EXIT.UNDETERMINED);
  assert.equal(calls.length, 0);
  assert.match(errs.join("\n"), /usage:/);
});

test("SIGNING_SECRETS is exactly the set of secrets release.yml reads (drift guard)", () => {
  /* MUTATION: drop a name from SIGNING_SECRETS (or add a secret to
     release.yml without adding it here) -> the sets differ. */
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const read = new Set([...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  read.delete("GITHUB_TOKEN"); // issued per run, not a stored secret
  assert.deepEqual([...read].sort(), [...SIGNING_SECRETS].sort());
});

test("the text report marks each check PASS / FAIL / ???? and ends with the verdict", () => {
  /* MUTATION: print "PASS" for an unknown (null) check -> fails. */
  const text = formatReport({
    repo: REPO, env: "release", exitCode: EXIT.UNDETERMINED, ready: false,
    checks: [{ id: "a", ok: true, detail: "x" }, { id: "b", ok: null, detail: "y" }, { id: "c", ok: false, detail: "z" }],
  });
  assert.match(text, /PASS {2}a: x/);
  assert.match(text, /\?\?\?\? {2}b: y/);
  assert.match(text, /FAIL {2}c: z/);
  assert.match(text, /UNDETERMINED/);
});

// Mutation killed: dropping (or renaming away from) the "Check:" pointer line in
// HUMAN-ACTIONS #115. Without it the founder and whoever holds #822 never learn
// this check exists, which is the whole point of the card.
test("HUMAN-ACTIONS #115 points at this check and gates PR #822 on it", () => {
  const ha = fs.readFileSync(path.join(ROOT, "HUMAN-ACTIONS.md"), "utf8");
  const start = ha.search(/^## #115 /m);
  assert.ok(start >= 0, "HUMAN-ACTIONS.md has a ## #115 section");
  const rest = ha.slice(start + 1);
  const next = rest.search(/^## #/m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const line = section.split("\n").find((l) => l.includes("node tools/ops/release-env-check.mjs"));
  assert.ok(line, "HA #115 names `node tools/ops/release-env-check.mjs`");
  assert.match(line, /#822/, "the pointer line gates PR #822");
  assert.match(line, /READY/, "the pointer line says what passing looks like");
});
