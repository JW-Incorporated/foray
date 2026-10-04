/* ADR-0008's pad arithmetic over a same-episode probe ledger (DAI-02,
   docs/roadmap/dai.md).

   WHAT A PAD IS. On a show that inserts ads dynamically, the delivered file is
   longer than the one the transcript was timed against, and every anchor after
   an inserted break lands late. ADR-0008 ("The pad must be an UPPER BOUND on
   the delta") admits such a show only when the player can seek EARLY by enough
   to cover the worst insertion: pad = delta_max + margin, where delta_max is
   the largest delivered-minus-reference delta seen across N >= 2 probes of the
   SAME episode, and the margin is at least the observed spread between those
   probes. A pad within ANCHOR_TIME_TOLERANCE_SEC is PADDABLE; beyond it the
   segment needs the locate step (LOCATE-REQUIRED).

   WHY SAME-EPISODE. measure-suspects.mjs's cross-episode maximum answers a
   different question (how much does this show insert, ever); a pad is spent on
   one episode's anchors, so only that episode's own deliveries bound it.

   WHAT IS REFUSED, AND WHY EACH IS A REFUSAL RATHER THAN A SMALLER PAD:
   - a ranged-GET probe from an untrusted origin (rangedGetTrusted, HUMAN-ACTIONS
     #24): its Content-Range total is the master's length, so EVERY probe from
     that host is equally spoofed and the set is poisoned, not merely thinned;
   - fewer than two usable deltas: one probe has no spread, and a margin of
     nothing is not an upper bound;
   - an undersized delivery: the file is not the one the feed describes, and a
     denominator caught being wrong answers no ad question (AD_FREE_FLOOR).

   Pure: no network, no file access. The CLIs that append probes and stamp the
   result onto data/segment-sources.json are DAI-04 and DAI-03. */

import { ANCHOR_TIME_TOLERANCE_SEC } from "./merge-segments.mjs";
import { AD_FREE_FLOOR, isPlausibleAudioSize, rangedGetTrusted } from "../transcribe/ad-inflation.mjs";

export const PROBE_METHODS = Object.freeze(["ranged-get", "decode"]);

const UNTRUSTED = "ranged-get on an untrusted host";
const tenth = (x) => Math.round(x * 10) / 10;

function assertReference(referenceDurationSec) {
  if (typeof referenceDurationSec !== "number" || !Number.isFinite(referenceDurationSec) || referenceDurationSec <= 0) {
    throw new TypeError(`referenceDurationSec must be a finite positive number, got ${JSON.stringify(referenceDurationSec)}`);
  }
}

/** One probe's delivered-minus-reference delta in seconds (0.1 s), or why it
    is unusable. */
export function probeDeltaSec(probe, referenceDurationSec) {
  assertReference(referenceDurationSec);
  if (!probe || typeof probe !== "object") return { unusable: "not a probe" };
  if (probe.method === "ranged-get") {
    const declared = Number(probe.declared_bytes);
    const delivered = Number(probe.delivered_bytes);
    if (!Number.isFinite(declared) || declared <= 0) return { unusable: "no denominator" };
    if (!isPlausibleAudioSize(delivered)) return { unusable: "implausible delivered length" };
    if (!rangedGetTrusted(probe.host)) return { unusable: UNTRUSTED };
    return { delta_sec: tenth(referenceDurationSec * (delivered / declared - 1)) };
  }
  if (probe.method === "decode") {
    const decoded = Number(probe.decoded_duration_sec);
    if (!Number.isFinite(decoded) || decoded <= 0) return { unusable: "no decoded duration" };
    return { delta_sec: tenth(decoded - referenceDurationSec) };
  }
  return { unusable: "unknown method" };
}

/** The pad for one episode from its probes, or the reason there is none. */
export function padFromProbes(probes, { referenceDurationSec } = {}) {
  assertReference(referenceDurationSec);
  const list = Array.isArray(probes) ? probes : [];
  const ids = new Set(list.map((p) => p?.item_id));
  if (ids.size > 1) throw new TypeError("probes span more than one item_id");

  const usable = [];
  const unusable = [];
  for (const p of list) {
    const r = probeDeltaSec(p, referenceDurationSec);
    if ("delta_sec" in r) usable.push({ probe: p, delta: r.delta_sec });
    else unusable.push(r.unusable);
  }
  // Checked FIRST: one spoofed answer means every answer from that host is.
  if (unusable.includes(UNTRUSTED)) return { refused: UNTRUSTED };
  if (usable.length < 2) return { refused: "n<2", n: usable.length };
  const floor = -(1 - AD_FREE_FLOOR) * referenceDurationSec;
  if (usable.some((u) => u.delta < floor)) return { refused: "undersized", n: usable.length };

  const deltas = usable.map((u) => u.delta);
  const deltaMax = Math.max(...deltas);
  const deltaMin = Math.min(...deltas);
  const spread = tenth(deltaMax - deltaMin);
  const pad = tenth(Math.max(0, deltaMax) + spread);
  const methods = new Set(usable.map((u) => u.probe.method));
  const measuredAt = usable
    .map((u) => u.probe.probed_at)
    .filter((t) => typeof t === "string")
    .sort()
    .at(-1) ?? null;
  return {
    n: usable.length,
    delta_max_sec: deltaMax,
    delta_min_sec: deltaMin,
    spread_sec: spread,
    pad_sec: pad,
    tier: pad <= ANCHOR_TIME_TOLERANCE_SEC ? "PADDABLE" : "LOCATE-REQUIRED",
    method: methods.size === 1 ? [...methods][0] : "mixed",
    measured_at: measuredAt,
    unusable,
  };
}

/** `ledger.probes` grouped by item_id, each group oldest first. */
export function groupProbesByItem(ledger) {
  const groups = new Map();
  for (const p of Array.isArray(ledger?.probes) ? ledger.probes : []) {
    if (!p || typeof p.item_id !== "string") continue;
    if (!groups.has(p.item_id)) groups.set(p.item_id, []);
    groups.get(p.item_id).push(p);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.probed_at ?? "").localeCompare(String(b.probed_at ?? "")));
  }
  return groups;
}
