#!/usr/bin/env node
/* Release-environment readiness check (HUMAN-ACTIONS #115, PR #822).

   WHAT IT ANSWERS: "has the founder finished HA #115, so PR #822 may merge?"
   PR #822 puts `environment: release` on release.yml's `ios` and `android`
   jobs. Merged BEFORE the `release` environment exists and holds the signing
   and upload secrets, every release breaks: the two jobs read empty secrets
   and go unsigned. Nothing in the repo could tell, from the outside, whether
   the admin-only settings had been changed yet. This does, so #822 cannot be
   merged early by someone who only has the PR in front of them.

   It is READ-ONLY. Every call is `gh api <GET path>` with no method flag and
   no body (a test pins that), and it prints secret NAMES only. GitHub's API
   never returns secret values; the report still copies names and nothing else
   out of each response, so no other field of a response can reach the output.

   Exit 0 ONLY when all four hold:
     1. the `release` environment exists;
     2. its deployment-branch policy is exactly branch `main` plus tag `v*`
        (custom policies; not "protected branches", not "any branch", nothing
        extra);
     3. every signing/upload secret is set at environment level and none is
        left at repository level;
     4. an ACTIVE tag ruleset covers `v*` and restricts tag creation.
   Exit 1 when any check definitely fails. Exit 2 when nothing failed but a
   check could not be decided (a 403, a network error, a truncated list):
   "could not check" is never reported as ready.

   Not wired into any workflow on purpose (the 115-part card): reading
   repository and environment secret names needs an admin token, which CI
   does not hold and should not. Run it locally:

     node tools/ops/release-env-check.mjs                 # JW-Incorporated/foray, env `release`
     node tools/ops/release-env-check.mjs --repo o/r --env release --json

   SIGNING_SECRETS is the list in PR #822's founder checklist, which is every
   `secrets.*` that .github/workflows/release.yml reads. It is not typed out
   here: it is built from the lists the release gates themselves use (the iOS
   seven from tools/mobile/ios-ci.mjs, the Android keystore trio and the Play
   key from tools/mobile/release-ci.mjs; CH2-21), so a secret renamed in a gate
   is renamed here too. Those two, and tools/release/readiness.mjs which both
   import, are the only non-builtin modules this file loads; none does anything
   on import but define constants and functions. The test suite still
   re-derives the set from the workflow, so a new signing secret there turns
   the suite red until a gate's list carries it. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isEntryScript } from "../ci/entry.mjs";

import { SIGNING_SECRETS as IOS_SIGNING_SECRETS } from "../mobile/ios-ci.mjs";
import { ANDROID_SECRETS, PLAY_SECRETS } from "../mobile/release-ci.mjs";

const execFileP = promisify(execFile);

export const DEFAULT_REPO = "JW-Incorporated/foray";
export const DEFAULT_ENV = "release";

/** Every secret the release environment must hold, sorted: the order a
    missing one is named in the report. */
export const SIGNING_SECRETS = Object.freeze(
  [...ANDROID_SECRETS, ...IOS_SIGNING_SECRETS, ...PLAY_SECRETS].sort(),
);

/** The deployment policies the environment must carry, and nothing else. */
export const REQUIRED_POLICIES = Object.freeze([
  Object.freeze({ type: "branch", name: "main" }),
  Object.freeze({ type: "tag", name: "v*" }),
]);

/** ref_name patterns in a tag ruleset that cover `v*` tags. `~ALL` covers
    every tag, `v*` among them. */
const V_TAG_PATTERNS = new Set(["refs/tags/v*", "v*", "~ALL"]);
const V_TAG_EXCLUDES = new Set(["refs/tags/v*", "v*"]);

export const EXIT = Object.freeze({ READY: 0, NOT_READY: 1, UNDETERMINED: 2 });

/** Default gh runner: resolves with stdout, rejects on a non-zero exit. */
async function defaultGh(args) {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function shortError(err) {
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  const first = (stderr || String(err?.message ?? err)).split("\n")[0];
  return first.slice(0, 200);
}

/** One GET. Returns { ok: true, data } | { ok: false, absent: true } (HTTP 404)
    | { ok: false, error }. A failed call is never read as "absent" unless
    GitHub said 404. */
export async function readJson(gh, path) {
  let stdout;
  try {
    stdout = await gh(["api", path]);
  } catch (err) {
    const msg = shortError(err);
    if (/HTTP 404\b/.test(msg)) return { ok: false, absent: true };
    return { ok: false, error: msg };
  }
  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: `unparseable response from ${path}` };
  }
}

/** Every GET the check makes. Returns raw read results; decides nothing. */
export async function gatherFacts({ repo = DEFAULT_REPO, env = DEFAULT_ENV, gh = defaultGh } = {}) {
  const base = `repos/${repo}`;
  const envPath = `${base}/environments/${encodeURIComponent(env)}`;
  const facts = { repo, env };

  facts.environment = await readJson(gh, envPath);
  const custom = facts.environment.ok
    && facts.environment.data?.deployment_branch_policy?.custom_branch_policies === true;
  // The policy list exists only for custom policies (404 otherwise).
  facts.branchPolicies = custom
    ? await readJson(gh, `${envPath}/deployment-branch-policies?per_page=100`)
    : null;
  facts.envSecrets = facts.environment.ok
    ? await readJson(gh, `${envPath}/secrets?per_page=100`)
    : null;
  facts.repoSecrets = await readJson(gh, `${base}/actions/secrets?per_page=100`);

  facts.rulesets = await readJson(gh, `${base}/rulesets?per_page=100&includes_parents=true`);
  facts.rulesetDetails = [];
  if (facts.rulesets.ok && Array.isArray(facts.rulesets.data)) {
    // The list omits conditions and rules; only tag rulesets need the detail.
    for (const rs of facts.rulesets.data) {
      if (rs?.target !== "tag") continue;
      facts.rulesetDetails.push({ id: rs.id, read: await readJson(gh, `${base}/rulesets/${rs.id}`) });
    }
  }
  return facts;
}

/** Secret names out of a `{ total_count, secrets: [{ name }] }` read.
    { names } | { error } — a list shorter than total_count is an error, not
    a smaller set. */
function secretNames(read) {
  if (!read.ok) return { error: read.absent ? "not found (HTTP 404)" : read.error };
  const list = read.data?.secrets;
  if (!Array.isArray(list)) return { error: "response has no secrets list" };
  if (typeof read.data.total_count === "number" && read.data.total_count > list.length) {
    return { error: `list truncated (${list.length} of ${read.data.total_count})` };
  }
  return { names: new Set(list.map((s) => String(s?.name ?? ""))) };
}

const check = (id, ok, detail) => ({ id, ok, detail });
const UNKNOWN = null;

function checkEnvironment(f) {
  if (f.environment.ok) return check("environment", true, `environment \`${f.env}\` exists`);
  if (f.environment.absent) return check("environment", false, `environment \`${f.env}\` does not exist`);
  return check("environment", UNKNOWN, `could not read environment \`${f.env}\`: ${f.environment.error}`);
}

function checkBranchPolicy(f) {
  const id = "deployment-branches";
  if (!f.environment.ok) {
    return f.environment.absent
      ? check(id, false, "no environment, so no deployment-branch policy")
      : check(id, UNKNOWN, "environment unreadable");
  }
  const p = f.environment.data?.deployment_branch_policy;
  if (p == null) return check(id, false, "any branch or tag may deploy (no deployment-branch policy)");
  if (p.protected_branches === true) return check(id, false, "policy is \"protected branches\", not `main` + `v*`");
  if (p.custom_branch_policies !== true) return check(id, false, "policy is not \"selected branches and tags\"");
  const read = f.branchPolicies;
  if (!read || !read.ok) {
    return check(id, UNKNOWN, `could not read the policy list: ${read?.absent ? "not found (HTTP 404)" : read?.error}`);
  }
  const list = read.data?.branch_policies;
  if (!Array.isArray(list)) return check(id, UNKNOWN, "policy list response has no branch_policies");
  if (typeof read.data.total_count === "number" && read.data.total_count > list.length) {
    return check(id, UNKNOWN, `policy list truncated (${list.length} of ${read.data.total_count})`);
  }
  // `type` arrived later in the API; an entry without it is a branch policy.
  const have = list.map((x) => `${x?.type ?? "branch"}:${x?.name}`);
  const want = REQUIRED_POLICIES.map((x) => `${x.type}:${x.name}`);
  const missing = want.filter((w) => !have.includes(w));
  const extra = have.filter((h) => !want.includes(h));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(", ")}`);
    if (extra.length) parts.push(`unexpected ${extra.join(", ")}`);
    return check(id, false, `deployment policies are not exactly branch:main + tag:v* (${parts.join("; ")})`);
  }
  return check(id, true, "deployment policies are exactly branch:main + tag:v*");
}

function checkEnvSecrets(f) {
  const id = "environment-secrets";
  if (!f.environment.ok) {
    return f.environment.absent
      ? check(id, false, `no environment, so none of the ${SIGNING_SECRETS.length} signing secrets is there`)
      : check(id, UNKNOWN, "environment unreadable");
  }
  const r = secretNames(f.envSecrets);
  if (r.error) return check(id, UNKNOWN, `could not list environment secrets: ${r.error}`);
  const missing = SIGNING_SECRETS.filter((n) => !r.names.has(n));
  if (missing.length) return check(id, false, `missing at environment level: ${missing.join(", ")}`);
  return check(id, true, `all ${SIGNING_SECRETS.length} signing secrets are set at environment level`);
}

function checkRepoSecrets(f) {
  const id = "repo-secrets";
  const r = secretNames(f.repoSecrets);
  if (r.error) return check(id, UNKNOWN, `could not list repository secrets: ${r.error}`);
  const left = SIGNING_SECRETS.filter((n) => r.names.has(n));
  if (left.length) return check(id, false, `still at repository level: ${left.join(", ")}`);
  return check(id, true, "no signing secret is left at repository level");
}

/** Why one tag ruleset does or does not protect `v*`; null when it does. */
function rulesetGap(rs) {
  if (rs?.enforcement !== "active") return `enforcement is ${rs?.enforcement ?? "unset"}, not active`;
  const ref = rs?.conditions?.ref_name ?? {};
  const include = Array.isArray(ref.include) ? ref.include : [];
  const exclude = Array.isArray(ref.exclude) ? ref.exclude : [];
  if (!include.some((p) => V_TAG_PATTERNS.has(p))) return "does not target v*";
  if (exclude.some((p) => V_TAG_EXCLUDES.has(p))) return "excludes v*";
  const rules = Array.isArray(rs?.rules) ? rs.rules : [];
  if (!rules.some((r) => r?.type === "creation")) return "does not restrict tag creation";
  return null;
}

function checkTagRuleset(f) {
  const id = "tag-ruleset";
  if (!f.rulesets.ok) {
    return check(id, UNKNOWN, `could not list rulesets: ${f.rulesets.absent ? "not found (HTTP 404)" : f.rulesets.error}`);
  }
  if (!Array.isArray(f.rulesets.data)) return check(id, UNKNOWN, "ruleset list is not an array");
  const gaps = [];
  let unreadable = 0;
  for (const { id: rsId, read } of f.rulesetDetails) {
    if (!read.ok) { unreadable++; continue; }
    const gap = rulesetGap(read.data);
    if (gap === null) return check(id, true, `tag ruleset "${read.data.name ?? rsId}" restricts creation of v*`);
    gaps.push(`"${read.data.name ?? rsId}" ${gap}`);
  }
  if (unreadable) return check(id, UNKNOWN, `${unreadable} tag ruleset(s) could not be read`);
  if (!f.rulesetDetails.length) return check(id, false, "no tag ruleset exists");
  return check(id, false, `no active tag ruleset restricts creation of v* (${gaps.join("; ")})`);
}

/** Pure decision over gathered facts. */
export function evaluate(facts) {
  const checks = [
    checkEnvironment(facts),
    checkBranchPolicy(facts),
    checkEnvSecrets(facts),
    checkRepoSecrets(facts),
    checkTagRuleset(facts),
  ];
  const failed = checks.some((c) => c.ok === false);
  const unknown = checks.some((c) => c.ok === UNKNOWN);
  const exitCode = failed ? EXIT.NOT_READY : unknown ? EXIT.UNDETERMINED : EXIT.READY;
  return { repo: facts.repo, env: facts.env, ready: exitCode === EXIT.READY, exitCode, checks };
}

export function formatReport(result) {
  const mark = (ok) => (ok === true ? "PASS" : ok === false ? "FAIL" : "????");
  const lines = [`Release environment readiness for ${result.repo} (environment \`${result.env}\`):`];
  for (const c of result.checks) lines.push(`  ${mark(c.ok)}  ${c.id}: ${c.detail}`);
  lines.push(
    result.exitCode === EXIT.READY
      ? "READY: HA #115 is done; PR #822 (environment: release) may merge."
      : result.exitCode === EXIT.NOT_READY
        ? "NOT READY: do not merge PR #822; finish HUMAN-ACTIONS #115 first."
        : "UNDETERMINED: some settings could not be read (an admin token is needed); do not merge PR #822 on this result.",
  );
  return lines.join("\n");
}

export function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, env: DEFAULT_ENV, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if ((a === "--repo" || a === "--env") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      opts[a.slice(2)] = argv[++i];
    } else return { error: `unknown or incomplete argument: ${a}` };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) return { error: `--repo must be owner/name, got ${opts.repo}` };
  return { opts };
}

export async function main(argv = process.argv.slice(2), { gh = defaultGh, out = console.log, err = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`${parsed.error}\nusage: node tools/ops/release-env-check.mjs [--repo owner/name] [--env release] [--json]`);
    return EXIT.UNDETERMINED;
  }
  const { repo, env, json } = parsed.opts;
  const result = evaluate(await gatherFacts({ repo, env, gh }));
  out(json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.exitCode;
}

if (isEntryScript(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`release-env-check crashed: ${e?.stack ?? e}`);
      process.exit(EXIT.UNDETERMINED);
    },
  );
}
