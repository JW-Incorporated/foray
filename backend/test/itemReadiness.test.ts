import { describe, it, expect } from "vitest";
import {
  alignDelivery,
  assessAct,
  deliveryView,
  itemKeyOf,
  preludeProvenance,
  provenanceFor,
  servableThroughAct,
  unverifiedProvenanceFor,
  type ItemProvenance
} from "../src/generation/itemReadiness";
import type { StitchedItem } from "../src/types/stitching";
import type { ForayItem } from "../src/generation/forayItems";
import type { ActVeracity } from "../src/generation/veracityMetrics";
import { HANDOFF_SCRIPT } from "../src/generation/writeNarration";

/**
 * GV-21 (docs/roadmap/generation-v2.md): the pure readiness module — item
 * classification, the per-act verdict, and the servable prefix as an ITEM
 * COUNT (decision 32). Each test names the mutation it kills; every one was
 * run against the source and went red.
 */

const seam = (id: string, verified?: boolean): StitchedItem => ({
  kind: "narration",
  narrationKind: "seam",
  mode: "Frame",
  script: "A line.",
  id,
  ...(verified === undefined ? {} : { verified })
});
const page = (id: string, verified: boolean, script = "A verified page about the subject."): StitchedItem => ({
  kind: "narration",
  narrationKind: "beat",
  beatIndex: 0,
  mode: "Carry",
  script,
  id,
  sources: [],
  verified
});
const tape = (segmentId: string): StitchedItem => ({
  kind: "tape",
  beatIndex: 1,
  slotTitle: "Slot",
  segmentId,
  itemId: segmentId.split("#")[0]!,
  startSec: 0,
  endSec: 30
});
const jingle = (id: string): StitchedItem => ({ kind: "jingle", reason: "cut", id });

const prelude: ForayItem = { type: "narration", id: "prelude", script: "s", mode: "marker", slot: "s1" };

function actOf(actIndex: number, firstIndex: number, items: StitchedItem[]): ItemProvenance[] {
  return provenanceFor(items, actIndex, firstIndex);
}

describe("provenanceFor", () => {
  it("classifies every kind: tape, jingle, verified, unverified, and an unchecked seam", () => {
    /* MUTATION THAT KILLS THIS: read `verified !== false` as verified (so an
       absent flag counts as checked). The introduction comes back "verified"
       instead of "unchecked-seam". Ran it — red. */
    const prov = provenanceFor([seam("act-1-introduction"), tape("ep#0"), jingle("jingle-cut-act-1-2"), page("p-ok", true), page("p-bad", false), seam("act-1-exit")], 0, 1);
    expect(prov.map((p) => [p.itemId, p.kind, p.check])).toEqual([
      ["act-1-introduction", "narration", "unchecked-seam"],
      ["ep#0", "segment", "tape"],
      ["jingle-cut-act-1-2", "jingle", "jingle"],
      ["p-ok", "narration", "verified"],
      ["p-bad", "narration", "unverified"],
      ["act-1-exit", "narration", "unchecked-seam"]
    ]);
    expect(prov.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(prov.every((p) => p.actIndex === 0)).toBe(true);
  });

  it("classifies the prelude explicitly, at index 0 and in no act", () => {
    expect(preludeProvenance(prelude)).toEqual({ itemId: "prelude", index: 0, actIndex: -1, kind: "narration", check: "prelude" });
  });

  it("keys a segment by its segment_id, the same key itemKeyOf reads off the mapped item", () => {
    const [p] = provenanceFor([tape("show-ep#120")], 0, 1);
    expect(p!.itemId).toBe(itemKeyOf({ type: "segment", segment_id: "show-ep#120", slot: "s" }, 1));
  });
});

describe("assessAct", () => {
  it("blocks an act holding the HANDOFF page (verified:false) with reason 'unverified'", () => {
    /* MUTATION THAT KILLS THIS: drop the `unverified` branch of assessAct.
       The hand-off act comes back servable. Ran it — red. */
    const prov = actOf(0, 1, [seam("act-1-introduction"), page("handoff", false, HANDOFF_SCRIPT), seam("act-1-exit")]);
    const verdict = assessAct(prov);
    expect(verdict.servable).toBe(false);
    expect(verdict.blockers).toEqual([{ itemId: "handoff", reason: "unverified" }]);
  });

  it("lets unchecked seams play by default and blocks them only under blockOnUncheckedSeams", () => {
    /* MUTATION THAT KILLS THIS: ignore the policy (always block, or never
       block, unchecked seams). One of the two expectations goes red. Ran
       both — red. */
    const prov = actOf(0, 1, [seam("act-1-introduction"), page("p", true), seam("act-1-exit")]);
    expect(assessAct(prov)).toEqual({ servable: true, blockers: [] });
    const strict = assessAct(prov, { blockOnUncheckedSeams: true });
    expect(strict.servable).toBe(false);
    expect(strict.blockers.map((b) => b.reason)).toEqual(["unchecked-seam", "unchecked-seam"]);
  });

  it("blocks on the act's veracity: a grounded-quote rate below 1, but not an unmeasured (null) one", () => {
    /* MUTATION THAT KILLS THIS: drop the groundedQuoteRate clause from
       assessAct. The 0.5 act comes back servable. Ran it — red. */
    const prov = actOf(0, 1, [seam("act-1-introduction"), page("p", true), seam("act-1-exit")]);
    const veracity = (groundedQuoteRate: number | null): ActVeracity => ({ actIndex: 0, unverifiedPages: [], handoffPages: 0, groundedQuoteRate, ok: groundedQuoteRate === null || groundedQuoteRate >= 1, failures: [] });
    expect(assessAct(prov, undefined, veracity(0.5))).toEqual({ servable: false, blockers: [{ itemId: "act-1", reason: "ungrounded-quote" }] });
    expect(assessAct(prov, undefined, veracity(null)).servable).toBe(true);
    expect(assessAct(prov, undefined, veracity(1)).servable).toBe(true);
  });
});

describe("deliveryView — the prefix rule (decision 32)", () => {
  const act0 = actOf(0, 1, [seam("act-1-introduction"), page("a0-p", true), tape("ep#0"), seam("act-1-exit")]);
  const act1Bad = actOf(1, 1 + act0.length, [seam("act-2-introduction"), page("a1-handoff", false, HANDOFF_SCRIPT), seam("act-2-exit")]);

  it("counts items, prelude included, and stops at the first unservable act", () => {
    /* MUTATION THAT KILLS THIS: count acts instead of items (servableThrough
       = number of servable acts). 1 + act 0's item count is 5; the act count
       is 1. Ran it — red. */
    const view = deliveryView({ prelude: [preludeProvenance(prelude)], acts: [{ index: 0, provenance: act0 }, { index: 1, provenance: act1Bad }] });
    expect(view.servableThrough).toBe(1 + act0.length);
    expect(servableThroughAct(view)).toBe(0);
    expect(view.acts.map((a) => a.servable)).toEqual([true, false]);
    expect(view.items).toHaveLength(1 + act0.length + act1Bad.length);
    expect(view.items.map((i) => i.index)).toEqual(view.items.map((_i, k) => k));
    expect(view.items.filter((i) => i.ready).map((i) => i.itemId)).toEqual(["prelude", ...act0.map((p) => p.itemId)]);
    expect(view.items.every((i) => i.audio === "pending")).toBe(true);
  });

  it("never extends past the first unservable act, even when a later act is servable", () => {
    /* MUTATION THAT KILLS THIS: sum every SERVABLE act's items instead of
       breaking at the first unservable one. Act 2's items are then counted
       behind the hole. Ran it — red. */
    const act0Bad = actOf(0, 1, [seam("act-1-introduction"), page("a0-bad", false), seam("act-1-exit")]);
    const act1Ok = actOf(1, 1 + act0Bad.length, [seam("act-2-introduction"), page("a1-ok", true), seam("act-2-exit")]);
    const view = deliveryView({ prelude: [preludeProvenance(prelude)], acts: [{ index: 0, provenance: act0Bad }, { index: 1, provenance: act1Ok }] });
    expect(view.servableThrough).toBe(1);
    expect(servableThroughAct(view)).toBe(-1);
    expect(view.items.filter((i) => i.ready).map((i) => i.itemId)).toEqual(["prelude"]);
  });

  it("serves the whole list when every act is servable", () => {
    const act1Ok = actOf(1, 1 + act0.length, [seam("act-2-introduction"), page("a1-ok", true), seam("act-2-exit")]);
    const view = deliveryView({ prelude: [preludeProvenance(prelude)], acts: [{ index: 0, provenance: act0 }, { index: 1, provenance: act1Ok }] });
    expect(view.servableThrough).toBe(view.items.length);
    expect(servableThroughAct(view)).toBe(1);
  });
});

describe("alignDelivery and the conservative fallbacks", () => {
  it("leaves an aligned view alone and serves only the prelude when ids disagree", () => {
    /* MUTATION THAT KILLS THIS: return the view unchanged without comparing
       ids. The misaligned act stays servable. Ran it — red. */
    const act0 = actOf(0, 1, [seam("act-1-introduction"), page("p", true), seam("act-1-exit")]);
    const view = deliveryView({ prelude: [preludeProvenance(prelude)], acts: [{ index: 0, provenance: act0 }] });
    const items: ForayItem[] = [prelude, ...act0.map((p): ForayItem => ({ type: "narration", id: p.itemId, script: "s", mode: "frame" }))];
    expect(alignDelivery(view, items)).toBe(view);

    const swapped = [items[0]!, items[2]!, items[1]!, items[3]!];
    const guarded = alignDelivery(view, swapped);
    expect(guarded.servableThrough).toBe(1);
    expect(guarded.acts[0]!.servable).toBe(false);
    expect(guarded.acts[0]!.blockers.at(-1)).toEqual({ itemId: "act-1", reason: "misaligned" });
    expect(guarded.items.map((i) => i.itemId)).toEqual(swapped.map((it, k) => itemKeyOf(it, k)));
  });

  it("unverifiedProvenanceFor marks every item of a banked act unverified", () => {
    const items: ForayItem[] = [
      { type: "narration", id: "act-1-introduction", script: "s", mode: "frame" },
      { type: "segment", segment_id: "ep#0", slot: "s" }
    ];
    const prov = unverifiedProvenanceFor(items, 0, 1);
    expect(prov.map((p) => [p.itemId, p.index, p.check])).toEqual([
      ["act-1-introduction", 1, "unverified"],
      ["ep#0", 2, "unverified"]
    ]);
    expect(assessAct(prov).servable).toBe(false);
  });
});
