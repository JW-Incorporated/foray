/* The structure a built Foray queue must have before anything plays it
   (docs/native-engine-plan.md §5.2 `playForay`, J-4; card NE-29j, port NE-29s).

   WHY THIS EXISTS. The page decides what a Foray is: `buildForayQueue`
   (player/foray-queue.js) resolves every authored item, drops the ones that must
   not play and hands the player a flat queue of CANDIDATES. On the web the
   manager plays that queue in the same process that built it. On iOS the queue
   crosses a bridge — `playForay {items, buildReport, ...}` — into an engine that
   did not build it, and the plan's J-4 is that the engine RE-VALIDATES the
   structure instead of trusting the wire: a page from an older deploy, a
   hand-edited document or a bug in either half must be refused as
   `refused-structure` before it is audible, never discovered as a segment that
   plays to the end of somebody's hour-long episode.

   So this module states, once, what `buildForayQueue` guarantees about every
   item it emits. It is the build's POST-CONDITION, not a second opinion on the
   authored document: every rule below is a drop or a construction in
   `buildForayQueue`, and `foray-structure.test.js` holds that every queue it
   builds (including every committed Foray's) passes. The Swift StructuralCheck
   (NE-29s) is a port of `structuralCheck`, pinned by the `foray-structure`
   parity family.

   WHAT IS CHECKED, per item (`problems[].code`, a closed set):
     not-an-object      the entry is not a plain object
     no-id              `id` is not a non-empty string
     duplicate-id       a second item with the same `id` — every id-keyed lookup
                        takes the first match, so one entry would be unreachable
                        and the other would play twice
     unknown-kind       `kind` is not episode (a segment), tts (narration) or
                        jingle
     no-audio           a segment or a jingle with no `audio_url`
     bad-bounds         a segment whose `start_sec` is not finite and >= 0, or
                        whose `end_sec` is not finite and after it: without both
                        there is no out-point, and a Foray segment without an
                        out-point is a whole episode
     dai-unanchored     a DAI source (`dai_suspected`) without both anchors
                        (ADR-0007)
     no-reference       a segment the ladder must check at load
                        (`needs_drift_check`) with no finite
                        `reference_duration_sec` to check it against
     silent-narration   a narration item with neither an asset nor a script
     no-duration        a narration or jingle item with no positive finite
                        `duration_sec`: the Foray clock would count it as zero
   And for the queue: `empty` (index -1) when there is no item at all.

   WHAT IS NOT CHECKED. Whether the audio exists, the precision ladder's rung 3
   (it needs the observed duration, which only a load produces — seek-policy.js
   `segmentLoadGate`), and anything about ORDER: a Foray's running order is
   authored, and no structural rule gets a vote on it.

   `seamCensus` is the other half of "structure": what each join of the queue
   is, by the same rules the manager applies at the seam (seam-gap.js and
   interlude.js). It is how the frozen capital-types-1 rule — 21 seams, 11 of
   them inside one episode, so exactly 10 jingles — reaches a Swift fixture.

   Pure: no DOM, no storage, no timers. */

import { seamGapSec, isSegment, AUTO_ADVANCE } from "./seam-gap.js";
import { interludeEligible, sameSourceEpisode } from "./interlude.js";
import { JINGLE } from "./foray-queue.js";

/** The token a refusal carries on the wire (engine-contract.js REASONS). */
export const REFUSED_STRUCTURE = "refused-structure";

/** The kinds a built Foray queue may hold. `episode` is a segment. */
export const QUEUE_KINDS = Object.freeze(["episode", "tts", JINGLE]);

/** The closed set of `problems[].code`, in the order the header explains them. */
export const STRUCTURE_PROBLEMS = Object.freeze([
  "empty", "not-an-object", "no-id", "duplicate-id", "unknown-kind", "no-audio",
  "bad-bounds", "dai-unanchored", "no-reference", "silent-narration", "no-duration",
]);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every problem one item has, in the header's order. */
function itemProblems(item) {
  if (!isPlain(item)) return ["not-an-object"];
  const out = [];
  if (!nonEmpty(item.id)) out.push("no-id");
  if (!QUEUE_KINDS.includes(item.kind)) {
    out.push("unknown-kind");
    return out;
  }
  if (item.kind === "episode") {
    if (!nonEmpty(item.audio_url)) out.push("no-audio");
    const bounded = isNum(item.start_sec) && item.start_sec >= 0 && isNum(item.end_sec) && item.end_sec > item.start_sec;
    if (!bounded) out.push("bad-bounds");
    if (item.dai_suspected === true && !(nonEmpty(item.start_anchor) && nonEmpty(item.end_anchor))) out.push("dai-unanchored");
    if (item.needs_drift_check === true && !isNum(item.reference_duration_sec)) out.push("no-reference");
    return out;
  }
  if (item.kind === JINGLE) {
    if (!nonEmpty(item.audio_url)) out.push("no-audio");
  } else if (!nonEmpty(item.audio_url) && !nonEmpty(item.script)) {
    out.push("silent-narration");
  }
  if (!(isNum(item.duration_sec) && item.duration_sec > 0)) out.push("no-duration");
  return out;
}

/**
 * Is this built queue one the player may start?
 *
 * @param {object[]} items  a built Foray queue (`buildForayQueue(...).items`,
 *   or the `items` of a `playForay` command)
 * @returns {{ ok: boolean, reason: string|null,
 *             problems: {index: number, code: string}[] }}
 *   `reason` is REFUSED_STRUCTURE whenever `ok` is false. `problems` lists every
 *   problem of every item in queue order (index -1 for the queue itself), so a
 *   refusal row can say exactly what was wrong rather than "something".
 */
export function structuralCheck(items) {
  const problems = [];
  if (!Array.isArray(items) || items.length === 0) {
    problems.push({ index: -1, code: "empty" });
  } else {
    const seen = new Set();
    items.forEach((item, index) => {
      for (const code of itemProblems(item)) problems.push({ index, code });
      if (isPlain(item) && nonEmpty(item.id)) {
        if (seen.has(item.id)) problems.push({ index, code: "duplicate-id" });
        seen.add(item.id);
      }
    });
  }
  const ok = problems.length === 0;
  return { ok, reason: ok ? null : REFUSED_STRUCTURE, problems };
}

/**
 * What every join of a queue is, as the manager decides it on an automatic
 * advance: a seam beat (seam-gap.js), a jingle (interlude.js), and whether the
 * two sides are slices of one source episode.
 *
 * @param {object[]} items  a built Foray queue
 * @returns {{ items: number, segments: number, seams: number, beats: number,
 *             jingles: number, sameSource: number, sourceChanges: number }}
 *   `seams` is every join (items - 1, never negative); `sourceChanges` counts
 *   the joins between two SEGMENTS whose `source_item_id` differs — where the
 *   segment strip draws a capsule edge — so `jingles === sourceChanges` is the
 *   "a jingle exactly where the strip draws a seam" rule on a tape-only Foray.
 */
export function seamCensus(items) {
  const list = Array.isArray(items) ? items : [];
  const out = {
    items: list.length,
    segments: list.filter((i) => isSegment(i)).length,
    seams: Math.max(0, list.length - 1),
    beats: 0,
    jingles: 0,
    sameSource: 0,
    sourceChanges: 0,
  };
  for (let i = 1; i < list.length; i++) {
    const from = list[i - 1];
    const to = list[i];
    if (seamGapSec({ from, to, cause: AUTO_ADVANCE }) > 0) out.beats += 1;
    if (interludeEligible({ from, to, cause: AUTO_ADVANCE })) out.jingles += 1;
    if (sameSourceEpisode(from, to)) out.sameSource += 1;
    if (isSegment(from) && isSegment(to) && from.source_item_id !== to.source_item_id) out.sourceChanges += 1;
  }
  return out;
}
