/* Validates data/semantic-index.json's structural integrity and flags the
   "broad term leaking into a related concept" pattern that caused the
   bbq -> food-science -> "nutrition" bug (a Sigma Nutrition Radio episode
   outranking real BBQ episodes on a "how bbq works" search, fixed in this
   same change -- see search-engine.js's `source: "related"` term cap).

   Formalizes the one-off checks described in
   docs/research/semantic-index-notes.md (coverage stats, related-link
   integrity, term/tag intersection) as a committed, CI-gated script,
   per CLAUDE.md workflow rule #6 ("codify repetition").

   Hard failures (exit 1): structural problems that break the engine.
   Warnings (exit 0, printed): content-quality signals worth a human look --
   coverage gaps are legitimate (see docs/curation/search-coverage-gaps.md;
   a topic with no coverage should stay uncovered rather than get a
   fabricated concept, per product principle #1), so those don't fail CI.

   Usage: node tools/validate-semantic-index.mjs */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const SE = require(join(ROOT, "search-engine.js"));

const semantic = JSON.parse(readFileSync(join(ROOT, "data/semantic-index.json"), "utf8"));
const itemTags = JSON.parse(readFileSync(join(ROOT, "data/item-tags.json"), "utf8"));
const discover = JSON.parse(readFileSync(join(ROOT, "data/discover.json"), "utf8"));
const taxonomy = JSON.parse(readFileSync(join(ROOT, "data/taxonomy.json"), "utf8"));
const session = JSON.parse(readFileSync(join(ROOT, "data/session.json"), "utf8"));

const concepts = semantic.concepts || {};
const modifiers = semantic.modifiers || {};
const taxonomyIds = new Set(taxonomy.nodes.map((n) => n.id));

/* corpusDF/tagDF should see the same corpus the live client actually
   searches -- app.js's fullPool() is session.episodes + discover.items,
   not discover.items alone (see tools/test-search.mjs for the same note). */
const sessionAsItems = Object.entries(session.episodes).map(([id, ep]) => ({
  id, show: ep.show, title: ep.title, topics: ep.topics || [], hook: ep.hook || ep.summary || ep.title,
}));
const seenIds = new Set(sessionAsItems.map((i) => i.id));
const fullPoolItems = [...sessionAsItems, ...discover.items.filter((i) => !seenIds.has(i.id))];
const ctx = { semantic, itemTags, discover: { items: fullPoolItems } };

const errors = [];
const warnings = [];

/* ---------- structural ---------- */

for (const [cid, c] of Object.entries(concepts)) {
  if (!Array.isArray(c.terms) || !c.terms.every((t) => typeof t === "string")) {
    errors.push(`concept "${cid}": terms must be an array of strings`);
  }
  if (!Array.isArray(c.topics)) errors.push(`concept "${cid}": topics must be an array`);
  if (!Array.isArray(c.related)) errors.push(`concept "${cid}": related must be an array`);

  for (const rid of c.related || []) {
    if (!concepts[rid]) errors.push(`concept "${cid}": related id "${rid}" does not exist`);
  }
  for (const topicId of c.topics || []) {
    if (!taxonomyIds.has(topicId)) errors.push(`concept "${cid}": topic "${topicId}" is not a taxonomy node`);
  }
  if (!(c.topics || []).length) warnings.push(`concept "${cid}": empty topics -- no topicBoost will ever fire for it`);
}

for (const [mid, m] of Object.entries(modifiers)) {
  const validTypes = new Set(["duration_max", "duration_min", "branch", "recency_days"]);
  if (!validTypes.has(m.type)) errors.push(`modifier "${mid}": unknown type "${m.type}"`);
  if (m.type === "branch" && !Array.isArray(m.value)) errors.push(`modifier "${mid}": branch value must be an array`);
  if (m.type !== "branch" && typeof m.value !== "number") errors.push(`modifier "${mid}": ${m.type} value must be a number`);
}

/* ---------- coverage (warn only -- see docs/curation/search-coverage-gaps.md) ---------- */

for (const [cid, c] of Object.entries(concepts)) {
  const covered = (c.terms || []).some((t) => SE.tagDF(t, ctx) > 0 || SE.corpusDF(t, ctx) > 0);
  if (!covered) warnings.push(`concept "${cid}": none of its terms hit any item tag/title/hook -- zero catalog coverage`);
}

/* ---------- the nutrition-leak tripwire ----------
   A term inside a concept's own list that is (a) not the concept's own id
   and (b) broad (high corpus frequency) can, when propagated to an UNRELATED
   query token via the `related` chain, single-handedly out-score a genuine
   match on an item that has nothing to do with the query. search-engine.js
   now caps `related`-sourced terms to title/hook/show bonuses only (see
   addTerm()'s `source` tracking), which bounds the damage -- but a broad
   term should still not be sitting in a concept's term list in the first
   place; flag it so a human decides whether it belongs. */

for (const [cid, c] of Object.entries(concepts)) {
  for (const term of c.terms || []) {
    if (term === cid) continue;
    const df = SE.corpusDF(term, ctx);
    if (df >= SE.BROAD_DF_THRESHOLD) {
      warnings.push(
        `concept "${cid}": term "${term}" is broad (${(df * 100).toFixed(1)}% of catalog) -- ` +
        `if another concept links to "${cid}" as \`related\`, this term can leak into unrelated matches. ` +
        `Confirm it's genuinely core to "${cid}", not an overloaded/generic word.`
      );
    }
  }
}

/* ---------- report ---------- */

console.log(`${Object.keys(concepts).length} concepts, ${Object.keys(modifiers).length} modifiers checked.`);
console.log(`${errors.length} errors, ${warnings.length} warnings.\n`);

if (warnings.length) {
  console.log("WARNINGS (non-fatal):");
  warnings.forEach((w) => console.log("  - " + w));
  console.log("");
}

if (errors.length) {
  console.log("ERRORS:");
  errors.forEach((e) => console.log("  - " + e));
  console.log("");
  process.exit(1);
}

console.log("semantic-index.json is structurally valid.");
