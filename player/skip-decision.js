/* skipped_at: is "a different episode starts now" a skip of the one that was
   playing, and if so, the row's numbers (docs/roadmap/catalogue-personalization.md
   §PKG-19, the Seams bullet (a) and "Guards at that seam"; spec §1.2).

   A PURE DECISION. `skipDecision(...)` reads only its argument and answers
   `{ episode_id, elapsed_seconds, duration_seconds }` or `null`. It logs
   nothing, stores nothing and reads no clock: the caller reads the outgoing
   episode's state and hands it over, and the caller's subscriber logs the
   row (`backend/src/types/events.ts` `SkippedAtPayloadSchema`: elapsed
   nonnegative, duration positive). `topics` are app.js's to add.

   NULL -- NOT A SKIP -- WHEN (one test each in skip-decision.test.js):
     - the outgoing item is a Foray clip (`outgoingIsForay`): a Foray is never
       a skipped episode;
     - there is no outgoing episode with an id;
     - the outgoing episode never loaded (`outgoingLoaded` is not true): while
       a load is pending the player's position answers the REQUESTED resume
       point, not listening;
     - the duration is unknown, non-finite or <= 0: "< 0.85 x duration"
       cannot be decided without one;
     - the incoming id is the outgoing id: replaying the same episode is not
       a switch;
     - elapsed is unknown, non-finite or <= 0: nothing was heard;
     - elapsed >= SKIP_THRESHOLD x duration: that is listened through, not
       skipped (a natural end is `finished`'s, through onEpisodeEnded).

   THE LATER CALL SITE (PKG-19, not this card). `ForayPlayer.play(item, opts)`
   in player/client.js is the one owner of "the current episode changed": it
   calls this BEFORE `flushPositions()`, while `current` is still the outgoing
   item, `foray` still says whether it was a Foray and episodePositionSec() /
   episodeDurationSec() still answer for it, and delivers a non-null answer
   through ONE new player hook beside `onEpisodeEnded`; app.js subscribes and
   logs it. The player module never calls logEvent. Not app.js's three
   `play_started` sites (three owners), not `setNowPlaying` (it runs after the
   flush), not `syncCurrentFromEngine`.

   NATIVE ENGINE-WALKED HOPS EMIT NO skipped_at (Seams (b)). A hop the native
   engine walks (a steering-wheel "next" past the queue's end, an autoadvance)
   is logged with no elapsed and no duration, so it never reaches this
   decision; on native, skipped_at comes only from page-initiated plays that
   go through play(). Carrying elapsed/duration on the hop is a mobile/ +
   contract change outside PKG-19.

   DELIBERATELY NOT IMPORTED YET (code-health CH-07): nothing imports this
   module, so it is not in client.js's import closure and not on the boot list
   (test/boot-path.test.js perf-1). PKG-19 adds the import in client.js, and
   index.html's modulepreload line, in the PR that wires the hook.

   The finite-number rule is player/guards.js's `isNum`, imported (CH-41: one
   owner; guards.test.js fails on a local copy). */

import { isNum, isObj } from "./guards.js";

/** Elapsed at or past this fraction of the duration is listened through. */
export const SKIP_THRESHOLD = 0.85;

/**
 * @param {{ outgoing: { id: string } | null | undefined, outgoingIsForay: boolean,
 *   incomingId: string, outgoingLoaded: boolean, elapsedSec: number,
 *   durationSec: number | null | undefined }} input
 * @returns {{ episode_id: string, elapsed_seconds: number, duration_seconds: number } | null}
 */
export function skipDecision(input) {
  const { outgoing, outgoingIsForay, incomingId, outgoingLoaded, elapsedSec, durationSec } =
    isObj(input) ? input : {};
  if (outgoingIsForay) return null;
  if (!isObj(outgoing) || typeof outgoing.id !== "string" || outgoing.id === "") return null;
  if (outgoingLoaded !== true) return null;
  if (!isNum(durationSec) || durationSec <= 0) return null;
  if (incomingId === outgoing.id) return null;
  if (!isNum(elapsedSec) || elapsedSec <= 0) return null;
  if (elapsedSec >= SKIP_THRESHOLD * durationSec) return null;
  return { episode_id: outgoing.id, elapsed_seconds: elapsedSec, duration_seconds: durationSec };
}
