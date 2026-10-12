/* The stream indexer's episode manifest (GV-09, from W3-05;
   docs/roadmap/generation-v2.md).

   data-local/passage-index/episodes.jsonl holds one row per streamed body:
     {show_id, fileName, bodyGuid, cues, lastEndSec, size, mtimeMs, origin, indexedAt}
   `size` and `mtimeMs` are the stat the body was indexed under (the stat the
   cache records for it), `origin` says where it came from ({kind: "local",
   key: "<dir>/<file>", sha256} or {kind: "r2", key, etag, sha256}). The
   retrieval server (GV-16) answers bodyStat from these rows, so a cache built
   from an R2 stream is fresh with no body on disk.

   data-local/passage-index/quarantine.jsonl holds the R2 objects refused for
   a reason the same bytes would give again (sync-r2's codes: SHA_MISMATCH,
   BAD_JSON, BAD_SHAPE:<field>, PATH_ESCAPE, TOO_LARGE, NO_BODY):
     {show_id, fileName, size, mtimeMs, origin, reason, at}
   They are kept apart so episodes.jsonl only ever describes bodies the index
   holds, and so an unchanged bad object does not make its whole show re-stream
   every night. A transient GET failure is never written here: the show is
   simply retried.

   showsToRebuild(listing, manifest) is the delta. A show is rebuilt whole
   (ShowIndex postings are per show) when its set of file names differs from
   the rows' (episodes plus quarantine), or when any listed file's size
   differs, or its etag differs (when both sides have one), else its mtimeMs.

   Both files are rewritten whole through a tmp file and a rename after each
   show (writeManifest), quarantine first: a crash between the two leaves the
   show's episode rows stale, which the next delta re-streams. Rows are sorted
   by show_id, then fileName. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EPISODES_FILE = "episodes.jsonl";
export const QUARANTINE_FILE = "quarantine.jsonl";

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** {show_id -> rows[]} from a JSONL file; a missing file is empty. */
function readRows(path) {
  const shows = new Map();
  if (!existsSync(path)) return shows;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.show_id !== "string" || typeof row.fileName !== "string") continue;
    if (!shows.has(row.show_id)) shows.set(row.show_id, []);
    shows.get(row.show_id).push(row);
  }
  return shows;
}

/** @returns {{episodes: Map<string, object[]>, quarantine: Map<string, object[]>}} */
export function readManifest(dir) {
  return { episodes: readRows(join(dir, EPISODES_FILE)), quarantine: readRows(join(dir, QUARANTINE_FILE)) };
}

/** The largest finite cue end, or null. */
function lastEndOf(cues) {
  let last = null;
  for (const cue of cues) {
    const end = cue?.end_sec;
    if (typeof end === "number" && Number.isFinite(end) && (last === null || end > last)) last = end;
  }
  return last;
}

/** One body item (sources.mjs) as a manifest row. */
export function manifestRow(item, indexedAt) {
  const body = item.body && typeof item.body === "object" ? item.body : null;
  const cues = Array.isArray(body?.cues) ? body.cues : null;
  return {
    show_id: item.show_id,
    fileName: item.fileName,
    bodyGuid: typeof body?.guid === "string" ? body.guid : null,
    cues: cues ? cues.length : 0,
    lastEndSec: cues ? lastEndOf(cues) : null,
    size: item.stat.size,
    mtimeMs: item.stat.mtimeMs,
    origin: { ...item.origin },
    indexedAt,
  };
}

/** One persistent quarantine item (sources.mjs) as a quarantine row. */
export function quarantineRow(item, at) {
  return { show_id: item.show_id, fileName: item.fileName, size: item.size, mtimeMs: item.mtimeMs, origin: { ...item.origin }, reason: item.reason, at };
}

/** Whether a listed entry is the object a row was made from. */
export function entryMatches(entry, row) {
  if (!row || entry.size !== row.size) return false;
  const a = entry.origin?.etag;
  const b = row.origin?.etag;
  if (a && b) return a === b;
  return entry.mtimeMs === row.mtimeMs;
}

/**
 * The delta. `listing` is a sources.mjs listing's `shows` map; `manifest` is
 * readManifest's result.
 * @returns {{rebuild: string[], unchanged: string[], gone: string[], reasons: Map<string, string>}}
 */
export function showsToRebuild(listing, manifest) {
  const rebuild = [];
  const unchanged = [];
  const reasons = new Map();
  for (const [showId, entries] of listing) {
    const known = new Map();
    for (const row of manifest.quarantine.get(showId) ?? []) known.set(row.fileName, row);
    for (const row of manifest.episodes.get(showId) ?? []) known.set(row.fileName, row);
    let reason = null;
    if (known.size === 0) reason = "new show";
    else if (known.size !== entries.length) reason = `${entries.length} files listed, ${known.size} known`;
    else {
      for (const entry of entries) {
        const row = known.get(entry.fileName);
        if (!row) {
          reason = `new file ${entry.fileName}`;
          break;
        }
        if (!entryMatches(entry, row)) {
          reason = `changed ${entry.fileName}`;
          break;
        }
      }
    }
    if (reason) {
      rebuild.push(showId);
      reasons.set(showId, reason);
    } else {
      unchanged.push(showId);
    }
  }
  const gone = [...new Set([...manifest.episodes.keys(), ...manifest.quarantine.keys()])].filter((s) => !listing.has(s)).sort(byString);
  return { rebuild, unchanged, gone, reasons };
}

/** Replaces one show's rows in both maps (in memory). */
export function replaceShow(manifest, showId, episodeRows, quarantineRows) {
  const sorted = (rows) => [...rows].sort((a, b) => byString(a.fileName, b.fileName));
  if (episodeRows.length > 0) manifest.episodes.set(showId, sorted(episodeRows));
  else manifest.episodes.delete(showId);
  if (quarantineRows.length > 0) manifest.quarantine.set(showId, sorted(quarantineRows));
  else manifest.quarantine.delete(showId);
}

function jsonl(shows) {
  let out = "";
  for (const showId of [...shows.keys()].sort(byString)) {
    for (const row of shows.get(showId)) out += `${JSON.stringify(row)}\n`;
  }
  return out;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Text through a tmp file and a rename (retried: Windows can hold the target briefly). */
export function writeTextAtomic(path, text, { retries = 5, pauseMs = 100 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (attempt >= retries || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(pauseMs);
    }
  }
}

/** Writes both files whole, quarantine first (see the header). */
export function writeManifest(dir, manifest) {
  writeTextAtomic(join(dir, QUARANTINE_FILE), jsonl(manifest.quarantine));
  writeTextAtomic(join(dir, EPISODES_FILE), jsonl(manifest.episodes));
}
