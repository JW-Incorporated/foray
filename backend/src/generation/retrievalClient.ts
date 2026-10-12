import { TranscriptSourceSchema, type TranscriptSource } from "../types/tapeSourcing";
import { familyGateAllows, nodesForArchiveEntry } from "./taxonomyFamily";
import {
  cuesFromBodyJson,
  guidIndexOfListing,
  locateInListing,
  type TranscriptCue,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import { corpusSafeKey } from "./transcriptCorpus";
import {
  NullTranscriptTextIndex,
  TRANSCRIPT_TEXT_CANDIDATES,
  type TranscriptBodySource,
  type TranscriptBodyStat,
  type TranscriptTextCandidate,
  type TranscriptTextIndex,
  type TranscriptTextSearchOptions
} from "./transcriptTextIndex";

/**
 * THE BACKEND'S RETRIEVAL CLIENT (GV-29; roadmap
 * docs/roadmap/generation-v2.md, from W3-10; covers R1-09 and GP-09).
 *
 * WHAT IT IS FOR. Sourcing is synchronous: `sourceBeats` and
 * `TranscriptCueProvider.getCues` return values, not promises, and every gate
 * in §4.5 is written against that. The retrieval server (GV-16,
 * `cli/retrievalServer.ts`) answers over HTTP. This module bridges the two
 * WITHOUT making sourcing async: every search a run will ask is sent to the
 * server AHEAD of the stage (`prepare`), every body it will open is fetched
 * ahead (`hydrate`), and the synchronous seams then read the stored answers.
 *
 *   RemoteRetrieval       the network half: /v1/episodes, /v1/scopes,
 *                         /v1/search and /v1/cues, each bounded by a timeout.
 *   PrecomputedTextIndex  a `TranscriptTextIndex` over the prepared answers,
 *                         keyed by scope + limit + query text (verbatim).
 *   HydratingCueProvider  a `TranscriptBodySource` over the hydrated bodies,
 *                         with `bodyStat` answered from the server's manifest.
 *
 * A KEY IS THE EXACT QUESTION. An answer is stored under
 * `${scope}\u0000${limit}\u0000${text}` with the text verbatim, because a
 * precomputed answer is only right for the string it was computed for. A
 * search for any other key is a MISS: it is counted and handed to the
 * fallback index (`NullTranscriptTextIndex` by default), never guessed at.
 * The wiring card (GV-95, from W3-11) prepares the strings the call sites
 * actually pass; `misses` and `hydrationMisses` are how any drift shows.
 *
 * TWO SCOPES PER FORAY, chosen by the presence of `isUsable` exactly as the
 * call sites use it:
 *   'lineage'  every archive entry `familyGateAllows(topic,
 *              nodesForArchiveEntry(entry, root), root)` admits: the predicate
 *              of researchShape's subtopic search and sourceBeats'
 *              `usableArchiveEntry`, decided HERE on the client, by the same
 *              code sourcing runs (the server never decides lineage).
 *   'all'      no predicate: researchShape's `probeSubjectTape`.
 *
 * NEVER THROWS ON THE NETWORK. A refused connection, an HTTP error, a
 * malformed reply or a timeout resolves with a recorded degraded reason; the
 * answer is simply not stored, so the synchronous seam misses and falls back.
 * A reason names the operation and the failure, never the query text (§9.4:
 * beat claims are prompt-derived).
 *
 * NO PERSISTENCE. Nothing here writes to disk; answers and bodies live in
 * memory for the run (`promptNoPersistence.test.ts` holds without an
 * exemption). It is the one generation module besides the provider call sites
 * allowed to call `fetch(` (GV-19's guard in `anthropicCall.test.ts`), which is
 * why it is a separate module: sourceBeats.ts and its neighbours stay
 * fetch-free (`sourceBeats.test.ts`'s structural check).
 *
 * INERT UNTIL CONSTRUCTED. Nothing builds these classes yet; GV-95 builds them
 * only when FORAY_RETRIEVAL_URL is set, so default generation is unchanged.
 */

/** Per-request budget. */
export const RETRIEVAL_TIMEOUT_MS = 3000;
/** Bodies fetched at once by `hydrate`. */
export const HYDRATE_CONCURRENCY = 8;
/** The hydrated-body memory bound: pins count toward it. */
export const HYDRATED_BODY_BUDGET_BYTES = 512 * 1024 * 1024;
/** Queries per POST /v1/search: the server's MAX_QUERIES_PER_SEARCH. */
export const SEARCH_BATCH_QUERIES = 256;
/** The server's MAX_SEARCH_LIMIT and MAX_QUERY_CHARS: a request outside them
 * is not sent (it would be refused) and stays a miss. */
export const MAX_REMOTE_SEARCH_LIMIT = 200;
export const MAX_REMOTE_QUERY_CHARS = 20_000;
/** How many degraded reasons `stats()` keeps (the count is exact). */
export const MAX_DEGRADED_REASONS = 50;

export type RetrievalScope = "lineage" | "all";
/** FORAY_RETRIEVAL_MODE's values (GV-95 reads the flag). 'hybrid' is sent to
 * the server only when chosen; bm25 sends no mode at all (GV-48). */
export type RetrievalMode = "bm25" | "hybrid";

/* ---------------------------------------------------------------------------
   Fetch shape, declared here like jevClient.ts's: Node's global fetch
   satisfies it, and a test injects a fake.
   --------------------------------------------------------------------------- */

export interface RetrievalFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface RetrievalFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export type RetrievalFetch = (url: string, init: RetrievalFetchInit) => Promise<RetrievalFetchResponse>;

export interface RemoteRetrievalOptions {
  /** e.g. http://127.0.0.1:7311 (no trailing /v1). */
  baseUrl: string;
  /** Bearer FORAY_RETRIEVAL_TOKEN; omitted for a loopback server without one. */
  token?: string | null;
  fetchFn?: RetrievalFetch;
  timeoutMs?: number;
  mode?: RetrievalMode;
  /** The archive rows this process sources from: answers and episodes are
   * mapped back onto these entries by show_id + guid. */
  archive: readonly TranscriptDigestEntry[];
  /** Memory bound for hydrated bodies (bytes of their JSON). */
  maxBodyBytes?: number;
  /** Bodies in flight during `hydrate`. */
  concurrency?: number;
}

/** One question a run will ask the index. */
export interface RetrievalSearchRequest {
  scope: RetrievalScope;
  text: string;
  limit: number;
}

/** A row of GET /v1/episodes. */
export interface RemoteEpisodeRow {
  show_id: string;
  guid: string;
  size: number;
  mtimeMs: number;
  transcript_source: string | null;
}

/** Hints a later card reads (GV-48's hybrid merge): how a candidate was found
 * and its best passage, carried beside the candidate rather than on it. */
export interface CandidateHint {
  via?: string;
  passage?: unknown;
}

export interface RetrievalStats {
  /** Answers stored by `prepare`. */
  prepared: number;
  /** Searches answered from a stored answer. */
  hits: number;
  /** Searches with no stored answer, handed to the fallback. */
  misses: number;
  /** Network operations that failed (timeout, refusal, HTTP error, bad reply). */
  degraded: number;
  /** Bodies fetched and held (present bodies only). */
  hydrated: number;
  /** `getCues` for an entry that was never hydrated (or was evicted). */
  hydrationMisses: number;
  /** Episodes the server reported as having no body (404). */
  hydrationAbsent: number;
  /** Server candidates or episode rows with no archive entry here, dropped. */
  unmapped: number;
  /** Requests not sent because the server would refuse them (limit or length). */
  unprepared: number;
  /** Bodies dropped by the memory bound, and how many of those were pinned. */
  evictions: number;
  evictedPinned: number;
  /** Bytes of the bodies held now, and how many entries are pinned. */
  heldBytes: number;
  pinned: number;
  /** Debug only: a lineage predicate whose admitted set differs from the scope. */
  scopeMismatches: number;
  /** The first MAX_DEGRADED_REASONS degraded reasons. Never query text. */
  reasons: string[];
}

/** The stored key for a prepared search: scope, limit and the verbatim text. */
export function precomputedKey(scope: RetrievalScope, limit: number, text: string): string {
  return `${scope}\u0000${limit}\u0000${text}`;
}

const entryKey = (showId: string, guid: string): string => `${showId}\u0000${guid}`;
const keyOfEntry = (entry: TranscriptDigestEntry): string => entryKey(String(entry.show_id), String(entry.guid));

/**
 * The provenance a normalized body records, by THE SAME RULE as
 * `FileTranscriptCueProvider.transcriptSource` (transcriptArchiveLookup.ts):
 * a stated `transcript_source` in the vocabulary wins, one outside it THROWS
 * (a writer bug must not be coerced onto a minted segment); otherwise a
 * `source_url` or a `raw/` `regenerated_from` means the publisher's
 * transcript, and neither means this machine transcribed it (`asr-local`).
 * Restated rather than imported because the provider's rule reads a file; the
 * parity test in retrievalClient.test.ts pins the two together.
 */
export function transcriptSourceOfBody(json: unknown): TranscriptSource {
  const j = (json !== null && typeof json === "object" ? json : {}) as {
    source_url?: unknown;
    regenerated_from?: unknown;
    transcript_source?: unknown;
  };
  if (j.transcript_source !== undefined && j.transcript_source !== null) {
    const stated = TranscriptSourceSchema.safeParse(j.transcript_source);
    if (stated.success) return stated.data;
    throw new Error(
      `transcript body states transcript_source ${JSON.stringify(j.transcript_source)}, ` +
        `which is not one of ${TranscriptSourceSchema.options.join("/")}`
    );
  }
  const fetchedFromPublisher =
    (typeof j.source_url === "string" && j.source_url.trim().length > 0) ||
    (typeof j.regenerated_from === "string" && /^raw[\\/]/.test(j.regenerated_from));
  return fetchedFromPublisher ? "publisher" : "asr-local";
}

interface StoredAnswer {
  candidates: TranscriptTextCandidate[];
  idf: ReadonlyMap<string, number>;
  hints: Map<TranscriptDigestEntry, CandidateHint>;
}

interface HeldBody {
  /** Null: the server holds no body for this episode. */
  cues: TranscriptCue[] | null;
  /** The provenance fields of the body, for `transcriptSourceOfBody`. */
  source: { transcript_source?: unknown; source_url?: unknown; regenerated_from?: unknown } | null;
  bytes: number;
  pinned: boolean;
}

interface ShowListing {
  files: Map<string, string>;
  byName: Map<string, RemoteEpisodeRow>;
  guidIndex: Map<string, string> | null;
}

type CallResult = { ok: true; json: unknown; bytes: number } | { ok: false; status?: number; reason: string };

function isEpisodeRow(value: unknown): value is RemoteEpisodeRow {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.show_id === "string" &&
    typeof v.guid === "string" &&
    typeof v.size === "number" &&
    Number.isFinite(v.size) &&
    typeof v.mtimeMs === "number" &&
    Number.isFinite(v.mtimeMs)
  );
}

/**
 * The network half. One instance per generation process; `prepareScope` is
 * called once per Foray (it replaces the previous Foray's scopes).
 */
export class RemoteRetrieval {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchFn: RetrievalFetch | null;
  private readonly timeoutMs: number;
  private readonly mode: RetrievalMode;
  private readonly maxBodyBytes: number;
  private readonly concurrency: number;
  private readonly archiveByKey = new Map<string, TranscriptDigestEntry>();
  private readonly archive: readonly TranscriptDigestEntry[];

  private readonly listings = new Map<string, ShowListing>();
  private readonly located = new Map<string, RemoteEpisodeRow | null>();
  private manifestLoaded = false;

  private scopeIds: { lineage: string | null; all: string | null } = { lineage: null, all: null };
  private lineageKeys: Set<string> | null = null;
  /** Bumped by every `prepareScope`: which lineage scope a debug check saw. */
  private scopeGeneration = 0;
  private readonly answers = new Map<string, StoredAnswer>();
  /** Insertion order is recency: the first entry is the least recently used. */
  private readonly bodies = new Map<string, HeldBody>();
  /* The hydration limit belongs to the INSTANCE, not to one `hydrate` call:
     /v1/cues requests in flight, the FIFO of fetches waiting for a slot, and
     the bodies being fetched now (so an overlapping hydrate waits for the same
     fetch instead of sending a second one). */
  private cuesInFlight = 0;
  private readonly cuesWaiters: Array<() => void> = [];
  private readonly bodiesInFlight = new Map<string, Promise<boolean>>();

  private readonly counters = {
    hits: 0,
    misses: 0,
    degraded: 0,
    hydrated: 0,
    hydrationMisses: 0,
    hydrationAbsent: 0,
    unmapped: 0,
    unprepared: 0,
    evictions: 0,
    evictedPinned: 0,
    heldBytes: 0,
    scopeMismatches: 0
  };
  private readonly reasons: string[] = [];

  constructor(options: RemoteRetrievalOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token && options.token.length > 0 ? options.token : null;
    this.fetchFn = options.fetchFn ?? ((globalThis as { fetch?: RetrievalFetch }).fetch ?? null);
    this.timeoutMs = options.timeoutMs ?? RETRIEVAL_TIMEOUT_MS;
    this.mode = options.mode ?? "bm25";
    this.maxBodyBytes = options.maxBodyBytes ?? HYDRATED_BODY_BUDGET_BYTES;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? HYDRATE_CONCURRENCY));
    this.archive = options.archive;
    for (const entry of options.archive) this.archiveByKey.set(keyOfEntry(entry), entry);
  }

  /* ------------------------------------------------------------------ */
  /* Manifest                                                             */
  /* ------------------------------------------------------------------ */

  /** GET /v1/episodes: what `bodyStat` answers from. Resolves false when
   * degraded, and `bodyStat` then answers null for every entry. */
  async loadManifest(): Promise<boolean> {
    const reply = await this.call("GET", "/v1/episodes");
    if (!reply.ok) return this.degrade("episodes", reply.reason);
    if (!Array.isArray(reply.json)) return this.degrade("episodes", "reply is not an array");
    this.listings.clear();
    this.located.clear();
    for (const row of reply.json as unknown[]) {
      if (!isEpisodeRow(row)) {
        this.counters.unmapped += 1;
        continue;
      }
      let listing = this.listings.get(row.show_id);
      if (!listing) {
        listing = { files: new Map(), byName: new Map(), guidIndex: null };
        this.listings.set(row.show_id, listing);
      }
      /* The server keyed each row by ITS archive guid; the name a writer
         would have given that guid's body stands in for a file name, and the
         guid stands in for what the body records, so GV-05's locate rule maps
         this process's archive rows onto them as it maps them onto a listing. */
      const name = `${corpusSafeKey(row.guid)}.json`;
      listing.files.set(name.toLowerCase(), name);
      listing.byName.set(name, row);
    }
    this.manifestLoaded = true;
    return true;
  }

  /** The manifest row an archive entry maps to, or null. */
  episodeFor(entry: TranscriptDigestEntry): RemoteEpisodeRow | null {
    if (!this.manifestLoaded) return null;
    const key = keyOfEntry(entry);
    if (this.located.has(key)) return this.located.get(key) ?? null;
    const listing = this.listings.get(String(entry.show_id));
    let row: RemoteEpisodeRow | null = null;
    if (listing) {
      const bodyGuidOf = (real: string): string | null => listing.byName.get(real)?.guid ?? null;
      const real = locateInListing({
        files: listing.files,
        guid: String(entry.guid),
        bodyGuidOf,
        guidIndex: () => (listing.guidIndex ??= guidIndexOfListing(listing.files, bodyGuidOf))
      });
      row = real === null ? null : (listing.byName.get(real) ?? null);
    }
    this.located.set(key, row);
    return row;
  }

  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null {
    const row = this.episodeFor(entry);
    return row ? { mtimeMs: row.mtimeMs, size: row.size } : null;
  }

  /* ------------------------------------------------------------------ */
  /* Scopes and searches                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Register this Foray's two scopes: 'lineage' (the archive entries the
   * topic's lineage gate admits, decided here) and 'all'. Stored answers of a
   * previous Foray are dropped, since a lineage answer belongs to its topic.
   * Resolves false when either registration degraded.
   */
  async prepareScope(topic: string | null, root?: string): Promise<boolean> {
    this.answers.clear();
    this.scopeIds = { lineage: null, all: null };
    this.scopeGeneration += 1;
    /* The exact predicate of researchShape's subtopic search and
       sourceBeats' usableArchiveEntry; an undefined root is the repo's. */
    const admitted = this.archive.filter((entry) => familyGateAllows(topic, nodesForArchiveEntry(entry, root), root));
    this.lineageKeys = new Set(admitted.map(keyOfEntry));
    const [lineage, all] = await Promise.all([
      this.registerScope(admitted.map((e) => [String(e.show_id), String(e.guid)])),
      this.registerScope("all")
    ]);
    this.scopeIds = { lineage, all };
    return lineage !== null && all !== null;
  }

  private async registerScope(episodes: Array<[string, string]> | "all"): Promise<string | null> {
    const reply = await this.call("POST", "/v1/scopes", { episodes });
    if (!reply.ok) {
      this.degrade("scopes", reply.reason);
      return null;
    }
    const scopeId = (reply.json as { scopeId?: unknown } | null)?.scopeId;
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      this.degrade("scopes", "reply has no scopeId");
      return null;
    }
    return scopeId;
  }

  /** The archive rows answers are mapped onto. */
  archiveEntries(): readonly TranscriptDigestEntry[] {
    return this.archive;
  }

  /** The entries the lineage scope admits (null before `prepareScope`). */
  lineageEntries(): ReadonlySet<string> | null {
    return this.lineageKeys;
  }

  /** Which `prepareScope` the lineage scope came from (0 before the first):
   * PrecomputedTextIndex's debug check runs once per value. */
  lineageScopeGeneration(): number {
    return this.scopeGeneration;
  }

  /**
   * Ask the server every search in `requests` ahead of the stage that needs
   * them. Requests are deduplicated by key, already-stored keys are skipped,
   * and the rest go out per scope in batches of SEARCH_BATCH_QUERIES. Each
   * answer is mapped back onto this process's archive entries by show_id +
   * guid (an unknown one is dropped and counted). Resolves the number of
   * answers stored; a degraded batch stores nothing.
   */
  async prepare(requests: readonly RetrievalSearchRequest[]): Promise<number> {
    const pending = new Map<RetrievalScope, Map<string, RetrievalSearchRequest>>();
    let stored = 0;
    for (const request of requests) {
      const key = precomputedKey(request.scope, request.limit, request.text);
      if (this.answers.has(key) || pending.get(request.scope)?.has(key)) continue;
      if (Number.isInteger(request.limit) && request.limit <= 0) {
        /* The local index answers a non-positive limit with nothing, without
           reading an index; so does this, without asking. */
        this.answers.set(key, { candidates: [], idf: new Map(), hints: new Map() });
        stored += 1;
        continue;
      }
      if (
        !Number.isInteger(request.limit) ||
        request.limit > MAX_REMOTE_SEARCH_LIMIT ||
        typeof request.text !== "string" ||
        request.text.length > MAX_REMOTE_QUERY_CHARS
      ) {
        this.counters.unprepared += 1;
        continue;
      }
      let byKey = pending.get(request.scope);
      if (!byKey) {
        byKey = new Map();
        pending.set(request.scope, byKey);
      }
      byKey.set(key, request);
    }

    const batches: Array<Promise<number>> = [];
    for (const [scope, byKey] of pending) {
      const scopeId = this.scopeIds[scope];
      if (scopeId === null) {
        this.degrade("search", `scope '${scope}' is not registered`);
        continue;
      }
      const list = [...byKey.values()];
      for (let i = 0; i < list.length; i += SEARCH_BATCH_QUERIES) {
        batches.push(this.searchBatch(scopeId, list.slice(i, i + SEARCH_BATCH_QUERIES)));
      }
    }
    for (const n of await Promise.all(batches)) stored += n;
    return stored;
  }

  private async searchBatch(scopeId: string, batch: RetrievalSearchRequest[]): Promise<number> {
    const body: Record<string, unknown> = { scopeId, queries: batch.map((q) => ({ text: q.text, limit: q.limit })) };
    if (this.mode !== "bm25") body.mode = this.mode;
    const reply = await this.call("POST", "/v1/search", body);
    if (!reply.ok) {
      this.degrade("search", reply.reason);
      return 0;
    }
    const results = (reply.json as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.length !== batch.length) {
      this.degrade("search", "reply has the wrong number of results");
      return 0;
    }
    let stored = 0;
    batch.forEach((request, i) => {
      const result = results[i] as { candidates?: unknown; idf?: unknown } | null;
      if (result === null || typeof result !== "object" || !Array.isArray(result.candidates)) {
        this.degrade("search", "a result has no candidate list");
        return;
      }
      const idf = new Map<string, number>();
      if (result.idf !== null && typeof result.idf === "object") {
        for (const [term, weight] of Object.entries(result.idf as Record<string, unknown>)) {
          if (typeof weight === "number" && Number.isFinite(weight)) idf.set(term, weight);
        }
      }
      const candidates: TranscriptTextCandidate[] = [];
      const hints = new Map<TranscriptDigestEntry, CandidateHint>();
      for (const raw of result.candidates as unknown[]) {
        const c = raw as { show_id?: unknown; guid?: unknown; score?: unknown; matchedTerms?: unknown; via?: unknown; passage?: unknown } | null;
        const entry =
          c && typeof c.show_id === "string" && typeof c.guid === "string" ? this.archiveByKey.get(entryKey(c.show_id, c.guid)) : undefined;
        if (!c || !entry || typeof c.score !== "number" || typeof c.matchedTerms !== "number") {
          this.counters.unmapped += 1;
          continue;
        }
        candidates.push({ entry, score: c.score, matchedTerms: c.matchedTerms, rank: candidates.length, idf });
        if (typeof c.via === "string" || c.passage !== undefined) {
          hints.set(entry, { ...(typeof c.via === "string" ? { via: c.via } : {}), ...(c.passage !== undefined ? { passage: c.passage } : {}) });
        }
      }
      this.answers.set(precomputedKey(request.scope, request.limit, request.text), { candidates, idf, hints });
      stored += 1;
    });
    return stored;
  }

  /** The stored answer for a key, or undefined. */
  answerFor(scope: RetrievalScope, limit: number, text: string): { candidates: readonly TranscriptTextCandidate[]; idf: ReadonlyMap<string, number> } | undefined {
    return this.answers.get(precomputedKey(scope, limit, text));
  }

  /** GV-48's via / passage hints for a stored answer, by candidate entry. */
  hintsFor(scope: RetrievalScope, limit: number, text: string): ReadonlyMap<TranscriptDigestEntry, CandidateHint> {
    return this.answers.get(precomputedKey(scope, limit, text))?.hints ?? new Map();
  }

  /** Counted by PrecomputedTextIndex. */
  countSearch(hit: boolean): void {
    if (hit) this.counters.hits += 1;
    else this.counters.misses += 1;
  }

  countScopeMismatch(): void {
    this.counters.scopeMismatches += 1;
  }

  /* ------------------------------------------------------------------ */
  /* Bodies                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Fetch the bodies of `entries` (GET /v1/cues), gzip-encoded, with at most
   * HYDRATE_CONCURRENCY requests in flight ACROSS every overlapping `hydrate`
   * on this instance. Duplicates and bodies already held are skipped (and
   * re-pinned when `pin`); a body another `hydrate` is fetching right now is
   * awaited, not fetched twice (and pinned once it lands, when `pin`). A 404
   * is recorded as "no body", which is an answer; a failure is degraded and
   * leaves the entry unhydrated. Pinned bodies are kept for the run (until
   * `unpinAll`) unless the memory bound forces them out; resolves the number
   * of bodies THIS call fetched.
   */
  async hydrate(entries: readonly TranscriptDigestEntry[], options: { pin?: boolean } = {}): Promise<number> {
    const pin = options.pin !== false;
    const own: Array<Promise<boolean>> = [];
    const joined: Array<Promise<void>> = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = keyOfEntry(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      const held = this.bodies.get(key);
      if (held) {
        if (pin) held.pinned = true;
        this.touch(key, held);
        continue;
      }
      const inFlight = this.bodiesInFlight.get(key);
      if (inFlight) {
        joined.push(
          inFlight.then(() => {
            const landed = this.bodies.get(key);
            if (pin && landed) landed.pinned = true;
          })
        );
        continue;
      }
      const fetching = this.hydrateOne(entry, pin).finally(() => this.bodiesInFlight.delete(key));
      this.bodiesInFlight.set(key, fetching);
      own.push(fetching);
    }
    const [results] = await Promise.all([Promise.all(own), Promise.all(joined)]);
    return results.filter(Boolean).length;
  }

  /** A /v1/cues slot: taken now if one is free, else after every fetch queued
   * before this one (FIFO). `releaseCuesSlot` hands it straight to the next
   * waiter, so the count never dips while fetches are queued. */
  private async acquireCuesSlot(): Promise<void> {
    if (this.cuesInFlight < this.concurrency) {
      this.cuesInFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.cuesWaiters.push(resolve));
  }

  private releaseCuesSlot(): void {
    const next = this.cuesWaiters.shift();
    if (next) next();
    else this.cuesInFlight -= 1;
  }

  private async hydrateOne(entry: TranscriptDigestEntry, pin: boolean): Promise<boolean> {
    const query = `show_id=${encodeURIComponent(String(entry.show_id))}&guid=${encodeURIComponent(String(entry.guid))}`;
    await this.acquireCuesSlot();
    let reply: CallResult;
    try {
      reply = await this.call("GET", `/v1/cues?${query}`);
    } finally {
      this.releaseCuesSlot();
    }
    const key = keyOfEntry(entry);
    if (!reply.ok) {
      if (reply.status === 404) {
        this.counters.hydrationAbsent += 1;
        this.hold(key, { cues: null, source: null, bytes: 0, pinned: pin });
        return false;
      }
      this.degrade("cues", reply.reason);
      return false;
    }
    const json = reply.json as { transcript_source?: unknown; source_url?: unknown; regenerated_from?: unknown } | null;
    const cues = cuesFromBodyJson(json);
    if (!cues || !json) {
      this.counters.hydrationAbsent += 1;
      this.hold(key, { cues: null, source: null, bytes: 0, pinned: pin });
      return false;
    }
    const source = { transcript_source: json.transcript_source, source_url: json.source_url, regenerated_from: json.regenerated_from };
    this.hold(key, { cues, source, bytes: reply.bytes, pinned: pin });
    this.counters.hydrated += 1;
    return true;
  }

  private hold(key: string, body: HeldBody): void {
    const previous = this.bodies.get(key);
    if (previous) {
      this.counters.heldBytes -= previous.bytes;
      this.bodies.delete(key);
    }
    this.bodies.set(key, body);
    this.counters.heldBytes += body.bytes;
    this.enforceBound();
  }

  /**
   * The memory bound: least recently used UNPINNED bodies go first; only when
   * the pins alone exceed the bound does the least recently used pinned body
   * go too (counted, so a run that outgrows the bound says so, and a later
   * read of it is a hydrationMiss rather than an out-of-memory).
   */
  private enforceBound(): void {
    while (this.counters.heldBytes > this.maxBodyBytes && this.bodies.size > 0) {
      let victim: string | null = null;
      for (const [key, held] of this.bodies) {
        if (!held.pinned) {
          victim = key;
          break;
        }
      }
      if (victim === null) {
        victim = this.bodies.keys().next().value ?? null;
        if (victim === null) break;
        this.counters.evictedPinned += 1;
      }
      const held = this.bodies.get(victim);
      this.bodies.delete(victim);
      this.counters.heldBytes -= held?.bytes ?? 0;
      this.counters.evictions += 1;
    }
  }

  private touch(key: string, held: HeldBody): void {
    this.bodies.delete(key);
    this.bodies.set(key, held);
  }

  /** A held body (moved to the recent end), or undefined when unhydrated. */
  bodyFor(entry: TranscriptDigestEntry): { cues: TranscriptCue[] | null; source: HeldBody["source"] } | undefined {
    const key = keyOfEntry(entry);
    const held = this.bodies.get(key);
    if (!held) return undefined;
    this.touch(key, held);
    return { cues: held.cues, source: held.source };
  }

  countHydrationMiss(): void {
    this.counters.hydrationMisses += 1;
  }

  /** End of a run: every held body becomes evictable. */
  unpinAll(): void {
    for (const held of this.bodies.values()) held.pinned = false;
  }

  /* ------------------------------------------------------------------ */
  /* Accounting and transport                                             */
  /* ------------------------------------------------------------------ */

  stats(): RetrievalStats {
    let pinned = 0;
    for (const held of this.bodies.values()) if (held.pinned) pinned += 1;
    return { prepared: this.answers.size, ...this.counters, pinned, reasons: [...this.reasons] };
  }

  private degrade(operation: string, reason: string): false {
    this.counters.degraded += 1;
    if (this.reasons.length < MAX_DEGRADED_REASONS) this.reasons.push(`${operation}: ${reason}`);
    return false;
  }

  /**
   * One request, bounded by the timeout: the signal aborts it, and the call is
   * also raced against the deadline so a fetch (or body read) that ignores its
   * signal cannot hold a stage. Never throws.
   */
  private async call(method: "GET" | "POST", route: string, payload?: unknown): Promise<CallResult> {
    const fetchFn = this.fetchFn;
    if (!fetchFn) return { ok: false, reason: "no fetch implementation" };
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "gzip" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const init: RetrievalFetchInit = { method, headers, signal: controller.signal };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CallResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: `timeout after ${this.timeoutMs} ms` });
      }, this.timeoutMs);
    });
    const work = (async (): Promise<CallResult> => {
      try {
        const res = await fetchFn(`${this.baseUrl}${route}`, init);
        const text = await res.text();
        if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
        try {
          return { ok: true, json: JSON.parse(text) as unknown, bytes: Buffer.byteLength(text, "utf8") };
        } catch {
          return { ok: false, status: res.status, reason: "reply is not JSON" };
        }
      } catch (error) {
        if (controller.signal.aborted) return { ok: false, reason: `timeout after ${this.timeoutMs} ms` };
        return { ok: false, reason: `network error (${error instanceof Error ? error.name : typeof error})` };
      }
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface PrecomputedTextIndexOptions {
  /** Where a miss goes. NullTranscriptTextIndex by default. */
  fallback?: TranscriptTextIndex;
  /** Debug builds: once per lineage scope (each `prepareScope`), check that
   * the caller's isUsable admits exactly the entries it was built from. */
  verifyScopes?: boolean;
}

/**
 * `TranscriptTextIndex` over the answers `RemoteRetrieval.prepare` stored.
 * The scope follows `isUsable`: none means 'all', a predicate means 'lineage'
 * (the caller passes the predicate the scope was built from). The stored
 * list is filtered by `isUsable`, sliced to `limit` and ranked by position,
 * which is the local index's own rank rule.
 */
export class PrecomputedTextIndex implements TranscriptTextIndex {
  readonly enabled = true;
  private readonly fallback: TranscriptTextIndex;
  private readonly verifyScopes: boolean;
  /** The lineage scope generation last checked; null before any check. */
  private verifiedGeneration: number | null = null;

  constructor(
    private readonly retrieval: RemoteRetrieval,
    options: PrecomputedTextIndexOptions = {}
  ) {
    this.fallback = options.fallback ?? new NullTranscriptTextIndex();
    this.verifyScopes = options.verifyScopes === true;
  }

  search(queryText: string, options: TranscriptTextSearchOptions = {}): TranscriptTextCandidate[] {
    const limit = options.limit ?? TRANSCRIPT_TEXT_CANDIDATES;
    const isUsable = options.isUsable;
    const scope: RetrievalScope = isUsable ? "lineage" : "all";
    const answer = this.retrieval.answerFor(scope, limit, queryText);
    if (!answer) {
      this.retrieval.countSearch(false);
      return this.fallback.search(queryText, options);
    }
    this.retrieval.countSearch(true);
    if (isUsable && this.verifyScopes) {
      const generation = this.retrieval.lineageScopeGeneration();
      if (generation !== this.verifiedGeneration) {
        this.verifiedGeneration = generation;
        this.verifyLineage(isUsable);
      }
    }
    const kept = isUsable ? answer.candidates.filter((c) => isUsable(c.entry)) : answer.candidates;
    return kept.slice(0, Math.max(0, limit)).map((c, rank) => ({ ...c, rank }));
  }

  stats(): RetrievalStats {
    return this.retrieval.stats();
  }

  private verifyLineage(isUsable: (entry: TranscriptDigestEntry) => boolean): void {
    const scope = this.retrieval.lineageEntries();
    if (!scope) return;
    const admitted = this.retrieval.archiveEntries().filter((e) => isUsable(e));
    if (admitted.length !== scope.size || admitted.some((e) => !scope.has(keyOfEntry(e)))) this.retrieval.countScopeMismatch();
  }
}

/**
 * `TranscriptBodySource` over the hydrated bodies. `getCues` never reaches the
 * network: an entry `hydrate` did not fetch answers null and is counted as a
 * hydrationMiss. `bodyStat` answers from the server's manifest, so topic
 * supply and corpus coverage see the remote corpus.
 */
export class HydratingCueProvider implements TranscriptBodySource {
  constructor(private readonly retrieval: RemoteRetrieval) {}

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    const body = this.retrieval.bodyFor(entry);
    if (body === undefined) {
      this.retrieval.countHydrationMiss();
      return null;
    }
    return body.cues;
  }

  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null {
    return this.retrieval.bodyStat(entry);
  }

  /** FileTranscriptCueProvider's rule over the hydrated body; null when there
   * is no body held (unhydrated, or the server has none). */
  transcriptSource(entry: TranscriptDigestEntry): TranscriptSource | null {
    const body = this.retrieval.bodyFor(entry);
    if (!body || body.cues === null || body.source === null) return null;
    return transcriptSourceOfBody(body.source);
  }
}
