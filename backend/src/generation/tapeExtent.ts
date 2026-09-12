import { tokenizeForSourcing } from "./catalogueLookup";
import {
  claimTermWeigher,
  indexCues,
  TAPE_CUE_GAP_MAX_SEC,
  TAPE_WINDOW_MAX_SEC,
  TAPE_WINDOW_MIN_SEC,
  type CueIndex,
  type TapeBoundary,
  type TapeWindow,
  type TranscriptCue
} from "./transcriptArchiveLookup";

/**
 * Q-01 (docs/curation/listening-quality-plan.md): A CLIP STARTS AND ENDS AT
 * THOUGHT BOUNDARIES, AND RUNS FOR AS LONG AS THE CONTENT STAYS RELEVANT.
 *
 * THE COMPLAINT THIS ANSWERS. Wyatt, 2026-09-12, after listening to the four
 * generated Forays: "The podcasts were trimmed too aggressively. I was just
 * starting to get into the podcast and it would cut off", and "the podcast
 * sounded like it had a relevant introduction that could have been included".
 * `selectTapeWindow` sizes a window (30-180 s) to cover the CLAIM's words, not
 * the speaker's thought, so a clip opened mid-sentence on the phrase that
 * proved the claim and closed as soon as the claim's vocabulary ran out —
 * 122-139 s mean, 31 s shortest, across the four Forays on `main` @ #642.
 *
 * WHAT THIS DOES, IN ORDER (`extendToThought`):
 *   1. The START moves back to the nearest thought boundary before the claim
 *      window: the beginning of the speaker's turn when the cues carry
 *      speakers, else the previous sentence boundary that a pause marks
 *      (`THOUGHT_PAUSE_SEC`) or that closes a paragraph-sized cue
 *      (`PARAGRAPH_CUE_SEC`). Then it keeps moving back, one
 *      `RELEVANCE_WINDOW_SEC` window at a time, while the tape there still
 *      scores above `RELEVANCE_FLOOR` against the claim and the act's thesis,
 *      and backs up to the boundary nearest the far edge of the relevant
 *      stretch. When the speaker's turn was prompted by a short question from
 *      another speaker — the host's question — the question is included too.
 *   2. The END moves forward to the nearest boundary after the claim window
 *      (the end of the turn, or of the sentence), then keeps going by the same
 *      sliding windows while the score holds, stops at the first window that
 *      drifts — or at a hole in the tape (`TAPE_CUE_GAP_MAX_SEC`) — and backs
 *      up to the last boundary before it.
 *   3. The result is capped at `maxSec` — `TAPE_WINDOW_MAX_SEC` (1,800 s),
 *      the founder's ceiling ("if there's a half hour of relevant content then
 *      let it ride") — and the floor, `TAPE_WINDOW_MIN_SEC` (60 s, the least a
 *      listener can be dropped into and hear a thought), is what the cut then
 *      GROWS TOWARDS through cues that share the claim (`cutWindowToSegment`,
 *      F-62), never a pad of whatever tape is next: see the clamp note in
 *      `extendToThought`.
 *
 * WHAT IT DOES NOT CHANGE. The window's edges are still cue boundaries, so
 * `cutWindowToSegment` mints `start_anchor`/`end_anchor` from the tape's own
 * words at them exactly as before — the ad-insertion anchoring constraint
 * (ADR-0007) is untouched, and `check-forays.mjs` sees nothing new but two
 * optional fields. The relevance verdict on the CLAIM window
 * (`tapeWindowIsRelevant`) is made before this runs and is not revisited: the
 * extension can add tape, never make a window about something else.
 *
 * WHAT IS RECORDED. `boundary` says what kind of edge the clip landed on
 * (`"turn"` / `"sentence"` / `"claim-only"`, the weaker of the two edges) and
 * `extendedBySec` how far relevance carried it past the claim window — both go
 * onto the minted row, so the ledger can say how often a real boundary was
 * found and how far the content ran.
 *
 * MEASURED ON THE RUN-8 CANDIDATE (*Being an Engineer*, 16 clips, the show's
 * own text-index idf; the table is in the Q-01 PR): mean clip 122 s -> 213 s,
 * longest 177 s -> 671 s; 12 clips longer, 3 unchanged, 1 shorter (the old
 * ladder had grown it on the trade's everyday words, which the idf weighting
 * discounts); boundary `turn` 10, `sentence` 5, `claim-only` 1 (a clip the
 * floor growth carried past its boundary).
 */

/**
 * A GAP THAT MARKS A SPOKEN PAUSE. The publisher transcripts this archive holds
 * are cut into cues of a sentence or so (median 16.6 s on *Being an Engineer*
 * S5E50, 119 cues), and the gap between one cue's end and the next one's start
 * is where the pause between them went. Measured on that transcript: the
 * median gap is 0.12 s (a continuation), the 80th percentile 1.26 s; 37 of 118
 * gaps are >= 0.7 s and 91 of 119 cues end in `.`/`?`/`!`, of which 37 are
 * followed by a gap >= 0.3 s. A boundary that asks for BOTH a sentence end and
 * a gap of this size is therefore a place the speaker actually stopped, not
 * every full stop — around one boundary every three cues, which is the
 * granularity a cut can use. Well under `TAPE_CUE_GAP_MAX_SEC` (5 s), which is
 * a hole in the tape rather than a pause.
 */
export const THOUGHT_PAUSE_SEC = 0.7;

/**
 * A CUE THAT IS A PARAGRAPH, NOT A SENTENCE. Not every body in the archive is
 * cut one sentence per cue: the same show's bodies carry cues of 57, 115 and
 * 173 s (*Ian McEachern*, *Daniel Servansky*), and there the transcriber's cue
 * break IS the paragraph break — the gap after it is 0.2-0.5 s because the
 * speaker did not stop, the paragraph did. A cue at least twice the archive's
 * median cue length (16.6 s) holds more than one sentence, so a sentence end
 * at its close counts as a boundary without the pause. Without this rule six
 * of the run-8 candidate's sixteen clips could find no boundary at all inside
 * a three-minute stretch of relevant tape and stayed `claim-only`.
 */
export const PARAGRAPH_CUE_SEC = 30;

/** The stretch of tape relevance is scored on, one step at a time. A minute is
 * long enough to hold a whole idea (a couple of hundred words) and short enough
 * that one off-topic minute — a segue, a sponsor, a new question — is seen as
 * such rather than averaged into the answer around it. */
export const RELEVANCE_WINDOW_SEC = 60;

/** How much of a cue must lie inside a relevance window for its words to count
 * toward that window: half the cue, or ten seconds for a cue longer than
 * twenty. A sentence that ends six seconds into the next minute does not make
 * that minute relevant (the `monologue` fixture in the tests is built on
 * exactly that), while a paragraph-sized cue that runs through the minute
 * counts in it. Ten seconds rather than half so a 115 s cue counts in every
 * minute it crosses rather than only the one holding its midpoint. */
export const CUE_OVERLAP_MIN_SEC = 10;

/**
 * THE RELEVANCE FLOOR: the idf-weighted share of the claim's and the thesis's
 * distinct content words that a `RELEVANCE_WINDOW_SEC` window must speak for
 * the clip to run through it — the same weighting `selectTapeWindow` ranks
 * windows by (`claimTermWeigher`), so a window's score means the same thing
 * here as it does in the search.
 *
 * MEASURED, NOT GUESSED (run-8 candidate, *Being an Engineer*, 16 segments,
 * scored with the show's own text-index idf against the claim plus the slot
 * title; the per-window profiles are in the Q-01 PR). The 60 s windows INSIDE
 * the claim windows score 0.30-0.58; the minutes immediately around them where
 * the same answer continues, 0.09-0.27; minutes two or more away on the same
 * episode — the host's next question, another subject — 0.00-0.07, and the
 * trade's everyday words (`engineer`, `work`, `company`) are exactly what the
 * idf weighting discounts. The sixteen extents are IDENTICAL at 0.07 and
 * 0.08; 0.06 admits one more minute on one clip (#14, 183 -> 264 s, a minute
 * that scored 0.06-0.07); 0.10 loses continuing answers on four clips (#5
 * 214 -> 119 s, #8 491 -> 381, #14 183 -> 131, #15 671 -> 473). 0.08 is the
 * top of the stable band: above every measured off-topic minute, under every
 * measured continuing one.
 *
 * Why a share and not a count: the claim plus the thesis is 15-30 distinct
 * content words, and one minute of speech touches two to five of them when it
 * is about the same thing — a count floor of "three" would be the search's bar
 * for a three-minute window applied to one minute, and would stop nearly every
 * clip at its claim.
 */
export const RELEVANCE_FLOOR = 0.08;

/**
 * THE HOST'S QUESTION. A turn from another speaker that ends in a question
 * mark and is shorter than this is the question the answer answers, and the
 * listener wants it: "who is talking and what they were asked" is most of an
 * introduction (Q-02 leans on this). Longer than a minute it is not a question
 * but a monologue with a question mark on the end, and relevance decides it
 * like any other tape.
 */
export const QUESTION_TURN_MAX_SEC = 60;

/**
 * How far back (or forward) the NEAREST boundary is looked for before
 * relevance takes over. A sentence or turn boundary more than one relevance
 * window away from the claim is not the sentence the claim sits in; from there
 * on, whether the tape is kept is a question of what it says, which is step 2.
 * Deliberately the same number as `RELEVANCE_WINDOW_SEC`, not a new one.
 */
const NEAREST_BOUNDARY_SPAN_SEC = RELEVANCE_WINDOW_SEC;

export interface ExtendToThoughtOptions {
  /** The beat's claim, as `tokenizeForSourcing` terms (deduplicated here). */
  claimTerms: readonly string[];
  /** The act's thesis, likewise — what the clip is meant to serve beyond the
   * one claim, so an answer that moves from the claim to the thesis's subject
   * is still relevant. Scored as its OWN share, never folded into the claim's
   * (see `relevanceScorer`, F-96). Optional: with none, the claim alone is
   * the query. */
  thesisTerms?: readonly string[];
  /** The corpus idf the window search scored with
   * (`TranscriptTextCandidate.idf`) — the CLAIM's terms — merged with the idf
   * of the thesis's terms when the caller has one (`sourceBeats.ts` asks the
   * index for the thesis once per act). A term with no entry weighs 1, the
   * weight of its list's rarest word, which is why the thesis needs its own
   * entries: see `relevanceScorer`. */
  idf?: ReadonlyMap<string, number>;
  /** The band. `maxSec` is the ceiling (default `TAPE_WINDOW_MAX_SEC`);
   * `minSec` (default `TAPE_WINDOW_MIN_SEC`, which is `MIN_TAPE_SEGMENT_SEC`)
   * is the floor the CUT grows towards afterwards — `cutWindowToSegment`
   * reads it, not this function; it is accepted here only so the band is
   * stated in one call. See the clamp note in `extendToThought`. */
  minSec?: number;
  maxSec?: number;
  /** `RELEVANCE_FLOOR` unless overridden — for the measurement script that
   * compares floors on real tape, never for a production caller. */
  relevanceFloor?: number;
}

/** The extended window: a `TapeWindow` whose edges are thought boundaries, with
 * the Q-01 fields always present. */
export interface ThoughtExtent extends TapeWindow {
  boundary: TapeBoundary;
  extendedBySec: number;
  claimStartSec: number;
  claimEndSec: number;
}

/** Rank of a boundary kind, for "the weaker of the two edges". */
const BOUNDARY_RANK: Record<TapeBoundary, number> = { "claim-only": 0, sentence: 1, turn: 2 };

/** A cue's text ends a sentence when it ends in a terminal mark, closing
 * quotes and brackets forgiven. */
const SENTENCE_END = /[.!?][\s"'”’)\]]*$/;
const QUESTION_END = /\?[\s"'”’)\]]*$/;

export function extendToThought(window: TapeWindow, cues: TranscriptCue[], options: ExtendToThoughtOptions): ThoughtExtent {
  const index = indexCues(cues);
  const n = index.cues.length;
  const maxSec = options.maxSec ?? TAPE_WINDOW_MAX_SEC;
  const claimStartSec = window.startSec;
  const claimEndSec = window.endSec;
  const unchanged = (): ThoughtExtent => ({
    ...window,
    boundary: "claim-only",
    extendedBySec: 0,
    claimStartSec,
    claimEndSec
  });
  if (n === 0 || window.firstCue < 0 || window.lastCue >= n || window.firstCue > window.lastCue) return unchanged();

  const scoreOf = relevanceScorer(index, options);
  const floor = options.relevanceFloor ?? RELEVANCE_FLOOR;
  const shape = cueShape(index);
  const startOf = (k: number) => shape.starts[k]!;
  const endOf = (k: number) => shape.ends[k]!;

  /* ------------------------------------------------------------- the start */
  let first = window.firstCue;
  let startKind: TapeBoundary = "claim-only";

  /* 1. The nearest boundary before the claim window, within one window of it:
        a turn start when the cues carry speakers, else a sentence start. The
        transcript's own first cue counts only when the window already starts
        on it — walking BACK to the start of the tape would pull in a minute
        nobody scored, and that is relevance's decision (step 2). */
  {
    const floorSec = Math.max(claimStartSec - NEAREST_BOUNDARY_SPAN_SEC, claimEndSec - maxSec);
    const near = nearestStartBoundary(shape, first, floorSec);
    if (near) {
      first = near.cue;
      startKind = near.kind;
    }
  }

  /* 2. Further back while relevant, then back up to a boundary. Each window is
        the minute BEFORE the current edge; the walk stops at the first one
        that drifts, at a hole in the tape (keeping the relevant part after
        it), where the tape starts, or at the budget. Then the start backs up
        to the boundary nearest the reach — the farthest boundary the relevant
        stretch holds. */
  {
    const budgetSec = claimEndSec - maxSec;
    const origin = startOf(first);
    let edge = origin;
    while (edge - RELEVANCE_WINDOW_SEC >= budgetSec) {
      let from = edge - RELEVANCE_WINDOW_SEC;
      const hole = lastHoleInside(shape, from, edge);
      if (hole !== null) from = hole;
      if (!speechBetween(index, from, edge)) break;
      if (scoreOf(from, edge) < floor) break;
      edge = from;
      if (hole !== null) break;
    }
    if (edge < origin) {
      const reachCue = firstCueCountedAfter(index, edge, first, seen(options));
      const snapped = reachCue === null ? null : firstStartBoundaryFrom(shape, reachCue, first);
      if (snapped && snapped.cue < first) {
        first = snapped.cue;
        startKind = snapped.kind;
      }
    }
  }

  /* 3. The host's question that prompted the answer: when the claim speaker's
        turn begins at or after the start found so far and the turn before it
        ends in a short question, the question opens the clip. */
  if (shape.hasTurns) {
    let turn = window.firstCue;
    while (turn > 0 && !shape.turnBefore[turn]) turn -= 1;
    if (turn > 0 && turn >= first) {
      const question = questionEndingAt(shape, index, turn - 1);
      if (question !== null && question <= first && claimEndSec - startOf(question) <= maxSec) {
        first = question;
        startKind = "turn";
      }
    }
  }

  /* ---------------------------------------------------------------- the end */
  let last = window.lastCue;
  let endKind: TapeBoundary = "claim-only";
  const startSec = startOf(first);

  /* 1. The nearest boundary after the claim window, within one window of it. */
  {
    const ceilingSec = Math.min(claimEndSec + NEAREST_BOUNDARY_SPAN_SEC, startSec + maxSec);
    const near = nearestEndBoundary(shape, last, ceilingSec);
    if (near) {
      last = near.cue;
      endKind = near.kind;
    }
  }

  /* 2. Forward while relevant, then back up to the last boundary before the
        drift — the same walk as the start's, mirrored. */
  {
    const budgetSec = startSec + maxSec;
    const origin = endOf(last);
    let edge = origin;
    while (edge + RELEVANCE_WINDOW_SEC <= budgetSec) {
      let to = edge + RELEVANCE_WINDOW_SEC;
      const hole = firstHoleInside(shape, edge, to);
      if (hole !== null) to = hole;
      if (!speechBetween(index, edge, to)) break;
      if (scoreOf(edge, to) < floor) break;
      edge = to;
      if (hole !== null) break;
    }
    if (edge > origin) {
      const reachCue = lastCueCountedBefore(index, edge, last, seen(options));
      const snapped = reachCue === null ? null : lastEndBoundaryUpTo(shape, reachCue, last);
      if (snapped && snapped.cue > last) {
        last = snapped.cue;
        endKind = snapped.kind;
      }
    }
  }

  /* -------------------------------------------------------------- the clamp */
  /* THE FLOOR IS A TARGET, NOT A PAD (F-62). An extent under `minSec` is left
     under it here: `cutWindowToSegment` grows it towards `MIN_TAPE_SEGMENT_SEC`
     (the same 60 s) through cues that share the claim's words and stops where
     the tape does, down to `ABSOLUTE_MIN_TAPE_SEGMENT_SEC`. Padding a fifty-
     second thought with ten seconds of "right after this we have a different
     guest" to reach a round minute is exactly the cut F-62 removed, and a
     clip that is all of a short thought beats one that is the thought plus a
     stranger's first sentence. The ceiling is the hard edge; the floor is
     what the cut grows towards while the tape is still about the claim. */
  /* The ceiling cannot be exceeded by construction — every step above checked
     the budget — but a caller-supplied window wider than `maxSec` is clamped
     here rather than trusted. */
  while (endOf(last) - startOf(first) > maxSec && last > window.lastCue) {
    last -= 1;
    endKind = boundaryKindAfter(shape, last, false) ?? "claim-only";
  }

  const boundary: TapeBoundary = BOUNDARY_RANK[startKind] <= BOUNDARY_RANK[endKind] ? startKind : endKind;
  const extendedBySec = Math.round((endOf(last) - startOf(first) - (claimEndSec - claimStartSec)) * 1000) / 1000;
  return {
    ...window,
    firstCue: first,
    lastCue: last,
    startSec: startOf(first),
    endSec: endOf(last),
    boundary,
    extendedBySec: Math.max(0, extendedBySec),
    claimStartSec,
    claimEndSec
  };
}

/* ---------------------------------------------------------------- scoring */

/**
 * The idf-weighted share of the query's distinct content words spoken between
 * two timestamps — `selectTapeWindow`'s `weightedShare`, on a stretch of tape
 * instead of a cue run. A cue counts as spoken inside the stretch when at
 * least half of it — or `CUE_OVERLAP_MIN_SEC` of it — overlaps the stretch,
 * so a sentence that ends a few seconds into the next minute does not make
 * that whole minute look relevant. Exported so the measurement script and the
 * tests can read the number the floor is compared against.
 */
export function relevanceScorer(index: CueIndex, options: ExtendToThoughtOptions): (fromSec: number, toSec: number) => number {
  /* THE CLAIM AND THE THESIS ARE TWO QUESTIONS, NOT ONE QUERY (F-96).
   *
   * Until run 9 the two term lists were folded into one query and a minute
   * scored by the share of the UNION's weight it spoke. That is the wrong
   * question and, live, it was asked with the wrong weights:
   *
   *   - the wrong weights: the idf the window search hands over
   *     (`TranscriptTextCandidate.idf`) holds the CLAIM's terms and nothing
   *     else, because the index computed it for the claim's search.
   *     `claimTermWeigher` weighs a term it has no idf for at 1 — the weight
   *     of the claim's RAREST word — so every word of the act's thesis
   *     (twenty to forty words, live; the offline measurement in F-94 used the
   *     slot title, three to five) entered the query at full weight. Measured
   *     on the run-9 candidate's six minted clips: with the claim alone the
   *     extension gives 195 / 72 / 148 / 188 / 319 / 93 s; with a thesis-length
   *     sentence folded in at weight 1 it gives 150 / 72 / 371 / 188 / 169 /
   *     78 s and reproduces the live rows exactly where the stand-in thesis
   *     happens to share the tape's words — the clip's length depended on
   *     whether the guest used the thesis's abstract vocabulary, which is
   *     noise.
   *   - the wrong question: a minute that CONTINUES the claim's answer
   *     speaks none of the thesis, and under a union share the thesis's
   *     weight in the denominator halves that minute's score — the answer
   *     is penalised for not being the thesis. The intent (Q-01: "an answer
   *     that moves from the claim to the thesis's subject is still
   *     relevant") is a disjunction: the minute is about the claim, OR it
   *     is about the thesis.
   *
   * So each list is scored as its own idf-weighted share, with its own
   * rarest word as the unit, and the minute's score is the LARGER of the
   * two. The claim's half is exactly the share F-94 measured the floor on
   * (the slot title's three words moved it by little), so `RELEVANCE_FLOOR`
   * stands. The thesis's half needs the thesis's OWN idf to mean anything —
   * without it every thesis word weighs one and a minute saying two of
   * twenty passes — so `sourceBeats.ts` asks the text index for the thesis
   * once per act and merges that idf into the map handed here; a caller
   * with no index (the tests) gets the unweighted thesis share, which is
   * what the fixtures were written against.
   */
  const claim = dedupe(options.claimTerms);
  const thesis = dedupe(options.thesisTerms ?? []);
  const shareOf = makeShare(index, claim, options.idf);
  const thesisShareOf = thesis.length > 0 ? makeShare(index, thesis, options.idf) : null;
  if (!shareOf && !thesisShareOf) return () => 0;
  return (fromSec: number, toSec: number): number => {
    const a = shareOf ? shareOf(fromSec, toSec) : 0;
    const b = thesisShareOf ? thesisShareOf(fromSec, toSec) : 0;
    return Math.max(a, b);
  };
}

function dedupe(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** One term list's idf-weighted share of itself spoken inside a stretch —
 * `selectTapeWindow`'s `weightedShare`, on a stretch of tape instead of a cue
 * run. `null` when the list is empty or weighs nothing. */
function makeShare(index: CueIndex, query: readonly string[], idf: ReadonlyMap<string, number> | undefined): ((fromSec: number, toSec: number) => number) | null {
  if (query.length === 0) return null;
  const weightOf = claimTermWeigher(query, idf);
  let total = 0;
  for (const t of query) total += weightOf(t);
  if (!(total > 0)) return null;
  const wanted = new Set(query);
  return (fromSec: number, toSec: number): number => {
    const matched = new Set<string>();
    for (let k = 0; k < index.cues.length; k++) {
      const cue = index.cues[k]!;
      if (cue.end_sec <= fromSec) continue;
      if (cue.start_sec >= toSec) break;
      const overlap = Math.min(cue.end_sec, toSec) - Math.max(cue.start_sec, fromSec);
      const needed = Math.min((cue.end_sec - cue.start_sec) / 2, CUE_OVERLAP_MIN_SEC);
      if (overlap < needed) continue;
      for (const term of index.terms[k]!) if (wanted.has(term)) matched.add(term);
    }
    let score = 0;
    for (const t of matched) score += weightOf(t);
    return score / total;
  };
}

/** The text spoken between two timestamps — a convenience for the measurement
 * script, which prints the first and last sentence of a cut. */
export function extentText(cues: TranscriptCue[], startSec: number, endSec: number): string {
  const parts: string[] = [];
  for (const cue of cues) {
    if (cue.end_sec <= startSec) continue;
    if (cue.start_sec >= endSec) continue;
    parts.push(cue.text);
  }
  return parts.join(" ");
}

/** `tokenizeForSourcing`, deduplicated in order — what the claim and thesis are
 * turned into before they reach `extendToThought`. */
export function thoughtTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokenizeForSourcing(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/* --------------------------------------------------------------- boundaries */

/** Per-cue boundary facts, computed once. `breakBefore[k]`: the gap before cue
 * `k` is a hole in the tape (`TAPE_CUE_GAP_MAX_SEC`), a hard edge in both
 * directions. `turnBefore[k]`: cue `k` starts a new speaker's turn.
 * `sentenceBefore[k]`: cue `k - 1` ends a sentence and a pause follows, or it
 * was a paragraph-sized cue. Index 0 carries none of the three: the
 * transcript's own edge is handled by the `edges` flag of `boundaryKindAt`. */
interface CueShape {
  n: number;
  hasTurns: boolean;
  starts: number[];
  ends: number[];
  breakBefore: boolean[];
  turnBefore: boolean[];
  sentenceBefore: boolean[];
}

function cueShape(index: CueIndex): CueShape {
  const n = index.cues.length;
  const hasTurns = index.cues.some((c) => typeof c.speaker === "string" && c.speaker.length > 0);
  const breakBefore = new Array<boolean>(n).fill(false);
  const turnBefore = new Array<boolean>(n).fill(false);
  const sentenceBefore = new Array<boolean>(n).fill(false);
  for (let k = 1; k < n; k++) {
    const prev = index.cues[k - 1]!;
    const cue = index.cues[k]!;
    const gap = cue.start_sec - prev.end_sec;
    breakBefore[k] = gap > TAPE_CUE_GAP_MAX_SEC;
    const a = prev.speaker ?? null;
    const b = cue.speaker ?? null;
    turnBefore[k] = hasTurns && a !== null && b !== null && a !== b;
    const paragraph = prev.end_sec - prev.start_sec >= PARAGRAPH_CUE_SEC;
    sentenceBefore[k] = SENTENCE_END.test(prev.text.trim()) && (gap >= THOUGHT_PAUSE_SEC || paragraph);
  }
  return {
    n,
    hasTurns,
    starts: index.cues.map((c) => c.start_sec),
    ends: index.cues.map((c) => c.end_sec),
    breakBefore,
    turnBefore,
    sentenceBefore
  };
}

/** The kind of boundary at the START of cue `k` (the edge before it). A hole in
 * the tape counts as a sentence boundary: the cut cannot cross it, but it is
 * not a speaker's turn. The transcript's own first cue is a boundary only when
 * `edges` says so — the relevance walk may land there; the nearest-boundary
 * search may not. */
function boundaryKindAt(shape: CueShape, k: number, edges: boolean): TapeBoundary | null {
  if (k <= 0) return edges ? (shape.hasTurns ? "turn" : "sentence") : null;
  if (shape.turnBefore[k]) return "turn";
  if (shape.breakBefore[k] || shape.sentenceBefore[k]) return "sentence";
  return null;
}

/** The kind of boundary at the END of cue `k` (the edge after it). */
function boundaryKindAfter(shape: CueShape, k: number, edges: boolean): TapeBoundary | null {
  if (k + 1 >= shape.n) return edges ? (shape.hasTurns ? "turn" : "sentence") : null;
  return boundaryKindAt(shape, k + 1, edges);
}

interface BoundaryHit {
  cue: number;
  kind: TapeBoundary;
}

/** Walking back from `first`, the nearest cue that starts a turn (with turns)
 * or a sentence, whose start is at or after `floorSec`. With turns, a sentence
 * boundary is the fallback when no turn starts inside the span. */
function nearestStartBoundary(shape: CueShape, first: number, floorSec: number): BoundaryHit | null {
  let sentence: BoundaryHit | null = null;
  for (let k = first; k >= 0 && shape.starts[k]! >= floorSec; k--) {
    const kind = boundaryKindAt(shape, k, k === first);
    if (kind === "turn") return { cue: k, kind };
    if (kind === "sentence" && !sentence) sentence = { cue: k, kind };
    if (!shape.hasTurns && sentence) return sentence;
    /* A hole in the tape ends the search on its far side. */
    if (shape.breakBefore[k]) break;
  }
  return sentence;
}

/** Walking forward from `last`, the nearest cue that ends a turn or a sentence,
 * whose end is at or before `ceilingSec`. */
function nearestEndBoundary(shape: CueShape, last: number, ceilingSec: number): BoundaryHit | null {
  let sentence: BoundaryHit | null = null;
  for (let k = last; k < shape.n && shape.ends[k]! <= ceilingSec; k++) {
    const kind = boundaryKindAfter(shape, k, k === last);
    if (kind === "turn") return { cue: k, kind };
    if (kind === "sentence" && !sentence) sentence = { cue: k, kind };
    if (!shape.hasTurns && sentence) return sentence;
    if (k + 1 < shape.n && shape.breakBefore[k + 1]) break;
  }
  return sentence;
}

/** The FIRST boundary of any kind at or after `reach`, walking toward `first`
 * — where the start backs up to once relevance has said how far back the tape
 * is about the claim. Any kind, nearest the reach: relevance decided how much
 * tape is kept, and the boundary only decides where inside it the cut falls,
 * so a sentence boundary a few seconds in beats a turn boundary two minutes
 * later. The transcript's own edge counts here: the reach has already been
 * stepped back over any cues that say nothing of the claim, so a clip that
 * runs to the very start or end of the recording ends on the last thing said
 * about it, not on the file's silence. (This is the step whose removal the
 * tests name as the mutation: with it gone the start sits wherever the
 * sixty-second grid stopped, mid-word.) */
function firstStartBoundaryFrom(shape: CueShape, reach: number, first: number): BoundaryHit | null {
  for (let k = reach; k <= first; k++) {
    const kind = boundaryKindAt(shape, k, true);
    if (kind) return { cue: k, kind };
  }
  return null;
}

/** The LAST boundary of any kind at or before `reach`, walking back toward
 * `last` — the mirror of the above. */
function lastEndBoundaryUpTo(shape: CueShape, reach: number, last: number): BoundaryHit | null {
  for (let k = reach; k >= last; k--) {
    const kind = boundaryKindAfter(shape, k, true);
    if (kind) return { cue: k, kind };
  }
  return null;
}

/** When cue `k` ends a short question from a different speaker than cue `k + 1`
 * begins with, the first cue of that question; else `null`. The question is
 * the host's LAST thought before the answer — back to the start of the turn or
 * to the last sentence boundary inside it, whichever is nearer — so a host who
 * summarised for a minute and then asked is quoted for the asking only. */
function questionEndingAt(shape: CueShape, index: CueIndex, k: number): number | null {
  if (k < 0 || !shape.turnBefore[k + 1]) return null;
  if (!QUESTION_END.test(index.cues[k]!.text.trim())) return null;
  let start = k;
  while (start > 0 && !shape.turnBefore[start] && !shape.breakBefore[start] && !shape.sentenceBefore[start]) start -= 1;
  if (index.cues[k]!.end_sec - index.cues[start]!.start_sec > QUESTION_TURN_MAX_SEC) return null;
  return start;
}

/** The first hole in the tape inside `(fromSec, toSec]`, as the start of the
 * cue after it — `null` when the stretch is continuous. */
function firstHoleInside(shape: CueShape, fromSec: number, toSec: number): number | null {
  for (let k = 1; k < shape.n; k++) {
    const start = shape.starts[k]!;
    if (start <= fromSec) continue;
    if (start > toSec) break;
    if (shape.breakBefore[k]) return start;
  }
  return null;
}

/** The last hole in the tape inside `[fromSec, toSec)`, likewise. */
function lastHoleInside(shape: CueShape, fromSec: number, toSec: number): number | null {
  for (let k = shape.n - 1; k >= 1; k--) {
    const start = shape.starts[k]!;
    if (start >= toSec) continue;
    if (start < fromSec) break;
    if (shape.breakBefore[k]) return start;
  }
  return null;
}

/** Whether any cue is spoken inside `(fromSec, toSec)` — false past either end
 * of the transcript. */
function speechBetween(index: CueIndex, fromSec: number, toSec: number): boolean {
  for (const cue of index.cues) {
    if (cue.end_sec <= fromSec) continue;
    if (cue.start_sec >= toSec) break;
    return true;
  }
  return false;
}

/** The query's terms as a set — what a cue must share to be the reach. */
function seen(options: ExtendToThoughtOptions): Set<string> {
  return new Set([...options.claimTerms, ...(options.thesisTerms ?? [])]);
}

/** Whether at least `CUE_OVERLAP_MIN_SEC` (or half) of cue `k` lies inside
 * `[fromSec, toSec]` — the same rule `relevanceScorer` counts cues by, so the
 * reach is a cue the walk actually scored. */
function counted(index: CueIndex, k: number, fromSec: number, toSec: number): boolean {
  const cue = index.cues[k]!;
  const overlap = Math.min(cue.end_sec, toSec) - Math.max(cue.start_sec, fromSec);
  return overlap >= Math.min((cue.end_sec - cue.start_sec) / 2, CUE_OVERLAP_MIN_SEC);
}

/**
 * THE REACH, AS A CUE. The walk stopped at `edgeSec`; the reach is the LAST cue
 * the passing windows counted (it may straddle the edge), stepped back over
 * any trailing cues that say none of the query's words — a minute passes on
 * the strength of its first sentences, and its last one can be the host's
 * segue. The start's mirror is `firstCueCountedAfter`. Never past `last`.
 */
function lastCueCountedBefore(index: CueIndex, edgeSec: number, last: number, query: Set<string>): number | null {
  let k = index.cues.length - 1;
  while (k > last && !(index.cues[k]!.start_sec < edgeSec && counted(index, k, -Infinity, edgeSec))) k--;
  while (k > last && !sharesAny(index, k, query)) k--;
  return k > last ? k : null;
}

function firstCueCountedAfter(index: CueIndex, edgeSec: number, first: number, query: Set<string>): number | null {
  let k = 0;
  while (k < first && !(index.cues[k]!.end_sec > edgeSec && counted(index, k, edgeSec, Infinity))) k++;
  while (k < first && !sharesAny(index, k, query)) k++;
  return k < first ? k : null;
}

function sharesAny(index: CueIndex, k: number, query: Set<string>): boolean {
  for (const term of index.terms[k]!) if (query.has(term)) return true;
  return false;
}
