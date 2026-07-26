/* Tests for seek precision policy (issue #30).

   The interesting cases are all about DAI (corner case #2). Read the header of
   seek-policy.js first — the own/foreign split is not obvious and it came out
   of measuring DAI for #22. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  seekPrecision, canSeekExactly, formatTimestamp, describeTimestamp,
  OWN, FOREIGN, EXACT, APPROXIMATE, DRIFT_TOLERANCE_SEC,
} from "./seek-policy.js";

const stitched = { id: "ep-dai", dai_suspected: true };
const staticEp = { id: "ep-static", dai_suspected: false };

/* ---------- the local-file override ---------- */

test("a downloaded file is exact, even for a stitched show", () => {
  // #29 forbids re-fetching while a saved position exists, which is what
  // keeps the local timeline frozen.
  assert.equal(seekPrecision(stitched, { isLocalFile: true, source: FOREIGN }).precision, EXACT);
  assert.equal(seekPrecision(stitched, { isLocalFile: true, source: OWN }).precision, EXACT);
});

test("local-file beats every other signal, including observed drift", () => {
  const r = seekPrecision(stitched, {
    isLocalFile: true, source: OWN, observedDuration: 3600, recordedDuration: 1,
  });
  assert.equal(r.precision, EXACT);
  assert.match(r.reason, /local file/);
});

/* ---------- static enclosures ---------- */

test("a static enclosure is exact regardless of timestamp source", () => {
  assert.equal(seekPrecision(staticEp, { source: FOREIGN }).precision, EXACT);
  assert.equal(seekPrecision(staticEp, { source: OWN }).precision, EXACT);
});

/* ---------- the #22 refinement ---------- */

test("streaming a stitched show: a FOREIGN timestamp is approximate", () => {
  // Chapter marks authored on the un-stitched master, transcript times from a
  // separate fetch. This is what corner case #2 is actually about.
  const r = seekPrecision(stitched, { source: FOREIGN });
  assert.equal(r.precision, APPROXIMATE);
  assert.match(r.reason, /dynamic ad insertion/);
});

test("streaming a stitched show: the listener's OWN marker is exact", () => {
  // DAI serves a stable file to a given listener — otherwise resume would not
  // work — so a bookmark they made against their own copy is reliable for them.
  const r = seekPrecision(stitched, { source: OWN });
  assert.equal(r.precision, EXACT);
  assert.match(r.reason, /own marker/);
});

test("an OWN marker degrades to approximate once the copy demonstrably changed", () => {
  const r = seekPrecision(stitched, {
    source: OWN, recordedDuration: 3600, observedDuration: 3600 + DRIFT_TOLERANCE_SEC + 1,
  });
  assert.equal(r.precision, APPROXIMATE);
  assert.match(r.reason, /drift/);
});

test("small duration differences do not count as drift", () => {
  // Encoders disagree by a second or two on the same file; crying drift over
  // rounding would make every stitched bookmark useless.
  for (const delta of [0, 1, -5, DRIFT_TOLERANCE_SEC]) {
    const r = seekPrecision(stitched, { source: OWN, recordedDuration: 3600, observedDuration: 3600 + delta });
    assert.equal(r.precision, EXACT, `delta ${delta} should not trip drift`);
  }
});

test("drift only applies when both durations are known", () => {
  assert.equal(seekPrecision(stitched, { source: OWN, recordedDuration: 3600 }).precision, EXACT);
  assert.equal(seekPrecision(stitched, { source: OWN, observedDuration: 3600 }).precision, EXACT);
});

/* ---------- defaults ---------- */

test("source defaults to FOREIGN — the safe assumption", () => {
  // A caller that forgets to say where a timestamp came from must not be
  // rewarded with a confident hard seek.
  assert.equal(seekPrecision(stitched, {}).precision, APPROXIMATE);
  assert.equal(seekPrecision(stitched).precision, APPROXIMATE);
});

test("a missing or malformed item is treated as static rather than throwing", () => {
  assert.equal(seekPrecision(null, {}).precision, EXACT);
  assert.equal(seekPrecision({}, {}).precision, EXACT);
});

test("canSeekExactly mirrors seekPrecision", () => {
  assert.equal(canSeekExactly(stitched, { source: FOREIGN }), false);
  assert.equal(canSeekExactly(stitched, { source: OWN }), true);
  assert.equal(canSeekExactly(staticEp, {}), true);
});

/* ---------- rendering (corner case #2c) ---------- */

test("formatTimestamp renders exact times to the second", () => {
  assert.equal(formatTimestamp(4050, EXACT), "1:07:30");
  assert.equal(formatTimestamp(2244, EXACT), "37:24");
  assert.equal(formatTimestamp(0, EXACT), "0:00");
  assert.equal(formatTimestamp(59, EXACT), "0:59");
  assert.equal(formatTimestamp(3600, EXACT), "1:00:00");
});

test("formatTimestamp marks approximate times and rounds away false precision", () => {
  // Minute language, not clock format. "~1:08:00" would show seconds on a
  // timeline we just said has moved, and "~0:37" reads as 37 seconds next to
  // an mm:ss scrubber. Both were mistakes in the first draft.
  assert.equal(formatTimestamp(4050, APPROXIMATE), "~68 min");
  assert.equal(formatTimestamp(2244, APPROXIMATE), "~37 min");
  assert.equal(formatTimestamp(90, APPROXIMATE), "~2 min");
  assert.ok(formatTimestamp(4050, APPROXIMATE).startsWith("~"));
  assert.ok(!/\d:\d\d/.test(formatTimestamp(4050, APPROXIMATE)), "must not look like a clock time");
});

test("formatTimestamp refuses junk instead of rendering NaN", () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, "4050"]) {
    assert.equal(formatTimestamp(bad, EXACT), "--:--", String(bad));
  }
});

test("describeTimestamp never implies precision it does not have", () => {
  assert.equal(describeTimestamp(4050, EXACT), "at 1:07:30");
  assert.equal(describeTimestamp(4050, APPROXIMATE), "around minute 68");
  assert.equal(describeTimestamp(NaN, EXACT), "");
});

test("approximate rendering contains no banned copy words", () => {
  // CLAUDE.md copy rules apply to anything user-facing, including this.
  const BANNED = /fascinating|deep dive|delve|explores/i;
  for (const s of [
    formatTimestamp(4050, APPROXIMATE),
    describeTimestamp(4050, APPROXIMATE),
    describeTimestamp(4050, EXACT),
  ]) assert.ok(!BANNED.test(s), s);
});

/* ---------- the property that matters ---------- */

test("nothing streaming a stitched show is exact unless the listener made it", () => {
  // The invariant #30 exists to protect. If this ever fails, some call site is
  // about to promise precision it does not have.
  for (const source of [FOREIGN, undefined, "chapters", "transcript"]) {
    assert.equal(
      seekPrecision(stitched, { isLocalFile: false, source }).precision,
      APPROXIMATE,
      `source=${source}`
    );
  }
});
