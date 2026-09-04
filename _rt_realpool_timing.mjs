import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));
const session = JSON.parse(readFileSync("data/session.json", "utf8"));

function fullPool() {
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    pool.push(session.episodes[id]);
    seen.add(id);
  }
  for (const item of discover.items) if (!seen.has(item.id)) pool.push(item);
  return pool;
}
const pool = fullPool();
console.log("real client pool size:", pool.length);

const ctx = { semantic, itemTags, discover };
// Simulate a REAL session's sequence: user types one query, gets a playlist,
// tab switches away, comes back, types another. That's buildPlaylist's actual
// call pattern in app.js: one ctx, reused, calls interpretQuery then
// searchWithRelaxation then classifyResults, once per submitted query.
for (const q of ["philosophy of science", "startups and venture capital", "true crime", "history"]) {
  const t0 = Date.now();
  const interp = SE.interpretQuery(q, ctx);
  const t1 = Date.now();
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const t2 = Date.now();
  const { status, picks } = SE.classifyResults(results, {});
  const t3 = Date.now();
  console.log(`q="${q}": interpret=${t1-t0}ms search=${t2-t1}ms classify=${t3-t2}ms status=${status} picks=${picks.length}`);
}
