#!/usr/bin/env node
/* Publish one corpus export version's catalogue artifacts as a GitHub
   Release and write the pointer to it (PKG-32, G-10/G-15;
   docs/roadmap/corpus.md §3 "PKG-32 · publish-release.mjs for corpus
   artifacts"). Same pattern as tools/shows/ (founder Q2 default in
   config.mjs): the big files live on a release, the repo carries a small
   pointer that names it.

   WHAT IS PUBLISHED. Exactly three assets, under the tag
   `corpusTagFor(export_version)` (`corpus-export-` + tools/shows' slug rule,
   e.g. `corpus-export-2026-10-06t12-00-00-000z`):
     manifest.json                    the version directory's own file, as is
     shows.jsonl.gz                   the version's shows.jsonl, gzipped
     catalog-breadth-corpus.json.gz   catalog-adapter.mjs's output, gzipped
   The gzip files are written to a fresh directory under the OS tmpdir and
   removed when the run ends, never into the version directory: manifest.json
   lists that directory's files with their sha256, so adding files to it
   would make it describe something else.

   WHERE THE INPUTS COME FROM. export.mjs writes
   `<EXPORT_OUT_DIR>/<versionDirName(export_version)>/` holding shows.jsonl
   and manifest.json; the CLI below defaults to the version latest.json
   names. `export_version` is read from manifest.json, never parsed back out
   of the directory name (versionDirName turned its `:` into `-`).
   catalog-breadth-corpus.json is NOT in the version directory. The choice
   made here: take it as a path, `--catalogue`, defaulting to
   catalog-adapter.mjs's DEFAULT_OUT (data-local/corpus-export/
   catalog-breadth-corpus.json), rather than rebuilding it in this module.
   Rebuilding would need data/catalog.json, data/catalog-breadth.json and a
   harvested_at instant, all of which are the adapter CLI's inputs; reading
   its output keeps one producer for that file. The consequence: the cron
   wrapper runs catalog-adapter.mjs on THIS version's shows.jsonl first, then
   this script; nothing here can tell a stale catalogue file from a fresh one.

   IDEMPOTENT AND RESUMABLE, through tools/shows/publish-release.mjs (imported,
   never copied): one `gh release view` (`releaseState`, which fails closed on
   anything but a real absence), then `publishRelease` with that state, which
   returns at once for a published release, creates a draft for an absent
   one, uploads only the assets a draft is missing, and publishes. This module
   never shells out to `gh` itself.

   THE POINTER. `{version: 1, export_version, release_tag, asset_base_url,
   manifest_url, catalogue_url, shows_url, published_at, counts}` written to
   POINTER_PATH (data/corpus-catalogue-pointer.json) tmp + rename. It is NOT
   tools/shows' pointer (no shard fields). Every URL is
   `assetBaseUrlFor(tag)` + `/` + the asset name, and `counts` is the
   manifest's `counts` block. A pointer that already names this tag is left
   alone, so a rerun after a success changes no file.

   THE PR. This module never commits, pushes or opens a PR. It prints the
   `gh pr create --draft ...` command for the pointer branch; the cron
   wrapper on hermes-vm commits the pointer on that branch and runs it. The
   first real publish waits on HUMAN-ACTIONS #139 (gh auth on hermes-vm).

   `--dry-run` makes no `gh` call and writes no pointer: it builds the gzip
   files in tmp (so a broken input still fails), prints the tag, the asset
   list, the pointer it would write and the PR command, and removes the tmp
   directory.

   CLI: node tools/foraycorpus-export/publish-release.mjs
     [--version-dir <dir>]    default: the version <EXPORT_OUT_DIR>/latest.json names
     [--catalogue <file>]     default: data-local/corpus-export/catalog-breadth-corpus.json
     [--pointer <file>]       default: data/corpus-catalogue-pointer.json
     [--dry-run] */
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { isEntryScript } from "../ci/entry.mjs";

import { writeJsonAtomic } from "../segments/sweep-transcripts.mjs";
import { RELEASE_TAG_PREFIX as SHOWS_TAG_PREFIX, REPO_SLUG } from "../shows/config.mjs";
import { PublishError, assetBaseUrlFor, publishRelease, releaseState, releaseTagFor } from "../shows/publish-release.mjs";
import { DEFAULT_OUT as DEFAULT_CATALOGUE } from "./catalog-adapter.mjs";
import { EXPORT_OUT_DIR, POINTER_PATH, RELEASE_TAG_PREFIX, ROOT } from "./config.mjs";

export { PublishError };

/** The three asset names, in upload order. */
export const ASSET_NAMES = Object.freeze(["manifest.json", "shows.jsonl.gz", "catalog-breadth-corpus.json.gz"]);
export const POINTER_VERSION = 1;

/** `corpus-export-` + releaseTagFor's slug (lowercase, every run of
    [^a-z0-9] -> `-`, edge dashes trimmed, an empty slug refused with
    PublishError BAD_EXPORT_VERSION). The slug rule is tools/shows'; only the
    prefix differs, so it is taken from releaseTagFor rather than re-written. */
export function corpusTagFor(exportVersion) {
  return RELEASE_TAG_PREFIX + releaseTagFor(exportVersion).slice(SHOWS_TAG_PREFIX.length);
}

function need(path, what) {
  if (!existsSync(path)) throw new PublishError("MISSING_ARTIFACT", `${what} not found: ${path}`, { path });
}

/** manifest.json of a version directory, parsed, with a string export_version. */
export function readVersionManifest(versionDir) {
  const path = join(versionDir, "manifest.json");
  need(path, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest?.export_version !== "string" || manifest.export_version === "") {
    throw new PublishError("BAD_MANIFEST", `${path} has no export_version`, { path });
  }
  return manifest;
}

async function gzipFile(from, to) {
  await pipeline(createReadStream(from), createGzip({ level: 9 }), createWriteStream(to));
  return to;
}

/**
 * The three asset paths for a version, in ASSET_NAMES order: the version
 * directory's manifest.json, and shows.jsonl / the catalogue gzipped into
 * `stagingDir` (which must exist and must not be the version directory).
 */
export async function assetsFor(versionDir, { catalogPath = DEFAULT_CATALOGUE, stagingDir }) {
  if (!stagingDir) throw new PublishError("NO_STAGING_DIR", "assetsFor needs a stagingDir outside the version directory");
  if (resolvePath(stagingDir) === resolvePath(versionDir)) {
    throw new PublishError("STAGING_IS_VERSION_DIR", "gzip files must not be written into the version directory");
  }
  const manifest = join(versionDir, "manifest.json");
  const shows = join(versionDir, "shows.jsonl");
  need(manifest, "manifest.json");
  need(shows, "shows.jsonl");
  need(catalogPath, "catalog-breadth-corpus.json (run catalog-adapter.mjs on this version first)");
  return [
    manifest,
    await gzipFile(shows, join(stagingDir, ASSET_NAMES[1])),
    await gzipFile(catalogPath, join(stagingDir, ASSET_NAMES[2])),
  ];
}

/** The pointer payload (pure). */
export function buildCorpusPointer({ manifest, tag, repo = REPO_SLUG, publishedAt }) {
  const base = assetBaseUrlFor(tag, repo);
  return {
    version: POINTER_VERSION,
    export_version: manifest.export_version,
    release_tag: tag,
    asset_base_url: base,
    manifest_url: `${base}/${ASSET_NAMES[0]}`,
    catalogue_url: `${base}/${ASSET_NAMES[2]}`,
    shows_url: `${base}/${ASSET_NAMES[1]}`,
    published_at: publishedAt,
    counts: manifest.counts ?? null,
  };
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The `gh pr create --draft` command for the pointer branch, as one line. Printed, never run. */
export function pointerPrCommand({ tag, repo = REPO_SLUG, pointerPath = POINTER_PATH }) {
  const rel = relative(ROOT, resolvePath(pointerPath)).split("\\").join("/");
  const args = [
    "gh", "pr", "create", "--draft",
    "--repo", repo,
    "--base", "main",
    "--head", `corpus-pointer/${tag}`,
    "--title", `data(corpus): point ${rel} at ${tag}`,
    "--body", `Corpus catalogue pointer for release ${tag} (tools/foraycorpus-export/publish-release.mjs, PKG-32).`,
  ];
  return args.map(shellQuote).join(" ");
}

function readPointerOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Publishes one version. Returns `{tag, pointer, pointerChanged, published,
 * uploaded, assets, prCommand, dryRun}` (`assets` are the asset names).
 * `exec`, `sleep` and `pauseMs` pass through to tools/shows' releaseState /
 * publishRelease (tests inject a fake `gh` and pauseMs 0).
 */
export async function publishCorpus({
  versionDir,
  catalogPath = DEFAULT_CATALOGUE,
  pointerPath = POINTER_PATH,
  repo = REPO_SLUG,
  exec,
  sleep,
  pauseMs,
  dryRun = false,
  now = () => new Date(),
  log = console.log,
}) {
  const manifest = readVersionManifest(versionDir);
  const tag = corpusTagFor(manifest.export_version);
  const stagingDir = mkdtempSync(join(tmpdir(), "foraycorpus-release-"));
  try {
    const assets = await assetsFor(versionDir, { catalogPath, stagingDir });
    const prCommand = pointerPrCommand({ tag, repo, pointerPath });

    if (dryRun) {
      const pointer = buildCorpusPointer({ manifest, tag, repo, publishedAt: now().toISOString() });
      log(`DRY RUN: would publish ${tag} with ${ASSET_NAMES.join(", ")} (no gh call made)`);
      log(`DRY RUN: would write ${pointerPath}:\n${JSON.stringify(pointer, null, 2)}`);
      log(`DRY RUN: pointer PR command: ${prCommand}`);
      return { tag, pointer, pointerChanged: false, published: false, uploaded: 0, assets: [...ASSET_NAMES], prCommand, dryRun: true };
    }

    const state = await releaseState(tag, { exec, repo });
    const result = await publishRelease({
      tag,
      title: `Corpus export ${manifest.export_version}`,
      notes: `Corpus catalogue artifacts for export ${manifest.export_version} (tools/foraycorpus-export/publish-release.mjs, PKG-32): ${ASSET_NAMES.join(", ")}.`,
      assets,
      exec,
      repo,
      sleep,
      pauseMs,
      state,
      log,
    });
    const published = state.state !== "published";
    log(published ? `PUBLISHED: ${tag} (${result.uploaded} asset(s) uploaded${result.resumed ? ", resumed a draft" : ""})` : `SKIP: release ${tag} is already published`);

    const current = readPointerOrNull(pointerPath);
    if (current && current.version === POINTER_VERSION && current.release_tag === tag) {
      log(`SKIP: ${pointerPath} already points at ${tag}`);
      return { tag, pointer: current, pointerChanged: false, published, uploaded: result.uploaded, assets: [...ASSET_NAMES], prCommand, dryRun: false };
    }
    const pointer = buildCorpusPointer({ manifest, tag, repo, publishedAt: now().toISOString() });
    writeJsonAtomic(pointerPath, pointer);
    log(`POINTER_UPDATED: ${pointerPath} now points at ${tag}`);
    log(`NEXT (run by the cron wrapper, not here): ${prCommand}`);
    return { tag, pointer, pointerChanged: true, published, uploaded: result.uploaded, assets: [...ASSET_NAMES], prCommand, dryRun: false };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** The version directory latest.json names under `outRoot`. */
export function latestVersionDir(outRoot = EXPORT_OUT_DIR) {
  const latestPath = join(outRoot, "latest.json");
  need(latestPath, "latest.json (run export.mjs first)");
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  if (typeof latest?.manifest_path !== "string") throw new PublishError("BAD_LATEST", `${latestPath} has no manifest_path`);
  return dirname(resolvePath(outRoot, latest.manifest_path));
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "version-dir": { type: "string" },
      catalogue: { type: "string" },
      pointer: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  await publishCorpus({
    versionDir: values["version-dir"] ? resolvePath(values["version-dir"]) : latestVersionDir(),
    catalogPath: values.catalogue ? resolvePath(values.catalogue) : DEFAULT_CATALOGUE,
    pointerPath: values.pointer ? resolvePath(values.pointer) : POINTER_PATH,
    dryRun: values["dry-run"],
  });
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
}
