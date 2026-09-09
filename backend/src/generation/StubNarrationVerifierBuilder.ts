import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage, hasDeclarativeSentence, quoteWords } from "../types/narration";
import type {
  NarrationBuildContext,
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
  PageVerdict,
  VerifyPageBrief
} from "./NarrationVerifierBuilder";

/**
 * Deterministic fake narration verifier, used whenever ANTHROPIC_API_KEY
 * is absent (env.anthropicDryRun). A DISTINCT CLASS from
 * `StubNarrationWriterBuilder` — never share a class or instance between
 * the two roles, per §4.7 rule 2 / §5's topology table.
 *
 * WHAT A STUB CAN HONESTLY ANSWER, AND WHAT IT CANNOT. The three
 * questions the real verifier is asked (does each quote support its
 * claim; does the page accomplish its purpose; is a genuinely contested
 * point handled) are reading-comprehension questions — a model's job, and
 * faking them with a token overlap is what run 1's stub did and what made
 * the dry-run path a weaker check than production rather than the same
 * one. So this class answers each question with the strongest STRUCTURAL
 * signal available and says nothing it cannot support:
 *
 *   - claimsSupported: a source attached to no claim at all fails. The
 *     harder half — does this quote support this claim — is already
 *     bounded by `writeNarration.ts`, which proved in code that the quote
 *     is a verbatim span of a document the pipeline holds before this is
 *     ever called.
 *   - purposeAccomplished: the script has to be about the purpose it was
 *     given — at least one content word in common (F-41's page 7 dropped
 *     its named concept entirely and re-told the collapse from the top).
 *     A purpose with no content words is not evidence of anything and
 *     passes.
 *   - contestedHandled: a source marked contested whose script never says
 *     so fails — the one rule of the three a string can actually decide.
 */
export class StubNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async verifySlot(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    return { pages: request.pages.map(verdictFor) };
  }
}

function verdictFor(page: VerifyPageBrief): PageVerdict {
  const notes: string[] = [];

  const claimsSupported = !page.sources.some((s) => s.claimText.trim().length === 0);
  if (!claimsSupported) notes.push("A source is attached to no claim at all.");

  const purposeAccomplished = scriptIsAboutPurpose(page.script, page.purpose);
  if (!purposeAccomplished) {
    notes.push(`The script shares no content word with the purpose it was given ("${page.purpose.slice(0, 60)}").`);
  }

  const contestedHandled = !page.sources.some((s) => s.contested) || containsContestedLanguage(page.script);
  if (!contestedHandled) notes.push("A source is marked contested but the script never says so explicitly.");

  /* F-44's coin flip, settled: a zero-source page that asserts something
     is not this stage's decision to make by sampling — `writeNarration.ts`
     already rejected it in code before any verifier saw it. Asserted here
     so a regression in that order shows up as a stub failure rather than
     as a page that quietly passes. */
  if (page.sources.length === 0 && hasDeclarativeSentence(page.script)) {
    notes.push("A zero-source page reached verification with a declarative script — the structural rule upstream did not run.");
    return { pageId: page.pageId, claimsSupported: false, purposeAccomplished, contestedHandled, notes: notes.join(" ") };
  }

  return {
    pageId: page.pageId,
    claimsSupported,
    purposeAccomplished,
    contestedHandled,
    ...(notes.length > 0 ? { notes: notes.join(" ") } : {})
  };
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
