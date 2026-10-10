/* tools/shows/load-postgres.test.mjs — S-09. Pure-function tests run
   always (no DB needed): row shaping, sizing report, changed-in-dump
   reasons. The actual COPY-into-staging -> upsert path against a live
   Postgres is exercised in shows-postgres-integration.test.mjs (this repo's
   CI `db` job only — see that file's own gating). Keeping the two apart
   means `npm test` here (used everywhere, including a laptop with no
   Postgres) never needs a live database, exactly like import-dump.mjs's
   own fixture-only tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as config from "./config.mjs";
import {
  buildChangedInDumpReasons, changedIdsFromPipeline, fetchPreviousNewest, resolveDatabaseUrl, sizingReport,
} from "./load-postgres.mjs";
import { buildChanged } from "./shard-build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("resolveDatabaseUrl: prefers SHOWS_DATABASE_URL over DATABASE_URL", () => {
  const env = { SHOWS_DATABASE_URL: "postgres://a", DATABASE_URL: "postgres://b" };
  assert.deepEqual(resolveDatabaseUrl(env), { url: "postgres://a", varName: "SHOWS_DATABASE_URL" });
});

test("resolveDatabaseUrl: falls back to DATABASE_URL when SHOWS_DATABASE_URL absent", () => {
  const env = { DATABASE_URL: "postgres://b" };
  assert.deepEqual(resolveDatabaseUrl(env), { url: "postgres://b", varName: "DATABASE_URL" });
});

test("resolveDatabaseUrl: null/null when neither set (the inert-in-production path)", () => {
  assert.deepEqual(resolveDatabaseUrl({}), { url: null, varName: null });
});

test("resolveDatabaseUrl: blank string counts as unset", () => {
  const env = { SHOWS_DATABASE_URL: "   ", DATABASE_URL: "postgres://b" };
  assert.deepEqual(resolveDatabaseUrl(env), { url: "postgres://b", varName: "DATABASE_URL" });
});

test("buildChangedInDumpReasons: names newest_item_pubdate_advanced for a present row", () => {
  const canonical = [{ id: 1, newestItemPubdate: 1700000000 }];
  const reasons = buildChangedInDumpReasons(canonical, [1]);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].pi_id, 1);
  assert.equal(reasons[0].reason, "newest_item_pubdate_advanced");
  assert.equal(reasons[0].newest_item_at, new Date(1700000000 * 1000).toISOString());
});

test("buildChangedInDumpReasons: names present_in_changed_set_row_missing when the id vanished from canonical", () => {
  const reasons = buildChangedInDumpReasons([], [42]);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].reason, "present_in_changed_set_row_missing");
  assert.equal(reasons[0].newest_item_at, null);
});

test("buildChangedInDumpReasons: only reports ids actually in the changed set", () => {
  const canonical = [{ id: 1, newestItemPubdate: 1 }, { id: 2, newestItemPubdate: 2 }];
  const reasons = buildChangedInDumpReasons(canonical, [2]);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].pi_id, 2);
});

test("changedIdsFromPipeline: main's { baseline, changed } shape from buildChanged feeds buildChangedInDumpReasons without a TypeError", () => {
  // runPipeline's result.changed on main is shard-build.mjs's buildChanged
  // output, not a bare id array. Use the real producer so a future shape
  // change breaks this test, not the live load.
  const canonical = [{ id: 1, newestItemPubdate: 200 }, { id: 2, newestItemPubdate: 100 }];
  const withBaseline = buildChanged(canonical, { 1: 100, 2: 100 });
  const reasons = buildChangedInDumpReasons(canonical, changedIdsFromPipeline(withBaseline));
  assert.deepEqual(reasons.map((r) => r.pi_id), [1]);
  assert.equal(reasons[0].reason, "newest_item_pubdate_advanced");

  // baseline:false (no previous release) carries changed: null; it must
  // report nothing rather than throw on null.map.
  const noBaseline = buildChanged(canonical, null);
  assert.deepEqual(noBaseline, { baseline: false, changed: null });
  assert.deepEqual(buildChangedInDumpReasons(canonical, changedIdsFromPipeline(noBaseline)), []);
});

test("sizingReport: zero rows reports zeros without dividing by zero", () => {
  const report = sizingReport([], { exportVersion: "v1" });
  assert.deepEqual(report, { row_count: 0, avg_bytes_per_row: 0, estimated_total_bytes: 0, export_version: "v1" });
});

test("sizingReport: computes avg/estimated bytes from real COPY-line encoding", () => {
  const rows = [
    { pi_id: 1, title: "Short", author: null, itunes_id: null, feed_url: "https://a", image_url: null,
      episode_count: 1, popularity_score: 1, explicit: false, language: "en", dead: false,
      newest_item_at: null, curated: false, category1: null, category2: null, category3: null,
      export_version: "v1" },
  ];
  const report = sizingReport(rows, { exportVersion: "v1" });
  assert.equal(report.row_count, 1);
  assert.equal(report.sampled, 1);
  assert.ok(report.avg_bytes_per_row > 0);
  assert.equal(report.estimated_total_bytes, report.avg_bytes_per_row * 1);
});

test("sizingReport: samples at most 5000 rows for the average (never materializes a full 4.7M-row COPY line set to measure)", () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    pi_id: i, title: "T", author: null, itunes_id: null, feed_url: "u", image_url: null,
    episode_count: 1, popularity_score: 1, explicit: false, language: "en", dead: false,
    newest_item_at: null, curated: false, category1: null, category2: null, category3: null,
    export_version: "v1",
  }));
  const report = sizingReport(rows, { exportVersion: "v1" });
  assert.equal(report.row_count, 6000);
  assert.equal(report.sampled, 5000);
  // estimated_total_bytes is rounded from the unrounded avg * row_count, so
  // it can differ from avg_bytes_per_row (itself independently rounded) * 6000
  // by a few bytes — assert it's in the right ballpark instead of bit-exact.
  const expectedApprox = report.avg_bytes_per_row * 6000;
  assert.ok(Math.abs(report.estimated_total_bytes - expectedApprox) < 6000);
});

/* ---- CH2-12 (docs/roadmap/code-health-2.md, T1-08 / T1-03 / T1-12) ---- */

test("resolveDatabaseUrl: a whitespace-only DATABASE_URL is unset, and the rule is config.mjs's one resolver", () => {
  // MUTATION: drop `.trim()` from config.mjs's resolveDatabaseUrl -> red here
  // (and in poll-episodes.test.mjs, which shares the same function).
  assert.deepEqual(resolveDatabaseUrl({ DATABASE_URL: " " }), { url: null, varName: null });
  assert.deepEqual(resolveDatabaseUrl({ DATABASE_URL: "  postgres://b \n" }), { url: "postgres://b", varName: "DATABASE_URL" });
  // MUTATION: a private copy of the resolver back in load-postgres.mjs -> red.
  assert.equal(resolveDatabaseUrl, config.resolveDatabaseUrl);
});

test("fetchPreviousNewest: an empty shows_catalog is NO baseline (null), never the {} that marks every row changed", async () => {
  // MUTATION: `return previousNewest` on zero rows (the {} import-dump.mjs's
  // parseNewestSnapshot bans) -> red: buildChanged would diff against {} and
  // flag every canonical row (T1-08).
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal(await fetchPreviousNewest(empty), null);
  assert.deepEqual(buildChanged([{ id: 1, newestItemPubdate: 5 }], await fetchPreviousNewest(empty)), { baseline: false, changed: null });

  const loaded = { query: async () => ({ rows: [{ pi_id: "900", newest_item_at: new Date("2026-01-01T00:00:00Z") }] }) };
  assert.deepEqual(await fetchPreviousNewest(loaded), { 900: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000) });
});

const INTEGER_COLUMNS = new Set([
  "id", "itunesId", "dead", "episodeCount", "lastUpdate", "newestItemPubdate",
  "oldestItemPubdate", "popularityScore", "explicit",
]);

/** A fixture dump on disk carrying one row per curated show in the real
    data/catalog.json, so the CLI's id-map guard (which reads that file) passes
    and the run reaches the changed/checksum stages. */
function writeCatalogFixtureDump(dir) {
  const raw = JSON.parse(readFileSync(config.CATALOG_PATH, "utf8"));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const path = join(dir, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE podcasts (${config.DUMP_COLUMNS.map((c) => `${c} ${INTEGER_COLUMNS.has(c) ? "INTEGER" : "TEXT"}`).join(", ")})`);
  const stmt = db.prepare(
    "INSERT INTO podcasts (id, url, itunesId, title, itunesAuthor, language, dead, episodeCount, newestItemPubdate, popularityScore) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const recent = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  shows.forEach((s, i) =>
    stmt.run(i + 1, s.feed_url ?? null, s.apple_collection_id ?? null, s.title ?? `Show ${i}`, `Author ${i}`, "en", 0, 10, recent, 10));
  db.close();
  return path;
}

test("CLI --dry-run on a fixture: baseline:false, nothing flagged, no database touched, export_version is the streamed sha256", () => {
  // Acceptance (CH2-12): `load-postgres.mjs --dump-file <fixture> --dry-run`
  // prints baseline:false. DATABASE_URL points at a port nothing listens on:
  // a dry run reads no baseline, so it must never connect.
  // MUTATION: `dryRun ? {} : ...` -> red (baseline:true, every row flagged).
  // MUTATION: connect before the dry-run branch -> red (ECONNREFUSED, exit 1).
  const dir = mkdtempSync(join(tmpdir(), "load-postgres-"));
  try {
    const dump = writeCatalogFixtureDump(dir);
    const res = spawnSync(process.execPath, [...process.execArgv, join(HERE, "load-postgres.mjs"), "--dump-file", dump, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, SHOWS_DATABASE_URL: "", DATABASE_URL: "postgres://user:pw@127.0.0.1:1/never" },
    });
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /changed_in_dump: baseline:false, 0 row\(s\) flagged: \[\]/);
    assert.match(res.stdout, /DRY_RUN: not writing to Postgres/);
    const sha = createHash("sha256").update(readFileSync(dump)).digest("hex");
    assert.ok(res.stdout.includes(`(export_version local:${sha.slice(0, 12)})`), res.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source pin: the dump checksum is config.mjs's streamed checksumFile, never a whole-file readFile (2 GiB trap, T1-03)", () => {
  // A >2 GiB sparse-file test is impractical, so pin the source (the
  // fetch-feed.test.mjs pattern).
  // MUTATION: restore `const bytes = await readFile(dumpFileArg)` in load-postgres.mjs -> red.
  // MUTATION: config.mjs's checksumFile reads the file with readFile -> red.
  const loader = readFileSync(join(HERE, "load-postgres.mjs"), "utf8");
  assert.match(loader, /import \{[^}]*\bchecksumFile\b[^}]*\} from "\.\/config\.mjs"/);
  assert.doesNotMatch(loader, /\breadFile\b/);
  const cfg = readFileSync(join(HERE, "config.mjs"), "utf8");
  const start = cfg.indexOf("export async function checksumFile");
  assert.ok(start >= 0, "config.mjs exports checksumFile");
  const fn = cfg.slice(start, cfg.indexOf("\n}\n", start) + 2);
  assert.match(fn, /createReadStream\(/);
  assert.doesNotMatch(fn, /readFile/);
});
