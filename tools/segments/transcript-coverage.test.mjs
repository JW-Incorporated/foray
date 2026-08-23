/* Tests for the discover <-> availability transcript join (issue #104 follow-up).
   Run: node --test tools/segments/

   No network, no fixtures on disk: both sides of this join are small enough to
   write inline, and doing so keeps the join key visible in the test itself.

   The guard tests are the important ones. This tool exists because a broken join
   reported "0 of 1,672 episodes have a transcript" for ten days while the index
   held 8,012 of them — a wrong number that looked like a finding because zero
   was what everyone expected. Its first working version then reported 165 by
   attaching 7 transcripts to the wrong episodes. Both failures produced a
   confident number nobody could tell was wrong from the output, so every test
   below pins a way the join can go quietly wrong, not merely a way it can work.

   Each test names the one-line mutation that makes it fail, and each was run
   against that mutation before being committed (CLAUDE.md § "A green test is
   not evidence until you have broken it"). */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CoverageError,
  DURATION_TOLERANCE_SEC,
  MAX_BACKSTOP_SHARE,
  MIN_JOIN_KEY_RATIO,
  MIN_MATCHES_FOR_SHARE_GUARD,
  coverage,
  indexAvailability,
  joinItem,
  normalizeTitle,
} from "./transcript-coverage.mjs";

/* Alpha ships three transcripts (two timed, one prose); Beta ships none. */
const availability = () => ({
  generated_at: "2026-08-22T00:00:00.000Z",
  shows: [
    {
      show_id: "alpha-show",
      apple_collection_id: 111,
      title: "Alpha Show",
      dai_suspected: false,
      episodes_with_transcript: 3,
      episodes: [
        {
          guid: "a1",
          title: "Episode One",
          enclosure_url: "https://cdn.example/a1.mp3",
          duration_sec: 1000,
          transcript_url: "https://t.example/a1.vtt",
          transcript_type: "text/vtt",
          has_timestamps: true,
          transcript_types: ["text/vtt"],
        },
        {
          guid: "a2",
          title: "Episode Two — Deluxe!",
          enclosure_url: "https://cdn.example/a2.mp3",
          duration_sec: 2000,
          transcript_url: "https://t.example/a2.txt",
          transcript_type: "text/plain",
          has_timestamps: false,
          transcript_types: ["text/plain"],
        },
        {
          guid: "a3",
          title: "Episode Three",
          enclosure_url: "https://cdn.example/a3.mp3",
          duration_sec: 3000,
          transcript_url: "https://t.example/a3.srt",
          transcript_type: "application/srt",
          has_timestamps: true,
          transcript_types: ["application/srt"],
        },
      ],
    },
    {
      show_id: "beta-show",
      apple_collection_id: 222,
      title: "Beta Show",
      dai_suspected: true,
      episodes_with_transcript: 0,
      episodes: [],
    },
  ],
});

const item = (over) => ({
  show: "Alpha Show",
  apple_collection_id: 111,
  title: "Episode One",
  audio_url: "https://cdn.example/a1.mp3",
  duration_sec: 1000,
  dai_suspected: false,
  ...over,
});

/* Six curated episodes: one exact-key hit, one backstop hit, and four that must
   find nothing — including one the old duration-only fallback wrongly matched. */
const discover = () => ({
  items: [
    item({}),
    // Publisher moved CDN and Apple re-punctuated the title; the runtime agrees,
    // so this is the same episode and the backstop should take it.
    item({ title: "Episode Two - Deluxe", audio_url: "https://cdn2.example/a2.mp3", duration_sec: 2000 }),
    // Runtime within tolerance of a3, but a completely different episode. The
    // real catalogue is full of these and every one is a wrong answer.
    item({ title: "Totally Different Episode", audio_url: "https://cdn2.example/other.mp3", duration_sec: 3001 }),
    item({ title: "Unindexed", audio_url: "https://cdn.example/zzz.mp3", duration_sec: 9999 }),
    item({ show: "Beta Show", apple_collection_id: 222, title: "B1", audio_url: "https://cdn.example/b1.mp3", duration_sec: 500, dai_suspected: true }),
    item({ show: "Beta Show", apple_collection_id: 222, title: "B2", audio_url: "https://cdn.example/b2.mp3", duration_sec: 600, dai_suspected: true }),
  ],
});

/* MUTATION: in `coverage`, change `keyed < MIN_JOIN_KEY_RATIO` to `keyed < 0`.
   The guard stops firing and a pre-join-key index reports 0% coverage instead of
   an error — the exact ten-day bug. Verified failing. */
test("an availability index without the join key is an error, not 0% coverage", () => {
  const stale = availability();
  for (const show of stale.shows) for (const ep of show.episodes) delete ep.enclosure_url;

  assert.throws(
    () => coverage({ discover: discover(), availability: stale }),
    (e) => e instanceof CoverageError && e.code === "NO_JOIN_KEY" && /sweep-transcripts\.mjs --reset/.test(e.message),
  );
});

/* A PARTIAL collapse is the dangerous one, and the all-or-nothing guard missed
   it entirely.

   MUTATION: change `MIN_JOIN_KEY_RATIO` from 0.9 to 0. Verified failing.

   This is a reviewer's finding reproduced in miniature: stripping
   `enclosure_url` from all but one of 8,250 real rows left the old guard silent
   while the backstop reported a confident 139 of 1,672 (8.3%). One row keeping
   the key was enough to make a broken index look merely disappointing. */
test("a PARTIAL join-key collapse is an error too, not a smaller number", () => {
  const partial = availability();
  const rows = partial.shows[0].episodes;
  for (const ep of rows.slice(1)) delete ep.enclosure_url; // 1 of 3 keeps the key

  assert.ok(MIN_JOIN_KEY_RATIO > 0 && MIN_JOIN_KEY_RATIO <= 1, "a ratio floor, not a zero check");
  assert.throws(
    () => coverage({ discover: discover(), availability: partial }),
    (e) => e instanceof CoverageError && e.code === "NO_JOIN_KEY" && /1 of 3/.test(e.message),
  );
});

/* MUTATION: change `MAX_BACKSTOP_SHARE` from 0.1 to 1. Verified failing.

   The module header promises it "fails loudly if the match rate collapses".
   That promise went unimplemented through two rounds of review. The backstop
   exists to survive a publisher moving CDNs; when it is carrying the join, the
   exact key has broken and every number is an understatement nobody notices.

   Built at scale on purpose: a share needs enough matches to mean anything, and
   the two-episode fixture above cannot express "most matches" — its single
   legitimate backstop hit is already 50%. */
test("the backstop carrying the join is an error, not a quieter answer", () => {
  const n = MIN_MATCHES_FOR_SHARE_GUARD + 5;
  const episodes = Array.from({ length: n }, (_, i) => ({
    guid: `e${i}`,
    title: `Episode ${i}`,
    enclosure_url: `https://cdn.example/e${i}.mp3`,
    duration_sec: 1000 + i,
    transcript_url: `https://t.example/e${i}.vtt`,
    transcript_type: "text/vtt",
    has_timestamps: true,
    transcript_types: ["text/vtt"],
  }));
  const shows = [{ show_id: "big", apple_collection_id: 777, title: "Big Show", dai_suspected: false, episodes }];
  const items = episodes.map((e) => ({
    show: "Big Show",
    apple_collection_id: 777,
    title: e.title,
    audio_url: e.enclosure_url,
    duration_sec: e.duration_sec,
  }));
  const swept = { generated_at: "2026-08-22T00:00:00.000Z", shows };

  // Healthy: every match comes from the exact key, so the guard stays quiet.
  const ok = coverage({ discover: { items }, availability: swept });
  assert.equal(ok.coverage.matched_via.enclosure_url, n);
  assert.equal(ok.coverage.matched_via["title+duration"], 0);

  // Now the publisher moves CDNs: the key still exists, it just no longer
  // matches discover.json, and the backstop silently carries the whole join.
  for (const ep of episodes) ep.enclosure_url = `https://newcdn.example/${ep.guid}.mp3`;
  assert.throws(
    () => coverage({ discover: { items }, availability: swept }),
    (e) => e instanceof CoverageError && e.code === "BACKSTOP_CARRYING_JOIN",
  );
});

/* THE DISTINCTION THAT STARTED ALL OF THIS.

   MUTATION: in `coverage`, change `if (!availability?.generated_at)` to `if
   (false)`. Verified failing.

   "Never swept" and "swept everything and found nothing" are different facts
   that produced the identical line, `0 of 1,672 (0%)`. A probe of the committed
   index read zero and nobody could tell which had happened — which is why the
   free-transcript pool went uncounted for ten days. Provenance, not counts,
   separates them: an index that was never generated has no `generated_at`. */
test("never-swept and swept-but-empty are different answers", () => {
  const neverSwept = { shows: [] };
  assert.throws(
    () => coverage({ discover: discover(), availability: neverSwept }),
    (e) => e instanceof CoverageError && e.code === "NEVER_SWEPT",
  );

  // Swept, dated, and every feed came back empty. That is a real zero.
  const sweptEmpty = {
    generated_at: "2026-08-22T00:00:00.000Z",
    shows: [{ show_id: "x", apple_collection_id: 9, title: "X", episodes: [] }],
  };
  const report = coverage({ discover: discover(), availability: sweptEmpty });
  assert.equal(report.coverage.episodes_with_transcript, 0);
  assert.deepEqual(report.by_show, []);
});

/* MUTATION: in `joinItem`, delete the `if (direct) return { ...direct, via:
   "enclosure_url" };` line. The exact key stops being consulted, the backstop
   absorbs the match, and `matched_via` misreports which key carried the join —
   the signal that tells us the key has drifted. Verified failing. */
test("the exact enclosure key is preferred, and every match records how it was made", () => {
  const report = coverage({ discover: discover(), availability: availability() });

  assert.deepEqual(report.coverage.matched_via, { enclosure_url: 1, "title+duration": 1 });
  assert.equal(report.availability.episode_rows_with_enclosure_url, 3);
});

/* THE ONE THAT CAUGHT A REAL BUG.

   MUTATION: in `joinItem`, delete the `normalizeTitle(e.title) === want &&`
   conjunct so the backstop matches on duration alone. Verified failing.

   Both halves below are real matches the independent-fallback version of this
   join produced against the live catalogue, and both are wrong:

     duration-only: Geology Bites "Bernhard Steinberger on Whether Hotspots Are
                    Fixed" (1736s) matched "Alec Brenner on When Tectonic Plates
                    First Moved" (1735s)
     title-only:    The BBQ Central Show matched its own title at 563s against a
                    303s row — a re-cut, so every timestamp in it is wrong

   That version reported 165 covered episodes. Seven of them were fiction. A miss
   costs one transcript; a mismatch produces a segment whose anchors point into
   different audio, and nothing downstream can detect it. */
test("the backstop requires title AND duration; neither alone can match", () => {
  const index = indexAvailability(availability());

  // Duration lines up with a3, title does not: the Geology Bites failure.
  assert.equal(joinItem(item({ title: "Some Other Episode", audio_url: "https://x/none.mp3", duration_sec: 3000 }), index), null);
  // Title lines up with a3, runtime says it is a different cut: the BBQ failure.
  assert.equal(joinItem(item({ title: "Episode Three", audio_url: "https://x/none.mp3", duration_sec: 1500 }), index), null);
  // Both agree — same episode, and it matches.
  const hit = joinItem(item({ title: "Episode Three", audio_url: "https://x/none.mp3", duration_sec: 3000 }), index);
  assert.equal(hit.via, "title+duration");
  assert.equal(hit.episode.guid, "a3");
});

/* MUTATION: change `DURATION_TOLERANCE_SEC` from 2 to 200. A re-cut 100s adrift
   is then accepted as the same episode. Verified failing.

   The offsets below are literals on purpose. Writing them as `3000 +
   DURATION_TOLERANCE_SEC` reads better and proves nothing: the fixture then
   moves with the constant, and this mutation SURVIVED the first version of this
   test for exactly that reason. A test that derives its input from the value
   under test can only confirm the code agrees with itself. */
test("the corroborating runtime admits rounding and nothing else", () => {
  assert.equal(DURATION_TOLERANCE_SEC, 2, "a rounding allowance, not a search radius");
  const index = indexAvailability(availability());
  const near = joinItem(item({ title: "Episode Three", audio_url: "https://x/none.mp3", duration_sec: 3002 }), index);
  const far = joinItem(item({ title: "Episode Three", audio_url: "https://x/none.mp3", duration_sec: 3003 }), index);

  assert.equal(near.episode.guid, "a3");
  assert.equal(far, null);
});

/* MUTATION: in `normalizeTitle`, drop the `.toLowerCase()` call. "Episode Two -
   Deluxe" stops matching "Episode Two — Deluxe!" and the backstop loses the one
   match it exists to catch. Verified failing. */
test("titles match across re-punctuation and case", () => {
  assert.equal(normalizeTitle("Episode Two — Deluxe!"), normalizeTitle("Episode Two - Deluxe"));
  assert.equal(normalizeTitle("#497 – Foo"), normalizeTitle("497 Foo"));

  const hit = joinItem(
    item({ title: "episode two, deluxe", audio_url: "https://cdn2.example/moved.mp3", duration_sec: 2000 }),
    indexAvailability(availability()),
  );
  assert.equal(hit.via, "title+duration");
  assert.equal(hit.episode.guid, "a2");
});

/* MUTATION: in `coverage`, change `if (hit.episode.has_timestamps)` to `if
   (true)`. Prose transcripts get counted as anchorable and the timed number —
   the only one that can produce a segment (ADR-0007) — overstates by the whole
   text/plain pool, which is the third largest format in the wild.
   Verified failing. */
test("prose transcripts count as found but never as anchorable", () => {
  const report = coverage({ discover: discover(), availability: availability() });

  assert.equal(report.coverage.episodes_with_transcript, 2);
  assert.equal(report.coverage.episodes_with_timed_transcript, 1);
  assert.equal(report.coverage.formats["text/plain"], 1);
});

/* MUTATION: in `coverage`, remove the `.filter((s) => s.with_transcript > 0)`
   from the `shows` construction. Shows with nothing to fetch appear in the
   distribution, and "concentrated in N shows" — the number that decides whether
   this pool can carry a Foray — silently counts the whole catalogue.
   Verified failing. */
test("the by-show distribution lists only shows that actually ship transcripts", () => {
  const report = coverage({ discover: discover(), availability: availability() });

  assert.equal(report.discover.shows, 2);
  assert.equal(report.coverage.shows_with_transcript, 1);
  assert.deepEqual(report.by_show.map((s) => s.show), ["Alpha Show"]);
  assert.equal(report.by_show[0].discover_episodes, 4);
  assert.equal(report.by_show[0].with_timed_transcript, 1);
});

/* MUTATION: in `findShow`, return `null` instead of the `showsByTitle` lookup.
   A catalogue entry whose Apple id has changed loses the backstop and reads as
   zero coverage for the whole show. Verified failing. */
test("a show still resolves when its Apple id has moved", () => {
  const index = indexAvailability(availability());
  const hit = joinItem(item({ apple_collection_id: 999999, title: "Episode Three", audio_url: "https://x/none.mp3", duration_sec: 3000 }), index);

  assert.equal(hit.via, "title+duration");
  assert.equal(hit.episode.guid, "a3");
});

/* MUTATION: in `coverage`, change the `items.length === 0` throw to
   `items.length < 0`. An empty catalogue then reports "0 of 0 episodes have a
   transcript (0%)", which is a division-by-zero dressed as a measurement.
   Verified failing. */
test("an empty catalogue is refused rather than reported as 0%", () => {
  assert.throws(
    () => coverage({ discover: { items: [] }, availability: availability() }),
    (e) => e instanceof CoverageError && e.code === "EMPTY_DISCOVER",
  );
  assert.throws(
    () => coverage({ discover: discover(), availability: {} }),
    (e) => e instanceof CoverageError && e.code === "BAD_AVAILABILITY",
  );
});
