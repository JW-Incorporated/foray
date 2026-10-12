/* Body sources for the stream indexer (GV-09, from W3-05;
   docs/roadmap/generation-v2.md; covers R1-09, GP-09, R2-16).

   A source answers two questions, in two phases, so the indexer can decide
   what to rebuild and check the disk BEFORE it reads a single body:

   1. LIST (no body read, no GET). listLocal / listR2Normalized return
      {shows: Map<show_id, entry[]>, ...notes}. An entry is
        {show_id, dir, fileName, size, mtimeMs, origin: {kind, key, etag?}}
      plus `path` for a local file. Shows are in sorted show_id order and a
      show's entries in sorted fileName order, so every run walks the corpus
      the same way.
   2. READ, one body at a time. readLocal / readR2 turn one entry into an item:
        {kind: "body", show_id, dir, fileName, body, bytes, stat: {size, mtimeMs},
         origin: {kind, key, sha256, etag?}}
      or, for an R2 object sync-r2 would not have mirrored,
        {kind: "quarantine", show_id, dir, fileName, size, mtimeMs, origin,
         reason, persist}
      `body` is the parsed JSON and `bytes` the exact bytes (the cue cache
      writes them unchanged). The caller drops both after sending.

   localSource / r2NormalizedSource are the two phases chained into one async
   generator that yields items grouped by show (every item of a show before
   the next show's first), which is the shape the card names.

   LOCAL. The walk is the one FileTranscriptCueProvider makes
   (backend/src/generation/transcriptArchiveLookup.ts filesIn): every
   `*.json` file of every directory under data-local/transcripts/normalized/.
   A directory's show_id is its name with the `-<10 hex>` safeKey suffix
   stripped (transcriptCorpus.ts SHOW_DIR_HASH, the rule the warmer and
   rebuild-index.mjs use). `stat` is the file's own {size, mtimeMs}, exactly
   what the provider's bodyStat returns, so a cache built from this stream is
   fresh to a local FileTranscriptTextIndex. A body that does not parse is
   still sent (as null): the provider lists it too, and the index then skips
   it the same way. Two directories that strip to one show_id keep only the
   first in sorted order (the others are reported in `shadowedDirs`).

   R2. listPrefix over transcripts/normalized/, parseBodyKey and the show map
   (resolveShowDir, localDirFor), all imported from tools/foraycorpus-export,
   never copied. An unmapped directory keeps its R2 name, as sync-r2 does, and
   is listed in `unmappedDirs`. Per object: getObject, the farm's sha256
   metadata against the bytes, JSON.parse, bodyShapeError; a failure is
   quarantined with sync-r2's reason codes (SHA_MISMATCH, BAD_JSON,
   BAD_SHAPE:<field>, PATH_ESCAPE, and getObject's TOO_LARGE / NO_BODY), so
   the stream carries exactly the bodies a sync-r2 mirror would hold. Any other
   GET failure is GET_FAILED:<name> with persist false: it is reported, never
   remembered, and the show is retried on the next run. stat.mtimeMs is
   Date.parse(LastModified). Within one show the last-listed object of a file
   name wins, which is the file a mirror would keep when two R2 directories map
   to one show.

   The AWS SDK is imported lazily by r2-client.mjs; tests inject the command
   classes and a fake client, so this module loads without node_modules. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NORMALIZED_PREFIX } from "../foraycorpus-export/config.mjs";
import { getObject, listPrefix, sha256 } from "../foraycorpus-export/r2-client.mjs";
import { localDirFor, resolveShowDir } from "../foraycorpus-export/show-map.mjs";
import { bodyShapeError, parseBodyKey } from "../foraycorpus-export/sync-r2.mjs";

/** The `-<10 hex>` suffix safeKey appends to a show id (transcriptCorpus.ts). */
export const SHOW_DIR_HASH = /-[0-9a-f]{10}$/;

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The show_id a local directory name stands for. */
export function showIdOfDir(dir) {
  return String(dir).replace(SHOW_DIR_HASH, "");
}

/** Sorted shows, each with its entries sorted by fileName. */
function sortedShows(shows) {
  const out = new Map();
  for (const showId of [...shows.keys()].sort(byString)) {
    out.set(showId, shows.get(showId).sort((a, b) => byString(a.fileName, b.fileName)));
  }
  return out;
}

/** The two phases chained: every selected show, item by item. */
async function* chain(shows, only, read) {
  for (const [showId, entries] of shows) {
    if (only && !only.has(showId)) continue;
    for (const entry of entries) yield await read(entry);
  }
}

/* ---------------------------------------------------------------- local */

/**
 * The local corpus listing: no body is opened, only listed and stat'ed.
 * @returns {{shows: Map<string, object[]>, shadowedDirs: Array<{dir: string, show_id: string, kept: string}>}}
 */
export function listLocal(normalizedRoot) {
  const shows = new Map();
  const dirOf = new Map();
  const shadowedDirs = [];
  let dirs = [];
  try {
    dirs = readdirSync(normalizedRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(byString);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  for (const dir of dirs) {
    const showId = showIdOfDir(dir);
    if (dirOf.has(showId)) {
      shadowedDirs.push({ dir, show_id: showId, kept: dirOf.get(showId) });
      continue;
    }
    dirOf.set(showId, dir);
    const entries = [];
    for (const fileName of readdirSync(join(normalizedRoot, dir))) {
      if (!fileName.endsWith(".json")) continue;
      const path = join(normalizedRoot, dir, fileName);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      entries.push({ show_id: showId, dir, fileName, path, size: st.size, mtimeMs: st.mtimeMs, origin: { kind: "local", key: `${dir}/${fileName}` } });
    }
    if (entries.length > 0) shows.set(showId, entries);
  }
  return { shows: sortedShows(shows), shadowedDirs };
}

/** One local body. Its stat is re-read, so it is the stat of the bytes sent. */
export function readLocal(entry) {
  const bytes = readFileSync(entry.path);
  const st = statSync(entry.path);
  let body = null;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    body = null;
  }
  return {
    kind: "body",
    show_id: entry.show_id,
    dir: entry.dir,
    fileName: entry.fileName,
    body,
    bytes,
    stat: { size: st.size, mtimeMs: st.mtimeMs },
    origin: { kind: "local", key: entry.origin.key, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

/**
 * Every local body, grouped by show. `listing` (from listLocal) skips the
 * walk; `only` (a Set of show_ids) narrows it.
 */
export async function* localSource(normalizedRoot, { listing = null, only = null } = {}) {
  const { shows } = listing ?? listLocal(normalizedRoot);
  yield* chain(shows, only, async (entry) => readLocal(entry));
}

/* ------------------------------------------------------------------- r2 */

const listingPrefix = (p) => (p.endsWith("/") ? p : `${p}/`);
const unsafeName = (s) => s === "." || s === ".." || /[\\/]/.test(s);

/**
 * The R2 normalized listing: ListObjectsV2 only, no HEAD, no GET.
 * @returns {Promise<{shows: Map<string, object[]>, objects: number, ignored: number,
 *   unmappedDirs: Array<{dir: string, objects: number}>, quarantined: object[]}>}
 * `quarantined` holds the keys refused at list time (PATH_ESCAPE), already in
 * item shape.
 */
export async function listR2Normalized({ client, bucket, showMap = new Map(), commands = {}, prefix = NORMALIZED_PREFIX } = {}) {
  const listed = listingPrefix(prefix);
  const shows = new Map();
  const unmapped = new Map();
  const quarantined = [];
  let objects = 0;
  let ignored = 0;
  for await (const obj of listPrefix(client, bucket, listed, { ListObjectsV2Command: commands.ListObjectsV2Command })) {
    objects += 1;
    const parsed = obj.key?.startsWith(listed) ? parseBodyKey(obj.key) : null;
    if (!parsed) {
      ignored += 1;
      continue;
    }
    const mapped = resolveShowDir(showMap, parsed.dir);
    const dir = mapped ? localDirFor(mapped.show_id) : parsed.dir;
    const showId = mapped ? mapped.show_id : showIdOfDir(parsed.dir);
    const lastModified = obj.lastModified instanceof Date ? obj.lastModified.toISOString() : obj.lastModified;
    const mtimeMs = lastModified ? Date.parse(lastModified) : NaN;
    const entry = {
      show_id: showId,
      dir,
      fileName: parsed.file,
      size: obj.size,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      origin: { kind: "r2", key: obj.key, etag: obj.etag ?? null },
    };
    if (unsafeName(parsed.dir) || unsafeName(parsed.file)) {
      quarantined.push(quarantineItem(entry, "PATH_ESCAPE", true));
      continue;
    }
    if (!mapped) unmapped.set(parsed.dir, (unmapped.get(parsed.dir) ?? 0) + 1);
    let entries = shows.get(showId);
    if (!entries) {
      entries = [];
      shows.set(showId, entries);
    }
    /* The last-listed object of a name wins, as the mirror's last write does. */
    const at = entries.findIndex((e) => e.fileName === entry.fileName);
    if (at >= 0) entries.splice(at, 1);
    entries.push(entry);
  }
  return {
    shows: sortedShows(shows),
    objects,
    ignored,
    unmappedDirs: [...unmapped.entries()].sort(([a], [b]) => byString(a, b)).map(([dir, n]) => ({ dir, objects: n })),
    quarantined,
  };
}

function quarantineItem(entry, reason, persist) {
  return {
    kind: "quarantine",
    show_id: entry.show_id,
    dir: entry.dir,
    fileName: entry.fileName,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    origin: { ...entry.origin },
    reason,
    persist,
  };
}

/** One R2 body, fetched once and checked the way sync-r2 checks it. */
export async function readR2(entry, { client, bucket, commands = {} } = {}) {
  let got;
  try {
    got = await getObject(client, bucket, entry.origin.key, { GetObjectCommand: commands.GetObjectCommand });
  } catch (e) {
    if (e?.name === "R2Error" && (e.code === "TOO_LARGE" || e.code === "NO_BODY")) return quarantineItem(entry, e.code, true);
    return quarantineItem(entry, `GET_FAILED:${e?.name ?? "Error"}`, false);
  }
  const digest = sha256(got.body);
  if (got.sha256Meta && digest !== String(got.sha256Meta).toLowerCase()) return quarantineItem(entry, "SHA_MISMATCH", true);
  let body;
  try {
    body = JSON.parse(got.body.toString("utf8"));
  } catch {
    return quarantineItem(entry, "BAD_JSON", true);
  }
  const bad = bodyShapeError(body);
  if (bad) return quarantineItem(entry, `BAD_SHAPE:${bad}`, true);
  return {
    kind: "body",
    show_id: entry.show_id,
    dir: entry.dir,
    fileName: entry.fileName,
    body,
    bytes: got.body,
    stat: { size: got.body.length, mtimeMs: entry.mtimeMs ?? 0 },
    origin: { kind: "r2", key: entry.origin.key, etag: got.etag ?? entry.origin.etag ?? null, sha256: digest },
  };
}

/**
 * Every R2 normalized body, grouped by show: one listing, then one GET per
 * selected object. `listing` (from listR2Normalized) skips the listing.
 */
export async function* r2NormalizedSource({ client, bucket, showMap = new Map(), commands = {}, listing = null, only = null } = {}) {
  const { shows } = listing ?? (await listR2Normalized({ client, bucket, showMap, commands }));
  yield* chain(shows, only, (entry) => readR2(entry, { client, bucket, commands }));
}
