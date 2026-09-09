import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import {
  writeNarration,
  decideConnectiveNarration,
  allWrittenNarration,
  heldDocsOf,
  NarrationWriteError,
  type WriteNarrationOptions,
  type WrittenAct
} from "../src/generation/writeNarration";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import type {
  ClaimSelectionRequest,
  ClaimSelectionResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  ProseWriteRequest,
  ProseWriteResult,
  SelectedClaim
} from "../src/generation/NarrationWriterBuilder";
import type {
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult
} from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import {
  MODE_CHAR_BANDS,
  containsContestedLanguage,
  disclosureNarratedBeat,
  disclosureTemplate,
  normalizeForQuoteMatch,
  validateNarratedBeat,
  type NarrationMode,
  type NarratedBeat
} from "../src/types/narration";
import type { SourcedAct, SourcedSlot } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { BANNED } from "../src/copy/rules";
import { env } from "../src/config/env";

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
 * Injected into every orchestrator test so the assertions are about
 * `writeNarration`'s rules and not about what a retrieval happened to
 * return — and so no test touches the catalogue or the network. */
function fixtureGatherer(docs: EvidenceDoc[] = [NBS_DOC], tape?: EvidencePack["tape"]): EvidenceGatherer {
  return {
    async gather(beat): Promise<EvidencePack> {
      return { purpose: beat.claim, beatKind: "account", docs: [...docs], ...(tape ? { tape } : {}) };
    }
  };
}

function makeOptions(overrides: Partial<WriteNarrationOptions> = {}): WriteNarrationOptions {
  return {
    writer: new StubNarrationWriterBuilder(),
    verifier: new StubNarrationVerifierBuilder(),
    evidence: fixtureGatherer(),
    ...overrides
  };
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

/**
 * A writer driven by a canned list of per-attempt answers. Each entry is
 * what the slot's ONE page selects and writes on that attempt, so a test
 * can replay a run-1 failure and then its correction.
 */
function scriptedWriter(
  attempts: Array<{ claims: SelectedClaim[]; script?: string; usedClaims?: number[] }>
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
          script: turn.script ?? DEFAULT_SCRIPT,
          usedClaims: turn.usedClaims ?? p.claims.map((_, i) => i),
          pronunciationHints: []
        }))
      };
    }
  };
  return w;
}

/** A Patch-band script (340-765 chars). Written out rather than padded so
 * a reader can see it is ordinary prose and not a length fixture. */
const DEFAULT_SCRIPT =
  "One welded joint now carried both walkways' weight, and the drawings for it were never checked. " +
  "The connection as built could hold about sixty percent of what the code required of it, which is " +
  "the number the investigators kept returning to when they explained why the fourth floor came down. " +
  "What makes it hard to read as a single mistake is how ordinary every step looked from inside the " +
  "office that took it, right up to the evening the whole thing let go.";

const GOOD_CLAIM: SelectedClaim = {
  claimText: "the connection was never checked",
  quote: "The box beam-hanger rod connections were not checked for adequacy at any stage of the design.",
  docId: NBS_DOC.docId,
  contested: false
};

function passingVerifier(): NarrationVerifierBuilder & { calls: number } {
  const v = {
    providerName: "passing",
    calls: 0,
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.calls++;
      return {
        pages: request.pages.map((p) => ({ pageId: p.pageId, claimsSupported: true, purposeAccomplished: true, contestedHandled: true }))
      };
    }
  };
  return v;
}

function rejectingVerifier(field: "claimsSupported" | "purposeAccomplished" | "contestedHandled" = "claimsSupported"): NarrationVerifierBuilder & {
  calls: number;
} {
  const v = {
    providerName: "always-reject",
    calls: 0,
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.calls++;
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          claimsSupported: field !== "claimsSupported",
          purposeAccomplished: field !== "purposeAccomplished",
          contestedHandled: field !== "contestedHandled",
          notes: "simulated rejection"
        }))
      };
    }
  };
  return v;
}

describe("writeNarration — one page per narration beat, within mode budget", () => {
  it.each(Object.keys(MODE_CHAR_BANDS) as NarrationMode[])("produces a script within the %s mode's character budget", async (mode) => {
    const acts: SourcedAct[] =
      mode === "Patch" || mode === "Carry"
        ? narrationAct("The Lawson criterion sets the bar tokamaks had to clear.", mode as "Patch" | "Carry")
        : tapeAct("Tape about a discovery.");

    const written = await writeNarration(acts, makeOptions(), voice, ctx);
    const pages = allWrittenNarration(written);
    expect(pages.length).toBeGreaterThan(0);
    const page = pages.find((p) => p.mode === mode) ?? pages[0]!;
    const [min, max] = MODE_CHAR_BANDS[page.mode];
    expect(page.script.length).toBeGreaterThanOrEqual(min);
    expect(page.script.length).toBeLessThanOrEqual(max);
  });
});

describe("writeNarration — every factual claim carries a non-empty sources array", () => {
  it("a Patch beat's written page has at least one source", async () => {
    const written = await writeNarration(narrationAct("Whyte explains the Lawson criterion."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources.length).toBeGreaterThan(0);
    for (const source of page.sources) {
      expect(source.claimText.length).toBeGreaterThan(0);
      expect(source.quote.length).toBeGreaterThan(0);
    }
  });

  it("validateNarratedBeat flags a Patch/Carry beat with zero sources as invalid", () => {
    const beat: NarratedBeat = { mode: "Patch", script: "A".repeat(400), sources: [], pronunciationHints: [], verified: true };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-sources")).toBe(true);
  });
});

describe("writeNarration — HTML entities in writer output are decoded (F-26)", () => {
  /* WS-E's rule, at WS-A's boundary. The held document is TEXT — it
     carries "&", not "&amp;" — so decoding has to happen BEFORE the
     substring check, or a quote that is character-for-character correct
     apart from an entity the listener never hears would be rejected as
     ungrounded. This test fails in exactly that way if the decode ever
     moves after `validateSelectedClaims`. */
  const PUBLISHER_DOC: EvidenceDoc = {
    docId: "print:publisher",
    kind: "print",
    title: "Simon & Schuster Press",
    text: "Simon & Schuster acquired the rights to the collection in nineteen eighty, and the editor said yes within a week."
  };

  it("decodes &amp;/&quot;/&#39; in the script and in a selected claim (the real \"Simon &amp; Schuster\" case)", async () => {
    const rawScript =
      "Simon &amp; Schuster published the collection, and the editor said &quot;yes&quot; right away " +
      "— it&#39;s a true story about a slow, careful decision." +
      " The publisher spent years building a catalog of accessible nonfiction, one careful title at a time," +
      " and this was simply the next entry on a long, patient list that nobody outside the building was watching at the time.";
    const entityClaim: SelectedClaim = {
      claimText: "Simon &amp; Schuster published the book.",
      // Entity-encoded here, plain "&" in PUBLISHER_DOC.text above.
      quote: "Simon &amp; Schuster acquired the rights to the collection in nineteen eighty",
      docId: PUBLISHER_DOC.docId,
      contested: false
    };
    const writer = scriptedWriter([{ claims: [entityClaim], script: rawScript }]);

    const written = await writeNarration(
      narrationAct("A claim about publishing."),
      { writer, verifier: passingVerifier(), evidence: fixtureGatherer([PUBLISHER_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;

    // It resolved at all: the decode ran before the substring check.
    expect(writer.selectCalls).toBe(1);
    expect(page.sources).toHaveLength(1);
    expect(page.script).toContain("Simon & Schuster");
    expect(page.script).not.toMatch(/&(amp|quot|#39);/);
    expect(page.sources[0]!.claimText).toBe("Simon & Schuster published the book.");
    expect(page.sources[0]!.quote).toBe("Simon & Schuster acquired the rights to the collection in nineteen eighty");
    // Attribution is read off the document, so it was never encoded (WS-A).
    expect(page.sources[0]!.publication).toBe("Simon & Schuster Press");
  });
});

describe("writeNarration — a quote is a LOOKUP, decided in code before any verifier call (F-14/F-27)", () => {
  it("derives publication and url from the held document, never from the writer", async () => {
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);

    const source = allWrittenNarration(written)[0]!.sources[0]!;
    expect(source.publication).toBe(NBS_DOC.title);
    expect(source.url).toBe(NBS_DOC.url);
    expect(source.retrieved).toBe(NBS_DOC.retrievedAt);
  });

  it("rejects run 1's fabricated 'New Safe Confinement' citation before the verifier is called, and says why", async () => {
    const fabricated: SelectedClaim = {
      claimText: "the hanger rods were doubled",
      quote: "The interviews describe the hanger rod change as one made on the shop floor overnight.",
      docId: NBS_DOC.docId,
      contested: false
    };
    const writer = scriptedWriter([{ claims: [fabricated] }, { claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();

    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);

    // The prose call is skipped entirely for an ungrounded selection: one
    // fewer paid call than run 1 spent writing a page it would then reject.
    expect(writer.selectCalls).toBe(2);
    expect(writer.writeCalls).toBe(1);
    expect(verifier.calls).toBe(1);
    expect(writer.retryNotes[1]).toMatch(/not a verbatim span of any document provided/);
    expect(allWrittenNarration(written)[0]!.sources[0]!.publication).toBe(NBS_DOC.title);
  });

  it("rejects a quote taken from a document other than the one it cites", async () => {
    const misfiled: SelectedClaim = { ...GOOD_CLAIM, docId: TAPE_DOC.docId };
    const writer = scriptedWriter([{ claims: [misfiled] }, { claims: [GOOD_CLAIM] }]);
    await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer([NBS_DOC, TAPE_DOC]) }, voice, ctx);
    expect(writer.retryNotes[1]).toMatch(/Quote the document you cite/);
  });

  it("rejects a docId that is not in the pack at all", async () => {
    const writer = scriptedWriter([{ claims: [{ ...GOOD_CLAIM, docId: "print:invented" }] }, { claims: [GOOD_CLAIM] }]);
    await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);
    expect(writer.retryNotes[1]).toMatch(/is not one of the documents provided/);
  });

  it("F-42: rejects the run-1 two-word span at claim selection", async () => {
    const short: SelectedClaim = { claimText: "the screens choked the channel", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const writer = scriptedWriter([{ claims: [short] }, { claims: [GOOD_CLAIM] }]);
    await writeNarration(narrationAct("Show what the connection was asked to hold."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);
    expect(writer.retryNotes[1]).toMatch(/the quote is 2 word\(s\)/);
  });

  it("F-46: rejects the beat purpose quoted back, even when it IS in a held document", async () => {
    const purpose = "Welding crews reinforced the tower's joints at night for three months in 1978.";
    const purposeDoc: EvidenceDoc = { docId: "print:enr", kind: "print", title: "Engineering News-Record", text: `Reports at the time: ${purpose}` };
    const echo: SelectedClaim = {
      claimText: "the joints were reinforced at night",
      quote: "welding crews reinforced the tower's joints at night for three months in 1978",
      docId: purposeDoc.docId,
      contested: false
    };
    const writer = scriptedWriter([{ claims: [echo] }, { claims: [] }]);
    await writeNarration(
      [{ title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "tape", claim: purpose, exploration: false, tape: tapePointer("item-1") }] }] }],
      { writer, verifier: passingVerifier(), evidence: fixtureGatherer([purposeDoc]) },
      voice,
      ctx
    );
    expect(writer.retryNotes[1]).toMatch(/repeats this beat's own purpose/);
  });
});

describe("writeNarration — two calls per SLOT, not per page (the 4.2-calls-per-beat problem)", () => {
  it("writes four pages of one slot with one selection call, one prose call and one verify call", async () => {
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();
    const slot: SourcedSlot = {
      title: "Slot",
      beats: [0, 1, 2, 3].map((i) => ({
        sourcing: "narration" as const,
        claim: `Claim number ${i} about the connection.`,
        exploration: false,
        narration: { mode: "Patch" as const, reason: "test" }
      }))
    };
    const written = await writeNarration([{ title: "Act", slots: [slot] }], { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);

    expect(allWrittenNarration(written)).toHaveLength(4);
    expect(writer.selectCalls).toBe(1);
    expect(writer.writeCalls).toBe(1);
    expect(verifier.calls).toBe(1);
  });

  it("WS-D1: the slots of one act are written in parallel, and the act's slot order is preserved", async () => {
    let inFlight = 0;
    let peak = 0;
    const writer: NarrationWriterBuilder = {
      providerName: "concurrency-probe",
      async selectClaims(request: ClaimSelectionRequest): Promise<ClaimSelectionResult> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { pages: request.pages.map((p) => ({ pageId: p.pageId, claims: [GOOD_CLAIM] })) };
      },
      async writePages(request: ProseWriteRequest): Promise<ProseWriteResult> {
        return {
          pages: request.pages.map((p) => ({ pageId: p.pageId, script: DEFAULT_SCRIPT, usedClaims: [0], pronunciationHints: [] }))
        };
      }
    };
    const slots: SourcedSlot[] = ["Slot A", "Slot B", "Slot C"].map((title) => ({
      title,
      beats: [{ sourcing: "narration", claim: `${title} claim about the connection.`, exploration: false, narration: { mode: "Patch", reason: "t" } }]
    }));

    const written = await writeNarration([{ title: "Act", slots }], { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);

    expect(peak).toBe(3);
    expect(written[0]!.slots.map((s) => s.title)).toEqual(["Slot A", "Slot B", "Slot C"]);
  });
});

describe("writeNarration — the verifier is a genuinely separate call from the writer", () => {
  it("throws if the same builder instance is passed as both writer and verifier", async () => {
    const shared = new StubNarrationWriterBuilder();
    await expect(
      writeNarration(narrationAct("A claim."), { writer: shared, verifier: shared as unknown as NarrationVerifierBuilder, evidence: fixtureGatherer() }, voice, ctx)
    ).rejects.toThrow(/writer and verifier must be distinct/);
  });

  it("the verifier is handed the purpose and the evidence pack, not just the writer's declarations (F-22/F-41)", async () => {
    let seen: NarrationVerifyRequest | undefined;
    const verifier: NarrationVerifierBuilder = {
      providerName: "recording",
      async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
        seen = request;
        return { pages: request.pages.map((p) => ({ pageId: p.pageId, claimsSupported: true, purposeAccomplished: true, contestedHandled: true })) };
      }
    };
    await writeNarration(
      narrationAct("Show what the connection was asked to hold."),
      { writer: scriptedWriter([{ claims: [GOOD_CLAIM] }]), verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );
    expect(seen!.pages[0]!.purpose).toBe("Show what the connection was asked to hold.");
    expect(seen!.pages[0]!.evidence.docs[0]!.text).toContain("box beam-hanger rod connections");
    expect(seen!.pages[0]!.script).toBe(DEFAULT_SCRIPT);
  });

  it.each(["claimsSupported", "purposeAccomplished", "contestedHandled"] as const)(
    "a false %s answer rejects the page and is named in the retry note",
    async (field) => {
      const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
      const verifier = rejectingVerifier(field);
      await expect(
        writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx)
      ).rejects.toThrow(NarrationWriteError);
      expect(verifier.calls).toBe(3);
      expect(writer.retryNotes[1]).toMatch(/simulated rejection/);
    }
  );

  it("records purposeAccomplished on the page as its own field, distinct from verified (WS-B's purposeFidelity)", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(true);
    expect(page.purposeAccomplished).toBe(true);
  });
});

describe("writeNarration — what a page carries out for WS-B's metrics", () => {
  it("carries the held documents as `evidence`, so groundedQuoteRate is checkable", async () => {
    const written = await writeNarration(narrationAct("Show what the connection was asked to hold."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.evidence).toEqual(heldDocsOf({ purpose: "x", beatKind: "account", docs: [NBS_DOC] }));
    for (const source of page.sources) {
      expect(page.evidence!.some((d) => d.text.includes(source.quote))).toBe(true);
    }
  });

  it("records every attempt, numbered, with the failing one's sources and note", async () => {
    const short: SelectedClaim = { claimText: "c", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const writer = scriptedWriter([{ claims: [short] }, { claims: [GOOD_CLAIM] }]);
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);
    const attempts = allWrittenNarration(written)[0]!.attempts!;
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(attempts[0]!.rejected).toBe(true);
    expect(attempts[0]!.rejectionNote).toMatch(/word\(s\)/);
    expect(attempts[1]!.rejected).toBe(false);
    expect(attempts[1]!.rejectionNote).toBeUndefined();
    expect(attempts[1]!.sources[0]!.publication).toBe(NBS_DOC.title);
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
      expect(normalizeForQuoteMatch(doc!.text)).toContain(normalizeForQuoteMatch(source.quote));
    }
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

describe("createNarrationWriterBuilder / createNarrationVerifierBuilder", () => {
  it("both return stub builders when ANTHROPIC_API_KEY is absent, and are distinct instances", () => {
    expect(env.anthropicDryRun).toBe(true);
    const writer = createNarrationWriterBuilder();
    const verifier = createNarrationVerifierBuilder();
    expect(writer.providerName).toBe("stub");
    expect(verifier.providerName).toBe("stub");
    expect(writer).not.toBe(verifier as unknown as NarrationWriterBuilder);
  });
});

describe("pronunciation hints — the field exists structurally, even though nothing consumes it yet", () => {
  it("a written page carries a pronunciationHints array (possibly empty)", async () => {
    const written = await writeNarration(narrationAct("Constantinople fell in the fifteenth century."), makeOptions(), voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(Array.isArray(page.pronunciationHints)).toBe(true);
  });
});

describe("writeNarration — generation run 1 (2026-09-09) regressions", () => {
  it("F-30: a tape slug can no longer BE a publication, because the writer never supplies one", async () => {
    const tapeClaim: SelectedClaim = {
      claimText: "the bakestone came before the griddle",
      quote: "So the bakestone came first, and the iron griddle only really arrives once cast iron is cheap",
      docId: TAPE_DOC.docId,
      contested: false
    };
    const writer = scriptedWriter([{ claims: [tapeClaim], script: "One welded joint now carried both walkways' weight, and nobody checked it." }]);
    const written = await writeNarration(
      tapeAct("Hand the listener into the tape.", "bfh-griddle-bakestone"),
      { writer, verifier: passingVerifier(), evidence: fixtureGatherer([TAPE_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources[0]!.publication).toBe("Bread from Home — The griddle and the bakestone");
    expect(page.sources[0]!.publication).not.toMatch(/^bfh-griddle-bakestone$/);
  });

  it("F-45: a script that says what the record does not contain is rejected unless a quote says so", async () => {
    const script =
      "The staged load sat somewhere on that span. Exactly where, the record doesn't say, and the crews " +
      "never wrote it down, which is why the question keeps coming back every time anyone re-reads the file. " +
      "The investigators who walked the deck afterwards were working from memory and from a handful of " +
      "photographs, and neither one puts the pile in a place anybody can point to now.";
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM], script }, { claims: [GOOD_CLAIM] }]);
    await writeNarration(narrationAct("Locate the staged load."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);
    expect(writer.retryNotes[1]).toMatch(/asserts what the record does or does not contain/);
  });

  it("F-36/F-37/F-44: a zero-source page that asserts something is rejected in code, and never reaches the verifier", async () => {
    const verifier = passingVerifier();
    /* A Frame-band script (70-170 chars) that nonetheless states something
       about the world, with no sources behind it — run 1's dominant
       first-attempt output for tape beats. */
    const writer = scriptedWriter([
      { claims: [], script: "The walkways hung from a single rod for four years before anyone looked at it.", usedClaims: [] },
      { claims: [GOOD_CLAIM], script: "One welded joint now carried both walkways' weight, and nobody had checked it." }
    ]);
    const written = await writeNarration(
      tapeAct("Hand the listener into the tape."),
      { writer, verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );
    expect(writer.writeCalls).toBe(2);
    expect(verifier.calls).toBe(1);
    expect(writer.retryNotes[1]).toMatch(/may only ask a question or hand off to the listener/);
    expect(allWrittenNarration(written)).toHaveLength(1);
  });

  it("F-35: the retry note accumulates every prior rejection, not just the latest one", async () => {
    /* Run 1's attempt 3 was told about attempt 2 only, so it regularly fixed
       the last complaint while reviving the first. Both earlier rejections
       have to be visible on the third attempt. */
    const shortQuote: SelectedClaim = { claimText: "c", quote: "not checked", docId: NBS_DOC.docId, contested: false };
    const wrongDoc: SelectedClaim = { ...GOOD_CLAIM, docId: "print:invented" };
    const writer = scriptedWriter([{ claims: [shortQuote] }, { claims: [wrongDoc] }, { claims: [GOOD_CLAIM] }]);

    await writeNarration(narrationAct("A claim about the connection."), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);

    expect(writer.selectCalls).toBe(3);
    expect(writer.retryNotes[1]).toMatch(/Attempt 1 was rejected for/);
    expect(writer.retryNotes[2]).toMatch(/Attempt 1 was rejected for/);
    expect(writer.retryNotes[2]).toMatch(/Attempt 2 was rejected for/);
    // The first attempt's complaint (a two-word span) is still on the record
    // when the third is written, alongside the second's (an unknown docId).
    expect(writer.retryNotes[2]).toMatch(/word\(s\)/);
    expect(writer.retryNotes[2]).toMatch(/not one of the documents provided/);
  });

  it("gives a page three informed attempts, then drops a CONNECTIVE page but keeps the tape beat", async () => {
    const verifier = rejectingVerifier();
    const written = await writeNarration(
      tapeAct("Tape about a discovery."),
      { writer: new StubNarrationWriterBuilder(), verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );
    expect(verifier.calls).toBe(3);
    const beat = written[0]!.slots[0]!.beats[0]!;
    expect(beat.sourcing).toBe("tape");
    expect(beat.sourcing === "tape" && beat.connectiveNarration).toBeFalsy();
    expect(allWrittenNarration(written)).toHaveLength(0);
  });

  it("still fails the Foray when a NARRATION beat's page is rejected three times — its page is the beat's content", async () => {
    const verifier = rejectingVerifier();
    await expect(
      writeNarration(narrationAct("A claim about the connection."), { writer: new StubNarrationWriterBuilder(), verifier, evidence: fixtureGatherer() }, voice, ctx)
    ).rejects.toThrow(NarrationWriteError);
    expect(verifier.calls).toBe(3);
  });

  it("a Patch page with no evidence at all is rejected rather than written unsourced", async () => {
    const writer = scriptedWriter([{ claims: [] }]);
    await expect(
      writeNarration(
        narrationAct("A claim nothing could be retrieved for."),
        { writer, verifier: passingVerifier(), evidence: fixtureGatherer([]) },
        voice,
        ctx
      )
    ).rejects.toThrow(/no evidence could be gathered/);
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
