import { afterAll, afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createR2BodyFetcher,
  CueCacheDir,
  DEFAULT_CUE_CACHE_GB,
  RemoteCueStore,
  type FetchBody,
  type FetchedObject,
  type R2ClientModule,
  type RemoteCueLogger,
  type RemoteOrigin
} from "../src/cli/remoteCueStore";
import {
  DEFAULT_CUE_CACHE,
  parseRetrievalServerArgs,
  RetrievalService,
  startRetrievalServer,
  type StartedRetrievalServer
} from "../src/cli/retrievalServer";
import type { EpisodeManifestRow } from "../src/generation/manifestBodySource";
import { FileTranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { corpusSafeKey } from "../src/generation/transcriptCorpus";

/**
 * GV-54 (docs/roadmap/generation-v2.md, from W3-24; subsumes corpus roadmap
 * PKG-24): the remote cue store. Every fetch is an injected fake over an
 * in-memory "bucket"; nothing here touches R2 or any network but the
 * loopback server of the /v1/cues test. Each test names the one-line mutation
 * that turns it red.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv54-remote-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const running: StartedRetrievalServer[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

let dirs = 0;
function freshDirs(): { normalizedRoot: string; cacheRoot: string; indexRoot: string } {
  dirs += 1;
  const base = path.join(tmp, `case-${dirs}`);
  const out = { normalizedRoot: path.join(base, "normalized"), cacheRoot: path.join(base, "cue-cache"), indexRoot: path.join(base, "index") };
  fs.mkdirSync(out.normalizedRoot, { recursive: true });
  return out;
}

const SHOW = "gv54-tides";

function entry(guid: string, show = SHOW): TranscriptDigestEntry {
  return { show_id: show, show_title: "Tides", guid, title: `Episode ${guid}`, cues: 2 };
}

/** A farm-normalized body (it records a source_url, so it reads as "publisher"). */
function normalizedBytes(guid: string, words: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      show_id: SHOW,
      guid,
      source_url: `https://example.invalid/${guid}.vtt`,
      cues: [
        { start_sec: 0, end_sec: 5, text: `${words} opens the episode` },
        { start_sec: 5, end_sec: 9, text: `${words} closes it` }
      ]
    }),
    "utf8"
  );
}

const sha = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function row(guid: string, kind: "r2" | "legacy" | "local", key: string, bytes: Buffer, show = SHOW): EpisodeManifestRow {
  return {
    show_id: show,
    fileName: `${corpusSafeKey(guid)}.json`,
    bodyGuid: guid,
    size: bytes.length,
    mtimeMs: 1_700_000_000_000,
    origin: { kind, key, etag: `"etag-${guid}"`, sha256: sha(bytes) }
  };
}

/** An in-memory bucket: key -> object. Counts every GET. */
function bucket(objects: Record<string, FetchedObject>): { fetchBody: FetchBody; gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    fetchBody: async (origin: RemoteOrigin) => {
      gets.push(origin.key);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return objects[origin.key] ?? null;
    }
  };
}

function capturedLogger(): RemoteCueLogger & { events: Array<{ level: string; event: string } & Record<string, unknown>> } {
  const events: Array<{ level: string; event: string } & Record<string, unknown>> = [];
  return {
    events,
    info: (event, fields) => events.push({ level: "info", event, ...(fields ?? {}) }),
    error: (event, fields) => events.push({ level: "error", event, ...(fields ?? {}) })
  };
}

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, d))) out.push(`${d}/${f}`);
  return out.sort();
}

function bytesUnder(root: string): number {
  return filesUnder(root).reduce((n, f) => n + fs.statSync(path.join(root, ...f.split("/"))).size, 0);
}

function store(
  d: { normalizedRoot: string; cacheRoot: string },
  fetchBody: FetchBody,
  capBytes = 10_000_000,
  logger: RemoteCueLogger = capturedLogger()
): RemoteCueStore {
  return new RemoteCueStore({ normalizedRoot: d.normalizedRoot, cache: new CueCacheDir(d.cacheRoot, capBytes), fetchBody, logger });
}

const keyOf = (guid: string): string => `transcripts/normalized/${SHOW}/${corpusSafeKey(guid)}.json`;

describe("GV-54 remote cue store — fetch once, then read from the cache", () => {
  it("miss, then fetch, then cache: the body is written byte-identical and a second call makes no fetch", async () => {
    /* MUTATION THAT KILLS THIS: skip the `this.cache.has(dir, row.fileName)`
       check in ensureUncached (always fetch) — the second call GETs again. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Semmelweis");
    const r2 = bucket({ [keyOf("ep-1")]: { bytes, sha256Meta: sha(bytes) } });
    const s = store(d, r2.fetchBody);
    const r = row("ep-1", "r2", keyOf("ep-1"), bytes);

    expect(await s.ensureBody(entry("ep-1"), r)).toEqual({ status: "fetched" });
    expect(r2.gets).toEqual([keyOf("ep-1")]);
    const [cached] = filesUnder(d.cacheRoot);
    expect(cached).toBe(`${corpusSafeKey(SHOW)}/${corpusSafeKey("ep-1")}.json`);
    expect(fs.readFileSync(path.join(d.cacheRoot, ...(cached as string).split("/"))).equals(bytes)).toBe(true);
    expect(s.getCues(entry("ep-1"))?.[0]?.text).toBe("Semmelweis opens the episode");
    expect(s.transcriptSource(entry("ep-1"))).toBe("publisher");

    expect(await s.ensureBody(entry("ep-1"), r)).toEqual({ status: "cached" });
    expect(r2.gets).toHaveLength(1);
    /* A restarted store finds the same file and still does not fetch. */
    const again = store(d, r2.fetchBody);
    expect(await again.ensureBody(entry("ep-1"), r)).toEqual({ status: "cached" });
    expect(again.getCues(entry("ep-1"))?.[1]?.text).toBe("Semmelweis closes it");
    expect(r2.gets).toHaveLength(1);
  });

  it("a body fetched after an earlier miss is returned on the very next request (forgetShow)", async () => {
    /* MUTATION THAT KILLS THIS: delete `this.cached.forgetShow(showId)` after
       the write — the provider over the cache memoised the miss (its listing,
       its locate answer and its null cues), so getCues stays null. */
    const d = freshDirs();
    const one = normalizedBytes("ep-1", "Alpha");
    const two = normalizedBytes("ep-2", "Beta");
    const r2 = bucket({ [keyOf("ep-1")]: { bytes: one, sha256Meta: sha(one) }, [keyOf("ep-2")]: { bytes: two, sha256Meta: sha(two) } });
    const s = store(d, r2.fetchBody);
    /* The miss is remembered before the show has any directory... */
    expect(s.getCues(entry("ep-1"))).toBeNull();
    expect(s.bodyStat(entry("ep-1"))).toBeNull();
    expect((await s.ensureBody(entry("ep-1"), row("ep-1", "r2", keyOf("ep-1"), one))).status).toBe("fetched");
    expect(s.getCues(entry("ep-1"))?.[0]?.text).toBe("Alpha opens the episode");
    /* ...and after it has one, with a listing already taken. */
    expect(s.getCues(entry("ep-2"))).toBeNull();
    expect((await s.ensureBody(entry("ep-2"), row("ep-2", "r2", keyOf("ep-2"), two))).status).toBe("fetched");
    expect(s.getCues(entry("ep-2"))?.[0]?.text).toBe("Beta opens the episode");
    expect(s.bodyStat(entry("ep-2"))).toEqual({ mtimeMs: expect.any(Number), size: two.length });
  });

  it("a 404 returns null and writes nothing", async () => {
    /* MUTATION THAT KILLS THIS: drop the `if (!fetched)` return — the store
       reads `.bytes` of null and ensureBody rejects instead of answering
       absent. */
    const d = freshDirs();
    const r2 = bucket({});
    const logger = capturedLogger();
    const s = store(d, r2.fetchBody, 10_000_000, logger);
    const bytes = normalizedBytes("gone", "Nobody");
    expect(await s.ensureBody(entry("gone"), row("gone", "r2", keyOf("gone"), bytes))).toEqual({ status: "absent", reason: "NOT_FOUND" });
    expect(r2.gets).toEqual([keyOf("gone")]);
    expect(filesUnder(d.cacheRoot)).toEqual([]);
    expect(s.getCues(entry("gone"))).toBeNull();
    expect(logger.events.map((e) => e.event)).toEqual(["cue-fetch-absent"]);
    /* No manifest row, or a row from a local stream, is never fetched. */
    expect(await s.ensureBody(entry("x"), null)).toEqual({ status: "absent", reason: "NO_MANIFEST_ROW" });
    expect(await s.ensureBody(entry("x"), row("x", "local", "gv54/x.json", bytes))).toEqual({ status: "absent", reason: "NOT_REMOTE" });
    expect(r2.gets).toHaveLength(1);
  });

  it("a manifest file name that escapes the cache is refused before the cache is even asked", async () => {
    /* MUTATION THAT KILLS THIS: drop the unsafeName guard, or move it after
       the cache check — "../../outside.json" then names a real file beside
       the cache root and the store answers "cached" for it. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-esc", "Escape");
    const outside = path.join(path.dirname(d.cacheRoot), "outside.json");
    fs.writeFileSync(outside, bytes);
    const r2 = bucket({ [keyOf("ep-esc")]: { bytes, sha256Meta: sha(bytes) } });
    const logger = capturedLogger();
    const s = store(d, r2.fetchBody, 10_000_000, logger);
    const r = { ...row("ep-esc", "r2", keyOf("ep-esc"), bytes), fileName: "../../outside.json" };
    expect(await s.ensureBody(entry("ep-esc"), r)).toEqual({ status: "refused", reason: "PATH_ESCAPE" });
    expect(r2.gets).toEqual([]);
    expect(filesUnder(d.cacheRoot)).toEqual([]);
    expect(fs.readFileSync(outside).equals(bytes)).toBe(true);
    expect(logger.events).toContainEqual(expect.objectContaining({ level: "error", event: "cue-fetch-refused", reason: "PATH_ESCAPE" }));
  });

  it("a sha mismatch is not cached and not served; the next request fetches again", async () => {
    /* MUTATION THAT KILLS THIS: remove the sha256-metadata comparison — the
       corrupt bytes are written and served. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Corrupt");
    const r2 = bucket({ [keyOf("ep-1")]: { bytes, sha256Meta: sha(Buffer.from("something else")) } });
    const logger = capturedLogger();
    const s = store(d, r2.fetchBody, 10_000_000, logger);
    const r = row("ep-1", "r2", keyOf("ep-1"), bytes);
    expect(await s.ensureBody(entry("ep-1"), r)).toEqual({ status: "refused", reason: "SHA_MISMATCH" });
    expect(filesUnder(d.cacheRoot)).toEqual([]);
    expect(s.getCues(entry("ep-1"))).toBeNull();
    expect(logger.events).toContainEqual(expect.objectContaining({ level: "error", event: "cue-fetch-refused", reason: "SHA_MISMATCH" }));
    expect((await s.ensureBody(entry("ep-1"), r)).status).toBe("refused");
    expect(r2.gets).toHaveLength(2);
    /* Upper-case hex metadata is the same digest. */
    const ok = normalizedBytes("ep-2", "Fine");
    const r2b = bucket({ [keyOf("ep-2")]: { bytes: ok, sha256Meta: sha(ok).toUpperCase() } });
    expect((await store(d, r2b.fetchBody).ensureBody(entry("ep-2"), row("ep-2", "r2", keyOf("ep-2"), ok))).status).toBe("fetched");
  });

  it("a legacy whisper origin is converted (GV-23) and served with transcript_source 'asr-local'", async () => {
    /* MUTATION THAT KILLS THIS: write the fetched bytes unconverted for a
       legacy origin (skip the `origin.kind === "legacy"` branch) — a raw
       whisper document has segments, not cues, so getCues is null and the
       body states no transcript_source. */
    const d = freshDirs();
    const whisper = Buffer.from(
      JSON.stringify({
        meta: { engine: "faster-whisper", model: "large-v3", detected_language: "en" },
        segments: [
          { start: 0, end: 4.5, text: " The tide comes in twice a day.", words: [{ word: " The", start: 0, end: 0.2 }] },
          { start: 4.5, end: 9, text: " And goes out twice." }
        ]
      }),
      "utf8"
    );
    const legacyKey = "tides/the-tide-0123456789.json";
    const r2 = bucket({ [legacyKey]: { bytes: whisper, sha256Meta: null } });
    const s = store(d, r2.fetchBody);
    expect(await s.ensureBody(entry("ep-legacy"), row("ep-legacy", "legacy", legacyKey, whisper))).toEqual({ status: "fetched" });
    expect(s.getCues(entry("ep-legacy"))?.map((c) => c.text)).toEqual(["The tide comes in twice a day.", "And goes out twice."]);
    expect(s.transcriptSource(entry("ep-legacy"))).toBe("asr-local");
    const [cached] = filesUnder(d.cacheRoot);
    const body = JSON.parse(fs.readFileSync(path.join(d.cacheRoot, ...(cached as string).split("/")), "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ show_id: SHOW, guid: "ep-legacy", transcript_source: "asr-local", asr: { engine: "faster-whisper" } });
    expect("source_url" in body).toBe(false);
    /* A legacy object that is not a whisper document is refused, not cached. */
    const bad = Buffer.from(JSON.stringify({ cues: [] }), "utf8");
    const r2bad = bucket({ "tides/bad-0123456789.json": { bytes: bad, sha256Meta: null } });
    const badStore = store(freshDirs(), r2bad.fetchBody);
    expect(await badStore.ensureBody(entry("ep-bad"), row("ep-bad", "legacy", "tides/bad-0123456789.json", bad))).toEqual({
      status: "refused",
      reason: "BAD_SHAPE:LegacyShapeError"
    });
  });

  it("the cache stays under its byte bound: oldest out first, a hit keeps a body warm, an evicted body is fetched again", async () => {
    /* MUTATION THAT KILLS THIS: make `put` skip `this.evict(key)` (return
       {evictedShows: []}) — the directory grows past the cap. */
    const d = freshDirs();
    const guids = ["ep-a", "ep-b", "ep-c"];
    const objects: Record<string, FetchedObject> = {};
    const bodies = new Map<string, Buffer>();
    for (const g of guids) {
      const b = normalizedBytes(g, `Body ${g}`);
      bodies.set(g, b);
      objects[keyOf(g)] = { bytes: b, sha256Meta: sha(b) };
    }
    const one = (bodies.get("ep-a") as Buffer).length;
    const cap = 2 * one + Math.floor(one / 2); // two bodies fit, three do not
    const r2 = bucket(objects);
    const s = store(d, r2.fetchBody, cap);
    const rowOf = (g: string): EpisodeManifestRow => row(g, "r2", keyOf(g), bodies.get(g) as Buffer);

    expect((await s.ensureBody(entry("ep-a"), rowOf("ep-a"))).status).toBe("fetched");
    expect((await s.ensureBody(entry("ep-b"), rowOf("ep-b"))).status).toBe("fetched");
    expect((await s.ensureBody(entry("ep-a"), rowOf("ep-a"))).status).toBe("cached"); // a is now the most recent
    expect((await s.ensureBody(entry("ep-c"), rowOf("ep-c"))).status).toBe("fetched");
    expect(bytesUnder(d.cacheRoot)).toBeLessThanOrEqual(cap);
    expect(filesUnder(d.cacheRoot).map((f) => f.split("/")[1])).toEqual([`${corpusSafeKey("ep-a")}.json`, `${corpusSafeKey("ep-c")}.json`].sort());
    /* The provider forgot the evicted file too: b is a miss, not a stale path. */
    expect(s.getCues(entry("ep-b"))).toBeNull();
    expect(s.getCues(entry("ep-a"))?.[0]?.text).toBe("Body ep-a opens the episode");
    expect((await s.ensureBody(entry("ep-b"), rowOf("ep-b"))).status).toBe("fetched");
    expect(s.getCues(entry("ep-b"))?.[0]?.text).toBe("Body ep-b opens the episode");
    expect(r2.gets.filter((k) => k === keyOf("ep-b"))).toHaveLength(2);
    expect(bytesUnder(d.cacheRoot)).toBeLessThanOrEqual(cap);
    /* A restart with a smaller cap re-reads the directory and trims it. */
    const smaller = new CueCacheDir(d.cacheRoot, one);
    expect(smaller.bytes).toBeLessThanOrEqual(one);
    expect(bytesUnder(d.cacheRoot)).toBe(smaller.bytes);
    expect(smaller.fileCount).toBe(1);
  });

  it("a failed fetch (no R2 key, a network error) is reported, writes nothing, never throws, and the next request tries again", async () => {
    /* MUTATION THAT KILLS THIS: rethrow in the fetch's catch instead of
       returning {status: "failed"} — ensureBody rejects and the request
       crashes. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Later");
    let broken = true;
    const gets: string[] = [];
    const fetchBody: FetchBody = async (origin) => {
      gets.push(origin.key);
      if (broken) throw Object.assign(new Error("NO_CREDENTIALS: env incomplete"), { name: "R2Error", code: "NO_CREDENTIALS" });
      return { bytes, sha256Meta: sha(bytes) };
    };
    const logger = capturedLogger();
    const s = store(d, fetchBody, 10_000_000, logger);
    const r = row("ep-1", "r2", keyOf("ep-1"), bytes);
    expect(await s.ensureBody(entry("ep-1"), r)).toEqual({ status: "failed", reason: "NO_CREDENTIALS" });
    expect(filesUnder(d.cacheRoot)).toEqual([]);
    const failed = logger.events.find((e) => e.event === "cue-fetch-failed");
    expect(failed).toMatchObject({ level: "error", show: SHOW, error: "NO_CREDENTIALS" });
    expect(JSON.stringify(failed)).not.toContain("env incomplete");
    broken = false;
    expect(await s.ensureBody(entry("ep-1"), r)).toEqual({ status: "fetched" });
    expect(gets).toHaveLength(2);
    /* r2-client's TOO_LARGE is the object's fault: refused, not failed. */
    const tooLarge: FetchBody = async () => {
      throw Object.assign(new Error("TOO_LARGE: x"), { name: "R2Error", code: "TOO_LARGE" });
    };
    expect(await store(freshDirs(), tooLarge).ensureBody(entry("ep-1"), r)).toEqual({ status: "refused", reason: "TOO_LARGE" });
  });

  it("a body on the local normalized disk is served from there, with no fetch", async () => {
    /* MUTATION THAT KILLS THIS: drop the `this.local.bodyStat(entry)` check at
       the top of ensureUncached — the store GETs a body it already has. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Local");
    const showDir = path.join(d.normalizedRoot, corpusSafeKey(SHOW));
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, `${corpusSafeKey("ep-1")}.json`), bytes);
    const r2 = bucket({ [keyOf("ep-1")]: { bytes: normalizedBytes("ep-1", "Remote"), sha256Meta: null } });
    const s = store(d, r2.fetchBody);
    expect(await s.ensureBody(entry("ep-1"), row("ep-1", "r2", keyOf("ep-1"), bytes))).toEqual({ status: "local" });
    expect(r2.gets).toEqual([]);
    expect(s.getCues(entry("ep-1"))?.[0]?.text).toBe("Local opens the episode");
    expect(filesUnder(d.cacheRoot)).toEqual([]);
  });

  it("concurrent requests for one episode make one fetch", async () => {
    /* MUTATION THAT KILLS THIS: skip the in-flight map in ensureBody — three
       concurrent requests make three GETs. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Once");
    const r2 = bucket({ [keyOf("ep-1")]: { bytes, sha256Meta: sha(bytes) } });
    const s = store(d, r2.fetchBody);
    const r = row("ep-1", "r2", keyOf("ep-1"), bytes);
    const outcomes = await Promise.all([s.ensureBody(entry("ep-1"), r), s.ensureBody(entry("ep-1"), r), s.ensureBody(entry("ep-1"), r)]);
    expect(outcomes.map((o) => o.status)).toEqual(["fetched", "fetched", "fetched"]);
    expect(r2.gets).toHaveLength(1);
    expect((await s.ensureBody(entry("ep-1"), r)).status).toBe("cached");
  });

  it("forgetShow clears one show's memoised misses in FileTranscriptCueProvider, and only that show's", () => {
    /* MUTATION THAT KILLS THIS: leave `dirByShow` alone in forgetShow — the
       show had no directory at the first look, and that null is kept. */
    const root = path.join(tmp, "forget");
    fs.mkdirSync(root, { recursive: true });
    const provider = new FileTranscriptCueProvider(root);
    const other = entry("o-1", "gv54-other");
    expect(provider.getCues(entry("ep-1"))).toBeNull();
    expect(provider.getCues(other)).toBeNull();
    for (const [show, guid] of [
      [SHOW, "ep-1"],
      ["gv54-other", "o-1"]
    ] as const) {
      const dir = path.join(root, corpusSafeKey(show));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${corpusSafeKey(guid)}.json`), normalizedBytes(guid, "Late"));
    }
    expect(provider.getCues(entry("ep-1"))).toBeNull(); // still memoised
    provider.forgetShow(SHOW);
    expect(provider.getCues(entry("ep-1"))?.[0]?.text).toBe("Late opens the episode");
    expect(provider.getCues(other)).toBeNull(); // the other show's miss is untouched
    provider.forgetShow("gv54-other");
    expect(provider.getCues(other)).not.toBeNull();
  });
});

describe("GV-54 the default R2 fetcher (r2-client.mjs, injected)", () => {
  it("NoSuchKey is null; the sha metadata is passed on; a credential failure throws and the next fetch retries", async () => {
    /* MUTATION THAT KILLS THIS: make isNotFound return false — a missing
       object throws, and the server would answer 503 (failed) instead of 404. */
    const bytes = Buffer.from("{}", "utf8");
    let credentialsOk = false;
    let clients = 0;
    const module: R2ClientModule = {
      loadR2Credentials: async () => {
        if (!credentialsOk) throw Object.assign(new Error("NO_CREDENTIALS"), { name: "R2Error", code: "NO_CREDENTIALS" });
        return { bucket: "foray-transcriptions" };
      },
      createR2Client: async () => {
        clients += 1;
        return { fake: true };
      },
      getObject: async (_client, bucketName, key) => {
        expect(bucketName).toBe("foray-transcriptions");
        if (key === "missing.json") throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        if (key === "boom.json") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
        return { body: bytes, sha256Meta: "abc", etag: '"e"' };
      }
    };
    const fetchBody = createR2BodyFetcher({ loadModule: async () => module });
    await expect(fetchBody({ kind: "r2", key: "a.json" })).rejects.toMatchObject({ code: "NO_CREDENTIALS" });
    credentialsOk = true;
    expect(await fetchBody({ kind: "r2", key: "a.json" })).toEqual({ bytes, sha256Meta: "abc", etag: '"e"' });
    expect(await fetchBody({ kind: "r2", key: "missing.json" })).toBeNull();
    await expect(fetchBody({ kind: "r2", key: "boom.json" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clients).toBe(1);
  });
});

describe("GV-54 the retrieval server with --r2", () => {
  it("/v1/cues awaits the fetch for an R2-only episode; a missing object is 404, a failed fetch 503, and the server keeps serving", async () => {
    /* MUTATION THAT KILLS THIS: route /v1/cues back to the synchronous
       `service.cues(...)` — the R2-only episode answers 404. */
    const d = freshDirs();
    const bytes = normalizedBytes("ep-1", "Served");
    const objects: Record<string, FetchedObject> = { [keyOf("ep-1")]: { bytes, sha256Meta: sha(bytes) } };
    const fetchBody: FetchBody = async (origin) => {
      if (origin.key === keyOf("ep-boom")) throw Object.assign(new Error("ECONNRESET"), { name: "Error" });
      return objects[origin.key] ?? null;
    };
    const archive = ["ep-1", "ep-gone", "ep-boom"].map((g) => entry(g));
    const rows = archive.map((e) => row(e.guid, "r2", keyOf(e.guid), bytes));
    const events: string[] = [];
    const logger = { info: (event: string) => events.push(event), error: (event: string) => events.push(event) };
    const service = new RetrievalService({
      loadArchive: () => ({ rows: archive, generatedAt: null }),
      loadManifest: () => rows,
      createCueStore: () => new RemoteCueStore({ normalizedRoot: d.normalizedRoot, cache: new CueCacheDir(d.cacheRoot, 10_000_000), fetchBody, logger }),
      indexRoot: d.indexRoot,
      logger
    });
    const started = await startRetrievalServer({ service, logger, token: null, host: "127.0.0.1", port: 0 });
    running.push(started);
    const get = async (guid: string): Promise<{ status: number; json: unknown }> => {
      const res = await fetch(`http://127.0.0.1:${started.port}/v1/cues?show_id=${SHOW}&guid=${guid}`);
      return { status: res.status, json: await res.json() };
    };
    const served = await get("ep-1");
    expect(served.status).toBe(200);
    expect(served.json).toMatchObject({ transcript_source: "publisher", cues: [{ text: "Served opens the episode" }, { text: "Served closes it" }] });
    expect((await get("ep-gone")).status).toBe(404);
    expect((await get("ep-boom")).status).toBe(503);
    expect(events).toContain("cue-fetch-failed");
    expect((await get("ep-1")).status).toBe(200);
    expect((await get("nope")).status).toBe(404);
    /* Without a read-through store the synchronous path is unchanged. */
    expect(service.cues(SHOW, "ep-1")).toMatchObject({ transcript_source: "publisher" });
  });

  it("--r2 turns the remote store on; --cue-cache and --cue-cache-gb need it", () => {
    /* MUTATION THAT KILLS THIS: drop the "need --r2" check — a --cue-cache
       given without --r2 is silently ignored. */
    expect(parseRetrievalServerArgs([])).toMatchObject({ r2: false, cueCache: DEFAULT_CUE_CACHE, cueCacheGb: DEFAULT_CUE_CACHE_GB });
    expect(parseRetrievalServerArgs(["--r2", "--cue-cache", "x/cache", "--cue-cache-gb", "5"])).toMatchObject({
      r2: true,
      cueCache: path.resolve("x/cache"),
      cueCacheGb: 5
    });
    expect(() => parseRetrievalServerArgs(["--cue-cache", "x/cache"])).toThrow(/need --r2/);
    expect(() => parseRetrievalServerArgs(["--cue-cache-gb", "5"])).toThrow(/need --r2/);
    expect(() => parseRetrievalServerArgs(["--r2", "--cue-cache-gb", "0"])).toThrow(/--cue-cache-gb must be/);
  });
});
