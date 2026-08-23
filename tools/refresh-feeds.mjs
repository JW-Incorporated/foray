/* Nightly feed refresh, deterministic half. Polls the curated shows' RSS
   feeds, finds episodes newer than the last run, and writes them to
   data-local/fresh-pending.json for the Claude pass (hooks, tags, trackId
   resolution, merge). See .claude/commands/nightly-refresh.md.

   Usage: node tools/refresh-feeds.mjs [--limit N] [--window-hours H]      */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { UA } from "./segments/politeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
const { XMLParser } = backendRequire("fast-xml-parser");

const THROTTLE_MS = 1800;
const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const WINDOW_H = args.includes("--window-hours") ? Number(args[args.indexOf("--window-hours") + 1]) : 48;

mkdirSync(join(ROOT, "data-local"), { recursive: true });
const STATE_PATH = join(ROOT, "data-local", "refresh-state.json");
const OUT_PATH = join(ROOT, "data-local", "fresh-pending.json");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const text = (v) => (v == null ? null : typeof v === "object" ? (v["#text"] ?? null) : String(v));

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

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch (_) { return { seen: {} }; }
}

async function main() {
  const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));
  const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
  const knownTitles = new Set(discover.items.map(i => i.show + "::" + i.title));
  const state = loadState();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
  const cutoff = Date.now() - WINDOW_H * 3600_000;

  const shows = catalog.shows.filter(s => s.feed_url).slice(0, LIMIT);
  const pending = [];
  let polled = 0, failed = 0;

  for (const show of shows) {
    await sleep(THROTTLE_MS);
    try {
      const res = await fetch(show.feed_url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = parser.parse(await res.text());
      let items = doc?.rss?.channel?.item || [];
      if (!Array.isArray(items)) items = [items];
      const seen = new Set(state.seen[show.apple_collection_id] || []);

      for (const it of items.slice(0, 10)) {
        const guid = text(typeof it.guid === "object" ? it.guid["#text"] ?? it.guid : it.guid) || text(it.enclosure?.["@_url"]);
        const title = text(it.title);
        if (!guid || !title || seen.has(guid)) continue;
        let pub = null;
        try { const d = new Date(it.pubDate); pub = isNaN(d) ? null : d; } catch (_) {}
        if (!pub || pub.getTime() < cutoff) continue;
        if (knownTitles.has(show.title + "::" + title)) continue;
        const desc = String(text(it.description) || text(it["itunes:summary"]) || "")
          .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
        pending.push({
          show: show.title,
          show_id: show.show_id || null,
          apple_collection_id: show.apple_collection_id,
          artwork_url: show.artwork_url || null,
          topics: show.taxonomy_node_ids || [],
          guid, title,
          release_date: pub.toISOString().slice(0, 10),
          duration_min: normDuration(it["itunes:duration"]),
          description: desc,
          explicit_hint: /yes|true|explicit/i.test(String(text(it["itunes:explicit"]) || "")),
        });
        seen.add(guid);
      }
      state.seen[show.apple_collection_id] = [...seen].slice(-60);
      polled++;
    } catch (e) {
      failed++;
      console.warn(`  ${show.title}: ${e.message}`);
    }
  }

  state.last_run = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state));
  writeFileSync(OUT_PATH, JSON.stringify({ generated_at: state.last_run, window_hours: WINDOW_H, episodes: pending }, null, 2));
  console.log(`polled ${polled}/${shows.length} feeds (${failed} failed); ${pending.length} new episodes -> ${OUT_PATH}`);
  console.log("REFRESH_SCAN_COMPLETE");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
