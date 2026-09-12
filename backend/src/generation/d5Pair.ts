/**
 * D5, RESTATED FOR LISTENING (Q-04, docs/curation/listening-quality-plan.md):
 * NO TWO CONSECUTIVE CLIPS WITHIN 20 % OF THE SAME LENGTH.
 *
 * WHAT IT REPLACES. Until Q-04 the D-tier length rules were a mean floor (D3,
 * 90 s), a uniform-triple clause (D5, three consecutive durations within
 * +/-20 % of each other — this file's predecessor, `d5Triple.ts`, F-80) and an
 * interquartile floor (D5, 45 s) that sourcing served with a length LADDER
 * (105/165/135/210 s, F-73) and a post-placement re-cut pass. Every one of
 * them was a rule about the lengths a window was CUT to; none asked where a
 * thought starts or ends. With Q-01 a clip's length is what the tape's own
 * relevance measures — a minute to half an hour — so a ladder has nothing to
 * ask for, a mean floor is served per clip by the 60 s floor, and an
 * interquartile range over clips that vary by an order of magnitude is met by
 * construction. What is left of D5's listening purpose — a Foray must not sound
 * metronomic — is the adjacent pair: two clips in a row of the same length is
 * the pattern a listener hears; a triple was a looser statement of the same
 * thing.
 *
 * THIS MODULE IS THE ARITHMETIC, MIRRORED EXACTLY. `tools/foray/check-forays.mjs`
 * is the authority on the rule and a plain-JS build script Vitest cannot load
 * on every checkout (its loader percent-encodes a space in the checkout path —
 * see `RunPipelineDeps.finalize`), so the checker's expression is copied here
 * rather than imported, and `test/d5Pair.test.ts` runs the checker's own
 * `d5UniformPairs` in a Node subprocess against the same fixtures and asserts
 * the two agree pair by pair. A change to either side the other does not
 * follow is a red test — the only form of "cannot disagree" available across
 * that loader boundary.
 *
 * "CONSECUTIVE" MEANS CONSECUTIVE SEGMENT ITEMS IN PLAY ORDER. The checker
 * builds `durations` from the resolvable `segment` items only — narration and
 * jingles are not cuts and do not break a run — and sourcing's
 * `placedDurations` ledger is the same sequence (beats are resolved in play
 * order; a narrated beat adds nothing to it). So the pair a placement can
 * create is the last placed duration plus the candidate's, and that is the only
 * pair `placementEscapesD5Pair` asks about.
 */

/** D5: two consecutive durations within +/- this of each other are a
 * uniformity violation. `check-forays.mjs`'s `D5_TOLERANCE`, unchanged from
 * the triple clause — the band is the same, the run length is two. */
export const D5_TOLERANCE = 0.2;

/** One uniform pair, in the checker's own row shape: where it starts, the two
 * durations, and the max/min ratio that put it inside the band. */
export interface D5PairHit {
  index: number;
  durations: [number, number];
  ratio: number;
}

/**
 * Whether two consecutive durations are within D5's tolerance of each other —
 * `check-forays.mjs`'s test, verbatim: it `continue`s past a pair whose
 * `max / min > 1 + D5_TOLERANCE` and reports every other one. Written as the
 * negation of that `continue` rather than as `<=` so the two agree on every
 * input, including a zero duration (0 / 0 is NaN, and NaN clears no `>` test,
 * so the checker reports a pair of zeros as uniform — this does too).
 */
export function d5PairIsUniform(a: number, b: number): boolean {
  const ratio = Math.max(a, b) / Math.min(a, b);
  return !(ratio > 1 + D5_TOLERANCE);
}

/**
 * Every uniform consecutive pair in `durations` — the same rows, in the same
 * order, as `d5UniformPairs(durations)` in `check-forays.mjs`.
 */
export function d5Pairs(durations: readonly number[]): D5PairHit[] {
  const hits: D5PairHit[] = [];
  for (let i = 0; i + 1 < durations.length; i++) {
    const a = durations[i]!;
    const b = durations[i + 1]!;
    if (!d5PairIsUniform(a, b)) continue;
    hits.push({ index: i, durations: [a, b], ratio: Math.max(a, b) / Math.min(a, b) });
  }
  return hits;
}

/**
 * Whether placing a segment of `durationSec` after `placed` (in play order)
 * leaves the last two durations OUTSIDE D5's band — the placement-time form of
 * the clause. With nothing placed there is no pair to make, so every length
 * escapes.
 */
export function placementEscapesD5Pair(placed: readonly number[], durationSec: number): boolean {
  if (placed.length < 1) return true;
  return !d5PairIsUniform(placed[placed.length - 1]!, durationSec);
}

/**
 * The longest length under the previous duration that escapes the band, or
 * `null` when there is no previous duration. What `sourceBeats.ts` asks the
 * thought extension to stop at when the full extent would be a uniform pair:
 * the clip is cut back to a boundary short of `previous / (1 + D5_TOLERANCE)`,
 * which is the nearest escape that keeps every second of tape it can. (The
 * other escape — longer than `previous * (1 + D5_TOLERANCE)` — is not a length
 * a clip can be asked for: the extent is already as long as relevance allows.)
 */
export function d5EscapeBelow(placed: readonly number[]): number | null {
  const previous = placed[placed.length - 1];
  if (previous === undefined || !(previous > 0)) return null;
  /* Strictly under the band's edge: at exactly previous / 1.2 the ratio is 1.2,
     which is NOT greater than 1 + 0.2 and so still uniform. */
  return previous / (1 + D5_TOLERANCE) - 0.001;
}
