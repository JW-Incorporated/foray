import { describe, it, expect } from "vitest";
import { DeliveryTimeline, deliveryReportOf, type ItemReadyEvent } from "../src/generation/deliveryTimeline";
import type { ForayItem } from "../src/generation/forayItems";

/**
 * GV-33 (docs/roadmap/generation-v2.md, decision 14): the delivery timeline and
 * the lead of generation over the playhead, on synthetic events with known
 * ready times and durations, so every expected number below is worked by hand.
 */

const narration = (id: string): ForayItem => ({ type: "narration", id, script: "x", mode: "Frame" }) as unknown as ForayItem;
const segment = (id: string): ForayItem => ({ type: "segment", segment_id: id }) as unknown as ForayItem;

/** One event; `index` doubles as the item id's suffix. */
function ev(index: number, actIndex: number, readyAtMs: number, playStartSec: number, durationSec: number, extra: Partial<ItemReadyEvent> = {}): ItemReadyEvent {
  const item = extra.item ?? narration(`i${index}`);
  return {
    forayId: "f",
    index,
    itemId: `i${index}`,
    actIndex,
    check: index === 0 ? "prelude" : "verified",
    servable: true,
    readyAtMs,
    playStartSec,
    durationSec,
    item,
    ...extra
  };
}

/** The worked fixture. Prelude (20 s) and act 0 (60 s + 40 s) ready at 10 s;
 * act 1 (50 s + 30 s) ready at 70 s. Playback starts at 10 s. */
function twoActs(act1ReadyMs = 70_000): DeliveryTimeline {
  const t = new DeliveryTimeline();
  t.record(ev(0, -1, 10_000, 0, 20));
  t.record(ev(1, 0, 10_000, 20, 60));
  t.record(ev(2, 0, 10_000, 80, 40));
  t.record(ev(3, 1, act1ReadyMs, 120, 50));
  t.record(ev(4, 1, act1ReadyMs, 170, 30));
  return t;
}

describe("DeliveryTimeline (GV-33)", () => {
  it("first / first-servable / all-ready times read off the events", () => {
    const t = twoActs();
    expect(t.firstItemReadyMs).toBe(10_000);
    expect(t.firstServableReadyMs).toBe(10_000);
    expect(t.allItemsReadyMs).toBe(70_000);
    expect(t.pausedAtIndex).toBeUndefined();
    expect(t.count).toBe(5);
  });

  it("act 2 ready early: the lead is the hand-computed positive value, at 1x and at 1.5x", () => {
    /* MUTATION THAT KILLS THIS: drop `/ rate` from the arrival (arrival =
       first audio + playStartSec). The 1.5x minimum then reads 60 instead of
       20. Ran it — red. Second: count items ready at first audio as samples.
       minLeadSec then reads 0 (the prelude). Ran it — red. */
    const t = twoActs();
    // Item 3 plays at 10 + 120 = 130 s and was ready at 70 s: 60 s ahead. Item 4: 10 + 170 - 70 = 110 s.
    expect(t.leadReport({ rate: 1 })).toEqual({ minLeadSec: 60, itemsBelow30s: 0, lateItems: [], samples: 2 });
    // At 1.5x item 3 plays at 10 + 80 = 90 s: 20 s ahead (below 30); item 4 at 10 + 113.333 - 70 = 53.333 s.
    expect(t.leadReport({ rate: 1.5 })).toEqual({ minLeadSec: 20, itemsBelow30s: 1, lateItems: [], samples: 2 });
  });

  it("act 2 ready after act 1's audio would end: a negative lead, and the late item is named", () => {
    const t = twoActs(150_000);
    // Item 3 plays at 130 s, ready at 150 s: 20 s late. Item 4: 180 - 150 = 30 s (not below 30).
    const r = t.leadReport({ rate: 1 });
    expect(r.minLeadSec).toBe(-20);
    expect(r.itemsBelow30s).toBe(1);
    expect(r.lateItems).toEqual([{ index: 3, itemId: "i3", leadSec: -20 }]);
  });

  it("an explicit first-audio time moves every arrival", () => {
    const t = twoActs();
    // Playback held until 40 s: item 3 at 40 + 120 - 70 = 90 s, item 4 at 140 s.
    expect(t.leadReport({ firstAudioAtMs: 40_000 }).minLeadSec).toBe(90);
  });

  it("an unservable middle act pauses playback there: it and everything after it are not lead samples", () => {
    /* MUTATION THAT KILLS THIS: filter only `e.servable` (no pause cut-off)
       in servablePrefix. Item 7, behind the pause, then becomes a sample
       with a 20 s lead. Ran it — red. */
    const t = twoActs();
    t.record(ev(5, 2, 80_000, 200, 10, { servable: false, check: "unverified" }));
    t.record(ev(6, 2, 80_000, 210, 10, { servable: false, check: "unverified" }));
    // Act 3 servable, ready at 90 s; behind the pause it would have read 10 + 100 - 90 = 20 s.
    t.record(ev(7, 3, 90_000, 100, 10));
    const r = t.leadReport({ rate: 1 });
    expect(r.pausedAtIndex).toBe(5);
    expect(r.samples).toBe(2);
    expect(r.minLeadSec).toBe(60);
    expect(t.pausedAtIndex).toBe(5);
  });

  it("no servable item: no first audio, no lead, paused at the first item", () => {
    const t = new DeliveryTimeline();
    t.record(ev(0, 0, 5_000, 0, 10, { servable: false, check: "unverified" }));
    t.record(ev(1, 0, 5_000, 10, 10, { servable: false, check: "unverified" }));
    expect(t.firstServableReadyMs).toBeNull();
    expect(t.leadReport()).toEqual({ minLeadSec: null, itemsBelow30s: 0, lateItems: [], samples: 0, pausedAtIndex: 0 });
  });

  it("refuses a non-positive rate", () => {
    expect(() => twoActs().leadReport({ rate: 0 })).toThrow(/rate must be positive/);
  });

  it("counts segment items runtimeSecFor could not time, and reports act granularity unless every event was item-level", () => {
    const t = twoActs();
    t.record(ev(5, 2, 80_000, 200, 0, { item: segment("unknown-seg") }));
    t.record(ev(6, 2, 80_000, 200, 12, { item: segment("known-seg") }));
    expect(t.unknownDurations).toBe(1);
    expect(t.granularity).toBe("act");
    const solo = new DeliveryTimeline();
    solo.record(ev(0, -1, 1_000, 0, 5, { granularity: "item" }));
    expect(solo.granularity).toBe("item");
  });
});

describe("deliveryReportOf (GV-33)", () => {
  it("a fresh attempt carries the times, the lead at 1x and 1.5x, and pausedAtIndex null when nothing paused", () => {
    /* MUTATION THAT KILLS THIS: read minLeadSecAt1_5x from the rate-1 report.
       It then reads 60, not 20. Ran it — red. */
    expect(deliveryReportOf(twoActs(), false)).toEqual({
      granularity: "act",
      items: 5,
      firstItemReadyMs: 10_000,
      firstServableMs: 10_000,
      allItemsReadyMs: 70_000,
      minLeadSec: 60,
      minLeadSecAt1_5x: 20,
      itemsBelow30s: 0,
      pausedAtIndex: null,
      unknownDurations: 0
    });
  });

  it("a resumed attempt says so and carries no lead and no first-item times", () => {
    const r = deliveryReportOf(twoActs(), true)!;
    expect(r).toEqual({ granularity: "act", items: 5, resumed: true });
    expect(r).not.toHaveProperty("minLeadSec");
    expect(r).not.toHaveProperty("firstItemReadyMs");
  });

  it("an attempt that emitted nothing reports nothing (absent, never zero)", () => {
    expect(deliveryReportOf(new DeliveryTimeline(), false)).toBeUndefined();
  });
});
