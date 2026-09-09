import { describe, it, expect } from "vitest";
import {
  MIN_QUOTE_WORDS,
  containsNegativeRecordClaim,
  findHoldingDoc,
  hasDeclarativeSentence,
  isCompleteSentence,
  normalizeForQuoteMatch,
  quoteEchoesPurpose,
  quoteWords,
  validateNarratedBeat,
  type EvidenceDoc,
  type NarratedBeat,
  type Source
} from "../src/types/narration";

/**
 * WS-A's mechanical rules, exercised against the REAL failures of
 * generation run 1 (docs/curation/generation-run-2026-09-09.md) rather
 * than invented examples — every fixture below is a span, publication or
 * sentence a page actually shipped in that run:
 *
 *   F-30  the tape slug `bfh-griddle-bakestone` cited as a publication;
 *   F-32  the same span attributed to Wikipedia, then to Britannica;
 *   F-42  the one- and two-word quotes ("debris", "fish screen");
 *   F-45  "Exactly where, the record doesn't say" — which is untrue;
 *   F-46  the beat purpose quoted back, credited to a real publisher;
 *   F-36/F-37/F-44 the zero-source connective page.
 */

const NBS_DOC: EvidenceDoc = {
  docId: "print:nbs-143",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

const TAPE_DOC: EvidenceDoc = {
  docId: "tape:bfh-griddle-bakestone#310",
  title: "Bread from Home — The griddle and the bakestone",
  text: "So the bakestone came first, and the iron griddle only really arrives once cast iron is cheap enough to sit on every hearth."
};

function page(overrides: Partial<NarratedBeat> = {}): NarratedBeat {
  return {
    mode: "Patch",
    script:
      "One welded joint now carried both walkways' weight, and the drawings for it were never checked. " +
      "The connection as built could hold about sixty percent of what the code required of it, which is " +
      "the number the investigators kept returning to when they explained why the fourth floor came down. " +
      "Nobody had signed off on the change in the sense anyone later expected, and the drawing that showed " +
      "it went round the office as a routine revision rather than as a question anyone was asked to answer.",
    sources: [],
    pronunciationHints: [],
    verified: true,
    ...overrides
  };
}

const goodSource: Source = {
  claimText: "the connection was never checked",
  quote: "The box beam-hanger rod connections were not checked for adequacy at any stage of the design.",
  publication: NBS_DOC.title,
  contested: false
};

describe("normalizeForQuoteMatch — a quote is a lookup, and only typography is forgiven", () => {
  it("collapses whitespace, folds case and normalizes curly punctuation", () => {
    expect(normalizeForQuoteMatch("The  walkways’\nweight —  checked")).toBe("the walkways' weight - checked");
  });

  it("does NOT forgive a changed word: a near-quote is not a quote", () => {
    const doc: EvidenceDoc = { docId: "d", title: "T", text: "the connection was never checked for adequacy" };
    expect(findHoldingDoc("the connection was never checked for adequacy", [doc])).toBe(doc);
    expect(findHoldingDoc("the connection was never reviewed for adequacy", [doc])).toBeNull();
  });

  it("finds the span across whitespace and quote-character differences", () => {
    expect(findHoldingDoc("The box beam-hanger rod   connections were not checked", [NBS_DOC])).toBe(NBS_DOC);
  });
});

describe("F-42 — a quote too short to be checkable is rejected", () => {
  it.each(["debris", "spillway", "fish screen", "the fish screen"])("rejects the run-1 span %o", (quote) => {
    const result = validateNarratedBeat(
      page({ sources: [{ claimText: "the screens choked the channel", quote, publication: NBS_DOC.title, contested: false }] }),
      { heldDocs: [{ ...NBS_DOC, text: `${NBS_DOC.text} Then the debris and the fish screen and the spillway.` }] }
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "quote-too-short")).toBe(true);
  });

  it(`accepts a span of ${MIN_QUOTE_WORDS} words or more`, () => {
    expect(quoteWords(goodSource.quote).length).toBeGreaterThanOrEqual(MIN_QUOTE_WORDS);
    const result = validateNarratedBeat(page({ sources: [goodSource] }), { heldDocs: [NBS_DOC] });
    expect(result.issues.some((i) => i.code === "quote-too-short")).toBe(false);
  });

  it("accepts a SHORT span when it is a complete sentence standing at a sentence boundary in the document", () => {
    const doc: EvidenceDoc = { docId: "d", title: "T", text: "Everyone agreed on that. The dam failed. Nobody could say when." };
    expect(isCompleteSentence("The dam failed.", doc.text)).toBe(true);
    // Capitalising a mid-sentence fragment does not make it a sentence.
    expect(isCompleteSentence("Nobody could say when.", "and then nobody could say when the water rose")).toBe(false);
    const result = validateNarratedBeat(
      page({ sources: [{ claimText: "the dam failed", quote: "The dam failed.", publication: "T", contested: false }] }),
      { heldDocs: [doc] }
    );
    expect(result.issues.some((i) => i.code === "quote-too-short")).toBe(false);
  });
});

describe("F-14/F-27 — a quote that is in no held document is rejected", () => {
  it("rejects the fabricated 'New Safe Confinement' style citation: real-looking span, no document behind it", () => {
    const result = validateNarratedBeat(
      page({
        sources: [
          {
            claimText: "the hanger rods were doubled",
            quote: "The interviews describe the hanger rod change as one made on the shop floor overnight.",
            publication: "New Safe Confinement Construction Engineering Interviews",
            contested: false
          }
        ]
      }),
      { heldDocs: [NBS_DOC] }
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "quote-not-held")).toBe(true);
  });

  it("skips the rule — rather than inventing a verdict — when the caller holds no documents at all", () => {
    const result = validateNarratedBeat(page({ sources: [goodSource] }), {});
    expect(result.issues.some((i) => i.code === "quote-not-held")).toBe(false);
  });
});

describe("F-30/F-32 — the publication is the held document's title, never free text", () => {
  it("rejects the tape item id as a publication (the griddle slug on a Kansas City claim)", () => {
    const result = validateNarratedBeat(
      page({
        sources: [
          {
            claimText: "the bakestone came before the griddle",
            quote: TAPE_DOC.text.slice(0, 80),
            publication: "bfh-griddle-bakestone",
            contested: false
          }
        ]
      }),
      { heldDocs: [TAPE_DOC] }
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "publication-not-held")).toBe(true);
  });

  it("rejects a plausibility label — the same span moved from Wikipedia to Britannica across attempts", () => {
    for (const publication of ["Wikipedia", "Encyclopædia Britannica"]) {
      const result = validateNarratedBeat(page({ sources: [{ ...goodSource, publication }] }), { heldDocs: [NBS_DOC] });
      expect(result.issues.some((i) => i.code === "publication-not-held")).toBe(true);
    }
  });

  it("accepts the held document's own title, and its url", () => {
    for (const publication of [NBS_DOC.title, NBS_DOC.url!]) {
      const result = validateNarratedBeat(page({ sources: [{ ...goodSource, publication }] }), { heldDocs: [NBS_DOC] });
      expect(result.issues.some((i) => i.code === "publication-not-held")).toBe(false);
    }
  });
});

describe("F-46 — the beat purpose may never be quoted back as a source", () => {
  const purpose = "Welding crews reinforced the tower's joints at night for three months in 1978.";

  it("rejects run 1's last page: the deepen stage's own sentence, credited to Engineering News-Record", () => {
    const result = validateNarratedBeat(
      page({
        sources: [
          {
            claimText: "the joints were reinforced at night",
            quote: "welding crews reinforced the tower's joints at night for three months in 1978",
            publication: "Engineering News-Record",
            contested: false
          }
        ]
      }),
      { purposeText: purpose }
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "quote-echoes-purpose")).toBe(true);
  });

  it("rejects a quote that merely shares a long run with the purpose or the prompt's context note", () => {
    expect(quoteEchoesPurpose("Reports say welding crews reinforced the tower's joints at night, and left before dawn.", purpose)).toBe(true);
  });

  it("does not reject a genuine quote about the same subject", () => {
    expect(quoteEchoesPurpose(goodSource.quote, purpose)).toBe(false);
  });

  it("does not trip on a one-word purpose, which is a substring of almost everything", () => {
    expect(quoteEchoesPurpose(goodSource.quote, "c")).toBe(false);
  });
});

describe("F-45 — a claim about what the record contains needs a source that says so", () => {
  it.each([
    "Exactly where, the record doesn't say.",
    "The record does not settle which of them signed off on it.",
    "No one knows who approved the change.",
    "There is no record of the second call.",
    "Where the load sat is not recorded."
  ])("detects the negative claim: %s", (sentence) => {
    expect(containsNegativeRecordClaim(sentence)).toBe(true);
  });

  it("does not fire on an ordinary assertion", () => {
    expect(containsNegativeRecordClaim("The report locates the staged material over the U10 nodes.")).toBe(false);
  });

  it("rejects the run-1 retry that turned an unsourced true claim into a sourced-looking false one", () => {
    const result = validateNarratedBeat(
      page({
        script: "The staged load sat somewhere on that span. Exactly where, the record doesn't say, and the crews never wrote it down.",
        mode: "Marker",
        sources: [goodSource]
      }),
      { heldDocs: [NBS_DOC] }
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "unsourced-negative-claim")).toBe(true);
  });

  it("accepts it when a source's own quote says the record is silent", () => {
    const doc: EvidenceDoc = {
      docId: "print:ntsb",
      title: "NTSB Highway Accident Report HAR-83/03",
      text: "The position of the staged material at the time of the collapse is not recorded in any surviving document."
    };
    const result = validateNarratedBeat(
      page({
        script: "The staged load sat somewhere on that span. Exactly where, the record doesn't say, and the crews never wrote it down.",
        mode: "Marker",
        sources: [{ claimText: "the position was not recorded", quote: doc.text, publication: doc.title, contested: false }]
      }),
      { heldDocs: [doc] }
    );
    expect(result.issues.some((i) => i.code === "unsourced-negative-claim")).toBe(false);
  });
});

describe("F-36/F-37/F-44 — zero sources is settled in code, so the verifier never sees the case", () => {
  it("accepts a source-free page that only asks a question", () => {
    expect(hasDeclarativeSentence("Was this a shortcut, or the only way anyone could have built it that season?")).toBe(false);
    const result = validateNarratedBeat(
      page({ mode: "Frame", script: "Was this a shortcut, or the only way anyone could have built it that season?", sources: [] })
    );
    expect(result.issues.some((i) => i.code === "sources-empty-with-claims")).toBe(false);
  });

  it("accepts a source-free hand-off addressed to the listener — the one page run 1 passed by coin flip", () => {
    const script = "What if the storm a dam was built for isn't the storm its river has now? Listen for how that gap opens.";
    expect(hasDeclarativeSentence(script)).toBe(false);
    const result = validateNarratedBeat(page({ mode: "Frame", script, sources: [] }));
    expect(result.issues.some((i) => i.code === "sources-empty-with-claims")).toBe(false);
  });

  it("rejects a source-free page that states something about the world", () => {
    const result = validateNarratedBeat(
      page({ mode: "Frame", script: "The walkways hung from a single rod for four years before anyone looked at it.", sources: [] })
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "sources-empty-with-claims")).toBe(true);
  });
});

describe("validateNarratedBeat — a well-formed, fully-grounded page passes every mechanical rule", () => {
  it("passes with a held quote, the document's own title, and a purpose it does not echo", () => {
    const result = validateNarratedBeat(page({ sources: [goodSource] }), {
      heldDocs: [NBS_DOC],
      purposeText: "Show what the fourth-floor connection was actually asked to hold."
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
