import type { ForayItem } from "./forayItems";
import type { ItemCheck } from "./itemReadiness";

/**
 * GV-33 (docs/roadmap/generation-v2.md, #1286; from W6-02 and W1-06; covers
 * R1-15, GP-07, R1-14, MT-01, MT-11; decision 14): the delivery timeline of one
 * pipeline attempt, and the lead of generation over the playhead.
 *
 * WHAT IT MEASURES. The KPI reading (OQ-03) is "generated ahead of the
 * playhead": once the listener's first audio starts, every later item must be
 * ready before the playhead reaches it, with a 30 s margin (PROPOSED,
 * decision 15). `runForayPipeline` emits one `ItemReadyEvent` per item, in
 * playback order, the moment the item is ready (`deps.onItemReady`); this
 * class records them and computes, per servable item,
 *
 *     arrival = firstAudioAtMs / 1000 + playStartSec / rate
 *     leadSec = arrival - readyAtMs / 1000
 *
 * i.e. how many seconds before the playhead arrives the item was ready. A
 * negative lead is a stall: the listener would have reached the item before it
 * existed.
 *
 * WHICH ITEMS COUNT. The playhead starts at the first servable item
 * (`firstServableReadyMs`) unless the caller says otherwise. An item that was
 * already ready when playback started is buffered, not raced, so it is not a
 * lead sample (its lead would read as 0 s for the item that started playback,
 * which says nothing about generation). Playback cannot pass an unservable
 * item (GV-21, decision 32: the servable prefix stops at the first unservable
 * act), so the first unservable item's index is `pausedAtIndex` and neither it
 * nor anything after it is a lead sample: those items never play in this run.
 *
 * KNOWN BIASES, NAMED (card risk). Act-level bursts make the lead look worse
 * than a streamed writer will (granularity says which one this was).
 * `runtimeSecFor` contributes 0 s for a segment the pool cannot resolve, which
 * under-states every later item's `playStartSec` and so makes the lead
 * optimistic; `unknownDurations` counts those items so a reader can see it.
 *
 * Pure: no I/O, no env, no clock of its own (every time is on the event).
 */

/** One item became ready. `readyAtMs` is milliseconds since the pipeline
 * attempt started (`runForayPipeline`'s `pipelineStartMs`, on
 * `deps.wallClockMs`). `playStartSec` is where the item starts on the
 * listener's clock (`runtimeSecFor` of every item before it, prelude
 * included); `durationSec` is `runtimeSecFor([item])`. */
export interface ItemReadyEvent {
  forayId: string;
  /** Position in the candidate's `items[]`, prelude included (prelude = 0). */
  index: number;
  /** The item's key (`itemKeyOf`). */
  itemId: string;
  /** -1 for the prelude, which belongs to no act. */
  actIndex: number;
  check: ItemCheck;
  /** Whether the item's act may be served (GV-21 `assessAct`); the prelude is
   * always servable. */
  servable: boolean;
  readyAtMs: number;
  playStartSec: number;
  durationSec: number;
  item: ForayItem;
  /** "act" when the item was emitted with its whole act (today's stitcher),
   * "item" when it was emitted on its own (the early prelude, or a streamed
   * writer's seam through `ForayStitcher.emitSeamItems`). Optional so a
   * hand-built event reads as act-granular. */
  granularity?: "act" | "item";
}

export interface LateItem {
  index: number;
  itemId: string;
  leadSec: number;
}

export interface LeadReport {
  /** The smallest lead over the lead samples; null when there was none (every
   * servable item was ready when playback started, or nothing was servable). */
  minLeadSec: number | null;
  /** Lead samples under 30 s (the PROPOSED lead target). */
  itemsBelow30s: number;
  /** Lead samples under 0 s: the playhead would have reached them first. */
  lateItems: LateItem[];
  /** The first unservable item's index, when playback has to pause there. */
  pausedAtIndex?: number;
  /** How many items were lead samples. */
  samples: number;
}

/** The lead target in seconds (decision 15: PROPOSED until a founder ruling). */
export const LEAD_TARGET_SEC = 30;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class DeliveryTimeline {
  private readonly list: ItemReadyEvent[] = [];

  record(ev: ItemReadyEvent): void {
    this.list.push({ ...ev });
  }

  /** Every recorded event, in record order (a copy). */
  events(): ItemReadyEvent[] {
    return this.list.map((e) => ({ ...e }));
  }

  get count(): number {
    return this.list.length;
  }

  /** Events in playback order. */
  private ordered(): ItemReadyEvent[] {
    return [...this.list].sort((a, b) => a.index - b.index);
  }

  get firstItemReadyMs(): number | null {
    return this.list.length ? Math.min(...this.list.map((e) => e.readyAtMs)) : null;
  }

  /** When the first servable item was ready: the default start of playback. */
  get firstServableReadyMs(): number | null {
    const servable = this.servablePrefix();
    return servable.length ? Math.min(...servable.map((e) => e.readyAtMs)) : null;
  }

  get allItemsReadyMs(): number | null {
    return this.list.length ? Math.max(...this.list.map((e) => e.readyAtMs)) : null;
  }

  /** The first unservable item's index, if any. */
  get pausedAtIndex(): number | undefined {
    return this.ordered().find((e) => !e.servable)?.index;
  }

  /** Segment items whose duration `runtimeSecFor` could not resolve (it
   * contributes 0 s for them). */
  get unknownDurations(): number {
    return this.list.filter((e) => e.item.type === "segment" && !(e.durationSec > 0)).length;
  }

  /** "item" only when every event was emitted on its own; one act-level
   * burst makes the whole timeline act-granular. */
  get granularity(): "act" | "item" {
    return this.list.length > 0 && this.list.every((e) => e.granularity === "item") ? "item" : "act";
  }

  /** The servable items before the pause: the only items that play. */
  private servablePrefix(): ItemReadyEvent[] {
    const paused = this.pausedAtIndex;
    return this.ordered().filter((e) => e.servable && (paused === undefined || e.index < paused));
  }

  leadReport(opts: { firstAudioAtMs?: number; rate?: number } = {}): LeadReport {
    const rate = opts.rate ?? 1;
    if (!(rate > 0)) throw new Error(`DeliveryTimeline.leadReport: rate must be positive, got ${rate}`);
    const paused = this.pausedAtIndex;
    const firstAudioAtMs = opts.firstAudioAtMs ?? this.firstServableReadyMs;
    const base = { ...(paused !== undefined ? { pausedAtIndex: paused } : {}) };
    if (firstAudioAtMs === null) return { minLeadSec: null, itemsBelow30s: 0, lateItems: [], samples: 0, ...base };

    let minLeadSec: number | null = null;
    let itemsBelow30s = 0;
    let samples = 0;
    const lateItems: LateItem[] = [];
    for (const ev of this.servablePrefix()) {
      if (ev.readyAtMs <= firstAudioAtMs) continue;
      const arrival = firstAudioAtMs / 1000 + ev.playStartSec / rate;
      const leadSec = round3(arrival - ev.readyAtMs / 1000);
      samples++;
      if (minLeadSec === null || leadSec < minLeadSec) minLeadSec = leadSec;
      if (leadSec < LEAD_TARGET_SEC) itemsBelow30s++;
      if (leadSec < 0) lateItems.push({ index: ev.index, itemId: ev.itemId, leadSec });
    }
    return { minLeadSec, itemsBelow30s, lateItems, samples, ...base };
  }
}

/** `report.json`'s `delivery` block (generateForays.ts `ReportEntry`). */
export interface DeliveryReport {
  granularity: "act" | "item";
  /** Items the attempt emitted. */
  items: number;
  /** A resumed attempt: banked acts never fired events, so no lead and no
   * first-item times are reported (the `ttlA1Ms` rule). */
  resumed?: true;
  firstItemReadyMs?: number | null;
  firstServableMs?: number | null;
  allItemsReadyMs?: number | null;
  minLeadSec?: number | null;
  minLeadSecAt1_5x?: number | null;
  itemsBelow30s?: number;
  /** The first unservable item's index; null when nothing paused playback. */
  pausedAtIndex?: number | null;
  unknownDurations?: number;
}

/**
 * The report block for one attempt. Undefined when the attempt emitted
 * nothing and was not resumed (absent stays absent, never zero). A resumed
 * attempt reports `resumed: true` with no lead and no first-item times.
 */
export function deliveryReportOf(timeline: DeliveryTimeline, resumed: boolean): DeliveryReport | undefined {
  if (resumed) return { granularity: timeline.granularity, items: timeline.count, resumed: true };
  if (timeline.count === 0) return undefined;
  const at1 = timeline.leadReport({ rate: 1 });
  const at15 = timeline.leadReport({ rate: 1.5 });
  return {
    granularity: timeline.granularity,
    items: timeline.count,
    firstItemReadyMs: timeline.firstItemReadyMs,
    firstServableMs: timeline.firstServableReadyMs,
    allItemsReadyMs: timeline.allItemsReadyMs,
    minLeadSec: at1.minLeadSec,
    minLeadSecAt1_5x: at15.minLeadSec,
    itemsBelow30s: at1.itemsBelow30s,
    pausedAtIndex: at1.pausedAtIndex ?? null,
    unknownDurations: timeline.unknownDurations
  };
}
