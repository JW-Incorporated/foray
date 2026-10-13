import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { pathToFileURL } from "url";
import * as zlib from "zlib";
import { loadCatalogueData, type SemanticConcept } from "../generation/catalogueLookup";
import {
  DEFAULT_DENSE_EXTRA,
  mergeCandidates,
  MERGE_POLICIES,
  nodeShortlistQuery,
  rankByScore,
  reciprocalRankFusion,
  scorePassagesBm25,
  type BestPassage,
  type CandidateVia,
  type DenseHit,
  type MergePolicy,
  type ShortlistNode
} from "../generation/hybridRetrieval";
import { loadTaxonomyNodes } from "../generation/resolveTopic";
import { familyGateAllows, nodesForArchiveEntry } from "../generation/taxonomyFamily";
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
import {
  createR2BodyFetcher,
  CueCacheDir,
  DEFAULT_CUE_CACHE_GB,
  GB,
  isReadThroughCueStore,
  RemoteCueStore
} from "./remoteCueStore";

/**
 * THE RETRIEVAL SERVER (GV-16; roadmap docs/roadmap/generation-v2.md, from
 * W3-08; covers R1-09 and GP-09).
 *
 *     node tools/passage-index/serve.mjs [--host 127.0.0.1] [--port 7311] [--shows a,b]
 *       [--index-root DIR] [--manifest FILE] [--normalized-root DIR]
 *       [--passages-db FILE [--embedder stub|transformers|openai]]
 *       [--r2 [--cue-cache DIR] [--cue-cache-gb N]]
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
 *      map to (a store with no `bodyStat` cannot say, so it counts as unable);
 *      otherwise the show is left out and reported, never half-built.
 *      `--shows` limits the set on a small machine.
 * A show that is not resident is never searched, so a query can never trigger
 * a build inside a request.
 *
 * HTTP JSON API (node:http only; no outbound request is made, except the R2
 * body fetch of REMOTE BODIES below, and that only with --r2):
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
 *   GET  /v1/cues?show_id=&guid=  {cues, transcript_source} or 404. With
 *                    --r2 (GV-54) a body that is only in R2 is fetched first
 *                    (see REMOTE BODIES below); 503 when that fetch failed.
 *   GET  /v1/archive   {generated_at, transcripts}: the archive rows exactly
 *                    as loaded (tools/passage-index/pull-archive.mjs).
 *   GET  /healthz      {indexVersion, shows, episodes, archiveGeneratedAt}.
 *   POST /v1/reload    re-reads the archive, the manifest and the caches (and
 *                    the passage store's dense index, when there is one).
 *
 * THE DENSE ARM AND THE SHORTLIST (GV-48, from W3-09; covers R1-09, R2-04,
 * QK-22). Both need the passage store (tools/passage-index/store.mjs, GV-28),
 * which `main()` opens only with --passages-db, by dynamic import, so no
 * backend module or test ever loads node:sqlite. The service sees it through
 * the `PassageStore` and `QueryEmbedder` interfaces; tests inject fakes.
 *   POST /v1/search  {..., mode: "hybrid", policy?: "append"|"rrf"} embeds each
 *                    query once, searches the passages of the SCOPE's episodes,
 *                    and merges with `mergeCandidates` (hybridRetrieval.ts):
 *                    under 'append' (the default) every BM25 candidate keeps
 *                    its rank and at most DEFAULT_DENSE_EXTRA dense-only
 *                    episodes follow. Candidates gain `via` and, when the dense
 *                    arm found them, `passage` and `denseSim`. No mode (or
 *                    "bm25") is the BM25 answer above, unchanged. The client
 *                    sends "hybrid" only when FORAY_RETRIEVAL_MODE=hybrid.
 *   POST /v1/shortlist/rebuild {nodes?: [node_id]} for each data/taxonomy.json
 *                    node (or the ones named): query = label + child labels +
 *                    the terms of the semantic-index concepts the label
 *                    matches; scope = the archive entries the lineage gate
 *                    admits for the node; the top SHORTLIST_SIZE passages of a
 *                    hybrid passage search are stored in node_shortlist.
 *   GET  /v1/shortlist?node=&query=&limit=  the stored passages (text, seconds,
 *                    boundaries, anchors), reranked against `query` by cosine,
 *                    or by BM25 over the passage text with no embedder.
 *
 * REMOTE BODIES (GV-54, from W3-24; subsumes docs/roadmap/corpus.md PKG-24).
 * Only with --r2: the cue store is a `RemoteCueStore` (cli/remoteCueStore.ts)
 * that reads the local normalized directory, then the --cue-cache directory
 * (default data-local/passage-index/cue-cache, bounded by --cue-cache-gb,
 * default 20), then GETs the manifest row's origin key from R2 into that
 * cache. The index's body source is synchronous, so /v1/cues AWAITS that
 * fetch before it reads the cues through it. A missing object answers 404, a
 * failed fetch (no R2 key on this box, a network error) 503; neither stops the
 * server. This is the one outbound request the process can make, and only
 * with --r2. Without --r2 the store is the FileTranscriptCueProvider below,
 * exactly as before.
 *
 * AUTH. Bearer FORAY_RETRIEVAL_TOKEN (or the file named by
 * FORAY_RETRIEVAL_TOKEN_FILE). The default bind is 127.0.0.1; any other bind
 * is REFUSED without a token. With a token set, every /v1 route needs it.
 *
 * PRIVACY (§9.4). Search bodies carry beat claims, which are prompt-derived.
 * Nothing here logs or persists query text: a log line carries counts,
 * latencies and a 12-hex sha256 prefix per query, never the text, and the
 * only file this process writes is a show's index cache, which is built from
 * transcripts alone, and the node shortlists (built from taxonomy labels and
 * transcripts, never from a request's query). Responses are gzip-encoded for
 * a client that accepts it.
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
/** The remote cue store's cache directory (GV-54), used only with --r2. */
export const DEFAULT_CUE_CACHE = path.join(REPO_ROOT, "data-local", "passage-index", "cue-cache");
/** How long a scope lives after its last use. */
export const SCOPE_TTL_MS = 2 * 60 * 60 * 1000;
/** Request-size and shape bounds: a scope of every episode of a large corpus is
 * well under this; anything bigger is a client bug. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_QUERIES_PER_SEARCH = 256;
export const MAX_QUERY_CHARS = 20_000;
export const MAX_SEARCH_LIMIT = 200;
/** Dense passages a hybrid query reads before grouping them by episode: enough
 * for DEFAULT_DENSE_EXTRA new episodes past a full BM25 list. */
export const HYBRID_DENSE_PASSAGES = 200;
/** Passages kept per taxonomy node. */
export const SHORTLIST_SIZE = 50;
/** BM25 episodes a shortlist build pools; dense-only episodes may add as many. */
export const SHORTLIST_EPISODES = 50;
/** Dense passages a shortlist build reads to find its dense-only episodes. */
export const SHORTLIST_DENSE_PASSAGES = 200;

export interface RetrievalLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoadedArchive {
  rows: TranscriptDigestEntry[];
  /** The machine-local corpus digest's `generated_at`, or null without one. */
  generatedAt: string | null;
}

/** One passage of the store (passageCutter.ts `Passage`, as stored). */
export interface PassageRecord {
  passageId: string;
  show_id: string;
  guid: string;
  startSec: number;
  endSec: number;
  startBoundary: string;
  endBoundary: string;
  startAnchor: string | null;
  endAnchor: string | null;
  text: string;
}

/** A dense hit: a passage scored by its best chunk. */
export interface DensePassageHit {
  passageId: string;
  show_id: string;
  guid: string;
  sim: number;
}

export interface ShortlistRow {
  rank: number;
  passageId: string;
  score: number;
  builtAt: string;
}

/**
 * The passage store as the server uses it. The real one is
 * tools/passage-index/store.mjs `createServerPassageStore` (node:sqlite),
 * loaded only by `main()`; tests inject an in-memory fake.
 */
export interface PassageStore {
  /** Passages of `episodes` ([show_id, guid] pairs; null = every episode)
   * scored against the query vector, best first, at most `k`. */
  denseSearch(vector: ArrayLike<number>, options: { episodes: ReadonlyArray<readonly [string, string]> | null; k: number }): DensePassageHit[];
  passagesById(ids: readonly string[]): PassageRecord[];
  passagesForEpisodes(episodes: ReadonlyArray<readonly [string, string]>): PassageRecord[];
  /** Replace a node's shortlist whole, in one transaction. */
  replaceShortlist(nodeId: string, rows: ReadonlyArray<{ rank: number; passageId: string; score: number }>, builtAt: string): void;
  /** A node's stored rows, by rank. */
  readShortlist(nodeId: string): ShortlistRow[];
  /** Re-read the dense index (after an embed). */
  reload?(): void;
}

/** Encodes a query for the dense arm (the model row's query prefix is the
 * store's business). */
export interface QueryEmbedder {
  embedQuery(text: string): Promise<ArrayLike<number>>;
}

/** What a shortlist build reads: the taxonomy and the semantic index. */
export interface ShortlistTaxonomy {
  nodes: readonly ShortlistNode[];
  concepts: Readonly<Record<string, SemanticConcept>>;
}

/** The lineage gate sourcing uses (familyGateAllows / nodesForArchiveEntry). */
export interface LineageGate {
  nodesFor(entry: TranscriptDigestEntry): string[];
  allows(nodeId: string, nodes: string[]): boolean;
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
  /** The dense arm and the shortlists (GV-48): absent, mode 'hybrid' and the
   * shortlist routes answer 503 and the BM25 routes are unchanged. */
  passageStore?: PassageStore | null;
  /** Absent: no hybrid search, and a shortlist is lexical only (as it is when
   * the embedder's model has no vectors yet). */
  queryEmbedder?: QueryEmbedder | null;
  loadTaxonomy?: () => ShortlistTaxonomy;
  lineage?: LineageGate;
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

/** A hybrid candidate on the wire: the BM25 fields plus how it was found. The
 * idf stays on the result (the client gives every candidate that map). */
export interface WireHybridCandidate extends WireCandidate {
  via: CandidateVia;
  passage?: BestPassage;
  denseSim?: number;
}

export interface WireHybridResult {
  candidates: WireHybridCandidate[];
  idf: Record<string, number>;
}

export interface ShortlistBuild {
  builtAt: string;
  nodes: number;
  rows: number;
  /** Nodes whose lineage admits no episode (stored empty). */
  empty: string[];
  ms: number;
}

export interface ShortlistPassage extends PassageRecord {
  /** Position in this answer. */
  rank: number;
  /** Position in the stored shortlist. */
  storedRank: number;
  /** The build's fused score. */
  score: number;
  /** The rerank score against `query`; null without a query. */
  rerankScore: number | null;
}

export interface ShortlistAnswer {
  node: string;
  builtAt: string | null;
  reranked: "cosine" | "bm25" | null;
  passages: ShortlistPassage[];
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
const splitKey = (key: string): [string, string] => {
  const at = key.indexOf("\u0000");
  return [key.slice(0, at), key.slice(at + 1)];
};

/** Dense hits with their passages' bounds; a hit whose passage the store no
 * longer holds is dropped. */
function withBounds(store: PassageStore, hits: readonly DensePassageHit[]): DenseHit[] {
  if (hits.length === 0) return [];
  const records = new Map(store.passagesById([...new Set(hits.map((h) => h.passageId))]).map((p) => [p.passageId, p]));
  const out: DenseHit[] = [];
  for (const h of hits) {
    const p = records.get(h.passageId);
    if (!p) continue;
    out.push({
      passageId: h.passageId,
      show_id: h.show_id,
      guid: h.guid,
      sim: h.sim,
      startSec: p.startSec,
      endSec: p.endSec,
      startBoundary: p.startBoundary,
      endBoundary: p.endBoundary
    });
  }
  return out;
}

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
    this.options.passageStore?.reload?.();
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
      /* FAIL CLOSED. A store that cannot say whether it holds a body (no
         `bodyStat`, e.g. a read-through store) is not trusted to hold any:
         rebuilding over it could write a partial index over the cache file
         and hold the show resident half-built. */
      const storeStat = cueStore.bodyStat;
      if (!storeStat) {
        logger.error("cache-not-rebuilt", { show: showId, missingBodies: entries.length, reason: "store-cannot-stat" });
        continue;
      }
      const missing = entries.filter((e) => storeStat.call(cueStore, e) === null).length;
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
    const { scope, parsed } = this.parseSearch(scopeId, queries);
    return this.searchParsed(this.snapshot, scope, parsed);
  }

  private parseSearch(scopeId: unknown, queries: unknown): { scope: Scope; parsed: Array<{ text: string; limit: number }> } {
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
    return { scope, parsed };
  }

  private searchParsed(snapshot: Snapshot, scope: Scope, parsed: Array<{ text: string; limit: number }>): WireSearchResult[] {
    const { index, resident } = snapshot;
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

  /**
   * Mode 'hybrid' (GV-48): the BM25 answer of `search`, merged with the dense
   * passages of the scope's episodes. Each query is embedded once. A dense hit
   * outside the scope, or on an episode the archive does not hold, is dropped
   * here even if the store returned it, so the scope is enforced twice.
   */
  async searchHybrid(scopeId: unknown, queries: unknown, policy: unknown = "append"): Promise<WireHybridResult[]> {
    const store = this.options.passageStore;
    const embedder = this.options.queryEmbedder;
    if (!store || !embedder) throw new HttpError(503, "hybrid search needs the passage store and a query embedder (--passages-db, --embedder)");
    if (typeof policy !== "string" || !MERGE_POLICIES.includes(policy as MergePolicy)) {
      throw new HttpError(400, `policy must be one of ${MERGE_POLICIES.join(", ")}`);
    }
    const { scope, parsed } = this.parseSearch(scopeId, queries);
    const snapshot = this.snapshot;
    const lexical = this.searchParsed(snapshot, scope, parsed);
    const keys = scope.keys;
    const inScope = (showId: string, guid: string): boolean => {
      const key = keyOf(showId, guid);
      return snapshot.byKey.has(key) && (keys === "all" || keys.has(key));
    };
    const episodes = keys === "all" ? null : [...keys].map(splitKey);
    const out: WireHybridResult[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const text = (parsed[i] as { text: string }).text;
      const answer = lexical[i] as WireSearchResult;
      const vector = await this.embed(embedder, text);
      const hits = store.denseSearch(vector, { episodes, k: HYBRID_DENSE_PASSAGES }).filter((h) => inScope(h.show_id, h.guid));
      const merged = mergeCandidates(answer.candidates, withBounds(store, hits), {
        policy: policy as MergePolicy,
        denseExtra: DEFAULT_DENSE_EXTRA,
        idf: new Map(Object.entries(answer.idf))
      });
      out.push({
        candidates: merged.map((c) => ({
          show_id: c.show_id,
          guid: c.guid,
          score: c.score,
          matchedTerms: c.matchedTerms,
          rank: c.rank,
          via: c.via,
          ...(c.passage ? { passage: c.passage } : {}),
          ...(c.denseSim !== null ? { denseSim: c.denseSim } : {})
        })),
        idf: answer.idf
      });
    }
    return out;
  }

  /** A query vector, or 503: an embedder failure never becomes a 500, and its
   * message (which may be anything) is not passed on; the log gets its class. */
  private async embed(embedder: QueryEmbedder, text: string): Promise<ArrayLike<number>> {
    try {
      return await embedder.embedQuery(text);
    } catch (error) {
      this.options.logger.error("embed-failed", { error: error instanceof Error ? error.name : typeof error });
      throw new HttpError(503, "the query embedder failed");
    }
  }

  private requireShortlistDeps(): { store: PassageStore; taxonomy: ShortlistTaxonomy; lineage: LineageGate } {
    const store = this.options.passageStore;
    const { loadTaxonomy, lineage } = this.options;
    if (!store || !loadTaxonomy || !lineage) throw new HttpError(503, "the shortlist needs the passage store (--passages-db)");
    return { store, taxonomy: loadTaxonomy(), lineage };
  }

  /**
   * POST /v1/shortlist/rebuild (GV-48). For each node: its query
   * (`nodeShortlistQuery`), its scope (the archive entries the lineage gate
   * admits), then a hybrid PASSAGE search over that scope:
   *   1. the episode pool: the top SHORTLIST_EPISODES BM25 episodes, plus the
   *      dense-only episodes among the top SHORTLIST_DENSE_PASSAGES passages
   *      ('append', so the BM25 pool is whole);
   *   2. every passage of the pool, ranked twice: BM25 over the passage text
   *      (with the episode search's corpus idf) and cosine to the query;
   *   3. the two rankings fused by RRF; the top SHORTLIST_SIZE are stored.
   * Without an embedder, or when the query embedding fails (the model has no
   * vectors yet), step 2 is the BM25 ranking alone. A node whose lineage
   * admits nothing is stored empty. Yields to the event loop between nodes.
   */
  async rebuildShortlist(nodes?: unknown): Promise<ShortlistBuild> {
    const { store, taxonomy, lineage } = this.requireShortlistDeps();
    const embedder = this.options.queryEmbedder ?? null;
    let targets: ShortlistNode[];
    if (nodes === undefined || nodes === null) {
      targets = [...taxonomy.nodes];
    } else {
      if (!Array.isArray(nodes) || nodes.some((n) => typeof n !== "string")) throw new HttpError(400, "nodes must be an array of taxonomy node ids");
      const byId = new Map(taxonomy.nodes.map((n) => [n.id, n]));
      const unknownIds = (nodes as string[]).filter((id) => !byId.has(id));
      if (unknownIds.length > 0) throw new HttpError(400, `unknown taxonomy node(s): ${unknownIds.slice(0, 5).join(", ")}`);
      targets = [...new Set(nodes as string[])].map((id) => byId.get(id) as ShortlistNode);
    }
    const started = this.now();
    const builtAt = new Date(started).toISOString();
    const snapshot = this.snapshot;
    const nodesOf = new Map<TranscriptDigestEntry, string[]>();
    for (const entry of snapshot.archive) nodesOf.set(entry, lineage.nodesFor(entry));
    let rows = 0;
    const empty: string[] = [];
    for (const node of targets) {
      const admitted = new Set<string>();
      for (const entry of snapshot.archive) {
        if (lineage.allows(node.id, nodesOf.get(entry) ?? [])) admitted.add(keyOf(String(entry.show_id), String(entry.guid)));
      }
      if (admitted.size === 0) empty.push(node.id);
      const picked =
        admitted.size === 0 ? [] : await this.shortlistFor(snapshot, store, embedder, nodeShortlistQuery(node, taxonomy.nodes, taxonomy.concepts), admitted);
      store.replaceShortlist(node.id, picked, builtAt);
      rows += picked.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const build: ShortlistBuild = { builtAt, nodes: targets.length, rows, empty, ms: this.now() - started };
    this.options.logger.info("shortlist-rebuilt", { nodes: build.nodes, rows, empty: empty.length, ms: build.ms });
    return build;
  }

  private async shortlistFor(
    snapshot: Snapshot,
    store: PassageStore,
    embedder: QueryEmbedder | null,
    query: string,
    admitted: Set<string>
  ): Promise<Array<{ rank: number; passageId: string; score: number }>> {
    const isUsable = (entry: TranscriptDigestEntry): boolean =>
      snapshot.resident.has(entry.show_id) && admitted.has(keyOf(String(entry.show_id), String(entry.guid)));
    const lexical = snapshot.index.searchWithIdf(query, { limit: SHORTLIST_EPISODES, isUsable });
    const bm25 = lexical.candidates.map((c) => ({
      show_id: String(c.entry.show_id),
      guid: String(c.entry.guid),
      score: c.score,
      matchedTerms: c.matchedTerms,
      rank: c.rank
    }));
    const inAdmitted = (h: { show_id: string; guid: string }): boolean => admitted.has(keyOf(h.show_id, h.guid));
    let vector: ArrayLike<number> | null = null;
    if (embedder) {
      try {
        vector = await embedder.embedQuery(query);
      } catch (error) {
        /* The embedder's model has no vectors in this store yet (or the
           embedder failed): this node's shortlist is lexical only, not a 503.
           The log gets the error class, never the query. */
        this.options.logger.error("shortlist-embed-failed", { error: error instanceof Error ? error.name : typeof error, fallback: "lexical" });
      }
    }
    const denseHits = vector
      ? store.denseSearch(vector, { episodes: [...admitted].map(splitKey), k: SHORTLIST_DENSE_PASSAGES }).filter(inAdmitted)
      : [];
    const pool = mergeCandidates(bm25, withBounds(store, denseHits), { policy: "append", denseExtra: SHORTLIST_EPISODES });
    if (pool.length === 0) return [];
    const poolPairs = pool.map((c) => [c.show_id, c.guid] as [string, string]);
    const passages = store.passagesForEpisodes(poolPairs).filter(inAdmitted);
    if (passages.length === 0) return [];
    const rankings: string[][] = [rankByScore(scorePassagesBm25(query, passages, { idf: lexical.idf }))];
    if (vector) {
      const ids = new Set(passages.map((p) => p.passageId));
      rankings.push(
        store
          .denseSearch(vector, { episodes: poolPairs, k: passages.length })
          .filter((h) => ids.has(h.passageId))
          .map((h) => h.passageId)
      );
    }
    const fused = reciprocalRankFusion(rankings);
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, SHORTLIST_SIZE)
      .map(([passageId, score], rank) => ({ rank, passageId, score }));
  }

  /**
   * GET /v1/shortlist (GV-48): a node's stored passages, reranked against
   * `query` by cosine (with an embedder) or by BM25 over the passage text, and
   * cut to `limit`. Without a query, the stored order.
   */
  async shortlist(nodeId: unknown, query: unknown, limitText: unknown): Promise<ShortlistAnswer> {
    const { store, taxonomy } = this.requireShortlistDeps();
    if (typeof nodeId !== "string" || nodeId.length === 0) throw new HttpError(400, "node is required");
    if (!taxonomy.nodes.some((n) => n.id === nodeId)) throw new HttpError(404, "unknown taxonomy node");
    if (query !== null && query !== undefined && (typeof query !== "string" || query.length > MAX_QUERY_CHARS)) {
      throw new HttpError(400, `query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    const limit = limitText === null || limitText === undefined || limitText === "" ? SHORTLIST_SIZE : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > SHORTLIST_SIZE) throw new HttpError(400, `limit must be an integer 1..${SHORTLIST_SIZE}`);
    const rows = store.readShortlist(nodeId);
    const records = new Map(store.passagesById(rows.map((r) => r.passageId)).map((p) => [p.passageId, p]));
    const present = rows.filter((r) => records.has(r.passageId));
    const recordOf = (r: ShortlistRow): PassageRecord => records.get(r.passageId) as PassageRecord;
    const text = typeof query === "string" ? query.trim() : "";
    let rerank: Map<string, number> | null = null;
    let reranked: ShortlistAnswer["reranked"] = null;
    if (text.length > 0 && present.length > 0) {
      const embedder = this.options.queryEmbedder;
      if (embedder) {
        const vector = await this.embed(embedder, text);
        const ids = new Set(present.map((r) => r.passageId));
        const pairs = [...new Set(present.map((r) => keyOf(recordOf(r).show_id, recordOf(r).guid)))].map(splitKey);
        rerank = new Map(
          store
            .denseSearch(vector, { episodes: pairs, k: Infinity })
            .filter((h) => ids.has(h.passageId))
            .map((h) => [h.passageId, h.sim])
        );
        reranked = "cosine";
      } else {
        rerank = scorePassagesBm25(text, present.map(recordOf));
        reranked = "bm25";
      }
    }
    const scores = rerank;
    const ordered = scores
      ? [...present].sort((a, b) => (scores.get(b.passageId) ?? -Infinity) - (scores.get(a.passageId) ?? -Infinity) || a.rank - b.rank)
      : present;
    return {
      node: nodeId,
      builtAt: rows[0]?.builtAt ?? null,
      reranked,
      passages: ordered.slice(0, limit).map((r, rank) => ({
        ...recordOf(r),
        rank,
        storedRank: r.rank,
        score: r.score,
        rerankScore: scores ? (scores.get(r.passageId) ?? null) : null
      }))
    };
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
   * body is unknown. Reads only what is on this box (see `fetchCues`). */
  cues(showId: unknown, guid: unknown): { cues: unknown[]; transcript_source: string | null } {
    const snapshot = this.snapshot;
    return this.cuesOf(snapshot, this.entryOf(snapshot, showId, guid));
  }

  /**
   * GET /v1/cues (GV-54): `cues`, after the cue store has brought the body
   * onto this box when it can (a read-through store, --r2). The fetch is
   * awaited here because the body source the index reads is synchronous. A
   * failed fetch is 503 (the client records it as degraded and may ask
   * again); a missing or refused object falls through to the 404 of `cues`.
   * A plain store (no --r2) is read exactly as `cues` reads it.
   */
  async fetchCues(showId: unknown, guid: unknown): Promise<{ cues: unknown[]; transcript_source: string | null }> {
    const snapshot = this.snapshot;
    const entry = this.entryOf(snapshot, showId, guid);
    const store = snapshot.cueStore;
    if (isReadThroughCueStore(store)) {
      const outcome = await store.ensureBody(entry, snapshot.manifest ? snapshot.manifest.rowFor(entry) : null);
      if (outcome.status === "failed") throw new HttpError(503, "the remote body fetch failed; try again later");
    }
    return this.cuesOf(snapshot, entry);
  }

  private entryOf(snapshot: Snapshot, showId: unknown, guid: unknown): TranscriptDigestEntry {
    if (typeof showId !== "string" || typeof guid !== "string" || showId.length === 0 || guid.length === 0) {
      throw new HttpError(400, "show_id and guid are required");
    }
    const entry = snapshot.byKey.get(keyOf(showId, guid));
    if (!entry) throw new HttpError(404, "unknown episode");
    return entry;
  }

  private cuesOf(snapshot: Snapshot, entry: TranscriptDigestEntry): { cues: unknown[]; transcript_source: string | null } {
    const cues = snapshot.bodies.getCues(entry);
    if (!cues) throw new HttpError(404, "no body for this episode");
    let source: string | null;
    try {
      source = snapshot.bodies.transcriptSource ? snapshot.bodies.transcriptSource(entry) : null;
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
        "/v1/shortlist/rebuild": "POST",
        "/v1/shortlist": "GET",
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
          const body = (await readBody(req)) as { scopeId?: unknown; queries?: unknown; mode?: unknown; policy?: unknown };
          const queries = Array.isArray(body?.queries) ? (body.queries as Array<{ text?: unknown }>) : [];
          fields.queries = queries.length;
          fields.queryHashes = queries.map((q) => (typeof q?.text === "string" ? queryHash(q.text) : null));
          const mode = body?.mode;
          /* No mode, or "bm25": the BM25 answer exactly as before GV-48. */
          if (mode === undefined || mode === null || mode === "bm25") {
            const results = service.search(body?.scopeId, body?.queries);
            fields.candidates = results.map((r) => r.candidates.length);
            return { status: 200, payload: { results } };
          }
          if (mode !== "hybrid") throw new HttpError(400, 'mode must be "bm25" or "hybrid"');
          fields.mode = "hybrid";
          const results = await service.searchHybrid(body?.scopeId, body?.queries, body?.policy ?? "append");
          fields.candidates = results.map((r) => r.candidates.length);
          fields.dense = results.map((r) => r.candidates.filter((c) => c.via === "dense").length);
          return { status: 200, payload: { results } };
        }
        case "/v1/shortlist/rebuild": {
          const body = (await readBody(req)) as { nodes?: unknown };
          const build = await service.rebuildShortlist(body?.nodes);
          fields.nodes = build.nodes;
          fields.rows = build.rows;
          return { status: 200, payload: build };
        }
        case "/v1/shortlist": {
          const query = url.searchParams.get("query");
          if (query) fields.queryHash = queryHash(query);
          const answer = await service.shortlist(url.searchParams.get("node"), query, url.searchParams.get("limit"));
          fields.node = answer.node;
          fields.passages = answer.passages.length;
          return { status: 200, payload: answer };
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
          const out = await service.fetchCues(url.searchParams.get("show_id"), url.searchParams.get("guid"));
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
  /** The passage store (GV-48); null: no dense arm and no shortlist. */
  passagesDb: string | null;
  /** The query embedder kind (tools/passage-index/embedder.mjs); null: none. */
  embedder: string | null;
  /** GV-54: serve bodies that are only in R2 through the remote cue store. */
  r2: boolean;
  /** The remote cue store's cache directory (only with --r2). */
  cueCache: string;
  /** Its byte bound, in GB (1e9 bytes, as the stream indexer counts). */
  cueCacheGb: number;
}

/** tools/passage-index/embedder.mjs EMBEDDER_KINDS. */
export const EMBEDDER_KINDS = ["stub", "transformers", "openai"] as const;

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
  const embedder = value("--embedder");
  if (embedder !== null && !(EMBEDDER_KINDS as readonly string[]).includes(embedder)) {
    throw new Error(`--embedder must be one of ${EMBEDDER_KINDS.join(", ")}, got ${embedder}`);
  }
  const passagesDb = value("--passages-db");
  if (embedder !== null && passagesDb === null) throw new Error("--embedder needs --passages-db");
  const cueCacheText = value("--cue-cache");
  const cueCacheGbText = value("--cue-cache-gb");
  const r2 = argv.includes("--r2");
  if (!r2 && (cueCacheText !== null || cueCacheGbText !== null)) throw new Error("--cue-cache and --cue-cache-gb need --r2");
  const cueCacheGb = cueCacheGbText === null ? DEFAULT_CUE_CACHE_GB : Number(cueCacheGbText);
  if (!Number.isFinite(cueCacheGb) || cueCacheGb <= 0) throw new Error(`--cue-cache-gb must be a number > 0, got ${cueCacheGbText}`);
  const portText = value("--port");
  const port = portText === null ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0..65535, got ${portText}`);
  return {
    host: value("--host") ?? DEFAULT_HOST,
    port,
    shows,
    indexRoot: path.resolve(value("--index-root") ?? DEFAULT_INDEX_ROOT),
    manifest: path.resolve(value("--manifest") ?? DEFAULT_MANIFEST),
    normalizedRoot: path.resolve(value("--normalized-root") ?? DEFAULT_NORMALIZED_ROOT),
    passagesDb: passagesDb === null ? null : path.resolve(passagesDb),
    embedder,
    r2,
    cueCache: path.resolve(cueCacheText ?? DEFAULT_CUE_CACHE),
    cueCacheGb
  };
}

/** The passage store's server adapter (tools/passage-index/store.mjs). */
interface ServerPassageStoreModule {
  openStore(dbPath: string): unknown;
  createServerPassageStore(db: unknown, options: { embedder: unknown }): { passageStore: PassageStore; queryEmbedder: QueryEmbedder | null };
}

/**
 * Open the passage store and the query embedder, by DYNAMIC import: only this
 * path loads node:sqlite (flagged behind --experimental-sqlite before Node
 * 22.13), so the BM25 server and every backend test run without it.
 */
async function loadPassageStore(args: RetrievalServerArgs): Promise<{ passageStore: PassageStore; queryEmbedder: QueryEmbedder | null } | null> {
  if (args.passagesDb === null) return null;
  const toolsDir = path.join(REPO_ROOT, "tools", "passage-index");
  const storeModule = (await import(pathToFileURL(path.join(toolsDir, "store.mjs")).href)) as ServerPassageStoreModule;
  let embedder: unknown = null;
  if (args.embedder !== null) {
    const embedderModule = (await import(pathToFileURL(path.join(toolsDir, "embedder.mjs")).href)) as {
      createPassageEmbedder(options: { kind: string }): Promise<unknown>;
    };
    embedder = await embedderModule.createPassageEmbedder({ kind: args.embedder });
  }
  return storeModule.createServerPassageStore(storeModule.openStore(args.passagesDb), { embedder });
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
  const dense = await loadPassageStore(args);
  if (dense) logger.info("passage-store", { embedder: args.embedder ?? "none" });
  /* GV-54: one fetcher for the process (its R2 client is built on first use;
     with no key on this box each fetch fails and is answered 503). */
  const fetchBody = args.r2 ? createR2BodyFetcher() : null;
  if (fetchBody) logger.info("remote-cue-store", { cueCache: args.cueCache, cueCacheGb: args.cueCacheGb });
  const service = new RetrievalService({
    loadArchive: loadArchiveFresh,
    loadManifest: () => {
      const read = readEpisodeManifest(args.manifest);
      if (read && read.skipped > 0) logger.error("manifest-lines-skipped", { skipped: read.skipped });
      return read ? read.rows : null;
    },
    createCueStore: () =>
      fetchBody
        ? new RemoteCueStore({
            normalizedRoot: args.normalizedRoot,
            cache: new CueCacheDir(args.cueCache, args.cueCacheGb * GB),
            fetchBody,
            logger
          })
        : new FileTranscriptCueProvider(args.normalizedRoot),
    indexRoot: args.indexRoot,
    shows: args.shows,
    logger,
    passageStore: dense?.passageStore ?? null,
    queryEmbedder: dense?.queryEmbedder ?? null,
    loadTaxonomy: () => ({ nodes: loadTaxonomyNodes(), concepts: loadCatalogueData().concepts }),
    lineage: { nodesFor: (entry) => nodesForArchiveEntry(entry), allows: (nodeId, nodes) => familyGateAllows(nodeId, nodes) }
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
