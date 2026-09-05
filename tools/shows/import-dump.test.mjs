/* End-to-end pipeline test against a small in-memory fixture `podcasts`
   table (node:sqlite) — covers: full D1+D13+shard-build run, id-map
   fail-closed behaviour, shard size ceiling enforcement, and the
   determinism acceptance criterion (two runs over the same fixture
   produce byte-identical output artifacts). No network, no real dump. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DUMP_COLUMNS } from "./config.mjs";
import { runPipeline, writeBuildOutput } from "./import-dump.mjs";

const NOW = Date.parse("2026-09-05T00:00:00Z");
const monthsAgo = (n) => Math.floor((NOW - n * (365.25 / 12) * 24 * 60 * 60 * 1000) / 1000);

function buildFixtureDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE podcasts (
    id INTEGER PRIMARY KEY, url TEXT, podcastGuid TEXT, itunesId INTEGER,
    title TEXT, itunesAuthor TEXT, itunesOwnerName TEXT, description TEXT,
    imageUrl TEXT, language TEXT, dead INTEGER, episodeCount INTEGER,
    lastUpdate INTEGER, newestItemPubdate INTEGER, oldestItemPubdate INTEGER,
    popularityScore INTEGER, explicit INTEGER, host TEXT,
    category1 TEXT, category2 TEXT, category3 TEXT, category4 TEXT, category5 TEXT,
    category6 TEXT, category7 TEXT, category8 TEXT, category9 TEXT, category10 TEXT
  )`);
  const cols = DUMP_COLUMNS;
  const stmt = db.prepare(`INSERT INTO podcasts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
  }
  return db;
}

const fixtureRow = (over = {}) => ({
  id: 1, url: "https://feeds.example.com/show1", podcastGuid: null, itunesId: null,
  title: "Show One", itunesAuthor: "Author One", itunesOwnerName: null,
  description: "", imageUrl: null, language: "en", dead: 0, episodeCount: 10,
  lastUpdate: monthsAgo(1), newestItemPubdate: monthsAgo(1), oldestItemPubdate: monthsAgo(30),
  popularityScore: 10, explicit: 0, host: "example.com",
  ...over,
});

test("runPipeline: full run over a small fixture — filter, dedupe, id-map all agree", () => {
  const rows = [
    fixtureRow({ id: 1, title: "Show One", itunesAuthor: "Author One", popularityScore: 100 }),
    /* A DISTINCT url, deliberately. This row exists to prove `dead` is filtered
       before dedupe sees it — but `fixtureRow`'s default url is show1's, which
       is also the curated entry's feed_url, so on the default it was ALSO a
       curated row. Once curated rows became exempt from D1 (identity.mjs's
       `curatedKeys`) this fixture asserted two contradictory things at once and
       the exemption, correctly, rescued it. The dead-row intent is kept here;
       the exemption gets its own test below rather than riding on an accident. */
    fixtureRow({ id: 2, url: "https://feeds.example.com/dead-show", title: "Dead Show", dead: 1, popularityScore: 5 }),
    fixtureRow({ id: 3, url: "https://feeds.example.com/show1", title: "Show One Dup", podcastGuid: null, itunesId: 555, popularityScore: 50 }), // same feed url as show 1's curated entry but different dump row -- distinct group by title
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" }];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.equal(result.totalRows, 3);
    assert.equal(result.d1Counts.dead, 1);
    assert.equal(result.canonical.length, 2); // dead one filtered before dedupe ever sees it
    assert.deepEqual(result.missing, []);
    assert.ok(Object.values(result.idMap).includes(1) || Object.values(result.idMap).includes(3));
  } finally {
    db.close();
  }
});

test("a curated show is exempt from D1 — dead, thin or years stale, it stays in the list", () => {
  /* THE FIRST REAL RUN'S FINDING, pinned. 16 of 220 curated shows never reached
     the id-map because D1 dropped them: LeVar Burton Reads (last episode May
     2024), The Robot Brains (August 2023), Black Box Down (June 2023) — all
     three still serving a full back catalogue over HTTP 200 today. A finished
     podcast is not a dead one, and dropping it would REMOVE from the app
     content a listener can play right now.

     MUTATION THAT KILLS THIS: delete the `isCuratedRow` branch in
     applyD1Filter. All three rows fail D1, `canonical` comes back empty and
     every curated show lands in `missing`. Ran it — red. */
  const rows = [
    fixtureRow({ id: 10, url: "https://feeds.example.com/finished", title: "Finished Show",
      newestItemPubdate: monthsAgo(30) }),                                   // stale
    fixtureRow({ id: 11, url: "https://feeds.example.com/gone", title: "Gone Show", dead: 1 }), // dead
    fixtureRow({ id: 12, url: "https://feeds.example.com/thin", title: "Thin Show", episodeCount: 1 }), // too few
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "finished", title: "Finished Show", feed_url: "https://feeds.example.com/finished" },
    { show_id: "gone", title: "Gone Show", feed_url: "https://feeds.example.com/gone" },
    { show_id: "thin", title: "Thin Show", feed_url: "https://feeds.example.com/thin" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.deepEqual(result.missing, [], "no curated show may be dropped by D1");
    assert.equal(result.d1Counts.curated_exempt, 3, "all three were kept BY the exemption, not by passing");
    assert.equal(result.canonical.length, 3);
    assert.deepEqual(
      Object.keys(result.idMap).sort(), ["finished", "gone", "thin"],
      "every curated show must resolve to a pi_id"
    );
  } finally {
    db.close();
  }
});

test("dedupe hands a group to its curated member, so the id-map join cannot miss", () => {
  /* WHY THIS IS SEPARATE FROM THE EXEMPTION. Odd Lots publishes daily and
     passes D1 on every measure, and the first real run still reported it
     unmapped. The exemption cannot explain that one: the cause is a show with
     SEVERAL feeds in the dump, where D13's default pick (has an Apple id, else
     most recently updated) chose a sibling row whose url and itunesId are not
     the ones `data/catalog.json` carries. The show survives, the join misses,
     and it reads as "missing" either way.

     MUTATION THAT KILLS THIS: drop the `curatedMembers` scope in
     pickCanonical. The sibling (id 21, which holds the itunesId) wins the
     group, the curated feed url is no longer in `canonical`, and `missing`
     names the show. Ran it — red. */
  const rows = [
    fixtureRow({ id: 20, url: "https://feeds.example.com/oddlots", title: "Odd Lots",
      podcastGuid: "same-guid", itunesId: null, popularityScore: 90 }),
    fixtureRow({ id: 21, url: "https://feeds.example.com/oddlots-mirror", title: "Odd Lots",
      podcastGuid: "same-guid", itunesId: 999, popularityScore: 10 }),
  ];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "odd-lots", title: "Odd Lots", feed_url: "https://feeds.example.com/oddlots" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.deepEqual(result.missing, []);
    assert.equal(result.canonical.length, 1, "the two feeds are still one show");
    assert.equal(result.idMap["odd-lots"], 20, "the curated feed's row must be the canonical one");
  } finally {
    db.close();
  }
});

test("runPipeline: id-map fails closed — a curated show with no matching row is reported, never silently dropped", () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [
    { show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" },
    { show_id: "ghost-show", title: "Ghost Show", feed_url: "https://nowhere.example.com/feed" },
  ];
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].show_id, "ghost-show");
  } finally {
    db.close();
  }
});

test("writeBuildOutput: throws ID_MAP_INCOMPLETE and writes nothing when a curated show is unmapped", async () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "ghost-show", title: "Ghost Show", feed_url: "https://nowhere.example.com/feed" }];
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    await assert.rejects(
      () => writeBuildOutput(result, { outDir, exportVersion: "v1" }),
      (err) => err.code === "ID_MAP_INCOMPLETE" && /ghost-show/.test(err.message),
    );
    // The fail-closed guarantee is that NOTHING is written on this path —
    // not shards, not top.json, nothing — so a partial/inconsistent build
    // never lands on disk. Assert the directory is genuinely empty, not
    // just that the right error was thrown (a partial-write regression
    // must fail this test).
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(outDir), [], "outDir must be empty when the id-map check fails");
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("writeBuildOutput: enforces the top.json size budget", async () => {
  const rows = [fixtureRow({ id: 1, url: "https://feeds.example.com/show1" })];
  const db = buildFixtureDb(rows);
  const curatedShows = [{ show_id: "show-one", title: "Show One", feed_url: "https://feeds.example.com/show1" }];
  const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
  try {
    const result = runPipeline(db, { curatedShows, now: NOW });
    // Force an oversized top.json by padding one row's title.
    result.top[0].t = "x".repeat(300_000);
    await assert.rejects(
      () => writeBuildOutput(result, { outDir, exportVersion: "v1" }),
      (err) => err.code === "TOP_TOO_LARGE",
    );
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(outDir), [], "outDir must be empty when the size budget check fails");
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("acceptance: two builds over the same fixture produce byte-identical output artifacts", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => fixtureRow({
    id: i + 1,
    url: `https://feeds.example.com/show${i + 1}`,
    title: `Show ${i + 1}`,
    itunesAuthor: `Author ${i % 3}`,
    popularityScore: (i * 37) % 97, // scrambled, not insertion-ordered
  }));
  const curatedShows = [{ show_id: "show-one", title: "Show 1", feed_url: "https://feeds.example.com/show1" }];

  async function buildOnce() {
    const db = buildFixtureDb(rows);
    const outDir = mkdtempSync(join(tmpdir(), "shows-build-"));
    try {
      const result = runPipeline(db, { curatedShows, now: NOW });
      await writeBuildOutput(result, { outDir, exportVersion: "v1", builtAt: "2026-09-05T00:00:00.000Z" });
      return outDir;
    } finally {
      db.close();
    }
  }

  const dirA = await buildOnce();
  const dirB = await buildOnce();
  try {
    for (const file of ["manifest.json", "top.json", "id-map.json", "changed.json"]) {
      const a = await readFile(join(dirA, file));
      const b = await readFile(join(dirB, file));
      assert.ok(a.equals(b), `${file} differs between two runs over the same fixture`);
    }
    // Spot-check a shard too.
    const shardA = readFileSync(join(dirA, "shards", "sh.json.gz"));
    const shardB = readFileSync(join(dirB, "shards", "sh.json.gz"));
    assert.ok(shardA.equals(shardB), "shards/sh.json.gz differs between two runs over the same fixture");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
