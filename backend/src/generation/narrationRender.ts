import type { ItemReadyEvent } from "./deliveryTimeline";
import type { JobAudioState } from "./jobSink";

/**
 * GV-74 (docs/roadmap/generation-v2.md, #1286; from W6-07; covers GP-08,
 * R1-13, R1-15): the backend RENDER STAGE — narration rendering inside the
 * generation run, per item and in play order, without ever blocking first
 * audio.
 *
 * WHAT IT DOES. Every servable narration item the run makes (GV-33's
 * `ItemReadyEvent`, servable under GV-21's per-act policy) becomes one render
 * job, handed to a `NarrationRenderClient` (the spool client,
 * `cli/spoolRenderClient.ts`, writes GV-22's `foray-render-job/1` files for
 * the resident worker). A job's `priority` is the item's index, so the worker
 * renders the prelude first and every later line in play order. What came
 * back (`results()`) folds into two places: the job snapshot's per-item audio
 * state (`audioStateFor`, read by `jobSink.snapshotFrom`) and the report's
 * `delivery.render` block (`renderReportOf`, MT-09).
 *
 * PHONE VOICE FIRST (NA-01, OQ-03's KPI reading). An item with no file is
 * still playable: the phone speaks its script. So the default audio policy,
 * `phone-voice-first`, ignores audio for readiness — first audio never waits
 * on a render, and the 30 s target holds whether or not a worker is running.
 * `await-render` (opt-in) holds a narration item back from the served prefix
 * until its render has a result; a FAILED render falls back to the phone
 * voice, so a broken worker never strands the listener once it has answered.
 *
 * NO URL WITHOUT AN UPLOAD. `audio_url` is only ever the done record's
 * `public_url`, which GV-22's spool-upload writes after a confirmed upload. A
 * rendered file that is not uploaded is not reachable by the phone, so it
 * reads `phone-voice` and carries no URL.
 *
 * Pure: types, pure functions and one small in-memory tracker. No fs (a
 * generation/ module may not write files), no env, no clock — every time is
 * on the event or the done record.
 */

/** The two audio policies. `phone-voice-first` is the default and the only
 * one that never delays first audio. */
export type AudioPolicy = "phone-voice-first" | "await-render";

export const AUDIO_POLICIES: readonly AudioPolicy[] = ["phone-voice-first", "await-render"];
export const DEFAULT_AUDIO_POLICY: AudioPolicy = "phone-voice-first";

export function isAudioPolicy(v: unknown): v is AudioPolicy {
  return typeof v === "string" && (AUDIO_POLICIES as readonly string[]).includes(v);
}

/** One `{term, ipa}` pronunciation pin (GV-22's job `lexicon`). */
export interface RenderLexiconEntry {
  term: string;
  ipa: string;
}

/** One narration line to render. `priority` is the item's index in the
 * Foray (prelude = 0): the worker takes the minimum first. */
export interface RenderJob {
  jobId: string;
  forayId: string;
  itemId: string;
  script: string;
  priority: number;
  lexicon?: RenderLexiconEntry[];
}

/** What a render job came to: GV-22's done record, read back. `publicUrl` is
 * present only once spool-upload confirmed the upload. Times are the
 * worker's own durations (`timings`), never a wall-clock stamp. */
export interface RenderResult {
  jobId: string;
  itemId: string;
  status: "rendered" | "failed";
  /** The rendered object's key (the done record's `entry.key`). */
  key?: string;
  publicUrl?: string;
  audioSec?: number;
  renderMs?: number;
  queuedMs?: number;
}

export interface NarrationRenderClient {
  enqueue(jobs: RenderJob[]): Promise<void>;
  results(): Promise<RenderResult[]>;
}

/** GV-22's job id: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (render-foray.py
 * JOB_ID_RE). */
export const RENDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Two FNV-1a passes (different offsets) over the UTF-16 code units, as 16
 * hex characters. A content key, not a security hash: it only has to change
 * when the line's text does. */
function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * The job id for one item: `<forayId>.i<index>.<hash>`. The hash covers the
 * Foray, the item and its script, so a resumed attempt that re-emits the same
 * line gets the same id (it is not rendered twice) and a rewritten line gets
 * a new one. Only id-safe characters survive, so no id can walk out of the
 * spool.
 */
export function renderJobIdFor(forayId: string, index: number, itemId: string, script: string): string {
  const slug = forayId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 80);
  const head = /^[A-Za-z0-9]/.test(slug) ? slug : `f${slug}`;
  const id = `${head}.i${index}.${contentHash(`${forayId}\u0000${itemId}\u0000${script}`)}`;
  if (!RENDER_JOB_ID_PATTERN.test(id)) throw new Error(`renderJobIdFor: built an unsafe job id ${JSON.stringify(id)}`);
  return id;
}

/**
 * The render jobs one item-ready event makes: one for a narration item with a
 * script, and only when the item is servable (GV-21's policy, carried on the
 * event). A tape segment or a jingle is audio already; an unservable item is
 * never played in this run, so rendering it would only spend the worker.
 */
export function renderJobsFor(ev: ItemReadyEvent, opts: { lexicon?: readonly RenderLexiconEntry[] } = {}): RenderJob[] {
  if (!ev.servable) return [];
  const item = ev.item;
  if (item.type !== "narration") return [];
  const script = item.script.trim();
  if (!script) return [];
  return [
    {
      jobId: renderJobIdFor(ev.forayId, ev.index, ev.itemId, script),
      forayId: ev.forayId,
      itemId: ev.itemId,
      script,
      priority: ev.index,
      ...(opts.lexicon && opts.lexicon.length ? { lexicon: opts.lexicon.map((e) => ({ term: e.term, ipa: e.ipa })) } : {})
    }
  ];
}

/** The latest result for an item (the last in the list wins). Matched by
 * item id only: the caller hands in results for each item's CURRENT line
 * (`NarrationRenderTracker.results`), never a superseded line's. */
export function resultFor(itemId: string, results: readonly RenderResult[]): RenderResult | undefined {
  for (let i = results.length - 1; i >= 0; i--) if (results[i]!.itemId === itemId) return results[i];
  return undefined;
}

/** A URL the phone may fetch: http(s) only. */
export function isPublicAudioUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\/[^\s]+$/.test(v);
}

/**
 * An item's audio state:
 * - `rendered`: a rendered result whose upload was confirmed (`publicUrl`);
 * - `phone-voice`: the render failed, or rendered but is not uploaded (the
 *   phone cannot reach the file), or — under `phone-voice-first` — there is
 *   no result yet: the phone speaks the script now;
 * - `pending`: under `await-render`, no result yet: the item waits.
 */
export function audioStateFor(itemId: string, results: readonly RenderResult[], policy: AudioPolicy): JobAudioState {
  const r = resultFor(itemId, results);
  if (!r) return policy === "await-render" ? "pending" : "phone-voice";
  if (r.status === "rendered" && isPublicAudioUrl(r.publicUrl)) return "rendered";
  return "phone-voice";
}

/** Whether audio lets the item be served: always under `phone-voice-first`;
 * under `await-render` only once its render has a result (rendered or failed). */
export function audioReadyFor(itemId: string, results: readonly RenderResult[], policy: AudioPolicy): boolean {
  return audioStateFor(itemId, results, policy) !== "pending";
}

const finiteNonNegative = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * GV-22's done record (`SPOOL/done/<job_id>.json`: `{job_id, status, entry |
 * error, timings:{queued_ms, render_ms, audio_sec}, public_url?}`) read back
 * as a result for the job it answers. Null when the document is not a done
 * record for that job. `publicUrl` is carried only when the record holds an
 * http(s) `public_url` on a rendered job — the only way an `audio_url` can
 * ever be written.
 */
export function renderResultFromDone(job: Pick<RenderJob, "jobId" | "itemId">, doc: unknown): RenderResult | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.job_id !== job.jobId) return null;
  if (d.status !== "rendered" && d.status !== "failed") return null;
  const timings = d.timings && typeof d.timings === "object" ? (d.timings as Record<string, unknown>) : {};
  const queuedMs = finiteNonNegative(timings.queued_ms);
  const renderMs = finiteNonNegative(timings.render_ms);
  const base: RenderResult = {
    jobId: job.jobId,
    itemId: job.itemId,
    status: d.status,
    ...(queuedMs !== undefined ? { queuedMs } : {}),
    ...(renderMs !== undefined ? { renderMs } : {})
  };
  if (d.status === "failed") return base;
  const entry = d.entry && typeof d.entry === "object" ? (d.entry as Record<string, unknown>) : null;
  if (!entry) return { ...base, status: "failed" };
  const key = typeof entry.key === "string" && entry.key ? entry.key : undefined;
  const audioSec = finiteNonNegative(timings.audio_sec) ?? finiteNonNegative(entry.duration_sec);
  return {
    ...base,
    ...(key !== undefined ? { key } : {}),
    ...(audioSec !== undefined ? { audioSec } : {}),
    ...(isPublicAudioUrl(d.public_url) ? { publicUrl: d.public_url } : {})
  };
}

/** `report.json`'s `delivery.render` (MT-09). */
export interface RenderReport {
  /** When the first rendered line came back, in ms since the attempt started
   * (the delivery timeline's clock): the item's `readyAtMs` (when it was
   * enqueued) plus the worker's queued and render times. Read against
   * `delivery.firstServableMs` (first audio). Null when nothing rendered in
   * the final attempt. */
  firstRenderedMs: number | null;
  /** Seconds of narration audio rendered. */
  narrationSec: number;
  /** Seconds the worker spent rendering those lines (sum of `render_ms`). */
  renderWallSec: number;
  /** narrationSec / renderWallSec: audio seconds per render second (> 1 is
   * faster than real time). Null when nothing rendered. */
  realtimeFactor: number | null;
  /** Render jobs that failed (those items fall back to the phone voice). */
  failed: number;
}

/** A job the tracker enqueued: when (the event's `readyAtMs`) and in which
 * attempt. */
export interface TrackedRenderJob {
  job: RenderJob;
  enqueuedAtMs: number;
  attempt: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The render block from the jobs enqueued and the results read back. Only
 * results for enqueued jobs count. `firstRenderedMs` uses the final attempt's
 * jobs only: an earlier attempt's clock started elsewhere.
 */
export function renderReportOf(jobs: readonly TrackedRenderJob[], results: readonly RenderResult[], finalAttempt: number): RenderReport {
  const byJob = new Map(jobs.map((j) => [j.job.jobId, j]));
  const latest = new Map<string, RenderResult>();
  for (const r of results) if (byJob.has(r.jobId)) latest.set(r.jobId, r);
  let firstRenderedMs: number | null = null;
  let narrationSec = 0;
  let renderMs = 0;
  let failed = 0;
  for (const [jobId, r] of latest) {
    if (r.status === "failed") {
      failed++;
      continue;
    }
    if (typeof r.audioSec === "number" && Number.isFinite(r.audioSec) && r.audioSec > 0) narrationSec += r.audioSec;
    if (typeof r.renderMs === "number" && Number.isFinite(r.renderMs) && r.renderMs >= 0) renderMs += r.renderMs;
    const tracked = byJob.get(jobId)!;
    if (tracked.attempt === finalAttempt && typeof r.renderMs === "number" && Number.isFinite(r.renderMs)) {
      const at = tracked.enqueuedAtMs + (typeof r.queuedMs === "number" && Number.isFinite(r.queuedMs) ? r.queuedMs : 0) + r.renderMs;
      if (firstRenderedMs === null || at < firstRenderedMs) firstRenderedMs = at;
    }
  }
  const renderWallSec = round3(renderMs / 1000);
  return {
    firstRenderedMs: firstRenderedMs === null ? null : Math.round(firstRenderedMs),
    narrationSec: round3(narrationSec),
    renderWallSec,
    realtimeFactor: renderWallSec > 0 && narrationSec > 0 ? round3(narrationSec / renderWallSec) : null,
    failed
  };
}

/**
 * One prompt's render stage, kept across resume attempts like the job sink:
 * a job already enqueued (same id) is never enqueued again. The driver calls
 * `beginAttempt` per pipeline attempt, `onItemReady` per item event and
 * `refresh` before it reads the results. An enqueue failure throws to the
 * caller (which warns: a render never costs the Foray) and tracks no job.
 *
 * ONE LINE, ONE JOB. Results are folded by item id (`resultFor`), so the
 * tracker serves only the results of each item's CURRENT job: the job of the
 * last event that item had. A resumed attempt can re-emit an item with a
 * rewritten script (a new job id); the old line's render is then dropped
 * from `results` and from the report, so the phone never plays audio that
 * does not match the line's text — it speaks the new script (or, under
 * await-render, waits for the new render).
 */
export class NarrationRenderTracker {
  private readonly tracked = new Map<string, TrackedRenderJob>();
  /** itemId -> the job id of that item's latest event (absent when the
   * latest event made no job: an unservable or empty line). */
  private readonly currentJob = new Map<string, string>();
  private latest: RenderResult[] = [];
  private attempt = 0;

  constructor(
    private readonly client: NarrationRenderClient,
    readonly policy: AudioPolicy = DEFAULT_AUDIO_POLICY
  ) {}

  beginAttempt(): void {
    this.attempt++;
  }

  /** Enqueues the event's jobs that are not enqueued yet; returns them. The
   * event's line becomes the item's current one before the enqueue, so a
   * failed enqueue still never serves an older line's audio. */
  async onItemReady(ev: ItemReadyEvent): Promise<RenderJob[]> {
    const jobs = renderJobsFor(ev);
    this.currentJob.delete(ev.itemId);
    for (const job of jobs) this.currentJob.set(job.itemId, job.jobId);
    const fresh = jobs.filter((j) => !this.tracked.has(j.jobId));
    if (!fresh.length) return [];
    await this.client.enqueue(fresh);
    for (const job of fresh) this.tracked.set(job.jobId, { job, enqueuedAtMs: ev.readyAtMs, attempt: this.attempt });
    return fresh;
  }

  private isCurrent(jobId: string, itemId: string): boolean {
    return this.currentJob.get(itemId) === jobId;
  }

  /** Reads the client's results, keeping only this prompt's jobs. */
  async refresh(): Promise<readonly RenderResult[]> {
    const all = await this.client.results();
    this.latest = all.filter((r) => this.tracked.has(r.jobId));
    return this.results;
  }

  /** The results of each item's current job only (see ONE LINE, ONE JOB). */
  get results(): readonly RenderResult[] {
    return this.latest.filter((r) => this.isCurrent(r.jobId, r.itemId));
  }

  get jobs(): TrackedRenderJob[] {
    return [...this.tracked.values()];
  }

  /** `delivery.render` over each item's current job: a superseded line's
   * render (or failure) is not the Foray's narration. */
  report(): RenderReport {
    const current = this.jobs.filter((t) => this.isCurrent(t.job.jobId, t.job.itemId));
    return renderReportOf(current, this.results, this.attempt);
  }
}
