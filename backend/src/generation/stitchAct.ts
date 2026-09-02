import type { WrittenAct, WrittenSlot } from "./writeNarration";
import type { CoverageEntry, StitchedAct, StitchedItem, StitchedJingleItem, StitchedNarrationItem, StitchedTapeItem } from "../types/stitching";

/**
 * §4.8 WITHIN-ACT stitching (docs/curation/generation-architecture.md
 * §4.8, §5's topology table: "4.8 Stitch within act | The act's agent |
 * It wrote the pages; it knows the voice."). Despite that table entry
 * naming "the act's agent", the actual work performed here — deciding
 * whether a beat-to-beat seam is silence, a jingle, or already-written
 * narration, and checking coverage — is 100% DETERMINISTIC given
 * §4.7's `WrittenAct` output: no new judgement call is made about voice
 * or prose (that already happened in §4.4/§4.7), only mechanical
 * seam/gap/coverage bookkeeping. Per this stage's own task brief and
 * PR #408's precedent (`sourceBeats.ts`, which skips the LLM Builder
 * pattern for the identical reason — see that module's own doc comment
 * for the general principle), a deterministic decision does not need an
 * LLM call or a Builder/Stub/Anthropic/create quad; it needs a pure,
 * well-tested function. That is what this module is. The genuinely
 * NEW-JUDGEMENT half of §4.8 — cross-act continuity — is NOT
 * deterministic (two independently-written strings need real prose
 * smoothing) and DOES use the Builder pattern; see `ContinuityBuilder.ts`
 * and `smoothSeam.ts`.
 *
 * FOUR RULES IMPLEMENTED HERE, IN ORDER (§4.8's own numbering):
 *
 *   1. SILENCE IS A VALID BRIDGE. Two adjacent tape items from the SAME
 *      episode (`tape.itemId` unchanged) with nothing else between them
 *      get NOTHING inserted — `player/seam-gap.js` already returns 0 for
 *      such a bridge, and inserting a jingle or narration there would
 *      make "a bridge and a gap... both", which §4.8 explicitly forbids.
 *
 *   2. THE JINGLE MARKS A CHANGE OF TAPE. A cross-episode tape-to-tape
 *      transition (`tape.itemId` CHANGES) needs *something* marking it —
 *      never two consecutive unrelated tape items with nothing between.
 *      §4.7's own `decideConnectiveNarration` (writeNarration.ts)
 *      already assigns a Frame connective-narration page to exactly this
 *      case (see that function's doc comment: "Cross-episode tape-to-
 *      tape: S1, Frame, attribution mandatory"), so the ordinary path
 *      never reaches this module needing a jingle for a real cut — the
 *      narration IS the mark. This module inserts a `StitchedJingleItem`
 *      (`reason: "cut"`) ONLY as a structural backstop: if a cross-
 *      episode transition somehow reaches here with no connective
 *      narration on either side, a bare jingle still marks the cut
 *      rather than silently gluing two unrelated episodes together.
 *
 *   3. TEXTURE ON A CADENCE — MEASURED, NOT GUESSED. See
 *      `TEXTURE_CADENCE_SEC` below and its citation to
 *      `tools/foray/measure-cadence.mjs`'s real run against
 *      `grilling-history-1`. An otherwise-silent same-episode bridge
 *      (rule 1's case) that has let more than `TEXTURE_CADENCE_SEC`
 *      elapse since the last audible marker (jingle, narration, or a
 *      real cut) gets a `StitchedJingleItem` (`reason: "cadence"`)
 *      inserted instead of staying silent — "a jingle or a beat of
 *      silence roughly every few minutes gives the ear a boundary to
 *      rest on."
 *
 *   4. COVERAGE IS CHECKED BEFORE FLOW. Every beat this module walks
 *      gets exactly one `CoverageEntry` (`present`, since this module
 *      never drops a beat itself — nothing upstream of §4.9 has a
 *      reason to cut content at this stage) in `StitchedAct.coverage`.
 *      `validateActCoverage` (stitching.ts) is the caller-side hard gate
 *      that a missing entry — a beat this module somehow skipped —
 *      fails loudly rather than silently.
 */

/**
 * §4.8 rule 3's measured cadence (docs/curation/generation-architecture.md
 * §4.8: "Propose a cadence, measure it against a real long Foray, and
 * write down what you measured — do not ship a number that was
 * guessed.").
 *
 * MEASURED, not guessed: `tools/foray/measure-cadence.mjs`, run against
 * the real 61-minute, 32-segment `grilling-history-1` Foray in
 * `data/forays.json` / `data/segments.json` (the one real long Foray
 * this repo has), found:
 *
 *   17 cut-gaps (the elapsed time between one cross-episode cut and the
 *   next, across the whole Foray)
 *   median cut gap: 155.34 s
 *   mean cut gap:   216.06 s
 *
 * `TEXTURE_CADENCE_SEC` below rounds the MEDIAN (155.34 s) down to a
 * whole number — 155, not 216 (the mean) — because the median is the
 * measurement least distorted by the handful of unusually long single-
 * episode stretches in that Foray (see the raw cut-gap list printed by
 * `measure-cadence.mjs`), and because a texture cadence exists to give
 * "the ear a boundary to rest on" roughly regularly — the TYPICAL gap
 * between real cuts, which the median estimates, is the more faithful
 * stand-in for that than a mean pulled long by a few outliers.
 *
 * Re-run `node tools/foray/measure-cadence.mjs` and update this constant
 * (with this same citation) if `grilling-history-1` is ever re-curated —
 * see that script's own doc comment.
 */
export const TEXTURE_CADENCE_SEC = 155;

function narrationItemId(actLabel: string, beatIndex: number, suffix: string): string {
  return `narration-${actLabel}-${beatIndex}-${suffix}`;
}

function jingleItemId(actLabel: string, beatIndex: number, reason: "cut" | "cadence"): string {
  return `jingle-${reason}-${actLabel}-${beatIndex}`;
}

/**
 * Stitches ONE act's `WrittenAct` (§4.7's output — see writeNarration.ts)
 * into its `StitchedAct` (ordered items + coverage report), applying the
 * four rules above. `actLabel` is used only to build stable, readable
 * item ids (e.g. "act-2") and never affects ordering or content.
 */
export function stitchAct(act: WrittenAct, actLabel: string): StitchedAct {
  const items: StitchedItem[] = [];
  const coverage: CoverageEntry[] = [];

  let beatIndex = 0;
  /** Wall-clock elapsed since the last audible marker (jingle, written
   * narration, or a jingle-marked cut) — reset to 0 every time one is
   * inserted or written. Only same-episode SILENT bridges accumulate
   * this; a written narration item or a jingle both count as "a
   * boundary the ear can rest on" and reset the clock (§4.8 rule 3). */
  let elapsedSinceMarker = 0;
  let previousTape: StitchedTapeItem | null = null;

  for (const slot of act.slots) {
    for (const beat of slot.beats) {
      const myIndex = beatIndex++;
      coverage.push({ status: "present", beatIndex: myIndex, claim: beat.claim });

      if (beat.sourcing === "narration") {
        const narrationItem: StitchedNarrationItem = {
          kind: "narration",
          narrationKind: "beat",
          beatIndex: myIndex,
          slotTitle: slot.title,
          mode: beat.narration.mode,
          script: beat.narration.script,
          id: narrationItemId(actLabel, myIndex, "beat")
        };
        items.push(narrationItem);
        elapsedSinceMarker = 0;
        previousTape = null; // no longer an adjacent tape-tape boundary
        continue;
      }

      // beat.sourcing === "tape"
      if (beat.connectiveNarration) {
        const connectiveItem: StitchedNarrationItem = {
          kind: "narration",
          narrationKind: "beat",
          beatIndex: myIndex,
          slotTitle: slot.title,
          mode: beat.connectiveNarration.mode,
          script: beat.connectiveNarration.script,
          id: narrationItemId(actLabel, myIndex, "connective")
        };
        items.push(connectiveItem);
        elapsedSinceMarker = 0;
      } else if (previousTape) {
        // Rule 1/2/3: decide what (if anything) bridges the previous
        // tape item and this one, since neither side wrote connective
        // narration to do that job.
        const sameEpisode = previousTape.itemId === beat.tape.itemId;
        if (!sameEpisode) {
          // Rule 2's structural backstop — see module doc comment for
          // why the ordinary path (Frame connective narration) already
          // covers this and this branch is rarely hit in practice.
          const jingle: StitchedJingleItem = { kind: "jingle", reason: "cut", id: jingleItemId(actLabel, myIndex, "cut") };
          items.push(jingle);
          elapsedSinceMarker = 0;
        } else if (elapsedSinceMarker > TEXTURE_CADENCE_SEC) {
          // Rule 3: same-episode bridge that would otherwise be silent,
          // but the measured cadence has elapsed since the last marker.
          const jingle: StitchedJingleItem = { kind: "jingle", reason: "cadence", id: jingleItemId(actLabel, myIndex, "cadence") };
          items.push(jingle);
          elapsedSinceMarker = 0;
        }
        // else: Rule 1 — silence is a valid bridge; insert nothing.
      }

      const tapeItem: StitchedTapeItem = {
        kind: "tape",
        beatIndex: myIndex,
        slotTitle: slot.title,
        segmentId: beat.tape.segmentId,
        itemId: beat.tape.itemId,
        startSec: beat.tape.startSec,
        endSec: beat.tape.endSec
      };
      items.push(tapeItem);
      elapsedSinceMarker += tapeItem.endSec - tapeItem.startSec;
      previousTape = tapeItem;
    }
  }

  return { items, coverage: { entries: coverage } };
}

/** Total beat count in an act's flattened beat list — the number
 * `validateActCoverage` needs as its `totalBeats` argument. Mirrors
 * `spine.ts`'s `countBeats`/`allBeats` helpers for the same shape one
 * stage earlier. */
export function countActBeats(act: WrittenAct): number {
  return act.slots.reduce((sum: number, slot: WrittenSlot) => sum + slot.beats.length, 0);
}
