import type { StitchedItem } from "../types/stitching";
import type { ForayItem } from "./forayItems";
import type { ActVeracity } from "./veracityMetrics";

/**
 * GV-21 (docs/roadmap/generation-v2.md, #1286; merged W6-01 + W5-12a; decision
 * 13 and 32): per-item readiness and per-act servability for a PARTIAL
 * candidate, built from the provenance the stitcher already holds.
 *
 * THE HOLE IT CLOSES. A stitched narration item knows whether its page passed
 * the verifier (`StitchedNarrationItem.verified`, F-103), but `toForayItems`
 * drops that field on purpose (the leak guard, `assertNoInternalFieldsLeaked`),
 * so `onActReady` used to hand the partial path plain items with no way to tell
 * a verified page from the HANDOFF fallback (`writeAct.ts`: `verified: false,
 * unverifiedReason: "no-page"`). A listener could be handed an act holding a
 * page nobody verified. This module classifies every item, decides per act
 * whether the act may be served, and computes the ONE servable prefix:
 * `servableThrough`, an ITEM COUNT of the leading servable items, prelude
 * included (decision 32).
 *
 * NOTHING HERE TOUCHES THE forays.json-SHAPED ITEMS. The readiness records
 * ride a separate, optional `delivery` field on the local partial candidate;
 * `items[]` stay byte-identical and the leak guard still passes. The verdict
 * never aborts a run and is independent of `validation` and of
 * `RefusedPartialError` (QK-29 / R2-13): an unservable act is withheld, the
 * run finishes its record.
 *
 * Pure: no I/O, no env, no model call.
 */

/** How an item's content was checked.
 * - `verified`: a narration page the verifier passed.
 * - `unverified`: a narration page kept with `verified: false` — this includes
 *   the HANDOFF fallback (`unverifiedReason: "no-page"`). Always blocks.
 * - `unchecked-seam`: narration that never went through the verifier at all
 *   (`verified` absent) — today the act introduction and exit, built from
 *   deepen text. Blocks only under `blockOnUncheckedSeams` (QK-24's decision).
 * - `tape`: a clip of the source episode, which is what it is.
 * - `jingle`: a structural marker with no content.
 * - `prelude`: the Foray's fixed opening (disclosure), from a template. */
export type ItemCheck = "verified" | "unverified" | "unchecked-seam" | "tape" | "jingle" | "prelude";

/** The forays.json item kind (`ForayItem["type"]`). */
export type ItemKind = ForayItem["type"];

export interface ItemProvenance {
  /** The item's key in `items[]`: a narration or jingle `id`, a segment's
   * `segment_id` (see `itemKeyOf`). */
  itemId: string;
  /** Position in the item list INCLUDING the prelude (the prelude is 0). */
  index: number;
  /** The act the item belongs to; -1 for the prelude, which belongs to none. */
  actIndex: number;
  kind: ItemKind;
  narrationKind?: "beat" | "seam";
  check: ItemCheck;
  pronunciationHints?: string[];
  scriptSha256?: string;
}

/** §4.9 prepends exactly one item (the prelude) before the stitched body, so
 * the stitcher's first item sits at index 1 of the candidate's `items[]`. */
export const PRELUDE_ITEM_COUNT = 1;

export interface ReadinessPolicy {
  /** QK-24: when true an `unchecked-seam` item blocks its act. Default false,
   * so the act introduction and exit play exactly as they do today. */
  blockOnUncheckedSeams: boolean;
}

export const DEFAULT_READINESS_POLICY: ReadinessPolicy = Object.freeze({ blockOnUncheckedSeams: false });

export type BlockerReason = "unverified" | "unchecked-seam" | "ungrounded-quote" | "misaligned";

export interface ActBlocker {
  /** The blocking item's key; for an act-level failure (a grounded-quote rate
   * below 1, or a misaligned item list) the act's own label, `act-<n>`. */
  itemId: string;
  reason: BlockerReason;
}

export interface ActAssessment {
  servable: boolean;
  blockers: ActBlocker[];
}

export interface DeliveryAct {
  index: number;
  servable: boolean;
  blockers: ActBlocker[];
}

export interface DeliveryItem {
  itemId: string;
  index: number;
  /** -1 for the prelude. */
  act: number;
  check: ItemCheck;
  /** True only inside the servable prefix (`index < servableThrough`). */
  ready: boolean;
  audio: "pending";
}

export interface DeliveryView {
  /** One entry per act handed in (the acts stitched so far), in act order. */
  acts: DeliveryAct[];
  /** ITEM COUNT of the leading all-servable prefix, prelude included — the
   * only servableThrough (decision 32). Never extends past the first
   * unservable act. */
  servableThrough: number;
  /** 1:1 with the candidate's `items[]`, prelude included. */
  items: DeliveryItem[];
}

/** The act label stitch uses in item ids (`act-1-introduction`). */
export function actLabelOf(actIndex: number): string {
  return `act-${actIndex + 1}`;
}

/** The key a forays.json item is joined on: narration and jingle `id`, a
 * segment's `segment_id`. A jingle without an id falls back to its position. */
export function itemKeyOf(item: ForayItem, index: number): string {
  if (item.type === "segment") return item.segment_id;
  if (item.type === "narration") return item.id;
  return item.id ?? `jingle@${index}`;
}

/** The same key, read off a stitched item before it is mapped. */
function stitchedKeyOf(item: StitchedItem, index: number): string {
  if (item.kind === "tape") return item.segmentId;
  if (item.kind === "narration") return item.id;
  return item.id ?? `jingle@${index}`;
}

/**
 * Classifies one act's stitched items. `firstIndex` is the act's first item's
 * position in the whole item list, prelude included.
 */
export function provenanceFor(stitched: readonly StitchedItem[], actIndex: number, firstIndex = 0): ItemProvenance[] {
  return stitched.map((item, k) => {
    const index = firstIndex + k;
    const itemId = stitchedKeyOf(item, index);
    if (item.kind === "tape") return { itemId, index, actIndex, kind: "segment", check: "tape" };
    if (item.kind === "jingle") return { itemId, index, actIndex, kind: "jingle", check: "jingle" };
    const check: ItemCheck = item.verified === true ? "verified" : item.verified === false ? "unverified" : "unchecked-seam";
    return { itemId, index, actIndex, kind: "narration", narrationKind: item.narrationKind, check };
  });
}

/** The conservative record for items whose provenance could not be
 * recomputed (a banked act whose ids disagree with its narration): every
 * item `unverified`, so the act is never served. */
export function unverifiedProvenanceFor(items: readonly ForayItem[], actIndex: number, firstIndex = 0): ItemProvenance[] {
  return items.map((item, k) => {
    const index = firstIndex + k;
    return { itemId: itemKeyOf(item, index), index, actIndex, kind: item.type, check: "unverified" };
  });
}

/** The prelude's record: index 0, no act, `check: "prelude"`. */
export function preludeProvenance(item: ForayItem): ItemProvenance {
  return { itemId: itemKeyOf(item, 0), index: 0, actIndex: -1, kind: item.type, check: "prelude" };
}

/**
 * Whether one act may be served. An `unverified` item always blocks (the
 * HANDOFF page included); an `unchecked-seam` blocks only under the policy.
 * W5-12a's act veracity also blocks: a grounded-quote rate below 1, and an
 * unverified page the item list somehow does not show. A null rate is
 * "unmeasured" (no page carried evidence) and does not block here.
 */
export function assessAct(prov: readonly ItemProvenance[], policy: ReadinessPolicy = DEFAULT_READINESS_POLICY, veracity?: ActVeracity): ActAssessment {
  const blockers: ActBlocker[] = [];
  for (const p of prov) {
    if (p.check === "unverified") blockers.push({ itemId: p.itemId, reason: "unverified" });
    else if (p.check === "unchecked-seam" && policy.blockOnUncheckedSeams) blockers.push({ itemId: p.itemId, reason: "unchecked-seam" });
  }
  if (veracity) {
    const actId = actLabelOf(veracity.actIndex);
    if (veracity.unverifiedPages.length > 0 && !blockers.some((b) => b.reason === "unverified")) blockers.push({ itemId: actId, reason: "unverified" });
    if (veracity.groundedQuoteRate !== null && veracity.groundedQuoteRate < 1) blockers.push({ itemId: actId, reason: "ungrounded-quote" });
  }
  return { servable: blockers.length === 0, blockers };
}

export interface ActReadinessInput {
  index: number;
  provenance: readonly ItemProvenance[];
  veracity?: ActVeracity;
}

/**
 * The delivery view over the acts stitched so far. `prelude` is the
 * provenance of the items before act 0 (the prelude itself), counted into
 * `servableThrough` because it is always served. The prefix stops at the
 * first unservable act: a later servable act behind it is not reachable.
 */
export function deliveryView(input: { prelude: readonly ItemProvenance[]; acts: readonly ActReadinessInput[] }, policy: ReadinessPolicy = DEFAULT_READINESS_POLICY): DeliveryView {
  const ordered = [...input.acts].sort((a, b) => a.index - b.index);
  const acts: DeliveryAct[] = ordered.map((a) => {
    const verdict = assessAct(a.provenance, policy, a.veracity);
    return { index: a.index, servable: verdict.servable, blockers: verdict.blockers };
  });

  let servableThrough = input.prelude.length;
  for (const [k, act] of acts.entries()) {
    if (act.index !== k || !act.servable) break;
    servableThrough += ordered[k]!.provenance.length;
  }

  const all = [...input.prelude, ...ordered.flatMap((a) => a.provenance)];
  const items: DeliveryItem[] = all.map((p, index) => ({
    itemId: p.itemId,
    index,
    act: p.actIndex,
    check: p.check,
    ready: index < servableThrough,
    audio: "pending"
  }));
  return { acts, servableThrough, items };
}

/**
 * The act-level reading of the prefix (W5-12a's value, decision 32): the
 * last index of the contiguous run of servable acts from act 0, or -1.
 * Derived from `delivery.acts`, never stored.
 */
export function servableThroughAct(delivery: Pick<DeliveryView, "acts">): number {
  let last = -1;
  for (const [k, act] of [...delivery.acts].sort((a, b) => a.index - b.index).entries()) {
    if (act.index !== k || !act.servable) break;
    last = k;
  }
  return last;
}

/**
 * Guards the 1:1 join between `delivery.items` and the candidate's
 * `items[]`. On any disagreement nothing past the prelude is served: every
 * act is marked unservable with a `misaligned` blocker. Conservative by
 * design — a readiness record that does not describe the items it sits
 * beside describes nothing.
 */
export function alignDelivery(delivery: DeliveryView, items: readonly ForayItem[], preludeCount = PRELUDE_ITEM_COUNT): DeliveryView {
  const aligned = delivery.items.length === items.length && delivery.items.every((d, i) => d.itemId === itemKeyOf(items[i]!, i));
  if (aligned) return delivery;
  const servableThrough = Math.min(preludeCount, items.length);
  return {
    acts: delivery.acts.map((a) => ({ index: a.index, servable: false, blockers: [...a.blockers, { itemId: actLabelOf(a.index), reason: "misaligned" as const }] })),
    servableThrough,
    items: items.map((item, index) => {
      const prior = delivery.items[index];
      return {
        itemId: itemKeyOf(item, index),
        index,
        act: prior?.act ?? -1,
        check: index < servableThrough && prior ? prior.check : ("unverified" as const),
        ready: index < servableThrough,
        audio: "pending" as const
      };
    })
  };
}
