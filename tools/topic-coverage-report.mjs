/* Cross-references data/top-topics.json (the ranked list of what a general
   user actually searches for) against:
     - data/discover.json      (curated-tier catalogue items + topics)
     - data/item-tags.json     (per-item keyword tags)
     - data/semantic-index.json (compiled search concepts + modifiers)
     - data/breadth-classification.json (19.7k-show breadth tier, chart-ranked,
       already genre-mapped to the taxonomy — see docs/CATALOG-PIPELINE.md)

   Produces data/topic-coverage-report.json: per-topic catalogue depth, tag
   depth, semantic-search status (covered / misrouted / missing / no-node),
   breadth-tier supply, and a recommended action. Also runs an independent
   scan of ALL semantic-index.json concepts for "misrouted" concepts — a
   concept whose `terms` imply a taxonomy node/branch its `topics` field
   doesn't include (the bug class caught in storytelling -> true-crime).

   This machine-readable report is the handoff artifact for the sibling
   agent improving the search engine (app.js + semantic-index.json) — it
   should not need to re-derive any of this.

   Matching semantics are IMPORTED from search-engine.js (hitTag/hitText), not
   copied, so "coverage" here means what a user actually gets from search today
   rather than an idealized match. That claim used to be false: this file kept
   its own looser copy and over-counted. See the matching-semantics section
   below for what changed and for the one helper (tokenize) deliberately left
   unshared.

   Usage: node tools/topic-coverage-report.mjs [--out path] */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const SE = require(join(ROOT, "search-engine.js"));
const args = process.argv.slice(2);
const outPath = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : join(ROOT, "data", "topic-coverage-report.json");

const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const topTopics = readJson("data/top-topics.json").topics;
const discover = readJson("data/discover.json").items;
const itemTags = readJson("data/item-tags.json").tags;
const semantic = readJson("data/semantic-index.json");
const breadth = readJson("data/breadth-classification.json").entries;
const taxonomy = readJson("data/taxonomy.json").nodes;

const nodeIds = new Set(taxonomy.map((n) => n.id));
const branchOf = (nodeId) => nodeId.split("/")[0];

/* ---------- matching semantics ----------------------------------------------
   `hitText`/`hitTag` are IMPORTED from search-engine.js, not reimplemented
   (#219). This file used to hold the THIRD copy of them, and it was the loose
   one: bare `text.includes(t)` / `tag.includes(t)`, with none of the ranker's
   collision guard. So it accepted `software` and `toward` for "war", `romance`
   for "roman", `confusion` for "fusion" -- the exact collisions
   search-engine.js documents and tools/test-search.mjs asserts the ranker must
   not make. That made this report OPTIMISTIC, which is the one direction that
   matters: it reported a topic as covered when search would not return it, so
   it hid gaps rather than inventing them. The header's claim that coverage here
   means "what a user actually gets from search today" is only true if the
   matcher is literally the one search uses.

   Three copies existed and two disagreed with the ranker; the copies are how
   they drifted. test/search-matcher.test.js now fails if any file reimplements
   these helpers instead of importing them.

   `tokenize` and `STOPWORDS` below are deliberately NOT shared, and that is a
   decision rather than an oversight. This file's STOPWORDS carries question
   words search-engine.js's does not ("how", "does", "is", "are", "works",
   "what", "explained") because its input is a topic's hand-written
   `example_queries`, not a live query box. More importantly, search-engine.js's
   tokenize filters GENERIC_WORDS unconditionally, while coreTermsFor() below
   must keep a generic word when it IS the topic's own label -- that is what
   stops the "History" topic from being unable to anchor on itself. Sharing
   tokenize would silently change which terms every topic is measured on, which
   is a coverage-methodology change wearing a deduplication costume. Do it in
   its own PR against its own before/after, or not at all. */

const STOPWORDS = new Set([
  "a", "an", "the", "about", "series", "playlist", "of", "on", "for", "me", "my",
  "give", "build", "make", "with", "to", "and", "or", "in", "podcast", "podcasts",
  "episode", "episodes", "show", "shows", "some", "something", "want", "i",
  "please", "that", "stuff", "things", "how", "does", "do", "is", "are", "works",
  "work", "what", "explained",
]);

function tokenize(q) {
  const base = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(base)];
}

const { hitText, hitTag } = SE;

/* Words so generic they're substrings of dozens of unrelated concept ids/tags
   (e.g. "-history" tags on film/music/computing/engineering/science items all
   contain "history") — without this filter a niche topic like "jazz" picks up
   "history" from its own "jazz history" example query and inherits every
   *-history concept's coverage, producing a bogus catalogue/tag count. Kept
   only when the word is part of the topic's own label (so the "History" or
   "Business" topics still anchor on themselves). */
const GENERIC_WORDS = new Set([
  "history", "business", "science", "technology", "story", "stories", "culture",
  "industry", "world", "life", "talk", "talks", "advice", "tips", "stuff", "real",
  "best", "top", "modern", "interview", "interviews",
]);

/* A topic entry's "core terms" = tokenized label + all example_queries,
   deduped, minus over-broad generic words unless they're literally the
   topic's own label. This is what we test against tags/titles/concepts. */
function coreTermsFor(topic) {
  const labelWords = tokenize(topic.label);
  const words = [...labelWords];
  (topic.example_queries || []).forEach((q) => tokenize(q).forEach((w) => words.push(w)));
  const deduped = [...new Set(words)];
  return deduped.filter((w) => !GENERIC_WORDS.has(w) || labelWords.includes(w));
}

/* union match: item/entry topics hit target nodes directly, OR via branch
   rollup when the TARGET itself is a bare top-level branch (e.g. "sports"
   must catch "sports/football"). A specific-subnode target like
   "health/mental" must NOT roll up to the whole "health" branch — that
   would silently inflate e.g. Mental Health's count to all of Health. */
function nodesMatch(itemTopics, targetNodes) {
  if (!itemTopics || !itemTopics.length || !targetNodes.length) return false;
  const rollupBranches = new Set(targetNodes.filter((n) => !n.includes("/")));
  return itemTopics.some((t) => targetNodes.includes(t) || rollupBranches.has(branchOf(t)));
}

/* ---------- per-topic coverage ---------- */

const FUSION_BUG_NODE = "engineering/energy-fusion"; // issue #12 — 46 discover.json items
                                                       // mistagged; counts here are noisy for
                                                       // this node, cross-check item-tags.

const report = [];

for (const topic of topTopics) {
  const nodes = topic.taxonomy_nodes || [];
  const terms = coreTermsFor(topic);

  const catalogItems = nodes.length ? discover.filter((i) => nodesMatch(i.topics, nodes)) : [];
  const catalog_count = catalogItems.length;

  let tag_count = 0;
  for (const tags of Object.values(itemTags)) {
    if (terms.some((t) => tags.some((tag) => hitTag(tag, t)))) tag_count++;
  }

  let text_hits = 0;
  for (const item of discover) {
    const hay = [item.title, item.hook || "", item.show].join(" ").toLowerCase();
    if (terms.some((t) => hitText(hay, t))) text_hits++;
  }

  // semantic-index status: does any concept whose terms overlap this topic's
  // terms actually route its `topics` at this node/branch? Skipped entirely
  // for no-node topics — there's nothing to route to, and scanning would
  // only surface generic-word noise (e.g. jazz -> the "history" concept).
  let semantic_status = "missing";
  let semantic_concepts = [];
  if (!nodes.length) {
    semantic_status = "no-node";
  } else {
    // exact membership only — mirrors interpretQuery()'s `c.terms?.includes(tok)`
    // gate in app.js, which triggers a concept on an exact query token, never a
    // substring (that would over-match e.g. "crime" against ocean's "maritime-crime")
    const supportingConcepts = [];
    for (const [cid, c] of Object.entries(semantic.concepts)) {
      const conceptTerms = c.terms || [];
      if (terms.some((t) => conceptTerms.includes(t))) {
        supportingConcepts.push({ id: cid, topics: c.topics || [] });
      }
    }
    if (supportingConcepts.length) {
      const routed = supportingConcepts.filter((c) => nodesMatch(c.topics, nodes));
      if (routed.length) {
        semantic_status = "covered";
        semantic_concepts = routed.map((c) => c.id);
      } else {
        semantic_status = "misrouted";
        semantic_concepts = supportingConcepts.map((c) => `${c.id} -> [${c.topics.join(", ") || "EMPTY"}]`);
      }
    }
  }

  const breadth_supply = nodes.length
    ? Object.values(breadth).filter((e) => nodesMatch(e.topics, nodes)).length
    : 0;

  const fusion_bug_flagged = nodes.includes(FUSION_BUG_NODE);

  // content depth bucket (catalogue-only, ignores search quality)
  const content_depth = !nodes.length ? "no-node" : catalog_count === 0 ? "absent" : catalog_count < 15 ? "thin" : "deep";

  // recommended actions — can be more than one
  const actions = [];
  if (!nodes.length) {
    actions.push("needs-taxonomy-adr");
  } else {
    if (content_depth !== "absent" && semantic_status !== "covered") {
      // content exists (even thinly) but search can't find it well — cheap, high-leverage
      actions.push("semantic-concept-fix");
    }
    if ((content_depth === "absent" || content_depth === "thin") && breadth_supply >= 20) {
      actions.push("promote-from-breadth");
    }
    if (content_depth === "thin" && tag_count > catalog_count * 2 && breadth_supply < 20) {
      actions.push("retag-existing");
    }
    if (content_depth === "absent" && breadth_supply < 20 && tag_count < 3) {
      actions.push("defer");
    }
    if (!actions.length) actions.push("none");
  }

  // priority: 1 = fix now, 5 = no lever / not worth it. Search-discoverable-
  // but-not-found on real content is the cheapest, highest-leverage class.
  let priority;
  if (actions.includes("semantic-concept-fix") && topic.tier === 1) priority = 1;
  else if (actions.includes("semantic-concept-fix")) priority = 2;
  else if (actions.includes("promote-from-breadth") && topic.tier <= 2) priority = 2;
  else if (actions.includes("promote-from-breadth")) priority = 3;
  else if (actions.includes("retag-existing") || actions.includes("needs-taxonomy-adr")) priority = 4;
  else if (actions.includes("defer")) priority = 5;
  else priority = 6; // none needed — already well served

  report.push({
    id: topic.id,
    label: topic.label,
    tier: topic.tier,
    taxonomy_nodes: nodes,
    catalog_count,
    tag_count,
    text_hits,
    content_depth,
    semantic_status,
    semantic_concepts,
    breadth_supply,
    fusion_bug_flagged,
    recommended_actions: actions,
    priority,
  });
}

report.sort((a, b) => a.priority - b.priority || b.tier <= a.tier ? (a.tier - b.tier) : 0);

/* ---------- independent scan: ALL semantic-index concepts for misroutes ----
   A concept is flagged when one of its own `terms` exactly names a taxonomy
   node id (or a top-level branch id) that its `topics` field does not
   include (directly or via branch). This is the general form of the
   storytelling -> true-crime bug: a concept whose vocabulary clearly spans a
   taxonomy area its topics field never points at. */

const topLevelBranches = new Set(taxonomy.filter((n) => !n.parent).map((n) => n.id));
const concept_misroutes = [];

for (const [cid, c] of Object.entries(semantic.concepts)) {
  const topics = c.topics || [];
  const topicBranches = new Set(topics.map(branchOf));
  const flaggedTerms = new Set();
  for (const t of c.terms || []) {
    const impliedNode = nodeIds.has(t) ? t : topLevelBranches.has(t) ? t : null;
    if (!impliedNode) continue;
    if (!topicBranches.has(branchOf(impliedNode))) flaggedTerms.add(`${t} -> ${impliedNode}`);
  }
  if (flaggedTerms.size) {
    concept_misroutes.push({
      concept: cid,
      current_topics: topics.length ? topics : "EMPTY",
      flagged_terms: [...flaggedTerms],
    });
  }
}

const doc = {
  version: 1,
  built_at: new Date().toISOString(),
  provenance: {
    produced_by: "topic-coverage-report.mjs",
    method:
      "deterministic cross-reference; no LLM. tag_count/text_hits use " +
      "search-engine.js's exported hitTag/hitText directly (#219), so they are " +
      "the ranker's own matching semantics rather than a copy of them. Counts " +
      "before 2026-08-17 came from a looser local copy (bare substring, no " +
      "collision guard) and were optimistic.",
    inputs: [
      "data/top-topics.json",
      "data/discover.json",
      "data/item-tags.json",
      "data/semantic-index.json",
      "data/breadth-classification.json",
      "data/taxonomy.json",
    ],
  },
  notes:
    "issue #12 (discover.json items mistagged onto 'engineering/energy-fusion') was fixed " +
    "by retagging the 47 affected items to their correct nodes; the fusion node's counts " +
    "here now reflect real content only. semantic-index.json concepts still routing to " +
    "engineering/energy-fusion (e.g. 'physics', 'clean-energy') are a separate, unfixed " +
    "concern — see the misrouted-concept entries below. " +
    "recommended_actions is an array (a topic can need more than one). priority: " +
    "1=fix search now (tier-1 topic, real content, broken discovery), 2-3=search or " +
    "sourcing fix, 4=retag/taxonomy-governance, 5=defer (no lever today), 6=already fine. " +
    "This script does not replicate app.js's small ALIASES table (bbq/cooking/rome/ww2/" +
    "plane/car/ocean synonym expansion) — tag_count/text_hits for those ~10 words are a " +
    "slight underestimate of what real search actually returns; catalog_count and the " +
    "concept-misroute scan are unaffected (ALIASES only expands literal text tokens).",
  summary: {
    topics_evaluated: report.length,
    by_priority: report.reduce((acc, r) => ((acc[r.priority] = (acc[r.priority] || 0) + 1), acc), {}),
    by_semantic_status: report.reduce((acc, r) => ((acc[r.semantic_status] = (acc[r.semantic_status] || 0) + 1), acc), {}),
    by_content_depth: report.reduce((acc, r) => ((acc[r.content_depth] = (acc[r.content_depth] || 0) + 1), acc), {}),
    concept_misroutes_found: concept_misroutes.length,
  },
  topics: report,
  concept_misroutes,
};

writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${outPath}: ${report.length} topics, ${concept_misroutes.length} concept misroutes`);
console.log("by priority:", doc.summary.by_priority);
console.log("by semantic status:", doc.summary.by_semantic_status);
