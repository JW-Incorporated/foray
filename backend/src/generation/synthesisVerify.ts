import type { Voice } from "../types/spine";
import { NO_EVIDENCE_NOTE, NARRATION_PAGE_ATTEMPTS, carryClaims, draftRound, heldDocsOf, newPage, reject, type NarrationWriteStats, type PendingPage, type WrittenAct, type WrittenBeat } from "./writeNarration";
import type { EvidenceDoc, EvidencePack } from "./gatherEvidence";
import type { NarrationBuildContext, NarrationWriterBuilder } from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder, SynthesisVerdict, VerifiedPageSummary } from "./NarrationVerifierBuilder";
import { isSynthesisVerified, type NarratedBeat } from "../types/narration";

/**
 * F-88 — SYNTHESIS VERIFICATION: a thesis Hinge verified against the
 * Foray's own verified pages.
 *
 * Run 7 attempt 4 (2026-09-11) kept ten of 49 pages unverified; nine were
 * Hinges carrying the Foray's THESIS — "Most retellings of engineering
 * disasters compress months or years of decisions into a single moment",
 * "Treating a disaster as one bad decision by one bad actor is
 * comforting", "The next time a headline calls something 'a single
 * catastrophic failure'…" — and every one of them was an F-60 hand-off:
 * a content beat whose two retrieval queries returned nothing and with no
 * tape beside it, degraded to a placeholder Hinge (`HANDOFF_SCRIPT`,
 * `unverifiedReason: "no-evidence"`) that the gate then refused. Those
 * claims generalise across the cases the Foray's OTHER pages establish
 * and verify; they are not incident facts, so print retrieval will never
 * find them, and F-82 (a Hinge cites the tape beside it) does not reach
 * them because they restate no one segment.
 *
 * THE RULE. A Hinge (or Frame) whose retrieval returned nothing is
 * verified as a SYNTHESIS when every concrete case, entity or claim it
 * names maps to a page in the same Foray that IS verified — tape-cited or
 * print-verified — and it introduces no factual claim of its own. Three
 * things make that safe rather than a loophole:
 *
 *   1. ORDER. This pass runs only after the retrieval path has failed the
 *      page (`isSynthesisEligible`: `verified: false` AND
 *      `unverifiedReason: "no-evidence"`), never instead of it. A page the
 *      verifier refused on its evidence is not eligible — it had evidence.
 *      A Patch or Carry is never eligible: content pages cite print.
 *   2. GROUND. The page is WRITTEN from the Foray's verified pages as its
 *      only documents (`kind: "page"`), through the same drafting path
 *      every other page takes (`draftRound`) — so its quotes are verbatim
 *      spans of those pages, its publication is read off the page it
 *      quotes, and every mechanical rule applies unchanged. Only pages
 *      verified the ordinary way are ground: a synthesis never rests on
 *      another synthesis (`verifiedPageSummaries` excludes them), so a
 *      chain of generalisations cannot float free of the tape and print.
 *   3. JUDGEMENT. The verifier — the same model call family, one call —
 *      is handed those pages and asked: is this a fair generalisation of
 *      them and only them? It answers with the page ids the Hinge rests
 *      on, or refuses. The pass then checks the answer in code: every id
 *      must be a verified page, and every page the script quotes must be
 *      among them. A Hinge naming a case no verified page covers stays
 *      unverified — that is the mutation test.
 *
 * WHAT IT RECORDS. `NarratedBeat.verification = { kind: "synthesis",
 * restsOn, attempt }` — an extension of the existing page record, not a
 * fork — so `veracityMetrics.ts` counts these pages as
 * `synthesisVerifiedPages` while the gate treats them as verified, and the
 * report and publish PR can say "verified by synthesis of pages X, Y, Z".
 *
 * WHERE IT SITS. `runPipeline.ts`'s ordered loop, between an act's
 * narration landing and its stitch, under its own `synthesis:<i>`
 * checkpoint key. Not inside `writeNarration` — that is handed ONE act,
 * and a synthesis needs the whole Foray's verified pages; and not after
 * stitching — the stitcher owns a page's leading and trailing sentences
 * and the partial candidate is already on its way to a listener. An act
 * with an eligible page therefore waits for every act's narration to
 * settle before its stitch (the cost is paid only by a Foray the gate
 * would otherwise refuse); an act with none pays nothing.
 */

/** Foray-wide page id: the act, slot and beat a page belongs to. The id
 * the verifier answers with and `verification.restsOn` records. */
export function forayPageId(actIndex: number, slotIndex: number, beatIndex: number): string {
  return `a${actIndex}/s${slotIndex}/p${beatIndex}`;
}

/** The evidence-pack docId a verified page is handed to a synthesis page
 * under — the ONE convention the writer's documents, a synthesis source's
 * publication and the stub verifier's cited-page lookup share. */
export function pageDocIdFor(pageId: string): string {
  return `page:${pageId}`;
}

export function pageIdOfPageDoc(docId: string): string | null {
  return docId.startsWith("page:") && docId.length > 5 ? docId.slice(5) : null;
}

export const SYNTHESIS_SLOT_TITLE = "synthesis";

/**
 * Eligibility, in one place. A page whose retrieval returned nothing
 * (F-60's hand-off) in a mode that may generalise — never a Patch or
 * Carry, and never a page that HAD evidence and was refused on it.
 */
export function isSynthesisEligible(page: Pick<NarratedBeat, "verified" | "unverifiedReason" | "mode">): boolean {
  if (page.verified) return false;
  if (page.unverifiedReason !== "no-evidence") return false;
  return page.mode === "Hinge" || page.mode === "Frame";
}

/** How many pages of the act the pass would try — what `runPipeline.ts`
 * reads to decide whether to wait for the other acts. */
export function countSynthesisCandidates(act: WrittenAct): number {
  let n = 0;
  for (const slot of act.slots) {
    for (const beat of slot.beats) {
      const page = pageOf(beat);
      if (page && isSynthesisEligible(page)) n++;
    }
  }
  return n;
}

function pageOf(beat: WrittenBeat): NarratedBeat | undefined {
  return beat.sourcing === "narration" ? beat.narration : beat.connectiveNarration;
}

function withPage(beat: WrittenBeat, page: NarratedBeat): WrittenBeat {
  return beat.sourcing === "narration" ? { ...beat, narration: page } : { ...beat, connectiveNarration: page };
}

/**
 * The ground a synthesis may rest on: every page in the Foray verified the
 * ORDINARY way — tape-cited or print-verified, carrying at least one
 * source (a verified hand-off that asserts nothing establishes nothing)
 * and not itself a synthesis. `acts` is indexed by act position; an act
 * whose narration has not landed is `undefined` and contributes nothing.
 */
export function verifiedPageSummaries(acts: ReadonlyArray<WrittenAct | undefined>): VerifiedPageSummary[] {
  const out: VerifiedPageSummary[] = [];
  acts.forEach((act, actIndex) => {
    if (!act) return;
    act.slots.forEach((slot, slotIndex) => {
      slot.beats.forEach((beat, beatIndex) => {
        const page = pageOf(beat);
        if (!page || !page.verified || isSynthesisVerified(page) || page.sources.length === 0) return;
        out.push({
          pageId: forayPageId(actIndex, slotIndex, beatIndex),
          claim: beat.claim,
          mode: page.mode,
          script: page.script,
          established: page.sources.map((s) => s.claimText)
        });
      });
    });
  });
  return out;
}

/** The verified pages as the writer's documents. Title carries the page id
 * and its claim so a source's `publication` — read off the document, never
 * written — names the page a listener could be pointed to. */
export function pageDocsFor(pages: VerifiedPageSummary[]): EvidenceDoc[] {
  return pages.map((p) => ({
    docId: pageDocIdFor(p.pageId),
    kind: "page" as const,
    title: `This Foray, page ${p.pageId} — ${p.claim.slice(0, 80)}`,
    text: p.script
  }));
}

/** The brief a synthesis page is written under. */
export function synthesisContextNote(): string {
  return (
    "Nothing in print was found for this page, and it restates no one segment: its purpose is a GENERALISATION across what this Foray's other, " +
    "verified pages establish. The documents are those pages. Write it as a synthesis of them and only them — every case, name or claim it " +
    "mentions must be one those pages make, with claimText saying what the pages together show and the quote a whole sentence copied out of " +
    "the page it rests on. Introduce no fact the documents do not state; a case no document covers is what gets this page refused (F-88)."
  );
}

export interface SynthesisPassOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  /** G-34's retry-round counter, shared with narration. */
  stats?: NarrationWriteStats;
}

/**
 * The pass, for ONE act, against the whole Foray. Returns the act with
 * every eligible page either verified by synthesis or left as it was —
 * unverified, `no-evidence`, now carrying the synthesis attempts and the
 * last refusal in `verifierNotes` so the report says what was tried.
 * Never throws for a page: the gate decides, exactly as for F-51/F-60.
 */
export async function verifyBySynthesis(
  act: WrittenAct,
  actIndex: number,
  forayActs: ReadonlyArray<WrittenAct | undefined>,
  options: SynthesisPassOptions,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<WrittenAct> {
  const { writer, verifier, stats } = options;
  if (writer === (verifier as unknown as NarrationWriterBuilder)) {
    throw new Error("verifyBySynthesis: writer and verifier must be distinct builder instances (§4.7 rule 2 — verification must never be the writer)");
  }

  /* The eligible pages, keyed by Foray-wide id so the verdict names them
     the way `restsOn` names everything else. */
  const pending: PendingPage[] = [];
  const at = new Map<string, { slotIndex: number; beatIndex: number }>();
  act.slots.forEach((slot, slotIndex) => {
    slot.beats.forEach((beat, beatIndex) => {
      const page = pageOf(beat);
      if (!page || !isSynthesisEligible(page)) return;
      const pageId = forayPageId(actIndex, slotIndex, beatIndex);
      const p = newPage(pageId, beatIndex, beat.claim, page.mode, synthesisContextNote());
      p.attempts = [...(page.attempts ?? [])];
      pending.push(p);
      at.set(pageId, { slotIndex, beatIndex });
    });
  });
  if (pending.length === 0) return act;

  if (!verifier.verifySynthesis) {
    console.warn(`synthesisVerify: ${pending.length} page(s) in act ${actIndex} could be verified by synthesis, but the ${verifier.providerName} verifier does not answer the synthesis question — left unverified (F-88)`);
    return act;
  }

  const ground = verifiedPageSummaries(forayActs).filter((p) => !at.has(p.pageId));
  if (ground.length === 0) {
    console.warn(`synthesisVerify: ${pending.length} page(s) in act ${actIndex} could be verified by synthesis, but the Foray holds no verified page to rest one on — left unverified (F-88)`);
    return act;
  }
  const groundIds = new Set(ground.map((p) => p.pageId));
  const docs = pageDocsFor(ground);
  for (const page of pending) {
    const pack: EvidencePack = { purpose: page.claim, beatKind: "account", docs };
    page.evidence = pack;
  }

  const results = new Map<string, NarratedBeat>();
  for (let round = 0; round < NARRATION_PAGE_ATTEMPTS; round++) {
    const open = pending.filter((p) => !results.has(p.pageId) && p.attempts.length < NARRATION_PAGE_ATTEMPTS);
    if (open.length === 0) break;
    if (round > 0 && stats) stats.retryRounds += 1;

    const drafts = await draftRound(SYNTHESIS_SLOT_TITLE, open, writer, voice, ctx);
    if (drafts.length === 0) continue;

    const verdicts = await verifier.verifySynthesis({ voice, pages: drafts.map((d) => d.brief), verifiedPages: ground }, ctx);
    for (const { page, claims, beat } of drafts) {
      const verdict = verdicts.pages.find((v) => v.pageId === page.pageId);
      const refusal = refusalFor(verdict, beat, groundIds, docs);
      if (refusal) {
        reject(page, [refusal], beat.sources);
        carryClaims(page, claims);
        continue;
      }
      const restsOn = [...new Set(verdict!.restsOn)];
      page.attempts.push({ attempt: page.attempts.length + 1, sources: beat.sources, rejected: false });
      const cited = new Set(restsOn.map(pageDocIdFor));
      results.set(page.pageId, {
        ...beat,
        verified: true,
        verification: { kind: "synthesis", restsOn, attempt: page.attempts.length },
        ...(verdict!.notes ? { verifierNotes: verdict!.notes } : {}),
        /* Only the pages it rests on travel with it: the quotes are on
           those, so `groundedQuoteRate` still resolves every one, and a
           49-page Foray does not ride along on each synthesis page. */
        evidence: heldDocsOf({ ...page.evidence, docs: docs.filter((d) => cited.has(d.docId)) }),
        attempts: page.attempts
      });
      console.log(`synthesisVerify: "${page.claim.slice(0, 80)}" verified by synthesis of ${restsOn.join(", ")} (attempt ${page.attempts.length}, F-88)`);
    }
  }

  const slots = act.slots.map((slot, slotIndex) => ({
    ...slot,
    beats: slot.beats.map((beat, beatIndex) => {
      const pageId = forayPageId(actIndex, slotIndex, beatIndex);
      const p = pending.find((x) => x.pageId === pageId);
      if (!p) return beat;
      const verified = results.get(pageId);
      if (verified) return withPage(beat, verified);
      const original = pageOf(beat)!;
      const last = p.rejections[p.rejections.length - 1];
      console.warn(`synthesisVerify: "${p.claim.slice(0, 80)}" (act ${actIndex}) stays UNVERIFIED after ${p.attempts.length} synthesis attempt(s) — the veracity gate decides (F-88): ${(last ?? "").slice(0, 200)}`);
      return withPage(beat, {
        ...original,
        verifierNotes: last ? `${NO_EVIDENCE_NOTE}; synthesis refused — ${last}` : original.verifierNotes,
        attempts: p.attempts
      });
    })
  }));
  return { ...act, slots };
}

/**
 * The code's own check on the verifier's answer — the part a model is not
 * the last line of defence for. Null when the verdict stands.
 */
export function refusalFor(
  verdict: SynthesisVerdict | undefined,
  beat: Pick<NarratedBeat, "sources">,
  groundIds: ReadonlySet<string>,
  docs: ReadonlyArray<Pick<EvidenceDoc, "docId" | "title">>
): string | null {
  if (!verdict) return "the verifier returned no synthesis verdict for this page";
  if (!verdict.synthesis) return `not a fair synthesis of the Foray's verified pages${verdict.notes ? ` — ${verdict.notes}` : ""}`;
  const restsOn = [...new Set(verdict.restsOn)];
  if (restsOn.length === 0) return "the verifier accepted the page as a synthesis but named no verified page it rests on — a synthesis that rests on nothing is not one";
  const unknown = restsOn.filter((id) => !groundIds.has(id));
  if (unknown.length > 0) return `the verifier said the page rests on ${unknown.join(", ")}, which is not a verified page of this Foray`;
  /* A source's `publication` is the page document's title — read off the
     document by `sourcesFor`, never written — so the page it quotes is
     the document with that title. */
  const quoted = beat.sources
    .map((s) => pageIdOfPageDoc(docs.find((d) => d.title === s.publication)?.docId ?? ""))
    .filter((id): id is string => id !== null);
  const missing = quoted.filter((id) => !restsOn.includes(id));
  if (missing.length > 0) return `the script quotes page ${missing.join(", ")} but the verifier did not list it among the pages the synthesis rests on`;
  return null;
}
