import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

console.log("itemTags.tags entries:", Object.keys(itemTags.tags || {}).length);
console.log("discover.items:", discover.items.length);
console.log("semantic.concepts:", Object.keys(semantic.concepts || {}).length);
console.log("semantic.modifiers:", Object.keys(semantic.modifiers || {}).length);

const ctx = { semantic, itemTags, discover };

// Direct microbenchmark of tagCount/corpusDF for one cold term.
let t0 = Date.now();
const c1 = SE.tagCount("philosophy", ctx);
console.log("tagCount('philosophy') cold:", Date.now() - t0, "ms ->", c1);

t0 = Date.now();
const d1 = SE.corpusDF("philosophy", ctx);
console.log("corpusDF('philosophy') cold:", Date.now() - t0, "ms ->", d1);

// Full interpretQuery timing broken into phases via process.hrtime for one term.
t0 = process.hrtime.bigint();
const interp = SE.interpretQuery("philosophy", ctx);
let t1 = process.hrtime.bigint();
console.log("interpretQuery('philosophy'):", Number(t1 - t0) / 1e6, "ms, groups:", interp.groups.length);
