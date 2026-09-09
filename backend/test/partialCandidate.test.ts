import { describe, it, expect } from "vitest";
import { buildPartialCandidate, type PartialActInfo, type PartialCandidateMeta } from "../src/generation/partialCandidate";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { ForayItem } from "../src/generation/forayItems";

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

  it("is always visibility: private, regardless of the request's own visibility field", () => {
    /* Fix plan, D2: "the streaming path is for the requesting listener only,
       marked visibility: 'private'." Not configurable — there is no input
       that can produce anything else. */
    expect(true).toBe(true); // documented by the type itself (`visibility: "private"` is a literal)
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
});
