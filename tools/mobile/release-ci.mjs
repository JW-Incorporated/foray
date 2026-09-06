#!/usr/bin/env node
/* The decisions `.github/workflows/release.yml` makes, as testable functions.
 *
 * R-03 (docs/release-lockstep-plan.md). Same rule as `ios-ci.mjs`'s header:
 * NOTHING HERE MAY REPORT A PASS FROM ABSENT DATA, and branch logic belongs in
 * a tested function, not inline in YAML, because this machine is the only one
 * that can run anything before a founder merges.
 *
 * USAGE (subcommands read env / argv and write to stdout / $GITHUB_OUTPUT)
 *   node tools/mobile/release-ci.mjs play-gate
 *   node tools/mobile/release-ci.mjs release-guard <event_name> <ref>
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ─────────────────────────── Play upload gate ─────────────────────────────── */

/** The one secret a Play upload needs.
 *
 *  A ONE-ELEMENT ARRAY, DELIBERATELY, AND SHAPED LIKE `SIGNING_SECRETS` ANYWAY.
 *  `signingReadiness()` in `ios-ci.mjs` has three outcomes because seven
 *  independent secrets can be half-set. Today Play has exactly one credential
 *  (`PLAY_SERVICE_ACCOUNT_JSON`), so `partial` can never be reached — but the
 *  function is written to the same {state, ready, present, missing, message}
 *  shape as its iOS counterpart on purpose, both so the two call sites in
 *  release.yml read identically and so a second Play secret (there is
 *  precedent: Apple needed seven) is a one-line addition here rather than a
 *  rewrite of the caller.
 */
export const PLAY_SECRETS = ["PLAY_SERVICE_ACCOUNT_JSON"];

/**
 * Is the Play internal-track upload configured?
 *
 * Same three-outcome shape as `signingReadiness()`, mirrored intentionally —
 * R-03's ask is "mirroring the iOS signing-gate's three-outcome rule".
 *
 *   ready   — every Play secret present. Upload to the internal track.
 *   absent  — none present. SKIP the upload; the signed `.aab` still ships as
 *             a build artifact. Expected today (HUMAN-ACTIONS.md G2/G3 open).
 *   partial — some present, some not. FAILS. Structurally unreachable with a
 *             single secret, kept for when a second one is added.
 *
 * @param {Record<string,string|undefined>} env
 */
export function playReadiness(env = {}) {
  const present = [];
  const missing = [];
  for (const key of PLAY_SECRETS) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") present.push(key);
    else missing.push(key);
  }
  const state = missing.length === 0 ? "ready" : present.length === 0 ? "absent" : "partial";
  return {
    state,
    ready: state === "ready",
    present,
    missing,
    message:
      state === "ready"
        ? "PLAY_SERVICE_ACCOUNT_JSON present — uploading the signed .aab to the Play internal testing track."
        : state === "absent"
          ? "PLAY_SERVICE_ACCOUNT_JSON is not set, so the Play upload is skipped. The signed .aab still " +
            "ships as a build artifact. Set up G2 (service account) and G3 (first manual upload) in " +
            "HUMAN-ACTIONS.md to unblock this — see docs/release-lockstep-plan.md."
          : `Play upload is HALF configured: ${present.length} of ${PLAY_SECRETS.length} secrets are ` +
            `set and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Failing ` +
            `rather than skipping, because a skipped upload on a green run is invisible.`,
  };
}

/* ───────────────────────────── release guard ──────────────────────────────── */

/**
 * May this run proceed to a real release?
 *
 * R-03: "refuses to run unless `github.ref` is `main` or a tag on `main`."
 * Two ways in:
 *   - `workflow_dispatch` with `github.ref == refs/heads/main` (the manual
 *     button, per docs/release-lockstep-plan.md §5 "workflow_dispatch is the
 *     founder's 'make me something to upload' button").
 *   - `push` of a `refs/tags/v*` ref. The ANCESTRY CHECK — is this tag's
 *     commit actually reachable from `main` — is NOT done in this pure
 *     function: it needs `git merge-base --is-ancestor`, a real repo, and a
 *     real SHA, none of which this function has. The CLI subcommand below
 *     does that check with git and treats a `false` result exactly like an
 *     unmatched ref. That split — pure decision here, git call in the CLI
 *     wrapper — is the same shape `signing-gate` uses for the same reason:
 *     the branch logic is what a fixture-based test can cover with no real
 *     git repo, no GitHub Actions context, and no clone.
 *
 * @param {{eventName: string, ref: string}} input
 *   `eventName` is `github.event_name`. `ref` is `github.ref` (already the
 *   full form, e.g. `refs/heads/main` or `refs/tags/v1.2.0`).
 */
export function releaseGuard({ eventName, ref }) {
  if (eventName === "workflow_dispatch") {
    if (ref === "refs/heads/main") {
      return { allowed: true, reason: "workflow_dispatch on refs/heads/main", requiresAncestryCheck: false };
    }
    return {
      allowed: false,
      reason: `workflow_dispatch is only permitted on refs/heads/main (got '${ref}')`,
      requiresAncestryCheck: false,
    };
  }
  if (eventName === "push") {
    if (typeof ref === "string" && /^refs\/tags\/v/.test(ref)) {
      /* Ancestry is asserted by the CLI wrapper, not here — see the doc
         comment above. */
      return { allowed: true, reason: `push of tag ${ref}`, requiresAncestryCheck: true };
    }
    return {
      allowed: false,
      reason: `push is only permitted for a 'refs/tags/v*' ref (got '${ref}')`,
      requiresAncestryCheck: false,
    };
  }
  return {
    allowed: false,
    reason: `unsupported event '${eventName}' — only workflow_dispatch and push are allowed`,
    requiresAncestryCheck: false,
  };
}

/** The git half of the guard: is `sha` actually reachable from `main`?
 *
 *  A SEPARATE FUNCTION SO IT CAN BE MOCKED. `releaseGuard()`'s own tests run
 *  with no git repo at all; this one is exercised only via the CLI path,
 *  against the real checked-out worktree, using the plumbing command
 *  (`merge-base --is-ancestor`) rather than parsing `git branch --contains`
 *  output, which is subject to what the branch listing happens to include.
 */
export function isAncestorOfMain(sha, { cwd = process.cwd(), git = defaultGit } = {}) {
  try {
    git(["merge-base", "--is-ancestor", sha, "origin/main"], cwd);
    return true;
  } catch {
    return false;
  }
}

function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/* ─────────────────────────── CLI ───────────────────────────────────────────── */

function appendOutput(line) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, `${line}\n`);
  } else {
    console.log(line);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "play-gate") {
      const r = playReadiness(process.env);
      appendOutput(`state=${r.state}`);
      appendOutput(`ready=${r.ready}`);
      appendOutput(`missing=${r.missing.join(",")}`);
      console.error(r.message);
      /* `partial` is the one that fails, same as ios-ci.mjs signing-gate. */
      process.exit(r.state === "partial" ? 1 : 0);
    } else if (cmd === "release-guard") {
      const [eventName, ref] = rest;
      const r = releaseGuard({ eventName, ref });
      if (r.allowed && r.requiresAncestryCheck) {
        const sha = process.env.GITHUB_SHA;
        if (!sha) {
          console.error("release-guard: push event but GITHUB_SHA is not set — cannot verify ancestry");
          appendOutput("allowed=false");
          process.exit(1);
        }
        if (!isAncestorOfMain(sha)) {
          console.error(
            `release-guard: tag ${ref} (${sha}) is not an ancestor of origin/main — refusing to release ` +
              "a tag that was not built from main"
          );
          appendOutput("allowed=false");
          process.exit(1);
        }
      }
      appendOutput(`allowed=${r.allowed}`);
      console.error(r.reason);
      process.exit(r.allowed ? 0 : 1);
    } else {
      console.error("Usage: node tools/mobile/release-ci.mjs <play-gate|release-guard> [args]");
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
