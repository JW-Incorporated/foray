import fs from "node:fs";
import path from "node:path";
import { renderResultFromDone, RENDER_JOB_ID_PATTERN, type NarrationRenderClient, type RenderJob, type RenderResult } from "../generation/narrationRender";

/**
 * GV-74 (docs/roadmap/generation-v2.md, #1286; from W6-07): the render client
 * the batch driver's `--render-spool <dir>` opens. It speaks GV-22's spool
 * layout (tools/narration/render-foray.py `--worker SPOOL`):
 *
 *   SPOOL/in/<job_id>.job.json   a `foray-render-job/1` job. Written as a
 *                                dot-file in in/ (the worker skips dot-files)
 *                                and RENAMED to its name, so the worker never
 *                                reads half a job.
 *   SPOOL/done/<job_id>.json     the worker's `{job_id, status, entry | error,
 *                                timings}`, plus `public_url` once
 *                                tools/narration/spool-upload.mjs confirmed
 *                                the upload. Read back as `RenderResult`s.
 *
 * It lives in cli/ because generation/ may not write files
 * (promptNoPersistence.test.ts). It never starts the worker and never
 * uploads: a job file is the whole hand-off. The job carries the narration
 * SCRIPT (the worker must speak it) — never the listener's prompt.
 *
 * Results are read only for jobs THIS client enqueued, so another run's done
 * records in the same spool are never folded into this Foray. A job already
 * queued, claimed or done (same id: the id hashes the line) is not written
 * again.
 */
export const RENDER_JOB_SCHEMA = "foray-render-job/1";

export interface RenderJobDocument {
  schema: typeof RENDER_JOB_SCHEMA;
  job_id: string;
  foray_id: string;
  item_id: string;
  script: string;
  priority: number;
  enqueued_at: string;
  lexicon?: { term: string; ipa: string }[];
}

/** The `foray-render-job/1` document for a job, stamped `enqueuedAt`. */
export function renderJobDocument(job: RenderJob, enqueuedAt: Date): RenderJobDocument {
  if (!RENDER_JOB_ID_PATTERN.test(job.jobId)) throw new Error(`renderJobDocument: refused job id ${JSON.stringify(job.jobId)}`);
  if (!Number.isInteger(job.priority)) throw new Error(`renderJobDocument: priority must be an integer, got ${job.priority}`);
  return {
    schema: RENDER_JOB_SCHEMA,
    job_id: job.jobId,
    foray_id: job.forayId,
    item_id: job.itemId,
    script: job.script,
    priority: job.priority,
    enqueued_at: enqueuedAt.toISOString(),
    ...(job.lexicon && job.lexicon.length ? { lexicon: job.lexicon.map((e) => ({ term: e.term, ipa: e.ipa })) } : {})
  };
}

export class SpoolRenderClient implements NarrationRenderClient {
  private readonly jobs = new Map<string, RenderJob>();

  constructor(
    private readonly spool: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private dir(name: "in" | "work" | "done"): string {
    return path.join(this.spool, name);
  }

  /** Writes each job into SPOOL/in/, in the order given (the caller's play
   * order; the worker orders by priority anyway). */
  async enqueue(jobs: RenderJob[]): Promise<void> {
    const inDir = this.dir("in");
    fs.mkdirSync(inDir, { recursive: true });
    for (const job of jobs) {
      const doc = renderJobDocument(job, this.clock());
      const name = `${job.jobId}.job.json`;
      const already =
        fs.existsSync(path.join(inDir, name)) || fs.existsSync(path.join(this.dir("work"), name)) || fs.existsSync(path.join(this.dir("done"), `${job.jobId}.json`));
      if (!already) {
        const part = path.join(inDir, `.${name}.part`);
        fs.writeFileSync(part, `${JSON.stringify(doc, null, 2)}\n`);
        fs.renameSync(part, path.join(inDir, name));
      }
      this.jobs.set(job.jobId, job);
    }
  }

  /** The done records of this client's jobs, read back. A missing or
   * unreadable record (the worker writes it atomically, so a half-written
   * one is not expected) is skipped: no result yet. */
  async results(): Promise<RenderResult[]> {
    const out: RenderResult[] = [];
    for (const job of this.jobs.values()) {
      const file = path.join(this.dir("done"), `${job.jobId}.json`);
      let doc: unknown;
      try {
        doc = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const r = renderResultFromDone(job, doc);
      if (r) out.push(r);
    }
    return out;
  }
}
