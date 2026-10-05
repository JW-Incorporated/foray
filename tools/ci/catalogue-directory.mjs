/* The catalogue directory pointer — `data/catalogue-directory.json` (issue #40,
 * narrowed 2026-09-30).
 *
 * WHAT IT IS
 * The first store release ships the CATALOGUE frozen at build time (DECISIONS
 * "v1 ships the catalogue frozen; Forays are already live", HA #17;
 * docs/mobile-shell.md §"Ruled 2026-09-30"). The fast-follow those rulings name
 * is "a catalogue directory on the same pointer mechanism the Forays use
 * (`generate-manifest.mjs` + `player/foray-directory.js`), with #40's TTL and
 * cached-fresh then bundled precedence". This module is the WRITER half: the
 * small file the native shell will fetch from the live origin to learn whether
 * the five catalogue documents it holds are behind the site.
 *
 *   {
 *     "version":  "<deploy_id>",              // the generation these files shipped in
 *     "built_at": "2026-09-10T12:34:56.000Z", // the same stamp the Foray pointer carries
 *     "files":    { "discover": "data/discover.json", "session": "data/session.json",
 *                   "taxonomy": "data/taxonomy.json", "itemTags": "data/item-tags.json",
 *                   "semanticIndex": "data/semantic-index.json" },
 *     "bytes":    { "discover": 1912345, ... },
 *     "sha256":   { "discover": "<hex>", ... }
 *   }
 *
 * The five files are exactly the ones the ruling names as frozen: the discover
 * document (the bundle carries a slice of it; the site serves it whole), the
 * session, the taxonomy, the item tags and the semantic index. Every one is in
 * `generate-manifest.mjs`'s RUNTIME_DATA, so a deploy that ships the pointer
 * always ships the files it names (pinned by a test).
 *
 * THE SAME CONTRACT AS THE FORAY POINTER, ON PURPOSE
 * `version` is the deploy id (one identity for "the files that shipped
 * together", never a second hash to keep in step) and `built_at` is the SAME
 * value `forays-directory.mjs`'s `buildTimestamp` gives the Foray pointer in the
 * same build — the only order a phone has, so it must move forward with `main`
 * and agree across every stamper. `player/catalogue-directory.js` reads it with
 * the Foray module's own `isOlderThan`, so the two pointers cannot disagree about
 * what "older" means.
 *
 * WHY IT IS NOT LISTED IN deploy-manifest.json (unlike the Foray pointer)
 * The Foray pointer is a manifest entry so `sw.js` verifies its bytes, and that
 * forced `deployIdFrom` to exclude it by name (the pointer contains the id it
 * would otherwise feed). This pointer is read only by the native shell, where no
 * service worker runs (docs/mobile-shell.md §2; iOS measures
 * `hasServiceWorkerApi: false`), so listing it buys nothing and would need a
 * second exclusion in the id derivation. `sw.js` treats an unlisted `data/`
 * file the way it treats `data/show-index.tsv`: from the network.
 *
 * IT IS A BUILD OUTPUT, NEVER A COMMITTED FILE (issue #701, DECISIONS 2026-09-24)
 * Written only into a BUILT tree by `generate-manifest.mjs`'s `stampBuild`
 * (`dist/` for Vercel, the Pages workflow's throwaway checkout). `.gitignore`
 * names it and `generate-manifest.mjs --check` fails if it is ever tracked —
 * a committed pointer would conflict with every open PR, exactly as the Foray
 * pointer did before #701.
 *
 * NOT YET READ BY THE APP. The client wiring (app.js's `fetchJson`, the bundled
 * seed pointer in `tools/mobile/prepare-webdir.mjs`) is a follow-up after #1039;
 * until it lands this file is served and nothing fetches it.
 *
 * Pure functions over (root, deployId), so they run from a scratch tree on any
 * checkout, CRLF or not.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const CATALOGUE_POINTER_PATH = "data/catalogue-directory.json";

/* Key -> repo path. Keys are the names the client reads
   (`player/catalogue-directory.js`'s CATALOGUE_FILE_KEYS, pinned equal by a
   test); paths are the manifest's keys. Order here is the order in the file. */
export const CATALOGUE_FILES = Object.freeze({
  discover: "data/discover.json",
  session: "data/session.json",
  taxonomy: "data/taxonomy.json",
  itemTags: "data/item-tags.json",
  semanticIndex: "data/semantic-index.json",
});

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The catalogue pointer for the five files as they are on disk under `root`. */
export function buildCataloguePointer(root, deployId, now = new Date()) {
  const files = {};
  const bytes = {};
  const sha256 = {};
  for (const [key, rel] of Object.entries(CATALOGUE_FILES)) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`catalogue-directory: listed file is missing on disk: ${rel}`);
    }
    const buf = readFileSync(abs);
    files[key] = rel;
    bytes[key] = buf.length;
    sha256[key] = sha256Hex(buf);
  }
  return { version: deployId, built_at: now.toISOString(), files, bytes, sha256 };
}

/** The exact bytes a build writes for a catalogue pointer object. */
export function cataloguePointerText(pointer) {
  return JSON.stringify(pointer, null, 2) + "\n";
}

/**
 * Everything wrong with the catalogue pointer on disk under `root` (a BUILT
 * tree) for the deploy id that tree computes to. Empty means it is current.
 * `generate-manifest.mjs`'s `stampedProblems` prints each line and the build
 * fails on any.
 */
export function cataloguePointerProblems(root, deployId) {
  const abs = path.join(root, CATALOGUE_POINTER_PATH);
  if (!existsSync(abs)) return [`${CATALOGUE_POINTER_PATH} is missing`];
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return [`${CATALOGUE_POINTER_PATH} is not valid JSON: ${err.message}`];
  }
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    return [`${CATALOGUE_POINTER_PATH} is not a JSON object`];
  }
  const problems = [];
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
    const extra = Object.keys(section).filter((k) => !(k in CATALOGUE_FILES));
    if (extra.length) problems.push(`${name} names unknown entries: ${extra.join(", ")}`);
  }
  for (const [key, rel] of Object.entries(CATALOGUE_FILES)) {
    if (pointer.files && pointer.files[key] !== rel) {
      problems.push(`files.${key} is ${JSON.stringify(pointer.files && pointer.files[key])}, expected "${rel}"`);
    }
    const fileAbs = path.join(root, rel);
    if (!existsSync(fileAbs)) {
      problems.push(`${rel} is missing on disk`);
      continue;
    }
    const size = statSync(fileAbs).size;
    if (pointer.bytes && pointer.bytes[key] !== size) {
      problems.push(`bytes.${key} is ${JSON.stringify(pointer.bytes[key])} but ${rel} is ${size} bytes on disk`);
    }
    const want = pointer.sha256 && pointer.sha256[key];
    if (typeof want !== "string" || !HEX64.test(want)) {
      problems.push(`sha256.${key} is not a 64-hex sha256: ${JSON.stringify(want)}`);
    } else {
      const got = sha256Hex(readFileSync(fileAbs));
      if (got !== want) {
        problems.push(`sha256.${key} is ${want.slice(0, 12)}… but ${rel} hashes to ${got.slice(0, 12)}… on disk`);
      }
    }
  }
  return problems;
}
