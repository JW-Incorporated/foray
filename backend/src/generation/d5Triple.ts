/**
 * D5's FIRST CLAUSE, IN ONE PLACE (F-80).
 *
 * `tools/foray/check-forays.mjs` refuses a Foray when "three consecutive
 * durations [are] within +/-20 % of each other" — its `d5Triples`, pairwise
 * reading: a triple is uniform when `max / min <= 1 + D5_TOLERANCE`. Run 5
 * (2026-09-11) narrated a 25-segment Foray end to end and was refused at
 * finalize on exactly that clause — 152.0 / 142.2 / 169.4 s, max/min 1.191 —
 * because sourcing asked it as a PREFERENCE (#571's `d5-uniform`) and took the
 * uniform cut when nothing else was to hand. #620 keeps the clause strict on a
 * partial candidate too, so a uniform triple placed anywhere ends the run.
 *
 * THIS MODULE IS THE ARITHMETIC, MIRRORED EXACTLY. `check-forays.mjs` is a
 * plain-JS build script Vitest cannot load on every checkout (its loader
 * percent-encodes a space in the checkout path — see `RunPipelineDeps.finalize`),
 * so the checker's expression is copied here character for character rather
 * than imported, and `test/d5Triple.test.ts` runs the checker's own `d5Triples`
 * in a Node subprocess against the same fixtures and asserts the two agree
 * triple by triple. A change to either side that the other does not follow is
 * a red test, which is the only form of "cannot disagree" available across
 * that loader boundary.
 *
 * "CONSECUTIVE" MEANS CONSECUTIVE SEGMENT ITEMS IN PLAY ORDER. The checker
 * builds `durations` from the resolvable `segment` items only — narration and
 * jingles are not cuts and do not break a run — and sourcing's
 * `placedDurations` ledger is the same sequence (beats are resolved in play
 * order; a narrated beat adds nothing to it). So the triple a placement can
 * create is always the last two placed durations plus the candidate's, and
 * that is the only triple `placementEscapesD5Triple` asks about: every earlier
 * triple was cleared when its own third member was placed.
 */

/** D5, first clause: three consecutive durations within +/- this of each other
 * are a uniformity violation. `check-forays.mjs`'s `D5_TOLERANCE`. */
export const D5_TOLERANCE = 0.2;

/** One uniform triple, in the checker's own row shape: where it starts, the
 * three durations, and the max/min ratio that put it inside the band. */
export interface D5TripleHit {
  index: number;
  durations: [number, number, number];
  worst: number;
}

/**
 * Whether three consecutive durations are within D5's tolerance of each other,
 * pairwise — `check-forays.mjs`'s test, verbatim: it `continue`s past a triple
 * whose `max / min > 1 + D5_TOLERANCE` and reports every other one. Written as
 * the negation of that `continue` rather than as `<=` so the two agree on every
 * input, including a zero duration (0 / 0 is NaN, and NaN clears no `>` test,
 * so the checker reports a triple of zeros as uniform — this does too).
 */
export function d5TripleIsUniform(a: number, b: number, c: number): boolean {
  const ratio = Math.max(a, b, c) / Math.min(a, b, c);
  return !(ratio > 1 + D5_TOLERANCE);
}

/**
 * Every uniform consecutive triple in `durations`, pairwise reading — the same
 * rows, in the same order, as `d5Triples(durations, { reading: "pairwise" })`
 * in `check-forays.mjs`. The spread pass in `sourceBeats.ts` counts these to
 * make sure a re-cut never trades D5's second clause for its first.
 */
export function d5Triples(durations: readonly number[]): D5TripleHit[] {
  const hits: D5TripleHit[] = [];
  for (let i = 0; i + 2 < durations.length; i++) {
    const a = durations[i]!;
    const b = durations[i + 1]!;
    const c = durations[i + 2]!;
    if (!d5TripleIsUniform(a, b, c)) continue;
    hits.push({ index: i, durations: [a, b, c], worst: Math.max(a, b, c) / Math.min(a, b, c) });
  }
  return hits;
}

/**
 * Whether placing a segment of `durationSec` after `placed` (in play order)
 * leaves the last three durations OUTSIDE D5's band — the placement-time form
 * of the clause. With fewer than two segments placed there is no triple to
 * make, so every length escapes.
 */
export function placementEscapesD5Triple(placed: readonly number[], durationSec: number): boolean {
  if (placed.length < 2) return true;
  return !d5TripleIsUniform(placed[placed.length - 2]!, placed[placed.length - 1]!, durationSec);
}

/**
 * How far a candidate length sits from the NEARER of the two durations before
 * it, on the ratio scale the band is defined on: `|ln(d / p)|`, minimised over
 * the two. Larger is farther. This is what "the rung farthest from the previous
 * two" means when `sourceBeats.ts` has to choose between several cuts of one
 * window that all escape the band — the one that escapes by the widest margin
 * is the one a later re-cut (`liftDurationSpread`) is least likely to pull back
 * inside it. Zero when there is nothing placed yet.
 */
export function d5DistanceFromPrevious(placed: readonly number[], durationSec: number): number {
  const previous = placed.slice(-2).filter((p) => p > 0);
  if (previous.length === 0 || !(durationSec > 0)) return 0;
  return Math.min(...previous.map((p) => Math.abs(Math.log(durationSec / p))));
}
