/* PKG-12 (docs/roadmap/shows-search.md): the P-10 popularity probe.

   Fakes only — no test here touches the network. The ranking itself is the
   REAL `search-engine.js` over synthetic rows, because what is being measured
   is how today's comparator orders a list, and a stand-in comparator would
   measure nothing.

   Every test names the one-line mutation that turns it red; each was run. */

import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_QUERIES,
  buildPositionMap,
  blockOrder,
  appleIdByShowId,
  makePositionOf,
  computeCoverage,
  probeQuery,
  buildReport,
  validateReport,
  loadTopRows,
} from "./popularity-signal-probe.mjs";
import { UA } from "./segments/politeness.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SearchEngine = createRequire(import.meta.url)(path.join(ROOT, "search-engine.js"));

const noSleep = { sleep: async () => {} };
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: null,
  json: async () => body,
});

test("coverage counts a breadth row by Apple id and a curated row by catalogue apple_collection_id", () => {
  /* top.json's `i` is the dump's NUMERIC itunesId; the breadth index's
     show_id is the Apple id as a STRING, and data/catalog.json's
     apple_collection_id is a number again. The join only works if both sides
     are coerced to one type.
     MUTATION: in `buildPositionMap`, `const key = String(row.i);` ->
     `const key = row.i;`. Both counts fall to 0 and this fails. */
  const top = [{ i: 111, c: true }, { i: 222, c: false }, { i: 333, c: false }, { c: false }];
  const map = buildPositionMap(top);
  assert.strictEqual(map.withId, 3, "the row with no `i` is skipped, not joined");
  const positionOf = makePositionOf(map.posByItunesId, appleIdByShowId([
    { show_id: "slug-a", apple_collection_id: 111 },
    { show_id: "slug-b", apple_collection_id: 444 },
  ]));
  const rows = [
    { show_id: "222", title: "B", tier: "breadth", chart_rank: 3 },
    { show_id: "999", title: "C", tier: "breadth", chart_rank: null },
    { show_id: "slug-a", title: "A", tier: "curated", chart_rank: null },
    { show_id: "slug-b", title: "D", tier: "curated", chart_rank: null },
  ];
  assert.deepStrictEqual(computeCoverage(rows, positionOf), {
    index_rows: 4,
    breadth_rows: 2,
    curated_rows: 2,
    breadth_rows_with_top_position: 1,
    curated_rows_with_top_position: 1,
    pct_breadth: 50,
  });
  assert.strictEqual(positionOf(rows[0]), 1, "position is the 0-based index in top.json");
  assert.strictEqual(positionOf(rows[2]), 0);
});

test("would_lead_by_top_position is false when a higher row has a smaller position", () => {
  /* Two breadth rows in one tier and one band, so today's order is the
     alphabet: "Daily Thing" above "The Daily". Position decides the verdict.
     A CURATED row sits above both with position 0 — the curated block of
     top.json — and must NOT count against a breadth show: the comparator
     already puts curated first, and the two blocks' positions are not
     comparable.
     MUTATION: in `wouldLeadByTopPosition`, `p < mine` -> `p > mine`. The
     false case below reads true (and the true case false) and this fails. */
  const shows = [
    { show_id: "cur", title: "Daily Curated" },
    { show_id: "10", title: "Daily Thing", tier: "breadth", chart_rank: 1 },
    { show_id: "20", title: "The Daily", tier: "breadth", chart_rank: 1 },
  ];
  const run = (posThing) => {
    const posByItunesId = new Map([["cur-apple", 0], ["10", posThing], ["20", 3]]);
    const positionOf = makePositionOf(posByItunesId, new Map([["cur", "cur-apple"]]));
    return probeQuery(SearchEngine, "daily", "The Daily", shows, positionOf);
  };
  const lower = run(1);
  assert.deepStrictEqual(lower.top25.map((r) => r[1]), ["Daily Curated", "Daily Thing", "The Daily"],
    "fixture assumption: today's order puts both rows above The Daily");
  assert.strictEqual(lower.intended.rank_today, 3);
  assert.strictEqual(lower.intended.top_position, 3);
  assert.strictEqual(lower.would_lead_by_top_position, false, "Daily Thing (position 1) is more popular");
  assert.deepStrictEqual(lower.intended.best_position_above, ["Daily Thing", 1]);

  const higher = run(9);
  assert.strictEqual(higher.would_lead_by_top_position, true,
    "Daily Thing at 9 is less popular; the curated row at 0 is another group and does not count");
  assert.strictEqual(higher.intended.same_tier_rows_above, 1);
});

test("validateReport rejects a report missing pointer_age_hours or any of the four queries", () => {
  /* MUTATION: delete the `pointer_age_hours` check from `validateReport`.
     The first stripped report validates clean and this fails. */
  const report = buildReport({
    SearchEngine,
    indexText: "The Daily\t1200361736\t1\t0\nPlanet Money\tplanet-money\t\t1\n",
    catalogClient: { shows: [{ show_id: "planet-money", title: "Planet Money" }] },
    catalog: { shows: [{ show_id: "planet-money", apple_collection_id: 290783428 }] },
    top: {
      topRows: [{ i: 290783428, c: true }, { i: 1200361736, c: false }],
      url: "https://example.test/top.json",
      release_tag: "shows-index-test",
      published_at: "2026-09-15T06:20:47.348Z",
      age_hours: 12.5,
    },
    generatedAt: "2026-10-04T00:00:00.000Z",
  });
  assert.deepStrictEqual(validateReport(report), [], "fixture assumption: a full report is valid");
  assert.strictEqual(report.coverage.pct_breadth, 100);
  assert.strictEqual(report.queries.daily.intended.top_position, 1);

  const noAge = structuredClone(report);
  delete noAge.pointer_age_hours;
  assert.ok(validateReport(noAge).some((e) => e.includes("pointer_age_hours")), "missing pointer_age_hours accepted");

  for (const [q] of PINNED_QUERIES) {
    const noQuery = structuredClone(report);
    delete noQuery.queries[q];
    assert.ok(validateReport(noQuery).some((e) => e.includes(`queries.${q}`)), `missing query "${q}" accepted`);
  }
});

test("a top.json block in plain ascending pi_id order is flagged as carrying no popularity order", () => {
  /* `buildTop` breaks score ties by id, so a block whose scores all tie comes
     out in pi_id order — feed age, not popularity. Measured on the
     2026-09-15 release: the 2,000-row non-curated block has 0 inversions.
     MUTATION: in `blockOrder`, `Number(rows[k - 1].id) > Number(rows[k].id)`
     -> `<`. The ascending block counts 2 inversions and this fails. */
  assert.deepStrictEqual(blockOrder([{ id: 3 }, { id: 5 }, { id: 9 }]),
    { rows: 3, pi_id_inversions: 0, ordered_by_pi_id: true });
  assert.deepStrictEqual(blockOrder([{ id: 9 }, { id: 3 }, { id: 5 }]),
    { rows: 3, pi_id_inversions: 1, ordered_by_pi_id: false });
  assert.strictEqual(blockOrder([{ id: 1 }]).ordered_by_pi_id, false, "one row has no order to judge");
});

test("loadTopRows makes one GET, for top.json alone, with the shared User-Agent", async () => {
  /* The card's budget is ONE release download. `changed.json` on the current
     release is 7 MB and is never needed for this question.
     MUTATION: in `politeFetch`, drop the `{ headers: ... }` argument to
     `fetchImpl`. The User-Agent assertion fails. */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init?.headers?.["User-Agent"] });
    return jsonRes([{ i: 1, c: false }]);
  };
  const top = await loadTopRows({
    pointer: {
      asset_base_url: "https://pkg12-one-get.test/releases/download/tag",
      release_tag: "tag",
      published_at: "2026-09-15T00:00:00.000Z",
    },
    fetchImpl,
    now: Date.parse("2026-09-16T12:00:00.000Z"),
    gate: noSleep,
  });
  assert.deepStrictEqual(calls.map((c) => c.url), ["https://pkg12-one-get.test/releases/download/tag/top.json"]);
  assert.strictEqual(calls[0].ua, UA);
  assert.strictEqual(top.age_hours, 36);
  assert.strictEqual(top.release_tag, "tag");
  assert.deepStrictEqual(top.topRows, [{ i: 1, c: false }]);
});

test("a 503 is retried through the host gate; a 404 is reported, not retried", async () => {
  /* MUTATION: in `politeFetch`, `res.status >= 500` -> `res.status >= 600`.
     The 503 is returned as final, loadTopRows throws, and this fails. */
  let n = 0;
  const flaky = async () => (++n === 1 ? jsonRes(null, 503) : jsonRes([{ i: 7, c: false }]));
  const pointer = { asset_base_url: "https://pkg12-retry.test/x", published_at: "2026-09-15T00:00:00.000Z" };
  const top = await loadTopRows({ pointer, fetchImpl: flaky, gate: noSleep });
  assert.strictEqual(n, 2, "one retry after the 503");
  assert.deepStrictEqual(top.topRows, [{ i: 7, c: false }]);

  let m = 0;
  const missing = async () => { m++; return jsonRes(null, 404); };
  await assert.rejects(
    loadTopRows({ pointer: { ...pointer, asset_base_url: "https://pkg12-404.test/x" }, fetchImpl: missing, gate: noSleep }),
    /HTTP 404/
  );
  assert.strictEqual(m, 1, "a 404 is an answer, not a transient");
});
