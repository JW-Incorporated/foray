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
import {
  buildChangedInDumpReasons, resolveDatabaseUrl, sizingReport,
} from "./load-postgres.mjs";

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
