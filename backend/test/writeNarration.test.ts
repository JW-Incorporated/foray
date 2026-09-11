import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import {
  writeNarration,
  decideConnectiveNarration,
  allWrittenNarration,
  evidenceGathererFor,
  heldDocsOf,
  pageCarriesContent,
  HANDOFF_MODE,
  HANDOFF_SCRIPT,
  NO_EVIDENCE_NOTE,
  NarrationWriteError,
  type WriteNarrationOptions,
  type WrittenAct,
  type WrittenSlot
} from "../src/generation/writeNarration";
import { computeUnverifiedPages } from "../src/generation/veracityMetrics";
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
  ClaimSelectionRequest,
  ClaimSelectionResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  ProseWriteRequest,
  ProseWriteResult,
  SelectAndWriteRequest,
  SelectAndWriteResult,
  SelectedClaim
} from "../src/generation/NarrationWriterBuilder";
import type {
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult
} from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import {
  MODE_CHAR_BANDS,
  containsContestedLanguage,
  disclosureNarratedBeat,
  disclosureTemplate,
  hasDeclarativeSentence,
  normalizeForQuoteMatch,
  purposeWasRevised,
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
 *
 * SPLIT PATH ONLY — it offers no `selectAndWrite`, so the orchestrator
 * takes the two-call path through it. That is deliberate: it is what
 * keeps the fallback path tested now that the real and stub builders
 * both offer the merged call (`mergedWriter` below is the merged fake).
 *
 * `retryNotes` records the note on EVERY writer call, selection or
 * prose, because since G-34 a retry may re-run prose alone and the note
 * then reaches only `writePages`; `lastRetryNote` reads the newest.
 */
function scriptedWriter(
  attempts: Array<{ claims: SelectedClaim[]; script?: string; usedClaims?: number[]; purposeRevised?: boolean }>
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
      w.retryNotes.push(request.pages[0]?.retryNote);
      const turn = attempts[Math.min(w.writeCalls, attempts.length - 1)]!;
      w.writeCalls++;
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          script: turn.script ?? DEFAULT_SCRIPT,
          usedClaims: turn.usedClaims ?? p.claims.map((_, i) => i),
          ...(turn.purposeRevised === undefined ? {} : { purposeRevised: turn.purposeRevised }),
          pronunciationHints: []
        }))
      };
    }
  };
  return w;
}

function lastRetryNote(w: { retryNotes: Array<string | undefined> }): string {
  return w.retryNotes[w.retryNotes.length - 1] ?? "";
}

/**
 * G-34's merged fake: one reply per page carrying claims AND script. Each
 * canned turn is consumed by ONE writer request of either kind, so a
 * test can script "merged reply, then the prose-only re-run". Records
 * every request it saw, with the page ids in it, because what G-34 is
 * about is which pages a retry pays for.
 */
function mergedWriter(
  turns: Array<{
    claims: SelectedClaim[] | ((pageId: string) => SelectedClaim[]);
    script?: string;
    usedClaims?: number[];
  }>
): NarrationWriterBuilder & {
  mergedCalls: number;
  writeCalls: number;
  selectCalls: number;
  requests: Array<{ kind: "merged" | "prose" | "select"; pageIds: string[]; claims?: SelectedClaim[][]; retryNotes: Array<string | undefined> }>;
} {
  let turnIndex = 0;
  const nextTurn = () => turns[Math.min(turnIndex++, turns.length - 1)]!;
  const claimsOf = (turn: (typeof turns)[number], pageId: string) => (typeof turn.claims === "function" ? turn.claims(pageId) : turn.claims);
  const w = {
    providerName: "merged-fake",
    mergedCalls: 0,
    writeCalls: 0,
    selectCalls: 0,
    requests: [] as Array<{ kind: "merged" | "prose" | "select"; pageIds: string[]; claims?: SelectedClaim[][]; retryNotes: Array<string | undefined> }>,
    async selectClaims(request: ClaimSelectionRequest): Promise<ClaimSelectionResult> {
      w.selectCalls++;
      w.requests.push({ kind: "select", pageIds: request.pages.map((p) => p.pageId), retryNotes: request.pages.map((p) => p.retryNote) });
      const turn = nextTurn();
      return { pages: request.pages.map((p) => ({ pageId: p.pageId, claims: claimsOf(turn, p.pageId) })) };
    },
    async writePages(request: ProseWriteRequest): Promise<ProseWriteResult> {
      w.writeCalls++;
      w.requests.push({
        kind: "prose",
        pageIds: request.pages.map((p) => p.pageId),
        claims: request.pages.map((p) => p.claims),
        retryNotes: request.pages.map((p) => p.retryNote)
      });
      const turn = nextTurn();
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          script: turn.script ?? DEFAULT_SCRIPT,
          usedClaims: turn.usedClaims ?? p.claims.map((_, i) => i),
          pronunciationHints: []
        }))
      };
    },
    async selectAndWrite(request: SelectAndWriteRequest): Promise<SelectAndWriteResult> {
      w.mergedCalls++;
      w.requests.push({ kind: "merged", pageIds: request.pages.map((p) => p.pageId), retryNotes: request.pages.map((p) => p.retryNote) });
      const turn = nextTurn();
      return {
        pages: request.pages.map((p) => {
          const claims = claimsOf(turn, p.pageId);
          return {
            pageId: p.pageId,
            claims,
            script: turn.script ?? DEFAULT_SCRIPT,
            usedClaims: turn.usedClaims ?? claims.map((_, i) => i),
            pronunciationHints: []
          };
        })
      };
    }
  };
  return w;
}

/** A verifier that rejects the named page ids on its first call only,
 * then accepts everything — the shape of "one page needs a second go". */
function rejectOnceVerifier(rejectPageIds: string[]): NarrationVerifierBuilder & { calls: number; requests: string[][] } {
  const v = {
    providerName: "reject-once",
    calls: 0,
    requests: [] as string[][],
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.calls++;
      v.requests.push(request.pages.map((p) => p.pageId));
      const first = v.calls === 1;
      return {
        pages: request.pages.map((p) => {
          const doomed = first && rejectPageIds.includes(p.pageId);
          return {
            pageId: p.pageId,
            claimsSupported: !doomed,
            purposeAccomplished: true,
            contestedHandled: true,
            ...(doomed ? { notes: "first-round objection" } : {})
          };
        })
      };
    }
  };
  return v;
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

describe("G-34 — the retry tax: select+prose in one call, and a retry pays for the rejected page only", () => {
  function patchSlot(claims: string[]): SourcedAct[] {
    return [
      {
        title: "Act",
        slots: [
          {
            title: "Slot",
            beats: claims.map((claim) => ({ sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } }))
          }
        ]
      }
    ];
  }
  const twoPages = () => patchSlot(["Claim zero about the connection.", "Claim one about the connection."]);
  const fourPages = () => patchSlot([0, 1, 2, 3].map((i) => `Claim number ${i} about the connection.`));
  /* A quote that is in no held document — the F-14/F-27 shape. */
  const UNHELD_CLAIM: SelectedClaim = {
    claimText: "the rods were doubled up on the night",
    quote: "the hanger rods were quietly doubled up on the night of the dance and nobody wrote it down",
    docId: NBS_DOC.docId,
    contested: false
  };

  it("a clean four-page slot costs ONE merged writer request and one verify request — two, where it was three", async () => {
    /* MUTATION THAT KILLS THIS: ignoring `selectAndWrite` and always
       taking the select + prose pair (mergedCalls 0, writeCalls 1). */
    const writer = mergedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();
    const stats = { retryRounds: 0 };
    const written = await writeNarration(fourPages(), { writer, verifier, evidence: fixtureGatherer(), stats }, voice, ctx);

    expect(allWrittenNarration(written)).toHaveLength(4);
    expect(allWrittenNarration(written).every((p) => p.verified)).toBe(true);
    expect(writer.mergedCalls).toBe(1);
    expect(writer.selectCalls).toBe(0);
    expect(writer.writeCalls).toBe(0);
    expect(verifier.calls).toBe(1);
    expect(stats.retryRounds).toBe(0);
  });

  it("lever (a): a slot with ONE verifier-rejected page re-runs prose + verify for that page, not the slot", async () => {
    /* MUTATION THAT KILLS THIS: forgetting `page.claims` on a verifier
       rejection (the retry would be a second MERGED call), or re-running
       the round over every page (the prose request would carry p0 too). */
    const writer = mergedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = rejectOnceVerifier(["p1"]);
    const stats = { retryRounds: 0 };
    const written = await writeNarration(twoPages(), { writer, verifier, evidence: fixtureGatherer(), stats }, voice, ctx);
    const pages = allWrittenNarration(written);

    expect(pages.every((p) => p.verified)).toBe(true);
    expect(writer.mergedCalls).toBe(1);
    expect(writer.selectCalls).toBe(0);
    expect(writer.writeCalls).toBe(1);
    const prose = writer.requests.find((r) => r.kind === "prose")!;
    expect(prose.pageIds).toEqual(["p1"]);
    /* The grounded claims travelled with the page — nothing was re-selected. */
    expect(prose.claims).toEqual([[GOOD_CLAIM]]);
    expect(prose.retryNotes[0]).toMatch(/first-round objection/);
    expect(verifier.calls).toBe(2);
    expect(verifier.requests[1]).toEqual(["p1"]);
    /* The page that passed kept its script: one attempt, and no second
       request ever named it. */
    expect(pages[0]!.attempts).toHaveLength(1);
    expect(pages[1]!.attempts).toHaveLength(2);
    expect(stats.retryRounds).toBe(1);
  });

  it("lever (b): a merged reply that fails the quote gate on one page re-runs that page's prose from the claims that passed", async () => {
    /* MUTATION THAT KILLS THIS: rejecting the whole page back to
       selection on any gate issue (mergedCalls 2, writeCalls 0), or
       carrying the unheld claim into the prose call. */
    const writer = mergedWriter([{ claims: (pageId) => (pageId === "p1" ? [GOOD_CLAIM, UNHELD_CLAIM] : [GOOD_CLAIM]) }, { claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();
    const written = await writeNarration(twoPages(), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    const pages = allWrittenNarration(written);

    expect(writer.mergedCalls).toBe(1);
    expect(writer.selectCalls).toBe(0);
    expect(writer.writeCalls).toBe(1);
    const prose = writer.requests.find((r) => r.kind === "prose")!;
    expect(prose.pageIds).toEqual(["p1"]);
    expect(prose.claims![0]).toEqual([GOOD_CLAIM]);
    expect(prose.retryNotes[0]).toMatch(/not a verbatim span of any document provided/);
    expect(verifier.calls).toBe(2);
    /* The rejected round is on the record, the kept page is verified, and
       the unheld quote never became a source. */
    expect(pages[1]!.attempts).toHaveLength(2);
    expect(pages[1]!.attempts![0]!.rejected).toBe(true);
    expect(pages[1]!.verified).toBe(true);
    expect(pages[1]!.sources.map((s) => s.quote)).toEqual([GOOD_CLAIM.quote]);
    expect(pages[0]!.attempts).toHaveLength(1);
  });

  it("a content page whose EVERY quote fails the gate re-selects — alone, not with the slot", async () => {
    /* There is nothing to write prose from, so this is the one post-merge
       rejection that goes back to selection; the page next to it, which
       passed, is not in that request. */
    const writer = mergedWriter([{ claims: (pageId) => (pageId === "p1" ? [UNHELD_CLAIM] : [GOOD_CLAIM]) }, { claims: [GOOD_CLAIM] }]);
    const written = await writeNarration(twoPages(), { writer, verifier: passingVerifier(), evidence: fixtureGatherer() }, voice, ctx);

    expect(writer.mergedCalls).toBe(2);
    expect(writer.writeCalls).toBe(0);
    expect(writer.requests[1]!.pageIds).toEqual(["p1"]);
    expect(allWrittenNarration(written).every((p) => p.verified)).toBe(true);
  });

  it("the three-attempt cap holds on the merged path, and the page that never verifies is still flagged", async () => {
    /* MUTATION THAT KILLS THIS: counting rounds instead of per-page
       attempts (a fourth attempt), or marking the salvage `verified`. */
    const writer = mergedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = rejectingVerifier();
    const stats = { retryRounds: 0 };
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer(), stats }, voice, ctx);
    const page = allWrittenNarration(written)[0]!;

    expect(verifier.calls).toBe(3);
    expect(writer.mergedCalls).toBe(1);
    expect(writer.writeCalls).toBe(2);
    expect(writer.selectCalls).toBe(0);
    expect(page.verified).toBe(false);
    expect(page.attempts).toHaveLength(3);
    expect(page.verifierNotes).toMatch(/simulated rejection/);
    expect(computeUnverifiedPages(written).count).toBe(1);
    expect(stats.retryRounds).toBe(2);
  });

  it("the split path takes lever (a) too: a verifier rejection re-runs prose, never selection", async () => {
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = rejectOnceVerifier(["p0"]);
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);

    expect(writer.selectCalls).toBe(1);
    expect(writer.writeCalls).toBe(2);
    expect(verifier.calls).toBe(2);
    expect(allWrittenNarration(written)[0]!.verified).toBe(true);
  });

  it("lever (c) is NOT built: a purposeRevised page the verifier says missed its purpose is still a rejection", async () => {
    /* The founder call the card defers. If it were ever taken, this page
       would pass on attempt one; today it is retried and kept unverified. */
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM], purposeRevised: true }]);
    const verifier = rejectingVerifier("purposeAccomplished");
    const written = await writeNarration(narrationAct("A claim about the connection."), { writer, verifier, evidence: fixtureGatherer() }, voice, ctx);
    const page = allWrittenNarration(written)[0]!;

    expect(verifier.calls).toBe(3);
    expect(page.verified).toBe(false);
    expect(page.purposeRevised).toBe(true);
    expect(page.purposeAccomplished).toBe(false);
  });

  it("the stub writer offers the merged call, so a dry run pays the one request production does", async () => {
    const writer = new StubNarrationWriterBuilder();
    let merged = 0;
    let prose = 0;
    const realMerged = writer.selectAndWrite.bind(writer);
    writer.selectAndWrite = async (request, buildCtx) => {
      merged++;
      return realMerged(request, buildCtx);
    };
    const realProse = writer.writePages.bind(writer);
    writer.writePages = async (request, buildCtx) => {
      prose++;
      return realProse(request, buildCtx);
    };
    const written = await writeNarration(fourPages(), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: fixtureGatherer() }, voice, ctx);

    expect(allWrittenNarration(written).every((p) => p.verified && p.attempts?.length === 1)).toBe(true);
    expect(merged).toBe(1);
    expect(prose).toBe(0);
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
      /* F-51: three rejections no longer throw — the page is kept
         unverified and the gate refuses it downstream. What this test is
         about is unchanged: the rejection is REAL (three attempts were
         spent) and its reason reached the next attempt. */
      const written = await writeNarration(
        narrationAct("A claim about the connection."),
        { writer, verifier, evidence: fixtureGatherer() },
        voice,
        ctx
      );
      expect(verifier.calls).toBe(3);
      expect(lastRetryNote(writer)).toMatch(/simulated rejection/);
      expect(allWrittenNarration(written)[0]!.verified).toBe(false);
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
    expect(lastRetryNote(writer)).toMatch(/asserts what the record does or does not contain/);
    /* G-34 lever (a): the rejection was structural, after the quote gate,
       so the second attempt re-ran prose from the same grounded claim and
       never re-selected. */
    expect(writer.selectCalls).toBe(1);
    expect(writer.writeCalls).toBe(2);
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
    expect(lastRetryNote(writer)).toMatch(/may only ask a question or hand off to the listener/);
    /* The page held NO grounded claim, so G-34 does not carry anything
       into the retry: it re-selects, and the second selection is what
       gives the page the claim it was missing. */
    expect(writer.selectCalls).toBe(2);
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

  it("keeps a NARRATION beat's page unverified after three rejections instead of failing the Foray (F-51)", async () => {
    const verifier = rejectingVerifier();
    const written = await writeNarration(
      narrationAct("A claim about the connection."),
      { writer: new StubNarrationWriterBuilder(), verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );
    expect(verifier.calls).toBe(3);
    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(false);
    expect(page.script.length).toBeGreaterThan(0);
  });

  it("a Patch page with no evidence at all is never written unsourced — it is not written at all (F-60)", async () => {
    /* This used to assert the rejection message. The rejection was correct
       and useless: it was produced three times, one selection call each,
       for a page no model could have written. The page is now degraded
       before the first call, and what the old test really protected — that
       nothing unsourced is ever asserted — is asserted here instead. */
    const writer = scriptedWriter([{ claims: [] }]);
    const written = await writeNarration(
      narrationAct("A claim nothing could be retrieved for."),
      { writer, verifier: passingVerifier(), evidence: fixtureGatherer([]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(writer.selectCalls).toBe(0);
    expect(page.sources).toEqual([]);
    expect(page.verified).toBe(false);
    expect(hasDeclarativeSentence(page.script)).toBe(false);
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
 * F-50 / F-51 — generation run 2, act 1, slot "Where Did This Number
 * Come From?", page p2. The real case, used as the fixture for both
 * findings because it is the one that ended the run.
 * ------------------------------------------------------------------ */

/** The deepen stage's purpose for p2, verbatim. It asserts a causal
 * account of why feature stores exist. */
const FEATURE_STORE_PURPOSE =
  "The feature store exists as a product category for one reason: those two code paths drift apart silently, " +
  "and the drift stays invisible until the model's live performance quietly diverges from its offline numbers " +
  "and someone finally goes looking.";

/** One of the documents WS-A's retrieval actually returned for that beat,
 * and the reason the page could not be written: it contradicts the
 * purpose it was gathered for. */
const SKEW_DOC: EvidenceDoc = {
  docId: "print:feature-stores-skew",
  kind: "print" as const,
  title: "Why Feature Stores Didn't Fix Training-Serving Skew",
  url: "https://example.org/feature-stores-skew",
  retrievedAt: "2026-09-09T15:00:00.000Z",
  text:
    "Feature stores manage data artifacts. They do not control execution. " +
    "Skew is caused by movement - every time a feature crosses a system boundary, execution context changes, " +
    "and consistency becomes probabilistic rather than guaranteed."
};

/** The claim attempts 2 and 3 were allowed to make. */
const SKEW_CLAIM: SelectedClaim = {
  claimText: "the people who build feature stores say they do not control execution",
  quote: "Feature stores manage data artifacts. They do not control execution.",
  docId: SKEW_DOC.docId,
  contested: false
};

/** The page neither prompt permitted before F-50: it names the purpose's
 * subject and then reports what the documents say about it. Patch band. */
const TENSION_SCRIPT =
  "The feature store was sold as the fix for exactly this. Ask the people who built them and you get a flatter answer: " +
  "they manage data artifacts, and they do not control execution. Skew comes from movement. Every time a feature crosses " +
  "a system boundary the execution context changes, and consistency stops being a guarantee and starts being a probability. " +
  "So the category exists, and the drift it was meant to end is still there, one boundary further down.";

/** A verifier that answers F-50's question the way the fix defines it:
 * the page addressed the purpose's subject with the evidence it had,
 * including by contradicting the purpose, and it says so. */
function purposeAwareVerifier(): NarrationVerifierBuilder & { calls: number } {
  const v = {
    providerName: "purpose-aware",
    calls: 0,
    async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
      v.calls++;
      return {
        pages: request.pages.map((p) => ({
          pageId: p.pageId,
          claimsSupported: true,
          purposeAccomplished: scriptIsAboutPurpose(p.script, p.purpose),
          purposeRevised: /do not control execution/.test(p.script),
          contestedHandled: true,
          ...(scriptIsAboutPurpose(p.script, p.purpose) ? {} : { notes: "the concept the purpose names is dropped" })
        }))
      };
    }
  };
  return v;
}

describe("F-50 — a page may correct its purpose from the evidence", () => {
  it("passes the page that reports the contradiction, and flags it on both sides", async () => {
    /* Run 2's attempt 1 asserted the purpose and was rejected as
       unsupported; attempts 2 and 3 narrowed to the documents, dropped the
       words "feature store" entirely, and were rejected for abandoning the
       purpose. This is the third page — the one that was always the right
       answer — and it now passes. */
    const writer = scriptedWriter([{ claims: [SKEW_CLAIM], script: TENSION_SCRIPT, purposeRevised: true }]);
    const verifier = purposeAwareVerifier();

    const written = await writeNarration(
      narrationAct(FEATURE_STORE_PURPOSE),
      { writer, verifier, evidence: fixtureGatherer([SKEW_DOC]) },
      voice,
      ctx
    );

    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(true);
    expect(verifier.calls).toBe(1);
    expect(writer.writeCalls).toBe(1);
    expect(page.purposeAccomplished).toBe(true);
    /* Both flags, kept separately: the writer declared the departure and
       the verifier judged it independently (§4.7 rule 2). */
    expect(page.purposeRevised).toBe(true);
    expect(page.purposeRevisedByVerifier).toBe(true);
    expect(purposeWasRevised(page)).toBe(true);
  });

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
    /* The stub verifier's `purposeAccomplished` is the same question F-50
       narrowed the real one to — "did the page keep the subject", not "did
       the page agree" — so a contradiction passes and a page about
       something else does not. */
    expect(scriptIsAboutPurpose(TENSION_SCRIPT, FEATURE_STORE_PURPOSE)).toBe(true);
    expect(scriptIsAboutPurpose("A single welded rod held both walkways, and nobody redrew it.", FEATURE_STORE_PURPOSE)).toBe(false);
  });

  it("still rejects the page that drops the purpose's subject altogether (F-41 is not weakened)", async () => {
    /* Run 2's attempts 2 and 3, exactly: sourced, accurate, and never once
       about feature stores. */
    const droppedSubjectScript =
      "Movement is what does it. Every time a value crosses a boundary, the context around it changes, and what came out " +
      "of one side is not quite what arrives at the other. Consistency stops being something anyone can promise and becomes " +
      "something you can only measure afterwards. That is a different kind of engineering problem than the one most teams " +
      "believe they are solving when they draw the diagram on the whiteboard.";
    const writer = scriptedWriter([{ claims: [SKEW_CLAIM], script: droppedSubjectScript }]);
    const written = await writeNarration(
      narrationAct(FEATURE_STORE_PURPOSE),
      { writer, verifier: purposeAwareVerifier(), evidence: fixtureGatherer([SKEW_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(false);
    expect(page.verifierNotes ?? "").toMatch(/the concept the purpose names is dropped/);
  });
});

describe("F-51 — a page never kills the Foray; the gate decides", () => {
  it("keeps the last attempt with verified:false, its attempts history and the verifier's final objection", async () => {
    const writer = scriptedWriter([{ claims: [SKEW_CLAIM], script: TENSION_SCRIPT }]);
    const verifier = rejectingVerifier("purposeAccomplished");

    const written = await writeNarration(
      narrationAct(FEATURE_STORE_PURPOSE),
      { writer, verifier, evidence: fixtureGatherer([SKEW_DOC]) },
      voice,
      ctx
    );

    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(false);
    expect(page.script).toBe(TENSION_SCRIPT);
    expect(page.purposeAccomplished).toBe(false);
    expect(page.verifierNotes).toMatch(/simulated rejection/);
    expect(page.attempts).toHaveLength(3);
    expect(page.attempts!.every((a) => a.rejected)).toBe(true);
    /* The evidence still travels with it, so WS-B can score the page it
       refuses rather than reporting it as unmeasurable. */
    expect(page.evidence!.some((d) => d.docId === SKEW_DOC.docId)).toBe(true);
  });

  it("the rest of the slot survives the page that failed — run 2 lost ten verified pages to one", async () => {
    /* Two narration beats in one slot: one the verifier accepts, one it
       never will. Before F-51 the second threw and took the first with it. */
    const acts: SourcedAct[] = [
      {
        title: "Act",
        slots: [
          {
            title: "Where Did This Number Come From?",
            beats: [
              {
                sourcing: "narration",
                claim: "Show what the connection was asked to hold.",
                exploration: false,
                narration: { mode: "Patch", reason: "t" }
              },
              { sourcing: "narration", claim: FEATURE_STORE_PURPOSE, exploration: false, narration: { mode: "Patch", reason: "t" } }
            ]
          }
        ]
      }
    ];
    const verifier: NarrationVerifierBuilder = {
      providerName: "one-bad-page",
      async verifySlot(request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
        return {
          pages: request.pages.map((p) => {
            const doomed = p.purpose === FEATURE_STORE_PURPOSE;
            return {
              pageId: p.pageId,
              claimsSupported: !doomed,
              purposeAccomplished: true,
              contestedHandled: true,
              ...(doomed ? { notes: "the quote does not say what the claim says" } : {})
            };
          })
        };
      }
    };

    const written = await writeNarration(
      acts,
      { writer: new StubNarrationWriterBuilder(), verifier, evidence: fixtureGatherer([SKEW_DOC]) },
      voice,
      ctx
    );
    const pages = allWrittenNarration(written);
    expect(pages).toHaveLength(2);
    expect(pages.filter((p) => p.verified)).toHaveLength(1);
    expect(pages.filter((p) => !p.verified)).toHaveLength(1);
  });

  it("keeps a hand-off instead of throwing when no page was ever written at all (F-60 closes F-51's last fatal branch)", async () => {
    /* Evidence existed, but the writer selected nothing from it on all
       three attempts, so no prose call ever ran and F-51's salvage has
       nothing to keep. That used to throw `NarrationWriteError` and end the
       Foray. It now leaves the same listener-safe hand-off an
       evidence-less page gets, marked `no-page` so an editor can tell the
       two apart, with the attempt history that explains it. */
    const writer = scriptedWriter([{ claims: [] }]);
    const written = await writeNarration(
      narrationAct("A claim the writer never selected anything for."),
      { writer, verifier: passingVerifier(), evidence: fixtureGatherer([NBS_DOC]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    expect(writer.selectCalls).toBe(3);
    expect(page.verified).toBe(false);
    expect(page.unverifiedReason).toBe("no-page");
    expect(page.script).toBe(HANDOFF_SCRIPT);
    expect(page.attempts).toHaveLength(3);
    expect(page.verifierNotes).toMatch(/must select at least one claim/);
  });

  it("a connective page is still DROPPED rather than kept unverified — its beat is the tape", async () => {
    const verifier = rejectingVerifier();
    const written = await writeNarration(
      tapeAct("Tape about a discovery."),
      { writer: new StubNarrationWriterBuilder(), verifier, evidence: fixtureGatherer() },
      voice,
      ctx
    );
    const beat = written[0]!.slots[0]!.beats[0]!;
    expect(beat.sourcing === "tape" && beat.connectiveNarration).toBeFalsy();
    expect(allWrittenNarration(written)).toHaveLength(0);
  });
});

describe("F-60 — a page with no evidence never costs a selection call", () => {
  /* Run 2 attempt 2, act 1, slot 2, page p5, verbatim. Retrieval returned
     `{"passages": []}`; three claim-selection calls followed, each on a
     prompt that said "Documents: none were retrieved for this page", each
     rejected in code before any model could help, and the third left no
     page at all — which was fatal. */
  const P5_PURPOSE =
    "Mature pipelines treat a dataset the way a build system treats source code: a schema check — wrong type, " +
    "an out-of-range value, a null where one shouldn't be — fails the run outright, the same way a type error " +
    "fails a compile, rather than letting a corrupted batch train a model that ships anyway.";
  const P5_SLOT = "Where Did This Number Come From?";

  function emptyPackAct(mode: "Patch" | "Carry" = "Carry"): SourcedAct[] {
    return [
      {
        title: "How AI systems get built",
        slots: [{ title: P5_SLOT, beats: [{ sourcing: "narration", claim: P5_PURPOSE, exploration: false, narration: { mode, reason: "t" } }] }]
      }
    ];
  }

  /** Records what the writer stage asked the gatherer for, and hands back
   * documents per claim — the run-2 slot had one of each. */
  function recordingGatherer(docsFor: (claim: string) => EvidenceDoc[], seen: EvidenceBeat[] = []): EvidenceGatherer & { seen: EvidenceBeat[] } {
    return {
      seen,
      async gather(beat): Promise<EvidencePack> {
        seen.push(beat);
        return { purpose: beat.claim, beatKind: "account", docs: docsFor(beat.claim) };
      }
    };
  }

  it("makes ZERO writer and verifier calls for a Carry page whose pack is empty", async () => {
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();
    const evidence = recordingGatherer(() => []);

    const written = await writeNarration(emptyPackAct(), { writer, verifier, evidence }, voice, ctx);

    expect(writer.selectCalls).toBe(0);
    expect(writer.writeCalls).toBe(0);
    expect(verifier.calls).toBe(0);
    /* And the gatherer was told this page carries content, which is what
       licenses its own second, rephrased query (gatherEvidence.test.ts). */
    expect(evidence.seen[0]!.requiresEvidence).toBe(true);
    expect(pageCarriesContent("Carry")).toBe(true);
    expect(pageCarriesContent("Frame")).toBe(false);

    const page = allWrittenNarration(written)[0]!;
    expect(page.verified).toBe(false);
    expect(page.unverifiedReason).toBe("no-evidence");
    expect(page.verifierNotes).toBe(NO_EVIDENCE_NOTE);
    expect(page.attempts).toEqual([]);
    expect(page.mode).toBe(HANDOFF_MODE);
    expect(page.script).toBe(HANDOFF_SCRIPT);
  });

  it("the degraded page's ONLY fault is that it is unverified — it asserts nothing and cites nothing", async () => {
    const written = await writeNarration(
      emptyPackAct(),
      { writer: new StubNarrationWriterBuilder(), verifier: passingVerifier(), evidence: fixtureGatherer([]) },
      voice,
      ctx
    );
    const page = allWrittenNarration(written)[0]!;
    const result = validateNarratedBeat(page, { bannedPhrasePatterns: BANNED, heldDocs: [], purposeText: P5_PURPOSE });
    /* Zero sources is legal only for a page that states nothing about the
       world (F-36/F-37/F-44), the script sits inside its mode's band, and
       no copy rule is broken. What is left is the one thing that IS true
       of this page. */
    expect(result.issues.map((i) => i.code)).toEqual(["not-verified"]);
  });

  it("is counted in unverifiedPages, so the publish gate refuses it exactly as it refuses F-51's pages", async () => {
    const written = await writeNarration(
      emptyPackAct(),
      { writer: new StubNarrationWriterBuilder(), verifier: passingVerifier(), evidence: fixtureGatherer([]) },
      voice,
      ctx
    );
    const unverified = computeUnverifiedPages(written);
    expect(unverified.count).toBe(1);
    expect(unverified.pages[0]!.claim).toBe(P5_PURPOSE);
  });

  it("degrades the PAGE, never the beat — §4.5's beat list survives §4.7 unchanged", async () => {
    /* The reason a content page is kept rather than dropped the way a
       connective page is: a connective page's beat is its tape and
       survives without it, while a narration beat IS its page. Dropping
       one would drop a beat, and `stitchAct`'s coverage and
       `computePagesDropped` both index written beats positionally against
       sourced ones. */
    const acts = emptyPackAct();
    const written = await writeNarration(
      acts,
      { writer: new StubNarrationWriterBuilder(), verifier: passingVerifier(), evidence: fixtureGatherer([]) },
      voice,
      ctx
    );
    const inBeats = acts[0]!.slots[0]!.beats;
    const outBeats = written[0]!.slots[0]!.beats;
    expect(outBeats).toHaveLength(inBeats.length);
    expect(outBeats[0]!.claim).toBe(inBeats[0]!.claim);
    expect(outBeats[0]!.sourcing).toBe("narration");
  });

  it("replays run 2's slot: the evidence-less page degrades, its neighbour is written, and ONE selection call is spent", async () => {
    const sourced = "Show what the schema check was asked to catch.";
    const acts: SourcedAct[] = [
      {
        title: "How AI systems get built",
        slots: [
          {
            title: P5_SLOT,
            beats: [
              { sourcing: "narration", claim: sourced, exploration: false, narration: { mode: "Patch", reason: "t" } },
              { sourcing: "narration", claim: P5_PURPOSE, exploration: false, narration: { mode: "Carry", reason: "t" } }
            ]
          }
        ]
      }
    ];
    const writer = scriptedWriter([{ claims: [GOOD_CLAIM] }]);
    const verifier = passingVerifier();

    const written = await writeNarration(
      acts,
      { writer, verifier, evidence: recordingGatherer((claim) => (claim === sourced ? [NBS_DOC] : [])) },
      voice,
      ctx
    );

    /* One selection call, one prose call, one verify call — for the ONE
       page that had documents. Run 2 spent three selection calls on the
       other one and then ended the Foray. */
    expect(writer.selectCalls).toBe(1);
    expect(writer.writeCalls).toBe(1);
    expect(verifier.calls).toBe(1);

    const pages = allWrittenNarration(written);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.verified).toBe(true);
    expect(pages[1]!.unverifiedReason).toBe("no-evidence");
  });

  it("leaves NarrationWriteError guarding the beat count only, and nothing reaches it", async () => {
    /* The class survives for a slot that came out with fewer beats than it
       went in with — unreachable, because every branch above pushes one
       written beat per sourced beat. Both former throw sites are exercised
       here in one call: a page with no evidence, and a page whose writer
       never selected anything from the evidence it had. */
    const acts: SourcedAct[] = [
      {
        title: "How AI systems get built",
        slots: [
          {
            title: P5_SLOT,
            beats: [
              { sourcing: "narration", claim: P5_PURPOSE, exploration: false, narration: { mode: "Carry", reason: "t" } },
              { sourcing: "narration", claim: "A claim the writer selects nothing for.", exploration: false, narration: { mode: "Patch", reason: "t" } }
            ]
          }
        ]
      }
    ];
    const written = await writeNarration(
      acts,
      {
        writer: scriptedWriter([{ claims: [] }]),
        verifier: passingVerifier(),
        evidence: recordingGatherer((claim) => (claim === P5_PURPOSE ? [] : [NBS_DOC]))
      },
      voice,
      ctx
    );
    expect(written[0]!.slots[0]!.beats).toHaveLength(2);
    expect(allWrittenNarration(written).map((p) => p.unverifiedReason)).toEqual(["no-evidence", "no-page"]);
    // Still exported, still a distinct error type — for the invariant, not for a page.
    expect(new NarrationWriteError("c", "Carry", new Error("x")).name).toBe("NarrationWriteError");
  });
});

describe("F-51 — per-slot checkpoint inside an act", () => {
  function twoSlotAct(): SourcedAct[] {
    return [
      {
        title: "Act",
        slots: [
          {
            title: "Slot A",
            beats: [
              {
                sourcing: "narration",
                claim: "Claim A about the connection.",
                exploration: false,
                narration: { mode: "Patch", reason: "t" }
              }
            ]
          },
          {
            title: "Slot B",
            beats: [
              {
                sourcing: "narration",
                claim: "Claim B about the connection.",
                exploration: false,
                narration: { mode: "Patch", reason: "t" }
              }
            ]
          }
        ]
      }
    ];
  }

  it("replays only the slot the resume hook does not already have", async () => {
    const banked: Array<{ act: number; slot: number; title: string }> = [];
    const writer = new StubNarrationWriterBuilder();
    let writeCalls = 0;
    /* The stub takes G-34's merged call on a clean slot, so that is the
       request a written slot costs. */
    const realWrite = writer.selectAndWrite.bind(writer);
    writer.selectAndWrite = async (request, buildCtx) => {
      writeCalls++;
      return realWrite(request, buildCtx);
    };

    /* Slot A as a previous run left it on disk. */
    const first = await writeNarration(twoSlotAct(), makeOptions(), voice, ctx);
    const slotA: WrittenSlot = first[0]!.slots[0]!;

    const written = await writeNarration(
      twoSlotAct(),
      {
        writer,
        verifier: new StubNarrationVerifierBuilder(),
        evidence: fixtureGatherer(),
        resume: (actIndex, slotIndex) => (actIndex === 0 && slotIndex === 0 ? slotA : undefined),
        onSlotWritten: (act, slot, value) => {
          banked.push({ act, slot, title: value.title });
        }
      },
      voice,
      ctx
    );

    /* One slot written, one replayed: the re-run pays for what is missing
       and nothing else. */
    expect(writeCalls).toBe(1);
    expect(written[0]!.slots[0]).toEqual(slotA);
    expect(written[0]!.slots[1]!.title).toBe("Slot B");
    /* And only the slot actually written is banked — a resumed slot is
       already stored. */
    expect(banked).toEqual([{ act: 0, slot: 1, title: "Slot B" }]);
  });

  it("banks a finished slot even when a sibling slot throws", async () => {
    const banked: string[] = [];
    const writer = new StubNarrationWriterBuilder();
    const realWrite = writer.selectAndWrite.bind(writer);
    let firstSlotTitle: string | null = null;
    writer.selectAndWrite = async (request, buildCtx) => {
      if (firstSlotTitle === null) firstSlotTitle = request.slotTitle;
      if (request.slotTitle !== firstSlotTitle) {
        /* Slow enough that the healthy slot certainly finished and banked
           first — which is the property under test. */
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("provider went away mid-slot");
      }
      return realWrite(request, buildCtx);
    };

    await expect(
      writeNarration(
        twoSlotAct(),
        {
          writer,
          verifier: new StubNarrationVerifierBuilder(),
          evidence: fixtureGatherer(),
          onSlotWritten: (_act, _slot, value) => {
            banked.push(value.title);
          }
        },
        voice,
        ctx
      )
    ).rejects.toThrow(/provider went away/);

    expect(banked).toHaveLength(1);
  });

  it("behaves exactly as before when no hooks are supplied", async () => {
    const written = await writeNarration(twoSlotAct(), makeOptions(), voice, ctx);
    expect(written[0]!.slots.map((s) => s.title)).toEqual(["Slot A", "Slot B"]);
    expect(allWrittenNarration(written)).toHaveLength(2);
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
    expect(tapeDoc!.title).toBe("Bread From Home \u2014 The griddle and the bakestone");
  });
});
