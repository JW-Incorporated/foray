/* The Foray directory pointer — `data/forays-directory.json` (FD-02).
 *
 * WHAT IT IS
 * The three files the app reads for Forays (`data/forays.json` for the order,
 * `data/segments.json` for the timestamps, `data/segment-sources.json` for the
 * audio — requirements §6.6) already deploy atomically with the rest of the
 * site under one content-derived `deploy_id` (`deploy-manifest.json`,
 * `tools/ci/generate-manifest.mjs`). The pointer is a SMALL file that names
 * that set for a client which does not run the service worker: the native
 * shell (FD-03) fetches it from the live origin at boot, compares `version`
 * with what it holds, and only when the pointer is newer fetches the three
 * files and verifies them against `sha256` before swapping them in. Publishing
 * a Foray therefore ends at a merge to `main`; no store build.
 *
 *   {
 *     "version":  "<deploy_id>",             // the generation these files shipped in
 *     "built_at": "2026-09-10T12:34:56.000Z",// when THIS version of the pointer was written
 *     "files":    { "forays": "data/forays.json", "segments": "data/segments.json",
 *                   "sources": "data/segment-sources.json" },
 *     "bytes":    { "forays": 54997, "segments": 177321, "sources": 59553 },
 *     "sha256":   { "forays": "<hex>", "segments": "<hex>", "sources": "<hex>" }
 *   }
 *
 * `files` are the bare repo paths — the same keys `deploy-manifest.json` and
 * `sw.js` use. A client that wants the long-lived (immutable) copy appends
 * `?v=<version>` to a file path: `vercel.json` serves
 * `data/{forays,segments,segment-sources}.json?v=...` with a one-year
 * immutable `Cache-Control`, and the bare path with the same always-revalidate
 * header every other `data/*.json` gets. The bare path is NOT immutable — it
 * changes on every deploy — so the version has to be in the URL before a
 * long-lived header is safe, exactly the way `sw.js` tags a pinned page's
 * data requests with `?_fdid=<deploy_id>`.
 *
 * WHY `version` IS THE DEPLOY ID AND NOT ITS OWN HASH
 * The web already has one identity for "the set of files that shipped
 * together": `deploy_id`. Giving the directory a second one would be a second
 * thing to keep in step. The consequence is a circularity to name: the
 * pointer CONTAINS the deploy id, so its own bytes cannot feed the deploy id.
 * `deployIdFrom()` below therefore excludes `POINTER_PATH` from the id's input
 * lines — the pointer is listed in `deploy-manifest.json` (so `sw.js` verifies
 * its bytes like any other shipped file) but does not contribute to
 * `deploy_id`. That is safe because the pointer's content is a pure function
 * of the deploy id and the three files' hashes, plus `built_at`, which
 * `writePointer()` keeps stable while nothing else changed: the pointer
 * changes iff the deploy id changes, except on the deploy that introduces it.
 *
 * WHY THIS IS ITS OWN FILE
 * Same reason as `crlf-guard.mjs`: `generate-manifest.mjs` runs its CLI at
 * module top level and an entrypoint guard there was rejected (a guard that
 * misfires on a runner turns the `data-and-site` gate into an exit-0 no-op).
 * Pure functions over (root, deployId) are testable from a scratch tree on
 * any checkout, CRLF or not.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const POINTER_PATH = "data/forays-directory.json";

/* Key -> repo path. Keys are the names FD-03 reads; paths are the manifest's
   keys. Order here is the order in the written file. */
export const DIRECTORY_FILES = Object.freeze({
  forays: "data/forays.json",
  segments: "data/segments.json",
  sources: "data/segment-sources.json",
});

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The deploy id for a `files` map of `{ "path": "sha256:<hex>" }`, as
 * `generate-manifest.mjs` and `tools/web/prepare-dist.mjs` both compute it:
 * first 16 hex chars of sha256 over sorted "path:filehash\n" lines. The
 * pointer's own entry is excluded — see the header for why.
 */
export function deployIdFrom(files) {
  const lines =
    Object.keys(files)
      .filter((p) => p !== POINTER_PATH)
      .sort()
      .map((p) => `${p}:${files[p]}`)
      .join("\n") + "\n";
  return sha256Hex(lines).slice(0, 16);
}

/** The pointer for the three files as they are on disk under `root`. */
export function buildPointer(root, deployId, now = new Date()) {
  const files = {};
  const bytes = {};
  const sha256 = {};
  for (const [key, rel] of Object.entries(DIRECTORY_FILES)) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`forays-directory: listed file is missing on disk: ${rel}`);
    }
    const buf = readFileSync(abs);
    files[key] = rel;
    bytes[key] = buf.length;
    sha256[key] = sha256Hex(buf);
  }
  return { version: deployId, built_at: now.toISOString(), files, bytes, sha256 };
}

/** The exact bytes `writePointer` puts on disk for a pointer object. */
export function pointerText(pointer) {
  return JSON.stringify(pointer, null, 2) + "\n";
}

/** Equal in everything but `built_at`. */
export function samePointerContent(a, b) {
  if (!a || !b) return false;
  const strip = (p) => JSON.stringify({ ...p, built_at: undefined });
  return strip(a) === strip(b);
}

function readPointer(root) {
  const abs = path.join(root, POINTER_PATH);
  if (!existsSync(abs)) return { pointer: null, error: `${POINTER_PATH} is missing` };
  try {
    return { pointer: JSON.parse(readFileSync(abs, "utf8")), error: null };
  } catch (err) {
    return { pointer: null, error: `${POINTER_PATH} is not valid JSON: ${err.message}` };
  }
}

/**
 * Write the pointer for `deployId`, idempotently: if the committed pointer
 * already describes exactly these files under exactly this id, it is left
 * byte-for-byte alone (its `built_at` included), so a `--write` that changed
 * nothing produces no diff and the manifest-autofix bot stays quiet.
 * -> { changed, pointer }
 */
export function writePointer(root, deployId, now = new Date()) {
  const fresh = buildPointer(root, deployId, now);
  const { pointer: existing } = readPointer(root);
  if (existing && samePointerContent(existing, fresh)) {
    return { changed: false, pointer: existing };
  }
  writeFileSync(path.join(root, POINTER_PATH), pointerText(fresh));
  return { changed: true, pointer: fresh };
}

/**
 * Everything wrong with the pointer on disk under `root` for the deploy id the
 * tree computes to. Empty means it is current. Each string is one operator-
 * facing line; `--check` prints them all and exits 1 on any.
 */
export function pointerProblems(root, deployId) {
  const { pointer, error } = readPointer(root);
  if (error) return [error];
  const problems = [];
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    return [`${POINTER_PATH} is not a JSON object`];
  }
  if (pointer.version !== deployId) {
    problems.push(`version is ${JSON.stringify(pointer.version)} but the tree computes to deploy_id ${deployId}`);
  }
  if (typeof pointer.built_at !== "string" || Number.isNaN(Date.parse(pointer.built_at))) {
    problems.push(`built_at is not an ISO-8601 timestamp: ${JSON.stringify(pointer.built_at)}`);
  }
  const sections = { files: pointer.files, bytes: pointer.bytes, sha256: pointer.sha256 };
  for (const [name, section] of Object.entries(sections)) {
    if (!section || typeof section !== "object") {
      problems.push(`${name} is missing`);
      continue;
    }
    const extra = Object.keys(section).filter((k) => !(k in DIRECTORY_FILES));
    if (extra.length) problems.push(`${name} names unknown entries: ${extra.join(", ")}`);
  }
  for (const [key, rel] of Object.entries(DIRECTORY_FILES)) {
    if (pointer.files && pointer.files[key] !== rel) {
      problems.push(`files.${key} is ${JSON.stringify(pointer.files && pointer.files[key])}, expected "${rel}"`);
    }
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel} is missing on disk`);
      continue;
    }
    const size = statSync(abs).size;
    if (pointer.bytes && pointer.bytes[key] !== size) {
      problems.push(`bytes.${key} is ${JSON.stringify(pointer.bytes[key])} but ${rel} is ${size} bytes on disk`);
    }
    const want = pointer.sha256 && pointer.sha256[key];
    if (typeof want !== "string" || !HEX64.test(want)) {
      problems.push(`sha256.${key} is not a 64-hex sha256: ${JSON.stringify(want)}`);
    } else {
      const got = sha256Hex(readFileSync(abs));
      if (got !== want) {
        problems.push(`sha256.${key} is ${want.slice(0, 12)}… but ${rel} hashes to ${got.slice(0, 12)}… on disk`);
      }
    }
  }
  return problems;
}
