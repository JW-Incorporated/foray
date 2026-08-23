/* Tests for the transcript availability sweep (issue #104).
   Run: node --test tools/segments/

   Scope is the pure half of the file — tag extraction, the timestamp
   classification, the summary arithmetic, and checkpoint resume. **Nothing
   here touches the network**: the feed bodies are fixtures, so the suite is
   deterministic, runnable in CI, and cannot be turned green or red by a
   publisher changing their feed at 3am.

   The classification test is the important one. `has_timestamps` decides
   whether an episode can anchor a segment boundary at all (ADR-0007), and
   `text/plain` is the third most published transcript format in the wild —
   so a matcher that quietly accepted prose would not look broken, it would
   look like a much larger free corpus than we actually have. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SweepError,
  TIMED_TRANSCRIPT_TYPES,
  PROSE_TRANSCRIPT_TYPES,
  attrOf,
  decodeEntities,
  emptyProgress,
  hasTimestamps,
  loadProgress,
  normalizeMimeType,
  parseFeed,
  pendingShows,
  pickTranscript,
  summarizeRun,
  summarizeShow,
  sweepShow,
  writeJsonAtomic,
} from "./sweep-transcripts.mjs";

const feed = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>Fixture Show</title>${items}</channel></rss>`;

const ITEM_FULL = `<item>
  <title>Fusion, honestly</title>
  <guid isPermaLink="false">ep-0001</guid>
  <pubDate>Tue, 05 Aug 2026 09:00:00 +0000</pubDate>
  <itunes:duration>01:12:30</itunes:duration>
  <enclosure url="https://dcs.megaphone.fm/EP0001.mp3?updated=1" length="61000000" type="audio/mpeg"/>
  <podcast:transcript url="https://example.com/ep1.txt" type="text/plain"/>
  <podcast:transcript url="https://example.com/ep1.vtt" type="text/vtt" language="en"/>
  <podcast:transcript url="https://example.com/ep1.json" type="application/json"/>
  <podcast:chapters url="https://example.com/ep1-chapters.json" type="application/json+chapters"/>
</item>`;

// A plain-text-only episode: has a transcript, cannot anchor a boundary.
const ITEM_PROSE_ONLY = `<item>
  <title><![CDATA[Prose only & proud]]></title>
  <guid>ep-0002</guid>
  <itunes:duration>2715</itunes:duration>
  <enclosure url="https://static.example.org/ep2.mp3" type="audio/mpeg"/>
  <podcast:transcript url="https://example.com/ep2.html?a=1&amp;b=2" type="text/html" />
</item>`;

// No transcript at all, no chapters — the ~90% case.
const ITEM_BARE = `<item>
  <title>Nothing to index</title>
  <guid>ep-0003</guid>
  <itunes:duration>45:00</itunes:duration>
  <enclosure url="https://static.example.org/ep3.mp3" type="audio/mpeg"/>
</item>`;

// --------------------------------------------------------------- extraction

test("extracts every recorded field from one item", () => {
  const { episodes } = parseFeed(feed(ITEM_FULL));
  assert.equal(episodes.length, 1);
  const ep = episodes[0];
  assert.equal(ep.guid, "ep-0001");
  assert.equal(ep.title, "Fusion, honestly");
  assert.equal(ep.duration_sec, 4350);
  assert.equal(ep.chapters_url, "https://example.com/ep1-chapters.json");
  assert.deepEqual(ep.transcript_types, ["text/plain", "text/vtt", "application/json"]);
});

test("the enclosure of the first item is offered as the DAI sample", () => {
  const { sample_enclosure_url } = parseFeed(feed(ITEM_BARE + ITEM_FULL));
  assert.equal(sample_enclosure_url, "https://static.example.org/ep3.mp3");
});

test("decodes entities in attribute URLs — a literal &amp; would 404", () => {
  const { episodes } = parseFeed(feed(ITEM_PROSE_ONLY));
  assert.equal(episodes[0].transcript_url, "https://example.com/ep2.html?a=1&b=2");
});

test("unwraps CDATA titles", () => {
  const { episodes } = parseFeed(feed(ITEM_PROSE_ONLY));
  assert.equal(episodes[0].title, "Prose only & proud");
});

test("reads the tag whatever namespace prefix the feed bound it to", () => {
  // Nearly every feed writes `podcast:` — but the prefix is arbitrary per the
  // XML spec, and a feed that binds the same namespace to `pc:` is not broken.
  const { episodes } = parseFeed(feed(`<item><guid>x</guid>
    <pc:transcript url="https://example.com/x.srt" type="application/srt"/>
    <pc:chapters url="https://example.com/x.json"/></item>`));
  assert.equal(episodes[0].transcript_url, "https://example.com/x.srt");
  assert.equal(episodes[0].chapters_url, "https://example.com/x.json");
});

test("handles single-quoted attributes and non-self-closing tags", () => {
  const { episodes } = parseFeed(feed(`<item><guid>y</guid>
    <podcast:transcript url='https://example.com/y.vtt' type='text/vtt'></podcast:transcript></item>`));
  assert.equal(episodes[0].transcript_url, "https://example.com/y.vtt");
  assert.equal(episodes[0].has_timestamps, true);
});

test("a transcript tag with no url is treated as absent, not as a transcript", () => {
  const { episodes } = parseFeed(feed(`<item><guid>z</guid><podcast:transcript type="text/vtt"/></item>`));
  assert.equal(episodes[0].transcript_url, null);
  assert.equal(episodes[0].has_timestamps, false);
  assert.deepEqual(episodes[0].transcript_types, []);
});

test("falls back to the enclosure url when an item carries no guid", () => {
  const { episodes } = parseFeed(feed(`<item><enclosure url="https://static.example.org/n.mp3"/></item>`));
  assert.equal(episodes[0].guid, "https://static.example.org/n.mp3");
});

test("normalizes the three itunes:duration dialects, and refuses garbage", () => {
  const { episodes } = parseFeed(feed(ITEM_FULL + ITEM_PROSE_ONLY + ITEM_BARE +
    `<item><guid>g</guid><itunes:duration>not a time</itunes:duration></item>`));
  assert.deepEqual(episodes.map((e) => e.duration_sec), [4350, 2715, 2700, null]);
});

test("attrOf and decodeEntities tolerate junk instead of throwing", () => {
  assert.equal(attrOf(null, "url"), null);
  assert.equal(attrOf("<podcast:transcript/>", "url"), null);
  assert.equal(attrOf('<podcast:transcript url="  " />', "url"), null);
  assert.equal(decodeEntities(null), null);
  assert.equal(decodeEntities("a &notarealentity; b"), "a &notarealentity; b");
  assert.equal(decodeEntities("&#39;&#x27;&quot;"), "''\"");
});

// ----------------------------------------------------- timestamp capability

test("timestamped formats are exactly the four that carry a timeline", () => {
  for (const t of TIMED_TRANSCRIPT_TYPES) assert.equal(hasTimestamps(t), true, t);
  assert.deepEqual(TIMED_TRANSCRIPT_TYPES, ["text/vtt", "application/srt", "application/x-subrip", "application/json"]);
});

test("prose formats are never timestamped — the whole point of the file", () => {
  for (const t of PROSE_TRANSCRIPT_TYPES) assert.equal(hasTimestamps(t), false, t);
  assert.deepEqual(PROSE_TRANSCRIPT_TYPES, ["text/plain", "text/html"]);
});

test("an unknown or missing type is not assumed to be anchorable", () => {
  for (const t of [null, undefined, "", "   ", "application/pdf", "text/markdown", "vtt"]) {
    assert.equal(hasTimestamps(t), false, String(t));
  }
});

test("mime parameters and casing do not defeat the match", () => {
  assert.equal(hasTimestamps("text/vtt; charset=utf-8"), true);
  assert.equal(hasTimestamps("TEXT/VTT"), true);
  assert.equal(hasTimestamps("  application/x-subrip  "), true);
  assert.equal(hasTimestamps("Text/Plain; charset=utf-8"), false);
  assert.equal(normalizeMimeType("TEXT/VTT ; charset=utf-8"), "text/vtt");
  assert.equal(normalizeMimeType(null), null);
});

test("picks the best timed format, in the same order parser.ts uses", () => {
  const all = [
    { url: "p", type: "text/plain" },
    { url: "j", type: "application/json" },
    { url: "s", type: "application/srt" },
    { url: "v", type: "text/vtt" },
  ];
  assert.equal(pickTranscript(all).url, "v");
  assert.equal(pickTranscript(all.filter((t) => t.type !== "text/vtt")).url, "s");
  assert.equal(pickTranscript([{ url: "x", type: "application/x-subrip" }, { url: "j", type: "application/json" }]).url, "x");
  assert.equal(pickTranscript([{ url: "j", type: "application/json" }, { url: "p", type: "text/plain" }]).url, "j");
});

test("with no timed format at all, the prose transcript is still recorded", () => {
  // Recorded, but flagged unanchorable: "we have text for this episode" is
  // useful to A10 topic selection even when Lane C cannot cut it.
  const picked = pickTranscript([{ url: "p", type: "text/plain" }, { url: "h", type: "text/html" }]);
  assert.equal(picked.url, "p");
  assert.equal(hasTimestamps(picked.type), false);
  assert.equal(pickTranscript([]), null);
  assert.equal(pickTranscript(null), null);
});

// --------------------------------------------------------- named failures

test("a broken feed raises a coded error instead of returning zero episodes", () => {
  // The starter-kit lesson: a run that reports success while indexing nothing
  // is worse than one that crashes, because the empty index is what every
  // later lane reads as truth.
  assert.throws(() => parseFeed("<!doctype html><html><body>404 not found</body></html>"), (e) => e instanceof SweepError && e.code === "NOT_XML");
  assert.throws(() => parseFeed(feed("")), (e) => e instanceof SweepError && e.code === "EMPTY_FEED");
  assert.throws(() => parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>a</title></entry></feed>`), (e) => e instanceof SweepError && e.code === "NOT_RSS");
  assert.throws(() => parseFeed(""), (e) => e instanceof SweepError && e.code === "NOT_XML");
});

// ------------------------------------------------------------- aggregation

test("per-show counts separate 'has a transcript' from 'can be anchored'", () => {
  const { episodes } = parseFeed(feed(ITEM_FULL + ITEM_PROSE_ONLY + ITEM_BARE));
  const rec = summarizeShow({ show_id: "fixture" }, episodes);
  assert.equal(rec.episodes_total, 3);
  assert.equal(rec.episodes_with_transcript, 2);
  assert.equal(rec.episodes_with_timed_transcript, 1);
  assert.equal(rec.episodes_with_chapters, 1);
  assert.equal(rec.transcript_tags, 4);
  assert.deepEqual(rec.transcript_types, { "text/plain": 1, "text/vtt": 1, "application/json": 1, "text/html": 1 });
});

test("run summary splits coverage by DAI, which is the finding that reshaped the epic", () => {
  const s = summarizeRun([
    { status: "ok", dai_suspected: true, episodes_total: 100, episodes_with_transcript: 13, episodes_with_timed_transcript: 10, episodes_with_chapters: 5, transcript_tags: 39, transcript_types: { "text/vtt": 13, "text/plain": 13, "application/srt": 13 } },
    { status: "ok", dai_suspected: false, episodes_total: 100, episodes_with_transcript: 1, episodes_with_timed_transcript: 0, episodes_with_chapters: 0, transcript_tags: 1, transcript_types: { "text/plain": 1 } },
    { status: "ok", dai_suspected: null, episodes_total: 10, episodes_with_transcript: 0, episodes_with_timed_transcript: 0, episodes_with_chapters: 0, transcript_tags: 0, transcript_types: {} },
    { status: "error", error_code: "HTTP_404" },
  ]);
  assert.equal(s.shows_ok, 3);
  assert.equal(s.shows_failed, 1);
  assert.deepEqual(s.error_codes, { HTTP_404: 1 });
  assert.equal(s.dai.transcript_coverage_pct, 13);
  assert.equal(s.non_dai.transcript_coverage_pct, 1);
  assert.equal(s.transcript_coverage_pct, 6.7);
  assert.equal(s.timed_transcript_coverage_pct, 4.8);
  assert.equal(s.transcript_tags_per_transcribed_episode, 2.86);
  assert.deepEqual(s.transcript_types, { "text/vtt": 13, "text/plain": 14, "application/srt": 13 });
});

test("a failed show contributes no episodes to the coverage denominator", () => {
  // Otherwise a bad afternoon on one CDN reads as "transcripts got rarer".
  const s = summarizeRun([{ status: "error", error_code: "TIMEOUT", episodes_total: 0, episodes_with_transcript: 0 }]);
  assert.equal(s.episodes_total, 0);
  assert.equal(s.transcript_coverage_pct, 0);
});

// ---------------------------------------------------------------- resuming

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), "foray-sweep-")), name);
}

const CATALOG = [
  { show_id: "a", feed_url: "https://a.example/rss" },
  { show_id: "b", feed_url: "https://b.example/rss" },
  { show_id: "c", feed_url: "https://c.example/rss" },
];

test("a checkpointed show is not swept twice", () => {
  const progress = emptyProgress();
  progress.shows.a = { show_id: "a", status: "ok" };
  progress.shows.b = { show_id: "b", status: "error", error_code: "TIMEOUT" };
  assert.deepEqual(pendingShows(CATALOG, progress).map((s) => s.show_id), ["c"]);
});

test("--retry-failed re-queues errors but never re-fetches a success", () => {
  const progress = emptyProgress();
  progress.shows.a = { show_id: "a", status: "ok" };
  progress.shows.b = { show_id: "b", status: "error", error_code: "HTTP_503" };
  assert.deepEqual(pendingShows(CATALOG, progress, { retryFailed: true }).map((s) => s.show_id), ["b", "c"]);
});

test("shows keyed by apple_collection_id resume too", () => {
  const progress = emptyProgress();
  progress.shows["123"] = { show_id: "123", status: "ok" };
  const shows = [{ apple_collection_id: 123, feed_url: "x" }, { apple_collection_id: 456, feed_url: "y" }];
  assert.deepEqual(pendingShows(shows, progress).map((s) => s.apple_collection_id), [456]);
});

test("a checkpoint survives a round trip through disk", () => {
  const path = tmpFile("transcript-progress.json");
  assert.deepEqual(loadProgress(path).shows, {}); // absent file is a legitimate cold start
  const progress = emptyProgress();
  progress.shows.a = { show_id: "a", status: "ok", episodes_with_transcript: 7 };
  writeJsonAtomic(path, progress);
  assert.equal(existsSync(path + ".tmp"), false); // atomic write leaves no debris
  const reloaded = loadProgress(path);
  assert.equal(reloaded.shows.a.episodes_with_transcript, 7);
  assert.deepEqual(pendingShows(CATALOG, reloaded).map((s) => s.show_id), ["b", "c"]);
});

test("a corrupt checkpoint is reported, never silently discarded", () => {
  // Silently starting over would look identical to a fresh run and cost an
  // hour of re-fetching that nobody would think to look for.
  const path = tmpFile("bad-progress.json");
  writeFileSync(path, JSON.stringify({ version: 1, note: "no shows map here" }));
  assert.throws(() => loadProgress(path), (e) => e instanceof SweepError && e.code === "BAD_CHECKPOINT");
  writeFileSync(path, "{ not json");
  assert.throws(() => loadProgress(path), SyntaxError);
});

test("the committed index carries no transcript bodies", () => {
  // Structural guard on the one rule that would blow up the repo: this module
  // must have no code path that fetches a transcript_url. 8,012 transcribed
  // episodes x ~50KB is ~400MB against a 44MB data/ directory.
  const src = readFileSync(new URL("./sweep-transcripts.mjs", import.meta.url), "utf8");
  const callSites = src.match(/(?<![\w.])fetch\s*\(\s*[\w.[\]]+/g) || [];
  assert.deepEqual(callSites, ["fetch(url"]); // exactly one, and it is the feed
  assert.match(src, /await fetchFeed\(show\.feed_url/);
  const fetchLinesMentioningTranscripts = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("*") && /\bfetch\w*\(/.test(l) && /transcript/i.test(l));
  assert.deepEqual(fetchLinesMentioningTranscripts, []);
});

/* ------------------------------------------------- --max-episode-rows (#114)

   These four are the only tests in this file that exercise `sweepShow`, and
   they still touch no network: `globalThis.fetch` is replaced with a stub that
   returns a fixture, and the fixture declares no `<enclosure>`, which is what
   makes `resolveDai` return "no enclosure url in feed" without a request.

   The cap exists because the checkpoint is rewritten in full after every show,
   so its cost is the whole index, and the index is driven by episode ROWS. The
   first 20 shows of the ranked breadth tranche produced 55MB at 951 bytes per
   row; a full-catalogue run at that shape hands `JSON.stringify` a string
   longer than V8 will allocate and throws rather than slowing down. */

const manyItems = (n) =>
  Array.from(
    { length: n },
    (_, i) => `<item><title>Ep ${i}</title><guid>ep-${i}</guid>
      <podcast:transcript url="https://cdn.example/${i}.vtt" type="text/vtt"/></item>`,
  ).join("");

async function withStubbedFeed(xml, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => xml,
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/* MUTATION: apply the cap to `episodes` before `summarizeShow` instead of
   after. The counts are then computed over the truncated list, so a 2,900-
   transcript show reports 200 and every yield number in the run — the one
   number the breadth sweep exists to produce — is silently floored at the cap.
   Verified failing. */
test("--max-episode-rows caps stored rows and never the counts", async () => {
  await withStubbedFeed(feed(manyItems(500)), async () => {
    const rec = await sweepShow({ show_id: "capped", feed_url: "https://feeds.cap-test-a.example/f" }, { maxEpisodeRows: 50 });
    assert.equal(rec.status, "ok");
    assert.equal(rec.episodes_total, 500, "counts must be computed over the whole feed");
    assert.equal(rec.episodes_with_transcript, 500);
    assert.equal(rec.episodes_with_timed_transcript, 500);
    assert.equal(rec.episodes.length, 50, "only the rows are capped");
  });
});

/* MUTATION: omit `episode_rows_available`/`episode_rows_dropped`. A truncated
   show then looks identical to a show that only ever had 50 transcripts, so a
   later fetch pass cannot tell "this show has no more" from "we stopped
   recording" — a silent ceiling, which is the failure mode this pipeline's
   other files go out of their way to avoid. Verified failing. */
test("a truncated show says how much it dropped", async () => {
  await withStubbedFeed(feed(manyItems(500)), async () => {
    const rec = await sweepShow({ show_id: "counted", feed_url: "https://feeds.cap-test-b.example/f" }, { maxEpisodeRows: 50 });
    assert.equal(rec.episode_rows_available, 500);
    assert.equal(rec.episode_rows_dropped, 450);
  });
});

/* MUTATION: default `maxEpisodeRows` to some finite number rather than
   Infinity. Every existing caller — including the curated sweep that produces
   the committed `data/transcript-availability.json` — would then silently lose
   episode rows on the next run, and `transcript-coverage.mjs`'s join would
   start reporting a collapse it would attribute to the publishers.
   Verified failing. */
test("the cap is absent by default, so existing runs are unchanged", async () => {
  await withStubbedFeed(feed(manyItems(300)), async () => {
    const rec = await sweepShow({ show_id: "uncapped", feed_url: "https://feeds.cap-test-c.example/f" });
    assert.equal(rec.episodes.length, 300);
    assert.equal(rec.episode_rows_dropped, 0);
    assert.equal(rec.episode_rows_available, 300);
  });
});

/* MUTATION: `eligible.slice(-maxEpisodeRows)` instead of `slice(0, n)`. Feeds
   are newest-first, so that keeps the OLDEST episodes — the ones likeliest to
   have a transcript URL the publisher has since taken down — and quietly
   maximises the 404 rate of the fetch stage that reads these rows.
   Verified failing. */
test("the rows kept are the newest ones the feed lists first", async () => {
  await withStubbedFeed(feed(manyItems(20)), async () => {
    const rec = await sweepShow({ show_id: "order", feed_url: "https://feeds.cap-test-d.example/f" }, { maxEpisodeRows: 3 });
    assert.deepEqual(rec.episodes.map((e) => e.guid), ["ep-0", "ep-1", "ep-2"]);
  });
});
