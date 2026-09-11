import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { containsContestedLanguage, hasDeclarativeSentence, quoteWords } from "../types/narration";
import type {
  NarrationBuildContext,
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
  PageVerdict,
  SynthesisVerdict,
  SynthesisVerifyRequest,
  SynthesisVerifyResult,
  VerifiedPageSummary,
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
 *   - purposeAccomplished: the script has to be about the SUBJECT of the
 *     purpose it was given — at least one content word in common (F-41's
 *     page 7 dropped its named concept entirely and re-told the collapse
 *     from the top). A purpose with no content words is not evidence of
 *     anything and passes. F-50 narrowed this question to exactly what
 *     this structural test already measured — "did the page wander off its
 *     subject entirely", not "did the page agree with its purpose" — so a
 *     page that CONTRADICTS its purpose from the documents passes here,
 *     which is the outcome run 2 needed and did not get.
 *   - purposeRevised: never claimed. Whether a page departed from its
 *     purpose because the evidence did is an editorial reading; a stub
 *     that guessed it would put a flag on a dry-run page that nothing
 *     decided.
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

  /**
   * F-88's synthesis question, answered with the strongest STRUCTURAL
   * signal a stub can honestly give: every named case in the page (a
   * proper-noun-shaped token in its purpose or script — `namedCasesIn`)
   * must appear on some verified page, or the page is refused naming the
   * case; and the pages it rests on are the ones that carry a named case,
   * plus every page its sources quote, plus — for a page that names no
   * case at all — the pages sharing a content word with its script. A
   * page that rests on nothing is refused. Whether the generalisation is
   * FAIR is a reading judgement only the real verifier makes.
   */
  async verifySynthesis(request: SynthesisVerifyRequest, ctx: NarrationBuildContext): Promise<SynthesisVerifyResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });
    return { pages: request.pages.map((page) => synthesisVerdictFor(page, request.verifiedPages)) };
  }
}

export function synthesisVerdictFor(page: VerifyPageBrief, verifiedPages: VerifiedPageSummary[]): SynthesisVerdict {
  const refuse = (notes: string): SynthesisVerdict => ({ pageId: page.pageId, synthesis: false, restsOn: [], notes });
  if (verifiedPages.length === 0) return refuse("no verified page exists for this page to rest on");

  const textOf = (v: VerifiedPageSummary): string => [v.claim, v.script, ...v.established].join(" ").toLowerCase();
  const covered = (token: string, v: VerifiedPageSummary): boolean => quoteWords(textOf(v)).includes(token.toLowerCase());

  const restsOn = new Set<string>();
  /* Purpose and script read SEPARATELY: the purpose has no terminal mark,
     and joined they would make the script's first word mid-sentence. */
  for (const name of [...new Set([...namedCasesIn(page.purpose), ...namedCasesIn(page.script)])]) {
    const holders = verifiedPages.filter((v) => covered(name, v));
    if (holders.length === 0) {
      return refuse(`the page names "${name}", and no verified page in this Foray covers it — a synthesis may generalise only the cases the Foray's verified pages establish`);
    }
    for (const v of holders) restsOn.add(v.pageId);
  }
  /* The pages the script quotes are pages it rests on by construction. A
     `page:` docId names the page; anything else is not a synthesis source
     and is left for the mechanical rules to have refused already. */
  for (const source of page.sources) {
    const cited = page.evidence.docs.find((d) => d.title === source.publication && d.kind === "page");
    if (cited) restsOn.add(cited.docId.replace(/^page:/, ""));
  }
  if (restsOn.size === 0) {
    const words = new Set(quoteWords(page.script).filter((w) => w.length > 3 && !SYNTHESIS_STOPWORDS.has(w)));
    for (const v of verifiedPages) {
      if (quoteWords(textOf(v)).some((w) => words.has(w))) restsOn.add(v.pageId);
    }
  }
  if (restsOn.size === 0) return refuse("the page shares no case and no content word with any verified page in this Foray");
  return { pageId: page.pageId, synthesis: true, restsOn: [...restsOn] };
}

/** Proper-noun-shaped tokens — capitalised, three letters or more, never
 * the first word of a sentence (which is capitalised for a different
 * reason) — in the order they appear, deduplicated. "Hyatt", "Regency",
 * "Challenger", "NTSB"; never "The", "This" or "Most". */
export function namedCasesIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sentence of String(text ?? "").split(/(?<=[.!?…])\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const token = words[i]!.replace(/^["'“”‘’(]+/, "").replace(/["'“”‘’),.;:!?]+$/, "");
      if (!/^[A-Z][A-Za-z'-]{2,}$/.test(token)) continue;
      const key = token.toLowerCase();
      if (seen.has(key) || CAPITALISED_FUNCTION_WORDS.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

/* Capitalised for a reason other than being a name — a quoted clause, a
   title-cased heading, a model's emphasis. Never a case. */
const CAPITALISED_FUNCTION_WORDS = new Set([
  "the", "this", "that", "these", "those", "there", "then", "they", "them", "and", "but", "not", "nor", "for",
  "what", "when", "where", "which", "while", "who", "whom", "whose", "why", "how", "most", "more", "some", "none",
  "every", "each", "all", "any", "one", "two", "three", "yes", "now", "here", "with", "from", "into", "over"
]);

const SYNTHESIS_STOPWORDS = new Set(["this", "that", "line", "idea", "what", "just", "played", "opens", "closes", "sets", "with", "from", "into", "than", "their", "there", "these", "those", "were", "have", "been", "more", "most", "very", "when", "where", "which", "while"]);

function verdictFor(page: VerifyPageBrief): PageVerdict {
  const notes: string[] = [];

  const claimsSupported = !page.sources.some((s) => s.claimText.trim().length === 0);
  if (!claimsSupported) notes.push("A source is attached to no claim at all.");

  const purposeAccomplished = scriptIsAboutPurpose(page.script, page.purpose);
  if (!purposeAccomplished) {
    notes.push(`The script shares no content word with the subject its purpose names ("${page.purpose.slice(0, 60)}").`);
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
    return { pageId: page.pageId, claimsSupported: false, purposeAccomplished, purposeRevised: false, contestedHandled, notes: notes.join(" ") };
  }

  return {
    pageId: page.pageId,
    claimsSupported,
    purposeAccomplished,
    purposeRevised: false,
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
