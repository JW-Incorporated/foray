import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));
const ctx = { semantic, itemTags, discover };

// Empirically verify classifyResults does NOT pad a sparse result up toward
// DEFAULT_CAP with off-topic filler -- scan real concept terms for cases
// where status === "sparse" and confirm picks.length stays below DEFAULT_CAP
// (10) rather than being padded to it, and that "ok" playlists are never
// smaller than what strong matches actually support.
const concepts = semantic.concepts || {};
const terms = new Set();
for (const c of Object.values(concepts)) (c.terms || []).forEach(t => terms.add(t));

let sparseCount = 0, okCount = 0, emptyCount = 0;
let sparseSizes = [];
for (const t of terms) {
  const interp = SE.interpretQuery(t, ctx);
  if (!interp.groups.length) continue;
  const { results } = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, {});
  if (status === "sparse") { sparseCount++; sparseSizes.push(picks.length); }
  else if (status === "ok") okCount++;
  else emptyCount++;
}
console.log(`terms tested: ${terms.size}, sparse=${sparseCount} ok=${okCount} empty=${emptyCount}`);
console.log("sparse pick-count distribution (should mostly be < 10 = DEFAULT_CAP, i.e. NOT padded):",
  JSON.stringify(sparseSizes.sort((a,b)=>a-b)));
console.log("DEFAULT_CAP:", SE.DEFAULT_CAP, "RICH_MIN:", SE.RICH_MIN);
