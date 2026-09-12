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
 * AND IT IS A MEASUREMENT, NOT A VETO (F-102, 2026-09-12). Q-01 and Q-04 are
 * two cards of one series that changed the same quantity from opposite
 * directions, and for a day the pair clause won: Q-01 said "if there's a half
 * hour of relevant content then let it ride" and Q-04's pair clause was wired
 * into `placementAllows` as a hard refusal, so sourcing's only two answers to a
 * collision were to SHORTEN the clip (`d5EscapeBelow`, deleted with this
 * paragraph) or to throw the beat's tape away. Measured on the real archive
 * that day: four seeded beats refused at `d5-pair` and nine clips placed where
 * the suite's floor asks for ten. Both answers make the Foray play LESS tape,
 * which is the one thing the founder's instruction forbids.
 *
 * The rule is now asked of every placement and ANSWERED IN THE REPORT, never in
 * the placement: `check-forays.mjs` counts each Foray's uniform pairs and its
 * interquartile spread and gates on neither, the relevance row marks the clip
 * that made a pair, and nothing is shortened or refused. Why variety is not
 * pursued by ORDERING either — the one lever that would cost no tape — is
 * argued at `placementAllows` in `sourceBeats.ts`: every order sourcing is free
 * to change is ranked by how well the tape carries the claim, and buying
 * rhythm with relevance is buying listening variety with veracity, which is
 * exactly the trade Q-04 says this rule must not make.
 *
 * WHY THE BAND IS STILL WORTH MEASURING. Under the old ladder two equal lengths
 * meant the ladder had put them there, and the number counted a defect. Under
 * Q-01 a clip's length is where a thought ended, so a uniform pair is a
 * coincidence of the tape — and a run of them is still something a listener
 * hears and an editor may want to know about. The count answers "how uniform is
 * this Foray's rhythm?"; it no longer answers "may this clip play?".
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
 * leaves the last two durations OUTSIDE D5's band. With nothing placed there is
 * no pair to make, so every length escapes.
 *
 * THIS IS A QUESTION, NOT A PERMISSION (F-102). It used to be the
 * placement-time form of a gate; `placementAllows` no longer consults it, and
 * the one caller left asks it to MARK the clip that made a pair on the
 * relevance row. A caller that treats `false` as a refusal has reintroduced the
 * defect this function's own header describes — `sourceBeats.test.ts`'s F-102
 * cases are the guard.
 */
export function placementEscapesD5Pair(placed: readonly number[], durationSec: number): boolean {
  if (placed.length < 1) return true;
  return !d5PairIsUniform(placed[placed.length - 1]!, durationSec);
}
