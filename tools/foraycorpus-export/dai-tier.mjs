/* One episode's DAI tier in G-12's vocabulary (PKG-16, docs/roadmap/corpus.md;
   roadmap G-12 in docs/curation/foray-to-spec-roadmap.md).

   A thin wrapper over the dai package's one implementation of ADR-0008's pad:
   `padFromProbes` / `probeDeltaSec` in tools/segments/ad-pad.mjs (DAI-02) and
   `rangedGetTrusted` in tools/transcribe/ad-inflation.mjs (DAI-01). This file
   only maps that result onto the per-episode tiers below. It does no byte or
   seconds arithmetic of its own: no bitrate, no margin (ADR-0008's margin is
   the observed spread, which padFromProbes already adds), no ceiling (the
   PADDABLE / LOCATE-REQUIRED split is padFromProbes's, against
   ANCHOR_TIME_TOLERANCE_SEC). Pure: no network, no file access. */

import { padFromProbes, probeDeltaSec } from "../segments/ad-pad.mjs";
import { rangedGetTrusted } from "../transcribe/ad-inflation.mjs";

export const TIERS = Object.freeze(["ad-free", "paddable", "locate-required", "unmeasured", "unmeasurable"]);

const NO_DENOMINATOR = "no denominator";

/** Distinct hosts of the ranged-get probes, first seen first. PKG-17's
    by-host table reads this. */
function hostsOf(list) {
  const seen = new Map();
  for (const p of list) {
    if (!p || typeof p !== "object" || p.method !== "ranged-get") continue;
    const host = typeof p.host === "string" ? p.host : null;
    if (!seen.has(host)) seen.set(host, { host, trusted: rangedGetTrusted(host) });
  }
  return [...seen.values()];
}

function refusal(tier, reason, hosts) {
  return {
    tier, reason,
    n: null, delta_max_sec: null, spread_sec: null, pad_sec: null,
    method: null, measured_at: null,
    hosts,
  };
}

/** The tier of one episode from its same-episode probes (one item_id, as
    groupProbesByItem returns them). Never throws on a missing reference. */
export function episodeTier(probes, { referenceDurationSec } = {}) {
  const list = Array.isArray(probes) ? probes : [];
  const hosts = hostsOf(list);
  // Checked BEFORE padFromProbes, which throws on a non-positive reference.
  if (typeof referenceDurationSec !== "number" || !Number.isFinite(referenceDurationSec) || referenceDurationSec <= 0) {
    return refusal("unmeasurable", "no reference duration", hosts);
  }

  const r = padFromProbes(list, { referenceDurationSec });
  if (r.refused === "ranged-get on an untrusted host" || r.refused === "undersized") {
    return refusal("unmeasurable", r.refused, hosts);
  }
  if (r.refused === "n<2") {
    // Megaphone's length="0", or a declared length nobody captured: every probe
    // lacks the denominator, so more probes of the same kind would not help.
    const noDenominator = list.length > 0 &&
      list.every((p) => probeDeltaSec(p, referenceDurationSec).unusable === NO_DENOMINATOR);
    return noDenominator ? refusal("unmeasurable", NO_DENOMINATOR, hosts) : refusal("unmeasured", "n<2", hosts);
  }
  if (r.refused !== undefined) throw new Error(`dai-tier: unmapped ad-pad refusal ${JSON.stringify(r.refused)}`);

  let tier;
  if (r.tier === "LOCATE-REQUIRED") tier = "locate-required";
  else if (r.tier === "PADDABLE") tier = r.pad_sec === 0 ? "ad-free" : "paddable";
  else throw new Error(`dai-tier: unmapped ad-pad tier ${JSON.stringify(r.tier)}`);
  return {
    tier, reason: null,
    n: r.n, delta_max_sec: r.delta_max_sec, spread_sec: r.spread_sec, pad_sec: r.pad_sec,
    method: r.method, measured_at: r.measured_at,
    hosts,
  };
}
