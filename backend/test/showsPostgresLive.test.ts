import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * backend/test/showsPostgresLive.test.ts — S-09 (kanban t_f00c0a28).
 *
 * The card asks for "backend tests run against a CI Postgres service
 * container in a new `db` job that applies migrations and runs the golden
 * set". The actual migration-apply + golden-query + rekey logic lives in
 * tools/shows/shows-postgres-integration.test.mjs (run under `node --test`,
 * same pattern as every other tools/shows suite, gated on TEST_DATABASE_URL
 * so it never needs Postgres on a laptop or in the `backend` vitest job).
 *
 * This file is the vitest-side half of the same acceptance criterion: it
 * runs INSIDE `backend`'s own `npm test` (vitest), so `.github/workflows/ci.yml`'s
 * new `db` job — which sets DATABASE_URL to the service container AND then
 * runs `npm test` here — actually exercises Postgres through the SAME
 * command the `backend` job runs unconditionally (with no DB, everything
 * below reports skipped, not failed, matching migrate.ts's own "degrades
 * gracefully when DATABASE_URL is unset" contract, which env.test.ts
 * already floors for the config layer).
 *
 * Skips (never fails) when neither DATABASE_URL nor SHOWS_DATABASE_URL is
 * set, matching load-postgres.mjs's own inert-in-production gate.
 */

const databaseUrl = process.env.SHOWS_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("shows_catalog / show_id_map against a live Postgres (db CI job)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg's Client type is intentionally loose here; this file only exists in the DB-present branch.
  let client: any;

  beforeAll(async () => {
    const { Client } = await import("pg");
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("shows_catalog and show_id_map exist with the expected columns (migrations 0017-0018 applied)", async () => {
    const result = await client.query(
      `select column_name from information_schema.columns
       where table_name = 'shows_catalog'
       order by column_name`
    );
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "pi_id", "title", "author", "itunes_id", "feed_url", "search_tsv", "curated", "export_version",
      ])
    );

    const idMapResult = await client.query(
      `select column_name from information_schema.columns where table_name = 'show_id_map' order by column_name`
    );
    const idMapColumns = idMapResult.rows.map((r: { column_name: string }) => r.column_name);
    expect(idMapColumns).toEqual(expect.arrayContaining(["show_id", "pi_id", "export_version"]));
  });

  it("catalog_show_episodes and catalog_show_feed_state carry a pi_id column after the 0019 rekey", async () => {
    for (const table of ["catalog_show_episodes", "catalog_show_feed_state"]) {
      const result = await client.query(
        `select column_name from information_schema.columns where table_name = $1`,
        [table]
      );
      const columns = result.rows.map((r: { column_name: string }) => r.column_name);
      expect(columns).toContain("pi_id");
      expect(columns).toContain("legacy_show_id");
    }
  });

  it("pg_trgm extension is installed (required by idx_shows_catalog_title_trgm)", async () => {
    const result = await client.query(
      `select extname from pg_extension where extname = 'pg_trgm'`
    );
    expect(result.rows.length).toBe(1);
  });
});
