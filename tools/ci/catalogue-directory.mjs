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

import { makeDirectoryPointer } from "./forays-directory.mjs";

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

/* The Foray pointer's own writer and checker over this table (code-health
   CH2-22): one implementation, so a fix to the validator lands in both. */
const catalogue = makeDirectoryPointer(CATALOGUE_FILES, "catalogue-directory", CATALOGUE_POINTER_PATH);

/** The catalogue pointer for the five files as they are on disk under `root`. */
export const buildCataloguePointer = catalogue.build;

/** The exact bytes a build writes for a catalogue pointer object. */
export const cataloguePointerText = catalogue.text;

/**
 * Everything wrong with the catalogue pointer on disk under `root` (a BUILT
 * tree) for the deploy id that tree computes to. Empty means it is current.
 * `generate-manifest.mjs`'s `stampedProblems` prints each line and the build
 * fails on any.
 */
export const cataloguePointerProblems = catalogue.problems;
