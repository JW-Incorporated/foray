#!/usr/bin/env node
/* The corpus export CLI (PKG-08, G-10; docs/roadmap/corpus.md §3 "PKG-08 ·
   export.mjs CLI end to end").

   One run writes one export version:

     <outRoot>/<versionDir>/shows.jsonl          catalogue.mjs buildShows
     <outRoot>/<versionDir>/episodes/<key>.jsonl episodes.mjs, one per show
     <outRoot>/<versionDir>/manifest.json        manifest.mjs buildManifest
     <outRoot>/latest.json                       manifest.mjs writeLatest, LAST
     <outRoot>/state.json                        delta.mjs writeState

   THE VERSION DIRECTORY IS NOT THE EXPORT VERSION. `export_version` is
   `now().toISOString()` (e.g. `2026-10-05T12:34:56.789Z`), kept exactly in
   manifest.json, latest.json and state.json. A `:` cannot appear in an NTFS
   file name, so the directory is `versionDirName(export_version)`: every `:`
   becomes `-` (`2026-10-05T12-34-56.789Z`). The mapping is one-to-one on
   ISO strings and sorts in the same order, so "the newest directory" is still
   the lexically last one. latest.json's `manifest_path` names the directory,
   so a reader never has to apply the mapping itself.

   Order of work, and why:
   1. The high-water mark is computed FIRST, before any file is built. An
      asset inserted while the export runs then shows up in an episode file
      with an id above the stored mark and is reported changed again next run
      (harmless). Computed last, the same asset could land after its episode
      file was written and below the stored mark, and be missed for good.
   2. Everything is written into a hidden staging directory
      (`.partial-<versionDir>-<pid>`) and renamed into place only once the
      manifest is written, so a run that dies half way leaves no directory
      that looks like a version. A failed run removes its staging directory.
   3. latest.json is written after the rename (writeLatest re-hashes every
      listed file first; if it refuses, the renamed directory is removed
      again), and state.json after latest.json: a run that fails
      before the pointer moves leaves the previous state, so the next run
      deltas against what readers actually see.

   Delta (manifest `delta`): against the version state.json names. An episode
   is ADDED when its `corpus_episode_id` was not in the same show's episode
   file of that version, CHANGED when it was and delta.mjs isChanged says so
   against the stored high-water mark. A show is changed when its shows.jsonl
   row differs from the previous one, is new, or has an added or changed
   episode. With no previous version (first run, or the directory state.json
   names is gone) every episode and show counts as added: a full export.

   `--dry-run` builds the whole version in a tmp directory, prints the
   manifest and the summary line, deletes the tmp directory, and never
   creates or writes anything under outRoot (it does read state.json and the
   previous version, so the delta it prints is the real one).

   Source: `--source jsonl:<dir>` (a fixture directory, row-source.mjs) or
   `--source pg` (pg-row-source.mjs, FORAYCORPUS_DATABASE_URL from the
   environment). No other network access; data/ is read (the catalogue, and
   the breadth file with `--breadth`) and never written: an `--out` under
   data/ is refused. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { assertNotInData } from "./catalog-adapter.mjs";
import { buildShows } from "./catalogue.mjs";
import { EXPORT_OUT_DIR, ROOT, safeKey } from "./config.mjs";
import { computeHighWater, isChanged, readState, writeState } from "./delta.mjs";
import { buildEpisodes, showKeyOf, writeEpisodesFile } from "./episodes.mjs";
import { buildManifest, computeSourceCounts, writeLatest } from "./manifest.mjs";
import { computeOverlap } from "./overlap.mjs";
import { pgRowSource } from "./pg-row-source.mjs";
import { readJsonl } from "./rows.mjs";
import { jsonlRowSource } from "./row-source.mjs";

export const DEFAULT_CATALOG_PATH = join(ROOT, "data", "catalog.json");
export const USAGE =
  "node tools/foraycorpus-export/export.mjs --source <jsonl:<dir>|pg> [--out <dir>] [--catalog <catalog.json>] [--breadth <catalog-breadth.json>] [--dry-run]";

export class ExportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ExportError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

const VALUE_FLAGS = Object.freeze({ "--source": "source", "--out": "out", "--catalog": "catalogPath", "--breadth": "breadthPath" });

/**
 * `{source, out, dryRun, catalogPath, breadthPath}` from argv. `--source` is
 * required (`pg` or `jsonl:<dir>`); `out` defaults to EXPORT_OUT_DIR,
 * `catalogPath` to data/catalog.json, `breadthPath` to null. An unknown flag,
 * a repeated flag or a flag missing its value throws ExportError.
 */
export function parseExportArgs(argv) {
  const seen = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new ExportError("UNKNOWN_FLAG", `${JSON.stringify(flag)}; usage: ${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ExportError("MISSING_VALUE", `${flag} needs a value`);
    if (key in seen) throw new ExportError("REPEATED_FLAG", flag);
    seen[key] = value;
    i += 1;
  }
  if (seen.source === undefined) throw new ExportError("USAGE", USAGE);
  if (seen.source !== "pg" && !/^jsonl:.+/.test(seen.source)) {
    throw new ExportError("BAD_SOURCE", `--source must be "pg" or "jsonl:<dir>", got ${JSON.stringify(seen.source)}`);
  }
  return {
    source: seen.source,
    out: seen.out ?? EXPORT_OUT_DIR,
    dryRun,
    catalogPath: seen.catalogPath ?? DEFAULT_CATALOG_PATH,
    breadthPath: seen.breadthPath ?? null,
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The filesystem-safe directory name for an export version: the ISO
    instant with every `:` replaced by `-` (NTFS refuses `:`). Anything that
    is not an ISO instant is refused rather than sanitised, so two versions
    can never map to one directory. */
export function versionDirName(exportVersion) {
  const v = String(exportVersion);
  if (!ISO_INSTANT.test(v)) throw new ExportError("BAD_EXPORT_VERSION", JSON.stringify(v));
  return v.replace(/:/g, "-");
}

/** `pg` → pgRowSource (env connection string); `jsonl:<dir>` → jsonlRowSource. */
export function defaultSourceFactory(spec) {
  if (spec === "pg") return pgRowSource();
  const dir = resolvePath(spec.slice("jsonl:".length));
  if (!existsSync(dir)) throw new ExportError("SOURCE_MISSING", dir);
  return jsonlRowSource(dir);
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ExportError(code, `${path}: ${e.message}`);
  }
}

/** Parsed rows of a JSONL file, or null when the file does not exist. */
function readJsonlOrNull(path) {
  return existsSync(path) ? readJsonl(path) : null;
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

export function summaryLine({ shows, episodes, added, changed, out }) {
  return `shows=${shows} episodes=${episodes} delta_added=${added} delta_changed=${changed} out=${out}`;
}

/**
 * Runs one export. Returns `{ exportVersion, versionDir, manifest, summary }`
 * (`versionDir` is null on a dry run).
 *
 * @param args parseExportArgs's result
 * @param {{now?: () => Date, sourceFactory?: (spec: string) => object, log?: (line: string) => void, warn?: (line: string) => void}} options
 */
export async function runExport(args, { now = () => new Date(), sourceFactory = defaultSourceFactory, log = console.log, warn = console.error } = {}) {
  const builtAt = now().toISOString();
  const exportVersion = builtAt;
  const dirName = versionDirName(exportVersion);
  const outRoot = resolvePath(args.out);
  assertNotInData(outRoot);

  const catalog = readJson(args.catalogPath, "CATALOG_UNREADABLE");
  const breadthDoc = args.breadthPath ? readJson(args.breadthPath, "BREADTH_UNREADABLE") : null;

  const statePath = join(outRoot, "state.json");
  const prevState = readState(statePath);
  let prevDir = null;
  if (prevState.last_export_version != null) {
    const candidate = join(outRoot, versionDirName(prevState.last_export_version));
    if (existsSync(candidate)) prevDir = candidate;
    else warn(`warning: state.json names ${prevState.last_export_version} but ${candidate} is gone; reporting a full export`);
  }

  const versionDir = join(outRoot, dirName);
  if (!args.dryRun && existsSync(versionDir)) throw new ExportError("VERSION_EXISTS", versionDir);
  const source = sourceFactory(args.source);
  let workRoot = null;
  let staging;
  if (args.dryRun) {
    workRoot = mkdtempSync(join(tmpdir(), "foraycorpus-export-dry-"));
    staging = join(workRoot, dirName);
  } else {
    staging = join(outRoot, `.partial-${dirName}-${process.pid}`);
  }

  let renamed = false;
  try {
    mkdirSync(staging, { recursive: true });
    const highWater = await computeHighWater(source);
    const { rows: showRows, chosenFeedByPodcast } = await buildShows(source, { catalog });
    writeJsonl(join(staging, "shows.jsonl"), showRows);
    const files = [{ path: "shows.jsonl", rows: showRows.length }];

    // buildEpisodes yields the corpus-internal podcast id; shows rows carry
    // the public id. Every English podcast gets an episode file, including
    // one without a feed (absent from chosenFeedByPodcast's keys).
    const publicIdOf = new Map();
    for await (const p of source.rows("podcasts")) {
      if (p.english_candidate_status === "yes") publicIdOf.set(p.id, p.public_id);
    }
    const showByPublicId = new Map(showRows.map((r) => [r.corpus_podcast_id, r]));
    const prevShows = prevDir ? readJsonlOrNull(join(prevDir, "shows.jsonl")) : null;
    const prevShowJson = prevShows ? new Map(prevShows.map((r) => [r.corpus_podcast_id, JSON.stringify(r)])) : null;

    const counts = { shows: showRows.length, episodes: 0, timed_transcript_episodes: 0, audio_episodes: 0 };
    const delta = { episodes_added: 0, episodes_changed: 0, shows_changed: 0 };
    const usedFiles = new Set();
    for await (const { podcast_id: podcastId, rows } of buildEpisodes(source, { podcastIds: [...publicIdOf.keys()], chosenFeedByPodcast })) {
      const show = showByPublicId.get(publicIdOf.get(podcastId));
      if (!show) throw new ExportError("SHOW_ROW_MISSING", `podcast ${podcastId} has no shows.jsonl row`);
      // Two corpus podcasts can resolve to one catalogue show id (a corpus
      // duplicate). The later one falls back to its corpus public id, which
      // is unique, instead of overwriting the earlier file.
      let key = String(showKeyOf(show));
      if (usedFiles.has(safeKey(key))) {
        warn(`warning: show key ${key} is already used; writing ${show.corpus_podcast_id}'s episodes under its corpus id`);
        key = String(show.corpus_podcast_id);
        if (usedFiles.has(safeKey(key))) throw new ExportError("DUPLICATE_SHOW_KEY", key);
      }
      usedFiles.add(safeKey(key));
      const fileName = basename(writeEpisodesFile(staging, key, rows));
      files.push({ path: `episodes/${fileName}`, rows: rows.length });

      counts.episodes += rows.length;
      for (const row of rows) {
        if (row.transcript?.timed) counts.timed_transcript_episodes += 1;
        if (row.audio) counts.audio_episodes += 1;
      }

      const prevRows = prevDir ? readJsonlOrNull(join(prevDir, "episodes", fileName)) ?? [] : null;
      const prevIds = prevRows ? new Set(prevRows.map((r) => r.corpus_episode_id)) : null;
      let showTouched = prevShowJson === null || prevShowJson.get(show.corpus_podcast_id) !== JSON.stringify(show);
      for (const row of rows) {
        if (prevIds === null || !prevIds.has(row.corpus_episode_id)) {
          delta.episodes_added += 1;
          showTouched = true;
        } else if (isChanged(row, prevState.high_water)) {
          delta.episodes_changed += 1;
          showTouched = true;
        }
      }
      if (showTouched) delta.shows_changed += 1;
    }

    const sourceCounts = await computeSourceCounts(source, { builtAt });
    const overlap = breadthDoc ? computeOverlap(showRows, breadthDoc) : null;
    const manifest = await buildManifest({
      exportVersion,
      builtAt,
      source,
      dir: staging,
      files,
      counts: { ...counts, ...sourceCounts },
      highWater,
      delta,
      overlap,
    });
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const summary = summaryLine({
      shows: counts.shows,
      episodes: counts.episodes,
      added: delta.episodes_added,
      changed: delta.episodes_changed,
      out: args.dryRun ? `${versionDir} (dry run, nothing written)` : versionDir,
    });
    if (args.dryRun) {
      log(JSON.stringify(manifest, null, 2));
      log(summary);
      return { exportVersion, versionDir: null, manifest, summary };
    }

    renameSync(staging, versionDir);
    renamed = true;
    try {
      await writeLatest(outRoot, { export_version: exportVersion, manifest_path: `${dirName}/manifest.json`, built_at: builtAt });
    } catch (e) {
      // No pointer, no version: the newest directory stays the one latest.json names.
      rmSync(versionDir, { recursive: true, force: true });
      throw e;
    }
    writeState(statePath, { version: 1, last_export_version: exportVersion, high_water: highWater });
    log(summary);
    return { exportVersion, versionDir, manifest, summary };
  } finally {
    if (typeof source.close === "function") await source.close();
    if (!renamed) rmSync(staging, { recursive: true, force: true });
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  await runExport(parseExportArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
