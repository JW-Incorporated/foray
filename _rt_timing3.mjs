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
const ctx = { semantic, itemTags, discover };

// warm up
for (const q of ["nuclear fusion energy","startups and venture capital"]) {
  const interp = SE.interpretQuery(q, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  SE.classifyResults(results, {});
}

// Now time interpretQuery vs searchWithRelaxation separately, repeatedly, same query, warm memo
const q = "nuclear fusion energy";
for (let i=0;i<5;i++) {
  const t0 = process.hrtime.bigint();
  const interp = SE.interpretQuery(q, ctx);
  const t1 = process.hrtime.bigint();
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const t2 = process.hrtime.bigint();
  console.log(`run ${i}: interp=${(Number(t1-t0)/1e6).toFixed(2)}ms search=${(Number(t2-t1)/1e6).toFixed(2)}ms results=${results.length}`);
}
