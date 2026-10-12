import { createHash } from "crypto";
import { cueShape, nearestEndBoundary, nearestStartBoundary, type CueShape } from "./tapeExtent";
import { cueWindowText, endAnchorFor, indexCues, startAnchorFor, type TranscriptCue } from "./transcriptArchiveLookup";
import { phraseIsInWindow } from "../types/anchorText";

/**
 * THE PASSAGE CUTTER (GV-12; roadmap docs/roadmap/generation-v2.md, from
 * W3-23; covers R1-09 and R2-04).
 *
 * Cuts one episode's transcript into WHOLE-THOUGHT PASSAGES of about 90-180 s,
 * by the same boundary rules sourcing extends a clip by (`tapeExtent.ts`:
 * `cueShape`, `nearestStartBoundary`, `nearestEndBoundary`) and with anchors
 * minted by the same rule a sourced segment's are (`startAnchorFor` /
 * `endAnchorFor` in `transcriptArchiveLookup.ts`, spill included). The dense
 * arm, the per-node shortlist and the clean-cut work (R2-05) then all read
 * stored passages instead of re-cutting tape at query time.
 *
 * THE WALK. Passages tile the episode in cue order, never overlapping:
 *   - a passage opens on the cue after the previous one closed (the first on
 *     the episode's first cue);
 *   - once it covers at least `PASSAGE_TARGET_MIN_SEC`, it closes at the
 *     nearest cue whose end is a `turn` or `sentence` boundary (a turn first
 *     when the cues carry speakers, `nearestEndBoundary`'s own rule) and whose
 *     end is at or before `PASSAGE_TARGET_MAX_SEC`;
 *   - with no such boundary it closes on the last cue that ends within
 *     `PASSAGE_MAX_SEC`, an edge labelled `cue` (a cut no thought boundary
 *     marks);
 *   - the episode's tail, shorter than the target, is its last passage.
 * So every passage but an episode's last is within [TARGET_MIN, MAX_SEC],
 * save one made of a single cue longer than MAX_SEC on its own, which no cut
 * at a cue edge can shorten.
 *
 * TWO EDGE KINDS, NOT ONE. `startBoundary` and `endBoundary` are reported
 * separately (R2-05 measures each edge of a cut), unlike `TapeWindow.boundary`,
 * which keeps only the weaker. An edge is `cue` whenever no turn or sentence
 * boundary sits exactly there, which includes every `PASSAGE_MAX_SEC` cut that
 * did not happen to land on one.
 *
 * WHAT IS STORED PER PASSAGE: a deterministic id (the first 16 hex of
 * sha1(show_id|guid|startSec|endSec)), the cue range (indices into the cues
 * that carry words, `indexCues`' numbering, which `TapeWindow` also uses), the
 * seconds, both edge kinds, both anchors, the text the passage speaks
 * (`cueWindowText`, strict edges) and `PASSAGE_INDEX_VERSION`.
 *
 * ANCHOR RULE NOTE. Anchors use today's content-word rule (`mintStartAnchor` /
 * `mintEndAnchor`). If R2-06's distinctiveness rule lands (GV-122), bump
 * `PASSAGE_INDEX_VERSION` and re-cut every stored passage.
 *
 * Pure: no file, no network, no model. No pipeline stage calls it (GV-12 has
 * no flag); `cli/indexBodies.ts --passages-out` is its only caller.
 */

/** Bump whenever a stored passage would come out different: the walk, the
 * boundary rules, the anchor rule or the text rule. */
export const PASSAGE_INDEX_VERSION = 1;
/** A passage closes at a thought boundary only once it covers this much. */
export const PASSAGE_TARGET_MIN_SEC = 90;
/** The boundary it closes at must end by this much. */
export const PASSAGE_TARGET_MAX_SEC = 180;
/** With no boundary inside the target, the cut falls at a cue edge by here. */
export const PASSAGE_MAX_SEC = 240;

/** What sits at a passage's edge: a speaker's turn, a sentence boundary (a
 * hole in the tape counts as one, as in `tapeExtent.ts`), or neither. */
export type PassageBoundary = "turn" | "sentence" | "cue";

/** Which episode a passage belongs to: the ARCHIVE row's show and guid. */
export interface PassageKey {
  show_id: string;
  guid: string;
}

/** A passage before it is keyed to an episode: everything the cues decide. */
export interface PassageSpan {
  firstCue: number;
  lastCue: number;
  startSec: number;
  endSec: number;
  startBoundary: PassageBoundary;
  endBoundary: PassageBoundary;
  /** Null only when the passage's words yield no quotable phrase (too few or
   * nothing but function words); never a phrase absent from `text`. */
  startAnchor: string | null;
  endAnchor: string | null;
  text: string;
}

/** One stored passage: one line of `--passages-out`. */
export interface Passage extends PassageSpan {
  id: string;
  show_id: string;
  guid: string;
  indexVersion: number;
}

/** The first 16 hex of sha1(show_id|guid|startSec|endSec). */
export function passageId(key: PassageKey, startSec: number, endSec: number): string {
  return createHash("sha1").update(`${key.show_id}|${key.guid}|${startSec}|${endSec}`).digest("hex").slice(0, 16);
}

/** The boundary kind at the START of cue `k`, or `cue` when none sits there.
 * `nearestStartBoundary` with a floor at the cue's own start looks at that cue
 * alone (the transcript's own first cue counts as a boundary there). */
function startEdgeKind(shape: CueShape, k: number): PassageBoundary {
  const hit = nearestStartBoundary(shape, k, shape.starts[k]!);
  return hit && hit.cue === k && (hit.kind === "turn" || hit.kind === "sentence") ? hit.kind : "cue";
}

/** The boundary kind at the END of cue `k`, or `cue`; the mirror of the above
 * (the transcript's own last cue counts as a boundary). */
function endEdgeKind(shape: CueShape, k: number): PassageBoundary {
  const hit = nearestEndBoundary(shape, k, shape.ends[k]!);
  return hit && hit.cue === k && (hit.kind === "turn" || hit.kind === "sentence") ? hit.kind : "cue";
}

/**
 * Cut `cues` (already through the reading filter, `cuesFromBodyJson`) into
 * passages, before they are keyed to an episode. Empty when no cue carries a
 * word.
 */
export function cutPassageSpans(cues: readonly TranscriptCue[]): PassageSpan[] {
  const index = indexCues([...cues]);
  const n = index.cues.length;
  if (n === 0) return [];
  const shape = cueShape(index);
  const spans: PassageSpan[] = [];
  let first = 0;
  let previousEndSec = -Infinity;
  while (first < n) {
    /* A cue that starts before the previous passage ended (overlapping cue
       timings) opens this one at that end, so the seconds never overlap. */
    const startSec = Math.max(shape.starts[first]!, previousEndSec);
    let last: number;
    let endBoundary: PassageBoundary;
    let reach = first;
    while (reach < n && shape.ends[reach]! - startSec < PASSAGE_TARGET_MIN_SEC) reach++;
    if (reach >= n) {
      /* The tail: less than the target is left, so it is the last passage. */
      last = n - 1;
      endBoundary = endEdgeKind(shape, last);
    } else {
      const hit = nearestEndBoundary(shape, reach, startSec + PASSAGE_TARGET_MAX_SEC);
      if (hit) {
        last = hit.cue;
        endBoundary = hit.kind === "turn" || hit.kind === "sentence" ? hit.kind : "cue";
      } else {
        /* No thought boundary inside the target: cut at the last cue edge
           within MAX_SEC (at least one cue, however long). */
        last = first;
        while (last + 1 < n && shape.ends[last + 1]! - startSec <= PASSAGE_MAX_SEC) last++;
        endBoundary = endEdgeKind(shape, last);
      }
    }
    let endSec = startSec;
    for (let k = first; k <= last; k++) endSec = Math.max(endSec, shape.ends[k]!);
    const text = cueWindowText(index.cues, startSec, endSec);
    /* The anchors are the passage's own words by construction; the check only
       refuses one a degenerate cue timing (a zero-length edge cue, which the
       strict edges leave out of `text`) would make unfindable. */
    const found = (anchor: string | null): string | null => (anchor !== null && phraseIsInWindow(anchor, text) ? anchor : null);
    spans.push({
      firstCue: first,
      lastCue: last,
      startSec,
      endSec,
      startBoundary: startEdgeKind(shape, first),
      endBoundary,
      startAnchor: found(startAnchorFor(index, first, last)),
      endAnchor: found(endAnchorFor(index, first, last)),
      text
    });
    previousEndSec = endSec;
    first = last + 1;
  }
  return spans;
}

/** Key cut spans to an episode: the id is computed from the key, so the same
 * spans keyed to two archive rows are two sets of passages. */
export function keyPassages(key: PassageKey, spans: readonly PassageSpan[]): Passage[] {
  return spans.map((span) => ({
    id: passageId(key, span.startSec, span.endSec),
    show_id: key.show_id,
    guid: key.guid,
    ...span,
    indexVersion: PASSAGE_INDEX_VERSION
  }));
}

/** Cut one episode into keyed passages. `key.guid` is the ARCHIVE row's guid,
 * which can differ from the guid the body records. */
export function cutPassages(key: PassageKey, cues: readonly TranscriptCue[]): Passage[] {
  return keyPassages(key, cutPassageSpans(cues));
}
