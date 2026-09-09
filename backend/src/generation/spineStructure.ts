import { DURATION_SHAPE_BUDGETS, SHAPE_TOLERANCE, countActs, countBeats, countSlots, type Spine } from "../types/spine";

/**
 * The cheap structural gate between §4.3 and §4.4 (generation run 2026-09-09,
 * finding F-13).
 *
 * WHAT F-13 SAYS. "§4.3 flows straight into §4.4 deepening with no validation
 * of the spine's counts before three more model calls are spent — a spine
 * outside 28-36 beats or below the 30% exploration floor would only be caught
 * at finalize, after every downstream stage has paid for it." Run 1's spine
 * happened to land at 3 acts / 6 slots / 31 beats and the gap never fired; the
 * cost of it firing is one Opus call plus 3 Sonnet deepen calls plus a full
 * sourcing and narration pass, discovered at §4.9.
 *
 * WHY IT IS A SEPARATE MODULE FROM `validateSpine`. `types/spine.ts` already
 * validates counts, claim shape and the exploration floor, and `buildSpine`
 * already runs it — that half of F-13 was closed before the finding was
 * written and this module does not re-litigate it (the count check below
 * re-states it so a direct caller gets one complete verdict from one call, and
 * uses the SAME budgets and the same `SHAPE_TOLERANCE`, so the two can never
 * disagree). What is genuinely missing is the set of defects a per-beat schema
 * cannot see because they are relationships BETWEEN beats and between a beat
 * and its own sentence:
 *
 *   - the same claim written into two different acts, which §4.4 will happily
 *     deepen twice and §4.7 will write two nearly identical pages for;
 *   - a beat carrying a paragraph instead of a claim, which becomes a page
 *     whose purpose the writer cannot accomplish (F-41) and whose sentences it
 *     mines for quotes (F-46);
 *   - a beat carrying two claims in two sentences, which produces a page that
 *     sources one of them and asserts the other;
 *   - an act with no start or end state, which is what §4.4's deepening and
 *     §4.8's continuity smoothing both read to know what the act must move the
 *     listener from and to.
 *
 * FAIL, DO NOT WARN. Every one of these is cheaper to fix by re-asking for a
 * spine (one Opus call) than to carry through four stages. That is the whole
 * argument of F-13 and this module holds to it.
 */

export type SpineStructureIssueCode =
  | "act-count-out-of-budget"
  | "slot-count-out-of-budget"
  | "beat-count-out-of-budget"
  | "duplicate-beat-claim"
  | "beat-claim-too-long"
  | "beat-claim-not-single-sentence"
  | "act-missing-start-state"
  | "act-missing-end-state";

export interface SpineStructureIssue {
  code: SpineStructureIssueCode;
  message: string;
}

export class InvalidSpineStructureError extends Error {
  constructor(public readonly issues: SpineStructureIssue[]) {
    super(
      `Spine failed the structural check before deepening (F-13), so no deepen call was made: ${issues
        .map((i) => i.message)
        .join("; ")}`
    );
    this.name = "InvalidSpineStructureError";
  }
}

/**
 * §4.3's own bar for a claim, as a length: "Charcoal briquettes were a Ford
 * Motor Company waste-disposal scheme" is 9 words. 60 is deliberately far
 * above anything a well-formed claim needs — it is a check for a PARAGRAPH
 * that has been pasted into a beat, not a style rule, and rejecting a real
 * spine is much more expensive than letting a wordy claim through (the same
 * accept-biased trade-off `isClaimShaped` documents at length).
 */
export const MAX_BEAT_CLAIM_WORDS = 60;

/** Abbreviations whose full stop is not a sentence end. Small and explicitly a
 * supplement: every entry here is a word that would otherwise make a perfectly
 * ordinary single-sentence claim look like two. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "jr",
  "sr",
  "vs",
  "etc",
  "no",
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "fig",
  "approx",
  "est",
  "ca",
  "vol",
  "op",
  "cf"
]);

/**
 * Counts sentences in a claim, biased — like every other heuristic in this
 * pipeline — toward ACCEPTING.
 *
 * A boundary is a `.`/`!`/`?` followed by whitespace and a capital or a digit.
 * Two things are excused, because both appear in genuine one-sentence claims
 * about real subjects: a full stop after a known abbreviation ("No. 3 reactor",
 * "Hyatt Regency vs. Havens"), and a full stop after a single letter, which is
 * how initials and dotted acronyms are written ("U.S. Steel", "W. E. B.").
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  let sentences = 1;
  const boundary = /[.!?]["'”’)\]]?\s+(?=[A-Z0-9])/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(trimmed)) !== null) {
    const before = trimmed.slice(0, match.index);
    const lastWord = (before.match(/[A-Za-z]+$/)?.[0] ?? "").toLowerCase();
    if (ABBREVIATIONS.has(lastWord)) continue;
    if (lastWord.length === 1) continue; // "U.S.", "W. E. B."
    sentences += 1;
  }
  return sentences;
}

/** Normalised claim text, for the cross-act duplicate check: punctuation and
 * casing differ between two acts' restatements of the same claim far more
 * often than the words do. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function withinTolerance(actual: number, [min, max]: [number, number]): boolean {
  return actual >= min * (1 - SHAPE_TOLERANCE) && actual <= max * (1 + SHAPE_TOLERANCE);
}

/** Every structural defect in one pass, so a re-ask can fix them all at once
 * rather than one Opus call per issue. */
export function checkSpineStructure(spine: Spine): SpineStructureIssue[] {
  const issues: SpineStructureIssue[] = [];
  const budget = DURATION_SHAPE_BUDGETS[spine.duration];

  const acts = countActs(spine);
  const slots = countSlots(spine);
  const beats = countBeats(spine);

  if (!withinTolerance(acts, budget.acts)) {
    issues.push({
      code: "act-count-out-of-budget",
      message: `${acts} acts is outside the ${spine.duration} tier's ${budget.acts[0]}-${budget.acts[1]} range`
    });
  }
  if (!withinTolerance(slots, budget.slots)) {
    issues.push({
      code: "slot-count-out-of-budget",
      message: `${slots} slots is outside the ${spine.duration} tier's ${budget.slots[0]}-${budget.slots[1]} range`
    });
  }
  if (!withinTolerance(beats, budget.items)) {
    issues.push({
      code: "beat-count-out-of-budget",
      message: `${beats} beats is outside the ${spine.duration} tier's ${budget.items[0]}-${budget.items[1]} range`
    });
  }

  /* Where each normalised claim was first seen, so the message can name BOTH
     places — "duplicated" with only one location is not actionable. */
  const firstSeen = new Map<string, string>();

  for (let a = 0; a < spine.acts.length; a++) {
    const act = spine.acts[a]!;
    const actLabel = `act ${a + 1} ("${act.title}")`;

    if (act.startState.trim().length === 0) {
      issues.push({ code: "act-missing-start-state", message: `${actLabel} has no startState` });
    }
    if (act.endState.trim().length === 0) {
      issues.push({ code: "act-missing-end-state", message: `${actLabel} has no endState` });
    }

    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        const where = `${actLabel}, slot "${slot.title}"`;
        const words = beat.claim.trim().split(/\s+/).filter(Boolean).length;
        if (words > MAX_BEAT_CLAIM_WORDS) {
          issues.push({
            code: "beat-claim-too-long",
            message: `${where}: beat claim is ${words} words, over the ${MAX_BEAT_CLAIM_WORDS}-word limit — "${beat.claim.slice(0, 80)}..."`
          });
        }
        const sentences = countSentences(beat.claim);
        if (sentences > 1) {
          issues.push({
            code: "beat-claim-not-single-sentence",
            message: `${where}: beat claim is ${sentences} sentences, must be one — "${beat.claim.slice(0, 120)}"`
          });
        }

        const norm = normalizeClaim(beat.claim);
        if (norm.length === 0) continue;
        const seenAt = firstSeen.get(norm);
        if (seenAt !== undefined) {
          issues.push({
            code: "duplicate-beat-claim",
            message: `beat claim appears twice — in ${seenAt} and again in ${where}: "${beat.claim.slice(0, 100)}"`
          });
        } else {
          firstSeen.set(norm, where);
        }
      }
    }
  }

  return issues;
}

/** Throws `InvalidSpineStructureError` when anything is wrong; returns
 * otherwise. The throwing wrapper is what `buildSpine` calls — F-13's whole
 * point is that this stage stops the run, not that it reports. */
export function assertSpineStructure(spine: Spine): void {
  const issues = checkSpineStructure(spine);
  if (issues.length > 0) throw new InvalidSpineStructureError(issues);
}
