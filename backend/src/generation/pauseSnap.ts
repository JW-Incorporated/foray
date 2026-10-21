import type { TranscriptCue } from "./transcriptArchiveLookup";

/**
 * GV-111 (docs/roadmap/generation-v2.md, from W5-14b; R2-05, MQ-06): where a
 * clip edge can sit on a REAL pause, read from word timestamps.
 *
 * WHY. A tier-2 clip is cut to whole caption cues (`cutWindowToSegment`), and
 * a caption cue is a display unit, not a breath: the archive's median cue is
 * 16.6 s (`tapeExtent.ts`, `THOUGHT_PAUSE_SEC`), and a cue edge often falls
 * mid-sentence. A body whose cues carry word timings (`TranscriptCue.words`,
 * whisper `word_timestamps` from the transcript farm) says where the speaker
 * actually stopped: a gap between two timed words. R2 called moving the edge
 * there the biggest "sounds professional" lever, and it costs nothing at
 * request time once the bodies carry words.
 *
 * WHAT COUNTS AS A PAUSE. A gap of at least `PAUSE_MIN_GAP_SEC` (0.3 s)
 * between one word's end and the next word's start, at most
 * `PAUSE_MAX_SHIFT_SEC` (4 s) from the cue edge it would replace. 0.3 s is
 * the gap the Q-01 measurement already uses for "a stop after a full stop"
 * (37 of 91 sentence ends on *Being an Engineer* S5E50 were followed by one);
 * the 4 s bound is how far whisper's word timing may be trusted to move an
 * edge at all (it drifts on long files) and keeps the snap a refinement of
 * the cut rather than a new cut.
 *
 * WHICH WORDS ARE ASKED. The edge cue's own words, plus the OUTWARD
 * neighbour's (the cue before a start edge, the cue after an end edge), so an
 * edge can move back to the pause that ended the previous sentence as well as
 * forward to one inside its own cue. Never the inward neighbour: a snap may
 * not eat a cue the cut chose. A neighbour spoken by another speaker is not
 * asked (a start edge never pulls in the previous speaker's last words), and
 * a neighbour with no words still lends its own end (or start) as the far
 * side of the gap at the cue boundary, but no word of it can be snapped to.
 *
 * PREFERENCE. A pause after terminal punctuation (the word before the gap
 * ends in `.`, `?` or `!`) wins over any other, nearest first: that edge is a
 * sentence boundary (kind `sentence`). Failing one, the nearest pause (kind
 * `pause`). Ties go to the longer gap.
 *
 * Pure: no I/O, no clock, no model.
 */

/** The shortest gap between two timed words that is a pause. */
export const PAUSE_MIN_GAP_SEC = 0.3;

/** The furthest a snap may move a clip edge from the cue edge it replaces. */
export const PAUSE_MAX_SHIFT_SEC = 4;

/** A word ends a sentence when it ends in a terminal mark, closing quotes and
 * brackets forgiven — the same rule as `tapeExtent.ts`'s `SENTENCE_END`. */
const SENTENCE_END = /[.!?][\s"'”’)\]]*$/;

/** Float slack for the gap and shift comparisons (0.7 - 0.4 is 0.2999...). */
const EPS = 1e-9;

export type SnapSide = "start" | "end";

/** `sentence`: the pause follows terminal punctuation. `pause`: any other. */
export type SnapKind = "sentence" | "pause";

export interface PauseSnapOptions {
  /** Default `PAUSE_MIN_GAP_SEC`. */
  minGapSec?: number;
  /** Default `PAUSE_MAX_SHIFT_SEC`. */
  maxShiftSec?: number;
  /** Whether the outward neighbour cue's words may be snapped to. Default true. */
  outward?: boolean;
  /** A candidate edge earlier than this is not offered (a ceiling on the
   * clip's length, or the other edge). */
  notBeforeSec?: number;
  /** A candidate edge later than this is not offered. */
  notAfterSec?: number;
}

/** One pause an edge could move to. */
export interface Pause {
  /** Where the edge would sit: the snapped word's start (a start edge) or end
   * (an end edge). */
  sec: number;
  /** The snapped word: the first word the clip would play (a start edge) or
   * the last (an end edge), as an index into `cues` and into its `words`. */
  cueIndex: number;
  wordIndex: number;
  gapSec: number;
  /** |sec - the cue edge|. */
  shiftSec: number;
  /** The word before the gap ends in terminal punctuation. */
  afterTerminal: boolean;
}

/** `snapEdge`'s answer. */
export interface SnappedEdge {
  sec: number;
  cueIndex: number;
  wordIndex: number;
  kind: SnapKind;
  shiftSec: number;
  gapSec: number;
}

interface Token {
  cueIndex: number;
  /** -1 for a neighbour with no words, which lends its timing but cannot be
   * snapped to. */
  wordIndex: number;
  text: string;
  start: number;
  end: number;
}

function sameSpeaker(a: TranscriptCue, b: TranscriptCue): boolean {
  const sa = a.speaker ?? null;
  const sb = b.speaker ?? null;
  return sa === null || sb === null || sa === sb;
}

function tokensOf(cues: readonly TranscriptCue[], cueIndex: number): Token[] {
  const cue = cues[cueIndex]!;
  if (cue.words && cue.words.length > 0) {
    return cue.words.map((w, wordIndex) => ({ cueIndex, wordIndex, text: w.text, start: w.start, end: w.end }));
  }
  return [{ cueIndex, wordIndex: -1, text: cue.text, start: cue.start_sec, end: cue.end_sec }];
}

/**
 * Every pause the `side` edge of cue `cueIndex` could move to, nearest first
 * (the longer gap first on a tie). Empty when the edge cue carries no words —
 * a body without word timings is never snapped.
 */
export function pausesNear(cues: readonly TranscriptCue[], cueIndex: number, side: SnapSide, options: PauseSnapOptions = {}): Pause[] {
  const cue = cues[cueIndex];
  if (!cue || !cue.words || cue.words.length === 0) return [];
  const minGapSec = options.minGapSec ?? PAUSE_MIN_GAP_SEC;
  const maxShiftSec = options.maxShiftSec ?? PAUSE_MAX_SHIFT_SEC;
  const edgeSec = side === "start" ? cue.start_sec : cue.end_sec;
  const neighbour = side === "start" ? cueIndex - 1 : cueIndex + 1;
  const hasNeighbour = neighbour >= 0 && neighbour < cues.length && sameSpeaker(cue, cues[neighbour]!);
  const own = tokensOf(cues, cueIndex);
  let tokens: Token[] = own;
  if (hasNeighbour) {
    const theirs = tokensOf(cues, neighbour);
    /* With `outward` off the neighbour still lends the far side of the gap at
       the cue boundary, never a word to snap to. */
    const lent = options.outward === false ? theirs.map((t) => ({ ...t, wordIndex: -1 })) : theirs;
    tokens = side === "start" ? [...lent, ...own] : [...own, ...lent];
  }
  const pauses: Pause[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const before = tokens[i]!;
    const after = tokens[i + 1]!;
    const gapSec = after.start - before.end;
    if (gapSec + EPS < minGapSec) continue;
    const snapped = side === "start" ? after : before;
    if (snapped.wordIndex < 0) continue;
    const sec = side === "start" ? after.start : before.end;
    const shiftSec = Math.abs(sec - edgeSec);
    if (shiftSec > maxShiftSec + EPS) continue;
    if (options.notBeforeSec !== undefined && sec < options.notBeforeSec - EPS) continue;
    if (options.notAfterSec !== undefined && sec > options.notAfterSec + EPS) continue;
    pauses.push({
      sec,
      cueIndex: snapped.cueIndex,
      wordIndex: snapped.wordIndex,
      gapSec,
      shiftSec,
      afterTerminal: SENTENCE_END.test(before.text.trim())
    });
  }
  return pauses.sort((a, b) => a.shiftSec - b.shiftSec || b.gapSec - a.gapSec);
}

/**
 * Where the `side` edge of cue `cueIndex` snaps to: the nearest pause after
 * terminal punctuation (kind `sentence`), else — unless `requireSentence` —
 * the nearest pause of any kind (kind `pause`). Null when there is none, and
 * the edge stays where the cue put it.
 *
 * `requireSentence` is for an edge that already sits on a sentence boundary:
 * it may move to a better-timed sentence boundary, never off one onto a mere
 * pause.
 */
export function snapEdge(
  cues: readonly TranscriptCue[],
  cueIndex: number,
  side: SnapSide,
  options: PauseSnapOptions & { requireSentence?: boolean } = {}
): SnappedEdge | null {
  const pauses = pausesNear(cues, cueIndex, side, options);
  const pick = pauses.find((p) => p.afterTerminal) ?? (options.requireSentence ? undefined : pauses[0]);
  if (!pick) return null;
  return {
    sec: pick.sec,
    cueIndex: pick.cueIndex,
    wordIndex: pick.wordIndex,
    kind: pick.afterTerminal ? "sentence" : "pause",
    shiftSec: pick.shiftSec,
    gapSec: pick.gapSec
  };
}
