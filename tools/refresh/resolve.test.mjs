/* Tests for the nightly resolve pass (audit round 3, data-tools-2 and -15).
   Run: node --test tools/refresh/

   Nothing here touches the network: resolveEpisodes takes a `lookup`, and
   lookupEpisodes takes a `fetchImpl`. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RETRY_NIGHTS, lookupEpisodes, matchKey, matchTrack, resolveEpisodes, retryItems, urlKey, writeRetryState,
} from "./resolve.mjs";

const track = (over = {}) => ({
  wrapperType: "podcastEpisode",
  trackId: 1,
  trackName: "Some Episode",
  releaseDate: "2026-09-01T10:00:00Z",
  episodeGuid: "guid-1",
  episodeUrl: "https://cdn.example.com/1.mp3",
  trackViewUrl: "https://podcasts.apple.com/x?i=1",
  ...over,
});
const ep = (over = {}) => ({
  show: "Show",
  show_id: "show",
  apple_collection_id: 100,
  topics: ["science"],
  guid: "g-new",
  title: "Some Episode",
  release_date: "2026-09-10",
  audio_url: "https://cdn.example.com/new.mp3",
  ...over,
});

/* -------------------------------------------------------------- matching */

/* The finding's two examples. MUTATION: drop the release-date filter on the
   fuzzy fallbacks (`const dated = eps`) -- Part 3 matches Part 2 by word
   overlap and Episode 12 matches Episode 120 by substring. */
test("a new episode never fuzzy-matches an OLDER track: Part 3 is not Part 2, Episode 12 is not Episode 120", () => {
  const part2 = track({ trackId: 2, trackName: "How to Build a Startup, Part 2", releaseDate: "2026-09-03T00:00:00Z", episodeGuid: "g2", episodeUrl: "https://cdn.example.com/p2.mp3" });
  assert.equal(matchTrack([part2], ep({ title: "How to Build a Startup, Part 3", release_date: "2026-09-10" })), null);
  const ep120 = track({ trackId: 120, trackName: "Episode 120", releaseDate: "2026-05-01T00:00:00Z", episodeGuid: "g120", episodeUrl: "https://cdn.example.com/120.mp3" });
  assert.equal(matchTrack([ep120], ep({ title: "Episode 12", release_date: "2026-09-10" })), null);
});

test("the fuzzy fallback still works on the same release date", () => {
  const t = track({ trackId: 9, trackName: "Startup Stories: Building the Company (Part 3)", releaseDate: "2026-09-10T05:00:00Z", episodeGuid: "other", episodeUrl: "https://other.example.com/x.mp3" });
  const m = matchTrack([t], ep({ title: "Building the Company, Part 3", release_date: "2026-09-10" }));
  assert.equal(m?.track.trackId, 9);
  assert.match(m.by, /\+date$/);
});

/* MUTATION: skip the guid/url steps -- the title step then picks the first
   same-titled track (a re-run with a different Apple id). */
test("guid, then enclosure URL, are matched before any title", () => {
  const rerun = track({ trackId: 5, trackName: "Best Of", episodeGuid: "g-old", episodeUrl: "https://cdn.example.com/old.mp3" });
  const real = track({ trackId: 6, trackName: "Best Of", episodeGuid: "g-new", episodeUrl: "https://cdn.example.com/other.mp3" });
  assert.deepEqual(matchTrack([rerun, real], ep({ title: "Best Of" })), { track: real, by: "guid" });
  const byUrl = track({ trackId: 7, trackName: "Different Title", episodeGuid: "zzz", episodeUrl: "http://CDN.example.com/new.mp3?utm=itunes" });
  assert.deepEqual(matchTrack([rerun, byUrl], ep({ title: "Best Of", guid: "nope" })), { track: byUrl, by: "url" });
  assert.equal(urlKey("https://cdn.example.com/a.mp3?x=1#t"), "cdn.example.com/a.mp3");
});

test("an exact title match does not need a date; an empty or non-Latin title only matches itself", () => {
  assert.equal(matchTrack([track({ trackName: "Some Episode!", episodeGuid: "x", episodeUrl: null })], ep({ guid: "y", audio_url: null }))?.by, "title");
  assert.equal(matchKey("Radio: Свобода"), "radio свобода");
  const jp = track({ trackId: 3, trackName: "東京の話", episodeGuid: "x", episodeUrl: null });
  assert.equal(matchTrack([jp], ep({ title: "大阪の話", guid: "y", audio_url: null })), null, "two different CJK titles do not both normalise to ''");
  assert.equal(matchTrack([track({ trackName: "!!!" })], ep({ title: "???", guid: "y", audio_url: null })), null);
});

/* ------------------------------------------------------- the resolve pass */

const pool = () => ({
  discover: { items: [{ id: "show--old-one", show: "Show", apple_track_id: 999 }] },
  session: { episodes: {} },
  taxonomy: { nodes: [{ id: "science" }] },
});

/* MUTATION: treat a failed lookup as an empty list (the old `data = { results: [] }`)
   -- the episode is dropped as "no trackId match" and nothing is carried. */
test("a failed iTunes lookup is reported per show and carried, never dropped as 'no match'", async () => {
  const out = await resolveEpisodes({
    ...pool(),
    pending: { episodes: [ep(), ep({ guid: "g-2", title: "Another" })] },
    lookup: async () => ({ ok: false, error: "HTTP 503" }),
  });
  assert.equal(out.resolved.length, 0);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.retry.length, 2);
  assert.deepEqual(out.lookupFailures, [{ show: "Show", apple_collection_id: 100, error: "HTTP 503" }], "one line per show, not per episode");
});

test("an episode iTunes has not indexed yet is carried, then dropped after MAX_RETRY_NIGHTS", async () => {
  const lookup = async () => ({ ok: true, eps: [track({ trackId: 50, trackName: "Something Else", releaseDate: "2026-08-01T00:00:00Z" })] });
  const first = await resolveEpisodes({ ...pool(), pending: { episodes: [ep()] }, lookup });
  assert.equal(first.retry.length, 1);
  assert.equal(first.retry[0].attempts, 1);
  assert.equal(first.retry[0].item.guid, "g-new");
  assert.equal(first.dropped.length, 0);

  const last = await resolveEpisodes({ ...pool(), pending: { episodes: [ep({ _retry_attempts: MAX_RETRY_NIGHTS - 1 })] }, lookup });
  assert.equal(last.retry.length, 0);
  assert.equal(last.dropped.length, 1);
  assert.match(last.dropped[0].reason, /no trackId match; gave up after 3 night/);
});

test("lookupEpisodes returns ok:false after three failures instead of an empty list", async () => {
  let calls = 0;
  const r = await lookupEpisodes(100, { fetchImpl: async () => { calls++; return { ok: false, status: 503 }; }, sleep: async () => {} });
  assert.deepEqual(r, { ok: false, error: "HTTP 503" });
  assert.equal(calls, 3);
  const ok = await lookupEpisodes(100, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ wrapperType: "track" }, track()] }) }),
    sleep: async () => {},
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.eps.length, 1);
});

/* data-tools-15. The id dedup works through existingIds alone; the dead
   `seenTrackThisRun.has(id)` clause (numeric trackIds vs a string slug) is gone.
   MUTATION: drop `existingIds.add(id)` -- two same-slug episodes both publish. */
test("two episodes with the same slug in one run publish once; the dead trackId-set clause is gone", async () => {
  const lookup = async () => ({ ok: true, eps: [
    track({ trackId: 11, episodeGuid: "a", trackName: "Weekly News Roundup" }),
    track({ trackId: 12, episodeGuid: "b", trackName: "Weekly News Roundup" }),
  ] });
  const out = await resolveEpisodes({
    ...pool(),
    pending: { episodes: [ep({ guid: "a", title: "Weekly News Roundup" }), ep({ guid: "b", title: "Weekly News Roundup" })] },
    lookup,
  });
  assert.equal(out.resolved.length, 1);
  assert.match(out.dropped[0].reason, /^dup id show--weekly-news-roundup$/);
  const src = readFileSync(new URL("./resolve.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /seenTrackThisRun\.has\(id\)/);
});

/* ------------------------------------------------- the carry, end to end */

/* MUTATION: have scan.mjs start `pending` empty instead of from retryItems --
   the source check fails; drop writeRetryState's replace -- the round trip
   keeps a resolved episode on the list. */
test("retries round-trip through the scan state and are re-emitted by scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-retry-"));
  const statePath = join(dir, "refresh-state.json");
  writeFileSync(statePath, JSON.stringify({ seen: { 100: ["g-new"] }, retry: { stale: { attempts: 1, item: ep({ guid: "stale" }) } } }));
  writeRetryState(statePath, [{ guid: "g-new", attempts: 1, reason: "no trackId match", item: ep() }]);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(Object.keys(state.retry), ["g-new"], "the list is replaced, not appended to");
  assert.deepEqual(state.seen, { 100: ["g-new"] }, "seen is untouched");

  const again = retryItems(state, new Set());
  assert.equal(again.length, 1);
  assert.equal(again[0]._retry_attempts, 1);
  assert.equal(again[0].guid, "g-new");
  assert.deepEqual(retryItems(state, new Set(["Show::Some Episode"])), [], "one that reached the pool is not re-emitted");

  const scan = readFileSync(new URL("./scan.mjs", import.meta.url), "utf8");
  assert.match(scan, /const pending = retryItems\(state, knownTitles\);/);
  assert.match(scan, /state_path: resolvePath\(STATE_PATH\)/);
});
