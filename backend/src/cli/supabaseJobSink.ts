import {
  closedSnapshot,
  JobSnapshotSchema,
  type GenerationJobSink,
  type JobCloseOutcome,
  type JobCloseTarget,
  type JobSnapshot
} from "../generation/jobSink";

/**
 * GV-59 (docs/roadmap/generation-v2.md, #1286; from W6-18; D9): the job row in
 * Supabase. The same `GenerationJobSink` as `cli/fileJobSink.ts` (GV-44), but
 * the row is `public.generation_jobs` (backend/migrations/supabase/
 * 0007_generation_jobs.sql), written through PostgREST with the service-role
 * key (D8) and read by the author's phone under RLS.
 *
 * DARK. Nothing in the repo constructs this class: the Spark generation worker
 * (GV-105) builds one per claimed job. Until 0007 is applied and the key is on
 * the Spark it has nothing to talk to. No new dependency: `fetch` is injected
 * (required, so no test and no caller reaches the network by default).
 *
 * ONE SINK, ONE ROW: the row's uuid (`jobId`, from claim_generation_job) is
 * fixed at construction. A snapshot's own jobId is replaced by it, as
 * FileJobSink replaces it with the carried job's.
 *
 * EACH PUBLISH IS ONE GUARDED PATCH:
 *   PATCH /rest/v1/generation_jobs?id=eq.<job>&author_id=eq.<author>
 *         &seq=lt.<n>&status=in.(claimed,running)
 * so the row moves only forward. A stale snapshot (a laggard process, a retry
 * that lost the race), a job the author cancelled, a closed job, or another
 * author's row matches nothing: PostgREST answers 200 with no rows and the
 * publish is a no-op (`lastOutcome()` says "unchanged"). The body is
 * {status, seq, snapshot} and NEVER a prompt: the snapshot is gated by the
 * strict `JobSnapshotSchema` (no prompt field, strict item schemas), and the
 * whole body is then scanned once more for a key named `prompt` at any depth
 * (`bodyHasPromptKey`), so a later loosening of either schema still cannot
 * put the author's prompt back into a row the worker writes.
 *
 * SEQ CONTINUES ACROSS PROCESSES, AND THE SERVED PREFIX NEVER SHRINKS — the
 * same two rules as FileJobSink, read from the row instead of a file. Before
 * its first write the sink GETs the row once: its seq offsets this process's
 * numbering (a resumed process starts at 1), and its snapshot is the floor a
 * new snapshot must extend (only a tail is new).
 *
 * PRIVACY. The service key is sent only in the two auth headers and never
 * appears in an error message. Errors carry the HTTP status, never a body.
 */

/** The slice of `fetch` this sink uses; the worker passes `globalThis.fetch`. */
export type JobSinkFetch = (
  url: string,
  init: { method: "GET" | "PATCH"; headers: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SupabaseJobSinkOptions {
  /** The project URL, e.g. https://<ref>.supabase.co (no path). */
  baseUrl: string;
  /** The service-role key (D8: on the Spark only). */
  serviceKey: string;
  /** The generation_jobs row's uuid, as claim_generation_job returned it. */
  jobId: string;
  fetch: JobSinkFetch;
  clock?: () => Date;
}

/** What the last write attempt did: "written" (the row took it), "unchanged"
 * (the guard matched nothing), "floor" (not sent: it served less than the row
 * already does), or null before any attempt. */
export type SupabaseJobWriteOutcome = "written" | "unchanged" | "floor" | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = "generation_jobs";
/** The row states a worker may still write: never queued (not claimed), never
 * complete / failed / cancelled (closed, or the author stopped it). */
const OPEN_FOR_WORKER = "in.(claimed,running)";

interface CarriedRow {
  authorId: string;
  seq: number;
  snapshot: JobSnapshot | null;
}

export class SupabaseJobSink implements GenerationJobSink {
  private readonly base: string;
  private readonly key: string;
  private readonly jobId: string;
  private readonly fetchImpl: JobSinkFetch;
  private readonly clock: () => Date;
  private last: JobSnapshot | null = null;
  private carried: { authorId: string; seqOffset: number; rowSeq: number } | null = null;
  private outcome: SupabaseJobWriteOutcome = null;

  constructor(opts: SupabaseJobSinkOptions) {
    if (!/^https?:\/\/[^/?#]+\/?$/.test(opts.baseUrl)) throw new Error("SupabaseJobSink: baseUrl must be the project origin (https://<ref>.supabase.co)");
    if (!opts.serviceKey) throw new Error("SupabaseJobSink: a service key is required");
    if (!UUID.test(opts.jobId)) throw new Error(`SupabaseJobSink: jobId must be the row's uuid, got ${JSON.stringify(String(opts.jobId).slice(0, 60))}`);
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.key = opts.serviceKey;
    this.jobId = opts.jobId.toLowerCase();
    this.fetchImpl = opts.fetch;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The last snapshot the row took from this sink (or carried), a copy. */
  lastSnapshot(): JobSnapshot | null {
    return this.last ? (JSON.parse(JSON.stringify(this.last)) as JobSnapshot) : null;
  }

  lastOutcome(): SupabaseJobWriteOutcome {
    return this.outcome;
  }

  async publish(s: JobSnapshot): Promise<void> {
    if (this.last && s.forayId !== this.last.forayId) {
      throw new Error(`SupabaseJobSink: one sink is one job (${this.last.forayId}); refused a snapshot for ${s.forayId}`);
    }
    if (!this.carried) await this.carry();
    const carried = this.carried!;
    if (s.authorId.toLowerCase() !== carried.authorId) throw new Error(`SupabaseJobSink: job ${this.jobId} belongs to another author than the snapshot's`);
    const out: JobSnapshot = { ...s, jobId: this.jobId, seq: s.seq + carried.seqOffset };
    if (this.last && out.seq <= this.last.seq) {
      throw new Error(`SupabaseJobSink: seq must strictly increase (got ${out.seq} after ${this.last.seq})`);
    }
    if (this.last && !extendsServed(this.last, out)) {
      this.outcome = "floor";
      return;
    }
    await this.write(out);
  }

  /**
   * Writes the final row. Unlike a file, the row is named by the sink's jobId,
   * so `target` is needed only to check the author. With a snapshot (this
   * sink's last, or the row's own) the final snapshot is GV-44's
   * closedSnapshot; with none — a run that failed before its first act — only
   * the row's status and seq move, so a claimed job never reads "claimed"
   * forever.
   */
  async close(outcome: JobCloseOutcome, detail?: string, target?: JobCloseTarget): Promise<void> {
    if (!this.carried) await this.carry();
    const carried = this.carried!;
    if (target && target.authorId.toLowerCase() !== carried.authorId) throw new Error("SupabaseJobSink: close names another author than the job row");
    const at = this.clock().toISOString();
    if (this.last) {
      await this.write(closedSnapshot(this.last, outcome, at, detail));
      return;
    }
    const seq = carried.rowSeq + 1;
    await this.patch(carried.authorId, seq, { status: outcome === "complete" ? "complete" : "failed", seq });
  }

  /** One GET of the row before the first write: its author, seq and snapshot.
   * The callers check the author against it. */
  private async carry(): Promise<void> {
    const url = `${this.base}/rest/v1/${TABLE}?id=eq.${this.jobId}&select=author_id,seq,snapshot`;
    const res = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
    if (!res.ok) throw new Error(`SupabaseJobSink: reading job ${this.jobId} failed (HTTP ${res.status})`);
    const rows = await res.json();
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) throw new Error(`SupabaseJobSink: no job row ${this.jobId} (the sink never creates one)`);
    const prior = readRow(row);
    this.carried = { authorId: prior.authorId, seqOffset: prior.seq, rowSeq: prior.seq };
    this.last = prior.snapshot;
  }

  private async write(snapshot: JobSnapshot): Promise<void> {
    /* A gate, not a transform: the snapshot goes as given. */
    JobSnapshotSchema.parse(snapshot);
    if (!UUID.test(snapshot.authorId)) throw new Error("SupabaseJobSink: authorId must be the author's auth uid");
    const wrote = await this.patch(snapshot.authorId, snapshot.seq, { status: snapshot.status, seq: snapshot.seq, snapshot });
    if (wrote) this.last = JSON.parse(JSON.stringify(snapshot)) as JobSnapshot;
  }

  /** The guarded PATCH. True when the row took it. */
  private async patch(authorId: string, seq: number, body: Record<string, unknown>): Promise<boolean> {
    if (!Number.isInteger(seq) || seq < 1) throw new Error(`SupabaseJobSink: seq must be a positive integer, got ${seq}`);
    if (bodyHasPromptKey(body)) throw new Error("SupabaseJobSink: refused a body carrying a prompt field");
    const url =
      `${this.base}/rest/v1/${TABLE}?id=eq.${this.jobId}&author_id=eq.${authorId.toLowerCase()}` +
      `&seq=lt.${seq}&status=${OPEN_FOR_WORKER}&select=seq`;
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: { ...this.headers(), "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`SupabaseJobSink: writing job ${this.jobId} seq ${seq} failed (HTTP ${res.status})`);
    const rows = await res.json();
    const wrote = Array.isArray(rows) && rows.length > 0;
    this.outcome = wrote ? "written" : "unchanged";
    if (wrote && this.carried) this.carried.rowSeq = seq;
    return wrote;
  }

  private headers(): Record<string, string> {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, Accept: "application/json" };
  }
}

function readRow(row: Record<string, unknown>): CarriedRow {
  const authorId = row.author_id;
  const seq = row.seq;
  if (typeof authorId !== "string" || !UUID.test(authorId)) throw new Error("SupabaseJobSink: the job row has no readable author_id");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) throw new Error("SupabaseJobSink: the job row has no readable seq");
  /* A row whose snapshot does not parse describes nothing: it is replaced,
     as FileJobSink replaces an unreadable file. */
  const parsed = row.snapshot == null ? null : JobSnapshotSchema.safeParse(row.snapshot);
  const snapshot = parsed && parsed.success ? (row.snapshot as JobSnapshot) : null;
  return { authorId: authorId.toLowerCase(), seq, snapshot };
}

/** A key named `prompt` (any case), at any depth. */
export function bodyHasPromptKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(bodyHasPromptKey);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k.toLowerCase() === "prompt" || bodyHasPromptKey(v));
  }
  return false;
}

/** True when `next` serves every item `prior` served, in the same order and
 * under the same ids (only a tail is new). FileJobSink's rule. */
function extendsServed(prior: JobSnapshot, next: JobSnapshot): boolean {
  if (next.itemStates.length < prior.itemStates.length) return false;
  return prior.itemStates.every((st, i) => next.itemStates[i]!.itemId === st.itemId);
}
