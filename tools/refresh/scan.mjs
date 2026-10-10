/* Nightly scan — STATIC machinery (committed). Polls the curated shows' RSS
   feeds, finds episodes newer than the last run, and writes fresh-pending.json.
   Keyless (RSS + optional local state only). Safe to run in GitHub Actions.

   Committed successor to tools/refresh-feeds.mjs, with configurable paths so the
   same script runs locally (state in data-local/) and in CI (ephemeral paths).

   Usage:  node tools/refresh/scan.mjs [--limit N] [--window-hours H] [--source index]
   Env overrides:
     STATE_PATH    seen-guid state    (default data-local/refresh-state.json)
     PENDING_PATH  scan output        (default data-local/fresh-pending.json)
     FEED_FIXTURE_DIR  an offline world, for tools/refresh/scan.test.mjs only
                   (code-health-2 CH2-29): catalog.json and discover.json are
                   read from it instead of data/, each feed URL reads
                   <dir>/<sha1(url)>.xml instead of the network (a missing file
                   is a failed feed), and there is no throttle. The nightly
                   never sets it.

   --source index (S-11, 4a-shows-pipeline-plan.md card S-11): instead of
   polling all 220 curated feeds every night, read S-04's published
   changed.json (tools/refresh/candidates.mjs) and scan only the curated
   shows it says advanced since the last release, intersected with the
   feeds S-04's id-map maps them to. The output shape is identical either
   way — resolve.mjs and everything downstream cannot tell the difference —
   plus a top-level `candidates` array: changed.json ∩ top.json's NOT-
   curated rows, so the curation agent sees fresh activity from shows
   nobody has curated in yet, without a database.

   FAILS OPEN, NEVER DARK: any failure loading the change index (S-04
   hasn't published a release yet, a network error, a malformed asset)
   falls back to scanning every curated feed, exactly as --source full
   (the default) always has. A missing/stale index must never mean fewer
   feeds get scanned than before S-11 shipped.                            */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { isEntryScript } from "../ci/entry.mjs";
import { feedParser, itemIdentity, itemToPendingRecord } from "./feed-xml.mjs";
import { UA } from "../segments/politeness.mjs";
import { fetchFeedCapped, capItems } from "./fetch-limits.mjs";
import { loadChangeIndex, selectChangedCuratedShows, curationCandidates } from "./candidates.mjs";
import { retryItems } from "./resolve.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const THROTTLE_MS = 1800;
const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const WINDOW_H = args.includes("--window-hours") ? Number(args[args.indexOf("--window-hours") + 1]) : 48;
const SOURCE = args.includes("--source") ? args[args.indexOf("--source") + 1] : "full";

mkdirSync(join(ROOT, "data-local"), { recursive: true });
const STATE_PATH = process.env.STATE_PATH || join(ROOT, "data-local", "refresh-state.json");
const OUT_PATH = process.env.PENDING_PATH || join(ROOT, "data-local", "fresh-pending.json");

const FIXTURE_DIR = process.env.FEED_FIXTURE_DIR || null;
const dataPath = (file) => (FIXTURE_DIR ? join(FIXTURE_DIR, file) : join(ROOT, "data", file));
const fixtureFeedFile = (url) => createHash("sha1").update(url).digest("hex") + ".xml";
async function fetchFeed(url) {
  if (FIXTURE_DIR) return readFileSync(join(FIXTURE_DIR, fixtureFeedFile(url)), "utf8");
  await sleep(THROTTLE_MS);
  return fetchFeedCapped(url, { headers: { "User-Agent": UA } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch (_) { return { seen: {} }; }
}

async function main() {
  const catalog = JSON.parse(readFileSync(dataPath("catalog.json"), "utf8"));
  const discover = JSON.parse(readFileSync(dataPath("discover.json"), "utf8"));
  const knownTitles = new Set(discover.items.map((i) => i.show + "::" + i.title));
  const state = loadState();
  const parser = feedParser();
  const cutoff = Date.now() - WINDOW_H * 3600_000;

  const curatedFeedShows = catalog.shows.filter((s) => s.feed_url);
  let shows = curatedFeedShows;
  let candidates = [];
  let indexMode = null; // null (full scan) | { used: true, ... } | { used: false, reason }

  if (SOURCE === "index") {
    const index = await loadChangeIndex();
    if (index.ok) {
      shows = selectChangedCuratedShows(curatedFeedShows, index.idMap, index.changedIds);
      candidates = curationCandidates(index.topRows, index.changedIds);
      console.log(`--source index: scanning ${shows.length}/${curatedFeedShows.length} curated feeds (changed since last release, or unmapped)`);
    } else {
      indexMode = { used: false, reason: index.reason };
      console.log(`--source index unavailable (${index.reason}) — falling back to full scan of ${curatedFeedShows.length} feeds`);
    }
  }

  shows = shows.slice(0, LIMIT);
  // Computed AFTER the --limit slice so index.changed/scanned_count always
  // describe what was actually polled this run, never a pre-slice count a
  // consumer could mistake for the real number scanned (review finding).
  if (SOURCE === "index" && indexMode === null) {
    indexMode = { used: true, changed: shows.length, total: curatedFeedShows.length };
  }
  /* Last night's unresolved episodes first (audit round 3, data-tools-2):
     resolve.mjs carries an episode iTunes had not indexed yet, or whose lookup
     failed, in state.retry, because this scan already marked its guid seen. */
  const pending = retryItems(state, knownTitles);
  if (pending.length) console.log(`retrying ${pending.length} episode(s) resolve could not match last night`);
  const withheld = [];
  let polled = 0, failed = 0;

  for (const show of shows) {
    try {
      const bodyText = await fetchFeed(show.feed_url);
      const doc = parser.parse(bodyText);
      let items = doc?.rss?.channel?.item || [];
      if (!Array.isArray(items)) items = [items];
      items = capItems(items);
      const seen = new Set(state.seen[show.apple_collection_id] || []);

      for (const it of items.slice(0, 10)) {
        const { guid, title, pub } = itemIdentity(it);
        if (!guid || !title || seen.has(guid)) continue;
        if (!pub || pub.getTime() < cutoff) continue;
        if (knownTitles.has(show.title + "::" + title)) continue;
        /* The record is built by the one function backfill-show.mjs uses too
           (tools/refresh/feed-xml.mjs, code-health-2 CH2-29): resolve.mjs reads
           one shape, whichever script pushed it. */
        const { record, reason } = itemToPendingRecord(show, it);
        // Not fatal: the record goes out with no audio_url (issue #24), listed so
        // a feed that starts withholding enclosures doesn't degrade silently.
        if (reason) withheld.push(`${show.title} :: ${title} :: ${reason}`);
        pending.push(record);
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
  writeFileSync(OUT_PATH, JSON.stringify({
    generated_at: state.last_run,
    // Where resolve.mjs carries tonight's unresolved episodes (state.retry).
    state_path: resolvePath(STATE_PATH),
    window_hours: WINDOW_H,
    source: SOURCE,
    ...(indexMode ? { index: indexMode } : {}),
    scanned_count: shows.length,
    episodes: pending,
    candidates,
  }, null, 2));
  const withAudio = pending.filter((e) => e.audio_url).length;
  console.log(`polled ${polled}/${shows.length} feeds (${failed} failed); ${pending.length} new episodes -> ${OUT_PATH}`);
  console.log(`audio urls: ${withAudio}/${pending.length}`);
  if (candidates.length) console.log(`curation candidates: ${candidates.length} (changed, not curated)`);
  // Not fatal: an episode with no playable URL still belongs in discovery, it
  // just links out instead of playing (issue #24). Visible so a feed that
  // starts withholding enclosures doesn't degrade silently.
  if (withheld.length) console.log(`WITHHELD ${withheld.length} enclosure(s):\n  ${withheld.join("\n  ")}`);
  console.log("REFRESH_SCAN_COMPLETE");
}

if (isEntryScript(import.meta.url)) main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
