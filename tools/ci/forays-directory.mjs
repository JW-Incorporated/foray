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

/** `a` is a parseable ISO instant strictly before the parseable instant `b`.
    Anything unparseable is not "older" — it is unknown, and an unknown floor
    must never cause a rewrite on its own. Mirrors `isOlderThan` in
    `player/foray-directory.js`, which is the consumer this ordering is for. */
export function builtAtIsOlder(a, b) {
  const x = Date.parse(a ?? "");
  const y = Date.parse(b ?? "");
  return Number.isFinite(x) && Number.isFinite(y) && x < y;
}

/** `git <args>` in `root`, trimmed stdout, or null on any failure. */
function gitOut(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (_) {
    return null;
  }
}

/**
 * The `built_at` of the pointer as it stands on a git ref (or commit sha), or
 * null when there is no git, no such ref, no such file on it, or it does not
 * parse as JSON.
 *
 * This and `builtAtFloorFrom` are the ONLY impure things in this module, and
 * they are deliberately best-effort: every failure returns null, which puts
 * `writePointer` back on exactly the behaviour it had before the floor existed.
 * A pure-function test from a scratch tree never calls them — it passes
 * `builtAtFloor` directly.
 */
export function pointerBuiltAtOnRef(root, ref) {
  const raw = gitOut(root, ["show", `${ref}:${POINTER_PATH}`]);
  if (raw === null) return null;
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc.built_at === "string" ? doc.built_at : null;
  } catch (_) {
    return null;
  }
}

/**
 * The floor `writePointer` measures against: the pointer's `built_at` at the
 * MERGE BASE of HEAD and the base branch.
 *
 * WHY THE MERGE BASE AND NOT THE BASE BRANCH'S TIP. The tip would make every
 * PR cut before the last data change look like a rollback — its pointer is
 * genuinely older than main's, it is not going backwards, and restamping it
 * would put an autofix commit on every stale branch in the repo. The merge base
 * is the pointer this branch STARTED from, so "behind the floor" means
 * "this branch moved it backwards", which is exactly the rollback case: a
 * revert is cut from the tip, so its merge base carries the stamp the revert
 * just undid.
 *
 * The first base in `bases` that HEAD shares a merge base with wins; null when
 * none does (no git, a shallow clone with no such ref, an orphan branch), which
 * is the pre-floor behaviour.
 */
export function builtAtFloorFrom(root, bases = ["origin/main", "main"]) {
  for (const base of bases) {
    const mergeBase = gitOut(root, ["merge-base", base, "HEAD"]);
    if (!mergeBase) continue;
    const at = pointerBuiltAtOnRef(root, mergeBase);
    if (at) return at;
  }
  return null;
}

/**
 * Write the pointer for `deployId`, idempotently: if the committed pointer
 * already describes exactly these files under exactly this id, it is left
 * byte-for-byte alone (its `built_at` included), so a `--write` that changed
 * nothing produces no diff and the manifest-autofix bot stays quiet.
 * -> { changed, pointer, restamped }
 *
 * ── THE ROLLBACK CLAUSE (`opts.builtAtFloor`, audit finding C, 2026-09-12) ──
 * `built_at` is not decoration: it is the ONLY order the phone has.
 * `player/foray-directory.js` refuses a live pointer whose `built_at` is
 * behind the one it holds (`STATUS.OLDER`) because deploy ids are content
 * hashes with no order of their own, and that refusal is permanent — it is
 * re-evaluated against the same two timestamps on every refresh, forever.
 *
 * A rollback is a `git revert`, and the pointer rides in the SAME squashed
 * commit as the three data files (`manifest-autofix.yml` adds
 * `data/forays-directory.json` to the data PR's own head — see commit e2934d0,
 * "Generated Foray: What Engineers Actually Do All Day"). So a revert restores
 * the pointer's OLD bytes, old `built_at` and all; the tree then computes back
 * to the old deploy id, `samePointerContent` says "nothing changed", and the
 * rolled-back site ships a pointer that every phone holding the reverted
 * version refuses for good. A fresh install is worse: its bundled seed is
 * `partial: true` (F-92) and never `current`, so it refuses the live pointer
 * as older and shows only the seed — no generated Foray, no recovery.
 *
 * WHY A FLOOR AND NOT "RESTAMP WHENEVER THE VERSION CHANGES". Restamping on a
 * version change does not touch this case at all: after the revert the
 * on-disk pointer's version and the computed deploy id are BOTH the old id.
 * Nothing local can tell "rolled back to D1" from "still at D1". The missing
 * fact lives in history, so the floor is read from history: the `built_at` of
 * the pointer at the MERGE BASE of this branch and main (`builtAtFloorFrom`),
 * which on a revert branch is the reverted-from pointer's newer stamp. A
 * pointer behind that floor is restamped even when its content is unchanged.
 *
 * WHY NOT A MONOTONIC COUNTER. A counter is a field in the same file, so a
 * revert walks it backwards exactly as it walks `built_at` backwards. The
 * problem is never the clock — it is that the ordering key is committed and
 * therefore revertible. Only a value derived from something the revert cannot
 * restore (history, or the wall clock at write time) fixes it.
 *
 * The floor changes nothing on an ordinary PR: the merge base's pointer is the
 * one on disk (a branch merely BEHIND main is not a rollback — that is why the
 * floor is the merge base and not main's tip), `builtAtIsOlder` is false, the
 * bytes are left alone and the autofix bot stays as quiet as before.
 */
export function writePointer(root, deployId, now = new Date(), opts = {}) {
  const fresh = buildPointer(root, deployId, now);
  const { pointer: existing } = readPointer(root);
  const floor = opts.builtAtFloor ?? null;
  const behindFloor = !!existing && builtAtIsOlder(existing.built_at, floor);
  if (existing && samePointerContent(existing, fresh) && !behindFloor) {
    return { changed: false, pointer: existing, restamped: false };
  }
  writeFileSync(path.join(root, POINTER_PATH), pointerText(fresh));
  return { changed: true, pointer: fresh, restamped: behindFloor };
}

/**
 * Everything wrong with the pointer on disk under `root` for the deploy id the
 * tree computes to. Empty means it is current. Each string is one operator-
 * facing line; `--check` prints them all and exits 1 on any.
 */
export function pointerProblems(root, deployId, opts = {}) {
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
  /* The rollback clause (audit finding C) — see `writePointer`. A pointer this
     branch has moved BACKWARDS from the stamp it started at is one every phone
     holding the newer version refuses forever, so it is as stale as a wrong
     hash. `builtAtFloor` is the merge base's stamp (`builtAtFloorFrom`), not
     the base branch's tip — a branch that is merely behind main is not a
     rollback. */
  const floor = opts.builtAtFloor ?? null;
  if (builtAtIsOlder(pointer.built_at, floor)) {
    problems.push(
      `built_at is ${JSON.stringify(pointer.built_at)}, BEHIND the ${floor} this branch started from — ` +
        "a rollback must carry a NEWER built_at or every phone holding the reverted version refuses it forever " +
        "(player/foray-directory.js, STATUS.OLDER)"
    );
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
