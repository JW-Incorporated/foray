import { describe, it, expect } from "vitest";
import { buildPartialCandidate, servableThroughAct, servableView, type PartialActInfo, type PartialCandidateMeta } from "../src/generation/partialCandidate";
import { preludeProvenance, provenanceFor } from "../src/generation/itemReadiness";
import { assertNoInternalFieldsLeaked, toForayItems } from "../src/generation/forayItems";
import { computeActVeracity } from "../src/generation/veracityMetrics";
import { HANDOFF_MODE, HANDOFF_SCRIPT, type WrittenAct } from "../src/generation/writeNarration";
import type { StitchedItem } from "../src/types/stitching";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { ForayItem } from "../src/generation/forayItems";
import type { MintedSegmentSource } from "../src/generation/audioSourceLookup";
import { PARTIAL_RULES, PROJECTED_RULES, type PartialProjectionPlan } from "../src/generation/partialProjection";
import type { SourcedAct } from "../src/types/tapeSourcing";

/**
 * `finalizeForay` itself is exercised by `finalizeForay.test.ts` (and, on a
 * checkout that can load the real `.mjs` checkers, `runPipeline.test.ts`'s
 * own "against the REAL §4.9 validator" case). This suite pins ONLY what
 * `buildPartialCandidate` adds on top: the `acts[]` ready/pending shape,
 * `status: "partial" | "complete"`, `visibility: "private"`, and that it
 * calls the injected `finalize` (not the real one) so it costs nothing and
 * needs no real checkout.
 */

function fakeFinalize(seen: FinalizeForayInput[]): (input: FinalizeForayInput, root?: string) => Promise<FinalizeForayResult> {
  return async (input) => {
    seen.push(input);
    return {
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true },
      timings: []
    };
  };
}

const items: ForayItem[] = [{ type: "narration", id: "disclosure", script: "s", mode: "marker", slot: "s1" }];
const meta: PartialCandidateMeta = { id: "f-1", title: "T", topic: "food/grilling-bbq", summary: "s", authorId: "founder-1", builtAt: "2026-09-08T12:00:00.000Z" };

describe("buildPartialCandidate", () => {
  it("marks every act through actIndex 'ready' and every act after it 'pending'", async () => {
    /* MUTATION THAT KILLS THIS: mark every act "ready" regardless of index.
       A listener/player reading `acts[]` to decide what it may append would
       then be told a not-yet-written act is playable. Ran it — red. */
    const info: PartialActInfo = {
      actIndex: 1,
      totalActs: 4,
      allActTitles: ["Act 1", "Act 2", "Act 3", "Act 4"],
      items,
      slots: [{ id: "s1", title: "Slot" }],
      runtimeSec: 42,
      ttlA1Ms: 1234
    };
    const candidate = await buildPartialCandidate(info, meta, fakeFinalize([]));
    expect(candidate.acts).toEqual([
      { index: 0, title: "Act 1", status: "ready" },
      { index: 1, title: "Act 2", status: "ready" },
      { index: 2, title: "Act 3", status: "pending" },
      { index: 3, title: "Act 4", status: "pending" }
    ]);
  });

  it("is 'partial' until the last act, then 'complete'", async () => {
    const baseInfo: Omit<PartialActInfo, "actIndex"> = {
      totalActs: 2,
      allActTitles: ["Act 1", "Act 2"],
      items,
      slots: [{ id: "s1", title: "Slot" }],
      runtimeSec: 42,
      ttlA1Ms: 1234
    };
    const first = await buildPartialCandidate({ ...baseInfo, actIndex: 0 }, meta, fakeFinalize([]));
    expect(first.status).toBe("partial");
    const last = await buildPartialCandidate({ ...baseInfo, actIndex: 1 }, meta, fakeFinalize([]));
    expect(last.status).toBe("complete");
  });

  it("is always visibility: private, regardless of the request's own visibility field", async () => {
    /* Fix plan, D2: "the streaming path is for the requesting listener only,
       marked visibility: 'private'." Not configurable — there is no input
       that can produce anything else.

       tests-7 (round-3 audit): this used to be `expect(true).toBe(true)`,
       leaning on the literal type — which proves nothing about the VALUE a
       future `...meta` spread would put there. So build from a request that
       says "public" on both inputs and read the result.
       MUTATION: spread `...meta` (or `...info`) after `visibility: "private"`
       in buildPartialCandidate -> "public" leaks through and this is red. */
    const publicMeta = { ...meta, visibility: "public" };
    const publicInfo = {
      actIndex: 0,
      totalActs: 1,
      allActTitles: ["Act 1"],
      items,
      slots: [{ id: "s1", title: "Slot" }],
      runtimeSec: 10,
      ttlA1Ms: 5,
      visibility: "public"
    };
    const candidate = await buildPartialCandidate(publicInfo, publicMeta, fakeFinalize([]));
    expect(candidate.visibility).toBe("private");
  });

  it("carries authorId and ttlA1Ms straight through, and stamps a fresh updatedAt", async () => {
    const before = Date.now();
    const candidate = await buildPartialCandidate(
      { actIndex: 0, totalActs: 1, allActTitles: ["Act 1"], items, slots: [{ id: "s1", title: "Slot" }], runtimeSec: 10, ttlA1Ms: 999 },
      meta,
      fakeFinalize([])
    );
    expect(candidate.authorId).toBe("founder-1");
    expect(candidate.ttlA1Ms).toBe(999);
    expect(Date.parse(candidate.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it("calls finalize with exactly the items/slots handed to it — the same gates, scoped down", async () => {
    /* "validated with the same check-forays gates, but for Act 1's items
       only" (fix plan, D2). Pinning that `buildPartialCandidate` does not
       silently widen the input back to the whole Foray. */
    const seen: FinalizeForayInput[] = [];
    const slots = [{ id: "s1", title: "Slot" }];
    await buildPartialCandidate({ actIndex: 0, totalActs: 3, allActTitles: ["A", "B", "C"], items, slots, runtimeSec: 7, ttlA1Ms: null }, meta, fakeFinalize(seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.items).toBe(items);
    expect(seen[0]!.slots).toBe(slots);
    expect(seen[0]!.id).toBe(meta.id);
  });

  it("hands finalize this run's minted tier-2 segments and source rows (F-71)", async () => {
    /* THE FINDING: run 2 attempt 4b's partial candidate came back with five
       `unknown segment_id "practical-ai--federated-learning-in-production-part-2#1962"
       — not in data/segments.json` errors and then "no resolvable segment
       items", while the FINAL candidate — the same items, the same checker —
       resolved all five and failed on M3/M4 instead. A tier-2 segment is cut
       from a transcript during the run and is not in the pool on disk, so a
       finalize call that is not handed it cannot resolve it. The partial
       candidate has to fail and pass on the same rules as the final record.

       MUTATION THAT KILLS THIS: drop `segments`/`segmentSources` from the
       `finalizeInput` literal in `partialCandidate.ts` — i.e. the pre-F-71
       code. Both assertions below go undefined. Ran it — red. */
    const seen: FinalizeForayInput[] = [];
    const segments = [
      {
        id: "practical-ai--fl-part-2#1962",
        itemId: "practical-ai--fl-part-2",
        startSec: 1962,
        endSec: 2020,
        referenceDurationSec: 3600,
        startAnchor: "the thing about federated learning in production",
        endAnchor: "and that is why nobody ships it that way",
        confidence: "medium" as const,
        why: "Federated learning rarely ships to production the way the papers describe.",
        transcriptSource: "publisher" as const
      }
    ];
    const segmentSources = [{ id: "practical-ai--fl-part-2", audio_url: "https://cdn.example/fl2.mp3" } as unknown as MintedSegmentSource];
    await buildPartialCandidate(
      { actIndex: 0, totalActs: 2, allActTitles: ["A", "B"], items, slots: [{ id: "s1", title: "Slot" }], runtimeSec: 7, ttlA1Ms: null },
      { ...meta, segments, segmentSources },
      fakeFinalize(seen)
    );
    expect(seen[0]!.segments).toBe(segments);
    expect(seen[0]!.segmentSources).toBe(segmentSources);
  });

  it("surfaces the finalize result's validation on the candidate", async () => {
    const failing = async (): Promise<FinalizeForayResult> => ({
      validation: { ok: false, checkForaysErrors: ["boom"], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      timings: []
    });
    const candidate = await buildPartialCandidate(
      { actIndex: 0, totalActs: 1, allActTitles: ["Act 1"], items, slots: [{ id: "s1", title: "Slot" }], runtimeSec: 10, ttlA1Ms: 0 },
      meta,
      failing
    );
    expect(candidate.validation.ok).toBe(false);
    expect(candidate.validation.checkForaysErrors).toEqual(["boom"]);
  });

  describe("delivery (GV-21)", () => {
    /* A two-act partial built the way runPipeline builds one: stitched items
       mapped with toForayItems, provenance read off the same stitched items,
       the prelude prepended at index 0. Act 1 (index 1) holds the HANDOFF
       page, so it is unservable. */
    const prelude: ForayItem = { type: "narration", id: "prelude", script: "s", mode: "marker", slot: "s1" };
    const seam = (id: string): StitchedItem => ({ kind: "narration", narrationKind: "seam", mode: "Frame", script: "A seam line.", id });
    const act0Stitched: StitchedItem[] = [
      seam("act-1-introduction"),
      { kind: "narration", narrationKind: "beat", beatIndex: 0, mode: "Carry", script: "A verified page.", id: "act-1-b0", sources: [], verified: true },
      { kind: "tape", beatIndex: 1, slotTitle: "Slot", segmentId: "ep#0", itemId: "ep", startSec: 0, endSec: 30 },
      seam("act-1-exit")
    ];
    const act1Stitched: StitchedItem[] = [
      seam("act-2-introduction"),
      { kind: "narration", narrationKind: "beat", beatIndex: 0, mode: "Hinge", script: HANDOFF_SCRIPT, id: "act-2-b0", sources: [], verified: false },
      seam("act-2-exit")
    ];
    const writtenAct0: WrittenAct = { title: "A", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "c", exploration: false, narration: { mode: "Carry", script: "A verified page.", sources: [], pronunciationHints: [], verified: true } }] }] };
    const writtenAct1: WrittenAct = {
      title: "B",
      slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "c", exploration: false, narration: { mode: HANDOFF_MODE, script: HANDOFF_SCRIPT, sources: [], pronunciationHints: [], verified: false, unverifiedReason: "no-page" } }] }]
    };

    function twoActInfo(): PartialActInfo {
      const twoActItems = [prelude, ...toForayItems(act0Stitched), ...toForayItems(act1Stitched)];
      return {
        actIndex: 1,
        totalActs: 3,
        allActTitles: ["A", "B", "C"],
        items: twoActItems,
        slots: [{ id: "s1", title: "Slot" }],
        runtimeSec: 60,
        ttlA1Ms: 10,
        itemProvenance: [preludeProvenance(prelude), ...provenanceFor(act0Stitched, 0, 1), ...provenanceFor(act1Stitched, 1, 1 + act0Stitched.length)],
        actVeracity: [computeActVeracity(writtenAct0, 0), computeActVeracity(writtenAct1, 1)]
      };
    }

    it("attaches delivery aligned 1:1 with items, and leaves items and validation untouched", async () => {
      /* MUTATION THAT KILLS THIS: drop the `delivery` spread from
         buildPartialCandidate's return. Ran it — red. */
      const info = twoActInfo();
      const before = JSON.stringify(info.items);
      const candidate = await buildPartialCandidate(info, meta, fakeFinalize([]));
      expect(candidate.items).toBe(info.items);
      expect(JSON.stringify(candidate.items)).toBe(before);
      expect(() => assertNoInternalFieldsLeaked(candidate.items)).not.toThrow();
      expect(candidate.validation.ok).toBe(true);
      expect(candidate.delivery).toBeDefined();
      expect(candidate.delivery!.items.map((d) => d.itemId)).toEqual(["prelude", "act-1-introduction", "act-1-b0", "ep#0", "act-1-exit", "act-2-introduction", "act-2-b0", "act-2-exit"]);
      expect(candidate.delivery!.acts.map((a) => a.servable)).toEqual([true, false]);
      expect(candidate.delivery!.acts[1]!.blockers).toContainEqual({ itemId: "act-2-b0", reason: "unverified" });
      expect(candidate.acts.map((a) => [a.status, a.served])).toEqual([
        ["ready", true],
        ["ready", false],
        ["pending", false]
      ]);
      expect(candidate.acts[1]!.veracity).toEqual({ ok: false, unverifiedPages: 1, handoffPages: 1 });
      expect(candidate.acts[2]!.veracity).toBeUndefined();
    });

    it("pins the units: servableThrough is an item count (prelude + act 0), servableThroughAct is 0, servableView ends in act 0", async () => {
      /* MUTATION THAT KILLS THIS: slice servableView by servableThroughAct
         (an act index) instead of servableThrough (an item count). It returns
         0 items, not 5. Ran it — red. */
      const candidate = await buildPartialCandidate(twoActInfo(), meta, fakeFinalize([]));
      const delivery = candidate.delivery!;
      expect(delivery.servableThrough).toBe(1 + act0Stitched.length);
      expect(servableThroughAct(delivery)).toBe(0);
      const view = servableView(candidate);
      expect(view).toHaveLength(delivery.servableThrough);
      const last = view.at(-1)!;
      expect(last.type === "narration" && last.id).toBe("act-1-exit");
      expect(delivery.items[view.length - 1]!.act).toBe(0);
    });

    it("carries no delivery and no served flag when no provenance is handed in, and servableView then returns everything", async () => {
      const candidate = await buildPartialCandidate(
        { actIndex: 0, totalActs: 1, allActTitles: ["Act 1"], items, slots: [{ id: "s1", title: "Slot" }], runtimeSec: 10, ttlA1Ms: 0 },
        meta,
        fakeFinalize([])
      );
      expect(candidate).not.toHaveProperty("delivery");
      expect(candidate.acts[0]).not.toHaveProperty("served");
      expect(servableView(candidate)).toBe(candidate.items);
    });

    it("serves only the prelude when the provenance does not describe the items, and nothing for a malformed count", async () => {
      /* MUTATION THAT KILLS THIS: skip alignDelivery in buildPartialCandidate.
         The misaligned act 0 stays servable. Ran it — red. */
      const info = twoActInfo();
      const misaligned = { ...info, items: [info.items[0]!, info.items[2]!, info.items[1]!, ...info.items.slice(3)] };
      const candidate = await buildPartialCandidate(misaligned, meta, fakeFinalize([]));
      expect(candidate.delivery!.servableThrough).toBe(1);
      expect(candidate.acts.every((a) => a.served === false)).toBe(true);

      const broken = { ...candidate, delivery: { ...candidate.delivery!, servableThrough: undefined as unknown as number } };
      expect(servableView(broken)).toEqual([]);
    });
  });
});

describe("buildPartialCandidate — GV-46: later acts not sourced yet (basis 'deferred')", () => {
  /* Act 0 of 3 has three segments, two from one episode — 66.7 % of the
     partial's segments, an M4 share failure on the prefix that the whole
     Foray (whose later acts are not even sourced yet) may well dilute. */
  const m4 = 'foray "f-1": M4 FAIL: "ep-a" is 66.7 % of segments and 66.7 % of runtime, over the 25 % cap';
  const d1 = 'foray "f-1": D1 FAIL: 9 segment starts inside a 600 s window (budget 8 for a 30.0-minute Foray)';
  const actItems: ForayItem[] = [
    ...items,
    { type: "segment", segment_id: "ep-a#1", slot: "s1" },
    { type: "segment", segment_id: "ep-a#2", slot: "s1" },
    { type: "segment", segment_id: "ep-b#1", slot: "s1" }
  ];
  const tape = (segmentId: string, itemId: string) => ({
    sourcing: "tape" as const,
    claim: `claim ${segmentId}`,
    exploration: false,
    tape: { segmentId, itemId, startSec: 0, endSec: 120, startAnchor: "start words", endAnchor: "end words", tier: 1 as const, confidence: "high" as const }
  });
  const act = (title: string, ids: Array<[string, string]>): SourcedAct => ({ title, slots: [{ title: `${title} slot`, beats: ids.map(([s, e]) => tape(s, e)) }] });
  const sourced: SourcedAct[] = [
    act("Act 1", [["ep-a#1", "ep-a"], ["ep-a#2", "ep-a"], ["ep-b#1", "ep-b"]]),
    act("Act 2", [["ep-c#1", "ep-c"]]),
    act("Act 3", [["ep-d#1", "ep-d"]])
  ];
  const slots = [{ id: "s1", title: "Act 1 slot" }, { id: "s2", title: "Act 2 slot" }, { id: "s3", title: "Act 3 slot" }];
  const info: PartialActInfo = {
    actIndex: 0,
    totalActs: 3,
    allActTitles: ["Act 1", "Act 2", "Act 3"],
    items: actItems,
    slots: [slots[0]!],
    runtimeSec: 360,
    ttlA1Ms: 1000
  };
  /** The stand-in checker: the M4 line on any record (the projection here is
   * no bigger a denominator than the partial), plus `extra` on the partial. */
  function checker(extra: string[] = []) {
    const seen: FinalizeForayInput[] = [];
    const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
      seen.push(input);
      const checkForaysErrors = [m4, ...(input.items === actItems ? extra : [])];
      return {
        validation: { ok: false, checkForaysErrors, checkForaysWarnings: ["fixture warning"], checkNarrationErrors: [], checkNarrationWarnings: [] },
        forayRecord: undefined,
        timings: []
      };
    };
    return { fn, seen };
  }

  it("a share rule that fails on the prefix of an act-0-of-3 partial with only act 0 sourced is not refused; its line is set aside in supersededOnPartial", async () => {
    /* MUTATION THAT KILLS THIS: route the incomplete plan to
       `partialOnlyScope("partial-only")` (every rule on the partial) — the M4
       line refuses the partial, run 5's false FAIL again. Or delete the
       deferred branch so the plan takes the F-79 projected path — the
       projection is the same prefix, its M4 line is taken, and the partial is
       refused. Ran both — red. */
    const plan: PartialProjectionPlan = { sourcedActs: sourced.slice(0, 1), slots, totalActs: 3 };
    const c = checker();
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan }, c.fn);

    expect(candidate.validation.ok).toBe(true);
    expect(candidate.validation.checkForaysErrors).toEqual([]);
    expect(candidate.ruleScope.basis).toBe("deferred");
    expect(candidate.ruleScope.projected).toEqual([]);
    expect(candidate.ruleScope.deferred).toEqual([...PROJECTED_RULES]);
    expect(candidate.ruleScope.partial).toEqual([...PARTIAL_RULES]);
    expect(candidate.ruleScope.projection?.supersededOnPartial).toEqual([m4]);
    expect(candidate.ruleScope.projection?.unsourcedActs).toBe(2);
    expect(candidate.ruleScope.projection?.acts).toBe(0);
    /* The line is a warning now, not dropped; the partial's own warnings stay. */
    expect(candidate.validation.checkForaysWarnings[0]).toBe("fixture warning");
    expect(candidate.validation.checkForaysWarnings).toContain(`deferred (GV-46): ${m4}`);
    expect(candidate.validation.checkForaysWarnings.some((w) => /^GV-46: M4, D2-end, D4-share deferred to the whole Foray — 2 later act\(s\) not sourced yet/.test(w))).toBe(true);
    /* No projection is finalized — one check-forays pass, the partial's. */
    expect(c.seen).toHaveLength(1);
    expect(candidate.status).toBe("partial");
  });

  it("a monotone rule still refuses a deferred partial", async () => {
    /* MUTATION THAT KILLS THIS: in `deferredVerdict`, set every check-forays
       line aside (or compute `ok` from the narration errors alone) — a D1
       failure, which no later act can clear, would be served. Ran it — red. */
    const plan: PartialProjectionPlan = { sourcedActs: sourced.slice(0, 1), slots, totalActs: 3 };
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan }, checker([d1]).fn);
    expect(candidate.validation.ok).toBe(false);
    expect(candidate.validation.checkForaysErrors).toEqual([d1]);
    expect(candidate.ruleScope.projection?.supersededOnPartial).toEqual([m4]);
  });

  it("a narration failure still refuses a deferred partial", async () => {
    /* MUTATION THAT KILLS THIS: in `deferredVerdict`, compute `ok` from the
       check-forays errors alone (drop `&& partial.checkNarrationErrors.length
       === 0`) — the only check-forays line is the deferred M4 one, set aside,
       so a partial whose narration failed would be served. Ran it — red. */
    const narration = 'foray "f-1": narration item 0: FAIL: fixture narration error';
    const fn = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => ({
      validation: {
        ok: false,
        checkForaysErrors: input.items === actItems ? [m4] : [],
        checkForaysWarnings: [],
        checkNarrationErrors: [narration],
        checkNarrationWarnings: []
      },
      forayRecord: undefined,
      timings: []
    });
    const plan: PartialProjectionPlan = { sourcedActs: sourced.slice(0, 1), slots, totalActs: 3 };
    const candidate = await buildPartialCandidate(info, { ...meta, projection: plan }, fn);
    expect(candidate.ruleScope.basis).toBe("deferred");
    expect(candidate.validation.checkForaysErrors).toEqual([]);
    expect(candidate.validation.checkNarrationErrors).toEqual([narration]);
    expect(candidate.ruleScope.projection?.supersededOnPartial).toEqual([m4]);
    expect(candidate.validation.ok).toBe(false);
  });

  it("a plan that covers every act keeps F-79's projected basis, with or without totalActs", async () => {
    /* MUTATION THAT KILLS THIS: treat any plan carrying `totalActs` as
       incomplete — a fully sourced Foray would stop judging its share rules
       on the projection. Ran it — red (basis 'deferred', one finalize call). */
    for (const plan of [{ sourcedActs: sourced, slots, totalActs: 3 }, { sourcedActs: sourced, slots }] as PartialProjectionPlan[]) {
      const c = checker();
      const candidate = await buildPartialCandidate(info, { ...meta, projection: plan }, c.fn);
      expect(candidate.ruleScope.basis).toBe("projected");
      expect(candidate.ruleScope.deferred).toBeUndefined();
      expect(c.seen).toHaveLength(2);
      /* The stand-in fails M4 on the projection too, so the projected verdict refuses. */
      expect(candidate.validation.ok).toBe(false);
    }
  });
});
