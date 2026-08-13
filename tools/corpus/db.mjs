/* Corpus DB: node:sqlite (zero native deps), migration-managed.
 *
 * Migrations are numbered .sql files in migrations/, applied in order inside
 * a transaction each, tracked via PRAGMA user_version — the same shape as a
 * Postgres migrations table, so the later pgvector lift is mechanical.
 *
 * WAL + busy_timeout because Workstream C runs one ingestion process per
 * dossier area in parallel against this one file.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "./paths.mjs";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

/* `create` is an explicit intent, defaulting to false, because DatabaseSync
 * silently CREATES an empty db when the file is absent — and on any checkout
 * without data-local/corpus/ (the DB is machine-local, gitignored) that turned
 * `search`/`stats` into "zero results" instead of "no corpus here". An empty
 * answer from a missing database is how someone concludes the corpus is empty
 * rather than absent, and quietly stops trusting it. Only the build commands
 * (init, load-manifest, ingest) pass create: true. */
export function openDb(dbPath = DB_PATH, { create = false } = {}) {
  if (!create && !fs.existsSync(dbPath)) {
    throw new Error(
      `no corpus database at ${dbPath}\n` +
        `The corpus DB is machine-local (data-local/ is gitignored) and exists only on the machine\n` +
        `that built it — this is not an empty corpus, it is an absent one. To build it here:\n` +
        `  node tools/corpus/corpus.mjs init\n` +
        `  node tools/corpus/corpus.mjs load-manifest\n` +
        `  node tools/corpus/corpus.mjs ingest --all\n` +
        `No DB needed: the committed digests cover all 54 sources — docs/research/corpus/digests.md.`
    );
  }
  if (create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db, migrationsDir = MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const current = db.prepare("PRAGMA user_version").get().user_version;
  let applied = 0;

  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    // BEGIN IMMEDIATE serializes concurrent migrators under busy_timeout,
    // and re-reading user_version inside the write lock means the losers of
    // the race skip cleanly instead of dying on "table already exists".
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = db.prepare("PRAGMA user_version").get().user_version;
      if (version <= v) { db.exec("COMMIT"); continue; }
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
      applied++;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return { from: current, to: Math.max(current, ...files.map((f) => Number(f.slice(0, 4))), 0), applied };
}

export function openMigrated(dbPath = DB_PATH, opts = {}) {
  const db = openDb(dbPath, opts);
  migrate(db);
  return db;
}
