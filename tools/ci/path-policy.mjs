#!/usr/bin/env node
/* The merge path policy — ONE implementation, every consumer.
 *
 * WHY THIS FILE EXISTS (2026-08-16)
 * The allow/deny path lists used to live inside
 * `.github/workflows/automerge-nightly.yml` as two heredoc strings and a pair of
 * hand-rolled `case`-glob loops. Three consequences, all of them measured on
 * real PRs on 2026-08-15/16:
 *
 *   1. THE POLICY ONLY GOVERNED ONE MERGE PATH. The lists lived inside the
 *      Actions job, so they described what Actions would do and nothing else.
 *      Two PRs were merged from a laptop with `gh pr merge` and a founder token
 *      and walked straight past the deny-list, because there was no check to
 *      walk past. The policy is now a module, so a status check
 *      (`.github/workflows/path-policy.yml`) can evaluate EVERY PR with the same
 *      code the auto-merge path uses. See that file's header for the honest
 *      limit of what a required check buys.
 *
 *   2. THE MATCHER WAS PREFIX-ONLY, INCLUDING FOR FILE ENTRIES. `case "$f" in
 *      "$prefix"*)` means the ALLOWED entry `app.js` also matched `app.json`
 *      and `app.js.bak`, and `STATE.md` matched `STATE.mdx`. Nothing exploited
 *      it, but "allowlisted by accident" is not a property worth keeping — and
 *      widening ALLOWED to `backend/test/` (see below) makes precision load
 *      bearing: `backend/testing-src/evil.ts` must NOT satisfy `backend/test/`.
 *      matchesPrefix() below is therefore two rules, not one, and
 *      path-policy.test.mjs pins both.
 *
 *   3. IT WAS UNTESTABLE. Workflow YAML has no unit test. Every change to the
 *      lists was verified by reading it. The sister project (Swift2) had already
 *      paid for the two-copies version of this exact drift.
 *
 * WHAT IT DECIDES
 *   pathPolicy()        -> per-file verdicts: malformed / denied / allowed / unlisted
 *   automergeDecision() -> ARMED or NOT ARMED, with the reason, for one PR
 *   governedCheck()     -> the status-check verdict: does this PR touch a
 *                          governed path, and is that approved?
 *
 * The bash it replaced is gone, deliberately: two copies of a policy is the
 * failure this module exists to prevent, so the workflows call this and only
 * this.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ policy */

/* DENIED wins over ALLOWED and is checked first.
 *
 * These are the files that DEFINE the gates, the operating rules, or the
 * deploy. A bot that can auto-merge a change to its own checks has no checks:
 * one PR widens the allowlist, weakens a required job, or rewrites the standing
 * instructions every future session reads, and every downstream guarantee is
 * gone.
 *
 * Several of these are not in ALLOWED either. They are listed here so that
 * carelessly widening ALLOWED later cannot expose them — defence in depth, and
 * the reason `backend/src/` appears below even though `backend/` has never been
 * allowlisted. */
export const DENIED_PREFIXES = [
  ".github/",
  ".claude/",
  "CLAUDE.md",
  "docs/DECISIONS.md",
  "docs/adr/",
  "docs/roles.md",
  "docs/agents/routine-invariants.md",
  // Was `backend/src/config/` (2026-07-24). Widened to the whole source tree on
  // 2026-08-16 in the same change that allowlisted `backend/test/`: the argument
  // for letting tests land unread is precisely that they cannot change
  // production behaviour, and that argument only holds if production code is
  // explicitly on the other side of the line. Nothing has asked for
  // agent-authored `backend/src/` PRs to land unread.
  "backend/src/",
  // This directory IS the gate: run-suites.mjs decides what CI executes, and
  // path-policy.mjs (this file) decides what may merge unread. `tools/` is
  // allowlisted, so without this entry the first PR to edit this file would
  // auto-merge under the policy it was rewriting — strictly worse than the
  // heredoc it replaced, which at least lived in a denied path. Cost: a change
  // to the CI runner needs a human merge. Measured frequency: single digits per
  // year. That is the right trade.
  "tools/ci/",
  // Two more gates that ci.yml invokes by name. Same argument as tools/ci/,
  // one directory over: a one-line `process.exit(0)` in either neuters a
  // required check with no human in the loop, and `tools/` is allowlisted.
  // Cheap to deny — 6 and 2 commits respectively in the repo's whole history.
  //
  // path-policy.test.mjs asserts that EVERY `node tools/**.mjs` invoked by
  // ci.yml is either denied here or explicitly acknowledged with a reason, so
  // a new gate script cannot acquire this exposure silently.
  "tools/test-search.mjs",
  "tools/validate-semantic-index.mjs",
];

/* Paths a bot run may touch, by tier (docs/curation/... § auto-merge):
 *   T1 data/         generated content; covered by the data invariants in
 *                    ci.yml (refs, dupes, taxonomy, audio scheme, tokened-URL
 *                    leaks, DAI flags) + copy rules
 *   T2 docs/         low blast radius; governance paths denied above
 *   T3 player/ tools/ test/   covered by node --test suites in ci.yml, with
 *                    one documented exception: test/playwright/ (kanban card
 *                    t_504fd5fd) is real-Chromium coverage run by its own
 *                    `playwright` CI job, not node --test, and that job is
 *                    ADVISORY-ONLY (see ci.yml's own comment on it) — a bad
 *                    change there cannot block a merge or reach production,
 *                    only turn a non-required check red. Still additive/
 *                    test-only in the same sense as backend/test/ below, so
 *                    it stays inside test/'s existing T3 allowance rather
 *                    than needing its own entry.
 *   T4 app.js styles.css search-engine.js
 *                    covered by test/app-security.test.js (esc/safeUrl
 *                    behaviour + CSP/href static invariants) and node --check
 *   T2 STATE.md      the cross-session announcement board. Added 2026-08-13
 *                    (PR #167 raised it, #168 fixed it): CLAUDE.md tells every
 *                    session to announce its workstream there, but STATE.md was
 *                    in NEITHER list, so obeying that instruction guaranteed a
 *                    founder merge every time — friction pointing the wrong way.
 *   T2 HUMAN-ACTIONS.md   same shape as STATE.md, same fix, 2026-08-16.
 *                    CLAUDE.md § HUMAN-ACTIONS.md orders every session to file
 *                    owner actions there "the moment you identify it". Leaving
 *                    it unlisted would have reproduced #167 exactly: an
 *                    instruction every session must obey, whose every obedience
 *                    costs a founder merge. It is a coordination doc — nothing
 *                    reads it to decide anything, so a wrong entry misinforms a
 *                    human and cannot weaken a check.
 *   T3 backend/test/ Added 2026-08-16. PR #175 was blocked from auto-merge by
 *                    exactly one file, `backend/test/dataSchemaCompliance.test.ts`
 *                    — additive, test-only, and `backend/` sat in NEITHER list,
 *                    so it fell through to "leaving it for a human". A
 *                    test-only backend change cannot break production: if a new
 *                    assertion is wrong, the REQUIRED `backend` check goes red
 *                    and the PR cannot merge at all. The blast radius of a bad
 *                    test here is a red build, not a bad deploy. Its production
 *                    counterpart `backend/src/` is explicitly denied above.
 *
 * BEFORE ADDING ANYTHING HERE: DENIED_PREFIXES is checked first and wins, so
 * widening this list cannot expose a denied path. What it CAN do is let a file
 * land unread whose contents change behaviour. The test is not "is it low
 * risk?" but "if a bot wrote something false here, would any gate, instruction
 * or deploy behave differently?" If yes, it belongs in DENIED, not here. */
export const ALLOWED_PREFIXES = [
  "data/",
  "docs/",
  "player/",
  "tools/",
  "test/",
  "backend/test/",
  "app.js",
  "styles.css",
  "search-engine.js",
  "STATE.md",
  "HUMAN-ACTIONS.md",
];

/* Labels that stop auto-merge on one PR. `hold` means a human is mid-thought;
 * `founder-decision` means the answer is not ours to give. */
export const BLOCKING_LABELS = ["hold", "founder-decision"];

/* The label a founder applies to say "yes, I approve this touching governed
 * paths". See .github/workflows/path-policy.yml for what this does and does not
 * buy — an agent with a repo token can apply it too, and that is stated rather
 * than hidden. */
export const APPROVAL_LABEL = "founder-approved";

/* Applied by the hygiene sweep so the residue is one filtered list rather than
 * something a founder has to notice. See tools/ci/pr-triage.mjs. */
export const FOUNDER_QUEUE_LABEL = "needs-founder";

/* ----------------------------------------------------------------- matching */

/**
 * Does `file` fall under `prefix`?
 *
 * TWO RULES, and the difference is the whole point:
 *   - `foo/bar/` (trailing slash) is a DIRECTORY prefix. It matches anything
 *     under that directory, and the trailing slash is what makes the boundary
 *     real: `backend/test/` cannot be satisfied by `backend/testing-src/evil.ts`
 *     because that path does not contain the segment boundary `test/`.
 *   - `foo.js` (no trailing slash) is a FILE and matches only itself. The old
 *     bash matcher was `case "$f" in "$prefix"*)` for both, so `app.js` also
 *     matched `app.json`, `app.js.bak` and `app.jsx`, and `STATE.md` matched
 *     `STATE.mdx`. Nothing exploited that; it is fixed because "allowlisted by
 *     accident" is not a property to keep.
 *
 * Caller normalises case where it wants to (deny matching is case-insensitive,
 * allow matching is not — see pathPolicy).
 */
export function matchesPrefix(file, prefix) {
  if (typeof file !== "string" || typeof prefix !== "string" || prefix === "") return false;
  return prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix;
}

/**
 * Why a path string cannot be trusted, or null if it can.
 *
 * A changed-file list arrives from the GitHub API or from `git diff`, so these
 * are cheap paranoia rather than a live threat — but a path this function
 * rejects is a path the prefix rules cannot reason about correctly
 * (`docs/../.github/workflows/ci.yml` is a `.github/` write that starts with
 * `docs/`), and the fail-safe direction for an unreasonable path is "a human
 * looks at it".
 */
export function pathProblem(file) {
  if (typeof file !== "string") return "not a string";
  if (file === "") return "empty path";
  if (file !== file.trim()) return "leading or trailing whitespace";
  if (file.includes("\0")) return "NUL byte";
  if (file.includes("\\")) return "backslash (paths must be POSIX)";
  if (file.startsWith("/")) return "absolute path";
  const segments = file.split("/");
  if (segments.some((s) => s === "")) return "empty path segment";
  if (segments.some((s) => s === "." || s === "..")) return "relative path segment";
  return null;
}

/**
 * Classify every changed file.
 *
 * -> { malformed: [{file, problem}], denied: [{file, prefix}],
 *      allowed: [{file, prefix}], unlisted: [{file}] }
 *
 * DENIED is evaluated first and unconditionally wins, so widening ALLOWED can
 * never expose a denied path.
 *
 * Deny matching is CASE-INSENSITIVE; allow matching is case-sensitive. The
 * asymmetry is deliberate and both directions are fail-safe: on a
 * case-insensitive checkout `Backend/Src/index.ts` and `backend/src/index.ts`
 * are the same file, so the deny list must catch both spellings, while a
 * mis-cased path that fails to match ALLOWED merely falls through to
 * "unlisted", which means a human looks.
 */
export function pathPolicy(files, opts = {}) {
  const denied = opts.denied ?? DENIED_PREFIXES;
  const allowed = opts.allowed ?? ALLOWED_PREFIXES;
  const out = { malformed: [], denied: [], allowed: [], unlisted: [] };

  for (const file of files ?? []) {
    const problem = pathProblem(file);
    if (problem) {
      out.malformed.push({ file: typeof file === "string" ? file : String(file), problem });
      continue;
    }
    const lower = file.toLowerCase();
    const hit = denied.find((p) => matchesPrefix(lower, p.toLowerCase()));
    if (hit) {
      out.denied.push({ file, prefix: hit });
      continue;
    }
    const ok = allowed.find((p) => matchesPrefix(file, p));
    if (ok) out.allowed.push({ file, prefix: ok });
    else out.unlisted.push({ file });
  }
  return out;
}

/** True when the AUTOMERGE_FREEZE repo variable is set to something meaning "on". */
export function isFreezeActive(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  if (v === "") return false;
  return !["false", "0", "no", "off"].includes(v);
}

/* --------------------------------------------------------------- decisions */

/**
 * Should auto-merge be armed on this PR, and if not, exactly why?
 *
 * -> { armed, code, reason, findings: [string], needsFounder, policy }
 *
 * `code` is a stable machine value; `reason` is the one-line human sentence;
 * `findings` lists EVERY blocker found, not just the first. The old bash exited
 * on the first failing file, so a PR with three problems reported one and the
 * author fixed it and hit the next — three round trips for one read.
 *
 * `needsFounder` is what puts a PR in the batched queue (the `needs-founder`
 * label). It is deliberately false for `hold` (a human is already on it) and
 * for a freeze (a founder set that switch and knows).
 */
export function automergeDecision(input = {}) {
  const {
    files = [],
    labels = [],
    freeze = "",
    draft = false,
    baseRef = "main",
    truncated = false,
    denied,
    allowed,
    blockingLabels = BLOCKING_LABELS,
  } = input;

  const policy = pathPolicy(files, { denied, allowed });
  const findings = [];
  const labelSet = labels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const blocking = blockingLabels.filter((l) => labelSet.includes(l));

  if (isFreezeActive(freeze)) {
    findings.push(`AUTOMERGE_FREEZE is set ("${String(freeze).trim()}") — all auto-merge is halted`);
  }
  for (const l of blocking) findings.push(`carries the \`${l}\` label`);
  for (const m of policy.malformed) findings.push(`unreasonable path \`${m.file}\` (${m.problem})`);
  for (const d of policy.denied) {
    findings.push(`touches governed path \`${d.file}\` (matched DENIED \`${d.prefix}\`)`);
  }
  for (const u of policy.unlisted) {
    findings.push(`touches non-allowlisted path \`${u.file}\``);
  }

  const not = (code, reason, needsFounder) => ({
    armed: false,
    code,
    reason,
    findings,
    needsFounder,
    policy,
  });

  if (draft) return not("DRAFT", "PR is a draft.", false);
  if (baseRef !== "main") return not("WRONG_BASE", `PR targets \`${baseRef}\`, not \`main\`.`, false);
  if (isFreezeActive(freeze)) {
    return not(
      "FREEZE_ACTIVE",
      `AUTOMERGE_FREEZE is set ("${String(freeze).trim()}") — the kill switch is on, nothing is armed.`,
      false
    );
  }
  if (blocking.length) {
    return not(
      "BLOCKING_LABEL",
      `Blocked by the \`${blocking.join("`, `")}\` label.`,
      // `hold` means a human is mid-thought and does not need chasing;
      // `founder-decision` is by definition waiting on a founder.
      blocking.includes("founder-decision")
    );
  }
  if (!files.length) {
    return not("NO_FILES", "No changed files were reported for this PR — refusing to guess.", true);
  }
  // A TRUNCATED changed-file list is the one input that makes an allowlist lie:
  // every path the caller could see is allowlisted, and the one it could not
  // see is `.github/workflows/ci.yml`. The list endpoint caps at 3000 files
  // (pagination included) and truncates SILENTLY, so the caller compares its
  // line count against the PR's own `changed_files` and sets this when they
  // disagree. Refusing is the only safe answer: "I could not see the whole
  // diff" is not the same as "the diff is fine".
  if (truncated) {
    return not(
      "TRUNCATED_FILE_LIST",
      `The changed-file list was truncated (${files.length} of a larger diff) — refusing to judge a diff it cannot fully see.`,
      true
    );
  }
  if (policy.malformed.length) {
    return not(
      "MALFORMED_PATH",
      `Changed-file list contains a path the policy cannot reason about: \`${policy.malformed[0].file}\` (${policy.malformed[0].problem}).`,
      true
    );
  }
  if (policy.denied.length) {
    return not(
      "DENIED_PATH",
      `Touches governed path \`${policy.denied[0].file}\` (matched DENIED \`${policy.denied[0].prefix}\`)${policy.denied.length > 1 ? ` and ${policy.denied.length - 1} more` : ""}.`,
      true
    );
  }
  if (policy.unlisted.length) {
    return not(
      "UNLISTED_PATH",
      `Touches non-allowlisted path \`${policy.unlisted[0].file}\`${policy.unlisted.length > 1 ? ` and ${policy.unlisted.length - 1} more` : ""}.`,
      true
    );
  }
  return {
    armed: true,
    code: "OK",
    reason: `All ${files.length} changed file(s) are allowlisted and no label blocks it.`,
    findings,
    needsFounder: false,
    policy,
  };
}

/**
 * The status-check verdict for one PR: does it touch governed paths, and is
 * that approved?
 *
 * -> { verdict, enforced, exitCode, reason, policy, governed: [{file, prefix}] }
 *
 * verdict is one of:
 *   CLEAN       nothing governed touched
 *   APPROVED    governed paths touched, and the approval label is present
 *   UNAPPROVED  governed paths touched, no approval label
 *
 * NOTE 2026-08-16: enforcement is ON in this repo (`PATH_POLICY_ENFORCE=1`), so
 * the default described below is no longer what runs. Read the repo variable, not
 * this default — three agents and a coordinator called the check "report-only" on
 * the strength of this paragraph. A default is not a setting.
 *
 * `exitCode` is 1 only for UNAPPROVED *while enforcing*. Report-only is the
 * shipped default so the check is visible on day one without turning every
 * `.github/` PR red before anyone has agreed it should block; the owner flips
 * one repo variable to make it bite (HUMAN-ACTIONS.md #1).
 */
export function governedCheck(input = {}) {
  const {
    files = [],
    labels = [],
    enforce = false,
    truncated = false,
    approvalLabel = APPROVAL_LABEL,
    denied,
    allowed,
  } = input;

  const policy = pathPolicy(files, { denied, allowed });
  const labelSet = labels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const governed = [
    ...policy.denied,
    ...policy.malformed.map((m) => ({ file: m.file, prefix: `<${m.problem}>` })),
    // A truncated list cannot be certified clean — see automergeDecision.
    ...(truncated ? [{ file: "(changed-file list truncated)", prefix: "<unreadable diff>" }] : []),
  ];
  const approved = labelSet.includes(approvalLabel);

  if (!governed.length) {
    return {
      verdict: "CLEAN",
      enforced: Boolean(enforce),
      exitCode: 0,
      reason: files.length
        ? `None of the ${files.length} changed file(s) touch a governed path.`
        : "No changed files reported.",
      policy,
      governed,
    };
  }
  if (approved) {
    return {
      verdict: "APPROVED",
      enforced: Boolean(enforce),
      exitCode: 0,
      reason: `Touches ${governed.length} governed path(s), and the \`${approvalLabel}\` label is present.`,
      policy,
      governed,
    };
  }
  return {
    verdict: "UNAPPROVED",
    enforced: Boolean(enforce),
    exitCode: enforce ? 1 : 0,
    reason:
      `Touches ${governed.length} governed path(s) without the \`${approvalLabel}\` label.` +
      (enforce ? "" : " Report-only: this check is not enforcing yet (see HUMAN-ACTIONS.md #1)."),
    policy,
    governed,
  };
}

/* --------------------------------------------------------------- reporting */

function bullets(items, render) {
  return items.map((i) => `- ${render(i)}`).join("\n");
}

/**
 * The auto-merge decision, as markdown for the job summary and the log.
 *
 * The FIRST LINE states ARMED or NOT ARMED, because the check being green says
 * only that a decision was recorded. PR #175 (2026-08-16) reported a green
 * check named `enable-automerge` while auto-merge was never armed — the name
 * promised an action and delivered a job status. That is why the job is now
 * called `automerge-decision` and why this text exists.
 */
export function formatDecision(decision, ctx = {}) {
  const { prNumber } = ctx;
  const who = prNumber ? `PR #${prNumber}` : "This PR";
  const lines = [
    `## automerge-decision: ${decision.armed ? "ARMED" : "NOT ARMED"}`,
    "",
    `**${who}: ${decision.reason}**`,
    "",
  ];
  if (decision.findings.length > 1) {
    lines.push("Everything blocking it, not just the first thing:", "");
    lines.push(bullets(decision.findings, (f) => f), "");
  }
  const p = decision.policy;
  lines.push(
    `Paths: ${p.allowed.length} allowlisted, ${p.denied.length} governed, ` +
      `${p.unlisted.length} unlisted, ${p.malformed.length} unreasonable.`,
    ""
  );
  if (p.unlisted.length) {
    lines.push(
      "Unlisted paths are in neither list, so they fail safe to a human. If one",
      "of these should land unread, add it to `ALLOWED_PREFIXES` in",
      "`tools/ci/path-policy.mjs` — that is the whole fix, and it is what #167/#168",
      "did for `STATE.md`:",
      "",
      bullets(p.unlisted, (u) => `\`${u.file}\``),
      ""
    );
  }
  lines.push(
    decision.armed
      ? "Auto-merge has been enabled. `protect-main` still requires `backend` and " +
          "`data-and-site` to pass, so a red PR does not merge."
      : "Auto-merge was NOT enabled. **A green check here does not mean this PR " +
          "will merge** — it means the decision above was reached and recorded. " +
          "Nothing will merge this PR until the reason above is resolved.",
    "",
    `<sub>code: \`${decision.code}\` · policy: \`tools/ci/path-policy.mjs\`</sub>`
  );
  return lines.join("\n");
}

/** The governed-path check, as markdown for the job summary and the log. */
export function formatGovernedCheck(check, ctx = {}) {
  const { prNumber, approvalLabel = APPROVAL_LABEL } = ctx;
  const who = prNumber ? `PR #${prNumber}` : "This PR";
  const headline =
    check.verdict === "CLEAN"
      ? "CLEAN"
      : check.verdict === "APPROVED"
        ? "GOVERNED PATHS — APPROVED"
        : check.enforced
          ? "GOVERNED PATHS — NOT APPROVED (blocking)"
          : "GOVERNED PATHS — NOT APPROVED (report-only)";
  const lines = [`## path-policy: ${headline}`, "", `**${who}: ${check.reason}**`, ""];
  if (check.governed.length) {
    lines.push(bullets(check.governed, (g) => `\`${g.file}\` — matched \`${g.prefix}\``), "");
    lines.push(
      "These paths define the gates, the operating rules, or the deploy " +
        "(`DENIED_PREFIXES` in `tools/ci/path-policy.mjs`).",
      ""
    );
    if (check.verdict === "UNAPPROVED") {
      lines.push(
        `To approve: a founder applies the \`${approvalLabel}\` label to this PR. ` +
          "This check re-runs on label changes, so nothing needs a push.",
        "",
        "**Be clear about what this buys.** It converts a founder *merge* into a " +
          "founder *approval*, and it makes both merge paths — Actions and a " +
          "laptop — answer to the same policy. It is not an absolute block: a repo " +
          "admin with a token can override a required check, and an agent with " +
          "write access can apply this label. Read it as visibility and " +
          "consistency, not as a lock.",
        ""
      );
    }
  }
  lines.push(`<sub>verdict: \`${check.verdict}\` · enforcing: \`${check.enforced}\`</sub>`);
  return lines.join("\n");
}

/** Human-readable dump of the policy itself, for docs and debugging. */
export function formatPolicy() {
  return [
    "DENIED_PREFIXES (checked first, always wins):",
    ...DENIED_PREFIXES.map((p) => `  ${p}`),
    "",
    "ALLOWED_PREFIXES:",
    ...ALLOWED_PREFIXES.map((p) => `  ${p}`),
    "",
    "Matching: a trailing `/` is a directory prefix; anything else matches only",
    "that exact path. Deny matching is case-insensitive.",
  ].join("\n");
}

/* --------------------------------------------------------------------- CLI */

const USAGE = `usage:
  node tools/ci/path-policy.mjs decide  [options]   # arm auto-merge or not
  node tools/ci/path-policy.mjs check   [options]   # governed-path status check
  node tools/ci/path-policy.mjs explain             # print the policy

options:
  --files-from <path|->   newline-separated changed files ("-" = stdin)
  --file <path>           one changed file (repeatable)
  --labels <csv>          PR labels, comma or newline separated
  --labels-from <path>    same, from a file
  --freeze <value>        AUTOMERGE_FREEZE repo variable
  --base <ref>            PR base ref (default: main)
  --pr <number>           PR number, for the report headline only
  --draft                 PR is a draft
  --truncated             the changed-file list is incomplete (the caller's line
                          count disagreed with the PR's own changed_files), so
                          refuse rather than judge a diff it cannot fully see
  --enforce               (check) fail the job on an unapproved governed path
  --approval-label <name> (check) default: ${APPROVAL_LABEL}
  --summary <path>        append the markdown report here ($GITHUB_STEP_SUMMARY)
  --github-output <path>  append key=value outputs here ($GITHUB_OUTPUT)
  --json <path>           write the decision as JSON here`;

const FLAGS_WITH_VALUE = new Set([
  "--files-from",
  "--file",
  "--labels",
  "--labels-from",
  "--freeze",
  "--base",
  "--pr",
  "--approval-label",
  "--summary",
  "--github-output",
  "--json",
]);
const BOOL_FLAGS = new Set(["--draft", "--enforce", "--truncated"]);

/** Parse argv into { command, opts } or throw. Exported for the test suite. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["decide", "check", "explain"].includes(command)) {
    throw new Error(`unknown command: ${command ?? "(none)"}`);
  }
  const opts = { files: [], labels: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (BOOL_FLAGS.has(a)) {
      opts[a.slice(2)] = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(a)) throw new Error(`unknown option: ${a}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--file") opts.files.push(v);
    else opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return { command, opts };
}

/** Split a list that may be comma- or newline-separated. Blank entries dropped. */
export function splitList(text) {
  return String(text ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readListFile(p, io) {
  const text = p === "-" ? io.readStdin() : io.readFile(p);
  // Only newlines here: a filename may legitimately contain a comma, and this
  // input comes from `git diff --name-only` / the GitHub API one path per line.
  //
  // Git does permit a newline INSIDE a filename, which this splitting would cut
  // into two entries. That is fail-safe rather than fail-open: every fragment
  // must be allowlisted for the PR to arm, and a fragment of a denied path
  // still starts with the denied prefix (`.github/wo` matches `.github/`).
  // A crafted name can cost a bot PR a human merge; it cannot buy one.
  return String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const defaultIo = {
  readFile: (p) => fs.readFileSync(p, "utf8"),
  readStdin: () => fs.readFileSync(0, "utf8"),
  append: (p, s) => fs.appendFileSync(p, s),
  write: (p, s) => fs.writeFileSync(p, s),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

/**
 * The CLI, with all I/O injected so the test suite exercises the real thing.
 * -> exit code (0 ok, 1 policy failure, 2 usage error)
 */
export function runCli(argv, io = {}) {
  const $ = { ...defaultIo, ...io };
  let command, opts;
  try {
    ({ command, opts } = parseArgs(argv));
  } catch (err) {
    $.err(err.message);
    $.err(USAGE);
    return 2;
  }

  if (command === "explain") {
    $.log(formatPolicy());
    return 0;
  }

  let files = [...opts.files];
  if (opts.filesFrom) files.push(...readListFile(opts.filesFrom, $));
  let labels = [];
  if (opts.labels) labels.push(...splitList(opts.labels));
  if (opts.labelsFrom) labels.push(...readListFile(opts.labelsFrom, $));

  const emit = (markdown, plainLast, payload) => {
    $.log(markdown);
    if (opts.summary) $.append(opts.summary, markdown + "\n");
    if (opts.json) $.write(opts.json, JSON.stringify(payload, null, 2) + "\n");
    // The last line of the log is the one a human skimming a failed run sees.
    $.log("");
    $.log(plainLast);
  };

  if (command === "decide") {
    const decision = automergeDecision({
      files,
      labels,
      freeze: opts.freeze,
      draft: Boolean(opts.draft),
      truncated: Boolean(opts.truncated),
      baseRef: opts.base ?? "main",
    });
    if (opts.githubOutput) {
      $.append(
        opts.githubOutput,
        [
          `armed=${decision.armed}`,
          `code=${decision.code}`,
          `needs_founder=${decision.needsFounder}`,
          `reason=${decision.reason.replace(/\r?\n/g, " ")}`,
          "",
        ].join("\n")
      );
    }
    emit(
      formatDecision(decision, { prNumber: opts.pr }),
      `${decision.armed ? "ARMED" : "NOT ARMED"}: ${decision.reason}`,
      decision
    );
    // Always 0. "Auto-merge was not armed" is a decision, not a broken job —
    // a red check here would be indistinguishable from CI failing.
    return 0;
  }

  const check = governedCheck({
    files,
    labels,
    enforce: Boolean(opts.enforce),
    truncated: Boolean(opts.truncated),
    approvalLabel: opts.approvalLabel ?? APPROVAL_LABEL,
  });
  if (opts.githubOutput) {
    $.append(
      opts.githubOutput,
      [`verdict=${check.verdict}`, `enforced=${check.enforced}`, ""].join("\n")
    );
  }
  emit(
    formatGovernedCheck(check, {
      prNumber: opts.pr,
      approvalLabel: opts.approvalLabel ?? APPROVAL_LABEL,
    }),
    `path-policy: ${check.verdict}${check.exitCode ? " (blocking)" : ""} — ${check.reason}`,
    check
  );
  return check.exitCode;
}

/* Import-safe: the workflows run it, the tests import it. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(runCli(process.argv.slice(2)));
}

/* Kept so a future reader can find the repo root the same way run-suites.mjs
 * does, without importing it (this module must stay dependency-free of the
 * runner so the runner can be tested without the policy and vice versa). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
