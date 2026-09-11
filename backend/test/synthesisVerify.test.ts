import { describe, it, expect } from "vitest";
import {
  countSynthesisCandidates,
  forayPageId,
  isSynthesisEligible,
  pageDocIdFor,
  pageDocsFor,
  refusalFor,
  verifiedPageSummaries,
  verifyBySynthesis,
  SYNTHESIS_SLOT_TITLE
} from "../src/generation/synthesisVerify";
import { HANDOFF_MODE, HANDOFF_SCRIPT, NO_EVIDENCE_NOTE, NARRATION_PAGE_ATTEMPTS, type WrittenAct, type WrittenBeat } from "../src/generation/writeNarration";
import { buildVeracityMetrics, computeSynthesisVerifiedPages, computeUnverifiedPages, evaluateVeracityGate } from "../src/generation/veracityMetrics";
import { buildSynthesisPrompt } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder, namedCasesIn, synthesisVerdictFor } from "../src/generation/StubNarrationVerifierBuilder";
import type { NarrationBuildContext, NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type {
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
  SynthesisVerifyRequest,
  SynthesisVerifyResult
} from "../src/generation/NarrationVerifierBuilder";
import { NarratedBeatSchema, isSynthesisVerified, validateNarratedBeat, type NarratedBeat } from "../src/types/narration";
import type { Voice } from "../src/types/spine";
import { BANNED } from "../src/copy/rules";

/**
 * F-88 (generation run 7 attempt 4, 2026-09-11): ten of 49 pages were
 * kept unverified and nine were Hinges carrying the Foray's thesis —
 * "Most retellings of engineering disasters compress months or years of
 * decisions into a single moment", "Treating a disaster as one bad
 * decision by one bad actor is comforting" — each an F-60 hand-off whose
 * two retrieval queries found nothing, because a generalisation across
 * the Foray's own cases is not a sentence print contains. This suite pins
 * SYNTHESIS VERIFICATION as implemented in `synthesisVerify.ts`:
 *
 *   - a Hinge whose retrieval returned nothing is written from the
 *     Foray's verified pages and verified as a synthesis of them, recorded
 *     as `verification: { kind: "synthesis", restsOn, attempt }`;
 *   - the same Hinge naming a case no verified page covers stays
 *     unverified — THE mutation test;
 *   - a Patch (or any page that had evidence) never goes through it;
 *   - a synthesis never rests on another synthesis;
 *   - the verifier's answer is checked in code — an id that is not a
 *     verified page, or a quoted page left out of `restsOn`, is a refusal;
 *   - the veracity gate counts such pages as `synthesisVerifiedPages`,
 *     treats them as verified, and the publish PR names what they rest on.
 *
 * Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* Three verified pages establishing three cases — the ground a thesis
   Hinge about "disasters as months of decisions" may rest on. */
const HYATT =
  "The Hyatt Regency walkways fell because a fabricator changed the hanger rod detail and nobody checked the new connection. " +
  "That change was reviewed as a routine substitution, and the drawings were stamped without a calculation.";
const CHALLENGER =
  "The Challenger launch went ahead after engineers at Thiokol argued against flying in the cold. " +
  "Their objection was overruled the night before, in a teleconference that turned into a management decision.";
const TACOMA =
  "Tacoma Narrows was slender by design, and the deck had been oscillating for months before it tore apart. " +
  "Engineers had watched it move and called it Galloping Gertie.";

function verifiedPatch(script: string, claimText: string, publication: string): NarratedBeat {
  return {
    mode: "Patch",
    script,
    sources: [{ claimText, quote: script.split(". ")[0]!, publication, contested: false }],
    pronunciationHints: [],
    verified: true,
    purposeAccomplished: true
  };
}

function narration(claim: string, page: NarratedBeat): WrittenBeat {
  return { sourcing: "narration", claim, exploration: false, narration: page };
}

/** F-60's hand-off, exactly as `writeNarration.ts` leaves it. */
function handOff(): NarratedBeat {
  return {
    mode: HANDOFF_MODE,
    script: HANDOFF_SCRIPT,
    sources: [],
    pronunciationHints: [],
    verified: false,
    unverifiedReason: "no-evidence",
    verifierNotes: NO_EVIDENCE_NOTE,
    evidence: [],
    attempts: []
  };
}

const THESIS = "Most retellings compress the Hyatt Regency collapse and the Challenger launch into one moment";
const UNCOVERED = "The same pattern shows in the Ukrainian grid intrusions";

/** Act 0 holds Hyatt and Challenger; act 1 holds the thesis Hinge (p0)
 * and Tacoma (p1). Foray-wide ids: a0/s0/p0, a0/s1/p0, a1/s0/p0, a1/s0/p1. */
function foray(thesisClaim = THESIS, thesisPage: NarratedBeat = handOff()): WrittenAct[] {
  return [
    {
      title: "Act 1",
      slots: [
        { title: "Kansas City", beats: [narration("The Hyatt Regency walkway collapse followed a design substitution", verifiedPatch(HYATT, "The hanger rod detail was changed by the fabricator", "NBS 143"))] },
        { title: "Cape Canaveral", beats: [narration("The Challenger decision was made the night before", verifiedPatch(CHALLENGER, "Thiokol engineers argued against the launch", "Rogers Commission"))] }
      ]
    },
    {
      title: "Act 2",
      slots: [
        {
          title: "The thesis",
          beats: [narration(thesisClaim, thesisPage), narration("Tacoma Narrows oscillated for months", verifiedPatch(TACOMA, "The deck oscillated for months before failing", "WSDOT history"))]
        }
      ]
    }
  ];
}

const THESIS_ID = forayPageId(1, 0, 0);

function countingWriter(): NarrationWriterBuilder & { calls: number } {
  const inner = new StubNarrationWriterBuilder();
  const w = {
    providerName: "counting-stub",
    calls: 0,
    selectClaims: (r: Parameters<NarrationWriterBuilder["selectClaims"]>[0], c: NarrationBuildContext) => (w.calls++, inner.selectClaims(r, c)),
    writePages: (r: Parameters<NarrationWriterBuilder["writePages"]>[0], c: NarrationBuildContext) => (w.calls++, inner.writePages(r, c)),
    selectAndWrite: (r: Parameters<NonNullable<NarrationWriterBuilder["selectAndWrite"]>>[0], c: NarrationBuildContext) => (w.calls++, inner.selectAndWrite(r, c))
  };
  return w;
}

/** A verifier whose synthesis answer is canned — for the code-side checks
 * on the verdict. Never asked the three ordinary questions here. */
function scriptedVerifier(answer: (request: SynthesisVerifyRequest) => SynthesisVerifyResult): NarrationVerifierBuilder & { synthesisCalls: number } {
  const v = {
    providerName: "scripted",
    synthesisCalls: 0,
    async verifySlot(_r: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      throw new Error("the synthesis pass must never ask the ordinary three questions");
    },
    async verifySynthesis(request: SynthesisVerifyRequest): Promise<SynthesisVerifyResult> {
      v.synthesisCalls++;
      return answer(request);
    }
  };
  return v;
}

async function runPass(acts: WrittenAct[], writer: NarrationWriterBuilder = new StubNarrationWriterBuilder(), verifier: NarrationVerifierBuilder = new StubNarrationVerifierBuilder()) {
  const act1 = await verifyBySynthesis(acts[1]!, 1, acts, { writer, verifier }, voice, ctx);
  return { acts: [acts[0]!, act1], thesis: (act1.slots[0]!.beats[0] as Extract<WrittenBeat, { sourcing: "narration" }>).narration };
}

describe("F-88 — a thesis Hinge is verified by synthesis of the Foray's own verified pages", () => {
  it("writes the hand-off from the verified pages and records verification.kind = synthesis with the pages it rests on", async () => {
    /* MUTATION THAT KILLS THIS: leave the F-60 hand-off as it is (skip
       the pass), or accept without recording `restsOn`. */
    const { thesis } = await runPass(foray());

    expect(thesis.verified).toBe(true);
    expect(isSynthesisVerified(thesis)).toBe(true);
    expect(thesis.verification).toEqual({ kind: "synthesis", restsOn: expect.arrayContaining([forayPageId(0, 0, 0), forayPageId(0, 1, 0)]), attempt: 1 });
    expect(thesis.unverifiedReason).toBeUndefined();
    expect(thesis.mode).toBe("Hinge");
    expect(thesis.script).not.toBe(HANDOFF_SCRIPT);
    expect(thesis.attempts).toHaveLength(1);
    expect(thesis.attempts![0]!.rejected).toBe(false);
  });

  it("every id in restsOn is a page verified the ordinary way, and never the thesis itself", async () => {
    /* MUTATION THAT KILLS THIS: let the verdict name any id. */
    const { thesis } = await runPass(foray());
    const ground = new Set(verifiedPageSummaries(foray()).map((p) => p.pageId));
    expect(ground.has(THESIS_ID)).toBe(false);
    for (const id of thesis.verification!.restsOn) expect(ground.has(id)).toBe(true);
  });

  it("the synthesis page's quotes are verbatim spans of the pages it rests on, so it passes every mechanical rule with those pages as its held documents", async () => {
    /* MUTATION THAT KILLS THIS: write the page from nothing (skip
       `draftRound`), or hand it the Foray's pages as prose rather than as
       documents it must quote. */
    const { thesis } = await runPass(foray());
    expect(thesis.sources.length).toBeGreaterThan(0);
    expect(thesis.evidence!.length).toBeGreaterThan(0);
    for (const doc of thesis.evidence!) expect(thesis.verification!.restsOn).toContain(doc.docId.replace(/^page:/, ""));
    const result = validateNarratedBeat(thesis, { bannedPhrasePatterns: BANNED, heldDocs: thesis.evidence, purposeText: THESIS });
    expect(result.issues.map((i) => i.code)).toEqual([]);
    for (const s of thesis.sources) expect(thesis.evidence!.some((d) => d.title === s.publication)).toBe(true);
  });

  it("the page record round-trips the checkpoint schema, and a synthesis that rests on nothing is not a record", () => {
    /* MUTATION THAT KILLS THIS: add `verification` outside the strict
       schema, or drop `.min(1)` on `restsOn`. */
    const page: NarratedBeat = { ...handOff(), verified: true, unverifiedReason: undefined, verification: { kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 2 } };
    delete (page as { unverifiedReason?: unknown }).unverifiedReason;
    expect(NarratedBeatSchema.parse(page).verification).toEqual({ kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 2 });
    expect(() => NarratedBeatSchema.parse({ ...page, verification: { kind: "synthesis", restsOn: [], attempt: 1 } })).toThrow();
    expect(isSynthesisVerified({ verified: false, verification: { kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 1 } })).toBe(false);
  });
});

describe("F-88 — the mutation test: a Hinge naming a case no verified page covers stays unverified", () => {
  it("'Ukrainian grid intrusions' has no page, so the page is refused on every attempt and keeps its no-evidence record", async () => {
    /* MUTATION THAT KILLS THIS: verify any Hinge that quotes a page,
       without asking whether every case it names is covered. */
    const writer = countingWriter();
    const { thesis } = await runPass(foray(UNCOVERED), writer);

    expect(thesis.verified).toBe(false);
    expect(thesis.verification).toBeUndefined();
    expect(thesis.unverifiedReason).toBe("no-evidence");
    expect(thesis.script).toBe(HANDOFF_SCRIPT);
    expect(thesis.verifierNotes).toMatch(/Ukrainian/);
    expect(thesis.verifierNotes!.startsWith(NO_EVIDENCE_NOTE)).toBe(true);
    /* Three attempts, every one a refusal, and the writer was paid for
       each (the retry path re-runs prose from the grounded claims). */
    expect(thesis.attempts).toHaveLength(NARRATION_PAGE_ATTEMPTS);
    expect(thesis.attempts!.every((a) => a.rejected)).toBe(true);
    expect(writer.calls).toBe(NARRATION_PAGE_ATTEMPTS);
    expect(computeUnverifiedPages([foray(UNCOVERED)[0]!, foray(UNCOVERED)[1]!]).count).toBe(1);
  });

  it("the stub verifier refuses on the uncovered case by name and rests on the pages that carry the covered ones", () => {
    /* MUTATION THAT KILLS THIS: read named cases from the script only
       (the stub writer lower-cases the purpose into it), or skip the
       sentence-initial rule so 'The' and 'Most' become cases. */
    const summaries = verifiedPageSummaries(foray());
    const brief = (purpose: string) => ({
      pageId: THESIS_ID,
      purpose,
      mode: "Hinge" as const,
      script: `This line closes what just played and opens the idea that ${purpose.toLowerCase()}.`,
      sources: [],
      evidence: { purpose, beatKind: "account" as const, docs: pageDocsFor(summaries) }
    });
    const refused = synthesisVerdictFor(brief(UNCOVERED), summaries);
    expect(refused.synthesis).toBe(false);
    expect(refused.restsOn).toEqual([]);
    expect(refused.notes).toMatch(/"Ukrainian"/);

    const accepted = synthesisVerdictFor(brief(THESIS), summaries);
    expect(accepted.synthesis).toBe(true);
    expect(accepted.restsOn.sort()).toEqual([forayPageId(0, 0, 0), forayPageId(0, 1, 0)]);

    expect(namedCasesIn(THESIS)).toEqual(["Hyatt", "Regency", "Challenger"]);
    expect(namedCasesIn(UNCOVERED)).toEqual(["Ukrainian"]);
    expect(namedCasesIn("This line opens the idea. Most of it is plain.")).toEqual([]);
    expect(synthesisVerdictFor(brief(THESIS), []).synthesis).toBe(false);
  });
});

describe("F-88 — eligibility: only a Hinge or Frame whose retrieval returned nothing", () => {
  it("a Patch kept unverified after every attempt never goes through synthesis — no writer or verifier call, act returned as it was", async () => {
    /* MUTATION THAT KILLS THIS: make eligibility `!verified`. */
    const patch: NarratedBeat = { ...verifiedPatch(TACOMA, "c", "P"), verified: false, verifierNotes: "the verifier objected" };
    const acts = foray("A Patch the verifier refused", patch);
    const writer = countingWriter();
    const verifier = scriptedVerifier(() => ({ pages: [{ pageId: THESIS_ID, synthesis: true, restsOn: [forayPageId(0, 0, 0)] }] }));

    expect(countSynthesisCandidates(acts[1]!)).toBe(0);
    const act1 = await verifyBySynthesis(acts[1]!, 1, acts, { writer, verifier }, voice, ctx);
    expect(act1).toBe(acts[1]);
    expect(writer.calls).toBe(0);
    expect(verifier.synthesisCalls).toBe(0);
    expect(isSynthesisEligible(patch)).toBe(false);
  });

  it("a Hinge the verifier refused on its evidence, and a no-page hand-off, are not eligible either; a Frame with no evidence is", () => {
    /* MUTATION THAT KILLS THIS: test the mode alone. */
    expect(isSynthesisEligible({ verified: false, mode: "Hinge" })).toBe(false);
    expect(isSynthesisEligible({ verified: false, mode: "Hinge", unverifiedReason: "no-page" })).toBe(false);
    expect(isSynthesisEligible({ verified: false, mode: "Frame", unverifiedReason: "no-evidence" })).toBe(true);
    expect(isSynthesisEligible({ verified: false, mode: "Hinge", unverifiedReason: "no-evidence" })).toBe(true);
    expect(isSynthesisEligible({ verified: false, mode: "Carry", unverifiedReason: "no-evidence" })).toBe(false);
    expect(isSynthesisEligible({ verified: true, mode: "Hinge", unverifiedReason: "no-evidence" })).toBe(false);
    expect(countSynthesisCandidates(foray()[1]!)).toBe(1);
  });

  it("a synthesis never rests on another synthesis: a Foray whose only verified pages are syntheses offers no ground", async () => {
    /* MUTATION THAT KILLS THIS: drop the `isSynthesisVerified` exclusion
       from `verifiedPageSummaries`. */
    const synthesised: NarratedBeat = { ...verifiedPatch(HYATT, "c", "P"), mode: "Hinge", verification: { kind: "synthesis", restsOn: ["a9/s9/p9"], attempt: 1 } };
    const acts: WrittenAct[] = [
      { title: "Act 1", slots: [{ title: "s", beats: [narration("a synthesis", synthesised)] }] },
      { title: "Act 2", slots: [{ title: "s", beats: [narration(THESIS, handOff())] }] }
    ];
    expect(verifiedPageSummaries(acts)).toEqual([]);
    const writer = countingWriter();
    const act1 = await verifyBySynthesis(acts[1]!, 1, acts, { writer, verifier: new StubNarrationVerifierBuilder() }, voice, ctx);
    expect(writer.calls).toBe(0);
    expect((act1.slots[0]!.beats[0] as Extract<WrittenBeat, { sourcing: "narration" }>).narration.verified).toBe(false);
  });

  it("a verified page that asserts nothing (no sources) is not ground, and an act whose narration has not landed contributes nothing", () => {
    /* MUTATION THAT KILLS THIS: count every `verified: true` page. */
    const empty: NarratedBeat = { mode: "Hinge", script: "What comes next? Listen for the turn.", sources: [], pronunciationHints: [], verified: true };
    const acts: Array<WrittenAct | undefined> = [{ title: "Act 1", slots: [{ title: "s", beats: [narration("hand-off", empty)] }] }, undefined, foray()[0]];
    expect(verifiedPageSummaries(acts).map((p) => p.pageId)).toEqual([forayPageId(2, 0, 0), forayPageId(2, 1, 0)]);
    expect(pageDocsFor(verifiedPageSummaries(acts))[0]).toMatchObject({ docId: pageDocIdFor(forayPageId(2, 0, 0)), kind: "page", text: HYATT });
  });
});

describe("F-88 — the verifier's answer is checked in code", () => {
  const ground = new Set([forayPageId(0, 0, 0), forayPageId(0, 1, 0)]);
  const docs = pageDocsFor(verifiedPageSummaries(foray()));
  const quotesHyatt = { sources: [{ claimText: "c", quote: "q", publication: docs[0]!.title, contested: false }] };

  it("an accepted verdict must name verified pages, all of them real, including every page the script quotes", () => {
    /* MUTATION THAT KILLS THIS: trust `restsOn` as returned. */
    expect(refusalFor(undefined, quotesHyatt, ground, docs)).toMatch(/no synthesis verdict/);
    expect(refusalFor({ pageId: THESIS_ID, synthesis: false, restsOn: [], notes: "names Ukraine" }, quotesHyatt, ground, docs)).toMatch(/names Ukraine/);
    expect(refusalFor({ pageId: THESIS_ID, synthesis: true, restsOn: [] }, quotesHyatt, ground, docs)).toMatch(/rests on nothing/);
    expect(refusalFor({ pageId: THESIS_ID, synthesis: true, restsOn: ["a9/s9/p9"] }, quotesHyatt, ground, docs)).toMatch(/a9\/s9\/p9, which is not a verified page/);
    expect(refusalFor({ pageId: THESIS_ID, synthesis: true, restsOn: [forayPageId(0, 1, 0)] }, quotesHyatt, ground, docs)).toMatch(/quotes page a0\/s0\/p0 but the verifier did not list it/);
    expect(refusalFor({ pageId: THESIS_ID, synthesis: true, restsOn: [forayPageId(0, 0, 0)] }, quotesHyatt, ground, docs)).toBeNull();
  });

  it("a verdict naming a page that is not verified leaves the Hinge unverified, with the reason in its notes", async () => {
    /* MUTATION THAT KILLS THIS: record `restsOn` without checking it. */
    const verifier = scriptedVerifier((request) => ({ pages: request.pages.map((p) => ({ pageId: p.pageId, synthesis: true, restsOn: ["a9/s9/p9"] })) }));
    const { thesis } = await runPass(foray(), new StubNarrationWriterBuilder(), verifier);
    expect(thesis.verified).toBe(false);
    expect(thesis.verifierNotes).toMatch(/a9\/s9\/p9, which is not a verified page/);
    expect(verifier.synthesisCalls).toBe(NARRATION_PAGE_ATTEMPTS);
  });

  it("a verifier that does not answer the synthesis question leaves the page unverified without a writer call", async () => {
    /* MUTATION THAT KILLS THIS: call a method that is not there. */
    const verifier: NarrationVerifierBuilder = { providerName: "old", async verifySlot() { throw new Error("never"); } };
    const writer = countingWriter();
    const { thesis } = await runPass(foray(), writer, verifier);
    expect(thesis.verified).toBe(false);
    expect(writer.calls).toBe(0);
  });

  it("the writer and the verifier must be distinct instances, as for every other page", async () => {
    /* MUTATION THAT KILLS THIS: drop the identity check. */
    const both = new StubNarrationWriterBuilder() as unknown as NarrationWriterBuilder & NarrationVerifierBuilder;
    await expect(verifyBySynthesis(foray()[1]!, 1, foray(), { writer: both, verifier: both }, voice, ctx)).rejects.toThrow(/distinct builder instances/);
  });
});

describe("F-88 — the veracity gate counts synthesis pages separately and treats them as verified", () => {
  it("synthesisVerifiedPages sits next to unverifiedPages, the gate passes, and firstAttemptPassRate counts the page's own attempts", async () => {
    /* MUTATION THAT KILLS THIS: count a synthesis page under
       `unverifiedPages`, or leave it out of `synthesisVerifiedPages`. */
    const { acts } = await runPass(foray());
    const veracity = buildVeracityMetrics({ sourcedActs: [], tapeRelevanceRows: [], writtenActs: acts, topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] });

    expect(veracity.unverifiedPages).toBe(0);
    expect(veracity.synthesisVerifiedPages).toBe(1);
    expect(veracity.synthesisVerifiedPageDetails).toEqual([{ claim: THESIS, mode: "Hinge", restsOn: expect.arrayContaining([forayPageId(0, 0, 0)]) }]);
    expect(veracity.groundedQuoteRate).toBe(1);
    expect(veracity.firstAttemptPassRate).toBe(1);
    expect(evaluateVeracityGate(veracity).ok).toBe(true);
  });

  it("before the pass the same Foray is refused; a synthesis record on an unverified page counts as unverified, not as a synthesis", () => {
    /* MUTATION THAT KILLS THIS: count `verification` without `verified`. */
    const before = buildVeracityMetrics({ sourcedActs: [], tapeRelevanceRows: [], writtenActs: foray(), topic: "t", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [] });
    expect(before.unverifiedPages).toBe(1);
    expect(before.synthesisVerifiedPages).toBe(0);
    expect(evaluateVeracityGate(before).ok).toBe(false);

    const malformed: NarratedBeat = { ...handOff(), verification: { kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 1 } };
    const acts = foray(THESIS, malformed);
    expect(computeSynthesisVerifiedPages(acts).count).toBe(0);
    expect(computeUnverifiedPages(acts).count).toBe(1);
  });
});

describe("F-88 — the synthesis prompt", () => {
  it("lists every verified page by id with what it established, the pages to judge, and the refusal rule — and is not the three-question prompt", () => {
    /* MUTATION THAT KILLS THIS: reuse `buildVerifyPrompt`, or leave the
       page ids out so the model cannot answer with them. */
    const summaries = verifiedPageSummaries(foray());
    const prompt = buildSynthesisPrompt({
      voice,
      verifiedPages: summaries,
      pages: [{ pageId: THESIS_ID, purpose: THESIS, mode: "Hinge", script: "Most retellings compress it.", sources: [], evidence: { purpose: THESIS, beatKind: "account", docs: pageDocsFor(summaries) } }]
    });
    for (const s of summaries) {
      expect(prompt).toContain(`[${s.pageId}]`);
      expect(prompt).toContain(s.established[0]!);
    }
    expect(prompt).toContain(`PAGE ${THESIS_ID}`);
    expect(prompt).toMatch(/REFUSAL, not a near miss/);
    expect(prompt).toMatch(/"restsOn": string\[\]/);
    expect(prompt).not.toMatch(/claimsSupported|purposeAccomplished|contestedHandled/);
    expect(SYNTHESIS_SLOT_TITLE).toBe("synthesis");
  });
});
