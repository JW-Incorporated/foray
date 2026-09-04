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
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    const ep = session.episodes[id];
    const v = validated?.episodes?.[id];
    const src = v ? { ...ep, apple_track_id: ep.apple_track_id ?? v.apple_track_id, artwork_url: v.artwork_url || ep.artwork_url || null, apple_episode_url: v.apple_episode_url || null } : ep;
    pool.push({
      id, show: src.show, title: src.title,
      apple_collection_id: src.apple_collection_id,
      apple_track_id: src.apple_track_id ?? null,
      apple_episode_url: src.apple_episode_url ?? null,
      duration_min: src.duration_min ?? null,
      artwork_url: src.artwork_url ?? null,
      topics: src.topics || [],
      hook: src.hook || src.summary || src.title,
    });
    seen.add(id);
  }
  for (const item of discover.items) {
    if (!seen.has(item.id)) pool.push(item);
  }
  return pool;
}
const pool = fullPool();
console.log("pool size", pool.length);

function freshCtx() { return { semantic, itemTags, discover }; }

function run(query, opts) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  if (!interp.groups.length && !interp.filters.length) return { status: "empty-no-interp", query };
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, opts);
  return { query, status, picksN: picks.length, resultsN: results.length, picks };
}

const queries = [
  "nuclear fusion energy","startups and venture capital","how bbq works","smartless",
  "true crime cold case","plane crashes","video games","train history","meditation",
  "nba","politics","stock market","basketball","grill","world war 2","lex fridman",
  "comedy","something short","parenting","relationships","design","paranormal",
  "stand-up comedy","nutrition","fiction audio drama","gardening","chess","murder",
  "history of jazz","climate change","artificial intelligence","cryptocurrency",
  "space exploration","ancient rome","world cup","serial killers","true crime",
  "self improvement","productivity","sleep science","running","cooking","wine",
  "startup founders","interview with scientist","physics","psychology","economics",
  "poker","chess strategy","board games","true crime murder mystery","conspiracy theories",
  "joe rogan","tim ferriss","huberman","football","soccer","baseball","tennis",
  "cold war","vietnam war","serial","dateline","casefile","morbid","freakonomics",
];

const rows = queries.map(q => run(q));
for (const r of rows) {
  if (r.status === "empty-no-interp") { console.log(r.query, "-> no-interp"); continue; }
  const showCounts = {};
  for (const p of r.picks) showCounts[p.i.show] = (showCounts[p.i.show]||0)+1;
  const maxShow = Object.entries(showCounts).sort((a,b)=>b[1]-a[1])[0];
  console.log(JSON.stringify({q:r.query, status:r.status, picksN:r.picksN, resultsN:r.resultsN, topShow: maxShow}));
}
