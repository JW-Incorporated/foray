/* CH2-30 (docs/roadmap/code-health-2.md, T1-20): the corpus export's one
   timestamp rule. pg returns timestamptz columns as Date objects and the
   JSONL fixture as ISO strings; both must reach the same instant, to the
   millisecond, in every builder. Before CH2-30 catalogue.mjs and episodes.mjs
   carried private `Date.parse` copies: `Date.parse(date)` goes through
   `Date#toString`, which has no milliseconds, so with `--source pg` two
   feeds whose `last_success_at` differed only in ms tied (first seen won)
   and every written timestamp was truncated to the second, while delta.mjs
   and manifest.mjs (which had the `instanceof Date` branch) kept the ms.

   In-memory row sources only: no fixture file, no network, no database, no
   credential, no data/ file. The floor for this suite lives in
   test/suite-integrity.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildShows } from "./catalogue.mjs";
import { buildEpisodes } from "./episodes.mjs";

/** A row source (row-source.mjs interface) over in-memory tables. */
function memorySource(tables) {
  return {
    kind: "memory",
    async *rows(table) {
      for (const row of tables[table] ?? []) yield row;
    },
  };
}

const podcast = { id: 1, public_id: "pod-1", english_candidate_status: "yes", canonical_title: "One" };
const feed = (id, lastSuccessAt) => ({ id, podcast_id: 1, current_url: `https://example.com/${id}.xml`, last_success_at: lastSuccessAt });

async function chosen(feeds) {
  const { rows, chosenFeedByPodcast } = await buildShows(memorySource({ podcasts: [podcast], podcast_feeds: feeds }), { catalog: [] });
  return { feedId: chosenFeedByPodcast.get(1), lastSuccessAt: rows[0].crawl.last_success_at };
}

/* Characterization (green before and after CH2-30): ISO strings keep their
   milliseconds through Date.parse, so the later feed wins and the written
   instant is exact. */
test("ISO strings: the feed with the later last_success_at wins, to the millisecond", async () => {
  assert.deepEqual(await chosen([feed(10, "2026-10-01T06:00:00.100Z"), feed(20, "2026-10-01T06:00:00.900Z")]), {
    feedId: 20,
    lastSuccessAt: "2026-10-01T06:00:00.900Z",
  });
  assert.deepEqual(await chosen([feed(10, null), feed(20, "not a date")]), { feedId: 10, lastSuccessAt: null }, "no instant on either: first seen");
  assert.deepEqual(await chosen([feed(10, null), feed(20, "2026-10-01T06:00:00Z")]), { feedId: 20, lastSuccessAt: "2026-10-01T06:00:00.000Z" });
});

/* RED before CH2-30: with pg Date objects the two feeds tied at second
   precision, feed 10 (first seen) won and the ms were dropped.
   Mutation that turns this red: reintroduce a `Date.parse`-only copy (drop
   the `value instanceof Date` branch from time.mjs instant()). */
test("pg Date objects: the feed with the later last_success_at wins, to the millisecond", async () => {
  const early = new Date("2026-10-01T06:00:00.100Z");
  const late = new Date("2026-10-01T06:00:00.900Z");
  assert.deepEqual(await chosen([feed(10, early), feed(20, late)]), { feedId: 20, lastSuccessAt: "2026-10-01T06:00:00.900Z" });
  assert.deepEqual(await chosen([feed(10, late), feed(20, early)]), { feedId: 10, lastSuccessAt: "2026-10-01T06:00:00.900Z" });
});

/* RED before CH2-30 (same mutation): newest_published_at, an episode's
   published_at and its updated_at lost their ms on a pg Date. */
test("pg Date objects keep their milliseconds in shows.jsonl and episodes.jsonl", async () => {
  const episode = {
    id: 7,
    public_id: "ep-7",
    podcast_id: 1,
    canonical_title: "Seven",
    source_published_at: new Date("2026-09-30T12:34:56.789Z"),
    updated_at: new Date("2026-10-01T01:02:03.456Z"),
  };
  const source = memorySource({ podcasts: [podcast], podcast_feeds: [feed(10, null)], episodes: [episode] });
  const { rows, chosenFeedByPodcast } = await buildShows(source, { catalog: [] });
  assert.equal(rows[0].newest_published_at, "2026-09-30T12:34:56.789Z");
  const shows = [];
  for await (const s of buildEpisodes(source, { chosenFeedByPodcast })) shows.push(s);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].rows[0].published_at, "2026-09-30T12:34:56.789Z");
  assert.equal(shows[0].rows[0].updated_at, "2026-10-01T01:02:03.456Z");
});
