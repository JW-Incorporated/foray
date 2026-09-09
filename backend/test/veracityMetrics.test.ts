import { describe, it, expect } from "vitest";
import {
  computeGroundedQuoteRate,
  computeAttributionStability,
  computeFirstAttemptPassRate,
  computePurposeFidelity,
  computeTapeRelevance,
  computePagesDropped,
  computeUnverifiedPages,
  computePurposeRevisedPages,
  computeCallsPerBeat,
  countAttemptedPages,
  buildVeracityMetrics,
  evaluateVeracityGate,
  GATE_MIN_GROUNDED_QUOTE_RATE,
  GATE_MIN_PURPOSE_FIDELITY,
  GATE_MIN_TAPE_RELEVANCE,
  type VeracityMetrics
} from "../src/generation/veracityMetrics";
import type { WrittenAct, WrittenBeat } from "../src/generation/writeNarration";
import type { NarratedBeat, Source } from "../src/types/narration";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";

/**
 * WS-B (docs/curation/generation-fix-plan-2026-09-09.md): every metric this
 * module computes gets a hand-built candidate here — real fixtures that
 * pin the exact "AI slop" failures the fix plan's findings named, not
 * mocks of the metric's own arithmetic. Where a metric is `null` by
 * design (no evidence data pre-WS-A; `purposeFidelity` always, per its own
 * comment), the test pins THAT, because the whole point of these metrics
 * is that a `null` never quietly reads as a `1.0`.
 */

function source(overrides: Partial<Source> = {}): Source {
  return { claimText: "claim", quote: "quote text", publication: "Pub", contested: false, ...overrides };
}

function narratedBeat(overrides: Partial<NarratedBeat> = {}): NarratedBeat {
  return {
    mode: "Patch",
    script: "x".repeat(400),
    sources: [source()],
    pronunciationHints: [],
    verified: true,
    ...overrides
  };
}

function narrationBeat(claim: string, beat: NarratedBeat): WrittenBeat {
  return { sourcing: "narration", claim, exploration: false, narration: beat };
}

function tapePointer(overrides: Partial<TapePointer> = {}): TapePointer {
  return {
    segmentId: "seg#1",
    itemId: "item-1",
    startSec: 0,
    endSec: 10,
    startAnchor: "a",
    endAnchor: "b",
    tier: 1,
    confidence: "high",
    ...overrides
  };
}

function actsOf(beats: WrittenBeat[]): WrittenAct[] {
  return [{ title: "Act 1", slots: [{ title: "Slot 1", beats }] }];
}

describe("computeGroundedQuoteRate", () => {
  it("is null when no page in the candidate carries evidence (pre-WS-A state)", () => {
    /* MUTATION THAT KILLS THIS: default `rate` to 1 when `checkableQuotes`
       is 0. That is exactly the false-positive F-27/F-32/F-46 exist to
       catch — a candidate with zero checkable quotes is UNMEASURED, not
       clean. Ran the mutant — red. */
    const acts = actsOf([narrationBeat("c1", narratedBeat())]);
    const result = computeGroundedQuoteRate(acts);
    expect(result.rate).toBe(null);
    expect(result.checkableQuotes).toBe(0);
  });

  it("counts a quote grounded when it is a normalized substring of held evidence", () => {
    const beat = narratedBeat({
      sources: [source({ quote: "welding crews reinforced the joints" })],
      evidence: [{ docId: "d1", title: "T", text: "Records show welding   crews reinforced the joints at night." }]
    });
    const acts = actsOf([narrationBeat("c1", beat)]);
    const result = computeGroundedQuoteRate(acts);
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(1);
    expect(result!.groundedQuotes).toBe(1);
    expect(result!.checkableQuotes).toBe(1);
    expect(result!.ungroundedPages).toEqual([]);
  });

  it("catches a fabricated quote — F-46: the writer quoted its own purpose text, not held evidence", () => {
    /* MUTATION THAT KILLS THIS: check the quote against `written.script`
       instead of `evidence[].text`. A quote can be a substring of the
       page's own script while never appearing in what was actually held —
       that is exactly F-46's failure. Ran it — red. */
    const beat = narratedBeat({
      sources: [source({ quote: "welding crews reinforced the tower's joints at night for three months in 1978", publication: "Engineering News-Record" })],
      evidence: [{ docId: "d1", title: "T", text: "Nothing in this document mentions welding at all." }]
    });
    const acts = actsOf([narrationBeat("beat 23", beat)]);
    const result = computeGroundedQuoteRate(acts);
    expect(result!.rate).toBe(0);
    expect(result!.ungroundedPages).toHaveLength(1);
    expect(result!.ungroundedPages[0]!.reason).toBe("ungrounded-quote");
    expect(result!.ungroundedPages[0]!.claim).toBe("beat 23");
  });

  it("excludes pages with no evidence from the denominator rather than failing them", () => {
    const grounded = narratedBeat({
      sources: [source({ quote: "sixty percent" })],
      evidence: [{ docId: "d1", title: "T", text: "about sixty percent of the minimum required" }]
    });
    const noEvidence = narratedBeat({ sources: [source({ quote: "anything at all" })] });
    const acts = actsOf([narrationBeat("c1", grounded), narrationBeat("c2", noEvidence)]);
    const result = computeGroundedQuoteRate(acts);
    expect(result!.checkableQuotes).toBe(1);
    expect(result!.rate).toBe(1);
  });
});

describe("computeAttributionStability", () => {
  it("is null when nothing carries multi-attempt data", () => {
    const acts = actsOf([narrationBeat("c1", narratedBeat())]);
    expect(computeAttributionStability(acts)).toBe(null);
  });

  it("catches F-32: the same quote's publication moved between attempts", () => {
    /* Attempt 4, page 1 of run 1: the same span was Wikipedia on attempt 1
       and Encyclopaedia Britannica on the informed retry.

       MUTATION THAT KILLS THIS: compare attempts pairwise instead of by
       claimText, or compare `quote` instead of `publication` — either
       would miss this exact case (same claim, same quote, different
       publication). Ran it — red. */
    const beat = narratedBeat({
      attempts: [
        { attempt: 1, sources: [source({ claimText: "the death toll", publication: "Wikipedia" })], rejected: true, rejectionNote: "unsourced" },
        { attempt: 2, sources: [source({ claimText: "the death toll", publication: "Encyclopaedia Britannica" })], rejected: false }
      ]
    });
    const acts = actsOf([narrationBeat("c1", beat)]);
    expect(computeAttributionStability(acts)).toBe(0);
  });

  it("counts a claim stable when its publication does not move across attempts", () => {
    const beat = narratedBeat({
      attempts: [
        { attempt: 1, sources: [source({ claimText: "the death toll", publication: "NIST report" })], rejected: true, rejectionNote: "too short" },
        { attempt: 2, sources: [source({ claimText: "the death toll", publication: "NIST report" })], rejected: false }
      ]
    });
    const acts = actsOf([narrationBeat("c1", beat)]);
    expect(computeAttributionStability(acts)).toBe(1);
  });

  it("does not compare a claim that appears in only one attempt", () => {
    const beat = narratedBeat({
      attempts: [
        { attempt: 1, sources: [source({ claimText: "claim A", publication: "Pub A" })], rejected: true, rejectionNote: "x" },
        { attempt: 2, sources: [source({ claimText: "claim B", publication: "Pub B" })], rejected: false }
      ]
    });
    const acts = actsOf([narrationBeat("c1", beat)]);
    expect(computeAttributionStability(acts)).toBe(null);
  });
});

describe("computeFirstAttemptPassRate", () => {
  it("is null when nothing carries attempts data", () => {
    const acts = actsOf([narrationBeat("c1", narratedBeat())]);
    expect(computeFirstAttemptPassRate(acts)).toBe(null);
  });

  it("counts a single-attempt page as a first-attempt pass", () => {
    const beat = narratedBeat({ attempts: [{ attempt: 1, sources: [source()], rejected: false }] });
    const acts = actsOf([narrationBeat("c1", beat)]);
    expect(computeFirstAttemptPassRate(acts)).toBe(1);
  });

  it("does not count a page that needed retries", () => {
    const beat = narratedBeat({
      attempts: [
        { attempt: 1, sources: [], rejected: true, rejectionNote: "missing sources" },
        { attempt: 2, sources: [source()], rejected: false }
      ]
    });
    const acts = actsOf([narrationBeat("c1", beat)]);
    expect(computeFirstAttemptPassRate(acts)).toBe(0);
  });

  it("matches the run-1 KPI shape: 1 of 2 kept pages passed on the first try", () => {
    const first = narratedBeat({ attempts: [{ attempt: 1, sources: [source()], rejected: false }] });
    const retried = narratedBeat({
      attempts: [
        { attempt: 1, sources: [], rejected: true, rejectionNote: "no sources" },
        { attempt: 2, sources: [], rejected: true, rejectionNote: "still no sources" },
        { attempt: 3, sources: [source()], rejected: false }
      ]
    });
    const acts = actsOf([narrationBeat("c1", first), narrationBeat("c2", retried)]);
    expect(computeFirstAttemptPassRate(acts)).toBe(0.5);
  });
});

describe("computePurposeFidelity", () => {
  it("is always null in this checkout, even for an all-verified candidate", () => {
    /* THE TRAP THIS PINS. `NarratedBeat.verified` is `true` for every page
       that survives into `WrittenAct[]` BY CONSTRUCTION
       (`writeNarration.ts`'s `writePageAndVerify` only ever returns a
       verified page) — averaging it would print 1.0 on every candidate
       this function can ever see, including ones that shipped fabricated
       citations. This metric must stay null until the verifier answers
       "does this page accomplish its purpose" as its own field.

       MUTATION THAT KILLS THIS: `return mean(writtenActs, b => b.verified)`.
       Every one of these beats is `verified: true`, so the mutant returns
       1, not null. Ran it — red. */
    const acts = actsOf([
      narrationBeat("c1", narratedBeat({ verified: true })),
      narrationBeat("c2", narratedBeat({ verified: true }))
    ]);
    expect(computePurposeFidelity(acts)).toBe(null);
  });
});

describe("computeTapeRelevance", () => {
  /* Real, committed catalogue rows (data/segments.json, data/catalog.json,
     data/segment-sources.json) — read-only, picked because their taxonomy
     families are already known and stable, not synthesized fixtures. See
     `computeTapeRelevance`'s own doc comment for why the segment's own
     `topic` field is the primary signal and the show-title join is the
     secondary one. */
  const foodSegmentId = "bbqc-moss-school#1881";
  const foodItemId = "bbqc-moss-school";
  const econSegmentId = "am-sba-lender-roundtable#1689";
  const econItemId = "am-sba-lender-roundtable";

  function sourcedTapeAct(claim: string, tape: TapePointer): SourcedAct[] {
    return [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim, exploration: false, tape }] }] }];
  }

  it("resolves on-topic from the segment's own taxonomy-shaped topic field", () => {
    const acts = sourcedTapeAct("c1", tapePointer({ segmentId: foodSegmentId, itemId: foodItemId }));
    const result = computeTapeRelevance(acts, "food/grilling-bbq");
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0]!.onTopic).toBe(true);
    expect(result.anchors[0]!.families).toContain("food");
    expect(result.rate).toBe(1);
  });

  it("catches a mis-anchored tape beat — F-23/F-24/F-29: a different taxonomy family entirely", () => {
    /* MUTATION THAT KILLS THIS: compare the segment's RAW topic string to
       the RAW resolved topic string instead of comparing families (the
       first path segment). "economics/markets" vs "food/grilling-bbq"
       would then also fail to match for the right reason by accident;
       flip the comparison to `topic.includes(family)` instead and this
       still passes wrongly, so the real regression check is on `onTopic`
       being `false` (not merely rate < 1). Ran the family-vs-family swap
       mutant — red. */
    const acts = sourcedTapeAct("c1", tapePointer({ segmentId: econSegmentId, itemId: econItemId }));
    const result = computeTapeRelevance(acts, "food/grilling-bbq");
    expect(result.anchors[0]!.onTopic).toBe(false);
    expect(result.rate).toBe(0);
  });

  it("reports onTopic null, not false, for an anchor neither signal resolves", () => {
    const acts = sourcedTapeAct("c1", tapePointer({ segmentId: "nonexistent#1", itemId: "nonexistent-item" }));
    const result = computeTapeRelevance(acts, "food/grilling-bbq");
    expect(result.anchors[0]!.onTopic).toBe(null);
    expect(result.anchors[0]!.families).toEqual([]);
    // The unresolvable anchor is excluded from the rate, not counted as a miss.
    expect(result.rate).toBe(null);
  });

  it("returns an empty anchor list, not a failure, for a candidate with no tape beats", () => {
    const acts: SourcedAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "narration", claim: "c1", exploration: false, narration: { mode: "Patch", reason: "no tape" } }] }] }];
    const result = computeTapeRelevance(acts, "food/grilling-bbq");
    expect(result.anchors).toEqual([]);
    expect(result.rate).toBe(null);
  });
});

describe("computePagesDropped", () => {
  it("counts a connective page decideConnectiveNarration wanted but the final candidate does not have", () => {
    /* Mirrors F-17/F-31's connective-page-drop path: `writeNarration.ts`'s
       `writeOneBeat` keeps the tape and drops the page after
       NARRATION_PAGE_ATTEMPTS rejections. A beat that OPENS its slot
       always gets a Frame decision (`decideConnectiveNarration`), so
       leaving `connectiveNarration` off the written beat is exactly what
       a drop looks like. */
    const tape = tapePointer();
    const sourced: SourcedAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape }] }] }];
    const written: WrittenAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape }] }] }];
    expect(computePagesDropped(sourced, written)).toBe(1);
  });

  it("does not count a kept connective page", () => {
    const tape = tapePointer();
    const sourced: SourcedAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape }] }] }];
    const written: WrittenAct[] = [
      { title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape, connectiveNarration: narratedBeat({ mode: "Frame" }) }] }] }
    ];
    expect(computePagesDropped(sourced, written)).toBe(0);
  });

  it("does not count a same-episode continuation, which decideConnectiveNarration never wanted a page for", () => {
    const tapeA = tapePointer({ itemId: "same-item" });
    const tapeB = tapePointer({ itemId: "same-item", segmentId: "seg#2" });
    const sourced: SourcedAct[] = [
      { title: "Act 1", slots: [{ title: "Slot 1", beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapeA },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapeB }
      ] }] }
    ];
    const written: WrittenAct[] = [
      { title: "Act 1", slots: [{ title: "Slot 1", beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapeA, connectiveNarration: narratedBeat({ mode: "Frame" }) },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapeB }
      ] }] }
    ];
    expect(computePagesDropped(sourced, written)).toBe(0);
  });
});

describe("countAttemptedPages / computeCallsPerBeat", () => {
  it("counts a narration beat and a connective-decided tape beat, not a silent tape beat", () => {
    const tapeOpening = tapePointer({ itemId: "item-a" });
    const tapeContinuation = tapePointer({ itemId: "item-a", segmentId: "seg#2" });
    const sourced: SourcedAct[] = [
      { title: "Act 1", slots: [{ title: "Slot 1", beats: [
        { sourcing: "narration", claim: "c1", exploration: false, narration: { mode: "Patch", reason: "no tape" } },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapeOpening },
        { sourcing: "tape", claim: "c3", exploration: false, tape: tapeContinuation }
      ] }] }
    ];
    // c1 (narration) + c2 (opens slot -> Frame) count; c3 (same-episode continuation) does not.
    expect(countAttemptedPages(sourced)).toBe(2);
    expect(computeCallsPerBeat(sourced, 6, 4)).toBe(5);
  });

  it("is null when there is nothing to attempt a page for", () => {
    expect(computeCallsPerBeat([], 0, 0)).toBe(null);
  });
});

describe("buildVeracityMetrics", () => {
  it("assembles every field from the sub-computations, never guessing a value the inputs don't support", () => {
    const tape = tapePointer({ segmentId: "bbqc-moss-school#1881", itemId: "bbqc-moss-school" });
    const sourced: SourcedAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape }] }] }];
    const written: WrittenAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape, connectiveNarration: narratedBeat({ mode: "Frame" }) }] }] }];

    const veracity = buildVeracityMetrics({
      sourcedActs: sourced,
      writtenActs: written,
      topic: "food/grilling-bbq",
      writerCalls: 1,
      verifierCalls: 1,
      pipelineTokens: 1234,
      stageTimings: [{ name: "understand", startedAt: "t", ms: 5 }]
    });

    expect(veracity.groundedQuoteRate).toBe(null); // no evidence on this beat
    // WS-A: null only when no page carries `purposeAccomplished` — these fixtures do not.
    expect(veracity.purposeFidelity).toBe(null);
    expect(veracity.tapeRelevance).toBe(1);
    expect(veracity.tapeRelevanceAnchors).toHaveLength(1);
    expect(veracity.pagesDropped).toBe(0);
    expect(veracity.callsPerBeat).toBe(2);
    expect(veracity.pipelineTokens).toBe(1234);
    expect(veracity.stageTimings[0]!.name).toBe("understand");
  });
});

describe("evaluateVeracityGate", () => {
  const passingVeracity = (): VeracityMetrics => ({
    groundedQuoteRate: 1,
    groundedQuoteCounts: { checkable: 4, grounded: 4 },
    ungroundedPages: [],
    attributionStability: 1,
    purposeFidelity: 0.9,
    tapeRelevance: 0.95,
    tapeRelevanceAnchors: [{ itemId: "i1", claim: "c1", onTopic: true, families: ["food"] }],
    firstAttemptPassRate: 0.8,
    callsPerBeat: 1.4,
    pagesDropped: 0,
    unverifiedPages: 0,
    unverifiedPageDetails: [],
    purposeRevisedPages: 0,
    pipelineTokens: 1000,
    stageTimings: []
  });

  it("refuses to publish when meta.veracity is entirely absent", () => {
    const gate = evaluateVeracityGate(undefined);
    expect(gate.ok).toBe(false);
    expect(gate.failures[0]).toMatch(/no meta.veracity/);
  });

  it("passes a candidate that clears all three floors", () => {
    const gate = evaluateVeracityGate(passingVeracity());
    expect(gate.ok).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it(`refuses when groundedQuoteRate is null (never treated as ${GATE_MIN_GROUNDED_QUOTE_RATE})`, () => {
    const gate = evaluateVeracityGate({ ...passingVeracity(), groundedQuoteRate: null });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => /groundedQuoteRate is null/.test(f))).toBe(true);
  });

  it("refuses and prints the failing page when groundedQuoteRate is below 1", () => {
    const veracity = { ...passingVeracity(), groundedQuoteRate: 0.5, ungroundedPages: [{ claim: "beat 23", mode: "Patch" as const, reason: "ungrounded-quote" as const, detail: "1 quote(s) not found" }] };
    const gate = evaluateVeracityGate(veracity);
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.includes("beat 23"))).toBe(true);
  });

  it(`refuses when purposeFidelity is null or below ${GATE_MIN_PURPOSE_FIDELITY}`, () => {
    expect(evaluateVeracityGate({ ...passingVeracity(), purposeFidelity: null }).ok).toBe(false);
    expect(evaluateVeracityGate({ ...passingVeracity(), purposeFidelity: 0.5 }).ok).toBe(false);
  });

  it(`refuses when tapeRelevance is below ${GATE_MIN_TAPE_RELEVANCE} and lists the off-topic anchor`, () => {
    const veracity = {
      ...passingVeracity(),
      tapeRelevance: 0.5,
      tapeRelevanceAnchors: [{ itemId: "i1", claim: "c1", onTopic: false, families: ["economics"] }]
    };
    const gate = evaluateVeracityGate(veracity);
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.includes("i1"))).toBe(true);
  });

  it("does NOT block on tapeRelevance when the candidate used no tape at all", () => {
    /* MUTATION THAT KILLS THIS: drop the `tapeRelevanceAnchors.length === 0`
       exception and always require `tapeRelevance !== null`. An all-
       narration Foray would then be unpublishable forever, for a metric
       that was never applicable. Ran it — red. */
    const gate = evaluateVeracityGate({ ...passingVeracity(), tapeRelevance: null, tapeRelevanceAnchors: [] });
    expect(gate.ok).toBe(true);
  });

  it("DOES block when tape anchors exist but none resolved (tapeRelevance null with anchors present)", () => {
    const gate = evaluateVeracityGate({
      ...passingVeracity(),
      tapeRelevance: null,
      tapeRelevanceAnchors: [{ itemId: "i1", claim: "c1", onTopic: null, families: [] }]
    });
    expect(gate.ok).toBe(false);
  });
});


/* ------------------------------------------------------------------ *
 * F-50 / F-51 — the two metrics the run-2 fixes added, and the gate
 * condition that replaces the throw.
 * ------------------------------------------------------------------ */

describe("computeUnverifiedPages (F-51)", () => {
  it("is zero for a candidate whose pages all passed verification", () => {
    const result = computeUnverifiedPages(actsOf([narrationBeat("c", narratedBeat())]));
    expect(result.count).toBe(0);
    expect(result.pages).toEqual([]);
  });

  it("counts and names a page kept with verified:false, quoting the verifier's objection", () => {
    /* Run 2's act 1 p2, as the pipeline now finishes it: ten verified
       pages, one kept unverified, and a candidate that exists. */
    const acts = actsOf([
      narrationBeat("Show what the connection was asked to hold.", narratedBeat()),
      narrationBeat("The feature store exists as a product category for one reason.", narratedBeat({
        verified: false,
        verifierNotes: "the concept the purpose names is dropped",
        attempts: [
          { attempt: 1, sources: [], rejected: true, rejectionNote: "unsupported by its quotes" },
          { attempt: 2, sources: [], rejected: true, rejectionNote: "the concept the purpose names is dropped" },
          { attempt: 3, sources: [], rejected: true, rejectionNote: "the concept the purpose names is dropped" }
        ]
      }))
    ]);

    const result = computeUnverifiedPages(acts);
    expect(result.count).toBe(1);
    expect(result.pages[0]!.reason).toBe("unverified-page");
    expect(result.pages[0]!.claim).toMatch(/feature store/);
    expect(result.pages[0]!.detail).toMatch(/the concept the purpose names is dropped/);
  });

  it("still names a page that has no verifier notes at all", () => {
    const result = computeUnverifiedPages(actsOf([narrationBeat("c", narratedBeat({ verified: false, attempts: [] }))]));
    expect(result.count).toBe(1);
    expect(result.pages[0]!.detail).toMatch(/kept unverified/);
  });
});

describe("computePurposeRevisedPages (F-50)", () => {
  it("counts a page the writer flagged, a page the verifier flagged, and a page both did — once each", () => {
    const acts = actsOf([
      narrationBeat("writer said so", narratedBeat({ purposeRevised: true })),
      narrationBeat("verifier said so", narratedBeat({ purposeRevisedByVerifier: true })),
      narrationBeat("both said so", narratedBeat({ purposeRevised: true, purposeRevisedByVerifier: true })),
      narrationBeat("neither", narratedBeat())
    ]);
    expect(computePurposeRevisedPages(acts)).toBe(3);
  });

  it("is zero, not null, for a candidate where no page took the permission", () => {
    expect(computePurposeRevisedPages(actsOf([narrationBeat("c", narratedBeat())]))).toBe(0);
  });
});

describe("the publish gate refuses an unverified page (F-51)", () => {
  const passing = (): VeracityMetrics => ({
    groundedQuoteRate: 1,
    groundedQuoteCounts: { checkable: 4, grounded: 4 },
    ungroundedPages: [],
    attributionStability: 1,
    purposeFidelity: 0.9,
    tapeRelevance: 0.95,
    tapeRelevanceAnchors: [{ itemId: "i1", claim: "c1", onTopic: true, families: ["food"] }],
    firstAttemptPassRate: 0.8,
    callsPerBeat: 1.4,
    pagesDropped: 0,
    unverifiedPages: 0,
    unverifiedPageDetails: [],
    purposeRevisedPages: 0,
    pipelineTokens: 1000,
    stageTimings: []
  });

  it("refuses on a single unverified page and names it", () => {
    const gate = evaluateVeracityGate({
      ...passing(),
      unverifiedPages: 1,
      unverifiedPageDetails: [
        {
          claim: "The feature store exists as a product category for one reason.",
          mode: "Patch",
          reason: "unverified-page",
          detail: "kept unverified after every attempt - the concept the purpose names is dropped"
        }
      ]
    });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => /never satisfied the verifier/.test(f))).toBe(true);
    expect(gate.failures.some((f) => /feature store/.test(f))).toBe(true);
  });

  it("does not refuse a candidate that revised a purpose — that is reported, never gated", () => {
    const gate = evaluateVeracityGate({ ...passing(), purposeRevisedPages: 3 });
    expect(gate.ok).toBe(true);
  });

  it("passes a clean candidate, so the new condition is not always-on", () => {
    expect(evaluateVeracityGate(passing()).ok).toBe(true);
  });
});

describe("buildVeracityMetrics surfaces the run-2 fields", () => {
  it("reports unverifiedPages, its detail list and purposeRevisedPages", () => {
    const veracity = buildVeracityMetrics({
      sourcedActs: [],
      writtenActs: actsOf([
        narrationBeat("kept unverified", narratedBeat({ verified: false, verifierNotes: "the concept the purpose names is dropped" })),
        narrationBeat("corrected its purpose", narratedBeat({ purposeRevised: true }))
      ]),
      topic: "engineering/software",
      writerCalls: 2,
      verifierCalls: 2,
      pipelineTokens: 0,
      stageTimings: []
    });

    expect(veracity.unverifiedPages).toBe(1);
    expect(veracity.unverifiedPageDetails).toHaveLength(1);
    expect(veracity.purposeRevisedPages).toBe(1);
    expect(evaluateVeracityGate(veracity).ok).toBe(false);
  });
});
