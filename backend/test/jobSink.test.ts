import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  closedSnapshot,
  EMPTY_JOB_PROGRESS,
  isJobForayId,
  jobSnapshotFilename,
  JobSnapshotSchema,
  progressWithEvent,
  progressWithPartial,
  snapshotFrom,
  type JobIdentity,
  type JobProgress,
  type JobSnapshot
} from "../src/generation/jobSink";
import { FileJobSink } from "../src/cli/fileJobSink";
import type { ItemReadyEvent } from "../src/generation/deliveryTimeline";
import type { PartialCandidate } from "../src/generation/partialCandidate";
import type { ForayItem } from "../src/generation/forayItems";
import type { ItemCheck } from "../src/generation/itemReadiness";
import { partialOnlyScope } from "../src/generation/partialProjection";

/**
 * GV-44 (docs/roadmap/generation-v2.md, #1286; W6-03): the job snapshot — the
 * prefix rule, seq, the schema contract — and the file-backed sink. Offline,
 * hand-built partials and events. Each test names the mutation it kills; every
 * one was run against the source and went red.
 */

const FORAY = "the-history-of-grilling-a1b2c3";
const JOB: JobIdentity = { jobId: "job-1", authorId: "founder-1", lane: "catalogue" };
const AT = "2026-10-12T10:00:00.000Z";

const narration = (id: string, script = `Line ${id}.`, mode: "marker" | "frame" | "hinge" = "frame"): ForayItem => ({ type: "narration", id, script, mode });
const segment = (id: string): ForayItem => ({ type: "segment", segment_id: id });

/** prelude, act 0 (intro, tape, exit), act 1 (intro, tape, exit). */
const ITEMS: ForayItem[] = [
  narration("prelude", "This Foray was generated.", "marker"),
  narration("act-1-introduction"),
  segment("show-a--ep-1#10"),
  narration("act-1-exit"),
  narration("act-2-introduction"),
  segment("show-b--ep-2#20"),
  narration("act-2-exit")
];
const ACT_OF = [-1, 0, 0, 0, 1, 1, 1];
const checkOf = (item: ForayItem, i: number): ItemCheck => (i === 0 ? "prelude" : item.type === "segment" ? "tape" : "unchecked-seam");
const idOf = (item: ForayItem): string => (item.type === "segment" ? item.segment_id : (item as { id: string }).id);

function partial(through: number, servable: boolean[], extra: Partial<PartialCandidate> = {}): PartialCandidate {
  const items = ITEMS.slice(0, through);
  let servableThrough = 1;
  for (const [k, ok] of servable.entries()) {
    if (!ok) break;
    servableThrough += items.filter((_it, i) => ACT_OF[i] === k).length;
  }
  return {
    id: FORAY,
    title: "Fire, smoke and time",
    topic: "food/grilling-bbq",
    summary: "How people learned to cook with smoke.",
    status: through === ITEMS.length ? "complete" : "partial",
    visibility: "private",
    authorId: "founder-1",
    acts: [
      { index: 0, title: "Act 1: Fire", status: "ready", served: servable[0] === true },
      { index: 1, title: "Act 2: Smoke", status: through > 4 ? "ready" : "pending", served: servable[0] === true && servable[1] === true }
    ],
    slots: [],
    items,
    runtimeSec: 100 * through,
    ttlA1Ms: 10,
    builtAt: AT,
    updatedAt: AT,
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    ruleScope: partialOnlyScope("partial-only"),
    delivery: {
      acts: servable.map((ok, index) => ({ index, servable: ok, blockers: ok ? [] : [{ itemId: `act-${index + 1}`, reason: "unverified" as const }] })),
      servableThrough,
      items: items.map((it, index) => ({ itemId: idOf(it), index, act: ACT_OF[index]!, check: checkOf(it, index), ready: index < servableThrough, audio: "pending" as const }))
    },
    ...extra
  };
}

function event(index: number, servable = true): ItemReadyEvent {
  const item = ITEMS[index]!;
  return {
    forayId: FORAY,
    index,
    itemId: idOf(item),
    actIndex: ACT_OF[index]!,
    check: checkOf(item, index),
    servable,
    readyAtMs: 1000 * index,
    playStartSec: 50 * index,
    durationSec: 50,
    item,
    granularity: "act"
  };
}

const withEvents = (p: JobProgress, ...evs: ItemReadyEvent[]): JobProgress => evs.reduce((acc, ev) => progressWithEvent(acc, ev), p);

describe("snapshotFrom — the prefix rule", () => {
  it("never carries an item from or after the first unservable act, even when later acts are ready", () => {
    /* MUTATION THAT KILLS THIS: in servablePrefix, take every partial item
       (drop the `i >= partialServable` stop). Act 0's items and act 1's —
       ready and servable — reach the snapshot behind an unservable act 0.
       Ran it — red. */
    let p = progressWithPartial(EMPTY_JOB_PROGRESS, partial(7, [false, true]));
    p = withEvents(p, event(4), event(5), event(6));
    const s = snapshotFrom(JOB, p, 0, AT)!;
    expect(s.items).toEqual([ITEMS[0]]);
    expect(s.itemStates.map((x) => x.itemId)).toEqual(["prelude"]);
    expect(s.delivery).toEqual({ servableThrough: 1, itemsGenerated: 7, servableThroughAct: -1, pausedAtIndex: 1 });
    expect(JSON.stringify(s)).not.toContain("act-2-introduction");
    expect(s.acts.map((a) => a.servable)).toEqual([false, false]);
  });

  it("from item events alone, stops at the first unservable event and at a gap", () => {
    /* MUTATION THAT KILLS THIS: skip an unservable event instead of stopping
       (`continue` for `break`). Item 5, after the unservable item 4, would
       be served. Ran it — red. */
    const paused = snapshotFrom(JOB, withEvents(EMPTY_JOB_PROGRESS, event(0), event(1), event(2), event(3), event(4, false), event(5)), 0, AT)!;
    expect(paused.items).toEqual(ITEMS.slice(0, 4));
    expect(paused.delivery?.pausedAtIndex).toBe(4);
    expect(paused.title).toBeNull();
    expect(paused.acts).toEqual([]);

    const gap = snapshotFrom(JOB, withEvents(EMPTY_JOB_PROGRESS, event(0), event(5)), 0, AT)!;
    expect(gap.items).toEqual([ITEMS[0]]);
    expect(gap.delivery).toEqual({ servableThrough: 1, itemsGenerated: 6, servableThroughAct: -1, pausedAtIndex: null });
  });

  it("inside the partial the act verdict wins; past it, item events extend the prefix", () => {
    /* MUTATION THAT KILLS THIS: read servability from the event first
       (`ev ? ev.servable : i < partialServable`). Item 1's stale unservable
       event would cut a prefix the partial serves. Ran it — red. */
    let p = progressWithPartial(EMPTY_JOB_PROGRESS, partial(4, [true]));
    p = withEvents(p, event(1, false), event(4), event(5));
    const s = snapshotFrom(JOB, p, 0, AT)!;
    expect(s.items).toEqual(ITEMS.slice(0, 6));
    expect(s.itemStates.map((x) => x.check)).toEqual(["prelude", "unchecked-seam", "tape", "unchecked-seam", "unchecked-seam", "tape"]);
    expect(s.title).toBe("Fire, smoke and time");
    expect(s.acts).toEqual([
      { index: 0, title: "Act 1: Fire", status: "ready", servable: true },
      { index: 1, title: "Act 2: Smoke", status: "pending", servable: false }
    ]);
    expect(s.delivery?.servableThroughAct).toBe(0);
    expect(s.runtimeSecSoFar).toBe(400);
  });

  it("is null before a Foray id exists, and numbers each snapshot prevSeq + 1", () => {
    /* MUTATION THAT KILLS THIS: `seq: prevSeq` — two publishes carry one seq,
       and a poller drops the second. Ran it — red. */
    expect(snapshotFrom(JOB, EMPTY_JOB_PROGRESS, 0, AT)).toBeNull();
    const p = withEvents(EMPTY_JOB_PROGRESS, event(0));
    expect(snapshotFrom(JOB, p, 0, AT)!.seq).toBe(1);
    expect(snapshotFrom(JOB, p, 41, AT)!.seq).toBe(42);
    expect(snapshotFrom(JOB, p, 0, AT)!.status).toBe("running");
  });
});

describe("JobSnapshotSchema — the contract", () => {
  const valid = (): JobSnapshot => snapshotFrom(JOB, progressWithPartial(EMPTY_JOB_PROGRESS, partial(7, [true, true])), 0, AT)!;

  it("has no prompt field and refuses a snapshot carrying one", () => {
    /* MUTATION THAT KILLS THIS: drop `.strict()` on the snapshot object. A
       `prompt` key then validates and a sink writes it. Ran it — red. */
    expect(JobSnapshotSchema.safeParse(valid()).success).toBe(true);
    expect(Object.keys(JobSnapshotSchema.innerType().shape)).not.toContain("prompt");
    expect(JobSnapshotSchema.safeParse({ ...valid(), prompt: "the history of grilling" }).success).toBe(false);
  });

  it("refuses itemStates out of step with items, and a servableThrough that is not the item count", () => {
    /* MUTATION THAT KILLS THIS: delete the servableThrough refinement. A row
       claiming more servable items than it carries validates. Ran it — red. */
    const s = valid();
    expect(JobSnapshotSchema.safeParse({ ...s, itemStates: s.itemStates.slice(1) }).success).toBe(false);
    expect(JobSnapshotSchema.safeParse({ ...s, delivery: { ...s.delivery!, servableThrough: s.items.length + 1 } }).success).toBe(false);
    expect(JobSnapshotSchema.safeParse({ ...s, forayId: "../x" }).success).toBe(false);
  });

  it("closedSnapshot maps the outcome, bumps seq and takes only a short code as detail", () => {
    /* MUTATION THAT KILLS THIS: drop the JOB_DETAIL_PATTERN check. A free-text
       error message — which can quote the prompt — lands on the row. Ran it — red. */
    const s = valid();
    expect(closedSnapshot(s, "complete", AT)).toMatchObject({ status: "complete", seq: 2, closed: { outcome: "complete" } });
    expect(closedSnapshot(s, "aborted", AT, "refused-partial")).toMatchObject({ status: "failed", closed: { outcome: "aborted", detail: "refused-partial" } });
    expect(() => closedSnapshot(s, "failed", AT, "Error: could not plan the history of grilling")).toThrow(/short code/);
  });

  it("refuses Foray ids that could name another path", () => {
    /* MUTATION THAT KILLS THIS: allow `.` and `/` in JOB_FORAY_ID_PATTERN.
       `../x` would build a path outside the job directory. Ran it — red. */
    for (const bad of ["../x", "a/b", "a.b", "", "A-B", "x".repeat(121)]) expect(isJobForayId(bad)).toBe(false);
    expect(isJobForayId(FORAY)).toBe(true);
    expect(() => jobSnapshotFilename("../x")).toThrow(/refused Foray id/);
    expect(jobSnapshotFilename(FORAY)).toBe(`${FORAY}.job.json`);
  });
});

describe("FileJobSink", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-jobs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (): JobSnapshot => JSON.parse(fs.readFileSync(path.join(dir, `${FORAY}.job.json`), "utf8")) as JobSnapshot;

  it("writes <forayId>.job.json atomically, refuses a non-increasing seq, and closes with the outcome", async () => {
    /* MUTATION THAT KILLS THIS: drop the strictly-increasing seq check in
       publish. A replayed snapshot overwrites a newer row. Ran it — red. */
    const sink = new FileJobSink(dir, () => new Date(AT));
    const p = withEvents(EMPTY_JOB_PROGRESS, event(0), event(1));
    await sink.publish(snapshotFrom(JOB, p, 0, AT)!);
    await sink.publish(snapshotFrom(JOB, p, 1, AT)!);
    expect(read().seq).toBe(2);
    await expect(sink.publish(snapshotFrom(JOB, p, 1, AT)!)).rejects.toThrow(/strictly increase/);
    await sink.close("complete");
    expect(read()).toMatchObject({ seq: 3, status: "complete", closed: { outcome: "complete" } });
    expect(fs.readdirSync(dir)).toEqual([`${FORAY}.job.json`]);
  });

  it("refuses to write a snapshot carrying a prompt, and leaves no temporary file", async () => {
    /* MUTATION THAT KILLS THIS: write without JobSnapshotSchema.parse. The
       prompt reaches disk. Ran it — red. */
    const sink = new FileJobSink(dir);
    const s = snapshotFrom(JOB, withEvents(EMPTY_JOB_PROGRESS, event(0)), 0, AT)!;
    await expect(sink.publish({ ...s, prompt: "the history of grilling" } as JobSnapshot)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("close before any publish writes nothing (no Foray id, no row)", async () => {
    /* MUTATION THAT KILLS THIS: drop `if (!this.last) return` in close. It
       throws on a null snapshot. Ran it — red. */
    await new FileJobSink(dir).close("failed", "rejected");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a resumed run continues the job on disk: same jobId, seq above the file's; another author's file is not overwritten", async () => {
    /* MUTATION THAT KILLS THIS: start seqOffset at 0 for an existing file.
       The restarted run writes seq 1 over seq 2 and a poller ignores it.
       Ran it — red. */
    const p = withEvents(EMPTY_JOB_PROGRESS, event(0));
    const first = new FileJobSink(dir);
    await first.publish(snapshotFrom(JOB, p, 0, AT)!);
    await first.publish(snapshotFrom(JOB, p, 1, AT)!);

    const second = new FileJobSink(dir);
    await second.publish(snapshotFrom({ ...JOB, jobId: "job-2" }, p, 0, AT)!);
    expect(read()).toMatchObject({ jobId: "job-1", seq: 3 });

    const stranger = new FileJobSink(dir);
    await expect(stranger.publish(snapshotFrom({ ...JOB, authorId: "someone-else" }, p, 0, AT)!)).rejects.toThrow(/another author/);
    expect(read()).toMatchObject({ authorId: "founder-1", seq: 3 });
  });
});
