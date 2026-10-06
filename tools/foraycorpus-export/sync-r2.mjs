#!/usr/bin/env node
/* Mirror the R2 transcript bucket into data-local/transcripts/ (PKG-13, G-11;
   docs/roadmap/corpus.md §3 "PKG-13 · sync-r2.mjs").

   The transcript farm writes `foray-transcriptions` in foray's own layout:

     transcripts/normalized/<safeKey(farm show_id)>/<safeKey(guid)>.json
     transcripts/raw/<safeKey(farm show_id)>/<safeKey(guid)>.vtt

   The farm's show_id is NOT foray's (it is String(podcastindex_feed_id) or a
   title slug), so each R2 directory goes through show-map.mjs
   resolveShowDir and lands under localDirFor(show_id) = safeKey(show_id), the
   directory tools/segments/fetch-transcripts.mjs transcriptPath writes and
   backend transcriptArchiveLookup.ts showDir finds. An unmapped directory
   keeps its R2 name and is listed in the state file's `unmapped_dirs`.

   What is a body. Exactly `transcripts/<kind>/<dir>/<file>`, four segments,
   kind `normalized` (file ends `.json`) or, with --raw, `raw`. Everything else
   the listing returns is counted `ignored` and never fetched: the 7,531
   legacy whisper JSONs at the bucket ROOT (`<show-slug>/<title-slug>-<10
   hex>.json`, not foray layout), anything under `fingerprints/`, directory
   placeholders and keys of any other depth. The key is parsed defensively
   even though the listing is prefix-scoped.

   File names stay the R2 names. transcriptPath is NOT called: it re-applies
   safeKey and would rename the file. Its `startsWith(base + sep)` guard is
   copied instead, with base = <out>/<kind>, so a key like
   `transcripts/normalized/../x.json` cannot write beside the kind
   directory; a key that fails it is quarantined PATH_ESCAPE. The backend's
   locateUncached finds a body by exact `corpusSafeKey(guid).json`, then slug
   prefix, then the body's own `guid`, so R2 names are fine as they are.

   Per object:
   1. Local file exists: if its size differs from the listed size it changed.
      If the size matches, a HEAD fetches the farm's `sha256` user metadata
      (ListObjectsV2 carries no user metadata) and an equal sha256 of the
      local bytes is `skipped_same`; with no metadata, the equal size is.
      Modification times are never compared.
   2. Otherwise GET (r2-client.mjs getObject). A metadata sha256 that does
      not match the bytes quarantines SHA_MISMATCH and nothing is written.
   3. Normalized bodies are parsed and validated: `show_id` and `guid`
      strings, `cues` an array whose every cue has numeric `start_sec` /
      `end_sec` and string `text`, `transcript_source` absent, null or in
      TRANSCRIPT_SOURCES (imported from tools/segments/merge-segments.mjs,
      THE ONE LIST; never copied). A failure quarantines BAD_JSON or
      BAD_SHAPE:<field>. Raw objects are not parsed.
   4. The fetched bytes are written byte-identical through a tmp file and a
      rename, never re-serialized, so `show_id` inside a body is never
      rewritten. A quarantined object leaves any existing local file alone.

   Nothing local is ever deleted: a body that disappeared from R2 stays on
   disk and is still counted in its directory's `bodies`.

   After the walk the state file (config.mjs SYNC_STATE_FILE, i.e.
   `<out>/r2-sync-state.json`) is written:
   {version:1, synced_at, bucket, prefix, objects_seen, ignored, written,
    skipped_same, quarantined:[{key, reason}], unmapped_dirs:[{dir, objects}],
    shows:{[localDir]: {show_id, via, bodies}}, bodies_expected}
   `bodies` counts the normalized bodies on disk in that directory after the
   run (including ones R2 no longer has); `bodies_expected` is their sum, the
   number PKG-23's run-start guard checks. `shows` lists the directories this
   run touched; an unmapped one has show_id null and via "unmapped". A run
   narrowed by --show or --limit writes a state covering what it saw.

   --dry-run lists, HEADs and GETs as usual (so quarantines are reported),
   writes no body and no state file, and prints the state it would have
   written followed by the summary line. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { TRANSCRIPT_SOURCES } from "../segments/merge-segments.mjs";
import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";
import { NORMALIZED_PREFIX, RAW_PREFIX, ROOT, SYNC_STATE_FILE, TRANSCRIPTS_DIR } from "./config.mjs";
import { createR2Client, getObject, listPrefix, loadR2Credentials, sha256 } from "./r2-client.mjs";
import { buildShowMap, localDirFor, resolveShowDir } from "./show-map.mjs";

export const STATE_FILE_NAME = basename(SYNC_STATE_FILE);
export const USAGE =
  "node tools/foraycorpus-export/sync-r2.mjs [--out <dir>] [--raw] [--dry-run] [--prefix <prefix>] [--limit <n>] [--show <dir|show_id>]";

const KINDS = Object.freeze({ normalized: "normalized", raw: "raw" });

export class SyncError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SyncError";
    this.code = code;
  }
}

/**
 * `{out, raw, dryRun, prefix, limit, showFilter}` from argv. An unknown flag,
 * a flag missing its value or a non-positive --limit throws SyncError.
 */
export function parseSyncArgs(argv) {
  const args = { out: TRANSCRIPTS_DIR, raw: false, dryRun: false, prefix: NORMALIZED_PREFIX, limit: Infinity, showFilter: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--raw") {
      args.raw = true;
      continue;
    }
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) throw new SyncError("MISSING_VALUE", `${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === "--out") args.out = needsValue();
    else if (flag === "--prefix") args.prefix = needsValue();
    else if (flag === "--show") args.showFilter = needsValue();
    else if (flag === "--limit") {
      const n = Number(needsValue());
      if (!Number.isInteger(n) || n <= 0) throw new SyncError("BAD_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(value)}`);
      args.limit = n;
    } else throw new SyncError("UNKNOWN_FLAG", `${JSON.stringify(flag)}; usage: ${USAGE}`);
  }
  return args;
}

/** Splits an R2 key into {kind, dir, file}, or null when it is not a body
    in foray layout (the caller counts it `ignored`). */
export function parseBodyKey(key, { raw = false } = {}) {
  if (typeof key !== "string") return null;
  const parts = key.split("/");
  if (parts.length !== 4 || parts[0] !== "transcripts") return null;
  const [, kind, dir, file] = parts;
  if (kind !== KINDS.normalized && !(raw && kind === KINDS.raw)) return null;
  if (dir === "" || file === "") return null;
  if (kind === KINDS.normalized && !file.endsWith(".json")) return null;
  return { kind, dir, file };
}

/** The local path for a body, refused when it resolves outside
    <out>/<kind> (transcriptPath's guard, fetch-transcripts.mjs). */
export function bodyPath(out, kind, localDir, file) {
  const base = resolvePath(out, kind);
  const full = resolvePath(base, localDir, file);
  const dotted = [localDir, file].some((s) => s === "." || s === "..");
  if (dotted || full === base || !full.startsWith(base + sep)) {
    throw new SyncError("PATH_ESCAPE", `refusing to write outside ${base}: ${full}`);
  }
  return full;
}

/** null when the parsed body is in shape, else the first bad field. */
export function bodyShapeError(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body";
  if (typeof body.show_id !== "string") return "show_id";
  if (typeof body.guid !== "string") return "guid";
  if (!Array.isArray(body.cues)) return "cues";
  for (let i = 0; i < body.cues.length; i += 1) {
    const cue = body.cues[i];
    if (cue === null || typeof cue !== "object") return `cues[${i}]`;
    if (typeof cue.start_sec !== "number" || !Number.isFinite(cue.start_sec)) return `cues[${i}].start_sec`;
    if (typeof cue.end_sec !== "number" || !Number.isFinite(cue.end_sec)) return `cues[${i}].end_sec`;
    if (typeof cue.text !== "string") return `cues[${i}].text`;
  }
  if (body.transcript_source !== undefined && body.transcript_source !== null && !TRANSCRIPT_SOURCES.has(body.transcript_source)) {
    return "transcript_source";
  }
  return null;
}

/** The farm's `sha256` user metadata via HEAD, or null when absent. */
async function headSha256(client, bucket, key, HeadObjectCommand) {
  const Command = HeadObjectCommand ?? (await import("@aws-sdk/client-s3")).HeadObjectCommand;
  const res = await client.send(new Command({ Bucket: bucket, Key: key }));
  const metadata = res?.Metadata ?? {};
  return metadata["sha256"] ?? metadata["x-amz-meta-sha256"] ?? null;
}

/** Writes bytes unchanged: tmp file in the same directory, then rename. */
function writeBytesAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Normalized bodies on disk in one local directory (tmp files excluded). */
function bodiesOnDisk(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath).filter((f) => f.endsWith(".json") && !f.startsWith("."));
}

const listingPrefix = (p) => (p.endsWith("/") ? p : `${p}/`);

/**
 * @returns {Promise<{state: object, summary: string}>}
 */
export async function syncR2({
  client,
  bucket,
  out = TRANSCRIPTS_DIR,
  raw = false,
  dryRun = false,
  prefix = NORMALIZED_PREFIX,
  limit = Infinity,
  showFilter = null,
  showMap = new Map(),
  now = () => new Date(),
  commands = {},
  log = (line) => console.log(line),
} = {}) {
  const prefixes = [listingPrefix(prefix)];
  if (raw && !prefixes[0].startsWith(listingPrefix(RAW_PREFIX))) prefixes.push(listingPrefix(RAW_PREFIX));

  const counts = { objects_seen: 0, ignored: 0, written: 0, skipped_same: 0 };
  const quarantined = [];
  const unmapped = new Map(); // r2 dir -> objects
  const shows = new Map(); // localDir -> {show_id, via}
  const wouldWrite = new Map(); // localDir -> Set(file), dry run only
  let candidates = 0;

  walk: for (const listed of prefixes) {
    for await (const obj of listPrefix(client, bucket, listed, { ListObjectsV2Command: commands.ListObjectsV2Command })) {
      counts.objects_seen += 1;
      const parsed = obj.key?.startsWith(listed) ? parseBodyKey(obj.key, { raw }) : null;
      if (!parsed) {
        counts.ignored += 1;
        continue;
      }
      const mapped = resolveShowDir(showMap, parsed.dir);
      const localDir = mapped ? localDirFor(mapped.show_id) : parsed.dir;
      if (showFilter !== null && showFilter !== parsed.dir && showFilter !== localDir && showFilter !== mapped?.show_id) continue;
      if (candidates >= limit) break walk;
      candidates += 1;

      let localPath;
      try {
        localPath = bodyPath(out, parsed.kind, localDir, parsed.file);
      } catch (e) {
        if (e.code !== "PATH_ESCAPE") throw e;
        quarantined.push({ key: obj.key, reason: "PATH_ESCAPE" });
        continue;
      }
      if (!mapped) unmapped.set(parsed.dir, (unmapped.get(parsed.dir) ?? 0) + 1);
      if (parsed.kind === KINDS.normalized && !shows.has(localDir)) {
        shows.set(localDir, mapped ? { show_id: mapped.show_id, via: mapped.via } : { show_id: null, via: "unmapped" });
      }

      if (existsSync(localPath)) {
        const localSize = statSync(localPath).size;
        if (typeof obj.size !== "number" || localSize === obj.size) {
          const meta = await headSha256(client, bucket, obj.key, commands.HeadObjectCommand);
          const same = meta ? sha256(readFileSync(localPath)) === String(meta).toLowerCase() : localSize === obj.size;
          if (same) {
            counts.skipped_same += 1;
            continue;
          }
        }
      }

      const got = await getObject(client, bucket, obj.key, { GetObjectCommand: commands.GetObjectCommand });
      if (got.sha256Meta && sha256(got.body) !== String(got.sha256Meta).toLowerCase()) {
        quarantined.push({ key: obj.key, reason: "SHA_MISMATCH" });
        continue;
      }
      if (parsed.kind === KINDS.normalized) {
        let body;
        try {
          body = JSON.parse(got.body.toString("utf8"));
        } catch {
          quarantined.push({ key: obj.key, reason: "BAD_JSON" });
          continue;
        }
        const bad = bodyShapeError(body);
        if (bad) {
          quarantined.push({ key: obj.key, reason: `BAD_SHAPE:${bad}` });
          continue;
        }
      }
      if (dryRun) {
        if (parsed.kind === KINDS.normalized) {
          if (!wouldWrite.has(localDir)) wouldWrite.set(localDir, new Set());
          wouldWrite.get(localDir).add(parsed.file);
        }
      } else {
        writeBytesAtomic(localPath, got.body);
      }
      counts.written += 1;
    }
  }

  const showsOut = {};
  let bodiesExpected = 0;
  for (const localDir of [...shows.keys()].sort()) {
    const files = new Set(bodiesOnDisk(join(resolvePath(out, KINDS.normalized), localDir)));
    for (const f of wouldWrite.get(localDir) ?? []) files.add(f);
    showsOut[localDir] = { ...shows.get(localDir), bodies: files.size };
    bodiesExpected += files.size;
  }

  const state = {
    version: 1,
    synced_at: now().toISOString(),
    bucket,
    prefix,
    ...counts,
    quarantined,
    unmapped_dirs: [...unmapped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([dir, objects]) => ({ dir, objects })),
    shows: showsOut,
    bodies_expected: bodiesExpected,
  };

  const summary =
    `sync-r2: seen=${state.objects_seen} ignored=${state.ignored} written=${state.written} ` +
    `skipped_same=${state.skipped_same} quarantined=${quarantined.length} unmapped_dirs=${state.unmapped_dirs.length} ` +
    `bodies_expected=${bodiesExpected}${dryRun ? " (dry run, nothing written)" : ""}`;
  if (dryRun) {
    log(JSON.stringify(state, null, 2));
  } else {
    writeJsonAtomic(join(out, STATE_FILE_NAME), state);
  }
  log(summary);
  return { state, summary };
}

/** Reads one data/ file, or null when it is absent (the map then has fewer
    entries and those directories are reported unmapped). */
function readDataJson(name) {
  const path = join(ROOT, "data", name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/**
 * The CLI run: parse argv, read credentials, build the show map from data/,
 * sync. Returns syncR2's `{state, summary}`. Exported so rebuild-index.mjs
 * (PKG-14) syncs in its own process and warms from the returned state.
 */
export async function runSync(argv) {
  const args = parseSyncArgs(argv);
  const creds = await loadR2Credentials();
  const client = await createR2Client(creds);
  const { map, collisions } = buildShowMap({
    queue: readDataJson("transcription-queue.json"),
    catalog: readDataJson("catalog.json"),
    breadth: readDataJson("breadth-transcript-yield.json"),
  });
  if (collisions.length > 0) console.error(`sync-r2: ${collisions.length} show-map collision(s); first writer kept`);
  return syncR2({ ...args, client, bucket: creds.bucket, showMap: map });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSync(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
