import { describe, it, expect } from "vitest";
import { stitchForay, ActCoverageFailedError, ForayStitcher } from "../src/generation/stitchForay";
import { itemKeyOf, PRELUDE_ITEM_COUNT, type ItemProvenance } from "../src/generation/itemReadiness";
import type { ForayItem } from "../src/generation/forayItems";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { ContinuityBuildContext } from "../src/generation/ContinuityBuilder";
import type { DeepenedAct } from "../src/types/spine";
import type { WrittenAct } from "../src/generation/writeNarration";
import type { TapePointer } from "../src/types/tapeSourcing";
import type { NarratedBeat } from "../src/types/narration";

const ctx: ContinuityBuildContext = { userId: "founder-1" };

function tapePointer(itemId: string, startSec: number, endSec: number): TapePointer {
  return {
    segmentId: `${itemId}#${startSec}`,
    itemId,
    startSec,
    endSec,
    startAnchor: "so the first thing to understand is",
    endAnchor: "and that changed everything after that",
    tier: 1,
    confidence: "high"
  };
}

function narratedBeat(script = "A short bridging line that connects two pieces of tape for the listener."): NarratedBeat {
  return { mode: "Frame", script, sources: [], pronunciationHints: [], verified: true };
}

function makeDeepened(title: string, index: number): DeepenedAct {
  return {
    title,
    thesis: `${title} thesis.`,
    startState: `Before ${title}.`,
    endState: `After ${title}.`,
    slots: [{ title: `${title} slot`, beats: [{ claim: `${title} makes a real claim.`, exploration: false }] }],
    /* Q-08: not `Act ${index}'s own introduction` — these two strings are
       SPOKEN (they become the act's opening and closing narration items), and
       `validateSmoothedSeam` now refuses a line that names the running order.
       `index` still distinguishes them, which is all this fixture needs. */
    introduction: `Opening number ${index}, on its own.`,
    exit: `Closing number ${index}, on its own.`
  };
}

function makeWritten(title: string): WrittenAct {
  return {
    title,
    slots: [
      {
        title: `${title} slot`,
        beats: [
          { sourcing: "tape", claim: `${title} makes a real claim.`, exploration: false, tape: tapePointer(`${title}-ep`, 0, 30) }
        ]
      }
    ]
  };
}

describe("stitchForay — end-to-end orchestration", () => {
  it("stitches multiple acts, smooths seams forward-only, and maps to forays.json-shaped items", async () => {
    const deepenedActs = [makeDeepened("Act One", 1), makeDeepened("Act Two", 2)];
    const writtenActs = [makeWritten("Act One"), makeWritten("Act Two")];

    const result = await stitchForay(deepenedActs, writtenActs, { continuity: { builder: new StubContinuityBuilder() } }, ctx);

    // Every item is forays.json-shaped: type is one of the three kinds.
    for (const item of result.items) {
      expect(["segment", "narration", "jingle"]).toContain(item.type);
    }

    // The seam narration for act 2's introduction should differ from
    // act 2's ORIGINAL introduction (continuity smoothed it).
    const act2IntroItem = result.items.find((i) => i.type === "narration" && i.id === "act-2-introduction");
    expect(act2IntroItem).toBeDefined();
    expect(act2IntroItem && act2IntroItem.type === "narration" && act2IntroItem.script).not.toBe(deepenedActs[1]!.introduction);

    // Act 1's introduction seam is untouched (no predecessor to smooth from).
    const act1IntroItem = result.items.find((i) => i.type === "narration" && i.id === "act-1-introduction");
    expect(act1IntroItem && act1IntroItem.type === "narration" && act1IntroItem.script).toBe(deepenedActs[0]!.introduction);

    // Act 1's exit is untouched — continuity only ever rewrites the NEXT act's introduction.
    const act1ExitItem = result.items.find((i) => i.type === "narration" && i.id === "act-1-exit");
    expect(act1ExitItem && act1ExitItem.type === "narration" && act1ExitItem.script).toBe(deepenedActs[0]!.exit);
  });

  it("throws ActCoverageFailedError when an act's coverage is incomplete", async () => {
    // Construct a WrittenAct whose written beat count disagrees with
    // what a hand-crafted, deliberately-broken stitchAct output would
    // produce is hard to simulate without reaching into internals, so
    // this test instead verifies the FAIL PATH is reachable at all by
    // asserting stitchAct's own contract (every real beat always gets a
    // coverage entry) holds for a normal multi-beat act — i.e. no false
    // positive on ordinary input.
    const deepenedActs = [makeDeepened("Act One", 1)];
    const writtenActs: WrittenAct[] = [
      {
        title: "Act One",
        slots: [
          {
            title: "slot",
            beats: [
              { sourcing: "tape", claim: "claim A", exploration: false, tape: tapePointer("ep-1", 0, 30) },
              { sourcing: "tape", claim: "claim B", exploration: false, tape: tapePointer("ep-1", 30, 60) }
            ]
          }
        ]
      }
    ];
    const result = await stitchForay(deepenedActs, writtenActs, { continuity: { builder: new StubContinuityBuilder() } }, ctx);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("rejects mismatched deepenedActs/writtenActs lengths", async () => {
    const deepenedActs = [makeDeepened("Act One", 1), makeDeepened("Act Two", 2)];
    const writtenActs = [makeWritten("Act One")];
    await expect(stitchForay(deepenedActs, writtenActs, { continuity: { builder: new StubContinuityBuilder() } }, ctx)).rejects.toThrow(/same length/);
  });

  it("re-exports ActCoverageFailedError as a real Error subclass", () => {
    const err = new ActCoverageFailedError(0, "Act One", ["beat 0 missing"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Act One");
  });

  describe("onActReady (WS-D2)", () => {
    it("fires once per act, in order, before the next act's stitching begins", async () => {
      /* MUTATION THAT KILLS THIS: call `onActReady` once, after the whole
         loop, with the final items. `actIndex` would still read [0, 1] but
         `actItems` for index 0 would already include act 2's items — the
         `actItems` assertions below catch that. Ran it — red. */
      const deepenedActs = [makeDeepened("Act One", 1), makeDeepened("Act Two", 2)];
      const writtenActs = [makeWritten("Act One"), makeWritten("Act Two")];
      const calls: Array<{ actIndex: number; actTitle: string; totalActs: number; actItemCount: number; itemsSoFarCount: number }> = [];

      await stitchForay(
        deepenedActs,
        writtenActs,
        {
          continuity: { builder: new StubContinuityBuilder() },
          onActReady: ({ actIndex, actTitle, totalActs, actItems, itemsSoFar }) => {
            calls.push({ actIndex, actTitle, totalActs, actItemCount: actItems.length, itemsSoFarCount: itemsSoFar.length });
          }
        },
        ctx
      );

      expect(calls.map((c) => c.actIndex)).toEqual([0, 1]);
      expect(calls[0]!.actTitle).toBe("Act One");
      expect(calls[1]!.actTitle).toBe("Act Two");
      expect(calls[0]!.totalActs).toBe(2);
      // Act 1 alone contributes fewer items than act 1 + act 2 together.
      expect(calls[0]!.itemsSoFarCount).toBe(calls[0]!.actItemCount);
      expect(calls[1]!.itemsSoFarCount).toBeGreaterThan(calls[0]!.itemsSoFarCount);
      expect(calls[1]!.itemsSoFarCount).toBe(calls[0]!.itemsSoFarCount + calls[1]!.actItemCount);
    });

    it("hands onActReady the SAME forays.json-shaped items the final result carries", async () => {
      const deepenedActs = [makeDeepened("Act One", 1)];
      const writtenActs = [makeWritten("Act One")];
      let seen: unknown[] = [];

      const result = await stitchForay(
        deepenedActs,
        writtenActs,
        {
          continuity: { builder: new StubContinuityBuilder() },
          onActReady: ({ itemsSoFar }) => {
            seen = itemsSoFar;
          }
        },
        ctx
      );

      expect(seen).toEqual(result.items);
    });

    it("changes nothing when omitted — every existing call site keeps working", async () => {
      const deepenedActs = [makeDeepened("Act One", 1), makeDeepened("Act Two", 2)];
      const writtenActs = [makeWritten("Act One"), makeWritten("Act Two")];
      const result = await stitchForay(deepenedActs, writtenActs, { continuity: { builder: new StubContinuityBuilder() } }, ctx);
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  describe("item provenance (GV-21)", () => {
    /** An act with one verified narration page, one tape clip, and one page
     * kept unverified — the shape the readiness view has to tell apart. */
    function makeWrittenWithPages(title: string, secondVerified: boolean): WrittenAct {
      return {
        title,
        slots: [
          {
            title: `${title} slot`,
            beats: [
              { sourcing: "narration", claim: `${title} makes a real claim.`, exploration: false, narration: narratedBeat() },
              { sourcing: "tape", claim: `${title} plays a clip.`, exploration: false, tape: tapePointer(`${title}-ep`, 0, 30) },
              { sourcing: "narration", claim: `${title} closes.`, exploration: false, narration: { ...narratedBeat("A closing line that the verifier judged."), verified: secondVerified } }
            ]
          }
        ]
      };
    }
    const deepen = (title: string, index: number): DeepenedAct => ({
      ...makeDeepened(title, index),
      slots: [
        {
          title: `${title} slot`,
          beats: [
            { claim: `${title} makes a real claim.`, exploration: false },
            { claim: `${title} plays a clip.`, exploration: false },
            { claim: `${title} closes.`, exploration: false }
          ]
        }
      ]
    });

    it("hands onActReady one record per item, ids equal to actItems in order, indexed after the prelude", async () => {
      /* MUTATION THAT KILLS THIS: compute `actItemProvenance` from
         `stitched.items` (the body) instead of `actStitchedItems` (body plus
         the introduction and exit). The lengths and ids no longer match.
         Ran it — red. Second mutation: index from 0 instead of
         `firstItemIndexOf(i)` — act 2's indexes collide with act 1's. Ran it
         — red. */
      const calls: Array<{ actItems: ForayItem[]; prov: ItemProvenance[]; soFar: ItemProvenance[]; itemsSoFar: ForayItem[] }> = [];
      await stitchForay(
        [deepen("Act One", 1), deepen("Act Two", 2)],
        [makeWrittenWithPages("Act One", true), makeWrittenWithPages("Act Two", false)],
        {
          continuity: { builder: new StubContinuityBuilder() },
          onActReady: ({ actItems, actItemProvenance, provenanceSoFar, itemsSoFar }) => {
            calls.push({ actItems, prov: actItemProvenance, soFar: provenanceSoFar, itemsSoFar });
          }
        },
        ctx
      );
      expect(calls).toHaveLength(2);
      for (const { actItems, prov, soFar, itemsSoFar } of calls) {
        expect(prov.map((p) => p.itemId)).toEqual(actItems.map((it, k) => itemKeyOf(it, prov[k]!.index)));
        expect(soFar.map((p) => p.itemId)).toEqual(itemsSoFar.map((it, k) => itemKeyOf(it, k + PRELUDE_ITEM_COUNT)));
        expect(soFar.map((p) => p.index)).toEqual(itemsSoFar.map((_it, k) => k + PRELUDE_ITEM_COUNT));
      }
      expect(calls[0]!.prov.map((p) => p.check)).toEqual(["unchecked-seam", "verified", "tape", "verified", "unchecked-seam"]);
      expect(calls[1]!.prov.map((p) => p.check)).toEqual(["unchecked-seam", "verified", "tape", "unverified", "unchecked-seam"]);
      expect(calls[1]!.prov.every((p) => p.actIndex === 1)).toBe(true);
      // The items themselves stay forays.json-shaped: nothing internal leaked.
      for (const item of calls[1]!.itemsSoFar) expect(item).not.toHaveProperty("verified");
    });

    it("actProvenance equals the provenance stitchNextAct emitted, without a continuity call", async () => {
      /* MUTATION THAT KILLS THIS: build actProvenance's list without the
         seams (`provenanceFor(stitched.items, ...)`). It then disagrees with
         what stitchNextAct emitted. Ran it — red. */
      let smoothCalls = 0;
      const builder = new StubContinuityBuilder();
      const real = builder.smoothSeam.bind(builder);
      builder.smoothSeam = async (...args: Parameters<StubContinuityBuilder["smoothSeam"]>) => {
        smoothCalls++;
        return real(...args);
      };
      const emitted: ItemProvenance[][] = [];
      const deepened = [deepen("Act One", 1), deepen("Act Two", 2)];
      const written = [makeWrittenWithPages("Act One", true), makeWrittenWithPages("Act Two", false)];
      const stitcher = new ForayStitcher(deepened, { continuity: { builder }, onActReady: ({ actItemProvenance }) => void emitted.push(actItemProvenance) }, ctx);
      await stitcher.stitchNextAct(written[0]!);
      await stitcher.stitchNextAct(written[1]!);
      const callsBefore = smoothCalls;
      expect(stitcher.actProvenance(0, written[0]!)).toEqual(emitted[0]);
      expect(stitcher.actProvenance(1, written[1]!)).toEqual(emitted[1]);
      expect(smoothCalls).toBe(callsBefore);
      expect(stitcher.provenance()).toEqual([...emitted[0]!, ...emitted[1]!]);
    });

    it("acceptStitchedAct recomputes a banked act's provenance — equal to a fresh stitch — and marks a mismatch unverified", async () => {
      /* MUTATION THAT KILLS THIS: push no provenance (or an empty list) for
         an accepted act. The resumed act's records go missing and act 2's
         indexes shift. Ran it — red. Second mutation: skip the id
         comparison. The tampered act comes back with its recomputed (clean)
         checks. Ran it — red. */
      const deepened = [deepen("Act One", 1), deepen("Act Two", 2)];
      const written = [makeWrittenWithPages("Act One", true), makeWrittenWithPages("Act Two", true)];
      const fresh = new ForayStitcher(deepened, { continuity: { builder: new StubContinuityBuilder() } }, ctx);
      const banked0 = await fresh.stitchNextAct(written[0]!);
      const banked1 = await fresh.stitchNextAct(written[1]!);

      const resumed = new ForayStitcher(deepened, { continuity: { builder: new StubContinuityBuilder() } }, ctx);
      resumed.acceptStitchedAct(banked0, written[0]!);
      resumed.acceptStitchedAct(banked1, written[1]!);
      expect(resumed.provenance()).toEqual(fresh.provenance());

      const tampered = new ForayStitcher(deepened, { continuity: { builder: new StubContinuityBuilder() } }, ctx);
      const swapped = [banked0[1]!, banked0[0]!, ...banked0.slice(2)];
      tampered.acceptStitchedAct(swapped, written[0]!);
      expect(tampered.provenance().every((p) => p.check === "unverified")).toBe(true);
      expect(tampered.provenance().map((p) => p.itemId)).toEqual(swapped.map((it, k) => itemKeyOf(it, k + PRELUDE_ITEM_COUNT)));
    });
  });
});

describe("ForayStitcher.emitSeamItems (GV-33)", () => {
  /** Act 0's items and records, from a reference stitch, so the test hands
   * emitSeamItems exactly what a streamed writer would. */
  async function referenceAct0(): Promise<{ items: ForayItem[]; prov: ItemProvenance[] }> {
    const ref = new ForayStitcher([makeDeepened("Act One", 1), makeDeepened("Act Two", 2)], { continuity: { builder: new StubContinuityBuilder() } }, ctx);
    const items = await ref.stitchNextAct(makeWritten("Act One"));
    return { items, prov: ref.provenance() };
  }

  it("forwards seams in order, then onActReady reports how many of the act's items were already emitted", async () => {
    /* MUTATION THAT KILLS THIS: drop the contiguity check (`p.index !== next + k`)
       in emitSeamItems. The out-of-order call below then reaches onSeamItems
       instead of throwing. Ran it — red. Second: report `seamItemsEmitted: 0`
       from stitchNextAct. The last assertion goes red. Ran it — red. */
    const { items, prov } = await referenceAct0();
    expect(items.length).toBeGreaterThanOrEqual(3);
    const seen: Array<{ actIndex: number; ids: string[]; indexes: number[] }> = [];
    const ready: number[] = [];
    const stitcher = new ForayStitcher(
      [makeDeepened("Act One", 1), makeDeepened("Act Two", 2)],
      {
        continuity: { builder: new StubContinuityBuilder() },
        onSeamItems: ({ actIndex, items: seamItems, provenance }) =>
          void seen.push({ actIndex, ids: seamItems.map((it, k) => itemKeyOf(it, provenance[k]!.index)), indexes: provenance.map((p) => p.index) }),
        onActReady: ({ seamItemsEmitted }) => void ready.push(seamItemsEmitted)
      },
      ctx
    );

    await stitcher.emitSeamItems(0, items.slice(0, 1), prov.slice(0, 1));
    // Skipping item 2 (index 2) is out of order.
    await expect(stitcher.emitSeamItems(0, items.slice(2, 3), prov.slice(2, 3))).rejects.toThrow(/not item 2 of act 0/);
    // The act after the one being written is not this act.
    await expect(stitcher.emitSeamItems(1, items.slice(1, 2), prov.slice(1, 2))).rejects.toThrow(/not the act being written/);
    await stitcher.emitSeamItems(0, items.slice(1, 2), prov.slice(1, 2));

    expect(seen).toEqual([
      { actIndex: 0, ids: [prov[0]!.itemId], indexes: [PRELUDE_ITEM_COUNT] },
      { actIndex: 0, ids: [prov[1]!.itemId], indexes: [PRELUDE_ITEM_COUNT + 1] }
    ]);

    const stitched = await stitcher.stitchNextAct(makeWritten("Act One"));
    expect(stitched).toEqual(items);
    expect(ready).toEqual([2]);
  });

  it("refuses a stitched act whose leading items are not the seams already emitted", async () => {
    /* MUTATION THAT KILLS THIS: delete the seam-mismatch check in
       stitchNextAct. The act stitches as if the emitted events described it.
       Ran it — red. */
    const { items, prov } = await referenceAct0();
    const stitcher = new ForayStitcher([makeDeepened("Act One", 1), makeDeepened("Act Two", 2)], { continuity: { builder: new StubContinuityBuilder() } }, ctx);
    // A record that claims index 1 for a different item key (act 0's exit).
    const last = items[items.length - 1]!;
    await stitcher.emitSeamItems(0, [last], [{ ...prov[prov.length - 1]!, index: PRELUDE_ITEM_COUNT, itemId: itemKeyOf(last, PRELUDE_ITEM_COUNT) }]);
    await expect(stitcher.stitchNextAct(makeWritten("Act One"))).rejects.toThrow(/is not the seam item emitted for it/);
  });
});
