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
import { fileURLToPath } from "node:url";
import { CLIENT_SHOW_FIELDS, projectShow, buildCatalogClient } from "./build-catalog-client.mjs";

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

test("the committed data/catalog-client.json equals the builder's output", () => {
  /* The derived file is committed, so it can drift from its inputs. This
     rebuilds it in-process from the two real catalogues and compares bytes
     (test/show-page.test.js shells out to --check for the same file; this
     one also proves the breadth join is in the committed bytes).

     MUTATION: drop "chart_rank" from CLIENT_SHOW_FIELDS. This fails: the
     rebuilt text no longer carries the committed chart_rank lines.
     MUTATION: hand-edit one chart_rank in data/catalog-client.json. This
     fails on the byte comparison. */
  const built = buildCatalogClient(readJson("data/catalog.json"), readJson("data/catalog-breadth.json"));
  const text = JSON.stringify(built, null, 2) + "\n";
  const onDisk = fs.readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8");
  assert.ok(text === onDisk, "data/catalog-client.json is stale — run: node tools/build-catalog-client.mjs");
  assert.ok(built.shows.some((s) => Number.isFinite(s.chart_rank) && s.chart_rank > 0), "at least one curated show carries a chart_rank");
});
