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
    fixtureRow({ id: 2, title: "Dead Show", dead: 1, popularityScore: 5 }),
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
