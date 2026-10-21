import { describe, it, expect } from "vitest";
import {
  computeGroundedQuoteRate,
  computeAttributionStability,
  computeFirstAttemptPassRate,
  computeFirstAttemptPassRates,
  computeListeningShares,
  computePurposeFidelity,
  computeTapeRelevance,
  computePagesDropped,
  computeUnverifiedPages,
  computePurposeRevisedPages,
  computeCallsPerBeat,
  countAttemptedPages,
  computeTapeYield,
  computeBeatCoverage,
  computeSpecificsUnsupported,
  computeClipOnSubject,
  computeShowVariety,
  computeTierFit,
  computeCleanCuts,
  computeSentencesSurviving,
  CLIP_ON_SUBJECT_LEVEL,
  buildVeracityMetrics,
  evaluateVeracityGate,
  GATE_MIN_GROUNDED_QUOTE_RATE,
  GATE_MIN_PURPOSE_FIDELITY,
  GATE_MIN_TAPE_RELEVANCE,
  GATE_MIN_CLEAN_CUT_RATE,
  type VeracityMetrics
} from "../src/generation/veracityMetrics";
import type { WrittenAct, WrittenBeat } from "../src/generation/writeNarration";
import type { NarratedBeat, Source } from "../src/types/narration";
import { findHoldingDoc } from "../src/types/narration";
import { computeVoiceMetrics, voiceReport } from "../src/generation/voiceChecks";
import type { SourceBeatsResult, SourcedAct, SourcingTrace, TapePointer, TapeRelevanceInput } from "../src/types/tapeSourcing";
import { CheckpointSession, type CheckpointFile, type CheckpointStore } from "../src/generation/checkpoint";
import { publishGateOptions } from "../src/cli/publishForay";

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

  it("arch-drift-2: a quote the narration gate accepted is grounded here too (curly vs straight apostrophe, em dash)", () => {
    /* MUTATION THAT KILLS THIS: go back to a private whitespace-and-case
       normaliser. "don't" is then not in "don’t", and a page the writer
       gate (findHoldingDoc) accepted is counted ungrounded at publish. */
    const doc = { docId: "d1", title: "T", text: "The crew said they don’t trust the gauge — not since 1978…" };
    const quote = "they don't trust the gauge - not since 1978...";
    expect(findHoldingDoc(quote, [doc])).not.toBeNull();
    const beat = narratedBeat({ sources: [source({ quote })], evidence: [doc] });
    const result = computeGroundedQuoteRate(actsOf([narrationBeat("c1", beat)]));
    expect(result).toMatchObject({ checkableQuotes: 1, groundedQuotes: 1, rate: 1, ungroundedPages: [] });
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

describe("F-101 — computeFirstAttemptPassRates emits BOTH units and declares which the scalar is in", () => {
  /** A per-act candidate: one beat confirmed on round 1, three not confirmed
   * at all — run 9's shape in miniature (1 of 21). Its pages ALSO carry
   * attempts, because `writeAct.ts` records them per seam, so the page unit is
   * measurable on the same candidate and the two numbers can disagree. */
  function perActCandidate(): WrittenAct[] {
    const onePass = narratedBeat({ attempts: [{ attempt: 1, sources: [source()], rejected: false }] });
    const retried = narratedBeat({
      attempts: [
        { attempt: 1, sources: [], rejected: true, rejectionNote: "seam s0: no sources" },
        { attempt: 2, sources: [source()], rejected: false }
      ]
    });
    const mark = (beat: WrittenBeat, verifiedAtAttempt?: number): WrittenBeat =>
      ({ ...beat, ...(verifiedAtAttempt === undefined ? { carriedBy: "s0" } : { verifiedAtAttempt }) }) as WrittenBeat;
    return actsOf([
      mark(narrationBeat("c1", onePass), 1),
      mark(narrationBeat("c2", retried), 2),
      mark(narrationBeat("c3", retried)),
      mark(narrationBeat("c4", retried))
    ]);
  }

  it("reports pages and beats separately on a per-act candidate, and names the unit the legacy scalar carries", () => {
    /* MUTATION THAT KILLS THIS: return only the sniffed number again (drop
       `pages` from the per-act branch, or set `unit` to a constant). The bench
       would go back to trending run 8's 0.68 (pages) against run 9's 0.048
       (beats) in one column — the comparison `writeAct.ts`'s F-97 paragraph
       cites as evidence the Q-03 contract did not converge. Ran it — red on
       the two rates disagreeing below. */
    const rates = computeFirstAttemptPassRates(perActCandidate());
    expect(rates.beats).toBe(0.25); // 1 of 4 beats confirmed on round 1
    expect(rates.pages).toBe(0.25); // 1 of 4 kept pages accepted on attempt 1
    expect(rates.unit).toBe("beats");
    /* The legacy scalar is still the sniffed one, unchanged, so run 4–9
       reports and the callers that predate F-101 read what they always read. */
    expect(computeFirstAttemptPassRate(perActCandidate())).toBe(rates.beats);
  });

  it("the two units are genuinely different numbers, not an alias — a beat no page carried drags only `beats` down", () => {
    /* MUTATION THAT KILLS THIS: compute `beats` over pages rather than over
       narration beats (or drop never-confirmed beats from the denominator).
       Both units would then agree on every candidate and the field pair would
       be decoration. Ran it — red: `beats` comes back 1. */
    const clean = narratedBeat({ attempts: [{ attempt: 1, sources: [source()], rejected: false }] });
    const acts = actsOf([
      { ...narrationBeat("c1", clean), verifiedAtAttempt: 1 } as WrittenBeat,
      /* A beat the act's prose carries but the verifier never confirmed: no
         page of its own, so the page unit cannot see it at all. */
      { sourcing: "narration", claim: "c2", exploration: false, carriedBy: "s0" } as unknown as WrittenBeat
    ]);
    const rates = computeFirstAttemptPassRates(acts);
    expect(rates.pages).toBe(1);
    expect(rates.beats).toBe(0.5);
    expect(rates.unit).toBe("beats");
  });

  it("a per-PAGE candidate (runs 1–8) declares the pages unit and has no beat reading", () => {
    /* MUTATION THAT KILLS THIS: default `unit` to "beats". Every pre-run-9
       report replayed through the bench would be filed in the wrong column,
       which is the exact defect F-101 is about, inverted. */
    const beat = narratedBeat({ attempts: [{ attempt: 1, sources: [source()], rejected: false }] });
    const rates = computeFirstAttemptPassRates(actsOf([narrationBeat("c1", beat)]));
    expect(rates.unit).toBe("pages");
    expect(rates.pages).toBe(1);
    expect(rates.beats).toBe(null);
  });
});

describe("F-101 — computeListeningShares says its denominator in the field name", () => {
  it("tapeOfTapePlusNarration divides by tape + narration, NOT by the candidate's runtime, and the deprecated alias is the same number", () => {
    /* MUTATION THAT KILLS THIS: make `tapeOfTapePlusNarration` divide by
       anything else — the whole point of the rename is that the name and the
       arithmetic agree. The roadmap's §1.2 row is titled "Tape share OF
       RUNTIME" and named `report.json tapeShare` as its source; on run 9 those
       two quantities read 0.684 and 0.557, so a *proposed* founder target
       (>= 70 %) was about to be graded against the flattering one. Ran it —
       red on the exact ratio below. */
    const sourced: SourcedAct[] = [
      {
        title: "Act 1",
        slots: [
          {
            title: "Slot 1",
            beats: [
              { sourcing: "tape", claim: "c1", exploration: false, tape: tapePointer({ startSec: 0, endSec: 300 }) },
              { sourcing: "narration", claim: "c2", exploration: false, narration: { mode: "Patch", reason: "fixture" } }
            ]
          }
        ]
      }
    ];
    const written = actsOf([narrationBeat("c2", narratedBeat({ script: "x".repeat(1700) }))]);
    const shares = computeListeningShares(sourced, written);

    expect(shares.tapeSec).toBe(300);
    expect(shares.tapeOfTapePlusNarration).toBeCloseTo(300 / (300 + shares.narrationSec), 9);
    expect(shares.narrationOfTapePlusNarration).toBeCloseTo(shares.narrationSec / (300 + shares.narrationSec), 9);
    expect(shares.tapeOfTapePlusNarration! + shares.narrationOfTapePlusNarration!).toBeCloseTo(1, 9);
    /* The alias is the same number under the name that does not say so. */
    expect(shares.tapeShare).toBe(shares.tapeOfTapePlusNarration);
    expect(shares.narrationShare).toBe(shares.narrationOfTapePlusNarration);
    /* And it is NOT tape over a runtime that also counts jingles and band:
       a candidate whose runtime is 100 s longer reads 13 points lower, which
       is exactly run 9's 0.684 against 0.557. */
    const runtimeSec = 300 + shares.narrationSec + 100;
    expect(300 / runtimeSec).toBeLessThan(shares.tapeOfTapePlusNarration!);
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
    firstAttemptUnit: "pages",
    firstAttemptPassRatePages: 0.8,
    firstAttemptPassRateBeats: null,
    callsPerBeat: 1.4,
    narrationCallsPerBeat: 1.1,
    narrationCalls: { writer: 4, verifier: 3 },
    retryRounds: 1,
    seedLostBeats: 0,
    pagesDropped: 0,
    unverifiedPages: 0,
    unverifiedPageDetails: [],
    synthesisVerifiedPages: 0,
    synthesisVerifiedPageDetails: [],
    purposeRevisedPages: 0,
    tapeCitedPages: 0,
    narrationPagesPerSeam: 1,
    narrationShare: 0.2,
    tapeShare: 0.8,
    tapeOfTapePlusNarration: 0.8,
    narrationOfTapePlusNarration: 0.2,
    introRestates: 0,
    narrationCallsPerAct: 2,
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
    firstAttemptUnit: "pages",
    firstAttemptPassRatePages: 0.8,
    firstAttemptPassRateBeats: null,
    callsPerBeat: 1.4,
    narrationCallsPerBeat: 1.1,
    narrationCalls: { writer: 4, verifier: 3 },
    retryRounds: 1,
    seedLostBeats: 0,
    pagesDropped: 0,
    unverifiedPages: 0,
    unverifiedPageDetails: [],
    synthesisVerifiedPages: 0,
    synthesisVerifiedPageDetails: [],
    purposeRevisedPages: 0,
    tapeCitedPages: 0,
    narrationPagesPerSeam: 1,
    narrationShare: 0.2,
    tapeShare: 0.8,
    tapeOfTapePlusNarration: 0.8,
    narrationOfTapePlusNarration: 0.2,
    introRestates: 0,
    narrationCallsPerAct: 2,
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

describe("G-34 — the retry tax is measurable from meta.veracity", () => {
  /* Two slots: one tape beat with NO connective page (it follows same-item
     tape, so `decideConnectiveNarration` returns null) and three beats
     that get pages. Four beats, three attempted pages — the two
     denominators differ, which is the point of having both rates. */
  const tape = tapePointer({ segmentId: "bbqc-moss-school#1881", itemId: "bbqc-moss-school" });
  const sourced: SourcedAct[] = [
    {
      title: "Act 1",
      slots: [
        {
          title: "Slot 1",
          beats: [
            { sourcing: "tape", claim: "opens", exploration: false, tape },
            { sourcing: "tape", claim: "continues the same tape", exploration: false, tape },
            { sourcing: "narration", claim: "n1", exploration: false, narration: { mode: "Patch", reason: "t" } },
            { sourcing: "narration", claim: "n2", exploration: false, narration: { mode: "Carry", reason: "t" } }
          ]
        }
      ]
    }
  ];

  it("narrationCallsPerBeat divides by EVERY beat, callsPerBeat by attempted pages, and both come from the same counts", () => {
    /* MUTATION THAT KILLS THIS: computing narrationCallsPerBeat over
       attempted pages (it would read 1.0, not 0.75), or dropping the
       raw counts from the report. */
    const veracity = buildVeracityMetrics({
      sourcedActs: sourced,
      writtenActs: [],
      topic: "food/grilling-bbq",
      writerCalls: 2,
      verifierCalls: 1,
      retryRounds: 1,
      pipelineTokens: 0,
      stageTimings: []
    });
    expect(veracity.narrationCallsPerBeat).toBe(3 / 4);
    expect(veracity.callsPerBeat).toBe(3 / 3);
    expect(veracity.narrationCalls).toEqual({ writer: 2, verifier: 1 });
    expect(veracity.retryRounds).toBe(1);
  });

  it("reports retryRounds as null, never as zero, when the caller did not count them", () => {
    /* An older caller that never threaded `NarrationWriteStats` through
       has not measured anything; a zero would claim a clean run. */
    const veracity = buildVeracityMetrics({
      sourcedActs: sourced,
      writtenActs: [],
      topic: "food/grilling-bbq",
      writerCalls: 2,
      verifierCalls: 1,
      pipelineTokens: 0,
      stageTimings: []
    });
    expect(veracity.retryRounds).toBe(null);
    /* And a counted zero is a zero. */
    expect(buildVeracityMetrics({ sourcedActs: sourced, writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, retryRounds: 0, pipelineTokens: 0, stageTimings: [] }).retryRounds).toBe(0);
  });

  it("narrationCallsPerBeat is null with no beats at all, like callsPerBeat", () => {
    const veracity = buildVeracityMetrics({ sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [] });
    expect(veracity.narrationCallsPerBeat).toBe(null);
    expect(veracity.callsPerBeat).toBe(null);
  });
});

describe("GV-26 — MQ-09 tape yield and MQ-11 beat coverage", () => {
  function tapeRow(beatIndex: number, overrides: Partial<TapeRelevanceInput> = {}): TapeRelevanceInput {
    return {
      actIndex: 0,
      slotIndex: 0,
      beatIndex,
      claim: `t${beatIndex}`,
      itemId: "item-1",
      segmentId: "seg#1",
      tier: 1,
      taxonomyNodeIds: ["food/grilling-bbq"],
      families: ["food"],
      forayTopic: "food/grilling-bbq",
      forayFamily: "food",
      onTopic: true,
      ...overrides
    };
  }
  function traceRow(beatIndex: number, outcome: SourcingTrace["outcome"]): SourcingTrace {
    return { actIndex: 0, slotIndex: 0, beatIndex, claim: `n${beatIndex}`, outcome, tier1: null, tier2: null };
  }
  /** A synthetic `SourceBeatsResult`: three tape beats (one whose seed won),
   * one beat that searched and found nothing (its seed lost), and one argument
   * beat that never searched. */
  function sourceBeatsResult(): Pick<SourceBeatsResult, "acts" | "tapeRelevance" | "sourcingTrace"> {
    const tape = tapePointer();
    return {
      acts: [
        {
          title: "Act 1",
          slots: [
            {
              title: "Slot 1",
              beats: [
                { sourcing: "tape", claim: "t0", exploration: false, tape },
                { sourcing: "tape", claim: "t1", exploration: false, tape },
                { sourcing: "tape", claim: "t2", exploration: false, tape },
                { sourcing: "narration", claim: "n3", exploration: false, narration: { mode: "Patch", reason: "r" }, seedLost: true },
                { sourcing: "narration", claim: "n4", exploration: false, narration: { mode: "Carry", reason: "r" } }
              ]
            }
          ]
        }
      ],
      tapeRelevance: [tapeRow(0, { seededEpisode: "ep-1", seedWindowWon: true }), tapeRow(1, { seededEpisode: "ep-2", seedWindowWon: false }), tapeRow(2)],
      sourcingTrace: [traceRow(3, "no-tape"), traceRow(4, "skipped:argument")]
    };
  }

  it("computeTapeYield: 3 tape rows, 1 no-tape, 1 argument -> rate 0.75, with seeds placed and lost", () => {
    /* MUTATION THAT KILLS THIS: count every trace row in wantedBeats (drop the
       `outcome === "no-tape"` filter) — the argument beat, which never searched,
       enters the denominator and the rate reads 0.6. Ran it — red. */
    const r = sourceBeatsResult();
    const yieldResult = computeTapeYield({ tapeRelevance: r.tapeRelevance, sourcingTrace: r.sourcingTrace, sourcedActs: r.acts });
    expect(yieldResult).toEqual({ tapeBeats: 3, wantedBeats: 4, rate: 0.75, seedsPlaced: 1, seedsLost: 1 });
  });

  it("computeTapeYield is null-rated, not zero, when no beat wanted tape", () => {
    expect(computeTapeYield({ tapeRelevance: [], sourcingTrace: [traceRow(0, "skipped:argument")], sourcedActs: [] }).rate).toBe(null);
  });

  it("computeBeatCoverage: the share of narration beats with a verifiedAtAttempt on a per-act candidate, null on a per-page one", () => {
    /* MUTATION THAT KILLS THIS: count only `verifiedAtAttempt === 1` as carried
       (the first-attempt reading) — carried drops to 1 and the rate to 1/3.
       Ran it — red. And dropping the per-act sniff makes the per-page fixture
       read {beats: 1, carried: 0, rate: 0} instead of null — red too. */
    const page = narratedBeat();
    const perAct = actsOf([
      { ...narrationBeat("c1", page), verifiedAtAttempt: 1 } as WrittenBeat,
      { sourcing: "narration", claim: "c2", exploration: false, carriedBy: { slot: 0, beat: 0 }, verifiedAtAttempt: 2 },
      { sourcing: "narration", claim: "c3", exploration: false, carriedBy: { slot: 0, beat: 0 } },
      { sourcing: "tape", claim: "t", exploration: false, tape: tapePointer() }
    ]);
    expect(computeBeatCoverage(perAct)).toEqual({ beats: 3, carried: 2, rate: 2 / 3 });
    expect(computeBeatCoverage(actsOf([narrationBeat("c1", page)]))).toBe(null);
  });

  it("buildVeracityMetrics carries tapeYield when given the sourcing trace, null without it, and beatCoverage beside it", () => {
    /* MUTATION THAT KILLS THIS: drop `tapeYield` (or compute it without the
       trace) in buildVeracityMetrics — the field reads undefined or the wrong
       denominator. Ran it — red. */
    const r = sourceBeatsResult();
    const base = { sourcedActs: r.acts, writtenActs: [], topic: "food/grilling-bbq", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [] };
    const withTrace = buildVeracityMetrics({ ...base, tapeRelevanceRows: r.tapeRelevance, sourcingTrace: r.sourcingTrace });
    expect(withTrace.tapeYield?.rate).toBe(0.75);
    expect(withTrace.beatCoverage).toBe(null);
    expect(buildVeracityMetrics({ ...base, tapeRelevanceRows: r.tapeRelevance }).tapeYield).toBe(null);
  });

  it("the gate is unchanged: a tapeYield or beatCoverage of zero refuses nothing", () => {
    const r = sourceBeatsResult();
    const clean = buildVeracityMetrics({
      sourcedActs: [],
      writtenActs: actsOf([{ sourcing: "narration", claim: "c", exploration: false, carriedBy: { slot: 0, beat: 0 } }]),
      topic: "t",
      writerCalls: 0,
      verifierCalls: 0,
      pipelineTokens: 0,
      stageTimings: [],
      tapeRelevanceRows: [],
      sourcingTrace: [r.sourcingTrace[0]!]
    });
    expect(clean.tapeYield?.rate).toBe(0);
    expect(clean.beatCoverage?.rate).toBe(0);
    const failures = evaluateVeracityGate(clean).failures;
    expect(failures.some((f) => /tapeYield|beatCoverage/.test(f))).toBe(false);
  });
});

describe("GV-34 — specificsUnsupported is computed from each page's own held evidence", () => {
  const STAR = { docId: "print:star", title: "Kansas City Star", text: "joe couitt ran the hotel for a decade" };
  const NBS = { docId: "print:nbs", title: "NBS Building Science Series 143", text: "the connection carried about 60% of the required load" };
  /** Three pages: one states a year its evidence lacks (and a name it has),
   * one states a percent its evidence has in digits, one holds no evidence
   * at all (uncheckable, skipped — it would be flagged if it were read). */
  function specificsActs(): WrittenAct[] {
    return actsOf([
      narrationBeat("c1", narratedBeat({ script: "In 1957 the walkway opened. Joe Couitt ran it.", evidence: [STAR] })),
      narrationBeat("c2", narratedBeat({ script: "It carried sixty percent of the load.", evidence: [NBS] })),
      narrationBeat("c3", narratedBeat({ script: "In 1931 Margaret Haines built it." }))
    ]);
  }

  it("counts the specifics no held document of their page carries, and names the sentence", () => {
    /* MUTATION THAT KILLS THIS: drop the no-evidence skip (read a page with
       no `evidence` against nothing) — the third page's year and name are
       flagged and the count reads 3. Ran it — red. */
    const result = computeSpecificsUnsupported(specificsActs());
    expect(result.count).toBe(1);
    expect(result.checkedPages).toBe(2);
    expect(result.details).toEqual([{ claim: "c1", mode: "Patch", sentence: "In 1957 the walkway opened.", unsupported: ["1957"] }]);
  });

  it("is null, not zero, when no page holds evidence; buildVeracityMetrics carries it, and `off` reports null", () => {
    /* MUTATION THAT KILLS THIS: return `count` instead of null when nothing
       was checked — an unmeasured candidate reads as a clean 0. Ran it — red. */
    expect(computeSpecificsUnsupported(actsOf([narrationBeat("c", narratedBeat({ script: "In 1931 it opened." }))])).count).toBe(null);
    const base = { sourcedActs: [], writtenActs: specificsActs(), topic: "t", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [] };
    const reported = buildVeracityMetrics(base);
    expect(reported.specificsUnsupported).toBe(1);
    expect(reported.specificsDetails).toHaveLength(1);
    expect(buildVeracityMetrics({ ...base, specifics: "off" }).specificsUnsupported).toBe(null);
    expect(evaluateVeracityGate(reported).failures.some((f) => /specifics/i.test(f))).toBe(false);
  });

  it("is identical after a resumed narrate stage — it reads the banked pages, not the run's stats", async () => {
    /* NarrationWriteStats is not checkpointed: a resumed act's counters start
       at zero, so a count kept there is lost on resume. MUTATION THAT KILLS
       THIS: report specificsUnsupported from a run-side counter instead of
       the pages (`input.retryRounds ?? null` in buildVeracityMetrics, the
       shape a stats-kept count would take) — the resumed run reads 0 where
       the fresh one read 2. Ran it — red. */
    const files = new Map<string, string>();
    const store: CheckpointStore = {
      load: (key) => (files.has(key) ? (JSON.parse(files.get(key)!) as CheckpointFile) : null),
      save: (key, stage, data) => {
        const file: CheckpointFile = files.has(key)
          ? (JSON.parse(files.get(key)!) as CheckpointFile)
          : { version: 3, key, fingerprint: "fp", updatedAt: "t", stages: {} };
        file.stages[stage] = data;
        files.set(key, JSON.stringify(file));
      }
    };
    const narrate = async (stats: { retryRounds: number }) => {
      const session = await CheckpointSession.open(store, "foray-1", "fp");
      const { value, resumed } = await session.stage("narrate:0", (raw) => raw as WrittenAct, async () => {
        stats.retryRounds += 2;
        return specificsActs()[0]!;
      });
      return { value, resumed };
    };
    const freshStats = { retryRounds: 0 };
    const fresh = await narrate(freshStats);
    const resumedStats = { retryRounds: 0 };
    const resumed = await narrate(resumedStats);
    expect(fresh.resumed).toBe(false);
    expect(resumed.resumed).toBe(true);
    const metricsOf = (act: WrittenAct, stats: { retryRounds: number }) =>
      buildVeracityMetrics({ sourcedActs: [], writtenActs: [act], topic: "t", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [], retryRounds: stats.retryRounds });
    const a = metricsOf(fresh.value, freshStats);
    const b = metricsOf(resumed.value, resumedStats);
    expect(a.retryRounds).not.toBe(b.retryRounds);
    expect(b.specificsUnsupported).toBe(a.specificsUnsupported);
    expect(b.specificsDetails).toEqual(a.specificsDetails);
    expect(a.specificsUnsupported).toBe(1);
  });
});

describe("GV-79 — clipOnSubject: the clip judge's Scores, aggregated (MQ-05)", () => {
  function row(beatIndex: number, extra: Partial<TapeRelevanceInput> = {}): TapeRelevanceInput {
    return {
      actIndex: 0,
      slotIndex: 0,
      beatIndex,
      claim: `claim ${beatIndex}`,
      itemId: `item-${beatIndex}`,
      segmentId: `seg-${beatIndex}`,
      tier: 2,
      taxonomyNodeIds: ["health/medicine"],
      families: ["health"],
      forayTopic: "health/medicine",
      forayFamily: "health",
      onTopic: true,
      ...extra
    };
  }
  const scores = (subject: number, claim: number, judge: "jev" | "qwen" | "code" = "jev") => ({ subject, claim, judge });

  /* MUTATION THAT KILLS THIS: pass on subject >= 3 alone (drop the claim
     half). Ran it: red (the 4/1 clip passes, rate 2/3). */
  it("rate is the share of scored clips with subject >= 3 AND claim >= 3; failing clips are named", () => {
    const rows = [
      row(0, { clipScores: scores(4, 4) }),
      row(1, { clipScores: scores(0, 2) }),
      row(2, { clipScores: scores(4, 1) })
    ];
    const r = computeClipOnSubject(rows);
    expect(CLIP_ON_SUBJECT_LEVEL).toBe(3);
    expect(r.rate).toBeCloseTo(1 / 3, 10);
    expect(r.offSubject).toEqual([
      { itemId: "item-1", segmentId: "seg-1", claim: "claim 1", scores: scores(0, 2) },
      { itemId: "item-2", segmentId: "seg-2", claim: "claim 2", scores: scores(4, 1) }
    ]);
    expect(r.judge).toBe("jev");
  });

  /* MUTATION THAT KILLS THIS: count an unavailable row as scored (or as a
     pass). Ran it: red (rate 1/2, or 1 on the all-unscored case). */
  it("an unanswered clip counts as unscored, and all-unscored is null, never 1", () => {
    const some = computeClipOnSubject([row(0, { clipScores: scores(3, 3) }), row(1, { clipScores: { unavailable: "http_503" } })]);
    expect(some).toMatchObject({ rate: 1, scored: 1, unscored: 1 });
    const none = computeClipOnSubject([row(0, { clipScores: { unavailable: "no_key" } }), row(1, { clipScores: { unavailable: "network" } })]);
    expect(none).toMatchObject({ rate: null, scored: 0, unscored: 2, judge: null });
  });

  it("ignores rows the judge was never offered and merged beats; names a mixed judge; reads each judge's level", () => {
    const rows = [
      row(0, { clipScores: scores(2, 2, "qwen") }),
      row(1, { clipScores: scores(2, 2, "code") }),
      row(2),
      row(3, { mergedInto: { slot: 0, beat: 0 }, clipScores: scores(0, 0) })
    ];
    const r = computeClipOnSubject(rows, (judge) => (judge === "qwen" ? 2 : 3));
    expect(r).toMatchObject({ scored: 2, unscored: 0, judge: "mixed" });
    expect(r.rate).toBe(0.5);
    expect(r.offSubject.map((c) => c.itemId)).toEqual(["item-1"]);
  });

  /* MUTATION THAT KILLS THIS: always spread the clip fields into the
     metrics. Ran it: red (the default report gains three keys). */
  it("buildVeracityMetrics adds the three fields only when the judge ran: a default report is unchanged", () => {
    const tape = tapePointer({ segmentId: "s#1", itemId: "s" });
    const sourced: SourcedAct[] = [{ title: "Act 1", slots: [{ title: "Slot 1", beats: [{ sourcing: "tape", claim: "c1", exploration: false, tape }] }] }];
    const base = { sourcedActs: sourced, writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
    const plain = buildVeracityMetrics({ ...base, tapeRelevanceRows: [row(0)] });
    expect("clipOnSubjectRate" in plain || "clipOnSubjectJudge" in plain || "clipOnSubjectDetails" in plain).toBe(false);
    const judged = buildVeracityMetrics({ ...base, tapeRelevanceRows: [row(0, { clipScores: scores(1, 4, "code") })], clipOnSubject: {} });
    expect(judged.clipOnSubjectRate).toBe(0);
    expect(judged.clipOnSubjectJudge).toBe("code");
    expect(judged.clipOnSubjectDetails).toEqual({ scored: 1, unscored: 0, offSubject: [expect.objectContaining({ itemId: "item-0" })] });
    expect(judged.tapeRelevance).toBe(1);
  });
});

/**
 * GV-83 (W3-12; MQ-07, QK-21, GP-22): show variety. Pure arithmetic over the
 * Foray's tape items, each already keyed to its show (showIdentity.ts).
 */
describe("GV-83 — computeShowVariety: distinct shows and the largest show's tape share (MQ-07)", () => {
  /* MUTATION THAT KILLS THIS: divide by the number of items instead of the
     tape seconds (`largest / items.length`). Ran it: red. */
  it("counts shows and episodes and gives the largest show's share of tape seconds on a two-show list", () => {
    const r = computeShowVariety([
      { showKey: "geology-bites", itemId: "geology-bites--a", durationSec: 60 },
      { showKey: "geology-bites", itemId: "geology-bites--b", durationSec: 30 },
      { showKey: "geology-bites", itemId: "geology-bites--a", durationSec: 30 },
      { showKey: "title:the grill coach", itemId: "grill-1", durationSec: 40 }
    ]);
    expect(r.distinctShows).toBe(2);
    expect(r.distinctEpisodes).toBe(3);
    expect(r.largestShowKey).toBe("geology-bites");
    expect(r.largestShowTapeShare).toBeCloseTo(120 / 160, 12);
    expect(r.tapeSecByShow).toEqual({ "geology-bites": 120, "title:the grill coach": 40 });
  });

  /* MUTATION THAT KILLS THIS: return `largest / Math.max(total, 1)` (0, not
     null, with no tape). Ran it: red. */
  it("is null, never 0 or 1, with no tape seconds; an empty key is not a show", () => {
    const none = computeShowVariety([]);
    expect(none).toEqual({ distinctShows: 0, distinctEpisodes: 0, largestShowKey: null, largestShowTapeShare: null, tapeSecByShow: {} });
    const zero = computeShowVariety([
      { showKey: "a", itemId: "a--1", durationSec: 0 },
      { showKey: "", itemId: "x", durationSec: 50 },
      { showKey: "b", itemId: "b--1", durationSec: Number.NaN }
    ]);
    expect(zero.distinctShows).toBe(2);
    expect(zero.largestShowKey).toBeNull();
    expect(zero.largestShowTapeShare).toBeNull();
  });

  it("a tie goes to the lexically first key, so the report is stable", () => {
    const r = computeShowVariety([
      { showKey: "zeta", durationSec: 10 },
      { showKey: "alpha", durationSec: 10 }
    ]);
    expect(r.largestShowKey).toBe("alpha");
    expect(r.largestShowTapeShare).toBe(0.5);
    expect(r.distinctEpisodes).toBe(0);
  });

  /* MUTATION THAT KILLS THIS: always add `showVariety` (computed over `[]`
     when no items were passed). Ran it: red (a caller that passes no items
     gains a key). */
  it("buildVeracityMetrics carries showVariety only when given the items, and the gate is unchanged", () => {
    const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
    const plain = buildVeracityMetrics(base);
    expect("showVariety" in plain).toBe(false);
    const single = buildVeracityMetrics({ ...base, showItems: [{ showKey: "one-show", itemId: "one-show--a", durationSec: 90 }] });
    expect(single.showVariety).toMatchObject({ distinctShows: 1, largestShowKey: "one-show", largestShowTapeShare: 1 });
    /* One show carrying all the tape (QK-21's finding) refuses nothing. */
    expect(evaluateVeracityGate(single)).toEqual(evaluateVeracityGate(plain));
  });
});

/**
 * GV-104 (W5-18 + W4-12; MQ-15..MQ-18): the voice block on meta.veracity,
 * from the final narration items. Measure-only: the gate never reads it.
 */
describe("GV-104 — buildVeracityMetrics carries the voice block from the final narration items", () => {
  const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
  const scripts = [
    { id: "prelude", script: "This is a Foray about bridges. Much of what you'll hear is written by AI.", hasTape: false },
    { id: "s0", script: "Interestingly, about 40 percent of the hangers were never checked. So who signed the drawing?", hasTape: false },
    { id: "s1", script: "The walkway hung from a single steel rod that ran through both of them. It held for a year.", hasTape: true }
  ];

  /* MUTATION THAT KILLS THIS: always add `voice` (computed over `[]` when no
     scripts were passed), or ignore `readingGradeBand`. Ran both: red. */
  it("only when given the scripts, read against the given band, and the gate is unchanged", () => {
    const plain = buildVeracityMetrics(base);
    expect("voice" in plain).toBe(false);
    const voiced = buildVeracityMetrics({ ...base, narrationScripts: scripts });
    expect(voiced.voice).toEqual(computeVoiceMetrics(scripts));
    expect(voiced.voice!.gradeBand).toEqual([6, 9]);
    expect(voiced.voice!.items).toBe(3);
    /* s0: a digit, an opener and a question with no tape beside it. */
    expect(voiced.voice!.hardErrors).toBe(voiceReport(scripts[1]!.script, { hasTape: false }).hardErrors.length);
    expect(voiced.voice!.hardErrors).toBe(3);
    expect(buildVeracityMetrics({ ...base, narrationScripts: scripts, readingGradeBand: [0, 1] }).voice!.gradeBand).toEqual([0, 1]);
    expect(evaluateVeracityGate(voiced)).toEqual(evaluateVeracityGate(plain));
  });

  /* MUTATION THAT KILLS THIS: read hasTape from the item itself rather than
     its neighbours (every question then counts as tapeless). Ran it: red. */
  it("a question beside tape is not a hard error; the same question with none is", () => {
    const q = (hasTape: boolean) => buildVeracityMetrics({ ...base, narrationScripts: [{ script: "So who signed the drawing?", hasTape }] }).voice!.hardErrors;
    expect(q(true)).toBe(0);
    expect(q(false)).toBe(1);
  });
});

describe("GV-106 — MQ-14 tier fit: reported on every candidate, gated only under FORAY_GATE_TIER_FIT", () => {
  const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };

  /* MUTATION THAT KILLS THIS: drop the lower bound from `withinTolerance`
     (`runtimeSec <= max`), or leave `ratio` unrounded. Ran both: red. */
  it("computeTierFit: target, ratio and the ±15 % band, both ends inclusive (14 Sep's 37-minute short is 2.467x)", () => {
    expect(computeTierFit("short", 37 * 60)).toEqual({ tier: "short", targetSec: 900, runtimeSec: 2220, ratio: 2.467, withinTolerance: false });
    expect(computeTierFit("short", 1035).withinTolerance).toBe(true);
    expect(computeTierFit("short", 1036).withinTolerance).toBe(false);
    expect(computeTierFit("short", 765).withinTolerance).toBe(true);
    expect(computeTierFit("short", 764).withinTolerance).toBe(false);
    expect(computeTierFit("medium", 3600)).toEqual({ tier: "medium", targetSec: 3600, runtimeSec: 3600, ratio: 1, withinTolerance: true });
    expect(computeTierFit("long", 9000).ratio).toBe(0.833);
  });

  /* MUTATION THAT KILLS THIS: always add `tierFit` (computed with runtime
     0 when the caller passed none). Ran it: red. */
  it("buildVeracityMetrics carries tierFit only when given the tier and runtime; a non-finite runtime reports null", () => {
    const plain = buildVeracityMetrics(base);
    expect("tierFit" in plain).toBe(false);
    const fitted = buildVeracityMetrics({ ...base, tierFit: { tier: "short", runtimeSec: 990 } });
    expect(fitted.tierFit).toEqual(computeTierFit("short", 990));
    expect(buildVeracityMetrics({ ...base, tierFit: { tier: "short", runtimeSec: Number.NaN } }).tierFit).toBeNull();
    /* The default gate cannot see it. */
    expect(evaluateVeracityGate(fitted)).toEqual(evaluateVeracityGate(plain));
  });

  /* MUTATIONS THAT KILL THIS: drop the `options.tierFit === true` guard (the
     default gate refuses the 37-minute short); compare against the band's
     target instead of its ceiling (a 1,000 s short is refused); treat a null
     tierFit as passing. Ran each: red. */
  it("evaluateVeracityGate is unchanged unless {tierFit: true}, which refuses a 37-minute short and a null or absent tierFit, never an undershoot", () => {
    const passing = (): VeracityMetrics => ({
      ...buildVeracityMetrics(base),
      groundedQuoteRate: 1,
      purposeFidelity: 1
    });
    expect(evaluateVeracityGate(passing()).ok).toBe(true);
    const long = { ...passing(), tierFit: computeTierFit("short", 37 * 60) };
    expect(evaluateVeracityGate(long)).toEqual(evaluateVeracityGate(passing()));
    expect(evaluateVeracityGate(long, {})).toEqual(evaluateVeracityGate(passing()));
    const refused = evaluateVeracityGate(long, { tierFit: true });
    expect(refused.ok).toBe(false);
    expect(refused.failures).toHaveLength(1);
    expect(refused.failures[0]).toMatch(/^tier runtime above \+15%: 2220 s is 2\.467x the short tier's 900 s target, over its 1035 s ceiling$/);
    expect(evaluateVeracityGate({ ...passing(), tierFit: computeTierFit("short", 1000) }, { tierFit: true }).ok).toBe(true);
    expect(evaluateVeracityGate({ ...passing(), tierFit: computeTierFit("short", 1035) }, { tierFit: true }).ok).toBe(true);
    expect(evaluateVeracityGate({ ...passing(), tierFit: computeTierFit("short", 300) }, { tierFit: true }).ok).toBe(true);
    for (const unmeasured of [{ ...passing(), tierFit: null }, passing()]) {
      const gate = evaluateVeracityGate(unmeasured, { tierFit: true });
      expect(gate.ok).toBe(false);
      expect(gate.failures[0]).toMatch(/^tierFit is null/);
    }
  });
});

describe("GV-109 — MQ-06 clean cuts: computed on every candidate, gated only under FORAY_CLEAN_CUT_GATE=enforce", () => {
  const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
  function row(beatIndex: number, extra: Partial<TapeRelevanceInput> = {}): TapeRelevanceInput {
    return {
      actIndex: 0,
      slotIndex: 0,
      beatIndex,
      claim: `claim ${beatIndex}`,
      itemId: `item-${beatIndex}`,
      segmentId: `seg-${beatIndex}`,
      tier: 2,
      taxonomyNodeIds: ["health/medicine"],
      families: ["health"],
      forayTopic: "health/medicine",
      forayFamily: "health",
      onTopic: true,
      ...extra
    };
  }
  /** A tier-2 clip with both edge kinds, `boundary` the weaker. */
  const cut = (beatIndex: number, start: TapeRelevanceInput["boundary"], end: TapeRelevanceInput["boundary"]) => {
    const rank = { "claim-only": 0, sentence: 1, turn: 2 } as const;
    return row(beatIndex, { boundary: rank[start!] <= rank[end!] ? start : end, startBoundary: start, endBoundary: end, extendedBySec: 10 });
  };

  /* MUTATIONS THAT KILL THIS: count a clip clean when EITHER edge is on a
     boundary (`||` for `&&`) — the rate reads 3/4; count tier-1 rows (no
     boundary) as known — known reads 6; count a merged beat's row as a clip
     of its own — known reads 5. Ran each: red. */
  it("computeCleanCuts on mixed rows: both edges clean, the opening alone, unknown tier-1 and pool cuts, merged beats counted once", () => {
    const rows = [
      cut(0, "turn", "turn"),
      cut(1, "sentence", "turn"),
      cut(2, "claim-only", "sentence"),
      cut(3, "turn", "claim-only"),
      /* Tier 1 and a reused pool cut: a curator's edges, unknown. */
      row(4, { tier: 1 }),
      row(5, { tier: 1, poolCut: "reused" }),
      /* A beat riding in clip 0 (F-96): the clip is counted once, on row 0. */
      { ...cut(6, "turn", "turn"), mergedInto: { slot: 0, beat: 0 } }
    ];
    const result = computeCleanCuts(rows);
    expect(result.known).toBe(4);
    expect(result.unknown).toBe(2);
    expect(result.rate).toBe(0.5);
    expect(result.openingCleanRate).toBe(0.75);
    expect(result.claimOnlyOpenings).toEqual([{ itemId: "item-2", segmentId: "seg-2", claim: "claim 2" }]);
  });

  /* MUTATION THAT KILLS THIS: read a row with no per-edge kinds as unknown
     (require `startBoundary` for `known`) — known reads 0 and both rates null. */
  it("unknown handling: a row written before GV-109 (boundary only) still counts, by its weaker edge; no boundary at all is null, not zero", () => {
    const legacy = computeCleanCuts([row(0, { boundary: "sentence" }), row(1, { boundary: "claim-only" })]);
    expect(legacy.known).toBe(2);
    expect(legacy.rate).toBe(0.5);
    /* A sentence-or-better `boundary` says the opening is clean; a claim-only
       one cannot say which edge, so the opening is not counted. */
    expect(legacy.openingCleanRate).toBe(1);
    expect(legacy.claimOnlyOpenings).toEqual([]);
    expect(computeCleanCuts([row(0, { tier: 1 })])).toEqual({ rate: null, openingCleanRate: null, known: 0, unknown: 1, claimOnlyOpenings: [] });
    expect(computeCleanCuts([])).toEqual({ rate: null, openingCleanRate: null, known: 0, unknown: 0, claimOnlyOpenings: [] });
  });

  /* MUTATION THAT KILLS THIS: compute the fields with no rows (`computeCleanCuts(
     input.tapeRelevanceRows ?? [])`) — a candidate built without rows grows
     `cleanCutRate: null`. Ran it: red. */
  it("buildVeracityMetrics always carries the clean-cut fields when given the rows, and not otherwise", () => {
    const plain = buildVeracityMetrics(base);
    expect("cleanCutRate" in plain).toBe(false);
    expect("cleanCutDetails" in plain).toBe(false);
    const measured = buildVeracityMetrics({ ...base, tapeRelevanceRows: [cut(0, "turn", "turn"), cut(1, "claim-only", "turn")] });
    expect(measured.cleanCutRate).toBe(0.5);
    expect(measured.cleanCutDetails).toEqual({
      openingCleanRate: 0.5,
      known: 2,
      unknown: 0,
      claimOnlyOpenings: [{ itemId: "item-1", segmentId: "seg-1", claim: "claim 1" }]
    });
  });

  /* MUTATIONS THAT KILL THIS: drop the `options.cleanCutGate === "enforce"`
     guard (report refuses the 0.5 Foray); compare with `<=` (a 0.9 Foray is
     refused); fail a Foray with no known clip (known 0); pass an unmeasured
     candidate. Ran each: red. */
  it("the gate in report vs enforce: report is the verdict before GV-109; enforce refuses under 0.9, N/A at known 0, fails null or unmeasured", () => {
    const passing = (rows: TapeRelevanceInput[]): VeracityMetrics => ({
      ...buildVeracityMetrics({ ...base, tapeRelevanceRows: rows }),
      groundedQuoteRate: 1,
      purposeFidelity: 1,
      tapeRelevance: 1
    });
    const half = passing([cut(0, "turn", "turn"), cut(1, "claim-only", "turn")]);
    expect(evaluateVeracityGate(half)).toEqual({ ok: true, failures: [] });
    expect(evaluateVeracityGate(half, { cleanCutGate: "report" })).toEqual({ ok: true, failures: [] });
    const refused = evaluateVeracityGate(half, { cleanCutGate: "enforce" });
    expect(refused.ok).toBe(false);
    expect(refused.failures).toEqual([
      `cleanCutRate 0.500 < ${GATE_MIN_CLEAN_CUT_RATE} over 2 clip(s) with a boundary`,
      "  opens mid-thought: seg-1 (claim 1)"
    ]);
    expect(GATE_MIN_CLEAN_CUT_RATE).toBe(0.9);
    /* Nine clean of ten is exactly the floor, and passes. */
    const nine = passing([...Array.from({ length: 9 }, (_, k) => cut(k, "turn", "sentence")), cut(9, "turn", "claim-only")]);
    expect(nine.cleanCutRate).toBe(0.9);
    expect(evaluateVeracityGate(nine, { cleanCutGate: "enforce" }).ok).toBe(true);
    /* No clip carries a boundary (tier-1 tape only): N/A. */
    expect(evaluateVeracityGate(passing([row(0, { tier: 1 })]), { cleanCutGate: "enforce" }).ok).toBe(true);
    /* A null rate with known clips fails, and so does a candidate on which the
       measurement never ran. */
    const nulled = { ...half, cleanCutRate: null };
    expect(evaluateVeracityGate(nulled, { cleanCutGate: "enforce" }).failures[0]).toMatch(/^cleanCutRate is null despite 2 clip\(s\)/);
    const unmeasured = { ...half };
    delete unmeasured.cleanCutRate;
    delete unmeasured.cleanCutDetails;
    expect(evaluateVeracityGate(unmeasured, { cleanCutGate: "enforce" }).failures[0]).toMatch(/^cleanCutRate was never measured/);
    expect(evaluateVeracityGate(unmeasured)).toEqual({ ok: true, failures: [] });
  });

  /* publishForay's read-only gate check reads the same key. MUTATION THAT
     KILLS THIS: drop the `cleanCutGate === "enforce"` spread from
     `publishGateOptions` (enforce publishes the 0.5 Foray). Ran it: red. */
  it("publishGateOptions adds the clean-cut floor only under FORAY_CLEAN_CUT_GATE=enforce, and fails fast on a malformed value", () => {
    expect(publishGateOptions({})).toEqual({});
    expect(publishGateOptions({ FORAY_CLEAN_CUT_GATE: "report" })).toEqual({});
    expect(publishGateOptions({ FORAY_CLEAN_CUT_GATE: "enforce" })).toEqual({ cleanCutGate: "enforce" });
    expect(publishGateOptions({ FORAY_CLEAN_CUT_GATE: "enforce", FORAY_GATE_TIER_FIT: "1" })).toEqual({ tierFit: true, cleanCutGate: "enforce" });
    expect(() => publishGateOptions({ FORAY_CLEAN_CUT_GATE: "strict" })).toThrow(/FORAY_CLEAN_CUT_GATE/);
    const half: VeracityMetrics = {
      ...buildVeracityMetrics({ ...base, tapeRelevanceRows: [cut(0, "turn", "turn"), cut(1, "claim-only", "turn")] }),
      groundedQuoteRate: 1,
      purposeFidelity: 1
    };
    expect(evaluateVeracityGate(half, publishGateOptions({})).ok).toBe(true);
    expect(evaluateVeracityGate(half, publishGateOptions({ FORAY_CLEAN_CUT_GATE: "enforce" })).ok).toBe(false);
  });
});

describe("GV-113 — sentencesSurviving: the sentences the writer wrote that reach the listener (R2-10)", () => {
  const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
  const page = (script: string, extra: Partial<NarratedBeat> = {}): NarratedBeat => ({ mode: "Patch", script, sources: [], pronunciationHints: [], verified: true, ...extra });
  const narrationBeat = (narration: NarratedBeat): WrittenBeat => ({ sourcing: "narration", claim: "c", exploration: false, narration });
  const clipPointer: TapePointer = { segmentId: "item-a#10", itemId: "item-a", startSec: 10, endSec: 70, startAnchor: "so the first thing", endAnchor: "was a hire", tier: 1, confidence: "high" };
  const act = (...beats: WrittenBeat[]): WrittenAct => ({ title: "Act 1", slots: [{ title: "s", beats }] });
  /* Two pages: a trimmed one (two sentences kept, one cut), and one untouched
     (three sentences). A carried beat holds no page and counts nothing. */
  const trimmed = act(
    narrationBeat(page("The hangers carried double the load. Investigators traced the change.", { cutSentences: ["Nobody ever checked the welds."] })),
    { sourcing: "narration", claim: "c2", exploration: false, carriedBy: { slot: 0, beat: 0 } },
    narrationBeat(page("One. Two sentences here. And a third?"))
  );

  /* MUTATION THAT KILLS THIS: count a page's cut sentences as surviving (or
     skip them), or count every page's sentences from `cutSentences` alone.
     Ran both: red. */
  it("counts every kept page's sentences against the ones the pages record as cut", () => {
    expect(computeSentencesSurviving([trimmed])).toEqual({ surviving: 5, cut: 1, rate: 5 / 6 });
    expect(computeSentencesSurviving([])).toEqual({ surviving: 0, cut: 0, rate: null });
    /* A page cut to its introduction (GV-108) counts its cut sentences too. */
    const intro = act({
      sourcing: "tape",
      claim: "t",
      exploration: false,
      tape: clipPointer,
      connectiveNarration: page("Next, from Practical AI.", { mode: "Intro", verification: { kind: "intro-only", clipId: "c0" }, cutSentences: ["A.", "B."] })
    });
    expect(computeSentencesSurviving([intro])).toEqual({ surviving: 1, cut: 2, rate: 1 / 3 });
  });

  /* MUTATION THAT KILLS THIS: report the two fields unconditionally (the
     default report gains keys), or only under the `cut` input (a pipeline
     run, which does not pass the policy, never reports a cut it made), or
     count GV-108's intro-only pages as a sentence cut (a cut-seam-policy
     report gains keys). Ran all three: red. */
  it("reported under the cut policy or when a sentence-cut page plays whole, never on a default report", () => {
    const untouched = act(narrationBeat(page("One sentence. And another.")));
    const plain = buildVeracityMetrics({ ...base, writtenActs: [untouched] });
    expect("sentencesSurvivingRate" in plain).toBe(false);
    expect("sentencesCut" in plain).toBe(false);
    expect("sentencesCut" in buildVeracityMetrics({ ...base, writtenActs: [untouched], sentencePolicy: "rewrite" })).toBe(false);
    const policyOn = buildVeracityMetrics({ ...base, writtenActs: [untouched], sentencePolicy: "cut" });
    expect(policyOn.sentencesSurvivingRate).toBe(1);
    expect(policyOn.sentencesCut).toBe(0);
    const fromPages = buildVeracityMetrics({ ...base, writtenActs: [trimmed] });
    expect(fromPages.sentencesSurvivingRate).toBe(5 / 6);
    expect(fromPages.sentencesCut).toBe(1);
    const introOnly = act({
      sourcing: "tape",
      claim: "t",
      exploration: false,
      tape: clipPointer,
      connectiveNarration: page("Next, from Practical AI.", { mode: "Intro", verification: { kind: "intro-only", clipId: "c0" }, cutSentences: ["A."] })
    });
    expect("sentencesCut" in buildVeracityMetrics({ ...base, writtenActs: [introOnly], unverifiedSeamPolicy: "cut" })).toBe(false);
    expect(evaluateVeracityGate(fromPages)).toEqual(evaluateVeracityGate(plain));
  });
});
