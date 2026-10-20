import { describe, it, expect } from "vitest";
import {
  DEFAULT_EVIDENCE_PREFETCH_CONCURRENCY,
  PrefetchingEvidenceGatherer,
  evidenceBeatsFor,
  evidenceMemoKey,
  evidencePrefetchConcurrency
} from "../src/generation/evidencePrefetch";
import { writeNarration } from "../src/generation/writeNarration";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { DefaultEvidenceGatherer, type EvidenceBeat, type EvidenceDoc, type EvidenceGatherer, type EvidencePack, type TapeEvidenceMetrics } from "../src/generation/gatherEvidence";
import { NullExternalResearcher } from "../src/generation/NullExternalResearcher";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { TranscriptCue, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { ExternalResearchContext } from "../src/generation/ExternalResearcher";
import type { SourcedAct, SourcedBeat, SourcedSlot } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { BudgetExceededError } from "../src/cost/budgetGuard";
import { FlagValueError, evidencePrefetchMode } from "../src/generation/generationFlags";

/**
 * G-35 / M6: the evidence for every page of every act is gathered in one
 * bounded fan-out after `source`, and `writeNarration` then finds it all
 * in hand. Each test names the mutation that kills it.
 */

const ctx: ExternalResearchContext = { userId: "founder-1" };
const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };

const DOC: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  retrievedAt: "2026-09-09T00:00:00.000Z",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

function tapeBeat(claim: string, itemId: string): SourcedBeat {
  return {
    sourcing: "tape",
    claim,
    exploration: false,
    tape: {
      segmentId: `${itemId}#100`,
      itemId,
      startSec: 100,
      endSec: 130,
      startAnchor: "so the first thing to understand is",
      endAnchor: "and that changed everything after that",
      tier: 1,
      confidence: "high"
    }
  };
}

function narrationBeat(claim: string, mode: "Patch" | "Carry" = "Patch"): SourcedBeat {
  return { sourcing: "narration", claim, exploration: false, narration: { mode, reason: "test" } };
}

/** One slot with every page shape the narration stage distinguishes: a tape beat
 * that opens the slot (a Frame page, connective), a same-item tape beat
 * after it (no page at all), and a Patch and a Carry (content pages). */
const MIXED_SLOT: SourcedSlot = {
  title: "The walkway",
  beats: [
    tapeBeat("The engineer explains the doubled load on the fourth-floor hanger.", "item-1"),
    tapeBeat("The engineer keeps going on the same episode.", "item-1"),
    narrationBeat("The as-built connection carried sixty percent of the code load.", "Patch"),
    narrationBeat("The connection was never checked for adequacy at any stage.", "Carry")
  ]
};

const MIXED_ACT: SourcedAct = { title: "Act", slots: [MIXED_SLOT] };

/** The wrapped gatherer: hands every beat the same document, counts what
 * reaches it, and can be latched so a test can see how many are in flight. */
class CountingGatherer implements EvidenceGatherer {
  calls: EvidenceBeat[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private release: Array<() => void> = [];
  constructor(private readonly options: { latched?: boolean; failFor?: (beat: EvidenceBeat, nthCall: number) => boolean } = {}) {}

  async gather(beat: EvidenceBeat): Promise<EvidencePack> {
    this.calls.push(beat);
    if (this.options.failFor?.(beat, this.calls.length)) throw new Error("retrieval backend down");
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.latched) await new Promise<void>((resolve) => this.release.push(resolve));
      return { purpose: beat.claim, beatKind: beat.kind ?? "account", docs: [DOC] };
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Releases ONE latched gather. */
  releaseOne(): void {
    this.release.shift()?.();
  }
  releaseAll(): void {
    while (this.release.length) this.releaseOne();
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("evidenceBeatsFor — the same page list the narration stage gathers for", () => {
  it("lists every page in the act's terms: a window for every tape beat — the same-item continuation included (Q-02) — and content flags on the Patch and Carry", () => {
    /* MUTATION THAT KILLS THIS: skip the same-item continuation again
       (`if (!mode) continue` without the `?? "Intro"` default). The list is
       three long and the act path's gather for that clip misses the memo.
       Or: set `requiresEvidence` from the beat's sourcing instead of
       `pageCarriesContent` — a connective page is then flagged as content
       and pays for a second query it can never use. */
    const beats = evidenceBeatsFor(MIXED_SLOT);
    expect(beats.map((b) => [b.claim.slice(0, 12), b.requiresEvidence, b.tape?.itemId ?? null])).toEqual([
      ["The engineer", false, "item-1"],
      ["The engineer", false, "item-1"],
      ["The as-built", true, null],
      ["The connecti", true, null]
    ]);
    expect(beats.every((b) => b.kind === "account")).toBe(true);
  });

  it("keys two beats apart on anything that changes their pack — kind, content flag, tape pointer — and together on whitespace", () => {
    const base: EvidenceBeat = { claim: "A claim  about the walkway.", requiresEvidence: true };
    expect(evidenceMemoKey(base)).toBe(evidenceMemoKey({ claim: "a claim about the walkway.", requiresEvidence: true }));
    expect(evidenceMemoKey(base)).not.toBe(evidenceMemoKey({ ...base, requiresEvidence: false }));
    expect(evidenceMemoKey(base)).not.toBe(evidenceMemoKey({ ...base, kind: "argument" }));
    const onTape = tapeBeat("x", "item-9");
    expect(evidenceMemoKey(base)).not.toBe(evidenceMemoKey({ ...base, tape: onTape.sourcing === "tape" ? onTape.tape : undefined }));
  });
});

describe("PrefetchingEvidenceGatherer — the fan-out, and what narration finds afterwards", () => {
  it("populates the memo so writeNarration makes ZERO gathers against the wrapped gatherer, and reports a 100 % hit rate", async () => {
    /* MUTATION THAT KILLS THIS: have `gather` bypass the memo and call the
       wrapped gatherer directly. The count rises to 6 during narration and
       the hit rate is 0. */
    const inner = new CountingGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const prefetch = await evidence.prefetch([MIXED_ACT], ctx, { concurrency: 3 });

    expect(prefetch.pages).toBe(4);
    expect(prefetch.prefetched).toBe(4);
    expect(prefetch.failed).toBe(0);
    expect(inner.calls).toHaveLength(4);

    const written = await writeNarration(
      [MIXED_ACT],
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence },
      voice,
      ctx
    );
    expect(written).toHaveLength(1);
    expect(inner.calls).toHaveLength(4);

    const after = evidence.metrics();
    expect(after.narrationGathers).toBe(4);
    expect(after.narrationHits).toBe(4);
    expect(after.hitRate).toBe(1);
    expect(after.narrationRetrievalMs).toBeGreaterThanOrEqual(0);
    expect(after.prefetchMs).toBeGreaterThanOrEqual(0);
  });

  it("honours the concurrency cap — with seven pages and a cap of two, exactly two are in flight until one is released", async () => {
    /* MUTATION THAT KILLS THIS: `Promise.all(queue.map(...))` instead of the
       worker pool. All seven are in flight after the first tick. */
    const inner = new CountingGatherer({ latched: true });
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const act: SourcedAct = {
      title: "Act",
      slots: [{ title: "Slot", beats: Array.from({ length: 7 }, (_, i) => narrationBeat(`Claim number ${i + 1} about the walkway collapse.`)) }]
    };
    const pending = evidence.prefetch([act], ctx, { concurrency: 2 });
    await settle();
    expect(inner.inFlight).toBe(2);
    expect(inner.calls).toHaveLength(2);

    inner.releaseOne();
    await settle();
    expect(inner.inFlight).toBe(2);
    expect(inner.calls).toHaveLength(3);

    /* Drain: each release lets a worker pick up the next page and latch on
       it again, so releasing continues until nothing is in flight. */
    while (inner.inFlight > 0) {
      inner.releaseAll();
      await settle();
    }
    const metrics = await pending;
    expect(inner.maxInFlight).toBe(2);
    expect(metrics.prefetched).toBe(7);
    expect(metrics.concurrency).toBe(2);
  });

  it("reads EVIDENCE_PREFETCH_CONCURRENCY, and falls back to 6 for anything that is not a whole number of at least 1", () => {
    const previous = process.env.EVIDENCE_PREFETCH_CONCURRENCY;
    try {
      process.env.EVIDENCE_PREFETCH_CONCURRENCY = "3";
      expect(evidencePrefetchConcurrency()).toBe(3);
      for (const bad of ["", "0", "-2", "2.5", "many"]) {
        process.env.EVIDENCE_PREFETCH_CONCURRENCY = bad;
        expect(evidencePrefetchConcurrency()).toBe(DEFAULT_EVIDENCE_PREFETCH_CONCURRENCY);
      }
      delete process.env.EVIDENCE_PREFETCH_CONCURRENCY;
      expect(evidencePrefetchConcurrency()).toBe(6);
    } finally {
      if (previous === undefined) delete process.env.EVIDENCE_PREFETCH_CONCURRENCY;
      else process.env.EVIDENCE_PREFETCH_CONCURRENCY = previous;
    }
  });

  it("does not memoise a gather that threw during the fan-out — it is counted failed and narration asks again", async () => {
    /* MUTATION THAT KILLS THIS: drop the `.catch` that deletes the memo
       entry in `lookup`. The rejected promise is then served to narration,
       which throws instead of retrieving. */
    let failedOnce = false;
    const inner = new CountingGatherer({
      failFor: (beat) => {
        if (failedOnce || !beat.claim.startsWith("The as-built")) return false;
        failedOnce = true;
        return true;
      }
    });
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const prefetch = await evidence.prefetch([MIXED_ACT], ctx, { concurrency: 2 });
    expect(prefetch.failed).toBe(1);
    expect(prefetch.prefetched).toBe(3);

    const pack = await evidence.gather({ claim: "The as-built connection carried sixty percent of the code load.", requiresEvidence: true }, ctx);
    expect(pack.docs).toEqual([DOC]);
    expect(inner.calls).toHaveLength(5);
    const after = evidence.metrics();
    expect(after.narrationGathers).toBe(1);
    expect(after.narrationHits).toBe(0);
    expect(after.hitRate).toBe(0);
  });

  it("gen-5: does not memoise a pack whose retrieval FAILED (resolved, not thrown) — counted failed, and narration asks again", async () => {
    /* MUTATION THAT KILLS THIS: keep memoising every resolved pack. The
       first gather's empty, failed pack is then served to narration for the
       whole run, and `failed` reads 0. */
    let failedOnce = false;
    const inner = new CountingGatherer();
    const realGather = inner.gather.bind(inner);
    inner.gather = async (beat: EvidenceBeat): Promise<EvidencePack> => {
      const pack = await realGather(beat);
      if (!failedOnce && beat.claim.startsWith("The as-built")) {
        failedOnce = true;
        return { ...pack, docs: [], retrievalFailed: true };
      }
      return pack;
    };
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const prefetch = await evidence.prefetch([MIXED_ACT], ctx, { concurrency: 2 });
    expect(prefetch.failed).toBe(1);
    expect(prefetch.prefetched).toBe(3);

    const pack = await evidence.gather({ claim: "The as-built connection carried sixty percent of the code load.", requiresEvidence: true }, ctx);
    expect(pack.docs).toEqual([DOC]);
    expect(pack.retrievalFailed).toBeUndefined();
    expect(inner.calls).toHaveLength(5);
  });

  it("gen-5: a budget refusal during the fan-out stops the run instead of being counted as a failed page", async () => {
    const inner = new CountingGatherer();
    inner.gather = async (): Promise<EvidencePack> => {
      throw new BudgetExceededError(9.9, 0.2, 10);
    };
    const evidence = new PrefetchingEvidenceGatherer(inner);
    await expect(evidence.prefetch([MIXED_ACT], ctx, { concurrency: 2 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("skips the slots a resumed run will not narrate again, and counts them rather than fetching for them", async () => {
    const inner = new CountingGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const acts: SourcedAct[] = [
      { title: "Act 1", slots: [MIXED_SLOT] },
      { title: "Act 2", slots: [{ title: "Later", beats: [narrationBeat("A later claim about the inquiry's findings.")] }] }
    ];
    const metrics = await evidence.prefetch(acts, ctx, { skipSlot: (actIndex) => actIndex === 0 });
    expect(metrics.skipped).toBe(4);
    expect(metrics.prefetched).toBe(1);
    expect(metrics.pages).toBe(5);
    expect(inner.calls.map((b) => b.claim)).toEqual(["A later claim about the inquiry's findings."]);
  });

  it("shares one gather between identical pages, and answers a narration-time miss from the wrapped gatherer rather than from nothing", async () => {
    const inner = new CountingGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const twice: SourcedAct = {
      title: "Act",
      slots: [
        { title: "One", beats: [narrationBeat("The same claim, said twice.")] },
        { title: "Two", beats: [narrationBeat("The same claim, said twice.")] }
      ]
    };
    await evidence.prefetch([twice], ctx);
    expect(inner.calls).toHaveLength(1);

    const miss = await evidence.gather({ claim: "A claim the prefetch never saw.", requiresEvidence: true }, ctx);
    expect(miss.docs).toEqual([DOC]);
    expect(inner.calls).toHaveLength(2);
    expect(evidence.metrics().hitRate).toBe(0);
    expect(evidence.summaryLine()).toMatch(/prefetched 1\/1 pages .* narration hit the prefetch 0\/1 \(0%\)/);
  });
});

/* GV-76 (QK-27): the wrapped gatherer's tape counts reach `metrics()`, the
   row runPipeline reports as `veracity.retrieval`. */
describe("GV-76: tapeDocsBuilt / tapeDocsCut pass through metrics()", () => {
  class TapeCountingGatherer extends CountingGatherer {
    built = 0;
    cut = 0;
    override async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      if (beat.tape) {
        this.built += 1;
        if (beat.tape.endSec - beat.tape.startSec > 20) this.cut += 1;
      }
      return super.gather(beat);
    }
    tapeEvidenceMetrics(): TapeEvidenceMetrics {
      return { tapeDocsBuilt: this.built, tapeDocsCut: this.cut };
    }
  }

  /* MUTATION THAT KILLS THIS: drop the `...this.inner.tapeEvidenceMetrics()`
     spread from metrics(). Ran: red (both counts undefined). */
  it("carries the wrapped gatherer's counts, read when metrics() is asked", async () => {
    const inner = new TapeCountingGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const m = await evidence.prefetch([MIXED_ACT], ctx);
    expect(m.tapeDocsBuilt).toBe(2);
    expect(m.tapeDocsCut).toBe(2);
    expect(evidence.metrics()).toMatchObject({ tapeDocsBuilt: 2, tapeDocsCut: 2 });
  });

  /* MUTATION THAT KILLS THIS: report zeros when the wrapped gatherer keeps
     no counts. Ran: red (the keys appear). */
  it("leaves the counts out when the wrapped gatherer keeps none", async () => {
    const evidence = new PrefetchingEvidenceGatherer(new CountingGatherer());
    await evidence.prefetch([MIXED_ACT], ctx);
    const m = evidence.metrics();
    expect("tapeDocsBuilt" in m).toBe(false);
    expect("tapeDocsCut" in m).toBe(false);
  });

  /* The real gatherer end to end: its own counts, unchanged by the wrapper.
     MUTATION THAT KILLS THIS: never increment tapeDocsBuilt in
     DefaultEvidenceGatherer. Ran: red (0 built). */
  it("with DefaultEvidenceGatherer, the row holds the documents it built and none cut for short clips", async () => {
    const item = "walkway--hearing-day-one";
    const catalogue: CatalogueData = {
      items: [{ id: item, show: "Walkway", title: "The walkway collapse hearing", topics: [], hook: "" }],
      itemTags: {},
      concepts: {},
      shows: [{ show_id: "walkway", title: "Walkway", taxonomy_node_ids: [] }]
    };
    const digest: TranscriptDigestEntry = { show_id: "walkway", show_title: "Walkway", guid: "w-1", title: "The walkway collapse hearing", cues: 1 };
    const cues: TranscriptCue[] = [{ text: "So the first thing to understand is the rod. And that changed everything after that.", start_sec: 100, end_sec: 130 }];
    const act: SourcedAct = {
      title: "Act",
      slots: [{ title: "Slot", beats: [tapeBeat("The engineer explains the hanger.", item), narrationBeat("The connection was never checked.", "Carry")] }]
    };
    const inner = new DefaultEvidenceGatherer({
      researcher: new NullExternalResearcher(),
      cueProvider: { getCues: () => cues },
      catalogue,
      transcriptArchive: [digest],
      cacheDir: null
    });
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const m = await evidence.prefetch([act], ctx);
    expect(m.tapeDocsBuilt).toBeGreaterThan(0);
    expect(m.tapeDocsCut).toBe(0);
    expect({ tapeDocsBuilt: m.tapeDocsBuilt, tapeDocsCut: m.tapeDocsCut }).toEqual(inner.tapeEvidenceMetrics());
  });
});

/* GV-98 (W3-17, R1-05): FORAY_EVIDENCE_PREFETCH=first-act. The timed stage
   awaits act 1's pages only (`prefetch` with `acts`), the later acts' pages
   are gathered behind it (`startBackground`), and a narration-time gather
   shares whatever is in flight. Every gatherer here is a scripted fake. */
describe("GV-98: act 1's packs on the timed path, the rest behind it", () => {
  /* The same page closes both acts (same claim, same neighbours, so the same
     memo key): one gather for both. */
  const SHARED_SLOT: SourcedSlot = { title: "The verdict", beats: [narrationBeat("Both acts end on the same finding about the walkway.")] };
  const ACT_1: SourcedAct = { title: "Act 1", slots: [MIXED_SLOT, SHARED_SLOT] };
  const ACT_2: SourcedAct = {
    title: "Act 2",
    slots: [
      {
        title: "The inquiry",
        beats: [
          narrationBeat("The inquiry found the hanger rods had been redesigned in the shop."),
          narrationBeat("The redesign doubled the load on the fourth-floor connection.", "Carry")
        ]
      },
      SHARED_SLOT
    ]
  };
  const ACT_2_CLAIMS = new Set(ACT_2.slots[0]!.beats.map((b) => b.claim));

  /** Act 1's pages answer after 5 ms; act 2's wait on a latch (the scripted
   * "slower act-2 gathers"), and each gather's end is logged. */
  function scriptedGatherer() {
    const calls: string[] = [];
    const log: string[] = [];
    let open!: () => void;
    const latch = new Promise<void>((resolve) => (open = resolve));
    const gatherer: EvidenceGatherer = {
      async gather(beat: EvidenceBeat): Promise<EvidencePack> {
        calls.push(beat.claim);
        if (ACT_2_CLAIMS.has(beat.claim)) await latch;
        else await new Promise((resolve) => setTimeout(resolve, 5));
        log.push(`landed:${beat.claim.slice(0, 16)}`);
        return { purpose: beat.claim, beatKind: beat.kind ?? "account", docs: [DOC] };
      }
    };
    return { gatherer, calls, log, release: () => open() };
  }

  /* MUTATION THAT KILLS THIS: ignore `options.acts` in buildQueue. The timed
     prefetch then queues act 2's latched pages and never resolves while the
     latch is held: the race below resolves to "act-2 waited". */
  it("the timed prefetch resolves before the slower act-2 gathers finish, and act 2's pages land behind it", async () => {
    const { gatherer, calls, log, release } = scriptedGatherer();
    const evidence = new PrefetchingEvidenceGatherer(gatherer);
    const timed = evidence.prefetch([ACT_1, ACT_2], ctx, { acts: (i) => i === 0 });
    const winner = await Promise.race([timed.then(() => "act-1 only"), new Promise((resolve) => setTimeout(() => resolve("act-2 waited"), 1000))]);
    expect(winner).toBe("act-1 only");
    log.push("evidence-stage-done");
    expect(calls).toHaveLength(5);

    evidence.startBackground([ACT_1, ACT_2], ctx, { acts: (i) => i > 0 });
    await settle();
    /* Act 2's two new pages are in flight, behind the stage. */
    expect(calls).toHaveLength(7);
    release();
    await evidence.settleBackground();
    expect(log.indexOf("evidence-stage-done")).toBeLessThan(log.findIndex((l) => l.startsWith("landed:The inquiry")));
  });

  /* MUTATION THAT KILLS THIS: give each phase its own `seen` set rather than
     the instance's `queued` (the shared closing page is then queued and
     counted by both phases: pages 8); or have `gather` skip the memo (the
     narration-time gather of an in-flight act-2 page calls the wrapped
     gatherer again: 8 calls). */
  it("gathers every page exactly once across both phases and narration, and reports timedPages, backgroundPages and backgroundMs", async () => {
    const { gatherer, calls, release } = scriptedGatherer();
    const evidence = new PrefetchingEvidenceGatherer(gatherer);
    await evidence.prefetch([ACT_1, ACT_2], ctx, { acts: (i) => i === 0 });
    evidence.startBackground([ACT_1, ACT_2], ctx, { acts: (i) => i > 0 });
    /* Narration asks for an act-2 page while its background gather is still
       latched: it shares the in-flight gather. */
    const asked = evidence.gather({ claim: "The inquiry found the hanger rods had been redesigned in the shop.", requiresEvidence: true }, ctx);
    await settle();
    release();
    expect((await asked).docs).toEqual([DOC]);
    await evidence.settleBackground();

    expect(calls).toHaveLength(7);
    expect(new Set(calls).size).toBe(7);
    const m = evidence.metrics();
    expect(m).toMatchObject({ pages: 7, prefetched: 7, failed: 0, skipped: 0, timedPages: 5, backgroundPages: 2, narrationGathers: 1, narrationHits: 1 });
    expect(m.backgroundMs).toBeGreaterThanOrEqual(0);
    expect(evidence.summaryLine()).toMatch(/prefetched 7\/7 pages .*, 2 of them behind act 1 in \d+ ms\)/);
  });

  /* MUTATION THAT KILLS THIS: spread the phase keys unconditionally in
     metrics() (zeros without a background): timedPages appears. */
  it("the default whole-Foray fan-out carries no phase keys, so its report row is unchanged", async () => {
    const evidence = new PrefetchingEvidenceGatherer(new CountingGatherer());
    await evidence.prefetch([ACT_1, ACT_2], ctx);
    await evidence.settleBackground();
    const m = evidence.metrics();
    expect(Object.keys(m)).toEqual(["prefetchMs", "concurrency", "pages", "prefetched", "failed", "skipped", "narrationGathers", "narrationHits", "hitRate", "narrationRetrievalMs"]);
    expect(m.pages).toBe(7);
    expect(evidence.summaryLine()).not.toMatch(/behind act 1/);
  });

  /* MUTATION THAT KILLS THIS: drop the `deferredBudgetError` throw at the top
     of gather() (the next gather then answers from the wrapped gatherer and
     the run goes on past the budget); or let a background budget stop keep
     taking pages (`stop` ignoring deferredBudgetError: 3 calls). */
  it("a background budget stop surfaces from the next gather, and no further background page is taken", async () => {
    const inner = new CountingGatherer();
    let budgetSpent = false;
    inner.gather = async (beat: EvidenceBeat): Promise<EvidencePack> => {
      inner.calls.push(beat);
      if (!budgetSpent) {
        budgetSpent = true;
        throw new BudgetExceededError(9.9, 0.2, 10);
      }
      return { purpose: beat.claim, beatKind: "account", docs: [DOC] };
    };
    const evidence = new PrefetchingEvidenceGatherer(inner);
    await evidence.prefetch([ACT_1, ACT_2], ctx, { acts: () => false });
    evidence.startBackground([ACT_1, ACT_2], ctx, { acts: (i) => i > 0, concurrency: 1 });
    await evidence.settleBackground();
    expect(inner.calls).toHaveLength(1);
    await expect(evidence.gather({ claim: "Any later page at all.", requiresEvidence: true }, ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(inner.calls).toHaveLength(1);
  });

  /* MUTATION THAT KILLS THIS: rethrow a non-budget error from the worker
     instead of counting it: `failed` reads 0, and with the chain's `.catch`
     also dropped the rejection is unhandled. */
  it("a failing background gather is counted, never an unhandled rejection, and settleBackground resolves", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const evidence = new PrefetchingEvidenceGatherer(new CountingGatherer({ failFor: () => true }));
      evidence.startBackground([ACT_1, ACT_2], ctx, { acts: (i) => i > 0 });
      await evidence.settleBackground();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(evidence.metrics()).toMatchObject({ backgroundPages: 3, failed: 3, prefetched: 0 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  /* MUTATION THAT KILLS THIS: ignore `stop` in settleBackground. The latched
     worker's successors are then taken after the release: 3 calls. */
  it("settleBackground({ stop: true }) lets the page in flight land and starts no more", async () => {
    const inner = new CountingGatherer({ latched: true });
    const evidence = new PrefetchingEvidenceGatherer(inner);
    evidence.startBackground([ACT_1, ACT_2], ctx, { acts: (i) => i > 0, concurrency: 1 });
    await settle();
    expect(inner.calls).toHaveLength(1);
    const settled = evidence.settleBackground({ stop: true });
    inner.releaseAll();
    await settled;
    expect(inner.calls).toHaveLength(1);
    expect(evidence.metrics()).toMatchObject({ backgroundPages: 3, prefetched: 1 });
  });

  it("refuses a second background fan-out", () => {
    const evidence = new PrefetchingEvidenceGatherer(new CountingGatherer());
    evidence.startBackground([ACT_2], ctx);
    expect(() => evidence.startBackground([ACT_2], ctx)).toThrow(/already been started/);
  });
});

/* GV-98: the flag reader (generationFlags.ts, decision 5). */
describe("GV-98: FORAY_EVIDENCE_PREFETCH", () => {
  /* MUTATION THAT KILLS THIS: default to 'first-act', or read the flag with
     a parser that falls back instead of throwing. */
  it("defaults to all, reads first-act, and a malformed value throws naming only the variable", () => {
    expect(evidencePrefetchMode({})).toBe("all");
    expect(evidencePrefetchMode({ FORAY_EVIDENCE_PREFETCH: "all" })).toBe("all");
    expect(evidencePrefetchMode({ FORAY_EVIDENCE_PREFETCH: " first-act " })).toBe("first-act");
    for (const bad of ["", "first", "FIRST-ACT", "s3cr3t-value"]) {
      let caught: unknown;
      try {
        evidencePrefetchMode({ FORAY_EVIDENCE_PREFETCH: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FlagValueError);
      expect((caught as Error).message).toContain("FORAY_EVIDENCE_PREFETCH");
    }
    expect(() => evidencePrefetchMode({ FORAY_EVIDENCE_PREFETCH: "s3cr3t-value" })).toThrow(/^(?!.*s3cr3t).*$/s);
  });
});
