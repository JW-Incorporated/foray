/* harvest-episodes.mjs: the archive row shapes (code-health-2 CH2-29, T1-06/T1-18).

   Run: node --test tools/harvest-episodes.test.mjs

   The script used to run on import (no entry guard, no exports), so nothing
   could pin what it writes into data/episode-archive.json.gz. The per-item and
   per-show shapes are exported now and pinned here: an `<item>` in
   fast-xml-parser's shape (no parser needed, so these run in CI's data-and-site
   job, which never installs backend/node_modules) and one harvested show row. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { episodeOf, harvestedShow } from "./harvest-episodes.mjs";

const ITEM = {
  title: "Episode One",
  guid: { "#text": "guid-1", "@_isPermaLink": "false" },
  pubDate: "Mon, 05 Oct 2026 10:00:00 GMT",
  "itunes:duration": "01:02:03",
  enclosure: { "@_url": "https://cdn.example.test/1.mp3", "@_length": "10", "@_type": "audio/mpeg" },
  link: "https://show.example.test/1",
  "itunes:episode": 7,
  "itunes:season": 2,
  description: "<p>Notes   with <b>HTML</b></p>",
};

/* MUTATION: drop `link:` (or any key) from episodeOf's literal -> red here. */
test("one <item> becomes one archive episode, field for field", () => {
  assert.deepEqual(episodeOf(ITEM), {
    guid: "guid-1",
    title: "Episode One",
    published_at: "2026-10-05",
    duration_min: 62,
    enclosure_url: "https://cdn.example.test/1.mp3",
    link: "https://show.example.test/1",
    episode: 7,
    season: 2,
    description: "Notes with HTML",
  });
});

/* MUTATION: guid read as `text(it.guid?.["#text"])` (string guids lost) -> red on
   the string case; read as `String(it.guid)` -> red on the object case. */
test("guid is read from the string, the CDATA-string and the object form alike; a bad pubDate is null", () => {
  assert.equal(episodeOf({ title: "t", guid: "plain" }).guid, "plain");
  assert.equal(episodeOf({ title: "t", guid: { "#text": "obj" } }).guid, "obj");
  assert.equal(episodeOf({ title: "t", guid: { "@_isPermaLink": "true" } }).guid, null);
  assert.equal(episodeOf({ title: "t" }).guid, null);
  assert.equal(episodeOf({ title: "t", pubDate: "not a date" }).published_at, null);
  assert.equal(episodeOf({ title: "t", "itunes:summary": "only summary" }).description, "only summary");
});

/* MUTATION: re-add `feed_capped_suspect` (or any key) to harvestedShow -> red. */
test("a harvested show row carries exactly these keys", () => {
  const now = new Date("2026-10-09T00:00:00.000Z");
  const episodes = [episodeOf(ITEM)];
  const row = harvestedShow({ id: 42, title: "Show", feed_url: "https://f.example.test/rss", rank: 3, episodes, now });
  assert.deepEqual(row, {
    apple_collection_id: 42,
    title: "Show",
    feed_url: "https://f.example.test/rss",
    chart_rank_overall: 3,
    episode_count_in_feed: 1,
    feed_capped_suspect: false,
    harvested_at: "2026-10-09T00:00:00.000Z",
    episodes,
  });
});
