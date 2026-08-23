/* Breadth-tier catalog harvester — see docs/CATALOG-PIPELINE.md.
   Apple genre tree -> per-genre top charts -> batched lookups ->
   data/catalog-breadth.json. Idempotent; re-run to refresh.

   Usage: node tools/harvest-catalog.mjs [--genres N] [--out path]
     --genres N   limit to first N subgenres (smoke testing)               */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA } from "./segments/politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THROTTLE_MS = 3000;
const CHART_LIMIT = 200;
const LOOKUP_BATCH = 150;

const args = process.argv.slice(2);
const genreLimit = args.includes("--genres") ? Number(args[args.indexOf("--genres") + 1]) : Infinity;
const REGIONS = (args.includes("--regions") ? args[args.indexOf("--regions") + 1] : "us").split(",");
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "data", "catalog-breadth.json");
// --exclude a,b: breadth files whose collectionIds are skipped (saves lookup
// calls and keeps harvest batches disjoint)
const excludeIds = new Set();
if (args.includes("--exclude")) {
  for (const p of args[args.indexOf("--exclude") + 1].split(",")) {
    try {
      JSON.parse(readFileSync(join(ROOT, p), "utf8")).shows.forEach(s => excludeIds.add(s.apple_collection_id));
    } catch (e) { console.warn(`exclude file ${p} unreadable: ${e.message}`); }
  }
  console.log(`excluding ${excludeIds.size} already-harvested ids`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Long runs get killed by session limits; checkpoint after every genre and
   every lookup batch so a re-run resumes instead of restarting. */
const CKPT = outPath + ".checkpoint";
function loadCkpt() {
  const defaults = { doneGenres: [], chartRows: {}, lookedUpBatches: 0, shows: [] };
  try { return { ...defaults, ...JSON.parse(readFileSync(CKPT, "utf8")) }; } catch (_) {
    return defaults;
  }
}
function saveCkpt(c) { writeFileSync(CKPT, JSON.stringify(c)); }

async function fetchJson(url, attempt = 1) {
  await sleep(THROTTLE_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`HTTP ${res.status} after ${attempt} tries: ${url}`);
      const backoff = THROTTLE_MS * Math.pow(2, attempt);
      console.warn(`  ${res.status} -> backing off ${backoff}ms`);
      await sleep(backoff);
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.json();
  } catch (e) {
    if (attempt >= 4) throw e;
    await sleep(THROTTLE_MS * Math.pow(2, attempt));
    return fetchJson(url, attempt + 1);
  }
}

function flattenGenres(node, out = []) {
  out.push({ id: node.id, name: node.name });
  for (const child of Object.values(node.subgenres || {})) flattenGenres(child, out);
  return out;
}

async function main() {
  console.log("1/3 genre tree…");
  const genreRoot = await fetchJson("https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?id=26");
  const podcastsNode = genreRoot["26"];
  if (!podcastsNode) throw new Error("genre tree shape changed — no id 26");
  // skip the root itself; harvest every subgenre (parents + leaves both chart)
  const genres = flattenGenres(podcastsNode).filter(g => g.id !== "26").slice(0, genreLimit);
  console.log(`   ${genres.length} genres`);

  console.log(`2/3 top charts: ${REGIONS.length} region(s) × ${genres.length} genres…`);
  const ckpt = loadCkpt();
  const doneGenres = new Set(ckpt.doneGenres); // keys: "region:genreId"
  const chartRows = new Map(Object.entries(ckpt.chartRows).map(([k, v]) => [Number(k), v]));
  let failedGenres = 0;
  for (const region of REGIONS) {
    for (const [i, g] of genres.entries()) {
      const key = `${region}:${g.id}`;
      if (doneGenres.has(key)) continue;
      const url = `https://itunes.apple.com/${region}/rss/toppodcasts/limit=${CHART_LIMIT}/genre=${g.id}/json`;
      try {
        const feed = await fetchJson(url);
        const entries = feed?.feed?.entry || [];
        const list = Array.isArray(entries) ? entries : [entries];
        list.forEach((e, idx) => {
          const cid = Number(e?.id?.attributes?.["im:id"]);
          if (!cid || excludeIds.has(cid)) return;
          const prev = chartRows.get(cid);
          if (!prev || idx + 1 < prev.rank) {
            chartRows.set(cid, { rank: idx + 1, genreId: g.id, genreName: g.name, region });
          }
        });
        if ((i + 1) % 20 === 0) console.log(`   [${region}] ${i + 1}/${genres.length} genres, ${chartRows.size} unique new shows`);
      } catch (e) {
        failedGenres++;
        console.warn(`   [${region}] genre ${g.id} failed: ${e.message}`);
      }
      doneGenres.add(key);
      ckpt.doneGenres = [...doneGenres];
      ckpt.chartRows = Object.fromEntries(chartRows);
      saveCkpt(ckpt);
    }
    console.log(`   [${region}] complete — ${chartRows.size} unique new shows so far`);
  }
  console.log(`   charts done: ${chartRows.size} unique shows (${failedGenres} genre-fetches failed this run)`);

  console.log("3/3 batched lookups…");
  const curated = existsSync(join(ROOT, "data", "catalog.json"))
    ? new Set(JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")).shows.map(s => s.apple_collection_id))
    : new Set();

  const ids = [...chartRows.keys()].sort((a, b) => a - b); // stable order for batch resume
  const shows = ckpt.shows;
  for (let i = ckpt.lookedUpBatches * LOOKUP_BATCH; i < ids.length; i += LOOKUP_BATCH) {
    const batch = ids.slice(i, i + LOOKUP_BATCH);
    try {
      const data = await fetchJson(`https://itunes.apple.com/lookup?id=${batch.join(",")}&entity=podcast`);
      for (const r of data.results || []) {
        if (r.kind !== "podcast" || !r.collectionId) continue;
        const chart = chartRows.get(r.collectionId) || {};
        shows.push({
          apple_collection_id: r.collectionId,
          title: r.collectionName ?? null,
          feed_url: r.feedUrl ?? null,
          artwork_url: r.artworkUrl600 ?? null,
          apple_genre: r.primaryGenreName ?? null,
          apple_genre_ids: r.genreIds ?? [],
          episode_count: r.trackCount ?? null,
          explicit: r.collectionExplicitness === "explicit",
          chart_genre_id: chart.genreId ?? null,
          chart_genre_name: chart.genreName ?? null,
          chart_rank: chart.rank ?? null,
          in_curated: curated.has(r.collectionId),
          podcastindex_id: null,
          tier: "breadth",
          region: chart.region ?? REGIONS[0],
          harvest_source: "apple-top-charts",
          harvested_at: new Date().toISOString(),
        });
      }
      console.log(`   ${Math.min(i + LOOKUP_BATCH, ids.length)}/${ids.length} looked up (${shows.length} kept)`);
    } catch (e) {
      console.warn(`   lookup batch at ${i} failed: ${e.message}`);
    }
    ckpt.lookedUpBatches = Math.floor(i / LOOKUP_BATCH) + 1;
    ckpt.shows = shows;
    saveCkpt(ckpt);
  }

  // final dedupe (lookup can echo an id twice across batches)
  const seen = new Set();
  const unique = shows.filter(s => !seen.has(s.apple_collection_id) && seen.add(s.apple_collection_id));

  const doc = {
    version: 1,
    built_at: new Date().toISOString(),
    regions: REGIONS,
    source: "apple-top-charts+lookup",
    genre_count: genres.length,
    shows: unique,
  };
  writeFileSync(outPath, JSON.stringify(doc) + "\n");
  try { writeFileSync(CKPT, "{}"); } catch (_) {}
  console.log(`WROTE ${outPath}: ${unique.length} shows (${unique.filter(s => s.feed_url).length} with feed URLs, ${unique.filter(s => s.in_curated).length} overlap curated tier)`);
  console.log("HARVEST_COMPLETE");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
