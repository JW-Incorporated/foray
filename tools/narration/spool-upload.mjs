#!/usr/bin/env node
/* tools/narration/spool-upload.mjs — push what the render worker staged, then record where it is.
 *
 * GV-22 (docs/roadmap/generation-v2.md). `render-foray.py --worker SPOOL`
 * renders one narration line per job and stages it as
 *
 *     SPOOL/upload/<job_id>/manifest-<job_id>.json   a one-entry render manifest
 *     SPOOL/upload/<job_id>/n/<profile>/<voice>/<sha256>.m4a
 *     SPOOL/done/<job_id>.json                       {job_id, status, entry, timings}
 *
 * For each staged directory whose done record says `rendered`, this tool
 *   1. verifies the directory with upload-narration.mjs's own collectUploads
 *      (the manifest's bytes and sha256 against the file on disk), and checks
 *      that the staged key is the key the done record names;
 *   2. runs the UNCHANGED governed uploader as a child process,
 *      `node upload-narration.mjs <dir>`, which reads the founder's R2 token
 *      from ~/.foray/r2-narration.env and writes with `rclone --immutable`;
 *   3. only when that exits 0, writes `public_url = <profile.public_base>/<key>`
 *      into done/<job_id>.json (atomically) and removes the staged directory.
 *
 * So nothing ever records a URL for an object that was not uploaded. A failed
 * upload leaves the staged directory and the done record as they were, to be
 * retried by the next run.
 *
 * This file holds and reads no credential; the uploader does. Like the
 * uploader, it REFUSES under CI (`CI` or `GITHUB_ACTIONS` set) before reading
 * anything: R2 writes happen only on a machine where the founder placed a
 * token (HUMAN-ACTIONS #119/#120).
 *
 *     node tools/narration/spool-upload.mjs <spool> [--dry-run] [--credentials-file PATH]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectUploads, inCI, PROFILE_PATH } from "./upload-narration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADER = path.join(HERE, "upload-narration.mjs");

export class SpoolUploadError extends Error {}

/** argv for the governed uploader: the staged dir, and nothing else but an optional credentials path. */
export function uploaderArgv(dir, { credentialsFile } = {}) {
  return [UPLOADER, dir, ...(credentialsFile ? ["--credentials-file", credentialsFile] : [])];
}

/** The default runner: `node upload-narration.mjs <dir>`, its output passed through. Returns the exit code. */
export function runUploader(dir, { credentialsFile, env = process.env } = {}) {
  const r = spawnSync(process.execPath, uploaderArgv(dir, { credentialsFile }), { stdio: "inherit", env });
  if (r.error) throw new SpoolUploadError(`the uploader could not start: ${r.error.message}`);
  return r.status ?? 1;
}

/** `<public_base>/<key>`, with exactly one slash between them. */
export function publicUrl(profile, key) {
  if (typeof profile.public_base !== "string" || !/^https:\/\//.test(profile.public_base)) {
    throw new SpoolUploadError("render-profile.json public_base must be an https URL");
  }
  return `${profile.public_base.replace(/\/+$/, "")}/${key}`;
}

function writeJsonAtomic(file, obj) {
  const part = path.join(path.dirname(file), `.${path.basename(file)}.part`);
  fs.writeFileSync(part, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(part, file);
}

/** The staged job directories, in job-id order. Dot-names are the worker's half-built staging dirs. */
export function stagedJobs(spool) {
  const dir = path.join(spool, "upload");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

/**
 * Upload every staged job and record its public URL.
 *
 * `runUploader(dir) -> exit code` is injectable for tests; the default runs the
 * governed uploader as a child process. Returns {uploaded, failed, skipped},
 * each a list of {job_id, ...}.
 */
export function uploadSpool({ spool, profile, env = process.env, runUploader: run, dryRun = false, credentialsFile, log = console.log }) {
  /* FIRST, before reading a single file: never from CI. */
  if (inCI(env)) {
    throw new SpoolUploadError(
      "refusing to run under CI (CI/GITHUB_ACTIONS is set). R2 writes happen only on a machine where the founder " +
        "placed a token; GitHub Actions never uploads."
    );
  }
  const runner = run ?? ((dir) => runUploader(dir, { credentialsFile, env }));
  const result = { uploaded: [], failed: [], skipped: [] };
  for (const jobId of stagedJobs(spool)) {
    const dir = path.join(spool, "upload", jobId);
    const donePath = path.join(spool, "done", `${jobId}.json`);
    if (!fs.existsSync(donePath)) {
      result.skipped.push({ job_id: jobId, reason: "no done record yet" });
      continue;
    }
    let done;
    try {
      done = JSON.parse(fs.readFileSync(donePath, "utf8"));
    } catch (err) {
      result.failed.push({ job_id: jobId, error: `done/${jobId}.json is unreadable: ${err.message}` });
      log(`FAILED ${jobId}: done/${jobId}.json is unreadable`);
      continue;
    }
    if (done.status !== "rendered" || !done.entry) {
      result.skipped.push({ job_id: jobId, reason: `done record status is ${done.status}` });
      continue;
    }
    let key;
    try {
      const uploads = collectUploads(dir, profile);
      if (uploads.length !== 1) throw new SpoolUploadError(`${jobId}: expected one staged object, found ${uploads.length}`);
      key = uploads[0].key;
      if (key !== done.entry.key) throw new SpoolUploadError(`${jobId}: staged ${key} but the done record names ${done.entry.key}`);
    } catch (err) {
      result.failed.push({ job_id: jobId, error: err.message });
      log(`FAILED ${jobId}: ${err.message}`);
      continue;
    }
    const url = publicUrl(profile, key);
    if (dryRun) {
      log(`would upload ${jobId}: ${key} -> ${url}`);
      result.skipped.push({ job_id: jobId, reason: "dry run" });
      continue;
    }
    const code = runner(dir);
    if (code !== 0) {
      result.failed.push({ job_id: jobId, error: `upload-narration.mjs exited ${code}` });
      log(`FAILED ${jobId}: upload-narration.mjs exited ${code}; no public_url recorded`);
      continue;
    }
    writeJsonAtomic(donePath, { ...done, public_url: url });
    fs.rmSync(dir, { recursive: true, force: true });
    result.uploaded.push({ job_id: jobId, key, public_url: url });
    log(`uploaded ${jobId}: ${url}`);
  }
  return result;
}

export function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  /* The CI refusal comes before argument parsing reads anything. */
  if (inCI(env)) {
    throw new SpoolUploadError(
      "refusing to run under CI (CI/GITHUB_ACTIONS is set). R2 writes happen only on a machine where the founder " +
        "placed a token; GitHub Actions never uploads."
    );
  }
  const args = { spool: null, dryRun: false, credentialsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") args.dryRun = true;
    else if (k === "--credentials-file") args.credentialsFile = argv[++i];
    else if (k.startsWith("--")) throw new SpoolUploadError(`unknown option ${k}`);
    else if (!args.spool) args.spool = k;
    else throw new SpoolUploadError(`unexpected argument ${k}`);
  }
  if (!args.spool) throw new SpoolUploadError("usage: spool-upload.mjs <spool> [--dry-run] [--credentials-file PATH]");
  const spool = path.resolve(args.spool);
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
  const r = uploadSpool({
    spool, profile, env, dryRun: args.dryRun, credentialsFile: args.credentialsFile ?? undefined,
    runUploader: deps.runUploader, log: deps.log,
  });
  console.log(`${r.uploaded.length} uploaded, ${r.failed.length} failed, ${r.skipped.length} skipped`);
  return r.failed.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`spool-upload: ${err instanceof SpoolUploadError ? err.message : err.stack}`);
    process.exit(2);
  }
}
