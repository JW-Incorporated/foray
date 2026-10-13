import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { CueStore, EpisodeManifestRow } from "../generation/manifestBodySource";
import {
  FileTranscriptCueProvider,
  type TranscriptCue,
  type TranscriptDigestEntry
} from "../generation/transcriptArchiveLookup";
import { corpusSafeKey } from "../generation/transcriptCorpus";
import type { TranscriptSource } from "../types/tapeSourcing";

/**
 * THE REMOTE CUE STORE (GV-54; docs/roadmap/generation-v2.md, from W3-24;
 * covers GP-09 and R2-16; subsumes docs/roadmap/corpus.md PKG-24).
 *
 * The retrieval server (cli/retrievalServer.ts) answers /v1/cues from a cue
 * store. On the box that streams R2 (GV-09) most bodies are NOT on disk: the
 * index was built from a stream and the manifest row only records where each
 * body came from (`origin: {kind, key, sha256|etag}`). This store serves those
 * episodes anyway, fetching each body ONCE into a byte-bounded cache directory
 * instead of mirroring the 1 TB bucket. It is used only when the server starts
 * with --r2; without it the server's store is a plain FileTranscriptCueProvider
 * over the normalized directory, exactly as before.
 *
 * LOOKUP ORDER for one episode:
 *   1. the local normalized directory (data-local/transcripts/normalized/);
 *   2. the cue cache directory (--cue-cache), laid out like normalized/
 *      (<dir>/<fileName>), which is also where the stream indexer's own
 *      --cue-cache warm-up (tools/passage-index/stream-index.mjs CueCache)
 *      keeps the bodies it streamed;
 *   3. the injected async `fetchBody(origin)` for the manifest row's origin
 *      key. The default (`createR2BodyFetcher`) dynamically imports
 *      tools/foraycorpus-export/r2-client.mjs and GETs the object.
 *
 * WHAT IS WRITTEN. A normalized object (`origin.kind` "r2") is checked against
 * the farm's sha256 metadata and must parse as JSON; it is then written
 * BYTE-IDENTICAL. A legacy whisper object (`origin.kind` "legacy", GV-60) is
 * converted with GV-23's convertWhisperDoc + toNormalizedBody
 * (tools/foraycorpus-export/legacy-whisper.mjs), so the cached file is a
 * normalized body stating transcript_source "asr-local" and no source_url.
 * Every write is tmp + rename, and the directory is an LRU by bytes
 * (--cue-cache-gb): the oldest files go first, and a hit refreshes a file's
 * place (and its mtime, so the order survives a restart).
 *
 * SYNC READS, ASYNC FETCH. The index's body source is synchronous, so the
 * fetch cannot happen inside `getCues`. The server awaits `ensureBody` BEFORE
 * it answers /v1/cues, then reads through the synchronous provider over the
 * cache directory. That provider memoises misses (its listing, its locate
 * answers, its null reads), so after every write and every eviction this store
 * calls its `forgetShow(showId)`; without it a body fetched after an earlier
 * miss would stay invisible until the process restarts (the PKG-24 point).
 *
 * DEGRADE, NEVER CRASH. A missing object (404), a refused object (sha
 * mismatch, bad JSON, a legacy document that does not convert, too large) and
 * a failed fetch (no R2 credentials, a network error) are all reported through
 * the logger and returned as an outcome; nothing is written for any of them
 * and `ensureBody` never throws. The server answers 404 for the first two and
 * 503 for a failed fetch, which the retrieval client records as degraded and
 * the run goes on.
 *
 * PRIVACY. Only transcripts pass through here; a log line carries the show,
 * the object key, a status, bytes and milliseconds. Nothing of a query.
 */

export const GB = 1e9;
/** The stream indexer's own default (stream-index.mjs DEFAULT_CUE_CACHE_GB). */
export const DEFAULT_CUE_CACHE_GB = 20;
/** The `-<10 hex>` suffix corpusSafeKey appends to a show id. */
const SHOW_DIR_HASH = /-[0-9a-f]{10}$/;

/** Where a manifest row's body lives in the bucket. */
export interface RemoteOrigin {
  kind: string;
  key: string;
  etag?: string | null;
  sha256?: string | null;
}

/** One object as the fetcher returns it. */
export interface FetchedObject {
  bytes: Buffer;
  /** The farm's `sha256` user metadata (hex), when the object carries it. */
  sha256Meta: string | null;
  etag?: string | null;
}

/** GET one object: null when it does not exist (404); throws on any other
 * failure (no credentials, network, an R2Error). */
export type FetchBody = (origin: RemoteOrigin) => Promise<FetchedObject | null>;

/** A parsed legacy whisper document -> a normalized body for that episode. */
export type LegacyConverter = (doc: unknown, identity: { show_id: string; guid: string }) => unknown;

export interface RemoteCueLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type EnsureStatus =
  /** On the local normalized disk; nothing to do. */
  | "local"
  /** Already in the cue cache. */
  | "cached"
  /** Fetched now and written into the cue cache. */
  | "fetched"
  /** No manifest row, a non-remote origin, or the object is not in the bucket. */
  | "absent"
  /** The object exists but is not servable; nothing was written. */
  | "refused"
  /** The fetch itself failed; worth retrying later. */
  | "failed";

export interface EnsureOutcome {
  status: EnsureStatus;
  /** Why, for absent / refused / failed (a code, never an error message). */
  reason?: string;
}

/** A cue store the server can ask to bring a body local before it reads it. */
export interface ReadThroughCueStore extends CueStore {
  ensureBody(entry: TranscriptDigestEntry, row: EpisodeManifestRow | null): Promise<EnsureOutcome>;
}

export function isReadThroughCueStore(store: CueStore): store is ReadThroughCueStore {
  return typeof (store as Partial<ReadThroughCueStore>).ensureBody === "function";
}

/** A file or directory name that could leave its parent. */
function unsafeName(name: string): boolean {
  return name.length === 0 || name === "." || name === ".." || /[\\/]/.test(name);
}

const showIdOfDir = (dir: string): string => dir.replace(SHOW_DIR_HASH, "");

interface CacheFile {
  showId: string;
  size: number;
}

/**
 * The cache directory's disk side: which files it holds, how many bytes, and
 * the LRU order. The server builds one with each cue store, so a reload
 * re-scans the directory and counts what the stream indexer's warm-up wrote
 * into it meanwhile (the order on disk is the files' mtime).
 */
export class CueCacheDir {
  readonly root: string;
  readonly capBytes: number;
  /** "dir/fileName" -> file, oldest first. */
  private readonly files = new Map<string, CacheFile>();
  private totalBytes = 0;
  private evictedCount = 0;

  constructor(root: string, capBytes: number) {
    this.root = root;
    this.capBytes = Math.max(0, capBytes);
    const found: Array<{ key: string; showId: string; size: number; mtimeMs: number }> = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's --cue-cache directory.
    if (fs.existsSync(root)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory of the cache root.
        for (const fileName of fs.readdirSync(path.join(root, dir.name))) {
          if (!fileName.endsWith(".json")) continue;
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the cache root.
            const st = fs.statSync(path.join(root, dir.name, fileName));
            if (st.isFile()) found.push({ key: `${dir.name}/${fileName}`, showId: showIdOfDir(dir.name), size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            /* Gone between the listing and the stat. */
          }
        }
      }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const f of found) {
      this.files.set(f.key, { showId: f.showId, size: f.size });
      this.totalBytes += f.size;
    }
    this.evict(null);
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get fileCount(): number {
    return this.files.size;
  }

  get evicted(): number {
    return this.evictedCount;
  }

  /**
   * The directory a show's bodies go in: the one FileTranscriptCueProvider
   * would find (its `showDir` rule: the show id itself, or `<show id>-...`),
   * else the writer's own name, corpusSafeKey(show id), which that rule finds.
   */
  dirFor(showId: string): string {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's --cue-cache directory.
      for (const d of fs.readdirSync(this.root)) {
        if (d === showId || d.startsWith(`${showId}-`)) return d;
      }
    } catch {
      /* No cache directory yet. */
    }
    return corpusSafeKey(showId);
  }

  /** Whether the cache holds this file. A file someone else removed (the
   * stream indexer shares the directory) is dropped from the count. */
  has(dir: string, fileName: string): boolean {
    const key = `${dir}/${fileName}`;
    const held = this.files.get(key);
    if (!held) return false;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file this cache holds.
    if (fs.existsSync(path.join(this.root, dir, fileName))) return true;
    this.files.delete(key);
    this.totalBytes -= held.size;
    return false;
  }

  /** A hit: the file moves to the recent end (and gets a fresh mtime). */
  touch(dir: string, fileName: string): void {
    const key = `${dir}/${fileName}`;
    const held = this.files.get(key);
    if (!held) return;
    this.files.delete(key);
    this.files.set(key, held);
    try {
      const at = new Date();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file this cache holds.
      fs.utimesSync(path.join(this.root, dir, fileName), at, at);
    } catch {
      /* The order in memory is what counts; the mtime only survives a restart. */
    }
  }

  /**
   * Write one body (tmp + rename) and evict down to the cap. Returns the shows
   * whose files were evicted, or null when the body is larger than the whole
   * cap and was not written.
   */
  put(showId: string, dir: string, fileName: string, bytes: Buffer): { evictedShows: string[] } | null {
    if (bytes.length > this.capBytes) return null;
    const key = `${dir}/${fileName}`;
    const target = path.join(this.root, dir, fileName);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory of the cache root.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.${fileName}.tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a temp file beside the target.
      fs.writeFileSync(tmp, bytes);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    const previous = this.files.get(key);
    if (previous) {
      this.totalBytes -= previous.size;
      this.files.delete(key);
    }
    this.files.set(key, { showId, size: bytes.length });
    this.totalBytes += bytes.length;
    return { evictedShows: this.evict(key) };
  }

  /** Oldest first until the bytes fit; never the file just written. */
  private evict(keep: string | null): string[] {
    const shows = new Set<string>();
    for (const [key, file] of [...this.files]) {
      if (this.totalBytes <= this.capBytes) break;
      if (key === keep) continue;
      fs.rmSync(path.join(this.root, ...key.split("/")), { force: true });
      this.files.delete(key);
      this.totalBytes -= file.size;
      this.evictedCount += 1;
      shows.add(file.showId);
    }
    return [...shows];
  }
}

export interface RemoteCueStoreOptions {
  normalizedRoot: string;
  cache: CueCacheDir;
  fetchBody: FetchBody;
  /** Default: tools/foraycorpus-export/legacy-whisper.mjs, by dynamic import. */
  convertLegacy?: () => Promise<LegacyConverter>;
  logger: RemoteCueLogger;
  now?: () => number;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXPORT_TOOLS = path.join(REPO_ROOT, "tools", "foraycorpus-export");

/** GV-23's converter: convertWhisperDoc, then toNormalizedBody. */
export async function loadLegacyConverter(): Promise<LegacyConverter> {
  const legacy = (await import(pathToFileURL(path.join(EXPORT_TOOLS, "legacy-whisper.mjs")).href)) as {
    convertWhisperDoc(doc: unknown): unknown;
    toNormalizedBody(converted: unknown, identity: { show_id: string; guid: string }): unknown;
  };
  return (doc, identity) => legacy.toNormalizedBody(legacy.convertWhisperDoc(doc), identity);
}

/** The R2 module surface the default fetcher uses (r2-client.mjs). */
export interface R2ClientModule {
  loadR2Credentials(): Promise<{ bucket: string }>;
  createR2Client(creds: unknown): Promise<unknown>;
  getObject(client: unknown, bucket: string, key: string): Promise<{ body: Buffer; sha256Meta: string | null; etag: string | null }>;
}

/** An S3 "no such object" (the SDK's NoSuchKey / NotFound, or a bare 404). */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

/**
 * The default fetcher: r2-client.mjs (the AWS SDK is imported lazily there),
 * with the credentials of loadR2Credentials (the environment or
 * R2_CREDENTIALS_FILE). The client is built on first use; when that fails (no
 * key on this box) the error is thrown to the store, which reports the fetch
 * as failed, and the next fetch tries again.
 */
export function createR2BodyFetcher(
  options: { loadModule?: () => Promise<R2ClientModule> } = {}
): FetchBody {
  const loadModule =
    options.loadModule ?? (async () => (await import(pathToFileURL(path.join(EXPORT_TOOLS, "r2-client.mjs")).href)) as R2ClientModule);
  let ready: Promise<{ module: R2ClientModule; client: unknown; bucket: string }> | null = null;
  return async (origin) => {
    ready ??= (async () => {
      const module = await loadModule();
      const creds = await module.loadR2Credentials();
      return { module, client: await module.createR2Client(creds), bucket: creds.bucket };
    })();
    let r2: { module: R2ClientModule; client: unknown; bucket: string };
    try {
      r2 = await ready;
    } catch (error) {
      ready = null;
      throw error;
    }
    try {
      const got = await r2.module.getObject(r2.client, r2.bucket, origin.key);
      return { bytes: got.body, sha256Meta: got.sha256Meta, etag: got.etag };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
}

/** The origin a manifest row records, when it is one this store can fetch. */
function remoteOrigin(row: EpisodeManifestRow): RemoteOrigin | null {
  const o = row.origin as Partial<RemoteOrigin> | null | undefined;
  if (!o || typeof o !== "object" || typeof o.key !== "string" || o.key.length === 0) return null;
  if (o.kind !== "r2" && o.kind !== "legacy") return null;
  return { kind: o.kind, key: o.key, etag: o.etag ?? null, sha256: o.sha256 ?? null };
}

/** What a thrown fetch error may say in a log or an outcome: a code. */
function errorCode(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown } | null;
  if (e && typeof e === "object") {
    if (e.name === "R2Error" && typeof e.code === "string") return e.code;
    if (typeof e.name === "string") return e.name;
  }
  return typeof error;
}

export class RemoteCueStore implements ReadThroughCueStore {
  private readonly local: FileTranscriptCueProvider;
  private readonly cached: FileTranscriptCueProvider;
  private readonly cache: CueCacheDir;
  private readonly fetchBody: FetchBody;
  private readonly loadConverter: () => Promise<LegacyConverter>;
  private converter: Promise<LegacyConverter> | null = null;
  private readonly logger: RemoteCueLogger;
  private readonly now: () => number;
  /** One fetch per episode at a time: a second request waits on the first. */
  private readonly inFlight = new Map<string, Promise<EnsureOutcome>>();

  constructor(options: RemoteCueStoreOptions) {
    this.local = new FileTranscriptCueProvider(options.normalizedRoot);
    this.cache = options.cache;
    this.cached = new FileTranscriptCueProvider(options.cache.root);
    this.fetchBody = options.fetchBody;
    this.loadConverter = options.convertLegacy ?? loadLegacyConverter;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** The provider that holds this episode's body: local first, then the cache. */
  private holder(entry: TranscriptDigestEntry): FileTranscriptCueProvider {
    return this.local.bodyStat(entry) !== null ? this.local : this.cached;
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    return this.holder(entry).getCues(entry);
  }

  readCuesUncached(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    return this.holder(entry).readCuesUncached(entry);
  }

  transcriptSource(entry: TranscriptDigestEntry): TranscriptSource | null {
    return this.holder(entry).transcriptSource(entry);
  }

  /** Honest about what can be read NOW, without a fetch: local or cached. A
   * body only in R2 is null, so the server never rebuilds an index over it. */
  bodyStat(entry: TranscriptDigestEntry): { mtimeMs: number; size: number } | null {
    return this.local.bodyStat(entry) ?? this.cached.bodyStat(entry);
  }

  /**
   * Bring an episode's body onto this box if it is not here yet. Never
   * throws: every failure is an outcome (see the file header).
   */
  ensureBody(entry: TranscriptDigestEntry, row: EpisodeManifestRow | null): Promise<EnsureOutcome> {
    const key = `${String(entry.show_id)}\u0000${String(entry.guid)}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const work = this.ensureUncached(entry, row).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async ensureUncached(entry: TranscriptDigestEntry, row: EpisodeManifestRow | null): Promise<EnsureOutcome> {
    if (this.local.bodyStat(entry) !== null) return { status: "local" };
    const showId = String(entry.show_id);
    if (!row) return { status: "absent", reason: "NO_MANIFEST_ROW" };
    /* The cache is asked by name (the manifest row's file), not through the
       provider: a provider miss would walk the show's whole cache directory
       for recorded guids, once per fetch. */
    const dir = this.cache.dirFor(showId);
    if (this.cache.has(dir, row.fileName)) {
      this.cache.touch(dir, row.fileName);
      return { status: "cached" };
    }
    const origin = remoteOrigin(row);
    if (!origin) return { status: "absent", reason: "NOT_REMOTE" };
    if (unsafeName(row.fileName) || unsafeName(dir)) return this.refuse(showId, origin, "PATH_ESCAPE");

    const started = this.now();
    let fetched: FetchedObject | null;
    try {
      fetched = await this.fetchBody(origin);
    } catch (error) {
      const code = errorCode(error);
      /* r2-client's TOO_LARGE / NO_BODY are the object's own fault (sync-r2
         quarantines them); anything else may pass. */
      if (code === "TOO_LARGE" || code === "NO_BODY") return this.refuse(showId, origin, code);
      this.logger.error("cue-fetch-failed", { show: showId, key: origin.key, error: code, ms: this.now() - started });
      return { status: "failed", reason: code };
    }
    if (!fetched) {
      this.logger.info("cue-fetch-absent", { show: showId, key: origin.key, ms: this.now() - started });
      return { status: "absent", reason: "NOT_FOUND" };
    }
    const digest = crypto.createHash("sha256").update(fetched.bytes).digest("hex");
    if (fetched.sha256Meta && digest !== String(fetched.sha256Meta).toLowerCase()) return this.refuse(showId, origin, "SHA_MISMATCH");
    let doc: unknown;
    try {
      doc = JSON.parse(fetched.bytes.toString("utf8")) as unknown;
    } catch {
      return this.refuse(showId, origin, "BAD_JSON");
    }
    let bytes = fetched.bytes;
    if (origin.kind === "legacy") {
      try {
        this.converter ??= this.loadConverter();
        const convert = await this.converter;
        const body = convert(doc, { show_id: showId, guid: row.bodyGuid ?? String(entry.guid) });
        bytes = Buffer.from(JSON.stringify(body), "utf8");
      } catch (error) {
        return this.refuse(showId, origin, `BAD_SHAPE:${errorCode(error)}`);
      }
    }
    let put: { evictedShows: string[] } | null;
    try {
      put = this.cache.put(showId, dir, row.fileName, bytes);
    } catch (error) {
      const code = errorCode(error);
      this.logger.error("cue-cache-write-failed", { show: showId, key: origin.key, error: code });
      return { status: "failed", reason: `WRITE:${code}` };
    }
    if (!put) return this.refuse(showId, origin, "LARGER_THAN_CACHE");
    /* The PKG-24 point: the provider over the cache memoised this show's miss. */
    this.cached.forgetShow(showId);
    for (const evicted of put.evictedShows) this.cached.forgetShow(evicted);
    this.logger.info("cue-fetched", {
      show: showId,
      key: origin.key,
      kind: origin.kind,
      bytes: bytes.length,
      ms: this.now() - started,
      cacheBytes: this.cache.bytes,
      evictedShows: put.evictedShows.length
    });
    return { status: "fetched" };
  }

  private refuse(showId: string, origin: RemoteOrigin, reason: string): EnsureOutcome {
    this.logger.error("cue-fetch-refused", { show: showId, key: origin.key, reason });
    return { status: "refused", reason };
  }
}
