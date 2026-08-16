/* The seam beat — how much silence goes between two segments (issue #111 / #65).

   A Foray cuts from one person, in one room, on one mic chain, to a different
   person in a different room at a different level. Foray #1 does that 31 times
   and carries no narration at all, so every one of those seams is currently a
   butt-cut: one voice stops mid-room-tone and the next starts on the same
   sample. That does not read as an edit. It reads as a glitch.

   This module answers ONE question — "how long is the silence at this seam?" —
   and answers it purely, so the decision table is readable in one screen and
   testable without a player. The manager owns the clock; this owns the rule.

   ── The number, and the two specs that disagree about it ──────────────────

   `docs/curation/segment-length-rules.md` §6b and §2e: an unbridged seam gets
   **>= 2.0 s**, taken from the audiobook mid-chapter section-break convention
   (2-3.5 s, commonly 2-2.5 s), which is the only published answer anyone has
   written down to "how much silence tells a listener they have moved."

   `docs/brief/04_VOICE_AUDIO_SPEC.md` line 12 says ~0.5 s of padding around TTS
   items. **These are not the same number and not the same job**, which the
   rules doc says out loud (§6b: "that number is right for joining audio and too
   short for marking an edit") and lists in §10 as a real spec divergence that
   needs a founder, "since it touches the player." This module implements the
   merged rule — 2.0 s at an unbridged seam — and 0.5 s stays correct for the
   padding baked around a TTS item whenever narration exists.

   ── What is NOT a seam ────────────────────────────────────────────────────

   The gap marks an edit the LISTENER DID NOT ASK FOR. Four cases therefore get
   nothing, and each one would be a bug if it did:

     - a bridged transition. Narration is a better marker than silence and it
       carries the 0.5 s padding of its own spec. Silence on top of it is dead
       air, not a beat.
     - anything the listener drove — a skip, a row tap, a scrub, a resume.
       They named a destination; a 2 s wait on a button press is a stall.
     - the first item of a Foray. There is nothing to be marked off from.
     - an ordinary unbounded episode on either side. A full episode ending is
       not an edit we made, and product principle 3 means we never touched it.

   ── What this deliberately is NOT ─────────────────────────────────────────

   It is NOT silence appended to audio. Nothing here, and nothing in the manager
   that consumes it, modifies, re-encodes, proxies or pads an episode file —
   product principle 3, "never rehost/proxy/transform episode audio." The gap is
   wall clock between the moment one segment's out-point stops the element and
   the moment the next segment's `startPlayback` runs. The bytes are untouched
   and the seam exists only in the player's timing.
*/

import { itemBounds } from "./queue-state.js";

/** The merged rule. `docs/curation/segment-length-rules.md` §0 ("Same-episode
    seam silence >= 2.0 s where narration is not used") and §6b. */
export const SEAM_GAP_SEC = 2.0;

/** Why the player moved from one item to the next. Only the first gets a beat. */
export const AUTO_ADVANCE = "auto";
export const USER_ACTION = "user";

/** A queue item is a Foray SEGMENT when it occupies a real forward slice of a
    source. Same predicate the reducer, the manager and the Foray builder use —
    imported rather than re-derived, because three definitions of "bounded" is
    exactly the drift `itemBounds` was written to end. */
export function isSegment(item) {
  return itemBounds({ startSec: item?.start_sec, endSec: item?.end_sec }) != null;
}

/**
 * How much silence belongs between `from` and `to`, in seconds.
 *
 * @param {object}  seam
 * @param {object}  [seam.from]     the queue item that just finished
 * @param {object}  [seam.to]       the queue item about to load
 * @param {boolean} [seam.bridged]  a narration item plays between them
 * @param {string}  [seam.cause]    AUTO_ADVANCE | USER_ACTION
 * @param {number}  [seam.gapSec]   override the length (tests, future settings)
 * @returns {number} seconds, 0 when this transition is not a seam
 */
export function seamGapSec({ from, to, bridged = false, cause = AUTO_ADVANCE, gapSec = SEAM_GAP_SEC } = {}) {
  if (cause !== AUTO_ADVANCE) return 0;
  if (bridged) return 0;
  if (!from || !to) return 0;
  if (!isSegment(from) || !isSegment(to)) return 0;
  const sec = typeof gapSec === "number" && Number.isFinite(gapSec) && gapSec > 0 ? gapSec : 0;
  return sec;
}

/**
 * One human sentence about a seam, for telemetry. Kept here beside the rule so
 * the log line cannot describe a decision this module did not make.
 */
export function describeSeam({ from, to, bridged = false, cause = AUTO_ADVANCE, gapSec = SEAM_GAP_SEC } = {}) {
  const sec = seamGapSec({ from, to, bridged, cause, gapSec });
  if (sec > 0) return `${sec.toFixed(1)}s beat: ${from.id} -> ${to.id}`;
  if (cause !== AUTO_ADVANCE) return `no beat (${cause}-driven): the listener named where to go`;
  if (bridged) return "no beat: narration bridges this seam";
  if (!from || !to) return "no beat: nothing on one side of this transition";
  return "no beat: not a segment-to-segment seam";
}
