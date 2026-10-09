/* Fold the breadth classification's topics into data/catalog-breadth.json, so
   every breadth show row carries `taxonomy_node_ids` the way a curated
   data/catalog.json row does (catalogue-personalization plan PKG-08, §6.4,
   founder Q3 default: "breadth shows get subjects").

   WHY THIS EXISTS. `data/breadth-classification.json` covers every
   breadth show (19,787 since 2026-07; 26,340 since the 2026-10-07
   re-harvest's newcomers got genre-map rows), but the classification never reached the
   catalogue row: `catalog-breadth.json` carried genre and chart rank only, so a
   breadth show page had no chips and no Similar shows. This script is the one
   writer of that field. The backend half (stop zeroing the field in
   `backend/src/catalog/breadthCatalog.ts`) is PKG-09, a separate DENIED-path PR.

   THE RULE. A show gets its entry's topics when the entry exists, its
   `confidence` is not "low" and `needs_review` is not true; anything else gets
   `[]` — an honest "no subject" rather than a guessed one. Topics are deduped
   (first occurrence wins) and any id `data/taxonomy.json` does not know is
   dropped, so a stale classification cannot put a dead chip on a page.

   BYTE-STABLE. The file is written exactly as it is stored — single-line
   `JSON.stringify(doc)` plus one trailing newline (verified on main: a plain
   parse/stringify round-trip reproduces it byte for byte). The field is
   appended to a row the first time and assigned in place after that, so a
   second run writes nothing, and `--check` exits 1 iff a run would change a
   byte.

   RE-RUN AFTER A HARVEST. `tools/harvest-catalog.mjs` rebuilds this file from
   Apple and does not know the field; run this script after it (the REAL DATA
   test in fold-breadth-topics.test.mjs fails until you do). Run
   `node tools/classify-breadth.mjs --in data/catalog-breadth.json` BEFORE it,
   so a chart newcomer has a classification entry to fold rather than `[]` (the
   second REAL DATA test fails until you do).

   Usage:
     node tools/refresh/fold-breadth-topics.mjs           # fold and write
     node tools/refresh/fold-breadth-topics.mjs --check   # exit 1 if a run would change the file

   Env overrides (mirrors the rest of tools/refresh/):
     FOLD_BREADTH_PATH    default data/catalog-breadth.json
     FOLD_CLASS_PATH      default data/breadth-classification.json
     FOLD_TAXONOMY_PATH   default data/taxonomy.json                          */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { isEntryScript } from "../ci/entry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = (name, fallback) => (process.env[name] ? resolvePath(process.env[name]) : join(ROOT, fallback));

/** True when a classification entry is trusted enough to label a show. */
export function entryFolds(entry) {
  return Boolean(entry) && entry.confidence !== "low" && entry.needs_review !== true;
}

/** Sets `taxonomy_node_ids` on every show in `doc.shows` (mutates) and returns counts. */
export function foldBreadthTopics(doc, entries, nodeIds) {
  if (!doc || !Array.isArray(doc.shows)) throw new Error("breadth catalogue did not parse to { shows: [...] }");
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("classification `entries` must be an object keyed by apple_collection_id");
  }
  const counts = { folded: 0, empty: 0, unknown_id: 0, dropped_nodes: 0 };
  for (const show of doc.shows) {
    const entry = entries[String(show.apple_collection_id)];
    if (!entry) counts.unknown_id++;
    let ids = [];
    if (entryFolds(entry)) {
      const unique = [...new Set(entry.topics || [])];
      ids = unique.filter((id) => nodeIds.has(id));
      counts.dropped_nodes += unique.length - ids.length;
    }
    show.taxonomy_node_ids = ids;
    if (ids.length) counts.folded++;
    else counts.empty++;
  }
  return counts;
}

/** The file's own serialization: single line, one trailing newline. */
export const serialize = (doc) => JSON.stringify(doc) + "\n";

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const breadthPath = envPath("FOLD_BREADTH_PATH", "data/catalog-breadth.json");
  const raw = readFileSync(breadthPath, "utf8");
  const doc = JSON.parse(raw);
  const { entries } = JSON.parse(readFileSync(envPath("FOLD_CLASS_PATH", "data/breadth-classification.json"), "utf8"));
  const taxonomy = JSON.parse(readFileSync(envPath("FOLD_TAXONOMY_PATH", "data/taxonomy.json"), "utf8"));
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));

  const counts = foldBreadthTopics(doc, entries, nodeIds);
  const out = serialize(doc);
  const changed = out !== raw;
  console.log(JSON.stringify({ ...counts, changed }));
  if (check) return changed ? 1 : 0;
  if (changed) writeFileSync(breadthPath, out);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
