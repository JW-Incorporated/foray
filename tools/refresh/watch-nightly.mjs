#!/usr/bin/env node
/* The nightly watchdog — issue #290. Watches for an ABSENCE.
 *
 * WHY THIS EXISTS
 * The nightly pipeline is two halves. The `nightly-refresh` Action does the
 * deterministic half and publishes `resolved.json` to the `refresh-digest`
 * branch. A Claude Cloud scheduled agent does the judgment half and opens
 * `nightly/YYYY-MM-DD`. On 2026-08-20 and 2026-08-21 the agent's account hit a
 * weekly usage limit and simply did not run. The Action succeeded both nights,
 * logged "published digest: 29 resolved episodes" both nights, and every
 * workflow in the list was green while the product got nothing.
 *
 * Nothing in the system watched for an absence, so the failure was invisible in
 * exactly the place anyone would look.
 *
 * THIS IS THE INVERSE OF A GUARD THAT ALREADY WORKS
 * `docs/agents/runner-prompts/foray-nightly.md` step 2 makes the runner REFUSE a
 * digest older than 12 hours, because a stale digest holds only items already in
 * `discover.json`, so `merge.mjs` reports "0 items added" — "a silently skipped
 * night that looks like a successful one". That is this bug's reasoning applied
 * to a missing ACTION. Nobody had applied it to a missing AGENT. Same sentence,
 * other direction, and deliberately the same 12 hours (see THRESHOLD below):
 * together the two guards say a digest must be CONSUMED within 12h of being
 * MADE, and whichever half fails to hold up its end is the one that goes red.
 *
 * TWO CHECKS, AND THE SECOND ONE IS THE IMPORTANT ONE
 *
 *   --mode absence   Ran on a schedule, hours after the agent should have
 *                    finished. A digest older than the threshold with no
 *                    `nightly/<its date>` PR (open or merged) is red. This is
 *                    the direct "a night that produced no PR must produce a red
 *                    something" requirement.
 *
 *   --mode overwrite Ran by the Action at scan time, BEFORE it publishes.
 *                    `resolved.json` is REPLACED each night, not appended, so
 *                    the moment data is actually lost is when a digest is about
 *                    to be overwritten while its predecessor never merged. That
 *                    is what happened on 2026-08-21: the 08-20 digest was
 *                    overwritten, and with it the 08-19 tail — 2026-08-19 held
 *                    10 episodes against a neighbouring Wednesday's 30, and a
 *                    deliberate 72-hour re-scan (#293) got 17 of them back.
 *                    One missed night is survivable. Two destroy data.
 *
 * In `overwrite` mode the detection IS the prevention, which is why it is worth
 * more than its size: the Action fails BEFORE the publish step, so neither
 * `resolved.json` nor `refresh-state.json` is replaced. The unmerged digest
 * survives on the branch and the seen-guid state still lists tonight's episodes
 * as unseen, so nothing has to be recovered — a human just has to look.
 *
 * WHICH MEANS THIS GUARD CAN STALL THE PIPELINE, AND HAS TO SAY HOW TO CLEAR IT
 * A guard that fails the job before the scan holds every subsequent night
 * hostage until its verdict flips. That is the right trade against silent data
 * loss and it is also strictly more expensive than the bug if nobody can clear
 * it, so three things are stated rather than left to be worked out under
 * pressure — see howToClear() for the text an operator actually reads:
 *   - the digest on the branch is >12h old by the time this fires, so the runner
 *     prompt's own staleness guard will refuse it; re-cut, do not retry.
 *   - the recovery branch must be named after the DIGEST's date
 *     (`nightly/<date>-recovery`), because that is the string the guard looks
 *     for. Named after the day the work happened, it clears nothing.
 *   - `--window-hours` has to reach back to the stranded digest. The 72 in
 *     #293's runbook was right for a one-day-old digest and silently wrong for
 *     one stranded over a weekend; recoveryWindowHours() computes it.
 * And there is a deliberate escape hatch: `nightly-refresh` accepts a
 * `overwrite_unmerged_digest` dispatch input for the case where the episodes are
 * genuinely gone from the feeds and someone decides, on purpose, to move on.
 *
 * WHY IT FIRES ONLY WHEN BOTH SIGNALS AGREE
 * `overwrite` needs BOTH "no nightly PR for that date" AND "not one of the
 * digest's items reached the pool" before it calls loss. Not conservatism for
 * its own sake — either signal alone is wrong:
 *   - Item overlap alone false-positives constantly. The runner is TOLD to drop
 *     cross-promos, trailers, encores and between-seasons filler, so a healthy
 *     night legitimately leaves some digest items out of the pool forever.
 *     "Zero of N landed" is the unambiguous version, and an agent dropping all
 *     29 items is the same case as the agent not running.
 *   - PR existence alone misses a rename. The pool is the ground truth for
 *     "did this content actually ship"; the PR is the ground truth for "was
 *     this night processed at all". A night is only lost when both say no.
 * An OPEN unmerged PR counts as processed, deliberately: the work is on that
 * branch, so overwriting the digest loses nothing.
 *
 * KNOWN FALSE POSITIVE, stated rather than hidden: a night on which the agent
 * ran and dropped EVERY item without opening a PR reads as a miss. It has never
 * happened; if it does, the cost is one red run a human clears in a glance,
 * which is the correct direction for this check to be wrong in.
 *
 * NO NETWORK, NO DEPENDENCIES. Every input is a file the caller fetched — the
 * digest, the PR list from `gh pr list --json`, and `data/discover.json`. That
 * keeps the whole verdict a pure function of committed fixtures, which is the
 * only way a watchdog can be shown to fire without waiting a day for it to.
 *
 * EXPOSURE, honestly: `tools/refresh/` is on the auto-merge allowlist (T3 in
 * tools/ci/path-policy.mjs), so unlike `tools/ci/` this file can be edited by a
 * bot PR that lands unread. It is not a merge gate — neutering it cannot let
 * bad code into `main`, only silence an alarm — which is why it lives here and
 * not behind a founder label. `test/suite-integrity.test.js` floors the suite
 * beside it, so deleting the tests is loud.
 *
 * USAGE
 *   node tools/refresh/watch-nightly.mjs --mode absence \
 *        --digest resolved.json --pulls pulls.json --discover data/discover.json
 *   node tools/refresh/watch-nightly.mjs --mode overwrite \
 *        --digest prior-resolved.json --pulls pulls.json --discover data/discover.json
 *   node tools/refresh/watch-nightly.mjs --mode date --digest resolved.json
 *   Options: --pulls may be repeated and the lists are unioned; --threshold-hours N
 *            (absence, default 12); --now <ISO> (tests); --json.
 *   Exit 1 on a red verdict, 2 on a bad --mode, 3 when `--mode date` cannot read
 *   one. Writes a report to $GITHUB_STEP_SUMMARY when set.
 *
 * BOTH MODES CONSULT BOTH SIGNALS. `--discover` is not decoration in `absence`:
 * #293 merged as `nightly/2026-08-19-recovery` on the 21st, so a branch-name-only
 * reading goes red on the evening a human just repaired the pipeline. The pool
 * says what shipped; the branch says what was processed.
 */

import fs from "node:fs";
import process from "node:process";

/* 12 HOURS, AND WHY IT TOLERATES GITHUB'S CRON DRIFT.
 *
 * GitHub does not honour cron punctually under load. Measured on this repo: the
 * old 09:40 slot actually started at 10:54 and 11:05 on consecutive days, 75-85
 * minutes late. A threshold that does not absorb that becomes a flaky alarm, and
 * a flaky alarm is worse than none because people learn to ignore it.
 *
 * Worst-case HEALTHY night, all delays stacked:
 *   06:40 cron  + ~85 min drift + ~15 min run   -> digest at ~08:20
 *   ~11:40 agent + a couple of hours of its own -> PR opened  ~14:40
 *   required checks + auto-merge                -> merged     ~15:10
 * That is a digest ~6.8h old at the moment the night succeeds. 12h is roughly
 * double the worst case anyone has measured, and it is not a number invented
 * here: it is the SAME 12h the runner prompt already uses for the mirror-image
 * staleness refusal. One number, two directions, one thing to reason about.
 *
 * Drift can only push a run LATER, never earlier, so drift on the WATCHDOG's own
 * schedule is safe in the only direction that matters — a late watchdog sees an
 * older digest and more merged PRs, never fewer. */
export const DEFAULT_THRESHOLD_HOURS = 12;

const NIGHTLY_PREFIX = "nightly/";

/* ------------------------------------------------------------------- inputs */

/** The UTC calendar day a digest belongs to, or null if it does not state one.
 *  UTC, not local: `nightly/<date>` is minted by an agent whose clock is UTC,
 *  and a digest published at 07:25Z belongs to that day in every timezone the
 *  pipeline runs in. */
export function digestDate(generatedAt) {
  if (typeof generatedAt !== "string" || generatedAt.trim() === "") return null;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function prState(pr) {
  if (!pr || typeof pr !== "object") return "";
  if (pr.mergedAt) return "MERGED";
  return typeof pr.state === "string" ? pr.state.toUpperCase() : "";
}

/** PRs for one night, in a state that means the night was processed.
 *
 *  MERGED or OPEN only. A CLOSED-unmerged `nightly/<date>` is treated as absent:
 *  somebody threw that night away, which may well have been right, but it is not
 *  a state this check may quietly call success.
 *
 *  Matching is `nightly/<date>` exactly, or `nightly/<date>-<suffix>` — #293
 *  shipped as `nightly/2026-08-19-recovery`. The `-` is load bearing: without
 *  it, `startsWith` would let `nightly/2026-08-190` satisfy 2026-08-19. */
export function nightlyPrsFor(pulls, date) {
  if (!Array.isArray(pulls) || typeof date !== "string" || date === "") return [];
  const exact = NIGHTLY_PREFIX + date;
  const suffixed = exact + "-";
  return pulls.filter((pr) => {
    const ref = pr && typeof pr.headRefName === "string" ? pr.headRefName : "";
    if (ref !== exact && !ref.startsWith(suffixed)) return false;
    const st = prState(pr);
    return st === "MERGED" || st === "OPEN";
  });
}

function digestItems(digest) {
  return digest && Array.isArray(digest.resolved) ? digest.resolved : [];
}

/** A comparable key for an Apple trackId, or null when there isn't one.
 *
 *  ONE function, used on both sides of the comparison, so the rule that an
 *  UNKNOWN trackId matches nothing — not even another unknown one — cannot be
 *  half-applied. Today it can only fire defensively: `resolve.mjs` DROPS items
 *  it cannot resolve a trackId for, and 0 of the 1623 items in the pool have a
 *  null one. The rule is here because if that ever changes — a resolve that
 *  keeps unresolvable items rather than dropping them — two nulls keying equal
 *  would let one unresolvable episode in the pool mark every unresolvable
 *  episode in a digest as safely landed, and the guard would go quiet on exactly
 *  the nights it is for. Numbers and strings key the same, because JSON
 *  round-trips through `gh` and `jq` produce both spellings for the same id. */
function trackKey(value) {
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

/** How many of a digest's items reached the published pool.
 *
 *  Matched on `id` OR `apple_track_id`, the same two keys `resolve.mjs` dedups
 *  on. Both, not just `id`: the id is derived from show+title, so a publisher
 *  correcting a typo after the digest was cut changes it, and the trackId is
 *  what actually pins the episode. */
export function landedCount(digest, discover) {
  const items = discover && Array.isArray(discover.items) ? discover.items : [];
  const ids = new Set();
  const tracks = new Set();
  for (const it of items) {
    if (it && typeof it.id === "string") ids.add(it.id);
    const key = it ? trackKey(it.apple_track_id) : null;
    if (key !== null) tracks.add(key);
  }
  let n = 0;
  for (const it of digestItems(digest)) {
    if (!it || typeof it !== "object") continue;
    const idHit = typeof it.id === "string" && ids.has(it.id);
    const key = trackKey(it.apple_track_id);
    const trackHit = key !== null && tracks.has(key);
    if (idHit || trackHit) n += 1;
  }
  return n;
}

/* ----------------------------------------------------------------- verdicts */

const ok = (code, summary, facts) => ({ ok: true, code, summary, facts: facts || {} });
const red = (code, summary, facts) => ({ ok: false, code, summary, facts: facts || {} });

/**
 * Did the night the digest belongs to produce a PR? (issue #290, item 1)
 *
 * Red when a digest that is old enough to have been consumed has no
 * `nightly/<date>` PR. Green while it is still young enough that the agent may
 * legitimately not have run yet — that grace is what makes the check quiet
 * enough to be believed.
 */
export function absenceVerdict({ digest, pulls, discover, now, thresholdHours = DEFAULT_THRESHOLD_HOURS }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return red("BAD_NOW", "`now` is not a timestamp.");

  if (!digest || typeof digest !== "object") {
    return red("UNREADABLE_DIGEST", "No digest to check. The digest branch should always carry one.");
  }
  const generatedAt = digest.generated_at;
  const date = digestDate(generatedAt);
  if (!date) {
    return red("UNREADABLE_DIGEST", `Digest has no usable generated_at (${JSON.stringify(generatedAt)}).`);
  }

  const ageHours = (nowMs - Date.parse(generatedAt)) / 3600000;
  const count = digestItems(digest).length;
  const facts = { date, generated_at: generatedAt, age_hours: Number(ageHours.toFixed(2)), items: count, threshold_hours: thresholdHours };

  /* A digest from the future means a clock is wrong somewhere, and a wrong clock
   * is how this check would silently stop checking: a negative age is forever
   * under any threshold, so the watchdog would be green every night for the rest
   * of time. One hour of slack for ordinary skew, then say so out loud. */
  if (ageHours < -1) {
    return red("DIGEST_FROM_FUTURE", `Digest generated_at is ${(-ageHours).toFixed(1)}h in the future — check the clocks.`, facts);
  }

  /* Runner prompt step 3: an empty digest is a night with nothing to publish, and
   * the runner is told to stop and open no PR. Demanding one here would make the
   * watchdog cry wolf on correct behaviour. */
  if (count === 0) {
    return ok("EMPTY_DIGEST", `Digest for ${date} is empty; the runner correctly opens no PR.`, facts);
  }

  const found = nightlyPrsFor(pulls, date);
  if (found.length > 0) {
    const pr = found[0];
    return ok("PR_FOUND", `${date}: ${count} resolved, ${pr.headRefName} is ${prState(pr)} (#${pr.number}).`, { ...facts, pr: pr.number, pr_state: prState(pr), pr_branch: pr.headRefName });
  }

  /* The pool is the ground truth for "did this content actually ship", and the
   * branch name is only the ground truth for "was this night processed". They
   * come apart on the evening after a hand-run recovery: #293 merged as
   * `nightly/2026-08-19-recovery` on the 21st, so a strict branch-name reading
   * would have gone red that night against a pool that had just been fixed. A
   * false red on the evening a human repaired the pipeline is precisely the
   * alarm-fatigue failure the 12h window is chosen to avoid. */
  const landed = landedCount(digest, discover);
  facts.landed = landed;
  if (landed > 0) {
    return ok(
      "DIGEST_CONSUMED",
      `No ${NIGHTLY_PREFIX}${date} PR, but ${landed}/${count} of that digest's episodes are in the pool, so the night shipped under another branch name.`,
      facts
    );
  }

  if (ageHours <= thresholdHours) {
    return ok("WITHIN_WINDOW", `Digest for ${date} is ${ageHours.toFixed(1)}h old; the agent still has until ${thresholdHours}h.`, facts);
  }

  if (!Array.isArray(pulls) || pulls.length === 0) return pullsUnavailable(date, facts);

  return red(
    "NO_PR_FOR_DIGEST",
    `The ${date} digest published ${count} episodes ${ageHours.toFixed(1)}h ago and no ${NIGHTLY_PREFIX}${date} PR exists, open or merged. The judgment half did not run.`,
    facts
  );
}

/* "I could not tell" must not be spelled the same way as "it did not happen".
 *
 * The callers hand this function a PR list they fetched with `gh`. A transient
 * API failure that yields an empty array reads, to every check above, exactly
 * like a night with no PR — the verdict is red either way, which is the safe
 * direction, but the sentence a human reads would send them hunting a runner
 * that ran fine. The workflows fail loudly on a `gh` error rather than passing
 * an empty list; this is the backstop for when one gets through. */
function pullsUnavailable(date, facts) {
  return red(
    "PULLS_UNAVAILABLE",
    `Could not tell whether ${date} produced a PR: the pull-request list is empty or missing, and none of that digest's episodes are in the pool. Check the fetch step before blaming the runner.`,
    facts
  );
}

/**
 * Would publishing tonight's digest destroy an unmerged one? (issue #290, item 3)
 *
 * Called with the digest CURRENTLY on `refresh-digest` — the one about to be
 * replaced. Red means: stop before the publish step. See the header for why both
 * signals must agree.
 */
export function overwriteVerdict({ digest, pulls, discover, now }) {
  /* No prior digest is the first run ever, not a loss. */
  if (digest === null || digest === undefined) {
    return ok("NO_PRIOR_DIGEST", "No digest on the branch yet — nothing to overwrite.");
  }
  if (typeof digest !== "object") {
    return red("UNREADABLE_DIGEST", "A digest is on the branch but could not be read; refusing to overwrite it blind.");
  }
  const date = digestDate(digest.generated_at);
  if (!date) {
    return red("UNREADABLE_DIGEST", `Digest on the branch has no usable generated_at (${JSON.stringify(digest.generated_at)}); refusing to overwrite it blind.`);
  }

  const count = digestItems(digest).length;
  const facts = { date, generated_at: digest.generated_at, items: count };

  /* `now` is optional and never decides the verdict on its own — it is what lets
   * the report name a `--window-hours` that actually reaches back to this digest
   * (see recoveryWindowHours). The one exception is a clock fault, which is
   * worth its own name: a far-future `generated_at` produces a
   * `nightly/<never>` branch nobody can ever open, so the plain reading would be
   * a permanent OVERWRITE_WOULD_LOSE with a misleading explanation. */
  const nowMs = now === undefined || now === null ? NaN : now instanceof Date ? now.getTime() : Date.parse(now);
  const ageHours = Number.isFinite(nowMs) ? (nowMs - Date.parse(digest.generated_at)) / 3600000 : null;
  if (ageHours !== null) facts.age_hours = Number(ageHours.toFixed(2));
  if (ageHours !== null && ageHours < -1) {
    return red("DIGEST_FROM_FUTURE", `The digest on the branch is dated ${(-ageHours).toFixed(1)}h in the future — check the clocks before publishing over it.`, facts);
  }

  if (count === 0) {
    return ok("EMPTY_DIGEST", `The digest on the branch (${date}) is empty; there is nothing to lose.`, facts);
  }

  const found = nightlyPrsFor(pulls, date);
  const landed = landedCount(digest, discover);
  facts.landed = landed;

  if (found.length > 0) {
    const pr = found[0];
    return ok("PR_EXISTS", `The ${date} digest was processed: ${pr.headRefName} is ${prState(pr)} (#${pr.number}).`, { ...facts, pr: pr.number, pr_state: prState(pr), pr_branch: pr.headRefName });
  }
  if (landed > 0) {
    return ok("DIGEST_CONSUMED", `No ${NIGHTLY_PREFIX}${date} PR, but ${landed}/${count} of that digest's episodes are in the pool, so it was merged under another branch name.`, facts);
  }
  if (!Array.isArray(pulls) || pulls.length === 0) return pullsUnavailable(date, facts);

  return red(
    "OVERWRITE_WOULD_LOSE",
    `Publishing now would overwrite the ${date} digest: ${count} episodes, none of them in data/discover.json, and no ${NIGHTLY_PREFIX}${date} PR open or merged. scan.mjs has already marked them seen, so replacing resolved.json drops them from the pipeline for good.`,
    facts
  );
}

/** The branch name that clears an `OVERWRITE_WOULD_LOSE`.
 *
 *  Named after the DIGEST's date, never the calendar day the recovery happens
 *  on, and this is the difference between a guard that clears itself and one
 *  that stalls the pipeline forever. `nightlyPrsFor` looks for the digest's
 *  date; #293 was named `nightly/2026-08-19-recovery` after the night it
 *  recovered, on the 21st, which is the right instinct and the reason the
 *  suffix form is matched at all. Say the exact string in the report so nobody
 *  has to infer it under pressure. */
export function recoveryBranch(date) {
  return `${NIGHTLY_PREFIX}${date}-recovery`;
}

/** A `--window-hours` that actually reaches back to the stranded digest.
 *
 *  The hardcoded 72 in #293's recovery was right for a digest one day old. It
 *  is wrong for one stranded over a long weekend, and quietly so: the scan
 *  reports success, re-emits nothing from the missing window, `landed` stays 0,
 *  and the guard is red again the next morning with no new information. Round up
 *  to the digest's own age and add half a day of margin, and never go below the
 *  72 the runbook already uses. */
export function recoveryWindowHours(ageHours) {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 72;
  return Math.max(72, Math.ceil(ageHours) + 12);
}

/**
 * S-01: did today's `nightly-refresh` Action itself succeed?
 *
 * Independent of `absenceVerdict` ON PURPOSE — the ask ("today's nightly-refresh
 * run failed -> red, regardless of digest PR state") is deliberately not folded
 * into the PR-shaped checks above. A red `nightly-refresh` run can still leave a
 * PREVIOUS night's digest sitting on `refresh-digest` merged and processed, which
 * makes `absenceVerdict` green — correctly, for the question IT asks ("did last
 * night's digest become a PR"). That is not the same question as "did the
 * scheduled run just fail", and folding them into one verdict would let a broken
 * publish step hide behind an old, healthy PR the way #290's missing agent hid
 * behind a run that logged success. Two verdicts, `nightly-watch` fails on
 * either — see the workflow for how they combine.
 *
 * Only `event === "schedule"` runs count. A manual `workflow_dispatch` retry
 * (someone testing the `overwrite_unmerged_digest` escape hatch, say) must not
 * stand in for the run the cron was supposed to make — a person doing that has
 * already seen it fail once and knows.
 *
 * A run still `in_progress`/`queued` reads OK: a scheduled run that has not
 * finished yet is not a failure, and this check running at 21:40 UTC, long after
 * 06:40 + drift, means that gap should not occur, but going red on it would be a
 * clock-skew false alarm of exactly the kind #290's own header warns against.
 */
export function refreshRunVerdict({ runs, now }) {
  const list = Array.isArray(runs) ? runs : [];
  const scheduled = list.filter((r) => r && typeof r === "object" && r.event === "schedule");
  if (scheduled.length === 0) {
    return ok("NO_SCHEDULED_RUN", "No scheduled nightly-refresh run found to check yet.");
  }

  const createdAt = (r) => Date.parse(r.createdAt ?? r.created_at ?? "");
  const sorted = [...scheduled].sort((a, b) => createdAt(b) - createdAt(a));
  const latest = sorted[0];
  const facts = {
    run_id: latest.databaseId ?? latest.id,
    created_at: latest.createdAt ?? latest.created_at,
    status: latest.status,
    conclusion: typeof latest.conclusion === "string" ? latest.conclusion : null,
  };

  if (typeof latest.status === "string" && latest.status !== "completed") {
    return ok("RUN_IN_PROGRESS", `The latest scheduled nightly-refresh run is still ${latest.status}.`, facts);
  }

  const conclusion = typeof latest.conclusion === "string" ? latest.conclusion.toLowerCase() : "";
  if (conclusion !== "success") {
    return red(
      "REFRESH_RUN_FAILED",
      `Today's scheduled nightly-refresh run did not succeed (conclusion: ${conclusion || "unknown"}). ` +
        "The publish step may not have run at all, so this is red regardless of any digest PR's state.",
      facts
    );
  }
  return ok("REFRESH_RUN_OK", "The latest scheduled nightly-refresh run succeeded.", facts);
}

/* ------------------------------------------------------------------ reports */

export function renderReport(mode, verdict) {
  const head = verdict.ok ? `PASS — nightly watchdog (${mode})` : `FAIL — nightly watchdog (${mode})`;
  const lines = [`### ${head}`, "", verdict.summary, "", `\`${verdict.code}\``];
  const facts = Object.entries(verdict.facts || {});
  if (facts.length) {
    lines.push("", "| fact | value |", "| --- | --- |");
    for (const [k, v] of facts) lines.push(`| ${k} | ${v === null || v === undefined ? "—" : String(v)} |`);
  }
  if (!verdict.ok) lines.push("", ...howToClear(mode, verdict));
  return lines.join("\n") + "\n";
}

/* What to actually do about it.
 *
 * A red run nobody knows how to clear becomes a red run people mute, and in
 * `overwrite` mode it is worse than that: the guard runs first and fails the
 * job, so an operator who cannot clear it has a stalled content pipeline. Two
 * things therefore have to be SAID, not inferred:
 *
 *   1. Do not try to run the runner against the digest that is on the branch.
 *      By the time this fires, that digest is over 12h old by construction, so
 *      the runner prompt's step-2 staleness guard refuses it — correctly, and
 *      an operator who tries it first has burned a cycle discovering that the
 *      two guards agree.
 *   2. The recovery branch's name is load bearing. `nightly/<digest-date>-recovery`
 *      is what makes the guard clear on its own; a branch named after the day
 *      the human did the work matches nothing and leaves the guard red forever.
 */
function howToClear(mode, verdict) {
  if (mode === "run-failed") {
    return [
      "Open the failing `nightly-refresh` run in the Actions tab and read its log — the `#290` header in " +
        "`nightly-refresh.yml` explains the two guards it runs before scanning, and a genuine scan/publish " +
        "failure (rather than one of those guards) usually means re-running the job once the underlying " +
        "cause (rate limit, `gh api` error, a bad feed) is fixed will produce a clean digest.",
      "",
      "This is independent of whether a `nightly/<date>` PR exists for a PREVIOUS night — that only tells you " +
        "the judgment half kept up; it says nothing about whether TODAY's scan and publish actually ran.",
    ];
  }
  const date = verdict.facts && verdict.facts.date;
  if (mode !== "overwrite" || !date) {
    return [
      "Run the `foray-nightly` runner by hand (`docs/agents/runner-prompts/foray-nightly.md`) " +
        "before the next scan overwrites this digest. Issue #290 is what happens when two of these pass unnoticed.",
    ];
  }
  const window = recoveryWindowHours(verdict.facts.age_hours);
  return [
    "**Nothing is lost yet.** This failed before the publish step, so `resolved.json` and " +
      "`refresh-state.json` on `refresh-digest` are untouched and tonight's episodes are still unseen.",
    "",
    "Do NOT run the runner against the digest on the branch — it is over 12h old by the time this " +
      "fires, so step 2 of the runner prompt refuses it, correctly. Re-cut it instead:",
    "",
    "```sh",
    "rm -f data-local/refresh-state.json",
    `node tools/refresh/scan.mjs --window-hours ${window}`,
    "node tools/refresh/resolve.mjs",
    "```",
    "",
    `Then follow \`docs/agents/runner-prompts/foray-nightly.md\` from step 4 and name the branch ` +
      `**\`${recoveryBranch(date)}\`** — after the DIGEST's date, not today's. That is the string this ` +
      `guard looks for; a branch named after the day you did the work clears nothing and it stays red.`,
    "",
    "If those episodes are genuinely gone from the feeds and you accept losing them, re-run " +
      "`nightly-refresh` from the Actions tab with **overwrite_unmerged_digest** set. That is the " +
      "only way past this guard, and it is deliberately a decision someone makes on purpose.",
  ];
}

/* ---------------------------------------------------------------------- CLI */

function readJson(file, { missingIsNull = false } = {}) {
  if (!file) return null;
  if (missingIsNull && !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

/** Every `--pulls` on the command line, in order. */
function argAll(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

/** One PR list from several fetches, deduped on number, first mention winning.
 *
 *  The workflows pass two: a page of recent PRs, and a targeted search for this
 *  digest's own `nightly/<date>` branches. Neither alone is sufficient — a busy
 *  day can push the night's PR off the recent page (35 PRs landed in one session
 *  here), and GitHub's search index lags behind PR creation by minutes. The
 *  union has neither failure and costs one extra API call a day. */
export function mergePulls(lists) {
  const byNumber = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const pr of list) {
      if (!pr || typeof pr !== "object") continue;
      const key = pr.number === undefined ? pr.headRefName : pr.number;
      if (!byNumber.has(key)) byNumber.set(key, pr);
    }
  }
  return [...byNumber.values()];
}

export function run(argv, env = process.env) {
  const mode = arg(argv, "--mode", "absence");
  if (mode !== "absence" && mode !== "overwrite" && mode !== "date" && mode !== "run-failed") {
    return { code: 2, text: `unknown --mode ${mode} (expected absence|overwrite|date|run-failed)\n` };
  }
  const digestPath = arg(argv, "--digest", null);
  const pullsPaths = argAll(argv, "--pulls");
  const runsPath = arg(argv, "--runs", null);
  const discoverPath = arg(argv, "--discover", "data/discover.json");
  const now = arg(argv, "--now", new Date().toISOString());
  const thresholdHours = Number(arg(argv, "--threshold-hours", DEFAULT_THRESHOLD_HOURS));

  /* `--mode date` prints the digest's UTC day and nothing else. It exists so the
   * workflows can build a `head:nightly/<date>` search without a second, drifting
   * copy of digestDate() in YAML — the shape of bug tools/ci/path-policy.mjs was
   * written to end. Exit 3, not 1: "I cannot read this digest" is not a verdict. */
  if (mode === "date") {
    try {
      const date = digestDate((readJson(digestPath, { missingIsNull: true }) || {}).generated_at);
      return date ? { code: 0, text: date + "\n" } : { code: 3, text: "" };
    } catch {
      return { code: 3, text: "" };
    }
  }

  let verdict;
  try {
    if (mode === "run-failed") {
      const runs = readJson(runsPath, { missingIsNull: true });
      verdict = refreshRunVerdict({ runs, now });
    } else {
      const pulls = mergePulls(pullsPaths.map((p) => readJson(p, { missingIsNull: true })));
      /* A missing digest file means different things in the two modes, and getting
       * this backwards is how a watchdog goes green on a broken branch. In
       * `overwrite` there is genuinely nothing to lose. In `absence` the branch is
       * supposed to always carry one, so its absence is itself the alarm. */
      const digest = readJson(digestPath, { missingIsNull: mode === "overwrite" });
      const discover = readJson(discoverPath, { missingIsNull: true });
      verdict =
        mode === "absence"
          ? absenceVerdict({ digest, pulls, discover, now, thresholdHours })
          : overwriteVerdict({ digest, pulls, discover, now });
    }
  } catch (err) {
    verdict = red("UNREADABLE_INPUT", `Could not read the watchdog's inputs: ${err.message}`);
  }

  if (argv.includes("--json")) {
    return { code: verdict.ok ? 0 : 1, text: JSON.stringify({ mode, ...verdict }, null, 2) + "\n", verdict };
  }
  const report = renderReport(mode, verdict);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
    } catch {
      /* A summary we cannot write must never change the verdict. */
    }
  }
  return { code: verdict.ok ? 0 : 1, text: report, verdict };
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/refresh/watch-nightly.mjs");
if (invokedDirectly) {
  const { code, text } = run(process.argv.slice(2));
  process.stdout.write(text);
  process.exit(code);
}
