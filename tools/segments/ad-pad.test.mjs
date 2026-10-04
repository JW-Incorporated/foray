/* ADR-0008's pad arithmetic (tools/segments/ad-pad.mjs, DAI-02). Run:
   node --test tools/segments/ad-pad.test.mjs

   Every test names the one-line mutation that turns it red. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROBE_METHODS, probeDeltaSec, padFromProbes, groupProbesByItem } from "./ad-pad.mjs";
import { ANCHOR_TIME_TOLERANCE_SEC } from "./merge-segments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ref = { referenceDurationSec: 2400 };
const decode = (delta, at = "2026-10-04T00:00:00Z", item_id = "ep-1") => ({
  item_id, probed_at: at, method: "decode", decoded_duration_sec: 2400 + delta,
});
const ranged = (delivered, host = "media.transistor.fm", at = "2026-10-04T00:00:00Z") => ({
  item_id: "ep-1", probed_at: at, method: "ranged-get", host, status: 206, attempts: 1,
  declared_bytes: 40_000_000, delivered_bytes: delivered,
});

test("a ranged-get probe's delta is the bitrate-implied seconds, rounded to 0.1", () => {
  // MUTATION: drop the `- 1` from the ratio -> 2520, not 120.
  assert.deepEqual(probeDeltaSec(ranged(42_000_000), 2400), { delta_sec: 120 });
  assert.deepEqual(probeDeltaSec(ranged(40_001_000), 2400), { delta_sec: 0.1 });
  assert.deepEqual(probeDeltaSec({ ...ranged(42_000_000), declared_bytes: 0 }, 2400), { unusable: "no denominator" });
  assert.deepEqual(probeDeltaSec(ranged(2), 2400), { unusable: "implausible delivered length" });
});

test("a decode probe's delta is decoded minus reference", () => {
  // MUTATION: swap the operands -> -66.1.
  assert.deepEqual(probeDeltaSec(decode(66.1), 2400), { delta_sec: 66.1 });
  assert.deepEqual(probeDeltaSec({ item_id: "x", method: "decode" }, 2400), { unusable: "no decoded duration" });
  assert.deepEqual(probeDeltaSec({ item_id: "x", method: "head" }, 2400), { unusable: "unknown method" });
  assert.deepEqual([...PROBE_METHODS], ["ranged-get", "decode"]);
});

test("a ranged-get probe on a flightcast origin is unusable", () => {
  // MUTATION: remove the rangedGetTrusted call -> a delta of 120 comes back.
  assert.deepEqual(probeDeltaSec(ranged(42_000_000, "atelier.flightcast.com"), 2400), { unusable: "ranged-get on an untrusted host" });
});

test("one probe bounds nothing: n<2 is refused", () => {
  // MUTATION: `usable.length < 2` -> `< 1` -> a pad from one probe.
  assert.deepEqual(padFromProbes([decode(30)], ref), { refused: "n<2", n: 1 });
  assert.deepEqual(padFromProbes([decode(30), { item_id: "ep-1", method: "decode" }], ref), { refused: "n<2", n: 1 });
  assert.deepEqual(padFromProbes([], ref), { refused: "n<2", n: 0 });
});

test("the pad reproduces ADR-0008's Gastropod arithmetic", () => {
  // MUTATION: `pad = delta_max` (no spread) -> 66.1, not 99.5.
  const r = padFromProbes([decode(66.1, "2026-10-01T00:00:00Z"), decode(32.7, "2026-10-03T00:00:00Z")], ref);
  assert.equal(r.n, 2);
  assert.equal(r.delta_max_sec, 66.1);
  assert.equal(r.delta_min_sec, 32.7);
  assert.equal(r.spread_sec, 33.4);
  assert.equal(r.pad_sec, 99.5);
  assert.equal(r.tier, "PADDABLE");
  assert.equal(r.method, "decode");
  assert.equal(r.measured_at, "2026-10-03T00:00:00Z", "the latest usable probe dates the measurement");
});

test("a pad of exactly the ceiling is PADDABLE; one 0.1 s over is LOCATE-REQUIRED", () => {
  // MUTATION: `pad <= ANCHOR_TIME_TOLERANCE_SEC` -> `<` -> the exact-ceiling case flips.
  assert.equal(ANCHOR_TIME_TOLERANCE_SEC, 120);
  const at = padFromProbes([decode(70), decode(20)], ref);
  assert.equal(at.pad_sec, ANCHOR_TIME_TOLERANCE_SEC);
  assert.equal(at.tier, "PADDABLE");
  const over = padFromProbes([decode(70.1), decode(20.1)], ref);
  assert.equal(over.pad_sec, 120.1);
  assert.equal(over.tier, "LOCATE-REQUIRED");
});

test("an undersized delivery refuses rather than pads", () => {
  // MUTATION: clamp negative deltas to 0 / drop the undersized check -> a pad of 2 comes back.
  assert.deepEqual(padFromProbes([decode(-60), decode(-58)], ref), { refused: "undersized", n: 2 });
  // Inside the floor (|delta| <= 1% of 2400 s = 24 s) a slightly short file is noise, and the pad is the spread.
  const near = padFromProbes([decode(-10), decode(-12)], ref);
  assert.equal(near.pad_sec, 2);
});

test("a poisoned set is refused even when trusted probes are present", () => {
  // MUTATION: skip untrusted probes instead of refusing -> a pad from the two trusted ones.
  const r = padFromProbes([ranged(42_000_000, "episode.flightcast.com"), ranged(41_000_000), ranged(41_500_000)], ref);
  assert.deepEqual(r, { refused: "ranged-get on an untrusted host" });
});

test("probes from two item_ids throw", () => {
  // MUTATION: drop the item_id check -> two episodes' deltas would make one pad.
  assert.throws(() => padFromProbes([decode(10), decode(12, undefined, "ep-2")], ref), /more than one item_id/);
});

test("a non-positive or missing reference throws", () => {
  // MUTATION: default the reference to 1 -> no throw.
  for (const bad of [0, -5, NaN, Infinity, "2400", undefined]) {
    assert.throws(() => padFromProbes([decode(10), decode(12)], { referenceDurationSec: bad }), TypeError, String(bad));
    assert.throws(() => probeDeltaSec(decode(10), bad), TypeError, String(bad));
  }
});

test("mixed methods are reported as mixed", () => {
  // MUTATION: report the first probe's method -> "decode".
  const r = padFromProbes([decode(10), ranged(40_200_000)], ref);
  assert.equal(r.method, "mixed");
  assert.equal(r.n, 2);
});

test("groupProbesByItem sorts each group by probed_at", () => {
  // MUTATION: drop the sort -> the 10-04 probe stays first.
  const g = groupProbesByItem({ probes: [
    decode(1, "2026-10-04T00:00:00Z"), decode(2, "2026-10-01T00:00:00Z"), decode(3, "2026-10-02T00:00:00Z", "ep-2"), null,
  ] });
  assert.deepEqual([...g.keys()], ["ep-1", "ep-2"]);
  assert.deepEqual(g.get("ep-1").map((p) => p.probed_at), ["2026-10-01T00:00:00Z", "2026-10-04T00:00:00Z"]);
  assert.equal(groupProbesByItem(undefined).size, 0);
});

test("the committed ledger parses and starts empty", () => {
  // A test that cannot fail on today's data, deliberately (CLAUDE.md rule 5): it
  // is what stops a hand-edit that breaks the JSON from reaching stamp-ad-pad.
  const ledger = JSON.parse(readFileSync(join(ROOT, "data", "ad-pad-probes.json"), "utf8"));
  assert.equal(ledger.version, 1);
  assert.ok(Array.isArray(ledger.probes));
  assert.match(ledger.notes, /N >= 2/);
});
