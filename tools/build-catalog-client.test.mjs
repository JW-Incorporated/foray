/* PKG-11b (P-09 data, client half — docs/roadmap/shows-search.md §PKG-11b):
 * tools/build-catalog-client.mjs projects data/catalog.json into
 * data/catalog-client.json, and now joins each curated show's Apple chart
 * rank from data/catalog-breadth.json on apple_collection_id — the same join
 * tools/build-show-index.mjs makes for data/show-index.tsv (PKG-11a).
 *
 * Nothing in the client reads chart_rank yet; popularityBand does from
 * PKG-13 on. Until then the risk is a SILENT one: a dropped field, a join
 * that filters out the in_curated twins (and so joins nothing), or a
 * committed file nobody regenerated. Each test names the mutation it kills.
 *
 * Harness: plain node:test over the module's exported pure functions, plus
 * the real committed catalogues for the parity claim.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLIENT_SHOW_FIELDS, projectShow, buildCatalogClient } from "./build-catalog-client.mjs";
import { rankByAppleId } from "./harvest-merge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

test("projectShow/buildCatalogClient emit chart_rank from the breadth join and null otherwise", () => {
  /* Three curated shows: one with a ranked breadth twin that is itself
     `in_curated: true` (which is what every real twin looks like — a join
     that skipped in_curated rows would find nothing), one whose twin carries
     no usable rank, and one with no twin at all. The twin's apple_collection_id
     is a number and the curated one a string, so the String() key matters.

     MUTATION: drop "chart_rank" from CLIENT_SHOW_FIELDS. This fails: the
     projected rows lose the key entirely.
     MUTATION: filter the rankByAppleId loop to `!row.in_curated`. This fails:
     show-a's rank comes back null. */
  const catalog = {
    version: 7,
    shows: [
      { show_id: "show-a", title: "A", apple_collection_id: "111" },
      { show_id: "show-b", title: "B", apple_collection_id: "222" },
      { show_id: "show-c", title: "C", apple_collection_id: "333" },
    ],
  };
  const breadth = {
    shows: [
      { apple_collection_id: 111, title: "A", chart_rank: 14, in_curated: true },
      { apple_collection_id: 222, title: "B", chart_rank: 0, in_curated: true },
      { apple_collection_id: 999, title: "Z", chart_rank: 3 },
    ],
  };

  assert.ok(CLIENT_SHOW_FIELDS.includes("chart_rank"), "CLIENT_SHOW_FIELDS must project chart_rank");
  assert.strictEqual(projectShow({ show_id: "x" }).chart_rank, null, "a show with no rank projects chart_rank: null");

  const joined = buildCatalogClient(catalog, breadth);
  assert.deepStrictEqual(
    joined.shows.map((s) => [s.show_id, s.chart_rank]),
    [["show-a", 14], ["show-b", null], ["show-c", null]],
  );

  const unjoined = buildCatalogClient(catalog);
  for (const s of unjoined.shows) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, "chart_rank"), `${s.show_id} must carry chart_rank`);
    assert.strictEqual(s.chart_rank, null, `${s.show_id}: no breadth, so chart_rank is null`);
  }
});

test("CH2-15: the chart_rank join over null, 0, \"12\", NaN, -1 and a ranked twin keeps only \"12\" and the ranked twin", () => {
  /* T1-13 (docs/roadmap/code-health-2.md): "a usable chart rank" is ONE join,
     tools/harvest-merge.mjs's rankByAppleId, shared with
     tools/build-show-index.mjs. The same six-row fixture is pinned in
     tools/harvest-merge.test.mjs (the helper) and tools/build-show-index.test.mjs
     (the other builder), so the client JSON and the TSV cannot disagree about
     which rank is usable.

     MUTATION: in harvest-merge.mjs's isChartRank, `Number(raw) > 0` ->
     `Number(raw) >= 0`. The 0 twin maps to 0 and this fails.
     MUTATION: project the raw `row.chart_rank` instead of rankByAppleId's.
     "12" comes back a string and this fails. */
  const ids = [101, 102, 103, 104, 105, 106];
  const breadth = { shows: [null, 0, "12", NaN, -1, 7].map((chart_rank, i) =>
    ({ apple_collection_id: ids[i], title: `T${ids[i]}`, chart_rank, in_curated: true })) };
  const catalog = { version: 1, shows: [...ids, 107].map((id) => ({ show_id: `s${id}`, title: `S${id}`, apple_collection_id: id })) };
  const out = buildCatalogClient(catalog, breadth);
  assert.deepStrictEqual(
    out.shows.map((s) => [s.show_id, s.chart_rank]),
    [["s101", null], ["s102", null], ["s103", 12], ["s104", null], ["s105", null], ["s106", 7], ["s107", null]],
  );
  const shared = rankByAppleId(breadth);
  for (const s of out.shows) {
    assert.strictEqual(s.chart_rank, shared.get(s.show_id.slice(1)) ?? null, `${s.show_id}: the builder's rank is the shared join's`);
  }
});

test("the committed data/catalog-client.json equals the builder's output", () => {
  /* The derived file is committed, so it can drift from its inputs. This
     rebuilds it in-process from the two real catalogues and compares bytes
     (test/show-page.test.js shells out to --check for the same file; this
     one also proves the breadth join is in the committed bytes).

     MUTATION: drop "chart_rank" from CLIENT_SHOW_FIELDS. This fails: the
     rebuilt text no longer carries the committed chart_rank lines.
     MUTATION: hand-edit one chart_rank in data/catalog-client.json. This
     fails on the byte comparison. */
  const built = buildCatalogClient(readJson("data/catalog.json"), readJson("data/catalog-breadth.json"), readJson("data/dai-classification.json"));
  const text = JSON.stringify(built, null, 2) + "\n";
  const onDisk = fs.readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8");
  assert.ok(text === onDisk, "data/catalog-client.json is stale — run: node tools/build-catalog-client.mjs");
  assert.ok(built.shows.some((s) => Number.isFinite(s.chart_rank) && s.chart_rank > 0), "at least one curated show carries a chart_rank");
  assert.ok(built.shows.some((s) => s.dai === true) && built.shows.some((s) => s.dai === false), "the committed file carries both DAI classes");
});

test("dai is joined from data/dai-classification.json on String(apple_collection_id), null when unclassified (CH-1, #1071)", () => {
  /* The classification is keyed by Apple collection id as a STRING, and the
     curated catalogue carries the id as a number or a string. show-d's
     show_id is itself a classification key, so a join on show_id answers
     false for it where the right answer is null.

     MUTATION: key the lookup on `show?.show_id` instead of
     `String(show?.apple_collection_id)` — show-a/show-b come back null and
     show-d false; red.
     MUTATION 2: return `v ?? null` instead of booleans only — show-c's
     "unknown" string leaks through; red. */
  const catalog = {
    version: 1,
    shows: [
      { show_id: "show-a", apple_collection_id: 111 },
      { show_id: "show-b", apple_collection_id: "222" },
      { show_id: "show-c", apple_collection_id: 333 },
      { show_id: "444", apple_collection_id: 999 },
    ],
  };
  const daiClass = { shows: { "111": { dai: true }, "222": { dai: false }, "333": { dai: "unknown" }, "444": { dai: false } } };
  assert.ok(CLIENT_SHOW_FIELDS.includes("dai"), "CLIENT_SHOW_FIELDS must project dai");
  assert.deepStrictEqual(
    buildCatalogClient(catalog, null, daiClass).shows.map((s) => [s.show_id, s.dai]),
    [["show-a", true], ["show-b", false], ["show-c", null], ["444", null]],
  );
  assert.ok(buildCatalogClient(catalog).shows.every((s) => s.dai === null), "no classification file: every dai is null");
});

test("--check exits non-zero on a stale file and zero on a fresh one", () => {
  /* The committed file is derived, so the gate is the --check exit code.
     MUTATION: change the stale branch's `process.exit(1)` to `process.exit(0)`
     — the stale copy passes; red. */
  const script = path.join(ROOT, "tools", "build-catalog-client.mjs");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catclient-")), "catalog-client.json");
  const run = () => spawnSync(process.execPath, [script, "--out", tmp, "--check"], { encoding: "utf8" });
  const fresh = fs.readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8");
  fs.writeFileSync(tmp, fresh.replace(/"dai": (true|false)/, (m, v) => `"dai": ${v === "true" ? "false" : "true"}`));
  assert.notStrictEqual(run().status, 0, "a drifted dai is flagged");
  fs.writeFileSync(tmp, fresh);
  assert.strictEqual(run().status, 0, "the committed file passes");
});
