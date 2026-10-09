/* shows.jsonl builder for the corpus export (PKG-04, G-10;
   docs/roadmap/corpus.md §3 "PKG-04 · catalogue.mjs").

   One row per English podcast (`english_candidate_status === "yes"`), built
   by streaming the corpus tables through a row source (row-source.mjs's
   interface; jsonlRowSource for fixtures, pg-row-source.mjs live). Only the
   English podcast Map, the per-podcast aggregates and the episode → podcast
   index are held in memory; every table is read once, as a stream.

   Joins (corpus brief §1, docs/curation/corpus-integration-brief.md:23-36):
   the feed URL is the join key to 4a (D2), normalised by tools/shows/
   identity.mjs's normalizeFeedUrl (imported, never copied, so a catalogue
   show and a corpus show match by exactly the rule tools/shows/ uses);
   `podcast_source_records.itunes_id` (~64 % set) is the cross-reference to
   catalog.json's `apple_collection_id`.

   Mime classification is mimes.mjs's isTimedMime: this module defines no
   mime list. */
import { normalizeFeedUrl } from "../shows/identity.mjs";
import { isTimedMime } from "./mimes.mjs";
import { rowsOf } from "./rows.mjs";
import { instant, toIsoOrNull } from "./time.mjs";

const TRUTHY_RAW = new Set(["yes", "true", "1"]);

/** Rights flags arrive as the raw RSS text (`itunes:block`,
    `podcast:locked`); "yes" | "true" | "1" (any case) is set, anything else
    — including null — is not (brief §5). */
function rawFlag(value) {
  if (value == null) return false;
  return TRUTHY_RAW.has(String(value).trim().toLowerCase());
}

/** `podcast_feeds.categories` is json (brief §4): an array of
    `{category, subcategory}`. A string is parsed (a driver that does not
    decode json columns); anything that is not an array becomes []. */
function feedCategories(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ category: c.category ?? null, subcategory: c.subcategory ?? null }));
}

/** PodcastIndex's `extra_source_json.category1..category10` (brief §4), in
    index order, non-null strings only. */
function piCategories(extra) {
  let value = extra;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const out = [];
  for (let i = 1; i <= 10; i += 1) {
    const c = value[`category${i}`];
    if (typeof c === "string" && c !== "") out.push(c);
  }
  return out;
}

/** The catalogue's `foray_show_id` lookup: normalised feed URL → show_id. */
function catalogIndex(catalog) {
  const byFeed = new Map();
  for (const show of rowsOf(catalog)) {
    const norm = normalizeFeedUrl(show?.feed_url);
    if (norm && show?.show_id != null && !byFeed.has(norm)) byFeed.set(norm, String(show.show_id));
  }
  return byFeed;
}

/**
 * Builds the shows.jsonl rows.
 *
 * @param source a row source (row-source.mjs interface)
 * @param {{catalog?: {shows: Array<{show_id, feed_url}>} | Array}} options
 *   `catalog` is data/catalog.json's parsed object (or its `shows` array);
 *   the caller reads it, this module never touches data/.
 * @returns {Promise<{rows: object[], stats: object, chosenFeedByPodcast: Map<number, number>}>}
 *   `chosenFeedByPodcast` maps the corpus's internal podcast id to the feed id
 *   this builder chose; episodes.mjs (PKG-05) takes it as an injected Map so
 *   the two modules stay independent, and its keys are the podcast ids to
 *   build episodes for.
 */
export async function buildShows(source, { catalog } = {}) {
  const byFeed = catalogIndex(catalog);

  // 1. English podcasts. podcasts_read counts every podcast row seen.
  const podcasts = new Map();
  let podcastsRead = 0;
  for await (const p of source.rows("podcasts")) {
    podcastsRead += 1;
    if (p.english_candidate_status !== "yes") continue;
    podcasts.set(p.id, {
      podcast: p,
      feed: null,
      link: null,
      record: null,
      episodesTotal: 0,
      newestPublishedMs: null,
      timed: new Set(),
      audio: new Set(),
    });
  }

  // 2. Feeds: the one with the latest last_success_at, else the first seen.
  for await (const f of source.rows("podcast_feeds")) {
    const entry = podcasts.get(f.podcast_id);
    if (!entry) continue;
    if (entry.feed === null) {
      entry.feed = f;
      continue;
    }
    const cur = instant(entry.feed.last_success_at);
    const next = instant(f.last_success_at);
    if (next !== null && (cur === null || next > cur)) entry.feed = f;
  }

  // 3. Source links → source records. A link on the chosen feed wins over
  //    the first link seen; only the record ids actually needed are kept.
  for await (const l of source.rows("podcast_source_links")) {
    const entry = podcasts.get(l.podcast_id);
    if (!entry) continue;
    const onChosen = entry.feed !== null && l.feed_id === entry.feed.id;
    const curOnChosen = entry.link !== null && entry.feed !== null && entry.link.feed_id === entry.feed.id;
    if (entry.link === null || (onChosen && !curOnChosen)) entry.link = l;
  }
  const wantRecords = new Map();
  for (const entry of podcasts.values()) {
    if (entry.link) wantRecords.set(entry.link.podcast_source_record_id, null);
  }
  for await (const r of source.rows("podcast_source_records")) {
    if (wantRecords.has(r.id)) wantRecords.set(r.id, r);
  }
  for (const entry of podcasts.values()) {
    if (entry.link) entry.record = wantRecords.get(entry.link.podcast_source_record_id) ?? null;
  }

  // 4. Episodes of English podcasts: totals, newest date, episode → podcast.
  const podcastOfEpisode = new Map();
  for await (const e of source.rows("episodes")) {
    const entry = podcasts.get(e.podcast_id);
    if (!entry) continue;
    podcastOfEpisode.set(e.id, e.podcast_id);
    entry.episodesTotal += 1;
    const t = instant(e.source_published_at);
    if (t !== null && (entry.newestPublishedMs === null || t > entry.newestPublishedMs)) {
      entry.newestPublishedMs = t;
    }
  }

  // 5. Episode assets: DISTINCT episodes with a timed transcript / audio.
  //    Sets, not counters: D's episode carries srt + json and counts once.
  for await (const a of source.rows("assets")) {
    if (a.owner_type !== "episode") continue;
    const podcastId = podcastOfEpisode.get(a.owner_id);
    if (podcastId === undefined) continue;
    const entry = podcasts.get(podcastId);
    if (isTimedMime(a.mime_type)) entry.timed.add(a.owner_id);
    if (a.asset_type === "alternate" && typeof a.mime_type === "string" && a.mime_type.toLowerCase().startsWith("audio/")) {
      entry.audio.add(a.owner_id);
    }
  }

  const rows = [];
  const chosenFeedByPodcast = new Map();
  const stats = { podcasts_read: podcastsRead, podcasts_english: podcasts.size, rows: 0, with_itunes_id: 0, blocked: 0, locked: 0 };
  for (const [podcastId, entry] of podcasts) {
    const { podcast: p, feed, record } = entry;
    if (feed) chosenFeedByPodcast.set(podcastId, feed.id);
    const feedUrl = feed?.current_url ?? null;
    const feedUrlNormalized = feedUrl == null ? null : normalizeFeedUrl(feedUrl) || null;
    const itunesId = record?.itunes_id ?? null;
    const rights = { itunes_block: rawFlag(feed?.itunes_block_raw), podcast_locked: rawFlag(feed?.podcast_locked_raw) };
    let forayShowId = null;
    if (feedUrlNormalized && byFeed.has(feedUrlNormalized)) forayShowId = byFeed.get(feedUrlNormalized);
    else if (itunesId != null) forayShowId = String(itunesId);
    rows.push({
      corpus_podcast_id: p.public_id,
      podcastindex_feed_id: record?.source_record_id ?? null,
      itunes_id: itunesId,
      title: p.canonical_title ?? null,
      feed_url: feedUrl,
      feed_url_normalized: feedUrlNormalized,
      language: p.declared_language ?? null,
      explicit: p.explicit ?? null,
      image_url: p.image_url ?? null,
      site_url: p.site_url ?? null,
      categories: feedCategories(feed?.categories),
      pi_categories: piCategories(record?.extra_source_json),
      rights,
      crawl: {
        tier: feed?.crawl_tier ?? null,
        rank: feed?.crawl_rank ?? null,
        last_success_at: toIsoOrNull(feed?.last_success_at),
        status: feed?.status ?? null,
      },
      episodes_total: entry.episodesTotal,
      timed_transcript_episodes: entry.timed.size,
      audio_episodes: entry.audio.size,
      newest_published_at: entry.newestPublishedMs === null ? null : new Date(entry.newestPublishedMs).toISOString(),
      foray_show_id: forayShowId,
    });
    if (itunesId != null) stats.with_itunes_id += 1;
    if (rights.itunes_block) stats.blocked += 1;
    if (rights.podcast_locked) stats.locked += 1;
  }

  rows.sort((a, b) => (a.corpus_podcast_id < b.corpus_podcast_id ? -1 : a.corpus_podcast_id > b.corpus_podcast_id ? 1 : 0));
  stats.rows = rows.length;
  return { rows, stats, chosenFeedByPodcast };
}
