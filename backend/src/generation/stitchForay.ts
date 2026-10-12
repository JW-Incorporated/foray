import type { DeepenedAct } from "../types/spine";
import { validateActCoverage, type StitchedItem } from "../types/stitching";
import type { WrittenAct } from "./writeNarration";
import { countActBeats, stitchAct } from "./stitchAct";
import { smoothActIntroduction, type SmoothActsOptions } from "./smoothSeam";
import { toForayItems, assertNoInternalFieldsLeaked, type ForayItem } from "./forayItems";
import type { ContinuityBuildContext } from "./ContinuityBuilder";
import { itemKeyOf, PRELUDE_ITEM_COUNT, provenanceFor, unverifiedProvenanceFor, type ItemProvenance } from "./itemReadiness";

/**
 * §4.8 top-level orchestrator (docs/curation/generation-architecture.md
 * §4.8): the single entry point a §4.9 caller uses to turn §4.4's
 * `DeepenedAct[]` (introductions/exits) plus §4.7's `WrittenAct[]`
 * (written-and-verified pages, one array element per act, same order)
 * into the final ordered `ForayItem[]` ready to become
 * `data/forays.json`'s `items` array (minus the disclosure item, which
 * §4.7's `disclosureNarratedBeat`/`disclosureTemplate` already produce
 * and §4.9 is responsible for prepending — this stage stitches the
 * BODY of the Foray, not that fixed opening beat).
 *
 * THREE STEPS, IN ORDER, MATCHING THIS STAGE'S TASK BRIEF EXACTLY:
 *
 *   (a) WITHIN-ACT stitching, per act, via `stitchAct` — deterministic
 *       (see that module's doc comment for why no LLM/Builder is used
 *       here, mirroring PR #408's precedent).
 *   (b) CROSS-ACT continuity, at every act boundary, via the ONE
 *       `ContinuityBuilder` (§5: "1 continuity agent... the only place
 *       no single act agent has context"), forward-only (§6.2) — see
 *       `smoothSeam.ts`. This step only ever touches `introduction`
 *       strings on `DeepenedAct[]`; act N's boundary is smoothed just
 *       BEFORE within-act stitching writes act N's OWN introduction into
 *       the item sequence (see `ForayStitcher.stitchNextAct` below), so a
 *       smoothed introduction reaches the final assembly rather than the
 *       original. F-66 moved this from a single up-front pass over every
 *       boundary to one boundary at a time; the calls are the same, in
 *       the same order, with the same arguments (see
 *       `smoothActIntroduction`'s own doc comment for why nothing about
 *       a boundary needed the later acts to exist first).
 *   (c) MAPPING every act's stitched items, in act order, into the
 *       `data/forays.json`-shaped `ForayItem[]` (`forayItems.ts`) —
 *       including a `seam` narration item at the START of every act
 *       after the first, carrying that act's (possibly continuity-
 *       smoothed) `introduction`, and at the END of every act,
 *       carrying its own `exit` (never touched by continuity — see
 *       `smoothSeam.ts`'s doc comment on why only `introduction` is
 *       ever replaced).
 *
 * COVERAGE IS CHECKED PER ACT, BEFORE ASSEMBLY (§4.8 rule 4): a single
 * act failing `validateActCoverage` fails the WHOLE `stitchForay` call
 * — a Foray missing coverage for one of its own beats is not a partial
 * success, mirroring `deepenActs.ts`'s "a deepened act is not optional
 * content" reasoning at this later stage.
 */
export class ActCoverageFailedError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly issues: string[]
  ) {
    super(`Act ${actIndex + 1} ("${actTitle}") failed coverage validation: ${issues.join("; ")}`);
    this.name = "ActCoverageFailedError";
  }
}

export interface StitchForayOptions {
  continuity: SmoothActsOptions;
  /**
   * gen-4 (round-3 audit): per act, per slot (by position), the slot id the
   * Foray's `slots` declares (`slotIdsFromSpine`). Every item is stamped with
   * it rather than with a slug of its slot's title, so the items and `slots`
   * cannot disagree (a reworded or a duplicated title). Optional: without it
   * items re-slug the title, as before.
   */
  slotIds?: readonly (readonly string[])[];
  /**
   * WS-D2 (docs/curation/generation-fix-plan-2026-09-09.md, "D2 (streaming
   * publish)"): fired once per act, the instant that act's own items are
   * assembled and its coverage validated (see the loop below) — before the
   * NEXT act's stitching begins. Optional; omitting it changes nothing,
   * matching every other Builder-shaped dependency in this pipeline
   * (`RunPipelineDeps`'s own pattern).
   *
   * `actItems`/`itemsSoFar` are already mapped to the `data/forays.json` item
   * shape (§4.8's own `toForayItems`), so a caller (`runForayPipeline`) can
   * hand them straight to a partial-candidate path without knowing this
   * stage's internal `StitchedItem` representation. `itemsSoFar` does NOT
   * include the disclosure item — that is a Foray-level obligation §4.9
   * prepends outside this stage (see `runPipeline.ts`'s own comment on
   * `disclosureItem`), so a caller building a playable partial candidate
   * must prepend it itself, exactly as the whole-Foray path already does.
   */
  onActReady?: (info: {
    actIndex: number;
    actTitle: string;
    totalActs: number;
    actItems: ForayItem[];
    itemsSoFar: ForayItem[];
    /** GV-21 (W5-12a): the act's own `WrittenAct`, so a caller can judge the
     * act's veracity from the pages it was stitched from. */
    written: WrittenAct;
    /** GV-21 (W6-01): one readiness record per `actItems` entry, in order —
     * what `toForayItems` drops (`verified`) kept beside the items rather
     * than on them. Indexes count the prelude §4.9 prepends. */
    actItemProvenance: ItemProvenance[];
    /** Every act's records so far, 1:1 with `itemsSoFar` (no prelude). */
    provenanceSoFar: ItemProvenance[];
    /** GV-33: how many of `actItems` (a prefix) were already handed out
     * through `emitSeamItems` before the act finished; 0 today, since no
     * production caller streams seams yet. A caller emitting per-item events
     * emits only the rest. */
    seamItemsEmitted: number;
  }) => void | Promise<void>;
  /**
   * GV-33 (W6-02): fired by `ForayStitcher.emitSeamItems`, so a streamed
   * writer (R1-06) can hand out an act's items one seam at a time before the
   * act is whole. Unit-tested with no production caller; the per-item event
   * contract (`ItemReadyEvent`) does not change when one appears.
   */
  onSeamItems?: (info: { actIndex: number; items: ForayItem[]; provenance: ItemProvenance[] }) => void | Promise<void>;
}

export interface StitchForayResult {
  items: ForayItem[];
}

/**
 * §4.8 driven ONE ACT AT A TIME (F-66, docs/curation/generation-run-
 * 2026-09-09.md). `stitchForay` below is this class in a loop and stays
 * the whole-Foray entry point; a caller that has act N's narration in hand
 * while act N+1 is still being written uses this directly.
 *
 * WHY IT EXISTS. Run 2 attempt 3 checkpointed act 1's narration at 18
 * minutes and did not produce a partial candidate — or a `ttlA1Ms` — until
 * the single stitch stage ran at 76 minutes, so WS-D2's "time to first
 * listen" measured the whole run instead of act 1. §4.8 was one stage
 * AFTER all of §4.7 for no reason that survives inspection: an act's own
 * items depend on that act's `WrittenAct`, that act's `DeepenedAct`, and
 * (for its introduction) the previous act's — never on a LATER act. So the
 * unit of this stage is an act, and this class is that unit made explicit.
 *
 * ORDERING IS THE CONTRACT, not the array. Acts must be handed in
 * ascending order, one each; `stitchNextAct` consumes index `actsDone` and
 * the continuity call for that boundary happens inside it, so the
 * `ContinuityBuilder` still sees boundaries 1, 2, 3... in order with the
 * previous act's ORIGINAL exit, exactly as the old up-front `smoothActs`
 * pass did.
 */
export class ForayStitcher {
  /** One entry per act, in act order, already mapped to the
   * `data/forays.json` item shape. Kept per act rather than as one flat
   * list because `toForayItems` is a pure per-item `map` — so a per-act
   * slice concatenated in order IS the whole-Foray mapping, and an act
   * whose items came from a checkpoint (`acceptStitchedAct`) drops into
   * the same structure without a second representation. */
  private readonly actItemLists: ForayItem[][] = [];
  /** GV-21: one readiness list per act, parallel to `actItemLists` — built
   * by `stitchNextAct`, or recomputed by `acceptStitchedAct` for a banked
   * act, so a resumed act has real provenance rather than none. */
  private readonly actProvenanceLists: ItemProvenance[][] = [];
  /** GV-33: the current (not yet stitched) act's items already handed out
   * through `emitSeamItems`, in order. */
  private seamEmitted: { itemId: string; index: number }[] = [];

  constructor(
    private readonly deepenedActs: DeepenedAct[],
    private readonly options: StitchForayOptions,
    private readonly ctx: ContinuityBuildContext
  ) {}

  /** How many acts are stitched (or accepted) so far — the index the next
   * `stitchNextAct` call will consume. */
  get actsDone(): number {
    return this.actItemLists.length;
  }

  /**
   * Smooths, stitches and coverage-checks the NEXT act, fires
   * `onActReady`, and returns that act's own `data/forays.json`-shaped
   * items. Throws `ActCoverageFailedError` for the same reason
   * `stitchForay` always did — a Foray missing coverage for one of its own
   * beats is not a partial success.
   */
  async stitchNextAct(written: WrittenAct): Promise<ForayItem[]> {
    const i = this.actItemLists.length;
    const act = this.deepenedActs[i];
    if (!act) {
      throw new Error(`ForayStitcher: no deepened act at index ${i} — ${this.deepenedActs.length} act(s) were supplied`);
    }
    const actLabel = `act-${i + 1}`;

    // (b) Cross-act continuity for THIS boundary — see the module doc
    // comment for why the smoothed introduction must exist before
    // within-act stitching's item assembly reads it, and
    // `smoothActIntroduction` for why one boundary at a time is the same
    // work in the same order.
    const introduction = await smoothActIntroduction(this.deepenedActs, i, this.options.continuity, this.ctx);

    // (a) Within-act deterministic stitching.
    const stitched = stitchAct(written, actLabel, this.options.slotIds?.[i]);

    const totalBeats = countActBeats(written);
    const coverageResult = validateActCoverage(stitched.coverage, totalBeats);
    if (!coverageResult.valid) {
      throw new ActCoverageFailedError(
        i,
        act.title,
        coverageResult.issues.map((issue) => issue.message)
      );
    }

    const actStitchedItems = this.withActSeams(i, stitched.items, introduction);
    const actItems = toForayItems(actStitchedItems);
    assertNoInternalFieldsLeaked(actItems);
    /* GV-21: read off the stitched items BEFORE the push, so the act's first
       index is the items before it plus the prelude. */
    const actItemProvenance = provenanceFor(actStitchedItems, i, this.firstItemIndexOf(i));
    /* GV-33: items streamed out early must be the act's leading items, or the
       per-item events already sent describe a different act. */
    const seamItemsEmitted = this.seamEmitted.length;
    const seamMismatch = this.seamEmitted.findIndex((e, k) => actItemProvenance[k]?.itemId !== e.itemId || actItemProvenance[k]?.index !== e.index);
    if (seamMismatch >= 0) {
      throw new Error(
        `ForayStitcher: act ${i + 1}'s stitched item ${seamMismatch} is not the seam item emitted for it (${this.seamEmitted[seamMismatch]!.itemId}) (GV-33)`
      );
    }
    this.seamEmitted = [];
    this.actItemLists.push(actItems);
    this.actProvenanceLists.push(actItemProvenance);

    // WS-D2: this act's own items are now complete and coverage-checked —
    // the earliest point in the PIPELINE (not merely in this stage) that a
    // partial candidate can be built from, now that this runs act-by-act.
    if (this.options.onActReady) {
      const itemsSoFar = this.items();
      await this.options.onActReady({
        actIndex: i,
        actTitle: act.title,
        totalActs: this.deepenedActs.length,
        actItems,
        itemsSoFar,
        written,
        actItemProvenance,
        provenanceSoFar: this.provenance(),
        seamItemsEmitted
      });
    }

    return actItems;
  }

  /**
   * Records the NEXT act's items from somewhere other than this stitcher —
   * in practice F-17/F-18's checkpoint, which banks each act's stitched
   * items under `stitch:<i>` (see `runPipeline.ts`).
   *
   * No continuity call is made and `onActReady` does NOT fire: the act was
   * paid for on an earlier run, and re-emitting a partial candidate for
   * work this process did not do is the same fiction `ttlA1Ms` refuses to
   * report on a resumed run.
   *
   * GV-21: `written` is the act's banked `narrate:<i>`, so the accepted act's
   * provenance is RECOMPUTED (`actProvenance`) rather than marked unknown —
   * no new checkpoint key. If the recomputed ids disagree with the banked
   * items, every item of the act is recorded `unverified`: a record that
   * does not describe the items beside it must not let them be served.
   */
  acceptStitchedAct(actItems: ForayItem[], written: WrittenAct): void {
    const i = this.actItemLists.length;
    this.seamEmitted = [];
    const firstIndex = this.firstItemIndexOf(i);
    let provenance = this.actProvenance(i, written);
    const sameIds = provenance.length === actItems.length && provenance.every((p, k) => p.itemId === itemKeyOf(actItems[k]!, firstIndex + k));
    if (!sameIds) {
      console.warn(`ForayStitcher: act ${i + 1}'s banked items do not match its narration's — recording every item of it unverified (GV-21)`);
      provenance = unverifiedProvenanceFor(actItems, i, firstIndex);
    }
    this.actItemLists.push(actItems);
    this.actProvenanceLists.push(provenance);
  }

  /**
   * GV-21: act `i`'s readiness records, rebuilt from its `WrittenAct` the way
   * `stitchNextAct` builds its items (`stitchAct` plus the introduction and
   * exit seams). Pure: the introduction's smoothed text is never needed —
   * provenance reads ids and verification, not scripts — so no continuity
   * call is made. Valid for any act up to the next one to be stitched.
   */
  actProvenance(i: number, written: WrittenAct): ItemProvenance[] {
    const act = this.deepenedActs[i];
    if (!act) {
      throw new Error(`ForayStitcher: no deepened act at index ${i} — ${this.deepenedActs.length} act(s) were supplied`);
    }
    const stitched = stitchAct(written, `act-${i + 1}`, this.options.slotIds?.[i]);
    return provenanceFor(this.withActSeams(i, stitched.items, act.introduction), i, this.firstItemIndexOf(i));
  }

  /**
   * GV-33 (W6-02): hands out some of the NEXT act's items before the act is
   * whole — a streamed writer (R1-06) calls this per seam as each one closes.
   * No production caller yet; the contract is fixed now so the per-item events
   * do not change when one appears.
   *
   * ORDER IS THE CONTRACT. `actIndex` must be the act the next
   * `stitchNextAct` will consume; `provenance` is 1:1 with `items`, of that
   * act, and continues exactly where the previous call for this act stopped
   * (the first call starts at the act's first item index, prelude counted).
   * Anything else throws before `onSeamItems` sees it. `stitchNextAct` later
   * checks these were the act's leading items and reports how many were
   * already emitted (`seamItemsEmitted`).
   */
  async emitSeamItems(actIndex: number, items: ForayItem[], provenance: ItemProvenance[]): Promise<void> {
    if (actIndex !== this.actItemLists.length) {
      throw new Error(`ForayStitcher.emitSeamItems: act ${actIndex} is not the act being written (${this.actItemLists.length}) (GV-33)`);
    }
    if (items.length !== provenance.length) {
      throw new Error(`ForayStitcher.emitSeamItems: ${items.length} item(s) but ${provenance.length} provenance record(s) (GV-33)`);
    }
    const next = this.firstItemIndexOf(actIndex) + this.seamEmitted.length;
    provenance.forEach((p, k) => {
      if (p.index !== next + k || p.actIndex !== actIndex || p.itemId !== itemKeyOf(items[k]!, p.index)) {
        throw new Error(
          `ForayStitcher.emitSeamItems: record ${k} (${p.itemId} at ${p.index}, act ${p.actIndex}) is not item ${next + k} of act ${actIndex} (GV-33)`
        );
      }
    });
    if (items.length === 0) return;
    this.seamEmitted.push(...provenance.map((p) => ({ itemId: p.itemId, index: p.index })));
    await this.options.onSeamItems?.({ actIndex, items: [...items], provenance: [...provenance] });
  }

  /** GV-21: every act's readiness records so far, 1:1 with `items()`. */
  provenance(): ItemProvenance[] {
    return this.actProvenanceLists.flat();
  }

  /** Act `i`'s first item's index in the candidate's item list: the prelude
   * plus every earlier act's items. */
  private firstItemIndexOf(i: number): number {
    if (i > this.actItemLists.length) {
      throw new Error(`ForayStitcher: act ${i} is not reachable — ${this.actItemLists.length} act(s) are stitched`);
    }
    let n = PRELUDE_ITEM_COUNT;
    for (let k = 0; k < i; k++) n += this.actItemLists[k]!.length;
    return n;
  }

  /** The act's stitched body wrapped in its seams — shared by `stitchNextAct`
   * and `actProvenance` so the two cannot disagree on what an act's items are. */
  private withActSeams(i: number, body: StitchedItem[], introduction: string): StitchedItem[] {
    const act = this.deepenedActs[i]!;
    const actLabel = `act-${i + 1}`;
    const actSlotIds = this.options.slotIds?.[i];
    const firstSlotId = actSlotIds?.[0];
    const lastSlotId = actSlotIds?.[act.slots.length - 1];
    // (c, partial) Seam narration around the act's own body: the act's
    // (possibly smoothed) introduction opens it, its own exit closes it
    // — mirroring `disclosureNarratedBeat`'s "seam" role but for a
    // whole-act boundary rather than the Foray's own opening.
    return [
      {
        kind: "narration",
        narrationKind: "seam",
        slotTitle: act.slots[0]?.title,
        ...(firstSlotId !== undefined ? { slotId: firstSlotId } : {}),
        mode: "Frame",
        script: introduction,
        id: `${actLabel}-introduction`
      },
      ...body,
      {
        kind: "narration",
        narrationKind: "seam",
        slotTitle: act.slots[act.slots.length - 1]?.title,
        ...(lastSlotId !== undefined ? { slotId: lastSlotId } : {}),
        mode: "Frame",
        script: act.exit,
        id: `${actLabel}-exit`
      }
    ];
  }

  /** (c) Every act stitched so far, in act order, mapped into the
   * forays.json-shaped item list. NOT including the disclosure item — that
   * is a Foray-level obligation §4.9 prepends outside this stage. */
  items(): ForayItem[] {
    return this.actItemLists.flat();
  }
}

/**
 * `deepenedActs` and `writtenActs` MUST be the same length, same order,
 * one-to-one (act N's `DeepenedAct` describes the same act as act N's
 * `WrittenAct`) — this is the caller's existing invariant from
 * `deepenActs.ts`/`writeNarration.ts` (both iterate `spine.acts` in the
 * same order and never reorder), checked here defensively rather than
 * re-derived.
 */
export async function stitchForay(deepenedActs: DeepenedAct[], writtenActs: WrittenAct[], options: StitchForayOptions, ctx: ContinuityBuildContext): Promise<StitchForayResult> {
  if (deepenedActs.length !== writtenActs.length) {
    throw new Error(`stitchForay: deepenedActs (${deepenedActs.length}) and writtenActs (${writtenActs.length}) must be the same length, one per act`);
  }

  const stitcher = new ForayStitcher(deepenedActs, options, ctx);
  for (const written of writtenActs) {
    await stitcher.stitchNextAct(written);
  }

  return { items: stitcher.items() };
}
