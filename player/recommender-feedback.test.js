/* Local listening observations for the recommender (RV-17, #1380;
 * docs/roadmap/recommender-v1.md, decisions D2 and D5).
 *
 * WHAT THIS SUITE GUARDS, beyond the arithmetic: the privacy shape of D5. The
 * module turns values the caller already read into per-show observations and
 * must never read a key, write one, send anything or log an event, and follows
 * must stay out of the weighting until the policy sentence about them changes
 * (RV-24). Two tests below exist only for that.
 *
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  effectiveLength, completionBucket, completionFraction,
  lengthExpectedCompletion, completionResidual,
  observationsFromDevice, SAVED_OBS, FOLLOW_OBS,
} from "./recommender-feedback.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60;

/* Episode ids are "<show>/<n>"; the caller's mapping is the prefix. */
const showKeyOf = (id) => String(id).split("/")[0] || null;

test("a stop inside the outro margin is complete", () => {
  /* MUTATION: `outroMarginSec = OUTRO_MARGIN_SEC` -> `outroMarginSec = 0` in
     effectiveLength — red: the effective length of a 50-minute episode becomes
     3000 s and the stop at 2,660 s (5.6 minutes before the end, 0.905 of the
     2,940 s effective length) falls to "engaged". */
  const dur = 50 * MIN;
  assert.equal(effectiveLength(dur), 2940);
  assert.equal(effectiveLength(5 * MIN), 270, "short episodes keep 90% of their length, not duration - 60 s");
  assert.equal(completionBucket(dur - 40, dur), "complete", "40 s before the end of a 50-minute episode");
  assert.equal(completionBucket(2660, dur), "complete");
  assert.equal(completionFraction(dur - 40, dur), 1, "capped at 1");
});

test("under 120 s is a bounce regardless of length", () => {
  /* MUTATION: drop `|| positionSec < BOUNCE_FLOOR_SEC` in completionBucket —
     red: 100 s into a 10-minute episode is 0.185 of its 540 s effective length,
     which would be "sampled". */
  assert.equal(completionBucket(90, 50 * MIN), "bounce", "90 s into a 50-minute episode");
  assert.equal(completionBucket(100, 10 * MIN), "bounce");
  assert.equal(completionBucket(119, 3 * MIN), "bounce");
  assert.equal(completionBucket(150, 10 * MIN), "sampled", "past the floor the fractions decide");
  /* A trailer heard to its end left nothing early: the floor does not apply. */
  assert.equal(completionBucket(100, 100), "complete");
});

test("buckets at 0.1 / 0.4 / 0.9 of effective length", () => {
  /* MUTATION: `ENGAGED_FRACTION = 0.4` -> `0.5` — red: 0.4 of the effective
     length would still be "sampled". (0.1 -> 0.2 and 0.9 -> 0.95 are red on
     the neighbouring assertions too.) */
  const dur = 100 * MIN; // effective length 5,940 s
  const eff = effectiveLength(dur);
  assert.equal(eff, 5940);
  assert.equal(completionBucket(0.1 * eff - 1, dur), "bounce");
  assert.equal(completionBucket(0.1 * eff, dur), "sampled");
  assert.equal(completionBucket(0.4 * eff - 1, dur), "sampled");
  assert.equal(completionBucket(0.4 * eff, dur), "engaged");
  assert.equal(completionBucket(0.9 * eff - 1, dur), "engaged");
  assert.equal(completionBucket(0.9 * eff, dur), "complete");
  assert.equal(completionBucket(100, 0), null, "no duration, no bucket");
  assert.equal(completionBucket(-1, dur), null);
});

test("residual is positive when above the length-expected curve", () => {
  /* MUTATION: `return bucketValue - lengthExpectedCompletion(durationMin)` ->
     `return lengthExpectedCompletion(durationMin) - bucketValue` — red on every
     sign below. */
  assert.equal(lengthExpectedCompletion(25), 0.8);
  assert.equal(lengthExpectedCompletion(30), 0.8);
  assert.equal(lengthExpectedCompletion(45), 0.7);
  assert.equal(lengthExpectedCompletion(60), 0.7);
  assert.equal(lengthExpectedCompletion(61), 0.58);
  /* The card's case: a 25-minute episode played to 80% is engaged, above the
     curve (0.833 of its 1,440 s effective length against 0.8 expected). */
  const dur = 25 * MIN;
  const pos = 0.8 * dur;
  assert.equal(completionBucket(pos, dur), "engaged");
  assert.ok(completionResidual(completionFraction(pos, dur), 25) > 0);
  assert.ok(completionResidual(0.5, 90) < 0, "half of a 90-minute episode is below the 0.58 curve");
  /* And it reaches the observation: above 3 for the engaged listen, below 3
     for a bounce. */
  const o = observationsFromDevice(
    { positions: { "a/1": pos, "b/1": 30 }, durations: { "a/1": dur, "b/1": 40 * MIN } },
    { showKeyOf },
  );
  assert.ok(o.a.obs > 3, `engaged above the curve maps above 3, got ${o.a.obs}`);
  assert.ok(o.b.obs < 3, `a bounce maps below 3, got ${o.b.obs}`);
  assert.equal(o.b.n, 1, "a bounce still counts one observation");
});

test("saved adds one observation at 4.5", () => {
  /* MUTATION: `SAVED_OBS = 4.5` -> `5.0` — red. */
  assert.equal(SAVED_OBS, 4.5);
  const o = observationsFromDevice({ saved: { "s/9": { title: "x" } } }, { showKeyOf });
  assert.equal(o.s.n, 1);
  assert.equal(o.s.obs, 4.5);
  assert.deepEqual(o.s.outcomes, [{ kind: "saved", episode_id: "s/9", value: 4.5 }]);
  /* A saved episode that was also heard is two observations. */
  const both = observationsFromDevice(
    { positions: { "s/9": 50 * MIN - 10 }, durations: { "s/9": 50 * MIN }, saved: { "s/9": {} } },
    { showKeyOf },
  );
  assert.equal(both.s.n, 2);
});

test("follows are ignored by default", () => {
  /* MUTATION: `useFollows = false` -> `useFollows = true` in the
     observationsFromDevice signature — red: the followed show appears. D5: the
     followed-shows policy row promises following "never changes what 4a
     surfaces to you elsewhere" (docs/legal/privacy-policy.md). */
  const o = observationsFromDevice({ starred: { f: { alerts: true } } }, { showKeyOf });
  assert.deepEqual(o, {});
  const withListen = observationsFromDevice(
    { starred: { f: {} }, positions: { "f/1": 50 * MIN - 10 }, durations: { "f/1": 50 * MIN } },
    { showKeyOf },
  );
  assert.equal(withListen.f.n, 1, "only the listen counts");
});

test("follows add one observation at 4.5 when enabled", () => {
  /* MUTATION: `if (useFollows === true)` -> `if (false)` (ignore the flag) —
     red: nothing is added. */
  assert.equal(FOLLOW_OBS, 4.5);
  const o = observationsFromDevice({ starred: { f: {} } }, { showKeyOf, useFollows: true });
  assert.equal(o.f.n, 1);
  assert.equal(o.f.obs, 4.5);
  assert.equal(o.f.outcomes[0].kind, "followed");
});

test("the module source has no localStorage, logEvent, fetch or document", () => {
  /* MUTATION: add `const x = localStorage.getItem("k");` to
     recommender-feedback.js — red. Also red for a quoted storage-key literal
     (the data-deletion suite counts those as key families; this module must
     add none). */
  const src = fs.readFileSync(path.join(HERE, "recommender-feedback.js"), "utf8");
  for (const word of [/\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\blogEvent\b/i,
    /\bfetch\s*\(/, /\bdocument\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bwindow\./]) {
    assert.ok(!word.test(src), `recommender-feedback.js must not mention ${word}`);
  }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/["'`]cp_/.test(code), "no storage-key literal in code");
  assert.ok(!/^\s*import\b/m.test(code), "imports nothing, so it cannot reach storage through a helper");
});

test("a recent bounce or sample is pending inside the resume window, a recent engaged listen counts", () => {
  /* MUTATION: `const pending = recent && (...)` -> `const pending = false` —
     red: the 2-day-old 20% stop counts as evidence. */
  const now = new Date("2026-10-14T12:00:00Z");
  const row = (seconds, daysAgo) => ({
    seconds, duration: 50 * MIN, updated_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), source: "local",
  });
  const o = observationsFromDevice(
    { positions: { "p/1": row(600, 2), "p/2": row(600, 30), "p/3": row(2400, 1) }, now },
    { showKeyOf },
  );
  const byId = Object.fromEntries(o.p.outcomes.map((x) => [x.episode_id, x]));
  assert.equal(byId["p/1"].bucket, "sampled");
  assert.equal(byId["p/1"].pending, true);
  assert.equal(byId["p/1"].value, undefined);
  assert.equal(byId["p/2"].pending, undefined, "older than the window: settled");
  assert.equal(byId["p/3"].bucket, "engaged");
  assert.equal(typeof byId["p/3"].value, "number", "engaged is evidence even mid-listen");
  assert.equal(o.p.n, 2);
  /* resumeWindowDays: 0 settles everything. */
  const settled = observationsFromDevice({ positions: { "p/1": row(600, 2) }, now }, { showKeyOf, resumeWindowDays: 0 });
  assert.equal(settled.p.n, 1);
});

test("history without a position is recorded as picked and not counted", () => {
  /* MUTATION: add `value: 3` to the picked outcome — red: n becomes 1. */
  const o = observationsFromDevice(
    { history: ["h/1", "h/2"], positions: { "h/2": 50 * MIN - 5 }, durations: { "h/2": 50 * MIN } },
    { showKeyOf },
  );
  assert.equal(o.h.n, 1);
  assert.deepEqual(o.h.outcomes.map((x) => x.kind).sort(), ["listen", "picked"]);
  const only = observationsFromDevice({ history: ["q/1"] }, { showKeyOf });
  assert.equal(only.q.n, 0);
  assert.equal(only.q.obs, 3, "no evidence is the neutral midpoint");
});

test("the position row's own duration stands in, and an unplaceable episode is dropped", () => {
  /* MUTATION: `: p.duration` -> `: null` in observationsFromDevice — red: the
     row-shaped position has no duration and is skipped. */
  const o = observationsFromDevice(
    { positions: { "r/1": { seconds: 50 * MIN - 5, duration: 50 * MIN, updated_at: "2026-01-01T00:00:00Z" }, "/x": 10 } },
    { showKeyOf },
  );
  assert.deepEqual(Object.keys(o), ["r"]);
  assert.equal(o.r.outcomes[0].bucket, "complete");
  assert.throws(() => observationsFromDevice({}, {}), /showKeyOf/);
});
