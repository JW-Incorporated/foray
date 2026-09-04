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
function run(query, opts) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  if (!interp.groups.length && !interp.filters.length) return null;
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, opts);
  return { query, status, picks, results };
}

for (const q of ["productivity", "cold war", "casefile", "morbid", "dateline"]) {
  const r = run(q);
  if (!r) { console.log(q, "no interp"); continue; }
  const bar = r.results.length ? r.results[0].sum * SE.STRONG_RATIO : 0;
  const strong = r.results.filter(x => x.sum >= bar);
  const distinctStrongShows = new Set(strong.map(x=>x.i.show));
  const distinctResultShows = new Set(r.results.map(x=>x.i.show));
  const pickShowCounts = {};
  r.picks.forEach(p => pickShowCounts[p.i.show] = (pickShowCounts[p.i.show]||0)+1);
  console.log(JSON.stringify({
    q, status: r.status, resultsN: r.results.length, strongN: strong.length,
    distinctStrongShows: distinctStrongShows.size, distinctResultShows: distinctResultShows.size,
    pickShowCounts
  }, null, 0));
}
