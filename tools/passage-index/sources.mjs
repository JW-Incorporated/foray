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

   LEGACY (GV-60, from W3-06; covers R2-16, GP-22). The 7,531 faster-whisper
   JSONs an earlier ASR lane left at the bucket root are indexed in place,
   converted in memory; no body file is ever written for them.
   listR2Legacy lists the bucket root (ListObjectsV2 only) and keeps the keys
   GV-23's parseLegacyKey accepts, so farm keys (transcripts/), fingerprints/
   and `_` probe keys are never legacy. Each key is resolved through GV-53's
   legacy-map.json (warmTranscriptIndex --resolve-legacy: {map: {key:
   {show_id, guid, ...}}, unresolved: {key: {status, reason}}}) to
   {show_id, guid}. A key the map does not resolve is skipped and counted by
   reason: `unmatched` and `ambiguous` (the map's own verdict) or `no-map`
   (the map does not know the key, or there is no map). The entry is
     {show_id, dir: localDirFor(show_id), fileName: `${safeKey(guid)}.json`,
      guid, size, mtimeMs, origin: {kind: "legacy", key, etag}}
   so W3-04's locate rule (transcriptArchiveLookup: corpusSafeKey(guid).json,
   which config.mjs's safeKey mirrors) finds it as an exact name. Two legacy
   keys that resolve to one episode keep the first listed (counted
   `duplicates.legacy`). readR2Legacy GETs the object once and runs
   convertWhisperDoc and toNormalizedBody (transcript_source "asr-local", no
   source_url); `bytes` are the converted body's JSON and `stat` is the
   OBJECT's {size, mtimeMs: LastModified}, which is what the next run's
   listing is compared on. A failure is quarantined: BAD_JSON,
   LEGACY_SHAPE:<code> (not a whisper doc), BAD_SHAPE:<field>, SHA_MISMATCH
   only if the object carries sha256 metadata (legacy objects do not), and
   getObject's codes as readR2 reports them.

   ALL. listR2All lists the normalized prefix, then the root, and merges them
   per show. When one (show_id, guid) arrives from both, the farm-normalized
   body wins: the per-show set of names the normalized listing already holds
   (each is safeKey(guid).json) drops the legacy duplicate AT LIST TIME,
   counted `duplicates.normalized`, so an episode is never indexed twice and
   the delta never sees a listed file that has no manifest row. readR2Any
   reads an entry by its origin kind.

   The AWS SDK is imported lazily by r2-client.mjs; tests inject the command
   classes and a fake client, so this module loads without node_modules. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NORMALIZED_PREFIX, safeKey } from "../foraycorpus-export/config.mjs";
import { convertWhisperDoc, LegacyShapeError, parseLegacyKey, toNormalizedBody } from "../foraycorpus-export/legacy-whisper.mjs";
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

/** A listed object's LastModified in ms, or null. */
function mtimeOf(obj) {
  const lastModified = obj.lastModified instanceof Date ? obj.lastModified.toISOString() : obj.lastModified;
  const mtimeMs = lastModified ? Date.parse(lastModified) : NaN;
  return Number.isFinite(mtimeMs) ? mtimeMs : null;
}
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
    const entry = {
      show_id: showId,
      dir,
      fileName: parsed.file,
      size: obj.size,
      mtimeMs: mtimeOf(obj),
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

/** One GET: {got}, or {item} quarantined (getObject's codes persist, any other failure does not). */
async function fetchEntry(entry, { client, bucket, commands = {} }) {
  try {
    return { got: await getObject(client, bucket, entry.origin.key, { GetObjectCommand: commands.GetObjectCommand }) };
  } catch (e) {
    if (e?.name === "R2Error" && (e.code === "TOO_LARGE" || e.code === "NO_BODY")) return { item: quarantineItem(entry, e.code, true) };
    return { item: quarantineItem(entry, `GET_FAILED:${e?.name ?? "Error"}`, false) };
  }
}

/** One R2 body, fetched once and checked the way sync-r2 checks it. */
export async function readR2(entry, { client, bucket, commands = {} } = {}) {
  const { got, item } = await fetchEntry(entry, { client, bucket, commands });
  if (item) return item;
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

/* --------------------------------------------------------------- legacy */

/** The reasons a legacy key is skipped, in report order. */
export const LEGACY_SKIP_REASONS = Object.freeze(["unmatched", "ambiguous", "no-map"]);

/** GV-53's legacy-map.json, parsed, or null when the file is absent. */
export function readLegacyMap(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  return JSON.parse(text);
}

const own = (obj, key) => obj !== null && typeof obj === "object" && Object.hasOwn(obj, key);

/**
 * What the legacy map says about one key: {show_id, guid}, or {skip: reason}
 * with reason one of LEGACY_SKIP_REASONS. A malformed map row counts as no-map.
 */
export function resolveLegacyKey(legacyMap, key) {
  const hit = own(legacyMap?.map, key) ? legacyMap.map[key] : null;
  if (hit && typeof hit.show_id === "string" && hit.show_id.trim() !== "" && typeof hit.guid === "string" && hit.guid !== "") {
    return { show_id: hit.show_id, guid: hit.guid };
  }
  const status = own(legacyMap?.unresolved, key) ? legacyMap.unresolved[key]?.status : null;
  if (status === "unmatched" || status === "ambiguous") return { skip: status };
  return { skip: "no-map" };
}

/**
 * The legacy listing: the bucket root, ListObjectsV2 only, no GET.
 * @returns {Promise<{shows: Map<string, object[]>, objects: number, ignored: number, unmappedDirs: [], quarantined: [],
 *   legacy: {listed: number, keys: number, resolved: number, skipped: {unmatched: number, ambiguous: number, "no-map": number},
 *   duplicates: {legacy: number, normalized: number}}}>}
 */
export async function listR2Legacy({ client, bucket, legacyMap = null, commands = {}, prefix = "" } = {}) {
  const shows = new Map();
  const skipped = Object.fromEntries(LEGACY_SKIP_REASONS.map((r) => [r, 0]));
  let objects = 0;
  let ignored = 0;
  let keys = 0;
  let resolved = 0;
  let duplicates = 0;
  for await (const obj of listPrefix(client, bucket, prefix, { ListObjectsV2Command: commands.ListObjectsV2Command })) {
    objects += 1;
    if (!parseLegacyKey(obj.key)) {
      ignored += 1;
      continue;
    }
    keys += 1;
    const hit = resolveLegacyKey(legacyMap, obj.key);
    if (hit.skip) {
      skipped[hit.skip] += 1;
      continue;
    }
    resolved += 1;
    const entry = {
      show_id: hit.show_id,
      dir: localDirFor(hit.show_id),
      fileName: `${safeKey(hit.guid)}.json`,
      guid: hit.guid,
      size: obj.size,
      mtimeMs: mtimeOf(obj),
      origin: { kind: "legacy", key: obj.key, etag: obj.etag ?? null },
    };
    let entries = shows.get(entry.show_id);
    if (!entries) {
      entries = [];
      shows.set(entry.show_id, entries);
    }
    /* Two legacy keys for one episode: the first listed is kept. */
    if (entries.some((e) => e.fileName === entry.fileName)) {
      duplicates += 1;
      continue;
    }
    entries.push(entry);
  }
  return {
    shows: sortedShows(shows),
    objects,
    ignored,
    unmappedDirs: [],
    quarantined: [],
    legacy: { listed: objects, keys, resolved, skipped, duplicates: { legacy: duplicates, normalized: 0 } },
  };
}

/** One legacy object, fetched once and converted in memory to a normalized body. */
export async function readR2Legacy(entry, { client, bucket, commands = {} } = {}) {
  const { got, item } = await fetchEntry(entry, { client, bucket, commands });
  if (item) return item;
  const digest = sha256(got.body);
  if (got.sha256Meta && digest !== String(got.sha256Meta).toLowerCase()) return quarantineItem(entry, "SHA_MISMATCH", true);
  let doc;
  try {
    doc = JSON.parse(got.body.toString("utf8"));
  } catch {
    return quarantineItem(entry, "BAD_JSON", true);
  }
  let body;
  try {
    body = toNormalizedBody(convertWhisperDoc(doc), { show_id: entry.show_id, guid: entry.guid });
  } catch (e) {
    if (e instanceof LegacyShapeError) return quarantineItem(entry, `LEGACY_SHAPE:${e.code}`, true);
    throw e;
  }
  const bad = bodyShapeError(body);
  if (bad) return quarantineItem(entry, `BAD_SHAPE:${bad}`, true);
  return {
    kind: "body",
    show_id: entry.show_id,
    dir: entry.dir,
    fileName: entry.fileName,
    body,
    bytes: Buffer.from(JSON.stringify(body), "utf8"),
    /* The object's own stat, as listed: the next run's delta compares the listing to it. */
    stat: { size: got.body.length, mtimeMs: entry.mtimeMs ?? 0 },
    origin: { kind: "legacy", key: entry.origin.key, etag: got.etag ?? entry.origin.etag ?? null, sha256: digest },
  };
}

/**
 * Every resolved legacy body, grouped by show. `listing` (from listR2Legacy)
 * skips the listing; `only` narrows it.
 */
export async function* r2LegacySource({ client, bucket, legacyMap = null, commands = {}, listing = null, only = null } = {}) {
  const { shows } = listing ?? (await listR2Legacy({ client, bucket, legacyMap, commands }));
  yield* chain(shows, only, (entry) => readR2Legacy(entry, { client, bucket, commands }));
}

/* ------------------------------------------------------------------ all */

/**
 * Normalized, then legacy, merged per show; the farm-normalized body wins a
 * (show_id, guid) both hold. The legacy block's duplicates.normalized counts
 * the legacy keys dropped for it.
 */
export async function listR2All({ client, bucket, showMap = new Map(), legacyMap = null, commands = {} } = {}) {
  const normalized = await listR2Normalized({ client, bucket, showMap, commands });
  const legacy = await listR2Legacy({ client, bucket, legacyMap, commands });
  const shows = new Map([...normalized.shows].map(([showId, entries]) => [showId, [...entries]]));
  let dropped = 0;
  for (const [showId, entries] of legacy.shows) {
    const have = shows.get(showId) ?? [];
    /* The guids this show already yields, as their file names (safeKey(guid).json). */
    const yielded = new Set(have.map((e) => e.fileName));
    const kept = entries.filter((e) => !yielded.has(e.fileName));
    dropped += entries.length - kept.length;
    if (kept.length > 0) shows.set(showId, [...have, ...kept]);
  }
  return {
    shows: sortedShows(shows),
    objects: normalized.objects,
    ignored: normalized.ignored,
    unmappedDirs: normalized.unmappedDirs,
    quarantined: normalized.quarantined,
    legacy: { ...legacy.legacy, duplicates: { ...legacy.legacy.duplicates, normalized: dropped } },
  };
}

/** One entry of listR2All, read by its origin kind. */
export function readR2Any(entry, opts = {}) {
  return entry.origin?.kind === "legacy" ? readR2Legacy(entry, opts) : readR2(entry, opts);
}

/** Every body of listR2All, grouped by show. */
export async function* r2AllSource({ client, bucket, showMap = new Map(), legacyMap = null, commands = {}, listing = null, only = null } = {}) {
  const { shows } = listing ?? (await listR2All({ client, bucket, showMap, legacyMap, commands }));
  yield* chain(shows, only, (entry) => readR2Any(entry, { client, bucket, commands }));
}
