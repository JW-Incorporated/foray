#!/usr/bin/env node
/* PR triage: the silently-stuck class, and the batched founder queue.
 *
 * WHY THIS FILE EXISTS (measured on 2026-08-15/16, not hypothetical)
 *
 *   #173 sat CONFLICTING/DIRTY for hours and never merged. GitHub's auto-merge
 *   only acts on a MERGEABLE PR, so a dirty PR is silently indistinguishable
 *   from one still waiting on checks: same "Auto-merge enabled" badge, same
 *   pending look, no notification, no red check. It was only fixed because a
 *   human went looking. Nothing in the repo would ever have said so.
 *
 *   Separately, a branch that falls behind `main` can re-block after its checks
 *   have already passed — most often by becoming conflicting when another
 *   content PR lands on the same generated JSON.
 *
 * So this module plans two kinds of action per PR:
 *   - BEHIND and mergeable  -> update the branch from `main`, then re-run CI on
 *     the new head (see the dispatch note below).
 *   - CONFLICTING           -> label it, and say so ONCE.
 *
 * EXACTLY ONE COMMENT. EVER. The comment carries a marker
 * (CONFLICT_MARKER) and the planner refuses to plan a second one if any
 * existing comment contains it. A bot that comments every sweep is the same
 * disease as the self-armed check-in loops CLAUDE.md § Never babysit your own
 * PR was written to kill — ~69% of all scheduled agent token spend in Swift2 —
 * and "it is only a comment" is exactly how that started. The LABEL is the
 * live signal: it appears and disappears on its own with no further noise.
 *
 * WHY THE CI RE-DISPATCH IS NOT OPTIONAL. Updating a branch changes the PR's
 * head SHA, and `protect-main`'s required checks (`backend`, `data-and-site`)
 * are matched against THAT SHA. Pushes made with the automatic GITHUB_TOKEN do
 * not create new workflow runs — a deliberate GitHub anti-recursion rule — so
 * an auto-updated PR would sit forever with "Expected — waiting for status to
 * be reported", i.e. this fix would have manufactured the exact silent stall it
 * exists to remove. `workflow_dispatch` and `repository_dispatch` are the two
 * documented exceptions to that rule, which is why `ci.yml` gained a
 * `workflow_dispatch` trigger in the same change and why every `update-branch`
 * action below is paired with a `dispatch-ci` action.
 *
 * THE BATCHED FOUNDER QUEUE (item 5)
 * Anything that still needs a human collects under one label
 * (`needs-founder`), applied and removed automatically from the same
 * path-policy decision the auto-merge path uses, and renders as a
 * marker-delimited block in `HUMAN-ACTIONS.md`. Set semantics make it
 * idempotent: re-running produces the same labels and byte-identical markdown,
 * so there is no duplicate-entry failure mode to guard against.
 *
 * HONEST LIMIT ON WRITING THAT FILE. The scheduled workflow cannot commit the
 * refreshed block to `main` itself: `main` is protected with zero bypass, and a
 * PR opened with GITHUB_TOKEN does not trigger `pull_request` workflows, so its
 * required checks would never run and it could never merge. Adding a PAT to fix
 * that would break "this repo's cloud automation is deliberately keyless"
 * (CLAUDE.md, decision-authority item 2), which is not a trade worth making for
 * a list. So: the workflow renders the block into its run summary every sweep
 * (always current), and any session refreshes the committed copy with
 * `node tools/ci/pr-triage.mjs waiting --write` — which now auto-merges,
 * because HUMAN-ACTIONS.md was added to ALLOWED_PREFIXES in the same change.
 *
 * Every decision here is a pure function over plain data. The workflow does the
 * `gh` calls and executes the planned actions; nothing in this file talks to a
 * network. That is what makes it testable, and it is the split that the YAML
 * heredoc version made impossible.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { APPROVAL_LABEL, automergeDecision, disarmDecision, FOUNDER_QUEUE_LABEL } from "./path-policy.mjs";

export const CONFLICT_LABEL = "merge-conflict";
export const CONFLICT_MARKER = "<!-- foray:pr-triage:merge-conflict -->";
export const QUEUE_LABEL = FOUNDER_QUEUE_LABEL;

/* The block in HUMAN-ACTIONS.md that this module owns end to end. Anything
 * between these two markers is generated; anything outside them is a human's.
 * Replacing between markers is what makes a re-run idempotent instead of
 * appending a second copy of the list every time. */
export const BLOCK_BEGIN = "<!-- BEGIN generated:waiting-on-you -->";
export const BLOCK_END = "<!-- END generated:waiting-on-you -->";

/* The checks `protect-main` requires. Used only to notice a head SHA that has
 * none of them — see the self-heal in planMergeability. Keep in step with the
 * ruleset; being wrong here costs a redundant CI dispatch, never a merge. */
export const REQUIRED_CHECKS = ["backend", "data-and-site"];

/* ------------------------------------------------------------- normalising */

/* GitHub reports mergeability in two vocabularies and this repo's evidence
 * mentions both (#173 was "CONFLICTING/DIRTY"):
 *   GraphQL (`gh pr view`):  mergeable = MERGEABLE|CONFLICTING|UNKNOWN,
 *                            mergeStateStatus = CLEAN|BEHIND|DIRTY|BLOCKED|...
 *   REST (`gh api .../pulls/N`): mergeable = true|false|null,
 *                            mergeable_state = clean|behind|dirty|blocked|...
 * The workflow uses REST (no GraphQL scope needed, works on a read-only token),
 * but accepting both means a future caller cannot get this subtly wrong. */
const MERGEABLE_FROM_BOOL = { true: "MERGEABLE", false: "CONFLICTING" };

/* REST's `state` on a pull request is the ISSUE state — "open" / "closed" — and
 * has nothing to do with mergeability. It is spelled the same as our normalised
 * merge-state field, which is exactly the trap: reading `raw.state` first makes
 * every gathered PR read "open", so `behind` and `dirty` become permanently
 * false and the whole auto-update path dies silently while its tests stay green
 * (they passed hand-built fixtures that set `state` directly — a shape the REST
 * gatherer never produces). Found in review before this shipped. Two defences:
 * `mergeable_state` is consulted BEFORE `state`, and these two values are
 * rejected outright if they ever arrive in the merge-state slot. */
const ISSUE_STATES = new Set(["open", "closed"]);

/* A changed-file entry is a path string, or the files API's object. The object
 * is expanded to BOTH sides of a rename (ci-release-2): the API reports
 * `git mv CLAUDE.md docs/old.md` as one entry whose `filename` is the
 * allowlisted destination and whose `previous_filename` is the governed
 * source, and a policy shown only `filename` let a governed file leave its
 * path unread. A missing `filename` stays in as a non-string so pathPolicy
 * rejects it as malformed — fail-safe, never silently dropped. */
function expandFileEntry(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [entry];
  const out = [entry.filename];
  if (typeof entry.previous_filename === "string" && entry.previous_filename !== "") out.push(entry.previous_filename);
  return out;
}

/** One PR, from either API shape, as the flat record every planner takes. */
export function normalizePr(raw = {}) {
  const labels = (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

  let mergeable = raw.mergeable;
  if (typeof mergeable === "boolean") mergeable = MERGEABLE_FROM_BOOL[String(mergeable)];
  if (mergeable === null || mergeable === undefined || mergeable === "") mergeable = "UNKNOWN";
  mergeable = String(mergeable).toUpperCase();

  let state = String(
    raw.mergeStateStatus ?? raw.mergeable_state ?? raw.state ?? "unknown"
  ).toLowerCase();
  if (ISSUE_STATES.has(state)) state = "unknown";

  const fileEntries = Array.isArray(raw.files) ? raw.files : [];
  // ci-release-7: the REST PR object carries the TRUE count. The files list
  // caps at 3000 (pagination included) and truncates silently, so a list
  // shorter than `changed_files` is a diff the policy cannot see all of.
  // Counted in ENTRIES — a rename is one entry and two paths.
  const changedFiles = Number(raw.changed_files ?? raw.changedFiles);
  const truncated =
    Boolean(raw.truncated) || (Number.isFinite(changedFiles) && changedFiles !== fileEntries.length);

  return {
    number: Number(raw.number),
    title: raw.title ?? "",
    url: raw.url ?? raw.html_url ?? "",
    headRefName: raw.headRefName ?? raw.head?.ref ?? "",
    baseRefName: raw.baseRefName ?? raw.base?.ref ?? "",
    draft: Boolean(raw.draft ?? raw.isDraft),
    // A fork whose repository was deleted reports `head.repo: null`; that is
    // still not our branch, so it reads as cross-repo (security-1).
    crossRepo: Boolean(
      raw.crossRepo ?? raw.isCrossRepository ?? (raw.base?.repo?.full_name && raw.head
        ? raw.head.repo?.full_name !== raw.base.repo.full_name
        : false)
    ),
    mergeable,
    state,
    labels,
    // `gh pr merge --auto` is STICKY: GitHub does not clear it when a label is
    // added or when someone pushes. So knowing whether a PR is currently armed
    // is what lets the sweep take it back off — see planMergeability.
    autoMergeEnabled: Boolean(
      raw.autoMergeEnabled ?? raw.auto_merge ?? raw.autoMergeRequest ?? false
    ),
    // WHO armed it: REST `auto_merge.enabled_by.login`, GraphQL
    // `autoMergeRequest.enabledBy.login`. A founder's arming of an outside PR
    // they have read is kept (disarmDecision in path-policy.mjs).
    armedBy: String(raw.armedBy ?? raw.auto_merge?.enabled_by?.login ?? raw.autoMergeRequest?.enabledBy?.login ?? ""),
    // Names of the check runs already reported on the current head SHA. Used
    // only to notice a head that never got any (a lost CI dispatch).
    checkNames: raw.checkNames ?? [],
    headSha: raw.headSha ?? raw.head?.sha ?? "",
    files: fileEntries.flatMap(expandFileEntry),
    truncated,
    comments: raw.comments ?? [],
    author: raw.author?.login ?? raw.user?.login ?? "",
    createdAt: raw.createdAt ?? raw.created_at ?? null,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? null,
    /* WHEN THE HEAD COMMIT WAS MADE — not when the PR was last touched.
       The checks-missing self-heal below is time-gated, and `updatedAt` is the
       wrong clock for it: a comment, a label, a review, a title edit all reset
       it, and `pr-hygiene` ITSELF writes labels. A PR stuck with no checks that
       gets labelled every six hours never ages past the gate, so the heal that
       exists for it never fires. The head commit's date only moves when the
       head moves, which is exactly the event whose checks we are waiting on.
       Populated by pr-hygiene.yml's gather step from
       `repos/:owner/:repo/commits/:sha` -> `.commit.committer.date`. */
    headCommittedAt:
      raw.headCommittedAt ?? raw.head_committed_at ?? raw.headCommit?.committedDate ?? null,
  };
}

/**
 * Is a `workflow_dispatch` of `ci.yml` redundant for this head SHA?
 *
 * `runs` is what `repos/:owner/:repo/actions/workflows/ci.yml/runs?head_sha=…`
 * returns (or just the event strings). True iff some run already exists for
 * that SHA from a trigger OTHER than `workflow_dispatch` — i.e. GitHub already
 * started CI for these exact bytes and a dispatch would only duplicate it.
 *
 * WHY (measured 2026-09-12 over the last 200 `ci.yml` runs): 178 distinct SHAs,
 * 26 `workflow_dispatch` runs, and 22 of those 26 sat on a SHA that also had a
 * `pull_request` run — usually 1–4 seconds apart. 85% of every dispatched run
 * was a duplicate. `update-branch` with the automatic GITHUB_TOKEN turns out to
 * produce a `pull_request` `synchronize` run after all in most cases; the
 * pairing in pr-hygiene.yml was written for the case where it does NOT, which
 * is real but rare, so the dispatch stays and this is the guard on it.
 *
 * The guard is here — at the DISPATCHER — and deliberately not as an `if:` on
 * ci.yml's jobs. A skipped job still publishes a check run under the required
 * name (`backend`, `data-and-site`), GitHub counts `skipped` as satisfied, and
 * the dispatch run is created at almost the same instant as the `pull_request`
 * run — so a job-level skip could overwrite a FAILING required check with a
 * passing `skipped` one and let a red PR merge. Not dispatching costs nothing
 * and cannot do that.
 */
/* ci-release-10 (round-3 audit): a run COUNTS as coverage only while it is in
 * flight or once it has finished with a verdict. A `pull_request` run that was
 * cancelled, never started its jobs (startup_failure) or was skipped reported
 * no required check at all — and the old guard, which looked only at `event`,
 * treated it as coverage forever, so the self-heal's re-dispatch was refused
 * on every sweep and the PR sat at "Expected — waiting for status to be
 * reported" permanently. A bare event string (the older input shape) carries
 * no status and still counts, as before. */
const NO_COVERAGE = new Set(["cancelled", "startup_failure", "skipped", "stale"]);

export function ciDispatchIsRedundant(runs = []) {
  return (runs ?? []).some((r) => {
    const event = String((typeof r === "string" ? r : r?.event) ?? "");
    if (event === "" || event === "workflow_dispatch") return false;
    if (typeof r === "string") return true;
    if (r?.status && r.status !== "completed") return true; // queued / in progress: it WILL report
    return !NO_COVERAGE.has(String(r?.conclusion ?? ""));
  });
}

/** True if this bot has already said "you are conflicting" on this PR. */
export function hasConflictComment(pr) {
  return (pr.comments ?? []).some((c) =>
    String(typeof c === "string" ? c : (c.body ?? "")).includes(CONFLICT_MARKER)
  );
}

/** The one comment. Written once, never repeated, and it says so. */
export function conflictComment(pr) {
  return [
    CONFLICT_MARKER,
    `**This PR conflicts with \`main\` and cannot merge as it stands.**`,
    "",
    "Auto-merge only acts on a mergeable PR, so a conflicting one looks exactly " +
      "like one still waiting on checks — same badge, no red check, no " +
      "notification. PR #173 sat that way for hours on 2026-08-16 and was only " +
      "found because a human went looking. This comment exists so that cannot " +
      "happen quietly again.",
    "",
    `Merge \`main\` in (or rebase) and push. The \`${CONFLICT_LABEL}\` label ` +
      "clears itself on the next hygiene sweep, and if the branch is merely " +
      "behind rather than conflicting it gets updated automatically.",
    "",
    "**This is the only comment this bot will post about it.** The label is the " +
      "live signal; it appears and disappears on its own. Nothing here polls, " +
      "re-comments or wakes up to check on you (CLAUDE.md § Never babysit your " +
      "own PR).",
  ].join("\n");
}

/* ---------------------------------------------------------------- planning */

/* THE decision for one normalised PR, with everything the policy needs: the
 * author and fork-ness (security-1) and whether the file list is complete
 * (ci-release-7). Arm, disarm and the founder queue all call this, so they
 * cannot disagree — and none of them can forget an input again, which is how
 * the sweep came to arm fork PRs and truncated diffs that automerge-nightly
 * refused. */
function decisionInput(pr, freeze) {
  return {
    files: pr.files,
    labels: pr.labels,
    freeze,
    baseRef: pr.baseRefName || "main",
    truncated: pr.truncated,
    author: pr.author,
    crossRepo: pr.crossRepo,
    armedBy: pr.armedBy,
  };
}
function decide(pr, freeze) {
  return automergeDecision(decisionInput(pr, freeze));
}

/**
 * Is it still right to ARM this PR, on facts read just now? -> { arm, reason }
 *
 * The sweep plans from a snapshot it gathered PR by PR, which on a busy repo is
 * minutes old by the time the executor reaches the last PR. A `hold` added, or
 * AUTOMERGE_FREEZE set, in that window used to be overridden: automerge-nightly
 * disarmed on the label event and the sweep then re-armed (or, on a CLEAN PR,
 * merged outright) from its stale plan. pr-hygiene's executor now re-reads the
 * PR and its files immediately before every `enable-auto` and asks this.
 * `headSha` is the SHA the plan judged: a head that moved since is a different
 * diff and is left for the next run.
 */
export function recheckArm(raw, opts = {}) {
  const { freeze = "", headSha = "" } = opts;
  const pr = normalizePr(raw);
  if (headSha && pr.headSha !== headSha) {
    return { arm: false, reason: `head moved from ${headSha.slice(0, 7)} to ${pr.headSha.slice(0, 7) || "?"} since the plan` };
  }
  if (pr.draft) return { arm: false, reason: "PR is a draft now" };
  const d = decide(pr, freeze);
  return d.armed ? { arm: true, reason: d.reason } : { arm: false, reason: `${d.code}: ${d.reason}` };
}

/**
 * Actions to keep PRs mergeable, and to alert on the ones that are not.
 *
 * -> { actions: [...], notes: [string] }
 *
 * Action kinds, all idempotent by construction (a label already present is not
 * re-added; a comment already posted is not re-posted):
 *   { kind: "add-label",    pr, label }
 *   { kind: "remove-label", pr, label }
 *   { kind: "comment",      pr, body }
 *   { kind: "update-branch",pr }
 *   { kind: "dispatch-ci",  pr, ref }   always paired with update-branch
 */
export function planMergeability(prs, opts = {}) {
  const {
    autoUpdate = true,
    freeze = "",
    // `sweep` is still ACCEPTED (pr-hygiene.yml passes `--sweep` on the cron,
    // and callers outside this repo may too) but it no longer gates anything —
    // see hole 1 in the checks-missing self-heal below.
    sweep: _sweep = false,
    now = Date.now(),
    requiredChecks = REQUIRED_CHECKS,
    staleAfterMs = 30 * 60 * 1000,
  } = opts;
  const actions = [];
  const notes = [];

  for (const raw of prs ?? []) {
    const pr = normalizePr(raw);
    if (pr.draft) {
      notes.push(`#${pr.number}: draft — skipped`);
      continue;
    }
    if (pr.baseRefName && pr.baseRefName !== "main") {
      notes.push(`#${pr.number}: targets ${pr.baseRefName}, not main — skipped`);
      continue;
    }

    // DISARM. `gh pr merge --auto` is sticky: adding `hold`, pushing a commit
    // that touches `.github/`, or flipping AUTOMERGE_FREEZE does NOT clear it,
    // so a PR armed a minute before any of those still merges the moment its
    // checks go green. The automerge job re-decides and prints NOT ARMED, which
    // is worse than useless on its own — it reads as if something stopped it.
    // Taking the arming back off is the half that was missing.
    //
    // This is also what makes AUTOMERGE_FREEZE a real kill switch: setting a
    // repo variable fires no PR event at all, so the 6-hourly sweep is the only
    // thing that can reach an already-armed PR.
    if (pr.autoMergeEnabled) {
      // disarmDecision, not `!decide().armed`: a founder who read an outside
      // contributor's PR and armed it has answered FOREIGN_AUTHOR, and the
      // sweep must not take that back (round-3 review of security-1).
      const { disarm, code, decision } = disarmDecision(decisionInput(pr, freeze));
      if (disarm) {
        actions.push({ kind: "disable-auto", pr: pr.number, reason: decision.reason });
      } else if (code === "FOUNDER_ARMED") {
        notes.push(`#${pr.number}: outside PR armed by founder \`${pr.armedBy}\` — left armed`);
      }
    } else if (pr.state === "clean") {
      // ARM — the symmetric half that was missing (t_a25ea475). A PR can reach
      // "the policy would approve it" with autoMergeEnabled still false and no
      // qualifying `pull_request` event ever fire to re-decide it: clearing
      // AUTOMERGE_FREEZE fires no PR event at all, and retargeting a PR's base
      // branch to `main` fires `edited`, which automerge-nightly.yml now also
      // listens for. Without this branch, "CLEAN + unarmed" is an absorbing
      // state — escapable only by a human clicking merge or a fresh push.
      //
      // Gated on `state === "clean"`, GitHub's own mergeStateStatus, not the
      // separate `mergeable` boolean: a BEHIND or DIRTY PR can still report
      // `mergeable: true` (behind/dirty are about mergeStateStatus, not the
      // plain mergeable flag), and arming either of those would race the
      // update-branch/conflict-label handling below. Only a settled CLEAN read
      // arms; UNKNOWN means "ask again next sweep", never "assume fine".
      //
      // security-1: `decide` refuses a fork PR or an author not on
      // AUTOMERGE_AUTHORS. This branch is what armed outside contributors'
      // green fork PRs every hour; automerge-nightly skips forks, the sweep
      // did not.
      const decision = decide(pr, freeze);
      if (decision.armed) {
        actions.push({ kind: "enable-auto", pr: pr.number, headSha: pr.headSha, reason: decision.reason });
      }
    }

    const labelled = pr.labels.includes(CONFLICT_LABEL);

    if (pr.mergeable === "CONFLICTING" || pr.state === "dirty") {
      if (!labelled) actions.push({ kind: "add-label", pr: pr.number, label: CONFLICT_LABEL });
      if (!hasConflictComment(pr)) {
        actions.push({ kind: "comment", pr: pr.number, body: conflictComment(pr) });
      } else {
        notes.push(`#${pr.number}: conflicting, already told once — label only`);
      }
      continue;
    }

    if (pr.mergeable === "UNKNOWN") {
      // GitHub computes mergeability asynchronously, so UNKNOWN right after a
      // push is normal and means "ask again", not "fine". Doing nothing is the
      // fail-safe choice: the next sweep sees the settled value. Guessing
      // MERGEABLE here would auto-update a branch that is actually conflicting.
      notes.push(`#${pr.number}: mergeability not computed yet — will re-check next sweep`);
      continue;
    }

    if (labelled) actions.push({ kind: "remove-label", pr: pr.number, label: CONFLICT_LABEL });

    // WHEN THIS ACTUALLY FIRES, which is worth knowing before you debug its
    // silence. GitHub reports `behind` only when being behind BLOCKS the merge
    // — i.e. when the branch ruleset requires branches to be up to date. As of
    // 2026-08-16 `protect-main` has `strict_required_status_checks_policy:
    // false`, so a behind-but-clean PR reads `clean` and merges on its own, and
    // this branch is correctly quiet.
    //
    // That is deliberate, not an oversight. Detecting behind-ness ourselves
    // (via the compare API) and updating regardless would re-run full CI —
    // including the macOS `ios-kit` job — on every open PR every time anything
    // lands on `main`, and would reset the green checks of PRs that were about
    // to merge. The cost is real and the benefit today is nil: the conflict
    // path below already catches the case that actually bit us (#173), because
    // a stale branch's failure mode here is a CONFLICT, not staleness.
    //
    // The moment `strict` is turned on — or a merge queue is enabled — being
    // behind starts blocking, GitHub starts reporting `behind`, and this fires
    // without anyone editing it.
    if (pr.state === "behind") {
      if (!autoUpdate) {
        notes.push(`#${pr.number}: behind main — auto-update disabled`);
      } else if (pr.crossRepo) {
        // A fork's head branch is not ours to push to.
        notes.push(`#${pr.number}: behind main but the head is on a fork — cannot update`);
      } else if (pr.labels.includes("hold")) {
        // `hold` means a human is mid-thought on this branch. Rewriting their
        // branch under them is the wrong kind of helpful.
        notes.push(`#${pr.number}: behind main but held — leaving the branch alone`);
      } else {
        actions.push({ kind: "update-branch", pr: pr.number });
        // Required checks live on the head SHA and GITHUB_TOKEN pushes do not
        // trigger workflows. Without this, updating the branch replaces a green
        // PR with one whose checks never report. See the header.
        actions.push({ kind: "dispatch-ci", pr: pr.number, ref: pr.headRefName });
      }
      continue;
    }

    // SELF-HEAL: a head SHA carrying none of the required checks.
    //
    // `update-branch` is asynchronous (202 Accepted) and the paired dispatch can
    // still lose the race or 422 even with the executor's SHA poll. If it does,
    // the PR is no longer `behind`, so nothing above would ever look at it
    // again, and it sits at "Expected — waiting for status to be reported"
    // forever — the exact silent stall this file exists to delete, manufactured
    // by the fix for it. This branch notices and re-dispatches.
    //
    // Time-gated, and the gate is the HEAD COMMIT's clock: on a fresh head the
    // checks legitimately have not reported yet, and dispatching into that race
    // would double every CI run. A head that is 30 minutes old and still missing
    // a required check is stuck, not starting.
    //
    // THREE HOLES CLOSED 2026-09-12 (machinery audit). As written, this heal
    // could be up to 6.5 hours late or never fire at all:
    //
    //   1. SWEEP-ONLY. `sweep` is set only by the 6-hourly cron
    //      (`pr-hygiene.yml`, `cron: "23 */6 * * *"`), so the fastest possible
    //      heal was 23 minutes past the next 6-hour boundary. Worse, the head
    //      that LANDS in this state does so because of a PR event outside
    //      `ci.yml`'s three defaults (`opened`/`synchronize`/`reopened`) —
    //      `edited`, `labeled`, `unlabeled`, `ready_for_review` — and
    //      `pr-hygiene.yml` is subscribed to four of those. The event that
    //      creates the stall is an event this workflow already wakes up for, so
    //      the heal now runs on it. The age gate is what keeps a `synchronize`
    //      from double-dispatching: a head seconds old is never 30 minutes old.
    //
    //   2. THE WRONG CLOCK. `age` came from `pr.updatedAt`, which a comment, a
    //      label, a review or a title edit resets — and `pr-hygiene` itself
    //      writes labels, so a PR it labels every sweep could never age past the
    //      gate. `headCommittedAt` only moves when the head moves.
    //
    //   3. ALL-OR-NOTHING. `missing.length === requiredChecks.length` fired only
    //      when EVERY required check was absent. A partial dispatch — one job
    //      reported, the other never created — is a head that can never merge
    //      and that this branch would have skipped forever. Any missing required
    //      check is the stall; `> 0` is the honest test.
    //
    // The duplicate-dispatch cost of (1) and (3) is bounded by
    // `ciDispatchIsRedundant`, which pr-hygiene.yml consults before every
    // dispatch: if a run already exists for the head SHA, nothing is sent.
    if (pr.headRefName && !pr.crossRepo && Array.isArray(pr.checkNames)) {
      const headAt = pr.headCommittedAt ?? pr.updatedAt;
      const age = headAt ? now - Date.parse(headAt) : Infinity;
      const missing = requiredChecks.filter((c) => !pr.checkNames.includes(c));
      if (missing.length > 0 && Number.isFinite(age) && age > staleAfterMs) {
        actions.push({ kind: "dispatch-ci", pr: pr.number, ref: pr.headRefName });
        notes.push(
          `#${pr.number}: head is missing ${missing.join("/")} after ` +
            `${Math.round(age / 60000)}m — re-dispatching CI`
        );
      }
    }
  }
  return { actions, notes };
}

/**
 * Who still needs a founder, and why — from the same decision the auto-merge
 * path makes, so the queue cannot disagree with the gate.
 *
 * -> { queue: [{ number, title, url, reason, code, labels, updatedAt }],
 *      actions: [...] }
 */
export function planFounderQueue(prs, opts = {}) {
  const { freeze = "" } = opts;
  const queue = [];
  const actions = [];

  for (const raw of prs ?? []) {
    const pr = normalizePr(raw);
    if (pr.draft) continue;
    if (pr.baseRefName && pr.baseRefName !== "main") continue;

    const decision = decide(pr, freeze);

    // A conflicting PR needs its AUTHOR, not a founder: the label and the one
    // comment are the whole alert, and putting it in the founder queue would
    // hand a human a task that resolving takes a git command.
    const conflicting = pr.mergeable === "CONFLICTING" || pr.state === "dirty";
    const wanted = decision.needsFounder && !conflicting;
    const labelled = pr.labels.includes(QUEUE_LABEL);

    if (wanted) {
      queue.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        reason: decision.reason,
        code: decision.code,
        labels: pr.labels,
        updatedAt: pr.updatedAt,
        // `founder-approved` makes the `path-policy` CHECK green; it does not
        // arm auto-merge on a governed path, so the PR stays in this queue
        // until someone actually merges it. Surfacing it means the founder can
        // see at a glance which rows are "already agreed, just needs the
        // click" — otherwise an approved PR looks identical to an unread one
        // and the batched list starts getting skimmed.
        approved: pr.labels.includes(APPROVAL_LABEL),
      });
      if (!labelled) actions.push({ kind: "add-label", pr: pr.number, label: QUEUE_LABEL });
    } else if (labelled) {
      actions.push({ kind: "remove-label", pr: pr.number, label: QUEUE_LABEL });
    }
  }
  queue.sort((a, b) => a.number - b.number);
  return { queue, actions };
}

/** Both planners, one call. Actions are deduplicated and ordered stably. */
export function planTriage(prs, opts = {}) {
  const m = planMergeability(prs, opts);
  const q = planFounderQueue(prs, opts);
  const seen = new Set();
  const actions = [...m.actions, ...q.actions].filter((a) => {
    const key = `${a.kind}:${a.pr}:${a.label ?? a.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { actions, notes: m.notes, queue: q.queue };
}

/* --------------------------------------------------------------- rendering */

/**
 * The "waiting on you" block. Byte-identical for identical input — no
 * timestamp, no run number, nothing that changes on a re-run — because a block
 * that always differs produces a commit every sweep and teaches everyone to
 * ignore it.
 */
export function renderWaitingBlock(queue, opts = {}) {
  const { repo = "JW-Incorporated/foray", queueLabel = QUEUE_LABEL } = opts;
  const filter = `https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+label%3A${encodeURIComponent(queueLabel)}`;
  const lines = [
    BLOCK_BEGIN,
    "",
    "### Waiting on a founder (auto-maintained)",
    "",
    `Generated by \`node tools/ci/pr-triage.mjs waiting --write\`, and re-rendered`,
    `into the run summary of \`.github/workflows/pr-hygiene.yml\` on every sweep.`,
    `Live, always-current view: <${filter}>`,
    "",
    "Everything the merge machinery could not land on its own ends up here, so",
    "the residue is one batched glance instead of something anyone has to notice.",
    "",
  ];
  if (!queue.length) {
    lines.push("**Nothing is waiting on a founder right now.**", "");
  } else {
    lines.push("| PR | What it is | Why it needs you |", "| --- | --- | --- |");
    for (const item of queue) {
      const link = item.url ? `[#${item.number}](${item.url})` : `#${item.number}`;
      // "approved" means the path-policy check is satisfied and only the merge
      // itself is left — a materially different ask from "nobody has looked".
      const why = item.approved
        ? `**approved — just needs the merge.** ${cell(item.reason)}`
        : cell(item.reason);
      lines.push(`| ${link} | ${cell(item.title)} | ${why} |`);
    }
    lines.push("");
    lines.push(
      "To let a whole category of these merge unread instead, add its path to",
      "`ALLOWED_PREFIXES` in `tools/ci/path-policy.mjs` — that is what #167/#168",
      "did for `STATE.md`, and it converts a recurring merge into a one-line diff.",
      ""
    );
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Make one line of untrusted text safe inside a markdown table cell.
 *
 * The `<!--` neutralisation is not cosmetic. A PR titled
 * `<!-- END generated:waiting-on-you -->` would render that marker INSIDE the
 * generated block, and spliceBlock finds the FIRST `BLOCK_END` — so the next
 * `waiting --write` would splice at the injected marker, duplicate half the
 * block and orphan the real one. PR titles and file paths are both attacker- or
 * accident-controlled text that lands here.
 */
function cell(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/<!--/g, "<!‑‑")
    .replace(/-->/g, "‑‑>")
    .trim();
}

/**
 * Put `block` into `text`, replacing any previous copy.
 *
 * Idempotent by markers, not by diffing: splice(splice(t, b), b) === splice(t, b).
 * If the markers are absent the block is appended, so a hand-deleted block
 * comes back rather than silently staying gone. A file with a BEGIN and no END
 * (someone edited inside the block) is a hard error — guessing where the
 * generated region stops would eat their edit.
 */
export function spliceBlock(text, block) {
  const src = String(text ?? "");
  const start = src.indexOf(BLOCK_BEGIN);
  const end = src.indexOf(BLOCK_END);
  if (start === -1 && end === -1) {
    const sep = src === "" || src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
    return `${src}${sep}${block}\n`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `HUMAN-ACTIONS.md has an unbalanced generated block (BEGIN at ${start}, END at ${end}). ` +
        `Restore both markers — refusing to guess where the generated region ends.`
    );
  }
  return src.slice(0, start) + block + src.slice(end + BLOCK_END.length);
}

/* ------------------------------------------------------- gathering via gh */

/**
 * Read open PRs with the `gh` CLI.
 *
 * The workflow gathers in YAML and passes `--from`; this exists so the command
 * HUMAN-ACTIONS.md tells a session to run —
 * `node tools/ci/pr-triage.mjs waiting --write` — actually works on its own.
 * Without it, omitting `--from` would render an EMPTY queue and cheerfully
 * commit "nothing is waiting on a founder" over a real list. A refresher that
 * silently blanks the thing it refreshes is worse than no refresher.
 *
 * `exec` is injected so the shape of every call is pinned by tests without
 * spawning anything.
 */
export function gatherPrs(opts = {}) {
  const { repo, exec = defaultExec } = opts;

  const owner = repo || exec(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  if (!owner) throw new Error("could not determine the repository — pass --repo owner/name");

  // Every open PR, paginated (ci-release-17). `gh pr list --limit 100` stopped
  // at the newest hundred, so an armed PR past it was never disarmed by
  // AUTOMERGE_FREEZE — the one path a kill switch has to already-armed PRs.
  const numbers = exec(["api", "--paginate", `repos/${owner}/pulls?state=open&per_page=100`, "--jq", ".[].number"])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return numbers.map((n) => {
    const pr = JSON.parse(exec(["api", `repos/${owner}/pulls/${n}`]));
    // One JSON array per page, so parse per line and concatenate rather than
    // trusting a single document.
    const pages = (out) =>
      out
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .flatMap((l) => JSON.parse(l));
    // Entries, not bare names: normalizePr expands a rename to both of its
    // paths and counts entries against `changed_files` (ci-release-2/-7).
    pr.files = pages(
      exec(["api", "--paginate", `repos/${owner}/pulls/${n}/files`, "--jq", "[.[] | {filename, previous_filename}]"])
    );
    pr.comments = pages(exec(["api", "--paginate", `repos/${owner}/issues/${n}/comments`, "--jq", "[.[].body]"]));
    return pr;
  });
}

function defaultExec(args) {
  const res = spawnSync(process.platform === "win32" ? "gh.exe" : "gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run gh: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${res.stderr?.trim()}`);
  return res.stdout ?? "";
}

/* --------------------------------------------------------------------- CLI */

const USAGE = `usage:
  node tools/ci/pr-triage.mjs plan    --from <prs.json> [options]
  node tools/ci/pr-triage.mjs waiting --from <prs.json> [--write|--print]
  node tools/ci/pr-triage.mjs recheck --from <pr.json> [--freeze <v>] [--head-sha <sha>]
                        exit 0 = still arm it, exit 1 = do not (a label, the
                        freeze, the head moved, or anything else the policy now
                        refuses). --from is ONE REST PR object with \`files\`
                        attached, read immediately before arming.
  node tools/ci/pr-triage.mjs dispatch-needed --from <runs.json>
                        exit 0 = send the workflow_dispatch, exit 1 = a run
                        already exists for that head SHA, so do not.
                        --from takes what
                        \`actions/workflows/ci.yml/runs?head_sha=…\` returns
                        (the envelope or just its .workflow_runs array).

options:
  --from <path|->        PRs as a JSON array ("-" = stdin). Accepts the shape of
                        \`gh api repos/:owner/:repo/pulls\` with \`files\`,
                        \`labels\` and \`comments\` attached. OMIT IT to read the
                        open PRs with \`gh\` instead — never to mean "none".
  --freeze <value>       AUTOMERGE_FREEZE repo variable
  --no-auto-update       plan no update-branch/dispatch-ci actions
  --partial              (plan) this run looked at one PR, not all of them, so
                        do not render the founder queue as if it were complete
  --sweep                (plan) this is the scheduled sweep. Accepted and
                        ignored since 2026-09-12: the checks-missing self-heal
                        used to be gated on it and is now gated only on the head
                        commit's age (see planMergeability). Kept so an older
                        workflow invocation still parses.
  --actions <path>       write planned actions as JSON lines here
  --summary <path>       append a markdown report here ($GITHUB_STEP_SUMMARY)
  --file <path>          (waiting) the file to splice, default HUMAN-ACTIONS.md
  --repo <owner/name>    (waiting) for the live filter URL
  --write                (waiting) write the file
  --print                (waiting) print the block, write nothing
  --check                (waiting) exit 1 if the file's block is stale`;

const VALUE_FLAGS = new Set([
  "--from",
  "--freeze",
  "--actions",
  "--summary",
  "--file",
  "--repo",
  "--head-sha",
]);
const BOOL_FLAGS = new Set(["--no-auto-update", "--write", "--print", "--check", "--partial", "--sweep"]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "waiting", "dispatch-needed", "recheck"].includes(command)) {
    throw new Error(`unknown command: ${command ?? "(none)"}`);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (BOOL_FLAGS.has(a)) {
      opts[a.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown option: ${a}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return { command, opts };
}

const defaultIo = {
  readFile: (p) => fs.readFileSync(p, "utf8"),
  readStdin: () => fs.readFileSync(0, "utf8"),
  writeFile: (p, s) => fs.writeFileSync(p, s),
  append: (p, s) => fs.appendFileSync(p, s),
  exists: (p) => fs.existsSync(p),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

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

  /* Handled before the PR-shaped `--from` below, because this command's input is
     workflow RUNS, and the runs API answers with an envelope object rather than
     a bare array. Exit code is the answer: 0 = dispatch, 1 = already covered.
     A malformed or unreadable input is 2 and the caller dispatches anyway — a
     duplicate CI run is a cost, a missing one strands the PR. */
  if (command === "dispatch-needed") {
    if (!opts.from) {
      $.err("dispatch-needed needs --from <runs.json|->");
      return 2;
    }
    let runs;
    try {
      const parsed = JSON.parse(opts.from === "-" ? $.readStdin() : $.readFile(opts.from));
      runs = Array.isArray(parsed) ? parsed : (parsed?.workflow_runs ?? null);
    } catch (err) {
      $.err(`--from is not valid JSON: ${err.message}`);
      return 2;
    }
    if (!Array.isArray(runs)) {
      $.err("--from must be a JSON array of runs, or the runs API's { workflow_runs: [...] }");
      return 2;
    }
    if (ciDispatchIsRedundant(runs)) {
      $.log(`a ci.yml run already exists for this head SHA (${runs.length} run(s)) — not dispatching`);
      return 1;
    }
    $.log(`no non-dispatch ci.yml run for this head SHA (${runs.length} run(s)) — dispatching`);
    return 0;
  }

  if (command === "recheck") {
    if (!opts.from) {
      $.err("recheck needs --from <pr.json|->");
      return 2;
    }
    let pr;
    try {
      const parsed = JSON.parse(opts.from === "-" ? $.readStdin() : $.readFile(opts.from));
      pr = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : null) : parsed;
    } catch (err) {
      $.err(`--from is not valid JSON: ${err.message}`);
      return 2;
    }
    if (!pr || typeof pr !== "object" || !Array.isArray(pr.files)) {
      $.err("--from must be ONE pull request object with its `files` attached");
      return 2;
    }
    const r = recheckArm(pr, { freeze: opts.freeze, headSha: opts.headSha });
    $.log(`#${pr.number}: ${r.arm ? "still armable" : "NOT armable now"} — ${r.reason}`);
    return r.arm ? 0 : 1;
  }

  let prs = [];
  if (opts.from) {
    const text = opts.from === "-" ? $.readStdin() : $.readFile(opts.from);
    try {
      prs = JSON.parse(text);
    } catch (err) {
      $.err(`--from is not valid JSON: ${err.message}`);
      return 2;
    }
    if (!Array.isArray(prs)) {
      $.err("--from must contain a JSON array of pull requests");
      return 2;
    }
  } else {
    // No --from means "go and look". Never means "assume there is nothing".
    try {
      prs = gatherPrs({ repo: opts.repo, exec: $.exec });
    } catch (err) {
      $.err(`could not read open PRs: ${err.message}`);
      $.err("Pass --from <prs.json> if `gh` is not available here.");
      return 2;
    }
  }

  if (command === "plan") {
    const { actions, notes, queue } = planTriage(prs, {
      freeze: opts.freeze,
      autoUpdate: !opts.noAutoUpdate,
      sweep: Boolean(opts.sweep),
    });
    if (opts.actions) {
      $.writeFile(opts.actions, actions.map((a) => JSON.stringify(a)).join("\n") + (actions.length ? "\n" : ""));
    }
    const report = [
      "## pr-hygiene",
      "",
      `${prs.length} open PR(s) examined · ${actions.length} action(s) planned · ` +
        `${queue.length} waiting on a founder.`,
      "",
      ...(actions.length
        ? actions.map((a) => `- \`${a.kind}\` #${a.pr}${a.label ? ` \`${a.label}\`` : ""}${a.ref ? ` (${a.ref})` : ""}`)
        : ["- nothing to do"]),
      "",
      ...(notes.length ? ["Notes:", "", ...notes.map((n) => `- ${n}`), ""] : []),
      // A run that looked at ONE PR must not print a block that reads like the
      // whole queue — an empty "nothing is waiting on a founder" rendered from
      // a single clean PR is exactly the kind of false reassurance this change
      // set exists to remove.
      ...(opts.partial
        ? [
            `_Scoped to one PR, so the founder queue is not rendered here._ ` +
              `The full list is in the 6-hourly sweep's summary and at the ` +
              `\`needs-founder\` filter.`,
          ]
        : [renderWaitingBlock(queue, { repo: opts.repo })]),
    ].join("\n");
    $.log(report);
    if (opts.summary) $.append(opts.summary, report + "\n");
    return 0;
  }

  // waiting
  const { queue } = planFounderQueue(prs, { freeze: opts.freeze });
  const block = renderWaitingBlock(queue, { repo: opts.repo });
  const file = opts.file ?? "HUMAN-ACTIONS.md";

  if (opts.print || (!opts.write && !opts.check)) {
    $.log(block);
    return 0;
  }
  const current = $.exists(file) ? $.readFile(file) : "";
  let next;
  try {
    next = spliceBlock(current, block);
  } catch (err) {
    $.err(err.message);
    return 2;
  }
  if (opts.check) {
    if (next === current) {
      $.log(`${file} is up to date.`);
      return 0;
    }
    $.err(`${file}'s generated block is stale — run: node tools/ci/pr-triage.mjs waiting --write`);
    return 1;
  }
  if (next === current) {
    $.log(`${file} already up to date — nothing written.`);
    return 0;
  }
  $.writeFile(file, next);
  $.log(`${file} updated (${queue.length} item(s) waiting on a founder).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(runCli(process.argv.slice(2)));
}
