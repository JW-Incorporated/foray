import { describe, it, expect } from "vitest";
import {
  writeNarration,
  allWrittenNarration,
  adjacentTapeFor,
  evidenceBeatFor,
  gateSelectedClaims,
  slotNeighbours,
  type WrittenAct
} from "../src/generation/writeNarration";
import { PrefetchingEvidenceGatherer, evidenceBeatsFor, evidenceMemoKey } from "../src/generation/evidencePrefetch";
import { buildVeracityMetrics, computeTapeCitedPages, computeUnverifiedPages } from "../src/generation/veracityMetrics";
import { buildActVerifyPrompt } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { buildActWritePrompt } from "../src/generation/AnthropicNarrationWriterBuilder";
import { DefaultEvidenceGatherer } from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, SelectedClaim } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest } from "../src/generation/NarrationVerifierBuilder";
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

/**
 * The act path with a hook on what the writer says (F-100). The per-page
 * writer this file used to script is gone with the per-slot path; the stub
 * builders are what `--dry-run` runs, and `mutate` puts the one fault each
 * test is about into the seam's reply. `seamFor` picks the seam that
 * carries a given beat's claim, so a test can answer for one seam and
 * leave the rest of the act alone.
 */
function actBuilders(mutate?: (reply: ActWriteResult, request: ActWriteRequest, round: number) => ActWriteResult) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { write: 0, verify: 0 };
  const requests: ActWriteRequest[] = [];
  const verifyRequests: ActVerifyRequest[] = [];
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    calls.write++;
    requests.push(request);
    const reply = await realWrite(request, buildCtx);
    return mutate ? mutate(reply, request, calls.write) : reply;
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    verifyRequests.push(request);
    return realVerify(request, buildCtx);
  };
  return { writer, verifier, calls, requests, verifyRequests };
}

/**
 * Answers for the seam carrying `claim`, leaving every other seam as the
 * stub wrote it — and, by default, leaving that seam's SCRIPT as the stub
 * wrote it too. The seam that carries a content beat usually also
 * introduces the next clip, and a replacement script that does not name
 * the show is refused by Q-02's Intro rule for a reason that has nothing
 * to do with the rule under test. What these tests need to control is the
 * CLAIMS, which is what the quote gate reads.
 */
function forSeamCarrying(
  reply: ActWriteResult,
  request: ActWriteRequest,
  claim: string,
  answer: { claims: SelectedClaim[]; script?: string }
): ActWriteResult {
  const seamId = request.seams.find((s) => s.beats.some((b) => b.claim === claim))?.seamId;
  return {
    seams: reply.seams.map((s) =>
      s.seamId === seamId
        ? { ...s, claims: answer.claims, usedClaims: answer.claims.map((_, i) => i), ...(answer.script ? { script: answer.script } : {}) }
        : s
    )
  };
}

/** What the writer was told to fix on the round after a refusal. */
function refusalOn(requests: ActWriteRequest[], round: number): string {
  const request = requests[round - 1];
  if (!request) return "";
  return [request.retryNote ?? "", ...request.seams.map((s) => s.notes ?? "")].join(" ");
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
    const page = { pageId: "p1", beatIndex: 1, claim: RUN6_CLAIM, mode: "Hinge" as const, evidence: { purpose: RUN6_CLAIM, beatKind: "account" as const, docs: [DOC_A, DOC_B] } };
    const gate = gateSelectedClaims([{ ...CLAIM_ON_A, docId: DOC_B.docId, quote: "the model choice comes last" }], page);
    expect(gate.valid).toEqual([]);
    expect(gate.issues[0]).toContain(`it is spoken in the other window this page holds, "${DOC_A.docId}" (the segment that plays just before this page)`);
    expect(gateSelectedClaims([{ ...CLAIM_ON_A, quote: "the model choice comes last" }], page).issues).toEqual([]);
  });
});

describe("F-82 — writeNarration: the run-6 page cites the tape beside it", () => {
  it("citing the next segment for the previous one's words is refused in code, the note names the right window, and the corrected page is verified", async () => {
    /* MUTATION THAT KILLS THIS: accept a tape echo found in ANY held
       window. The first attempt would pass with the wrong segment cited.

       PORTED (F-100): the per-page path read the rejection off the
       writer's next per-page `retryNote`; the act path reads it off the
       seam's `notes`. `gateSelectedClaims` is the same function. */
    const { writer, verifier, requests } = actBuilders((reply, request, round) =>
      forSeamCarrying(reply, request, RUN6_CLAIM, {
        claims: [{ ...CLAIM_ON_A, ...(round === 1 ? { docId: DOC_B.docId } : {}), quote: "the model choice comes last" }]
      })
    );
    const written = await writeNarration(betweenTape(), { writer, verifier, evidence: neighbourGatherer() }, voice, ctx);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    /* `tapeWindowHolding` names the window that DOES say the phrase, which
       is the half of the note the writer acts on. The positional suffix
       ("the segment that plays just before this page") is a per-page
       reading: the act's documents are deduplicated act-wide and carry no
       per-page position, so the act path says "beside this page". */
    expect(refusalOn(requests, 2)).toContain(`it is spoken in the other window this page holds, "${DOC_A.docId}"`);
    /* The page that carries the ECHO — not the Intro before clip A, which
       cites the same window as a whole with no quote of its own. */
    const page = allWrittenNarration(written).find((p) => p.sources.some((s) => isTapeSource(s) && s.quote === "the model choice comes last"))!;
    expect(page, "no page carries the corrected echo").toBeDefined();
    expect(page.verified).toBe(true);
    expect(page.sources).toContainEqual(expect.objectContaining({ kind: "tape", segmentId: SEGMENT_A, quote: "the model choice comes last" }));
  });

  it("a page between two episodes holds the previous window too and may cite it — the act's documents say which is which", async () => {
    /* MUTATION THAT KILLS THIS: build a page's pack from `beat.tape`
       alone. A page closing what A said then has no citable A. */
    const backToBack: SourcedAct[] = [{ title: "Act", slots: [{ title: "Slot", beats: [tapeBeat("Tape A plays.", TAPE_A), tapeBeat("Tape B plays.", TAPE_B)] }] }];
    const { writer, verifier, requests } = actBuilders((reply, request, round) => {
      /* The seam that plays between the two clips — the one introducing B
         — cites what A said. */
      const between = request.seams.find((s) => s.introduces !== undefined && s.follows !== undefined)?.seamId;
      if (round > 1) return reply;
      return { seams: reply.seams.map((s) => (s.seamId === between ? { ...s, claims: [...s.claims, CLAIM_ON_A], usedClaims: [...s.claims, CLAIM_ON_A].map((_, i) => i) } : s)) };
    });
    const written = await writeNarration(backToBack, { writer, verifier, evidence: neighbourGatherer() }, voice, ctx);
    /* Both windows reach the act under the tape docId convention — which
       is what makes a citation of A legal in the page that plays between
       A and B. */
    const docs = requests[0]!.documents.filter((doc) => doc.kind === "tape").map((doc) => doc.docId);
    expect(docs).toContain(DOC_A.docId);
    expect(docs).toContain(DOC_B.docId);
    const page = allWrittenNarration(written).find((p) => p.sources.some((s) => isTapeSource(s) && s.segmentId === SEGMENT_A));
    expect(page, "no page cites the segment that played before it").toBeDefined();
    expect(page!.verified).toBe(true);
  });

  it("a content beat that DID find print rests on the print: a claim on a print document is the print shape, beside the windows it also holds", async () => {
    /* MUTATION THAT KILLS THIS: key `sourcesFor` on nothing but the
       docId prefix — a print claim on a page that also holds windows
       would come back tape-shaped.

       PORTED with its assertion about MODE dropped: F-97 assigns a
       seam's mode after writing, from what it rests on, so "stays a
       Carry" is no longer a rule anyone can state before the verifier
       answers. `isTapeClaim`'s mode rule is pinned directly in
       frameTapeSource.test.ts. */
    const eightWords = "Organisations that inventory their existing skills before buying tools";
    const { writer, verifier, requests } = actBuilders((reply, request) =>
      forSeamCarrying(reply, request, RUN6_CLAIM, {
        claims: [{ claimText: "organisations that inventory skills first abandon fewer platforms", quote: eightWords, docId: PRINT.docId, contested: false }]
      })
    );
    const written = await writeNarration(betweenTape(), { writer, verifier, evidence: neighbourGatherer([PRINT]) }, voice, ctx);
    expect(requests[0]!.documents.map((doc) => doc.docId)).toEqual([DOC_A.docId, DOC_B.docId, PRINT.docId]);
    const page = allWrittenNarration(written).find((p) => p.sources.some((s) => !isTapeSource(s)))!;
    expect(page.verified).toBe(true);
    expect(page.sources.find((s) => !isTapeSource(s))).toMatchObject({ quote: eightWords, publication: PRINT.title });
  });

  it("the dry-run path writes the run-6 shape end to end: stub writer, stub verifier, a seam page recorded as the Frame it is, with a tape source on the previous segment", async () => {
    /* MUTATION THAT KILLS THIS: have the stub writer's first legal span
       come from a window the page does not hold, or key the neighbouring
       window under a docId `sourcesFor` does not recognise as tape. Since
       Q-03 the dry-run path writes per act: the content beat between two
       clips is a seam page, tape-citable whatever the mode (`tapeCitable`),
       so F-82's Hinge rewrite is not needed to cite the segment that just
       played. Since F-97 the mode is assigned AFTER writing from what the
       seam rests on: this seam rests on tape only and plays into clip B, so
       it is recorded as a Frame — not the Carry its beat was planned as. */
    const written = await writeNarration(
      betweenTape("The host argued that the mix of skills in the organization decides the tools, and the model choice comes last."),
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence: neighbourGatherer() },
      voice,
      ctx
    );
    const beat = written[0]!.slots[0]!.beats[1]!;
    const page = beat.sourcing === "narration" ? beat.narration : undefined;
    expect(page?.mode).toBe("Frame");
    expect(page?.verified).toBe(true);
    /* The seam both introduces clip B (a tape source on B's window, Q-02)
       and restates clip A; the run-6 property is the source on A. */
    expect(page?.sources).toContainEqual(expect.objectContaining({ kind: "tape", segmentId: SEGMENT_A, publication: TITLE_A }));
  });
});

describe("F-82 — the prefetch stage gathers the same documents, so the hit rate stays 1", () => {
  it("prefetch then narration: every gather is a memo hit, the wrapped gatherer is asked once per page, and the Carry's beat carries its neighbours", async () => {
    /* MUTATION THAT KILLS THIS: leave the neighbours out of
       `evidenceBeatsFor` (or out of the gather `writeAct` asks for) — the
       keys differ on `adjacentTape`, narration misses on every
       tape-adjacent page, and the wrapped gatherer is asked again. */
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

    const { writer, verifier } = actBuilders();
    await writeNarration([act], { writer, verifier, evidence }, voice, ctx);
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

  it("each of the four, as a content beat after the segment it restates, cites that segment and is verified; unverifiedPages is 0 and every page is tape-cited", async () => {
    /* MUTATION THAT KILLS THIS: any of the above — no neighbouring window,
       no tape source on a page whose claim is what the tape said — leaves
       at least one of the four as the placeholder run 6 shipped, and the
       gate refuses.

       PORTED (F-100) from the per-page writer to the act path. The
       assertion about each page's MODE is gone rather than translated:
       F-97 assigns a seam's mode after writing from what it rests on, so
       "is written as a Hinge" is not a property the writer decides any
       more. What the run-6 finding was actually about — the page cites
       the segment whose words it restates, and the gate stops refusing —
       is asserted unchanged. */
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
    const { writer, verifier } = actBuilders((reply, request) => {
      let out = reply;
      for (const s of segments) {
        out = forSeamCarrying(out, request, s.claim, {
          claims: [{ claimText: s.claimText, quote: "", docId: tapeDocIdFor(s.tape.segmentId), contested: false }]
        });
      }
      return out;
    });
    const written = await writeNarration(acts, { writer, verifier, evidence }, voice, ctx);

    for (const s of segments) {
      const page = allWrittenNarration(written).find((p) =>
        p.sources.some((source) => isTapeSource(source) && source.segmentId === s.tape.segmentId && source.claimText === s.claimText)
      );
      expect(page, s.claim).toBeDefined();
      expect(page!.verified, s.claim).toBe(true);
    }
    expect(computeUnverifiedPages(written).count).toBe(0);
    expect(computeTapeCitedPages(written)).toBe(allWrittenNarration(written).length);
    const veracity = buildVeracityMetrics({ sourcedActs: acts, tapeRelevanceRows: [], writtenActs: written, topic: "t", writerCalls: 8, verifierCalls: 4, pipelineTokens: 0, stageTimings: [] });
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
  /* PORTED to the per-act prompts (F-100). The rule is the same: a
     restatement of what the tape said is cited to that tape, never to an
     outside publication and never to nothing, and the verifier judges it
     against the window it names. */
  const clipA = { clipId: "c0", segmentId: SEGMENT_A, itemId: ITEM_A, docId: DOC_A.docId, show: "Practical AI", title: "Skills over models", durationSec: 160, opening: WINDOW_A.slice(0, 60), intro: "full" as const };
  const clipB = { clipId: "c1", segmentId: SEGMENT_B, itemId: ITEM_B, docId: DOC_B.docId, show: "Practical AI", title: "A robot in a simulator", durationSec: 160, opening: WINDOW_B.slice(0, 60), intro: "full" as const };
  const seam = {
    seamId: "s0",
    beats: [{ beatId: "b0", claim: RUN6_CLAIM, mode: "Carry" as const, kind: "account" as const }],
    follows: "c0",
    introduces: "c1",
    intro: "full" as const,
    band: [340, 765] as [number, number]
  };

  it("the writer prompt states the rule: a statement about a clip rests on that clip's window, never on an outside publication", () => {
    /* MUTATION THAT KILLS THIS: drop the clip-citation rule lines — the
       writer goes on citing an outside publication, or nothing, for what
       the tape said, which is run 6. */
    const prompt = buildActWritePrompt({ actTitle: "Act", voice, seams: [seam], clips: [clipA, clipB], documents: [DOC_A, DOC_B] });
    expect(prompt).toContain(`docId: ${DOC_A.docId} | ${TITLE_A} | TRANSCRIPT WINDOW of a clip (cite it for statements about that clip)`);
    expect(prompt).toContain(`docId: ${DOC_B.docId} | ${TITLE_B} | TRANSCRIPT WINDOW of a clip (cite it for statements about that clip)`);
    expect(prompt).toMatch(/A statement about a CLIP — what it is about, who is speaking, what was said in it — rests on that clip's transcript window/);
    expect(prompt).toContain("Never back a statement about a clip with an outside publication.");
  });

  it("the verifier prompt prints each clip's own window under that clip, so a statement about A is judged against A", () => {
    /* MUTATION THAT KILLS THIS: print the windows as one undifferentiated
       block — a verifier handed two windows would judge a restatement of
       A against B. */
    const prompt = buildActVerifyPrompt({
      actTitle: "Act",
      voice,
      beats: [{ beatId: "b0", claim: RUN6_CLAIM, mode: "Carry", kind: "account" }],
      sources: [
        { id: "c0", kind: "clip", claimText: "clip A's window", publication: TITLE_A, docId: DOC_A.docId, contested: false },
        { id: "c1", kind: "clip", claimText: "clip B's window", publication: TITLE_B, docId: DOC_B.docId, contested: false }
      ],
      seams: [
        { seamId: "sA", script: "First, a host on skills and tools.", selected: [], carries: [], introduces: "c0", intro: "full" },
        { seamId: "s0", script: RUN6_HINGE, selected: ["c0"], carries: ["b0"], follows: "c0", introduces: "c1", intro: "full" }
      ],
      clips: [
        { ...clipA, windowText: WINDOW_A },
        { ...clipB, windowText: WINDOW_B }
      ],
      documents: [DOC_A, DOC_B]
    });
    expect(prompt).toContain(WINDOW_A);
    expect(prompt).toContain(WINDOW_B);
    /* Each window sits under the CLIP line that names its segment, which
       is what tells the verifier which one a source means. */
    expect(prompt.indexOf(WINDOW_A)).toBeGreaterThan(prompt.indexOf(`CLIP ${clipA.clipId}`));
    expect(prompt.indexOf(WINDOW_B)).toBeGreaterThan(prompt.indexOf(`CLIP ${clipB.clipId}`));
    /* And each window is printed ONCE, under the clip it belongs to: a
       second copy anywhere else is how a verifier comes to judge a
       statement about A against B. */
    expect(prompt.split(WINDOW_A)).toHaveLength(2);
    expect(prompt.split(WINDOW_B)).toHaveLength(2);
  });
});
