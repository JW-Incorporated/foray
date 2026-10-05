/* PKG-04 (docs/roadmap/corpus.md): the shows.jsonl builder over the
   synthetic fixture (fixtures/synthetic/: podcasts A-D, counts.json).
   Reads only tracked fixture files; no network, no database, no credential,
   and no data/ file (the catalog is an inline stub). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildShows } from "./catalogue.mjs";
import { jsonlRowSource } from "./row-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "synthetic");
const COUNTS = JSON.parse(readFileSync(join(FIXTURE, "counts.json"), "utf8"));

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.corpus_podcast_id, r]));

/* C is english_candidate_status "no" and must not become a show; the row
   count is counts.json's podcasts_english.
   Mutation that turns this red: in catalogue.mjs delete
   `if (p.english_candidate_status !== "yes") continue;` (4 rows). */
test("exactly the English podcasts become rows (C excluded)", async () => {
  const { rows, stats } = await buildShows(jsonlRowSource(FIXTURE), { catalog: { shows: [] } });
  assert.equal(rows.length, 3);
  assert.equal(rows.length, COUNTS.podcasts_english);
  assert.deepEqual(rows.map((r) => r.corpus_podcast_id), ["pod-synth-a", "pod-synth-b", "pod-synth-d"]);
  assert.deepEqual(stats, { podcasts_read: 4, podcasts_english: 3, rows: 3, with_itunes_id: 2, blocked: 1, locked: 1 });
});

/* Aggregates are DISTINCT episodes: D's one episode carries srt + json and
   counts once. B has no itunes_id and no catalogue match, so no foray id.
   Mutation that turns this red: in catalogue.mjs count assets instead of
   distinct episodes — `entry.timed.add(a.owner_id)` → `entry.timed.add(a.id)`
   (D reads 2). */
test("per-show aggregates, rights flags and the itunes_id fallback", async () => {
  const { rows, chosenFeedByPodcast } = await buildShows(jsonlRowSource(FIXTURE), { catalog: { shows: [] } });
  const { "pod-synth-a": a, "pod-synth-b": b, "pod-synth-d": d } = byId(rows);
  assert.equal(a.timed_transcript_episodes, 3);
  assert.equal(a.audio_episodes, 3);
  assert.equal(a.episodes_total, 3);
  assert.equal(a.foray_show_id, "111");
  assert.equal(a.podcastindex_feed_id, "900001");
  assert.deepEqual(a.pi_categories, ["technology", "news"]);
  assert.deepEqual(a.categories, [{ category: "Technology", subcategory: null }]);
  assert.equal(a.newest_published_at, "2026-08-03T12:00:00.000Z");
  assert.equal(b.rights.itunes_block, true);
  assert.equal(b.rights.podcast_locked, false);
  assert.equal(b.foray_show_id, null);
  assert.equal(b.timed_transcript_episodes, 0);
  assert.deepEqual(b.categories, []);
  assert.equal(d.timed_transcript_episodes, 1);
  assert.equal(d.audio_episodes, 0);
  assert.equal(d.rights.podcast_locked, true);
  assert.equal(d.foray_show_id, "444");
  assert.deepEqual([...chosenFeedByPodcast], [[1, 11], [2, 12], [4, 14]]);
  assert.deepEqual(Object.keys(a), [
    "corpus_podcast_id", "podcastindex_feed_id", "itunes_id", "title", "feed_url", "feed_url_normalized",
    "language", "explicit", "image_url", "site_url", "categories", "pi_categories", "rights", "crawl",
    "episodes_total", "timed_transcript_episodes", "audio_episodes", "newest_published_at", "foray_show_id",
  ]);
});

/* The catalogue join goes through tools/shows/identity.mjs normalizeFeedUrl:
   a curated show whose feed_url differs from A's only by a trailing slash
   (and scheme/case) still maps A to that show_id, ahead of the itunes_id
   fallback.
   Mutation that turns this red: in catalogue.mjs catalogIndex, key the Map by
   the raw `show.feed_url` instead of `normalizeFeedUrl(show?.feed_url)`
   (A falls back to "111"). */
test("a catalog feed_url differing only by a trailing slash maps to its show_id", async () => {
  const catalog = { shows: [{ show_id: "synthetic-show-a", feed_url: "HTTP://Feeds.Example.org/a/rss/", apple_collection_id: 999 }] };
  const { rows } = await buildShows(jsonlRowSource(FIXTURE), { catalog });
  const a = byId(rows)["pod-synth-a"];
  assert.equal(a.feed_url, "https://feeds.example.org/a/rss");
  assert.equal(a.feed_url_normalized, "feeds.example.org/a/rss");
  assert.equal(a.foray_show_id, "synthetic-show-a");
  assert.equal(byId(rows)["pod-synth-d"].foray_show_id, "444");
});

/* Output order is corpus_podcast_id, not source order. The fixture is
   already in id order, so this wraps it in a source that yields podcasts
   reversed.
   Mutation that turns this red: delete the `rows.sort(...)` line in
   catalogue.mjs (rows come out d, b, a). */
test("rows are sorted by corpus_podcast_id regardless of source order", async () => {
  const inner = jsonlRowSource(FIXTURE);
  const reversed = {
    kind: "jsonl-reversed",
    async *rows(table) {
      const all = [];
      for await (const row of inner.rows(table)) all.push(row);
      if (table === "podcasts") all.reverse();
      yield* all;
    },
  };
  const { rows } = await buildShows(reversed, { catalog: { shows: [] } });
  const ids = rows.map((r) => r.corpus_podcast_id);
  assert.deepEqual(ids, ["pod-synth-a", "pod-synth-b", "pod-synth-d"]);
});
