import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

console.log("catalog size:", discover.items.length);

// Simulate a real session: ONE ctx object created once (as app.js's searchCtx()
// does), then several DIFFERENT single-word queries typed by a user in sequence
// (a realistic session, not a repeat of the same word).
const ctx = { semantic, itemTags, discover };
const words = ["grilling", "philosophy", "startups", "meditation", "hiking", "wine", "true crime", "comedy", "politics", "science"];
for (const w of words) {
  const t0 = Date.now();
  const interp = SE.interpretQuery(w, ctx);
  const t1 = Date.now();
  const { results } = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  const t2 = Date.now();
  console.log(`q="${w}": interpretQuery=${t1-t0}ms search=${t2-t1}ms results=${results.length}`);
}
