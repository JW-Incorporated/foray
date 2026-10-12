import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  closedSnapshot,
  jobSnapshotFilename,
  JobSnapshotSchema,
  type GenerationJobSink,
  type JobCloseOutcome,
  type JobCloseTarget,
  type JobSnapshot
} from "../generation/jobSink";

/**
 * GV-44 (docs/roadmap/generation-v2.md, #1286; from W6-03): the file-backed job
 * row. It lives in cli/ because generation/ may not write files
 * (promptNoPersistence.test.ts); a Supabase sink (W6-18, GV-59) implements the
 * same `GenerationJobSink` later.
 *
 * ONE FILE PER FORAY: `<jobDir>/<forayId>.job.json`, the id checked against
 * `JOB_FORAY_ID_PATTERN` before any path is built. Every write is atomic (a
 * temporary file in the same directory, then a rename), so a reader never sees
 * half a snapshot. Every snapshot is checked against `JobSnapshotSchema` before
 * it is written: a snapshot carrying a prompt (or any unknown key) is refused.
 *
 * SEQ CONTINUES ACROSS PROCESSES. A resumed run of the same Foray (G-30's
 * "re-run to resume" keeps the banked Foray id) starts its own numbering at 1;
 * the sink continues the job already on disk instead — same jobId, seq above
 * the file's — so a poller's "skip anything not newer" rule holds across the
 * restart. A file on disk for the same id but another author is never
 * overwritten.
 *
 * THE SERVED PREFIX NEVER SHRINKS (the brief's "`items` only grows"). A
 * resumed process starts from an empty progress: its banked acts fire no
 * events, so its first snapshots carry only the prelude (the walk stops at
 * the gap after it) until its first partial candidate names every item again.
 * Written over a file that already served N items, with a higher seq, that
 * would make a poller's row fall to one item and later re-append items it
 * had queued. So the row already written (the carried file's, then this
 * sink's own last write) is a FLOOR: a snapshot whose items do not extend it
 * (shorter, or a different item id at a shared index) is not written, and the
 * row stays as it was. The carried file also seeds `close`, so a resumed
 * process that publishes nothing still closes the job it continues.
 */
export class FileJobSink implements GenerationJobSink {
  private last: JobSnapshot | null = null;
  /** Set on the first publish (or a targeted close): the job on disk this
   * run continues, if any. */
  private carried: { jobId: string; seqOffset: number } | null = null;

  constructor(
    private readonly jobDir: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** The file a Foray id's job lives in. Throws on a refused id. */
  filePathFor(forayId: string): string {
    return path.join(this.jobDir, jobSnapshotFilename(forayId));
  }

  /** The last snapshot this sink wrote (a copy), or null. */
  lastSnapshot(): JobSnapshot | null {
    return this.last ? (JSON.parse(JSON.stringify(this.last)) as JobSnapshot) : null;
  }

  async publish(s: JobSnapshot): Promise<void> {
    const file = this.filePathFor(s.forayId);
    if (this.last && s.forayId !== this.last.forayId) {
      throw new Error(`FileJobSink: one sink is one job (${this.last.forayId}); refused a snapshot for ${s.forayId}`);
    }
    if (!this.carried) this.carry(file, s.authorId, s.jobId);
    const carried = this.carried!;
    const out: JobSnapshot = { ...s, jobId: carried.jobId, seq: s.seq + carried.seqOffset };
    if (this.last && out.seq <= this.last.seq) {
      throw new Error(`FileJobSink: seq must strictly increase (got ${out.seq} after ${this.last.seq})`);
    }
    /* The floor: never write a row that serves less than, or other than, the
       row already written (see the class comment). */
    if (this.last && !extendsServed(this.last, out)) return;
    this.write(file, out);
  }

  /**
   * Writes the final row. `target` names the row when this sink was never
   * handed a snapshot — a resumed process whose acts were all banked fires no
   * hook, yet the job file the earlier process left must not read "running"
   * forever. Without a snapshot and without a file on disk there is no row,
   * and nothing is written.
   */
  async close(outcome: JobCloseOutcome, detail?: string, target?: JobCloseTarget): Promise<void> {
    if (!this.last && target && !this.carried) this.carry(this.filePathFor(target.forayId), target.authorId, null);
    if (!this.last) return;
    this.write(this.filePathFor(this.last.forayId), closedSnapshot(this.last, outcome, this.clock().toISOString(), detail));
  }

  /** Reads the job on disk this run continues: its jobId and seq carry over,
   * and its row becomes `last` (the floor, and what `close` closes). */
  private carry(file: string, authorId: string, jobId: string | null): void {
    /* No usable file: a publish starts the job afresh under its own jobId; a
       targeted close has nothing to continue (and carries nothing). */
    const fresh = jobId === null ? null : { jobId, seqOffset: 0 };
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      this.carried = fresh;
      return;
    }
    let prior: JobSnapshot;
    try {
      prior = JobSnapshotSchema.parse(JSON.parse(raw)) as JobSnapshot;
    } catch {
      /* An unreadable file is replaced: it describes nothing. */
      this.carried = fresh;
      return;
    }
    if (prior.authorId !== authorId) {
      throw new Error(`FileJobSink: ${path.basename(file)} belongs to another author; refused to overwrite it`);
    }
    this.carried = { jobId: prior.jobId, seqOffset: prior.seq };
    this.last = prior;
  }

  private write(file: string, snapshot: JobSnapshot): void {
    /* Validated, then written as given: the schema is a gate, not a
       transform (a stripping item schema must not rewrite an item). */
    JobSnapshotSchema.parse(snapshot);
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    fs.mkdirSync(this.jobDir, { recursive: true });
    const tmp = path.join(this.jobDir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      throw err;
    }
    this.last = JSON.parse(text) as JobSnapshot;
  }
}

/** True when `next` serves every item `prior` served, in the same order and
 * under the same ids (only a tail is new). */
function extendsServed(prior: JobSnapshot, next: JobSnapshot): boolean {
  if (next.itemStates.length < prior.itemStates.length) return false;
  return prior.itemStates.every((st, i) => next.itemStates[i]!.itemId === st.itemId);
}
