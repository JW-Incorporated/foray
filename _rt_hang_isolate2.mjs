import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

function freshCtx() { return { semantic, itemTags, discover }; }

for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const q = "history ".repeat(n);
  const ctx = freshCtx();
  const t0 = Date.now();
  const interp = SE.interpretQuery(q, ctx);
  const t1 = Date.now();
  console.log(`n=${n}: dt=${t1-t0}ms groups=${interp.groups.length}`);
}
