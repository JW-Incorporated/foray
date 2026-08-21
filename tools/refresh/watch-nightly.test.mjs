/* Tests for the nightly watchdog (issue #290).
 *   Run: node --test tools/refresh/watch-nightly.test.mjs
 *
 * WHAT THIS SUITE HAS TO PROVE, AND WHY IT IS EASY TO FAKE
 * A watchdog is the single most vacuity-prone thing to test: a fixture that
 * looks healthy makes every assertion pass while the alarm is wired to nothing.
 * CLAUDE.md § "A green test is not evidence until you have broken it" lists five
 * agents who shipped exactly that, each because the fixture was more forgiving
 * than the real thing.
 *
 * So the fixtures here are not invented. `fixtures/nightly-watch/` is the real
 * 2026-08-20 failure, rebuilt from git: the 29 episodes are the ones #293
 * actually recovered, the PR list is the repo's real PR list as it stood that
 * evening, and the pool is `data/discover.json` at `dacf501`, the commit before
 * the catch-up. The healthy fixtures are the SAME digest with the one PR the
 * agent never opened added back — so every green case here is one field away
 * from a red one, and "the fixtures really are the failure" is itself a test
 * (last block) rather than something a reader has to take on faith.
 *
 * Every test names the one-line mutation that makes it fail. All of them were
 * run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THRESHOLD_HOURS,
  absenceVerdict,
  digestDate,
  landedCount,
  mergePulls,
  nightlyPrsFor,
  overwriteVerdict,
  recoveryBranch,
  recoveryWindowHours,
  renderReport,
  run,
} from "./watch-nightly.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures", "nightly-watch");
const CLI = path.join(REPO, "tools", "refresh", "watch-nightly.mjs");

const fixPath = (name) => path.join(FIX, name);
const fixture = (name) => JSON.parse(fs.readFileSync(fixPath(name), "utf8"));

const DIGEST = "digest-2026-08-20.json";
const PULLS_MISS = "pulls-2026-08-20-miss.json";
const PULLS_OK = "pulls-2026-08-20-healthy.json";
const POOL_BEFORE = "discover-2026-08-20.json";
const POOL_MERGED = "discover-2026-08-20-merged.json";

/* The evening the watchdog would have run on the first missed night. */
const WATCH_TIME = "2026-08-20T21:40:00Z";

/* --------------------------------------------------------------- digestDate */

test("digestDate reads the digest's UTC calendar day", () => {
  // Mutation: `.slice(0, 10)` -> `.slice(0, 7)`. Every date becomes a month and
  // no `nightly/<date>` branch can ever match again.
  assert.equal(digestDate("2026-08-20T07:25:11.402Z"), "2026-08-20");
});

test("digestDate is UTC, not the runner's local clock", () => {
  // A digest cut just after midnight UTC belongs to the NEW day, because that is
  // the day the agent will name its branch after. On any US machine the local
  // date is still the 20th.
  // Mutation: `new Date(t).toISOString()` -> `new Date(t).toString()` (then the
  // slice yields "Thu Aug 2"). Also killed by any toLocaleDateString rewrite.
  assert.equal(digestDate("2026-08-21T00:30:00Z"), "2026-08-21");
  assert.equal(digestDate("2026-08-20T23:59:59Z"), "2026-08-20");
});

test("digestDate refuses a generated_at it cannot parse", () => {
  // Mutation: delete the `if (!Number.isFinite(t)) return null;` line. `new
  // Date(NaN).toISOString()` throws, which in `run()` is caught as
  // UNREADABLE_INPUT — still red, but for the wrong reason and with a stack
  // trace instead of a sentence.
  for (const bad of [undefined, null, "", "   ", "last night", 1_755_000_000_000, {}]) {
    assert.equal(digestDate(bad), null, String(bad));
  }
});

/* ------------------------------------------------------------ nightlyPrsFor */

test("nightlyPrsFor finds the exact nightly branch for a date", () => {
  // Mutation: `ref !== exact` -> `ref === exact` in the reject clause. Nothing
  // matches, the watchdog is red every single night, and gets ignored.
  const found = nightlyPrsFor(fixture(PULLS_OK), "2026-08-20");
  assert.equal(found.length, 1);
  assert.equal(found[0].headRefName, "nightly/2026-08-20");
});

test("nightlyPrsFor accepts a suffixed recovery branch", () => {
  // #293 really shipped as `nightly/2026-08-19-recovery`.
  // Mutation: drop the `|| ref.startsWith(suffixed)` arm. A hand-run catch-up
  // night then reads as a miss forever after.
  const pulls = [{ number: 293, headRefName: "nightly/2026-08-19-recovery", state: "MERGED", mergedAt: "2026-08-21T09:14:52Z" }];
  assert.equal(nightlyPrsFor(pulls, "2026-08-19").length, 1);
});

test("nightlyPrsFor does not let a longer date satisfy a shorter one", () => {
  // The `-` in `nightly/<date>-` is the whole boundary. Mutation:
  // `exact + "-"` -> `exact`. Then `nightly/2026-08-190` (or a `nightly/2026-08-2`
  // typo widening to the 20th) counts as the night's PR and the miss goes green.
  const pulls = [{ number: 1, headRefName: "nightly/2026-08-190", state: "MERGED", mergedAt: "x" }];
  assert.deepEqual(nightlyPrsFor(pulls, "2026-08-19"), []);
});

test("nightlyPrsFor ignores PRs from other branches and other nights", () => {
  // Mutation: `return pulls.filter(...)` -> `return pulls`. 57 real PRs, none of
  // them that night's, all of them "proof" the night succeeded.
  const pulls = fixture(PULLS_MISS);
  assert.ok(pulls.length > 20, "fixture should carry the real PR traffic, not just nightlies");
  assert.deepEqual(nightlyPrsFor(pulls, "2026-08-20"), []);
  assert.equal(nightlyPrsFor(pulls, "2026-08-19")[0].number, 284);
});

test("nightlyPrsFor counts an OPEN PR, because the work is safe on its branch", () => {
  // Mutation: `st === "MERGED" || st === "OPEN"` -> `st === "MERGED"`. A night
  // whose PR is sitting in review then trips the alarm every time.
  const pulls = [{ number: 2, headRefName: "nightly/2026-08-20", state: "OPEN", mergedAt: null }];
  assert.equal(nightlyPrsFor(pulls, "2026-08-20").length, 1);
});

test("nightlyPrsFor does not count a CLOSED, unmerged night", () => {
  // Somebody threw that night away. That may have been right, but it is not a
  // state this check may quietly call success.
  // Mutation: add `|| st === "CLOSED"` to the state test.
  const pulls = [{ number: 3, headRefName: "nightly/2026-08-20", state: "CLOSED", mergedAt: null }];
  assert.deepEqual(nightlyPrsFor(pulls, "2026-08-20"), []);
});

test("nightlyPrsFor trusts mergedAt over a stale state string", () => {
  // The REST API reports merged PRs as state CLOSED; only `gh --json state`
  // normalises to MERGED. Reading one field would make the check depend on which
  // API the caller happened to use.
  // Mutation: delete `if (pr.mergedAt) return "MERGED";` from prState.
  const pulls = [{ number: 4, headRefName: "nightly/2026-08-20", state: "CLOSED", mergedAt: "2026-08-20T11:45:52Z" }];
  assert.equal(nightlyPrsFor(pulls, "2026-08-20").length, 1);
});

/* -------------------------------------------------------------- landedCount */

test("landedCount sees the digest's episodes once they are in the pool", () => {
  // Mutation: `if (idHit || trackHit) n += 1;` -> `n += 0;`. Nothing ever counts
  // as landed and the overwrite guard fires on healthy nights.
  const digest = fixture(DIGEST);
  assert.equal(landedCount(digest, fixture(POOL_MERGED)), digest.resolved.length);
});

test("landedCount sees none of them in the pool as it stood that evening", () => {
  // This is the fact the whole incident turns on: 29 episodes published to the
  // digest branch, 0 of them in data/discover.json.
  // Mutation: seed `ids` from the digest instead of the pool.
  assert.equal(landedCount(fixture(DIGEST), fixture(POOL_BEFORE)), 0);
});

test("landedCount matches on apple_track_id when the id has drifted", () => {
  // resolve.mjs dedups on both keys because the id is derived from show+title: a
  // publisher fixing a typo after the digest was cut changes it, and then an
  // episode that DID ship reads as lost.
  // Mutation: drop the `|| trackHit` arm.
  const digest = { generated_at: "2026-08-20T07:25:11Z", resolved: [{ id: "show--titel-typo", apple_track_id: 1000784264014 }] };
  const pool = { items: [{ id: "show--title-fixed", apple_track_id: 1000784264014 }] };
  assert.equal(landedCount(digest, pool), 1);
});

test("landedCount compares track ids across number and string spellings", () => {
  // JSON round-trips through jq and gh have both spellings in the wild.
  // Mutation: `trackKey` -> `return typeof value === "number" ? value : null;`.
  const digest = { resolved: [{ id: "a", apple_track_id: "1000784264014" }] };
  const pool = { items: [{ id: "b", apple_track_id: 1000784264014 }] };
  assert.equal(landedCount(digest, pool), 1);
});

test("landedCount never matches two unknown track ids to each other", () => {
  // Nulls are common — resolve.mjs stores null when Apple has no trackId. If two
  // nulls matched, one unresolvable episode in the pool would mark every
  // unresolvable episode in the digest as safely landed, and OVERWRITE_WOULD_LOSE
  // would be unreachable on exactly the nights it is needed.
  // Mutation: `trackKey`'s body -> `return String(value);`. That is the one line
  // both sides of the comparison share, which is why the rule lives in it and
  // not in two typeof guards a mutation can only half-apply.
  const digest = { resolved: [{ id: "a", apple_track_id: null }] };
  const pool = { items: [{ id: "b", apple_track_id: null }] };
  assert.equal(landedCount(digest, pool), 0);
  // Absent, not merely null — `undefined` must key the same way as `null` does.
  assert.equal(landedCount({ resolved: [{ id: "a" }] }, { items: [{ id: "b" }] }), 0);
  // And the guard must not have eaten the real case along with the null one.
  assert.equal(landedCount({ resolved: [{ id: "a", apple_track_id: 1 }] }, { items: [{ id: "b", apple_track_id: 1 }] }), 1);
});

/* ---------------------------------------------------- absenceVerdict (item 1) */

test("absenceVerdict fires on the real 2026-08-20 night", () => {
  // THE BUG. Digest published, 29 episodes, no nightly/2026-08-20 PR in the real
  // PR list, and every workflow green.
  // Mutation: `return red("NO_PR_FOR_DIGEST", ...)` -> `return ok(...)`.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: WATCH_TIME });
  assert.equal(v.ok, false);
  assert.equal(v.code, "NO_PR_FOR_DIGEST");
  assert.equal(v.facts.items, 29);
  assert.equal(v.facts.date, "2026-08-20");
  assert.match(v.summary, /nightly\/2026-08-20/);
});

test("absenceVerdict passes the same night had the agent opened its PR", () => {
  // Same digest, same hour, one PR added. If this were red too, the test above
  // would be pinning nothing.
  // Mutation: ignore `found` and fall through to the NO_PR_FOR_DIGEST return.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_OK), now: WATCH_TIME });
  assert.equal(v.ok, true);
  assert.equal(v.code, "PR_FOUND");
  assert.equal(v.facts.pr, 289);
});

test("absenceVerdict stays quiet while the agent still has time", () => {
  // 07:25Z digest, checked at 12:00Z: 4.6h old. GitHub's cron drift lives in
  // here — the Action can start 85 minutes late and the agent later still.
  // Mutation: delete the WITHIN_WINDOW branch. The watchdog then goes red
  // every morning between the two halves, which is how an alarm gets ignored.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: "2026-08-20T12:00:00Z" });
  assert.equal(v.ok, true);
  assert.equal(v.code, "WITHIN_WINDOW");
});

test("absenceVerdict's threshold is 12h, and the boundary is where it says", () => {
  // The same 12h the runner prompt uses to refuse a stale digest, deliberately.
  // Mutation: `DEFAULT_THRESHOLD_HOURS = 12` -> `24`. The 19:26Z case goes green
  // and the pipeline can miss a whole night before anything says so.
  assert.equal(DEFAULT_THRESHOLD_HOURS, 12);
  const args = { digest: fixture(DIGEST), pulls: fixture(PULLS_MISS) };
  assert.equal(absenceVerdict({ ...args, now: "2026-08-20T19:24:00Z" }).code, "WITHIN_WINDOW"); // 11.98h
  assert.equal(absenceVerdict({ ...args, now: "2026-08-20T19:26:00Z" }).code, "NO_PR_FOR_DIGEST"); // 12.02h
});

test("absenceVerdict honours an explicit threshold", () => {
  // Mutation: ignore the `thresholdHours` argument and use the constant.
  const args = { digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: WATCH_TIME };
  assert.equal(absenceVerdict({ ...args, thresholdHours: 24 }).code, "WITHIN_WINDOW");
  assert.equal(absenceVerdict({ ...args, thresholdHours: 6 }).code, "NO_PR_FOR_DIGEST");
});

test("absenceVerdict does not demand a PR for an empty digest", () => {
  // Runner prompt step 3: an empty digest is a night with nothing to publish and
  // the runner is told to open no PR. Crying wolf on correct behaviour is how
  // this check would earn its way into everyone's ignore list.
  // Mutation: delete the `count === 0` branch.
  const v = absenceVerdict({ digest: { generated_at: "2026-08-20T07:25:11Z", resolved: [] }, pulls: fixture(PULLS_MISS), now: WATCH_TIME });
  assert.equal(v.ok, true);
  assert.equal(v.code, "EMPTY_DIGEST");
});

test("absenceVerdict goes red on a digest from the future rather than green forever", () => {
  // A wrong clock is how this check would silently stop checking: a negative age
  // is under every threshold, so the watchdog would pass every night from then on.
  // Mutation: delete the `ageHours < -1` branch — the verdict becomes
  // WITHIN_WINDOW and the alarm is permanently disarmed.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: "2026-08-19T07:25:11Z" });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DIGEST_FROM_FUTURE");
});

test("absenceVerdict tolerates an hour of ordinary clock skew", () => {
  // Mutation: `ageHours < -1` -> `ageHours < 0`. Every runner a few minutes
  // ahead of GitHub's clock now reports a clock fault instead of a verdict.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: "2026-08-20T07:00:00Z" });
  assert.equal(v.code, "WITHIN_WINDOW");
});

test("absenceVerdict goes red when the digest branch carries nothing readable", () => {
  // The branch is supposed to always hold a digest, so its absence is itself the
  // alarm. Mutation: `return red("UNREADABLE_DIGEST", ...)` -> `return ok(...)`.
  for (const bad of [null, undefined, {}, { generated_at: "soon" }, { generated_at: null, resolved: [] }]) {
    const v = absenceVerdict({ digest: bad, pulls: fixture(PULLS_MISS), now: WATCH_TIME });
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.equal(v.code, "UNREADABLE_DIGEST");
  }
});

test("absenceVerdict does not go red on the evening a recovery was merged", () => {
  // #293 merged as `nightly/2026-08-19-recovery` on the 21st. A branch-name-only
  // reading of the 08-20 digest would go red that evening against a pool that had
  // just been repaired — a false alarm on the night a human fixed the pipeline,
  // which is the exact way an alarm earns its way into everyone's ignore list.
  // Mutation: delete the `landed > 0` branch from absenceVerdict.
  const v = absenceVerdict({
    digest: fixture(DIGEST),
    pulls: fixture(PULLS_MISS),
    discover: fixture(POOL_MERGED),
    now: WATCH_TIME,
  });
  assert.equal(v.ok, true);
  assert.equal(v.code, "DIGEST_CONSUMED");
  assert.equal(v.facts.landed, 29);
});

test("absenceVerdict still fires when the pool has none of it, pool supplied or not", () => {
  // The corollary of the test above: adding the pool signal must not soften the
  // alarm on the real miss. Mutation: `landed > 0` -> `landed >= 0`.
  for (const discover of [fixture(POOL_BEFORE), null, undefined]) {
    const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover, now: WATCH_TIME });
    assert.equal(v.code, "NO_PR_FOR_DIGEST");
  }
});

test("an empty PR list is reported as ignorance, not as absence", () => {
  // A `gh` blip that yields `[]` looks, to every check, exactly like a night
  // with no PR. Red either way — but the sentence a human reads would send them
  // hunting a runner that ran fine. Mutation: delete both `pullsUnavailable`
  // calls; the codes collapse back to NO_PR_FOR_DIGEST / OVERWRITE_WOULD_LOSE.
  const a = absenceVerdict({ digest: fixture(DIGEST), pulls: [], discover: fixture(POOL_BEFORE), now: WATCH_TIME });
  assert.equal(a.ok, false);
  assert.equal(a.code, "PULLS_UNAVAILABLE");
  const o = overwriteVerdict({ digest: fixture(DIGEST), pulls: null, discover: fixture(POOL_BEFORE) });
  assert.equal(o.ok, false);
  assert.equal(o.code, "PULLS_UNAVAILABLE");
});

test("PULLS_UNAVAILABLE never pre-empts a green verdict", () => {
  // It sits after every pass, so a young digest or one that shipped stays green
  // even when the PR list could not be fetched. Mutation: move the
  // `pullsUnavailable` guard above the WITHIN_WINDOW check.
  assert.equal(absenceVerdict({ digest: fixture(DIGEST), pulls: [], now: "2026-08-20T12:00:00Z" }).code, "WITHIN_WINDOW");
  assert.equal(overwriteVerdict({ digest: fixture(DIGEST), pulls: [], discover: fixture(POOL_MERGED) }).code, "DIGEST_CONSUMED");
});

test("absenceVerdict rejects a `now` it cannot read instead of guessing", () => {
  // Mutation: `if (!Number.isFinite(nowMs))` -> `if (false)`. Every age becomes
  // NaN, NaN passes no comparison, and the verdict is a silent PR_FOUND/red coin
  // flip depending on branch order.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: [], now: "tonight" });
  assert.equal(v.ok, false);
  assert.equal(v.code, "BAD_NOW");
});

/* ------------------------------------------------- overwriteVerdict (item 3) */

test("overwriteVerdict fires on the exact condition that destroyed 2026-08-19", () => {
  // THE ONE THAT MATTERS. On the morning of 08-21 the Action was about to
  // replace a 29-episode digest whose night never merged. It did, and the 08-19
  // tail left the pipeline: that Wednesday held 10 episodes against the previous
  // Wednesday's 30.
  // Mutation: `return red("OVERWRITE_WOULD_LOSE", ...)` -> `return ok(...)`.
  const v = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) });
  assert.equal(v.ok, false);
  assert.equal(v.code, "OVERWRITE_WOULD_LOSE");
  assert.equal(v.facts.items, 29);
  assert.equal(v.facts.landed, 0);
});

test("overwriteVerdict passes on the ordinary morning, where last night merged", () => {
  // The steady state the Action sees at 06:40 every day: yesterday's digest on
  // the branch, yesterday's PR merged at ~11:45. If this were red the guard
  // would block the pipeline nightly.
  // Mutation: delete the `found.length > 0` branch.
  const v = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_OK), discover: fixture(POOL_BEFORE) });
  assert.equal(v.ok, true);
  assert.equal(v.code, "PR_EXISTS");
  assert.equal(v.facts.pr, 289);
});

test("overwriteVerdict passes while the night's PR is still open", () => {
  // An unmerged PR still holds the work on its own branch, so overwriting the
  // digest loses nothing.
  // Mutation: require `prState(pr) === "MERGED"` here.
  const pulls = [{ number: 5, headRefName: "nightly/2026-08-20", state: "OPEN", mergedAt: null }];
  assert.equal(overwriteVerdict({ digest: fixture(DIGEST), pulls, discover: fixture(POOL_BEFORE) }).code, "PR_EXISTS");
});

test("overwriteVerdict passes when the episodes shipped under another branch name", () => {
  // The pool is the ground truth for "did this content actually ship". A
  // renamed or hand-run merge must not read as loss.
  // Mutation: delete the `landed > 0` branch.
  const v = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_MERGED) });
  assert.equal(v.ok, true);
  assert.equal(v.code, "DIGEST_CONSUMED");
  assert.equal(v.facts.landed, 29);
});

test("overwriteVerdict treats a partly-consumed digest as consumed, not as loss", () => {
  // This is why the check needs BOTH signals. The runner is TOLD to drop
  // cross-promos, trailers, encores and between-seasons filler, so a healthy
  // night legitimately leaves items in the digest that never reach the pool.
  // "Zero of 29 landed" is the only unambiguous reading.
  // Mutation: `landed > 0` -> `landed === count`. Every night on which the agent
  // dropped a single trailer now reports data loss, and the guard blocks the
  // Action until a human clears it.
  const digest = fixture(DIGEST);
  const pool = { items: [{ id: digest.resolved[7].id, apple_track_id: digest.resolved[7].apple_track_id }] };
  const v = overwriteVerdict({ digest, pulls: fixture(PULLS_MISS), discover: pool });
  assert.equal(v.ok, true);
  assert.equal(v.facts.landed, 1);
});

test("overwriteVerdict has nothing to lose on an empty prior digest", () => {
  // Mutation: delete the `count === 0` branch. A night the Action correctly
  // found nothing on now blocks the next night's scan.
  const v = overwriteVerdict({ digest: { generated_at: "2026-08-20T07:25:11Z", resolved: [] }, pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) });
  assert.equal(v.ok, true);
  assert.equal(v.code, "EMPTY_DIGEST");
});

test("overwriteVerdict treats a branch with no digest yet as the first run", () => {
  // Mutation: `digest === null || digest === undefined` -> `digest === null`,
  // and the very first run of a fresh repo fails before it can publish anything.
  assert.equal(overwriteVerdict({ digest: null, pulls: [], discover: null }).code, "NO_PRIOR_DIGEST");
  assert.equal(overwriteVerdict({ digest: undefined, pulls: [], discover: null }).code, "NO_PRIOR_DIGEST");
});

test("overwriteVerdict refuses to overwrite a digest it cannot read", () => {
  // A corrupt digest is the one case where the contents are unknowable, so the
  // only safe direction is to stop. Mutation: `return red("UNREADABLE_DIGEST", ...)`
  // -> `return ok(...)`, and a truncated digest is silently replaced.
  for (const bad of [{}, { generated_at: 42, resolved: [{ id: "x" }] }, "not an object"]) {
    const v = overwriteVerdict({ digest: bad, pulls: [], discover: null });
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.equal(v.code, "UNREADABLE_DIGEST");
  }
});

test("overwriteVerdict does not need a pool to reach a verdict", () => {
  // The Action runs from a bare checkout; if data/discover.json ever moves, the
  // PR signal must still work rather than the check crashing green.
  // Mutation: `discover && Array.isArray(discover.items) ? ... : []` -> `discover.items`.
  assert.equal(overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_OK), discover: null }).code, "PR_EXISTS");
  assert.equal(overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: null }).code, "OVERWRITE_WOULD_LOSE");
});

test("overwriteVerdict names a clock fault rather than blaming the runner", () => {
  // A far-future generated_at produces a `nightly/<never>` nobody can open, so
  // the plain reading is a permanent OVERWRITE_WOULD_LOSE with a misleading
  // sentence. Mutation: delete the `ageHours < -1` branch from overwriteVerdict.
  const v = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE), now: "2026-08-19T07:25:11Z" });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DIGEST_FROM_FUTURE");
});

test("overwriteVerdict's `now` is optional and never flips a verdict on its own", () => {
  // It exists to size the recovery window, not to judge. Mutation: make the
  // `ageHours !== null` guard unconditional — every call without `now` then
  // compares against NaN and the age facts become garbage.
  const args = { digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) };
  assert.equal(overwriteVerdict(args).code, "OVERWRITE_WOULD_LOSE");
  assert.equal(overwriteVerdict({ ...args, now: "2026-08-21T06:40:00Z" }).code, "OVERWRITE_WOULD_LOSE");
  assert.equal(overwriteVerdict(args).facts.age_hours, undefined);
  assert.equal(overwriteVerdict({ ...args, now: "2026-08-21T06:40:00Z" }).facts.age_hours, 23.25);
});

/* -------------------------------------------------------- clearing the guard */

test("recoveryBranch is named after the digest, not the day of the rescue", () => {
  // The guard clears only when a branch matching the DIGEST's date appears. #293
  // was named `nightly/2026-08-19-recovery` on the 21st — right instinct, and the
  // reason the suffix form is matched at all. A branch named for the rescue day
  // matches nothing and leaves the pipeline stalled indefinitely, which is worse
  // than the bug this guard is for.
  // Mutation: `${date}-recovery` -> `${new Date().toISOString().slice(0,10)}-recovery`.
  assert.equal(recoveryBranch("2026-08-20"), "nightly/2026-08-20-recovery");
  assert.equal(nightlyPrsFor([{ number: 9, headRefName: recoveryBranch("2026-08-20"), state: "MERGED", mergedAt: "x" }], "2026-08-20").length, 1);
});

test("recoveryWindowHours reaches back past the stranded digest", () => {
  // #293's runbook says 72, which is right for a digest one day old and silently
  // wrong for one stranded over a long weekend: the re-scan reports success,
  // re-emits nothing from the missing window, and the guard is red again the next
  // morning with no new information.
  // Mutation: `Math.max(72, Math.ceil(ageHours) + 12)` -> `72`.
  assert.equal(recoveryWindowHours(23.25), 72); // the ordinary case keeps the runbook number
  assert.equal(recoveryWindowHours(96), 108); // a long weekend needs more than 72
  assert.equal(recoveryWindowHours(undefined), 72);
  assert.equal(recoveryWindowHours(-5), 72);
});

/* ------------------------------------------------------------------ reports */

test("renderReport leads with PASS or FAIL so a run summary is readable at a glance", () => {
  // Mutation: swap the two branches of the `verdict.ok ?` ternary. The step
  // summary then says PASS on the night it fires — the exact "green run that
  // reads like success" this issue is about.
  const bad = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) });
  const good = overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_OK), discover: fixture(POOL_BEFORE) });
  assert.match(renderReport("overwrite", bad), /^### FAIL/);
  assert.match(renderReport("overwrite", good), /^### PASS/);
});

test("renderReport tells a failing night what to do next", () => {
  // A red run nobody knows how to clear becomes a red run people mute.
  // Mutation: delete the `if (!verdict.ok)` block.
  const v = absenceVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), now: WATCH_TIME });
  assert.match(renderReport("absence", v), /foray-nightly\.md/);
  assert.match(renderReport("overwrite", overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) })), /untouched/);
});

test("the overwrite report spells out the branch name that clears the guard", () => {
  // The guard fails the job BEFORE the scan, so an operator who cannot clear it
  // has a stalled content pipeline — worse than the bug. The exact branch name is
  // the difference between clearing it and not, so it is printed, not implied.
  // Mutation: `howToClear` -> return the absence sentence for both modes.
  const report = renderReport("overwrite", overwriteVerdict({
    digest: fixture(DIGEST),
    pulls: fixture(PULLS_MISS),
    discover: fixture(POOL_BEFORE),
    now: "2026-08-21T06:40:00Z",
  }));
  assert.match(report, /nightly\/2026-08-20-recovery/);
  assert.match(report, /--window-hours 72/);
  assert.match(report, /overwrite_unmerged_digest/);
});

test("the overwrite report tells the operator NOT to retry the stale digest", () => {
  // By the time this fires the digest is >12h old, so the runner prompt's step-2
  // staleness guard refuses it. An earlier draft of this text suggested running
  // the runner against it first, which sent the responder into a refusal on every
  // single occurrence.
  // Mutation: drop the "Do NOT run the runner" line from howToClear.
  const report = renderReport("overwrite", overwriteVerdict({ digest: fixture(DIGEST), pulls: fixture(PULLS_MISS), discover: fixture(POOL_BEFORE) }));
  assert.match(report, /Do NOT run the runner against the digest on the branch/);
  assert.match(report, /scan\.mjs --window-hours/);
});

test("the recovery window in the report grows with the digest's age", () => {
  // Mutation: `recoveryWindowHours(verdict.facts.age_hours)` -> `72`.
  const stranded = renderReport("overwrite", overwriteVerdict({
    digest: fixture(DIGEST),
    pulls: fixture(PULLS_MISS),
    discover: fixture(POOL_BEFORE),
    now: "2026-08-24T06:40:00Z", // four days stranded
  }));
  assert.match(stranded, /--window-hours 108/);
});

/* ---------------------------------------------------------------------- CLI */

/* `--discover` defaults to `data/discover.json`, which is live content that
 * changes every night — so every CLI case here passes the fixture pool
 * explicitly. Leaving it off is not a smaller test, it is a test whose verdict
 * depends on what shipped last night: the first draft of the job-summary case
 * omitted it and flipped from NO_PR_FOR_DIGEST to DIGEST_CONSUMED as soon as
 * #293 put those 29 episodes into the real pool. */
function cli(args, env = {}) {
  const withPool = args.includes("--discover") ? args : [...args, "--discover", fixPath(POOL_BEFORE)];
  return run(withPool, { ...env });
}

test("the CLI exits 1 on the real miss and 0 on the night that worked", () => {
  // The end-to-end proof: same binary, same digest, one PR apart. `--discover` is
  // the pool as it stood that evening, so it cannot be what carries the green
  // case — swapping it for POOL_MERGED turns BOTH into passes, which is asserted
  // below so this argument is coverage rather than decoration.
  // Mutation: `verdict.ok ? 0 : 1` -> `0`.
  const base = ["--mode", "absence", "--digest", fixPath(DIGEST), "--now", WATCH_TIME, "--discover", fixPath(POOL_BEFORE)];
  assert.equal(cli([...base, "--pulls", fixPath(PULLS_MISS)]).code, 1);
  assert.equal(cli([...base, "--pulls", fixPath(PULLS_OK)]).code, 0);

  const merged = ["--mode", "absence", "--digest", fixPath(DIGEST), "--now", WATCH_TIME, "--discover", fixPath(POOL_MERGED), "--pulls", fixPath(PULLS_MISS)];
  assert.equal(cli(merged).verdict.code, "DIGEST_CONSUMED");
});

test("--pulls may be repeated, and the lists are unioned", () => {
  // The workflows pass two: a page of recent PRs, and a targeted search for this
  // digest's own branches. Neither alone is enough — a busy day pushes the
  // night's PR off the recent page, and GitHub's search index lags creation.
  // Mutation: `argAll` -> `[arg(argv, "--pulls", null)]`, which keeps only the
  // FIRST list, so a PR that only the targeted search found is invisible.
  const out = cli([
    "--mode", "absence",
    "--digest", fixPath(DIGEST),
    "--pulls", fixPath(PULLS_MISS),
    "--pulls", fixPath(PULLS_OK),
    "--discover", fixPath(POOL_BEFORE),
    "--now", WATCH_TIME,
  ]);
  assert.equal(out.code, 0);
  assert.equal(out.verdict.code, "PR_FOUND");
});

test("mergePulls dedupes on number and survives a fetch that returned nothing", () => {
  // Mutation: `if (!byNumber.has(key)) byNumber.set(key, pr);` -> `byNumber.set(key, pr);`
  // is harmless; the one that matters is dropping the `Array.isArray` skip, which
  // throws on the null a missing --pulls file produces.
  assert.deepEqual(mergePulls([[{ number: 1 }], [{ number: 1 }, { number: 2 }]]).map((p) => p.number), [1, 2]);
  assert.deepEqual(mergePulls([null, undefined, [{ number: 3 }]]).map((p) => p.number), [3]);
  assert.deepEqual(mergePulls([]), []);
});

test("--mode date prints the digest's day so the workflows need no second copy", () => {
  // The workflows build a `head:nightly/<date>` search from this. A second,
  // drifting implementation of digestDate() in YAML is the shape of bug
  // tools/ci/path-policy.mjs exists to end.
  // Mutation: `code: 0, text: date` -> `code: 0, text: new Date().toISOString().slice(0,10)`.
  const out = cli(["--mode", "date", "--digest", fixPath(DIGEST)]);
  assert.equal(out.code, 0);
  assert.equal(out.text, "2026-08-20\n");
});

test("--mode date exits 3 on an unreadable digest, not 0 with an empty answer", () => {
  // A workflow that captures this into a shell variable must be able to tell
  // "no date" from "the empty date". Mutation: `code: 3` -> `code: 0`.
  assert.equal(cli(["--mode", "date", "--digest", fixPath("no-such-digest.json")]).code, 3);
});

test("the CLI exits 1 on the overwrite condition and 0 once the night merged", () => {
  // Mutation: route `--mode overwrite` to absenceVerdict. The overwrite case
  // then reads NO_PR_FOR_DIGEST at best and WITHIN_WINDOW at worst, depending on
  // when it runs — which is the failure, not the guard.
  const base = ["--mode", "overwrite", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_MISS)];
  assert.equal(cli([...base, "--discover", fixPath(POOL_BEFORE)]).code, 1);
  assert.equal(cli([...base, "--discover", fixPath(POOL_MERGED)]).code, 0);
});

test("the real process exits non-zero, not merely the exported run()", () => {
  // A workflow reads the exit code, so that is what has to be proven. Mutation:
  // change the `invokedDirectly` suffix test so the CLI block never executes —
  // the script then prints nothing and exits 0 on every failing night.
  const args = ["--mode", "overwrite", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_MISS), "--discover", fixPath(POOL_BEFORE)];
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || "");
  }
  assert.equal(status, 1);
  assert.match(stdout, /OVERWRITE_WOULD_LOSE/);

  const okArgs = ["--mode", "overwrite", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_OK), "--discover", fixPath(POOL_BEFORE)];
  const okOut = execFileSync(process.execPath, [CLI, ...okArgs], { encoding: "utf8" });
  assert.match(okOut, /^### PASS/);
});

test("the CLI writes its report into the job summary", () => {
  // Mutation: drop the `env.GITHUB_STEP_SUMMARY` append. The workflow log still
  // has it, but the run summary — the thing an operator actually reads — is bare.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-nightly-")), "summary.md");
  fs.writeFileSync(file, "");
  cli(["--mode", "absence", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_MISS), "--now", WATCH_TIME], { GITHUB_STEP_SUMMARY: file });
  assert.match(fs.readFileSync(file, "utf8"), /FAIL — nightly watchdog \(absence\)[\s\S]*NO_PR_FOR_DIGEST/);
});

test("a job summary that cannot be written never changes the verdict", () => {
  // Mutation: remove the try/catch around appendFileSync. A read-only runner
  // filesystem then turns a PASS into a crash and a FAIL into a different one.
  const out = cli(["--mode", "absence", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_OK), "--now", WATCH_TIME], {
    GITHUB_STEP_SUMMARY: path.join(FIX, "no-such-dir", "summary.md"),
  });
  assert.equal(out.code, 0);
});

test("--json emits the verdict code for anything downstream", () => {
  // Mutation: `verdict.ok ? 0 : 1` in the --json branch -> `0`.
  const out = cli(["--mode", "overwrite", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_MISS), "--discover", fixPath(POOL_BEFORE), "--json"]);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.code, "OVERWRITE_WOULD_LOSE");
  assert.equal(parsed.mode, "overwrite");
  assert.equal(out.code, 1);
});

test("an unknown --mode exits 2 rather than quietly checking something else", () => {
  // Mutation: delete the mode guard and let it fall through to the absence
  // default. A workflow with a typo'd mode then runs the wrong check, greenly.
  assert.equal(cli(["--mode", "overwite", "--digest", fixPath(DIGEST), "--pulls", fixPath(PULLS_MISS)]).code, 2);
});

test("a missing digest file is red for absence and green for overwrite", () => {
  // The asymmetry is deliberate and getting it backwards is how a watchdog goes
  // green on a broken branch: `overwrite` has genuinely nothing to lose, while
  // `absence` is looking at a branch that should always carry a digest.
  // Mutation: `missingIsNull: mode === "overwrite"` -> `missingIsNull: true`.
  const gone = fixPath("no-such-digest.json");
  assert.equal(cli(["--mode", "overwrite", "--digest", gone, "--pulls", fixPath(PULLS_MISS)]).code, 0);
  const absent = cli(["--mode", "absence", "--digest", gone, "--pulls", fixPath(PULLS_MISS), "--now", WATCH_TIME]);
  assert.equal(absent.code, 1);
  assert.equal(absent.verdict.code, "UNREADABLE_INPUT");
});

test("malformed JSON is a red verdict, not an unhandled throw", () => {
  // An exception escaping run() would surface as a workflow error whose text
  // says nothing about the night. Mutation: delete the try/catch in run().
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "watch-nightly-")), "resolved.json");
  fs.writeFileSync(bad, "{ this is not json");
  const out = cli(["--mode", "absence", "--digest", bad, "--pulls", fixPath(PULLS_MISS), "--now", WATCH_TIME]);
  assert.equal(out.code, 1);
  assert.equal(out.verdict.code, "UNREADABLE_INPUT");
});

/* ------------------------------------------------------------- the fixtures */

test("the committed fixtures really are the 2026-08-20 failure", () => {
  // The guard on this suite. Every red assertion above is only worth what the
  // fixture is worth, and the named failure of five previous rounds
  // (CLAUDE.md § "A green test is not evidence") is a fixture more forgiving
  // than the real thing. So the fixture's own shape is pinned here.
  // Mutation: regenerate digest-2026-08-20.json with `resolved: []` — every
  // "fires" test above would go green on EMPTY_DIGEST and only this one fails.
  const digest = fixture(DIGEST);
  assert.equal(digest.resolved.length, 29, "the Action logged 29 resolved episodes that night");
  assert.equal(digest.generated_at.slice(0, 10), "2026-08-20");
  for (const it of digest.resolved) {
    assert.equal(typeof it.id, "string");
    assert.equal(typeof it.apple_track_id, "number");
  }

  const miss = fixture(PULLS_MISS);
  assert.deepEqual(
    miss.filter((p) => p.headRefName.startsWith("nightly/")).map((p) => p.headRefName),
    ["nightly/2026-08-19", "nightly/2026-08-18", "nightly/2026-08-17"],
    "the real PR list that evening: three nightlies, and none of them the 20th"
  );

  // Stated so the gap is a known one rather than an unnoticed one: the real list
  // holds no CLOSED-unmerged PR, so the "a thrown-away night is not success" rule
  // is exercised only against a hand-built array above. If a CLOSED row ever
  // appears here, point that rule at it.
  assert.deepEqual([...new Set(miss.map((p) => p.state))].sort(), ["MERGED", "OPEN"]);

  // The healthy fixture must differ by exactly one PR, or the green cases are
  // being carried by something other than the agent having run.
  const healthy = fixture(PULLS_OK);
  assert.equal(healthy.length, miss.length + 1);
  assert.equal(healthy[0].headRefName, "nightly/2026-08-20");
});

test("the pool fixtures differ by exactly the digest, and nothing else", () => {
  // The `before` pool must not contain a single one of the digest's episodes —
  // if it did, DIGEST_CONSUMED would carry the overwrite tests and
  // OVERWRITE_WOULD_LOSE would be unreachable.
  // Mutation: build discover-2026-08-20.json from `81f7179` instead of `dacf501`.
  const digest = fixture(DIGEST);
  const before = fixture(POOL_BEFORE);
  const merged = fixture(POOL_MERGED);
  const ids = new Set(digest.resolved.map((i) => i.id));
  assert.equal(before.items.filter((i) => ids.has(i.id)).length, 0);
  assert.equal(merged.items.filter((i) => ids.has(i.id)).length, 29);
  assert.equal(merged.items.length, before.items.length + 29);
  assert.ok(before.items.length >= 50, "a realistic pool, not a two-item stub");
});
