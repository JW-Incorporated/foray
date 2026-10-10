/* PKG-16 (docs/roadmap/corpus.md): one episode's DAI tier over the dai
   package's pad (tools/segments/ad-pad.mjs). Run:
   npm test --prefix tools/foraycorpus-export -- dai-tier.test.mjs

   Fixtures are built the way tools/segments/ad-pad.test.mjs builds them: one
   item_id, an ISO probed_at, a trusted host, and ranged-get sizes at or above
   MIN_PLAUSIBLE_BYTES. Every test names the one-line mutation that turns it
   red. */

import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, episodeTier } from "./dai-tier.mjs";
import { padFromProbes } from "../segments/ad-pad.mjs";
import { ANCHOR_TIME_TOLERANCE_SEC } from "../segments/merge-segments.mjs";
import { MIN_PLAUSIBLE_BYTES } from "../transcribe/ad-inflation.mjs";

const REF = 2400;
const ref = { referenceDurationSec: REF };
const decode = (delta, at = "2026-10-04T00:00:00Z") => ({
  item_id: "ep-1", probed_at: at, method: "decode", decoded_duration_sec: REF + delta,
});
const ranged = (delivered, { host = "traffic.example.com", declared = 40_000_000, at = "2026-10-04T00:00:00Z" } = {}) => ({
  item_id: "ep-1", probed_at: at, method: "ranged-get", host, status: 206, attempts: 1,
  declared_bytes: declared, delivered_bytes: delivered,
});
const NUMBERS = ["n", "delta_max_sec", "spread_sec", "pad_sec", "method", "measured_at"];

function assertRefusalNumbersNull(r) {
  for (const k of NUMBERS) assert.equal(r[k], null, `${k} is null on a refusal`);
}

test("(a) Gastropod: 2,466.1 s and 2,432.7 s on a 2,400 s reference is paddable at 99.5 s, copied from padFromProbes", () => {
  // MUTATION: add a 30 s margin in the wrapper (`pad_sec: r.pad_sec + 30`) -> 129.5, and locate-required.
  const probes = [decode(66.1, "2026-10-01T00:00:00Z"), decode(32.7, "2026-10-03T00:00:00Z")];
  assert.equal(probes[0].decoded_duration_sec, 2466.1);
  assert.equal(probes[1].decoded_duration_sec, 2432.7);
  const r = episodeTier(probes, ref);
  assert.equal(r.tier, "paddable");
  assert.equal(r.reason, null);
  assert.equal(r.spread_sec, 33.4);
  assert.equal(r.pad_sec, 99.5);
  const p = padFromProbes(probes, ref);
  assert.deepEqual(
    Object.fromEntries(NUMBERS.map((k) => [k, r[k]])),
    Object.fromEntries(NUMBERS.map((k) => [k, p[k]])),
  );
  assert.deepEqual(r.hosts, [], "decode probes name no ranged-get host");
  assert.ok(TIERS.includes(r.tier));
  assert.ok(Object.isFrozen(TIERS));
  assert.deepEqual([...TIERS], ["ad-free", "paddable", "locate-required", "unmeasured", "unmeasurable"]);
});

test("(b) a pad of exactly ANCHOR_TIME_TOLERANCE_SEC is paddable; 0.1 s over is locate-required", () => {
  // MUTATION: re-threshold in the wrapper with `<` (`r.pad_sec < ANCHOR_TIME_TOLERANCE_SEC ? "paddable" : "locate-required"`) -> the exact-ceiling case flips.
  const at = episodeTier([decode(70), decode(20)], ref);
  assert.equal(at.pad_sec, ANCHOR_TIME_TOLERANCE_SEC);
  assert.equal(at.tier, "paddable");
  const over = episodeTier([decode(70.1), decode(20.1)], ref);
  assert.equal(over.pad_sec, Math.round((ANCHOR_TIME_TOLERANCE_SEC + 0.1) * 10) / 10);
  assert.equal(over.tier, "locate-required");
  assert.equal(over.reason, null);
});

test("(c) two ranged-get probes that each deliver exactly the declared length are ad-free", () => {
  // MUTATION: map every PADDABLE to `paddable` (drop the `pad_sec === 0` branch) -> "paddable".
  const declared = 40_000_000;
  assert.ok(declared >= MIN_PLAUSIBLE_BYTES);
  const r = episodeTier([
    ranged(declared, { declared, at: "2026-10-01T00:00:00Z" }),
    ranged(declared, { declared, at: "2026-10-02T00:00:00Z" }),
  ], ref);
  assert.equal(r.tier, "ad-free");
  assert.equal(r.reason, null);
  assert.equal(r.pad_sec, 0);
  assert.equal(r.n, 2);
  assert.equal(r.method, "ranged-get");
  assert.equal(r.measured_at, "2026-10-02T00:00:00Z");
  assert.deepEqual(r.hosts, [{ host: "traffic.example.com", trusted: true }]);
});

test("(d) one usable probe is unmeasured (n<2), not unmeasurable", () => {
  // MUTATION: map every `n<2` to `unmeasurable` -> tier "unmeasurable".
  // MUTATION: `list.every(...)` -> `list.some(...)` -> the mixed set below reads "no denominator".
  const one = episodeTier([decode(30)], ref);
  assert.equal(one.tier, "unmeasured");
  assert.equal(one.reason, "n<2");
  assertRefusalNumbersNull(one);
  const mixed = episodeTier([decode(30), ranged(42_000_000, { declared: 0 })], ref);
  assert.equal(mixed.tier, "unmeasured");
  assert.equal(mixed.reason, "n<2");
  const none = episodeTier([], ref);
  assert.equal(none.tier, "unmeasured", "no probe yet is not a missing denominator");
  assert.equal(none.reason, "n<2");
});

test("(e) two ranged-get probes with declared_bytes 0 are unmeasurable: no denominator", () => {
  // MUTATION: map every `n<2` to `unmeasured` (drop the no-denominator branch) -> tier "unmeasured".
  const r = episodeTier([
    ranged(42_000_000, { declared: 0, at: "2026-10-01T00:00:00Z" }),
    ranged(43_000_000, { declared: 0, at: "2026-10-02T00:00:00Z" }),
  ], ref);
  assert.equal(r.tier, "unmeasurable");
  assert.equal(r.reason, "no denominator");
  assertRefusalNumbersNull(r);
  assert.deepEqual(r.hosts, [{ host: "traffic.example.com", trusted: true }]);
});

test("(f) two probes from atelier.flightcast.com are unmeasurable, and the host is listed untrusted", () => {
  // MUTATION: `trusted: rangedGetTrusted(host)` -> `trusted: true` -> hosts[0].trusted is true.
  const host = "atelier.flightcast.com";
  const r = episodeTier([
    ranged(42_000_000, { host, at: "2026-10-01T00:00:00Z" }),
    ranged(42_000_000, { host, at: "2026-10-02T00:00:00Z" }),
  ], ref);
  assert.equal(r.tier, "unmeasurable");
  assert.equal(r.reason, "ranged-get on an untrusted host");
  assertRefusalNumbersNull(r);
  assert.equal(r.hosts.length, 1);
  assert.equal(r.hosts[0].host, host);
  assert.equal(r.hosts[0].trusted, false);
});

test("(g) deltas below the undersized floor are unmeasurable: undersized", () => {
  // MUTATION: map undersized to `unmeasured` (`refusal("unmeasured", r.refused, hosts)` for it) -> tier "unmeasured".
  const r = episodeTier([decode(-60), decode(-58)], ref);
  assert.equal(r.tier, "unmeasurable");
  assert.equal(r.reason, "undersized");
  assertRefusalNumbersNull(r);
});

test("(h) no reference duration is unmeasurable, and nothing throws", () => {
  // MUTATION: drop the reference guard -> padFromProbes throws a TypeError.
  const probes = [decode(66.1), decode(32.7)];
  for (const referenceDurationSec of [null, undefined, 0, -1, Number.NaN, "2400"]) {
    let r;
    assert.doesNotThrow(() => { r = episodeTier(probes, { referenceDurationSec }); });
    assert.equal(r.tier, "unmeasurable", `reference ${String(referenceDurationSec)}`);
    assert.equal(r.reason, "no reference duration");
    assertRefusalNumbersNull(r);
  }
  assert.equal(episodeTier(probes).reason, "no reference duration", "no options at all");
});
