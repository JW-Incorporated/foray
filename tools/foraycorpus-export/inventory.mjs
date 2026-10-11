/* List-only inventory of the R2 transcript bucket and the disk-space guard
   (GV-06 / W3-01, docs/roadmap/generation-v2.md; covers R2-16, GP-09, GP-22).

   The founder was promised a size report of `foray-transcriptions` built from
   the listing alone: ListObjectsV2 carries every key and its size, so the
   report needs no HEAD and no GET. sync-r2.mjs --list-only feeds this module
   the listing (r2-client.mjs listPrefix, {key, size}) and writes the result.

   Areas. Every key falls in exactly one (classifyKey):
   - `normalized`   transcripts/normalized/...  (the bodies the sync mirrors)
   - `raw`          transcripts/raw/...          (the farm's .vtt files)
   - `fingerprints` fingerprints/...             (ad-fingerprint objects)
   - `legacy-root`  the 7,531 legacy whisper JSONs at the bucket root,
                    `<show-slug>/<title-slug>-<10 hex>.json`. GV-23 (W3-02)
                    will own parseLegacyKey; until it merges this inlines
                    foray-db's _KEY_RE and excludes the transcripts/,
                    transcript-originals/ and `_` prefixes, as foray-db does.
   - `other`        anything else.
   A key's directory (for `dirs` and `top_dirs`) is the show directory: the
   third segment under transcripts/<kind>/, the second under fingerprints/,
   the first for a legacy-root key and for `other` ("" for a key with no `/`).

   Sizes. A listed object with no numeric size is counted in
   `unknownSizeObjects` and as MAX_OBJECT_BYTES (r2-client.mjs, the largest
   body getObject accepts), so an unknown can only over-state the bytes.

   Local side. With `out` set, every normalized key that sync-r2 would treat
   as a body (parseBodyKey) is resolved to the file sync-r2 writes
   (bodyPath(out, "normalized", localDirFor(show_id) or the R2 dir, file)).
   A file already there at the listed size is `normalized_on_disk`; anything
   else counts toward `would_fetch_objects` / `would_fetch_bytes`
   (fetchNeedBytes: the one rule sync-r2's disk guard sums, so the report and
   the guard agree). A key that would escape the kind directory is skipped:
   the sync quarantines it and fetches nothing.

   ensureDiskSpace({path, needBytes, minFreeBytes, statfs}) is the guard
   sync-r2 runs before its first HEAD or GET, and every 200 writes after; it
   is exported for reuse by the stream indexer (GV-09 / W3-05). It throws
   SyncError DISK_SPACE when free - needBytes < minFreeBytes, free being
   bavail * bsize of the nearest existing ancestor of `path` (the out
   directory may not exist yet).

   Import note: this module imports parseBodyKey, bodyPath and SyncError from
   sync-r2.mjs, which imports this module back. The cycle is safe because
   neither module reads the other's bindings while it is being evaluated,
   only inside functions. */
import { existsSync, statSync, statfsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { MAX_OBJECT_BYTES } from "./r2-client.mjs";
import { localDirFor, resolveShowDir } from "./show-map.mjs";
import { SyncError, bodyPath, parseBodyKey } from "./sync-r2.mjs";

export const AREAS = Object.freeze(["normalized", "raw", "fingerprints", "legacy-root", "other"]);
export const TOP_DIRS_PER_AREA = 50;
export const LARGEST_OBJECTS = 20;
export const GB = 1e9;

/** foray-db `_KEY_RE`: a legacy whisper JSON at the bucket root. */
export const LEGACY_KEY_RE = /^[a-z0-9][a-z0-9-]*\/(?:.*-)?[0-9a-f]{10}\.json$/;
const LEGACY_EXCLUDED_PREFIXES = Object.freeze(["transcripts/", "transcript-originals/", "_"]);

/** The area a key belongs to (see the file header). */
export function classifyKey(key) {
  if (typeof key !== "string") return "other";
  if (key.startsWith("transcripts/normalized/")) return "normalized";
  if (key.startsWith("transcripts/raw/")) return "raw";
  if (key.startsWith("fingerprints/")) return "fingerprints";
  if (LEGACY_KEY_RE.test(key) && !LEGACY_EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) return "legacy-root";
  return "other";
}

/** The directory a key is grouped under in its area. */
export function dirOfKey(key, area = classifyKey(key)) {
  const parts = String(key).split("/");
  if (area === "normalized" || area === "raw") return parts[2] ?? "";
  if (area === "fingerprints") return parts.length > 2 ? parts[1] : "";
  return parts.length > 1 ? parts[0] : "";
}

/** A listed size, or MAX_OBJECT_BYTES when the listing gave none. */
export const sizeOrMax = (size) => (typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : MAX_OBJECT_BYTES);

/** Bytes a sync must download for one object: 0 when the local file already
    has the listed size, else the listed size (MAX_OBJECT_BYTES if unknown).
    `localSize` is null when there is no local file. */
export function fetchNeedBytes(listedSize, localSize) {
  if (localSize !== null && localSize !== undefined && typeof listedSize === "number" && localSize === listedSize) return 0;
  return sizeOrMax(listedSize);
}

/** Size of a local file, or null when it is absent. */
export function localSizeOf(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  return st && st.isFile() ? st.size : null;
}

const byBytesThenName = (nameOf) => (a, b) => b.bytes - a.bytes || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0);

/**
 * The inventory of one listing. `objects` is any iterable of {key, size}.
 * With `out`, the local block compares normalized bodies against the mirror
 * (sync-r2's own path rule, through `showMap`); without it `local` is null.
 */
export function inventoryFromListing(objects, { out = null, showMap = new Map(), statLocal = localSizeOf } = {}) {
  const areas = new Map(AREAS.map((a) => [a, { objects: 0, bytes: 0, dirs: new Map() }]));
  const largest = [];
  const local = out === null ? null : { normalized_on_disk: 0, would_fetch_objects: 0, would_fetch_bytes: 0 };
  let total = 0;
  let totalBytes = 0;
  let unknown = 0;

  for (const obj of objects) {
    const area = classifyKey(obj.key);
    const known = typeof obj.size === "number" && Number.isFinite(obj.size) && obj.size >= 0;
    if (!known) unknown += 1;
    const bytes = sizeOrMax(obj.size);
    total += 1;
    totalBytes += bytes;
    const slot = areas.get(area);
    slot.objects += 1;
    slot.bytes += bytes;
    const dir = dirOfKey(obj.key, area);
    const d = slot.dirs.get(dir) ?? { dir, objects: 0, bytes: 0 };
    d.objects += 1;
    d.bytes += bytes;
    slot.dirs.set(dir, d);
    largest.push({ key: obj.key, bytes, area });

    if (local && area === "normalized") {
      const parsed = parseBodyKey(obj.key);
      if (!parsed) continue;
      const mapped = resolveShowDir(showMap, parsed.dir);
      let path;
      try {
        path = bodyPath(out, parsed.kind, mapped ? localDirFor(mapped.show_id) : parsed.dir, parsed.file);
      } catch (e) {
        if (e.code === "PATH_ESCAPE") continue;
        throw e;
      }
      const need = fetchNeedBytes(obj.size, statLocal(path));
      if (need === 0) local.normalized_on_disk += 1;
      else {
        local.would_fetch_objects += 1;
        local.would_fetch_bytes += need;
      }
    }
  }

  const byArea = {};
  const topDirs = {};
  for (const [area, slot] of areas) {
    byArea[area] = { objects: slot.objects, bytes: slot.bytes, dirs: slot.dirs.size };
    topDirs[area] = [...slot.dirs.values()].sort(byBytesThenName((d) => d.dir)).slice(0, TOP_DIRS_PER_AREA);
  }
  return {
    objects: total,
    bytes: totalBytes,
    unknownSizeObjects: unknown,
    by_area: byArea,
    top_dirs: topDirs,
    largest_objects: largest
      .sort(byBytesThenName((o) => o.key))
      .slice(0, LARGEST_OBJECTS)
      .map(({ key, bytes, area }) => ({ key, size: bytes, area })),
    local,
  };
}

const gb = (bytes) => (bytes / GB).toFixed(2);
const int = (n) => n.toLocaleString("en-US");

/** A markdown report of an inventory, to paste into #1163. */
export function inventoryMarkdown(inv, { bucket = null, prefix = null, listedAt = null } = {}) {
  const lines = [];
  const where = [bucket && `bucket \`${bucket}\``, prefix !== null && `prefix \`${prefix || "(all)"}\``, listedAt && `listed ${listedAt}`].filter(Boolean);
  lines.push(`### R2 inventory${where.length ? ` (${where.join(", ")})` : ""}`, "");
  lines.push("List-only: ListObjectsV2 sizes, no HEAD and no GET.", "");
  lines.push("| area | objects | bytes | GB | dirs |", "|---|---:|---:|---:|---:|");
  for (const area of AREAS) {
    const a = inv.by_area[area];
    lines.push(`| ${area} | ${int(a.objects)} | ${int(a.bytes)} | ${gb(a.bytes)} | ${int(a.dirs)} |`);
  }
  lines.push(`| **total** | ${int(inv.objects)} | ${int(inv.bytes)} | ${gb(inv.bytes)} | |`, "");
  if (inv.unknownSizeObjects > 0) {
    lines.push(`${int(inv.unknownSizeObjects)} object(s) listed without a size, each counted as ${int(MAX_OBJECT_BYTES)} bytes.`, "");
  }
  if (inv.local) {
    lines.push(
      `Local mirror: ${int(inv.local.normalized_on_disk)} normalized bodies already on disk at the listed size; ` +
        `a sync would fetch ${int(inv.local.would_fetch_objects)} objects, ${gb(inv.local.would_fetch_bytes)} GB.`,
      "",
    );
  }
  lines.push("Largest directories per area (top 5 by bytes):", "", "| area | dir | objects | GB |", "|---|---|---:|---:|");
  for (const area of AREAS) {
    for (const d of inv.top_dirs[area].slice(0, 5)) lines.push(`| ${area} | \`${d.dir || "(root)"}\` | ${int(d.objects)} | ${gb(d.bytes)} |`);
  }
  return lines.join("\n") + "\n";
}

/** The nearest existing ancestor of a path (statfs needs one). */
function existingAncestor(path) {
  let p = resolvePath(path);
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return p;
}

/** The guard's verdict without throwing: {ok, needBytes, freeBytes, minFreeBytes, message}. */
export function diskVerdict({ path, needBytes, minFreeBytes, statfs = statfsSync }) {
  const st = statfs(existingAncestor(path));
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  const ok = freeBytes - needBytes >= minFreeBytes;
  const message = `need ${gb(needBytes)} GB, free ${gb(freeBytes)} GB, keep ${gb(minFreeBytes)} GB`;
  return { ok, needBytes, freeBytes, minFreeBytes, message };
}

/** Throws SyncError DISK_SPACE when free - needBytes < minFreeBytes; returns the verdict otherwise. */
export function ensureDiskSpace(options) {
  const verdict = diskVerdict(options);
  if (!verdict.ok) throw new SyncError("DISK_SPACE", verdict.message);
  return verdict;
}
