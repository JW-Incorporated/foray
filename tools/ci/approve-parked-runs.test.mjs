/* approve-parked-runs.mjs (#1032), the step that approves the pointer PR's
   `pull_request` runs GitHub parks at action_required. Both review findings
   on PR #1038 are pinned here: the late-run race that gave a false red, and a
   failed list call read as "nothing to approve". Every `gh` call is faked;
   sleep is a no-op, so the suite is instant and network-free. */
import test from "node:test";
import assert from "node:assert/strict";
import { approveParkedRuns, failureSummary, listParked } from "./approve-parked-runs.mjs";

const REPO = "o/r";
const SHA = "abc123";
const OPTS = { pollMs: 0, minPolls: 4, quietPolls: 2, maxPolls: 20, sleep: async () => {}, log: () => {} };

function ghError(stderr) {
  return Object.assign(new Error("Command failed: gh api"), { code: 1, stderr });
}

/** `parkedAt(poll, approvedIds)` returns the parked runs ({id, name, event?})
    at the n-th list call (1-based), or throws to simulate a failed call.
    `approve(id)` throws to simulate a refused approval. */
function fakeGh({ parkedAt, approve = () => {} }) {
  let poll = 0;
  const approved = new Set();
  const approveCalls = [];
  const gh = async (args) => {
    assert.equal(args[0], "api");
    if (args[1] === "-X") {
      assert.equal(args[2], "POST");
      const id = args[3].match(/runs\/(\d+)\/approve$/)[1];
      approveCalls.push(id);
      approve(id);
      approved.add(id);
      return "";
    }
    assert.match(args[1], new RegExp(`^repos/${REPO}/actions/runs\\?head_sha=${SHA}&status=action_required`));
    poll += 1;
    const runs = parkedAt(poll, approved);
    return JSON.stringify({
      workflow_runs: runs.map((r) => ({ event: "pull_request", ...r })),
    });
  };
  return { gh, approveCalls, polls: () => poll };
}

test("a run parked seconds after the first batch is approved too, not reported as a failure (finding 1)", async () => {
  // ci.yml parks at poll 1; path-policy's run only appears at poll 3, after
  // ci.yml's run was already approved. The old bash stopped at poll 1 and
  // would have called path-policy's run a failure.
  const f = fakeGh({
    parkedAt: (poll, approved) => {
      const runs = [{ id: 1, name: "ci" }];
      if (poll >= 3) runs.push({ id: 2, name: "path-policy" });
      return runs.filter((r) => !approved.has(String(r.id)));
    },
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reason, "approved");
  assert.deepEqual(f.approveCalls, ["1", "2"]);
  assert.deepEqual(res.stillParked, []);
});

test("a run that only parks after the old one-minute wait would have stopped is still caught", async () => {
  // Nothing parked for the first minPolls-1 polls, then a run appears; the
  // window must extend past minPolls until it goes quiet again.
  const f = fakeGh({
    parkedAt: (poll, approved) => (poll >= 4 ? [{ id: 9, name: "triage" }] : [])
      .filter((r) => !approved.has(String(r.id))),
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, true);
  assert.equal(res.reason, "approved");
  assert.deepEqual(f.approveCalls, ["9"]);
  assert.equal(f.polls(), 6, "polls 5 and 6 are the quiet window after the approval at poll 4");
});

test("an approved run still showing as parked for one poll is not a failure", async () => {
  // The approval takes a moment to land: run 1 is listed again right after.
  const f = fakeGh({
    parkedAt: (poll) => (poll <= 2 ? [{ id: 1, name: "ci" }] : []),
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(f.approveCalls, ["1"], "approved once, not re-approved");
});

test("an approve call that fails turns the step red and names the run", async () => {
  const f = fakeGh({
    parkedAt: (poll, approved) => [{ id: 1, name: "ci" }, { id: 2, name: "triage" }]
      .filter((r) => !approved.has(String(r.id))),
    approve: (id) => {
      if (id === "2") throw ghError("HTTP 403: Resource not accessible by integration");
    },
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "approve_failed");
  assert.deepEqual(res.failedApprovals.map((x) => x.id), ["2"]);
  assert.match(res.failedApprovals[0].error, /403/);
  assert.deepEqual(res.approved.map((x) => x.id), ["1"]);
  assert.deepEqual(f.approveCalls, ["1", "2"], "a refused run is not re-approved every poll");
});

test("a run whose approve call succeeded but stays parked is red as still_parked", async () => {
  const f = fakeGh({ parkedAt: () => [{ id: 5, name: "ci" }] });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "still_parked");
  assert.deepEqual(res.stillParked.map((x) => x.id), ["5"]);
});

test("every list call failing is red list_failed, never 'nothing to approve' (finding 2)", async () => {
  const f = fakeGh({
    parkedAt: () => {
      throw ghError("HTTP 403: API rate limit exceeded");
    },
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "list_failed");
  assert.equal(res.goodPolls, 0);
  assert.equal(res.polls, OPTS.maxPolls, "kept trying to the cap before giving up");
  assert.match(res.lastListError, /rate limit/);
  const md = failureSummary(res, { prNumber: 77, branch: "shows-index/pointer-update", headSha: SHA });
  assert.match(md, /Pointer PR #77 needs a human/);
  assert.match(md, /UNKNOWN/);
  assert.match(md, /Approve and run workflows/);
  assert.match(md, /`shows-index\/pointer-update`/);
});

test("transient list failures are retried and do not count toward the quiet window", async () => {
  // Polls 1-3 fail; run 3 is parked from poll 4. Ending early on the errors
  // (or treating them as empty) would miss it.
  const f = fakeGh({
    parkedAt: (poll, approved) => {
      if (poll <= 3) throw ghError("HTTP 502: Bad Gateway");
      return [{ id: 3, name: "automerge-decision" }].filter((r) => !approved.has(String(r.id)));
    },
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reason, "approved");
  assert.equal(res.listErrors, 3);
  assert.deepEqual(f.approveCalls, ["3"]);
});

test("no run ever parked is green 'nothing', only after the full minimum observation", async () => {
  const f = fakeGh({ parkedAt: () => [] });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, true);
  assert.equal(res.reason, "nothing");
  assert.equal(f.polls(), OPTS.minPolls);
});

test("never reaching a quiet window is red 'unconfirmed', not green", async () => {
  // A good poll, then the list call breaks for good: the end state is unknown.
  const f = fakeGh({
    parkedAt: (poll, approved) => {
      if (poll >= 2) throw ghError("HTTP 500");
      return [{ id: 4, name: "ci" }].filter((r) => !approved.has(String(r.id)));
    },
  });
  const res = await approveParkedRuns({ repo: REPO, headSha: SHA, gh: f.gh, ...OPTS });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unconfirmed");
  assert.match(failureSummary(res, { prNumber: 1, branch: "b", headSha: SHA }), /unconfirmed/);
});

test("listParked keeps only pull_request runs and reports a malformed body as an error, not empty", async () => {
  const ok = await listParked({
    repo: REPO,
    headSha: SHA,
    gh: async () => JSON.stringify({
      workflow_runs: [
        { id: 1, name: "ci", event: "pull_request" },
        { id: 2, name: "ci", event: "workflow_dispatch" },
      ],
    }),
  });
  assert.deepEqual(ok, { ok: true, runs: [{ id: "1", name: "ci" }] });
  const bad = await listParked({ repo: REPO, headSha: SHA, gh: async () => "<html>502</html>" });
  assert.equal(bad.ok, false);
  const shapeless = await listParked({ repo: REPO, headSha: SHA, gh: async () => "{}" });
  assert.equal(shapeless.ok, false);
});
