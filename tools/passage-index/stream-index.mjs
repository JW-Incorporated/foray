#!/usr/bin/env node
/* Stream indexer (GV-09, from W3-05; docs/roadmap/generation-v2.md; covers
   R1-09, GP-09, R2-16).

     node tools/passage-index/stream-index.mjs --source local|r2 [--show x] [--full]
       [--passages-out f] [--index-root d] [--cue-cache d --cue-cache-gb n]
       [--staged-out f] [--manifest-dir d] [--normalized-root d] [--min-free-gb n]

   Builds the per-show BM25 caches, the staged digest rows (and, once GV-12's
   --passages-out lands in indexBodies, the passages) wherever the transcripts
   live: the founder PC's data-local/transcripts/normalized/ (--source local)
   or the foray-transcriptions bucket streamed from R2 (--source r2). Exactly
   one body is held in memory at a time, so the 1 TB bucket never needs a
   mirror.

   1. LIST (sources.mjs): a directory walk, or ListObjectsV2 only.
   2. CHOOSE the shows to rebuild: every listed show with --full, else the
      delta against data-local/passage-index/episodes.jsonl (manifest.mjs
      showsToRebuild). --show narrows either to one show (its show_id or its
      directory name).
   3. GUARD the disk BEFORE the first body is read or fetched: needBytes is
      POSTINGS_FACTOR (0.4) x the bytes of the bodies to stream, plus
      PASSAGES_FACTOR (1.1) x them when --passages-out is set, plus what the
      cue cache can take (the smaller of those bytes and --cue-cache-gb).
      tools/foraycorpus-export/inventory.mjs ensureDiskSpace refuses with
      DISK_SPACE (exit 2) when free - needBytes < --min-free-gb (default 20;
      0 turns the guard off), measured at --index-root.
   4. STREAM: one backend indexBodies child (backend/src/cli/indexBodies.ts,
      GV-05), spawned once through tsx the way
      tools/generation/warm-transcript-index.mjs launches its warmer, is fed
      {kind:"body"} records and an {kind:"end-show"} marker after each show.
      The launcher waits for indexBodies' summary line for that show before
      the next show starts, so the child holds one show's term counts, never
      cues and never a body.
   5. COMMIT the manifest after each show (episodes.jsonl and quarantine.jsonl,
      tmp + rename).

   A show is re-streamed whole on any change, because ShowIndex postings are
   per show. Each body is dropped after it is sent. With --cue-cache the exact
   bytes are also kept in a byte-bounded LRU directory laid out like
   transcripts/normalized/ (<dir>/<fileName>), for the remote cue store
   (GV-54, W3-24) to read through.

   Writes: the caches (--index-root, default data-local/transcripts/index),
   the staged digest rows (--staged-out, default
   data-local/passage-index/staged-digest.jsonl), the manifest
   (--manifest-dir, default data-local/passage-index) and, only when set, the
   passages and the cue cache. Nothing else; no body is ever written outside
   the cue cache. indexBodies APPENDS staged rows, so a re-streamed show
   appends its new rows again; readers keep the first row per guid.

   Exit: 0 done (quarantined objects are reported, skipped and the run goes
   on), 1 the indexer reported a problem or failed, 2 DISK_SPACE.

   The R2 key never lives in the tree: r2-client.mjs loadR2Credentials reads
   the environment or R2_CREDENTIALS_FILE. Tests inject the indexer, the R2
   client and statfs; none of them touches the network. */
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isEntryScript } from "../ci/entry.mjs";
import { exitCodeFor } from "../generation/exit-code.mjs";
import { ensureDiskSpace, GB, sizeOrMax } from "../foraycorpus-export/inventory.mjs";
import { createR2Client, loadR2Credentials } from "../foraycorpus-export/r2-client.mjs";
import { buildShowMap } from "../foraycorpus-export/show-map.mjs";
import { manifestRow, quarantineRow, readManifest, replaceShow, showsToRebuild, writeManifest } from "./manifest.mjs";
import { listLocal, listR2Normalized, readLocal, readR2 } from "./sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolvePath(HERE, "..", "..");
export const BACKEND_DIR = join(REPO_ROOT, "backend");
/** The indexer entry, relative to backend/ (GV-05). */
export const INDEX_ENTRY = "src/cli/indexBodies.ts";

export const DEFAULT_NORMALIZED_ROOT = join(REPO_ROOT, "data-local", "transcripts", "normalized");
export const DEFAULT_INDEX_ROOT = join(REPO_ROOT, "data-local", "transcripts", "index");
export const DEFAULT_MANIFEST_DIR = join(REPO_ROOT, "data-local", "passage-index");
export const DEFAULT_STAGED_OUT = join(DEFAULT_MANIFEST_DIR, "staged-digest.jsonl");
export const DEFAULT_MIN_FREE_GB = 20;
export const DEFAULT_CUE_CACHE_GB = 20;
export const POSTINGS_FACTOR = 0.4;
export const PASSAGES_FACTOR = 1.1;
export const DISK_SPACE_EXIT_CODE = 2;
export const SOURCES = Object.freeze(["local", "r2"]);

export const USAGE =
  "node tools/passage-index/stream-index.mjs --source local|r2 [--show x] [--full] [--passages-out f] [--index-root d]" +
  " [--cue-cache d --cue-cache-gb n] [--staged-out f] [--manifest-dir d] [--normalized-root d] [--min-free-gb n]";

export class StreamIndexError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StreamIndexError";
    this.code = code;
  }
}

/** Parsed argv; an unknown flag, a missing value or a bad number throws. */
export function parseStreamArgs(argv) {
  const args = {
    source: "local",
    show: null,
    full: false,
    passagesOut: null,
    indexRoot: DEFAULT_INDEX_ROOT,
    stagedOut: DEFAULT_STAGED_OUT,
    manifestDir: DEFAULT_MANIFEST_DIR,
    normalizedRoot: DEFAULT_NORMALIZED_ROOT,
    cueCache: null,
    cueCacheGb: DEFAULT_CUE_CACHE_GB,
    minFreeGb: DEFAULT_MIN_FREE_GB,
  };
  const number = (flag, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new StreamIndexError("BAD_NUMBER", `${flag} must be a number >= 0, got ${JSON.stringify(raw)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--full") {
      args.full = true;
      continue;
    }
    const value = argv[i + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) throw new StreamIndexError("MISSING_VALUE", `${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === "--source") {
      args.source = needsValue();
      if (!SOURCES.includes(args.source)) throw new StreamIndexError("BAD_SOURCE", `--source must be one of ${SOURCES.join(", ")}`);
    } else if (flag === "--show") args.show = needsValue();
    else if (flag === "--passages-out") args.passagesOut = resolvePath(needsValue());
    else if (flag === "--index-root") args.indexRoot = resolvePath(needsValue());
    else if (flag === "--staged-out") args.stagedOut = resolvePath(needsValue());
    else if (flag === "--manifest-dir") args.manifestDir = resolvePath(needsValue());
    else if (flag === "--normalized-root") args.normalizedRoot = resolvePath(needsValue());
    else if (flag === "--cue-cache") args.cueCache = resolvePath(needsValue());
    else if (flag === "--cue-cache-gb") args.cueCacheGb = number(flag, needsValue());
    else if (flag === "--min-free-gb") args.minFreeGb = number(flag, needsValue());
    else throw new StreamIndexError("UNKNOWN_FLAG", `${JSON.stringify(flag)}; usage: ${USAGE}`);
  }
  return args;
}

/** The disk the run can take (step 3 of the header). */
export function estimateNeedBytes({ bodyBytes, passages = false, cueCacheCapBytes = 0 }) {
  const cue = Math.min(bodyBytes, Math.max(0, cueCacheCapBytes));
  return Math.ceil(bodyBytes * POSTINGS_FACTOR + (passages ? bodyBytes * PASSAGES_FACTOR : 0) + cue);
}

/* ------------------------------------------------------------ cue cache */

/**
 * A byte-bounded LRU directory of exact body bytes, laid out like
 * transcripts/normalized/ (<root>/<dir>/<fileName>). The order is the files'
 * mtime when the cache is opened (a reader that touches a file on a hit keeps
 * it warm), then put order. A body larger than the whole cap is not kept.
 */
export class CueCache {
  constructor(root, capBytes) {
    this.root = root;
    this.capBytes = capBytes;
    this.entries = new Map(); // "dir/file" -> size, oldest first
    this.bytes = 0;
    this.evicted = 0;
    const found = [];
    if (existsSync(root)) {
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const fileName of readdirSync(join(root, dir.name))) {
          if (!fileName.endsWith(".json")) continue;
          const st = statSync(join(root, dir.name, fileName));
          found.push({ key: `${dir.name}/${fileName}`, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const f of found) {
      this.entries.set(f.key, f.size);
      this.bytes += f.size;
    }
    this.evict();
  }

  put(dir, fileName, bytes) {
    if (bytes.length > this.capBytes) return false;
    const key = `${dir}/${fileName}`;
    const path = join(this.root, dir, fileName);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${fileName}.tmp-${process.pid}`);
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    if (this.entries.has(key)) {
      this.bytes -= this.entries.get(key);
      this.entries.delete(key);
    }
    this.entries.set(key, bytes.length);
    this.bytes += bytes.length;
    this.evict();
    return true;
  }

  evict() {
    for (const [key, size] of this.entries) {
      if (this.bytes <= this.capBytes) break;
      rmSync(join(this.root, ...key.split("/")), { force: true });
      this.entries.delete(key);
      this.bytes -= size;
      this.evicted += 1;
    }
  }
}

/* -------------------------------------------------------------- indexer */

/**
 * The real indexer: ONE backend indexBodies child, spawned through tsx.
 * Returns {send(record), endShow(showId) -> summary line, close() -> {exitCode, problems}}.
 * `command`/`args`/`cwd` replace the tsx launch (tests run a plain node
 * script that speaks the same protocol).
 */
export function spawnIndexer({ indexRoot, stagedOut, passagesOut = null, command = null, args = null, cwd = BACKEND_DIR, log = (line) => console.log(line) } = {}) {
  let argv = args;
  let cmd = command;
  if (!cmd) {
    const tsx = createRequire(join(BACKEND_DIR, "package.json")).resolve("tsx/cli");
    cmd = process.execPath;
    argv = [tsx, INDEX_ENTRY, "--index-root", indexRoot, "--staged-out", stagedOut, ...(passagesOut ? ["--passages-out", passagesOut] : [])];
  }
  const child = spawn(cmd, argv ?? [], { cwd, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const problems = [];
  let waiting = null; // {showId, resolve, reject}
  let exited = null;
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (waiting) {
        waiting.reject(new StreamIndexError("INDEXER_EXIT", `indexBodies exited (${exitCodeFor(code, signal)}) before ${waiting.showId} was written`));
        waiting = null;
      }
      resolve(exited);
    });
  });
  const fail = (e) => {
    if (waiting) {
      waiting.reject(e);
      waiting = null;
    }
  };
  child.on("error", fail);
  /* A child gone early turns the next write into EPIPE; that is the exit
     handler's to report, never an unhandled 'error' event. */
  child.stdin.on("error", fail);
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (line.startsWith("problem: ")) problems.push(line.slice("problem: ".length));
    log(`[indexBodies] ${line}`);
    if (waiting && line.startsWith(`${waiting.showId}: `)) {
      const w = waiting;
      waiting = null;
      w.resolve(line);
    }
  });

  const write = async (record) => {
    if (exited) throw new StreamIndexError("INDEXER_EXIT", `indexBodies exited (${exitCodeFor(exited.code, exited.signal)})`);
    if (!child.stdin.write(`${JSON.stringify(record)}\n`)) {
      await Promise.race([once(child.stdin, "drain"), exitPromise]);
    }
  };
  return {
    send: (record) => write(record),
    async endShow(showId) {
      const done = new Promise((resolve, reject) => {
        waiting = { showId, resolve, reject };
      });
      await write({ kind: "end-show", show_id: showId });
      return done;
    },
    async close() {
      child.stdin.end();
      const { code, signal } = await exitPromise;
      return { exitCode: exitCodeFor(code, signal), problems };
    },
  };
}

/* ----------------------------------------------------------------- run */

/** The listing narrowed to one show, by show_id or directory name. */
function narrow(shows, show) {
  if (show === null || show === undefined) return shows;
  const out = new Map();
  for (const [showId, entries] of shows) {
    if (showId === show || entries.some((e) => e.dir === show)) out.set(showId, entries);
  }
  return out;
}

/**
 * One run. `list()` is a sources.mjs listing ({shows, ...notes}) and
 * `read(entry)` turns an entry into an item; `indexer(paths)` makes the
 * indexer (spawnIndexer by default, only when a show is rebuilt).
 */
export async function streamIndex({
  list,
  read,
  manifestDir = DEFAULT_MANIFEST_DIR,
  indexRoot = DEFAULT_INDEX_ROOT,
  stagedOut = DEFAULT_STAGED_OUT,
  passagesOut = null,
  cueCache = null,
  cueCacheGb = DEFAULT_CUE_CACHE_GB,
  full = false,
  show = null,
  minFreeGb = DEFAULT_MIN_FREE_GB,
  statfs,
  indexer = (paths) => spawnIndexer(paths),
  now = () => new Date(),
  log = (line) => console.log(line),
} = {}) {
  const listing = await list();
  const shows = narrow(listing.shows, show);
  const manifest = readManifest(manifestDir);
  const delta = showsToRebuild(shows, manifest);
  const rebuild = full ? [...shows.keys()] : delta.rebuild;

  let bodyBytes = 0;
  let bodiesPlanned = 0;
  for (const showId of rebuild) {
    for (const entry of shows.get(showId)) {
      bodyBytes += sizeOrMax(entry.size);
      bodiesPlanned += 1;
    }
  }
  const cueCacheCapBytes = cueCache ? cueCacheGb * GB : 0;
  const needBytes = estimateNeedBytes({ bodyBytes, passages: Boolean(passagesOut), cueCacheCapBytes });
  let disk = null;
  if (minFreeGb > 0 && rebuild.length > 0) {
    disk = ensureDiskSpace({ path: indexRoot, needBytes, minFreeBytes: minFreeGb * GB, ...(statfs ? { statfs } : {}) });
    log(`stream-index: disk guard ok (${disk.message})`);
  }
  for (const showId of rebuild) log(`stream-index: rebuild ${showId} (${full ? "--full" : delta.reasons.get(showId)})`);

  /* Keys refused at list time (PATH_ESCAPE) are reported on every run that covers their show. */
  const quarantined = (listing.quarantined ?? []).filter((q) => show === null || shows.has(q.show_id)).map((q) => ({ show_id: q.show_id, key: q.origin.key, reason: q.reason }));
  const result = {
    shows_listed: shows.size,
    rebuilt: [],
    unchanged: full ? 0 : delta.unchanged.length,
    gone: delta.gone,
    bodies: 0,
    bodies_planned: bodiesPlanned,
    body_bytes: 0,
    need_bytes: needBytes,
    quarantined,
    carried_quarantine: 0,
    indexer_problems: [],
    cue_cache: null,
    unmapped_dirs: listing.unmappedDirs ?? [],
    shadowed_dirs: listing.shadowedDirs ?? [],
    exitCode: 0,
  };
  if (!full) {
    for (const showId of delta.unchanged) result.carried_quarantine += (manifest.quarantine.get(showId) ?? []).length;
  }

  if (rebuild.length > 0) {
    const ix = indexer({ indexRoot, stagedOut, passagesOut });
    const cache = cueCache ? new CueCache(cueCache, cueCacheCapBytes) : null;
    const indexedAt = now().toISOString();
    let failure = null;
    try {
      for (const showId of rebuild) {
        const episodeRows = [];
        const quarantineRows = [];
        for (const entry of shows.get(showId)) {
          const item = await read(entry);
          if (item.kind === "quarantine") {
            result.quarantined.push({ show_id: showId, key: item.origin.key, reason: item.reason });
            log(`stream-index: quarantined ${item.origin.key} (${item.reason})`);
            if (item.persist) quarantineRows.push(quarantineRow(item, indexedAt));
            continue;
          }
          await ix.send({ kind: "body", show_id: showId, fileName: item.fileName, stat: item.stat, body: item.body });
          if (cache) cache.put(item.dir, item.fileName, item.bytes);
          episodeRows.push(manifestRow(item, indexedAt));
          result.bodies += 1;
          result.body_bytes += item.bytes.length;
        }
        await ix.endShow(showId);
        replaceShow(manifest, showId, episodeRows, quarantineRows);
        writeManifest(manifestDir, manifest);
        result.rebuilt.push(showId);
      }
    } catch (e) {
      failure = e;
    }
    const closed = await ix.close();
    result.indexer_problems = closed.problems ?? [];
    if (cache) result.cue_cache = { dir: cueCache, bytes: cache.bytes, files: cache.entries.size, evicted: cache.evicted };
    if (failure) throw failure;
    if (closed.exitCode !== 0 || result.indexer_problems.length > 0) result.exitCode = 1;
  }

  log(
    `stream-index: listed=${result.shows_listed} rebuilt=${result.rebuilt.length} unchanged=${result.unchanged} ` +
      `bodies=${result.bodies} quarantined=${result.quarantined.length} carried_quarantine=${result.carried_quarantine} ` +
      `gone=${result.gone.length} unmapped_dirs=${result.unmapped_dirs.length}`
  );
  return result;
}

/* ----------------------------------------------------------------- CLI */

function readDataJson(name) {
  const path = join(REPO_ROOT, "data", name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export async function main(argv) {
  const args = parseStreamArgs(argv);
  let list;
  let read;
  if (args.source === "local") {
    list = async () => listLocal(args.normalizedRoot);
    read = async (entry) => readLocal(entry);
  } else {
    const creds = await loadR2Credentials();
    const client = await createR2Client(creds);
    const { map, collisions } = buildShowMap({
      queue: readDataJson("transcription-queue.json"),
      catalog: readDataJson("catalog.json"),
      breadth: readDataJson("breadth-transcript-yield.json"),
    });
    if (collisions.length > 0) console.error(`stream-index: ${collisions.length} show-map collision(s); first writer kept`);
    list = () => listR2Normalized({ client, bucket: creds.bucket, showMap: map });
    read = (entry) => readR2(entry, { client, bucket: creds.bucket });
  }
  return streamIndex({
    list,
    read,
    manifestDir: args.manifestDir,
    indexRoot: args.indexRoot,
    stagedOut: args.stagedOut,
    passagesOut: args.passagesOut,
    cueCache: args.cueCache,
    cueCacheGb: args.cueCacheGb,
    full: args.full,
    show: args.show,
    minFreeGb: args.minFreeGb,
  });
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((e) => {
      console.error("FATAL:", e?.message ?? e);
      process.exit(e?.code === "DISK_SPACE" ? DISK_SPACE_EXIT_CODE : 1);
    });
}
