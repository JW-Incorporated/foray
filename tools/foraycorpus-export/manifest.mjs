/* Export manifest + atomic `latest.json` pointer for the corpus export
   (PKG-06, G-10; docs/roadmap/corpus.md §3 "PKG-06 · manifest.mjs +
   delta.mjs").

   One export version is a directory `<outRoot>/<export_version>/` holding
   shows.jsonl, episodes/*.jsonl and manifest.json. The manifest lists every
   file with its byte size, sha256 and row count, plus the counts the G-10
   card asks for (docs/curation/foray-to-spec-roadmap.md:485-511: feeds
   crawled vs known, the 30-day insert rate) and the delta / overlap blocks.

   `latest.json` is the only thing a reader follows, so it is written LAST and
   only after every file the manifest lists has been re-read and re-hashed
   against the manifest: a pointer to a version whose bytes changed (or never
   finished landing) is refused with ManifestError FILE_MISMATCH. It is written
   tmp + rename via tools/segments/sweep-transcripts.mjs writeJsonAtomic, which
   removes the tmp file when the rename fails, so a failed write leaves no
   latest.json and no debris. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";

import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";
import { instant } from "./time.mjs";

export const INSERT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ManifestError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ManifestError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** sha256 hex of a file's bytes, streamed (episode files can be large). */
export function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

/**
 * The source-side manifest counts: `feeds_known` (podcast_feeds rows),
 * `feeds_crawled` (rows with a non-null `last_success_at`) and `inserts_30d`
 * (episodes whose `updated_at`, else `source_published_at`, is at or after
 * `builtAt` minus 30 days; the boundary instant counts). `updated_at` is
 * ASSUMED until PKG-03 confirms it, hence the fallback.
 */
export async function computeSourceCounts(source, { builtAt }) {
  const built = instant(builtAt);
  if (built === null) throw new ManifestError("BAD_BUILT_AT", String(builtAt));
  const windowStart = built - INSERT_WINDOW_DAYS * DAY_MS;
  let feedsKnown = 0;
  let feedsCrawled = 0;
  for await (const f of source.rows("podcast_feeds")) {
    feedsKnown += 1;
    if (f.last_success_at != null) feedsCrawled += 1;
  }
  let inserts = 0;
  for await (const e of source.rows("episodes")) {
    const t = instant(e.updated_at) ?? instant(e.source_published_at);
    if (t !== null && t >= windowStart) inserts += 1;
  }
  return { feeds_known: feedsKnown, feeds_crawled: feedsCrawled, inserts_30d: inserts };
}

/** Resolves a manifest-relative path and refuses one that leaves `base`. */
function inside(base, rel) {
  const root = resolvePath(base);
  const full = resolvePath(root, rel);
  if (!full.startsWith(root + sep)) throw new ManifestError("PATH_ESCAPE", `${rel} is outside ${root}`);
  return full;
}

/**
 * Builds the manifest object. `dir` is the export-version directory; each
 * `files` entry is `{ path, rows }` with `path` relative to `dir` (forward
 * slashes; that is what the manifest records). Every file is hashed here.
 * `source` is a row source (its `kind` and `describe()`, which never carries
 * a credential). `counts` supplies the export-side counts (shows, episodes,
 * timed_transcript_episodes, audio_episodes) and computeSourceCounts's three;
 * a missing one is recorded as null rather than guessed.
 */
export async function buildManifest({ exportVersion, builtAt, source, dir, files = [], counts = {}, highWater = null, delta = null, overlap = null }) {
  const listed = [];
  for (const f of files) {
    const rel = String(f.path).split("\\").join("/");
    const full = inside(dir, rel);
    listed.push({ path: rel, bytes: statSync(full).size, sha256: await hashFile(full), rows: f.rows ?? null });
  }
  const c = (k) => (counts[k] == null ? null : counts[k]);
  return {
    version: 1,
    export_version: exportVersion,
    built_at: builtAt,
    source: { kind: source?.kind ?? null, identity: typeof source?.describe === "function" ? source.describe() : null },
    counts: {
      shows: c("shows"),
      episodes: c("episodes"),
      timed_transcript_episodes: c("timed_transcript_episodes"),
      audio_episodes: c("audio_episodes"),
      feeds_known: c("feeds_known"),
      feeds_crawled: c("feeds_crawled"),
      inserts_30d: c("inserts_30d"),
    },
    high_water: highWater,
    delta: delta == null ? null : { episodes_added: delta.episodes_added ?? null, episodes_changed: delta.episodes_changed ?? null, shows_changed: delta.shows_changed ?? null },
    overlap,
    files: listed,
  };
}

/**
 * Writes `<outRoot>/latest.json` = `{ export_version, manifest_path, built_at }`
 * (`manifest_path` relative to `outRoot`), but only after re-reading the
 * manifest and re-hashing every file it lists: a missing file, or one whose
 * sha256 or size differs from the manifest, throws ManifestError
 * FILE_MISMATCH and latest.json is not touched. `options` pass through to
 * writeJsonAtomic (its `rename` seam is how the test makes the write fail).
 */
export async function writeLatest(outRoot, { export_version, manifest_path, built_at }, options) {
  const manifestFile = inside(outRoot, manifest_path);
  if (!existsSync(manifestFile)) throw new ManifestError("FILE_MISMATCH", `manifest ${manifest_path} is missing`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const dir = dirname(manifestFile);
  for (const f of manifest.files ?? []) {
    const full = inside(dir, f.path);
    if (!existsSync(full)) throw new ManifestError("FILE_MISMATCH", `${f.path} is missing`);
    const sha = await hashFile(full);
    if (sha !== f.sha256 || statSync(full).size !== f.bytes) throw new ManifestError("FILE_MISMATCH", `${f.path} changed since the manifest was built`);
  }
  const latest = join(resolvePath(outRoot), "latest.json");
  writeJsonAtomic(latest, { export_version, manifest_path, built_at }, options);
  return latest;
}
