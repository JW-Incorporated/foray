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

test("the self-heal never fires outside the scheduled sweep", () => {
  const { actions } = planMergeability([pr({ autoMergeEnabled: true, checkNames: [], updatedAt: OLD })]);
  assert.deepEqual(actions, []);
});

test("a freshly-updated PR is not re-dispatched into its own CI run", () => {
  const { actions } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: [], updatedAt: new Date().toISOString() })],
    { sweep: true }
  );
  assert.deepEqual(actions, []);
});

test("a head with even one required check is left alone", () => {
  const { actions } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: ["backend"], updatedAt: OLD })],
    { sweep: true }
  );
  assert.deepEqual(actions, []);
});

test("the self-heal does not touch forks, whose branches we cannot dispatch on", () => {
  const { actions } = planMergeability(
    [pr({ autoMergeEnabled: true, checkNames: [], updatedAt: OLD, crossRepo: true })],
    { sweep: true }
  );
  assert.deepEqual(actions, []);
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
    ["pr list", "4\n"],
    ["pulls/4/files", '["data/a.json"]\n'],
    ["issues/4/comments", '["hello"]\n'],
    ["pulls/4", JSON.stringify({ number: 4, mergeable: true })],
  ]);
  const prs = gatherPrs({ repo: "o/r", exec: gh.exec });
  assert.equal(prs.length, 1);
  assert.deepEqual(prs[0].files, ["data/a.json"]);
  assert.deepEqual(prs[0].comments, ["hello"]);
  assert.ok(gh.calls.every((c) => c.includes("o/r")), gh.calls.join("\n"));
});

test("gatherPrs concatenates paginated pages instead of parsing one document", () => {
  const gh = fakeGh([
    ["pr list", "1\n"],
    ["pulls/1/files", '["a"]\n["b"]\n'],
    ["issues/1/comments", "\n"],
    ["pulls/1", "{}"],
  ]);
  assert.deepEqual(gatherPrs({ repo: "o/r", exec: gh.exec })[0].files, ["a", "b"]);
});

test("gatherPrs asks gh for the repo when none is given", () => {
  const gh = fakeGh([
    ["repo view", "o/r\n"],
    ["pr list", ""],
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
    ["pr list", "8\n"],
    ["pulls/8/files", '["CLAUDE.md"]\n'],
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
