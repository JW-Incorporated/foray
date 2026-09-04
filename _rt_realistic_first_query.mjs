import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

// Realistic FIRST-EVER query in a brand new session (cold ctx, as every real
// user's FIRST playlist build is) -- this is the number that matters for a
// user typing into pl-input and hitting Go for the first time this session.
const ctx = { semantic, itemTags, discover };
const t0 = Date.now();
const interp = SE.interpretQuery("philosophy of science", ctx);
const t1 = Date.now();
const { results } = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
const t2 = Date.now();
console.log(`FIRST query of a session, "philosophy of science": interpret=${t1-t0}ms search=${t2-t1}ms total=${t2-t0}ms`);

// Now the SECOND query in the SAME session (ctx now has warm memo caches
// from the first query's term expansion, which is realistic -- but a totally
// different topic means mostly-cold terms again).
const t3 = Date.now();
const interp2 = SE.interpretQuery("grilling techniques", ctx);
const t4 = Date.now();
const { results: results2 } = SE.searchWithRelaxation(discover.items, interp2, 2, itemTags, () => 0.5);
const t5 = Date.now();
console.log(`SECOND query, different topic, "grilling techniques": interpret=${t4-t3}ms search=${t5-t4}ms total=${t5-t3}ms`);
