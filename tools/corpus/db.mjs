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

export function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
    db.exec("BEGIN");
    try {
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

export function openMigrated(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  migrate(db);
  return db;
}
