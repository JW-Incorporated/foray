import { describe, it, expect } from "vitest";
import { toForayItem, toForayItems, assertNoInternalFieldsLeaked, slugifySlotTitle, estimateScriptSeconds, ForayItemSchema } from "../src/generation/forayItems";
import type { StitchedItem, StitchedNarrationItem, StitchedTapeItem, StitchedJingleItem } from "../src/types/stitching";

describe("forayItems — internal-only fields never leak into the mapped output", () => {
  it("maps a tape item without beatIndex/itemId/startSec/endSec", () => {
    const item: StitchedTapeItem = {
      kind: "tape",
      beatIndex: 7,
      slotTitle: "Fire and the origins of cooking",
      segmentId: "origin-stories-cooking-human#147",
      itemId: "origin-stories-cooking-human",
      startSec: 100,
      endSec: 130
    };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({ type: "segment", segment_id: "origin-stories-cooking-human#147", slot: "fire-and-the-origins-of-cooking" });
    expect(mapped).not.toHaveProperty("beatIndex");
    expect(mapped).not.toHaveProperty("itemId");
    expect(mapped).not.toHaveProperty("startSec");
    expect(mapped).not.toHaveProperty("endSec");
  });

  it("maps a narration item without sources/verified/pronunciationHints/beatIndex/narrationKind", () => {
    const item: StitchedNarrationItem = {
      kind: "narration",
      narrationKind: "beat",
      beatIndex: 3,
      slotTitle: "Fire and the origins of cooking",
      mode: "Patch",
      script: "This is a real narration script long enough to pass the mode's character band easily.",
      id: "narration-act-1-3-beat"
    };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({
      type: "narration",
      id: "narration-act-1-3-beat",
      script: item.script,
      mode: "patch",
      slot: "fire-and-the-origins-of-cooking"
    });
    expect(mapped).not.toHaveProperty("sources");
    expect(mapped).not.toHaveProperty("verified");
    expect(mapped).not.toHaveProperty("pronunciationHints");
    expect(mapped).not.toHaveProperty("beatIndex");
    expect(mapped).not.toHaveProperty("narrationKind");
  });

  it("maps a jingle item to exactly {type, id?}", () => {
    const item: StitchedJingleItem = { kind: "jingle", reason: "cadence", id: "jingle-cadence-act-1-4" };
    const mapped = toForayItem(item);
    expect(mapped).toEqual({ type: "jingle", id: "jingle-cadence-act-1-4" });
    expect(mapped).not.toHaveProperty("reason");
  });

  it("assertNoInternalFieldsLeaked passes for a real mapped sequence and throws on a synthetic leak", () => {
    const items: StitchedItem[] = [
      { kind: "tape", beatIndex: 0, slotTitle: "Slot", segmentId: "seg#1", itemId: "ep-1", startSec: 0, endSec: 30 },
      { kind: "jingle", reason: "cut", id: "j1" },
      { kind: "tape", beatIndex: 1, slotTitle: "Slot", segmentId: "seg#2", itemId: "ep-2", startSec: 0, endSec: 30 }
    ];
    const mapped = toForayItems(items);
    expect(() => assertNoInternalFieldsLeaked(mapped)).not.toThrow();

    const leaked = [...mapped, { type: "segment", segment_id: "x", sources: [] } as any];
    expect(() => assertNoInternalFieldsLeaked(leaked)).toThrow(/leaked internal-only field/);
  });

  it("every mapped item parses against ForayItemSchema (matches check-forays.mjs's expected shape)", () => {
    const items: StitchedItem[] = [
      { kind: "tape", beatIndex: 0, slotTitle: "Slot A", segmentId: "seg#1", itemId: "ep-1", startSec: 0, endSec: 30, label: "ORI-1" },
      { kind: "narration", narrationKind: "seam", slotTitle: "Slot A", mode: "Frame", script: "A seam narration script long enough for its band.", id: "seam-1" },
      { kind: "jingle", reason: "cut" }
    ];
    const mapped = toForayItems(items);
    for (const item of mapped) {
      expect(() => ForayItemSchema.parse(item)).not.toThrow();
    }
  });
});

describe("slugifySlotTitle", () => {
  it("produces a stable, lowercase, hyphenated slug", () => {
    expect(slugifySlotTitle("Fire and the origins of cooking")).toBe("fire-and-the-origins-of-cooking");
    expect(slugifySlotTitle("  US regional divergence!! ")).toBe("us-regional-divergence");
  });
});

describe("estimateScriptSeconds", () => {
  it("matches the published 17 chars/sec planning rate", () => {
    expect(estimateScriptSeconds(170)).toBe(10);
    expect(estimateScriptSeconds(17)).toBe(1);
  });
});
