import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DefaultEvidenceGatherer,
  EVIDENCE_MAX_PASSAGE_CHARS,
  EVIDENCE_MAX_PRINT_PASSAGES,
  EVIDENCE_TAPE_WINDOW_SEC,
  beatKindOf,
  claimHash,
  cueWindowText,
  createEvidenceGatherer,
  findDigestForItem,
  titlesForItem
} from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { findHoldingDoc } from "../src/types/narration";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { ExternalResearcher, ExternalResearchContext, ExternalResearchResult, PassageRetrievalRequest, RetrievedPassage } from "../src/generation/ExternalResearcher";
import type { TranscriptCue, TranscriptCueProvider, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { TapePointer } from "../src/types/tapeSourcing";

/**
 * WS-A's evidence pack. The point of every test here is the one the fix
 * plan makes in a sentence: a quote has to be a LOOKUP. These assert that
 * the pack really does hold text the pipeline retrieved (or heard on
 * tape), that it is bounded, that it is cached, and that an argument beat
 * is never handed tape to anchor to.
 *
 * The real retrieval path needs an API key, so it is exercised here
 * through the `ExternalResearcher` interface with a fake retriever —
 * `AnthropicExternalResearcher.retrievePassages` is the only part not
 * covered by a test, and its budget-guard and parse behaviour follow the
 * same shape `AnthropicExternalResearcher.test.ts` already covers for
 * `research()`.
 */

const ctx: ExternalResearchContext = { userId: "founder-1" };

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
  { text: "Before any of that, people baked on a stone.", start_sec: 100, end_sec: 110 },
  { text: "So the bakestone came first, and the iron griddle only arrives once cast iron is cheap.", start_sec: 300, end_sec: 315 },
  { text: "And that is the part everybody gets backwards.", start_sec: 315, end_sec: 320 },
  { text: "Much later, the whole trade moved indoors.", start_sec: 900, end_sec: 910 }
];

class FixedCueProvider implements TranscriptCueProvider {
  constructor(private readonly cues: TranscriptCue[] | null) {}
  getCues(): TranscriptCue[] | null {
    return this.cues;
  }
}

class FakeRetriever implements ExternalResearcher {
  readonly providerName = "fake";
  calls: PassageRetrievalRequest[] = [];
  constructor(private readonly passages: RetrievedPassage[]) {}
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
  async retrievePassages(request: PassageRetrievalRequest): Promise<RetrievedPassage[]> {
    this.calls.push(request);
    return this.passages;
  }
}

/** A researcher with no retrieval at all — the interface allows it, and
 * the pack must degrade to "no print evidence" rather than throw. */
class ResearchOnly implements ExternalResearcher {
  readonly providerName = "research-only";
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
}

const tape: TapePointer = {
  segmentId: "bread-from-home--griddle-bakestone#300",
  itemId: "bread-from-home--griddle-bakestone",
  startSec: 300,
  endSec: 315,
  startAnchor: "so the bakestone came first",
  endAnchor: "cast iron is cheap",
  tier: 1,
  confidence: "high"
};

function gatherer(researcher: ExternalResearcher, cues: TranscriptCue[] | null = CUES) {
  return new DefaultEvidenceGatherer({
    researcher,
    cueProvider: new FixedCueProvider(cues),
    catalogue: CATALOGUE,
    transcriptArchive: [DIGEST],
    cacheDir: null,
    now: () => new Date("2026-09-09T12:00:00.000Z")
  });
}

describe("cueWindowText — the tape a beat is anchored to, ±90 seconds of it", () => {
  it("includes the cues inside the window and excludes the ones outside", () => {
    const text = cueWindowText(CUES, tape.startSec, tape.endSec);
    expect(text).toContain("So the bakestone came first");
    expect(text).toContain("And that is the part everybody gets backwards.");
    // 100-110s is more than 90s before the segment starts; 900s is far after.
    expect(text).not.toContain("people baked on a stone");
    expect(text).not.toContain("moved indoors");
  });

  it("widens by exactly EVIDENCE_TAPE_WINDOW_SEC on each side", () => {
    const justInside: TranscriptCue[] = [{ text: "just inside", start_sec: tape.startSec - EVIDENCE_TAPE_WINDOW_SEC, end_sec: tape.startSec - EVIDENCE_TAPE_WINDOW_SEC + 1 }];
    const justOutside: TranscriptCue[] = [{ text: "just outside", start_sec: 0, end_sec: tape.startSec - EVIDENCE_TAPE_WINDOW_SEC - 1 }];
    expect(cueWindowText(justInside, tape.startSec, tape.endSec)).toBe("just inside");
    expect(cueWindowText(justOutside, tape.startSec, tape.endSec)).toBe("");
  });
});

describe("the pack for a tape beat — who is on the tape, and what they said", () => {
  it("carries the show and episode title, so a Frame can attribute the tape instead of citing its slug (F-30)", async () => {
    const pack = await gatherer(new FakeRetriever([])).gather({ claim: "the bakestone came first", tape }, ctx);
    expect(pack.tape).toEqual({
      itemId: tape.itemId,
      showTitle: "Bread From Home",
      episodeTitle: "The griddle and the bakestone",
      startSec: 300,
      endSec: 315
    });
  });

  it("holds the cue window as a document whose TITLE is the work — never the item id", async () => {
    const pack = await gatherer(new FakeRetriever([])).gather({ claim: "the bakestone came first", tape }, ctx);
    const doc = pack.docs.find((d) => d.kind === "tape")!;
    expect(doc.docId).toBe(`tape:${tape.segmentId}`);
    expect(doc.title).toBe("Bread From Home — The griddle and the bakestone");
    expect(doc.title).not.toMatch(/^[a-z0-9-]+$/);
    // And a span from the tape is now genuinely findable in a held document.
    expect(findHoldingDoc("the iron griddle only arrives once cast iron is cheap", pack.docs)).toBe(doc);
  });

  it("still names the tape when no transcript body is on disk — with no document to quote from", async () => {
    const pack = await gatherer(new FakeRetriever([]), null).gather({ claim: "the bakestone came first", tape }, ctx);
    expect(pack.tape?.showTitle).toBe("Bread From Home");
    expect(pack.docs.filter((d) => d.kind === "tape")).toHaveLength(0);
  });

  it("gives an ARGUMENT beat print evidence only, never tape (WS-C's kind tag)", async () => {
    const pack = await gatherer(new FakeRetriever([{ title: "A paper", text: "Some retrieved wording." }])).gather(
      { claim: "the shift was economic, not technical", kind: "argument", tape },
      ctx
    );
    expect(pack.beatKind).toBe("argument");
    expect(pack.tape).toBeUndefined();
    expect(pack.docs.every((d) => d.kind === "print")).toBe(true);
  });

  it("treats a beat with no kind field as an account — the field does not exist upstream yet", () => {
    expect(beatKindOf({})).toBe("account");
    expect(beatKindOf({ kind: "argument" })).toBe("argument");
    expect(beatKindOf({ kind: "something-else" })).toBe("account");
  });
});

describe("print evidence — bounded, attributed, and retrieved rather than recalled", () => {
  it("caps the pack at three passages of 1,500 characters and asks the retriever for exactly that", async () => {
    const many: RetrievedPassage[] = Array.from({ length: 6 }, (_, i) => ({
      title: `Doc ${i}`,
      text: "x".repeat(4000)
    }));
    const retriever = new FakeRetriever(many);
    const pack = await gatherer(retriever).gather({ claim: "a claim with a lot written about it" }, ctx);
    const print = pack.docs.filter((d) => d.kind === "print");
    expect(print).toHaveLength(EVIDENCE_MAX_PRINT_PASSAGES);
    for (const doc of print) expect(doc.text.length).toBe(EVIDENCE_MAX_PASSAGE_CHARS);
    expect(retriever.calls[0]).toEqual({
      claim: "a claim with a lot written about it",
      maxPassages: EVIDENCE_MAX_PRINT_PASSAGES,
      maxChars: EVIDENCE_MAX_PASSAGE_CHARS
    });
  });

  it("mints a doc id and stamps a retrieval time when the retriever supplies neither", async () => {
    const pack = await gatherer(new FakeRetriever([{ title: "A paper", text: "Some retrieved wording." }])).gather({ claim: "a claim" }, ctx);
    const doc = pack.docs[0]!;
    expect(doc.docId).toBe(`print:${claimHash("a claim")}-1`);
    expect(doc.retrievedAt).toBe("2026-09-09T12:00:00.000Z");
  });

  it("drops a passage with no text or no title rather than holding an unquotable document", async () => {
    const pack = await gatherer(new FakeRetriever([
      { title: "Real", text: "Real wording." },
      { title: "", text: "Orphaned wording." },
      { title: "Titled", text: "   " }
    ])).gather({ claim: "a claim" }, ctx);
    expect(pack.docs.map((d) => d.title)).toEqual(["Real"]);
  });

  it("continues with the evidence it already holds when retrieval throws", async () => {
    const broken: ExternalResearcher = {
      providerName: "broken",
      async research() {
        return { notes: "", controversies: [] };
      },
      async retrievePassages(): Promise<RetrievedPassage[]> {
        throw new Error("search is down");
      }
    };
    const pack = await gatherer(broken).gather({ claim: "the bakestone came first", tape }, ctx);
    expect(pack.docs.filter((d) => d.kind === "print")).toHaveLength(0);
    expect(pack.docs.filter((d) => d.kind === "tape")).toHaveLength(1);
  });

  it("degrades to no print evidence for a researcher that implements no retrieval at all", async () => {
    const pack = await gatherer(new ResearchOnly()).gather({ claim: "a claim" }, ctx);
    expect(pack.docs).toEqual([]);
  });
});

describe("the retrieval cache — a re-run is free", () => {
  it("reads a second identical claim out of the cache instead of retrieving it again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-"));
    try {
      const retriever = new FakeRetriever([{ title: "A paper", text: "Some retrieved wording." }]);
      const g = new DefaultEvidenceGatherer({ researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] });
      const first = await g.gather({ claim: "an expensive claim" }, ctx);
      const second = await g.gather({ claim: "An  Expensive   Claim" }, ctx);
      expect(retriever.calls).toHaveLength(1);
      expect(second.docs).toEqual(first.docs);
      expect(fs.readdirSync(dir)).toEqual([`${claimHash("an expensive claim")}.json`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never writes a cache for a stub researcher — a dry-run's fixtures are not a retrieval", async () => {
    const g = createEvidenceGatherer({ researcher: new StubExternalResearcher(), catalogue: CATALOGUE, transcriptArchive: [] });
    const pack = await g.gather({ claim: "a dry-run claim" }, ctx);
    expect(pack.docs).toHaveLength(1);
    expect(fs.existsSync(path.join(__dirname, "..", "..", "data-local", "evidence", `${claimHash("a dry-run claim")}.json`))).toBe(false);
  });

  it("the dry-run fixture is quotable and shares no run with the beat purpose", async () => {
    const claim = "This passage stands in for something the pipeline retrieved.";
    const g = createEvidenceGatherer({ researcher: new StubExternalResearcher(), catalogue: CATALOGUE, transcriptArchive: [] });
    const pack = await g.gather({ claim }, ctx);
    expect(findHoldingDoc("It exists so that a quoted span can be looked up", pack.docs)).not.toBeNull();
  });
});

describe("resolving a tape item to the episode whose transcript we hold", () => {
  it("matches a catalogue item to its digest entry by show and title", () => {
    expect(findDigestForItem("bread-from-home--griddle-bakestone", [DIGEST], CATALOGUE)).toBe(DIGEST);
  });

  it("matches a tier-2 minted item id exactly", () => {
    expect(findDigestForItem("bread-from-home--the-griddle-and-the-bakestone", [DIGEST], CATALOGUE)).toBe(DIGEST);
  });

  it("returns null rather than a guess for an item nothing knows about", () => {
    expect(findDigestForItem("some-other-show--unknown", [DIGEST], CATALOGUE)).toBeNull();
    expect(titlesForItem("some-other-show--unknown", CATALOGUE, null)).toBeNull();
  });

  it("falls back to the digest's own show and episode title when the catalogue has never listed the episode", () => {
    expect(titlesForItem("bread-from-home--not-in-catalogue", CATALOGUE, DIGEST)).toEqual({
      showTitle: "Bread From Home",
      episodeTitle: "The griddle and the bakestone"
    });
  });
});
