/* tools/shows/shows-postgres-integration.test.mjs — S-09's real-Postgres
   acceptance suite: applies migrations 0001-0019 against a scratch
   database, loads a synthetic fixture through load-postgres.mjs's actual
   COPY-staging -> upsert path, runs the golden-query set through
   search-shows.mjs, and checks the rekey (0019) preserves a seeded 0016
   row. This is the suite CI's new `db` job (backend/package.json's `test`
   already covers the vitest side; this one runs under `node --test` like
   every other tools/shows suite) points a real Postgres service container
   at — see .github/workflows/ci.yml's `db` job.

   GATED on TEST_DATABASE_URL: skips (not fails) when unset, so `npm test`
   here stays the zero-Postgres-required command everywhere else in this
   repo, per this file's own package.json note and the card's "nothing here
   runs in production" instruction extended to "nothing here requires a DB
   locally either". */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(ROOT, "backend", "migrations");

async function applyMigrations(client) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  await client.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
  for (const file of files) {
    const already = await client.query("select 1 from schema_migrations where filename = $1", [file]);
    if ((already.rowCount ?? 0) > 0) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    }
  }
}

const GOLDEN_ROWS = [
  { pi_id: 1, title: "Lex Fridman Podcast", author: "Lex Fridman", itunes_id: 1434243584, curated: true, popularity: 90 },
  { pi_id: 2, title: "The Joe Rogan Experience", author: "Joe Rogan", itunes_id: 111, curated: false, popularity: 100 },
  { pi_id: 3, title: "Titans of Nuclear", author: "Energy Impact Center", itunes_id: 1331598443, curated: true, popularity: 40 },
  { pi_id: 4, title: "Deep Questions with Cal Newport", author: "Cal Newport", itunes_id: 222, curated: false, popularity: 60 },
  { pi_id: 5, title: "A Completely Unrelated Cooking Show", author: "Chef Someone", itunes_id: 333, curated: false, popularity: 30 },
];

async function seedGoldenRows(client) {
  for (const row of GOLDEN_ROWS) {
    await client.query(
      `insert into shows_catalog (pi_id, title, author, itunes_id, feed_url, curated, popularity_score, export_version, dead)
       values ($1, $2, $3, $4, $5, $6, $7, 'test-v1', false)
       on conflict (pi_id) do update set title = excluded.title`,
      [row.pi_id, row.title, row.author, row.itunes_id, `https://feeds.example.com/${row.pi_id}`, row.curated, row.popularity]
    );
  }
}

test("integration: migrations 0001-0019 apply against a real Postgres, twice, clean", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await applyMigrations(client);
    await applyMigrations(client); // second pass: every migration should skip, none should error
    const tables = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('shows_catalog', 'show_id_map', 'catalog_show_episodes', 'catalog_show_feed_state')`
    );
    const names = tables.rows.map((r) => r.table_name).sort();
    assert.deepEqual(names, ["catalog_show_episodes", "catalog_show_feed_state", "show_id_map", "shows_catalog"]);
  } finally {
    await client.end();
  }
});

test("integration: golden-query search set ranks correctly", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, async () => {
  const { Client } = await import("pg");
  const { searchShows } = await import("./search-shows.mjs");
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await applyMigrations(client);
    await client.query("delete from shows_catalog");
    await seedGoldenRows(client);

    // Exact title match ranks first.
    let result = await searchShows(client, { query: "Lex Fridman" });
    assert.equal(result.strategy, "fts");
    assert.equal(Number(result.rows[0].pi_id), 1);

    // Author-field match still finds the show (weight B).
    result = await searchShows(client, { query: "Cal Newport" });
    assert.equal(Number(result.rows[0].pi_id), 4);

    // Typo tolerance via trgm fallback: FTS on "rogen" finds no lexeme match
    // against "Rogan", so this should hit the trgm path and still surface it.
    result = await searchShows(client, { query: "joe rogen" });
    assert.equal(result.rows.some((r) => Number(r.pi_id) === 2), true);

    // A query with no relation to any title/author returns nothing, not a
    // false positive.
    result = await searchShows(client, { query: "xyzzyquux nonsense" });
    assert.equal(result.rows.length, 0);

    // Curated boost: construct two near-tied-popularity shows differing only
    // in curated status and confirm curated sorts ahead when lexical rank
    // ties (both titles contain "nuclear").
    await client.query(
      `insert into shows_catalog (pi_id, title, author, feed_url, curated, popularity_score, export_version, dead)
       values (100, 'Nuclear Report', 'X', 'https://feeds.example.com/100', false, 40, 'test-v1', false)
       on conflict (pi_id) do update set title = excluded.title`
    );
    result = await searchShows(client, { query: "nuclear" });
    const curatedIdx = result.rows.findIndex((r) => Number(r.pi_id) === 3);
    const nonCuratedIdx = result.rows.findIndex((r) => Number(r.pi_id) === 100);
    assert.ok(curatedIdx >= 0 && nonCuratedIdx >= 0);
    assert.ok(curatedIdx < nonCuratedIdx, "curated show should rank ahead of a non-curated show at similar popularity");
  } finally {
    await client.end();
  }
});

test("integration: rekey (0019) preserves a seeded 0016 row set, backfilled via the real loader function", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, async () => {
  const { Client } = await import("pg");
  const { backfillLegacyShowIdKeys } = await import("./load-postgres.mjs");
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await applyMigrations(client);
    await client.query("delete from shows_catalog");
    await client.query("delete from show_id_map");
    await client.query("delete from catalog_show_episodes");
    await client.query("delete from catalog_show_feed_state");

    // Seed a 0016-shaped episode row AND a feed-state row, keyed by
    // legacy_show_id with pi_id still null — simulating data that existed
    // before 0019 ever ran (0018's show_id_map was empty at migration
    // time, so every pre-existing row landed as an orphan per 0019's own
    // comment). show_id_map gets its mapping only NOW, after the fact —
    // the exact "mapping arrives later" scenario backfillLegacyShowIdKeys
    // exists to resolve (fresh-context review finding, 2026-09-15: the
    // migration's one-shot UPDATE...FROM can never see a mapping that
    // doesn't exist yet at migration time).
    await client.query(
      `insert into shows_catalog (pi_id, title, feed_url, export_version, dead)
       values (777, 'Seeded Show', 'https://feeds.example.com/777', 'test-v1', false)
       on conflict (pi_id) do nothing`
    );
    await client.query(
      `insert into catalog_show_episodes (legacy_show_id, guid, title, audio_url, pi_id)
       values ('seeded-show', 'guid-1', 'Episode One', 'https://audio.example.com/1', null)`
    );
    await client.query(
      `insert into catalog_show_feed_state (legacy_show_id, feed_url, pi_id)
       values ('seeded-show', 'https://feeds.example.com/777', null)`
    );

    // Confirm nothing resolved yet — show_id_map has no entry for
    // 'seeded-show' at this point.
    let episodeRow = await client.query(
      `select pi_id from catalog_show_episodes where legacy_show_id = 'seeded-show'`
    );
    assert.equal(episodeRow.rows[0].pi_id, null, "pi_id should still be null before show_id_map is populated");

    // NOW a real import maps 'seeded-show' -> 777 (this is what
    // loadIdMap does on every real run).
    await client.query(
      `insert into show_id_map (show_id, pi_id, export_version)
       values ('seeded-show', 777, 'test-v1')
       on conflict (show_id) do update set pi_id = excluded.pi_id`
    );

    // Run the ACTUAL exported function, not a hand-copy of its SQL.
    const backfillResult = await backfillLegacyShowIdKeys(client);
    assert.equal(backfillResult.episodes_backfilled, 1);
    assert.equal(backfillResult.feed_state_backfilled, 1);

    episodeRow = await client.query(
      `select pi_id, legacy_show_id, guid, title from catalog_show_episodes where legacy_show_id = 'seeded-show'`
    );
    assert.equal(episodeRow.rows.length, 1);
    assert.equal(Number(episodeRow.rows[0].pi_id), 777);
    assert.equal(episodeRow.rows[0].guid, "guid-1");
    assert.equal(episodeRow.rows[0].title, "Episode One");

    const feedStateRow = await client.query(
      `select pi_id, legacy_show_id, feed_url from catalog_show_feed_state where legacy_show_id = 'seeded-show'`
    );
    assert.equal(feedStateRow.rows.length, 1);
    assert.equal(Number(feedStateRow.rows[0].pi_id), 777);
    assert.equal(feedStateRow.rows[0].feed_url, "https://feeds.example.com/777");

    // Idempotent: running it again touches nothing (pi_id already set).
    const secondRun = await backfillLegacyShowIdKeys(client);
    assert.equal(secondRun.episodes_backfilled, 0);
    assert.equal(secondRun.feed_state_backfilled, 0);
  } finally {
    await client.end();
  }
});

test("integration: the real COPY loader (loadCatalogRows) inserts, updates, and retires rows across two runs", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, async () => {
  const { Client } = await import("pg");
  const { loadCatalogRows, fetchPreviousNewest } = await import("./load-postgres.mjs");
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await applyMigrations(client);
    await client.query("delete from show_id_map");
    await client.query("delete from catalog_show_episodes");
    await client.query("delete from catalog_show_feed_state");
    await client.query("delete from shows_catalog");

    const baseRow = (over) => ({
      pi_id: 900, title: "Run One Show", author: "Author", itunes_id: null,
      feed_url: "https://feeds.example.com/900", image_url: null, episode_count: 10,
      popularity_score: 5, explicit: false, language: "en", dead: false,
      newest_item_at: "2026-01-01T00:00:00.000Z", curated: false,
      category1: null, category2: null, category3: null,
      export_version: "run-1",
      ...over,
    });

    // Run 1: insert two rows.
    const run1 = await loadCatalogRows(client, [baseRow({ pi_id: 900 }), baseRow({ pi_id: 901, title: "Run One Show B" })], { exportVersion: "run-1" });
    assert.equal(run1.inserted, 2);
    assert.equal(run1.updated, 0);
    assert.equal(run1.retired, 0);

    const previousNewest = await fetchPreviousNewest(client);
    assert.equal(previousNewest["900"], Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000));

    // Run 2: pi_id 900 persists with a changed title (update), pi_id 901
    // is ABSENT from this run's canonical output (it failed D1 on the
    // re-import, or lost a dedupe tie-break) — it must be retired, not
    // left stale in shows_catalog forever.
    const run2 = await loadCatalogRows(
      client,
      [baseRow({ pi_id: 900, title: "Run One Show (renamed)", export_version: "run-2" })],
      { exportVersion: "run-2" }
    );
    assert.equal(run2.inserted, 0);
    assert.equal(run2.updated, 1);
    assert.equal(run2.retired, 1, "pi_id 901, absent from run 2's canonical set, must be retired");

    const remaining = await client.query("select pi_id, title from shows_catalog order by pi_id");
    assert.equal(remaining.rows.length, 1);
    assert.equal(Number(remaining.rows[0].pi_id), 900);
    assert.equal(remaining.rows[0].title, "Run One Show (renamed)");
  } finally {
    await client.end();
  }
});

test("integration: checkMissingMapping fails closed over the exact MAX_UNMAPPED_CURATED_FRACTION ceiling", async () => {
  const { checkMissingMapping } = await import("./load-postgres.mjs");
  // 6 of 100 missing = 6%, over the 5% ceiling.
  const missing = Array.from({ length: 6 }, (_, i) => ({ show_id: `show-${i}`, title: `Show ${i}` }));
  const idMap = Object.fromEntries(Array.from({ length: 94 }, (_, i) => [`mapped-${i}`, i]));
  assert.throws(
    () => checkMissingMapping({ missing, idMap }),
    /6 of 100 curated show\(s\)/
  );
});

test("integration: checkMissingMapping passes under the ceiling and warns rather than throwing", () => {
  return import("./load-postgres.mjs").then(({ checkMissingMapping }) => {
    const missing = [{ show_id: "show-0", title: "Show 0" }];
    const idMap = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`mapped-${i}`, i]));
    // 1 of 100 = 1%, under the 5% ceiling -- must not throw.
    checkMissingMapping({ missing, idMap });
  });
});

