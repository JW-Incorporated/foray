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
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  BUILD_OUT_DIR, DOWNLOAD_DIR, DUMP_UA, DUMP_URL,
  MAX_SHARD_GZ_P95_BYTES, MAX_TOP_JSON_BYTES, POINTER_PATH,
  STATE_DIR, STATE_PATH, TOP_N_BY_POPULARITY,
  MAX_NEWEST_SNAPSHOT_BYTES, NEWEST_SNAPSHOT_ASSET, NEWEST_SNAPSHOT_FETCH_TIMEOUT_MS,
  NEWEST_SNAPSHOT_VERSION,
  ImportError, checkMissingMapping, checksumFile, loadCuratedShows,
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

/* ImportError lives in config.mjs (CH2-12) so the shared guards can throw
   it; re-exported here because this module is where callers have always
   found it. */
export { ImportError };

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
export function runPipeline(db, { curatedShows, previousNewest = null, now = Date.now() } = {}) {
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

/* ---------------------------------------------------- baseline (#1033) -- */

/** The per-pi_id `newest_item_at` snapshot this build publishes as
    NEWEST_SNAPSHOT_ASSET, so the NEXT weekly run has a baseline to diff
    against. Same shape `buildChanged` takes as `previousNewest` (and the
    same one load-postgres.mjs's `fetchPreviousNewest` builds from
    Postgres): `{ "<pi_id>": epoch seconds }`.

    EVERY canonical id is listed, including a row with no newest-item date,
    which is stored as 0. `buildChanged` reads an absent id (and a null
    value) as "new since last release", so leaving dateless rows out would
    report them as changed every single week; 0 keeps them unchanged until
    they gain a real date, which then counts as an advance. Integer-like
    object keys serialise in ascending numeric order, so the bytes are
    deterministic for a given set of rows. */
export function buildNewestSnapshot(canonicalRows, { exportVersion }) {
  const newest = {};
  for (const row of canonicalRows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    const t = Number(row.newestItemPubdate);
    newest[String(id)] = Number.isFinite(t) && t > 0 ? t : 0;
  }
  return {
    version: NEWEST_SNAPSHOT_VERSION,
    export_version: exportVersion ?? null,
    count: Object.keys(newest).length,
    newest,
  };
}

/** Reads a downloaded snapshot asset back into `previousNewest`. Returns
    `{ ok: true, previousNewest, count, exportVersion }` or `{ ok: false,
    reason }`; never throws.

    AN EMPTY OR MALFORMED SNAPSHOT IS NO BASELINE, NEVER `{}`. `{}` is the
    exact value audit round 3 (data-tools-14) removed: `buildChanged` diffs
    against it and lists every show as changed, labelled as a real index
    (shard-build.test.mjs pins the `null` half). So a snapshot with zero ids,
    a non-numeric value, a wrong schema version, or an export_version that
    does not match the pointer it was found through is rejected here, and
    the caller keeps `baseline: false`. */
export function parseNewestSnapshot(gz, { expectedExportVersion = null, maxBytes = MAX_NEWEST_SNAPSHOT_BYTES } = {}) {
  let doc;
  try {
    doc = JSON.parse(gunzipSync(gz, { maxOutputLength: maxBytes }).toString("utf8"));
  } catch (e) {
    return { ok: false, reason: `snapshot did not gunzip and parse: ${e.message}` };
  }
  if (!doc || typeof doc !== "object" || doc.version !== NEWEST_SNAPSHOT_VERSION) {
    return { ok: false, reason: `snapshot schema version ${JSON.stringify(doc?.version)} is not ${NEWEST_SNAPSHOT_VERSION}` };
  }
  if (expectedExportVersion != null && doc.export_version !== expectedExportVersion) {
    return {
      ok: false,
      reason: `snapshot export_version ${JSON.stringify(doc.export_version)} does not match the pointer's ${JSON.stringify(expectedExportVersion)}`,
    };
  }
  const newest = doc.newest;
  if (!newest || typeof newest !== "object" || Array.isArray(newest)) {
    return { ok: false, reason: "snapshot carries no `newest` map" };
  }
  let count = 0;
  for (const key of Object.keys(newest)) {
    const v = newest[key];
    if (!/^\d+$/.test(key) || typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, reason: `snapshot entry ${JSON.stringify(key)}: ${JSON.stringify(v)} is not a pi_id -> epoch-seconds pair` };
    }
    count++;
  }
  if (count === 0) {
    return { ok: false, reason: "snapshot lists no ids (an empty baseline would mark every show changed)" };
  }
  return { ok: true, previousNewest: newest, count, exportVersion: doc.export_version };
}

/** Downloads the PREVIOUS release's snapshot through the committed pointer
    (data/shows-index-pointer.json's `asset_base_url`; run-and-publish.mjs
    only rewrites the pointer AFTER this build, so what is on disk here is
    the last release's). Public release-asset URL, fetched with no token and
    no Authorization header.

    NEVER FAILS THE RUN. A missing pointer, a 404 (every release before
    #1033 has no snapshot asset), a network error, a timeout or a bad
    snapshot all return `{ previousNewest: null, reason }`: the build goes
    on, changed.json says `{ baseline: false }` (consumers read that as
    "index unavailable" and fall back to a full scan), and the reason is
    logged. Never `{}` -- see parseNewestSnapshot. */
export async function loadPreviousNewest({
  pointerPath = POINTER_PATH, fetchImpl = fetch, timeoutMs = NEWEST_SNAPSHOT_FETCH_TIMEOUT_MS,
} = {}) {
  const none = (reason, url = null) => ({ previousNewest: null, reason, url, count: 0, exportVersion: null });
  try {
    let pointer;
    try {
      pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    } catch (e) {
      return none(`no readable pointer at ${pointerPath} (${e.code || e.message})`);
    }
    const base = pointer?.asset_base_url;
    if (typeof base !== "string" || !/^https:\/\//.test(base)) {
      return none("the pointer has no https asset_base_url");
    }
    const url = `${base.replace(/\/+$/, "")}/${NEWEST_SNAPSHOT_ASSET}`;
    let res;
    try {
      res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return none(`download failed: ${e.message}`, url);
    }
    if (!res.ok) {
      const why = res.status === 404 ? " (that release predates the snapshot asset, #1033)" : "";
      return none(`download returned HTTP ${res.status}${why}`, url);
    }
    let body;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return none(`reading the download failed: ${e.message}`, url);
    }
    const parsed = parseNewestSnapshot(body, { expectedExportVersion: pointer.export_version ?? null });
    if (!parsed.ok) return none(parsed.reason, url);
    return { previousNewest: parsed.previousNewest, reason: null, url, count: parsed.count, exportVersion: parsed.exportVersion };
  } catch (e) {
    return none(`unexpected error loading the baseline: ${e?.message ?? e}`);
  }
}

/** `runPipeline` with the prior-release baseline wired in: what `main()`
    runs. Split out so the tests drive the real wiring (pointer -> download
    -> parse -> buildChanged) instead of a copy of it. */
export async function runPipelineWithBaseline(db, { curatedShows, now, log = console.log, ...loadOpts } = {}) {
  const baseline = await loadPreviousNewest(loadOpts);
  if (baseline.previousNewest) {
    log(`BASELINE: ${baseline.count} ids from ${baseline.url} (export_version ${baseline.exportVersion})`);
  } else {
    log(`NO_BASELINE: ${baseline.reason} -- changed.json will say { baseline: false } (index unavailable, not a failure)`);
  }
  const result = runPipeline(db, { curatedShows, previousNewest: baseline.previousNewest, now });
  return { result, baseline };
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
  // Fails closed over the unmapped ceiling; under it, publishes but names
  // them (config.mjs's checkMissingMapping, shared with load-postgres.mjs).
  const { curatedTotal } = checkMissingMapping(result);

  /* ---- checks: compute everything, write nothing yet ---- */
  const shardEntries = [];
  const shardSizes = [];
  for (const [key, rows] of result.shards) {
    const gz = await gzipJson(rows);
    shardSizes.push(gz.length);
    // gzBytes is captured on the SAME entry as gz itself (not read back out
    // of the sibling shardSizes array by position) so shard_inventory below
    // can never desync from shardEntries even if either array's
    // construction changes later — a fresh-context review flagged the
    // positional-index version of this as an unverified alignment
    // assumption, so this stores the size directly.
    shardEntries.push([key, gz, gz.length]);
  }
  const shardP95 = p95(shardSizes);
  if (shardP95 > MAX_SHARD_GZ_P95_BYTES) {
    throw new ImportError("SHARD_TOO_LARGE", `p95 shard size ${shardP95}B exceeds budget ${MAX_SHARD_GZ_P95_BYTES}B`, { shardP95 });
  }

  const topJson = JSON.stringify(result.top);
  if (Buffer.byteLength(topJson) > MAX_TOP_JSON_BYTES) {
    throw new ImportError("TOP_TOO_LARGE", `top.json ${Buffer.byteLength(topJson)}B exceeds budget ${MAX_TOP_JSON_BYTES}B`);
  }

  /* #1033: the next run's changed.json baseline, published with this release. */
  const snapshot = buildNewestSnapshot(result.canonical, { exportVersion });
  const snapshotGz = await gzipJson(snapshot);

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
    /* Per Fable ruling FR-t_30a53ba2-1: shard files are built and size-
       validated (the SHARD_TOO_LARGE check above still runs against
       every one of them) but are NOT uploaded as release assets —
       GitHub Releases hard-caps a single release at 1,000 assets and
       the real build's ~1,298 shards put a release well over that
       ceiling, with no batching workaround (the limit is per-release,
       not per-API-call). `shards_published: false` is explicit so no
       future reader of this manifest mistakes it for a promise that
       `<asset_base_url>/shards/<key>.json.gz` exists — it does not, for
       any release this pipeline has produced so far. `shard_inventory`
       lists every shard key this build produced (with its row count and
       gzip size) so a follow-up card designing the real shard-publishing
       shape (multi-release layout, coarser bucketing, etc., decided
       together with whichever client ends up reading it) has the exact
       real numbers without re-running the build. */
    /* #1033: the asset the NEXT weekly run downloads as changed.json's
       baseline (see loadPreviousNewest). */
    newest_snapshot: { asset: NEWEST_SNAPSHOT_ASSET, count: snapshot.count, gz_bytes: snapshotGz.length },
    shards_published: false,
    shard_inventory: shardEntries
      .map(([key, , gzBytes]) => ({ key, row_count: result.shards.get(key).length, gz_bytes: gzBytes }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
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
  await writeFile(join(outDir, NEWEST_SNAPSHOT_ASSET), snapshotGz);
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ---------------------------------------------------------------- main -- */

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
    // file directly, skipping fetch+extract entirely. Streamed checksum
    // (config.mjs's checksumFile): the real db is over readFile's 2GiB cap.
    dbPath = dumpFileArg;
    checksum = await checksumFile(dumpFileArg);
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
    /* #1033: the previous release's per-id snapshot, downloaded through the
       committed pointer, is changed.json's baseline. Any failure to get it
       leaves `previousNewest` null, so changed.json says
       { baseline:false, changed:null } (audit round 3, data-tools-14)
       rather than failing the run or listing every show as changed. */
    const { result } = await runPipelineWithBaseline(db, { curatedShows });
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
