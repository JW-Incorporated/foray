import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage, hasDeclarativeSentence, quoteWords } from "../types/narration";
import type {
  ActVerifyRequest,
  ActVerifyResult,
  BeatVerdict,
  NarrationBuildContext,
  NarrationVerifierBuilder,
  SeamVerdict
} from "./NarrationVerifierBuilder";

/**
 * Deterministic fake narration verifier, used whenever ANTHROPIC_API_KEY
 * is absent (env.anthropicDryRun). A DISTINCT CLASS from
 * `StubNarrationWriterBuilder` — never share a class or instance between
 * the two roles, per §4.7 rule 2 / §5's topology table.
 *
 * WHAT A STUB CAN HONESTLY ANSWER, AND WHAT IT CANNOT. The questions the
 * real verifier is asked (does the act's prose carry this beat's claim;
 * does each statement rest on a source; is a genuinely contested point
 * handled) are reading-comprehension questions — a model's job, and faking
 * them with a token overlap is what run 1's stub did and what made the
 * dry-run path a weaker check than production rather than the same one. So
 * this class answers each question with the strongest STRUCTURAL signal
 * available and says nothing it cannot support:
 *
 *   - carried: a beat is carried when some seam's script shares a content
 *     word with its claim (F-41's "did the prose drop the subject
 *     entirely", not "did it paraphrase well"). A claim with no content
 *     words is not evidence of anything and passes. A page that
 *     CONTRADICTS its beat from the documents passes here, which is F-50's
 *     rule and the outcome run 2 needed and did not get.
 *   - claimsSupported: a source attached to no claim at all fails, and so
 *     does a declarative seam that rests on nothing (F-36/F-37,
 *     act-scoped). The harder half — does this quote support this claim —
 *     is already bounded by `writeNarration.ts`, which proved in code that
 *     the quote is a verbatim span of a document the pipeline holds before
 *     this is ever called.
 *   - contestedHandled: a source marked contested whose script never says
 *     so fails — the one rule a string can actually decide.
 *
 * ONE METHOD SINCE F-100. This class also faked `verifySlot` (the same
 * questions, per page) and F-88's `verifySynthesis`; Q-03/F-97 folded both
 * into `verifyAct`, and they are deleted with the path they served.
 */
export class StubNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  /**
   * Q-03: the per-beat question, answered with the structural signal
   * above — a beat is carried when some
   * seam's script shares a content word with its claim (F-41's "did the
   * prose drop the subject entirely"), and a beat no seam is about is not,
   * with a note naming the seam it was positioned in. Per seam, the two
   * structural checks `verdictFor` makes (a source with no claim; a
   * contested source the script never flags). Whether the prose FAIRLY
   * carries a beat is a reading judgement only the real verifier makes.
   */
  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });
    return actVerdictFor(request);
  }
}

/** Exported for the act tests. F-97: what a seam RESTS ON is answered
 * here, deterministically — its own selected claims when it selected any;
 * else, for a declarative bridge, the windows of the clips on either side
 * of it (the act's sources include every held window as `c<n>`); else
 * nothing. A declarative seam that rests on nothing is refused, which is
 * F-36/F-37 act-scoped and what the real verifier is asked to do. */
export function actVerdictFor(request: ActVerifyRequest): ActVerifyResult {
  const sourceIds = new Set(request.sources.map((s) => s.id));
  const restOf = (seam: ActVerifyRequest["seams"][number]): string[] => {
    if (seam.selected.length > 0) return seam.selected;
    if (!hasDeclarativeSentence(seam.script)) return [];
    return [seam.follows, seam.introduces].filter((id): id is string => id !== undefined && sourceIds.has(id));
  };
  const beats: BeatVerdict[] = request.beats.map((beat) => {
    const carrier = request.seams.find((seam) => scriptIsAboutPurpose(seam.script, beat.claim));
    if (carrier) return { beatId: beat.beatId, carried: true, carriedBy: carrier.seamId, restsOn: restOf(carrier) };
    const positioned = request.seams.find((seam) => seam.carries.includes(beat.beatId));
    return {
      beatId: beat.beatId,
      carried: false,
      notes: `no seam's script shares a content word with the claim "${beat.claim.slice(0, 60)}"${positioned ? ` — it was positioned in seam ${positioned.seamId}` : ""}`
    };
  });
  const seams: SeamVerdict[] = request.seams
    .filter((seam) => !seam.frozen)
    .map((seam) => {
      const notes: string[] = [];
      const restsOn = restOf(seam);
      const rested = request.sources.filter((s) => restsOn.includes(s.id));
      let claimsSupported = !rested.some((s) => s.claimText.trim().length === 0);
      if (!claimsSupported) notes.push("A source is attached to no claim at all.");
      const contestedHandled = !rested.some((s) => s.contested) || containsContestedLanguage(seam.script);
      if (!contestedHandled) notes.push("A source is marked contested but the script never says so explicitly.");
      if (restsOn.length === 0 && hasDeclarativeSentence(seam.script)) {
        claimsSupported = false;
        notes.push(`The script states something — "${seam.script.split(/(?<=[.!?])\s+/)[0] ?? seam.script}" — and rests on no source in the act.`);
      }
      return { seamId: seam.seamId, claimsSupported, restsOn, contestedHandled, ...(notes.length > 0 ? { notes: notes.join(" ") } : {}) };
    });
  return { beats, seams };
}

/* Words too common to mean anything as a shared token between a purpose
 * and a script. Deliberately short: the test is "did the page wander off
 * its subject entirely", not "did it paraphrase well". */
const STOPWORDS = new Set([
  "about", "after", "again", "against", "because", "before", "being", "between", "could", "every",
  "first", "from", "have", "into", "just", "like", "more", "most", "only", "other", "over", "same",
  "some", "such", "than", "that", "them", "then", "there", "these", "they", "this", "those",
  "through", "under", "very", "were", "what", "when", "where", "which", "while", "will", "with",
  "would", "your"
]);

export function scriptIsAboutPurpose(script: string, purpose: string): boolean {
  const wanted = new Set(quoteWords(purpose).filter((w) => w.length > 3 && !STOPWORDS.has(w)));
  if (wanted.size === 0) return true;
  return quoteWords(script).some((w) => wanted.has(w));
}
