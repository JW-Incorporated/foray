/* Applies data/genre-taxonomy-map.json to the breadth catalog(s), producing
   the BASE classification layer of data/breadth-classification.json.

   LAYERING (docs/CATALOG-PIPELINE.md, tools/classify/README.md):

     genre-map            <- this script. Deterministic, keyless, $0.
     llm-title-genre      <- the 2026-07 title+genre pass (distrusted, but
                             per-show signal this script does not have).
     classify-agent-tier1 <- tools/classify/ pipeline, real feed signal.
     classify-agent-tier2 <- ditto, escalated.

   Higher layers WIN. This script is the bottom of the stack, so it writes
   entries that are absent or still on its own layer, leaves every
   `classify-agent-*` judgement alone, and touches any other overlay only
   when it can ADD nodes without removing one (see the strict-superset rule
   below). Until 2026-08 it did the
   opposite — it rebuilt `entries` from scratch and wrote the result, so a
   single re-run would have silently deleted every agent-authored
   classification in the file (1,851 of them at the time this was fixed)
   and every entry for a show missing from the input catalog. That is why
   the file below is a merge, not a rebuild.

   Usage: node tools/classify-breadth.mjs [--in data/catalog-breadth.json] [--dry-run]

   Env overrides (mirrors tools/classify/'s convention; tests only):
     CATALOG_BREADTH_PATH, GENRE_MAP_PATH, TAXONOMY_PATH,
     BREADTH_CLASSIFICATION_PATH */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const inPath = args.includes("--in") ? args[args.indexOf("--in") + 1] : null;
const dryRun = args.includes("--dry-run");

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

const CATALOG_PATH = inPath
  ? resolvePath(process.cwd(), inPath)
  : envPath("CATALOG_BREADTH_PATH", ["data", "catalog-breadth.json"]);
const GENRE_MAP_PATH = envPath("GENRE_MAP_PATH", ["data", "genre-taxonomy-map.json"]);
const TAXONOMY_PATH = envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]);
const OUT_PATH = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const cat = readJson(CATALOG_PATH);
const gmap = readJson(GENRE_MAP_PATH).map;
const taxonomy = new Set(readJson(TAXONOMY_PATH).nodes.map((n) => n.id));

/* This layer's own source tag. Every OTHER source is treated as a
   higher-precedence overlay and preserved — the fail-safe direction, so a
   source added later is protected by default rather than by remembering to
   list it here. */
const BASE_SOURCE = "genre-map";

const prior = existsSync(OUT_PATH) ? readJson(OUT_PATH) : { version: 1, entries: {} };
const priorEntries = prior.entries || {};
/* Start from what is already on disk: entries this layer does not own (and
   entries for shows outside this input catalog) survive by construction. */
const entries = { ...priorEntries };

const CONF_ORDER = { high: 3, medium: 2, low: 1 };
const unmappedGenres = new Set();
/* A genre-map topic that is not a taxonomy node used to be dropped in silence,
   so a renamed/removed node un-classified shows with no signal at all — the
   UNMAPPED GENRES warning below does not cover it (that one only fires for
   genres absent from the map). Collect them and fail loudly instead. */
const staleMapTopics = new Set();

const preservedBySource = {};
let wrote = 0, added = 0, changed = 0, unchanged = 0, upgraded = 0, noTopics = 0;

for (const s of cat.shows) {
  const id = String(s.apple_collection_id);
  const existing = entries[id];
  const existingSource = existing?.source;

  /* An agent tier is a real per-show judgement made against the whole
     taxonomy. It may legitimately be narrower than, or flatly disagree with,
     what the genre implies (The Dice Tower is `gaming/design`, not the
     `gaming/tabletop` its genre suggests), so the base layer does not touch
     it at all — not even to bolt a node on. */
  if (existingSource && existingSource.startsWith("classify-agent-")) {
    preservedBySource[existingSource] = (preservedBySource[existingSource] || 0) + 1;
    continue;
  }

  const topics = new Set();
  let conf = "high";
  for (const g of [s.apple_genre, s.chart_genre_name]) {
    if (!g) continue;
    const m = gmap[g];
    if (!m) { unmappedGenres.add(g); continue; }
    m.topics.forEach((t) => { if (taxonomy.has(t)) topics.add(t); else staleMapTopics.add(t); });
    if (CONF_ORDER[m.confidence] < CONF_ORDER[conf]) conf = m.confidence;
  }
  if (!topics.size) { noTopics++; continue; }

  const next = { topics: [...topics], confidence: conf, source: BASE_SOURCE };

  if (existingSource && existingSource !== BASE_SOURCE) {
    /* Any other overlay: the base layer may only ENRICH it, never rewrite it,
       and only for the one defect this pass exists to fix.

       The 2026-07 `llm-title-genre` pass is the case in hand — for whole
       genres it emitted nothing but the bare branch (`["gaming"]`,
       `["personal-journals"]`), i.e. strictly less than the genre map now
       says, while outranking it. Two conditions, both required:

         1. strict superset — nothing the overlay asserted is dropped, so this
            can never un-classify or narrow a show; and
         2. the addition turns a branch the overlay left at its root into one
            with a child.

       Condition 2 is what stops this from being a numbers exercise. Without
       it the map also bolts its coarse SECONDARY branches onto every touched
       show (`Social Sciences` carries psychology + society + economics), which
       adds hundreds of new bare-root tags — measurably making root dumping
       worse while looking like more classification. Measured on the live file:
       2,021 shows qualified on condition 1 alone and root-only pairs went
       9,741 -> 10,502. */
    const old = existing.topics || [];
    const strictSuperset = old.every((t) => next.topics.includes(t)) && next.topics.length > old.length;
    const oldBranches = new Set(old.map((t) => t.split("/")[0]));
    const oldBranchesWithChild = new Set(old.filter((t) => t.includes("/")).map((t) => t.split("/")[0]));
    const fixesRootDumping = next.topics.some(
      (t) => t.includes("/") && oldBranches.has(t.split("/")[0]) && !oldBranchesWithChild.has(t.split("/")[0])
    );
    if (!strictSuperset || !fixesRootDumping) {
      preservedBySource[existingSource] = (preservedBySource[existingSource] || 0) + 1;
      continue;
    }
    entries[id] = { ...next, upgraded_from: existingSource };
    upgraded++;
    wrote++;
    continue;
  }

  if (!existing) added++;
  else if (JSON.stringify(existing.topics) !== JSON.stringify(next.topics) || existing.confidence !== next.confidence) changed++;
  else unchanged++;
  entries[id] = next;
  wrote++;
}

/* Fail before writing, not after: a stale map produces a systematically
   under-classified overlay, and writing it first would leave the bad file on
   disk for the next stage to consume. */
if (staleMapTopics.size) {
  console.error(
    "STALE GENRE MAP: data/genre-taxonomy-map.json points at topics that are not " +
      "taxonomy nodes, so they would be dropped:",
    [...staleMapTopics].sort()
  );
  console.error("Nothing was written. Fix the map (or the taxonomy) and re-run.");
  process.exit(1);
}

/* The invisible regression this pass could cause is un-classification: a show
   that had topics yesterday and has none today. Nothing above can do that (we
   only ever add or replace), so this is a cheap assertion that the merge above
   stayed a merge — not a hypothetical. */
const lost = Object.keys(priorEntries).filter(
  (id) => (priorEntries[id].topics || []).length > 0 && !(entries[id]?.topics || []).length
);
if (lost.length) {
  console.error(`UN-CLASSIFIED ${lost.length} show(s) that previously had topics, e.g.`, lost.slice(0, 10));
  console.error("Nothing was written. This layer must never remove a classification.");
  process.exit(1);
}

const doc = {
  version: prior.version || 1,
  built_at: new Date().toISOString(),
  provenance: {
    produced_by: "classify-breadth.mjs",
    method: "deterministic genre map (base layer; higher-precedence overlays preserved)",
    input: inPath || "data/catalog-breadth.json",
  },
  entries,
};

if (!dryRun) writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + "\n");

const confCounts = {};
for (const id of Object.keys(entries)) {
  if (entries[id].source !== BASE_SOURCE) continue;
  confCounts[entries[id].confidence] = (confCounts[entries[id].confidence] || 0) + 1;
}
console.log(
  `${dryRun ? "[dry-run] " : ""}base layer: wrote ${wrote}/${cat.shows.length} shows ` +
    `(${added} new, ${changed} changed, ${unchanged} unchanged, ${upgraded} upgraded from a lower-trust overlay), ` +
    `${noTopics} with no mappable genre.`
);
console.log(`preserved higher-precedence entries:`, preservedBySource);
console.log(`genre-map entries by confidence:`, confCounts, `| total entries: ${Object.keys(entries).length}`);
if (unmappedGenres.size) console.warn("UNMAPPED GENRES:", [...unmappedGenres]);
