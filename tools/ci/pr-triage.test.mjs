/* Tests for PR triage: auto-update, conflict alerting, and the founder queue.
 *
 * The two behaviours most worth pinning are the ones that would be invisible in
 * production if they regressed:
 *   - a conflicting PR gets EXACTLY ONE comment, ever (the anti-babysitting
 *     invariant applied to machinery);
 *   - every update-branch is paired with a dispatch-ci, because a GITHUB_TOKEN
 *     push does not trigger workflows and an unpaired update replaces a green PR
 *     with one whose required checks never report.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

import {
  BLOCK_BEGIN,
  BLOCK_END,
  CONFLICT_LABEL,
  CONFLICT_MARKER,
  QUEUE_LABEL,
  conflictComment,
  gatherPrs,
  hasConflictComment,
  normalizePr,
  parseArgs,
  planFounderQueue,
  planMergeability,
  planTriage,
  ciDispatchIsRedundant,
  recheckArm,
  renderWaitingBlock,
  runCli,
  spliceBlock,
} from "./pr-triage.mjs";

const pr = (over = {}) => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  headRefName: "nightly/x",
  baseRefName: "main",
  draft: false,
  mergeable: "MERGEABLE",
  state: "clean",
  labels: [],
  files: ["data/discover.json"],
  comments: [],
  // security-1: only AUTOMERGE_AUTHORS arm, so the fixture is one of ours.
  user: { login: "github-actions[bot]" },
  ...over,
});

const kinds = (actions) => actions.map((a) => a.kind);

/* -------------------------------------------------------- normalizePr() */

test("REST booleans normalise to the GraphQL vocabulary", () => {
  assert.equal(normalizePr({ mergeable: true }).mergeable, "MERGEABLE");
  assert.equal(normalizePr({ mergeable: false }).mergeable, "CONFLICTING");
  assert.equal(normalizePr({ mergeable: null }).mergeable, "UNKNOWN");
  assert.equal(normalizePr({}).mergeable, "UNKNOWN");
});

test("mergeable_state, mergeStateStatus and state are all read, and lowercased", () => {
  assert.equal(normalizePr({ mergeable_state: "DIRTY" }).state, "dirty");
  assert.equal(normalizePr({ mergeStateStatus: "BEHIND" }).state, "behind");
  assert.equal(normalizePr({ state: "clean" }).state, "clean");
  assert.equal(normalizePr({}).state, "unknown");
});

test("mergeable_state WINS over REST's issue-level `state` on a real payload", () => {
  // The bug this pins, caught in review before it shipped: `gh api
  // repos/O/R/pulls/N` returns BOTH `state:"open"` (the issue state) and
  // `mergeable_state:"behind"`. Reading `state` first made every gathered PR
  // read "open", so `behind` and `dirty` were permanently false and the whole
  // auto-update path was dead — while the suite stayed green, because the
  // fixtures set `state` directly, a shape the REST gatherer never produces.
  const rest = {
    number: 5,
    state: "open",
    mergeable: true,
    mergeable_state: "behind",
    head: { ref: "nightly/x", sha: "abc", repo: { full_name: "o/r" } },
    base: { ref: "main", repo: { full_name: "o/r" } },
  };
  assert.equal(normalizePr(rest).state, "behind");
  const { actions } = planMergeability([rest]);
  assert.deepEqual(kinds(actions), ["update-branch", "dispatch-ci"]);
});

test("a bare REST payload with no merge state does not read as a merge state", () => {
  // "open"/"closed" are issue states and must never be mistaken for one.
  assert.equal(normalizePr({ state: "open" }).state, "unknown");
  assert.equal(normalizePr({ state: "closed" }).state, "unknown");
});

test("REST's dirty state on a full payload still triggers the conflict path", () => {
  const rest = {
    number: 6,
    state: "open",
    mergeable: false,
    mergeable_state: "dirty",
    head: { ref: "b", sha: "s", repo: { full_name: "o/r" } },
    base: { ref: "main", repo: { full_name: "o/r" } },
  };
  assert.deepEqual(kinds(planMergeability([rest]).actions), ["add-label", "comment"]);
});

test("REST head/base shapes normalise, including fork detection", () => {
  const p = normalizePr({
    number: "7",
    html_url: "u",
    head: { ref: "f", repo: { full_name: "someone/foray" } },
    base: { ref: "main", repo: { full_name: "JW-Incorporated/foray" } },
  });
  assert.equal(p.number, 7);
  assert.equal(p.url, "u");
  assert.equal(p.headRefName, "f");
  assert.equal(p.baseRefName, "main");
  assert.equal(p.crossRepo, true);
});

test("a same-repo PR is not cross-repo", () => {
  const p = normalizePr({
    head: { repo: { full_name: "JW-Incorporated/foray" } },
    base: { repo: { full_name: "JW-Incorporated/foray" } },
  });
  assert.equal(p.crossRepo, false);
});

test("labels normalise from strings or {name} objects", () => {
  assert.deepEqual(normalizePr({ labels: ["a", { name: "b" }, null] }).labels, ["a", "b"]);
});

test("isDraft and draft are both honoured", () => {
  assert.equal(normalizePr({ isDraft: true }).draft, true);
  assert.equal(normalizePr({ draft: true }).draft, true);
  assert.equal(normalizePr({}).draft, false);
});

/* -------------------------------------------------- conflict alerting */

test("a conflicting PR is labelled and commented once", () => {
  const { actions } = planMergeability([pr({ mergeable: "CONFLICTING", state: "dirty" })]);
  assert.deepEqual(kinds(actions), ["add-label", "comment"]);
  assert.equal(actions[0].label, CONFLICT_LABEL);
  assert.ok(actions[1].body.includes(CONFLICT_MARKER));
});

test("REST's dirty state alone is enough to detect a conflict", () => {
  // #173 was reported as CONFLICTING/DIRTY. Either spelling must trigger.
  const { actions } = planMergeability([pr({ mergeable: "UNKNOWN", state: "dirty" })]);
  assert.ok(kinds(actions).includes("add-label"));
});

test("the comment is NOT repeated once the marker is present", () => {
  const { actions, notes } = planMergeability([
    pr({ mergeable: "CONFLICTING", state: "dirty", labels: [CONFLICT_LABEL], comments: [{ body: `x ${CONFLICT_MARKER} y` }] }),
  ]);
  assert.deepEqual(actions, [], "nothing left to do — no re-comment, no re-label");
  assert.match(notes.join(" "), /already told once/);
});

test("a still-conflicting PR keeps its label without a second comment", () => {
  const { actions } = planMergeability([
    pr({ mergeable: "CONFLICTING", state: "dirty", comments: [CONFLICT_MARKER] }),
  ]);
  assert.deepEqual(kinds(actions), ["add-label"]);
});

test("hasConflictComment reads plain strings and comment objects", () => {
  assert.equal(hasConflictComment({ comments: [CONFLICT_MARKER] }), true);
  assert.equal(hasConflictComment({ comments: [{ body: CONFLICT_MARKER }] }), true);
  assert.equal(hasConflictComment({ comments: [{ body: "hi" }] }), false);
  assert.equal(hasConflictComment({}), false);
});

test("the comment says it is the only one and names the label that clears itself", () => {
  const body = conflictComment(pr());
  assert.match(body, /only comment this bot will post/);
  assert.match(body, new RegExp(CONFLICT_LABEL));
  assert.match(body, /Never babysit your own PR/);
});

test("the conflict label is removed once the PR is mergeable again", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: true, labels: [CONFLICT_LABEL] })]);
  assert.deepEqual(kinds(actions), ["remove-label"]);
  assert.equal(actions[0].label, CONFLICT_LABEL);
});

test("a clean unlabelled PR that is already armed produces no actions at all", () => {
  assert.deepEqual(planMergeability([pr({ autoMergeEnabled: true })]).actions, []);
});

/* ---------------------------------------------------------- auto-update */

test("a PR that is behind main is updated and CI is re-dispatched", () => {
  const { actions } = planMergeability([pr({ state: "behind" })]);
  assert.deepEqual(kinds(actions), ["update-branch", "dispatch-ci"]);
  assert.equal(actions[1].ref, "nightly/x");
});

test("every update-branch is paired with a dispatch-ci", () => {
  // Unpaired, this fix manufactures the stall it exists to remove: required
  // checks live on the head SHA and a GITHUB_TOKEN push triggers no workflows.
  const { actions } = planMergeability([
    pr({ number: 1, state: "behind" }),
    pr({ number: 2, state: "behind", headRefName: "classify/y" }),
  ]);
  const updated = actions.filter((a) => a.kind === "update-branch").map((a) => a.pr);
  const dispatched = actions.filter((a) => a.kind === "dispatch-ci").map((a) => a.pr);
  assert.deepEqual(updated, dispatched);
});

test("--no-auto-update plans no branch writes", () => {
  const { actions, notes } = planMergeability([pr({ state: "behind" })], { autoUpdate: false });
  assert.deepEqual(actions, []);
  assert.match(notes.join(" "), /auto-update disabled/);
});

test("a held PR's branch is left alone even when behind", () => {
  const { actions, notes } = planMergeability([pr({ state: "behind", labels: ["hold"] })]);
  assert.deepEqual(actions, []);
  assert.match(notes.join(" "), /held/);
});

test("a fork's branch is not updated", () => {
  const { actions, notes } = planMergeability([pr({ state: "behind", crossRepo: true })]);
  assert.deepEqual(actions, []);
  assert.match(notes.join(" "), /fork/);
});

test("UNKNOWN mergeability does nothing and says it will re-check", () => {
  // Guessing MERGEABLE here would auto-update a branch that is really dirty.
  const { actions, notes } = planMergeability([pr({ mergeable: "UNKNOWN", state: "unknown" })]);
  assert.deepEqual(actions, []);
  assert.match(notes.join(" "), /not computed yet/);
});

test("drafts and non-main bases are skipped with a note", () => {
  const { actions, notes } = planMergeability([
    pr({ number: 1, draft: true, state: "behind" }),
    pr({ number: 2, baseRefName: "refresh-digest", state: "behind" }),
  ]);
  assert.deepEqual(actions, []);
  assert.match(notes.join(" "), /draft/);
  assert.match(notes.join(" "), /not main/);
});

test("a conflicting PR is not also auto-updated", () => {
  const { actions } = planMergeability([pr({ mergeable: "CONFLICTING", state: "dirty" })]);
  assert.equal(kinds(actions).includes("update-branch"), false);
});

/* -------------------------------------------------------------- disarming */

test("an armed PR that is no longer allowed gets disarmed", () => {
  // `gh pr merge --auto` is sticky: adding `hold` or pushing a governed-path
  // file does NOT clear it, so re-deciding NOT ARMED and doing nothing let the
  // PR merge anyway. Deciding is only honest if the no branch acts.
  const { actions } = planMergeability([pr({ autoMergeEnabled: true, labels: ["hold"] })]);
  assert.ok(kinds(actions).includes("disable-auto"));
  assert.match(actions.find((a) => a.kind === "disable-auto").reason, /hold/);
});

test("a mid-flight governed-path addition disarms an already-armed PR", () => {
  const { actions } = planMergeability([
    pr({ autoMergeEnabled: true, files: ["data/x.json", ".github/workflows/evil.yml"] }),
  ]);
  assert.ok(kinds(actions).includes("disable-auto"));
});

test("the freeze switch reaches already-armed PRs — that is what makes it a kill switch", () => {
  // Setting a repo variable fires no PR event, so the sweep is the only thing
  // that can disarm what is already armed.
  const { actions } = planMergeability([pr({ autoMergeEnabled: true })], { freeze: "1" });
  assert.ok(kinds(actions).includes("disable-auto"));
});

test("an armed PR that is still allowed is left armed", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: true })]);
  assert.equal(kinds(actions).includes("disable-auto"), false);
});

test("a PR that was never armed is not disarmed", () => {
  const { actions } = planMergeability([pr({ labels: ["hold"] })]);
  assert.deepEqual(actions, []);
});

test("REST's auto_merge object and GraphQL's autoMergeRequest both read as armed", () => {
  assert.equal(normalizePr({ auto_merge: { merge_method: "squash" } }).autoMergeEnabled, true);
  assert.equal(normalizePr({ autoMergeRequest: {} }).autoMergeEnabled, true);
  assert.equal(normalizePr({ auto_merge: null }).autoMergeEnabled, false);
  assert.equal(normalizePr({}).autoMergeEnabled, false);
});

/* ------------------------------------------------------------- arming */
// t_a25ea475: the sweep was disarm-only. A PR the policy would approve, with
// autoMergeEnabled still false, was never re-decided by anything unless a
// qualifying `pull_request` event fired — making "CLEAN + unarmed" an
// absorbing state. These pin the arm-on-clean symmetry that closes it.

test("a mergeable, policy-approved PR that was never armed gets armed", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false })]);
  assert.ok(kinds(actions).includes("enable-auto"));
  const action = actions.find((a) => a.kind === "enable-auto");
  assert.equal(action.pr, 1);
  assert.equal(action.headSha, "");
});

test("enable-auto carries the head SHA so arming binds to the judged commit", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false, headSha: "abc123" })]);
  const action = actions.find((a) => a.kind === "enable-auto");
  assert.equal(action.headSha, "abc123");
});

test("a mergeable PR the policy would reject (hold) is not armed", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false, labels: ["hold"] })]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("a mergeable PR touching a governed path is not armed", () => {
  const { actions } = planMergeability([
    pr({ autoMergeEnabled: false, files: ["data/x.json", ".github/workflows/evil.yml"] }),
  ]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("freeze prevents arming a not-yet-armed PR too — no half-a-kill-switch", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false })], { freeze: "1" });
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("CONFLICTING PRs are never armed, even though they read MERGEABLE=false not true", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false, mergeable: "CONFLICTING", state: "dirty" })]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("UNKNOWN mergeability is never armed — ask again next sweep, never assume fine", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: false, mergeable: "UNKNOWN", state: "unknown" })]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("an already-armed, still-approved PR is not re-armed (no duplicate enable-auto)", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: true })]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
  assert.equal(kinds(actions).includes("disable-auto"), false);
});

/* ------------------------------------------------- checks-missing self-heal */

const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

test("a stale head with none of the required checks is re-dispatched on the sweep", () => {
  // The backstop for a lost dispatch after an auto-update: without it, one lost
  // race strands the PR at "Expected — waiting for status to be reported"
  // forever, because it is no longer `behind` and nothing looks again.
  // `autoMergeEnabled: true` isolates this from the (separate) arm-on-clean
  // path above: this test is about the self-heal dispatch, not arming.
  const { actions, notes } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: [], updatedAt: OLD })],
    { sweep: true }
  );
  assert.deepEqual(kinds(actions), ["dispatch-ci"]);
  assert.match(notes.join(" "), /re-dispatching CI/);
});

test("the self-heal fires on a PR event too, not only on the 6-hourly sweep", () => {
  /* MUTATION: restore `sweep &&` to the self-heal's condition. This plans
     nothing and the assertion fails.

     Hole 1 of three (machinery audit, 2026-09-12). The heal used to require
     `--sweep`, which only the six-hourly cron run passed, so a stranded head
     waited up to 6.5 hours. The event that CREATES the stall is a PR event
     outside ci.yml's three defaults — `edited`, `labeled`, `unlabeled` — and
     pr-hygiene.yml is subscribed to those, so the run that could heal it was
     already happening and declining to. The age gate below is what keeps this
     from double-dispatching on `synchronize`. */
  const { actions } = planMergeability([pr({ autoMergeEnabled: true, checkNames: [], updatedAt: OLD })]);
  assert.deepEqual(kinds(actions), ["dispatch-ci"]);
});

test("a freshly-updated PR is not re-dispatched into its own CI run", () => {
  const { actions } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: [], updatedAt: new Date().toISOString() })],
    { sweep: true }
  );
  assert.deepEqual(actions, []);
});

test("the age gate reads the head commit's clock, not the PR's updatedAt", () => {
  /* MUTATION: go back to `const age = pr.updatedAt ? ... : Infinity`. The first
     case below then reads the PR as seconds old and plans nothing.

     Hole 2 of three. `updatedAt` is reset by a comment, a label, a review or a
     title edit — and pr-hygiene is itself a label writer, so a PR it labels
     every six hours could never age past a gate keyed on `updatedAt`. The head
     commit's date moves only when the head moves, which is the event whose
     checks are missing. The second case is the converse and is the one that
     would go wrong if the fallback were dropped: a real head that is NEW while
     the PR record is old must still be left alone. */
  const stuck = planMergeability([
    pr({ autoMergeEnabled: true, checkNames: [], headCommittedAt: OLD, updatedAt: new Date().toISOString() }),
  ]);
  assert.deepEqual(kinds(stuck.actions), ["dispatch-ci"]);

  const starting = planMergeability([
    pr({ autoMergeEnabled: true, checkNames: [], headCommittedAt: new Date().toISOString(), updatedAt: OLD }),
  ]);
  assert.deepEqual(starting.actions, []);
});

test("a head missing ONE required check is re-dispatched — a partial dispatch is still a stall", () => {
  /* MUTATION: restore `missing.length === requiredChecks.length`. `backend`
     reported and `data-and-site` never did, so `missing` is 1 of 2 and the
     all-or-nothing test is false: nothing is planned, and the PR sits at
     "Expected — waiting for status to be reported" forever because it is no
     longer `behind` and nothing else ever looks at it again.

     Hole 3 of three. */
  const { actions, notes } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: ["backend"], updatedAt: OLD })],
    { sweep: true }
  );
  assert.deepEqual(kinds(actions), ["dispatch-ci"]);
  assert.match(notes.join(" "), /missing data-and-site/);
});

test("a head carrying every required check is left alone", () => {
  /* The other side of the previous test: `> 0` must not mean `>= 0`. Extra
     check runs beyond the required set (Vercel, automerge-decision) are not
     the self-heal's business either. */
  const { actions } = planMergeability(
    [
      pr({
        autoMergeEnabled: true,
        checkNames: ["backend", "data-and-site", "Vercel Preview Comments"],
        updatedAt: OLD,
      }),
    ],
    { sweep: true }
  );
  assert.deepEqual(actions, []);
});

test("the self-heal does not touch forks, whose branches we cannot dispatch on", () => {
  const { actions } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: [], updatedAt: OLD, crossRepo: true })],
    { sweep: true }
  );
  // No dispatch. The one action left is security-1's: an armed fork PR is
  // taken back off auto-merge (see the arming tests below).
  assert.deepEqual(kinds(actions), ["disable-auto"]);
});

/* ------------------------------------------- the duplicate-dispatch guard */

test("a SHA that already has a pull_request run needs no dispatch", () => {
  /* MUTATION: return `false` unconditionally (or drop the `!== "workflow_dispatch"`
     half so a dispatch counts as its own precedent). Measured 2026-09-12 over
     the last 200 `ci.yml` runs: 178 distinct SHAs, 26 dispatch runs, 22 of them
     duplicating a `pull_request` run on the same SHA, usually 1–4 seconds apart
     — 85% of every dispatched run was waste. */
  assert.equal(ciDispatchIsRedundant([{ event: "pull_request" }]), true);
  assert.equal(ciDispatchIsRedundant([{ event: "push" }]), true);
  assert.equal(ciDispatchIsRedundant(["pull_request"]), true);
});

test("a SHA with only dispatch runs — or none at all — still needs the dispatch", () => {
  /* The direction that must never go wrong. The self-heal exists because a head
     can end up with no run at all; answering "redundant" there would strand the
     PR forever, which is the failure this whole file is about. A previous
     dispatch is not evidence either: if it had produced the checks, the heal
     would not have been planned. */
  assert.equal(ciDispatchIsRedundant([]), false);
  assert.equal(ciDispatchIsRedundant(), false);
  assert.equal(ciDispatchIsRedundant(null), false);
  assert.equal(ciDispatchIsRedundant([{ event: "workflow_dispatch" }]), false);
  assert.equal(ciDispatchIsRedundant([{}, { event: "" }]), false);
});

test("a conflicting PR is not re-dispatched — its problem is not missing checks", () => {
  const { actions } = planMergeability(
    [pr({ mergeable: "CONFLICTING", state: "dirty", checkNames: [], updatedAt: OLD })],
    { sweep: true }
  );
  assert.equal(kinds(actions).includes("dispatch-ci"), false);
});

/* --------------------------------------------------------- founder queue */

test("a PR touching a denied path is queued and labelled", () => {
  const { queue, actions } = planFounderQueue([pr({ files: [".github/workflows/ci.yml"] })]);
  assert.equal(queue.length, 1);
  assert.match(queue[0].reason, /\.github/);
  assert.deepEqual(kinds(actions), ["add-label"]);
  assert.equal(actions[0].label, QUEUE_LABEL);
});

test("a PR that will auto-merge is not queued", () => {
  const { queue, actions } = planFounderQueue([pr()]);
  assert.deepEqual(queue, []);
  assert.deepEqual(actions, []);
});

test("the queue label is removed once the reason is gone", () => {
  const { actions } = planFounderQueue([pr({ labels: [QUEUE_LABEL] })]);
  assert.deepEqual(kinds(actions), ["remove-label"]);
});

test("a conflicting PR is not queued to a founder — that is the author's job", () => {
  const { queue } = planFounderQueue([
    pr({ mergeable: "CONFLICTING", state: "dirty", files: ["index.html"] }),
  ]);
  assert.deepEqual(queue, []);
});

test("a held PR is not queued, a founder-decision PR is", () => {
  assert.equal(planFounderQueue([pr({ labels: ["hold"] })]).queue.length, 0);
  assert.equal(planFounderQueue([pr({ labels: ["founder-decision"] })]).queue.length, 1);
});

test("a freeze does not fill the queue with every open PR", () => {
  const { queue } = planFounderQueue([pr(), pr({ number: 2 })], { freeze: "1" });
  assert.deepEqual(queue, []);
});

test("the queue is sorted by PR number", () => {
  const { queue } = planFounderQueue([
    pr({ number: 9, files: ["CLAUDE.md"] }),
    pr({ number: 3, files: ["CLAUDE.md"] }),
  ]);
  assert.deepEqual(queue.map((q) => q.number), [3, 9]);
});

test("drafts never reach the queue", () => {
  assert.deepEqual(planFounderQueue([pr({ draft: true, files: ["CLAUDE.md"] })]).queue, []);
});

/* ------------------------------------------------------------ planTriage */

test("planTriage merges both planners and deduplicates actions", () => {
  const { actions, queue } = planTriage([
    pr({ number: 1, state: "behind" }),
    pr({ number: 2, files: ["CLAUDE.md"] }),
  ]);
  assert.deepEqual(queue.map((q) => q.number), [2]);
  assert.ok(kinds(actions).includes("update-branch"));
  assert.ok(kinds(actions).includes("add-label"));
  const keys = actions.map((a) => `${a.kind}:${a.pr}:${a.label ?? a.ref ?? ""}`);
  assert.equal(new Set(keys).size, keys.length, "actions must be unique");
});

test("planTriage on no PRs is empty, not an error", () => {
  assert.deepEqual(planTriage([]), { actions: [], notes: [], queue: [] });
  assert.deepEqual(planTriage(undefined).actions, []);
});

/* ------------------------------------------------------------- rendering */

test("an empty queue renders as 'nothing is waiting'", () => {
  const b = renderWaitingBlock([]);
  assert.match(b, /Nothing is waiting on a founder right now/);
  assert.ok(b.startsWith(BLOCK_BEGIN));
  assert.ok(b.endsWith(BLOCK_END));
});

test("the block is byte-identical across renders — no timestamp, no run id", () => {
  // A block that always differs produces a commit every sweep and teaches
  // everyone to ignore it.
  const q = planFounderQueue([pr({ files: ["CLAUDE.md"] })]).queue;
  assert.equal(renderWaitingBlock(q), renderWaitingBlock(q));
});

test("the block renders a table row per queued PR with a link", () => {
  const b = renderWaitingBlock([
    { number: 4, title: "T", url: "https://x/4", reason: "R", code: "DENIED_PATH" },
  ]);
  assert.match(b, /\[#4\]\(https:\/\/x\/4\)/);
  assert.match(b, /\| T \| R \|/);
});

test("pipes and newlines in a PR title cannot break the table", () => {
  const b = renderWaitingBlock([{ number: 1, title: "a | b\nc", reason: "r|r" }]);
  const row = b.split("\n").find((l) => l.includes("#1"));
  // Exactly the 4 structural pipes of a 3-column row; the title's own pipe and
  // the reason's are escaped, and the newline is folded to a space.
  assert.equal((row.match(/(^|[^\\])\|/g) || []).length, 4, row);
  assert.match(row, /a \\\| b c/);
});

test("a PR title cannot inject the block's own end marker", () => {
  // spliceBlock finds the FIRST BLOCK_END, so an injected one would make the
  // next --write splice mid-block, duplicating half of it and orphaning the
  // real marker. PR titles are untrusted text.
  const b = renderWaitingBlock([{ number: 1, title: BLOCK_END, reason: BLOCK_BEGIN }]);
  assert.equal(b.split(BLOCK_END).length - 1, 1, "exactly one real end marker");
  assert.equal(b.split(BLOCK_BEGIN).length - 1, 1, "exactly one real begin marker");
  // And the round trip still behaves.
  const once = spliceBlock("# H\n", b);
  assert.equal(spliceBlock(once, b), once);
});

test("an approved PR is marked as needing only the merge", () => {
  const b = renderWaitingBlock([
    { number: 3, title: "t", reason: "r", approved: true },
    { number: 4, title: "u", reason: "s", approved: false },
  ]);
  assert.match(b, /#3.*approved — just needs the merge/);
  assert.doesNotMatch(b.split("\n").find((l) => l.includes("#4")), /approved/);
});

test("planFounderQueue reports the approval state from the label", () => {
  const q = planFounderQueue([pr({ files: ["CLAUDE.md"], labels: ["founder-approved"] })]).queue;
  assert.equal(q[0].approved, true);
  assert.equal(planFounderQueue([pr({ files: ["CLAUDE.md"] })]).queue[0].approved, false);
});

test("approval does NOT remove a PR from the queue — a founder still merges it", () => {
  // The docs must match this: `founder-approved` makes the path-policy CHECK
  // green; it does not arm auto-merge on a governed path.
  const { queue } = planFounderQueue([
    pr({ files: ["CLAUDE.md"], labels: ["founder-approved"] }),
  ]);
  assert.equal(queue.length, 1);
});

test("the block carries the live filter URL for the queue label", () => {
  assert.match(renderWaitingBlock([], { repo: "o/r" }), /o\/r\/pulls\?q=.*needs-founder/);
});

test("the block tells the reader how to stop a category recurring", () => {
  const b = renderWaitingBlock([{ number: 1, title: "t", reason: "r" }]);
  assert.match(b, /ALLOWED_PREFIXES/);
});

/* ------------------------------------------------------------ spliceBlock */

test("splicing into a file with no markers appends the block", () => {
  const out = spliceBlock("# Title\n", renderWaitingBlock([]));
  assert.ok(out.startsWith("# Title\n"));
  assert.ok(out.includes(BLOCK_BEGIN));
});

test("splicing is idempotent", () => {
  const block = renderWaitingBlock([]);
  const once = spliceBlock("# T\n", block);
  assert.equal(spliceBlock(once, block), once);
});

test("splicing replaces the previous block rather than appending a second", () => {
  const a = renderWaitingBlock([]);
  const b = renderWaitingBlock([{ number: 2, title: "t", reason: "r" }]);
  const out = spliceBlock(spliceBlock("# T\n", a), b);
  assert.equal(out.split(BLOCK_BEGIN).length - 1, 1);
  assert.match(out, /#2/);
  assert.doesNotMatch(out, /Nothing is waiting/);
});

test("splicing preserves text on both sides of the block", () => {
  const seeded = `before\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\nafter\n`;
  const out = spliceBlock(seeded, renderWaitingBlock([]));
  assert.ok(out.startsWith("before\n"));
  assert.ok(out.endsWith("\nafter\n"));
  assert.doesNotMatch(out, /old/);
});

test("an unbalanced block is a hard error, not a guess", () => {
  assert.throws(() => spliceBlock(`x\n${BLOCK_BEGIN}\ny\n`, "b"), /unbalanced/);
  assert.throws(() => spliceBlock(`x\n${BLOCK_END}\ny\n`, "b"), /unbalanced/);
  assert.throws(() => spliceBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`, "b"), /unbalanced/);
});

test("splicing into an empty file works", () => {
  assert.ok(spliceBlock("", renderWaitingBlock([])).includes(BLOCK_BEGIN));
});

/* ------------------------------------------------------------- gatherPrs */

function fakeGh(responses) {
  const calls = [];
  return {
    calls,
    exec: (args) => {
      calls.push(args.join(" "));
      for (const [pattern, out] of responses) {
        if (args.join(" ").includes(pattern)) return out;
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  };
}

test("gatherPrs resolves the repo, lists open PRs and attaches files and comments", () => {
  const gh = fakeGh([
    ["pulls?state=open", "4\n"],
    ["pulls/4/files", '[{"filename":"data/a.json","previous_filename":null}]\n'],
    ["issues/4/comments", '["hello"]\n'],
    ["pulls/4", JSON.stringify({ number: 4, mergeable: true })],
  ]);
  const prs = gatherPrs({ repo: "o/r", exec: gh.exec });
  assert.equal(prs.length, 1);
  assert.deepEqual(normalizePr(prs[0]).files, ["data/a.json"]);
  assert.deepEqual(prs[0].comments, ["hello"]);
  assert.ok(gh.calls.every((c) => c.includes("o/r")), gh.calls.join("\n"));
});

test("gatherPrs concatenates paginated pages instead of parsing one document", () => {
  const gh = fakeGh([
    ["pulls?state=open", "1\n"],
    ["pulls/1/files", '[{"filename":"a"}]\n[{"filename":"b"}]\n'],
    ["issues/1/comments", "\n"],
    ["pulls/1", "{}"],
  ]);
  assert.deepEqual(normalizePr(gatherPrs({ repo: "o/r", exec: gh.exec })[0]).files, ["a", "b"]);
});

test("gatherPrs asks gh for the repo when none is given", () => {
  const gh = fakeGh([
    ["repo view", "o/r\n"],
    ["pulls?state=open", ""],
  ]);
  assert.deepEqual(gatherPrs({ exec: gh.exec }), []);
  assert.ok(gh.calls[0].includes("repo view"));
});

test("gatherPrs throws rather than returning an empty list it cannot justify", () => {
  const gh = fakeGh([["repo view", "\n"]]);
  assert.throws(() => gatherPrs({ exec: gh.exec }), /could not determine the repository/);
});

test("omitting --from gathers rather than assuming an empty queue", () => {
  // The footgun this guards: `waiting --write` with no data would render
  // "nothing is waiting" and commit it over a real list.
  const gh = fakeGh([
    ["pulls?state=open", "8\n"],
    ["pulls/8/files", '[{"filename":"CLAUDE.md"}]\n'],
    ["issues/8/comments", "[]\n"],
    ["pulls/8", JSON.stringify({ number: 8, title: "t", mergeable: true, base: { ref: "main" } })],
  ]);
  const h = harness({ "HUMAN-ACTIONS.md": "# H\n" });
  assert.equal(runCli(["waiting", "--write", "--repo", "o/r"], { ...h.io, exec: gh.exec }), 0);
  assert.match(h.written["HUMAN-ACTIONS.md"], /#8/);
});

test("a gh failure is an error, not an empty queue", () => {
  const h = harness({ "HUMAN-ACTIONS.md": "# H\n" });
  const exec = () => {
    throw new Error("gh: not found");
  };
  assert.equal(runCli(["waiting", "--write", "--repo", "o/r"], { ...h.io, exec }), 2);
  assert.deepEqual(h.written, {});
});

/* -------------------------------------------------------------------- CLI */

test("parseArgs rejects unknown commands, flags and missing values", () => {
  assert.throws(() => parseArgs(["nope"]), /unknown command/);
  assert.throws(() => parseArgs(["plan", "--wat"]), /unknown option/);
  assert.throws(() => parseArgs(["plan", "--from"]), /needs a value/);
});

test("parseArgs camel-cases --no-auto-update", () => {
  assert.equal(parseArgs(["plan", "--no-auto-update"]).opts.noAutoUpdate, true);
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
      writeFile: (p, s) => (written[p] = s),
      append: (p, s) => (appended[p] = (appended[p] ?? "") + s),
      exists: (p) => p in files,
      log: (s) => out.push(String(s)),
      err: (s) => out.push(String(s)),
    },
  };
}

test("CLI rejects non-JSON and non-array --from with exit 2", () => {
  assert.equal(runCli(["plan", "--from", "f"], harness({ f: "{" }).io), 2);
  assert.equal(runCli(["plan", "--from", "f"], harness({ f: "{}" }).io), 2);
});

test("CLI plan writes one JSON line per action", () => {
  const h = harness({ f: JSON.stringify([pr({ state: "behind" })]) });
  assert.equal(runCli(["plan", "--from", "f", "--actions", "A"], h.io), 0);
  const lines = h.written.A.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["update-branch", "dispatch-ci"]);
});

test("CLI plan writes an empty actions file when there is nothing to do", () => {
  const h = harness({ f: JSON.stringify([pr({ autoMergeEnabled: true })]) });
  runCli(["plan", "--from", "f", "--actions", "A"], h.io);
  assert.equal(h.written.A, "");
});

test("CLI plan appends a summary that includes the waiting block", () => {
  const h = harness({ f: JSON.stringify([pr({ files: ["CLAUDE.md"] })]) });
  runCli(["plan", "--from", "f", "--summary", "S"], h.io);
  assert.match(h.appended.S, /## pr-hygiene/);
  assert.match(h.appended.S, new RegExp(BLOCK_BEGIN.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&")));
});

test("CLI plan --partial refuses to render a queue it could not have seen", () => {
  // A pull_request run examines ONE PR. Rendering "nothing is waiting on a
  // founder" from a sample of one is exactly the false reassurance this change
  // set exists to remove.
  const h = harness({ f: JSON.stringify([pr()]) });
  runCli(["plan", "--from", "f", "--partial", "--summary", "S"], h.io);
  assert.doesNotMatch(h.appended.S, /Nothing is waiting on a founder/);
  assert.match(h.appended.S, /Scoped to one PR/);
});

test("CLI plan without --partial does render the queue", () => {
  const h = harness({ f: JSON.stringify([pr()]) });
  runCli(["plan", "--from", "f", "--summary", "S"], h.io);
  assert.match(h.appended.S, /Nothing is waiting on a founder/);
});

test("CLI waiting --print writes no file", () => {
  const h = harness({ f: "[]" });
  assert.equal(runCli(["waiting", "--from", "f", "--print"], h.io), 0);
  assert.deepEqual(h.written, {});
  assert.match(h.out.join("\n"), /Nothing is waiting/);
});

test("CLI waiting with no mode defaults to printing", () => {
  const h = harness({ f: "[]" });
  assert.equal(runCli(["waiting", "--from", "f"], h.io), 0);
  assert.deepEqual(h.written, {});
});

test("CLI waiting --write splices the file", () => {
  const h = harness({ f: JSON.stringify([pr({ files: ["CLAUDE.md"] })]), "HUMAN-ACTIONS.md": "# H\n" });
  assert.equal(runCli(["waiting", "--from", "f", "--write"], h.io), 0);
  assert.match(h.written["HUMAN-ACTIONS.md"], /#1/);
});

test("CLI waiting --write is a no-op the second time", () => {
  const seeded = spliceBlock("# H\n", renderWaitingBlock([]));
  const h = harness({ f: "[]", "HUMAN-ACTIONS.md": seeded });
  assert.equal(runCli(["waiting", "--from", "f", "--write"], h.io), 0);
  assert.deepEqual(h.written, {}, "nothing to write means nothing written");
  assert.match(h.out.join("\n"), /already up to date/);
});

test("CLI waiting --check exits 1 when the committed block is stale", () => {
  const seeded = spliceBlock("# H\n", renderWaitingBlock([]));
  const stale = harness({
    f: JSON.stringify([pr({ files: ["CLAUDE.md"] })]),
    "HUMAN-ACTIONS.md": seeded,
  });
  assert.equal(runCli(["waiting", "--from", "f", "--check"], stale.io), 1);

  const fresh = harness({ f: "[]", "HUMAN-ACTIONS.md": seeded });
  assert.equal(runCli(["waiting", "--from", "f", "--check"], fresh.io), 0);
});

test("CLI waiting on an unbalanced file exits 2 rather than eating an edit", () => {
  const h = harness({ f: "[]", "HUMAN-ACTIONS.md": `x\n${BLOCK_BEGIN}\ny\n` });
  assert.equal(runCli(["waiting", "--from", "f", "--write"], h.io), 2);
  assert.deepEqual(h.written, {});
});

test("CLI waiting --file targets another path", () => {
  const h = harness({ f: "[]", OTHER: "# O\n" });
  runCli(["waiting", "--from", "f", "--write", "--file", "OTHER"], h.io);
  assert.ok(h.written.OTHER.includes(BLOCK_BEGIN));
});

test("CLI reads PRs from stdin", () => {
  const h = harness({ "-": "[]" });
  assert.equal(runCli(["plan", "--from", "-"], h.io), 0);
});

/* ------------------------------------------ security-1: the sweep and outsiders */

const FORK = {
  head: { ref: "patch-1", sha: "f00", repo: { full_name: "stranger/foray" } },
  base: { ref: "main", repo: { full_name: "JW-Incorporated/foray" } },
  user: { login: "stranger" },
};

test("security-1: a clean fork PR touching only data/ produces no enable-auto — and queues for a founder", () => {
  /* The live hole: the hourly sweep armed a returning outside contributor's
     green fork PR, and the executor merged it directly on "clean status".
     MUTATION: drop `author`/`crossRepo` from pr-triage's decide() -> the PR is
     armed again and this fails. */
  const raw = pr({ ...FORK, crossRepo: undefined, headRefName: undefined, baseRefName: undefined, autoMergeEnabled: false });
  const { actions, queue } = planTriage([raw]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].code, "FOREIGN_AUTHOR");
});

test("security-1: a same-repo PR from an author not on the list is not armed either", () => {
  const { actions } = planMergeability([pr({ user: { login: "someone-else" }, autoMergeEnabled: false })]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
});

test("security-1: an armed fork PR is DISARMED by the sweep", () => {
  // `--auto` is sticky; if anything ever armed one, the sweep takes it back.
  const { actions } = planMergeability([pr({ ...FORK, crossRepo: undefined, autoMergeEnabled: true })]);
  assert.ok(kinds(actions).includes("disable-auto"));
});

test("security-1: a fork whose repository was deleted (head.repo null) still reads as a fork", () => {
  const n = normalizePr({ head: { ref: "x", repo: null }, base: { repo: { full_name: "o/r" } } });
  assert.equal(n.crossRepo, true);
  assert.equal(normalizePr({ head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } }).crossRepo, false);
});

test("security-1: the author comes from REST `user.login` and from gh's `author.login`", () => {
  assert.equal(normalizePr({ user: { login: "wjduvall-cmd" } }).author, "wjduvall-cmd");
  assert.equal(normalizePr({ author: { login: "app/github-actions" } }).author, "app/github-actions");
});

/* ------------------------------------------ ci-release-2 / -7: the file list */

test("ci-release-2: a rename out of CLAUDE.md is seen as CLAUDE.md, and is not armed", () => {
  /* MUTATION: have expandFileEntry ignore previous_filename -> only the
     allowlisted docs/ path is judged and the PR arms. */
  const raw = pr({ files: [{ filename: "docs/CLAUDE-old.md", previous_filename: "CLAUDE.md" }], changed_files: 1 });
  assert.deepEqual(normalizePr(raw).files, ["docs/CLAUDE-old.md", "CLAUDE.md"]);
  const { actions, queue } = planTriage([raw]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
  assert.equal(queue[0].code, "DENIED_PATH");
});

test("ci-release-2: a rename out of tools/ci/ is denied the same way", () => {
  const raw = pr({ files: [{ filename: "tools/old/pr-triage.mjs", previous_filename: "tools/ci/pr-triage.mjs" }] });
  assert.equal(planTriage([raw]).queue[0].code, "DENIED_PATH");
});

test("ci-release-7: the sweep refuses a truncated file list, as automerge-nightly does", () => {
  /* The sweep's ARM path used to skip this guard and re-arm PRs that
     automerge-nightly had refused. MUTATION: drop `truncated` from decide(). */
  const raw = pr({ files: ["data/a.json"], changed_files: 3001, autoMergeEnabled: false });
  assert.equal(normalizePr(raw).truncated, true);
  const { actions, queue } = planTriage([raw]);
  assert.equal(kinds(actions).includes("enable-auto"), false);
  assert.equal(queue[0].code, "TRUNCATED_FILE_LIST");
  // ...and an ARMED truncated PR is disarmed.
  const armed = planMergeability([{ ...raw, autoMergeEnabled: true }]);
  assert.ok(kinds(armed.actions).includes("disable-auto"));
});

test("ci-release-7: a rename is ONE entry against changed_files, not two, so it is not a truncation", () => {
  const raw = pr({ files: [{ filename: "data/b.json", previous_filename: "data/a.json" }], changed_files: 1 });
  assert.equal(normalizePr(raw).truncated, false);
  assert.ok(kinds(planMergeability([raw]).actions).includes("enable-auto"));
});

/* ------------------------------------------------ ci-release-17: every open PR */

test("ci-release-17: gatherPrs paginates the open-PR list instead of stopping at 100", () => {
  /* MUTATION: go back to `gh pr list --limit 100`. */
  const gh = fakeGh([["pulls?state=open", "1\n"], ["pulls/1/files", "[]\n"], ["issues/1/comments", "[]\n"], ["pulls/1", "{}"]]);
  gatherPrs({ repo: "o/r", exec: gh.exec });
  const list = gh.calls.find((c) => c.includes("pulls?state=open"));
  assert.match(list, /--paginate/);
  assert.equal(gh.calls.some((c) => /--limit/.test(c)), false);
});

test("ci-release-17: pr-hygiene.yml's sweep gathers with pagination and no 100 cap", () => {
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/pr-hygiene.yml"), "utf8");
  assert.doesNotMatch(yml, /--limit 100/);
  assert.match(yml, /gh api --paginate "repos\/\$REPO\/pulls\?state=open&per_page=100"/);
});

/* ------------------------------------------------ ci-release-9: concurrency */

test("ci-release-9: pr-hygiene runs the sweep and each PR in their own groups, and re-reads comments before posting", () => {
  /* A single global group keeps ONE pending run and cancels the older one, so
     a burst of PR events dropped the hourly sweep. MUTATION: put back
     `group: pr-hygiene`, or drop the marker re-read in the comment action. */
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/pr-hygiene.yml"), "utf8");
  const conc = yml.slice(yml.indexOf("\nconcurrency:"), yml.indexOf("\njobs:"));
  assert.match(conc, /pr-hygiene-pr-\{0\}/);
  assert.match(conc, /'pr-hygiene-sweep'/);
  assert.doesNotMatch(conc, /group: pr-hygiene\s*$/m);
  assert.match(yml, /comment\)[\s\S]{0,800}grep -qF "\$marker"/, "the comment action must re-read the PR's comments for the marker first");
});

/* ------------------------------------------------ ci-release-10: the dispatch guard */

test("ci-release-10: a cancelled, startup_failure or skipped pull_request run is NOT coverage", () => {
  /* MUTATION: go back to looking at `event` alone -> each of these reads as
     coverage, the self-heal's dispatch is refused every sweep, and the PR is
     stranded with no required checks forever. */
  for (const conclusion of ["cancelled", "startup_failure", "skipped"]) {
    assert.equal(
      ciDispatchIsRedundant([{ event: "pull_request", status: "completed", conclusion }]),
      false,
      conclusion
    );
  }
});

test("ci-release-10: a run in flight, or finished with a verdict, is coverage", () => {
  assert.equal(ciDispatchIsRedundant([{ event: "pull_request", status: "in_progress", conclusion: null }]), true);
  assert.equal(ciDispatchIsRedundant([{ event: "pull_request", status: "queued" }]), true);
  assert.equal(ciDispatchIsRedundant([{ event: "pull_request", status: "completed", conclusion: "failure" }]), true);
  assert.equal(ciDispatchIsRedundant([{ event: "push", status: "completed", conclusion: "success" }]), true);
  // The older bare-event shape carries no status and still counts.
  assert.equal(ciDispatchIsRedundant(["pull_request"]), true);
});

/* ------------- round-3 review: a founder's arming of an outside PR stands ------------- */

/* REST's shape: `auto_merge` carries who enabled it. */
const armedBy = (login) => ({ auto_merge: { enabled_by: { login }, merge_method: "squash" } });

test("review: an outside PR the FOUNDER armed after reading it is NOT disarmed by the sweep", () => {
  /* security-1 made every outside PR FOREIGN_AUTHOR, and the sweep disarmed any
     armed PR the policy would not arm, so a founder who read a fork PR and ran
     `gh pr merge --auto` had it taken back within the hour.
     MUTATION: in planMergeability, go back to `if (!decide(pr, freeze).armed)`
     (or drop the FOREIGN_AUTHOR exception in disarmDecision) -> disable-auto. */
  const raw = pr({ ...FORK, crossRepo: undefined, ...armedBy("wjduvall-cmd") });
  assert.equal(normalizePr(raw).armedBy, "wjduvall-cmd");
  const { actions, notes } = planMergeability([raw]);
  assert.equal(kinds(actions).includes("disable-auto"), false);
  assert.ok(notes.some((n) => /armed by founder/.test(n)), notes.join("\n"));
});

test("review: the same outside PR armed by the BOT is still disarmed (the sweep never vouches for strangers)", () => {
  const raw = pr({ ...FORK, crossRepo: undefined, ...armedBy("github-actions[bot]") });
  assert.ok(kinds(planMergeability([raw]).actions).includes("disable-auto"));
});

test("review: a founder's arming does not outlive a freeze, a hold, or a governed path", () => {
  /* Foreign-ness is the ONLY blocker the founder's read answers. */
  const base = { ...FORK, crossRepo: undefined, ...armedBy("wjduvall-cmd") };
  assert.ok(kinds(planMergeability([pr(base)], { freeze: "on" }).actions).includes("disable-auto"), "freeze");
  assert.ok(kinds(planMergeability([pr({ ...base, labels: ["hold"] })]).actions).includes("disable-auto"), "hold");
  assert.ok(kinds(planMergeability([pr({ ...base, files: [".github/workflows/ci.yml"] })]).actions).includes("disable-auto"), "governed path");
});

/* ------------- round-3 review: the sweep re-decides right before it arms ------------- */

const FRESH = { ...pr(), head: { ref: "nightly/x", sha: "abc1234", repo: { full_name: "o/r" } }, base: { ref: "main", repo: { full_name: "o/r" } }, changed_files: 1 };

test("review: recheckArm arms on unchanged fresh facts", () => {
  assert.equal(recheckArm(FRESH, { headSha: "abc1234" }).arm, true);
});

test("review: a `hold` added after the plan stops the arming (the stale-snapshot override)", () => {
  /* The plan said enable-auto; the founder then added `hold`, automerge-nightly
     disarmed on the label event, and the executor used to re-arm from the old
     plan. MUTATION: make recheckArm return { arm: true } unconditionally. */
  const r = recheckArm({ ...FRESH, labels: [{ name: "hold" }] }, { headSha: "abc1234" });
  assert.equal(r.arm, false);
  assert.match(r.reason, /BLOCKING_LABEL/);
});

test("review: the freeze read at execute time, a moved head, or a new governed file stop it too", () => {
  assert.match(recheckArm(FRESH, { headSha: "abc1234", freeze: "true" }).reason, /FREEZE_ACTIVE/);
  assert.match(recheckArm(FRESH, { headSha: "0000000" }).reason, /head moved/);
  const governed = { ...FRESH, files: [{ filename: "tools/ci/path-policy.mjs" }] };
  assert.equal(recheckArm(governed, { headSha: "abc1234" }).arm, false);
});

test("review: CLI recheck exits 0 to arm, 1 to skip, 2 on bad input", () => {
  const io = (text) => ({ readFile: () => text, log: () => {}, err: () => {} });
  assert.equal(runCli(["recheck", "--from", "p", "--head-sha", "abc1234"], io(JSON.stringify(FRESH))), 0);
  assert.equal(runCli(["recheck", "--from", "p", "--freeze", "on"], io(JSON.stringify(FRESH))), 1);
  assert.equal(runCli(["recheck", "--from", "p"], io("{nope")), 2);
  assert.equal(runCli(["recheck", "--from", "p"], io(JSON.stringify({ number: 1 }))), 2, "no files attached is not a verdict");
});

test("review: pr-hygiene's enable-auto re-reads the PR and runs recheck BEFORE any merge, with the freeze in its env", () => {
  /* MUTATION: delete the recheck call from the enable-auto branch, or the
     FREEZE env line from the Execute step -> red. */
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/pr-hygiene.yml"), "utf8");
  const exec = yml.slice(yml.indexOf("- name: Execute"));
  assert.match(exec.slice(0, 800), /FREEZE: \$\{\{ vars\.AUTOMERGE_FREEZE \}\}/);
  const branch = exec.slice(exec.indexOf("enable-auto)"), exec.indexOf(";;", exec.indexOf("enable-auto)")));
  const recheckAt = branch.indexOf("pr-triage.mjs recheck");
  assert.ok(recheckAt > 0, "enable-auto no longer re-checks");
  assert.match(branch, /--freeze "\$\{FREEZE:-\}" --head-sha "\$sha"/);
  assert.ok(recheckAt < branch.indexOf("gh pr merge"), "the re-check must come before arming or merging");
  assert.match(branch, /"\$rc" -eq 1[\s\S]*skipping/);
});

test("review: automerge-nightly reads who armed the PR and keeps a founder's arming", () => {
  /* MUTATION: drop `--armed-by` from Decide, or the founder_armed clause from
     Disarm -> a same-repo outside PR the founder armed is disarmed on its next
     event. */
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/automerge-nightly.yml"), "utf8");
  assert.match(yml, /\.auto_merge\.enabled_by\.login/);
  assert.match(yml, /--armed-by "\$\{ARMED_BY:-\}"/);
  assert.match(yml, /- name: Disarm auto-merge[\s\S]{0,400}if: steps\.decide\.outputs\.armed != 'true' && steps\.decide\.outputs\.founder_armed != 'true'/);
});
