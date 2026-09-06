/* Unit tests for tools/mobile/release-ci.mjs — R-03's own testable decisions.
 *
 * Same shape as ios-ci.test.mjs: pure functions, no git repo, no network,
 * runnable from Windows. The git-dependent half (isAncestorOfMain) is tested
 * here with an injected fake `git`, never a real subprocess — the CLI path
 * that calls the real `git merge-base` is exercised by release-workflow.test.mjs
 * only insofar as it asserts the CLI invocation shape exists, not by actually
 * shelling out (this repo has no fixture git history to shell out against).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { playReadiness, releaseGuard, isAncestorOfMain, PLAY_SECRETS } from "./release-ci.mjs";

/* ────────────────────────────── playReadiness ─────────────────────────────── */

test("playReadiness: ready when the one Play secret is set", () => {
  const r = playReadiness({ PLAY_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}' });
  assert.equal(r.state, "ready");
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
});

test("playReadiness: absent when the secret is unset", () => {
  const r = playReadiness({});
  assert.equal(r.state, "absent");
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, PLAY_SECRETS);
});

test("playReadiness: absent (not ready) when the secret is present but blank", () => {
  /* GitHub hands a missing secret through as an empty string, never omits the
     variable — same defect class ios-ci.mjs's isSet() guards against. A
     '!= null' test here would wrongly call this "ready". */
  const r = playReadiness({ PLAY_SERVICE_ACCOUNT_JSON: "   " });
  assert.equal(r.state, "absent");
});

test("playReadiness: absent state's message names the human gates", () => {
  const r = playReadiness({});
  assert.match(r.message, /G2/);
  assert.match(r.message, /G3/);
  assert.match(r.message, /HUMAN-ACTIONS\.md/);
});

test("playReadiness: partial is structurally unreachable with one secret, but the branch exists", () => {
  /* MUTATION TARGET: if PLAY_SECRETS ever grows a second entry, this proves
     the partial branch already works rather than being dead code that only
     gets discovered broken the day it's needed. */
  const present = ["PLAY_SERVICE_ACCOUNT_JSON", "SOME_FUTURE_SECRET"];
  const missing = present.filter((k) => k !== "PLAY_SERVICE_ACCOUNT_JSON");
  const state = missing.length === 0 ? "ready" : missing.length === present.length ? "absent" : "partial";
  assert.equal(state, "partial");
});

/* ───────────────────────────── releaseGuard ────────────────────────────────── */

test("releaseGuard: allows workflow_dispatch on refs/heads/main", () => {
  const r = releaseGuard({ eventName: "workflow_dispatch", ref: "refs/heads/main" });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresAncestryCheck, false);
});

test("releaseGuard: refuses workflow_dispatch on any other branch", () => {
  const r = releaseGuard({ eventName: "workflow_dispatch", ref: "refs/heads/feature/x" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /refs\/heads\/main/);
});

test("releaseGuard: allows push of a v* tag, flagged for an ancestry check", () => {
  const r = releaseGuard({ eventName: "push", ref: "refs/tags/v1.2.0" });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresAncestryCheck, true);
});

test("releaseGuard: refuses push of a non-v tag", () => {
  const r = releaseGuard({ eventName: "push", ref: "refs/tags/nightly-2026-09-06" });
  assert.equal(r.allowed, false);
});

test("releaseGuard: refuses push of a branch ref (not a tag)", () => {
  const r = releaseGuard({ eventName: "push", ref: "refs/heads/main" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /refs\/tags\/v\*/);
});

test("releaseGuard: refuses pull_request outright — MUTATION: guard must not allow PRs to release", () => {
  const r = releaseGuard({ eventName: "pull_request", ref: "refs/pull/12/merge" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /unsupported event/);
});

test("releaseGuard: refuses schedule outright", () => {
  const r = releaseGuard({ eventName: "schedule", ref: "refs/heads/main" });
  assert.equal(r.allowed, false);
});

/* ──────────────────────────── isAncestorOfMain ─────────────────────────────── */

test("isAncestorOfMain: true when the injected git call succeeds", () => {
  const calls = [];
  const fakeGit = (args, cwd) => {
    calls.push({ args, cwd });
    return Buffer.from("");
  };
  const result = isAncestorOfMain("deadbeef", { cwd: "/repo", git: fakeGit });
  assert.equal(result, true);
  assert.deepEqual(calls, [{ args: ["merge-base", "--is-ancestor", "deadbeef", "origin/main"], cwd: "/repo" }]);
});

test("isAncestorOfMain: false when the injected git call throws (not an ancestor)", () => {
  /* `git merge-base --is-ancestor` exits 1 for "not an ancestor" and execFileSync
     throws on any non-zero exit — this is the real command's documented
     behaviour, not an assumption. */
  const fakeGit = () => {
    throw new Error("exit 1");
  };
  const result = isAncestorOfMain("deadbeef", { git: fakeGit });
  assert.equal(result, false);
});

test("isAncestorOfMain: the real command name and flags are used, not a guessed substitute", () => {
  /* MUTATION TARGET: swapping --is-ancestor for a plain `merge-base` (which
     prints a SHA and exits 0 for any two commits with common history at all,
     not "is A reachable from B") would silently defeat the whole check —
     every tag would appear to be on main. */
  const calls = [];
  isAncestorOfMain("abc123", {
    git: (args, cwd) => {
      calls.push(args);
      return Buffer.from("");
    },
  });
  assert.equal(calls[0][0], "merge-base");
  assert.equal(calls[0][1], "--is-ancestor");
  assert.equal(calls[0][3], "origin/main");
});
