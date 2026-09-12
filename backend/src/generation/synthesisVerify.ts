import { isSynthesisVerified } from "../types/narration";
import type { NarratedBeat } from "../types/narration";
import type { GroundPageBrief } from "./NarrationWriterBuilder";
import { pageOfWrittenBeat, type WrittenAct, type WrittenBeat } from "./writeNarration";

/**
 * THE FORAY'S OWN VERIFIED PAGES, AS GROUND FOR A LATER ACT (F-97; F-88's
 * rule, on the path that runs).
 *
 * THE PROBLEM, from run 7 attempt 4 (2026-09-11): ten of 49 pages were kept
 * unverified and nine of them were bridges carrying the Foray's THESIS —
 * "Most retellings of engineering disasters compress months or years of
 * decisions into a single moment", "Treating a disaster as one bad decision
 * by one bad actor is comforting". Those sentences generalise across the
 * cases the Foray's OTHER pages establish. They are not incident facts, so
 * print retrieval will never find them, and the tape beside them restates
 * no one of them. Under the ordinary rule — every assertion rests on a
 * retrieved document or a clip — they could only ever be refused.
 *
 * THE RULE. A page may rest on a page of this same Foray that is verified
 * the ORDINARY way — tape-cited or print-verified, carrying at least one
 * source, and not itself resting on another page. Three things make that
 * safe rather than a loophole:
 *
 *   1. GROUND. Only pages verified the ordinary way are ground
 *      (`verifiedPageSummaries` excludes a page that itself rests on
 *      pages), so a chain of generalisations cannot float free of the tape
 *      and print.
 *   2. WRITING. The pages reach the writer as DOCUMENTS
 *      (`writeAct.ts`'s `groundDocsFor`, `kind: "page"`), so every
 *      mechanical rule applies to a quote of one
 *      unchanged: it must be a verbatim span, and its `publication` is read
 *      off the document rather than written.
 *   3. JUDGEMENT. The verifier says which of the act's sources — the
 *      clips' windows, the documents' spans, THESE pages — each seam rests
 *      on (`SeamVerdict.restsOn`), and `writeAct.ts` resolves the answer in
 *      code: an id that is not in the act's source set is ignored, and a
 *      seam that states something about the world and rests on nothing is
 *      refused. A bridge naming a case no verified page covers therefore
 *      stays unverified — that is the mutation test.
 *
 * WHAT IT RECORDS. `NarratedBeat.verification = { kind: "synthesis",
 * restsOn, attempt }` on the seam's page, so `veracityMetrics.ts` counts it
 * under `synthesisVerifiedPages` and the publish PR can say "verified by
 * synthesis of pages X, Y, Z".
 *
 * WHAT USED TO BE HERE (F-100, 2026-09-12). F-88 shipped this as a SEPARATE
 * PASS — `verifyBySynthesis`, a whole second drafting-and-verifying loop
 * that ran between an act's narration and its stitch, on pages the per-slot
 * path had degraded to `unverifiedReason: "no-evidence"`. Q-03/F-97
 * superseded it: the act writer is handed the ground up front and the act
 * verifier answers the same question in the call it was already making, so
 * the safety property is the same by a shorter route. The pass survived
 * anyway, and could not run — the act path emits only `seed-lost` and
 * `no-page`, so its eligibility test was never true and
 * `countSynthesisCandidates` was always 0. It is deleted; what remains is
 * the ground itself, which is what F-97 consumes.
 */

/** Foray-wide page id: the act, slot and beat a page belongs to. The id the
 * verifier answers with and `verification.restsOn` records. */
export function forayPageId(actIndex: number, slotIndex: number, beatIndex: number): string {
  return `a${actIndex}/s${slotIndex}/p${beatIndex}`;
}

/** The evidence-pack docId a verified page is handed to the act writer
 * under — the ONE convention the writer's documents, a page source's
 * publication and the stub verifier's cited-page lookup share. */
export function pageDocIdFor(pageId: string): string {
  return `page:${pageId}`;
}

function pageOf(beat: WrittenBeat): NarratedBeat | undefined {
  return pageOfWrittenBeat(beat);
}

/**
 * The ground a later act may rest a bridge on: every page in the Foray
 * verified the ORDINARY way — tape-cited or print-verified, carrying at
 * least one source (a verified hand-off that asserts nothing establishes
 * nothing) and not itself resting on other pages. `acts` is indexed by act
 * position; an act whose narration has not landed is `undefined` and
 * contributes nothing.
 */
export function verifiedPageSummaries(acts: ReadonlyArray<WrittenAct | undefined>): GroundPageBrief[] {
  const out: GroundPageBrief[] = [];
  acts.forEach((act, actIndex) => {
    if (!act) return;
    act.slots.forEach((slot, slotIndex) => {
      slot.beats.forEach((beat, beatIndex) => {
        const page = pageOf(beat);
        if (!page || !page.verified || isSynthesisVerified(page) || page.sources.length === 0) return;
        out.push({
          pageId: forayPageId(actIndex, slotIndex, beatIndex),
          claim: beat.claim,
          script: page.script,
          established: page.sources.map((s) => s.claimText)
        });
      });
    });
  });
  return out;
}
