/* RV-04 (docs/roadmap/recommender-v1.md): RSS metadata enrichment.
   Run: node --test tools/recommender/enrich-rss.test.mjs

   OFFLINE. Every fetch here is a fake that returns `fixtures/feed.xml` or a
   status; no test touches a network host. The clock and the sleep are
   injected into politeness.mjs's gate (as politeness.test.mjs does), so a
   1,200 ms host interval is asserted in microseconds.

   PARSER NOTE, said plainly: the two tests that parse the fixture feed use
   parseFeed, which needs backend/'s fast-xml-parser. CI's data-and-site job
   never installs backend/node_modules, so those two SKIP there (the
   tools/refresh/scan.test.mjs precedent) and run wherever `npm ci` has been
   run in backend/. Every other test injects a parse fake and runs everywhere.

   Each test names the one-line mutation that turns it red; each was run
   (CLAUDE.md "A green test is not evidence until you have broken it"). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_HOST_INTERVAL_MS, resetHostGates } from "../segments/politeness.mjs";
import {
  EPISODES_KEPT,
  MAX_CHANNEL_DESCRIPTION_CHARS,
  cachePath,
  channelDescription,
  enrichAll,
  resolveFeeds,
  keyEntries,
} from "./enrich-rss.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FEED_XML = readFileSync(join(HERE, "fixtures", "feed.xml"), "utf8");

let HAS_PARSER = true;
try { createRequire(join(ROOT, "backend", "package.json")).resolve("fast-xml-parser"); } catch { HAS_PARSER = false; }
const needParser = { skip: HAS_PARSER ? false : "backend/node_modules not installed (CI data-and-site); run `npm ci` in backend/ to run it" };

/** A clock we control and a sleep that advances it instead of sleeping. */
function harness(start = Date.parse("2026-10-14T12:00:00Z")) {
  const state = { t: start, slept: [] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms) => { state.slept.push(ms); state.t += ms; },
    random: () => 0,
  };
}

/** For CONCURRENT workers a sleep that advances the clock at once would let one
    worker's wait move every other worker's clock too. This one parks each sleep
    as a timer and a driver releases them in time order, moving the clock to
    each timer's due time: a tiny discrete-event clock. */
function virtualClock(start = Date.parse("2026-10-14T12:00:00Z")) {
  const state = { t: start, timers: [] };
  const now = () => state.t;
  const sleep = (ms) => new Promise((r) => state.timers.push({ at: state.t + ms, r }));
  const run = async (promise) => {
    let done = false;
    promise.finally(() => { done = true; }).catch(() => {});
    while (!done) {
      await new Promise((r) => setImmediate(r));
      if (!state.timers.length) continue;
      state.timers.sort((a, b) => a.at - b.at);
      const next = state.timers.shift();
      state.t = Math.max(state.t, next.at);
      next.r();
    }
    return promise;
  };
  return { state, now, sleep, run, random: () => 0 };
}

/** A fetch fake: records every call (url, clock time) and answers from `reply`. */
function fakeFetch(h, reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, at: h.now(), init });
    return reply(url, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const xmlRes = (body) => new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });

/** parseFeed's output shape without the parser: what episodeOf returns. */
const fakeParse = () => Array.from({ length: 6 }, (_, i) => ({
  guid: `g${i}`,
  title: `Ep ${i}`,
  published_at: `2026-09-0${i + 1}`,
  duration_min: 30,
  enclosure_url: `https://media.fixture.test/ep-${i}.mp3`,
  link: `https://fixture.test/ep-${i}`,
  episode: null,
  season: null,
  description: `About episode ${i}.`,
}));

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "enrich-rss-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const SHOW = { show_key: "fixture-roads", feed_url: "https://feeds.fixture.test/roads.xml" };

/* MUTATION, run: in episodesForCache, `.slice(0, EPISODES_KEPT)` ->
   `.slice(0, 5)` -> red (5 episodes, not 10). Also run: the comparator's
   `return da < db ? 1 : -1;` -> `return 0;` (feed order kept) -> red: the feed
   lists episode 3 first, not 12. */
test("writes description and the 10 newest episodes from the fixture feed", needParser, () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const fetchImpl = fakeFetch(h, () => xmlRes(FEED_XML));
  const counts = await enrichAll([SHOW], { dir, fetchImpl, now: h.now, sleep: h.sleep, random: h.random });
  assert.deepEqual(counts, { fetched: 1, cached: 0, failed: 0, skipped: 0 });

  const doc = JSON.parse(readFileSync(cachePath(dir, SHOW.show_key), "utf8"));
  assert.equal(doc.status, "ok");
  assert.equal(doc.fetched_at, "2026-10-14T12:00:00.000Z");
  assert.equal(doc.description, "A slow-travel show: two hosts & one long road, every week.", "the channel's own description, CDATA/HTML/entities undone");
  assert.equal(EPISODES_KEPT, 10);
  assert.equal(doc.episodes.length, 10, "the feed has 12 items; the 10 newest are kept");
  assert.deepEqual(
    doc.episodes.map((e) => e.published_at),
    ["2026-09-12", "2026-09-11", "2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07", "2026-09-06", "2026-09-05", "2026-09-04", "2026-09-03"],
    "newest first by pubDate, not feed order",
  );
  assert.deepEqual(doc.episodes[1], {
    title: "Episode 11: Notes from the road",
    description: "Episode 11 & friends talk slow travel .",
    duration_min: 41,
    published_at: "2026-09-11",
  });
  for (const e of doc.episodes) assert.deepEqual(Object.keys(e), ["title", "description", "duration_min", "published_at"], "no enclosure, guid or link in the cache");
  assert.ok(!JSON.stringify(doc).includes("Do Not Show This Network"), "the itunes:author network name never reaches the cache (D7)");
  assert.deepEqual(readdirSync(dir), ["fixture-roads.json"], "written atomically: no temp file left behind");
}));

/* MUTATION, run: drop episodeOf's cap (in tools/harvest-episodes.mjs, delete
   `.slice(0, 280)` from episodeOf's description) -> red: the cache would carry
   the full 431-char description. The cap is inherited from episodeOf, not
   restated, so removing it there is the mutation that matters. */
test("caps an episode description at 280 chars", needParser, () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const raw = FEED_XML.match(/This episode runs long[^<]*/)[0];
  assert.ok(raw.length > 280, "the fixture's long description really is over the cap");
  await enrichAll([SHOW], { dir, fetchImpl: fakeFetch(h, () => xmlRes(FEED_XML)), now: h.now, sleep: h.sleep, random: h.random });
  const doc = JSON.parse(readFileSync(cachePath(dir, SHOW.show_key), "utf8"));
  const long = doc.episodes.find((e) => e.published_at === "2026-09-12");
  assert.ok(long.description.startsWith("This episode runs long on purpose."));
  assert.ok(long.description.length <= 280, `capped, got ${long.description.length}`);
  assert.ok(doc.episodes.every((e) => e.description.length <= 280));
}));

/* MUTATION, run: in isFresh, `return nowMs - at < maxAgeDays * DAY_MS;` ->
   `return false;` (fetched_at ignored, everything refetched) -> red on the
   fresh file. And `return true;` -> red on the stale one. */
test("a fresh cache file is not refetched", () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const day = 86_400_000;
  const fresh = { show_key: "fresh-show", feed_url: "https://a.fixture.test/f.xml" };
  const stale = { show_key: "stale-show", feed_url: "https://b.fixture.test/s.xml" };
  writeFileSync(cachePath(dir, fresh.show_key), JSON.stringify({ fetched_at: new Date(h.now() - 29 * day).toISOString(), status: "ok", description: "kept", episodes: [] }));
  writeFileSync(cachePath(dir, stale.show_key), JSON.stringify({ fetched_at: new Date(h.now() - 31 * day).toISOString(), status: "ok", description: "old", episodes: [] }));
  const fetchImpl = fakeFetch(h, () => xmlRes("<rss/>"));
  const counts = await enrichAll([fresh, stale], { dir, fetchImpl, parse: fakeParse, maxAgeDays: 30, now: h.now, sleep: h.sleep, random: h.random });
  assert.deepEqual(counts, { fetched: 1, cached: 1, failed: 0, skipped: 0 });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [stale.feed_url], "only the stale show was fetched");
  assert.equal(JSON.parse(readFileSync(cachePath(dir, fresh.show_key), "utf8")).description, "kept", "the fresh file is untouched");
  assert.equal(JSON.parse(readFileSync(cachePath(dir, stale.show_key), "utf8")).episodes.length, 6, "the stale file was rewritten");
}));

/* MUTATION, run: in enrichShow's catch, delete the
   `writeCache(file, { ... status: "failed", error })` line -> red: no file,
   and the second run fetches again. */
test("a failed fetch is recorded and not retried before max-age", () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const fetchImpl = fakeFetch(h, () => new Response("gone", { status: 404 }));
  const opts = { dir, fetchImpl, parse: fakeParse, now: h.now, sleep: h.sleep, random: h.random };
  assert.deepEqual(await enrichAll([SHOW], opts), { fetched: 0, cached: 0, failed: 1, skipped: 0 });
  assert.equal(fetchImpl.calls.length, 1, "a 404 is permanent: one attempt, no retry");
  const doc = JSON.parse(readFileSync(cachePath(dir, SHOW.show_key), "utf8"));
  assert.deepEqual(doc, { fetched_at: "2026-10-14T12:00:00.000Z", status: "failed", error: "HTTP_404: HTTP 404" });

  h.state.t += 10 * 86_400_000; // ten days later, inside the 30-day window
  assert.deepEqual(await enrichAll([SHOW], opts), { fetched: 0, cached: 1, failed: 0, skipped: 0 });
  assert.equal(fetchImpl.calls.length, 1, "not asked again before --max-age-days");
}));

/* MUTATION, run: in fetchFeedPolitely, delete `await awaitHostSlot(url, { sleep, now });`
   -> red: both same-host fetches land at the same instant. */
test("same-host requests honour MIN_HOST_INTERVAL_MS", () => withDir(async (dir) => {
  resetHostGates();
  const h = virtualClock();
  const shows = [
    { show_key: "one", feed_url: "https://feeds.shared.test/one.xml" },
    { show_key: "two", feed_url: "https://feeds.shared.test/two.xml" },
    { show_key: "elsewhere", feed_url: "https://other.test/three.xml" },
  ];
  const fetchImpl = fakeFetch(h, () => xmlRes("<rss/>"));
  await h.run(enrichAll(shows, { dir, fetchImpl, parse: fakeParse, concurrency: 3, now: h.now, sleep: h.sleep, random: h.random }));
  const at = Object.fromEntries(fetchImpl.calls.map((c) => [c.url, c.at]));
  assert.equal(MIN_HOST_INTERVAL_MS, 1200);
  assert.ok(at[shows[1].feed_url] - at[shows[0].feed_url] >= MIN_HOST_INTERVAL_MS,
    `same host ${at[shows[1].feed_url] - at[shows[0].feed_url]}ms apart`);
  assert.equal(at[shows[2].feed_url], at[shows[0].feed_url], "a different host is not held back by the first");
  const init = fetchImpl.calls[0].init;
  assert.match(init.headers["User-Agent"], /^Foray\/0\.1 \(personal podcast client; contact /, "politeness.mjs's UA");
  assert.equal(init.headers["Accept-Language"], "en", "politeness.mjs's ACCEPT_LANGUAGE");
}));

/* MUTATION, run: in enrichShow after `const episodes = ...`, add
   `for (const e of parse(xml)) await fetchImpl(e.enclosure_url);` (with
   fetchImpl taken from opts) -> red: enclosure URLs appear in the call log. */
test("only the feed URL is fetched", () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const fetchImpl = fakeFetch(h, () => xmlRes("<rss/>"));
  const shows = [SHOW, { show_key: "123456", feed_url: "https://feeds.fixture.test/b.xml" }];
  await enrichAll(shows, { dir, fetchImpl, parse: fakeParse, now: h.now, sleep: h.sleep, random: h.random });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url).sort(), shows.map((s) => s.feed_url).sort());
  const cached = readFileSync(cachePath(dir, SHOW.show_key), "utf8");
  assert.ok(!cached.includes("media.fixture.test"), "no enclosure URL is cached either");
}));

/* MUTATION, run: in fetchFeedPolitely, `if (res.status !== 429 && res.status < 500) throw err;`
   -> `throw err;` (every non-ok final) -> red: one attempt, no hold. Also run:
   delete the `waitBeforeRetry(url, res, attempt, ...)` line -> red: the retries
   fire with no Retry-After wait. */
test("a 429 is retried at most three times, each after the host's Retry-After", () => withDir(async (dir) => {
  resetHostGates();
  const h = harness();
  const fetchImpl = fakeFetch(h, () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }));
  const counts = await enrichAll([SHOW], { dir, fetchImpl, parse: fakeParse, now: h.now, sleep: h.sleep, random: h.random });
  assert.deepEqual(counts, { fetched: 0, cached: 0, failed: 1, skipped: 0 });
  assert.equal(fetchImpl.calls.length, 3, "three attempts, then recorded as failed");
  const gaps = fetchImpl.calls.slice(1).map((c, i) => c.at - fetchImpl.calls[i].at);
  assert.ok(gaps.every((g) => g >= 7000), `each retry waits out Retry-After: ${gaps}`);
  assert.match(JSON.parse(readFileSync(cachePath(dir, SHOW.show_key), "utf8")).error, /^HTTP_429/);
}));

/* MUTATION, run: in channelDescription, read from the whole document instead
   of `preamble` (`head.slice(channelAt)` for both) on a channel with only an
   itunes:summary -> red: an item's description stands in for the show's.
   Also run: drop `.slice(0, MAX_CHANNEL_DESCRIPTION_CHARS)` -> red. */
test("channelDescription reads the channel, not an item, strips HTML and caps at 600", () => {
  const onlySummary = `<rss><channel><title>T</title><itunes:summary>Show &amp; tell, &lt;b&gt;weekly&lt;/b&gt;.</itunes:summary>
    <item><title>E</title><description>An item's text</description></item></channel></rss>`;
  assert.equal(channelDescription(onlySummary), "Show & tell, weekly .");
  const none = `<rss><channel><title>T</title><item><description>An item's text</description></item></channel></rss>`;
  assert.equal(channelDescription(none), null, "no channel description: null, never the item's");
  const long = `<rss><channel><description>${"word ".repeat(400)}</description></channel></rss>`;
  assert.equal(channelDescription(long).length, MAX_CHANNEL_DESCRIPTION_CHARS);
  assert.equal(channelDescription("not xml at all"), null);
});

/* MUTATION, run: in resolveFeeds, `want.get(String(row.apple_collection_id))`
   -> `want.get(row.apple_collection_id)` -> red: the breadth key stays
   unresolved (a number never equals the string key). */
test("keys resolve curated by show_id and breadth by apple_collection_id; unknown keys are skipped", () => withDir(async (dir) => {
  const catalogPath = join(dir, "catalog.json");
  const breadthPath = join(dir, "catalog-breadth.json");
  writeFileSync(catalogPath, JSON.stringify({ shows: [
    { show_id: "curated-a", apple_collection_id: 111, feed_url: "https://c.test/a.xml" },
    { show_id: "curated-nofeed", apple_collection_id: 112, feed_url: null },
  ] }));
  writeFileSync(breadthPath, JSON.stringify({ version: 1, shows: [
    { apple_collection_id: 222, title: "B", feed_url: "https://b.test/b.xml", chart_rank: 3, artist_name: "Net" },
  ] }));
  const entries = keyEntries({ shows: [{ show_key: "curated-a" }, { show_key: "222" }, { show_key: "999" }, { show_key: "222" }] });
  const shows = resolveFeeds(entries, { catalogPath, breadthPath });
  assert.deepEqual(shows, [
    { show_key: "curated-a", feed_url: "https://c.test/a.xml" },
    { show_key: "222", feed_url: "https://b.test/b.xml" },
    { show_key: "999", feed_url: null },
  ], "resolved, deduplicated, and nothing but key and feed_url carried");
  assert.deepEqual(keyEntries(["x", 5]), [{ show_key: "x", feed_url: null }, { show_key: "5", feed_url: null }]);

  resetHostGates();
  const h = harness();
  const rss = join(dir, "rss");
  const fetchImpl = fakeFetch(h, () => xmlRes("<rss/>"));
  const bad = { show_key: "../escape", feed_url: "https://c.test/x.xml" };
  const notHttp = { show_key: "file-url", feed_url: "file:///etc/passwd" };
  const counts = await enrichAll([...shows, bad, notHttp], { dir: rss, fetchImpl, parse: fakeParse, now: h.now, sleep: h.sleep, random: h.random });
  assert.deepEqual(counts, { fetched: 2, cached: 0, failed: 0, skipped: 3 });
  assert.ok(!existsSync(join(dir, "escape.json")), "a key is never a path");
}));
