#!/usr/bin/env node
/* Generates / verifies deploy-manifest.json — the deploy manifest sw.js uses
 * to stage and atomically promote one content-addressed generation (#233
 * remainder, M4 in the 2026-08-31 repo review).
 *
 * WHY THIS EXISTS
 * GitHub Pages serves `main` root with no build step and no server-side hook,
 * so there was nowhere to stamp a deploy id into the artifact sw.js fetches.
 * This script generates that stamp as a committed file: sha256 per shipped
 * file, and a `deploy_id` derived from all of them together.
 *
 * `deploy_id` = first 16 hex chars of sha256(sorted "path:filehash\n" lines).
 * Content-derived, not git-SHA-based, so it is reproducible from the tree
 * alone with no dependency on commit history, and it changes iff a listed
 * file's CONTENT changes — not on unrelated file additions elsewhere in the
 * repo, and not on mtime or listing order. The manifest's own hash is never
 * part of its own input set, so there is no chicken-and-egg problem committing
 * a file that describes itself.
 *
 * WHY NOT `manifest.json` — THAT NAME IS TAKEN
 * `manifest.json` is already the PWA web-app manifest `index.html` links
 * (`name`, `icons`, `display`, ...). This file is `deploy-manifest.json`
 * specifically to avoid clobbering it — it happened once during manual
 * testing of this script and is exactly the mistake this comment exists to
 * stop a future session from repeating.
 *
 * WHICH FILES ARE LISTED
 * Exactly what sw.js needs for one complete generation: the app shell
 * (also `tools/web/prepare-dist.mjs`'s SHELL — this file's SHELL additionally
 * covers `manifest.json`, the PWA manifest, since it too is a shell file
 * `sw.js` precaches), every player module the client actually loads, and the
 * runtime `data/*.json` app.js's `init()` fetches (kept in sync with
 * `tools/web/prepare-dist.mjs`'s RUNTIME_DATA by design — same derivation
 * concern that file's header names: a list nobody remembers to extend rots).
 *
 * `deploy-manifest.json` names every OTHER shipped file's hash, so including
 * its own hash in that set is circular; it is precisely the one file sw.js's
 * `isCode()`/pin logic does not need to gate on anyway (it is fetched with
 * `cache: "reload"` directly, never through the generation cache's pin path).
 *
 * USAGE
 *   node tools/ci/generate-manifest.mjs --write   # regenerate deploy-manifest.json
 *   node tools/ci/generate-manifest.mjs --check   # verify it is up to date (CI)
 *
 * `--check` regenerates the manifest in memory and diffs it against the
 * committed copy — including deploy_id — so a hand-edited deploy-manifest.json
 * or one that fell behind a real file change fails loudly rather than silently
 * shipping a torn deploy.
 *
 * BOTH MODES REFUSE TO RUN IN A CRLF CHECKOUT (`tools/ci/crlf-guard.mjs`).
 * These hashes describe bytes on disk, and a Windows `core.autocrlf=true`
 * checkout has CRLF where the committed blob — and the byte stream Pages
 * serves — has LF. Read that file's header before touching the guard.
 *
 * WHO CALLS `--write`
 *   - tools/refresh/merge.mjs, so the nightly's FIRST commit already carries a
 *     correct manifest and no bot fixup commit is needed (docs/DECISIONS.md,
 *     2026-09-03).
 *   - .github/workflows/manifest-autofix.yml, the safety net for every other PR.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { crlfOffenders, crlfFatalMessage } from "./crlf-guard.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = path.join(ROOT, "deploy-manifest.json");
const SW_PATH = path.join(ROOT, "sw.js");
const BUILD_ID_RE = /const BUILD_ID = "[^"]*";/;

/* The app shell sw.js precaches on install. Kept explicit, same reasoning as
   prepare-dist.mjs's SHELL: a new root-level file must be added here
   deliberately. */
const SHELL = [
  "index.html",
  "app.js",
  "search-engine.js",
  "styles.css",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];

/* Exactly what app.js fetches at runtime — kept in sync with
   tools/web/prepare-dist.mjs's RUNTIME_DATA by design (same derivation
   concern; see that script's header). */
const RUNTIME_DATA = [
  "session.json",
  "taxonomy.json",
  "discover.json",
  "semantic-index.json",
  "item-tags.json",
  "validated-links.json",
  "forays.json",
  "segments.json",
  "segment-sources.json",
  "catalog-client.json",
  "personas.json",
  "ladders.json",
  "dai-classification.json",
];

/* The player modules the client actually loads (#23/#24/#33). Test files are
   deliberately excluded — they never ship. */
function playerSources() {
  return readdirSync(path.join(ROOT, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join("player", f));
}

function listedFiles() {
  const files = [
    ...SHELL,
    ...playerSources(),
    ...RUNTIME_DATA.map((f) => path.join("data", f)),
  ];
  return [...new Set(files)].sort();
}

function sha256File(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`generate-manifest: listed file is missing on disk: ${relPath}`);
  }
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/* Aborts before any hash is computed or written. Called by BOTH modes: on a
   CRLF checkout `--check` used to report "deploy-manifest.json is stale", which
   sends the reader to run the very command that breaks it. Full rationale and
   the measurement behind it live in tools/ci/crlf-guard.mjs. */
function assertLfCheckout() {
  const bad = crlfOffenders(ROOT, listedFiles());
  if (!bad.length) return;
  console.error(crlfFatalMessage(bad));
  process.exit(1);
}

function computeManifest() {
  const files = {};
  for (const rel of listedFiles()) {
    /* Cache keys and sw.js fetches use forward slashes regardless of OS. */
    files[rel.split(path.sep).join("/")] = "sha256:" + sha256File(rel);
  }
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}:${files[p]}`)
    .join("\n") + "\n";
  const deployId = createHash("sha256").update(lines).digest("hex").slice(0, 16);
  return { deploy_id: deployId, files };
}

function main() {
  const mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--write")
    ? "write"
    : null;
  if (!mode) {
    console.error("usage: generate-manifest.mjs --write | --check");
    process.exit(2);
  }

  assertLfCheckout();

  const computed = computeManifest();

  if (mode === "write") {
    writeFileSync(MANIFEST_PATH, JSON.stringify(computed, null, 2) + "\n");
    stampBuildId(computed.deploy_id);
    console.log(`deploy-manifest.json written — deploy_id ${computed.deploy_id}, ${Object.keys(computed.files).length} files`);
    return;
  }

  // --check
  if (!existsSync(MANIFEST_PATH)) {
    console.error("FATAL: deploy-manifest.json does not exist — run with --write first");
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const committedFiles = Object.keys(committed.files || {}).sort();
  const computedFiles = Object.keys(computed.files).sort();
  const sameFiles =
    committedFiles.length === computedFiles.length &&
    committedFiles.every((f, i) => f === computedFiles[i] && committed.files[f] === computed.files[f]);
  const same = committed.deploy_id === computed.deploy_id && sameFiles;

  if (!same) {
    console.error("FATAL: deploy-manifest.json is stale. Run `node tools/ci/generate-manifest.mjs --write` and commit the result.");
    console.error(`  committed deploy_id: ${committed.deploy_id}`);
    console.error(`  computed  deploy_id: ${computed.deploy_id}`);
    const added = computedFiles.filter((f) => !committedFiles.includes(f));
    const removed = committedFiles.filter((f) => !computedFiles.includes(f));
    if (added.length) console.error(`  files added:   ${added.join(", ")}`);
    if (removed.length) console.error(`  files removed: ${removed.join(", ")}`);
    process.exit(1);
  }

  const stampedId = readStampedBuildId();
  if (stampedId !== committed.deploy_id) {
    console.error(
      "FATAL: sw.js's BUILD_ID does not match deploy-manifest.json's deploy_id — " +
        "a manifest-only content change would ship with byte-identical sw.js bytes, " +
        "so browsers would never notice the new generation exists. Run " +
        "`node tools/ci/generate-manifest.mjs --write` and commit both files."
    );
    console.error(`  sw.js BUILD_ID:      ${stampedId}`);
    console.error(`  deploy-manifest.json: ${committed.deploy_id}`);
    process.exit(1);
  }

  console.log(`deploy-manifest.json is up to date — deploy_id ${committed.deploy_id}, ${committedFiles.length} files`);
}

/* Stamps sw.js's BUILD_ID with the freshly computed deploy_id. This is the
   half of the fix that makes a manifest-only content change (a data file, a
   player module, app.js — none of which are sw.js itself) still change
   sw.js's OWN bytes: browsers compare a service worker's fetched script
   byte-for-byte against the previously registered copy and skip `install()`
   (and therefore skip ever reading the new manifest) when nothing differs.
   Without this stamp, an app.js-only deploy would leave every existing
   client's pointer on the old generation indefinitely. */
function stampBuildId(deployId) {
  const src = readFileSync(SW_PATH, "utf8");
  if (!BUILD_ID_RE.test(src)) {
    console.error("FATAL: sw.js's BUILD_ID constant could not be located — cannot stamp the deploy id.");
    process.exit(1);
  }
  const stamped = src.replace(BUILD_ID_RE, `const BUILD_ID = "${deployId}";`);
  writeFileSync(SW_PATH, stamped);
}

function readStampedBuildId() {
  const src = readFileSync(SW_PATH, "utf8");
  const m = BUILD_ID_RE.exec(src);
  if (!m) {
    console.error("FATAL: sw.js's BUILD_ID constant could not be located.");
    process.exit(1);
  }
  return /const BUILD_ID = "([^"]*)";/.exec(m[0])[1];
}

main();

export { computeManifest, listedFiles };
