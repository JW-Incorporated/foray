import { describe, it, expect } from "vitest";
import { forayPageId, pageDocIdFor, verifiedPageSummaries } from "../src/generation/synthesisVerify";
import { groundDocsFor } from "../src/generation/writeAct";
import type { WrittenAct, WrittenBeat } from "../src/generation/writeNarration";
import {
  buildVeracityMetrics,
  computeSynthesisVerifiedPages,
  computeUnverifiedPages,
  evaluateVeracityGate
} from "../src/generation/veracityMetrics";
import { NarratedBeatSchema, isSynthesisVerified, type NarratedBeat } from "../src/types/narration";

/**
 * F-88's GROUND: the Foray's own verified pages, and the rules about what
 * may be one.
 *
 * THE FINDING (generation run 7 attempt 4, 2026-09-11): ten of 49 pages
 * were kept unverified and nine were bridges carrying the Foray's thesis —
 * "Most retellings of engineering disasters compress months or years of
 * decisions into a single moment", "Treating a disaster as one bad
 * decision by one bad actor is comforting". A generalisation across the
 * Foray's own cases is not a sentence print contains, so under the
 * ordinary rule those pages could only ever be refused.
 *
 * WHAT F-88 SHIPPED, AND WHAT REPLACED IT (F-100, 2026-09-12). F-88 added
 * a SEPARATE PASS — `verifyBySynthesis`, a second drafting-and-verifying
 * loop between an act's narration and its stitch, over pages the per-page
 * path had degraded to `unverifiedReason: "no-evidence"`. Q-03/F-97
 * superseded it: the act writer is handed the earlier acts' verified pages
 * as DOCUMENTS it may quote, and the act verifier answers which act
 * sources — clip windows, document spans, THOSE PAGES — each seam rests
 * on, in the call it was already making. Same safety property, one call
 * instead of a pass. The pass itself could not run after Q-03 (the act
 * path emits only `seed-lost` and `no-page`, never `no-evidence`, so its
 * eligibility test was never true and `countSynthesisCandidates` was
 * always 0) and is deleted; the tests that drove it went with it.
 *
 * WHAT IS PINNED HERE is what F-97 consumes and what the report reads:
 * which pages may be ground, the id and document conventions the writer,
 * the verifier and `verification.restsOn` share, and the fact that a page
 * resting on other pages is counted separately and still treated as
 * verified. The end-to-end path — ground reaching the act writer and
 * verifier, and a seam resting on `p<n>` — is in `actNarration.test.ts`
 * ("F-88's ground reaches the act").
 *
 * Every test names the mutation that kills it.
 */

/* Three verified pages establishing three cases — the ground a thesis
   bridge about "disasters as months of decisions" may rest on. */
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

const THESIS = "Most retellings compress the Hyatt Regency collapse and the Challenger launch into one moment";

/** The thesis page as F-97 leaves it: verified, resting on the two pages
 * of act 0 that established the cases it generalises. */
function thesisPage(restsOn: string[] = [forayPageId(0, 0, 0), forayPageId(0, 1, 0)]): NarratedBeat {
  const pageDoc = { docId: pageDocIdFor(restsOn[0]!), title: `This Foray, page ${restsOn[0]} — the Hyatt Regency`, text: HYATT };
  return {
    mode: "Hinge",
    script: "Neither of those was one bad decision on one bad day, and that is the shape this keeps taking.",
    sources: [{ claimText: "the hanger rod detail was changed and nobody checked it", quote: HYATT.split(". ")[0]!, publication: pageDoc.title, contested: false }],
    pronunciationHints: [],
    verified: true,
    purposeAccomplished: true,
    /* The pages it rests on travel with it, so `groundedQuoteRate`
       resolves its quote exactly as it resolves a print page's. */
    evidence: [pageDoc],
    verification: { kind: "synthesis", restsOn, attempt: 1 },
    attempts: [{ attempt: 1, sources: [], rejected: false }]
  };
}

/** The same page before the act verifier confirmed it: unverified, with no
 * record. */
function unconfirmedThesis(): NarratedBeat {
  return { ...thesisPage(), verified: false, purposeAccomplished: false, verification: undefined } as NarratedBeat;
}

/** Act 0 holds Hyatt and Challenger; act 1 holds the thesis bridge (p0)
 * and Tacoma (p1). Foray-wide ids: a0/s0/p0, a0/s1/p0, a1/s0/p0, a1/s0/p1. */
function foray(thesis: NarratedBeat = thesisPage()): WrittenAct[] {
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
          beats: [narration(THESIS, thesis), narration("Tacoma Narrows oscillated for months", verifiedPatch(TACOMA, "The deck oscillated for months before failing", "WSDOT history"))]
        }
      ]
    }
  ];
}

const THESIS_ID = forayPageId(1, 0, 0);

describe("F-88's ground — which pages a later act may rest on", () => {
  it("every page verified the ordinary way, named by act, slot and beat", () => {
    /* MUTATION THAT KILLS THIS: index the ids by anything but position —
       `verification.restsOn`, the writer's documents and the verifier's
       `p<n>` entries are the same ids, and they are positional. */
    expect(verifiedPageSummaries(foray()).map((p) => p.pageId)).toEqual([
      forayPageId(0, 0, 0),
      forayPageId(0, 1, 0),
      forayPageId(1, 0, 1)
    ]);
    expect(verifiedPageSummaries(foray())[0]).toMatchObject({
      claim: "The Hyatt Regency walkway collapse followed a design substitution",
      script: HYATT,
      established: ["The hanger rod detail was changed by the fabricator"]
    });
  });

  it("a page that itself rests on other pages is NOT ground: a generalisation never rests on a generalisation", () => {
    /* MUTATION THAT KILLS THIS: drop the `isSynthesisVerified` exclusion
       from `verifiedPageSummaries` — a chain of generalisations could then
       float free of the tape and print it is supposed to stand on. */
    const ground = verifiedPageSummaries(foray()).map((p) => p.pageId);
    expect(ground).not.toContain(THESIS_ID);

    const onlySyntheses: WrittenAct[] = [
      { title: "Act 1", slots: [{ title: "s", beats: [narration("a synthesis", { ...verifiedPatch(HYATT, "c", "P"), mode: "Hinge", verification: { kind: "synthesis", restsOn: ["a9/s9/p9"], attempt: 1 } })] }] }
    ];
    expect(verifiedPageSummaries(onlySyntheses)).toEqual([]);
  });

  it("a verified page that asserts nothing (no sources) is not ground, and an act whose narration has not landed contributes nothing", () => {
    /* MUTATION THAT KILLS THIS: count every `verified: true` page. A
       verified hand-off establishes nothing, so nothing may rest on it. */
    const empty: NarratedBeat = { mode: "Hinge", script: "What comes next? Listen for the turn.", sources: [], pronunciationHints: [], verified: true };
    const acts: Array<WrittenAct | undefined> = [{ title: "Act 1", slots: [{ title: "s", beats: [narration("hand-off", empty)] }] }, undefined, foray()[0]];
    expect(verifiedPageSummaries(acts).map((p) => p.pageId)).toEqual([forayPageId(2, 0, 0), forayPageId(2, 1, 0)]);
  });

  it("the ground reaches the writer as documents under the ONE docId convention the verifier and `restsOn` share", () => {
    /* MUTATION THAT KILLS THIS: build the page documents with a different
       id shape in `writeAct.ts` than `pageDocIdFor` mints here — the
       writer would quote `page:a0/s0/p0` and the verifier would resolve
       nothing. F-100 deleted a second, identical copy of this builder
       that lived beside the pass; `groundDocsFor` is the only one now. */
    const docs = groundDocsFor(verifiedPageSummaries(foray()));
    expect(docs[0]).toMatchObject({ docId: pageDocIdFor(forayPageId(0, 0, 0)), kind: "page", text: HYATT });
    expect(docs[0]!.title).toContain(`This Foray, page ${forayPageId(0, 0, 0)}`);
    expect(docs.map((d) => d.docId)).toEqual(verifiedPageSummaries(foray()).map((p) => pageDocIdFor(p.pageId)));
  });
});

describe("F-88 — the record a page resting on other pages carries", () => {
  it("the page record round-trips the checkpoint schema, and a synthesis that rests on nothing is not a record", () => {
    /* MUTATION THAT KILLS THIS: add `verification` outside the strict
       schema, or drop `.min(1)` on `restsOn` — a page could then claim to
       rest on nothing and still read as verified by synthesis. */
    const page = thesisPage(["a0/s0/p0"]);
    expect(NarratedBeatSchema.parse(page).verification).toEqual({ kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 1 });
    expect(() => NarratedBeatSchema.parse({ ...page, verification: { kind: "synthesis", restsOn: [], attempt: 1 } })).toThrow();
  });

  it("a record on an UNVERIFIED page is malformed and reads as false, not as a synthesis", () => {
    /* MUTATION THAT KILLS THIS: read `verification.kind` without
       `verified` — an unverified page would be counted as verified-by-
       synthesis and the gate would stop refusing it. */
    expect(isSynthesisVerified(thesisPage())).toBe(true);
    expect(isSynthesisVerified({ verified: false, verification: { kind: "synthesis", restsOn: ["a0/s0/p0"], attempt: 1 } })).toBe(false);
    expect(isSynthesisVerified({ verified: true })).toBe(false);
  });
});

describe("F-88 — the veracity gate counts these pages separately and treats them as verified", () => {
  it("synthesisVerifiedPages sits next to unverifiedPages, and the gate passes", async () => {
    /* MUTATION THAT KILLS THIS: count such a page under
       `unverifiedPages`, or leave it out of `synthesisVerifiedPages`.

       AND THE REASON THIS TEST IS NOT A DEAD 0 SINCE F-100: `writeAct.ts`
       is the producer of the record now (`finalPageFor`, from the
       verifier's `restsOn` over the act's ground), so the metric is live
       on the path that runs. The audit that produced F-100 read run 9's
       reported 0 as proof the metric was structurally dead; it was not —
       run 9's first wave of acts simply had no earlier act to rest on. */
    const acts = foray();
    const veracity = buildVeracityMetrics({ sourcedActs: [], tapeRelevanceRows: [], writtenActs: acts, topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] });

    expect(veracity.unverifiedPages).toBe(0);
    expect(veracity.synthesisVerifiedPages).toBe(1);
    expect(veracity.synthesisVerifiedPageDetails).toEqual([{ claim: THESIS, mode: "Hinge", restsOn: [forayPageId(0, 0, 0), forayPageId(0, 1, 0)] }]);
    expect(evaluateVeracityGate(veracity).ok).toBe(true);
  });

  it("the same Foray with the bridge unconfirmed is refused, and a record on an unverified page counts as unverified", () => {
    /* MUTATION THAT KILLS THIS: count `verification` without `verified`. */
    const before = buildVeracityMetrics({ sourcedActs: [], tapeRelevanceRows: [], writtenActs: foray(unconfirmedThesis()), topic: "t", writerCalls: 0, verifierCalls: 0, pipelineTokens: 0, stageTimings: [] });
    expect(before.unverifiedPages).toBe(1);
    expect(before.synthesisVerifiedPages).toBe(0);
    expect(evaluateVeracityGate(before).ok).toBe(false);

    const malformed = foray({ ...thesisPage(), verified: false });
    expect(computeSynthesisVerifiedPages(malformed).count).toBe(0);
    expect(computeUnverifiedPages(malformed).count).toBe(1);
  });
});
