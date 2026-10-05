#!/usr/bin/env node
/* Approve the pointer PR's own `pull_request` runs that GitHub parks at
   `action_required` (issue #1032). Called by the last step of
   .github/workflows/shows-import.yml; see that step's comment for why the
   runs get parked and why approving them is safe.

   This used to be inline bash in the workflow. It moved here because review
   of PR #1038 found two ways the bash gave a WRONG answer, and the whole
   point of the step is to measure whether the workflow token can approve
   (#1032), so a wrong answer corrupts the measurement:

   1. FALSE RED (race). The bash stopped polling the moment the first parked
      run showed up, approved only that batch, then looked once more after 5s
      and called anything else parked a failure. Several workflows trigger on
      `pull_request` (ci.yml, path-policy, triage, automerge-decision), and a
      run created a few seconds late landed in that last look, so the job went
      red with "could not be approved" even when approval worked. Now: keep
      polling and approving whatever becomes parked until a quiet window (no
      new parked run for QUIET_POLLS consecutive good polls) after a minimum
      observation time. Failure is reported only for approve calls that
      actually failed, or for runs still parked after their approve call.

   2. SILENT STRAND (error read as empty). `runs=$(parked || true)` turned a
      failed list call (403, 5xx, rate limit) into an empty list, printed
      "nothing to approve" and exited 0. Now a failed list call is counted as
      an error, never as "no runs", and if EVERY poll errored the step goes
      red with the manual remedy. A window that never goes quiet is also red:
      we could not confirm the end state, so we do not claim it. */
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);

export const DEFAULTS = Object.freeze({
  pollMs: 5000,
  /** Never stop before this many polls (~1 min): the pull_request runs
      appear a few seconds after the push / PR open, and not all at once. */
  minPolls: 12,
  /** Consecutive successful polls with nothing NEW parked that end the
      window (after minPolls). Also gives an approval time to take effect
      before a run still showing as parked is called a failure. */
  quietPolls: 3,
  /** Hard cap (~5 min) so a list call that keeps failing, or runs that keep
      appearing, cannot hang the job. */
  maxPolls: 60,
});

/** Default gh runner: resolves with stdout, rejects on a non-zero exit. */
async function defaultGh(args) {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function shortError(err) {
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  const first = (stderr || String(err?.message ?? err)).split("\n")[0];
  return first.slice(0, 300);
}

/** One list call. Returns { ok: true, runs } or { ok: false, error }.
    A failed call is NEVER reported as an empty list. */
export async function listParked({ repo, headSha, gh }) {
  let stdout;
  try {
    stdout = await gh([
      "api",
      `repos/${repo}/actions/runs?head_sha=${headSha}&status=action_required&per_page=100`,
    ]);
  } catch (err) {
    return { ok: false, error: shortError(err) };
  }
  let body;
  try {
    body = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `unparseable runs response: ${shortError(err)}` };
  }
  if (!body || !Array.isArray(body.workflow_runs)) {
    return { ok: false, error: "runs response has no workflow_runs array" };
  }
  const runs = body.workflow_runs
    .filter((r) => r && r.event === "pull_request" && r.id !== undefined && r.id !== null)
    .map((r) => ({ id: String(r.id), name: String(r.name ?? "") }));
  return { ok: true, runs };
}

/** Polls, approving every pull_request run that becomes parked on headSha,
    until a quiet window passes. Returns a result object; `ok` is false when
    the step must go red. `reason` is one of:
      "nothing"      — no run was ever parked (GitHub ran them normally)
      "approved"     — every parked run was approved and none is left parked
      "approve_failed" / "still_parked" — the measurement #1032 cares about
      "list_failed"  — every list call errored; parked state unknown
      "unconfirmed"  — hit maxPolls without a quiet window */
export async function approveParkedRuns({
  repo,
  headSha,
  gh = defaultGh,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.log(line),
  pollMs = DEFAULTS.pollMs,
  minPolls = DEFAULTS.minPolls,
  quietPolls = DEFAULTS.quietPolls,
  maxPolls = DEFAULTS.maxPolls,
} = {}) {
  if (!repo || !headSha) throw new Error("approveParkedRuns needs repo and headSha");
  const attempted = new Map(); // id -> { name, approved: boolean, error? }
  let polls = 0;
  let goodPolls = 0;
  let listErrors = 0;
  let lastListError = null;
  let quiet = 0;
  let lastParked = null; // runs from the most recent successful poll

  while (polls < maxPolls) {
    await sleep(pollMs);
    polls += 1;
    const res = await listParked({ repo, headSha, gh });
    if (!res.ok) {
      listErrors += 1;
      lastListError = res.error;
      log(`::warning::listing parked runs on ${headSha} failed (poll ${polls}): ${res.error}`);
      continue; // neither quiet nor new: an error tells us nothing
    }
    goodPolls += 1;
    lastParked = res.runs;
    let sawNew = false;
    for (const run of res.runs) {
      if (attempted.has(run.id)) continue;
      sawNew = true;
      try {
        await gh(["api", "-X", "POST", `repos/${repo}/actions/runs/${run.id}/approve`]);
        attempted.set(run.id, { name: run.name, approved: true });
        log(`approved run ${run.id} (${run.name})`);
      } catch (err) {
        const error = shortError(err);
        attempted.set(run.id, { name: run.name, approved: false, error });
        log(`::warning::could not approve run ${run.id} (${run.name}) on ${headSha}: ${error}`);
      }
    }
    quiet = sawNew ? 0 : quiet + 1;
    if (polls >= minPolls && quiet >= quietPolls) break;
  }

  const failedApprovals = [...attempted]
    .filter(([, a]) => !a.approved)
    .map(([id, a]) => ({ id, name: a.name, error: a.error }));
  const approved = [...attempted]
    .filter(([, a]) => a.approved)
    .map(([id, a]) => ({ id, name: a.name }));
  // Still parked = parked in the LAST good poll although its approve call
  // succeeded at least quietPolls polls earlier. Runs whose approve call
  // failed are reported under failedApprovals instead.
  const stillParked = (lastParked ?? [])
    .filter((r) => attempted.get(r.id)?.approved === true);

  const base = { polls, goodPolls, listErrors, lastListError, approved, failedApprovals, stillParked };
  if (goodPolls === 0) return { ...base, ok: false, reason: "list_failed" };
  if (failedApprovals.length > 0) return { ...base, ok: false, reason: "approve_failed" };
  if (quiet < quietPolls) return { ...base, ok: false, reason: "unconfirmed" };
  if (stillParked.length > 0) return { ...base, ok: false, reason: "still_parked" };
  if (attempted.size === 0) return { ...base, ok: true, reason: "nothing" };
  return { ...base, ok: true, reason: "approved" };
}

/** Markdown for $GITHUB_STEP_SUMMARY when the step goes red. */
export function failureSummary(result, { prNumber, branch, headSha }) {
  const lines = [`### Pointer PR #${prNumber} needs a human (#1032)`, ""];
  if (result.reason === "list_failed") {
    lines.push(
      `Every call listing the workflow runs on \`${headSha}\` failed (${result.listErrors} of ${result.polls}; last error: ${result.lastListError}).`,
      "Whether its pull_request runs are parked at action_required is UNKNOWN, so this is not \"nothing to approve\".",
    );
  } else if (result.reason === "unconfirmed") {
    lines.push(
      `Polled ${result.polls} times without a quiet window (list errors: ${result.listErrors}), so whether every pull_request run got approved is unconfirmed.`,
    );
  } else {
    lines.push("Its pull_request runs are parked at action_required and could not be approved by the workflow token.");
  }
  for (const f of result.failedApprovals) lines.push(`- approve call failed: run ${f.id} (${f.name}): ${f.error}`);
  for (const s of result.stillParked) lines.push(`- still parked after a successful approve call: run ${s.id} (${s.name})`);
  lines.push(
    "",
    `Remedy: open PR #${prNumber} and press "Approve and run workflows", or push an empty commit to \`${branch}\` as a user.`,
    "Do not hand-edit data/shows-index-pointer.json.",
  );
  return lines.join("\n") + "\n";
}

async function main() {
  const { REPO, HEAD_SHA, PR_NUMBER, BRANCH, GITHUB_STEP_SUMMARY } = process.env;
  const result = await approveParkedRuns({ repo: REPO, headSha: HEAD_SHA });
  if (result.ok) {
    console.log(result.reason === "nothing"
      ? `No pull_request run is parked at action_required on ${HEAD_SHA}; nothing to approve.`
      : `Every parked pull_request run on ${HEAD_SHA} is approved (${result.approved.length}).`);
    return 0;
  }
  const summary = failureSummary(result, { prNumber: PR_NUMBER, branch: BRANCH, headSha: HEAD_SHA });
  if (GITHUB_STEP_SUMMARY) await appendFile(GITHUB_STEP_SUMMARY, summary);
  else process.stderr.write(summary);
  console.log(`::error::pointer PR #${PR_NUMBER}: parked pull_request runs not confirmed approved (${result.reason}, #1032); see the job summary`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::approve-parked-runs crashed: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
