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
 *     "built_at": "2026-09-10T12:34:56.000Z",// the built commit's committer date (`buildTimestamp`)
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
 * of the deploy id and the three files' hashes, plus `built_at`.
 *
 * IT IS A BUILD OUTPUT, NEVER A COMMITTED FILE (issue #701, 2026-09-24)
 * Until #701 this file was committed, regenerated on every PR by
 * `manifest-autofix.yml`, and so changed by every merge to `main` — which made
 * every other open PR conflict with `main` the moment anything merged. It is now
 * written only into a BUILT tree: `tools/web/prepare-dist.mjs` (the Vercel
 * deploy the phones read it from, `app.js`'s `API_ORIGIN`), the Pages workflow's
 * stamped checkout, and — in memory, marked `partial` — the native bundle's seed
 * (`tools/mobile/prepare-webdir.mjs`). `.gitignore` keeps it out of the tree and
 * `generate-manifest.mjs --check` (the required `data-and-site` gate) fails if
 * it is ever committed again. `built_at` comes from `buildTimestamp` below; read
 * that function's header before changing anything about ordering.
 *
 * WHY THIS IS ITS OWN FILE
 * Pure functions over (root, deployId) are testable from a scratch tree on any
 * checkout, CRLF or not, and `prepare-webdir.mjs` needs them without the CLI.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

/** The exact bytes a build writes for a pointer object (`generate-manifest.mjs`'s `stampBuild`). */
export function pointerText(pointer) {
  return JSON.stringify(pointer, null, 2) + "\n";
}

/** `git <args>` in `root`, trimmed stdout, or null on any failure. */
function gitOut(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (_) {
    return null;
  }
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
 * The `built_at` a build stamps into the pointer, and where it came from.
 *
 * `built_at` is the ONLY order a phone has (`player/foray-directory.js` refuses
 * a live pointer whose `built_at` is behind the set it holds, `STATUS.OLDER`,
 * and re-decides that from the same two stamps on every refresh — forever). So
 * the one property this has to have is that it MOVES FORWARD with `main`.
 *
 * THE COMMIT'S OWN COMMITTER DATE, not the wall clock and not a committed value.
 *   - Not committed (issue #701): a committed stamp is exactly what a `git
 *     revert` walks backwards (audit finding C, 2026-09-12 — the revert restored
 *     the old pointer bytes, old `built_at` and all, and every phone holding the
 *     reverted version refused the rollback for good). A revert is a NEW commit
 *     with a NEW committer date, so a stamp derived from HEAD's date carries a
 *     rollback forward on its own; the merge-base "floor" machinery that used to
 *     patch this over is gone with the committed file.
 *   - Not the wall clock: two builds of the same commit (a Vercel redeploy, the
 *     Pages workflow and the Vercel build of one merge) then agree byte for byte,
 *     and the stamp means "when this version reached `main`", which is what the
 *     phone is ordering by. The clock is the last-resort fallback only.
 *
 * `SOURCE_DATE_EPOCH` (the reproducible-builds convention, integer seconds)
 * wins when set, so a test or a rebuild can pin the stamp without git.
 *
 * -> { builtAt: ISO-8601 string, source: "SOURCE_DATE_EPOCH" | "git" | "clock" }
 */
export function buildTimestamp(root, { env = process.env, now = () => new Date() } = {}) {
  const epoch = env && env.SOURCE_DATE_EPOCH;
  if (epoch != null && /^\d+$/.test(String(epoch).trim())) {
    return { builtAt: new Date(Number(String(epoch).trim()) * 1000).toISOString(), source: "SOURCE_DATE_EPOCH" };
  }
  const committed = gitOut(root, ["log", "-1", "--format=%cI", "HEAD"]);
  if (committed && Number.isFinite(Date.parse(committed))) {
    return { builtAt: new Date(Date.parse(committed)).toISOString(), source: "git" };
  }
  return { builtAt: now().toISOString(), source: "clock" };
}

/**
 * Everything wrong with the pointer on disk under `root` (a BUILT tree — `dist/`
 * or a stamped Pages checkout) for the deploy id that tree computes to. Empty
 * means it is current. Each string is one operator-facing line;
 * `generate-manifest.mjs`'s `stampedProblems` prints them all and the build
 * fails on any.
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
