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
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ExternalResearchContext } from "../src/generation/ExternalResearcher";
import type { SourcedAct, SourcedBeat, SourcedSlot } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

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

/** One slot with every page shape `writeSlot` distinguishes: a tape beat
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

describe("evidenceBeatsFor — the same page list writeSlot gathers for", () => {
  it("lists every page in writeSlot's terms: a Frame for the opening tape beat, no page for the same-item continuation, and content flags on the Patch and Carry", () => {
    /* MUTATION THAT KILLS THIS: give every tape beat a page (skip
       `decideConnectiveNarration`). The same-item continuation then appears
       and the list is four long. Or: set `requiresEvidence` from the beat's
       sourcing instead of `pageCarriesContent` — the Frame page is then
       flagged as content and pays for a second query it can never use. */
    const beats = evidenceBeatsFor(MIXED_SLOT);
    expect(beats.map((b) => [b.claim.slice(0, 12), b.requiresEvidence, b.tape?.itemId ?? null])).toEqual([
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

    expect(prefetch.pages).toBe(3);
    expect(prefetch.prefetched).toBe(3);
    expect(prefetch.failed).toBe(0);
    expect(inner.calls).toHaveLength(3);

    const written = await writeNarration(
      [MIXED_ACT],
      { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder(), evidence },
      voice,
      ctx
    );
    expect(written).toHaveLength(1);
    expect(inner.calls).toHaveLength(3);

    const after = evidence.metrics();
    expect(after.narrationGathers).toBe(3);
    expect(after.narrationHits).toBe(3);
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
    expect(prefetch.prefetched).toBe(2);

    const pack = await evidence.gather({ claim: "The as-built connection carried sixty percent of the code load.", requiresEvidence: true }, ctx);
    expect(pack.docs).toEqual([DOC]);
    expect(inner.calls).toHaveLength(4);
    const after = evidence.metrics();
    expect(after.narrationGathers).toBe(1);
    expect(after.narrationHits).toBe(0);
    expect(after.hitRate).toBe(0);
  });

  it("skips the slots a resumed run will not narrate again, and counts them rather than fetching for them", async () => {
    const inner = new CountingGatherer();
    const evidence = new PrefetchingEvidenceGatherer(inner);
    const acts: SourcedAct[] = [
      { title: "Act 1", slots: [MIXED_SLOT] },
      { title: "Act 2", slots: [{ title: "Later", beats: [narrationBeat("A later claim about the inquiry's findings.")] }] }
    ];
    const metrics = await evidence.prefetch(acts, ctx, { skipSlot: (actIndex) => actIndex === 0 });
    expect(metrics.skipped).toBe(3);
    expect(metrics.prefetched).toBe(1);
    expect(metrics.pages).toBe(4);
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
