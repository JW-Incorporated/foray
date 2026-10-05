/* PKG-12 (docs/roadmap/corpus.md): R2 show directory → foray show_id map.
   Small stub docs shaped like data/transcription-queue.json (top-level
   `shows[]`: title, feed_url, podcastindex_feed_id, apple_collection_id),
   data/catalog.json (`shows[]`: slug show_id, feed_url, apple_collection_id)
   and data/breadth-transcript-yield.json (`shows[]`: show_id ===
   String(apple_collection_id)). The suite never reads data/. Expected
   directory names are computed with fetch-transcripts.mjs's own safeKey
   (imported directly, not through config.mjs), so a local re-implementation
   in show-map.mjs could not agree with itself. No network, no credential. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeKey as farmSafeKey } from "../segments/fetch-transcripts.mjs";
import { buildShowMap, localDirFor, resolveShowDir, slugify } from "./show-map.mjs";

const queueRow = (overrides) => ({
  rank: 1,
  title: "Darkness Radio",
  feed_url: "https://audioboom.com/channels/5080242.rss",
  podcastindex_feed_id: 470582,
  apple_collection_id: 1185048025,
  ...overrides,
});
const doc = (shows) => ({ shows });

/* (a) The farm named the directory after the PodcastIndex id. The catalog
   show with the same feed URL (spelled with another scheme, case and a
   trailing slash, so the match goes through normalizeFeedUrl) owns it.
   Mutation that turns this red: in buildShowMap make the catalog branch
   `entry = { show_id: String(row.podcastindex_feed_id), via: "catalog-feed" }`
   (map to the PI id). */
test("a PI-id farm directory resolves to the catalog show with the same feed URL", () => {
  const { map } = buildShowMap({
    queue: doc([queueRow({})]),
    catalog: doc([{ show_id: "darkness-radio", feed_url: "HTTP://AudioBoom.com/channels/5080242.rss/", apple_collection_id: 1185048025 }]),
    breadth: doc([]),
  });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("470582")), { show_id: "darkness-radio", via: "catalog-feed" });
});

/* (b) Not in the catalog: the breadth convention, String(apple_collection_id).
   Mutation that turns this red: delete the
   `else if (present(row.apple_collection_id)) …` branch (falls to the title
   slug). */
test("a queue row absent from the catalog maps to String(apple_collection_id)", () => {
  const { map } = buildShowMap({ queue: doc([queueRow({})]), catalog: doc([]), breadth: doc([]) });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("470582")), { show_id: "1185048025", via: "breadth-apple" });
});

/* (c) A row without a PI id makes the farm use slugify(title); that
   directory resolves too, as does the slug directory of a row that has one.
   With neither catalog match nor apple id, the show is the title slug.
   Mutation that turns this red: delete the
   `put(safeKey(slugify(row.title)), entry);` line. */
test("a slug directory resolves too", () => {
  const { map } = buildShowMap({
    queue: doc([
      queueRow({ title: "Café Société — Épisodes", podcastindex_feed_id: null, apple_collection_id: null, feed_url: "https://x.example/cafe" }),
      queueRow({}),
    ]),
    catalog: doc([]),
    breadth: doc([]),
  });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("cafe-societe-episodes")), { show_id: "cafe-societe-episodes", via: "queue-title" });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("darkness-radio")), { show_id: "1185048025", via: "breadth-apple" });
});

/* (d) The four pinned examples from the farm's forayfmt.py.
   Mutation that turns this red: delete `.normalize("NFKD")` in slugify (the
   accents are dropped whole and the café case becomes
   "caf-soci-t-pisodes"). */
test("slugify matches the farm's four pinned examples", () => {
  assert.equal(slugify("Darkness Radio!"), "darkness-radio");
  assert.equal(slugify("Café Société — Épisodes"), "cafe-societe-episodes");
  assert.equal(slugify("  The   Odd Lots Podcast "), "the-odd-lots-podcast");
  assert.equal(slugify("日本語"), "show");
});

/* (e) A directory nobody wrote maps to null; identity entries cover the
   catalog's and breadth's own ids (raw and safeKey'd) and nothing else.
   Mutation that turns this red: make resolveShowDir return
   `map.get(r2Dir) ?? { show_id: r2Dir, via: "identity" }`. */
test("an unknown directory resolves to null", () => {
  const { map } = buildShowMap({
    queue: doc([queueRow({})]),
    catalog: doc([{ show_id: "being-an-engineer", feed_url: "https://bae.example/feed" }]),
    breadth: doc([{ show_id: "1002520452", apple_collection_id: 1002520452 }]),
  });
  assert.equal(resolveShowDir(map, "no-such-show-0123456789"), null);
  assert.equal(resolveShowDir(map, farmSafeKey("999999")), null);
  assert.deepEqual(resolveShowDir(map, "being-an-engineer"), { show_id: "being-an-engineer", via: "identity" });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("1002520452")), { show_id: "1002520452", via: "identity" });
});

/* (f) The local directory is the name transcriptPath writes, which the
   backend's transcriptArchiveLookup showDir finds by its `${showId}-` prefix.
   Mutation that turns this red: make localDirFor `return showId;` (the raw
   id). */
test("localDirFor is fetch-transcripts.mjs's safeKey of the show_id", () => {
  assert.equal(localDirFor("being-an-engineer"), farmSafeKey("being-an-engineer"));
  assert.ok(localDirFor("being-an-engineer").startsWith("being-an-engineer-"));
});

/* (g) Two queue rows whose titles slugify identically ("Darkness Radio!" and
   "darkness   radio") claim the same slug directory for different shows. The
   first mapping is kept and the second is reported once. Their PI-id
   directories differ and do not collide.
   Mutation that turns this red: in buildShowMap's put, replace the
   collision branch with `map.set(dir, entry);` (last writer wins). */
test("an identical title slug yields one collision and the first mapping is kept", () => {
  const { map, collisions } = buildShowMap({
    queue: doc([
      queueRow({ title: "Darkness Radio!", podcastindex_feed_id: 111, apple_collection_id: 1001 }),
      queueRow({ title: "darkness   radio", podcastindex_feed_id: 222, apple_collection_id: 2002, feed_url: "https://other.example/rss" }),
    ]),
    catalog: doc([]),
    breadth: doc([]),
  });
  const dir = farmSafeKey("darkness-radio");
  assert.deepEqual(resolveShowDir(map, dir), { show_id: "1001", via: "breadth-apple" });
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0], {
    dir,
    kept: { show_id: "1001", via: "breadth-apple" },
    dropped: { show_id: "2002", via: "breadth-apple" },
  });
  assert.deepEqual(resolveShowDir(map, farmSafeKey("222")), { show_id: "2002", via: "breadth-apple" });
});
