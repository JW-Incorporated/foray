#!/usr/bin/env node
/* The transcription work order — `data/transcription-queue.json`.
 *
 * WHAT THIS IS FOR. A dedicated GPU box does roughly 250 episodes/day. This
 * file decides which shows it eats first, for about a month of continuous work
 * (~6,000-9,000 episodes over >=100 shows). Rough ordering is the explicit
 * brief: "not a huge impact if we miss some / transcribe them a couple weeks
 * later". Coverage and the correctness of the NO-TRANSCRIPT determination are
 * what matter, so most of the care in this file is spent there and very little
 * on rank precision.
 *
 * ============================================================================
 * MEASURED vs ESTIMATED — the one discipline this file must not lose
 * ============================================================================
 * `data/breadth-transcript-yield.json` sets the standard: it carries
 * `inferred: 0` deliberately, and its `measurement_coverage` note says
 * "measured_clean is the only bucket a measurement admitted".
 *
 * Every count this tool emits is labelled. As built, EVERY show is
 * `count_basis: "measured"`, and that is not a convenience — it is the reason
 * the selection pool is only the 2,500 swept shows rather than all 19,787
 * breadth feeds. `sweepShow` (tools/segments/sweep-transcripts.mjs) computes
 * `episodes_total` / `episodes_with_transcript` by parsing EVERY <item> in the
 * feed, not the <=200 rows it keeps: `summarizeShow(base, episodes)` is handed
 * the full list, and `maxEpisodeRows` only truncates the stored rows, which are
 * themselves already filtered to episodes that have a transcript or chapters.
 * So a swept show reading `episodes_with_transcript: 0` is a whole-feed
 * measurement, not a sample of the first N items.
 *
 * The `estimated` branch is implemented and exercised by the suite because the
 * NEXT version of this queue will need it — but nothing in v1 uses it, and if
 * you add a show whose count came from PodcastIndex's `episodeCount` column
 * rather than from our own parse, it MUST carry `count_basis: "estimated"` and
 * name its estimator. PodcastIndex's `episodeCount` is a DIFFERENT QUANTITY
 * from ours (what their crawler last saw, not what the feed serves today) and
 * the two are not interchangeable.
 *
 * WHAT `episodes_total` MEANS, precisely: items present in the show's RSS feed
 * at measurement time. Not the show's lifetime output. A publisher serving a
 * 300-item window has 300 fetchable episodes and that is the number a
 * transcription box can act on, so it is the right denominator here — but it is
 * NOT "how many episodes this show has ever made", and a later reader must not
 * quote it as that.
 *
 * ============================================================================
 * APPEND-SAFETY — a worker machine has already consumed these ranks
 * ============================================================================
 * `mergeAppendSafe` is the whole mechanism. A show's `rank` is assigned ONCE,
 * in the version that added it, and is never recomputed. Rebuilding at
 * queue_version 2 appends new shows at max(existing rank)+1 and leaves every
 * v1 entry byte-identical. Nothing is ever removed: a show we later decide
 * against keeps its rank and its position and gains a label, because deleting
 * it would renumber everything behind it on a machine that is mid-run.
 *
 * This is also why re-ranking is not offered as a flag. A `--rerank` option
 * would be one typo away from renumbering a live queue, and the value it buys
 * (a better order among shows the box has already processed) is zero.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT A RANKING SIGNAL
 * ============================================================================
 * `dai_suspected`. It rides along as a LABEL and carries weight 0. ADR-0008
 * removed ad load as a rejection reason, and `tools/classify/labels.mjs` states
 * the consequence plainly: a per-show ad field rebuilds a gate the CTO had just
 * taken down. Ranking on it would do exactly that, quietly, in a file nobody
 * reads. It is carried because the downstream anchoring lane genuinely wants to
 * know, and discarding a measurement we already paid for helps nobody.
 *
 * `popularityScore` from PodcastIndex. MEASURED USELESS on this pool: all 1,202
 * candidates score 9. Not a signal, so not used, and recorded here so the next
 * session does not spend an hour re-discovering it.
 *
 * NETWORK. Only `--verify` touches the network, and it does so through
 * `fetchFeed` from tools/segments/sweep-transcripts.mjs, which gates on
 * tools/segments/politeness.mjs. There is no fetch call, no User-Agent string
 * and no sleep-loop in this file — that duplication class has bitten this repo
 * seven times and politeness.mjs's header names every one of them.
 *
 * `node:sqlite` is imported DYNAMICALLY inside `scanPodcastIndex` and nowhere
 * else. CI runs Node 22 where it is flagged (see tools/ci/run-suites.mjs), so a
 * top-level import would take the whole suite down on a code path the suite
 * never exercises.
 *
 * Usage:
 *   node tools/transcribe/build-transcription-queue.mjs --scan <join.json>
 *   node tools/transcribe/build-transcription-queue.mjs --build --join <join.json>
 *   node tools/transcribe/build-transcription-queue.mjs --verify --top 25 --sample 15
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

// --------------------------------------------------------------- constants --

/** The box's throughput, per the brief. Used only to report days of work. */
export const EPISODES_PER_DAY = 250;

/** The month-of-work window this queue is sized to. */
export const EPISODE_BUDGET = Object.freeze({ min: 6000, max: 9000, target: 7500 });

/** At least this many shows, per the brief. Breadth beats depth here: the app
    builds journeys ACROSS shows, so 150 shows x 50 episodes is worth more than
    15 shows x 500. */
export const MIN_SHOWS = 100;

/** How many episodes of one show this queue asks for in ONE version. A show
    with 2,741 un-transcribed episodes would otherwise eat 11 days of the box on
    its own. The remainder is not lost — it is what queue_version 2 is for, and
    `episodes_without_transcript` records the full measured figure next to the
    capped ask so the gap is visible rather than implied. */
export const PER_SHOW_CAP = 50;

/** Back catalogue below this is not worth a queue slot. */
export const MIN_EPISODES = 20;

/** "Active" = something published inside this window. */
export const ACTIVE_WINDOW_DAYS = 90;

/** No more than this many shows from one Apple chart genre, so the head of the
    queue is not 40 fantasy-football feeds. Applied BEFORE the budget, so the
    cap costs shows rather than silently reordering them. */
export const PER_GENRE_CAP = 5;

/* Apple chart genres whose episodes go stale in days. NOT excluded — the app
   may well want a news lane — but a daily six-minute brief is worth less GPU
   than an evergreen back catalogue, so they sort behind. This is a JUDGEMENT,
   it is the only judgement in the ranker, and it is listed here rather than
   buried inside a scoring expression so a founder can disagree with it in one
   edit. */
export const EPHEMERAL_GENRES = Object.freeze([
  "Daily News",
  "News Commentary",
  "Sports News",
  "Business News",
  "Politics",
  "Tech News",
  "Entertainment News",
  "Sports Comedy",
  "Fantasy Sports",
]);

export const EPHEMERAL_MULTIPLIER = 0.45;

/* Score weights. They sum to 1. Rough ordering is the brief, so these are round
   numbers chosen once and deliberately not tuned. */
export const WEIGHTS = Object.freeze({ demand: 0.5, archetype: 0.3, durability: 0.2 });

/** Apple chart ranks run 1..200 in this harvest. */
export const MAX_CHART_RANK = 200;

// ------------------------------------------------------------------ scoring --

/** Demand, from the Apple top-charts position the breadth catalogue harvested.
    Genre-relative (rank 1 in Volleyball is not rank 1 in Comedy), which is a
    known weakness and an acceptable one at this precision. */
export function demandScore(chartRank) {
  const r = Number(chartRank);
  if (!Number.isFinite(r) || r < 1) return 0;
  return Math.max(0, (MAX_CHART_RANK + 1 - Math.min(r, MAX_CHART_RANK)) / MAX_CHART_RANK);
}

/** Fit against the app's archetypes — `data/personas.json`, whose weights are
    over TOP-LEVEL taxonomy nodes. Returns the best single persona's best
    matching weight, normalised by the largest weight any persona expresses.

    Max-over-personas rather than sum: a show one archetype loves is worth
    queueing even if the other five are indifferent, and summing would reward
    bland middle-of-the-road shows that every persona mildly tolerates. */
export function archetypeFit(topics, personas) {
  const roots = new Set((topics || []).map((t) => String(t).split("/")[0]));
  let best = 0;
  let maxWeight = 0;
  for (const p of personas || []) {
    for (const w of p.weights || []) {
      maxWeight = Math.max(maxWeight, Number(w.weight) || 0);
      if (roots.has(w.node_id)) best = Math.max(best, Number(w.weight) || 0);
    }
  }
  return maxWeight > 0 ? best / maxWeight : 0;
}

/** 1 for an evergreen back catalogue, less for one that goes stale in a day. */
export function durabilityScore(chartGenre) {
  return EPHEMERAL_GENRES.includes(chartGenre) ? EPHEMERAL_MULTIPLIER : 1;
}

export function scoreShow({ chartRank, topics, chartGenre }, personas) {
  const demand = demandScore(chartRank);
  const archetype = archetypeFit(topics, personas);
  const durability = durabilityScore(chartGenre);
  const total = WEIGHTS.demand * demand + WEIGHTS.archetype * archetype + WEIGHTS.durability * durability;
  return { demand, archetype, durability, total };
}

// ---------------------------------------------------------------- selection --

/** How many episodes of a show this version asks for. */
export function queuedEpisodes(withoutTranscript, cap = PER_SHOW_CAP) {
  return Math.max(0, Math.min(Number(withoutTranscript) || 0, cap));
}

/** Takes ranked candidates and returns the prefix that fits the budget, under
    the per-genre cap and the minimum show count.

    ORDER OF OPERATIONS MATTERS. The genre cap is applied first, so it removes
    shows from consideration rather than reshuffling the survivors; then the
    budget takes a PREFIX of what is left. A budget applied first would let 40
    fantasy-football feeds fill the month before the cap ever ran. */
export function selectForBudget(
  ranked,
  { cap = PER_SHOW_CAP, budget = EPISODE_BUDGET, perGenreCap = PER_GENRE_CAP, minShows = MIN_SHOWS } = {}
) {
  const perGenre = new Map();
  const eligible = [];
  let genreCapped = 0;
  for (const c of ranked) {
    const g = c.chart_genre || "(none)";
    const n = perGenre.get(g) || 0;
    if (n >= perGenreCap) {
      genreCapped += 1;
      continue;
    }
    perGenre.set(g, n + 1);
    eligible.push(c);
  }

  const taken = [];
  let episodes = 0;
  for (const c of eligible) {
    const q = queuedEpisodes(c.episodes_without_transcript, cap);
    if (q <= 0) continue;
    if (episodes + q > budget.max) break;
    taken.push({ ...c, episodes_queued: q });
    episodes += q;
    if (episodes >= budget.target && taken.length >= minShows) break;
  }
  return { taken, episodes, genre_capped: genreCapped, eligible_after_genre_cap: eligible.length };
}

// ------------------------------------------------------------ append-safety --

/** THE INVARIANT. Merges freshly-selected shows into an existing queue without
    disturbing a single entry a worker may already have consumed.

    - An existing show keeps its `rank`, its `added_queue_version` and its
      position in the array. Its fields are NOT refreshed, even when a newer
      measurement disagrees; a v1 entry describes what v1 asked for, and a
      worker that has already run it must be able to reconcile its own log
      against the file it read.
    - A new show appends at max(existing rank) + 1, in the order given.
    - NOTHING IS REMOVED. Not by this function, not by its caller.

    Identity is `feed_url`, lowercased and trimmed. Not the title (publishers
    rename), not the Apple id (nullable in this catalogue), not the PodcastIndex
    id (a feed can appear twice in the dump under two ids — the scan already
    picks one, but the queue must not depend on which one it picked). */
export function mergeAppendSafe(existingShows, incoming, queueVersion) {
  const key = (u) => String(u || "").trim().toLowerCase();
  const seen = new Set();
  const out = [];
  let maxRank = 0;
  for (const s of existingShows || []) {
    seen.add(key(s.feed_url));
    out.push(s);
    maxRank = Math.max(maxRank, Number(s.rank) || 0);
  }
  let added = 0;
  for (const c of incoming) {
    if (seen.has(key(c.feed_url))) continue;
    maxRank += 1;
    seen.add(key(c.feed_url));
    out.push({ rank: maxRank, ...c, added_queue_version: queueVersion });
    added += 1;
  }
  return { shows: out, added, carried: (existingShows || []).length };
}

// ------------------------------------------------------------------- inputs --

export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

export function loadInputs(root = REPO_ROOT) {
  const d = path.join(root, "data");
  return {
    yieldDoc: readJson(path.join(d, "breadth-transcript-yield.json")),
    catalog: readJson(path.join(d, "catalog-breadth.json")),
    classification: readJson(path.join(d, "breadth-classification.json")),
    genreMap: readJson(path.join(d, "genre-taxonomy-map.json")),
    personas: readJson(path.join(d, "personas.json")),
    taxonomy: readJson(path.join(d, "taxonomy.json")),
  };
}

/** The union of the agent classification and the deterministic Apple-genre map,
    restricted to real `data/taxonomy.json` node ids.

    BOTH, not one. The agent classifier is the richer signal and it is also
    measurably noisy on this pool — it files "Pop Culture Happy Hour" under
    `science/storytelling` and "Short Wave" under `engineering/ai-robotics`.
    `tools/segments/rank-breadth.mjs` reached the same conclusion from the other
    direction and set its TOPIC_WEIGHT to 0. The genre map is coarse but
    deterministic and derived from Apple's own tree, so the union degrades
    gracefully: a show the agent misfiled still carries its genre's nodes.

    Filtering to real node ids is not decoration. `test/data-topic-integrity.js`
    is the standing gate on exactly these ids for the other `data/` files, and a
    queue that invented one would be the same defect in a file that auto-merges
    unread. */
export function topicsFor(show, { classification, genreMap, taxonomy }) {
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));
  const entry = classification.entries[String(show.apple_collection_id)] || null;
  const fromAgent = (entry && Array.isArray(entry.topics) ? entry.topics : []).filter((t) => nodeIds.has(t));
  const fromGenre = ((genreMap.map[show.chart_genre_name] || {}).topics || []).filter((t) => nodeIds.has(t));
  const merged = [];
  for (const t of [...fromAgent, ...fromGenre]) if (!merged.includes(t)) merged.push(t);
  return { topics: merged, agent: fromAgent, genre: fromGenre, entry };
}

// -------------------------------------------------------- podcastindex scan --

/** One full pass over the local PodcastIndex dump, matching every swept show.

    ONE pass, not 2,500 point lookups. The dump has no index on `itunesId`, so
    per-show queries are 2,500 full scans of 4.7M rows and simply do not finish
    — measured: the point-lookup version was still running after two minutes
    having resolved nothing. The single pass takes about ninety seconds.

    Dynamic import of node:sqlite — see the header note on Node 22. */
export async function scanPodcastIndex(dbPath, shows) {
  const { DatabaseSync } = await import("node:sqlite");
  const wantItunes = new Map();
  const wantUrl = new Map();
  for (const s of shows) {
    if (s.apple_collection_id != null) wantItunes.set(Number(s.apple_collection_id), s.show_id);
    if (s.feed_url) wantUrl.set(s.feed_url, s.show_id);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stmt = db.prepare(
    "select id,url,title,language,dead,newestItemPubdate,episodeCount,popularityScore,itunesId,host from podcasts"
  );
  const join = {};
  let scanned = 0;
  for (const r of stmt.iterate()) {
    scanned += 1;
    let k = null;
    if (r.itunesId != null && wantItunes.has(Number(r.itunesId))) k = wantItunes.get(Number(r.itunesId));
    else if (wantUrl.has(r.url)) k = wantUrl.get(r.url);
    if (!k) continue;
    const prev = join[k];
    // PodcastIndex holds duplicate rows per feed; prefer alive, then popular.
    if (!prev || (prev.dead && !r.dead) || (!r.dead && Number(r.popularityScore || 0) > Number(prev.popularityScore || 0))) join[k] = r;
  }
  db.close();
  return { join, scanned, matched: Object.keys(join).length };
}

// --------------------------------------------------------------- candidates --

/** The funnel, as a pure function, so the suite can drive it and the numbers in
    `method.funnel` are the ones the run actually produced rather than a
    hand-copied summary that rots on the first rebuild. */
export function buildCandidates({ yieldDoc, catalog, classification, genreMap, personas, taxonomy }, join, nowSec) {
  const cat = new Map(catalog.shows.map((s) => [String(s.apple_collection_id), s]));
  const funnel = {};
  const bump = (k) => (funnel[k] = (funnel[k] || 0) + 1);
  const candidates = [];

  for (const s of yieldDoc.shows) {
    bump("swept");
    if (s.status !== "ok") { bump("drop_feed_unreadable"); continue; }
    if (s.episodes_with_transcript !== 0) { bump("drop_publishes_transcripts"); continue; }
    bump("zero_transcript_measured");
    if (s.episodes_total < MIN_EPISODES) { bump("drop_thin_back_catalogue"); continue; }
    const pi = join[s.show_id];
    if (!pi) { bump("drop_not_in_podcastindex"); continue; }
    if (!String(pi.language || "").toLowerCase().startsWith("en")) { bump("drop_not_english"); continue; }
    if (pi.dead) { bump("drop_marked_dead"); continue; }
    if (!pi.newestItemPubdate || nowSec - pi.newestItemPubdate > ACTIVE_WINDOW_DAYS * 86400) { bump("drop_inactive"); continue; }
    const c = cat.get(String(s.apple_collection_id));
    if (!c) { bump("drop_not_in_breadth_catalogue"); continue; }
    const t = topicsFor(
      { apple_collection_id: s.apple_collection_id, chart_genre_name: c.chart_genre_name },
      { classification, genreMap, taxonomy }
    );
    if (t.topics.length === 0) { bump("drop_no_topic"); continue; }
    bump("candidate");

    const score = scoreShow({ chartRank: c.chart_rank, topics: t.topics, chartGenre: c.chart_genre_name }, personas.personas);
    const labels = [];
    if (s.dai_suspected) labels.push("dai-suspected");
    if (t.entry && t.entry.confidence !== "high") labels.push(`classifier-confidence-${t.entry.confidence}`);
    if (t.entry && t.entry.source !== "classify-agent-tier1") labels.push(`topics-from-${t.entry.source}`);
    if (t.agent.length === 0) labels.push("topics-from-apple-genre-only");
    if (EPHEMERAL_GENRES.includes(c.chart_genre_name)) labels.push("ephemeral-genre");
    if (s.episodes_total >= 1000) labels.push("large-back-catalogue-capped");

    candidates.push({
      title: s.title,
      feed_url: s.feed_url,
      podcastindex_feed_id: pi.id,
      apple_collection_id: s.apple_collection_id ?? null,
      chart_genre: c.chart_genre_name,
      chart_rank: c.chart_rank,
      topic_tags: t.topics,
      episodes_total: s.episodes_total,
      episodes_without_transcript: s.episodes_total - s.episodes_with_transcript,
      count_basis: "measured",
      count_source: "tools/segments/sweep-transcripts.mjs — full-feed <item> parse",
      count_measured_at: s.swept_at,
      score,
      labels,
    });
  }
  // Deterministic: the tiebreaks make a rebuild on unchanged inputs byte-identical.
  candidates.sort((a, b) => b.score.total - a.score.total || a.chart_rank - b.chart_rank || String(a.title).localeCompare(String(b.title)));
  return { candidates, funnel };
}

/** One line saying why this show sits where it does. */
export function whyRanked(c) {
  const bits = [`#${c.chart_rank} in Apple ${c.chart_genre}`];
  bits.push(
    c.score.archetype >= 0.66 ? "strong archetype fit" : c.score.archetype >= 0.33 ? "partial archetype fit" : "weak archetype fit"
  );
  bits.push(`${c.episodes_without_transcript} feed episodes measured with no <podcast:transcript>`);
  if (c.score.durability < 1) bits.push("sorted back as an ephemeral daily-news genre");
  return bits.join("; ");
}

// ------------------------------------------------------ live verification --

/** Folds a live feed reading into a queue row.

    THE RULE THIS ENCODES: a live reading that CONTRADICTS the sweep does not
    delete the row and does not renumber anything. The row keeps its rank and
    its place; `episodes_queued` drops to 0 and a label says why. Deleting it
    would renumber every entry behind it on a box that is mid-run, which is the
    one failure this file exists to prevent — and the founder's standing rule is
    label, never exclude.

    `episodes_total` and `episodes_without_transcript` are REPLACED by the live
    figures when the fetch succeeds, because both readings are measurements and
    the newer one is the truer one. `count_measured_at` moves with them, so the
    pair is never half-updated. This is the same "richer observation wins" rule
    `mergeTranscriptLabels` applies in tools/classify/labels.mjs.

    A fetch that FAILS changes no count at all. "We could not read it" is not
    evidence about transcripts, and writing zeros on a timeout is how a
    measurement file starts lying. */
export function applyVerification(row, live, { cap = PER_SHOW_CAP } = {}) {
  const out = { ...row };
  /* Labels are a SET, applied idempotently. Caught in review: --verify appends,
     so running it twice on the same document produced
     ["live-verified-no-transcript", "live-verified-no-transcript"] — which is
     harmless until something counts labels. */
  const label = (...add) => {
    out.labels = [...new Set([...(row.labels || []), ...add])];
  };
  if (!live.ok) {
    out.verified_live = {
      verified_at: live.verified_at,
      status: "unreadable",
      error_code: live.error_code || null,
      note: "counts left at their swept values; a failed fetch is not evidence about transcripts",
    };
    label("live-verification-failed");
    return out;
  }
  const contradicts = live.episodes_with_transcript > 0;
  out.episodes_total = live.episodes_total;
  out.episodes_without_transcript = live.episodes_total - live.episodes_with_transcript;
  out.count_measured_at = live.verified_at;
  out.count_source = "live RSS re-read via tools/segments/sweep-transcripts.mjs fetchFeed+parseFeed";
  out.verified_live = {
    verified_at: live.verified_at,
    status: contradicts ? "contradicts-sweep" : "confirms-sweep",
    episodes_total: live.episodes_total,
    episodes_with_transcript: live.episodes_with_transcript,
    episodes_with_timed_transcript: live.episodes_with_timed_transcript,
    newest_pub_date: live.newest_pub_date,
    median_duration_sec: live.median_duration_sec,
  };
  if (contradicts) {
    out.episodes_queued = 0;
    label("live-verification-contradicts-sweep", "not-queued-publisher-has-transcripts");
  } else {
    out.episodes_queued = queuedEpisodes(out.episodes_without_transcript, cap);
    label("live-verified-no-transcript");
  }
  return out;
}

/** Reads one feed and reduces it to the numbers `applyVerification` wants.

    Reuses `fetchFeed`/`parseFeed` rather than growing a second feed reader.
    That is not tidiness: politeness.mjs's header records that the last two
    fetchers in this repo were each written by copying the previous one and both
    copies drifted into the same two politeness bugs. */
export async function readFeedLive(feedUrl, { fetchFeed, parseFeed, hasTimestamps, now = () => new Date() }) {
  const verified_at = now().toISOString();
  try {
    const xml = await fetchFeed(feedUrl);
    const { episodes } = parseFeed(xml);
    let withT = 0;
    let withTimed = 0;
    const durations = [];
    for (const ep of episodes) {
      if (ep.transcript_url) withT += 1;
      if ((ep.transcript_types || []).some((t) => hasTimestamps(t))) withTimed += 1;
      if (Number.isFinite(ep.duration_sec) && ep.duration_sec > 0) durations.push(ep.duration_sec);
    }
    durations.sort((a, b) => a - b);
    return {
      ok: true,
      verified_at,
      episodes_total: episodes.length,
      episodes_with_transcript: withT,
      episodes_with_timed_transcript: withTimed,
      newest_pub_date: episodes.length ? episodes[0].pub_date || null : null,
      median_duration_sec: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    };
  } catch (e) {
    return { ok: false, verified_at, error_code: e?.code || e?.message || "UNKNOWN" };
  }
}

/** Which rows get a live read: the whole head, plus a SEEDED sample of the
    tail.

    The head is the brief's requirement. The tail sample is the part that turns
    the exercise into an estimate rather than a spot-check — without it we would
    know the top 25 are right and know nothing at all about rows 26..N, which is
    most of the month's work. Seeded so a re-run picks the same rows and the two
    runs are comparable. */
export function verificationPlan(shows, { top = 25, sample = 15, seed = 1 } = {}) {
  const head = shows.slice(0, top);
  const tail = shows.slice(top);
  const picked = [];
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pool = tail.map((_, i) => i);
  for (let i = 0; i < Math.min(sample, pool.length); i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    picked.push(tail[pool[i]]);
  }
  return { head, tailSample: picked };
}

// ---------------------------------------------------------------- CLI glue --

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const QUEUE_PATH = path.join(REPO_ROOT, "data", "transcription-queue.json");

async function main(argv) {
  if (argv.includes("--scan")) {
    const out = arg(argv, "--scan");
    if (!out) throw new Error("--scan needs an output path");
    const db = arg(argv, "--db", path.join(REPO_ROOT, "data-local", "podcastindex", "podcastindex_feeds.db"));
    const { yieldDoc } = loadInputs();
    const res = await scanPodcastIndex(db, yieldDoc.shows);
    fs.writeFileSync(out, JSON.stringify(res.join));
    console.log(`scanned ${res.scanned} rows, matched ${res.matched} of ${yieldDoc.shows.length} swept shows -> ${out}`);
    return;
  }

  if (argv.includes("--build")) {
    const joinPath = arg(argv, "--join");
    if (!joinPath) throw new Error("--build needs --join <path> (produced by --scan)");
    const inputs = loadInputs();
    const join = readJson(joinPath);
    const nowIso = arg(argv, "--now", new Date().toISOString());
    const nowSec = Math.floor(Date.parse(nowIso) / 1000);
    const { candidates, funnel } = buildCandidates(inputs, join, nowSec);
    const sel = selectForBudget(candidates);
    const rows = sel.taken.map((c) => ({
      title: c.title,
      feed_url: c.feed_url,
      podcastindex_feed_id: c.podcastindex_feed_id,
      apple_collection_id: c.apple_collection_id,
      topic_tags: c.topic_tags,
      episodes_total: c.episodes_total,
      episodes_without_transcript: c.episodes_without_transcript,
      episodes_queued: c.episodes_queued,
      count_basis: c.count_basis,
      count_source: c.count_source,
      count_measured_at: c.count_measured_at,
      apple_chart: { genre: c.chart_genre, rank: c.chart_rank },
      priority_score: Number(c.score.total.toFixed(4)),
      why_ranked: whyRanked(c),
      labels: c.labels,
      verified_live: null,
    }));

    /* REFUSE TO SHIP A QUEUE THAT MISSES THE BRIEF. selectForBudget enforces
       the CEILING (it stops adding) but nothing in it can enforce the FLOOR —
       if the candidate pool runs dry it simply returns what it found, and a
       three-week queue described as a month is the kind of quiet miss that gets
       noticed on day 22. Caught in review: the artefact suite asserts both
       floors, but a producer that only fails at test time has already written
       the file. */
    if (sel.taken.length < MIN_SHOWS || sel.episodes < EPISODE_BUDGET.min) {
      throw new Error(
        `refusing to write: ${sel.taken.length} shows / ${sel.episodes} episodes is under the brief's floor of ` +
          `${MIN_SHOWS} shows / ${EPISODE_BUDGET.min} episodes. The candidate pool (${candidates.length}) is too ` +
          `thin — sweep another tranche rather than lowering the floor.`
      );
    }

    const existing = fs.existsSync(QUEUE_PATH) ? readJson(QUEUE_PATH) : null;
    const queueVersion = existing ? Number(existing.queue_version) + 1 : 1;
    const merged = mergeAppendSafe(existing ? existing.shows : [], rows, queueVersion);
    const doc = buildDocument({ merged, funnel, sel, nowIso, queueVersion, previous: existing });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(doc, null, 2) + "\n");
    console.log(
      `queue_version ${queueVersion}: ${merged.added} shows added, ${merged.carried} carried, ` +
        `${doc.totals.episodes_queued} episodes = ${doc.totals.days_at_250_per_day} days`
    );
    return;
  }

  if (argv.includes("--verify")) {
    const { fetchFeed, parseFeed, hasTimestamps } = await import("../segments/sweep-transcripts.mjs");
    const doc = readJson(QUEUE_PATH);
    const top = Number(arg(argv, "--top", "25"));
    const sample = Number(arg(argv, "--sample", "15"));
    const plan = verificationPlan(doc.shows, { top, sample });
    const targets = [...plan.head, ...plan.tailSample];
    const byUrl = new Map();
    for (const t of targets) {
      const live = await readFeedLive(t.feed_url, { fetchFeed, parseFeed, hasTimestamps });
      byUrl.set(t.feed_url, live);
      console.log(
        `${live.ok ? (live.episodes_with_transcript > 0 ? "CONTRADICTS" : "ok         ") : "FAILED     "} ` +
          `${String(t.rank).padStart(3)} ${t.title}` +
          (live.ok ? ` (${live.episodes_total} eps, ${live.episodes_with_transcript} with transcript)` : ` (${live.error_code})`)
      );
    }
    doc.shows = doc.shows.map((s) => (byUrl.has(s.feed_url) ? applyVerification(s, byUrl.get(s.feed_url)) : s));
    doc.method.live_verification = summariseVerification(doc.shows, { top, sample });
    doc.totals = totalsFor(doc.shows);
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(doc, null, 2) + "\n");
    console.log(JSON.stringify(doc.method.live_verification, null, 2));
    return;
  }

  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("* Usage:")[1].split("*/")[0]);
}

/** Audio hours behind the queued episodes.

    THIS ONE IS AN ESTIMATE AND IS LABELLED AS ONE. Two reasons, both real:
    durations come from the publisher's declared `<itunes:duration>` rather than
    from decoding the audio, and only the live-verified shows have a duration
    reading at all — the rest borrow the pooled median of those. It is here
    because "250 episodes/day" quietly assumes an episode length, and the
    measured spread on this queue is 3 minutes to 2.8 hours of MEDIAN episode
    per show. A month of six-minute joke feeds and a month of three-hour
    interview shows are not the same month of GPU. */
export function audioHoursEstimate(shows) {
  const perShow = shows.map((s) => s.verified_live?.median_duration_sec).filter((d) => Number.isFinite(d) && d > 0);
  if (perShow.length === 0) {
    return { basis: "unavailable", note: "no live-verified durations in this document yet; run --verify" };
  }
  const sorted = [...perShow].sort((a, b) => a - b);
  const pooledMedian = sorted[Math.floor(sorted.length / 2)];
  let seconds = 0;
  for (const s of shows) {
    const d = Number.isFinite(s.verified_live?.median_duration_sec) && s.verified_live.median_duration_sec > 0
      ? s.verified_live.median_duration_sec
      : pooledMedian;
    seconds += (Number(s.episodes_queued) || 0) * d;
  }
  return {
    basis: "estimated",
    hours: Number((seconds / 3600).toFixed(0)),
    estimator:
      `sum over shows of episodes_queued x that show's median <itunes:duration>. ${perShow.length} shows have a ` +
      `live-measured median; the remaining ${shows.length - perShow.length} borrow the pooled median of those ` +
      `(${pooledMedian}s). Publisher-declared durations, not decoded audio.`,
    per_show_median_duration_sec: { min: sorted[0], median: pooledMedian, max: sorted[sorted.length - 1], n: perShow.length },
    why_it_matters:
      "the 250 episodes/day figure is an episode rate, and episodes are not equal work. This is the number to " +
      "re-check against the box's real throughput before trusting the days figure.",
  };
}

export function totalsFor(shows) {
  const queued = shows.reduce((n, s) => n + (Number(s.episodes_queued) || 0), 0);
  return {
    shows: shows.length,
    shows_with_work: shows.filter((s) => (Number(s.episodes_queued) || 0) > 0).length,
    episodes_queued: queued,
    episodes_without_transcript_measured_total: shows.reduce((n, s) => n + (Number(s.episodes_without_transcript) || 0), 0),
    days_at_250_per_day: Number((queued / EPISODES_PER_DAY).toFixed(1)),
    counts_measured: shows.filter((s) => s.count_basis === "measured").length,
    counts_estimated: shows.filter((s) => s.count_basis === "estimated").length,
    audio_hours: audioHoursEstimate(shows),
  };
}

export function summariseVerification(shows, { top, sample }) {
  const v = shows.filter((s) => s.verified_live);
  const head = v.filter((s) => s.rank <= top);
  const contradicts = v.filter((s) => s.verified_live.status === "contradicts-sweep");
  const failed = v.filter((s) => s.verified_live.status === "unreadable");
  return {
    method:
      "each listed feed re-fetched live and its <podcast:transcript> tags counted by parsing the RSS itself, " +
      "not by consulting any cached flag. Fetch and rate-limiting via tools/segments/sweep-transcripts.mjs " +
      "fetchFeed(), which gates on tools/segments/politeness.mjs (#318 owns every outbound identity string).",
    why_not_metadata:
      "HEAD requests lie on ad-inserting hosts and atelier.flightcast.com lies even to ranged GETs, so this repo's " +
      "rule is to verify against the artefact rather than against metadata about it. RSS is not subject to that " +
      "specific trap, but the rule is applied anyway: the transcript tag is read out of the feed body.",
    head_verified: head.length,
    head_target: top,
    tail_sample_verified: v.length - head.length,
    tail_sample_target: sample,
    confirmed_no_transcript: v.filter((s) => s.verified_live.status === "confirms-sweep").length,
    contradicted: contradicts.length,
    contradicted_titles: contradicts.map((s) => s.title),
    unreadable: failed.length,
    unreadable_titles: failed.map((s) => s.title),
    tail_error_rate_note:
      "the tail sample is a seeded random draw from ranks beyond the head, so `contradicted` among it is an " +
      "estimate of how often a cached zero is wrong across the rest of the queue. It is a small sample; treat " +
      "it as an order of magnitude, not a rate.",
  };
}

export function buildDocument({ merged, funnel, sel, nowIso, queueVersion, previous }) {
  return {
    queue_version: queueVersion,
    generated: nowIso.slice(0, 10),
    generated_at: nowIso,
    produced_by: "tools/transcribe/build-transcription-queue.mjs",
    what_this_is:
      "A work order for a dedicated transcription box that does ~250 episodes/day. Shows whose feed episodes " +
      "carry no <podcast:transcript>, ranked roughly, sized to about a month of continuous work.",
    append_safety: {
      rule: "rank is assigned once, in the version that added the show, and is never recomputed.",
      how_preserved: [
        "shows[] is append-only and ordered by rank; a rebuild carries every existing entry through byte-identical.",
        "new shows append at max(existing rank) + 1 and carry added_queue_version.",
        "no show is ever removed. One we later decide against keeps its rank and its position and gains a label; " +
          "episodes_queued goes to 0 instead. Removal would renumber everything behind it on a worker that is mid-run.",
        "identity is feed_url, lowercased and trimmed — not title (publishers rename), not apple_collection_id " +
          "(nullable here), not podcastindex_feed_id (a feed can appear twice in the dump).",
        "existing rows are NOT refreshed on rebuild. A v1 row describes what v1 asked for, so a worker can " +
          "reconcile its own log against the file it actually read.",
        "the one thing that DOES rewrite a row in place is --verify, and it is part of producing a version rather " +
          "than a later edit of a published one: it corrects the measurement fields against a live feed read and " +
          "can set episodes_queued to 0, but it never touches rank, array position, feed_url or " +
          "added_queue_version. Ordering a worker has consumed cannot move.",
      ],
      enforced_by: "mergeAppendSafe() in the producer; pinned by tools/transcribe/build-transcription-queue.test.mjs.",
      consumer_contract:
        "read shows[] in rank order, skip any row whose episodes_queued is 0, and take the newest " +
        "episodes_queued episodes from the feed.",
    },
    method: {
      throughput_assumption: { episodes_per_day: EPISODES_PER_DAY, source: "the brief for this queue" },
      counting: {
        basis_field: "every show carries count_basis, one of `measured` or `estimated`. Never present one as the other.",
        measured_definition:
          "episodes_total = the number of <item> elements in the show's RSS feed at count_measured_at, obtained by " +
          "parsing the whole feed. episodes_without_transcript = that number minus the items carrying a " +
          "<podcast:transcript> tag. Source: tools/segments/sweep-transcripts.mjs, whose summarizeShow() is handed " +
          "the FULL episode list — maxEpisodeRows only truncates the stored per-episode rows, never the counts. " +
          "For the live-verified head these numbers were re-measured against the feed itself; see live_verification.",
        what_it_is_not:
          "episodes_total is what the feed SERVES, not what the show has ever produced. A publisher with a " +
          "300-item window reads 300 here whatever their archive holds. That is the right number for a " +
          "transcription box, and the wrong number to quote as the show's output.",
        estimated_definition:
          "no show in queue_version 1 is estimated. The producer supports it and the suite exercises it, because a " +
          "later version extending past the 2,500 swept feeds will need it. Any such row must carry " +
          "count_basis: `estimated` and name its estimator. PodcastIndex's episodeCount column is the obvious " +
          "candidate and is a DIFFERENT quantity from ours — what their crawler last saw, not what the feed " +
          "serves today — so it is not interchangeable and must be labelled if used.",
        why_the_pool_is_2500:
          "the whole breadth catalogue is 19,787 shows, but only 2,500 have been swept. Selecting from the " +
          "un-swept 17,287 would mean estimating the one quantity this queue exists to be right about. Coverage " +
          "was traded for measurement, deliberately. data/breadth-transcript-yield.json's measurement_coverage " +
          "block sets that standard with its inferred: 0.",
      },
      selection_filters: {
        english: "PodcastIndex `language` starts with `en`.",
        active: `PodcastIndex newestItemPubdate within ${ACTIVE_WINDOW_DAYS} days of the build date, and not marked dead.`,
        back_catalogue: `at least ${MIN_EPISODES} episodes in the feed.`,
        topic_fit:
          "at least one real data/taxonomy.json node, from the union of the Claude classification agent's topics " +
          "(data/breadth-classification.json) and the deterministic Apple-genre map (data/genre-taxonomy-map.json). " +
          "The union rather than either alone: the agent classifier is richer and measurably noisy on this pool — " +
          "it files Pop Culture Happy Hour under science/storytelling — while the genre map is coarse but " +
          "deterministic, so a misfiled show still carries its genre's nodes.",
        never_excluded:
          "the founder's standing rule is label, never exclude. Nothing questionable was silently dropped: shows " +
          "carry labels[] instead. The filters above are the selection frontier, and the funnel below reports " +
          "exactly what each one cost.",
      },
      ranking: {
        note: "ROUGH BY DESIGN, per the brief. Weights are round numbers chosen once and not tuned.",
        weights: WEIGHTS,
        demand: "Apple top-charts position from the breadth harvest, linearly mapped from rank 1..200. Genre-relative, which is a known and accepted weakness.",
        archetype_fit:
          "best matching weight across the six data/personas.json archetypes, over the show's top-level topic nodes, " +
          "normalised by the largest weight any persona expresses. Max rather than sum, so a show one archetype " +
          "loves outranks one every archetype mildly tolerates.",
        durability: `Apple chart genres whose episodes go stale in days are multiplied by ${EPHEMERAL_MULTIPLIER} and sort behind. They are not excluded. The list is EPHEMERAL_GENRES in the producer, in one place, so it can be disagreed with in one edit.`,
        diversity: `at most ${PER_GENRE_CAP} shows per Apple chart genre, applied BEFORE the episode budget so the cap costs shows rather than silently reordering survivors.`,
        deliberately_not_signals: {
          dai_suspected:
            "carried as a label with weight 0. ADR-0008 removed ad load as a rejection reason and " +
            "tools/classify/labels.mjs warns that a per-show ad field rebuilds that gate; ranking on it would do " +
            "so quietly.",
          podcastindex_popularity_score:
            "measured useless on this pool — all candidates score 9. Recorded so it is not re-tried.",
        },
      },
      per_show_cap: {
        episodes: PER_SHOW_CAP,
        why:
          "the largest candidate has 2,741 un-transcribed episodes and would eat 11 days of the box alone. Breadth " +
          "is worth more to a cross-show recommender than depth in one feed. The remainder is not lost: " +
          "episodes_without_transcript records the full measured figure, and queue_version 2 is where the top-up " +
          "goes.",
      },
      funnel: {
        note: "counted by the producer on this run, not transcribed by hand.",
        ...funnel,
        after_genre_cap: sel.eligible_after_genre_cap,
        dropped_by_genre_cap: sel.genre_capped,
        selected: sel.taken.length,
      },
      inputs: {
        transcript_counts: "data/breadth-transcript-yield.json",
        podcastindex:
          "data-local/podcastindex/podcastindex_feeds.db — the local 5GB dump, gitignored. Joined to the swept shows " +
          "by itunesId, falling back to feed url. Contributes language, dead, newestItemPubdate and the " +
          "podcastindex_feed_id in every row below. One full table scan, not per-show lookups: the dump has no " +
          "index on itunesId, so 2,500 point queries are 2,500 scans of 4.7M rows and do not finish.",
        topics: ["data/breadth-classification.json", "data/genre-taxonomy-map.json", "data/taxonomy.json"],
        archetypes: "data/personas.json",
        demand: "data/catalog-breadth.json (Apple top-charts harvest)",
      },
      known_gaps: [
        "Selection pool is the 2,500 swept shows out of 19,787 breadth feeds (12.6%). The other 17,287 are not " +
          "ranked low — they are unmeasured, which is a different thing, and a later sweep tranche is how they enter.",
        "Apple chart rank is genre-relative, so rank 1 in Volleyball scores the same as rank 1 in Comedy.",
        "Topic tags inherit the classification agent's known error rate. Every row carries the labels that say when " +
          "its topics came from a low-confidence or genre-map-only source.",
        "The genre-map half of topic_tags inherits where the PUBLISHER chose to list themselves on Apple, which is " +
          "sometimes marketing. Concretely, in this file: `Real Ghost Stories Online` is listed under Natural " +
          "Sciences and therefore carries `science` and `nature`. The union hedges against a misfiling classifier " +
          "and cannot hedge against a misfiling publisher. Do not read topic_tags as a claim about content.",
        "`no transcript` means no <podcast:transcript> element in the RSS feed. A publisher may still have a " +
          "transcript on their website. That is out of scope: the pipeline downstream of this queue consumes the " +
          "feed, so a transcript it cannot see is a transcript that does not exist for its purposes.",
        "`active` for un-verified rows rests on PodcastIndex's newestItemPubdate as of the local dump, not on a " +
          "live read. The live-verified rows carry a real newest_pub_date; the rest do not.",
        "Episodes are not equal work. A daily six-minute brief and a three-hour interview both count as one " +
          "episode against the 250/day figure. median_duration_sec is recorded for the live-verified rows so the " +
          "spread is at least visible.",
      ],
    },
    totals: totalsFor(merged.shows),
    previous_version: previous ? { queue_version: previous.queue_version, generated: previous.generated, shows: previous.shows.length } : null,
    shows: merged.shows,
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
