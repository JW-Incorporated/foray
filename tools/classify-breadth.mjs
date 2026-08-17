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
   `classify-agent-*` judgement completely alone, and touches any other
   overlay only to ENRICH it in place — adding the child nodes that fix a
   branch the overlay left bare, and nothing else. Until 2026-08 it did the
   opposite — it rebuilt `entries` from scratch and wrote the result, so a
   single re-run would have silently deleted every agent-authored
   classification in the file (1,851 of them at the time this was fixed)
   and every entry for a show missing from the input catalog. That is why
   the file below is a merge, not a rebuild.

   Usage: node tools/classify-breadth.mjs [--in <catalog>] [--dry-run]
     --in is resolved against the CWD (like the env overrides below), so run it
     from the repo root: `--in data/catalog-breadth.json`. --dry-run reports
     what would change and writes nothing.

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
let wrote = 0, added = 0, changed = 0, unchanged = 0, enriched = 0, noTopics = 0;

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

  /* Note the test is on `existing`, not on `existingSource`: an entry with no
     `source` field at all is still somebody's work, and the whole point of the
     rule below is that an unrecognised layer is protected by default. Testing
     the source would have dropped a sourceless entry straight through to the
     base path and rewritten it. */
  if (existing && existingSource !== BASE_SOURCE) {
    /* Any other overlay: the base layer ENRICHES the entry in place. It does
       not replace it, does not re-source it, does not touch its confidence,
       and adds nothing except the child nodes that fix a branch the overlay
       left bare.

       The 2026-07 `llm-title-genre` pass is the case in hand — for whole
       genres it emitted nothing but the bare branch (`["gaming"]`,
       `["personal-journals"]`) while outranking a map that now names the
       child.

       Adding ONLY the fixing children is the part that took two attempts to
       get right, and the reason is measurable. Writing the map's whole topic
       list instead also bolts on its coarse SECONDARY branches (`Games`
       carries `hobbies`, `Astronomy` carries `science`, `Social Sciences`
       carries psychology + society + economics). Measured on the live file:
       replacing the entry wholesale on any strict superset touched 2,021
       shows and made root dumping WORSE, 9,741 -> 10,502 pairs; gating that
       on "fixes a bare branch" cut it to 352 shows but still rode 179 new
       bare-root pairs in on their backs. Adding just the children rides none.

       Enriching in place rather than replacing also keeps every other field
       the overlay carried — its `by` batch marker, its rationale, its
       confidence — which "additive" has to mean if it is going to mean
       anything. */
    const old = existing.topics || [];
    const oldBranches = new Set(old.map((t) => t.split("/")[0]));
    const oldBranchesWithChild = new Set(old.filter((t) => t.includes("/")).map((t) => t.split("/")[0]));

    /* An overlay entry with no topics asserts nothing, so nothing can be lost
       by filling it in wholesale. No such entry exists in the live file today;
       without this branch an empty overlay entry would lock its show out of
       classification permanently. */
    if (old.length === 0) {
      entries[id] = { ...existing, topics: next.topics, confidence: next.confidence, enriched_by: BASE_SOURCE, enriched_nodes: next.topics };
      enriched++;
      wrote++;
      continue;
    }

    const fixes = next.topics.filter(
      (t) => t.includes("/") && oldBranches.has(t.split("/")[0]) && !oldBranchesWithChild.has(t.split("/")[0])
    );
    if (!fixes.length) {
      const key = existingSource || "(no source)";
      preservedBySource[key] = (preservedBySource[key] || 0) + 1;
      continue;
    }
    /* Each child goes immediately before its own bare parent. The parent is
       guaranteed to be present as a bare root: a branch only qualifies as a
       fix when the overlay named it with no child. */
    const merged = [...old];
    for (const child of fixes) merged.splice(merged.indexOf(child.split("/")[0]), 0, child);
    entries[id] = {
      ...existing,
      topics: merged,
      enriched_by: BASE_SOURCE,
      enriched_nodes: [...(existing.enriched_nodes || []), ...fixes],
    };
    enriched++;
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
   that had topics yesterday and has none today.
   BE HONEST ABOUT WHAT THIS IS: the real protection is structural — `entries`
   starts as a copy of what was on disk and every write carries a non-empty
   `topics` — so this loop should be unreachable. It is a belt-and-braces
   assertion that a future edit has not broken that property, not the mechanism
   that guarantees it. Keep it: the failure it catches is silent, and an
   unreachable check that costs one pass over 19,787 keys is a bargain. */
const lost = Object.keys(priorEntries).filter(
  (id) => (priorEntries[id].topics || []).length > 0 && !(entries[id]?.topics || []).length
);
if (lost.length) {
  console.error(`UN-CLASSIFIED ${lost.length} show(s) that previously had topics, e.g.`, lost.slice(0, 10));
  console.error("Nothing was written. This layer must never remove a classification.");
  process.exit(1);
}

/* Provenance is per-layer, and merged rather than replaced. merge-results.mjs
   records `last_batch_id`/`last_batch_tier` here; this script must not sign
   over the top of a file whose best 1,851 entries it just refused to touch. */
const doc = {
  version: prior.version || 1,
  built_at: new Date().toISOString(),
  provenance: {
    ...(prior.provenance || {}),
    base_layer: {
      produced_by: "classify-breadth.mjs",
      method: "deterministic genre map (base layer; higher-precedence overlays enriched in place, never replaced)",
      input: CATALOG_PATH.startsWith(ROOT) ? CATALOG_PATH.slice(ROOT.length + 1).replace(/\\/g, "/") : CATALOG_PATH,
      built_at: new Date().toISOString(),
    },
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
    `(${added} new, ${changed} changed, ${unchanged} unchanged, ${enriched} overlay entries enriched in place), ` +
    `${noTopics} with no mappable genre.`
);
console.log(`preserved higher-precedence entries:`, preservedBySource);
console.log(`genre-map entries by confidence:`, confCounts, `| total entries: ${Object.keys(entries).length}`);
if (unmappedGenres.size) console.warn("UNMAPPED GENRES:", [...unmappedGenres]);
