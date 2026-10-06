/* What KIND of thing a Foray item is, asked one way everywhere (code-health
   CH-11, P2-03).

   A Foray's items are tape (a segment cut from a publisher's episode) or OURS:
   a narrator bridge, or an authored jingle (generation-architecture.md §4.8).
   Before this file the question had three answers. `segment-strip.js` spelled
   `"tts"` itself and keyed a jingle on its asset URL, so the strip painted it
   as a toned clip of a show with no name and counted it in `stripTally.clips`;
   `media-session.js` already credited it as ours. Now both read the
   predicates below.

   Each predicate accepts BOTH shapes an item travels in: the built queue item
   (`kind`, from `buildForayQueue`) and the authored/hydrated entry (`type`,
   as `data/forays.json` writes it). The player page hands a surface
   `resolved.playable`; a card may hand it `resolved.entries`.

   What this file does NOT decide:
     - The rate. `player/queue-state.js` keeps its own `TTS` constant and must
       not import this module (queue-state is the reducer every engine mirrors,
       and this module imports it — a cycle). A jingle keeping 1.0x like
       `interlude.js`'s INTERLUDE_RATE is CH-11b, with the Swift and Java
       reducer ports.
     - Warming. Whether a seam PREPARES a jingle ahead of time is
       `deck-policy.js` `warmsAcross` (and the native `preparesNext` it
       mirrors), a separate decision about bytes and decoders, unchanged here.

   Pure: no DOM, no storage. */

import { TTS } from "./queue-state.js";
import { JINGLE, NARRATION } from "./foray-queue.js";

/** A narrator bridge: `kind: "tts"` on a built queue item, `type: "narration"`
    on an authored/hydrated one. */
export function isNarration(item) {
  return item?.kind === TTS || item?.type === NARRATION;
}

/** An authored jingle: `kind: "jingle"` on a built queue item, `type:
    "jingle"` on an authored/hydrated one. Not the player-side interlude, which
    is never a queue item (`interlude.js`). */
export function isJingle(item) {
  return item?.kind === JINGLE || item?.type === JINGLE;
}

/** Tape: an item that is not ours — a slice of a publisher's episode. */
export function isTape(item) {
  return item != null && typeof item === "object" && !isNarration(item) && !isJingle(item);
}
