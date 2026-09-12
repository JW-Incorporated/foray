import { z } from "zod";
import { phraseIsInWindow } from "./anchorText";

/**
 * §4.7 narration types (docs/curation/generation-architecture.md §4.7).
 * Takes §4.5-4.6's `SourcedBeat[]` (backend/src/types/tapeSourcing.ts) —
 * every beat already carrying either a tape pointer or a Patch/Carry
 * narration assignment — and, for every narration-sourced beat, produces
 * ONE PAGE: a script in the spine's voice, in one of the six modes
 * (`docs/curation/narration-craft.md` §0/§2.1), inside that mode's
 * second/character budget.
 *
 * PER §4.5'S OWN NOTE (see this stage's task brief), a tape-sourced beat
 * may still need short connective narration around it — Hinge, Frame,
 * Marker or Correction. §4.5-4.6's output shape (`SourcedBeat`) does not
 * flag this: it only ever assigns Patch/Carry, and only to a beat with NO
 * tape. This module therefore treats connective narration as a §4.7
 * DECISION, not an input it reads off `SourcedBeat` — see
 * `decideConnectiveNarration` in `writeNarration.ts`.
 *
 * MANDATORY QUALITY BAR — FACTUAL ACCURACY (the doc's own words: "the
 * product risk that kills this feature"):
 *   1. Every factual claim in a page carries a source, recorded
 *      alongside the script even though never spoken — `sources: Source[]`
 *      below, one entry per claim, structurally required (not a comment).
 *   2. A verification pass reads the page against its sources — a
 *      DIFFERENT agent than the writer (see `NarrationVerifierBuilder`,
 *      never the same class as `NarrationWriterBuilder`).
 *   3. A contested claim says so explicitly in the narration text AND
 *      structurally, via `Source.contested`.
 *
 * PRONUNCIATION: §9.1's on-device narration work owns the actual control
 * mechanism; this stage only has to carry the hint per hard/foreign word
 * so nothing has to be retrofitted later — `pronunciationHints` below.
 */

/** The narration modes, §2.1 / narration-craft.md §0 — the six the craft
 * doc named, plus `Intro` (Q-02, listening-quality deck). Capitalized to
 * match `tapeSourcing.ts`'s existing `NarrationAssignmentSchema` enum
 * ("Patch" | "Carry") rather than introducing a second casing for the
 * same extra modes this stage adds (Hinge/Frame/Marker/Correction/Intro).
 *
 * INTRO (Q-02). One or two sentences before a clip: who is speaking (name
 * and role), on which show, and what to listen for — written from the
 * clip's OPENING, never from its point. It replaces the Frame/Hinge that
 * F-81/F-82 made restate the tape they introduce (the narrator said the
 * point, then the guest said the point — Wyatt's second complaint). It is
 * verified structurally, not by a model: it must name the show or someone
 * the episode title names, and it must not repeat the clip's first
 * sentences (`actSeams.ts`). Under the per-act writer (Q-03) a seam page
 * that carries beats AND introduces a clip keeps its content mode
 * (Patch/Carry); `Intro` is the mode of a page that ONLY introduces. */
export const NarrationModeSchema = z.enum(["Hinge", "Frame", "Marker", "Correction", "Patch", "Carry", "Intro"]);
export type NarrationMode = z.infer<typeof NarrationModeSchema>;

/** narration-craft.md §0's table, in CHARACTERS — the primitive
 * `tools/foray/check-narration.mjs`'s `MODE_CHAR_BANDS` also uses, and
 * mirrored here rather than imported: that file is ESM-only
 * (`tools/`, no build step) and this backend compiles to CommonJS
 * (backend/tsconfig.build.json), so a runtime `require()` of an .mjs
 * module is not viable from a `tsc`-built CommonJS entry point.
 * `backend/test/narration.test.ts` cross-checks these numbers against
 * `check-narration.mjs`'s exported `MODE_CHAR_BANDS` at test time (a
 * live `import()` of the ESM module works fine under vitest), so the two
 * tables cannot silently drift apart — same discipline `copyRules.js`
 * documents for its own single-source-of-truth problem, applied via a
 * cross-file equality test instead of a shared runtime import. */
export const MODE_CHAR_BANDS: Record<NarrationMode, [number, number]> = {
  Hinge: [50, 135],
  Frame: [70, 170],
  Marker: [135, 340],
  Correction: [100, 205],
  Patch: [340, 765],
  Carry: [765, 1870],
  /* Q-02: "one or two sentences" — one clause (a same-guest follow-on,
     "don't go overkill") up to two full sentences naming guest, role, show
     and what to listen for. ~2–15 s at the planning rate. */
  Intro: [30, 260]
};

/** narration-craft.md §2a: the planning rate the whole cost model rests
 * on. Matches `check-narration.mjs`'s `NARRATION_CHARS_PER_SEC` exactly
 * (same cross-check test enforces it). */
export const NARRATION_CHARS_PER_SEC = 17;

export function scriptSeconds(chars: number): number {
  return Math.round((chars / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/** One factual claim's evidence, recorded alongside the script even
 * though `quote` is never spoken (§4.7's rule 1, and Ruling 3 —
 * `check-narration.mjs`'s `REFERENCE_LEAK_RE` — bans a citation from
 * ever reaching a spoken line). `claimText` ties this source to the
 * specific sentence/assertion it backs, so "every factual claim carries
 * a source" is checkable per-claim rather than only "the page has some
 * sources somewhere".
 *
 * TWO SHAPES (F-81). A PRINT source is a verbatim span of a held document
 * — the shape every Patch and Carry cites, unchanged. A TAPE source is
 * the segment a connective page introduces: a Frame that says what the
 * tape is about, or who is speaking, is describing the tape, and the tape
 * IS its source. It names the segment (`segmentId`), its holding document
 * is that segment's transcript window (`tapeDocIdFor`), and its `quote`
 * is OPTIONAL — a phrase of the tape's own words when the page echoes one,
 * checked as a whole-word span of the window with the same
 * canonicalisation §4.5 mints anchors with. The verifier reads the whole
 * window as the source, not a quote. Run 5 dropped eight Frames for
 * "declares no sources but states something about the world" (F-36/F-37/
 * F-44) because the only source shape available was a span of print, and
 * a description of what a segment says is not one; tape entered on
 * silence. The shape lives in the pipeline's candidate and report only:
 * `forayItems.ts` strips `sources` from the published record either way. */
const SourceCommonShape = {
  /** The factual assertion this source supports, in the author's own
   * words — not necessarily verbatim from the script (a script may
   * fold several claims into one sentence), but specific enough that a
   * verifier can find and check it against the script. */
  claimText: z.string().trim().min(1),
  publication: z.string().trim().min(1),
  url: z.string().trim().min(1).optional(),
  /** ISO date the span was retrieved, when known. */
  retrieved: z.string().trim().min(1).optional(),
  /** §4.7 rule 3: a genuinely contested claim must say so, both here
   * (structural — a verifier or downstream consumer can filter on it
   * without re-parsing prose) and in the narration text itself
   * (checked by `containsContestedLanguage` below, applied by the
   * caller — this schema cannot itself read the script it belongs to). */
  contested: z.boolean()
};

export const PrintSourceSchema = z
  .object({
    ...SourceCommonShape,
    /** Verbatim span from the source. Never spoken — see the module doc
     * comment and Ruling 3. */
    quote: z.string().trim().min(1)
  })
  .strict();
export type PrintSource = z.infer<typeof PrintSourceSchema>;

export const TapeSourceSchema = z
  .object({
    ...SourceCommonShape,
    kind: z.literal("tape"),
    /** The `data/segments.json`-shaped id of the segment this page
     * introduces — the same id its beat's `TapePointer.segmentId` carries
     * and the transcript window in the evidence pack is keyed by. */
    segmentId: z.string().trim().min(1),
    /** A phrase of the tape's own words, when the page echoes one; absent
     * when the page only describes what the segment is about. Never
     * spoken as a citation either way. */
    quote: z.string().trim().min(1).optional()
  })
  .strict();
export type TapeSource = z.infer<typeof TapeSourceSchema>;

/* Tape first: the two objects are `.strict()`, so a tape source fails the
   print shape on its extra fields and a print source fails the tape shape
   on its missing `kind`, and the order only decides which error a
   malformed object is reported with. */
export const SourceSchema = z.union([TapeSourceSchema, PrintSourceSchema]);
export type Source = z.infer<typeof SourceSchema>;

export function isTapeSource(source: Source): source is TapeSource {
  return (source as TapeSource).kind === "tape";
}

/** The evidence-pack docId of a segment's transcript window — the ONE
 * convention `gatherEvidence.ts` builds the window under and a tape source
 * is resolved against. */
export function tapeDocIdFor(segmentId: string): string {
  return `tape:${segmentId}`;
}

/** The inverse: the segment id a tape document's docId names, or `null`
 * for a document that is not a transcript window. */
export function segmentIdOfTapeDoc(docId: string): string | null {
  return docId.startsWith("tape:") && docId.length > 5 ? docId.slice(5) : null;
}

/** The connective modes that may cite the tape they hand into (F-81): the
 * Frame that introduces a segment, and a Hinge or Marker doing the same
 * job at a seam. Never a Patch or Carry — those carry the beat's content
 * and cite print — and never a Correction, which bounds tape on the
 * authority of a print source (narration-craft.md §3f). */
export const TAPE_SOURCE_MODES: readonly NarrationMode[] = ["Frame", "Hinge", "Marker", "Intro"];

export function modeMayCiteTape(mode: NarrationMode): boolean {
  return TAPE_SOURCE_MODES.includes(mode);
}

/**
 * One document the pipeline HOLDS the text of, as a narration page sees
 * it. WS-A's whole design turns on this type: a quote is a LOOKUP in one
 * of these, not a claim the writer makes, and a `publication` is one of
 * these documents' `title` rather than free text (F-27, F-30, F-32).
 *
 * Declared HERE, not in `gatherEvidence.ts`, so this types module stays
 * free of any dependency on the generation stages that use it — the
 * gatherer's own doc type EXTENDS this one with the two fields only
 * retrieval cares about (`kind`, `retrievedAt`), rather than restating it.
 * WS-B's `veracityMetrics.ts` reads this exact shape off `NarratedBeat`
 * to compute `groundedQuoteRate`.
 */
export const EvidenceDocSchema = z
  .object({
    docId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    url: z.string().trim().min(1).optional(),
    /** Held text the writer may quote from — a transcript cue window or a
     * fetched passage. Not trimmed to non-empty: a document that failed to
     * retrieve any text is still worth recording as "we tried and got
     * nothing" rather than dropped silently (WS-B). */
    text: z.string()
  })
  .strict();
export type EvidenceDoc = z.infer<typeof EvidenceDocSchema>;

/**
 * One attempt at a page, kept whether it passed or not, so the retry note
 * can accumulate every prior rejection (F-35) and so WS-B can measure
 * `firstAttemptPassRate` and `attributionStability` — did the same quote's
 * publication move between attempts (F-32) — from recorded data rather
 * than from side effects.
 *
 * SHAPE PINNED TO WS-B. `veracityMetrics.ts` on `ws-b-veracity-metrics`
 * reads exactly these four fields; this declaration is deliberately
 * identical to that branch's so the two land as one hunk.
 */
export const NarrationAttemptRecordSchema = z
  .object({
    /** 1-based — the Nth attempt at this page. */
    attempt: z.number().int().min(1),
    sources: z.array(SourceSchema),
    rejected: z.boolean(),
    /** Required when `rejected`; absent on the attempt that finally passed. */
    rejectionNote: z.string().trim().min(1).optional()
  })
  .strict();
export type NarrationAttemptRecord = z.infer<typeof NarrationAttemptRecordSchema>;

/** §4.7's pronunciation-control hint, per hard/foreign word. Nothing
 * consumes this yet (§9.1 owns the actual TTS-facing mechanism) — the
 * field exists so the data shape does not need retrofitting later. */
export const PronunciationHintSchema = z
  .object({
    word: z.string().trim().min(1),
    /** Plain-English or phonetic guide — deliberately untyped beyond
     * "non-empty string", since §9.1 has not chosen a notation yet. */
    hint: z.string().trim().min(1)
  })
  .strict();
export type PronunciationHint = z.infer<typeof PronunciationHintSchema>;

/**
 * One written-and-verified narration page — the §4.7 output for a single
 * narration beat. Matches this stage's task brief's output shape
 * exactly: `{ mode, script, sources, pronunciationHints, verified,
 * verifierNotes? }`, plus two WS-B additions (`evidence`, `attempts`),
 * both optional so every existing producer/consumer of this schema is
 * unaffected until something actually populates them.
 */
/** See `NarratedBeat.unverifiedReason`. */
export const UnverifiedReasonSchema = z.enum(["no-evidence", "no-page"]);
export type UnverifiedReason = z.infer<typeof UnverifiedReasonSchema>;

/**
 * F-88: HOW a page came to be verified when it was not by retrieval.
 *
 * Run 7 attempt 4 (2026-09-11) kept ten pages unverified; nine were the
 * Foray's THESIS — "Most retellings of engineering disasters compress
 * months or years of decisions into a single moment", "Treating a disaster
 * as one bad decision by one bad actor is comforting" — generalisations
 * across the cases the Foray's other, verified pages establish. Print
 * retrieval will never find a sentence like that, and F-82 (a Hinge cites
 * the tape beside it) does not reach it because it restates no one
 * segment. So a Hinge or Frame whose retrieval returned nothing may be
 * verified as a SYNTHESIS: written from the Foray's own verified pages as
 * its documents, then judged by the verifier as a fair generalisation of
 * those pages and only them, introducing no fact of its own
 * (`synthesisVerify.ts`). `restsOn` names the pages it rests on, so the
 * report and the publish PR can say "verified by synthesis of pages X, Y,
 * Z" and `veracityMetrics.ts` can count these pages separately
 * (`synthesisVerifiedPages`) while the gate treats them as verified.
 *
 * Absent on every page verified the ordinary way. A Patch or Carry never
 * carries it — content pages cite print or tape, never a generalisation.
 */
export const SynthesisVerificationSchema = z
  .object({
    kind: z.literal("synthesis"),
    /** Foray-wide page ids (`synthesisVerify.ts`'s `forayPageId`) of the
     * verified pages this generalisation rests on. Never empty: a
     * synthesis that rests on nothing is not a synthesis. */
    restsOn: z.array(z.string().trim().min(1)).min(1),
    /** The 1-based synthesis attempt that passed. */
    attempt: z.number().int().min(1)
  })
  .strict();
export type SynthesisVerification = z.infer<typeof SynthesisVerificationSchema>;

export const NarratedBeatSchema = z
  .object({
    mode: NarrationModeSchema,
    script: z.string().trim().min(1),
    /** Per-claim sources, §4.7 rule 1. May be empty ONLY for a page that
     * asserts no factual claim at all (a pure Hinge/Frame handoff with no
     * new information) — `writeNarration.ts`'s orchestrator treats an
     * empty array on a Patch/Carry page (which by definition carries
     * content) as a hard validation failure; see `validateNarratedBeat`. */
    sources: z.array(SourceSchema),
    pronunciationHints: z.array(PronunciationHintSchema),
    /** Set only by the verification pass (§4.7 rule 2) — never
     * self-reported by the writer. `writeNarration.ts`'s orchestrator is
     * the only code path allowed to flip this to `true`. */
    verified: z.boolean(),
    /** The verifier's SECOND question, kept as its own field rather than
     * folded into `verified` (F-41: nothing in run 1 asked whether a page
     * did the job its beat existed for, and page 7 re-told the collapse
     * from the top instead of introducing its named concept). Distinct
     * from `verified` because `verified` is trivially true on every kept
     * page — an unverified page is retried or dropped and never reaches a
     * `WrittenAct` — so averaging it would print 1.0 forever. WS-B's
     * `purposeFidelity` averages THIS. */
    purposeAccomplished: z.boolean().optional(),
    /** F-50, THE WRITER'S OWN FLAG: this page departs from the purpose it
     * was given because the evidence did — the documents contradicted or
     * complicated the purpose, and the page reports that tension instead
     * of asserting the purpose. Run 2 died on the beat where that was the
     * only honest page and no prompt permitted it: the purpose said the
     * feature store exists because training and serving code paths drift
     * apart silently, and the retrieved document said feature stores
     * "manage data artifacts. They do not control execution." Asserting
     * the purpose was unsupported; dropping the subject failed
     * `purposeAccomplished`; reporting the contradiction was allowed by
     * neither. It is now allowed, and flagged here so an editor can find
     * every page that took the permission. */
    purposeRevised: z.boolean().optional(),
    /** F-50, THE VERIFIER'S INDEPENDENT ANSWER to the same question. Kept
     * as its own field rather than merged into `purposeRevised`: the two
     * are different agents answering separately (§4.7 rule 2), and a page
     * the writer did not flag but the verifier did — or the reverse — is
     * exactly the page an editor most wants to see. `purposeWasRevised`
     * below is the OR of the two, for anything that just wants the set. */
    purposeRevisedByVerifier: z.boolean().optional(),
    verifierNotes: z.string().trim().min(1).optional(),
    /** WHY this page is unverified, when the answer is not "the verifier
     * read it and objected" (F-60). Two shapes of page reach a listener
     * with `verified: false`, and an editor triaging them needs to tell
     * them apart at a glance:
     *
     *   "no-evidence" — nothing was retrieved for the beat, in two
     *      differently-phrased queries, so no writer call was ever made
     *      and the page is a listener-safe hand-off holding the beat's
     *      place. There is no draft to fix; the beat needs evidence or it
     *      needs cutting.
     *   "no-page" — evidence existed but no attempt ever cleared the
     *      mechanical rules far enough to produce prose, so the same
     *      hand-off holds the place and `attempts` records what was tried.
     *
     * A page the verifier simply refused carries no reason at all: its
     * `verifierNotes` is the objection, which is the more useful thing to
     * read. */
    unverifiedReason: UnverifiedReasonSchema.optional(),
    /** The documents this page's quotes were looked up in (WS-A). Optional
     * so nothing upstream of the evidence pack has to change; WS-B reads
     * it to compute `groundedQuoteRate`. */
    evidence: z.array(EvidenceDocSchema).optional(),
    /** Every attempt at this page, successful or not, oldest first
     * (F-35/F-32) — `writeNarration.ts` records one entry per page per
     * attempt, so `attempts.length === 1` is WS-B's first-attempt pass and
     * a publication that moves between two entries is F-32 recurring.
     * Still optional: `disclosureNarratedBeat` and any hand-built
     * `NarratedBeat` in a test fixture carry none. */
    attempts: z.array(NarrationAttemptRecordSchema).optional(),
    /** F-88: present only on a page verified as a synthesis of the
     * Foray's own verified pages — see `SynthesisVerificationSchema`. */
    verification: SynthesisVerificationSchema.optional()
  })
  .strict();
export type NarratedBeat = z.infer<typeof NarratedBeatSchema>;

/** F-88: true for a page that is verified BY SYNTHESIS — and only then.
 * A page that carries a `verification` record but is not `verified` is
 * malformed, and reads as false here rather than as a synthesis. */
export function isSynthesisVerified(beat: Pick<NarratedBeat, "verified" | "verification">): boolean {
  return beat.verified === true && beat.verification?.kind === "synthesis";
}

/** True when EITHER agent said this page corrected its purpose from the
 * evidence (F-50). The one place the two flags are combined, so a
 * consumer that only wants "which pages departed from their brief" —
 * `veracityMetrics.ts`'s `purposeRevisedPages`, an editor's filter —
 * cannot get the disjunction subtly wrong in its own copy of it. */
export function purposeWasRevised(beat: Pick<NarratedBeat, "purposeRevised" | "purposeRevisedByVerifier">): boolean {
  return beat.purposeRevised === true || beat.purposeRevisedByVerifier === true;
}

export interface NarratedBeatValidationIssue {
  code:
    | "script-empty"
    | "out-of-budget"
    | "missing-sources"
    | "contested-not-flagged-in-text"
    | "banned-copy"
    | "not-verified"
    /** The quote is not a substring of any document the pipeline holds —
     * i.e. it was recalled, not looked up (F-14/F-27/F-32). */
    | "quote-not-held"
    /** Short enough that any text on the subject contains it, so it
     * "supports" anything (F-42's `"debris"`). */
    | "quote-too-short"
    /** The quote is the beat's own purpose (or the prompt) read back as
     * if it were a source (F-46). */
    | "quote-echoes-purpose"
    /** The publication is not the title or url of a held document — free
     * text, a slug, or a plausibility label (F-30/F-32). */
    | "publication-not-held"
    /** The script says what the record does or does not contain, with no
     * source whose own quote says so (F-45). */
    | "unsourced-negative-claim"
    /** Zero sources on a page that nonetheless asserts something
     * (F-36/F-37/F-44, settled here so the verifier never sees it). */
    | "sources-empty-with-claims"
    /** A tape source names a segment whose transcript window is not among
     * the documents the page was given — a page may cite only the tape it
     * introduces, and only when the pipeline holds its words (F-81). */
    | "tape-window-not-held"
    /** A tape source on a mode that carries content or corrects: a Patch,
     * Carry or Correction cites print, never the tape beside it (F-81). */
    | "tape-source-on-content-page";
  message: string;
}
export interface NarratedBeatValidationResult {
  valid: boolean;
  issues: NarratedBeatValidationIssue[];
}

/** narration-craft.md §5e-derived (mirrors `check-narration.mjs`'s
 * `BANNED_HEDGES`/language for "contested" framing): phrases a script
 * uses to flag a claim it is not standing fully behind. Kept narrow and
 * explicit rather than inferred, since §4.7 rule 3 requires the text say
 * so "explicitly". */
/* Generation run 1 (2026-09-09) rejected two correct pages on rule 3 because
   the writer said "historians still argue over" and "historians still
   dispute" — neither was on this list, though both say exactly what the rule
   asks for. Stems rather than phrases, so "dispute/disputed/disputes",
   "argue/argued/argues/argument" and "debate/debated" all count; the rule is
   that the script tells the listener the point is open, not that it uses a
   house phrase. */
const CONTESTED_PHRASES = [
  "contest",
  "disput",
  "debat",
  "disagree",
  "argue",
  "argued",
  "argument",
  "unsettled",
  "unresolved",
  "open question",
  "not everyone agrees",
  "accounts differ",
  "the evidence is mixed",
  "no consensus",
  "cannot settle",
  "can't settle",
  "still ask"
];

export function containsContestedLanguage(script: string): boolean {
  const low = script.toLowerCase();
  return CONTESTED_PHRASES.some((p) => low.includes(p));
}

/* ------------------------------------------------------------------ *
 * WS-A's mechanical rules. Every one of these is a rule a MODEL was
 * asked to follow in run 1 and did not; each is now checked in code,
 * before any verifier call, because "put every rule that can be checked
 * in code, in code" is what the run cost us the hard way.
 * ------------------------------------------------------------------ */

/**
 * The comparison form for "is this quote actually in that document".
 * Whitespace-collapsed, case-folded, and with the typographic characters
 * a transcript, a web page and a model's output disagree about (curly
 * quotes, en/em dashes, ellipses, non-breaking spaces) folded to their
 * ASCII forms. Everything else — every word, in order — must match
 * exactly. The forgiveness is deliberately limited to characters no
 * reader hears: a "quote" that differs from the document in any WORD is
 * not a quote, which is the whole point.
 */
export function normalizeForQuoteMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ′`´]/gu, "'")
    .replace(/[“”″]/gu, '"')
    .replace(/[‐-―−]/gu, "-")
    .replace(/[…]/gu, "...")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Minimum quoted span, in words. F-42: run 1's writer learned that a
 * one-word quote is never contradicted, and its spans shrank across the
 * run to `"debris"`, `"spillway"`, `"fish screen"` — spans any text on
 * the subject contains, so they support anything and can be looked up in
 * nothing. */
export const MIN_QUOTE_WORDS = 8;

/** How many words of the beat's own purpose a quote may share with it
 * before it is a quote OF the purpose. Set below `MIN_QUOTE_WORDS` so a
 * quote that IS the purpose (F-46) can never slip through on length. */
export const MAX_PURPOSE_OVERLAP_WORDS = 6;

export function quoteWords(quote: string): string[] {
  const n = normalizeForQuoteMatch(quote).replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  return n ? n.split(" ") : [];
}

/**
 * A short span is acceptable when it is a WHOLE SENTENCE — "The dam
 * failed." is checkable in a way "debris" is not. Recognised
 * structurally: an initial capital, a terminal mark, and at least three
 * words. When the holding document is known, the span must also sit at a
 * real sentence boundary in it, so a mid-sentence fragment cannot be
 * dressed up as a sentence by capitalising it.
 */
export function isCompleteSentence(quote: string, docText?: string): boolean {
  const trimmed = String(quote ?? "").trim().replace(/^["'“”‘’(]+/, "").replace(/["'“”‘’)]+$/, "");
  if (!/^[A-Z]/.test(trimmed)) return false;
  if (!/[.!?]$/.test(trimmed)) return false;
  if (quoteWords(trimmed).length < 3) return false;
  if (docText === undefined) return true;
  const doc = normalizeForQuoteMatch(docText);
  const at = doc.indexOf(normalizeForQuoteMatch(trimmed));
  if (at < 0) return false;
  if (at === 0) return true;
  return /[.!?]\s?$/.test(doc.slice(Math.max(0, at - 2), at));
}

/**
 * True when the quote is the beat's own purpose (or any other prompt
 * text) handed back as a source — F-46, the failure that ended run 1:
 * the deepen stage's sentence, word for word, attributed to Engineering
 * News-Record. Caught by a shared word run rather than only by equality,
 * because the writer trims and re-punctuates.
 */
export function quoteEchoesPurpose(quote: string, purposeText: string): boolean {
  const purposeWords = quoteWords(purposeText);
  const words = quoteWords(quote);
  /* Compared as WORD sequences, never as raw strings: a one-word purpose
     ("c" in a test fixture, a bare subject in production) is a substring
     of almost any quote, and a character-level containment check would
     reject every page it appeared on. */
  if (purposeWords.length < 3 || words.length === 0) return false;
  const purposeRun = ` ${purposeWords.join(" ")} `;
  const quoteRun = ` ${words.join(" ")} `;
  if (purposeRun.includes(quoteRun) || quoteRun.includes(purposeRun)) return true;

  if (words.length < MAX_PURPOSE_OVERLAP_WORDS || purposeWords.length < MAX_PURPOSE_OVERLAP_WORDS) return false;
  for (let i = 0; i + MAX_PURPOSE_OVERLAP_WORDS <= words.length; i++) {
    if (purposeRun.includes(` ${words.slice(i, i + MAX_PURPOSE_OVERLAP_WORDS).join(" ")} `)) return true;
  }
  return false;
}

/** The document `quote` is a verbatim (whitespace-normalised) substring
 * of, or `null`. `docId`, when given, restricts the search to the
 * document the writer SAID the quote came from — quoting doc A and
 * citing doc B is its own kind of mis-attribution. */
export function findHoldingDoc(quote: string, docs: EvidenceDoc[], docId?: string): EvidenceDoc | null {
  const needle = normalizeForQuoteMatch(quote);
  if (!needle) return null;
  const pool = docId ? docs.filter((d) => d.docId === docId) : docs;
  for (const doc of pool) {
    if (normalizeForQuoteMatch(doc.text).includes(needle)) return doc;
  }
  return null;
}

/* F-45: beat 18's retry replaced an unsourced true claim with a sourced-
   looking false one — "Exactly where, the record doesn't say", when the
   NTSB report says exactly where. An assertion about what the record
   CONTAINS is a factual claim about a document, and needs a document
   that says it, like any other. Stems and contractions included; the
   list is explicit rather than inferred so a page can be told precisely
   what tripped it. */
const NEGATIVE_RECORD_PATTERNS: RegExp[] = [
  /\bthe (?:record|file|archive|documentation)\b[^.?!]{0,40}?\b(?:does not|doesn't|do not|don't|never|cannot|can't|could not|couldn't|will not|won't|fails? to)\b/i,
  /\b(?:the )?(?:records?|sources?|documents?|accounts?|files|archives)\b[^.?!]{0,40}?\b(?:are|is) silent\b/i,
  /\b(?:no one|nobody|no-one) (?:knows|knew|recorded|wrote|said|documented|noted|remembers)\b/i,
  /\b(?:there is|there's|there was|there were) no (?:record|account|documentation|evidence|paper trail)\b/i,
  /\bno (?:record|account|documentation|note|memo) (?:says|shows|survives|exists|remains|was kept)\b/i,
  /\b(?:we|historians?|investigators?) (?:do not|don't|does not|doesn't|still don't|never) know\b/i,
  /\b(?:is|was|were|are) (?:not|never) recorded\b/i,
  /\bwas never written down\b/i
];

/** True when `text` asserts something about what the record does or does
 * not contain. Applied to the SCRIPT to find the claim, and to each
 * source's QUOTE to find the document that backs it. */
export function containsNegativeRecordClaim(text: string): boolean {
  const t = String(text ?? "");
  return NEGATIVE_RECORD_PATTERNS.some((rx) => rx.test(t));
}

/* F-37/F-44: the design disagreed with itself about whether a connective
   page needs sources, and the verifier decided it by sampling (one
   zero-source Frame passed in eleven). Settled here, structurally, so the
   verifier never sees the case: a page may declare zero sources only if
   it ASSERTS nothing — a question, or a hand-off addressed to the
   listener. The imperative list is deliberately narrow and explicit; a
   sentence that is not a question and not one of these openings is
   treated as an assertion about the world and needs a source. */
const LISTENER_IMPERATIVES = [
  "listen", "notice", "watch", "hear", "keep", "stay", "think", "consider",
  "remember", "picture", "imagine", "follow", "hold", "wait", "note", "ask"
];

export function hasDeclarativeSentence(script: string): boolean {
  const sentences = String(script ?? "")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (/[?]\s*$/.test(sentence)) continue;
    const words = quoteWords(sentence);
    if (words.length < 3) continue;
    if (LISTENER_IMPERATIVES.includes(words[0]!)) continue;
    return true;
  }
  return false;
}

export interface ValidateNarratedBeatOptions {
  bannedPhrasePatterns?: RegExp[];
  /** Every document the pipeline holds for this page. When supplied, a
   * quote MUST be a substring of one of them and a publication MUST be
   * one of their titles or urls. When absent (a caller that has no
   * evidence pack) those two rules are skipped and the rest still run. */
  heldDocs?: EvidenceDoc[];
  /** The beat purpose plus any other prompt text the writer was handed,
   * so a quote of it can be rejected (F-46). */
  purposeText?: string;
  /** Q-03: the character band to hold the script to INSTEAD of its mode's
   * `MODE_CHAR_BANDS` row. A seam page written per act carries several
   * beats' worth of prose (and an Intro), so its budget is the sum of the
   * bands it carries (`actSeams.ts`'s `seamBand`), not one beat's. Absent
   * means the mode's own band, as for every per-page path. */
  charBand?: [number, number];
  /** Q-03: the page may cite any transcript window it holds whatever its
   * mode. A seam page is Patch/Carry by its beats, and the act's clips are
   * documents it may restate — cited to the window, judged by the verifier
   * against that window (F-82's rule, act-wide). The per-page path never
   * sets this: there a Patch cites print (F-81). */
  tapeCitable?: boolean;
}

/**
 * Structural + copy-rule validation for one written-and-verified page.
 * Pure: takes the beat and an (optional) copy-rule checker so callers can
 * inject `backend/src/copy/rules.js`'s `BANNED` list without this module
 * importing a CommonJS `.js` file with hand-authored types into a
 * `.strict()`-typed module — kept as a parameter for testability too.
 */
export function validateNarratedBeat(
  beat: NarratedBeat,
  opts: ValidateNarratedBeatOptions = {}
): NarratedBeatValidationResult {
  const issues: NarratedBeatValidationIssue[] = [];

  if (beat.script.trim().length === 0) {
    issues.push({ code: "script-empty", message: "script is empty" });
  }

  const band = opts.charBand ?? MODE_CHAR_BANDS[beat.mode];
  const chars = beat.script.length;
  if (chars < band[0] || chars > band[1]) {
    issues.push({
      code: "out-of-budget",
      message: opts.charBand
        ? `${chars} chars is outside this seam's band ${band[0]}-${band[1]} (the bands of the beats it carries, summed — narration-craft.md §0)`
        : `${chars} chars is outside the ${beat.mode} band ${band[0]}-${band[1]} (narration-craft.md §0)`
    });
  }

  // A Patch/Carry page IS a beat's content (or supplies the part its tape
  // misses) — either way it is asserting something, so it must carry at
  // least one source. Hinge/Frame/Marker/Correction connective narration
  // may legitimately carry none (a pure handoff introduces no new claim).
  if ((beat.mode === "Patch" || beat.mode === "Carry") && beat.sources.length === 0) {
    issues.push({
      code: "missing-sources",
      message: `${beat.mode} narration carries a factual claim by definition and must have at least one source (§4.7 rule 1)`
    });
  }

  const anyContestedSource = beat.sources.some((s) => s.contested);
  if (anyContestedSource && !containsContestedLanguage(beat.script)) {
    issues.push({
      code: "contested-not-flagged-in-text",
      message: "a source is marked contested but the script does not say so explicitly (§4.7 rule 3)"
    });
  }

  /* Zero sources is legitimate for a page that asserts nothing, and only
     for that page. Checked before the per-source rules so an empty page
     is told the one thing wrong with it. */
  if (beat.sources.length === 0 && hasDeclarativeSentence(beat.script)) {
    issues.push({
      code: "sources-empty-with-claims",
      message:
        "the page declares no sources but its script states something about the world — a page with no sources may only ask a question or hand off to the listener (F-36/F-37/F-44)"
    });
  }

  const heldDocs = opts.heldDocs;
  const purposeText = opts.purposeText;
  for (const source of beat.sources) {
    if (isTapeSource(source)) {
      issues.push(...validateTapeSource(source, beat.mode, heldDocs, opts.tapeCitable === true));
      continue;
    }

    const holding = heldDocs ? findHoldingDoc(source.quote, heldDocs) : null;

    if (heldDocs) {
      if (!holding) {
        issues.push({
          code: "quote-not-held",
          message: `quote "${source.quote.slice(0, 60)}" is not a verbatim span of any document this page was given — a quote is a lookup, not a recollection (F-14/F-27)`
        });
      } else if (source.publication.trim() !== holding.title.trim() && (!holding.url || source.publication.trim() !== holding.url.trim())) {
        issues.push({
          code: "publication-not-held",
          message: `publication "${source.publication}" is not the title or url of the document the quote comes from ("${holding.title}") — attribution is read off the document, never written (F-30/F-32)`
        });
      }
    }

    const words = quoteWords(source.quote).length;
    if (words < MIN_QUOTE_WORDS && !isCompleteSentence(source.quote, holding?.text)) {
      issues.push({
        code: "quote-too-short",
        message: `quote "${source.quote.slice(0, 60)}" is ${words} word(s); a span must be at least ${MIN_QUOTE_WORDS} words or a complete sentence to be checkable (F-42)`
      });
    }

    if (purposeText && quoteEchoesPurpose(source.quote, purposeText)) {
      issues.push({
        code: "quote-echoes-purpose",
        message: `quote "${source.quote.slice(0, 60)}" repeats the beat's own purpose or prompt text — the purpose is editorial direction, never a source (F-28/F-46)`
      });
    }
  }

  if (containsNegativeRecordClaim(beat.script) && !beat.sources.some((s) => containsNegativeRecordClaim(s.quote ?? ""))) {
    issues.push({
      code: "unsourced-negative-claim",
      message:
        "the script asserts what the record does or does not contain, but no source's quote says so — drop the assertion rather than turning an unsourced true claim into a sourced-looking false one (F-45)"
    });
  }

  const bannedPatterns = opts.bannedPhrasePatterns ?? [];
  for (const rx of bannedPatterns) {
    if (rx.test(beat.script)) {
      issues.push({ code: "banned-copy", message: `script matches banned copy pattern ${rx}` });
    }
  }

  if (!beat.verified) {
    issues.push({ code: "not-verified", message: "beat has not been through the §4.7 verification pass" });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * F-81's rules for a source that IS the tape the page introduces. Three,
 * all mechanical:
 *
 *   - only a connective mode may cite tape (`TAPE_SOURCE_MODES`);
 *   - when the held documents are known, the segment's transcript window
 *     must be one of them (`tapeDocIdFor`) and the publication must be
 *     that document's title, exactly as a print source's must be;
 *   - a quote, if the source carries one, must be a whole-word span of
 *     that window under the anchor canonicalisation (`phraseIsInWindow`).
 *     No eight-word floor and no purpose-echo rule: the holding document
 *     for a tape source is the WHOLE window, which the verifier reads, so
 *     the quote is an echo the page chose to make and not the thing the
 *     claim rests on. A short quote cannot "support anything" here (F-42's
 *     worry) because nothing rests on it.
 *
 * With no `heldDocs` (a caller without an evidence pack) only the first
 * rule runs, matching how the print rules degrade. `tapeCitable` (Q-03)
 * waives the first rule for a seam page written per act — see
 * `ValidateNarratedBeatOptions.tapeCitable`.
 */
export function validateTapeSource(
  source: TapeSource,
  mode: NarrationMode,
  heldDocs?: EvidenceDoc[],
  tapeCitable = false
): NarratedBeatValidationIssue[] {
  const issues: NarratedBeatValidationIssue[] = [];
  if (!tapeCitable && !modeMayCiteTape(mode)) {
    issues.push({
      code: "tape-source-on-content-page",
      message: `a ${mode} page cites tape segment "${source.segmentId}" as its source — only a Frame, Hinge or Marker introducing that segment may; a ${mode} cites print (F-81)`
    });
  }
  if (!heldDocs) return issues;

  const window = heldDocs.find((d) => d.docId === tapeDocIdFor(source.segmentId));
  if (!window) {
    issues.push({
      code: "tape-window-not-held",
      message: `source cites tape segment "${source.segmentId}" but its transcript window is not among the documents this page was given — a page may cite only the tape beside it (the segment it introduces, or the one that plays just before or after it), and only when the pipeline holds its words (F-81/F-82)`
    });
    return issues;
  }
  if (source.publication.trim() !== window.title.trim()) {
    issues.push({
      code: "publication-not-held",
      message: `publication "${source.publication}" is not the title of the tape document the source names ("${window.title}") — attribution is read off the document, never written (F-30/F-32)`
    });
  }
  if (source.quote !== undefined && !phraseIsInWindow(source.quote, window.text)) {
    /* F-82: a page between two segments holds BOTH windows. A phrase the
       tape did say, cited to the wrong segment, is named as such — the
       fix is to cite the window it is in, not to drop the echo. */
    const elsewhere = tapeWindowHolding(source.quote, heldDocs, window.docId);
    issues.push({
      code: "quote-not-held",
      message: elsewhere
        ? `quote "${source.quote.slice(0, 60)}" is not spoken in the transcript window of segment "${source.segmentId}" — it is spoken in segment "${elsewhere.segmentId}", which this page also holds; cite the segment whose words they are (F-82)`
        : `quote "${source.quote.slice(0, 60)}" is not spoken in the transcript window of segment "${source.segmentId}" — a tape source may only echo the tape's own words (F-81)`
    });
  }
  return issues;
}

/**
 * F-82: the OTHER held transcript window a phrase is spoken in, when a
 * page holds more than one (a Hinge between two segments, a Frame with
 * tape before it). `null` when no other window says it. Shared by the
 * structural validator and the selection gate so both name the same
 * segment when a writer cites the wrong one.
 */
export function tapeWindowHolding(
  phrase: string,
  heldDocs: EvidenceDoc[],
  exceptDocId?: string
): { docId: string; segmentId: string; title: string } | null {
  for (const doc of heldDocs) {
    if (doc.docId === exceptDocId) continue;
    const segmentId = segmentIdOfTapeDoc(doc.docId);
    if (!segmentId) continue;
    if (phraseIsInWindow(phrase, doc.text)) return { docId: doc.docId, segmentId, title: doc.title };
  }
  return null;
}

/**
 * §4.7's mandatory disclosure — the first item of every generated Foray,
 * spoken before anything else, using the doc's EXACT template with only
 * `<subject>` filled in. Written once, here, as the single producer of
 * this string so nothing downstream can paraphrase it — the disclosure's
 * value is legal cover, and `tools/foray/check-forays.mjs`'s
 * `DISCLOSURE_RX` (PR #391) matches this exact wording verbatim (checked
 * by `backend/test/disclosureTemplate.test.ts`'s round-trip against that
 * validator, not merely asserted in prose here).
 */
export function disclosureTemplate(subject: string): string {
  const trimmedSubject = subject.trim();
  if (!trimmedSubject) throw new Error("disclosureTemplate: subject must not be empty");
  return (
    `This is a Foray about ${trimmedSubject}. Much of what you'll hear is written by AI. ` +
    "We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source."
  );
}

/** The disclosure as a full narration beat, ready to prepend as
 * `items[0]` — `check-forays.mjs` requires `items[0].type === "narration"`
 * with a `script` matching `DISCLOSURE_RX`, mode is not checked on the
 * disclosure item specifically but is set to "Marker" here (it announces
 * structure — the Foray's own opening — matching narration-craft.md §2c's
 * definition) so it still satisfies the six-mode enum check on any
 * generated Foray. */
export function disclosureNarratedBeat(subject: string): NarratedBeat {
  return {
    mode: "Marker",
    script: disclosureTemplate(subject),
    sources: [],
    pronunciationHints: [],
    verified: true
  };
}
