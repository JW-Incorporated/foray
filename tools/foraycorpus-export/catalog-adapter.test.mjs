/* PKG-31 (docs/roadmap/corpus.md): breadth-shaped catalogue from the corpus.
   Input rows are stubs with catalogue.mjs buildShows' row shape; the old
   breadth rows carry data/catalog-breadth.json's 20 keys with invented
   values. The suite never writes data/: the CLI test writes its inputs and
   output to a tmp dir. One test READS the committed data/catalog-breadth.json
   to pin BREADTH_KEYS to the live key order. No network, no database, no
   credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADDITIVE_KEYS, BREADTH_KEYS, catalogAdapter } from "./catalog-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_BREADTH = join(HERE, "..", "..", "data", "catalog-breadth.json");
const CLI = join(HERE, "catalog-adapter.mjs");
const HARVESTED_AT = "2026-10-05T00:00:00.000Z";

/** A buildShows row (catalogue.mjs) with invented values. */
function showRow(overrides) {
  return {
    corpus_podcast_id: "p-0001",
    podcastindex_feed_id: "9001",
    itunes_id: "111",
    title: "Synthetic corpus show",
    feed_url: "https://feeds.example.org/a/rss",
    feed_url_normalized: "feeds.example.org/a/rss",
    language: "en-us",
    explicit: false,
    image_url: "https://feeds.example.org/a/art.jpg",
    site_url: "https://example.org/a",
    categories: [{ category: "Technology", subcategory: null }],
    pi_categories: ["technology"],
    rights: { itunes_block: false, podcast_locked: false },
    crawl: { tier: 1, rank: 1, last_success_at: "2026-09-01T00:00:00.000Z", status: "ok" },
    episodes_total: 12,
    timed_transcript_episodes: 4,
    audio_episodes: 3,
    newest_published_at: "2026-09-01T00:00:00.000Z",
    foray_show_id: "111",
    ...overrides,
  };
}

/** A data/catalog-breadth.json row (all 20 keys, in the live order) with invented values. */
function oldBreadthRow(overrides) {
  return {
    apple_collection_id: 111,
    title: "Synthetic breadth show",
    feed_url: "https://feeds.example.org/a/rss",
    artwork_url: "https://breadth.example/art.jpg",
    apple_genre: "Technology",
    apple_genre_ids: ["1318", "26"],
    artist_name: "Synthetic Studios",
    episode_count: 10,
    explicit: false,
    chart_genre_id: "1318",
    chart_genre_name: "Technology",
    chart_rank: 7,
    last_charted_at: "2026-07-09T00:00:00.000Z",
    in_curated: false,
    podcastindex_id: null,
    tier: "breadth",
    region: "us",
    harvest_source: "apple-top-charts",
    harvested_at: "2026-07-09T00:00:00.000Z",
    taxonomy_node_ids: ["technology/software"],
    ...overrides,
  };
}

const breadthDoc = (shows) => ({ version: 1, built_at: "2026-07-09T00:00:00.000Z", region: "us", source: "synthetic", genre_count: 1, shows });

/* (1) Default 31 (docs/roadmap/README.md, corpus Q3; a proposed default the
   tasks proceed on, not a founder ruling): a blocked show
   and a locked show are left out and counted under skipped_rights. A row
   with no itunes_id is counted under skipped_no_apple_id, and a non-English
   one under skipped_language. A null language passes.
   Mutation that turns this red: delete the `if (row.rights?.itunes_block
   !== false || …) { … continue; }` block (both rights-flagged shows are
   emitted). */
test("blocked and locked shows are skipped and counted; no apple id and non-English are counted", () => {
  const { shows, report } = catalogAdapter(
    [
      showRow({ corpus_podcast_id: "p-1", itunes_id: "111" }),
      showRow({ corpus_podcast_id: "p-2", itunes_id: "222", rights: { itunes_block: true, podcast_locked: false } }),
      showRow({ corpus_podcast_id: "p-3", itunes_id: "333", rights: { itunes_block: false, podcast_locked: true } }),
      showRow({ corpus_podcast_id: "p-4", itunes_id: null }),
      showRow({ corpus_podcast_id: "p-5", itunes_id: "555", language: "fr" }),
      showRow({ corpus_podcast_id: "p-6", itunes_id: "666", language: null }),
    ],
    { breadthOld: breadthDoc([]), catalog: { shows: [] }, harvestedAt: HARVESTED_AT },
  );
  assert.deepEqual(
    shows.map((s) => s.apple_collection_id),
    [111, 666],
  );
  assert.equal(report.skipped_rights, 2);
  assert.equal(report.skipped_no_apple_id, 1);
  assert.equal(report.skipped_language, 1);
  assert.equal(report.rows, 2);
});

/* (2) chart_genre_id / chart_genre_name / chart_rank and taxonomy_node_ids
   come from the old breadth row with the same apple_collection_id (pg's
   string "111" joins the file's number 111). A show the old harvest never
   had gets nulls and []. The diff counts the new show, the old one the
   corpus lacks (kept, see test 7) and the changed feed URL.
   Mutation that turns this red: in catalogAdapter change
   `chart_rank: old?.chart_rank ?? null` to `chart_rank: old?.chart_rank ?? 0`
   (a show with no chart history gets rank 0, which outranks #1). */
test("chart fields and taxonomy_node_ids come from the old breadth row, else null and []", () => {
  const { shows, report } = catalogAdapter(
    [
      showRow({ corpus_podcast_id: "p-1", itunes_id: "111", feed_url: "https://moved.example/a.rss" }),
      showRow({ corpus_podcast_id: "p-2", itunes_id: "777" }),
    ],
    {
      breadthOld: breadthDoc([oldBreadthRow({ apple_collection_id: 111 }), oldBreadthRow({ apple_collection_id: 888, chart_rank: 3 })]),
      catalog: { shows: [] },
      harvestedAt: HARVESTED_AT,
    },
  );
  const [known, fresh] = shows.filter((s) => s.harvest_source === "foraycorpus");
  assert.deepEqual(
    [known.chart_genre_id, known.chart_genre_name, known.chart_rank, known.taxonomy_node_ids],
    ["1318", "Technology", 7, ["technology/software"]],
  );
  assert.deepEqual([fresh.chart_genre_id, fresh.chart_genre_name, fresh.chart_rank, fresh.taxonomy_node_ids], [null, null, null, []]);
  assert.deepEqual(
    [report.new_vs_old, report.kept_from_old, report.feed_url_changed],
    [1, 1, 1],
  );
});

/* (3) in_curated is true only when foray_show_id is a data/catalog.json
   show_id. buildShows falls back to String(itunes_id), so the numeric
   "222" row has a foray_show_id that is not a curated slug and stays false
   even though it is non-null.
   Mutation that turns this red: change in_curated to
   `row.foray_show_id != null` (the numeric fallback reads as curated). */
test("in_curated is true only for catalog show_ids, never for the numeric fallback", () => {
  const { shows } = catalogAdapter(
    [
      showRow({ corpus_podcast_id: "p-1", itunes_id: "111", foray_show_id: "lex-fridman-podcast" }),
      showRow({ corpus_podcast_id: "p-2", itunes_id: "222", foray_show_id: "222" }),
      showRow({ corpus_podcast_id: "p-3", itunes_id: "333", foray_show_id: null }),
    ],
    { breadthOld: breadthDoc([]), catalog: { shows: [{ show_id: "lex-fridman-podcast" }, { show_id: "titans-of-nuclear" }] }, harvestedAt: HARVESTED_AT },
  );
  assert.deepEqual(
    shows.map((s) => [s.apple_collection_id, s.in_curated]),
    [
      [111, true],
      [222, false],
      [333, false],
    ],
  );
});

/* (4) The row's key set is the old file's 20 keys (the plan's 17, plus
   taxonomy_node_ids, which breadthCatalog.ts reads, and artist_name /
   last_charted_at, which the harvester writes since P-03a / #1149) plus the
   two additive fields. Every value is a JSON value, so nothing vanishes on stringify. The
   expected set is written out here, not taken from BREADTH_KEYS.
   Mutation that turns this red: rename `chart_genre_name:` to
   `chart_genre:` in the emitted row. */
test("output keys are the old row's 20 keys plus timed_transcript_episodes and audio_episodes", () => {
  const old = oldBreadthRow({});
  const { shows } = catalogAdapter([showRow({})], { breadthOld: breadthDoc([old]), catalog: { shows: [] }, harvestedAt: HARVESTED_AT });
  const expected = [...Object.keys(old), "timed_transcript_episodes", "audio_episodes"].sort();
  assert.equal(Object.keys(old).length, 20);
  assert.deepEqual(Object.keys(shows[0]).sort(), expected);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(shows[0]))).sort(), expected);
  assert.deepEqual([...BREADTH_KEYS, ...ADDITIVE_KEYS].sort(), expected);
  assert.equal(shows[0].timed_transcript_episodes, 4);
  assert.equal(shows[0].audio_episodes, 3);
  assert.equal(shows[0].harvest_source, "foraycorpus");
});

/* (5) The CLI writes the envelope minified (one line + "\n", like
   data/catalog-breadth.json) and it parses back to the adapted rows. An
   --out under data/ is refused before anything is written.
   Mutation that turns this red: in writeMinified write
   `JSON.stringify(value, null, 2)` (indented output). */
test("CLI output is minified, parses, and an --out under data/ is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-adapter-"));
  try {
    const showsPath = join(dir, "shows.jsonl");
    const breadthPath = join(dir, "breadth.json");
    const catalogPath = join(dir, "catalog.json");
    const outPath = join(dir, "out", "catalog-breadth-corpus.json");
    writeFileSync(showsPath, [showRow({}), showRow({ corpus_podcast_id: "p-2", itunes_id: "222" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(breadthPath, JSON.stringify(breadthDoc([oldBreadthRow({})])));
    writeFileSync(catalogPath, JSON.stringify({ shows: [] }));
    const args = [CLI, "--shows", showsPath, "--breadth", breadthPath, "--catalog", catalogPath, "--harvested-at", HARVESTED_AT];

    const printed = JSON.parse(execFileSync(process.execPath, [...args, "--out", outPath], { encoding: "utf8" }));
    assert.equal(printed.rows, 2);
    const text = readFileSync(outPath, "utf8");
    assert.ok(text.endsWith("}\n"), "one trailing newline");
    assert.equal(text.indexOf("\n"), text.length - 1, "a single line");
    const doc = JSON.parse(text);
    assert.equal(text, JSON.stringify(doc) + "\n");
    assert.deepEqual(Object.keys(doc), ["version", "built_at", "region", "source", "genre_count", "shows"]);
    assert.deepEqual(
      doc.shows.map((s) => s.apple_collection_id),
      [111, 222],
    );

    const refused = join(HERE, "..", "..", "data", "catalog-breadth-corpus-should-not-exist.json");
    assert.throws(() => execFileSync(process.execPath, [...args, "--out", refused], { encoding: "utf8", stdio: "pipe" }), /REFUSE_DATA/);
    assert.equal(existsSync(refused), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* (6) BREADTH_KEYS is pinned to the LIVE file, not to the plan: it
   deep-equals the key order of the committed data/catalog-breadth.json's
   first row, so the next field the harvester adds turns this red here
   instead of silently vanishing from a corpus catalogue (#1148 class).
   BREADTH_KEYS is derived from tools/harvest-merge.mjs's ROW_KEYS (CH2-15),
   so this also guards ROW_KEYS against the committed file: a key added to
   the harvester is one edit, and this goes red until the file carries it.
   Mutation that turns this red: add a key to ROW_KEYS in harvest-merge.mjs
   (or delete "artist_name" from it). */
test("BREADTH_KEYS is the key order of the committed data/catalog-breadth.json's first row", () => {
  const live = JSON.parse(readFileSync(LIVE_BREADTH, "utf8"));
  assert.ok(Array.isArray(live.shows) && live.shows.length > 0, "the committed breadth file has rows");
  assert.deepEqual([...BREADTH_KEYS], Object.keys(live.shows[0]));
  const { shows } = catalogAdapter([showRow({})], { breadthOld: breadthDoc([oldBreadthRow({})]), catalog: { shows: [] }, harvestedAt: HARVESTED_AT });
  assert.deepEqual(Object.keys(shows[0]), [...Object.keys(live.shows[0]), ...ADDITIVE_KEYS], "emitted in the live order");
});

/* (7) UNION (PR #1149 semantics, docs/CATALOG-PIPELINE.md "Re-harvests keep
   shows that left the charts"): after the corpus rows, every old row whose
   apple id was not emitted is appended unchanged, so a corpus catalogue is a
   superset of the committed file and no search result, show page or shared
   #/show/<id> link is lost. The one exception is a show the corpus itself
   flags (default 31): its old row is withheld and counted, not re-added.
   Mutation that turns this red: delete the loop that appends the old rows
   (888 and 999 vanish, kept_from_old stays 0). Also red: drop the
   rightsFlagged check (222 comes back), or push `old` itself instead of a
   structuredClone (the caller's object is aliased). */
test("old rows the corpus did not emit are appended unchanged; a rights-flagged show is withheld", () => {
  const old888 = oldBreadthRow({ apple_collection_id: 888, title: "Left the corpus", chart_rank: 3 });
  const old999 = oldBreadthRow({ apple_collection_id: 999, title: "Non-English in the corpus", taxonomy_node_ids: [] });
  const old222 = oldBreadthRow({ apple_collection_id: 222, title: "Blocked in the corpus" });
  const { shows, report } = catalogAdapter(
    [
      showRow({ corpus_podcast_id: "p-1", itunes_id: "111" }),
      showRow({ corpus_podcast_id: "p-2", itunes_id: "222", rights: { itunes_block: true, podcast_locked: false } }),
      showRow({ corpus_podcast_id: "p-9", itunes_id: "999", language: "de" }),
    ],
    { breadthOld: breadthDoc([oldBreadthRow({ apple_collection_id: 111 }), old888, old222, old999]), catalog: { shows: [] }, harvestedAt: HARVESTED_AT },
  );
  assert.deepEqual(
    shows.map((s) => s.apple_collection_id),
    [111, 888, 999],
  );
  assert.deepEqual(shows[1], old888, "kept unchanged");
  assert.deepEqual(shows[2], old999, "kept unchanged");
  assert.notEqual(shows[1], old888, "a copy, not the caller's object");
  assert.deepEqual([report.rows, report.kept_from_old, report.withheld_from_old], [3, 2, 1]);
});

/* (8) artist_name, last_charted_at and apple_genre_ids come from the old row
   with the same apple_collection_id (never from the corpus `author`, which
   PKG-03 scrubs and which is not Apple's artistName); a show the old file
   never had gets null / null / [].
   Mutation that turns this red: emit `apple_genre_ids: []` unconditionally
   (the old row's ["1318", "26"] is lost). */
test("artist_name, last_charted_at and apple_genre_ids are copied from the old row, else null, null, []", () => {
  const { shows } = catalogAdapter(
    [showRow({ corpus_podcast_id: "p-1", itunes_id: "111", author: "Scrubbed corpus author" }), showRow({ corpus_podcast_id: "p-2", itunes_id: "777" })],
    { breadthOld: breadthDoc([oldBreadthRow({ apple_collection_id: 111 })]), catalog: { shows: [] }, harvestedAt: HARVESTED_AT },
  );
  const [known, fresh] = shows;
  assert.deepEqual(
    [known.artist_name, known.last_charted_at, known.apple_genre_ids],
    ["Synthetic Studios", "2026-07-09T00:00:00.000Z", ["1318", "26"]],
  );
  assert.deepEqual([fresh.artist_name, fresh.last_charted_at, fresh.apple_genre_ids], [null, null, []]);
});
