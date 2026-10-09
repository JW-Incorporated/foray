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
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  playReadiness, releaseGuard, isAncestorOfMain, PLAY_SECRETS, ANDROID_SECRETS, PLAY_READINESS_MESSAGES,
} from "./release-ci.mjs";
import { signingReadiness, SIGNING_SECRETS, SIGNING_READINESS_MESSAGES } from "./ios-ci.mjs";
import { readiness } from "../release/readiness.mjs";

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
     gets discovered broken the day it's needed. Since CH2-21 it runs the real
     rule with the Play gate's own words (it used to recompute the state
     inline and so tested nothing). */
  const r = readiness([...PLAY_SECRETS, "SOME_FUTURE_SECRET"], { PLAY_SERVICE_ACCOUNT_JSON: "{}" }, PLAY_READINESS_MESSAGES);
  assert.equal(r.state, "partial");
  assert.equal(r.ready, false);
  assert.equal(
    r.message,
    "Play upload is HALF configured: 1 of 2 secrets are set and SOME_FUTURE_SECRET is missing. " +
      "Failing rather than skipping, because a skipped upload on a green run is invisible."
  );
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

/* ───────────── CH2-21 characterization: the Play gate as it ships ─────────── */

const RELEASE_CI = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-ci.mjs");

const PLAY_READY_MESSAGE =
  "PLAY_SERVICE_ACCOUNT_JSON present — uploading the signed .aab to the Play internal testing track.";
const PLAY_ABSENT_MESSAGE =
  "PLAY_SERVICE_ACCOUNT_JSON is not set, so the Play upload is skipped. The signed .aab still " +
  "ships as a build artifact. Set up G2 (service account) and G3 (first manual upload) in " +
  "HUMAN-ACTIONS.md to unblock this — see docs/release-lockstep-plan.md.";

test("playReadiness over {all present, none, one missing, whitespace-only}: ready / absent / absent / absent, with the shipped messages (CH2-21 characterization)", () => {
  /* MUTATION: reword either message in the shared readiness() table (or let the
     shared function trim differently) -> the exact strings below go red. With
     one Play secret, "one missing" IS "none", so it lands on absent. */
  const all = playReadiness({ PLAY_SERVICE_ACCOUNT_JSON: "{}" });
  assert.deepEqual(all, {
    state: "ready", ready: true, present: ["PLAY_SERVICE_ACCOUNT_JSON"], missing: [], message: PLAY_READY_MESSAGE,
  });
  for (const env of [{}, { OTHER: "x" }, { PLAY_SERVICE_ACCOUNT_JSON: " \t\n" }, { PLAY_SERVICE_ACCOUNT_JSON: "" }]) {
    assert.deepEqual(playReadiness(env), {
      state: "absent", ready: false, present: [], missing: ["PLAY_SERVICE_ACCOUNT_JSON"], message: PLAY_ABSENT_MESSAGE,
    }, JSON.stringify(env));
  }
  /* A non-string value (a number, an object) is not a secret either. */
  assert.equal(playReadiness({ PLAY_SERVICE_ACCOUNT_JSON: 1 }).state, "absent");
});

test("play-gate CLI: prints state / ready / missing, the message on stderr, and exits 0 for absent and ready (CH2-21 characterization)", () => {
  /* MUTATION: make the CLI exit 1 on `absent` (or drop a GITHUB_OUTPUT line)
     -> android-bundle's play_gate step would fail every release today. */
  const run = (extra) => {
    const env = { ...process.env, ...extra };
    delete env.GITHUB_OUTPUT;
    if (!("PLAY_SERVICE_ACCOUNT_JSON" in extra)) delete env.PLAY_SERVICE_ACCOUNT_JSON;
    return spawnSync(process.execPath, [RELEASE_CI, "play-gate"], { env, encoding: "utf8" });
  };
  const absent = run({});
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, "state=absent\nready=false\nmissing=PLAY_SERVICE_ACCOUNT_JSON\n");
  assert.equal(absent.stderr.trim(), PLAY_ABSENT_MESSAGE);
  const ready = run({ PLAY_SERVICE_ACCOUNT_JSON: "{}" });
  assert.equal(ready.status, 0);
  assert.equal(ready.stdout, "state=ready\nready=true\nmissing=\n");
  assert.equal(ready.stderr.trim(), PLAY_READY_MESSAGE);
});

/* ───────────── CH2-21: one readiness() for both gates (T2-11) ─────────────── */

const MSG = Object.freeze({ ready: "R", absent: "A", subject: "Thing" });

test("readiness: ready / absent / partial, missing named in the list's order, is/are agreement", () => {
  /* MUTATION: flip the "is"/"are" agreement, or report missing in env order
     instead of list order -> red. */
  const names = ["A_KEY", "B_KEY", "C_KEY"];
  assert.deepEqual(readiness(names, { A_KEY: "1", B_KEY: "2", C_KEY: "3" }, MSG), {
    state: "ready", ready: true, present: names, missing: [], message: "R",
  });
  assert.deepEqual(readiness(names, undefined, MSG), {
    state: "absent", ready: false, present: [], missing: names, message: "A",
  });
  const one = readiness(names, { C_KEY: "3", A_KEY: "1" }, MSG);
  assert.equal(one.state, "partial");
  assert.deepEqual(one.present, ["A_KEY", "C_KEY"]);
  assert.equal(
    one.message,
    "Thing is HALF configured: 2 of 3 secrets are set and B_KEY is missing. Failing rather than " +
      "skipping, because a skipped upload on a green run is invisible."
  );
  assert.match(readiness(names, { B_KEY: "2" }, MSG).message, /1 of 3 secrets are set and A_KEY, C_KEY are missing\./);
});

test("readiness: only a string with a non-space character counts as present", () => {
  /* MUTATION: drop the trim (or the typeof check) -> a blank or non-string
     secret reads as set, and seven blank secrets read as "ready". */
  for (const blank of ["", " ", "\t\n", undefined, null, 0, 1, {}, true]) {
    assert.equal(readiness(["K"], { K: blank }, MSG).state, "absent", JSON.stringify(blank));
  }
  assert.equal(readiness(["K"], { K: " v " }, MSG).state, "ready");
});

test("both gates ARE readiness(): the same answer for the same env, with their own words", () => {
  /* MUTATION: give either gate its own copy of the rule again with any
     difference (a trim, an order, a state) -> its answers part from
     readiness()'s on one of these envs. */
  const envs = [
    {},
    Object.fromEntries([...SIGNING_SECRETS, ...PLAY_SECRETS].map((k) => [k, "x"])),
    { APPLE_TEAM_ID: "T", PLAY_SERVICE_ACCOUNT_JSON: "  " },
    { IOS_DIST_CERT_P12_BASE64: "p12", APP_STORE_CONNECT_KEY_ID: "\n", PLAY_SERVICE_ACCOUNT_JSON: "{}" },
  ];
  for (const env of envs) {
    assert.deepEqual(playReadiness(env), readiness(PLAY_SECRETS, env, PLAY_READINESS_MESSAGES));
    assert.deepEqual(signingReadiness(env), readiness(SIGNING_SECRETS, env, SIGNING_READINESS_MESSAGES));
  }
});

test("neither gate keeps its own copy of the rule or its partial wording", () => {
  /* MUTATION: paste the old inline loop (or the HALF-configured sentence) back
     into ios-ci.mjs or release-ci.mjs -> red. The partial wording lives once,
     in tools/release/readiness.mjs. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shared = fs.readFileSync(path.join(here, "..", "release", "readiness.mjs"), "utf8");
  assert.match(shared, /HALF configured/);
  for (const f of ["ios-ci.mjs", "release-ci.mjs"]) {
    const src = fs.readFileSync(path.join(here, f), "utf8");
    assert.doesNotMatch(src, /HALF configured/, `${f} spells the partial message itself`);
    assert.doesNotMatch(src, /missing\.length === 0 \? "ready"/, `${f} decides the state itself`);
    assert.match(src, /from "\.\.\/release\/readiness\.mjs"/, `${f} does not import the shared rule`);
  }
});

test("ANDROID_SECRETS is the keystore trio release.yml hands android-bundle, frozen", () => {
  /* MUTATION: drop or rename one -> red here, and release-env-check (which
     builds its list from this one) misses it. */
  assert.deepEqual([...ANDROID_SECRETS], ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS"]);
  assert.ok(Object.isFrozen(ANDROID_SECRETS));
  assert.ok(Object.isFrozen(PLAY_SECRETS));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const yml = fs.readFileSync(path.join(here, "..", "..", ".github", "workflows", "release.yml"), "utf8");
  for (const name of ANDROID_SECRETS) assert.match(yml, new RegExp(`secrets\\.${name}\\b`), name);
});
