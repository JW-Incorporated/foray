/* Enclosure downloader for the transcription pipeline (issue #120, epic #115).

   WHY THIS EXISTS — transcription needs bytes on disk, and getting them there
   is a politeness and hygiene problem, not an ML one. Podcast CDNs are not our
   infrastructure; the fastest way to lose access to this catalogue is to burst
   a publisher's origin with an anonymous User-Agent. Everything below is either
   a corner case from docs/brief/05_CORNER_CASES.md or a disk-safety rule.

   THIS IS A STREAMING PIPELINE, NOT AN ARCHIVE. A file exists only between its
   download and its transcription. `cleanup(episodeId)` is the other half of
   every fetch, and the caller is expected to call it. Because a caller can
   forget — or crash between the two — the ledger below caps how much can be
   resident at once and the disk guard refuses to start on a nearly-full disk.
   That combination is deliberate: the genuinely bad failure here is not a
   crash, it is a stalled cleanup quietly filling a 15 GB laptop overnight,
   which fails *everything* on the machine, not just this tool.

   CORNER CASE #1 — the URL we fetch is the publisher's DECLARED enclosure URL,
   always. Redirects are followed (2–5 hops through podtrac/chartable is normal,
   and some prefix hosts reject HEAD), but resolution is only ever *looked at*,
   never stored or reused: the resolved CDN host goes into the report as
   `resolved_host` and nothing else. A Range resume re-requests the declared URL
   too — resuming straight from the resolved CDN would skip the publisher's
   download counter, which is precisely the cheat corner case #1 forbids.
   `tools/refresh/dai.mjs` established this split; this file follows it.

   CORNER CASE #8 — per-HOST (not per-feed) concurrency budget, a minimum gap
   between request starts so a 40-episode run does not arrive as a burst,
   exponential backoff honouring `Retry-After` on 429/5xx, and the same honest
   contact User-Agent the rest of tools/ uses.

   CORNER CASE #2 — a Range resume splices two byte ranges together and assumes
   they came from the same file. On a DAI host that assumption can be false: the
   copy is stable for one listener over a short window, not across a long gap.
   So a resume is only accepted when the server's identity for the file (ETag,
   else total length) still matches what the checkpoint recorded; otherwise we
   restart the file rather than hand the transcriber audio with a seam in it.
   `dai_suspected` changes nothing about *whether* we fetch an episode — which
   pool to transcribe is A10/T5's call, not this file's — it only makes the
   resume check strict, and it is carried into the run report.

   FAILURES ARE NAMED ERRORS (starter-kit LESSONS.md). Every refusal below
   throws a subclass of `FetchAudioError` with a `code`. A run that reports
   success while having downloaded nothing is worse than one that crashes, so
   "no episodes matched" is an error, not an empty array.

   Almost everything here is a pure function over numbers and strings, called by
   a thin network shell at the bottom. That is what makes the disk arithmetic,
   the resume logic and the URL handling testable without touching a CDN —
   fetch-audio.test.mjs downloads nothing.

   Usage:
     node tools/transcribe/fetch-audio.mjs --ids a,b,c
     node tools/transcribe/fetch-audio.mjs --topic science/physics --limit 5
     node tools/transcribe/fetch-audio.mjs --ids a --dry-run
     node tools/transcribe/fetch-audio.mjs --cleanup a,b      # discard files
     node tools/transcribe/fetch-audio.mjs --status           # checkpoint report

   Flags: --min-free-gb N (default 5), --max-resident-gb N (default 2),
          --per-host N (default 2), --gap-ms N (default 1000).                */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
/* `ACCEPT_LANGUAGE` alongside `UA` because Node's fetch otherwise sends
   `accept-language: *`, and Captivate's edge answers THAT with
   `404 Missing redirect URL` on every `episodes.captivate.fm/episode/<guid>.mp3`
   redirector -- politeness.mjs records the header being verified both ways
   (`*` -> 404, `en` -> 302) and re-verified when an ad-inflation scan without it
   drew 404 on every Captivate enclosure.

   THIS FILE WAS MISSING IT, which was not visible until something asked it for
   a Captivate episode: the probes have sent it since #316 and this downloader
   never did, so the two disagreed about how to ask the same host for the same
   file. A 404 here is not a soft failure either -- `fetchEpisode` treats a
   non-retryable status as fatal for that episode, so the whole of Captivate was
   simply un-downloadable by the pipeline, silently, on a header. */
import { ACCEPT_LANGUAGE, UA } from "../segments/politeness.mjs";

/* ------------------------------------------------------------------ config */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Downloaded audio lives here and NOTHING under it is ever committed. The
    directory is gitignored and a test asserts nothing inside is tracked. It is
    deliberately a top-level, obviously-transient name rather than a hidden dir:
    when this tool misbehaves, the first thing a human should be able to do is
    see the directory and delete it. */
export const DOWNLOAD_DIR = join(ROOT, "audio-cache");
export const CHECKPOINT_PATH = join(DOWNLOAD_DIR, "checkpoint.json");

/* Re-exported, not re-declared: `fetch-audio.test.mjs` imports `UA` from here,
   and the bytes are `politeness.mjs`'s. */
export { UA };

export const GIB = 1024 * 1024 * 1024;

/** Refuse to *start* below this much free space. Well above the biggest single
    episode (a 3 h show at 128 kbps is ~170 MB) because the guard is protecting
    the machine, not the run: leaving a laptop with under 5 GB free breaks the
    OS, the editor and the ASR model's own scratch files long before it breaks
    us. */
export const DEFAULT_MIN_FREE_BYTES = 5 * GIB;

/** Hard cap on bytes resident at once, independent of free space. ~2 GiB is a
    dozen episodes in flight; the pipeline only needs a couple. This is the
    number that bounds the damage when cleanup stops being called. */
export const DEFAULT_MAX_RESIDENT_BYTES = 2 * GIB;

export const DEFAULT_PER_HOST = 2;
export const DEFAULT_GAP_MS = 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 120_000;

/** Used only when a feed declares neither length nor duration. 128 kbps mono. */
export const BYTES_PER_SEC_ESTIMATE = 16_000;
export const FALLBACK_ESTIMATE_BYTES = 120 * 1024 * 1024;

/** How far a real download may exceed its reservation before we abort it. A
    feed's declared `length` is frequently wrong (corner case #6) so some slack
    is required, but an unbounded stream against a wrong estimate is exactly the
    "silently fills the disk" bug — so the slack is bounded and its breach is a
    named error, not a warning. */
export const SIZE_OVERRUN_FACTOR = 1.5;

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac"]);

/* ------------------------------------------------------------------ errors */

export class FetchAudioError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FetchAudioError";
    this.code = code;
    this.details = details;
  }
}
export class SelectionError extends FetchAudioError {
  constructor(message, details) { super("SELECTION", message, details); this.name = "SelectionError"; }
}
export class DiskGuardError extends FetchAudioError {
  constructor(message, details) { super("DISK_GUARD", message, details); this.name = "DiskGuardError"; }
}
export class DiskBudgetError extends FetchAudioError {
  constructor(message, details) { super("DISK_BUDGET", message, details); this.name = "DiskBudgetError"; }
}
export class SizeOverrunError extends FetchAudioError {
  constructor(message, details) { super("SIZE_OVERRUN", message, details); this.name = "SizeOverrunError"; }
}
export class HttpError extends FetchAudioError {
  constructor(message, details) { super("HTTP", message, details); this.name = "HttpError"; }
}
export class UnusableUrlError extends FetchAudioError {
  constructor(message, details) { super("UNUSABLE_URL", message, details); this.name = "UnusableUrlError"; }
}

/* -------------------------------------------------------------- selection */

/** Episodes to fetch, from `data/discover.json` items (or any array shaped like
    them). Returns `{ selected, skipped }` — `skipped` carries a reason per item
    so a run can report "3 of 10 had no enclosure" rather than silently
    shrinking. Throws when the request cannot be honoured at all: unknown ids,
    or nothing left to fetch. Never returns an empty selection. */
export function selectEpisodes(pool, { ids = null, topic = null, limit = Infinity } = {}) {
  const items = Array.isArray(pool) ? pool : Array.isArray(pool?.items) ? pool.items : null;
  if (!items) throw new SelectionError("pool is not a discover.json shape (expected .items array)");

  let candidates = items;
  if (ids && ids.length) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new SelectionError(`unknown episode ids: ${missing.join(", ")}`, { missing });
    }
    candidates = ids.map((id) => byId.get(id));
  }
  if (topic) {
    // Prefix match so `science` selects `science/physics` — the taxonomy is a
    // tree and asking for a branch should mean the branch.
    const t = String(topic).toLowerCase();
    candidates = candidates.filter((i) =>
      (i.topics || []).some((x) => {
        const s = String(x).toLowerCase();
        return s === t || s.startsWith(t + "/");
      }));
    if (!candidates.length) throw new SelectionError(`no episodes carry topic "${topic}"`, { topic });
  }
  if (!ids && !topic) throw new SelectionError("refusing to fetch the whole catalogue: pass --ids or --topic");

  const skipped = [];
  const selected = [];
  for (const item of candidates) {
    if (!item.audio_url) { skipped.push({ id: item.id, reason: "no enclosure url" }); continue; }
    if (!/^https:\/\//i.test(item.audio_url)) { skipped.push({ id: item.id, reason: "non-https enclosure" }); continue; }
    if (selected.length >= limit) break;
    selected.push(item);
  }
  if (!selected.length) {
    throw new SelectionError("every matched episode was unfetchable", { skipped });
  }
  return { selected, skipped };
}

/* -------------------------------------------------------------------- urls */

export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (_) { return null; }
}

/** Extension from the URL *path*, ignoring query strings (tracking params on
    enclosures are the norm). Unknown or absent → .mp3, which is what the
    overwhelming majority of this catalogue is; the transcoder sniffs the real
    container anyway, so the extension is a convenience, not a contract. */
export function extensionFor(url) {
  let path = "";
  try { path = new URL(url).pathname; } catch (_) { path = String(url || "").split("?")[0]; }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return ".mp3";
  const ext = path.slice(dot).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) ? ext : ".mp3";
}

/** Episode ids come from a JSON file, so they are data, not identifiers we
    control. Everything outside `[A-Za-z0-9._-]` becomes a dash, which makes a
    path separator impossible; leading dots and dashes are stripped so no id can
    produce `..` or a flag-looking filename. */
export function safeFileName(episodeId, url) {
  const base = String(episodeId ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 120);
  if (!base) throw new UnusableUrlError(`episode id yields no usable filename: ${JSON.stringify(episodeId)}`);
  return base + extensionFor(url);
}

/** Absolute path for an episode's audio, with a containment assert. Belt and
    braces over `safeFileName` — if the sanitiser is ever loosened, this still
    refuses to write outside the download dir. */
export function targetPath(episodeId, url, dir = DOWNLOAD_DIR) {
  const full = resolve(dir, safeFileName(episodeId, url));
  const root = resolve(dir);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new UnusableUrlError(`refusing to write outside the download dir: ${full}`);
  }
  return full;
}

export const partPathFor = (finalPath) => finalPath + ".part";

/** The provenance record for one fetch. The single rule this encodes: `url` is
    always what the publisher declared, whatever the redirect chain did. The
    resolved host is reported so we can see where the bytes actually came from,
    and never substituted back into `url`. */
export function provenance(item, { resolvedUrl = null, bytes = null, status = null } = {}) {
  return {
    episode_id: item.id,
    url: item.audio_url,              // publisher's declared URL. Never replaced.
    resolved_host: resolvedUrl ? hostOf(resolvedUrl) : null,
    declared_host: hostOf(item.audio_url),
    dai_suspected: item.dai_suspected ?? null,   // reported, never acted on here
    bytes,
    status,
  };
}

/* ------------------------------------------------------------ disk arithmetic */

/** Bytes an episode is expected to need. Declared length first (it is the
    publisher's own number), duration next, then a deliberately generous
    constant — over-reserving costs a slot, under-reserving costs the disk. */
export function estimateBytes(item) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return (
    n(item?.audio_bytes) ??
    (n(item?.duration_sec) ? Math.round(item.duration_sec * BYTES_PER_SEC_ESTIMATE) : null) ??
    (n(item?.duration_min) ? Math.round(item.duration_min * 60 * BYTES_PER_SEC_ESTIMATE) : null) ??
    FALLBACK_ESTIMATE_BYTES
  );
}

/** Free space on the volume holding `dir`. `statfs` is the only dependency-free
    way to ask; if it is unavailable we say so rather than guessing, because a
    guessed "plenty of room" is how the disk gets filled. */
export async function freeBytesFor(dir) {
  if (typeof fsp.statfs !== "function") {
    throw new DiskGuardError("node:fs statfs unavailable — cannot verify free space, refusing to start");
  }
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** The start gate. Pure so the arithmetic is testable without a filesystem. */
export function assertFreeSpace({ freeBytes, minFreeBytes = DEFAULT_MIN_FREE_BYTES }) {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    throw new DiskGuardError("free space could not be determined, refusing to start", { freeBytes });
  }
  if (freeBytes < minFreeBytes) {
    throw new DiskGuardError(
      `only ${fmtBytes(freeBytes)} free, need ${fmtBytes(minFreeBytes)} — refusing to start`,
      { freeBytes, minFreeBytes });
  }
  return true;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Bytes-resident accounting for in-flight and downloaded-but-not-yet-discarded
    files. The high-water mark is kept because "was the cap ever approached" is
    the question you want answered after an unattended run, and it is what the
    test asserts against.

    `admit` distinguishes two refusals on purpose:
      - returns false  → no room *right now*; the caller waits for a release.
      - throws         → this file can never fit; waiting would hang forever.
    Collapsing them would produce a run that sits at 0% and reports success,
    which is the failure mode LESSONS.md is about. */
export class ResidentLedger {
  constructor({ maxResidentBytes = DEFAULT_MAX_RESIDENT_BYTES } = {}) {
    this.max = maxResidentBytes;
    this.held = new Map();
    this.resident = 0;
    this.highWater = 0;
  }
  admit(id, bytes) {
    if (this.held.has(id)) throw new DiskBudgetError(`${id} is already admitted`, { id });
    if (!Number.isFinite(bytes) || bytes <= 0) throw new DiskBudgetError(`bad byte estimate for ${id}: ${bytes}`, { id, bytes });
    if (bytes > this.max) {
      throw new DiskBudgetError(
        `${id} needs ${fmtBytes(bytes)} but the resident cap is ${fmtBytes(this.max)} — raise --max-resident-gb`,
        { id, bytes, max: this.max });
    }
    if (this.resident + bytes > this.max) return false;
    this.held.set(id, bytes);
    this.resident += bytes;
    this.highWater = Math.max(this.highWater, this.resident);
    return true;
  }
  /** Correct a reservation once the server states the real length. Growing past
      the cap is fatal for that file — the caller aborts and deletes it. */
  resize(id, bytes) {
    if (!this.held.has(id)) throw new DiskBudgetError(`${id} is not admitted`, { id });
    if (!Number.isFinite(bytes) || bytes <= 0) return this.resident;
    const next = this.resident - this.held.get(id) + bytes;
    if (next > this.max) {
      throw new DiskBudgetError(
        `${id} is actually ${fmtBytes(bytes)}; resident would reach ${fmtBytes(next)} over a ${fmtBytes(this.max)} cap`,
        { id, bytes, max: this.max });
    }
    this.held.set(id, bytes);
    this.resident = next;
    this.highWater = Math.max(this.highWater, this.resident);
    return this.resident;
  }
  release(id) {
    if (!this.held.has(id)) return this.resident;
    this.resident -= this.held.get(id);
    this.held.delete(id);
    return this.resident;
  }
  get inFlight() { return this.held.size; }
}

/* ------------------------------------------------------------------ resume */

/** What to do with a `.part` file we found on disk.
      start    — nothing partial, fetch from 0
      resume   — request `bytes=<from>-`
      complete — the file is already whole
      restart  — the partial is unusable; delete and fetch from 0
    The `partial > expected` case is `restart` rather than `complete` because a
    partial larger than the whole file means the two are not the same file. */
export function resumePlan({ partialBytes = 0, expectedBytes = null } = {}) {
  const p = Number.isFinite(partialBytes) && partialBytes > 0 ? partialBytes : 0;
  const e = Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : null;
  if (p === 0) return { action: "start", from: 0, header: null };
  if (e != null && p === e) return { action: "complete", from: p, header: null };
  if (e != null && p > e) return { action: "restart", from: 0, header: null, reason: "partial larger than expected total" };
  return { action: "resume", from: p, header: `bytes=${p}-` };
}

/** `bytes 200-1023/1024` → `{ from, to, total }`. Null on anything else,
    including the unsatisfied-range form a 416 uses (`bytes` star slash N). */
export function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

/** Decide whether a response to a Range request may actually be appended.

    Three ways this goes wrong in the wild, all of which silently corrupt audio
    if unchecked: the server ignores `Range` and sends 200 with the whole file;
    it honours it but from a different offset; or it is a DAI host that
    re-stitched the file between our two requests, so byte N of the new copy is
    not byte N of the old one (corner case #2). The last is why identity —
    ETag if offered, total length otherwise — must match what we recorded, and
    why a DAI item with no recorded identity restarts rather than gambles. */
export function verifyResumeResponse({ status, contentRange, etag = null, from, prevIdentity = null, dai = false }) {
  if (status === 200) return { ok: false, restart: true, reason: "server ignored Range (200)" };
  if (status === 416) return { ok: false, restart: true, reason: "range not satisfiable (416)" };
  if (status !== 206) return { ok: false, restart: false, reason: `unexpected status ${status}` };

  const cr = parseContentRange(contentRange);
  if (!cr) return { ok: false, restart: true, reason: "206 without a parseable Content-Range" };
  if (cr.from !== from) return { ok: false, restart: true, reason: `206 from ${cr.from}, expected ${from}` };

  const identity = etag || (cr.total != null ? `len:${cr.total}` : null);
  if (prevIdentity && identity && prevIdentity !== identity) {
    return { ok: false, restart: true, reason: `file changed since the partial was written (${prevIdentity} -> ${identity})` };
  }
  if (dai && !(prevIdentity && identity && prevIdentity === identity)) {
    return { ok: false, restart: true, reason: "DAI host with unproven identity — refusing to splice ad-stitched ranges" };
  }
  return { ok: true, restart: false, identity, total: cr.total };
}

/* ----------------------------------------------------------------- backoff */

/** 408/425/429 and 5xx are worth retrying; everything else is a decision the
    server has made and repeating it is just impolite. */
export function shouldRetryStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are honoured;
    `now` is injectable so the date branch is testable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

/** Exponential with jitter, capped. Returns null when the caller must give up —
    a wrong status or an exhausted attempt budget — so "retry forever" is not
    expressible. `rand` is injectable for deterministic tests. */
export function backoffDelayMs(attempt, { status = 503, retryAfter = null, now = Date.now(), rand = Math.random, maxAttempts = MAX_ATTEMPTS } = {}) {
  if (attempt >= maxAttempts) return null;
  if (status != null && !shouldRetryStatus(status)) return null;
  const ra = parseRetryAfter(retryAfter, now);
  if (ra != null) return Math.min(ra, MAX_BACKOFF_MS);
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60_000);
  return Math.round(Math.min(base + rand() * 0.3 * base, MAX_BACKOFF_MS));
}

/* -------------------------------------------------------------- host gate */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-HOST concurrency plus a minimum gap between request starts on that host
    (corner case #8: per-host, not per-feed — one CDN fronts hundreds of feeds,
    so a per-feed budget is no budget at all). The gap is what stops 40 queued
    episodes from arriving as a burst the moment the run starts. */
export class HostGate {
  constructor({ perHost = DEFAULT_PER_HOST, minGapMs = DEFAULT_GAP_MS } = {}) {
    this.perHost = Math.max(1, perHost);
    this.minGapMs = Math.max(0, minGapMs);
    this.active = new Map();
    this.queues = new Map();
    this.lastStart = new Map();
  }
  async run(host, fn) {
    const key = String(host || "unknown").toLowerCase();
    await this.#acquire(key);
    try {
      const gap = this.minGapMs - (Date.now() - (this.lastStart.get(key) ?? -Infinity));
      if (gap > 0) await sleep(gap);
      this.lastStart.set(key, Date.now());
      return await fn();
    } finally {
      this.#release(key);
    }
  }
  async #acquire(key) {
    const n = this.active.get(key) ?? 0;
    if (n < this.perHost) { this.active.set(key, n + 1); return; }
    await new Promise((res) => {
      if (!this.queues.has(key)) this.queues.set(key, []);
      this.queues.get(key).push(res);
    });
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  }
  #release(key) {
    this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    const q = this.queues.get(key);
    if (q && q.length) q.shift()();
  }
}

/* ------------------------------------------------------------- checkpoint */

export const EMPTY_CHECKPOINT = Object.freeze({ version: 1, updated_at: null, high_water_bytes: 0, episodes: {} });

/** Pure merge so resume bookkeeping is testable. Unknown episodes are created;
    known ones are patched; `attempts` accumulates rather than being overwritten
    so a repeatedly-failing episode is visible instead of looking fresh. */
export function mergeCheckpoint(prev, id, patch) {
  const base = prev && prev.episodes ? prev : EMPTY_CHECKPOINT;
  const before = base.episodes[id] || { attempts: 0 };
  const after = { ...before, ...patch };
  if (patch.attempts === undefined && patch.bump_attempt) after.attempts = (before.attempts || 0) + 1;
  delete after.bump_attempt;
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    high_water_bytes: Math.max(base.high_water_bytes || 0, patch.high_water_bytes || 0),
    episodes: { ...base.episodes, [id]: after },
  };
}

export async function loadCheckpoint(path = CHECKPOINT_PATH) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.episodes) return { ...EMPTY_CHECKPOINT, episodes: {} };
    return raw;
  } catch (e) {
    if (e.code === "ENOENT") return { ...EMPTY_CHECKPOINT, episodes: {} };
    // A corrupt checkpoint must not be fatal — the .part files on disk are the
    // real state and are re-derivable. But it is loud, not silent.
    process.emitWarning(`checkpoint unreadable (${e.message}); starting a fresh one`);
    return { ...EMPTY_CHECKPOINT, episodes: {} };
  }
}

export async function saveCheckpoint(ck, path = CHECKPOINT_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ck, null, 2) + "\n");
  return ck;
}

/** The ONLY way the downloader writes the checkpoint.

    Found by running this tool for real: two episodes downloading in parallel
    each held a checkpoint snapshot taken when they started, and whichever
    finished last wrote its snapshot over the other's entry. The file ended up
    recording one of two completed downloads — so a resumed run would have
    re-fetched an episode that was already on disk, which is exactly the
    impolite behaviour the checkpoint exists to prevent.

    So: serialize writes through one chain, and re-READ inside the chain so each
    merge is against what is actually on disk rather than a stale snapshot. */
let checkpointChain = Promise.resolve();
export async function updateCheckpoint(id, patch, path = CHECKPOINT_PATH) {
  const next = checkpointChain.then(async () => {
    const current = await loadCheckpoint(path);
    return saveCheckpoint(mergeCheckpoint(current, id, patch), path);
  });
  checkpointChain = next.then(() => {}, () => {});
  return next;
}

/* ---------------------------------------------------------------- cleanup */

/** The other half of every fetch. Deletes the finished file and any partial,
    and marks the checkpoint entry `discarded` so a later run does not think the
    audio is still there. Idempotent: cleaning an episode twice, or one that was
    never fetched, is a no-op rather than an error — the caller is often a
    `finally` block and must be able to call this unconditionally. */
export async function cleanup(episodeId, { dir = DOWNLOAD_DIR, checkpointPath = CHECKPOINT_PATH, url = null } = {}) {
  const ck = await loadCheckpoint(checkpointPath);
  const entry = ck.episodes[episodeId] || null;
  const candidates = new Set();
  if (entry?.path) { candidates.add(entry.path); candidates.add(partPathFor(entry.path)); }
  const u = url || entry?.url;
  if (u) { const p = targetPath(episodeId, u, dir); candidates.add(p); candidates.add(partPathFor(p)); }

  const removed = [];
  let freedBytes = 0;
  for (const p of candidates) {
    try {
      const s = await stat(p);
      await rm(p, { force: true });
      removed.push(p);
      freedBytes += s.size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (entry) {
    await updateCheckpoint(episodeId, { status: "discarded", bytes_done: 0, discarded_at: new Date().toISOString() }, checkpointPath);
  }
  return { episodeId, removed, freedBytes };
}

/* --------------------------------------------------------- network shell */

async function fileSize(path) {
  try { return (await stat(path)).size; } catch (e) { if (e.code === "ENOENT") return 0; throw e; }
}

/** One episode, start to finish: resume plan → ranged GET of the DECLARED url →
    verify the range is spliceable → stream to `.part` → rename. Retries with
    backoff on 429/5xx and network errors; gives up with a named HttpError. */
export async function fetchEpisode(item, opts = {}) {
  const {
    dir = DOWNLOAD_DIR,
    checkpointPath = CHECKPOINT_PATH,
    ledger = new ResidentLedger(),
    gate = new HostGate(),
    userAgent = UA,
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
    timeoutMs = 120_000,
    onProgress = null,
  } = opts;

  const url = item.audio_url;                       // corner case #1: never substituted
  const host = hostOf(url);
  if (!host) throw new UnusableUrlError(`unparseable enclosure url for ${item.id}`, { url });

  await mkdir(dir, { recursive: true });
  const final = targetPath(item.id, url, dir);
  const part = partPathFor(final);

  const prev = (await loadCheckpoint(checkpointPath)).episodes[item.id] || null;

  // Already whole from an earlier run.
  const doneSize = await fileSize(final);
  if (doneSize > 0 && prev?.status === "complete") {
    return { ...provenance(item, { bytes: doneSize, status: "cached" }), path: final, resumed: false };
  }

  const reserved = estimateBytes(item);
  let admitted = ledger.admit(item.id, reserved);
  while (!admitted) {
    if (ledger.inFlight === 0) {
      throw new DiskBudgetError(`nothing in flight yet ${item.id} cannot be admitted — cap misconfigured`, { id: item.id });
    }
    await sleep(250);
    admitted = ledger.admit(item.id, reserved);
  }

  try {
    let attempt = 0;
    let lastError = null;
    for (;;) {
      attempt += 1;
      // Re-check free space every attempt, not just at startup: another process
      // (or our own uncleaned files) can eat the margin mid-run.
      assertFreeSpace({ freeBytes: await freeBytesFor(dir), minFreeBytes });

      let plan = resumePlan({ partialBytes: await fileSize(part), expectedBytes: prev?.bytes_expected ?? null });
      if (plan.action === "complete") {
        await fsp.rename(part, final);
        const bytes = await fileSize(final);
        await updateCheckpoint(item.id, { status: "complete", path: final, url, bytes_done: bytes, high_water_bytes: ledger.highWater }, checkpointPath);
        return { ...provenance(item, { bytes, status: "complete" }), path: final, resumed: true };
      }
      if (plan.action === "restart") { await rm(part, { force: true }); plan = resumePlan({}); }

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await gate.run(host, () =>
          fetch(url, {
            headers: {
              "User-Agent": userAgent,
              "Accept-Language": ACCEPT_LANGUAGE,   // see the import — Captivate 404s without it
              ...(plan.header ? { Range: plan.header } : {}),
            },
            redirect: "follow",     // resolve only to look — see the header
            signal: ctl.signal,
          }));

        if (!res.ok && res.status !== 206) {
          const delay = backoffDelayMs(attempt, { status: res.status, retryAfter: res.headers.get("retry-after") });
          lastError = `HTTP ${res.status}`;
          if (delay == null) {
            throw new HttpError(`${item.id}: ${url} returned ${res.status} after ${attempt} attempt(s)`, { status: res.status, url, id: item.id });
          }
          await sleep(delay);
          continue;
        }

        let append = false;
        let identity = res.headers.get("etag") || null;
        if (plan.action === "resume") {
          const v = verifyResumeResponse({
            status: res.status,
            contentRange: res.headers.get("content-range"),
            etag: identity,
            from: plan.from,
            prevIdentity: prev?.identity ?? null,
            dai: item.dai_suspected === true,
          });
          if (v.ok) { append = true; identity = v.identity; }
          else if (v.restart) { await rm(part, { force: true }); continue; }
          else throw new HttpError(`${item.id}: ${v.reason}`, { id: item.id, url });
        }

        const declaredLen = Number(res.headers.get("content-length"));
        const total = append ? plan.from + (Number.isFinite(declaredLen) ? declaredLen : 0) : declaredLen;
        if (Number.isFinite(total) && total > 0) ledger.resize(item.id, total);
        if (!identity && Number.isFinite(total) && total > 0) identity = `len:${total}`;

        const ceiling = Math.round(Math.max(reserved, total || 0) * SIZE_OVERRUN_FACTOR);
        let written = append ? plan.from : 0;
        const sink = createWriteStream(part, { flags: append ? "a" : "w" });
        const meter = async function* (src) {
          for await (const chunk of src) {
            written += chunk.length;
            if (written > ceiling) {
              ctl.abort();
              throw new SizeOverrunError(
                `${item.id} exceeded ${fmtBytes(ceiling)} (expected ~${fmtBytes(reserved)}) — aborting rather than filling the disk`,
                { id: item.id, written, ceiling });
            }
            if (onProgress) onProgress({ id: item.id, written, total });
            yield chunk;
          }
        };
        await pipeline(Readable.fromWeb(res.body), meter, sink);

        await fsp.rename(part, final);
        await updateCheckpoint(item.id, {
          status: "complete", path: final, url, identity,
          bytes_expected: written, bytes_done: written,
          resolved_host: hostOf(res.url), dai_suspected: item.dai_suspected ?? null,
          high_water_bytes: ledger.highWater,
        }, checkpointPath);
        return { ...provenance(item, { resolvedUrl: res.url, bytes: written, status: "complete" }), path: final, resumed: append };
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof FetchAudioError) {
          await updateCheckpoint(item.id, { status: "failed", url, error: e.message, bump_attempt: true }, checkpointPath);
          throw e;
        }
        lastError = e.message;
        const delay = backoffDelayMs(attempt, { status: null });
        if (delay == null) {
          const err = new HttpError(`${item.id}: ${url} failed after ${attempt} attempt(s): ${lastError}`, { id: item.id, url, cause: lastError });
          await updateCheckpoint(item.id, { status: "failed", url, error: err.message, bump_attempt: true }, checkpointPath);
          throw err;
        }
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    ledger.release(item.id);
  }
}

/** Fetch a selection. Sequential per host by construction (the gate), parallel
    across hosts. Returns a report; throws only when *nothing* succeeded — a
    partial success is a result, a total failure is an error. */
export async function fetchAll(items, opts = {}) {
  const ledger = opts.ledger || new ResidentLedger({ maxResidentBytes: opts.maxResidentBytes ?? DEFAULT_MAX_RESIDENT_BYTES });
  const gate = opts.gate || new HostGate({ perHost: opts.perHost ?? DEFAULT_PER_HOST, minGapMs: opts.gapMs ?? DEFAULT_GAP_MS });
  const dir = opts.dir ?? DOWNLOAD_DIR;

  await mkdir(dir, { recursive: true });
  assertFreeSpace({ freeBytes: await freeBytesFor(dir), minFreeBytes: opts.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES });

  const ok = [], failed = [];
  const results = await Promise.allSettled(items.map((item) => fetchEpisode(item, { ...opts, dir, ledger, gate })));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else failed.push({ episode_id: items[i].id, code: r.reason?.code || "UNKNOWN", error: r.reason?.message || String(r.reason) });
  });
  if (!ok.length) {
    throw new FetchAudioError("ALL_FAILED", `all ${items.length} downloads failed: ${failed.map((f) => f.error).join(" | ")}`, { failed });
  }
  return { ok, failed, high_water_bytes: ledger.highWater, dir };
}

/* -------------------------------------------------------------------- cli */

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

async function main(argv) {
  const args = argv.slice(2);
  const ids = flag(args, "--ids");
  const topic = flag(args, "--topic");
  const limit = Number(flag(args, "--limit", "Infinity"));
  const minFreeBytes = Number(flag(args, "--min-free-gb", String(DEFAULT_MIN_FREE_BYTES / GIB))) * GIB;
  const maxResidentBytes = Number(flag(args, "--max-resident-gb", String(DEFAULT_MAX_RESIDENT_BYTES / GIB))) * GIB;
  const perHost = Number(flag(args, "--per-host", String(DEFAULT_PER_HOST)));
  const gapMs = Number(flag(args, "--gap-ms", String(DEFAULT_GAP_MS)));

  if (args.includes("--status")) {
    const ck = await loadCheckpoint();
    const rows = Object.entries(ck.episodes);
    console.log(`checkpoint: ${rows.length} episode(s), high water ${fmtBytes(ck.high_water_bytes || 0)}`);
    for (const [id, e] of rows) console.log(`  ${e.status.padEnd(10)} ${fmtBytes(e.bytes_done || 0).padStart(9)}  ${id}`);
    return;
  }
  if (args.includes("--cleanup")) {
    const list = (flag(args, "--cleanup") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new SelectionError("--cleanup needs a comma-separated list of episode ids");
    let freed = 0;
    for (const id of list) { const r = await cleanup(id); freed += r.freedBytes; console.log(`discarded ${id}: ${r.removed.length} file(s)`); }
    console.log(`freed ${fmtBytes(freed)}`);
    return;
  }

  const pool = JSON.parse(await readFile(join(ROOT, "data", "discover.json"), "utf8"));
  const { selected, skipped } = selectEpisodes(pool, {
    ids: ids ? ids.split(",").map((s) => s.trim()).filter(Boolean) : null,
    topic, limit,
  });
  const dai = selected.filter((i) => i.dai_suspected).length;
  console.log(`selected ${selected.length} episode(s) (${dai} dai_suspected), skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skip ${s.id}: ${s.reason}`);
  const planned = selected.reduce((a, i) => a + estimateBytes(i), 0);
  console.log(`estimated ${fmtBytes(planned)} total, capped at ${fmtBytes(maxResidentBytes)} resident`);

  if (args.includes("--dry-run")) {
    for (const i of selected) console.log(`  would fetch ${i.id} <- ${i.audio_url} (~${fmtBytes(estimateBytes(i))})`);
    return;
  }

  const report = await fetchAll(selected, { minFreeBytes, maxResidentBytes, perHost, gapMs });
  console.log(`\ndownloaded ${report.ok.length}, failed ${report.failed.length}, high water ${fmtBytes(report.high_water_bytes)}`);
  for (const f of report.failed) console.log(`  FAIL ${f.episode_id} [${f.code}] ${f.error}`);
  console.log(`\nfiles are in ${report.dir} — call cleanup(episodeId) after transcription; this is not an archive.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error(`${e.name || "Error"}${e.code ? ` [${e.code}]` : ""}: ${e.message}`);
    process.exit(1);
  });
}
