import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".");
const require = createRequire(import.meta.url);
const SE = require(join(ROOT, "search-engine.js"));
const discover = JSON.parse(readFileSync(join(ROOT, "data/discover.json"), "utf8"));
const itemTags = JSON.parse(readFileSync(join(ROOT, "data/item-tags.json"), "utf8"));
const semantic = JSON.parse(readFileSync(join(ROOT, "data/semantic-index.json"), "utf8"));
const session = JSON.parse(readFileSync(join(ROOT, "data/session.json"), "utf8"));
let validated = {};
try { validated = JSON.parse(readFileSync(join(ROOT, "data/validated-links.json"), "utf8")); } catch(e) {}
function fullPool() {
  const pool = []; const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    const ep = session.episodes[id];
    const v = validated?.episodes?.[id];
    const src = v ? { ...ep, apple_track_id: ep.apple_track_id ?? v.apple_track_id, artwork_url: v.artwork_url || ep.artwork_url || null, apple_episode_url: v.apple_episode_url || null } : ep;
    pool.push({ id, show: src.show, title: src.title, apple_collection_id: src.apple_collection_id,
      apple_track_id: src.apple_track_id ?? null, apple_episode_url: src.apple_episode_url ?? null,
      duration_min: src.duration_min ?? null, artwork_url: src.artwork_url ?? null,
      topics: src.topics || [], hook: src.hook || src.summary || src.title });
    seen.add(id);
  }
  for (const item of discover.items) if (!seen.has(item.id)) pool.push(item);
  return pool;
}
const pool = fullPool();
function freshCtx() { return { semantic, itemTags, discover }; }
const queries = ["nuclear fusion energy","startups and venture capital","true crime cold case","video games","politics","psychology","murder","climate change","self improvement","comedy"];
let total = 0;
const timings = [];
for (const q of queries) {
  const t0 = process.hrtime.bigint();
  const ctx = freshCtx();
  const interp = SE.interpretQuery(q, ctx);
  const t1 = process.hrtime.bigint();
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const t2 = process.hrtime.bigint();
  const { status } = SE.classifyResults(results, {});
  const t3 = process.hrtime.bigint();
  const interpMs = Number(t1-t0)/1e6, searchMs = Number(t2-t1)/1e6, classifyMs = Number(t3-t2)/1e6;
  timings.push({q, interpMs: +interpMs.toFixed(3), searchMs: +searchMs.toFixed(3), classifyMs: +classifyMs.toFixed(3), status, resultsN: results.length});
  total += interpMs+searchMs+classifyMs;
}
console.log(JSON.stringify(timings, null, 1));
console.log("total ms for 10 queries (single run each):", total.toFixed(2));

// Now loop the same query 50 times to see per-call cost / caching
const q = "nuclear fusion energy";
const t0 = process.hrtime.bigint();
for (let i=0;i<50;i++) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(q, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  SE.classifyResults(results, {});
}
const t1 = process.hrtime.bigint();
console.log("50x same query total ms:", (Number(t1-t0)/1e6).toFixed(2), "avg ms/call:", (Number(t1-t0)/1e6/50).toFixed(3));
