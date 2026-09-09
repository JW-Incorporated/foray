import { BANNED } from "../copy/rules";
import { decodeEntities } from "../feeds/html";
import type { SourcedAct, SourcedBeat, SourcedSlot, TapePointer } from "../types/tapeSourcing";
import {
  containsContestedLanguage,
  disclosureNarratedBeat,
  findHoldingDoc,
  isCompleteSentence,
  MIN_QUOTE_WORDS,
  MODE_CHAR_BANDS,
  quoteEchoesPurpose,
  quoteWords,
  validateNarratedBeat,
  type EvidenceDoc,
  type NarratedBeat,
  type NarrationAttemptRecord,
  type NarrationMode,
  type Source
} from "../types/narration";
import type { Voice } from "../types/spine";
import { beatKindOf, createEvidenceGatherer, emptyEvidencePack, type EvidenceGatherer, type EvidencePack } from "./gatherEvidence";
import type {
  NarrationBuildContext,
  NarrationPageBrief,
  NarrationWriterBuilder,
  ProsePageBrief,
  SelectedClaim
} from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder, VerifyPageBrief } from "./NarrationVerifierBuilder";

/**
 * §4.7 end to end (docs/curation/generation-architecture.md §4.7): takes
 * §4.5-4.6's `SourcedAct[]` (backend/src/generation/sourceBeats.ts) and,
 * for every narration beat plus any tape beat that needs short
 * connective narration around it, writes a page — grounded in an
 * EVIDENCE PACK gathered first, then checked mechanically, then read by a
 * SEPARATE `NarrationVerifierBuilder`.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN (WS-A):
 *
 *   evidence  → the documents this page may quote (`gatherEvidence.ts`)
 *   select    → one call per slot: which claims, and the span behind each
 *   CODE      → is that span really in that document? long enough? not the
 *               purpose read back? — decided here, by a substring check
 *   prose     → one call per slot: the scripts, from those claims only
 *   CODE      → structural + copy + negative-claim + empty-source rules,
 *               and every `publication` derived from the held document
 *   verify    → one call per slot: three questions a model is actually
 *               needed for (support, purpose, contested)
 *
 * A model is never asked to decide something a string comparison can
 * decide, and never gets to be the last check on one. Run 1's writer had
 * every incentive to declare less, shorter, or nothing, because declaring
 * was free and unverifiable; under this order a quote either resolves in a
 * held document or the page does not exist.
 *
 * §4.5's OWN NOTE, RESOLVED HERE: `SourcedBeat` only ever carries
 * `sourcing: "tape"` with a pointer or `sourcing: "narration"` with a
 * Patch/Carry assignment; there is no field for "this tape beat also needs
 * a Hinge/Frame/Marker/Correction around it". `decideConnectiveNarration`
 * below is where that decision is made, deterministically, from beat
 * POSITION within its slot.
 *
 * TWO DISTINCT AGENT ROLES, NEVER COLLAPSED: `writer` and `verifier` must
 * be different builder instances — enforced structurally by
 * `writeNarration` throwing if a caller passes the SAME object reference
 * for both.
 *
 * FAILURE POLICY: three informed attempts per page, each retry carrying
 * EVERY prior rejection (F-35). A connective page that still fails is
 * dropped and its tape kept (§4.8's silence-is-a-valid-bridge rule covers
 * the seam); a narration-sourced page failing takes the run down, because
 * dropping it would drop the beat's content.
 */

export class NarrationWriteError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly cause: unknown
  ) {
    super(`Writing narration for "${claim}" (mode ${mode}) failed after ${NARRATION_PAGE_ATTEMPTS} attempts: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "NarrationWriteError";
  }
}

export class InvalidNarratedBeatError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly issues: string[]
  ) {
    super(`Narration for "${claim}" (mode ${mode}) failed validation: ${issues.join("; ")}`);
    this.name = "InvalidNarratedBeatError";
  }
}

/** One beat's §4.7 result, preserving its position in the sourced spine.
 * A tape beat carries `connectiveNarration` only when
 * `decideConnectiveNarration` decided one was needed; a narration beat
 * always carries `narration`. */
export type WrittenBeat =
  | { sourcing: "tape"; claim: string; exploration: boolean; tape: TapePointer; connectiveNarration?: NarratedBeat }
  | { sourcing: "narration"; claim: string; exploration: boolean; narration: NarratedBeat };

export interface WrittenSlot {
  title: string;
  beats: WrittenBeat[];
}
export interface WrittenAct {
  title: string;
  slots: WrittenSlot[];
}

export interface WriteNarrationOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  /** Supplies each beat's evidence pack. Defaults to the real gatherer,
   * which is stub-backed whenever ANTHROPIC_API_KEY is absent — so a
   * dry-run still runs the whole lookup path for real. */
  evidence?: EvidenceGatherer;
}

/**
 * narration-craft.md §3b's seam table, reduced to a POSITIONAL rule this
 * stage can apply without stitching context (§4.8 owns the real seam
 * work — silence-vs-bridge, jingles, cross-act continuity). This is
 * deliberately conservative: it only ever proposes a mode for a tape
 * beat that OPENS its slot (S1/S2, "Frame — the common case") or that
 * immediately follows a DIFFERENT-source tape beat within the same slot
 * (S1's cross-episode case, also Frame — a Hinge is for same-episode
 * continuations, which this stage cannot detect from a claim + pointer
 * alone since two segments from the same show are not necessarily the
 * same episode's own continuous recording). A tape beat following
 * another tape beat from the SAME item (episode) gets no connective
 * narration — narration-craft.md §3b S3, "must be marked... where the
 * elision exceeds 5 min", a duration judgement out of this stage's scope
 * (left as a `null` result, i.e. §4.8's silence-is-a-valid-bridge rule
 * applies by default).
 */
export function decideConnectiveNarration(slot: SourcedSlot, beatIndex: number): NarrationMode | null {
  const beat = slot.beats[beatIndex];
  if (!beat || beat.sourcing !== "tape") return null;

  const previous = beatIndex > 0 ? slot.beats[beatIndex - 1] : undefined;

  if (!previous) {
    // Opens the slot: narration-craft.md §3b S1/S2 — a Frame introduces
    // tape that carries the beat and is the common case for entering it.
    return "Frame";
  }

  if (previous.sourcing === "narration") {
    // S4 in narration-craft.md's table (tape -> narration is the OTHER
    // direction; a narration item exiting into tape needs its own
    // Frame-shaped handoff on the tape side, matching S5's "strongest
    // place to use Set-up -> explanation").
    return "Frame";
  }

  // previous.sourcing === "tape"
  if (previous.tape.itemId !== beat.tape.itemId) {
    // Cross-episode tape-to-tape: S1, Frame, attribution mandatory.
    return "Frame";
  }

  // Same-episode continuation: leave to §4.8 (silence or a later
  // duration-aware Hinge decision it is better positioned to make).
  return null;
}

export const NARRATION_PAGE_ATTEMPTS = 3;

/** Lower-case hyphenated tokens with no spaces — the shape of every
 * `data/segments.json` item id and of a tier-2 minted id. A publication
 * is now derived from a held document's title, so this can only fire if a
 * document itself is named like a slug; kept as a last guard because the
 * cost of it firing wrongly is one retry and the cost of it not existing
 * was a podcast about griddles cited as a source (F-30).
 *
 * Spelled out as three linear tests rather than one regex with a nested
 * quantifier: the obvious `/^[a-z0-9]+(?:[-#][a-z0-9]+){2,}$/` is
 * catastrophically backtrackable on a long non-matching input, and this
 * runs on model output. */
export function looksLikeSlug(text: string): boolean {
  const t = text.trim();
  if (!/^[a-z0-9][a-z0-9#-]*[a-z0-9]$/.test(t)) return false;
  if (/[-#][-#]/.test(t)) return false;
  return (t.match(/[-#]/g) ?? []).length >= 2;
}

export async function writeNarration(acts: SourcedAct[], options: WriteNarrationOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct[]> {
  const { writer, verifier } = options;
  if (writer === (verifier as unknown as NarrationWriterBuilder)) {
    throw new Error("writeNarration: writer and verifier must be distinct builder instances (§4.7 rule 2 — verification must never be the writer)");
  }
  const evidence = options.evidence ?? createEvidenceGatherer();

  const writtenActs: WrittenAct[] = [];
  for (const act of acts) {
    /* WS-D1: every slot in an act is written in parallel. Nothing in a
       slot depends on another slot's text — the running order and the M3/M4
       episode-ordering guarantees were both fixed at sourcing time, over the
       whole Foray, before any of this runs — so the only thing serialising
       them bought was wall time, and narration is the largest stage. Acts
       stay sequential here; WS-D2 is what makes act 1 playable early. */
    const slots = await Promise.all(act.slots.map((slot) => writeSlot(slot, writer, verifier, evidence, voice, ctx)));
    writtenActs.push({ title: act.title, slots });
  }
  return writtenActs;
}

/** A page in flight: what it is for, what it may quote, what has been
 * said about it so far, and its result once it has one. */
interface PendingPage {
  pageId: string;
  beatIndex: number;
  claim: string;
  mode: NarrationMode;
  contextNote?: string;
  evidence: EvidencePack;
  rejections: string[];
  attempts: NarrationAttemptRecord[];
  result?: NarratedBeat;
}

async function writeSlot(
  slot: SourcedSlot,
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  evidence: EvidenceGatherer,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<WrittenSlot> {
  const pages: PendingPage[] = [];
  for (let i = 0; i < slot.beats.length; i++) {
    const beat = slot.beats[i]!;
    if (beat.sourcing === "narration") {
      pages.push(newPage(`p${i}`, i, beat.claim, beat.narration.mode));
      continue;
    }
    const connectiveMode = decideConnectiveNarration(slot, i);
    if (!connectiveMode) continue;
    pages.push(
      newPage(
        `p${i}`,
        i,
        beat.claim,
        connectiveMode,
        `This page hands the listener into or out of real tape — ${tapeDescription(beat)}. It does not restate what the tape itself says (narration-craft.md's spoiler rule).`
      )
    );
  }

  await Promise.all(
    pages.map(async (page) => {
      const beat = slot.beats[page.beatIndex]!;
      page.evidence = await evidence.gather(
        {
          claim: page.claim,
          kind: beatKindOf(beat as unknown as { kind?: unknown }),
          ...(beat.sourcing === "tape" ? { tape: beat.tape } : {})
        },
        ctx
      );
    })
  );

  for (let attempt = 0; attempt < NARRATION_PAGE_ATTEMPTS; attempt++) {
    const pending = pages.filter((p) => !p.result);
    if (pending.length === 0) break;
    await runSlotAttempt(slot.title, pending, writer, verifier, voice, ctx);
  }

  const beats: WrittenBeat[] = [];
  for (let i = 0; i < slot.beats.length; i++) {
    const beat = slot.beats[i]!;
    const page = pages.find((p) => p.beatIndex === i);

    if (beat.sourcing === "narration") {
      if (!page?.result) {
        throw new NarrationWriteError(
          beat.claim,
          beat.narration.mode,
          new InvalidNarratedBeatError(beat.claim, beat.narration.mode, page?.rejections ?? ["no page was produced"])
        );
      }
      beats.push({ sourcing: "narration", claim: beat.claim, exploration: beat.exploration, narration: page.result });
      continue;
    }

    if (page && !page.result) {
      /* A CONNECTIVE PAGE THAT CANNOT BE WRITTEN DOES NOT TAKE THE FORAY
         DOWN. The beat's content is the tape; the Frame around it is a
         courtesy §4.8's silence-is-a-valid-bridge rule already covers when
         no page exists. Run 1 attempt 3 died at beat 5 of 31 because a
         connective page failed verification twice — thirty beats of
         finished work discarded for one hand-off line. */
      console.warn(
        `writeNarration: dropping the ${page.mode} page for tape beat "${beat.claim.slice(0, 80)}" after ${NARRATION_PAGE_ATTEMPTS} rejected attempts — tape kept, silence bridges (${page.rejections.join(" | ").slice(0, 200)})`
      );
    }
    beats.push({
      sourcing: "tape",
      claim: beat.claim,
      exploration: beat.exploration,
      tape: beat.tape,
      ...(page?.result ? { connectiveNarration: page.result } : {})
    });
  }

  return { title: slot.title, beats };
}

/** One attempt over the slot's still-pending pages: select, check, write,
 * check, verify. At most three model calls, whatever the page count. */
async function runSlotAttempt(
  slotTitle: string,
  pending: PendingPage[],
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<void> {
  const briefs = pending.map(briefFor);
  const selection = await writer.selectClaims({ slotTitle, voice, pages: briefs }, ctx);

  const proseBriefs: ProsePageBrief[] = [];
  const byPageId = new Map(pending.map((p) => [p.pageId, p]));
  for (const page of pending) {
    const claims = decodeClaimEntities(selection.pages.find((s) => s.pageId === page.pageId)?.claims ?? []);
    const issues = validateSelectedClaims(claims, page);
    if (issues.length > 0) {
      /* The prose call is skipped for this page entirely: writing a script
         from claims that are not grounded would only produce a page that
         fails a second time, one call later. */
      reject(page, issues, []);
      continue;
    }
    proseBriefs.push({ ...briefFor(page), claims });
  }
  if (proseBriefs.length === 0) return;

  const prose = await writer.writePages({ slotTitle, voice, pages: proseBriefs }, ctx);

  const toVerify: Array<{ page: PendingPage; brief: VerifyPageBrief; beat: NarratedBeat }> = [];
  for (const brief of proseBriefs) {
    const page = byPageId.get(brief.pageId)!;
    const written = prose.pages.find((p) => p.pageId === brief.pageId);
    if (!written) {
      reject(page, [`the writer returned no page for "${brief.pageId}" — every page in the batch must come back`], []);
      continue;
    }

    const sources = sourcesFor(written.usedClaims, brief.claims, page.evidence);
    const beat: NarratedBeat = {
      mode: page.mode,
      // The script is the other half of the entity boundary — see
      // `decodeClaimEntities`. This one is about what a listener hears:
      // a narrator does not say "ampersand a-m-p semicolon" (F-26).
      script: decodeEntities(written.script),
      sources,
      pronunciationHints: written.pronunciationHints ?? [],
      verified: true
    };

    const structural = validateNarratedBeat(beat, {
      bannedPhrasePatterns: BANNED,
      heldDocs: heldDocsOf(page.evidence),
      purposeText: [page.claim, page.contextNote].filter(Boolean).join(" ")
    });
    const issues = structural.issues.map((i) => i.message);
    for (const source of sources) {
      if (looksLikeSlug(source.publication)) {
        issues.push(`publication "${source.publication}" is a tape item id, not a publication — cite the real work the quote comes from, or drop the claim`);
      }
    }
    if (issues.length > 0) {
      reject(page, issues, sources);
      continue;
    }

    toVerify.push({ page, brief: { ...brief, script: beat.script, sources }, beat });
  }
  if (toVerify.length === 0) return;

  const verdicts = await verifier.verifySlot({ slotTitle, voice, pages: toVerify.map((v) => v.brief) }, ctx);
  for (const { page, beat } of toVerify) {
    const verdict = verdicts.pages.find((v) => v.pageId === page.pageId);
    if (!verdict) {
      reject(page, [`the verifier returned no verdict for "${page.pageId}"`], beat.sources);
      continue;
    }
    const failures: string[] = [];
    if (!verdict.claimsSupported) failures.push("a claim in the script is not supported by the quote attached to it");
    if (!verdict.purposeAccomplished) failures.push("the page does not accomplish the purpose the beat was given");
    if (!verdict.contestedHandled) failures.push("a genuinely contested point is not handled as §4.7 rule 3 requires");
    if (failures.length > 0) {
      reject(page, [`${failures.join("; ")}${verdict.notes ? ` — ${verdict.notes}` : ""}`], beat.sources);
      continue;
    }

    /* `purposeAccomplished` is recorded on the page even though a `false`
       answer above already sent it back for another attempt: the field is
       what WS-B's `purposeFidelity` averages, and it is the statement "the
       verifier was asked F-41's question about THIS page and answered
       yes" — which run 1 could not make about any page, because nothing
       asked. It reads 1.0 across a healthy run by construction (a page
       that never gets a yes is retried, then dropped or fatal), so the
       metric earns its keep as a regression alarm rather than as a
       score: if it ever drops below 1, the question stopped being asked
       or stopped being enforced. */
    page.attempts.push({ attempt: page.attempts.length + 1, sources: beat.sources, rejected: false });
    page.result = {
      ...beat,
      purposeAccomplished: verdict.purposeAccomplished,
      ...(verdict.notes ? { verifierNotes: verdict.notes } : {}),
      evidence: heldDocsOf(page.evidence),
      attempts: page.attempts
    };
  }
}

function newPage(pageId: string, beatIndex: number, claim: string, mode: NarrationMode, contextNote?: string): PendingPage {
  return {
    pageId,
    beatIndex,
    claim,
    mode,
    ...(contextNote ? { contextNote } : {}),
    evidence: emptyEvidencePack(claim),
    rejections: [],
    attempts: []
  };
}

function tapeDescription(beat: Extract<SourcedBeat, { sourcing: "tape" }>): string {
  return `segment ${beat.tape.segmentId}`;
}

function briefFor(page: PendingPage): NarrationPageBrief {
  return {
    pageId: page.pageId,
    purpose: page.claim,
    mode: page.mode,
    ...(page.contextNote ? { contextNote: page.contextNote } : {}),
    ...(page.rejections.length > 0 ? { retryNote: retryNoteFrom(page.rejections) } : {}),
    evidence: page.evidence
  };
}

/** F-35: every prior rejection, in order. Run 1 overwrote this on each
 * failure, so attempt 3 was told about attempt 2 only and regularly
 * revived the fault attempt 1 was rejected for. */
export function retryNoteFrom(rejections: string[]): string {
  return (
    `${rejections.map((r, i) => `Attempt ${i + 1} was rejected for: ${r}.`).join(" ")} ` +
    "Write a corrected page that fixes every problem listed above — including the earlier ones — while keeping all other rules."
  );
}

/** Records one attempt's failure. Exactly one outcome — this or a result
 * — is recorded per page per attempt, which is what makes
 * `page.attempts.length + 1` the attempt number rather than a guess. */
function reject(page: PendingPage, issues: string[], sources: Source[]): void {
  const rejection = issues.join("; ");
  page.rejections.push(rejection);
  page.attempts.push({ attempt: page.attempts.length + 1, sources, rejected: true, rejectionNote: rejection });
}

/** The evidence pack as the validator sees it: documents, and nothing
 * about how they were found. */
export function heldDocsOf(pack: EvidencePack): EvidenceDoc[] {
  return pack.docs.map((d) => ({ docId: d.docId, title: d.title, ...(d.url ? { url: d.url } : {}), text: d.text }));
}

/**
 * Decodes HTML/XML entities (`&amp;`, `&quot;`, `&#39;`, numeric refs, …)
 * out of the claim-selection call's text fields — reusing
 * `feeds/html.ts`'s `decodeEntities`, already exercised against real feed
 * titles, rather than a second private implementation. Run 1 observed a
 * writer emit `&amp;` in an attribution ("Simon &amp; Schuster"), and a
 * model can put an entity in any prose field it writes (F-26).
 *
 * IT MUST RUN BEFORE THE SUBSTRING CHECK, not after. The held documents
 * are text — a transcript cue window, a retrieved passage — so they carry
 * `&`, not `&amp;`. A quote that arrives entity-encoded is the SAME span
 * of the same document; decoding first is what lets it resolve, and
 * decoding after `validateSelectedClaims` would reject a perfectly good
 * quote for a difference no reader can see.
 *
 * `publication` is not in this list, and that is the WS-A change rather
 * than an omission: it is no longer writer-supplied text at all. It is
 * read off the held document in `sourcesFor`, so an entity could only
 * reach it from a document title, which is upstream of this boundary.
 */
export function decodeClaimEntities(claims: SelectedClaim[]): SelectedClaim[] {
  return claims.map((claim) => ({
    ...claim,
    claimText: decodeEntities(String(claim.claimText ?? "")),
    quote: decodeEntities(String(claim.quote ?? ""))
  }));
}

/**
 * THE MECHANICAL GATE ON THE CLAIM-SELECTION CALL. Every rule here is a
 * substring or a word count; none of them is a judgement, and none of
 * them is ever asked of a model.
 */
export function validateSelectedClaims(claims: SelectedClaim[], page: PendingPage): string[] {
  const issues: string[] = [];
  const docs = heldDocsOf(page.evidence);
  const purposeText = [page.claim, page.contextNote].filter(Boolean).join(" ");

  if (claims.length === 0) {
    if (page.mode === "Patch" || page.mode === "Carry") {
      issues.push(
        docs.length === 0
          ? `no evidence could be gathered for this ${page.mode} page, and a ${page.mode} page carries the beat's content — it cannot be written unsourced`
          : `a ${page.mode} page carries the beat's content by definition and must select at least one claim from the documents provided (§4.7 rule 1)`
      );
    }
    return issues;
  }

  for (const claim of claims) {
    const where = `claim "${String(claim.claimText ?? "").slice(0, 50)}"`;
    if (!claim.claimText || claim.claimText.trim().length === 0) {
      issues.push("a selected claim has no claim text");
      continue;
    }
    const named = docs.find((d) => d.docId === claim.docId);
    if (!named) {
      issues.push(`${where} cites docId "${claim.docId}", which is not one of the documents provided`);
      continue;
    }
    if (!findHoldingDoc(claim.quote, [named])) {
      const elsewhere = findHoldingDoc(claim.quote, docs);
      issues.push(
        elsewhere
          ? `${where}: the quote is not in "${named.title}" — it is in "${elsewhere.title}". Quote the document you cite.`
          : `${where}: the quote is not a verbatim span of any document provided. Copy a span out of one of them; do not write one from memory (F-14/F-27).`
      );
      continue;
    }
    const words = quoteWords(claim.quote).length;
    if (words < MIN_QUOTE_WORDS && !isCompleteSentence(claim.quote, named.text)) {
      issues.push(`${where}: the quote is ${words} word(s). Take at least ${MIN_QUOTE_WORDS} words, or a whole sentence (F-42).`);
      continue;
    }
    if (quoteEchoesPurpose(claim.quote, purposeText)) {
      issues.push(`${where}: the quote repeats this beat's own purpose or prompt text. The purpose is editorial direction, never a source (F-46).`);
    }
  }
  return issues;
}

/**
 * Builds the page's `sources` from the claims the script actually used.
 * ATTRIBUTION IS READ OFF THE DOCUMENT, never written by the page's
 * author: `publication` is the held document's title and `url` its url.
 * That is what makes F-30 (a tape slug as a publication) and F-32 (the
 * same span moving between Wikipedia and Britannica across two attempts)
 * unrepresentable rather than merely forbidden.
 */
export function sourcesFor(usedClaims: number[] | undefined, claims: SelectedClaim[], pack: EvidencePack): Source[] {
  const out: Source[] = [];
  const seen = new Set<number>();
  for (const index of usedClaims ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= claims.length || seen.has(index)) continue;
    seen.add(index);
    const claim = claims[index]!;
    const doc = pack.docs.find((d) => d.docId === claim.docId);
    if (!doc) continue;
    out.push({
      claimText: claim.claimText,
      quote: claim.quote,
      publication: doc.title,
      ...(doc.url ? { url: doc.url } : {}),
      ...(doc.retrievedAt ? { retrieved: doc.retrievedAt } : {}),
      contested: claim.contested === true
    });
  }
  return out;
}

/** Flattens every `WrittenBeat`'s narration output (the beat's own page
 * plus any connective page a tape beat carries) across `acts` — used by
 * tests and by §4.8's stitching stage, which needs a flat ordered list of
 * narration pages rather than the nested act/slot structure. */
export function allWrittenNarration(acts: WrittenAct[]): NarratedBeat[] {
  const out: NarratedBeat[] = [];
  for (const act of acts) {
    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        if (beat.sourcing === "narration") out.push(beat.narration);
        else if (beat.connectiveNarration) out.push(beat.connectiveNarration);
      }
    }
  }
  return out;
}

export { disclosureNarratedBeat, MODE_CHAR_BANDS, containsContestedLanguage };
