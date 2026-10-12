import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as zlib from "zlib";
import {
  CORPUS_DIGEST_FILE,
  FileTranscriptCueProvider,
  loadTranscriptArchive,
  type TranscriptDigestEntry
} from "../generation/transcriptArchiveLookup";
import {
  FileTranscriptTextIndex,
  showIndexCacheFile,
  TRANSCRIPT_TEXT_CANDIDATES,
  TRANSCRIPT_TEXT_INDEX_VERSION,
  type TranscriptBodySource
} from "../generation/transcriptTextIndex";
import {
  ManifestBodySource,
  readEpisodeManifest,
  type CueStore,
  type EpisodeManifestRow
} from "../generation/manifestBodySource";

/**
 * THE RETRIEVAL SERVER (GV-16; roadmap docs/roadmap/generation-v2.md, from
 * W3-08; covers R1-09 and GP-09).
 *
 *     node tools/passage-index/serve.mjs [--host 127.0.0.1] [--port 7311] [--shows a,b]
 *       [--index-root DIR] [--manifest FILE] [--normalized-root DIR]
 *
 * WHY A RESIDENT PROCESS. Every generation process used to load each show's
 * BM25 cache on first search (and needed the transcript bodies on its own
 * disk to know the cache was fresh). This process loads the index ONCE, on the
 * box that holds the corpus, keeps every show resident, and answers searches
 * over HTTP, so no run pays the per-process index load or needs local
 * transcripts. It reuses `FileTranscriptTextIndex` itself, so an answer is the
 * one a local search over the same archive would give: same order, same
 * scores, same idf.
 *
 * AT BOOT (and on POST /v1/reload):
 *   1. the archive is `loadTranscriptArchive()`: the committed digests plus
 *      this box's `data-local/transcripts/corpus-digest.json`;
 *   2. the body source is a `ManifestBodySource` over the stream indexer's
 *      `data-local/passage-index/episodes.jsonl` (GV-09), so caches built from
 *      an R2 stream are fresh with no body on disk. Without a manifest the
 *      cue store itself is the body source (a box with the bodies on disk);
 *   3. every show is held from its cache if the cache is fresh
 *      (`warmFromCache`). A stale or missing cache is logged as an ERROR and
 *      rebuilt only when the cue store can serve every body the show's rows
 *      map to; otherwise the show is left out and reported, never half-built.
 *      `--shows` limits the set on a small machine.
 * A show that is not resident is never searched, so a query can never trigger
 * a build inside a request.
 *
 * HTTP JSON API (node:http only; no outbound request is ever made):
 *   POST /v1/scopes  {episodes: [[show_id, guid], ...] | "all"} -> {scopeId, episodes, unknown}
 *                    held in memory for 2 h after last use. Lineage is
 *                    decided by the CLIENT (familyGateAllows /
 *                    nodesForArchiveEntry, the code sourcing uses), which sends
 *                    the admitted episodes.
 *   POST /v1/search  {scopeId, queries: [{text, limit}]} -> {results: [{candidates, idf}]}
 *                    candidates [{show_id, guid, score, matchedTerms, rank}];
 *                    idf {term: weight}, present even with zero candidates.
 *   GET  /v1/episodes  [{show_id, guid, size, mtimeMs, transcript_source}] for
 *                    every archive row that maps to a body (manifest row).
 *   GET  /v1/cues?show_id=&guid=  {cues, transcript_source} or 404.
 *   GET  /v1/archive   {generated_at, transcripts}: the archive rows exactly
 *                    as loaded (tools/passage-index/pull-archive.mjs).
 *   GET  /healthz      {indexVersion, shows, episodes, archiveGeneratedAt}.
 *   POST /v1/reload    re-reads the archive, the manifest and the caches.
 *
 * AUTH. Bearer FORAY_RETRIEVAL_TOKEN (or the file named by
 * FORAY_RETRIEVAL_TOKEN_FILE). The default bind is 127.0.0.1; any other bind
 * is REFUSED without a token. With a token set, every /v1 route needs it.
 *
 * PRIVACY (§9.4). Search bodies carry beat claims, which are prompt-derived.
 * Nothing here logs or persists query text: a log line carries counts,
 * latencies and a 12-hex sha256 prefix per query, never the text, and the
 * only file this process writes is a show's index cache, which is built from
 * transcripts alone. Responses are gzip-encoded for a client that accepts it.
 *
 * INJECTION. The archive and manifest loaders, the cue store and the logger
 * are injected; `main()` is the only place that builds the real ones. An
 * inert process: nothing in the pipeline talks to it until W3-11 (GV-95) sets
 * FORAY_RETRIEVAL_URL.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7311;
export const DEFAULT_INDEX_ROOT = path.join(REPO_ROOT, "data-local", "transcripts", "index");
export const DEFAULT_MANIFEST = path.join(REPO_ROOT, "data-local", "passage-index", "episodes.jsonl");
export const DEFAULT_NORMALIZED_ROOT = path.join(REPO_ROOT, "data-local", "transcripts", "normalized");
/** How long a scope lives after its last use. */
export const SCOPE_TTL_MS = 2 * 60 * 60 * 1000;
/** Request-size and shape bounds: a scope of every episode of a large corpus is
 * well under this; anything bigger is a client bug. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_QUERIES_PER_SEARCH = 256;
export const MAX_QUERY_CHARS = 20_000;
export const MAX_SEARCH_LIMIT = 200;

export interface RetrievalLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoadedArchive {
  rows: TranscriptDigestEntry[];
  /** The machine-local corpus digest's `generated_at`, or null without one. */
  generatedAt: string | null;
}

export interface RetrievalServiceOptions {
  loadArchive: () => LoadedArchive;
  /** The episode manifest's rows; null when there is none, and then the cue
   * store is the body source (it must be able to `bodyStat`). */
  loadManifest: () => EpisodeManifestRow[] | null;
  /** Builds the cue store; called again on reload, so per-process listings
   * and caches start fresh. */
  createCueStore: () => CueStore;
  indexRoot: string;
  /** Hold only these shows (a small machine). Null or empty: every show. */
  shows?: readonly string[] | null;
  logger: RetrievalLogger;
  now?: () => number;
  scopeTtlMs?: number;
}

export interface EpisodeRow {
  show_id: string;
  guid: string;
  size: number;
  mtimeMs: number;
  transcript_source: string | null;
}

export interface SearchQuery {
  text: string;
  limit?: number;
}

export interface WireCandidate {
  show_id: string;
  guid: string;
  score: number;
  matchedTerms: number;
  rank: number;
}

export interface WireSearchResult {
  candidates: WireCandidate[];
  idf: Record<string, number>;
}

export interface Health {
  indexVersion: number;
  shows: number;
  episodes: number;
  archiveGeneratedAt: string | null;
}

interface Snapshot {
  archive: TranscriptDigestEntry[];
  generatedAt: string | null;
  byKey: Map<string, TranscriptDigestEntry>;
  bodies: TranscriptBodySource;
  manifest: ManifestBodySource | null;
  cueStore: CueStore;
  index: FileTranscriptTextIndex;
  resident: Set<string>;
  episodes: number;
}

interface Scope {
  keys: Set<string> | "all";
  expiresAt: number;
}

const keyOf = (showId: string, guid: string): string => `${showId}\u0000${guid}`;

/** A 12-hex sha256 prefix: what a log line may say about a query. */
export function queryHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The index, the scopes and the archive, without HTTP. Exported for tests and
 * so the HTTP layer stays a thin router.
 */
export class RetrievalService {
  private snapshot: Snapshot;
  private readonly scopes = new Map<string, Scope>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: RetrievalServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.scopeTtlMs ?? SCOPE_TTL_MS;
    this.snapshot = this.load();
  }

  /** Re-read the archive, the manifest and the caches; the old snapshot keeps
   * serving until the new one is complete, and stays if loading throws. */
  reload(): Health {
    this.snapshot = this.load();
    return this.health();
  }

  private load(): Snapshot {
    const { logger } = this.options;
    const started = this.now();
    const { rows, generatedAt } = this.options.loadArchive();
    const archive = rows;
    const byKey = new Map<string, TranscriptDigestEntry>();
    for (const entry of archive) byKey.set(keyOf(String(entry.show_id), String(entry.guid)), entry);

    const cueStore = this.options.createCueStore();
    const manifestRows = this.options.loadManifest();
    let manifest: ManifestBodySource | null = null;
    let bodies: TranscriptBodySource;
    if (manifestRows) {
      manifest = new ManifestBodySource({ rows: manifestRows, cues: cueStore });
      bodies = manifest;
    } else {
      const statOf = cueStore.bodyStat;
      if (!statOf) throw new Error("retrieval server: no episode manifest, and the cue store cannot stat bodies");
      bodies = {
        getCues: (entry) => cueStore.getCues(entry),
        readCuesUncached: (entry) => (cueStore.readCuesUncached ? cueStore.readCuesUncached(entry) : cueStore.getCues(entry)),
        transcriptSource: (entry) => (cueStore.transcriptSource ? cueStore.transcriptSource(entry) : null),
        bodyStat: (entry) => statOf.call(cueStore, entry)
      };
      logger.info("manifest-absent", { bodySource: "cue-store" });
    }

    const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: this.options.indexRoot });
    const wanted = this.options.shows && this.options.shows.length > 0 ? new Set(this.options.shows) : null;
    const known = index.shows();
    if (wanted) {
      const knownIds = new Set(known.map((s) => s.showId));
      for (const showId of wanted) if (!knownIds.has(showId)) logger.error("show-unknown", { show: showId });
    }

    const resident = new Set<string>();
    let episodes = 0;
    for (const { showId } of known) {
      if (wanted && !wanted.has(showId)) continue;
      const warm = index.warmFromCache(showId);
      if (warm) {
        resident.add(showId);
        episodes += warm.episodes;
        continue;
      }
      const entries = archive.filter((e) => e.show_id === showId && bodies.bodyStat(e) !== null);
      if (entries.length === 0) {
        logger.info("show-no-bodies", { show: showId });
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the cache path of a digest show id, slugged by showIndexCacheFile.
      const reason = fs.existsSync(showIndexCacheFile(this.options.indexRoot, showId)) ? "stale" : "missing";
      logger.error("cache-stale", { show: showId, reason, episodes: entries.length });
      const missing = cueStore.bodyStat ? entries.filter((e) => cueStore.bodyStat?.(e) === null).length : 0;
      if (missing > 0) {
        logger.error("cache-not-rebuilt", { show: showId, missingBodies: missing });
        continue;
      }
      const built = index.warmShow(showId);
      if (!built) {
        logger.error("cache-not-rebuilt", { show: showId, missingBodies: 0, usableBodies: 0 });
        continue;
      }
      resident.add(showId);
      episodes += built.episodes;
      logger.info("cache-rebuilt", { show: showId, episodes: built.episodes, terms: built.terms, bytes: built.bytes });
    }
    logger.info("loaded", {
      archiveRows: archive.length,
      manifestRows: manifestRows ? manifestRows.length : null,
      shows: resident.size,
      episodes,
      ms: this.now() - started
    });
    return { archive, generatedAt, byKey, bodies, manifest, cueStore, index, resident, episodes };
  }

  health(): Health {
    const s = this.snapshot;
    return {
      indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION,
      shows: s.resident.size,
      episodes: s.episodes,
      archiveGeneratedAt: s.generatedAt
    };
  }

  /** The resident shows, in archive order. */
  residentShows(): string[] {
    return [...this.snapshot.resident];
  }

  createScope(spec: unknown): { scopeId: string; episodes: number | "all"; unknown: number } {
    this.sweep();
    const scopeId = crypto.randomUUID();
    if (spec === "all") {
      this.scopes.set(scopeId, { keys: "all", expiresAt: this.now() + this.ttlMs });
      return { scopeId, episodes: "all", unknown: 0 };
    }
    if (!Array.isArray(spec)) throw new HttpError(400, 'episodes must be "all" or an array of [show_id, guid] pairs');
    const keys = new Set<string>();
    let unknown = 0;
    for (const pair of spec as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
        throw new HttpError(400, "each episode must be a [show_id, guid] pair of strings");
      }
      const key = keyOf(pair[0], pair[1]);
      if (!this.snapshot.byKey.has(key)) unknown += 1;
      keys.add(key);
    }
    this.scopes.set(scopeId, { keys, expiresAt: this.now() + this.ttlMs });
    return { scopeId, episodes: keys.size, unknown };
  }

  /** Answers in query order. Throws 404 for an unknown or expired scope. */
  search(scopeId: unknown, queries: unknown): WireSearchResult[] {
    this.sweep();
    if (typeof scopeId !== "string") throw new HttpError(400, "scopeId must be a string");
    const scope = this.scopes.get(scopeId);
    if (!scope) throw new HttpError(404, "unknown or expired scope");
    scope.expiresAt = this.now() + this.ttlMs;
    if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_QUERIES_PER_SEARCH) {
      throw new HttpError(400, `queries must be an array of 1..${MAX_QUERIES_PER_SEARCH}`);
    }
    const parsed: Array<{ text: string; limit: number }> = [];
    for (const q of queries as unknown[]) {
      const query = q as { text?: unknown; limit?: unknown } | null;
      if (query === null || typeof query !== "object" || typeof query.text !== "string" || query.text.length > MAX_QUERY_CHARS) {
        throw new HttpError(400, `each query needs a text of at most ${MAX_QUERY_CHARS} characters`);
      }
      const limit = query.limit === undefined ? TRANSCRIPT_TEXT_CANDIDATES : query.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
        throw new HttpError(400, `limit must be an integer 1..${MAX_SEARCH_LIMIT}`);
      }
      parsed.push({ text: query.text, limit });
    }
    const { index, resident } = this.snapshot;
    const keys = scope.keys;
    /* A non-resident show is never offered to the index, so a request can
       never build one. For a scope of every resident show this predicate
       admits exactly what an unfiltered search would. */
    const isUsable =
      keys === "all"
        ? (entry: TranscriptDigestEntry): boolean => resident.has(entry.show_id)
        : (entry: TranscriptDigestEntry): boolean => resident.has(entry.show_id) && keys.has(keyOf(String(entry.show_id), String(entry.guid)));
    return parsed.map(({ text, limit }) => {
      const result = index.searchWithIdf(text, { limit, isUsable });
      return {
        candidates: result.candidates.map((c) => ({
          show_id: String(c.entry.show_id),
          guid: String(c.entry.guid),
          score: c.score,
          matchedTerms: c.matchedTerms,
          rank: c.rank
        })),
        idf: Object.fromEntries(result.idf)
      };
    });
  }

  /** Every archive row that maps to a body, in archive order. */
  episodes(): EpisodeRow[] {
    const { archive, bodies, manifest } = this.snapshot;
    const out: EpisodeRow[] = [];
    for (const entry of archive) {
      const stat = bodies.bodyStat(entry);
      if (!stat) continue;
      const row = manifest ? manifest.rowFor(entry) : null;
      out.push({
        show_id: String(entry.show_id),
        guid: String(entry.guid),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        transcript_source: typeof row?.transcript_source === "string" ? row.transcript_source : null
      });
    }
    return out;
  }

  /** An archive episode's cues and provenance; 404 when the episode or its
   * body is unknown. */
  cues(showId: unknown, guid: unknown): { cues: unknown[]; transcript_source: string | null } {
    if (typeof showId !== "string" || typeof guid !== "string" || showId.length === 0 || guid.length === 0) {
      throw new HttpError(400, "show_id and guid are required");
    }
    const entry = this.snapshot.byKey.get(keyOf(showId, guid));
    if (!entry) throw new HttpError(404, "unknown episode");
    const cues = this.snapshot.bodies.getCues(entry);
    if (!cues) throw new HttpError(404, "no body for this episode");
    let source: string | null;
    try {
      source = this.snapshot.bodies.transcriptSource ? this.snapshot.bodies.transcriptSource(entry) : null;
    } catch {
      throw new HttpError(500, "the body states a transcript_source outside the vocabulary");
    }
    return { cues, transcript_source: source };
  }

  /** The archive rows exactly as loaded. */
  archive(): { generated_at: string | null; transcripts: TranscriptDigestEntry[] } {
    return { generated_at: this.snapshot.generatedAt, transcripts: this.snapshot.archive };
  }

  scopeCount(): number {
    this.sweep();
    return this.scopes.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, scope] of this.scopes) if (scope.expiresAt <= now) this.scopes.delete(id);
  }
}

/** Loopback binds need no token; every other bind does. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function assertBindAllowed(host: string, token: string | null | undefined): void {
  if (!isLoopbackHost(host) && !(token && token.length > 0)) {
    throw new Error(`retrieval server: refusing to bind ${host} without FORAY_RETRIEVAL_TOKEN (only 127.0.0.1 may run without one)`);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match || !match[1]) return false;
  const a = crypto.createHash("sha256").update(match[1].trim(), "utf8").digest();
  const b = crypto.createHash("sha256").update(token, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        done = true;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new HttpError(400, "request body is not JSON"));
      }
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, payload: unknown): number {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const gzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
  const body = gzip ? zlib.gzipSync(json) : json;
  const headers: http.OutgoingHttpHeaders = {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    vary: "accept-encoding"
  };
  if (gzip) headers["content-encoding"] = "gzip";
  if (status === 401) headers["www-authenticate"] = 'Bearer realm="foray-retrieval"';
  res.writeHead(status, headers);
  res.end(body);
  return body.length;
}

export interface RetrievalHttpOptions {
  service: RetrievalService;
  /** Required for every /v1 route when set. */
  token?: string | null;
  logger: RetrievalLogger;
  now?: () => number;
}

/** The router. Builds no dependency of its own. */
export function createRetrievalHttpServer(options: RetrievalHttpOptions): http.Server {
  const { service, logger } = options;
  const token = options.token && options.token.length > 0 ? options.token : null;
  const now = options.now ?? Date.now;

  return http.createServer((req, res) => {
    const started = now();
    const url = new URL(req.url ?? "/", "http://retrieval.local");
    const route = url.pathname;
    const method = req.method ?? "GET";
    /* What a log line may carry: counts, latencies, query hashes. Never the
       text of a query, never a request body. */
    const fields: Record<string, unknown> = {};

    const handle = async (): Promise<{ status: number; payload: unknown }> => {
      if (route === "/healthz" && method === "GET") return { status: 200, payload: service.health() };
      if (!route.startsWith("/v1/")) throw new HttpError(404, "not found");
      if (token && !tokenMatches(req.headers.authorization, token)) throw new HttpError(401, "missing or wrong bearer token");
      const routes: Record<string, string> = {
        "/v1/scopes": "POST",
        "/v1/search": "POST",
        "/v1/reload": "POST",
        "/v1/episodes": "GET",
        "/v1/cues": "GET",
        "/v1/archive": "GET"
      };
      const allowed = routes[route];
      if (!allowed) throw new HttpError(404, "not found");
      if (method !== allowed) throw new HttpError(405, `use ${allowed}`);
      switch (route) {
        case "/v1/scopes": {
          const body = (await readBody(req)) as { episodes?: unknown };
          const scope = service.createScope(body?.episodes);
          fields.scopeEpisodes = scope.episodes;
          fields.unknown = scope.unknown;
          return { status: 200, payload: scope };
        }
        case "/v1/search": {
          const body = (await readBody(req)) as { scopeId?: unknown; queries?: unknown };
          const queries = Array.isArray(body?.queries) ? (body.queries as Array<{ text?: unknown }>) : [];
          fields.queries = queries.length;
          fields.queryHashes = queries.map((q) => (typeof q?.text === "string" ? queryHash(q.text) : null));
          const results = service.search(body?.scopeId, body?.queries);
          fields.candidates = results.map((r) => r.candidates.length);
          return { status: 200, payload: { results } };
        }
        case "/v1/reload": {
          await readBody(req);
          return { status: 200, payload: service.reload() };
        }
        case "/v1/episodes": {
          const episodes = service.episodes();
          fields.episodes = episodes.length;
          return { status: 200, payload: episodes };
        }
        case "/v1/cues": {
          const out = service.cues(url.searchParams.get("show_id"), url.searchParams.get("guid"));
          fields.cues = out.cues.length;
          return { status: 200, payload: out };
        }
        default: {
          const archive = service.archive();
          fields.rows = archive.transcripts.length;
          return { status: 200, payload: archive };
        }
      }
    };

    handle()
      .then(
        ({ status, payload }) => ({ status, payload }),
        (error: unknown) => {
          if (error instanceof HttpError) return { status: error.status, payload: { error: error.message } };
          /* An unexpected failure: its message may be anything, so the log
             gets its class name only. */
          logger.error("request-failed", { route, error: error instanceof Error ? error.name : typeof error });
          return { status: 500, payload: { error: "internal error" } };
        }
      )
      .then(({ status, payload }) => {
        const bytes = send(req, res, status, payload);
        logger.info("request", { method, route, status, ms: now() - started, bytes, ...fields });
      })
      .catch(() => {
        /* The socket went away mid-write; nothing to answer. */
      });
  });
}

export interface StartedRetrievalServer {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Bind and listen; refuses a non-loopback host without a token. */
export async function startRetrievalServer(options: RetrievalHttpOptions & { host?: string; port?: number }): Promise<StartedRetrievalServer> {
  const host = options.host ?? DEFAULT_HOST;
  assertBindAllowed(host, options.token);
  const server = createRetrievalHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_PORT);
  options.logger.info("listening", { host, port, auth: options.token ? "bearer" : "none" });
  return {
    server,
    host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((e) => (e ? reject(e) : resolve()));
      })
  };
}

export interface RetrievalServerArgs {
  host: string;
  port: number;
  shows: string[];
  indexRoot: string;
  manifest: string;
  normalizedRoot: string;
}

export function parseRetrievalServerArgs(argv: readonly string[]): RetrievalServerArgs {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? String(argv[i + 1]) : null;
  };
  const shows: string[] = [];
  argv.forEach((arg, i) => {
    if (arg === "--shows" && argv[i + 1] !== undefined) {
      for (const s of String(argv[i + 1]).split(",")) if (s.trim().length > 0) shows.push(s.trim());
    }
  });
  const portText = value("--port");
  const port = portText === null ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0..65535, got ${portText}`);
  return {
    host: value("--host") ?? DEFAULT_HOST,
    port,
    shows,
    indexRoot: path.resolve(value("--index-root") ?? DEFAULT_INDEX_ROOT),
    manifest: path.resolve(value("--manifest") ?? DEFAULT_MANIFEST),
    normalizedRoot: path.resolve(value("--normalized-root") ?? DEFAULT_NORMALIZED_ROOT)
  };
}

/** One JSON line per event on stderr. */
export function jsonLineLogger(write: (line: string) => void = (line) => process.stderr.write(line)): RetrievalLogger {
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void =>
    write(`${JSON.stringify({ at: new Date().toISOString(), level, event, ...(fields ?? {}) })}\n`);
  return { info: (event, fields) => emit("info", event, fields), error: (event, fields) => emit("error", event, fields) };
}

/** The token from FORAY_RETRIEVAL_TOKEN, else the file FORAY_RETRIEVAL_TOKEN_FILE names. */
export function retrievalToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.FORAY_RETRIEVAL_TOKEN?.trim();
  if (direct) return direct;
  const file = env.FORAY_RETRIEVAL_TOKEN_FILE?.trim();
  if (!file) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-named secret file.
  const text = fs.readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : null;
}

/** The real archive: always re-read (a reload must see a new corpus digest). */
function loadArchiveFresh(): LoadedArchive {
  const saved = process.env.FORAY_SKIP_CATALOGUE_CACHE;
  process.env.FORAY_SKIP_CATALOGUE_CACHE = "1";
  let rows: TranscriptDigestEntry[];
  try {
    rows = loadTranscriptArchive();
  } finally {
    if (saved === undefined) delete process.env.FORAY_SKIP_CATALOGUE_CACHE;
    else process.env.FORAY_SKIP_CATALOGUE_CACHE = saved;
  }
  let generatedAt: string | null = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the fixed corpus-digest path under the repo root.
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CORPUS_DIGEST_FILE), "utf8")) as { generated_at?: unknown };
    generatedAt = typeof parsed.generated_at === "string" ? parsed.generated_at : null;
  } catch {
    /* No corpus digest on this box: the committed digests alone. */
  }
  return { rows, generatedAt };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<StartedRetrievalServer> {
  const args = parseRetrievalServerArgs(argv);
  const logger = jsonLineLogger();
  const token = retrievalToken();
  assertBindAllowed(args.host, token);
  const service = new RetrievalService({
    loadArchive: loadArchiveFresh,
    loadManifest: () => {
      const read = readEpisodeManifest(args.manifest);
      if (read && read.skipped > 0) logger.error("manifest-lines-skipped", { skipped: read.skipped });
      return read ? read.rows : null;
    },
    createCueStore: () => new FileTranscriptCueProvider(args.normalizedRoot),
    indexRoot: args.indexRoot,
    shows: args.shows,
    logger
  });
  const started = await startRetrievalServer({ service, token, logger, host: args.host, port: args.port });
  const stop = (): void => {
    void started.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return started;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
