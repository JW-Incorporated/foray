/* The rules for retrying a store upload.
 *
 * WHAT THIS SUITE IS FOR, STATED FIRST. The saving is a release; the risk is a
 * loop that retries something Apple has already refused, three times, and buries
 * the one line that said why. So most of what is pinned below is the
 * DISCRIMINATION — that a rejection is recognised as final even when its prose
 * also carries a transient-sounding word — rather than the retrying, which is
 * the easy half.
 *
 * THE FIXTURES ARE REAL. `APPLE_500` is the verbatim tail of run 35672098914's
 * ios job, the failure that prompted the whole change. A suite written against
 * paraphrased tool output is the forgiving-fake failure CLAUDE.md names five
 * times: the strings are the entire mechanism here, and a fixture that says
 * what we WISH altool printed would pin nothing at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyUploadFailure, shouldRetry, backoffFor,
  PERMANENT_MARKERS, TRANSIENT_MARKERS, MAX_ATTEMPTS, BACKOFF_SECONDS,
} from "./upload-retry.mjs";

/* ---------- the real thing ---------------------------------------------- */

/** Run 35672098914, ios job 106570740102, 2026-09-22T00:31:29Z. Verbatim. */
const APPLE_500 = `
2026-09-22 00:31:29.105 ERROR: [ContentDelivery.Uploader.A5D028480] CREATE BUILD (ASSET_UPLOAD): received status code 500; internal server error. (OD7Z2YQCYF53IIOVJK24XP4EGI) (500)
2026-09-22 00:31:29.106 ERROR: [ContentDelivery.Uploader.A5D028480] An unexpected error occurred. (500) An unexpected error occurred on the server side. If this issue continues, contact us at https://developer.apple.com/contact/. (ID: OD7Z2YQCYF53IIOVJK24XP4EGI)
   NSUnderlyingError : An unexpected error occurred. (-19241) An unexpected error occurred on the server side.
      status : 500
      code : UNEXPECTED_ERROR
      title : An unexpected error occurred.
   iris-code : UNEXPECTED_ERROR
2026-09-22 00:31:29.110 ERROR: [altool.A5D028480] Failed to upload package.
Failed to upload archive at '/Users/runner/work/_temp/export/App.ipa'.
2026-09-22 00:31:29.111 ERROR: [altool.101096C80] ExitFailure (31)
`;

test("THE FAILURE THAT CAUSED THIS FILE IS RETRIED", () => {
  /* If nothing else here holds, this must. The archive was built, signed,
     exported and validated; Apple's ingestion server returned a 500; the
     release died and Play shipped a build TestFlight never got.
     MUTATION: remove "status code 500" AND "unexpected_error" AND
     "internal server error" from TRANSIENT_MARKERS — it then classifies as
     `unrecognised`, which still retries, so this test alone does not prove the
     list is doing anything. The next test is the one that does. */
  const verdict = classifyUploadFailure(APPLE_500);
  assert.equal(verdict.retry, true);
  assert.equal(verdict.reason, "transient");
});

test("…and it is recognised as transient, not merely unclassified", () => {
  /* The distinction the previous test cannot make. `unrecognised` also retries,
     so a marker list that had quietly stopped matching altool's output would
     leave every assertion about RETRYING green while the log lost the ability
     to say why. The reason is what a reader of the run log sees.
     MUTATION: empty TRANSIENT_MARKERS. This goes red; the one above does not. */
  const verdict = classifyUploadFailure(APPLE_500);
  assert.equal(verdict.reason, "transient", "the log must be able to say WHY it is waiting");
  assert.ok(verdict.marker, "and name the string that decided it");
  assert.ok(APPLE_500.toLowerCase().includes(verdict.marker), "a marker it did not actually contain");
});

/* ---------- the expensive mistake --------------------------------------- */

test("a duplicate build number is NOT retried, even though its prose looks transient", () => {
  /* THE WHOLE REASON PERMANENT IS TESTED FIRST. Apple wraps a rejection in the
     same ERROR furniture as a server fault — a request id, a timestamp, and
     often the word "error" — and this one arrives alongside a generic line. A
     naive "does it contain anything transient" check retries a binary that will
     be refused identically three more times, and the real reason ends up as the
     fourth copy of itself in the log.
     MUTATION: move the TRANSIENT loop above the PERMANENT loop in
     classifyUploadFailure. This goes red. RUN: failed as named. */
  const rejected = `
ERROR: [ContentDelivery.Uploader] An unexpected error occurred.
ERROR ITMS-4238: "Redundant Binary Upload. There already exists a binary upload with build version '2026092224'"
   The bundle version must be higher than the previously uploaded version.
`;
  const verdict = classifyUploadFailure(rejected);
  assert.equal(verdict.retry, false, "a refused binary must not be sent again");
  assert.equal(verdict.reason, "permanent");
});

test("a Play version-code conflict is not retried either", () => {
  const conflict = `
Error: Google Api Error: apkUpgradeVersionConflict: APK specifies a version code that has already been used.
`;
  assert.equal(classifyUploadFailure(conflict).retry, false);
});

test("bad credentials are permanent — retrying cannot make a key valid", () => {
  /* And the failure mode if this were transient is nasty: three attempts, three
     authentication failures, and a run that took nine minutes to tell a founder
     the thing it knew in ten seconds. */
  for (const output of [
    "ERROR: Unable to authenticate. Please check your credentials.",
    "Authentication credentials are missing or invalid.",
    "Error: The caller does not have permission",
  ]) {
    assert.equal(classifyUploadFailure(output).retry, false, output);
  }
});

/* ---------- failing toward the release ---------------------------------- */

test("AN OUTPUT WE CANNOT CLASSIFY IS RETRIED", () => {
  /* The asymmetry, and it is deliberate. Retrying a permanent failure costs a
     few minutes of a runner nobody is waiting on. Not retrying a transient one
     costs the whole release and leaves the two stores out of step. So an
     unknown retries, and MAX_ATTEMPTS is what bounds the waste.
     MUTATION: return `{ retry: false, reason: "unrecognised" }` at the end of
     classifyUploadFailure. This goes red, and in production a new spelling of
     Apple's 500 would silently stop being retried. */
  const verdict = classifyUploadFailure("something nobody has seen before, exit 71");
  assert.equal(verdict.retry, true);
  assert.equal(verdict.reason, "unrecognised");
  assert.equal(verdict.marker, null);
});

test("an empty or absent output is unrecognised, not permanent", () => {
  /* The CLI reads the attempt's log off disk and passes "" when it cannot. A
     log we failed to capture is not evidence that the binary was refused. */
  for (const output of ["", null, undefined, "   "]) {
    const verdict = classifyUploadFailure(output);
    assert.equal(verdict.retry, true, `${JSON.stringify(output)} must not be read as a rejection`);
    assert.equal(verdict.reason, "unrecognised");
  }
});

/* ---------- the loop's arithmetic --------------------------------------- */

test("shouldRetry stops at the attempt budget even for a transient failure", () => {
  /* Otherwise "retry the transient ones" is an unbounded loop holding a macOS
     runner against a server that may be down for an hour — which is the
     watchdog's problem, not this loop's.
     MUTATION: drop the `attempt < maxAttempts` clause. This goes red. */
  assert.equal(shouldRetry(APPLE_500, 1), true, "first failure: try again");
  assert.equal(shouldRetry(APPLE_500, 2), true, "second: one more");
  assert.equal(shouldRetry(APPLE_500, MAX_ATTEMPTS), false, "the budget is spent");
  assert.equal(shouldRetry(APPLE_500, MAX_ATTEMPTS + 1), false);
});

test("a permanent failure is refused on the very first attempt", () => {
  assert.equal(shouldRetry("Redundant Binary Upload", 1), false);
});

test("the backoff grows, and never runs off the end of its table", () => {
  /* A `backoffFor` returning undefined becomes `sleep` with no argument in the
     composite, which is an instant retry wearing a backoff's name — so raising
     MAX_ATTEMPTS without extending the table must degrade to "wait the longest
     we know", never to "do not wait".
     MUTATION: `return table[attempt - 1]` without the Math.min clamp. The last
     assertion goes red. */
  assert.equal(backoffFor(1), BACKOFF_SECONDS[0]);
  assert.equal(backoffFor(2), BACKOFF_SECONDS[1]);
  assert.ok(backoffFor(2) > backoffFor(1), "the second wait is longer than the first");
  assert.equal(backoffFor(99), BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1], "clamped, never undefined");
  assert.equal(backoffFor(0), BACKOFF_SECONDS[0]);
});

test("the total wait is bounded to something a runner can afford", () => {
  /* A macOS runner is the most expensive minute this repo buys, and the founder
     came to this because of a bill. Two waits plus three uploads must stay well
     inside the job timeout rather than turning one bad afternoon at Apple into
     a half-hour of held runner. */
  const total = BACKOFF_SECONDS.slice(0, MAX_ATTEMPTS - 1).reduce((a, b) => a + b, 0);
  assert.ok(total <= 600, `total backoff ${total}s must stay under ten minutes`);
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 4, "enough to beat a blip, not enough to sit out an outage");
});

/* ---------- the lists themselves ---------------------------------------- */

test("every marker is lower case, because the haystack is lower-cased", () => {
  /* A marker with a capital in it can never match, and would fail SILENTLY —
     the classification would simply fall through to `unrecognised`, which
     retries, so nothing would ever go red. Exactly the shape of guard that
     reads as protection and is not.
     MUTATION: add "UNEXPECTED_ERROR" (upper case) to TRANSIENT_MARKERS. */
  for (const marker of [...PERMANENT_MARKERS, ...TRANSIENT_MARKERS]) {
    assert.equal(marker, marker.toLowerCase(), `${marker} can never match`);
    assert.ok(marker.trim().length > 3, `${marker} is too short to be safe`);
  }
});

test("no marker appears in both lists", () => {
  /* One that did would be permanent by virtue of the loop order, silently, and
     the transient entry would read as live code that cannot execute. */
  const both = PERMANENT_MARKERS.filter((m) => TRANSIENT_MARKERS.includes(m));
  assert.deepEqual(both, []);
});

test("no permanent marker is a substring of a transient one, or the order would decide it invisibly", () => {
  /* `includes` is substring matching, so a permanent entry contained inside a
     transient phrase would classify that whole phrase as permanent and nobody
     reading the two lists would see why. */
  for (const p of PERMANENT_MARKERS) {
    for (const t of TRANSIENT_MARKERS) {
      assert.ok(!t.includes(p), `transient "${t}" contains permanent "${p}"`);
    }
  }
});
