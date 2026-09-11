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
  retryQueryFor,
  RETRY_QUERY_MAX_WORDS,
  titlesForItem
} from "../src/generation/gatherEvidence";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { EMPTY_EVIDENCE_TTL_MS, emptyEvidenceTtlMs, readEvidenceCache } from "../src/generation/evidenceCache";
import { findHoldingDoc } from "../src/types/narration";
import { leadingNounPhrase } from "../src/types/spine";
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

/** Answers the calls in order, repeating its last answer thereafter. */
class SequenceRetriever implements ExternalResearcher {
  readonly providerName = "sequence";
  calls: PassageRetrievalRequest[] = [];
  constructor(private readonly answers: RetrievedPassage[][]) {}
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
  async retrievePassages(request: PassageRetrievalRequest): Promise<RetrievedPassage[]> {
    this.calls.push(request);
    return this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)] ?? [];
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

describe("F-60 — an empty retrieval is asked once more, rephrased", () => {
  /* Run 2 attempt 2, act 1 page p5's purpose, verbatim: one long editorial
     sentence, framing and all. Asked as a search query it returned
     `{"passages": []}`, the empty result was cached, and the page then
     cost three claim-selection calls and the Foray. */
  const P5_PURPOSE =
    "Mature pipelines treat a dataset the way a build system treats source code: a schema check — wrong type, " +
    "an out-of-range value, a null where one shouldn't be — fails the run outright, the same way a type error " +
    "fails a compile, rather than letting a corrupted batch train a model that ships anyway.";

  const FOUND: RetrievedPassage[] = [{ title: "Great Expectations documentation", text: "A failed expectation halts the pipeline run before the batch is written." }];

  it("asks a SECOND, differently-worded query when a content beat's first query finds nothing", async () => {
    const retriever = new SequenceRetriever([[], FOUND]);
    const pack = await gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);

    expect(retriever.calls).toHaveLength(2);
    expect(retriever.calls[0]!.claim).toBe(P5_PURPOSE);
    expect(retriever.calls[1]!.claim).not.toBe(P5_PURPOSE);
    expect(retriever.calls[1]!.claim).toBe(retryQueryFor(P5_PURPOSE));
    expect(pack.docs.map((d) => d.title)).toEqual(["Great Expectations documentation"]);
  });

  it("asks once more and then stops — two queries per page, never three", async () => {
    const retriever = new SequenceRetriever([[]]);
    const pack = await gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    expect(retriever.calls).toHaveLength(2);
    /* And the pack really is empty, which is the signal writeNarration
       degrades on rather than paying a writer to fail (F-60). */
    expect(pack.docs).toEqual([]);
  });

  it("never spends the second query on a page that can be written from no documents at all", async () => {
    const retriever = new SequenceRetriever([[], FOUND]);
    const pack = await gatherer(retriever).gather({ claim: P5_PURPOSE }, ctx);
    expect(retriever.calls).toHaveLength(1);
    expect(pack.docs).toEqual([]);
  });

  it("asks BOTH queries for a content page even when the first finds something — one extra call is the price of never waiting on an empty first (G-35 / M5)", async () => {
    /* This used to assert ONE call. The serial protocol's saving was one
       Haiku call (≈ $0.02) on the half of pages whose first query succeeds;
       its cost was 12–30 s of waiting on the other half. The concurrent
       protocol spends the call and never waits — see the G-35 suite below
       for the overlap itself. */
    const retriever = new SequenceRetriever([FOUND]);
    const pack = await gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    expect(retriever.calls).toHaveLength(2);
    expect(pack.docs.map((d) => d.title)).toEqual(["Great Expectations documentation"]);
  });

  it("never dispatches either query when the claim's pack is already held — a cache hit races nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-held-"));
    try {
      const retriever = new SequenceRetriever([FOUND]);
      const options = { researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] };
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      expect(retriever.calls).toHaveLength(2);
      /* MUTATION THAT KILLS THIS: drop the `held` check at the top of
         `printEvidenceFor` — the retry query is then dispatched before the
         first query's cache hit is seen, and the count reaches 3. */
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      expect(retriever.calls).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches the retry under its OWN key, so the first query's emptiness is never served in its place", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-f60-"));
    try {
      const retriever = new SequenceRetriever([[], FOUND]);
      const options = { researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] };
      const first = await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      // A fresh gatherer, as a re-run would be: both queries are cache hits.
      const second = await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);

      expect(retriever.calls).toHaveLength(2);
      expect(second.docs).toEqual(first.docs);
      expect(fs.readdirSync(dir).sort()).toEqual(
        [`${claimHash(P5_PURPOSE)}.json`, `${claimHash(retryQueryFor(P5_PURPOSE))}.json`].sort()
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops treating a cached EMPTY result as a hit after 24 hours", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-ttl-"));
    try {
      /* Too few distinctive words to rephrase, so this claim asks exactly
         one query per gather and the count is unambiguous. */
      const claim = "a claim nothing knows";
      const retriever = new SequenceRetriever([[]]);
      const at = (iso: string) => new DefaultEvidenceGatherer({
        researcher: retriever,
        cacheDir: dir,
        catalogue: CATALOGUE,
        transcriptArchive: [],
        now: () => new Date(iso)
      });

      expect(retryQueryFor(claim)).toBe("");
      await at("2026-09-09T12:00:00.000Z").gather({ claim, requiresEvidence: true }, ctx);
      expect(retriever.calls).toHaveLength(1);

      // An hour later the emptiness is still a fact about now: no new call.
      await at("2026-09-09T13:00:00.000Z").gather({ claim, requiresEvidence: true }, ctx);
      expect(retriever.calls).toHaveLength(1);

      // A day later it is a fact about yesterday, and the web has moved.
      await at("2026-09-10T13:00:00.000Z").gather({ claim, requiresEvidence: true }, ctx);
      expect(retriever.calls).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the purpose's first clause, as a readable question about the claim's subject (F-69)", () => {
    /* WHAT THIS REPLACES. The retry used to be the sentence's rarest-looking
       words, longest first: run 2 attempt 4b's log has "Conway's bites pipeline
       boundaries wherever postmortem exactly places" and "rotation spanning
       training diagnose failures materially separate rotations" in it, and one
       of those came back with fault-diagnosis papers about rotating machinery
       for a claim about an on-call rotation. A bag of tokens has no subject.

       MUTATION THAT KILLS THIS: drop the `the way …` clause opener from
       `retryQueryFor`'s boundary test. The cut falls through to the colon and
       the query is the whole analogy again — "Mature pipelines treat a dataset
       the way a build system treats source code" — which is the framing the
       FIRST query already failed on. Ran it — red. */
    const query = retryQueryFor(P5_PURPOSE);
    expect(query).toBe("Mature pipelines treat a dataset");

    /* The three properties that make it a query rather than a word list, stated
       against the function rather than against that one string: it is a PREFIX
       of the purpose (so it reads as English, in the purpose's own order), it
       is bounded, and it contains the whole of the claim's subject. */
    expect(P5_PURPOSE.startsWith(query)).toBe(true);
    expect(query.split(" ").length).toBeLessThanOrEqual(RETRY_QUERY_MAX_WORDS);
    expect(query.startsWith(leadingNounPhrase(P5_PURPOSE))).toBe(true);

    /* And the framing the first query already failed on is gone: the analogy
       ("the way a build system…"), the parenthetical schema check, the
       consequence. */
    expect(query).not.toContain("the way");
    expect(query).not.toContain("rather than");
    expect(query).not.toContain("schema check");
  });

  it("cuts a clause off a purpose built the other way round, too", () => {
    /* The `wherever` claim from the same run, shortened to the question a
       librarian would have been asked. The clause opener is a word here rather
       than punctuation, which is the other half of the rule. */
    expect(retryQueryFor("Conway's law bites at pipeline boundaries wherever a postmortem places them.")).toBe(
      "Conway's law bites at pipeline boundaries"
    );
    /* And an em dash is a clause boundary exactly like a subordinator. */
    expect(retryQueryFor("An on-call rotation spanning training and inference — the shape most teams land on — makes failures harder to diagnose.")).toBe(
      "An on-call rotation spanning training and inference"
    );
  });

  it("returns nothing to ask when the shorter question is the claim over again", () => {
    /* A one-clause purpose IS the query, so there is no second question to ask
       and no second call to pay for. */
    expect(retryQueryFor("Charcoal briquettes were a Ford Motor Company waste-disposal scheme.")).toBe("");
    expect(retryQueryFor("It was over.")).toBe("");
    expect(retryQueryFor("")).toBe("");
  });
});

/** A retriever whose every answer is held back until the test releases it —
 * the latch that lets a test SEE two queries in flight at once, rather than
 * inferring overlap from a call count that a serial protocol would match. */
class LatchedRetriever implements ExternalResearcher {
  readonly providerName = "latched";
  calls: Array<{ request: PassageRetrievalRequest; resolve: (p: RetrievedPassage[]) => void; reject: (e: Error) => void; settled: boolean }> = [];
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
  retrievePassages(request: PassageRetrievalRequest): Promise<RetrievedPassage[]> {
    return new Promise((resolve, reject) => {
      const call = {
        request,
        settled: false,
        resolve: (p: RetrievedPassage[]) => {
          call.settled = true;
          resolve(p);
        },
        reject: (e: Error) => {
          call.settled = true;
          reject(e);
        }
      };
      this.calls.push(call);
    });
  }
}

class ThrowingRetriever implements ExternalResearcher {
  readonly providerName = "throwing";
  calls = 0;
  async research(): Promise<ExternalResearchResult> {
    return { notes: "", controversies: [] };
  }
  async retrievePassages(): Promise<RetrievedPassage[]> {
    this.calls += 1;
    throw new Error("search backend returned 503");
  }
}

/** Lets every already-queued microtask and I/O callback run, so a gather
 * that dispatches synchronously has dispatched everything it is going to. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("G-35 — the two queries run concurrently, and the first non-empty answer wins", () => {
  const P5_PURPOSE =
    "Mature pipelines treat a dataset the way a build system treats source code: a schema check — wrong type, " +
    "an out-of-range value, a null where one shouldn't be — fails the run outright, the same way a type error " +
    "fails a compile, rather than letting a corrupted batch train a model that ships anyway.";
  const FOUND: RetrievedPassage[] = [{ title: "Great Expectations documentation", text: "A failed expectation halts the pipeline run before the batch is written." }];
  const ALSO_FOUND: RetrievedPassage[] = [{ title: "Data validation at scale", text: "Schema checks fail the run before a corrupted batch reaches training." }];

  it("dispatches the rephrased query BEFORE the first has answered — the latches prove the overlap", async () => {
    /* MUTATION THAT KILLS THIS: `await` the first `retrieveFor` before
       calling the second (the pre-G-35 body). The second call is then not
       in the log while the first is still latched, and the count is 1. */
    const retriever = new LatchedRetriever();
    const pending = gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    await settle();

    expect(retriever.calls).toHaveLength(2);
    expect(retriever.calls.every((c) => !c.settled)).toBe(true);
    expect(retriever.calls[0]!.request.claim).toBe(P5_PURPOSE);
    expect(retriever.calls[1]!.request.claim).toBe(retryQueryFor(P5_PURPOSE));

    retriever.calls[0]!.resolve([]);
    retriever.calls[1]!.resolve([]);
    expect((await pending).docs).toEqual([]);
  });

  it("returns the rephrased query's documents the moment they land, without waiting for the first query at all", async () => {
    /* MUTATION THAT KILLS THIS: replace `firstNonEmpty` with `Promise.all`
       and pick afterwards — the gather then cannot resolve while call 0 is
       latched, and the `await pending` below hangs until the test times out. */
    const retriever = new LatchedRetriever();
    const pending = gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    await settle();

    retriever.calls[1]!.resolve(ALSO_FOUND);
    const pack = await pending;
    expect(pack.docs.map((d) => d.title)).toEqual(["Data validation at scale"]);
    expect(retriever.calls[0]!.settled).toBe(false);
    retriever.calls[0]!.resolve([]);
  });

  it("returns the first query's documents the moment they land, with the rephrased one still in flight", async () => {
    const retriever = new LatchedRetriever();
    const pending = gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    await settle();

    retriever.calls[0]!.resolve(FOUND);
    const pack = await pending;
    expect(pack.docs.map((d) => d.title)).toEqual(["Great Expectations documentation"]);
    expect(retriever.calls[1]!.settled).toBe(false);
    retriever.calls[1]!.resolve([]);
  });

  it("an empty first answer does not end the wait — the rephrased query's later documents still win", async () => {
    /* MUTATION THAT KILLS THIS: resolve the race on the FIRST answer to land
       whatever it holds (`Promise.race`). The empty first answer then wins and
       the pack is empty. */
    const retriever = new LatchedRetriever();
    const pending = gatherer(retriever).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
    await settle();

    retriever.calls[0]!.resolve([]);
    await settle();
    retriever.calls[1]!.resolve(ALSO_FOUND);
    const pack = await pending;
    expect(pack.docs.map((d) => d.title)).toEqual(["Data validation at scale"]);
  });
});

describe("F-77 — an empty result is not a fact: only a confirmed 'two queries, nothing' is cached, and only for EVIDENCE_EMPTY_TTL_MS", () => {
  const P5_PURPOSE =
    "Mature pipelines treat a dataset the way a build system treats source code: a schema check — wrong type, " +
    "an out-of-range value, a null where one shouldn't be — fails the run outright, the same way a type error " +
    "fails a compile, rather than letting a corrupted batch train a model that ships anyway.";
  const FOUND: RetrievedPassage[] = [{ title: "Great Expectations documentation", text: "A failed expectation halts the pipeline run before the batch is written." }];

  function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-f77-"));
    return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  it("does not cache a connective page's single empty answer — the next run asks again", () =>
    withDir(async (dir) => {
      /* MUTATION THAT KILLS THIS: write the cache unconditionally in
         `retrieveFor` (the pre-G-35 body). The file then exists and the
         second gather is served emptiness for free. */
      const retriever = new SequenceRetriever([[]]);
      const options = { researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] };
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE }, ctx);
      expect(fs.readdirSync(dir)).toEqual([]);
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE }, ctx);
      expect(retriever.calls).toHaveLength(2);
    }));

  it("does not cache a retrieval that failed — a 503 is not a fact about the web", () =>
    withDir(async (dir) => {
      const retriever = new ThrowingRetriever();
      const options = { researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] };
      const pack = await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      expect(pack.docs).toEqual([]);
      expect(retriever.calls).toBe(2);
      expect(fs.readdirSync(dir)).toEqual([]);
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      expect(retriever.calls).toBe(4);
    }));

  it("records the winning documents under the CLAIM's key when the rephrased query won — never the loser's emptiness", () =>
    withDir(async (dir) => {
      /* MUTATION THAT KILLS THIS: drop the `winner.query !== claim` write in
         `printEvidenceFor`. The claim's key is then absent, and the re-run
         pays for the first query again. */
      const retriever = new SequenceRetriever([[], FOUND]);
      const options = { researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [] };
      await new DefaultEvidenceGatherer(options).gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
      const underClaim = readEvidenceCache(dir, claimHash(P5_PURPOSE));
      const underRetry = readEvidenceCache(dir, claimHash(retryQueryFor(P5_PURPOSE)));
      expect(underClaim?.map((d) => d.title)).toEqual(["Great Expectations documentation"]);
      expect(underRetry?.map((d) => d.title)).toEqual(["Great Expectations documentation"]);
    }));

  it("caches a confirmed 'two queries, nothing' under both keys, and stops serving it once EVIDENCE_EMPTY_TTL_MS has passed", () =>
    withDir(async (dir) => {
      const previous = process.env.EVIDENCE_EMPTY_TTL_MS;
      process.env.EVIDENCE_EMPTY_TTL_MS = String(60 * 60 * 1000); // one hour, not a day
      try {
        const retriever = new SequenceRetriever([[]]);
        const at = (iso: string) =>
          new DefaultEvidenceGatherer({ researcher: retriever, cacheDir: dir, catalogue: CATALOGUE, transcriptArchive: [], now: () => new Date(iso) });

        await at("2026-09-09T12:00:00.000Z").gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
        expect(retriever.calls).toHaveLength(2);
        expect(fs.readdirSync(dir).sort()).toEqual(
          [`${claimHash(P5_PURPOSE)}.json`, `${claimHash(retryQueryFor(P5_PURPOSE))}.json`].sort()
        );

        // Thirty minutes on: still a verdict, no new call for either query.
        await at("2026-09-09T12:30:00.000Z").gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
        expect(retriever.calls).toHaveLength(2);

        /* Two hours on: the operator's one-hour TTL has passed, and both
           questions are asked again. MUTATION THAT KILLS THIS: read the TTL
           from the constant instead of `emptyEvidenceTtlMs()` — the day-long
           default then still serves the emptiness, and the count stays 2. */
        await at("2026-09-09T14:00:00.000Z").gather({ claim: P5_PURPOSE, requiresEvidence: true }, ctx);
        expect(retriever.calls).toHaveLength(4);
      } finally {
        if (previous === undefined) delete process.env.EVIDENCE_EMPTY_TTL_MS;
        else process.env.EVIDENCE_EMPTY_TTL_MS = previous;
      }
    }));

  it("falls back to the 24-hour default for an EVIDENCE_EMPTY_TTL_MS that is not a non-negative number", () => {
    const previous = process.env.EVIDENCE_EMPTY_TTL_MS;
    try {
      for (const bad of ["", "  ", "soon", "-5", "Infinity"]) {
        process.env.EVIDENCE_EMPTY_TTL_MS = bad;
        expect(emptyEvidenceTtlMs()).toBe(EMPTY_EVIDENCE_TTL_MS);
      }
      process.env.EVIDENCE_EMPTY_TTL_MS = "0";
      expect(emptyEvidenceTtlMs()).toBe(0);
      delete process.env.EVIDENCE_EMPTY_TTL_MS;
      expect(emptyEvidenceTtlMs()).toBe(24 * 60 * 60 * 1000);
    } finally {
      if (previous === undefined) delete process.env.EVIDENCE_EMPTY_TTL_MS;
      else process.env.EVIDENCE_EMPTY_TTL_MS = previous;
    }
  });
});

describe("F-69 — a beat that sourced to tape is not sent to the web", () => {
  it("hands the transcript window in as the document and issues no retrieval call", async () => {
    /* WHAT ATTEMPT 4B DID. Every tape beat's hand-off page went through the same
       retrieval as a Carry page — a web query, often an empty result, and then
       F-60's second query on top — for a page whose evidence is the stretch of
       tape it introduces and whose transcript this pipeline is already holding.

       MUTATION THAT KILLS THIS: delete the `pack.docs.some(d => d.kind ===
       "tape")` early return from `gather`. The retriever is called and
       `calls` is 1. Ran it — red. */
    const retriever = new FakeRetriever([{ title: "A magazine", text: "Something about griddles." }]);
    const pack = await gatherer(retriever).gather({ claim: "the bakestone came first", tape, requiresEvidence: true }, ctx);

    expect(retriever.calls).toHaveLength(0);
    expect(pack.docs.map((d) => d.kind)).toEqual(["tape"]);
    /* And the page has a document to quote, so `writeNarration`'s no-evidence
       guard does not degrade it. */
    expect(findHoldingDoc("the iron griddle only arrives once cast iron is cheap", pack.docs)).toBe(pack.docs[0]);
  });

  it("still retrieves for a tape beat whose transcript body is not on this machine", async () => {
    /* The skip is conditioned on HOLDING the window, not on the beat being
       tape: with no cue body there is no document, and a page with nothing to
       quote is the case F-60 exists for. */
    const retriever = new FakeRetriever([{ title: "A magazine", text: "Something about griddles." }]);
    const pack = await gatherer(retriever, null).gather({ claim: "the bakestone came first", tape, requiresEvidence: true }, ctx);

    expect(retriever.calls).toHaveLength(1);
    expect(pack.docs.map((d) => d.kind)).toEqual(["print"]);
    expect(pack.tape?.showTitle).toBe("Bread From Home");
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
