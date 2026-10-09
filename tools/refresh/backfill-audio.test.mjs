/* Tests for the one-shot audio backfill (code-health-2 CH2-36: T1-02, T1-11).
   Run: node --test tools/refresh/backfill-audio.test.mjs

   Nothing here touches the network or data/: workTargets is pure, and
   resolveAudio takes the feed (`entriesFor`) and the iTunes lookup (`lookup`)
   as arguments. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAudio, workTargets } from "./backfill-audio.mjs";
import { lookupEpisodes } from "./resolve.mjs";
import { prepareSessionPatch } from "./session-patch.mjs";

const CID = 100;
const discoverItem = (over = {}) => ({
  id: "show--old-episode",
  show: "Show",
  title: "Old Episode",
  apple_collection_id: CID,
  apple_track_id: 11,
  release_date: "2024-05-01",
  duration_min: 50,
  ...over,
});
const sessionEp = (over = {}) => ({
  show: "Show",
  title: "Flagship Episode",
  apple_collection_id: CID,
  apple_track_id: 22,
  release_date: "2023-03-01",
  duration_min: 60,
  ...over,
});
const showRow = { title: "Show", apple_collection_id: CID, feed_url: "https://feeds.example.com/show.xml" };
const feedByCollection = new Map([[CID, showRow]]);
const quiet = { pause: async () => {}, log: () => {} };

/* A world after a host migration: every episode already has audio, and the
   publisher's feed now names a new host for all of them. */
function migratedWorld() {
  const discover = { items: [discoverItem({ audio_url: "https://old.example.com/d.mp3" })] };
  const session = {
    episodes: {
      "flag-1": sessionEp({ audio_url: "https://old.example.com/s.mp3", audio_type: "audio/mpeg", audio_bytes: 1, duration_sec: 3600 }),
      "flag-2": sessionEp({ title: "Never Resolved", apple_track_id: 33 }),
    },
  };
  const entries = [
    { title: "Old Episode", date: "2024-05-01", audio_url: "https://new.example.com/d.mp3", audio_type: "audio/mpeg", audio_bytes: 9, duration_sec: 3000 },
    { title: "Flagship Episode", date: "2023-03-01", audio_url: "https://new.example.com/s.mp3", audio_type: "audio/mpeg", audio_bytes: 9, duration_sec: 3601 },
    { title: "Never Resolved", date: "2023-03-01", audio_url: "https://new.example.com/n.mp3", audio_type: "audio/mpeg", audio_bytes: 9, duration_sec: 1200 },
  ];
  return { discover, session, entries };
}

const ids = (targets) => targets.map((t) => `${t.where}:${t.ref.id}`);

/* Characterization: the default run takes whatever lacks audio_url, discover
   and session alike. MUTATION: drop `|| !t.ref.audio_url` -- the empty session
   episode (and every empty discover item) stops being a target. */
test("without --force, every item and session episode that lacks audio_url is a target, and only those", () => {
  const { discover, session } = migratedWorld();
  discover.items.push(discoverItem({ id: "show--empty" }));
  assert.deepEqual(ids(workTargets(discover, session)), ["discover:show--empty", "session:flag-2"]);
});

/* T1-02, RED before CH2-36: `--force` made every session episode a target; the
   session patch skips a block that already carries audio_url, so the verify
   step threw on the first moved URL and the run wrote nothing, discover refresh
   included. MUTATION: put the old filter back, `FORCE || !t.ref.audio_url` --
   flag-1 joins the targets and both assertions go red. */
test("--force re-resolves discover items but never a session episode that already has audio", () => {
  const { discover, session } = migratedWorld();
  assert.deepEqual(ids(workTargets(discover, session, { force: true })), ["discover:show--old-episode", "session:flag-2"]);
});

/* The failure scenario end to end, on fixtures (the card's acceptance: a
   --force run touches no filled session entry). The discover item moves to the
   new host, the empty session episode is filled, flag-1 is byte-for-byte
   untouched, and the session patch verifies instead of throwing.
   MUTATION: the old FORCE filter -- flag-1 is re-resolved to new.example.com
   and prepareSessionPatch throws `session patch mismatch on flag-1`. */
test("a --force run after a host migration patches session.json instead of aborting", async () => {
  const { discover, session, entries } = migratedWorld();
  const original = JSON.stringify(session);
  const flag1Before = { ...session.episodes["flag-1"] };
  const { stats } = await resolveAudio(workTargets(discover, session, { force: true }), {
    feedByCollection, entriesFor: async () => entries, lookup: async () => assert.fail("no leftovers, no iTunes call"), ...quiet,
  });
  assert.equal(stats.rss, 2);
  assert.equal(discover.items[0].audio_url, "https://new.example.com/d.mp3");
  assert.equal(discover.items[0].duration_min, 50);
  assert.deepEqual(session.episodes["flag-1"], flag1Before);
  assert.equal(session.episodes["flag-2"].audio_url, "https://new.example.com/n.mp3");
  const { txt } = prepareSessionPatch(original, session.episodes, { kind: "audio" });
  assert.equal(JSON.parse(txt).episodes["flag-1"].audio_url, "https://old.example.com/s.mp3");
});

/* T1-11, RED before CH2-36: backfill-audio's own lookup turned three 5xx into
   `[]`, so every leftover read "no RSS or iTunes match". It now uses
   resolve.mjs's lookupEpisodes, whose `{ ok:false }` is reported as the
   failure it is. MUTATION: restore `let eps = []` (treat `!look.ok` as an
   empty list) -- both items read "no RSS or iTunes match" and lookupFail is 0. */
test("an iTunes outage (5xx x3) is reported as a lookup failure, not as no match", async () => {
  const discover = { items: [discoverItem({ id: "a" }), discoverItem({ id: "b", title: "Other", apple_track_id: 12 })] };
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503 }; };
  const { stats, unresolved } = await resolveAudio(workTargets(discover, { episodes: {} }), {
    feedByCollection,
    entriesFor: async () => [],
    lookup: (cid) => lookupEpisodes(cid, { fetchImpl, sleep: async () => {}, limit: 200 }),
    ...quiet,
  });
  assert.equal(calls, 3, "three attempts, once for the show");
  assert.deepEqual(unresolved.map((u) => u.reason), ["iTunes lookup failed (HTTP 503)", "iTunes lookup failed (HTTP 503)"]);
  assert.equal(stats.lookupFail, 2);
  assert.equal(stats.unmatched, 0);
});

/* The same outage on a show whose feed also failed names both failures.
   MUTATION: drop `feedPart` from the lookup-failure reason -- the feed error
   disappears from UNRESOLVED. */
test("a feed error plus an iTunes outage names both", async () => {
  const discover = { items: [discoverItem()] };
  const { unresolved } = await resolveAudio(workTargets(discover, { episodes: {} }), {
    feedByCollection,
    entriesFor: async () => { throw new Error("HTTP 500"); },
    lookup: async () => ({ ok: false, error: "fetch failed" }),
    ...quiet,
  });
  assert.deepEqual(unresolved.map((u) => u.reason), ["feed error (HTTP 500) + iTunes lookup failed (fetch failed)"]);
});

/* Characterization of a lookup that answered: the trackId match is applied
   (http upgraded by normalizeAudioUrl), a missing track is "no match".
   MUTATION: treat every answer as a failure (`if (look.ok)`) -- nothing
   resolves via iTunes. */
test("an iTunes answer still rescues a leftover by trackId and a miss is still 'no RSS or iTunes match'", async () => {
  const discover = { items: [discoverItem({ id: "hit" }), discoverItem({ id: "miss", title: "Other", apple_track_id: 99 })] };
  const eps = [{ wrapperType: "podcastEpisode", trackId: 11, episodeUrl: "http://cdn.example.com/11.mp3", episodeFileExtension: "mp3", trackTimeMillis: 1_800_000 }];
  const { stats, unresolved } = await resolveAudio(workTargets(discover, { episodes: {} }), {
    feedByCollection, entriesFor: async () => [], lookup: async () => ({ ok: true, eps }), ...quiet,
  });
  assert.equal(stats.itunes, 1);
  assert.equal(discover.items[0].audio_url, "https://cdn.example.com/11.mp3");
  assert.equal(discover.items[0].audio_type, "audio/mp3");
  assert.equal(discover.items[0].duration_sec, 1800);
  assert.deepEqual(unresolved, [{ id: "miss", show: "Show", reason: "no RSS or iTunes match" }]);
});

/* One iTunes lookup in tools/refresh: the default asks resolve.mjs's
   lookupEpisodes for 200 episodes, and backfill-audio keeps no lookup, cache
   or normaliser of its own. MUTATION: default `lookup` back to limit 25 (or
   none) -- the URL assertion goes red; paste the old `itunesEpisodes` /
   `itunesCache` / `const norm` back -- the source scan names it. */
test("the default iTunes fallback is resolve.mjs's lookupEpisodes at limit=200, with no private copy", async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ results: [] }) }; };
  try {
    await resolveAudio(workTargets({ items: [discoverItem()] }, { episodes: {} }), {
      feedByCollection, entriesFor: async () => [], ...quiet,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(urls, [`https://itunes.apple.com/lookup?id=${CID}&entity=podcastEpisode&limit=200`]);

  const src = readFileSync(new URL("./backfill-audio.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\blookupEpisodes\b[^}]*\bnorm\b[^}]*\} from "\.\/resolve\.mjs";/);
  assert.doesNotMatch(src, /itunes\.apple\.com|itunesCache|const norm\s*=/);
});
