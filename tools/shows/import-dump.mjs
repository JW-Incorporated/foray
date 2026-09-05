#!/usr/bin/env node
/* tools/shows/import-dump.mjs — S-04a: fetch the PodcastIndex dump, filter
   (D1), dedupe (D13), build the static shard index (§3.2 of
   4a-shows-pipeline-plan.md). Offline builder only — no GitHub Release, no
   PR, no workflow file (that is S-04b).

   Pipeline stages live in sibling modules so each is independently
   fixture-testable without the real 1.8 GB dump:
     config.mjs       — every constant this file would otherwise inline
     dump-reader.mjs   — node:sqlite streaming row generator
     filter.mjs        — D1
     dedupe.mjs        — D13
     shard-build.mjs   — manifest/shards/top/changed/id-map shapes
     identity.mjs      — feed-url normalisation shared by id-map + D2
     state.mjs         — idempotent skip-if-already-built

   Usage:
     node tools/shows/import-dump.mjs [--dump-file PATH] [--skip-fetch]
     node tools/shows/import-dump.mjs --dry-run   # fetch + report, no write

   --dump-file lets a fixture (or a hand-downloaded dump) stand in for the
   network fetch; the tests never invoke this file's `main`, they import
   the pipeline functions directly, so this flag exists purely for a human
   or a CI job re-running against a real dump. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  BUILD_OUT_DIR, CATALOG_PATH, DOWNLOAD_DIR, DUMP_UA, DUMP_URL,
  MAX_SHARD_GZ_P95_BYTES, MAX_TOP_JSON_BYTES, POINTER_PATH,
  STATE_DIR, STATE_PATH, TOP_N_BY_POPULARITY,
  MAX_UNMAPPED_CURATED_FRACTION,
} from "./config.mjs";
import { applyD1Filter } from "./filter.mjs";
import { curatedKeys } from "./identity.mjs";
import { applyD13Dedupe } from "./dedupe.mjs";
import {
  buildChanged, buildIdMap, buildShards, buildTop,
} from "./shard-build.mjs";
import { alreadyBuilt, nextState } from "./state.mjs";
import { countPodcasts, streamPodcasts } from "./dump-reader.mjs";

const execFileP = promisify(execFile);

export class ImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------- fetch ---- */

/** Downloads the dump archive with the identifying User-Agent, streaming to
    disk. Returns the checksum (sha256) and the `Last-Modified` header
    verbatim as `exportVersion`. Throws ImportError('BAD_RESPONSE', …) on a
    non-200/206 or a body that doesn't look like gzip — the card's own
    "default UA -> 403 with a 179-byte non-gzip body" trap, made loud
    instead of silently writing garbage to disk. */
export async function fetchDump({ url = DUMP_URL, userAgent = DUMP_UA, destPath, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { "User-Agent": userAgent } });
  if (!res.ok) {
    throw new ImportError("BAD_RESPONSE", `dump fetch failed: ${res.status} ${res.statusText}`, { status: res.status });
  }
  const exportVersion = res.headers.get("last-modified");
  if (!exportVersion) {
    throw new ImportError("NO_LAST_MODIFIED", "dump response carried no Last-Modified header; cannot compute export_version");
  }

  await mkdir(dirname(destPath), { recursive: true });
  const hash = createHash("sha256");
  const tmpPath = `${destPath}.part`;
  const fileStream = createWriteStream(tmpPath);
  const body = res.body;
  if (!body) throw new ImportError("EMPTY_BODY", "dump response had no body");

  let magicBytes = Buffer.alloc(0);
  const hashing = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      if (magicBytes.length < 2) magicBytes = Buffer.concat([magicBytes, chunk]).subarray(0, 4);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(body, hashing, fileStream);

  // gzip magic number is 0x1f 0x8b — the 403 trap's body is plain text.
  // Accumulated across chunks (not just the first) so a stream whose first
  // TCP segment happens to be a single byte doesn't false-positive NOT_GZIP.
  if (magicBytes.length < 2 || magicBytes[0] !== 0x1f || magicBytes[1] !== 0x8b) {
    await rm(tmpPath, { force: true });
    throw new ImportError(
      "NOT_GZIP",
      "downloaded body is not gzip — likely the default-User-Agent 403 trap (docs/curation/catalogue-broadening.md)",
    );
  }

  await rename(tmpPath, destPath);
  return { checksum: hash.digest("hex"), exportVersion };
}

/** Extracts the archive's single sqlite db. Shells out to `tar` rather than
    a JS gunzip+untar pair — the dump is a plain .tgz with one file inside,
    and the repo already treats `tar` as an acceptable dependency-free tool
    (see tools/corpus's fetcher notes on similar tradeoffs). */
export async function extractDump({ archivePath, outDir }) {
  await mkdir(outDir, { recursive: true });
  await execFileP("tar", ["-xzf", archivePath, "-C", outDir]);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(outDir);
  const dbFile = entries.find((f) => f.endsWith(".db"));
  if (!dbFile) throw new ImportError("NO_DB_IN_ARCHIVE", `no .db file found in ${outDir} after extraction`, { entries });
  return join(outDir, dbFile);
}

/* -------------------------------------------------------------- build --- */

/** The whole filter -> dedupe -> shard-build pipeline over an already-open
    DatabaseSync (or any object exposing `.prepare`), plus the curated
    catalogue. Pure aside from reading `db` via the streaming generator;
    used by both `main()` and the unit tests (tests pass an in-memory
    DatabaseSync built from fixtures). */
export function runPipeline(db, { curatedShows, previousNewest = {}, now = Date.now() } = {}) {
  const totalRows = countPodcasts(db);
  /* Curated shows are exempt from D1 — see identity.mjs's `curatedKeys`. Built
     once, before the stream, because the filter runs per row over 4.7M of
     them. */
  const curated = curatedKeys(curatedShows);
  const { kept, counts: d1Counts } = applyD1Filter(streamPodcasts(db), { now, curatedKeys: curated });
  const { canonical, counts: d13Counts } = applyD13Dedupe(kept, { curatedKeys: curated });

  const { idMap, missing } = buildIdMap(canonical, curatedShows);
  const curatedIds = new Set(Object.values(idMap));

  const shards = buildShards(canonical, curatedIds);
  const top = buildTop(canonical, curatedIds, TOP_N_BY_POPULARITY);
  const changed = buildChanged(canonical, previousNewest);

  return {
    totalRows,
    curatedTotal: curatedShows.length,
    d1Counts,
    d13Counts,
    canonical,
    shards,
    top,
    changed,
    idMap,
    missing,
  };
}

/** gzips one shard's JSON array; returns the compressed Buffer so the
    caller can measure its size before deciding to write it (p95 budget
    enforcement happens on the measured bytes, not an estimate). */
export async function gzipJson(value) {
  const { gzipSync } = await import("node:zlib");
  return gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 });
}

export function p95(sizes) {
  if (!sizes.length) return 0;
  const sorted = [...sizes].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

/* --------------------------------------------------------------- write -- */

/** Every fail-closed / budget check MUST run before the first byte is
    written to `outDir` (review finding, 2026-09-05: an earlier version
    wrote shards + top.json before reaching the id-map check, leaving a
    directory full of partial output on the exact failure path this
    function exists to prevent). Everything below the "checks" section
    is therefore computed into memory first; writes only start once every
    check has passed. */
export async function writeBuildOutput(result, { outDir = BUILD_OUT_DIR, exportVersion, builtAt = new Date().toISOString() } = {}) {
  const curatedTotal = result.curatedTotal || (result.missing.length + Object.keys(result.idMap).length);
  const unmappedFraction = curatedTotal > 0 ? result.missing.length / curatedTotal : 0;
  if (unmappedFraction > MAX_UNMAPPED_CURATED_FRACTION) {
    throw new ImportError(
      "ID_MAP_INCOMPLETE",
      `${result.missing.length} of ${curatedTotal} curated show(s) did not resolve to a dump row ` +
        `(${(unmappedFraction * 100).toFixed(1)}%, over the ${(MAX_UNMAPPED_CURATED_FRACTION * 100).toFixed(0)}% ceiling — ` +
        `that is the join breaking, not the index being incomplete): ` +
        result.missing.map((m) => `${m.show_id} (${m.title})`).join(", "),
      { missing: result.missing, curatedTotal },
    );
  }
  if (result.missing.length > 0) {
    // Under the ceiling: publish, but name them. See config.mjs's note.
    console.warn(
      `WARN: ${result.missing.length} of ${curatedTotal} curated show(s) are not in this dump ` +
        `(under the ${(MAX_UNMAPPED_CURATED_FRACTION * 100).toFixed(0)}% ceiling, so the build continues; ` +
        `they keep working from data/catalog.json): ` +
        result.missing.map((m) => `${m.show_id} (${m.title})`).join(", "),
    );
  }

  /* ---- checks: compute everything, write nothing yet ---- */
  const shardEntries = [];
  const shardSizes = [];
  for (const [key, rows] of result.shards) {
    const gz = await gzipJson(rows);
    shardSizes.push(gz.length);
    shardEntries.push([key, gz]);
  }
  const shardP95 = p95(shardSizes);
  if (shardP95 > MAX_SHARD_GZ_P95_BYTES) {
    throw new ImportError("SHARD_TOO_LARGE", `p95 shard size ${shardP95}B exceeds budget ${MAX_SHARD_GZ_P95_BYTES}B`, { shardP95 });
  }

  const topJson = JSON.stringify(result.top);
  if (Buffer.byteLength(topJson) > MAX_TOP_JSON_BYTES) {
    throw new ImportError("TOP_TOO_LARGE", `top.json ${Buffer.byteLength(topJson)}B exceeds budget ${MAX_TOP_JSON_BYTES}B`);
  }

  const manifest = {
    export_version: exportVersion,
    built_at: builtAt,
    row_count: result.canonical.length,
    shard_count: result.shards.size,
    shard_key: "token-prefix-2",
    counts: {
      read: result.totalRows,
      in_4a: result.d1Counts.kept,
      canonical: result.canonical.length,
    },
    d1_filter_counts: result.d1Counts,
    d13_dedupe_counts: result.d13Counts,
    curated: {
      total: curatedTotal,
      mapped: Object.keys(result.idMap).length,
      /* Kept only because they are curated — they failed D1 and were exempted.
         This is the number that says whether D1's staleness rule is eating the
         catalogue, so it belongs in the published manifest, not just a log. */
      exempt_from_d1: result.d1Counts.curated_exempt || 0,
      unmapped: result.missing,
    },
    shard_size_bytes: { p95: shardP95, max: Math.max(0, ...shardSizes), count: shardSizes.length },
  };

  /* ---- writes: every check above passed; nothing left to fail on ---- */
  // Clear any shards left over from a previous build (review finding: a
  // fixed BUILD_OUT_DIR that is never cleared can leave a stale
  // shards/<pp>.json.gz on disk for a prefix that has zero rows in THIS
  // build, silently outliving the manifest that describes it).
  await rm(join(outDir, "shards"), { recursive: true, force: true });
  await mkdir(join(outDir, "shards"), { recursive: true });
  for (const [key, gz] of shardEntries) {
    await writeFile(join(outDir, "shards", `${key}.json.gz`), gz);
  }
  await writeFile(join(outDir, "top.json"), topJson);
  await writeFile(join(outDir, "id-map.json"), JSON.stringify(result.idMap, null, 2));
  await writeFile(join(outDir, "changed.json"), JSON.stringify(result.changed));
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ---------------------------------------------------------------- main -- */

async function loadCuratedShows() {
  const raw = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  if (!Array.isArray(shows)) throw new ImportError("BAD_CATALOG", `${CATALOG_PATH} did not parse to an array or {shows:[...]}`);
  return shows;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const dumpFileArg = get("--dump-file");
  const dryRun = argv.includes("--dry-run");

  const curatedShows = await loadCuratedShows();
  const prevState = await loadState();

  let checksum, exportVersion, dbPath;
  if (dumpFileArg) {
    // Fixture / manual path: caller supplies an already-extracted sqlite
    // file directly, skipping fetch+extract entirely.
    dbPath = dumpFileArg;
    const bytes = await readFile(dumpFileArg);
    checksum = createHash("sha256").update(bytes).digest("hex");
    exportVersion = get("--export-version") || `local:${checksum.slice(0, 12)}`;
  } else {
    const archivePath = join(DOWNLOAD_DIR, "podcastindex_feeds.db.tgz");
    const fetched = await fetchDump({ destPath: archivePath });
    checksum = fetched.checksum;
    exportVersion = fetched.exportVersion;
    dbPath = await extractDump({ archivePath, outDir: join(DOWNLOAD_DIR, "extracted") });
  }

  if (alreadyBuilt(prevState, { exportVersion, checksum })) {
    console.log(`SKIP: export_version ${exportVersion} (checksum ${checksum.slice(0, 12)}…) already built at ${prevState.built_at}`);
    process.exit(0);
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let manifest;
  try {
    const previousNewest = {}; // TODO(S-11 follow-up wiring): read from prior manifest's per-id snapshot once persisted; empty means "everything counts as changed" on a fresh build, which is correct for the first run.
    const result = runPipeline(db, { curatedShows, previousNewest });
    console.log(`read ${result.totalRows} rows; D1 kept ${result.d1Counts.kept}; D13 canonical ${result.canonical.length}`);
    console.log(`D1 per-filter misses: ${JSON.stringify(result.d1Counts)}`);
    console.log(`D13 dedupe: ${JSON.stringify(result.d13Counts)}`);

    if (dryRun) {
      console.log("DRY_RUN: not writing build output or state");
      if (result.missing.length) {
        console.log(`WOULD FAIL CLOSED: ${result.missing.length} curated show(s) unmapped: ${JSON.stringify(result.missing)}`);
      }
      return;
    }

    manifest = await writeBuildOutput(result, { exportVersion });
  } finally {
    db.close();
  }

  await mkdir(STATE_DIR, { recursive: true });
  const state = nextState(prevState, { exportVersion, checksum, builtAt: manifest.built_at, counts: manifest.counts });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(`BUILD_COMPLETE: ${BUILD_OUT_DIR} (export_version ${exportVersion})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e instanceof ImportError ? `${e.code}: ${e.message}` : e);
    process.exit(1);
  });
}
