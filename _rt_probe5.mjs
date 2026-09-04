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
function run(query) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  if (!interp.groups.length && !interp.filters.length) return null;
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, {});
  return { query, status, picks };
}
// Gather candidate query terms from semantic-index concepts
const concepts = semantic.concepts || {};
const terms = new Set();
for (const c of Object.values(concepts)) (c.terms||[]).forEach(t => terms.add(t));
console.log("num terms", terms.size);
let worst = [];
let n=0;
for (const t of terms) {
  n++;
  if (n % 200 === 0) console.error("progress", n);
  const r = run(t);
  if (!r || r.status === "empty") continue;
  const counts = {};
  r.picks.forEach(p => counts[p.i.show] = (counts[p.i.show]||0)+1);
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const [topShow, topCount] = entries[0];
  const frac = topCount / r.picks.length;
  if (topCount >= 4) worst.push({ q: t, status: r.status, total: r.picks.length, topShow, topCount, frac: +frac.toFixed(2) });
}
worst.sort((a,b)=>b.topCount-a.topCount);
console.log(JSON.stringify(worst.slice(0,25), null, 1));
