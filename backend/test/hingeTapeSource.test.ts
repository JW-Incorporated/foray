import { describe, it, expect } from "vitest";
import {
  writeNarration,
  allWrittenNarration,
  adjacentTapeFor,
  evidenceBeatFor,
  gateSelectedClaims,
  slotNeighbours,
  HANDOFF_MODE,
  HANDOFF_SCRIPT,
  type WrittenAct
} from "../src/generation/writeNarration";
import { PrefetchingEvidenceGatherer, evidenceBeatsFor, evidenceMemoKey } from "../src/generation/evidencePrefetch";
import { buildVeracityMetrics, computeTapeCitedPages, computeUnverifiedPages } from "../src/generation/veracityMetrics";
import { buildVerifyPrompt } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { buildSelectionPrompt } from "../src/generation/AnthropicNarrationWriterBuilder";
import { DefaultEvidenceGatherer } from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type {
  ClaimSelectionRequest,
  ClaimSelectionResult,
  NarrationBuildContext,
  NarrationPageBrief,
  NarrationWriterBuilder,
  ProseWriteRequest,
  ProseWriteResult,
  SelectedClaim
} from "../src/generation/NarrationWriterBuilder";
import type { NarrationVerifierBuilder, NarrationVerifyRequest, NarrationVerifyResult } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import { isTapeSource, tapeDocIdFor, validateNarratedBeat, type NarratedBeat, type TapeSource } from "../src/types/narration";
import type { SourcedAct, SourcedBeat, SourcedSlot, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * F-82 (generation run 6, 2026-09-11): four pages were kept unverified —
 * "One host argued that matching an organization's actual mix of skills…",
 * "An engineer described buying a small robot and using a simulator…",
 * "None of these are modeling decisions — they're procurement, systems, and
 * packaging…", "One data-education program ran 88 projects with roughly 60
 * different companies…" — and the veracity gate refused the publish. Every
 * one of them was a page whose claim was the tape's own content: the
 * segment that says it was placed next door, the writer was handed only
 * the window of the segment a page INTRODUCES (F-81), two web queries
 * found nothing, and the page went out as a source-less hand-off.
 *
 * This suite pins the rule as implemented:
 *
 *   - a page holds the transcript windows of BOTH adjacent segments, in
 *     play order (`adjacentTapeFor`), each a tape document under
 *     `tapeDocIdFor(segmentId)` with its position; the prefetch stage
 *     gathers the same documents, so the hit rate stays 1;
 *   - a content page with no print but a neighbouring window is written
 *     as a Hinge from that tape instead of degraded to a placeholder;
 *   - a tape source is judged against the window it NAMES — a phrase from
 *     the previous segment cited to the next one is refused, and the
 *     rejection names the window that does say it;
 *   - a page with no source that states a fact is still refused;
 *   - `meta.veracity.tapeCitedPages` counts the pages that cite tape.
 *
 * Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* Two Practical AI segments in the run-6 shape, from different episodes so
   a Frame stands between them (`decideConnectiveNarration`'s cross-episode
   case). A's window is what the run-6 page restated. */
const ITEM_A = "practical-ai--skills-over-models";
const ITEM_B = "practical-ai--a-robot-in-a-simulator";
const SEGMENT_A = `${ITEM_A}#410`;
const SEGMENT_B = `${ITEM_B}#980`;
const WINDOW_A =
  "I think the thing people get wrong is they pick the model first. What I'd argue is you look at the actual mix of skills " +
  "in the organization, and you match the tools you adopt to that mix, and the model choice comes last, honestly.";
const WINDOW_B =
  "So I bought a small robot, one of the cheap arms, and before I let it touch anything I ran everything in a simulator first, " +
  "and the simulator was honestly where most of the learning happened.";
const TITLE_A = "Practical AI — Skills over models";
const TITLE_B = "Practical AI — A robot in a simulator";

function pointer(segmentId: string, itemId: string, startSec: number): TapePointer {
  return {
    segmentId,
    itemId,
    startSec,
    endSec: startSec + 150,
    startAnchor: "the thing people get wrong",
    endAnchor: "comes last honestly",
    tier: 1,
    confidence: "high"
  };
}
const TAPE_A = pointer(SEGMENT_A, ITEM_A, 410);
const TAPE_B = pointer(SEGMENT_B, ITEM_B, 980);

const DOC_A: EvidenceDoc = { docId: tapeDocIdFor(SEGMENT_A), kind: "tape", title: TITLE_A, text: WINDOW_A, tapePosition: "previous" };
const DOC_B: EvidenceDoc = { docId: tapeDocIdFor(SEGMENT_B), kind: "tape", title: TITLE_B, text: WINDOW_B, tapePosition: "next" };
const PRINT: EvidenceDoc = {
  docId: "print:survey-1",
  kind: "print",
  title: "A survey of tooling adoption",
  url: "https://example.org/survey",
  retrievedAt: "2026-09-11T00:00:00.000Z",
  text: "Organisations that inventory their existing skills before buying tools report fewer abandoned platforms, the survey found, across every sector sampled."
};

/* The run-6 claim, as the deepen stage wrote it: the tape's own content. */
const RUN6_CLAIM = "One host argued that matching an organization's actual mix of skills to the tools it adopts matters more than the model choice.";
/* The Hinge a writer makes of it — inside the Hinge band, declarative, and
   about what the previous tape said. */
const RUN6_HINGE = "One host just argued for matching tools to a team's actual mix of skills. Hold that thought as the next voice picks it up.";

const SOURCE_A: TapeSource = {
  kind: "tape",
  segmentId: SEGMENT_A,
  claimText: "the host argued for matching adopted tools to the organisation's actual mix of skills, with the model choice last",
  publication: TITLE_A,
  contested: false
};

function tapeBeat(claim: string, tape: TapePointer): SourcedBeat {
  return { sourcing: "tape", claim, exploration: false, tape };
}
function carryBeat(claim: string, mode: "Patch" | "Carry" = "Carry"): SourcedBeat {
  return { sourcing: "narration", claim, exploration: false, narration: { mode, reason: "test" } };
}

/** [tape A][Carry: the run-6 claim][tape B] — the run-6 shape. */
function betweenTape(claim: string = RUN6_CLAIM): SourcedAct[] {
  return [{ title: "Act", slots: [{ title: "Slot", beats: [tapeBeat("Tape A plays.", TAPE_A), carryBeat(claim), tapeBeat("Tape B plays.", TAPE_B)] }] }];
}

function hinge(overrides: Partial<NarratedBeat> = {}): NarratedBeat {
  return { mode: "Hinge", script: RUN6_HINGE, sources: [SOURCE_A], pronunciationHints: [], verified: true, ...overrides };
}

/** A gatherer that answers from the beat's declared neighbours — the
 * windows it names, positioned — plus whatever print the test hands it. */
function neighbourGatherer(print: EvidenceDoc[] = []): EvidenceGatherer & { seen: EvidenceBeat[] } {
  const windows: Record<string, EvidenceDoc> = { [SEGMENT_A]: DOC_A, [SEGMENT_B]: DOC_B };
  const g = {
    seen: [] as EvidenceBeat[],
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      g.seen.push(beat);
      const docs: EvidenceDoc[] = [];
      const own = beat.tape ? windows[beat.tape.segmentId] : undefined;
      if (own) docs.push({ ...own, tapePosition: "next" });
      for (const [position, p] of [["previous", beat.adjacentTape?.previous], ["next", beat.adjacentTape?.next]] as const) {
        const w = p ? windows[p.segmentId] : undefined;
        if (!w || docs.some((d) => d.docId === w.docId)) continue;
        docs.push({ ...w, tapePosition: position });
      }
      if (!own) docs.push(...print);
      return { purpose: beat.claim, beatKind: "account", docs };
    }
  };
  return g;
}

/** A writer replaying one canned answer per page per attempt, on the
 * split select/prose path. */
type Answer = { claims: SelectedClaim[]; script: string };
function pageWriter(answer: (brief: NarrationPageBrief, attempt: number) => Answer): NarrationWriterBuilder & { briefs: NarrationPageBrief[]; writeCalls: number } {
  const attempts = new Map<string, number>();
  const w = {
    providerName: "scripted",
    briefs: [] as NarrationPageBrief[],
    writeCalls: 0,
    async selectClaims(request: ClaimSelectionRequest): Promise<ClaimSelectionResult> {
      return {
        pages: request.pages.map((p) => {
          w.briefs.push(p);
          const n = attempts.get(p.pageId) ?? 0;
          attempts.set(p.pageId, n + 1);
          return { pageId: p.pageId, claims: answer(p, n).claims };
        })
      };
    },
    async writePages(request: ProseWriteRequest): Promise<ProseWriteResult> {
      w.writeCalls++;
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          script: answer(p, (attempts.get(p.pageId) ?? 1) - 1).script,
          usedClaims: p.claims.map((_, i) => i),
          pronunciationHints: []
        }))
      };
    }
  };
  return w;
}

function approvingVerifier(): NarrationVerifierBuilder & { seen: NarrationVerifyRequest[] } {
  const v = {
    providerName: "recording",
    seen: [] as NarrationVerifyRequest[],
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.seen.push(request);
      return { pages: request.pages.map((p) => ({ pageId: p.pageId, claimsSupported: true, purposeAccomplished: true, contestedHandled: true })) };
    }
  };
  return v;
}

const CLAIM_ON_A: SelectedClaim = { claimText: SOURCE_A.claimText, quote: "", docId: DOC_A.docId, contested: false };

describe("F-82 — a page holds the tape on either side of it, in play order", () => {
  it("a narration beat between two segments is handed both; a Frame on a tape beat is handed the one it introduces and the one before it", () => {
    /* MUTATION THAT KILLS THIS: hand a page only the segment it introduces
       (F-81's shape), or look at the next beat for a connective page (which
       plays BEFORE its beat, so its own segment is its `next`). */
    const slot = betweenTape()[0]!.slots[0]!;
    expect(adjacentTapeFor(slot, 1)).toEqual({ previous: TAPE_A, next: TAPE_B });
    // The Frame on beat 2 (tape B) plays after the Carry's page, not after
    // tape A: only the segment it introduces is beside it.
    expect(adjacentTapeFor(slot, 2)).toEqual({ next: TAPE_B });
    // The Frame on beat 0 has nothing before it: only the segment it introduces.
    expect(adjacentTapeFor(slot, 0)).toEqual({ next: TAPE_A });
    // Tape straight after tape (cross-episode): the Frame on B plays between A and B.
    const backToBack: SourcedSlot = { title: "S", beats: [tapeBeat("a", TAPE_A), tapeBeat("b", TAPE_B)] };
    expect(adjacentTapeFor(backToBack, 1)).toEqual({ previous: TAPE_A, next: TAPE_B });
    // A narration beat with no tape beside it holds no window at all.
    const noTape: SourcedSlot = { title: "S", beats: [carryBeat("x"), carryBeat("y"), carryBeat("z")] };
    expect(adjacentTapeFor(noTape, 1)).toBeUndefined();
  });

  it("adjacency crosses a slot edge: the last beat of the slot before and the first of the slot after count as neighbours", () => {
    /* MUTATION THAT KILLS THIS: stop at the slot boundary — a Hinge that
       ends a slot before a tape-opening slot then has no citable tape. */
    const act: SourcedAct = {
      title: "Act",
      slots: [
        { title: "One", beats: [tapeBeat("a", TAPE_A), carryBeat(RUN6_CLAIM)] },
        { title: "Two", beats: [tapeBeat("b", TAPE_B), carryBeat("more")] }
      ]
    };
    expect(slotNeighbours(act, 0)).toEqual({ after: act.slots[1]!.beats[0] });
    expect(slotNeighbours(act, 1)).toEqual({ before: act.slots[0]!.beats[1] });
    expect(adjacentTapeFor(act.slots[0]!, 1, slotNeighbours(act, 0))).toEqual({ previous: TAPE_A, next: TAPE_B });
    expect(adjacentTapeFor(act.slots[0]!, 1)).toEqual({ previous: TAPE_A });
  });

  it("the real gatherer builds both windows, positioned, under the tape docId convention — and a narration beat still asks the web its one question", () => {
    /* MUTATION THAT KILLS THIS: gather only `beat.tape` (the neighbours
       are then not held and a Hinge citing A is refused as
       `tape-window-not-held`), or let a neighbour's window trigger F-69's
       web skip (the Hinge's print question then never gets asked). */
    const catalogue: CatalogueData = {
      items: [
        { id: ITEM_A, show: "Practical AI", title: "Skills over models", topics: [], hook: "" },
        { id: ITEM_B, show: "Practical AI", title: "A robot in a simulator", topics: [], hook: "" }
      ],
      itemTags: {},
      concepts: {},
      shows: [{ show_id: "practical-ai", title: "Practical AI", taxonomy_node_ids: [] }]
    };
    const archive: TranscriptDigestEntry[] = [
      { show_id: "practical-ai", show_title: "Practical AI", guid: "a", title: "Skills over models", cues: 1 },
      { show_id: "practical-ai", show_title: "Practical AI", guid: "b", title: "A robot in a simulator", cues: 1 }
    ];
    class Cues implements TranscriptCueProvider {
      getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
        return entry.guid === "a" ? [{ text: WINDOW_A, start_sec: 400, end_sec: 560 }] : [{ text: WINDOW_B, start_sec: 970, end_sec: 1130 }];
      }
    }
    const gatherer = new DefaultEvidenceGatherer({ researcher: new StubExternalResearcher(), cueProvider: new Cues(), catalogue, transcriptArchive: archive, cacheDir: null });
    const slot = betweenTape()[0]!.slots[0]!;
    return (async () => {
      const hingePack = await gatherer.gather(evidenceBeatFor(slot, 1, "Carry"), ctx);
      expect(hingePack.docs.map((d) => [d.docId, d.kind, d.tapePosition ?? null, d.title])).toEqual([
        [tapeDocIdFor(SEGMENT_A), "tape", "previous", TITLE_A],
        [tapeDocIdFor(SEGMENT_B), "tape", "next", TITLE_B],
        [expect.stringMatching(/^print:/), "print", null, "Dry-run evidence fixture (no ANTHROPIC_API_KEY configured)"]
      ]);
      expect(hingePack.docs[0]!.text).toBe(WINDOW_A);

      // The Frame on B, when B plays straight after A: its own window is
      // `next`, A's is `previous`, and the web is not asked (F-69 — the
      // own window is the evidence).
      const backToBack: SourcedSlot = { title: "S", beats: [tapeBeat("a", TAPE_A), tapeBeat("b", TAPE_B)] };
      const framePack = await gatherer.gather(evidenceBeatFor(backToBack, 1, "Frame"), ctx);
      expect(framePack.docs.map((d) => [d.docId, d.tapePosition])).toEqual([
        [tapeDocIdFor(SEGMENT_B), "next"],
        [tapeDocIdFor(SEGMENT_A), "previous"]
      ]);
      expect(framePack.tape?.itemId).toBe(ITEM_B);
    })();
  });

  it("the memo key changes with the adjacent segments, so a prefetched pack is never served to a page beside different tape", () => {
    /* MUTATION THAT KILLS THIS: leave `adjacentTape` out of
       `evidenceMemoKey` — a Hinge between A and B and the same claim
       between C and D would share one pack. */
    const base: EvidenceBeat = { claim: RUN6_CLAIM, requiresEvidence: true };
    const beside = { ...base, adjacentTape: { previous: TAPE_A, next: TAPE_B } };
    expect(evidenceMemoKey(beside)).not.toBe(evidenceMemoKey(base));
    expect(evidenceMemoKey(beside)).not.toBe(evidenceMemoKey({ ...base, adjacentTape: { previous: TAPE_A } }));
    expect(evidenceMemoKey(beside)).toBe(evidenceMemoKey({ ...beside, claim: `  ${RUN6_CLAIM.toUpperCase()}  ` }));
  });
});

describe("F-82 — the structural validator: a Hinge restating the previous segment cites that segment", () => {
  it("a Hinge restating the previous segment passes with a tape source naming that segment, quote optional", () => {
    /* MUTATION THAT KILLS THIS: resolve a tape source only against the
       segment a page introduces (`next`) — the previous window is then
       "not held". */
    const held = [DOC_A, DOC_B];
    expect(validateNarratedBeat(hinge(), { heldDocs: held, purposeText: RUN6_CLAIM }).issues).toEqual([]);
    const echoed = hinge({ sources: [{ ...SOURCE_A, quote: "the model choice comes last" }] });
    expect(validateNarratedBeat(echoed, { heldDocs: held }).issues).toEqual([]);
  });

  it("the same Hinge citing the NEXT segment's id for words the PREVIOUS one said is refused, and the rejection names the window that says them", () => {
    /* MUTATION THAT KILLS THIS: check the echo against every held window
       instead of the one the source names — citing the wrong segment would
       pass, and the verifier would be handed the wrong window. */
    const wrong = hinge({ sources: [{ ...SOURCE_A, segmentId: SEGMENT_B, publication: TITLE_B, quote: "the model choice comes last" }] });
    const result = validateNarratedBeat(wrong, { heldDocs: [DOC_A, DOC_B] });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === "quote-not-held");
    expect(issue?.message).toContain(`it is spoken in segment "${SEGMENT_A}"`);
    // Citing a segment this page does not hold at all is still refused as before.
    const stranger = hinge({ sources: [{ ...SOURCE_A, segmentId: "practical-ai--elsewhere#1" }] });
    expect(validateNarratedBeat(stranger, { heldDocs: [DOC_A, DOC_B] }).issues.map((i) => i.code)).toContain("tape-window-not-held");
  });

  it("a Hinge with no source that states what the tape said is still refused (F-36/F-37/F-44 is not loosened)", () => {
    /* MUTATION THAT KILLS THIS: treat a connective page beside tape as
       implicitly tape-sourced when it declares nothing. */
    const result = validateNarratedBeat(hinge({ sources: [] }), { heldDocs: [DOC_A, DOC_B] });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("sources-empty-with-claims");
  });

  it("the selection gate refuses a claim that names the next segment's window for the previous one's words, and says which window to cite", () => {
    /* MUTATION THAT KILLS THIS: drop `tapeWindowHolding` from the gate's
       tape branch — the writer is told only that the phrase is not in the
       window, not that the other window says it. */
    const page = { pageId: "p1", beatIndex: 1, claim: RUN6_CLAIM, mode: "Hinge" as const, evidence: { purpose: RUN6_CLAIM, beatKind: "account" as const, docs: [DOC_A, DOC_B] }, rejections: [], attempts: [] };
    const gate = gateSelectedClaims([{ ...CLAIM_ON_A, docId: DOC_B.docId, quote: "the model choice comes last" }], page);
    expect(gate.valid).toEqual([]);
    expect(gate.issues[0]).toContain(`it is spoken in the other window this page holds, "${DOC_A.docId}" (the segment that plays just before this page)`);
    expect(gateSelectedClaims([{ ...CLAIM_ON_A, quote: "the model choice comes last" }], page).issues).toEqual([]);
  });
});

describe("F-82 — writeNarration: the run-6 page is written as a Hinge from the tape beside it", () => {
  it("a content beat with no print but a neighbouring window is written as a Hinge citing that tape — no F-60 placeholder, one writer round, verified", async () => {
    /* MUTATION THAT KILLS THIS: keep F-60's `docs.length > 0` test — the
       pack holds two windows, so the Carry is written AS a Carry and
       refused (a Carry may not cite tape, F-81), or restore the degrade on
       "no print" alone and the page is the placeholder run 6 shipped. */
    const writer = pageWriter(() => ({ claims: [CLAIM_ON_A], script: RUN6_HINGE }));
    const verifier = approvingVerifier();
    const evidence = neighbourGatherer();
    const written = await writeNarration(betweenTape(), { writer, verifier, evidence }, voice, ctx);

    const carry = evidence.seen.find((b) => b.claim === RUN6_CLAIM)!;
    expect(carry.adjacentTape).toEqual({ previous: TAPE_A, next: TAPE_B });

    const beat = written[0]!.slots[0]!.beats[1]!;
    expect(beat.sourcing).toBe("narration");
    const page = beat.sourcing === "narration" ? beat.narration : undefined;
    expect(page?.mode).toBe(HANDOFF_MODE);
    expect(page?.script).toBe(RUN6_HINGE);
    expect(page?.verified).toBe(true);
    expect(page?.unverifiedReason).toBeUndefined();
    expect(page?.sources).toEqual([{ kind: "tape", segmentId: SEGMENT_A, claimText: SOURCE_A.claimText, publication: TITLE_A, contested: false }]);
    expect(writer.writeCalls).toBe(1);

    // The brief said which window is which, and why the page is a Hinge.
    const brief = writer.briefs.find((b) => b.purpose === RUN6_CLAIM)!;
    expect(brief.mode).toBe("Hinge");
    expect(brief.contextNote).toContain(`the segment that plays just before this page (document ${DOC_A.docId})`);
    expect(brief.contextNote).toContain("A restatement of the tape with no tape source, or backed by an outside publication, is what gets this page rejected (F-82)");

    // The verifier was handed A's window as the holding document.
    const verified = verifier.seen.flatMap((r) => r.pages).find((p) => p.purpose === RUN6_CLAIM)!;
    expect(verified.sources.some((s) => isTapeSource(s) && s.segmentId === SEGMENT_A)).toBe(true);
    expect(verified.evidence.docs.find((d) => d.docId === DOC_A.docId)?.text).toBe(WINDOW_A);
  });

  it("citing the next segment for the previous one's words is refused at selection, the retry note names the right window, and the corrected page is verified", async () => {
    /* MUTATION THAT KILLS THIS: accept a tape echo found in ANY held
       window. The first attempt would pass with the wrong segment cited. */
    const writer = pageWriter((brief, attempt) =>
      brief.purpose === RUN6_CLAIM && attempt === 0
        ? { claims: [{ ...CLAIM_ON_A, docId: DOC_B.docId, quote: "the model choice comes last" }], script: RUN6_HINGE }
        : { claims: [{ ...CLAIM_ON_A, quote: "the model choice comes last" }], script: RUN6_HINGE }
    );
    const written = await writeNarration(betweenTape(), { writer, verifier: approvingVerifier(), evidence: neighbourGatherer() }, voice, ctx);
    const retried = writer.briefs.filter((b) => b.purpose === RUN6_CLAIM);
    expect(retried).toHaveLength(2);
    expect(retried[1]!.retryNote).toContain(`"${DOC_A.docId}" (the segment that plays just before this page)`);
    const page = allWrittenNarration(written).find((p) => p.script === RUN6_HINGE)!;
    expect(page.verified).toBe(true);
    expect(page.sources[0]).toMatchObject({ kind: "tape", segmentId: SEGMENT_A, quote: "the model choice comes last" });
  });

  it("a Frame between two episodes holds the previous window too and may cite it — the pack and the brief both say so", async () => {
    /* MUTATION THAT KILLS THIS: build the connective page's pack from
       `beat.tape` alone. A Frame closing what A said has no citable A. */
    const writer = pageWriter((brief) =>
      brief.mode === "Frame" && brief.purpose === "Tape B plays."
        ? { claims: [CLAIM_ON_A], script: "That was one host on matching tools to skills. Next, an engineer takes the same question into a simulator." }
        : { claims: [CLAIM_ON_A], script: RUN6_HINGE }
    );
    const backToBack: SourcedAct[] = [{ title: "Act", slots: [{ title: "Slot", beats: [tapeBeat("Tape A plays.", TAPE_A), tapeBeat("Tape B plays.", TAPE_B)] }] }];
    const written = await writeNarration(backToBack, { writer, verifier: approvingVerifier(), evidence: neighbourGatherer() }, voice, ctx);
    const frame = writer.briefs.find((b) => b.mode === "Frame" && b.purpose === "Tape B plays.")!;
    expect(frame.contextNote).toContain(`The tape that plays just before this page (document ${DOC_A.docId}) is held too`);
    expect(frame.evidence.docs.map((d) => [d.docId, d.tapePosition])).toEqual([
      [DOC_B.docId, "next"],
      [DOC_A.docId, "previous"]
    ]);
    const beatB = written[0]!.slots[0]!.beats[1]!;
    const page = beatB.sourcing === "tape" ? beatB.connectiveNarration : undefined;
    expect(page?.verified).toBe(true);
    expect(page?.sources[0]).toMatchObject({ kind: "tape", segmentId: SEGMENT_A });
  });

  it("a content page that DID find print stays a Carry: the neighbouring window is held as context, and a claim on it is the print shape (F-81's mode rule is unchanged)", async () => {
    /* MUTATION THAT KILLS THIS: re-mode every tape-adjacent content page
       to a Hinge, or let `isTapeClaim` ignore the mode — a Carry would
       then carry a tape source the validator refuses. */
    const eightWords = "Organisations that inventory their existing skills before buying tools";
    const writer = pageWriter((brief) =>
      brief.purpose === RUN6_CLAIM
        ? {
            claims: [{ claimText: "organisations that inventory skills first abandon fewer platforms", quote: eightWords, docId: PRINT.docId, contested: false }],
            script: `${"Teams that take stock of the skills they already have before they buy a platform tend to keep the platform they buy. ".repeat(7)}That is the pattern the survey found.`
          }
        : { claims: [CLAIM_ON_A], script: RUN6_HINGE }
    );
    const written = await writeNarration(betweenTape(), { writer, verifier: approvingVerifier(), evidence: neighbourGatherer([PRINT]) }, voice, ctx);
    const brief = writer.briefs.find((b) => b.purpose === RUN6_CLAIM)!;
    expect(brief.mode).toBe("Carry");
    expect(brief.contextNote).toBeUndefined();
    expect(brief.evidence.docs.map((d) => d.docId)).toEqual([DOC_A.docId, DOC_B.docId, PRINT.docId]);
    const beat = written[0]!.slots[0]!.beats[1]!;
    const page = beat.sourcing === "narration" ? beat.narration : undefined;
    expect(page?.mode).toBe("Carry");
    expect(page?.verified).toBe(true);
    expect(page?.sources.every((s) => !isTapeSource(s))).toBe(true);
  });

  it("a content page with neither print nor tape beside it is still degraded unwritten — F-60 is not loosened", async () => {
    /* MUTATION THAT KILLS THIS: write every print-less content page as a
       Hinge whether or not a window is held — a source-less Hinge then
       spends three writer rounds to be refused. */
    const writer = pageWriter(() => ({ claims: [], script: RUN6_HINGE }));
    const acts: SourcedAct[] = [{ title: "Act", slots: [{ title: "Slot", beats: [carryBeat("An unrelated claim nobody has written about."), carryBeat("Another such claim.")] }] }];
    const empty: EvidenceGatherer = { async gather(beat) { return { purpose: beat.claim, beatKind: "account", docs: [] }; } };
    const written = await writeNarration(acts, { writer, verifier: approvingVerifier(), evidence: empty }, voice, ctx);
    expect(writer.briefs).toHaveLength(0);
    for (const page of allWrittenNarration(written)) {
      expect(page.mode).toBe(HANDOFF_MODE);
      expect(page.script).toBe(HANDOFF_SCRIPT);
      expect(page.unverifiedReason).toBe("no-evidence");
    }
  });

  it("the dry-run path writes the run-6 shape end to end: stub writer, stub verifier, a Hinge with a tape source on the previous segment", async () => {
    /* MUTATION THAT KILLS THIS: have the stub writer's first legal span
       come from a window the page does not hold, or key the neighbouring
       window under a docId `sourcesFor` does not recognise as tape. */
    const written = await writeNarration(
      betweenTape("The host argued that the mix of skills in the organization decides the tools, and the model choice comes last."),
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence: neighbourGatherer() },
      voice,
      ctx
    );
    const beat = written[0]!.slots[0]!.beats[1]!;
    const page = beat.sourcing === "narration" ? beat.narration : undefined;
    expect(page?.mode).toBe(HANDOFF_MODE);
    expect(page?.verified).toBe(true);
    expect(page?.sources[0]).toMatchObject({ kind: "tape", segmentId: SEGMENT_A, publication: TITLE_A });
  });
});

describe("F-82 — the prefetch stage gathers the same documents, so the hit rate stays 1", () => {
  it("prefetch then narration: every gather is a memo hit, the wrapped gatherer is asked once per page, and the Carry's beat carries its neighbours", async () => {
    /* MUTATION THAT KILLS THIS: leave the neighbours out of
       `evidenceBeatsFor` (or out of `writeSlot`'s request) — the keys
       differ on `adjacentTape`, narration misses on every tape-adjacent
       page, and the wrapped gatherer is asked again. */
    const inner = neighbourGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const act: SourcedAct = {
      title: "Act",
      slots: [
        { title: "One", beats: [tapeBeat("Tape A plays.", TAPE_A), carryBeat(RUN6_CLAIM)] },
        { title: "Two", beats: [tapeBeat("Tape B plays.", TAPE_B)] }
      ]
    };
    const before = await evidence.prefetch([act], ctx, { concurrency: 2 });
    expect(before.pages).toBe(3);
    expect(before.prefetched).toBe(3);
    expect(inner.seen.find((b) => b.claim === RUN6_CLAIM)?.adjacentTape).toEqual({ previous: TAPE_A, next: TAPE_B });
    expect(evidenceBeatsFor(act.slots[0]!, slotNeighbours(act, 0))[1]).toEqual(evidenceBeatFor(act.slots[0]!, 1, "Carry", slotNeighbours(act, 0)));

    const writer = pageWriter(() => ({ claims: [CLAIM_ON_A], script: RUN6_HINGE }));
    await writeNarration([act], { writer, verifier: approvingVerifier(), evidence }, voice, ctx);
    expect(inner.seen).toHaveLength(3);
    const after = evidence.metrics();
    expect(after.narrationGathers).toBe(3);
    expect(after.narrationHits).toBe(3);
    expect(after.hitRate).toBe(1);
  });
});

describe("F-82 — the four run-6 pages become acceptable with the right tape source", () => {
  /* Each claim as the deepen stage wrote it, the window of the segment that
     said it, and the Hinge a writer makes of it inside the 50–135 band. */
  const RUN6: Array<{ claim: string; window: string; hinge: string; claimText: string }> = [
    {
      claim: RUN6_CLAIM,
      window: WINDOW_A,
      hinge: RUN6_HINGE,
      claimText: SOURCE_A.claimText
    },
    {
      claim: "An engineer described buying a small robot and using a simulator to train it before it touched the real world.",
      window: WINDOW_B,
      hinge: "An engineer described buying a small robot and testing it in a simulator first. Listen for what changed in the real world.",
      claimText: "the engineer bought a small robot and ran everything in a simulator before letting it touch anything"
    },
    {
      claim: "None of these are modeling decisions — they're procurement, systems, and packaging decisions.",
      window:
        "And none of these are modeling decisions, right? They're procurement decisions, they're systems decisions, they're packaging decisions. " +
        "Who signs the contract, what runs where, how it ships to the customer.",
      hinge: "None of those were modeling decisions — they were procurement, systems and packaging. Keep that in mind as the tape continues.",
      claimText: "the speaker says the decisions are procurement, systems and packaging decisions, not modeling ones"
    },
    {
      claim: "One data-education program ran 88 projects with roughly 60 different companies over its life.",
      window:
        "We ran eighty-eight projects over the life of the program with roughly sixty different companies, and every single one of them " +
        "taught us something about what a partner actually needs from a data team.",
      hinge: "One data-education program ran 88 projects with roughly 60 companies. Listen for what that many partners taught them.",
      claimText: "the program ran eighty-eight projects with roughly sixty companies"
    }
  ];

  it("each of the four, as a content beat after the segment it restates, is written as a Hinge citing that segment and verified; tapeCitedPages counts all four and unverifiedPages is 0", async () => {
    /* MUTATION THAT KILLS THIS: any of the above — no neighbouring window,
       no re-mode to Hinge, no tape source on a Hinge — leaves at least one
       of the four as the placeholder run 6 shipped, and the gate refuses. */
    const segments = RUN6.map((r, i) => ({ ...r, tape: pointer(`practical-ai--run6-${i}#100`, `practical-ai--run6-${i}`, 100), title: `Practical AI — run 6 segment ${i}` }));
    const acts: SourcedAct[] = [
      { title: "Act", slots: segments.map((s, i) => ({ title: `Slot ${i}`, beats: [tapeBeat(`Tape ${i} plays.`, s.tape), carryBeat(s.claim)] })) }
    ];
    const evidence: EvidenceGatherer = {
      async gather(beat) {
        const docs: EvidenceDoc[] = [];
        const own = beat.tape && segments.find((s) => s.tape.segmentId === beat.tape!.segmentId);
        if (own) docs.push({ docId: tapeDocIdFor(own.tape.segmentId), kind: "tape", title: own.title, text: own.window, tapePosition: "next" });
        const prev = beat.adjacentTape?.previous && segments.find((s) => s.tape.segmentId === beat.adjacentTape!.previous!.segmentId);
        if (prev && !docs.some((d) => d.docId === tapeDocIdFor(prev.tape.segmentId))) {
          docs.push({ docId: tapeDocIdFor(prev.tape.segmentId), kind: "tape", title: prev.title, text: prev.window, tapePosition: "previous" });
        }
        return { purpose: beat.claim, beatKind: "account", docs };
      }
    };
    const writer = pageWriter((brief) => {
      const s = segments.find((x) => x.claim === brief.purpose);
      if (s) return { claims: [{ claimText: s.claimText, quote: "", docId: tapeDocIdFor(s.tape.segmentId), contested: false }], script: s.hinge };
      // The Frames: describe the segment they introduce, citing it.
      const own = brief.evidence.docs.find((d) => d.tapePosition === "next")!;
      return { claims: [{ claimText: "the segment is a speaker on the subject", quote: "", docId: own.docId, contested: false }], script: "Here is a voice from the same conversation, on what comes next. Listen for where they land." };
    });
    const written = await writeNarration(acts, { writer, verifier: approvingVerifier(), evidence }, voice, ctx);

    for (const [i, s] of segments.entries()) {
      const beat = written[0]!.slots[i]!.beats[1]!;
      const page = beat.sourcing === "narration" ? beat.narration : undefined;
      expect(page?.mode, s.claim).toBe("Hinge");
      expect(page?.script, s.claim).toBe(s.hinge);
      expect(page?.verified, s.claim).toBe(true);
      expect(page?.sources, s.claim).toEqual([{ kind: "tape", segmentId: s.tape.segmentId, claimText: s.claimText, publication: s.title, contested: false }]);
      expect(validateNarratedBeat(page!, { heldDocs: page!.evidence }).issues).toEqual([]);
    }
    expect(computeUnverifiedPages(written).count).toBe(0);
    // The four Hinges and the four Frames all cite tape.
    expect(computeTapeCitedPages(written)).toBe(8);
    const veracity = buildVeracityMetrics({ sourcedActs: acts, tapeRelevanceRows: [], writtenActs: written, topic: "t", writerCalls: 8, verifierCalls: 4, pipelineTokens: 0, stageTimings: [] });
    expect(veracity.tapeCitedPages).toBe(8);
    expect(veracity.unverifiedPages).toBe(0);
  });

  it("tapeCitedPages counts a page once however many tape sources it carries, and never counts a print-only page", () => {
    /* MUTATION THAT KILLS THIS: count sources instead of pages. */
    const acts: WrittenAct[] = [
      {
        title: "Act",
        slots: [
          {
            title: "Slot",
            beats: [
              { sourcing: "narration", claim: "a", exploration: false, narration: hinge({ sources: [SOURCE_A, { ...SOURCE_A, segmentId: SEGMENT_B, publication: TITLE_B }] }) },
              { sourcing: "narration", claim: "b", exploration: false, narration: hinge({ mode: "Carry", script: RUN6_HINGE.repeat(7), sources: [{ claimText: "c", quote: "eight words of a held print document here", publication: "P", contested: false }] }) },
              { sourcing: "tape", claim: "c", exploration: false, tape: TAPE_A }
            ]
          }
        ]
      }
    ];
    expect(computeTapeCitedPages(acts)).toBe(1);
  });
});

describe("F-82 — the prompts say what the code enforces", () => {
  const brief = {
    pageId: "p1",
    purpose: RUN6_CLAIM,
    mode: "Hinge" as const,
    evidence: { purpose: RUN6_CLAIM, beatKind: "account" as const, docs: [DOC_A, DOC_B] }
  };

  it("the selection prompt marks each window by where it plays and states the rule: a restatement of the tape is cited to the tape, never to print, never to nothing", () => {
    /* MUTATION THAT KILLS THIS: drop the F-82 rule line or the
       BEFORE/AFTER notes — the writer goes on citing an outside
       publication, or nothing, for what the tape said. */
    const prompt = buildSelectionPrompt({ slotTitle: "Slot", voice, pages: [brief] });
    expect(prompt).toContain(`docId: ${DOC_A.docId} | ${TITLE_A} | TAPE that plays just BEFORE this page — may be cited as a whole (quote optional)`);
    expect(prompt).toContain(`docId: ${DOC_B.docId} | ${TITLE_B} | TAPE that plays just AFTER this page (the segment this page introduces) — may be cited as a whole (quote optional)`);
    expect(prompt).toMatch(/restates, summarises or attributes what the tape said .* it MUST cite that tape/);
    expect(prompt).toContain("Never back a restatement of the tape with an outside publication");
    expect(prompt).toContain("a restatement with no tape citation is exactly what gets the page rejected");
    // A content page is told the window is context, not a source it may cite as tape.
    const carry = buildSelectionPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, mode: "Carry" }] });
    expect(carry).toContain("TAPE that plays just BEFORE this page — context; this page stands on print");
    expect(carry).not.toContain("may be cited as a whole");
  });

  it("the verifier is told which side of the page a tape source's segment plays on, and to judge it against that window and not the other", () => {
    /* MUTATION THAT KILLS THIS: render every tape source as "the segment
       this page introduces" — a verifier handed two windows would judge a
       restatement of A against B. */
    const prompt = buildVerifyPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, script: RUN6_HINGE, sources: [SOURCE_A] }] });
    expect(prompt).toContain(`[TAPE — the segment that plays just BEFORE this page, ${SEGMENT_A}]`);
    expect(prompt).toContain("not against any other window this page holds");
    expect(prompt).toContain("a restatement of the tape with no tape source is unsupported");
    expect(prompt.indexOf(WINDOW_A)).toBeGreaterThan(prompt.indexOf("Holding document for this source"));
    const onB = buildVerifyPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, script: RUN6_HINGE, sources: [{ ...SOURCE_A, segmentId: SEGMENT_B, publication: TITLE_B }] }] });
    expect(onB).toContain(`[TAPE — the segment that plays just AFTER this page (the one it introduces), ${SEGMENT_B}]`);
  });
});
