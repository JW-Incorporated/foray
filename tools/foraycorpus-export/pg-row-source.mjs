/* Read-only Postgres row source for the corpus export (PKG-07, G-10;
   docs/roadmap/corpus.md §3 "PKG-07 · pg-row-source.mjs").

   Same interface as row-source.mjs jsonlRowSource: `{ kind, rows(table),
   counts(), describe() }`, plus `close()`. It reads foraycorpus through the
   read-only role (corpus brief :36: the role can SELECT and the statement
   timeout is respected).

   - One transaction, opened on first use: `BEGIN`, `SET TRANSACTION READ
     ONLY`, `SET LOCAL statement_timeout = <PG_STATEMENT_TIMEOUT_MS>`. READ
     ONLY is belt and braces on top of the role, so a bug here cannot write
     even if the role ever gains a grant.
   - Keyset pagination with plain `client.query` (no pg-cursor, no OFFSET).
     It uses `id` for podcasts, podcast_feeds, podcast_source_records,
     episodes and assets (five tables; the card says six). It uses the tuple
     `(episode_id, feed_id)` for episode_source_records and
     `(podcast_source_record_id, feed_id)` for podcast_source_links.
     feed_host_policies is read whole (one row per host, small). Ids are
     serial or identity columns and so positive: the first page starts at 0.
     Pages are PG_PAGE_SIZE rows, and a short page ends the table.
   - `counts()` reads `pg_class.reltuples`. These are planner estimates, not
     exact counts: -1 means the table was never analysed. Exact counts would
     be full scans of millions of rows under the statement timeout.
   - `describe()` never carries the connection string, and a connection
     error has its password stripped before it is rethrown. No test (and no
     code path here) logs the string.

   `pg` is imported lazily inside the default client factory, so importing
   this module needs no node_modules and the tests inject a fake client.
   pg returns int8 columns as strings by default. The source passes rows
   through unchanged, and the consumers coerce ids with Number where they
   compare them. */
import { PG_ENV, PG_PAGE_SIZE, PG_STATEMENT_TIMEOUT_MS } from "./config.mjs";
import { RowSourceError, TABLES } from "./row-source.mjs";

/* SQL per table. Column lists are PKG-02's (fixtures/synthetic/*.jsonl and
   its README): brief §1 for podcasts, podcast_feeds, episodes,
   episode_source_records and assets.
   ASSUMED: the column lists for podcast_source_records, podcast_source_links,
   feed_host_policies and episodes.updated_at are ASSUMED until PKG-03
   confirms them (fixtures/scrubbed-2026-09/SCHEMA.md does not exist yet).
   PKG-03 corrects this map if they differ. */
const ID_PAGE = (table, cols) => `SELECT ${cols} FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`;
const PAIR_PAGE = (table, cols, a, b) => `SELECT ${cols} FROM ${table} WHERE (${a}, ${b}) > ($1, $2) ORDER BY ${a}, ${b} LIMIT $3`;

export const SQL = Object.freeze({
  podcasts: ID_PAGE(
    "podcasts",
    "id, public_id, canonical_title, description, declared_language, english_candidate_status, explicit, author, site_url, image_url, status",
  ),
  podcast_feeds: ID_PAGE(
    "podcast_feeds",
    "id, podcast_id, current_url, normalized_url, url_hash, status, last_success_at, last_attempt_at, crawl_rank, crawl_tier, categories, itunes_block_raw, podcast_locked_raw",
  ),
  podcast_source_records: ID_PAGE("podcast_source_records", "id, source_record_id, itunes_id, extra_source_json"),
  podcast_source_links: PAIR_PAGE("podcast_source_links", "podcast_source_record_id, feed_id, podcast_id", "podcast_source_record_id", "feed_id"),
  episodes: ID_PAGE(
    "episodes",
    "id, public_id, podcast_id, canonical_title, description, source_published_at, duration_seconds, explicit, status, updated_at",
  ),
  episode_source_records: PAIR_PAGE(
    "episode_source_records",
    "episode_id, feed_id, guid_raw, guid_hash, title_raw, description_raw, pub_date_parsed, duration_parsed_seconds",
    "episode_id",
    "feed_id",
  ),
  assets: ID_PAGE("assets", "id, owner_type, owner_id, asset_type, url, mime_type, language, relation, declared_byte_length"),
  feed_host_policies: "SELECT host, state, reason FROM feed_host_policies ORDER BY host",
});

/** How each table pages: the keyset columns (empty = read whole). */
export const KEYSET = Object.freeze({
  podcasts: Object.freeze(["id"]),
  podcast_feeds: Object.freeze(["id"]),
  podcast_source_records: Object.freeze(["id"]),
  podcast_source_links: Object.freeze(["podcast_source_record_id", "feed_id"]),
  episodes: Object.freeze(["id"]),
  episode_source_records: Object.freeze(["episode_id", "feed_id"]),
  assets: Object.freeze(["id"]),
  feed_host_policies: Object.freeze([]),
});

export const COUNT_SQL = "SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1";

/** Replaces the password in any `user:password@` run with `***`. */
export function redactSecrets(text) {
  return String(text ?? "").replace(/:[^:@/]+@/g, ":***@");
}

function databaseName(connectionString) {
  try {
    const name = new URL(connectionString).pathname.replace(/^\//, "");
    return /^[A-Za-z0-9_-]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

async function defaultClientFactory({ connectionString }) {
  const { default: pg } = await import("pg");
  return new pg.Client({ connectionString });
}

/**
 * @param {{connectionString?: string, clientFactory?: Function, pageSize?: number}} options
 *   `clientFactory({ connectionString })` returns an object with
 *   `query(text, params)` (and optionally `connect()` / `end()`); default
 *   is a `pg.Client`. `pageSize` defaults to PG_PAGE_SIZE.
 */
export function pgRowSource({ connectionString = process.env[PG_ENV], clientFactory = defaultClientFactory, pageSize = PG_PAGE_SIZE } = {}) {
  let ready = null;
  let client = null;

  function start() {
    if (!ready) {
      ready = (async () => {
        if (!connectionString && clientFactory === defaultClientFactory) {
          throw new RowSourceError("PG_CONNECT", `${PG_ENV} is not set`);
        }
        try {
          client = await clientFactory({ connectionString });
          if (typeof client.connect === "function") await client.connect();
        } catch (e) {
          throw new RowSourceError("PG_CONNECT", redactSecrets(e?.message ?? e));
        }
        await client.query("BEGIN");
        await client.query("SET TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${Number(PG_STATEMENT_TIMEOUT_MS)}`);
        return client;
      })();
    }
    return ready;
  }

  return {
    kind: "pg",
    async *rows(table) {
      if (!TABLES.includes(table)) throw new RowSourceError("UNKNOWN_TABLE", String(table));
      const c = await start();
      const keys = KEYSET[table];
      if (keys.length === 0) {
        const { rows } = await c.query(SQL[table]);
        yield* rows;
        return;
      }
      let cursor = keys.map(() => 0);
      for (;;) {
        const { rows } = await c.query(SQL[table], [...cursor, pageSize]);
        yield* rows;
        if (rows.length < pageSize) return;
        const last = rows[rows.length - 1];
        cursor = keys.map((k) => last[k]);
      }
    },
    async counts() {
      const c = await start();
      const out = {};
      for (const table of TABLES) {
        const { rows } = await c.query(COUNT_SQL, [table]);
        out[table] = rows.length ? Number(rows[0].n) : null;
      }
      return out;
    },
    describe() {
      const db = connectionString ? databaseName(connectionString) : null;
      return db ? `pg:<host redacted>/${db}` : "pg:<host redacted>";
    },
    /** Ends the read-only transaction and the connection; a no-op if never
        started. */
    async close() {
      if (!ready) return;
      const c = await ready.catch(() => null);
      ready = null;
      if (!c) return;
      try {
        await c.query("ROLLBACK");
      } finally {
        if (typeof c.end === "function") await c.end();
      }
    },
  };
}
