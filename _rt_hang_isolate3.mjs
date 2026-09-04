import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

// Reuse ONE ctx across calls, as app.js's searchCtx() does across the session
// (per the file's own header: "callers should reuse one ctx per session/run").
const ctx = { semantic, itemTags, discover };

for (const q of ["history", "bbq", "startups", "history"]) {
  const t0 = Date.now();
  const interp = SE.interpretQuery(q, ctx);
  const t1 = Date.now();
  console.log(`q="${q}": dt=${t1-t0}ms groups=${interp.groups.length}`);
}

console.log("--- now with a fresh ctx each time (cold, as _redteam_probe.js does) ---");
for (const q of ["history", "history", "history"]) {
  const freshCtx2 = { semantic, itemTags, discover };
  const t0 = Date.now();
  const interp = SE.interpretQuery(q, freshCtx2);
  const t1 = Date.now();
  console.log(`q="${q}" (fresh ctx): dt=${t1-t0}ms groups=${interp.groups.length}`);
}
