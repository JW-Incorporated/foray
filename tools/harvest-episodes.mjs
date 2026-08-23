/* Full episode archives for the top-N shows. The iTunes API caps episode
   lookups at ~300; the public RSS feed IS the complete catalog (modulo
   publisher-side feed caps, which we measure and flag per show).

   Usage: node tools/harvest-episodes.mjs [--top N] [--out path]           */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { UA } from "./segments/politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// reuse the backend's battle-tested lenient XML parser
const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
const { XMLParser } = backendRequire("fast-xml-parser");

const THROTTLE_MS = 2500;
const args = process.argv.slice(2);
const TOP_N = args.includes("--top") ? Number(args[args.indexOf("--top") + 1]) : 100;
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "data", "episode-archive.json");
const CKPT = outPath + ".checkpoint";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, attempt = 1) {
  await sleep(THROTTLE_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(THROTTLE_MS * Math.pow(2, attempt));
    return fetchText(url, attempt + 1);
  }
}

function normDuration(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Math.round(Number(s) / 60);
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return Math.round(parts[0] * 60 + parts[1] + parts[2] / 60);
  if (parts.length === 2) return Math.round(parts[0] + parts[1] / 60);
  return null;
}

const text = (v) => (v == null ? null : typeof v === "object" ? (v["#text"] ?? null) : String(v));

function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) return null;
  let items = channel.item || [];
  if (!Array.isArray(items)) items = [items];
  return items.map(it => {
    const enc = it.enclosure || {};
    const desc = text(it.description) || text(it["itunes:summary"]) || "";
    return {
      guid: text(typeof it.guid === "object" ? it.guid["#text"] ?? it.guid : it.guid),
      title: text(it.title),
      published_at: (() => {
        // malformed pubDates exist in real feeds — never let one kill a show
        try { const d = new Date(it.pubDate); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
        catch (_) { return null; }
      })(),
      duration_min: normDuration(it["itunes:duration"]),
      enclosure_url: enc["@_url"] ?? null,
      link: text(it.link),
      episode: it["itunes:episode"] ?? null,
      season: it["itunes:season"] ?? null,
      description: String(desc).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280),
    };
  }).filter(e => e.title);
}

function loadCkpt() {
  try { return JSON.parse(readFileSync(CKPT, "utf8")); } catch (_) { return { doneIds: [], shows: [] }; }
}

async function main() {
  console.log("1/3 overall top chart…");
  const chart = JSON.parse(await fetchText(`https://itunes.apple.com/us/rss/toppodcasts/limit=200/json`));
  const topIds = (chart.feed.entry || []).map(e => Number(e?.id?.attributes?.["im:id"])).filter(Boolean).slice(0, TOP_N);
  console.log(`   top ${topIds.length} shows`);

  console.log("2/3 resolve feed URLs…");
  const known = new Map();
  for (const p of ["data/catalog-breadth.json", "data/catalog.json"]) {
    if (!existsSync(join(ROOT, p))) continue;
    JSON.parse(readFileSync(join(ROOT, p), "utf8")).shows.forEach(s => {
      if (s.feed_url) known.set(s.apple_collection_id, { feed_url: s.feed_url, title: s.title });
    });
  }
  const missing = topIds.filter(id => !known.has(id));
  if (missing.length) {
    const data = JSON.parse(await fetchText(`https://itunes.apple.com/lookup?id=${missing.join(",")}&entity=podcast`));
    for (const r of data.results || []) {
      if (r.collectionId && r.feedUrl) known.set(r.collectionId, { feed_url: r.feedUrl, title: r.collectionName });
    }
  }
  const noFeed = topIds.filter(id => !known.has(id));
  console.log(`   resolved ${topIds.length - noFeed.length}/${topIds.length}; no public feed: ${noFeed.join(",") || "none"}`);

  console.log("3/3 parse full feeds…");
  const ckpt = loadCkpt();
  const done = new Set(ckpt.doneIds);
  for (const [i, id] of topIds.entries()) {
    if (done.has(id) || !known.has(id)) continue;
    const { feed_url, title } = known.get(id);
    try {
      const xml = await fetchText(feed_url);
      const episodes = parseFeed(xml);
      if (!episodes) throw new Error("unparseable feed");
      ckpt.shows.push({
        apple_collection_id: id, title, feed_url,
        chart_rank_overall: topIds.indexOf(id) + 1,
        episode_count_in_feed: episodes.length,
        feed_capped_suspect: episodes.length > 0 && episodes.length <= 105 && /daily|news/i.test(title || "") === false && episodes.length % 50 === 0,
        harvested_at: new Date().toISOString(),
        episodes,
      });
      console.log(`   ${i + 1}/${topIds.length} ${title}: ${episodes.length} episodes`);
    } catch (e) {
      ckpt.shows.push({ apple_collection_id: id, title, feed_url, error: e.message, harvested_at: new Date().toISOString(), episodes: [] });
      console.warn(`   ${i + 1}/${topIds.length} ${title}: FAILED ${e.message}`);
    }
    done.add(id);
    ckpt.doneIds = [...done];
    writeFileSync(CKPT, JSON.stringify(ckpt));
  }

  const doc = {
    version: 1, built_at: new Date().toISOString(),
    source: "rss-feeds (full public catalogs); overall US top chart order",
    shows: ckpt.shows,
  };
  const totalEps = ckpt.shows.reduce((s, x) => s + (x.episodes?.length || 0), 0);
  writeFileSync(outPath + ".gz", gzipSync(JSON.stringify(doc), { level: 9 }));
  writeFileSync(CKPT, "{}");
  console.log(`WROTE ${outPath}.gz: ${ckpt.shows.length} shows, ${totalEps} episodes total`);
  console.log("ARCHIVE_COMPLETE");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
