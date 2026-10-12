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
  startRetrievalServer,
  type RetrievalLogger,
  type RetrievalServiceOptions,
  type StartedRetrievalServer
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
