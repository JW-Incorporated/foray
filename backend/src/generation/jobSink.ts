import { z } from "zod";
import { ForayItemSchema, type ForayItem } from "./forayItems";
import type { ItemReadyEvent } from "./deliveryTimeline";
import { servableThroughAct, servableView, type PartialCandidate } from "./partialCandidate";
import { itemKeyOf, type ItemCheck } from "./itemReadiness";

/**
 * GV-44 (docs/roadmap/generation-v2.md, #1286; from W6-03; covers R1-15, GP-07;
 * decision 32): the JOB SNAPSHOT — what a phone may play of a Foray that is
 * still being generated, item by item, published to a "job row".
 *
 * WHAT IT IS. One small JSON document per job, rewritten on every act-ready
 * (GV-21's partial candidate, with its `delivery`) and every item-ready event
 * (GV-33). Its `items` are ONLY the leading servable prefix of the Foray —
 * `items[0..servableThrough)`, an item count with the prelude first (decision
 * 32) — so nothing from or after the first unservable act ever reaches the row,
 * not even as an id: `itemStates` is 1:1 with `items`.
 *
 * WHERE IT GOES. Behind `GenerationJobSink`, so the row can be a local file
 * today (`cli/fileJobSink.ts`, the batch driver's `--job-dir`) and a Supabase
 * row later (W6-18, GV-59) without the snapshot changing. `JobSnapshotSchema`
 * pins the contract both readers build against: the player (W6-04, GV-57) and
 * the Supabase sink.
 *
 * PRIVACY (§9.4). The schema has NO prompt field, and is strict, so a snapshot
 * carrying one does not validate. Title, topic and summary are allowed (§9.4
 * keeps the title): they are the understander's copy, never the raw prompt.
 *
 * Pure: types and pure functions only. No fs (generation/ may not write files,
 * promptNoPersistence.test.ts), no env, no clock — every time is passed in.
 */

export const JOB_SNAPSHOT_SCHEMA = "foray-job/1" as const;

/** The only Foray ids a job file may be named by (`<forayId>.job.json`): no
 * dot, no slash, no backslash, so no id can walk out of the job directory.
 * `forayIdFor` mints `<slug>-<6 hex>` (plus G-30's `-2` suffix), which fits. */
export const JOB_FORAY_ID_PATTERN = /^[a-z0-9-]{1,120}$/;

export function isJobForayId(id: unknown): id is string {
  return typeof id === "string" && JOB_FORAY_ID_PATTERN.test(id);
}

/** The job file's name for a Foray id. Throws on an id that fails
 * `JOB_FORAY_ID_PATTERN`, so no caller can build a path from one. */
export function jobSnapshotFilename(forayId: string): string {
  if (!isJobForayId(forayId)) throw new Error(`jobSnapshotFilename: refused Foray id ${JSON.stringify(forayId)} (must match ${JOB_FORAY_ID_PATTERN})`);
  return `${forayId}.job.json`;
}

export type JobLane = "on-demand" | "catalogue";
export type JobStatus = "running" | "complete" | "failed";
export type JobCloseOutcome = "complete" | "failed" | "aborted";
export type JobAudioState = "pending" | "rendered" | "phone-voice";

/** A close detail is a short machine code (`refused-partial`, `budget-stop`,
 * `error`, `invalid` ...), never free text: an error message can quote
 * anything, the prompt included. */
export const JOB_DETAIL_PATTERN = /^[a-z0-9:-]{1,64}$/;

const ITEM_CHECKS = ["verified", "unverified", "unchecked-seam", "tape", "jingle", "prelude"] as const satisfies readonly ItemCheck[];

export interface JobSnapshotAct {
  index: number;
  title: string;
  status: "ready" | "pending";
  /** Inside the servable prefix (GV-21's `served`). */
  servable: boolean;
}

export interface JobItemState {
  itemId: string;
  check: ItemCheck;
  /** "pending" until a render card stamps the item (W6-07); "phone-voice"
   * when the phone speaks the script itself. */
  audio: JobAudioState;
  audioKey?: string;
}

export interface JobDeliverySummary {
  /** ITEM COUNT of the servable prefix, prelude included: always
   * `items.length` (decision 32). */
  servableThrough: number;
  /** How many items the run has made so far, servable or not. A count only:
   * nothing past the prefix is named. */
  itemsGenerated: number;
  /** The last act inside the prefix (GV-21's act-level reading, derived from
   * the latest partial's `delivery.acts`), or -1. */
  servableThroughAct: number;
  /** The index of the generated item the prefix stops at because it is not
   * servable; null when the prefix stops only because nothing more is made. */
  pausedAtIndex: number | null;
}

export interface JobSnapshot {
  schema: typeof JOB_SNAPSHOT_SCHEMA;
  jobId: string;
  forayId: string;
  authorId: string;
  lane: JobLane;
  status: JobStatus;
  /** Strictly increasing per job file: a poller skips any snapshot whose seq
   * is not above the last one it applied. */
  seq: number;
  updatedAt: string;
  /** The understander's copy; null until the first partial candidate names
   * it (an item event carries no title). Never the prompt. */
  title: string | null;
  topic: string | null;
  summary: string | null;
  acts: JobSnapshotAct[];
  /** ONLY `items[0..delivery.servableThrough)`, prelude first. The player
   * plays these and nothing else. */
  items: ForayItem[];
  /** 1:1 with `items`. */
  itemStates: JobItemState[];
  /** Seconds of Foray the run has made so far (listener's clock, prelude
   * included), servable or not. */
  runtimeSecSoFar: number;
  delivery?: JobDeliverySummary;
  /** Set by `close`: how the run ended. `detail` is a machine code. */
  closed?: { outcome: JobCloseOutcome; detail?: string };
}

/** Where a job row goes. `publish` replaces the row with a newer snapshot;
 * `close` writes the final one with the run's outcome. A sink that was never
 * handed a snapshot has no Foray id to name a row by, so its `close` writes
 * nothing. */
export interface GenerationJobSink {
  publish(s: JobSnapshot): Promise<void>;
  close(outcome: JobCloseOutcome, detail?: string): Promise<void>;
}

/** The job's fixed fields, known before the run mints its Foray id. */
export interface JobIdentity {
  jobId: string;
  authorId: string;
  lane: JobLane;
}

/** What the run has handed the job so far: the latest partial candidate
 * (act-level, GV-21) and every item event (item-level, GV-33), by index. */
export interface JobProgress {
  forayId: string | null;
  partial: PartialCandidate | null;
  /** Item events by index; a later event at the same index (a resumed
   * attempt re-emitting an item) replaces the earlier one. */
  events: readonly ItemReadyEvent[];
}

export const EMPTY_JOB_PROGRESS: JobProgress = Object.freeze({ forayId: null, partial: null, events: Object.freeze([]) as readonly ItemReadyEvent[] });

export function progressWithEvent(progress: JobProgress, ev: ItemReadyEvent): JobProgress {
  const events = progress.events.filter((e) => e.index !== ev.index);
  events.push(ev);
  events.sort((a, b) => a.index - b.index);
  return { ...progress, forayId: progress.forayId ?? ev.forayId, events };
}

export function progressWithPartial(progress: JobProgress, candidate: PartialCandidate): JobProgress {
  return { ...progress, forayId: candidate.id, partial: candidate };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * THE PREFIX RULE. Walks the items from index 0 and stops at the first index
 * that is not known-servable:
 * - inside the latest partial's items, an index is servable only when it lies
 *   inside that partial's servable prefix (`servableView`, GV-21) — the
 *   act-level verdict, with alignment and veracity, wins over the event's;
 * - past them, only when an item event for that index says `servable`;
 * - an index nothing has reported (a gap, e.g. a resumed attempt's banked
 *   acts fire no events) stops the walk too.
 * So a later act that is ready never reaches `items` while an earlier act is
 * unservable or missing.
 */
function servablePrefix(progress: JobProgress): { items: ForayItem[]; states: JobItemState[]; pausedAtIndex: number | null; generated: number } {
  const partialItems = progress.partial?.items ?? [];
  const partialServable = progress.partial ? servableView(progress.partial).length : 0;
  const deliveryChecks = progress.partial?.delivery?.items ?? [];
  const byIndex = new Map(progress.events.map((e) => [e.index, e]));
  const maxEvent = progress.events.reduce((m, e) => Math.max(m, e.index + 1), 0);
  const generated = Math.max(partialItems.length, maxEvent);

  const items: ForayItem[] = [];
  const states: JobItemState[] = [];
  let pausedAtIndex: number | null = null;
  for (let i = 0; i < generated; i++) {
    const ev = byIndex.get(i);
    let item: ForayItem | undefined;
    let check: ItemCheck | undefined;
    let itemId: string | undefined;
    if (i < partialItems.length) {
      if (i >= partialServable) {
        pausedAtIndex = i;
        break;
      }
      item = partialItems[i]!;
      const d = deliveryChecks[i];
      itemId = d?.itemId ?? ev?.itemId;
      check = d?.check ?? ev?.check;
    } else if (ev) {
      if (!ev.servable) {
        pausedAtIndex = i;
        break;
      }
      item = ev.item;
      itemId = ev.itemId;
      check = ev.check;
    } else {
      break;
    }
    items.push(item);
    /* A partial without `delivery` (pre-GV-21) and no event: the item is
       served as servableView serves it, labelled conservatively. */
    states.push({ itemId: itemId ?? itemKeyOf(item, i), check: check ?? "unverified", audio: "pending" });
  }
  return { items, states, pausedAtIndex, generated };
}

/**
 * The snapshot of a job's progress, numbered `prevSeq + 1`. Null until the
 * run has minted its Foray id (no row can be named before it). `updatedAt` is
 * passed in: this module reads no clock.
 */
export function snapshotFrom(job: JobIdentity, progress: JobProgress, prevSeq: number, updatedAt: string): JobSnapshot | null {
  const forayId = progress.partial?.id ?? progress.forayId;
  if (!forayId) return null;
  const partial = progress.partial;
  const prefix = servablePrefix(progress);

  const acts: JobSnapshotAct[] = (partial?.acts ?? []).map((a) => ({
    index: a.index,
    title: a.title,
    status: a.status,
    servable: partial?.delivery ? a.served === true : a.status === "ready"
  }));
  const lastServedAct = partial?.delivery ? servableThroughAct(partial.delivery) : acts.filter((a) => a.servable).length - 1;
  const eventRuntime = progress.events.reduce((m, e) => Math.max(m, e.playStartSec + e.durationSec), 0);

  return {
    schema: JOB_SNAPSHOT_SCHEMA,
    jobId: job.jobId,
    forayId,
    authorId: job.authorId,
    lane: job.lane,
    status: "running",
    seq: prevSeq + 1,
    updatedAt,
    title: partial?.title ?? null,
    topic: partial?.topic ?? null,
    summary: partial?.summary ?? null,
    acts,
    items: prefix.items,
    itemStates: prefix.states,
    runtimeSecSoFar: round3(Math.max(partial?.runtimeSec ?? 0, eventRuntime)),
    ...(prefix.generated > 0
      ? {
          delivery: {
            servableThrough: prefix.items.length,
            itemsGenerated: prefix.generated,
            servableThroughAct: lastServedAct,
            pausedAtIndex: prefix.pausedAtIndex
          }
        }
      : {})
  };
}

/** The final snapshot: the last one, renumbered, with the run's outcome. An
 * "aborted" run's row reads `status: "failed"` with `closed.outcome`
 * "aborted"; the content is never widened on close. */
export function closedSnapshot(last: JobSnapshot, outcome: JobCloseOutcome, updatedAt: string, detail?: string): JobSnapshot {
  if (detail !== undefined && !JOB_DETAIL_PATTERN.test(detail)) {
    throw new Error(`closedSnapshot: detail must be a short code matching ${JOB_DETAIL_PATTERN}, got ${JSON.stringify(detail.slice(0, 80))}`);
  }
  return {
    ...last,
    status: outcome === "complete" ? "complete" : "failed",
    seq: last.seq + 1,
    updatedAt,
    closed: { outcome, ...(detail !== undefined ? { detail } : {}) }
  };
}

const JobItemStateSchema = z
  .object({
    itemId: z.string().min(1),
    check: z.enum(ITEM_CHECKS),
    audio: z.enum(["pending", "rendered", "phone-voice"]),
    audioKey: z.string().min(1).optional()
  })
  .strict();

/**
 * The contract (W6-04 player, W6-18 Supabase row). Strict: an unknown key,
 * a `prompt` above all, fails. Refined so `items` and `itemStates` agree
 * 1:1 and `delivery.servableThrough` is the item count.
 */
export const JobSnapshotSchema = z
  .object({
    schema: z.literal(JOB_SNAPSHOT_SCHEMA),
    jobId: z.string().min(1).max(200),
    forayId: z.string().regex(JOB_FORAY_ID_PATTERN),
    authorId: z.string().min(1),
    lane: z.enum(["on-demand", "catalogue"]),
    status: z.enum(["running", "complete", "failed"]),
    seq: z.number().int().positive(),
    updatedAt: z.string().min(1),
    title: z.string().nullable(),
    topic: z.string().nullable(),
    summary: z.string().nullable(),
    acts: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          title: z.string(),
          status: z.enum(["ready", "pending"]),
          servable: z.boolean()
        })
        .strict()
    ),
    items: z.array(ForayItemSchema),
    itemStates: z.array(JobItemStateSchema),
    runtimeSecSoFar: z.number().nonnegative(),
    delivery: z
      .object({
        servableThrough: z.number().int().nonnegative(),
        itemsGenerated: z.number().int().nonnegative(),
        servableThroughAct: z.number().int().min(-1),
        pausedAtIndex: z.number().int().nonnegative().nullable()
      })
      .strict()
      .optional(),
    closed: z
      .object({
        outcome: z.enum(["complete", "failed", "aborted"]),
        detail: z.string().regex(JOB_DETAIL_PATTERN).optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.itemStates.length !== s.items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["itemStates"], message: `itemStates (${s.itemStates.length}) must be 1:1 with items (${s.items.length})` });
    }
    if (s.delivery && s.delivery.servableThrough !== s.items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery", "servableThrough"], message: `servableThrough (${s.delivery.servableThrough}) must equal items.length (${s.items.length})` });
    }
    if (s.delivery && s.delivery.itemsGenerated < s.items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery", "itemsGenerated"], message: "itemsGenerated is below the served item count" });
    }
  });
