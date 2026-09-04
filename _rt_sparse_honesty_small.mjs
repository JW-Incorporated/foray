import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));
const ctx = { semantic, itemTags, discover }; // ONE ctx, reused -- fast path

// Smaller honesty sample: 15 concept terms, reusing one warm ctx (as a real
// session would after its first query), checking classifyResults never pads
// a "sparse" result up to DEFAULT_CAP with off-bar filler.
const concepts = semantic.concepts || {};
const allTerms = [...new Set(Object.values(concepts).flatMap(c => c.terms || []))];
const sample = allTerms.slice(0, 25);

for (const t of sample) {
  const interp = SE.interpretQuery(t, ctx);
  if (!interp.groups.length) continue;
  const { results } = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, {});
  console.log(`q="${t}" status=${status} picks=${picks.length} totalCandidates=${results.length}`);
}
