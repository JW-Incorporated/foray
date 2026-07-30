/* Classification batch prep — STATIC machinery (committed), keyless, no LLM.
   Companion to tools/refresh/scan.mjs, adapted for the breadth-catalog
   reclassification pipeline (docs/adr/0006-podcast-classification-methodology.md).

   Picks the next N breadth shows to (re)classify, fetches each show's RSS
   feed for Tier-0.5 signal (channel description + a sample of recent
   episode titles/descriptions — NEVER full transcripts by default, see the
   ADR's "Rejected Alternatives"), and writes one batch INPUT file for a
   Claude Code classification agent to read
   (docs/agents/runner-prompts/classify-batch.md is that agent's prompt).

   Two selection modes:
     --mode fresh     (default) shows not yet classified by THIS pipeline —
                       i.e. still on the old, distrusted sources
                       ("genre-map" / "llm-title-genre") or entirely absent
                       from data/breadth-classification.json. This is how
                       the untrustworthy output gets replaced, batch by
                       batch.
     --mode escalate   shows this pipeline already classified at Tier 1
                       (source "classify-agent-tier1") but flagged
                       needs_review=true — a Tier-2 "look harder" batch.
                       Adds each show's Tier-1 result as context and, when
                       available, a transcript excerpt from
                       <podcast:transcript> (ADR-0004's already-free tier-1
                       transcript source — the only place this pipeline
                       fetches transcript text, and only for this narrow,
                       already-ambiguous slice).

   Progress is tracked in a small JSON state file (default
   data-local/classify-progress.json) so successive runs don't repeat work
   and don't get stuck retrying a permanently-dead feed forever:
     - `in_flight`: ids reserved by an unmerged batch (reclaimed after a
       stale window, in case a batch is abandoned before merge-results.mjs
       runs).
     - `failed_fetch`: per-id attempt count + last error, with a cooldown
       between retries; after MAX_FETCH_ATTEMPTS the show is still included
       in a batch (Tier-0-only signal) rather than retried forever, so the
       classifier can produce a low-confidence, needs_review-flagged
       result instead of the show silently never getting classified.

   Usage:
     node tools/classify/prepare-batch.mjs [--batch-size 40] [--mode fresh|escalate]
       [--episodes-per-show 8] [--max-fetch-attempts 3] [--out PATH] [--progress PATH]

   Env overrides (mirrors tools/refresh/'s cloud-path-split convention):
     PROGRESS_PATH      progress/state file      (default data-local/classify-progress.json)
     BATCH_INPUT_PATH   batch output path         (default data-local/classify-batch-<id>.json)
     CATALOG_BREADTH_PATH, BREADTH_CLASSIFICATION_PATH, GENRE_MAP_PATH — data file overrides,
       rarely needed outside tests. */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backendRequire = createRequire(join(ROOT, "backend", "package.json"));
const { XMLParser } = backendRequire("fast-xml-parser");

const UA = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
const FETCH_TIMEOUT_MS = 15_000;
const THROTTLE_MS = 1500; // between feed requests — different hosts per show, so lighter than scan.mjs's single-host throttle
const RETRY_COOLDOWN_MS = 6 * 3600_000; // 6h between retry attempts on the same failed feed
const STALE_IN_FLIGHT_MS = 12 * 3600_000; // reclaim a batch nobody merged within 12h
const NEW_PIPELINE_SOURCE_PREFIX = "classify-agent-";

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
  };
  return {
    batchSize: Number(get("--batch-size", "40")),
    mode: get("--mode", "fresh"), // "fresh" | "escalate"
    episodesPerShow: Number(get("--episodes-per-show", "8")),
    maxFetchAttempts: Number(get("--max-fetch-attempts", "3")),
    outOverride: get("--out", null),
    progressOverride: get("--progress", null),
    shard: get("--shard", null) // "i/N" for parallel sharded runs — take only shows where Number(id) % N === i
  };
}

mkdirSync(join(ROOT, "data-local"), { recursive: true });

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

const CATALOG_BREADTH_PATH = envPath("CATALOG_BREADTH_PATH", ["data", "catalog-breadth.json"]);
const BREADTH_CLASSIFICATION_PATH = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);
const GENRE_MAP_PATH = envPath("GENRE_MAP_PATH", ["data", "genre-taxonomy-map.json"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function loadProgress(path) {
  if (!existsSync(path)) return { in_flight: {}, failed_fetch: {} };
  try {
    const p = readJson(path);
    return { in_flight: p.in_flight || {}, failed_fetch: p.failed_fetch || {} };
  } catch {
    return { in_flight: {}, failed_fetch: {} };
  }
}

function reclaimStaleInFlight(progress, now) {
  for (const [id, meta] of Object.entries(progress.in_flight)) {
    if (now - new Date(meta.reserved_at).getTime() > STALE_IN_FLIGHT_MS) {
      delete progress.in_flight[id];
    }
  }
}

// --- Genre-map Tier-0 prior (mirrors tools/classify-breadth.mjs's logic,
// kept in sync deliberately rather than importing that script, since this
// one only needs the single-show lookup, not the whole-catalog batch pass).
const CONF_ORDER = { high: 3, medium: 2, low: 1 };
function tier0Prior(show, gmap) {
  const topics = new Set();
  let confidence = "high";
  for (const g of [show.apple_genre, show.chart_genre_name]) {
    if (!g) continue;
    const m = gmap[g];
    if (!m) continue;
    m.topics.forEach((t) => topics.add(t));
    if (CONF_ORDER[m.confidence] < CONF_ORDER[confidence]) confidence = m.confidence;
  }
  return { topics: [...topics], confidence: topics.size ? confidence : "low" };
}

// --- RSS fetch + extraction (Tier 0.5). Never throws — degrades to a
// failure result the caller decides how to handle (skip + retry later, or
// fall back to Tier-0-only signal after MAX_FETCH_ATTEMPTS).
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function textOf(node) {
  if (node == null) return null;
  if (typeof node === "object") return node["#text"] != null ? String(node["#text"]).trim() : null;
  return String(node).trim();
}
function attrOf(node, attr) {
  return node && typeof node === "object" ? (node[`@_${attr}`] ?? null) : null;
}
function stripHtml(raw) {
  return String(raw || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches + parses a show's feed into { description, episodes, transcriptUrls, error }. */
async function fetchShowSignal(feedUrl, episodesPerShow) {
  try {
    const body = await fetchText(feedUrl);
    const doc = xmlParser.parse(body);
    const channel = doc?.rss?.channel;
    if (!channel) return { error: "no <rss><channel> found" };

    const description = stripHtml(textOf(channel.description) ?? textOf(channel["itunes:summary"]) ?? "").slice(0, 800);

    let items = channel.item || [];
    if (!Array.isArray(items)) items = [items];

    const episodes = [];
    const transcriptUrls = [];
    for (const it of items.slice(0, episodesPerShow)) {
      const title = textOf(it.title) ?? "(untitled)";
      const desc = stripHtml(textOf(it["content:encoded"]) ?? textOf(it.description) ?? textOf(it["itunes:summary"]) ?? "").slice(0, 200);
      episodes.push({ title, description: desc });

      let transcripts = it["podcast:transcript"];
      if (transcripts && !Array.isArray(transcripts)) transcripts = [transcripts];
      const preferred = (transcripts || []).find((t) => attrOf(t, "type") === "text/plain") ?? (transcripts || [])[0];
      const tUrl = preferred ? attrOf(preferred, "url") : null;
      if (tUrl && transcriptUrls.length < 3) transcriptUrls.push(tUrl);
    }

    if (episodes.length === 0) return { error: "feed has zero <item> entries" };
    return { description, episodes, transcriptUrls };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

/** Tier-2 only: fetches + truncates a transcript body already known to exist (free — ADR-0004). */
async function fetchTranscriptExcerpt(url) {
  try {
    const body = await fetchText(url, 20_000);
    // Plain-text and (lightly) JSON transcripts both degrade fine under a
    // blunt HTML/whitespace strip — good enough for an excerpt, not a
    // transcript-quality display surface.
    return stripHtml(body).slice(0, 2000);
  } catch (e) {
    return null;
  }
}

function selectFreshCandidates(shows, classification, progress, now, batchSize, maxFetchAttempts, shard) {
  let shardIndex = -1, shardCount = 0;
  if (shard) {
    const [i, n] = String(shard).split("/").map(Number);
    if (Number.isInteger(i) && Number.isInteger(n) && n > 0 && i >= 0 && i < n) { shardIndex = i; shardCount = n; }
  }
  const candidates = [];
  for (const show of shows) {
    const id = String(show.apple_collection_id);
    if (shardCount && Number(id) % shardCount !== shardIndex) continue; // parallel sharded run — disjoint slice, no collision with sibling shards
    if (progress.in_flight[id]) continue;
    const entry = classification.entries[id];
    if (entry && entry.source && entry.source.startsWith(NEW_PIPELINE_SOURCE_PREFIX)) continue; // already reclassified

    const failed = progress.failed_fetch[id];
    if (failed && failed.attempts < maxFetchAttempts && now - new Date(failed.last_attempt_at).getTime() < RETRY_COOLDOWN_MS) {
      continue; // in cooldown, try again later
    }
    candidates.push(show);
  }
  // Prioritize known-bad sources first (llm-title-genre, the distrusted
  // refinement) so the least-trustworthy tags get replaced soonest; then
  // genre-map-only; then never-classified.
  const rank = (show) => {
    const e = classification.entries[String(show.apple_collection_id)];
    if (!e) return 0; // never classified — mildly urgent (no signal at all)
    if (e.source === "llm-title-genre") return 2; // most urgent — known-distrusted
    if (e.source === "genre-map") return 1;
    return 0;
  };
  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates.slice(0, batchSize);
}

function selectEscalateCandidates(shows, classification, progress, batchSize) {
  const byId = new Map(shows.map((s) => [String(s.apple_collection_id), s]));
  const candidates = [];
  for (const [id, entry] of Object.entries(classification.entries)) {
    if (entry.source !== "classify-agent-tier1") continue;
    if (!entry.needs_review) continue;
    if (progress.in_flight[id]) continue;
    const show = byId.get(id);
    if (show) candidates.push({ show, priorResult: entry });
  }
  return candidates.slice(0, batchSize);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const batchId = `${args.mode}-${new Date(now).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

  const progressPath = args.progressOverride ? resolvePath(process.cwd(), args.progressOverride) : envPath("PROGRESS_PATH", ["data-local", "classify-progress.json"]);
  const outPath = args.outOverride ? resolvePath(process.cwd(), args.outOverride) : envPath("BATCH_INPUT_PATH", ["data-local", `classify-batch-${batchId}.json`]);

  const catalog = readJson(CATALOG_BREADTH_PATH);
  const classification = existsSync(BREADTH_CLASSIFICATION_PATH)
    ? readJson(BREADTH_CLASSIFICATION_PATH)
    : { version: 1, entries: {} };
  const gmap = readJson(GENRE_MAP_PATH).map;
  const progress = loadProgress(progressPath);
  reclaimStaleInFlight(progress, now);

  const usShows = catalog.shows.filter((s) => s.feed_url);

  let selection;
  if (args.mode === "escalate") {
    selection = selectEscalateCandidates(usShows, classification, progress, args.batchSize).map((c) => ({ show: c.show, priorResult: c.priorResult }));
  } else {
    selection = selectFreshCandidates(usShows, classification, progress, now, args.batchSize, args.maxFetchAttempts, args.shard).map((show) => ({ show, priorResult: null }));
  }

  if (selection.length === 0) {
    console.log(`CLASSIFY_BATCH_EMPTY: no candidates for mode "${args.mode}" (batch-size ${args.batchSize}).`);
    console.log(args.mode === "fresh" ? "  Every show is already reclassified or in cooldown — the fresh pass may be complete." : "  No Tier-1 shows are currently flagged needs_review awaiting escalation.");
    return;
  }

  const batchShows = [];
  let fetchOk = 0, fetchFailed = 0, fetchDegraded = 0;

  for (const { show, priorResult } of selection) {
    await sleep(THROTTLE_MS);
    const id = String(show.apple_collection_id);
    const signal = await fetchShowSignal(show.feed_url, args.episodesPerShow);

    if (signal.error) {
      const failed = progress.failed_fetch[id] || { attempts: 0 };
      failed.attempts += 1;
      failed.last_error = signal.error;
      failed.last_attempt_at = new Date(now).toISOString();
      progress.failed_fetch[id] = failed;

      if (failed.attempts < args.maxFetchAttempts) {
        fetchFailed++;
        console.warn(`  SKIP (retry later, attempt ${failed.attempts}/${args.maxFetchAttempts}): ${show.title}: ${signal.error}`);
        continue; // excluded from this batch — "skip + log, retry later"
      }
      // Exhausted retries: include with Tier-0-only signal so the show
      // still gets a (low-confidence, flagged) classification rather than
      // being stuck out of rotation forever.
      fetchDegraded++;
      console.warn(`  DEGRADED (attempts exhausted): ${show.title}: ${signal.error} — including with Tier-0-only signal`);
    } else {
      fetchOk++;
      delete progress.failed_fetch[id];
    }

    const tier0 = tier0Prior(show, gmap);

    let transcriptExcerpts = [];
    if (args.mode === "escalate" && signal.transcriptUrls?.length) {
      for (const tUrl of signal.transcriptUrls.slice(0, 2)) {
        await sleep(THROTTLE_MS);
        const excerpt = await fetchTranscriptExcerpt(tUrl);
        if (excerpt) transcriptExcerpts.push(excerpt);
      }
    }

    batchShows.push({
      apple_collection_id: show.apple_collection_id,
      title: show.title,
      apple_genre: show.apple_genre ?? null,
      chart_genre_name: show.chart_genre_name ?? null,
      chart_rank: show.chart_rank ?? null,
      tier0_prior: tier0,
      signal_fetch_status: signal.error ? "failed_degraded" : "ok",
      description: signal.description ?? null,
      episodes: signal.episodes ?? [],
      transcript_excerpts: transcriptExcerpts.length ? transcriptExcerpts : undefined,
      prior_result: priorResult ? { topics: priorResult.topics, needs_review: priorResult.needs_review, rationale: priorResult.rationale } : undefined
    });

    progress.in_flight[id] = { batch_id: batchId, reserved_at: new Date(now).toISOString() };
  }

  writeFileSync(progressPath, JSON.stringify(progress, null, 2) + "\n");

  if (batchShows.length === 0) {
    console.log(`CLASSIFY_BATCH_EMPTY: all ${selection.length} selected show(s) failed signal fetch and are queued for retry.`);
    return;
  }

  const batch = {
    batch_id: batchId,
    mode: args.mode,
    tier: args.mode === "escalate" ? 2 : 1,
    generated_at: new Date(now).toISOString(),
    taxonomy_path: "data/taxonomy.json",
    genre_map_path: "data/genre-taxonomy-map.json",
    shows: batchShows
  };
  writeFileSync(outPath, JSON.stringify(batch, null, 2) + "\n");

  console.log(
    `fetched ${fetchOk} ok, ${fetchFailed} skipped-for-retry, ${fetchDegraded} degraded (attempts exhausted); ${batchShows.length} show(s) -> ${outPath}`
  );
  console.log(`CLASSIFY_BATCH_PREPARED: ${outPath} (batch_id=${batchId}, mode=${args.mode}, tier=${batch.tier}, shows=${batchShows.length})`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
