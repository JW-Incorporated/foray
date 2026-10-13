import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { main as indexBodies } from "../src/cli/indexBodies";
import {
  assertBindAllowed,
  parseRetrievalServerArgs,
  queryHash,
  RetrievalService,
  SHORTLIST_SIZE,
  startRetrievalServer,
  type DensePassageHit,
  type LineageGate,
  type PassageRecord,
  type PassageStore,
  type QueryEmbedder,
  type RetrievalLogger,
  type RetrievalServiceOptions,
  type ShortlistAnswer,
  type ShortlistBuild,
  type ShortlistRow,
  type ShortlistTaxonomy,
  type StartedRetrievalServer,
  type WireHybridResult
} from "../src/cli/retrievalServer";
import type { CueStore, EpisodeManifestRow } from "../src/generation/manifestBodySource";
import {
  deriveItemId,
  loadTranscriptArchive,
  type TranscriptCue,
  type TranscriptDigestEntry
} from "../src/generation/transcriptArchiveLookup";
import { corpusSafeKey } from "../src/generation/transcriptCorpus";
import {
  FileTranscriptTextIndex,
  showIndexCacheFile,
  TRANSCRIPT_TEXT_INDEX_VERSION,
  type TranscriptBodySource
} from "../src/generation/transcriptTextIndex";

/**
 * GV-16 (docs/roadmap/generation-v2.md, from W3-08): the retrieval server.
 *
 * A synthetic corpus of invented sentences is streamed through GV-05's
 * indexBodies into a tmp index root, with invented stats (as an R2 stream
 * would give), and the matching episode manifest rows are built in memory.
 * The server then runs on an ephemeral loopback port with an in-memory cue
 * store and a captured logger. No body file exists on disk, nothing reaches a
 * network beyond 127.0.0.1, and no model is involved.
 *
 * The last block redirects the three digest paths loadTranscriptArchive reads
 * (vi.mock of "fs", passthrough otherwise) so the pull-archive round trip runs
 * through the real loader without touching this checkout's data/ or
 * data-local/.
 */

const redirect = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const nodePath = await import("path");
  const target = (p: unknown): unknown => {
    if (typeof p !== "string" || redirect.map.size === 0) return p;
    return redirect.map.get(nodePath.resolve(p).toLowerCase()) ?? p;
  };
  const existsSync = ((p: fs.PathLike) => actual.existsSync(target(p) as fs.PathLike)) as typeof actual.existsSync;
  const readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    (actual.readFileSync as (...a: unknown[]) => unknown)(target(p), ...rest)) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SHOW_A = "gv16-alpha";
const SHOW_B = "gv16-beta";
const SHOW_C = "gv16-gamma";
const PERMALINK = "https://example.com/podcast/ep-1-the-permalink-guid/";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv16-server-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cue = (text: string, start: number, end: number): TranscriptCue => ({ text, start_sec: start, end_sec: end });

interface Episode {
  row: TranscriptDigestEntry;
  fileName: string;
  bodyGuid: string;
  cues: TranscriptCue[];
  stat: { mtimeMs: number; size: number };
}

let n = 0;
function ep(show: string, title: string, guid: string, texts: string[], extra: Partial<Episode> = {}): Episode {
  n += 1;
  return {
    row: { show_id: show, show_title: show.replace("gv16-", ""), guid, title, cues: texts.length },
    fileName: `${corpusSafeKey(guid)}.json`,
    bodyGuid: guid,
    cues: texts.map((t, i) => cue(t, i * 10, i * 10 + 8)),
    stat: { mtimeMs: 1_760_000_000_000 + n, size: 1000 + n * 7 },
    ...extra
  };
}

const LISTER = "lister carbolic acid antiseptic surgery wards";
const EPISODES: Episode[] = [
  /* Becker's: the row's guid is a permalink, the body records a slug. */
  ep(SHOW_A, "Episode one", PERMALINK, ["semmelweis washed his hands before the delivery ward", "miasma was the theory of the day"], {
    bodyGuid: "ep-1-the-permalink-guid"
  }),
  ep(SHOW_A, "Pasteur", "a2", ["pasteur and the swan neck flask experiment", "germ theory replaced miasma", "germ germ germ"]),
  /* Two episodes the text ranks identically: the title bar breaks the tie. */
  ep(SHOW_A, "An episode", "a3", [LISTER]),
  ep(SHOW_A, "Lister and antiseptic surgery", "a4", [LISTER]),
  ep(SHOW_B, "Rocks", "b1", ["plate tectonics and banded iron formations", "geology has no miasma"]),
  ep(SHOW_B, "Boxes", "b2", ["the constructor of the toothpaste box", "__proto__ spoken aloud near a germ"]),
  ep(SHOW_C, "Snow", "c1", ["cholera maps of the broad street pump", "john snow doubted miasma", "germ theory"]),
  ep(SHOW_C, "Maps", "c2", ["snow mapped the cholera deaths street by street"])
];
const ARCHIVE: TranscriptDigestEntry[] = EPISODES.map((e) => e.row);
const keyOf = (showId: string, guid: string): string => `${showId}\u0000${guid}`;

function manifestRows(episodes: Episode[] = EPISODES): EpisodeManifestRow[] {
  return episodes.map((e) => ({
    show_id: e.row.show_id,
    fileName: e.fileName,
    bodyGuid: e.bodyGuid,
    cues: e.cues.length,
    size: e.stat.size,
    mtimeMs: e.stat.mtimeMs,
    origin: { kind: "r2", key: `transcripts/normalized/${e.row.show_id}-0123456789/${e.fileName}` }
  }));
}

/** The in-memory cue store: bodies by archive key. */
function memoryStore(episodes: Episode[] = EPISODES): CueStore & { reads: string[] } {
  const byKey = new Map(episodes.map((e) => [keyOf(e.row.show_id, e.row.guid), e]));
  const reads: string[] = [];
  const read = (entry: TranscriptDigestEntry): TranscriptCue[] | null => {
    reads.push(entry.show_id);
    return byKey.get(keyOf(entry.show_id, entry.guid))?.cues ?? null;
  };
  return {
    reads,
    getCues: read,
    readCuesUncached: read,
    transcriptSource: (entry) => (byKey.has(keyOf(entry.show_id, entry.guid)) ? "asr-local" : null),
    bodyStat: (entry) => byKey.get(keyOf(entry.show_id, entry.guid))?.stat ?? null
  };
}

/** The reference: a local index built straight from the bodies, no cache. */
function referenceIndex(episodes: Episode[] = EPISODES): FileTranscriptTextIndex {
  const store = memoryStore(episodes);
  const bodies: TranscriptBodySource = { getCues: store.getCues, bodyStat: (e) => store.bodyStat?.(e) ?? null };
  return new FileTranscriptTextIndex({ archive: episodes.map((e) => e.row), bodies, cache: false });
}

const sink = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    }
  });

/** Stream the corpus through indexBodies into `indexRoot`. */
async function buildCaches(indexRoot: string, episodes: Episode[] = EPISODES): Promise<void> {
  const committed = path.join(indexRoot, "..", "committed.json");
  fs.mkdirSync(path.dirname(committed), { recursive: true });
  fs.writeFileSync(committed, JSON.stringify({ transcripts: episodes.map((e) => e.row) }), "utf8");
  const lines: string[] = [];
  for (const show of [...new Set(episodes.map((e) => e.row.show_id))]) {
    for (const e of episodes.filter((x) => x.row.show_id === show)) {
      lines.push(
        JSON.stringify({ kind: "body", show_id: show, fileName: e.fileName, stat: e.stat, body: { show_id: show, guid: e.bodyGuid, cues: e.cues } })
      );
    }
    lines.push(JSON.stringify({ kind: "end-show", show_id: show }));
  }
  const result = await indexBodies(Readable.from(lines.map((l) => `${l}\n`)), sink(), {
    indexRoot,
    stagedOut: path.join(indexRoot, "..", "staged.jsonl"),
    archive: episodes.map((e) => e.row),
    committedDigests: [committed],
    showTitle: (s) => s
  });
  expect(result.exitCode).toBe(0);
}

function capturedLogger(): RetrievalLogger & { lines: string[]; events: (level?: string) => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const push = (level: string) => (event: string, fields?: Record<string, unknown>) => lines.push(JSON.stringify({ level, event, ...(fields ?? {}) }));
  return {
    lines,
    info: push("info"),
    error: push("error"),
    events: (level) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => !level || e.level === level)
  };
}

function serviceOptions(indexRoot: string, overrides: Partial<RetrievalServiceOptions> = {}): RetrievalServiceOptions {
  return {
    loadArchive: () => ({ rows: ARCHIVE.map((r) => ({ ...r })), generatedAt: "2026-10-10T00:00:00.000Z" }),
    loadManifest: () => manifestRows(),
    createCueStore: () => memoryStore(),
    indexRoot,
    logger: capturedLogger(),
    ...overrides
  };
}

interface Reply {
  status: number;
  json: unknown;
  headers: Headers;
}

async function call(base: string, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as unknown, headers: res.headers };
}

const running: StartedRetrievalServer[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function serve(service: RetrievalService, logger: RetrievalLogger, token: string | null = null): Promise<string> {
  const started = await startRetrievalServer({ service, logger, token, host: "127.0.0.1", port: 0 });
  running.push(started);
  return `http://127.0.0.1:${started.port}`;
}

interface WireResult {
  candidates: Array<{ show_id: string; guid: string; score: number; matchedTerms: number; rank: number }>;
  idf: Record<string, number>;
}

const QUERIES = [
  "semmelweis washed hands delivery ward miasma",
  "germ theory miasma",
  "lister antiseptic surgery",
  "the constructor of the toothpaste box",
  "__proto__ germ",
  "cholera snow street",
  "zzqx nothingmatches here",
  "the and of"
];

describe("retrievalServer — /v1/search answers exactly what a local FileTranscriptTextIndex answers", () => {
  const indexRoot = path.join(tmp, "parity", "index");
  beforeAll(async () => buildCaches(indexRoot));

  it("parity: a lineage scope equals search(isUsable) and an 'all' scope equals search() with no isUsable — same order, scores, matchedTerms, idf", async () => {
    /* MUTATIONS THAT KILL THIS: in RetrievalService.search drop the scope's
       `keys.has(...)` test (the lineage answer gains SHOW_C and b1); map
       `rank: c.rank` to `rank + 1`; serialize idf from the FIRST candidate's
       map only when there is one (the zero-hit query loses {}); pass the
       client's limit through as TRANSCRIPT_TEXT_CANDIDATES. Ran the first two
       — red. */
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger }));
    const base = await serve(service, logger);
    const reference = referenceIndex();

    const lineage = [keyOf(SHOW_A, PERMALINK), keyOf(SHOW_A, "a2"), keyOf(SHOW_A, "a3"), keyOf(SHOW_A, "a4"), keyOf(SHOW_B, "b2")];
    const isUsable = (e: TranscriptDigestEntry): boolean => lineage.includes(keyOf(e.show_id, e.guid));
    const scoped = await call(base, "POST", "/v1/scopes", { episodes: lineage.map((k) => k.split("\u0000")) });
    expect(scoped.status).toBe(200);
    const { scopeId } = scoped.json as { scopeId: string };
    const all = await call(base, "POST", "/v1/scopes", { episodes: "all" });
    const allId = (all.json as { scopeId: string }).scopeId;

    const limits = [8, 2, 1, 8, 3, 8, 8, 8];
    const queries = QUERIES.map((text, i) => ({ text, limit: limits[i] }));
    const lineageReply = await call(base, "POST", "/v1/search", { scopeId, queries });
    const allReply = await call(base, "POST", "/v1/search", { scopeId: allId, queries });
    expect(lineageReply.status).toBe(200);
    const lineageResults = (lineageReply.json as { results: WireResult[] }).results;
    const allResults = (allReply.json as { results: WireResult[] }).results;
    expect(lineageResults).toHaveLength(QUERIES.length);

    const wire = (text: string, limit: number, usable?: (e: TranscriptDigestEntry) => boolean): WireResult => {
      const local = reference.searchWithIdf(text, { limit, isUsable: usable });
      expect(local.candidates).toEqual(reference.search(text, { limit, isUsable: usable }));
      return {
        candidates: local.candidates.map((c) => ({ show_id: c.entry.show_id, guid: c.entry.guid, score: c.score, matchedTerms: c.matchedTerms, rank: c.rank })),
        idf: Object.fromEntries(local.idf)
      };
    };
    queries.forEach(({ text, limit }, i) => {
      expect(lineageResults[i], text).toEqual(wire(text, limit ?? 8, isUsable));
      expect(allResults[i], text).toEqual(wire(text, limit ?? 8));
    });

    /* The cases are real: hits in the lineage scope, a different answer for
       'all', a title tie-break, prototype tokens, and a zero-hit answer that
       still carries its (empty) idf. */
    const [semmelweis, germ, lister, ctor, proto, cholera, nothing] = lineageResults as WireResult[];
    expect(semmelweis?.candidates[0]?.guid).toBe(PERMALINK);
    expect(germ?.candidates.map((c) => c.guid)).toEqual(["a2", PERMALINK]);
    expect(allResults[1]?.candidates.length).toBe(2);
    expect(lister?.candidates.map((c) => c.guid)).toEqual(["a4"]);
    expect(ctor?.candidates.map((c) => c.guid)).toEqual(["b2"]);
    expect(Object.hasOwn(ctor?.idf ?? {}, "constructor")).toBe(true);
    expect(proto?.candidates.map((c) => c.guid)).toEqual(["b2", "a2"]);
    expect(cholera?.candidates).toEqual([]);
    expect(allResults[5]?.candidates.map((c) => c.show_id)).toEqual([SHOW_C, SHOW_C]);
    expect(nothing).toEqual({ candidates: [], idf: {} });
  });

  it("searchWithIdf hands back the idf map even with zero candidates, and search() is its candidates", () => {
    /* MUTATION THAT KILLS THIS: return `{candidates: [], idf: undefined}` on
       the early exits (the zero-hit idf is lost again, as search()'s [] lost
       it). */
    const index = referenceIndex();
    for (const text of QUERIES) {
      const out = index.searchWithIdf(text);
      expect(out.idf).toBeInstanceOf(Map);
      expect(index.search(text)).toEqual(out.candidates);
      for (const c of out.candidates) expect(c.idf).toBe(out.idf);
    }
    expect(index.searchWithIdf("zzqx").idf.size).toBe(0);
    expect(index.searchWithIdf("germ", { isUsable: () => false })).toEqual({ candidates: [], idf: new Map() });
    expect(index.searchWithIdf("germ", { limit: 0 }).candidates).toEqual([]);
  });

  it("serves episodes, cues, the archive and health; gzip when accepted; 404 for unknown episodes and expired scopes", async () => {
    /* MUTATIONS THAT KILL THIS: answer /v1/episodes from the cue store's
       stat instead of the manifest's (sizes differ in this test); drop the
       scope TTL sweep (the expired scope still answers); send identity
       encoding to a gzip client. */
    let clock = 1_000_000;
    const logger = capturedLogger();
    const statsDiffer = (): CueStore => ({ ...memoryStore(), bodyStat: (e) => ({ mtimeMs: 1, size: e.cues + 999_999 }) });
    const service = new RetrievalService(serviceOptions(indexRoot, { logger, now: () => clock, createCueStore: statsDiffer }));
    const base = await serve(service, logger);

    const health = await call(base, "GET", "/healthz");
    expect(health.json).toEqual({ indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION, shows: 3, episodes: 8, archiveGeneratedAt: "2026-10-10T00:00:00.000Z" });

    const episodes = (await call(base, "GET", "/v1/episodes")).json as Array<Record<string, unknown>>;
    expect(episodes).toHaveLength(8);
    expect(episodes[0]).toEqual({ show_id: SHOW_A, guid: PERMALINK, size: EPISODES[0]?.stat.size, mtimeMs: EPISODES[0]?.stat.mtimeMs, transcript_source: null });

    const cues = await call(base, "GET", `/v1/cues?show_id=${SHOW_A}&guid=${encodeURIComponent(PERMALINK)}`);
    expect(cues.status).toBe(200);
    expect(cues.json).toEqual({ cues: EPISODES[0]?.cues, transcript_source: "asr-local" });
    expect((await call(base, "GET", `/v1/cues?show_id=${SHOW_A}&guid=nope`)).status).toBe(404);
    expect((await call(base, "GET", `/v1/cues?show_id=${SHOW_A}`)).status).toBe(400);

    const archive = (await call(base, "GET", "/v1/archive")).json as { generated_at: string; transcripts: TranscriptDigestEntry[] };
    expect(archive).toEqual({ generated_at: "2026-10-10T00:00:00.000Z", transcripts: ARCHIVE });

    /* gzip on the wire when the client asks for it. */
    const raw = await new Promise<{ encoding: string | undefined; status: number }>((resolve, reject) => {
      http
        .get(`${base}/v1/archive`, { headers: { "accept-encoding": "gzip" } }, (res) => {
          res.resume();
          resolve({ encoding: res.headers["content-encoding"], status: res.statusCode ?? 0 });
        })
        .on("error", reject);
    });
    expect(raw).toEqual({ encoding: "gzip", status: 200 });

    const scope = (await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string };
    clock += 60 * 60 * 1000;
    expect((await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: "germ" }] })).status).toBe(200);
    clock += 2 * 60 * 60 * 1000 - 1;
    expect((await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: "germ" }] })).status).toBe(200);
    clock += 2 * 60 * 60 * 1000;
    expect((await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: "germ" }] })).status).toBe(404);
    expect(service.scopeCount()).toBe(0);

    expect((await call(base, "POST", "/v1/search", { scopeId: "nope", queries: [{ text: "germ" }] })).status).toBe(404);
    const fresh = (await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string };
    expect((await call(base, "POST", "/v1/search", { scopeId: fresh.scopeId, queries: [] })).status).toBe(400);
    expect((await call(base, "POST", "/v1/search", { scopeId: fresh.scopeId, queries: [{ text: "germ", limit: 0 }] })).status).toBe(400);
    expect((await call(base, "POST", "/v1/scopes", { episodes: [["only-one"]] })).status).toBe(400);
    expect((await call(base, "GET", "/v1/search")).status).toBe(405);
    expect((await call(base, "GET", "/v2/anything")).status).toBe(404);
  });

  it("never logs query text: a search's log line carries counts, latency and 12-hex query hashes only", async () => {
    /* MUTATION THAT KILLS THIS: log `queries` (the request's array) instead of
       its length, or log the query text beside its hash. Ran the first — red. */
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger }));
    const base = await serve(service, logger);
    const secret = "semmelweis quietly washed delivery ward hands";
    const scope = (await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string };
    const reply = await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: secret }, { text: "zzqx" }] });
    expect(reply.status).toBe(200);
    const all = logger.lines.join("\n");
    expect(all).not.toContain(secret);
    for (const word of ["semmelweis", "quietly", "washed", "zzqx"]) expect(all).not.toContain(word);
    const search = logger.events().find((e) => e.event === "request" && e.route === "/v1/search");
    expect(search).toMatchObject({ method: "POST", status: 200, queries: 2, queryHashes: [queryHash(secret), queryHash("zzqx")] });
    expect(search?.candidates).toEqual([1, 0]);
    expect(typeof search?.ms).toBe("number");
    expect(queryHash(secret)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("retrievalServer — auth and bind", () => {
  const indexRoot = path.join(tmp, "auth", "index");
  beforeAll(async () => buildCaches(indexRoot));

  it("refuses a non-loopback bind without a token, before listening", async () => {
    /* MUTATION THAT KILLS THIS: drop assertBindAllowed from
       startRetrievalServer — the server listens on 0.0.0.0 with no auth. Ran
       it — red. */
    expect(() => assertBindAllowed("0.0.0.0", null)).toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(() => assertBindAllowed("192.168.0.10", "")).toThrow(/FORAY_RETRIEVAL_TOKEN/);
    expect(() => assertBindAllowed("127.0.0.1", null)).not.toThrow();
    expect(() => assertBindAllowed("::1", undefined)).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", "t0ken")).not.toThrow();
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger }));
    const listen = vi.spyOn(http.Server.prototype, "listen");
    try {
      await expect(startRetrievalServer({ service, logger, token: null, host: "0.0.0.0", port: 0 })).rejects.toThrow(/refusing to bind/);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
    expect(parseRetrievalServerArgs([]).host).toBe("127.0.0.1");
  });

  it("with a token, every /v1 route needs the bearer and /healthz does not", async () => {
    /* MUTATION THAT KILLS THIS: compare the token only when the header is
       present (a request with no Authorization header gets through). */
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger }));
    const base = await serve(service, logger, "s3cret-token");
    expect((await call(base, "GET", "/healthz")).status).toBe(200);
    for (const [method, route] of [
      ["GET", "/v1/archive"],
      ["GET", "/v1/episodes"],
      ["POST", "/v1/scopes"],
      ["POST", "/v1/reload"]
    ] as const) {
      const none = await call(base, method, route, method === "POST" ? { episodes: "all" } : undefined);
      expect(none.status, route).toBe(401);
      expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
      expect((await call(base, method, route, method === "POST" ? { episodes: "all" } : undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    }
    expect((await call(base, "GET", "/v1/archive", undefined, { authorization: "Bearer s3cret-token" })).status).toBe(200);
    expect(logger.lines.join("\n")).not.toContain("s3cret-token");
  });
});

describe("retrievalServer — residency, stale caches and reload", () => {
  it("a stale cache is logged as an error and rebuilt only when the cue store can serve its bodies; otherwise the show is left out and never searched", async () => {
    /* MUTATIONS THAT KILL THIS: rebuild regardless of the store (the gamma
       show comes back from no bodies and the store is read); drop the
       resident-show test from the search predicate (a query then builds the
       gamma index inside the request, reading the store); log the stale show
       as info. Ran the first two — red. */
    const indexRoot = path.join(tmp, "stale", "index");
    await buildCaches(indexRoot);
    const bumped = (rows: EpisodeManifestRow[]): EpisodeManifestRow[] =>
      rows.map((r) => (r.show_id === SHOW_B || r.show_id === SHOW_C ? { ...r, size: r.size + 1 } : r));

    /* The store serves beta but has no gamma body. */
    const store = memoryStore(EPISODES.filter((e) => e.row.show_id !== SHOW_C));
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger, loadManifest: () => bumped(manifestRows()), createCueStore: () => store }));
    expect(service.residentShows().sort()).toEqual([SHOW_A, SHOW_B]);
    expect(store.reads.filter((s) => s === SHOW_A)).toEqual([]);
    expect(store.reads.filter((s) => s === SHOW_C)).toEqual([]);
    const errors = logger.events("error");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cache-stale", show: SHOW_B, reason: "stale" }),
        expect.objectContaining({ event: "cache-stale", show: SHOW_C, reason: "stale" }),
        expect.objectContaining({ event: "cache-not-rebuilt", show: SHOW_C, missingBodies: 2 })
      ])
    );
    expect(logger.events().find((e) => e.event === "cache-rebuilt")).toMatchObject({ show: SHOW_B, episodes: 2 });
    /* Beta's rebuilt cache records the manifest's stat, so the next boot holds it from disk. */
    const rebuilt = JSON.parse(fs.readFileSync(showIndexCacheFile(indexRoot, SHOW_B), "utf8")) as { docs: Array<{ size: number }> };
    expect(rebuilt.docs.map((d) => d.size)).toEqual(bumped(manifestRows()).filter((r) => r.show_id === SHOW_B).map((r) => r.size));

    const readsBefore = store.reads.length;
    const results = service.search(service.createScope("all").scopeId, [{ text: "cholera snow street miasma" }]);
    expect(results[0]?.candidates.every((c) => c.show_id !== SHOW_C)).toBe(true);
    expect(results[0]?.candidates.length).toBeGreaterThan(0);
    expect(store.reads.length).toBe(readsBefore);
    expect(service.health()).toMatchObject({ shows: 2, episodes: 6 });
  });

  it("fails closed on a cue store with no bodyStat: a stale show is not rebuilt, the store is never read, and its cache file is unchanged", async () => {
    /* MUTATION THAT KILLS THIS: count a store with no bodyStat as able to
       serve every body (`missing = 0`, the old behaviour) — beta and gamma are
       rebuilt from a store that answers no cues, read, and their cache files
       overwritten. */
    const indexRoot = path.join(tmp, "stale-nostat", "index");
    await buildCaches(indexRoot);
    const bumped = manifestRows().map((r) => (r.show_id === SHOW_B || r.show_id === SHOW_C ? { ...r, size: r.size + 1 } : r));
    const full = memoryStore();
    const store: CueStore & { reads: string[] } = {
      reads: full.reads,
      getCues: full.getCues,
      readCuesUncached: full.readCuesUncached,
      transcriptSource: full.transcriptSource
    };
    expect("bodyStat" in store).toBe(false);
    const before = new Map([SHOW_B, SHOW_C].map((s) => [s, fs.readFileSync(showIndexCacheFile(indexRoot, s), "utf8")]));
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger, loadManifest: () => bumped, createCueStore: () => store }));
    expect(service.residentShows()).toEqual([SHOW_A]);
    expect(store.reads).toEqual([]);
    for (const [s, text] of before) expect(fs.readFileSync(showIndexCacheFile(indexRoot, s), "utf8")).toBe(text);
    expect(logger.events("error")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cache-not-rebuilt", show: SHOW_B, missingBodies: 2, reason: "store-cannot-stat" }),
        expect.objectContaining({ event: "cache-not-rebuilt", show: SHOW_C, reason: "store-cannot-stat" })
      ])
    );
    expect(logger.events().some((e) => e.event === "cache-rebuilt")).toBe(false);
  });

  it("--shows limits the resident set; POST /v1/reload re-reads the archive and caches", async () => {
    /* MUTATION THAT KILLS THIS: in reload(), keep the old snapshot's archive
       (the new episode never appears). */
    const indexRoot = path.join(tmp, "reload", "index");
    await buildCaches(indexRoot);
    const logger = capturedLogger();
    let archive = ARCHIVE.map((r) => ({ ...r }));
    let episodes = EPISODES;
    const service = new RetrievalService(
      serviceOptions(indexRoot, {
        logger,
        shows: [SHOW_A, "gv16-unknown"],
        loadArchive: () => ({ rows: archive.map((r) => ({ ...r })), generatedAt: null }),
        loadManifest: () => manifestRows(episodes),
        createCueStore: () => memoryStore(episodes)
      })
    );
    expect(service.residentShows()).toEqual([SHOW_A]);
    expect(logger.events("error")).toEqual([expect.objectContaining({ event: "show-unknown", show: "gv16-unknown" })]);
    const base = await serve(service, logger);
    const scope = (await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string };
    const before = (await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: "germ" }] })).json as { results: WireResult[] };
    expect(before.results[0]?.candidates.every((c) => c.show_id === SHOW_A)).toBe(true);

    const extra = ep(SHOW_A, "Koch", "a5", ["koch postulates for germ theory"]);
    episodes = [...EPISODES, extra];
    archive = episodes.map((e) => e.row);
    await buildCaches(indexRoot, episodes);
    const reloaded = await call(base, "POST", "/v1/reload", {});
    expect(reloaded.json).toMatchObject({ shows: 1, episodes: 5 });
    const after = (await call(base, "POST", "/v1/search", { scopeId: scope.scopeId, queries: [{ text: "koch postulates" }] })).json as { results: WireResult[] };
    expect(after.results[0]?.candidates.map((c) => c.guid)).toEqual(["a5"]);
  });

  it("without a manifest, the cue store is the body source (a box with the bodies on disk)", () => {
    /* MUTATION THAT KILLS THIS: treat a null manifest as an empty one (every
       body stat is null, nothing is resident). */
    const indexRoot = path.join(tmp, "no-manifest", "index");
    const logger = capturedLogger();
    const service = new RetrievalService(serviceOptions(indexRoot, { logger, loadManifest: () => null }));
    expect(service.residentShows().sort()).toEqual([SHOW_A, SHOW_B, SHOW_C]);
    expect(logger.events().some((e) => e.event === "manifest-absent")).toBe(true);
    const noStat: CueStore = { getCues: () => null };
    expect(() => new RetrievalService(serviceOptions(indexRoot, { logger, loadManifest: () => null, createCueStore: () => noStat }))).toThrow(
      /cannot stat bodies/
    );
  });
});

/* ---------------------------------------------------------------------------
   GV-48 (from W3-09): the dense arm, the hybrid merge and the node shortlist,
   over an in-memory fake PassageStore and a stub QueryEmbedder. No test here
   (or anywhere under backend/test) loads node:sqlite or the real store.
   --------------------------------------------------------------------------- */

/** The stub embedder's vector: words hashed into 16 buckets (FNV-1a). */
function stubVector(text: string): number[] {
  const v = new Array<number>(16).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0x811c9dc5;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193) >>> 0;
    v[h % 16] = (v[h % 16] ?? 0) + 1;
  }
  return v;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A query embedder: an explicit vector per text, else the stub. */
function stubEmbedder(table: Record<string, number[]> = {}): QueryEmbedder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    embedQuery: async (text) => {
      calls.push(text);
      return table[text] ?? stubVector(text);
    }
  };
}

interface FakePassage extends PassageRecord {
  vector: number[];
}

/** A fake passage without its vector: what the store hands back. */
const recordOf = (p: FakePassage): PassageRecord => {
  const record: PassageRecord & { vector?: number[] } = { ...p };
  delete record.vector;
  return record;
};

type FakeStore = PassageStore & { shortlists: Map<string, ShortlistRow[]>; reloads: number; byEpisodeCalls: Array<Array<readonly [string, string]>> };

/** The in-memory PassageStore. `ignoreFilter` makes denseSearch and
 * passagesForEpisodes return passages of EVERY episode, so the server's own
 * scope enforcement is what the test sees. */
function fakeStore(passages: FakePassage[], { ignoreFilter = false } = {}): FakeStore {
  const shortlists = new Map<string, ShortlistRow[]>();
  const byEpisodeCalls: Array<Array<readonly [string, string]>> = [];
  const store: FakeStore = {
    shortlists,
    reloads: 0,
    byEpisodeCalls,
    denseSearch(vector, { episodes, k }): DensePassageHit[] {
      const allow = episodes && !ignoreFilter ? new Set(episodes.map(([s, g]) => keyOf(s, g))) : null;
      return passages
        .filter((p) => !allow || allow.has(keyOf(p.show_id, p.guid)))
        .map((p) => ({ passageId: p.passageId, show_id: p.show_id, guid: p.guid, sim: cosine(vector, p.vector) }))
        .sort((a, b) => b.sim - a.sim || (a.passageId < b.passageId ? -1 : 1))
        .slice(0, k);
    },
    passagesById: (ids) => ids.flatMap((id) => passages.filter((p) => p.passageId === id)).map(recordOf),
    passagesForEpisodes(episodes) {
      byEpisodeCalls.push([...episodes]);
      const allow = new Set(episodes.map(([s, g]) => keyOf(s, g)));
      return passages.filter((p) => ignoreFilter || allow.has(keyOf(p.show_id, p.guid))).map(recordOf);
    },
    replaceShortlist(nodeId, rows, builtAt) {
      shortlists.set(
        nodeId,
        rows.map((r) => ({ rank: r.rank, passageId: r.passageId, score: r.score, builtAt }))
      );
    },
    readShortlist: (nodeId) => shortlists.get(nodeId) ?? [],
    reload() {
      store.reloads += 1;
    }
  };
  return store;
}

/** One passage per cue of every fixture episode, vectors from the stub. */
function cuePassages(overrides: Record<string, number[]> = {}): FakePassage[] {
  return EPISODES.flatMap((e) =>
    e.cues.map((c, i) => {
      const passageId = `${e.row.show_id}:${e.row.guid}:${i}`;
      return {
        passageId,
        show_id: e.row.show_id,
        guid: e.row.guid,
        startSec: c.start_sec,
        endSec: c.end_sec,
        startBoundary: "sentence",
        endBoundary: i % 2 ? "turn" : "cue",
        startAnchor: c.text.split(" ").slice(0, 3).join(" "),
        endAnchor: null,
        text: c.text,
        vector: overrides[passageId] ?? stubVector(c.text)
      };
    })
  );
}

const pid = (e: Episode, i = 0): string => `${e.row.show_id}:${e.row.guid}:${i}`;
const byGuid = (guid: string): Episode => EPISODES.find((e) => e.row.guid === guid) as Episode;

const TAXONOMY: ShortlistTaxonomy = {
  nodes: [
    { id: "medicine", parent: null, label: "Germ theory and miasma" },
    { id: "medicine/surgery", parent: "medicine", label: "Antiseptic surgery" },
    { id: "science", parent: null, label: "Geology and rocks" },
    { id: "arts", parent: null, label: "Painting" }
  ],
  concepts: { cholera: { terms: ["cholera", "pump"], topics: ["medicine"], related: [] } }
};
/* Alpha is filed under medicine/surgery, gamma under medicine, beta under
   science. The gate admits a node's lineage: itself, ancestors, descendants. */
const NODES_BY_SHOW: Record<string, string[]> = { [SHOW_A]: ["medicine/surgery"], [SHOW_B]: ["science"], [SHOW_C]: ["medicine"] };
const LINEAGE: LineageGate = {
  nodesFor: (entry) => NODES_BY_SHOW[entry.show_id] ?? [],
  allows: (node, nodes) => nodes.some((n) => n === node || n.startsWith(`${node}/`) || node.startsWith(`${n}/`))
};

describe("retrievalServer — hybrid mode (GV-48)", () => {
  const indexRoot = path.join(tmp, "hybrid", "index");
  beforeAll(async () => buildCaches(indexRoot));

  /* "germ theory miasma": BM25 finds a2 and the permalink episode in the
     lineage scope. The dense arm is told (by explicit vectors) that a3, b2,
     c2 and b1 are close, in that order of closeness: c2 and b1 are out of the
     lineage scope. */
  const QUERY = "germ theory miasma";
  const Q = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const near = (x: number): number[] => [x, Math.sqrt(1 - x * x), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const far = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const vectors = (): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    for (const e of EPISODES) e.cues.forEach((_c, i) => (out[pid(e, i)] = far));
    out[pid(byGuid("c2"))] = near(0.95);
    out[pid(byGuid("b1"))] = near(0.9);
    out[pid(byGuid("a3"))] = near(0.8);
    out[pid(byGuid("b2"), 1)] = near(0.7);
    out[pid(byGuid("a2"), 2)] = near(0.6);
    return out;
  };
  const LINEAGE_SCOPE = [[SHOW_A, PERMALINK], [SHOW_A, "a2"], [SHOW_A, "a3"], [SHOW_A, "a4"], [SHOW_B, "b2"]];

  it("'append': the BM25 answer unchanged, then the in-scope dense-only episodes; out-of-scope hits never returned even from a store that ignores the filter", async () => {
    /* MUTATIONS THAT KILL THIS: drop the server's `inScope` filter (c2 and b1
       come back from the filter-ignoring store); send the dense arm the
       query's BM25 candidates instead of its scope (a3 is lost); serialize the
       merged candidates without `via`. Ran the first — red. */
    const logger = capturedLogger();
    const store = fakeStore(cuePassages(vectors()), { ignoreFilter: true });
    const embedder = stubEmbedder({ [QUERY]: Q });
    const service = new RetrievalService(serviceOptions(indexRoot, { logger, passageStore: store, queryEmbedder: embedder }));
    const base = await serve(service, logger);
    const { scopeId } = (await call(base, "POST", "/v1/scopes", { episodes: LINEAGE_SCOPE })).json as { scopeId: string };

    const bm25 = (await call(base, "POST", "/v1/search", { scopeId, queries: [{ text: QUERY, limit: 2 }] })).json as { results: WireResult[] };
    const reply = await call(base, "POST", "/v1/search", { scopeId, mode: "hybrid", queries: [{ text: QUERY, limit: 2 }] });
    expect(reply.status).toBe(200);
    const [hybrid] = (reply.json as { results: WireHybridResult[] }).results;
    const lexical = bm25.results[0] as WireResult;
    expect(lexical.candidates.map((c) => c.guid)).toEqual(["a2", PERMALINK]);

    /* a4 is in scope with every passage at similarity 0: still a dense hit,
       third of the at most four dense-only episodes. */
    expect(hybrid?.candidates.map((c) => c.guid)).toEqual(["a2", PERMALINK, "a3", "b2", "a4"]);
    expect(hybrid?.candidates.slice(0, 2).map(({ show_id, guid, score, matchedTerms, rank }) => ({ show_id, guid, score, matchedTerms, rank }))).toEqual(
      lexical.candidates
    );
    expect(hybrid?.candidates.map((c) => c.via)).toEqual(["both", "both", "dense", "dense", "dense"]);
    expect(hybrid?.candidates.map((c) => c.rank)).toEqual([0, 1, 2, 3, 4]);
    expect(hybrid?.idf).toEqual(lexical.idf);
    const a3 = byGuid("a3");
    expect(hybrid?.candidates[2]?.passage).toEqual({
      passageId: pid(a3),
      startSec: a3.cues[0]?.start_sec,
      endSec: a3.cues[0]?.end_sec,
      startBoundary: "sentence",
      endBoundary: "cue"
    });
    expect(hybrid?.candidates[2]?.denseSim).toBeCloseTo(0.8, 10);
    expect(hybrid?.candidates[3]?.passage?.passageId).toBe(pid(byGuid("b2"), 1));
    expect(hybrid?.candidates[0]?.passage?.passageId).toBe(pid(byGuid("a2"), 2));
    for (const c of hybrid?.candidates ?? []) expect(["c2", "b1"]).not.toContain(c.guid);
    expect(embedder.calls).toEqual([QUERY]);

    /* An 'all' scope admits c2 and b1; b1 is a BM25 hit (miasma) too. */
    const all = (await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string };
    const wide = (await call(base, "POST", "/v1/search", { scopeId: all.scopeId, mode: "hybrid", queries: [{ text: QUERY, limit: 8 }] })).json as {
      results: WireHybridResult[];
    };
    const viaOf = Object.fromEntries((wide.results[0]?.candidates ?? []).map((c) => [c.guid, c.via]));
    expect(viaOf.c2).toBe("dense");
    expect(viaOf.b1).toBe("both");

    /* Never the query text in a log line. */
    expect(logger.lines.join("\n")).not.toContain("miasma");
    expect(logger.events().find((e) => e.event === "request" && e.mode === "hybrid")).toMatchObject({ queryHashes: [queryHash(QUERY)], dense: [3] });
  });

  it("is deterministic with the stub embedder; no mode is byte-identical to a server with no store; bad modes and a missing store are refused", async () => {
    /* MUTATION THAT KILLS THIS: route a request with no mode through
       searchHybrid (its answer gains `via`, so it differs from the plain
       server's). Ran it — red. */
    const logger = capturedLogger();
    const withStore = new RetrievalService(serviceOptions(indexRoot, { logger, passageStore: fakeStore(cuePassages()), queryEmbedder: stubEmbedder() }));
    const plain = new RetrievalService(serviceOptions(indexRoot, { logger }));
    const base = await serve(withStore, logger);
    const plainBase = await serve(plain, logger);
    const scopeA = ((await call(base, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string }).scopeId;
    const scopeB = ((await call(plainBase, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string }).scopeId;
    const queries = QUERIES.map((text) => ({ text, limit: 3 }));

    const one = await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "hybrid", queries });
    const two = await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "hybrid", queries });
    expect(one.status).toBe(200);
    expect(two.json).toEqual(one.json);
    expect(((one.json as { results: WireHybridResult[] }).results ?? []).some((r) => r.candidates.some((c) => c.via === "dense"))).toBe(true);

    const noMode = await call(base, "POST", "/v1/search", { scopeId: scopeA, queries });
    const bm25Mode = await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "bm25", queries });
    const reference = await call(plainBase, "POST", "/v1/search", { scopeId: scopeB, queries });
    expect(JSON.stringify(noMode.json)).toBe(JSON.stringify(reference.json));
    expect(JSON.stringify(bm25Mode.json)).toBe(JSON.stringify(reference.json));

    expect((await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "dense", queries })).status).toBe(400);
    expect((await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "hybrid", policy: "max", queries })).status).toBe(400);
    const rrf = await call(base, "POST", "/v1/search", { scopeId: scopeA, mode: "hybrid", policy: "rrf", queries });
    expect(rrf.status).toBe(200);
    expect((await call(plainBase, "POST", "/v1/search", { scopeId: scopeB, mode: "hybrid", queries })).status).toBe(503);
    const failing: QueryEmbedder = { embedQuery: async () => Promise.reject(new Error("no vectors for semmelweis")) };
    const broken = new RetrievalService(serviceOptions(indexRoot, { logger, passageStore: fakeStore(cuePassages()), queryEmbedder: failing }));
    const brokenBase = await serve(broken, logger);
    const scopeC = ((await call(brokenBase, "POST", "/v1/scopes", { episodes: "all" })).json as { scopeId: string }).scopeId;
    const refused = await call(brokenBase, "POST", "/v1/search", { scopeId: scopeC, mode: "hybrid", queries });
    expect(refused.status).toBe(503);
    expect(JSON.stringify(refused.json)).not.toContain("semmelweis");
  });
});

describe("retrievalServer — the per-taxonomy-node shortlist (GV-48)", () => {
  const indexRoot = path.join(tmp, "shortlist", "index");
  beforeAll(async () => buildCaches(indexRoot));

  /* a2 gets 60 extra passages, so the medicine pool holds more than 50. */
  const extra = (): FakePassage[] =>
    Array.from({ length: 60 }, (_x, i) => {
      const text = i % 3 === 0 ? `germ theory lecture part ${i}` : `antiseptic surgery notes ${i} on wards`;
      return {
        passageId: `extra:${String(i).padStart(2, "0")}`,
        show_id: SHOW_A,
        guid: "a2",
        startSec: 100 + i * 120,
        endSec: 220 + i * 120,
        startBoundary: "turn",
        endBoundary: "turn",
        startAnchor: null,
        endAnchor: null,
        text,
        vector: stubVector(text)
      };
    });

  it("a node's shortlist holds only lineage-admitted episodes and at most 50 rows; a node with no admitted episode is stored empty", async () => {
    /* MUTATIONS THAT KILL THIS: drop the `inAdmitted` filter on the pool's
       passages (the filter-ignoring store leaks beta's geology passages into
       medicine); drop `.slice(0, SHORTLIST_SIZE)` (medicine stores 70+ rows).
       Ran both — red. */
    const logger = capturedLogger();
    const store = fakeStore([...cuePassages(), ...extra()], { ignoreFilter: true });
    const service = new RetrievalService(
      serviceOptions(indexRoot, { logger, passageStore: store, queryEmbedder: stubEmbedder(), loadTaxonomy: () => TAXONOMY, lineage: LINEAGE })
    );
    const base = await serve(service, logger);
    const reply = await call(base, "POST", "/v1/shortlist/rebuild", {});
    expect(reply.status).toBe(200);
    const build = reply.json as ShortlistBuild;
    expect(build).toMatchObject({ nodes: 4, empty: ["arts"] });

    const showOf = (passageId: string): string => passageId.split(":")[0] as string;
    const medicine = store.shortlists.get("medicine") ?? [];
    expect(SHORTLIST_SIZE).toBe(50);
    expect(medicine).toHaveLength(50);
    expect(medicine.map((r) => r.rank)).toEqual(Array.from({ length: 50 }, (_x, i) => i));
    const medicineShows = new Set(medicine.map((r) => (r.passageId.startsWith("extra:") ? SHOW_A : showOf(r.passageId))));
    expect([...medicineShows].sort()).toEqual([SHOW_A, SHOW_C]);
    expect(new Set(medicine.map((r) => r.builtAt))).toEqual(new Set([build.builtAt]));

    /* surgery's lineage is itself and medicine: alpha (surgery) and gamma
       (medicine, an ancestor). science admits beta only. */
    const science = store.shortlists.get("science") ?? [];
    expect(science.length).toBeGreaterThan(0);
    expect(science.every((r) => showOf(r.passageId) === SHOW_B)).toBe(true);
    expect(store.shortlists.get("arts")).toEqual([]);
    expect(build.rows).toBe([...store.shortlists.values()].reduce((n, rows) => n + rows.length, 0));
    for (const asked of store.byEpisodeCalls) for (const [show] of asked) expect([SHOW_A, SHOW_C, SHOW_B]).toContain(show);
    expect(store.byEpisodeCalls.some((asked) => asked.some(([show]) => show === SHOW_B) && asked.some(([show]) => show !== SHOW_B))).toBe(false);

    /* Only the named nodes are rebuilt; an unknown node is refused. */
    store.shortlists.set("science", []);
    expect(((await call(base, "POST", "/v1/shortlist/rebuild", { nodes: ["arts"] })).json as ShortlistBuild).nodes).toBe(1);
    expect(store.shortlists.get("science")).toEqual([]);
    expect((await call(base, "POST", "/v1/shortlist/rebuild", { nodes: ["nope"] })).status).toBe(400);
  });

  it("an embedder whose model has no vectors yet: the rebuild is 200 and lexical only, still lineage-admitted and capped at 50", async () => {
    /* MUTATION THAT KILLS THIS: let the query-embedding failure propagate from
       shortlistFor (the rebuild answers 503). Ran it — red. */
    const logger = capturedLogger();
    const noVectors: QueryEmbedder = {
      embedQuery: async () => Promise.reject(new Error("model stub@1 has no vectors in this store yet (run index-db embed)"))
    };
    const store = fakeStore([...cuePassages(), ...extra()], { ignoreFilter: true });
    const service = new RetrievalService(
      serviceOptions(indexRoot, { logger, passageStore: store, queryEmbedder: noVectors, loadTaxonomy: () => TAXONOMY, lineage: LINEAGE })
    );
    const reply = await call(await serve(service, logger), "POST", "/v1/shortlist/rebuild", {});
    expect(reply.status).toBe(200);
    expect(reply.json as ShortlistBuild).toMatchObject({ nodes: 4, empty: ["arts"] });

    const showOf = (passageId: string): string => (passageId.startsWith("extra:") ? SHOW_A : (passageId.split(":")[0] as string));
    const medicine = store.shortlists.get("medicine") ?? [];
    expect(medicine).toHaveLength(SHORTLIST_SIZE);
    expect([...new Set(medicine.map((r) => showOf(r.passageId)))].sort()).toEqual([SHOW_A, SHOW_C]);
    const science = store.shortlists.get("science") ?? [];
    expect(science.length).toBeGreaterThan(0);
    expect(science.every((r) => showOf(r.passageId) === SHOW_B)).toBe(true);
    expect(store.shortlists.get("arts")).toEqual([]);

    /* Exactly the rows a server with no embedder stores. */
    const lexStore = fakeStore([...cuePassages(), ...extra()], { ignoreFilter: true });
    const lexical = new RetrievalService(serviceOptions(indexRoot, { logger: capturedLogger(), passageStore: lexStore, loadTaxonomy: () => TAXONOMY, lineage: LINEAGE }));
    expect((await call(await serve(lexical, logger), "POST", "/v1/shortlist/rebuild", {})).status).toBe(200);
    const strip = (m: Map<string, ShortlistRow[]>): Record<string, unknown> =>
      Object.fromEntries([...m].map(([node, rows]) => [node, rows.map(({ rank, passageId, score }) => ({ rank, passageId, score }))]));
    expect(strip(store.shortlists)).toEqual(strip(lexStore.shortlists));

    /* Logged by class, never the query or the error's message. */
    expect(logger.events("error").some((e) => e.event === "shortlist-embed-failed" && e.error === "Error")).toBe(true);
    expect(logger.lines.join("\n")).not.toMatch(/miasma|no vectors/);
  });

  it("GET reranks the stored rows against the query by cosine with an embedder, by BM25 without one, and returns text, seconds, boundaries and anchors", async () => {
    /* MUTATION THAT KILLS THIS: ignore `query` and return the stored order
       (the cholera passage is not first). Ran it — red. */
    const logger = capturedLogger();
    const store = fakeStore(cuePassages());
    const service = new RetrievalService(
      serviceOptions(indexRoot, { logger, passageStore: store, queryEmbedder: stubEmbedder(), loadTaxonomy: () => TAXONOMY, lineage: LINEAGE })
    );
    const base = await serve(service, logger);
    await call(base, "POST", "/v1/shortlist/rebuild", { nodes: ["medicine"] });
    const stored = store.shortlists.get("medicine") ?? [];
    const cholera = pid(byGuid("c1"));
    expect(stored.map((r) => r.passageId)).toContain(cholera);
    expect(stored[0]?.passageId).not.toBe(cholera);

    const secret = "cholera maps of the broad street pump";
    const answer = (await call(base, "GET", `/v1/shortlist?node=medicine&query=${encodeURIComponent(secret)}&limit=5`)).json as ShortlistAnswer;
    expect(answer.reranked).toBe("cosine");
    expect(answer.passages).toHaveLength(5);
    expect(answer.passages[0]).toMatchObject({
      passageId: cholera,
      show_id: SHOW_C,
      guid: "c1",
      startSec: 0,
      endSec: 8,
      startBoundary: "sentence",
      endBoundary: "cue",
      startAnchor: "cholera maps of",
      endAnchor: null,
      text: secret,
      rank: 0
    });
    expect(answer.passages[0]?.storedRank).toBe(stored.findIndex((r) => r.passageId === cholera));
    expect(answer.passages[0]?.rerankScore).toBeCloseTo(1, 10);
    expect(logger.lines.join("\n")).not.toContain("broad street");

    const plainOrder = (await call(base, "GET", "/v1/shortlist?node=medicine")).json as ShortlistAnswer;
    expect(plainOrder.reranked).toBeNull();
    expect(plainOrder.passages.map((p) => p.passageId)).toEqual(stored.map((r) => r.passageId));

    /* No embedder: BM25 over the passage text. */
    const lexicalOnly = new RetrievalService(serviceOptions(indexRoot, { logger, passageStore: store, loadTaxonomy: () => TAXONOMY, lineage: LINEAGE }));
    const lexBase = await serve(lexicalOnly, logger);
    const lex = (await call(lexBase, "GET", `/v1/shortlist?node=medicine&query=${encodeURIComponent("broad street pump")}&limit=3`)).json as ShortlistAnswer;
    expect(lex.reranked).toBe("bm25");
    expect(lex.passages[0]?.passageId).toBe(cholera);

    expect((await call(base, "GET", "/v1/shortlist?node=nope")).status).toBe(404);
    expect((await call(base, "GET", "/v1/shortlist?node=medicine&limit=51")).status).toBe(400);
    const noStore = new RetrievalService(serviceOptions(indexRoot, { logger }));
    expect((await call(await serve(noStore, logger), "GET", "/v1/shortlist?node=medicine")).status).toBe(503);

    /* POST /v1/reload re-reads the dense index too. */
    expect(store.reloads).toBe(0);
    await call(base, "POST", "/v1/reload", {});
    expect(store.reloads).toBe(1);
  });

  it("--passages-db and --embedder parse; --embedder alone or of an unknown kind is refused", () => {
    expect(parseRetrievalServerArgs([])).toMatchObject({ passagesDb: null, embedder: null });
    const args = parseRetrievalServerArgs(["--passages-db", "x/p.db", "--embedder", "stub"]);
    expect(args.passagesDb).toBe(path.resolve("x/p.db"));
    expect(args.embedder).toBe("stub");
    expect(() => parseRetrievalServerArgs(["--embedder", "stub"])).toThrow(/needs --passages-db/);
    expect(() => parseRetrievalServerArgs(["--passages-db", "p.db", "--embedder", "anthropic"])).toThrow(/--embedder must be one of/);
  });
});

describe("pull-archive round trip — the generation box derives the server's item ids", () => {
  const box = (name: string, files: { committed: string; corpus: string }): void => {
    redirect.map.clear();
    redirect.map.set(path.join(REPO_ROOT, "data", "transcript-digests.json").toLowerCase(), files.committed);
    redirect.map.set(path.join(REPO_ROOT, "data", "breadth-transcript-digests.json").toLowerCase(), path.join(tmp, name, "absent.json"));
    redirect.map.set(path.join(REPO_ROOT, "data-local", "transcripts", "corpus-digest.json").toLowerCase(), files.corpus);
  };
  const saved = process.env.FORAY_SKIP_CATALOGUE_CACHE;
  afterAll(() => {
    redirect.map.clear();
    if (saved === undefined) delete process.env.FORAY_SKIP_CATALOGUE_CACHE;
    else process.env.FORAY_SKIP_CATALOGUE_CACHE = saved;
  });

  it("pull-archive writes a digest that loadTranscriptArchive reads back with the server's rows, order and disambiguated item ids", async () => {
    /* MUTATIONS THAT KILL THIS: in pull-archive.mjs write the rows under
       `rows` instead of `transcripts` (the box reads none of them), or reverse
       the row order; in the server answer /v1/archive with the committed rows
       only. Ran the first — red. */
    process.env.FORAY_SKIP_CATALOGUE_CACHE = "1";
    const dir = path.join(tmp, "roundtrip");
    fs.mkdirSync(dir, { recursive: true });
    const roundup = "Weekly roundup: six stories we are following today";
    const committedRows: TranscriptDigestEntry[] = [
      { show_id: SHOW_A, show_title: "Alpha", guid: "r1", title: roundup, cues: 3 },
      { show_id: SHOW_A, show_title: "Alpha", guid: "r2", title: roundup, cues: 3 },
      { show_id: SHOW_A, show_title: "Alpha", guid: "solo", title: "A solo episode", cues: 2 }
    ];
    const serverLocal: TranscriptDigestEntry[] = [
      { show_id: SHOW_B, show_title: "Beta", guid: "x1", title: "A solo episode", cues: 2 },
      { show_id: SHOW_A, show_title: "Alpha", guid: "r3", title: roundup, cues: 4 },
      { show_id: SHOW_B, show_title: "Beta", guid: "x2", title: "Only on the server", cues: 5 },
      /* Also committed: the reader keeps the committed copy. */
      { show_id: SHOW_A, show_title: "Alpha", guid: "solo", title: "A solo episode (local copy)", cues: 2 }
    ];
    const committed = path.join(dir, "committed.json");
    fs.writeFileSync(committed, JSON.stringify({ transcripts: committedRows }), "utf8");
    const serverCorpus = path.join(dir, "server-corpus.json");
    fs.writeFileSync(serverCorpus, JSON.stringify({ generated_at: "2026-10-09T00:00:00.000Z", transcripts: serverLocal }), "utf8");
    const genCorpus = path.join(dir, "gen", "corpus-digest.json");
    fs.mkdirSync(path.dirname(genCorpus), { recursive: true });
    fs.writeFileSync(genCorpus, JSON.stringify({ transcripts: [{ show_id: SHOW_C, show_title: "Gamma", guid: "stale", title: "Stale", cues: 1 }] }), "utf8");

    /* The server box. */
    box("server", { committed, corpus: serverCorpus });
    const serverArchive = loadTranscriptArchive();
    expect(serverArchive.map((r) => r.guid)).toEqual(["r1", "r2", "solo", "x1", "r3", "x2"]);
    const logger = capturedLogger();
    const service = new RetrievalService({
      loadArchive: () => ({ rows: serverArchive, generatedAt: "2026-10-09T00:00:00.000Z" }),
      loadManifest: () => [],
      createCueStore: () => memoryStore([]),
      indexRoot: path.join(dir, "index"),
      logger
    });
    const base = await serve(service, logger);
    const served = (await call(base, "GET", "/v1/archive")).json as { transcripts: TranscriptDigestEntry[] };

    /* The generation box pulls, then reads through its own loader. */
    const pull = (await import(pathToFileURL(path.join(REPO_ROOT, "tools", "passage-index", "pull-archive.mjs")).href)) as {
      pullArchive: (o: { url: string; out: string }) => Promise<{ rows: number }>;
    };
    expect((await pull.pullArchive({ url: base, out: genCorpus })).rows).toBe(6);
    box("gen", { committed, corpus: genCorpus });
    const genArchive = loadTranscriptArchive();

    const ids = (rows: TranscriptDigestEntry[]): string[] => rows.map((r) => `${r.show_id}/${r.guid} -> ${deriveItemId(r)}`);
    expect(ids(genArchive)).toEqual(ids(served.transcripts));
    expect(ids(genArchive)).toEqual(ids(serverArchive));
    expect(genArchive.some((r) => r.guid === "stale")).toBe(false);
    /* The collisions are real: the committed pair and the local r3 are suffixed. */
    expect(genArchive.filter((r) => r.item_id_suffix).map((r) => r.guid)).toEqual(["r1", "r2", "r3"]);
    redirect.map.clear();
  });
});
