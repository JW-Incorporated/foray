import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  closedSnapshot,
  jobSnapshotFilename,
  JobSnapshotSchema,
  type GenerationJobSink,
  type JobCloseOutcome,
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
 */
export class FileJobSink implements GenerationJobSink {
  private last: JobSnapshot | null = null;
  /** Set on the first publish: the job on disk this run continues, if any. */
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
    if (!this.carried) this.carried = this.continueFrom(file, s);
    const out: JobSnapshot = { ...s, jobId: this.carried.jobId, seq: s.seq + this.carried.seqOffset };
    if (this.last && out.seq <= this.last.seq) {
      throw new Error(`FileJobSink: seq must strictly increase (got ${out.seq} after ${this.last.seq})`);
    }
    this.write(file, out);
  }

  async close(outcome: JobCloseOutcome, detail?: string): Promise<void> {
    if (!this.last) return;
    this.write(this.filePathFor(this.last.forayId), closedSnapshot(this.last, outcome, this.clock().toISOString(), detail));
  }

  private continueFrom(file: string, s: JobSnapshot): { jobId: string; seqOffset: number } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { jobId: s.jobId, seqOffset: 0 };
    }
    let prior: JobSnapshot;
    try {
      prior = JobSnapshotSchema.parse(JSON.parse(raw)) as JobSnapshot;
    } catch {
      /* An unreadable file is replaced: it describes nothing. */
      return { jobId: s.jobId, seqOffset: 0 };
    }
    if (prior.authorId !== s.authorId) {
      throw new Error(`FileJobSink: ${path.basename(file)} belongs to another author; refused to overwrite it`);
    }
    return { jobId: prior.jobId, seqOffset: prior.seq };
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
