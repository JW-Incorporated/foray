import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import {
  allWrittenNarration,
  containsContestedLanguage,
  decideConnectiveNarration,
  disclosureNarratedBeat,
  evidenceGathererFor,
  gateSelectedClaims,
  heldDocsOf,
  writeNarration,
  type WriteNarrationOptions,
  type WrittenAct
} from "../src/generation/writeNarration";
import { DefaultEvidenceGatherer } from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { NullTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { scriptIsAboutPurpose } from "../src/generation/StubNarrationVerifierBuilder";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import type {
  ActWriteRequest,
  ActWriteResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SelectedClaim
} from "../src/generation/NarrationWriterBuilder";
import type { NarrationVerifierBuilder } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import {
  disclosureTemplate,
  hasDeclarativeSentence,
  normalizeForQuoteMatch,
  purposeWasRevised,
  validateNarratedBeat,
  type NarratedBeat
} from "../src/types/narration";
import type { SourcedAct, SourcedSlot } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { BANNED } from "../src/copy/rules";
import { env } from "../src/config/env";

/**
 * §4.7's ORCHESTRATOR AND ITS MECHANICAL RULES.
 *
 * WHAT THIS FILE WAS, AND WHAT F-100 DID TO IT (2026-09-12). Runs 1-8 wrote
 * narration a page at a time, and this suite pinned that orchestration —
 * `writeSlot`, `runSlotRound`, `draftRound`, the writer's `selectClaims` /
 * `writePages` / `selectAndWrite` calls — together with every mechanical
 * rule those rounds applied. Q-03 replaced the orchestration with one call
 * per ACT (`writeAct.ts`) and left the old one standing as "the fallback
 * for a builder without the act contract". It was not reachable: both
 * classes `createNarrationWriterBuilder()` can return implement `writeAct`,
 * and both verifiers implement `verifyAct`, so nothing but this file ever
 * took the per-page path — and it took it only because `makeOptions()`
 * wrapped the stubs in objects whose whole job was to hide the act
 * contract from the orchestrator.
 *
 * F-100 deleted the path. The rules it applied did not go with it: they
 * live in `writeNarration.ts` (`gateSelectedClaims`, `decodeClaimEntities`,
 * `sourcesFor`, `retryNoteFrom`) and `types/narration.ts`
 * (`validateNarratedBeat`), and `writeAct.ts` calls exactly those. So every
 * rule test below now runs THROUGH THE ACT PATH — the stub builders, no
 * wrapper, with the writer's reply mutated to produce the failure the rule
 * is about — and the rejection is read off the act the writer is handed on
 * its next round. A test that only measured the per-page CALL ECONOMICS
 * (two calls per slot, G-34's merged call, the per-slot checkpoint) was
 * deleted with the path it measured; `actNarration.test.ts` measures the
 * act path's own.
 *
 * The narrow unit tests of the same rules — `validateNarratedBeat` against
 * a hand-built page — are in `narrationRules.test.ts` and were never on the
 * per-page path. They are the floor under this file, not a duplicate of it:
 * these tests are about a rule FIRING, in the orchestrator, and telling the
 * writer what to fix.
 *
 * Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* The two documents run 1 should have had and did not. Both are real:
   NBS 143 is the Hyatt Regency investigation report, and the tape doc is
   the griddle episode whose SLUG became a publication (F-30). */
const NBS_DOC: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print" as const,
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  retrievedAt: "2026-09-09T00:00:00.000Z",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

const TAPE_DOC: EvidenceDoc = {
  docId: "tape:bfh-griddle-bakestone#310",
  kind: "tape" as const,
  title: "Bread from Home — The griddle and the bakestone",
  text: "So the bakestone came first, and the iron griddle only really arrives once cast iron is cheap enough to sit on every hearth."
};

/** An evidence gatherer that hands every beat the same fixture documents.
 * Injected into every orchestrator test so the assertions are about the
 * stage's rules and not about what a retrieval happened to return — and so
 * no test touches the catalogue or the network. */
function fixtureGatherer(docs: EvidenceDoc[] = [NBS_DOC], tape?: EvidencePack["tape"]): EvidenceGatherer {
  return {
    async gather(beat): Promise<EvidencePack> {
      return { purpose: beat.claim, beatKind: "account", docs: [...docs], ...(tape ? { tape } : {}) };
    }
  };
}

/**
 * THE ACT PATH, WITH A HOOK ON WHAT THE WRITER SAYS — the shape every rule
 * test below uses, and the reason they are honest tests of the live path
 * rather than of a fixture: the builders are the real stubs
 * (`createNarrationWriterBuilder()` returns exactly this class in a
 * dry-run), and only the reply is mutated, at the seam, to produce the one
 * fault the rule is about.
 *
 * `mutate` is given the round number, so a test can say "attempt 1 is the
 * run-1 failure, attempt 2 is the correction" and assert both the refusal
 * and the recovery.
 */
function actBuilders(mutate?: (reply: ActWriteResult, request: ActWriteRequest, round: number) => ActWriteResult) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { write: 0, verify: 0 };
  const requests: ActWriteRequest[] = [];
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
    return realVerify(request, buildCtx);
  };
  return { writer, verifier, calls, requests };
}

/** Replaces the claims of every seam in the reply — the one lever every
 * quote-gate test pulls. */
function withClaims(reply: ActWriteResult, claims: SelectedClaim[]): ActWriteResult {
  return { seams: reply.seams.map((s) => ({ ...s, claims, usedClaims: claims.map((_, i) => i) })) };
}

/** What the writer was told to fix, on the round after a refusal: the
 * act-level accumulation (F-35) and the seam's own note (F-97). */
function refusalOn(requests: ActWriteRequest[], round: number): string {
  const request = requests[round - 1];
  if (!request) return "";
  return [request.retryNote ?? "", ...request.seams.map((s) => s.notes ?? "")].join(" ");
}

function makeOptions(overrides: Partial<WriteNarrationOptions> = {}): WriteNarrationOptions {
  const { writer, verifier } = actBuilders();
  return { writer, verifier, evidence: fixtureGatherer(), ...overrides };
}

function tapePointer(itemId: string) {
  return {
    segmentId: `${itemId}#100`,
    itemId,
    startSec: 100,
    endSec: 130,
    startAnchor: "so the first thing to understand is",
    endAnchor: "and that changed everything after that",
    tier: 1 as const,
    confidence: "high" as const
  };
}

function narrationAct(claim: string, mode: "Patch" | "Carry" = "Patch"): SourcedAct[] {
  return [
    {
      title: "Act",
      slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim, exploration: false, narration: { mode, reason: "test" } }] }]
    }
  ];
}

function tapeAct(claim: string, itemId = "item-1"): SourcedAct[] {
  return [{ title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "tape", claim, exploration: false, tape: tapePointer(itemId) }] }] }];
}

const GOOD_CLAIM: SelectedClaim = {
  claimText: "the connection was never checked",
  quote: "The box beam-hanger rod connections were not checked for adequacy at any stage of the design.",
  docId: NBS_DOC.docId,
  contested: false
};

/* ------------------------------------------------------------------ *
 * The quote gate, through the orchestrator (F-14/F-27/F-30/F-42/F-46).
 * PORTED from the per-page path: each of these used to drive `writeSlot`
 * with a scripted per-page writer and read the rejection off the writer's
 * next `selectClaims` request. The rule is the same function
 * (`gateSelectedClaims`); what changed is that the act writer is handed
 * the refusal on its next round, in the seam's `notes`.
 * ------------------------------------------------------------------ */

describe("writeNarration — a quote is a LOOKUP, decided in code before any verifier call (F-14/F-27)", () => {
  it("derives publication and url from the held document, never from the writer", async () => {
    /* MUTATION THAT KILLS THIS: let the writer supply `publication` —
       `sourcesFor` would stop reading it off the document and F-30/F-32
       would be representable again. */
    const { writer, verifier } = actBuilders((reply) => withClaims(reply, [GOOD_CLAIM]));
    const written = await writeNarration(
      narrationAct("Show what the connection was asked to hold."),
      { writer, verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );

    const source = allWrittenNarration(written)[0]!.sources[0]!;
    expect(source.publication).toBe(NBS_DOC.title);
    expect(source.url).toBe(NBS_DOC.url);
    expect(source.retrieved).toBe(NBS_DOC.retrievedAt);
  });

  it("rejects run 1's fabricated 'New Safe Confinement' citation before the verifier is called, and says why", async () => {
    /* MUTATION THAT KILLS THIS: run the quote gate after the verifier, or
       drop `findHoldingDoc` — the invented span becomes a source. */
    const fabricated: SelectedClaim = {
      claimText: "the hanger rods were doubled",
      quote: "The interviews describe the hanger rod change as one made on the shop floor overnight.",
      docId: NBS_DOC.docId,
      contested: false
    };
    const { writer, verifier, calls, requests } = actBuilders((reply, _request, round) =>
      withClaims(reply, [round === 1 ? fabricated : GOOD_CLAIM])
    );

    const written = await writeNarration(
      narrationAct("Show what the connection was asked to hold."),
      { writer, verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );

    /* The verifier is not called on the refused round at all: a claim that
       is not a span of a held document is settled in code, one call
       earlier than run 1 settled it. */
    expect(calls.write).toBe(2);
    expect(calls.verify).toBe(1);
    expect(refusalOn(requests, 2)).toMatch(/not a verbatim span of any document provided/);
    expect(allWrittenNarration(written)[0]!.sources[0]!.publication).toBe(NBS_DOC.title);
  });

  it("rejects a quote taken from a document other than the one it cites", async () => {
    /* MUTATION THAT KILLS THIS: check the quote against the whole pack
       rather than against the document named. Two PRINT documents: a tape
       document would take F-81's branch, where the whole window is the
       source and this rule does not apply. */
    const OTHER_PRINT: EvidenceDoc = {
      docId: "print:enr-1981",
      kind: "print",
      title: "Engineering News-Record (1981)",
      text: "Crews on the fourth floor described the walkway as steady under foot in the weeks before the dance."
    };
    const misfiled: SelectedClaim = { ...GOOD_CLAIM, docId: OTHER_PRINT.docId };
    const { writer, verifier, requests } = actBuilders((reply, _request, round) => withClaims(reply, [round === 1 ? misfiled : GOOD_CLAIM]));
    await writeNarration(
      narrationAct("Show what the connection was asked to hold."),
      { writer, verifier, evidence: fixtureGatherer([NBS_DOC, OTHER_PRINT]) },
      voice,
      ctx
    );
    expect(refusalOn(requests, 2)).toMatch(/Quote the document you cite/);
  });

  it("rejects a docId that is not in the pack at all", async () => {
    /* MUTATION THAT KILLS THIS: fall back to "any document" when the named
       one is absent. */
    const { writer, verifier, requests } = actBuilders((reply, _request, round) =>
      withClaims(reply, [round === 1 ? { ...GOOD_CLAIM, docId: "print:invented" } : GOOD_CLAIM])
    );
    await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/is not one of the documents provided/);
  });

  it("F-42: rejects the run-1 two-word span at claim selection", async () => {
    /* MUTATION THAT KILLS THIS: drop the word minimum, or apply it to a
       span that is not a whole sentence of the document. */
    const short: SelectedClaim = { claimText: "the screens choked the channel", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const { writer, verifier, requests } = actBuilders((reply, _request, round) => withClaims(reply, [round === 1 ? short : GOOD_CLAIM]));
    await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/the quote is 2 word\(s\)/);
  });

  it("F-46: rejects the beat purpose quoted back, even when it IS in a held document", async () => {
    /* MUTATION THAT KILLS THIS: drop `quoteEchoesPurpose`, or stop joining
       the seam's beats into the purpose text the gate is given. */
    const purpose = "Welding crews reinforced the tower's joints at night for three months in 1978.";
    const purposeDoc: EvidenceDoc = { docId: "print:enr", kind: "print", title: "Engineering News-Record", text: `Reports at the time: ${purpose}` };
    const echo: SelectedClaim = {
      claimText: "the joints were reinforced at night",
      quote: "welding crews reinforced the tower's joints at night for three months in 1978",
      docId: purposeDoc.docId,
      contested: false
    };
    const { writer, verifier, requests } = actBuilders((reply, _request, round) => (round === 1 ? withClaims(reply, [echo]) : reply));
    await writeNarration(narrationAct(purpose), { writer, verifier, evidence: fixtureGatherer([purposeDoc]) }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/repeats this beat's own purpose/);
  });

  it("F-30: a tape slug can no longer BE a publication, because the writer never supplies one", async () => {
    /* MUTATION THAT KILLS THIS: take `publication` from the reply, or
       drop the slug guard (`looksLikeSlug`) that catches it if it ever
       does. */
    const tapeClaim: SelectedClaim = {
      claimText: "the bakestone came before the griddle",
      quote: "So the bakestone came first, and the iron griddle only really arrives once cast iron is cheap",
      docId: TAPE_DOC.docId,
      contested: false
    };
    const { writer, verifier } = actBuilders((reply) => withClaims(reply, [tapeClaim]));
    const written = await writeNarration(
      tapeAct("Hand the listener into the tape.", "bfh-griddle-bakestone"),
      { writer, verifier, evidence: fixtureGatherer([TAPE_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources[0]!.publication).toBe("Bread from Home — The griddle and the bakestone");
    expect(page.sources[0]!.publication).not.toMatch(/^bfh-griddle-bakestone$/);
  });

  it("F-26: decodes &amp;/&quot;/&#39; in a selected claim before the substring check (the real \"Simon &amp; Schuster\" case)", async () => {
    /* MUTATION THAT KILLS THIS: move `decodeClaimEntities` after
       `gateSelectedClaims`. The held document is TEXT — it carries "&",
       not "&amp;" — so a quote that is character-for-character correct
       apart from an entity no listener hears would be refused. */
    const PUBLISHER_DOC: EvidenceDoc = {
      docId: "print:publisher",
      kind: "print",
      title: "Simon & Schuster Press",
      text: "Simon & Schuster acquired the rights to the collection in nineteen eighty, and the editor said yes within a week."
    };
    const entityClaim: SelectedClaim = {
      claimText: "Simon &amp; Schuster published the book.",
      // Entity-encoded here, plain "&" in PUBLISHER_DOC.text above.
      quote: "Simon &amp; Schuster acquired the rights to the collection in nineteen eighty",
      docId: PUBLISHER_DOC.docId,
      contested: false
    };
    const { writer, verifier, calls } = actBuilders((reply) => withClaims(reply, [entityClaim]));
    const written = await writeNarration(
      narrationAct("A claim about publishing."),
      { writer, verifier, evidence: fixtureGatherer([PUBLISHER_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;

    // It resolved at all: the decode ran before the substring check.
    expect(calls.write).toBe(1);
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]!.claimText).toBe("Simon & Schuster published the book.");
    expect(page.sources[0]!.quote).toBe("Simon & Schuster acquired the rights to the collection in nineteen eighty");
    // Attribution is read off the document, so it was never encoded (WS-A).
    expect(page.sources[0]!.publication).toBe("Simon & Schuster Press");
  });

  it("F-26: decodes entities in the SCRIPT too — a narrator does not say \"ampersand a-m-p semicolon\"", async () => {
    /* MUTATION THAT KILLS THIS: decode the claims and not the script. */
    const { writer, verifier } = actBuilders((reply) => ({
      seams: reply.seams.map((s) => ({ ...s, script: s.script.replace(/\band\b/, "&amp;") }))
    }));
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    for (const page of allWrittenNarration(written)) {
      expect(page.script).not.toMatch(/&(amp|quot|#39);/);
    }
  });
});

describe("writeNarration — the mechanical rules a script must clear, through the orchestrator", () => {
  it("F-45: a script that says what the record does not contain is rejected unless a quote says so", async () => {
    /* MUTATION THAT KILLS THIS: drop `negativeRecordSentence` from the
       structural validator, or stop giving it the act's quotes to look
       for the backing in. */
    const negative =
      "The staged load sat somewhere on that span. Exactly where, the record doesn't say, and the crews never wrote it down, " +
      "which is why the question keeps coming back every time anyone re-reads the file.";
    const { writer, verifier, requests } = actBuilders((reply, _request, round) =>
      round === 1 ? { seams: reply.seams.map((s) => ({ ...s, script: `${negative} ${s.script}` })) } : reply
    );
    await writeNarration(narrationAct("Locate the staged load."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/asserts what the record does or does not contain/);
  });

  it("F-36/F-37/F-44: a seam that asserts something and rests on no source in the act is rejected in code", async () => {
    /* MUTATION THAT KILLS THIS: let a declarative seam through with an
       empty claim list — run 1's dominant first-attempt output for tape
       beats, and the case it decided by sampling. */
    const { writer, verifier, requests } = actBuilders((reply, _request, round) => (round === 1 ? withClaims(reply, []) : reply));
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/rests on no source in the act|may only ask a question or hand off to the listener/);
    expect(allWrittenNarration(written)[0]!.verified).toBe(true);
  });

  it("F-35: the retry note accumulates every prior rejection, not just the latest one", async () => {
    /* MUTATION THAT KILLS THIS: overwrite the note on each failure, which
       is what run 1 did — attempt 3 was told about attempt 2 only and
       regularly revived the fault attempt 1 was rejected for. */
    const shortQuote: SelectedClaim = { claimText: "c", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const wrongDoc: SelectedClaim = { ...GOOD_CLAIM, docId: "print:invented" };
    const { writer, verifier, requests } = actBuilders((reply, _request, round) =>
      withClaims(reply, round === 1 ? [shortQuote] : round === 2 ? [wrongDoc] : [GOOD_CLAIM])
    );

    await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);

    expect(requests).toHaveLength(3);
    const third = requests[2]!.retryNote ?? "";
    expect(third).toMatch(/Attempt 1 was rejected for/);
    expect(third).toMatch(/Attempt 2 was rejected for/);
    // The first attempt's complaint (a two-word span) is still on the
    // record when the third is written, alongside the second's (an
    // unknown docId).
    expect(third).toMatch(/word\(s\)/);
    expect(third).toMatch(/not one of the documents provided/);
  });

  it("the slug guard fires on a publication that is a tape item id rather than a work", async () => {
    /* MUTATION THAT KILLS THIS: drop `looksLikeSlug` from the structural
       pass — the one check that would still catch F-30 if attribution
       ever stopped being read off the document. */
    const slugDoc: EvidenceDoc = {
      docId: "print:slug",
      kind: "print",
      title: "bread-from-home-griddle-bakestone",
      text: "The bakestone came first and the iron griddle arrives once cast iron is cheap enough for every hearth."
    };
    const claim: SelectedClaim = {
      claimText: "the bakestone came first",
      quote: "The bakestone came first and the iron griddle arrives once cast iron",
      docId: slugDoc.docId,
      contested: false
    };
    const { writer, verifier, requests } = actBuilders((reply, _request, round) => (round === 1 ? withClaims(reply, [claim]) : reply));
    await writeNarration(narrationAct("Say where the griddle came from."), { writer, verifier, evidence: fixtureGatherer([slugDoc]) }, voice, ctx);
    expect(refusalOn(requests, 2)).toMatch(/is a tape item id, not a publication/);
  });
});

/* ------------------------------------------------------------------ *
 * The rules as pure functions — never on the per-page path, unchanged.
 * ------------------------------------------------------------------ */

describe("writeNarration — every factual claim carries a non-empty sources array", () => {
  it("a narration beat's written page has at least one source", async () => {
    const written = await writeNarration(narrationAct("Whyte explains the Lawson criterion."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources.length).toBeGreaterThan(0);
    for (const source of page.sources) {
      expect(source.claimText.length).toBeGreaterThan(0);
    }
  });

  it("validateNarratedBeat flags a Patch/Carry beat with zero sources as invalid", () => {
    const beat: NarratedBeat = { mode: "Patch", script: "A".repeat(400), sources: [], pronunciationHints: [], verified: true };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-sources")).toBe(true);
  });
});

describe("writeNarration — the verifier is a genuinely separate call from the writer", () => {
  it("throws if the same builder instance is passed as both writer and verifier", async () => {
    const shared = new StubNarrationWriterBuilder();
    await expect(
      writeNarration(narrationAct("A claim."), { writer: shared, verifier: shared as unknown as NarrationVerifierBuilder, evidence: fixtureGatherer() }, voice, ctx)
    ).rejects.toThrow(/writer and verifier must be distinct/);
  });

  it("records purposeAccomplished on the page as its own field, distinct from verified (WS-B's purposeFidelity)", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(true);
    expect(page.purposeAccomplished).toBe(true);
  });
});

describe("writeNarration — what a page carries out for WS-B's metrics", () => {
  it("carries the held documents it cites as `evidence`, so groundedQuoteRate is checkable", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.evidence!.length).toBeGreaterThan(0);
    for (const source of page.sources) {
      expect(page.evidence!.some((d) => d.text.includes(source.quote!))).toBe(true);
    }
  });

  it("records every attempt, numbered, with the failing one's note (F-32/F-35)", async () => {
    /* MUTATION THAT KILLS THIS: record only the attempt that passed, or
       renumber from the surviving attempts — `firstAttemptPassRate` and
       the report's failure table both read this history. */
    const short: SelectedClaim = { claimText: "c", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const { writer, verifier } = actBuilders((reply, _request, round) => withClaims(reply, [round === 1 ? short : GOOD_CLAIM]));
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    const attempts = allWrittenNarration(written)[0]!.attempts!;
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(attempts[0]!.rejected).toBe(true);
    expect(attempts[0]!.rejectionNote).toMatch(/word\(s\)/);
    expect(attempts[1]!.rejected).toBe(false);
    expect(attempts[1]!.rejectionNote).toBeUndefined();
  });

  it("a page that passes first time records exactly one attempt (firstAttemptPassRate)", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    expect(allWrittenNarration(written)[0]!.attempts).toHaveLength(1);
  });
});

describe("writeNarration — the dry-run path is structurally real, not a shortcut", () => {
  it("stub writer + stub verifier + the real gatherer produce a page whose quote is a span of its own evidence", async () => {
    /* No fixture gatherer here: this is the `--dry-run` path exactly as
       `npm run generate-forays -- --dry-run` runs it (no key, so
       `createExternalResearcher()` is the stub and its fixture passage is
       the held document). Run 1's stub invented its quote, which left every
       mechanical rule in this file dead code until a key was configured. */
    const written = await writeNarration(
      narrationAct("Whyte explains why the bakestone came before the griddle."),
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder() },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources.length).toBeGreaterThan(0);
    expect(page.evidence!.length).toBeGreaterThan(0);
    for (const source of page.sources) {
      const doc = page.evidence!.find((d) => d.title === source.publication);
      expect(doc, `no held document titled "${source.publication}"`).toBeTruthy();
      if (source.quote) expect(normalizeForQuoteMatch(doc!.text)).toContain(normalizeForQuoteMatch(source.quote));
    }
  });

  it("the factories hand `writeNarration` two builders that both carry the per-act contract (F-100's precondition)", () => {
    /* MUTATION THAT KILLS THIS: return a builder without `writeAct` or
       `verifyAct` from either factory. F-100 deleted the per-page
       orchestration on exactly this ground — every builder either factory
       can return implements the act contract, so the fallback could not
       run. If that ever stops being true, this test is where it shows. */
    expect(env.anthropicDryRun).toBe(true);
    const writer = createNarrationWriterBuilder();
    const verifier = createNarrationVerifierBuilder();
    expect(writer.providerName).toBe("stub");
    expect(verifier.providerName).toBe("stub");
    expect(typeof writer.writeAct).toBe("function");
    expect(typeof verifier.verifyAct).toBe("function");
    expect(writer).not.toBe(verifier as unknown as NarrationWriterBuilder);
  });
});

describe("writeNarration — copy-rule violations are caught", () => {
  it("validateNarratedBeat catches a banned word via the shared BANNED pattern list", () => {
    const beat: NarratedBeat = {
      mode: "Patch",
      script: `This is a fascinating look at the topic. ${"A".repeat(320)}`,
      sources: [{ claimText: "x", quote: "y", publication: "z", contested: false }],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat, { bannedPhrasePatterns: BANNED });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "banned-copy")).toBe(true);
  });

  it("validateNarratedBeat catches an out-of-budget (over-length) script", () => {
    const beat: NarratedBeat = { mode: "Hinge", script: "A".repeat(10000), sources: [], pronunciationHints: [], verified: true };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "out-of-budget")).toBe(true);
  });
});

describe("writeNarration — contested claims say so explicitly", () => {
  it("containsContestedLanguage finds the flagged phrases", () => {
    expect(containsContestedLanguage("This detail is contested among historians.")).toBe(true);
    expect(containsContestedLanguage("This is a plain, uncontroversial fact.")).toBe(false);
  });

  it("validateNarratedBeat flags a contested source with no textual acknowledgement", () => {
    const beat: NarratedBeat = {
      mode: "Patch",
      script: "A".repeat(400),
      sources: [{ claimText: "x", quote: "y", publication: "z", contested: true }],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "contested-not-flagged-in-text")).toBe(true);
  });
});

describe("disclosureTemplate / disclosureNarratedBeat — the mandatory first item", () => {
  it("renders correctly with a real subject substituted", () => {
    const text = disclosureTemplate("the history of grilling");
    expect(text).toBe(
      "This is a Foray about the history of grilling. Much of what you'll hear is written by AI. " +
        "We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source."
    );
  });

  it("round-trips through check-forays.mjs's own DISCLOSURE_RX", () => {
    // check-forays.mjs is loaded by dynamic import, and Vitest re-resolves
    // that import through its own vite-node loader — which mishandles a
    // space in the checkout path (this repo lives under "Vibe Coding"),
    // producing "Invalid or unexpected token" whether the specifier is
    // relative, an absolute path, or a pathToFileURL'd file:// URL, with or
    // without a `/* @vite-ignore */` hint (see the `finalize` seam comment
    // in runPipeline.ts for the fuller account of the same defect). A plain
    // Node subprocess started outside vite-node does not have that problem,
    // so do the ESM import and the checkForays() call there instead.
    //
    // DISCLOSURE_RX itself is not exported, so exercise it the way the real
    // validator does: build a minimal generated foray whose items[0] is this
    // stage's disclosure beat, and confirm checkForays raises no
    // disclosure-related error for it.
    const checkForaysUrl = pathToFileURL(resolvePath(__dirname, "../../tools/foray/check-forays.mjs")).href;
    const beat = disclosureNarratedBeat("marine navigation before satellites");
    const foray = {
      id: "test-foray",
      generated: true,
      subject: "marine navigation before satellites",
      duration_tier: "short",
      why: "A short test why-line under the word limit.",
      hook: "A short test hook.",
      items: [{ type: "narration", script: beat.script }]
    };
    const input = { forays: { forays: [foray] }, segments: { segments: [] }, sources: { sources: [] }, taxonomy: {} };
    const script =
      `import(${JSON.stringify(checkForaysUrl)}).then((mod) => {` +
      `process.stdout.write(JSON.stringify(mod.checkForays(${JSON.stringify(input)})));` +
      `});`;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    const result = JSON.parse(stdout) as { errors: string[] };
    expect(result.errors.some((e: string) => e.toLowerCase().includes("disclosure"))).toBe(false);
  });

  it("throws on an empty subject rather than silently emitting a malformed disclosure", () => {
    expect(() => disclosureTemplate("   ")).toThrow();
  });
});

describe("decideConnectiveNarration — §4.5's own note, resolved by beat position", () => {
  it("assigns Frame to a tape beat that opens its slot", () => {
    const slot: SourcedSlot = { title: "S", beats: [{ sourcing: "tape", claim: "c", exploration: false, tape: tapePointer("item-1") }] };
    expect(decideConnectiveNarration(slot, 0)).toBe("Frame");
  });

  it("assigns Frame to a tape beat immediately following a different-item tape beat", () => {
    const slot: SourcedSlot = {
      title: "S",
      beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapePointer("item-1") },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapePointer("item-2") }
      ]
    };
    expect(decideConnectiveNarration(slot, 1)).toBe("Frame");
  });

  it("assigns null to a tape beat following a same-item tape beat (left to §4.8)", () => {
    const slot: SourcedSlot = {
      title: "S",
      beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapePointer("item-1") },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapePointer("item-1") }
      ]
    };
    expect(decideConnectiveNarration(slot, 1)).toBeNull();
  });

  it("returns null for a narration-sourced beat (no connective narration decision applies)", () => {
    const slot: SourcedSlot = { title: "S", beats: [{ sourcing: "narration", claim: "c", exploration: false, narration: { mode: "Patch", reason: "r" } }] };
    expect(decideConnectiveNarration(slot, 0)).toBeNull();
  });
});

describe("writeNarration — §4.5's guardrail carries through: beat identity is preserved", () => {
  it("every input beat's claim appears exactly once in the flattened output-adjacent structure", async () => {
    const acts: SourcedAct[] = [
      {
        title: "Act",
        slots: [
          {
            title: "Slot",
            beats: [
              { sourcing: "tape", claim: "Tape claim one.", exploration: false, tape: tapePointer("item-1") },
              { sourcing: "narration", claim: "Narration claim two.", exploration: false, narration: { mode: "Carry", reason: "no tape" } }
            ]
          }
        ]
      }
    ];
    const written = await writeNarration(acts, makeOptions(), voice, ctx);
    const claims = written.flatMap((a: WrittenAct) => a.slots.flatMap((s) => s.beats.map((b) => b.claim)));
    expect(claims).toEqual(["Tape claim one.", "Narration claim two."]);
  });
});

describe("pronunciation hints — the field exists structurally, even though nothing consumes it yet", () => {
  it("a written page carries a pronunciationHints array (possibly empty)", async () => {
    const written = await writeNarration(narrationAct("Constantinople fell in the fifteenth century."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(Array.isArray(page.pronunciationHints)).toBe(true);
  });
});

describe("containsContestedLanguage — F-43: natural phrasings count, not only house phrases", () => {
  it.each([
    "How much it choked the channel is something historians still argue over.",
    "Historians still dispute how much the screens mattered.",
    "The point is contested.",
    "Whether that was the cause is an open question.",
    "The record cannot settle which came first."
  ])("accepts: %s", (script) => {
    expect(containsContestedLanguage(script)).toBe(true);
  });
  it("still rejects a script that asserts without hedging", () => {
    expect(containsContestedLanguage("The screens choked the channel and the dam went over the top.")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * F-50 — a page may correct its purpose from the evidence.
 *
 * WHAT SURVIVES F-100, AND WHAT DOES NOT. F-50's QUESTION is unchanged and
 * is asked on the act path: "does the prose address the subject its beat
 * names, INCLUDING by contradicting it" — `scriptIsAboutPurpose` is the
 * structural form of it and the stub verifier decides `carried` with it.
 * What F-50 also added was a self-reported FLAG, `purposeRevised` on the
 * writer's reply and `purposeRevisedByVerifier` on the verifier's, and the
 * only producers of either were the per-page reply shapes deleted here.
 * `veracityMetrics.ts`'s `purposeRevisedPages` therefore now reads a real
 * 0 until the act contract carries the flag; that is recorded in the F-100
 * ledger entry rather than papered over, and the predicate itself is still
 * pinned below because it is what an editor's filter reads.
 * ------------------------------------------------------------------ */

const FEATURE_STORE_PURPOSE =
  "The feature store exists as a product category for one reason: those two code paths drift apart silently, " +
  "and the drift stays invisible until the model's live performance quietly diverges from its offline numbers " +
  "and someone finally goes looking.";

const TENSION_SCRIPT =
  "The feature store was sold as the fix for exactly this. Ask the people who built them and you get a flatter answer: " +
  "they manage data artifacts, and they do not control execution. Skew comes from movement. Every time a feature crosses " +
  "a system boundary the execution context changes, and consistency stops being a guarantee and starts being a probability. " +
  "So the category exists, and the drift it was meant to end is still there, one boundary further down.";

describe("F-50 — a page may correct its purpose from the evidence", () => {
  it("the writer's flag alone is enough to find the page, and the verifier's alone is too", () => {
    expect(purposeWasRevised({ purposeRevised: true })).toBe(true);
    expect(purposeWasRevised({ purposeRevisedByVerifier: true })).toBe(true);
    expect(purposeWasRevised({})).toBe(false);
    expect(purposeWasRevised({ purposeRevised: false, purposeRevisedByVerifier: false })).toBe(false);
  });

  it("leaves an ordinary page unflagged — the permission is recorded only when it is taken", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.purposeRevised).toBeUndefined();
    expect(purposeWasRevised(page)).toBe(false);
  });

  it("the structural purpose test passes a script that contradicts its purpose but keeps its subject", () => {
    /* The question F-50 narrowed the real one to — "did the prose keep the
       subject", not "did the prose agree" — so a contradiction passes and
       prose about something else does not. The act verifier decides
       `carried` with exactly this. */
    expect(scriptIsAboutPurpose(TENSION_SCRIPT, FEATURE_STORE_PURPOSE)).toBe(true);
    expect(scriptIsAboutPurpose("A single welded rod held both walkways, and nobody redrew it.", FEATURE_STORE_PURPOSE)).toBe(false);
  });
});

describe("gateSelectedClaims — the partition the act path needs (§4.7 rule 1, act-scoped)", () => {
  /* PORTED: the per-page path asserted this rule through `writeSlot`, where
     a Patch page with no surviving claim could not be written at all. On
     the act path the seam's gate is built with `claimsOptional` — whether a
     BEAT is carried with support is the verifier's per-beat question — so
     the rule is asserted on the gate directly. */
  const page = (extra: Partial<Parameters<typeof gateSelectedClaims>[1]> = {}) => ({
    pageId: "p0",
    beatIndex: 0,
    claim: "Show what the connection was asked to hold.",
    mode: "Patch" as const,
    evidence: { purpose: "x", beatKind: "account" as const, docs: [NBS_DOC] },
    ...extra
  });

  it("a Patch page whose every claim failed is told it must select one", () => {
    /* MUTATION THAT KILLS THIS: judge the zero-claim rule on what was
       SUBMITTED rather than on what survived the gate. */
    const { valid, issues } = gateSelectedClaims([{ ...GOOD_CLAIM, quote: "not in any document at all here" }], page());
    expect(valid).toEqual([]);
    expect(issues.join(" ")).toMatch(/must select at least one claim/);
  });

  it("a seam gate built with claimsOptional does not fire that rule — the beat's support is the verifier's question (F-97)", () => {
    /* MUTATION THAT KILLS THIS: apply §4.7 rule 1 per seam. Run 9 did, and
       refused every bridge in the act. */
    const { issues } = gateSelectedClaims([], page({ claimsOptional: true }));
    expect(issues).toEqual([]);
  });

  it("a page with no documents at all is told THAT, rather than told to select harder", () => {
    const { issues } = gateSelectedClaims([], page({ evidence: { purpose: "x", beatKind: "account", docs: [] } }));
    expect(issues.join(" ")).toMatch(/no evidence could be gathered/);
  });

  it("heldDocsOf strips how a document was found and keeps what it says", () => {
    expect(heldDocsOf({ purpose: "x", beatKind: "account", docs: [NBS_DOC] })).toEqual([
      { docId: NBS_DOC.docId, title: NBS_DOC.title, url: NBS_DOC.url, text: NBS_DOC.text }
    ]);
  });
});

describe("the evidence gatherer this stage builds carries the cue provider (requirements §8.1)", () => {
  const DIGEST: TranscriptDigestEntry = {
    show_id: "bread-from-home",
    show_title: "Bread From Home",
    guid: "bfh-0042",
    title: "The griddle and the bakestone",
    cues: 3
  };
  const CATALOGUE: CatalogueData = {
    items: [
      { id: "bread-from-home--griddle-bakestone", show: "Bread From Home", title: "The griddle and the bakestone", topics: [], hook: "" }
    ],
    itemTags: {},
    concepts: {},
    shows: [{ show_id: "bread-from-home", title: "Bread From Home", taxonomy_node_ids: [] }]
  };
  const CUES: TranscriptCue[] = [
    { text: "So the bakestone came first, and the iron griddle only arrives once cast iron is cheap.", start_sec: 100, end_sec: 115 },
    { text: "And that is the part everybody gets backwards.", start_sec: 115, end_sec: 125 }
  ];
  class FixedCueProvider implements TranscriptCueProvider {
    getCues(): TranscriptCue[] | null {
      return CUES;
    }
  }

  it("passes a supplied cue provider through to the default gatherer instead of dropping it", () => {
    /* The bug: `writeNarration` called `createEvidenceGatherer()` with no
       arguments, so every tape beat's pack was built against
       `NullTranscriptCueProvider` — the episode title and nothing the
       episode said — even on the machine holding the transcripts. */
    const probe = new FixedCueProvider();
    const withProvider = evidenceGathererFor({
      writer: new StubNarrationWriterBuilder(),
      verifier: new StubNarrationVerifierBuilder(),
      cueProvider: probe
    });
    expect(withProvider).toBeInstanceOf(DefaultEvidenceGatherer);
    expect((withProvider as DefaultEvidenceGatherer).cueProvider).toBe(probe);

    const without = evidenceGathererFor({ writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder() });
    expect((without as DefaultEvidenceGatherer).cueProvider).toBeInstanceOf(NullTranscriptCueProvider);
  });

  it("an injected gatherer is used as given — the cue-provider option is for the default only", () => {
    const injected = fixtureGatherer();
    expect(
      evidenceGathererFor({
        writer: new StubNarrationWriterBuilder(),
        verifier: new StubNarrationVerifierBuilder(),
        evidence: injected,
        cueProvider: new FixedCueProvider()
      })
    ).toBe(injected);
  });

  it("a tape beat's page then holds a tape: document carrying the cue window, not just the episode title", async () => {
    const gatherer = new DefaultEvidenceGatherer({
      researcher: new StubExternalResearcher(),
      cueProvider: new FixedCueProvider(),
      catalogue: CATALOGUE,
      transcriptArchive: [DIGEST],
      cacheDir: null
    });

    const written = await writeNarration(
      tapeAct("Tape about the bakestone.", "bread-from-home--griddle-bakestone"),
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence: gatherer },
      voice,
      ctx
    );

    const page = allWrittenNarration(written)[0]!;
    const tapeDoc = page.evidence!.find((d) => d.docId.startsWith("tape:"));
    expect(tapeDoc).toBeDefined();
    expect(tapeDoc!.text).toContain("the bakestone came first");
    expect(tapeDoc!.title).toBe("Bread From Home — The griddle and the bakestone");
  });
});

describe("F-100 — the per-slot path is gone, and a builder without the act contract is an error", () => {
  it("a writer without writeAct is refused by name rather than silently taking a second orchestration", async () => {
    /* MUTATION THAT KILLS THIS: re-introduce a fallback branch in
       `writeNarration`. The whole of F-100 is that a path no production
       run can take is not a safety net — it is a second definition of
       these rules that nothing checks. */
    const partial = { providerName: "no-act" } as unknown as NarrationWriterBuilder;
    await expect(
      writeNarration(narrationAct("A claim."), { writer: partial, verifier: new StubNarrationVerifierBuilder(), evidence: fixtureGatherer() }, voice, ctx)
    ).rejects.toThrow(/writeAct/);
  });

  it("a verifier without verifyAct is refused the same way", async () => {
    const partial = { providerName: "no-act" } as unknown as NarrationVerifierBuilder;
    await expect(
      writeNarration(narrationAct("A claim."), { writer: new StubNarrationWriterBuilder(), verifier: partial, evidence: fixtureGatherer() }, voice, ctx)
    ).rejects.toThrow(/verifyAct/);
  });

  it("a zero-source page that asserts something never reaches the candidate — hasDeclarativeSentence is the rule, not a verifier's sample", () => {
    /* F-36/F-37/F-44, as a pure rule: the per-page path used to prove this
       by degrading an evidence-less page to a hand-off before any call.
       The act path has no such degrade — a seam that rests on nothing is
       refused and kept unverified for the gate — so what is pinned here is
       the predicate both paths were built on. */
    expect(hasDeclarativeSentence("Where does this go next? Keep listening.")).toBe(false);
    expect(hasDeclarativeSentence("The walkways hung from a single rod for four years.")).toBe(true);
  });
});
