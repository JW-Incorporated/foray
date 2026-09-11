import { describe, it, expect } from "vitest";
import { writeNarration, allWrittenNarration, isTapeClaim, sourcesFor, type WrittenAct } from "../src/generation/writeNarration";
import { computeGroundedQuoteRate } from "../src/generation/veracityMetrics";
import { buildVerifyPrompt } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { buildSelectionPrompt } from "../src/generation/AnthropicNarrationWriterBuilder";
import { DefaultEvidenceGatherer } from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { canonicalizeForAnchorMatch as fromLookup } from "../src/generation/transcriptArchiveLookup";
import { canonicalizeForAnchorMatch, phraseIsInWindow } from "../src/types/anchorText";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type {
  ClaimSelectionRequest,
  ClaimSelectionResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  ProseWriteRequest,
  ProseWriteResult,
  SelectedClaim
} from "../src/generation/NarrationWriterBuilder";
import type { NarrationVerifierBuilder, NarrationVerifyRequest, NarrationVerifyResult } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import {
  SourceSchema,
  TAPE_SOURCE_MODES,
  hasDeclarativeSentence,
  isTapeSource,
  modeMayCiteTape,
  segmentIdOfTapeDoc,
  tapeDocIdFor,
  validateNarratedBeat,
  type NarratedBeat,
  type NarrationMode,
  type Source,
  type TapeSource
} from "../src/types/narration";
import type { SourcedAct } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * F-81 (generation run 5, 2026-09-11): eight Frame pages — the short
 * narration that introduces a tape segment — were rejected three times for
 * "declares no sources but its script states something about the world"
 * (F-36/F-37/F-44) and dropped, so the tape entered on silence. A Frame
 * that introduces a segment is describing that segment, and the tape IS
 * its source. This suite pins the rule as implemented:
 *
 *   - a Frame/Hinge/Marker may declare `{kind: "tape", segmentId, quote?}`;
 *   - the mechanical gate accepts it when the segment's transcript window
 *     is held and the quote, if any, is spoken in that window under the
 *     anchor canonicalisation (no eight-word floor — nothing rests on it);
 *   - the verifier is handed the window as the holding document;
 *   - a page with NO source that states a fact is refused exactly as
 *     before, and a content page may not cite tape at all.
 *
 * Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* The run-5 segment shape: a Practical AI episode the sourcing stage
   placed, with a ±90 s window the cue provider held. The apostrophe in
   "drivers' dashcams" is deliberate — it is what the anchor
   canonicalisation forgives and the print quote rule does not. */
const SEGMENT_ID = "practical-ai--open-source-self-driving-with-comma-ai#1210";
const WINDOW_TEXT =
  "So what we did at comma is we said, okay, we're not going to write the rules for driving. " +
  "We're going to take the video from tens of thousands of drivers' dashcams, and we're going to train a network end to end on that. " +
  "And the first thing you notice is that it doesn't drive like the rule-based stack did. It drives like the people it learned from.";
const TAPE_DOC: EvidenceDoc = {
  docId: tapeDocIdFor(SEGMENT_ID),
  kind: "tape",
  title: "Practical AI — Open source self-driving with comma.ai",
  text: WINDOW_TEXT
};

/* A Frame in the run-5 shape: it says what the segment is about and who
   is speaking, in the Frame band (70–170 characters), and every sentence
   is declarative — which is exactly what F-36/F-37/F-44 refuses without a
   source, and what run 5 refused eight times. */
const RUN5_FRAME =
  "Here is an engineer at comma on why their open-source stack learned to drive from thousands of dashcams, not from hand-written rules.";

const TAPE_SOURCE: TapeSource = {
  kind: "tape",
  segmentId: SEGMENT_ID,
  claimText: "the segment is a comma engineer explaining that the stack learned to drive from dashcam video rather than written rules",
  publication: TAPE_DOC.title,
  contested: false
};

function frame(overrides: Partial<NarratedBeat> = {}): NarratedBeat {
  return { mode: "Frame", script: RUN5_FRAME, sources: [TAPE_SOURCE], pronunciationHints: [], verified: true, ...overrides };
}

function tapeAct(claim: string): SourcedAct[] {
  return [
    {
      title: "Act",
      slots: [
        {
          title: "Slot",
          beats: [
            {
              sourcing: "tape",
              claim,
              exploration: false,
              tape: {
                segmentId: SEGMENT_ID,
                itemId: "practical-ai--open-source-self-driving-with-comma-ai",
                startSec: 1210,
                endSec: 1360,
                startAnchor: "so what we did at comma",
                endAnchor: "like the people it learned from",
                tier: 1,
                confidence: "high"
              }
            }
          ]
        }
      ]
    }
  ];
}

function windowGatherer(docs: EvidenceDoc[] = [TAPE_DOC]): EvidenceGatherer {
  return {
    async gather(beat): Promise<EvidencePack> {
      return {
        purpose: beat.claim,
        beatKind: "account",
        docs: [...docs],
        tape: { itemId: "practical-ai--open-source-self-driving-with-comma-ai", showTitle: "Practical AI", episodeTitle: "Open source self-driving with comma.ai", startSec: 1210, endSec: 1360 }
      };
    }
  };
}

/** A writer replaying one canned answer per attempt for the slot's one page. */
function scriptedWriter(
  attempts: Array<{ claims: SelectedClaim[]; script?: string }>
): NarrationWriterBuilder & { selectCalls: number; writeCalls: number; retryNotes: Array<string | undefined> } {
  const w = {
    providerName: "scripted",
    selectCalls: 0,
    writeCalls: 0,
    retryNotes: [] as Array<string | undefined>,
    async selectClaims(request: ClaimSelectionRequest): Promise<ClaimSelectionResult> {
      w.retryNotes.push(request.pages[0]?.retryNote);
      const turn = attempts[Math.min(w.selectCalls, attempts.length - 1)]!;
      w.selectCalls++;
      return { pages: request.pages.map((p) => ({ pageId: p.pageId, claims: turn.claims })) };
    },
    async writePages(request: ProseWriteRequest): Promise<ProseWriteResult> {
      const turn = attempts[Math.min(w.writeCalls, attempts.length - 1)]!;
      w.writeCalls++;
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          script: turn.script ?? RUN5_FRAME,
          usedClaims: p.claims.map((_, i) => i),
          pronunciationHints: []
        }))
      };
    }
  };
  return w;
}

function recordingVerifier(): NarrationVerifierBuilder & { calls: number; seen: NarrationVerifyRequest[] } {
  const v = {
    providerName: "recording",
    calls: 0,
    seen: [] as NarrationVerifyRequest[],
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.calls++;
      v.seen.push(request);
      return { pages: request.pages.map((p) => ({ pageId: p.pageId, claimsSupported: true, purposeAccomplished: true, contestedHandled: true })) };
    }
  };
  return v;
}

const TAPE_CLAIM: SelectedClaim = { claimText: TAPE_SOURCE.claimText, quote: "", docId: TAPE_DOC.docId, contested: false };

describe("F-81 — the structural validator: a Frame's source is the tape it introduces", () => {
  it("a Frame stating what the tape says passes with a tape source and no quote", () => {
    /* MUTATION THAT KILLS THIS: drop the `isTapeSource` branch in
       `validateNarratedBeat`, so the print rules run on a source with no
       quote and reject it as not held. */
    expect(hasDeclarativeSentence(RUN5_FRAME)).toBe(true);
    const result = validateNarratedBeat(frame(), { heldDocs: [TAPE_DOC], purposeText: "Hand the listener into the comma segment." });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("a tape source may echo a phrase of the tape — fewer than eight words, apostrophe and punctuation forgiven", () => {
    /* MUTATION THAT KILLS THIS: run `quote-too-short` or the print
       `findHoldingDoc` (which keeps apostrophes) on a tape source. The
       phrase is six words and differs from the window by an apostrophe. */
    const echoed = frame({ sources: [{ ...TAPE_SOURCE, quote: "tens of thousands of drivers dashcams" }] });
    const result = validateNarratedBeat(echoed, { heldDocs: [TAPE_DOC] });
    expect(result.issues.map((i) => i.code)).toEqual([]);
  });

  it("a Frame with NO source stating a fact is still refused (F-36/F-37/F-44 is not loosened)", () => {
    /* MUTATION THAT KILLS THIS: exempt Frame from `sources-empty-with-claims`. */
    const result = validateNarratedBeat(frame({ sources: [] }), { heldDocs: [TAPE_DOC] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "sources-empty-with-claims")).toBe(true);
  });

  it("a tape source whose quote is not spoken in the window is refused", () => {
    /* MUTATION THAT KILLS THIS: skip the `phraseIsInWindow` check when a
       quote is present — the whole point of an echo is that the tape said
       it (narration-craft.md §3i). */
    const result = validateNarratedBeat(frame({ sources: [{ ...TAPE_SOURCE, quote: "learned to drive from hand-written rules" }] }), { heldDocs: [TAPE_DOC] });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === "quote-not-held");
    expect(issue?.message).toMatch(/not spoken in the transcript window/);
  });

  it("a tape source whose window is not among the held documents is refused", () => {
    /* MUTATION THAT KILLS THIS: look the window up by title, or accept a
       tape source whenever ANY tape document is held. */
    const other: EvidenceDoc = { ...TAPE_DOC, docId: tapeDocIdFor("some-other-episode#40") };
    expect(validateNarratedBeat(frame(), { heldDocs: [] }).issues.map((i) => i.code)).toContain("tape-window-not-held");
    expect(validateNarratedBeat(frame(), { heldDocs: [other] }).issues.map((i) => i.code)).toContain("tape-window-not-held");
    // No held documents at all (a caller with no pack): the rule degrades
    // the way the print rules do — nothing to check, nothing refused.
    expect(validateNarratedBeat(frame()).issues).toEqual([]);
  });

  it("a tape source's publication is still read off the document, never written", () => {
    /* MUTATION THAT KILLS THIS: drop the publication comparison for tape
       sources — F-30's slug would be a publication again. */
    const result = validateNarratedBeat(frame({ sources: [{ ...TAPE_SOURCE, publication: "practical-ai--open-source-self-driving-with-comma-ai" }] }), {
      heldDocs: [TAPE_DOC]
    });
    expect(result.issues.map((i) => i.code)).toContain("publication-not-held");
  });

  it.each(["Patch", "Carry", "Correction"] as NarrationMode[])("a %s may not cite tape — it carries content or corrects, and cites print", (mode) => {
    /* MUTATION THAT KILLS THIS: widen `TAPE_SOURCE_MODES`, or skip the
       mode rule in `validateTapeSource`. */
    expect(modeMayCiteTape(mode)).toBe(false);
    const result = validateNarratedBeat(frame({ mode, script: RUN5_FRAME.repeat(3) }), { heldDocs: [TAPE_DOC] });
    expect(result.issues.map((i) => i.code)).toContain("tape-source-on-content-page");
  });

  it("exactly Frame, Hinge and Marker may cite tape", () => {
    expect([...TAPE_SOURCE_MODES].sort()).toEqual(["Frame", "Hinge", "Marker"]);
    for (const mode of TAPE_SOURCE_MODES) expect(modeMayCiteTape(mode)).toBe(true);
  });

  it("SourceSchema accepts both shapes and refuses a tape source with no segment or a print source with a kind", () => {
    /* MUTATION THAT KILLS THIS: make `segmentId` optional, or loosen
       either object off `.strict()`. */
    const print: Source = { claimText: "c", quote: "eight words of a held print document here", publication: "P", contested: false };
    expect(SourceSchema.safeParse(print).success).toBe(true);
    expect(SourceSchema.safeParse(TAPE_SOURCE).success).toBe(true);
    expect(SourceSchema.safeParse({ ...TAPE_SOURCE, quote: "it drives like the people" }).success).toBe(true);
    const noSegment: Record<string, unknown> = { ...TAPE_SOURCE };
    delete noSegment.segmentId;
    expect(SourceSchema.safeParse(noSegment).success).toBe(false);
    expect(SourceSchema.safeParse({ ...print, kind: "print" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...print, quote: "" }).success).toBe(false);
    expect(isTapeSource(print)).toBe(false);
    expect(isTapeSource(TAPE_SOURCE)).toBe(true);
  });

  it("the docId convention round-trips, and is the one the evidence gatherer builds", () => {
    /* MUTATION THAT KILLS THIS: change the prefix in one place only. */
    expect(tapeDocIdFor(SEGMENT_ID)).toBe(`tape:${SEGMENT_ID}`);
    expect(segmentIdOfTapeDoc(tapeDocIdFor(SEGMENT_ID))).toBe(SEGMENT_ID);
    expect(segmentIdOfTapeDoc("print:abc-1")).toBeNull();
    expect(segmentIdOfTapeDoc("tape:")).toBeNull();
  });
});

describe("F-81 — the anchor canonicalisation is the quote matcher for tape", () => {
  it("phraseIsInWindow matches whole words only, with the same canonical form §4.5 mints anchors with", () => {
    /* MUTATION THAT KILLS THIS: a bare `includes` without word padding
       ("drivers dash" would match inside "drivers' dashcams"), or a second
       canonicaliser that keeps apostrophes. */
    expect(phraseIsInWindow("tens of thousands of drivers dashcams", WINDOW_TEXT)).toBe(true);
    expect(phraseIsInWindow("Drivers' dashcams, and we're going", WINDOW_TEXT)).toBe(true);
    expect(phraseIsInWindow("drivers dash", WINDOW_TEXT)).toBe(false);
    expect(phraseIsInWindow("", WINDOW_TEXT)).toBe(false);
    expect(phraseIsInWindow("hand-written rules", WINDOW_TEXT)).toBe(false);
  });

  it("transcriptArchiveLookup still exports the same function — one canonicalisation, two importers", () => {
    /* MUTATION THAT KILLS THIS: leave a private copy behind in
       `transcriptArchiveLookup.ts` that drifts from `types/anchorText.ts`. */
    expect(fromLookup).toBe(canonicalizeForAnchorMatch);
    expect(canonicalizeForAnchorMatch("Drivers’ DASH-cams, okay?")).toBe("drivers dash cams okay");
  });
});

describe("F-81 — writeNarration: the run-5 Frame is written, gated and verified against the window", () => {
  it("the run-5 Frame becomes acceptable with a tape source: one selection, one prose call, the verifier gets the window as the holding document", async () => {
    /* MUTATION THAT KILLS THIS: leave the tape branch out of
       `validateSelectedClaims` (an empty quote is then "not a verbatim
       span"), or out of `sourcesFor` (the page then carries a print-shaped
       source with an empty quote, which `SourceSchema` refuses). */
    const writer = scriptedWriter([{ claims: [TAPE_CLAIM] }]);
    const verifier = recordingVerifier();
    const written = await writeNarration(tapeAct("Hand the listener into the comma segment."), { writer, verifier, evidence: windowGatherer() }, voice, ctx);

    expect(writer.selectCalls).toBe(1);
    expect(writer.writeCalls).toBe(1);
    expect(verifier.calls).toBe(1);

    const brief = verifier.seen[0]!.pages[0]!;
    expect(brief.sources).toHaveLength(1);
    expect(isTapeSource(brief.sources[0]!)).toBe(true);
    expect(brief.evidence.docs.find((d) => d.docId === tapeDocIdFor(SEGMENT_ID))?.text).toBe(WINDOW_TEXT);

    const page = allWrittenNarration(written)[0]!;
    expect(page.mode).toBe("Frame");
    expect(page.script).toBe(RUN5_FRAME);
    expect(page.verified).toBe(true);
    expect(page.sources).toEqual([{ kind: "tape", segmentId: SEGMENT_ID, claimText: TAPE_SOURCE.claimText, publication: TAPE_DOC.title, contested: false }]);
    expect("quote" in page.sources[0]!).toBe(false);
    expect(SourceSchema.safeParse(page.sources[0]).success).toBe(true);
    const beat = written[0]!.slots[0]!.beats[0]!;
    expect(beat.sourcing === "tape" && beat.connectiveNarration?.script).toBe(RUN5_FRAME);
  });

  it("a tape echo shorter than eight words passes the gate and rides on the source", async () => {
    /* MUTATION THAT KILLS THIS: apply MIN_QUOTE_WORDS to a tape claim. */
    const writer = scriptedWriter([{ claims: [{ ...TAPE_CLAIM, quote: "It drives like the people it learned from." }] }]);
    const written = await writeNarration(tapeAct("Hand the listener into the comma segment."), { writer, verifier: recordingVerifier(), evidence: windowGatherer() }, voice, ctx);
    expect(writer.selectCalls).toBe(1);
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources[0]).toMatchObject({ kind: "tape", segmentId: SEGMENT_ID, quote: "It drives like the people it learned from." });
  });

  it("a tape claim whose quote is not spoken in the window is refused at selection — no prose call, no verifier call — and the retry note says so", async () => {
    /* MUTATION THAT KILLS THIS: accept any quote on a tape claim. */
    const writer = scriptedWriter([{ claims: [{ ...TAPE_CLAIM, quote: "learned to drive from hand-written rules" }] }, { claims: [TAPE_CLAIM] }]);
    const verifier = recordingVerifier();
    const written = await writeNarration(tapeAct("Hand the listener into the comma segment."), { writer, verifier, evidence: windowGatherer() }, voice, ctx);
    expect(writer.selectCalls).toBe(2);
    expect(writer.writeCalls).toBe(1);
    expect(verifier.calls).toBe(1);
    expect(writer.retryNotes[1]).toMatch(/not spoken in the transcript window/);
    expect(allWrittenNarration(written)[0]!.verified).toBe(true);
  });

  it("a Frame with no source that states what the tape says is still refused three times and dropped — the rule for source-less pages is unchanged", async () => {
    /* MUTATION THAT KILLS THIS: treat a connective page on a tape beat as
       implicitly tape-sourced when it declares nothing. Declaring is the
       act; a page that declares nothing may only ask or hand off. */
    const writer = scriptedWriter([{ claims: [] }]);
    const verifier = recordingVerifier();
    const written = await writeNarration(tapeAct("Hand the listener into the comma segment."), { writer, verifier, evidence: windowGatherer() }, voice, ctx);
    expect(writer.writeCalls).toBe(3);
    expect(verifier.calls).toBe(0);
    expect(writer.retryNotes[1]).toMatch(/may only ask a question or hand off to the listener/);
    expect(allWrittenNarration(written)).toHaveLength(0);
    const beat = written[0]!.slots[0]!.beats[0]!;
    expect(beat.sourcing).toBe("tape");
  });

  it("a tape source can only name the tape this page introduces — a claim on a window not in the pack is refused", async () => {
    /* MUTATION THAT KILLS THIS: resolve the segment from the claim's docId
       without requiring the document to be in the page's pack. */
    const writer = scriptedWriter([{ claims: [{ ...TAPE_CLAIM, docId: tapeDocIdFor("some-other-episode#40") }] }, { claims: [TAPE_CLAIM] }]);
    await writeNarration(tapeAct("Hand the listener into the comma segment."), { writer, verifier: recordingVerifier(), evidence: windowGatherer() }, voice, ctx);
    expect(writer.retryNotes[1]).toMatch(/not one of the documents provided/);
  });

  it("sourcesFor builds the tape shape from the pack's tape document on a Frame, and the print shape from everything else", () => {
    /* MUTATION THAT KILLS THIS: key the tape branch on the docId prefix
       alone rather than on the held document's kind, or the reverse. */
    const print: EvidenceDoc = { docId: "print:nbs-143", kind: "print", title: "NBS 143", url: "https://example.org/nbs", retrievedAt: "2026-09-11T00:00:00.000Z", text: "eight words of a held print document here, and more" };
    const pack: EvidencePack = { purpose: "p", beatKind: "account", docs: [TAPE_DOC, print] };
    const claims: SelectedClaim[] = [
      { ...TAPE_CLAIM, quote: "  " },
      { claimText: "a print claim", quote: "eight words of a held print document here", docId: print.docId, contested: true }
    ];
    const sources = sourcesFor([0, 1], claims, pack, "Frame");
    expect(sources[0]).toEqual({ kind: "tape", segmentId: SEGMENT_ID, claimText: TAPE_CLAIM.claimText, publication: TAPE_DOC.title, contested: false });
    expect(sources[1]).toEqual({
      claimText: "a print claim",
      quote: "eight words of a held print document here",
      publication: "NBS 143",
      url: "https://example.org/nbs",
      retrieved: "2026-09-11T00:00:00.000Z",
      contested: true
    });
  });

  it("on a page that may not cite tape, a claim on a tape document is the print shape it always was — the gate and sourcesFor agree", () => {
    /* MUTATION THAT KILLS THIS: key `sourcesFor` on the document's kind
       without the mode — a Patch handed a window in a fixture would carry
       a tape source the validator refuses, while the selection gate had
       judged the same claim by the print rules. */
    const pack: EvidencePack = { purpose: "p", beatKind: "account", docs: [TAPE_DOC] };
    const claim: SelectedClaim = { ...TAPE_CLAIM, quote: "It drives like the people it learned from." };
    expect(isTapeClaim(claim, { mode: "Frame", evidence: pack })).toBe(true);
    expect(isTapeClaim(claim, { mode: "Patch", evidence: pack })).toBe(false);
    const [asPrint] = sourcesFor([0], [claim], pack, "Patch");
    expect(asPrint).toEqual({ claimText: claim.claimText, quote: claim.quote, publication: TAPE_DOC.title, contested: false });
  });

  it("the dry-run path produces a tape source on a Frame: stub writer + real gatherer + a held cue window", async () => {
    /* MUTATION THAT KILLS THIS: have the gatherer key the window under a
       docId `sourcesFor` does not recognise as tape. */
    const DIGEST: TranscriptDigestEntry = { show_id: "practical-ai", show_title: "Practical AI", guid: "pai-0042", title: "Open source self-driving with comma.ai", cues: 2 };
    const CATALOGUE: CatalogueData = {
      items: [{ id: "practical-ai--open-source-self-driving-with-comma-ai", show: "Practical AI", title: "Open source self-driving with comma.ai", topics: [], hook: "" }],
      itemTags: {},
      concepts: {},
      shows: [{ show_id: "practical-ai", title: "Practical AI", taxonomy_node_ids: [] }]
    };
    const CUES: TranscriptCue[] = [
      { text: WINDOW_TEXT.slice(0, 120), start_sec: 1200, end_sec: 1260 },
      { text: WINDOW_TEXT.slice(120), start_sec: 1260, end_sec: 1370 }
    ];
    class FixedCueProvider implements TranscriptCueProvider {
      getCues(): TranscriptCue[] | null {
        return CUES;
      }
    }
    const gatherer = new DefaultEvidenceGatherer({
      researcher: new StubExternalResearcher(),
      cueProvider: new FixedCueProvider(),
      catalogue: CATALOGUE,
      transcriptArchive: [DIGEST],
      cacheDir: null
    });
    const written = await writeNarration(
      tapeAct("Tape about learning to drive from dashcams."),
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence: gatherer },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(page.mode).toBe("Frame");
    expect(page.verified).toBe(true);
    const source = page.sources[0]!;
    expect(isTapeSource(source)).toBe(true);
    expect((source as TapeSource).segmentId).toBe(SEGMENT_ID);
    expect(phraseIsInWindow(source.quote!, WINDOW_TEXT)).toBe(true);
  });
});

describe("F-81 — the publish gate's groundedQuoteRate reads a tape source the way the narration gate did", () => {
  function candidate(page: NarratedBeat): WrittenAct[] {
    const beat = tapeAct("c")[0]!.slots[0]!.beats[0]!;
    if (beat.sourcing !== "tape") throw new Error("fixture: expected a tape beat");
    return [{ title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "tape", claim: "c", exploration: false, tape: beat.tape, connectiveNarration: page }] }] }];
  }
  const held = [{ docId: TAPE_DOC.docId, title: TAPE_DOC.title, text: TAPE_DOC.text }];

  it("a tape source with no quote is not a quote: counted nowhere, so a page of only such sources is unmeasured rather than failing", () => {
    /* MUTATION THAT KILLS THIS: count a quoteless tape source as a
       checkable quote — it would be ungrounded, and `GATE_MIN_GROUNDED_
       QUOTE_RATE` would refuse every Frame the narration gate accepted. */
    const result = computeGroundedQuoteRate(candidate(frame({ evidence: held })));
    expect(result.checkableQuotes).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.ungroundedPages).toEqual([]);
  });

  it("a tape echo the narration gate forgave an apostrophe on is grounded here too — one canonicalisation, both gates", () => {
    /* MUTATION THAT KILLS THIS: check a tape quote with the print
       `normalizeQuote` (whitespace and case only): "drivers dashcams" is
       then not in "drivers' dashcams", and a Foray narration accepted is
       refused at publish. */
    const result = computeGroundedQuoteRate(candidate(frame({ evidence: held, sources: [{ ...TAPE_SOURCE, quote: "tens of thousands of drivers dashcams" }] })));
    expect(result).toMatchObject({ checkableQuotes: 1, groundedQuotes: 1, rate: 1, ungroundedPages: [] });
  });

  it("a tape echo that is not in its own segment's window is ungrounded, even when some other held text contains it", () => {
    /* MUTATION THAT KILLS THIS: search every held document instead of the
       window the source names. */
    const elsewhere = { docId: "print:x", title: "Elsewhere", text: "hand-written rules for driving" };
    const result = computeGroundedQuoteRate(candidate(frame({ evidence: [...held, elsewhere], sources: [{ ...TAPE_SOURCE, quote: "hand-written rules for driving" }] })));
    expect(result).toMatchObject({ checkableQuotes: 1, groundedQuotes: 0, rate: 0 });
    expect(result.ungroundedPages[0]).toMatchObject({ mode: "Frame", reason: "ungrounded-quote" });
  });
});

describe("F-81 — the prompts say what the code enforces", () => {
  const brief = {
    pageId: "p0",
    purpose: "Hand the listener into the comma segment.",
    mode: "Frame" as const,
    evidence: { purpose: "Hand the listener into the comma segment.", beatKind: "account" as const, docs: [TAPE_DOC] }
  };

  it("the verifier is handed the segment's transcript window as the holding document for a tape source, and told a [TAPE] source has no quote to check", () => {
    /* MUTATION THAT KILLS THIS: render a tape source with the print line
       (`quote="undefined"`), or leave the window out of the source block. */
    const prompt = buildVerifyPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, script: RUN5_FRAME, sources: [TAPE_SOURCE] }] });
    expect(prompt).toContain(`[TAPE — the segment this page introduces, ${SEGMENT_ID}]`);
    expect(prompt).toContain("Holding document for this source: the segment's transcript window below.");
    expect(prompt.indexOf(WINDOW_TEXT)).toBeGreaterThan(prompt.indexOf("Holding document for this source"));
    expect(prompt).toContain("A source marked [TAPE] has no quote to check against");
    expect(prompt).not.toContain('quote="undefined"');
    const echoed = buildVerifyPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, script: RUN5_FRAME, sources: [{ ...TAPE_SOURCE, quote: "drivers dashcams" }] }] });
    expect(echoed).toContain('echoes="drivers dashcams"');
  });

  it("the selection prompt marks the tape document a Frame may cite as a whole, and says the quote is optional", () => {
    /* MUTATION THAT KILLS THIS: drop the TAPE note from `evidenceBlock`
       or the rule line from `buildSelectionPrompt` — the writer would go
       on selecting nothing for a Frame, which is run 5. */
    const prompt = buildSelectionPrompt({ slotTitle: "Slot", voice, pages: [brief] });
    expect(prompt).toContain("TAPE: the segment this page introduces — may be cited as a whole (quote optional)");
    expect(prompt).toMatch(/A Frame, Hinge or Marker that hands the listener into tape may cite the tape itself/);
    expect(prompt).toContain("never the answer it gives");
    const patch = buildSelectionPrompt({ slotTitle: "Slot", voice, pages: [{ ...brief, mode: "Patch" }] });
    expect(patch).not.toContain("may be cited as a whole");
  });
});
