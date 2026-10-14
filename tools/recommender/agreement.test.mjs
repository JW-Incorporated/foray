/* tools/recommender/agreement.mjs: the agreement statistics every go/no-go in
   docs/roadmap/recommender-v1.md is read from (RV-11) -- Krippendorff's
   alpha, Spearman, Kendall tau-b, test-retest, joint vs isolated, persona
   differentiation, within-node tau, per-batch drift, score compression, and
   the CLI that rewrites a report block.

   Every test names the one-line mutation of agreement.mjs that turns it red;
   each was run red before this suite was committed. Offline: fixtures built
   here, and the CLI tests write only to a fresh temp folder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchDrift,
  beginMarker,
  endMarker,
  jointVsIsolated,
  kendallTau,
  krippendorffAlpha,
  loadResults,
  main,
  pearson,
  personaDifferentiation,
  scoreDistribution,
  spearman,
  testRetest,
  withinNodeTau,
} from "./agreement.mjs";
import { validateRatingsFile } from "./schema.mjs";

const r3 = (x) => Number(x.toFixed(3));

/* ---------- fixture builders (the RV-02 shapes) ---------- */

const FLAGS = { explicit: false, harassment: false, medical_financial_advice: false, injection_suspected: false };

/** A ratings.json document from `{ show_key: { persona_id: fit } }`: valid
    against schema.mjs, every other slot fixed. */
function ratingsDoc(table, { merged = [] } = {}) {
  const shows = {};
  for (const [key, row] of Object.entries(table)) {
    const personas = {};
    for (const [pid, fit] of Object.entries(row)) personas[pid] = [fit, 0.5, 3, 3, 3, 3, null, null, null, 0.4];
    const top = Object.keys(row).sort().reduce((best, pid) => (best === null || row[pid] > row[best] ? pid : best), null);
    shows[key] = {
      evidence_tier: "show-metadata",
      summary: "A weekly conversation about how things work.",
      format: "interview",
      flags: { ...FLAGS },
      top_reason: "Clear explanations of how ordinary machines work.",
      top_persona: top,
      passes: 1,
      personas,
    };
  }
  return { version: 1, rubric_version: 1, built_at: "2026-10-14T00:00:00.000Z", merged_batches: merged, shows };
}

/** A results file (joint unless `mode` says otherwise) from
    `{ show_key: { persona_id: [fit, return_prob] } }`. Only the fields the
    statistics read are filled; the CLI never validates results files. */
function resultsDoc({ batch_id, pass, mode = "joint", rated_at = "2026-10-14T00:00:00.000Z", shows }) {
  const results = {};
  for (const [key, row] of Object.entries(shows)) {
    const personas = {};
    for (const [pid, [fit, rp]] of Object.entries(row)) personas[pid] = { fit, return_prob: rp };
    results[key] = { evidence_tier: "show-metadata", personas };
  }
  return { batch_id, rubric_version: 1, model: "fixture", mode, pass, rated_at, results };
}

/* The canonical worked example of Krippendorff (2011), "Computing
   Krippendorff's Alpha-Reliability": 4 observers x 12 units, values 1-5,
   null = missing. Published: nominal 0.743, ordinal 0.815, interval 0.849. */
const K2011 = (() => {
  const _ = null;
  const A = [1, 2, 3, 3, 2, 1, 4, 1, 2, _, _, _];
  const B = [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, _, 3];
  const C = [_, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, _];
  const D = [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, _];
  return A.map((__, i) => [A[i], B[i], C[i], D[i]]);
})();

/* ---------- the statistics ---------- */

test("krippendorff alpha reproduces the published nominal example", () => {
  /* MUTATION (run red): `return 1 - (n * observed) / expected` (drop the
     n-1 expected-disagreement correction) -- nominal reads 0.737. */
  assert.equal(r3(krippendorffAlpha(K2011, { metric: "nominal" })), 0.743);
  assert.equal(r3(krippendorffAlpha(K2011, { metric: "ordinal" })), 0.815);
  assert.equal(r3(krippendorffAlpha(K2011, { metric: "interval" })), 0.849);
  // Unit 12 has one value and is not pairable; dropping it changes nothing.
  assert.equal(krippendorffAlpha(K2011.slice(0, 11), { metric: "nominal" }), krippendorffAlpha(K2011, { metric: "nominal" }));
  assert.equal(krippendorffAlpha([[3, 3], [3, 3]]), null, "no expected disagreement -> null, not NaN");
});

test("interval alpha differs from nominal on an ordered fixture", () => {
  /* MUTATION (run red): `if (metric === "nominal" || true) return 1` in
     delta2 (metric ignored) -- interval reads the nominal value. Raters
     who miss by one point agree well on an interval scale and not at all
     on a nominal one. Hand: 16 values, counts {1:3, 2:4, 3:2, 4:4, 5:3},
     mean 3; observed = 4 disagreeing units x 2 ordered pairs x 1 = 8;
     expected = 2 * 16 * sum n_c (c - 3)^2 = 32 * 32 = 1024;
     alpha = 1 - 15 * 8 / 1024 = 0.883. */
  const units = [[1, 2], [2, 3], [3, 4], [4, 5], [1, 1], [5, 5], [2, 2], [4, 4]];
  const nominal = krippendorffAlpha(units, { metric: "nominal" });
  const interval = krippendorffAlpha(units, { metric: "interval" });
  assert.ok(nominal < 0.5, `nominal ${nominal}`);
  assert.ok(interval > 0.85, `interval ${interval}`);
  assert.equal(r3(interval), 0.883);
});

test("spearman on a hand-computed fixture", () => {
  /* MUTATION (run red): `return pearson(xs, ys)` in spearman (raw values,
     not ranks) -- the outlier 100 drags it to 0.676.
     Hand: ranks of a are 1..6, d = [0,-1,1,-1,1,0], sum d^2 = 4,
     rho = 1 - 6*4 / (6*35) = 0.886. With ties, average ranks
     a = [1,2.5,2.5,4,5,6], b = [1.5,1.5,3,4,6,5]: 15.25 / 17 = 0.897. */
  assert.equal(r3(spearman([1, 2, 3, 4, 5, 100], [1, 3, 2, 5, 4, 6])), 0.886);
  assert.equal(r3(spearman([1, 2, 2, 3, 4, 5], [1, 1, 2, 3, 5, 4])), 0.897);
  assert.equal(r3(pearson([1, 2, 3, 4, 5, 100], [1, 3, 2, 5, 4, 6])), 0.676);
  assert.equal(spearman([1, null], [2, 5]), null, "one pair after dropping the null is not a correlation");
});

test("kendall tau-b handles ties", () => {
  /* MUTATION (run red): `const denom = n0` (tau-a) -- 11/15 = 0.733.
     Hand: 15 pairs, one tie in a (2,2), one in b (1,1), 12 concordant,
     1 discordant: tau-b = 11 / sqrt(14 * 14) = 0.786. */
  assert.equal(r3(kendallTau([1, 2, 2, 3, 4, 5], [1, 1, 2, 3, 5, 4])), 0.786);
  assert.equal(kendallTau([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]), -1);
  assert.equal(kendallTau([2, 2, 2], [1, 2, 3]), null, "a constant side has no tau-b");
});

test("testRetest reports the top-persona change fraction", () => {
  /* MUTATION (run red): `topPersona(byShow[key][passes[0]])` inside the
     `later` map (compare pass 1 to itself) -- no change is ever seen and the
     fraction reads 0. */
  const p1 = resultsDoc({
    batch_id: "b1",
    pass: 1,
    shows: { s1: { a: [5, 0.9], b: [3, 0.5] }, s2: { a: [2, 0.2], b: [4, 0.6] }, s3: { a: [4, 0.7], b: [4, 0.5] }, s4: { a: [1, 0.1], b: [2, 0.2] } },
  });
  const p2 = resultsDoc({
    batch_id: "b2",
    pass: 2,
    // s1 flips top from a to b; s3 ties on fit, return_prob keeps a on top.
    shows: { s1: { a: [3, 0.5], b: [4, 0.6] }, s2: { a: [2, 0.2], b: [5, 0.8] }, s3: { a: [4, 0.6], b: [4, 0.5] } },
  });
  // An isolated pass is a different design, never a retest.
  const iso = resultsDoc({ batch_id: "b3", pass: 2, mode: "isolated:a", shows: { s4: { a: [5, 0.9] } } });
  const tr = testRetest([p1, p2, iso]);
  assert.equal(tr.shows, 3, "s4 has one joint pass and is not a retest");
  assert.equal(tr.top_persona_changed, 1);
  assert.equal(r3(tr.top_persona_change_fraction), 0.333);
  assert.deepEqual(Object.keys(tr.per_persona), ["a", "b"]);
  assert.equal(tr.per_persona.a.units, 3);
  assert.equal(r3(tr.overall), r3(krippendorffAlpha([[5, 3], [2, 2], [4, 4], [3, 4], [4, 5], [4, 4]], { metric: "interval" })));
});

test("jointVsIsolated per-persona spearman", () => {
  /* MUTATION (run red): compute `rho` over every persona's (joint, isolated)
     pairs pooled and report it for each -- a and b read the same value. */
  const joint = ratingsDoc({ s1: { a: 1, b: 5 }, s2: { a: 2, b: 4 }, s3: { a: 3, b: 3 }, s4: { a: 4, b: 2 }, s5: { a: 5, b: 1 } });
  const isolated = ratingsDoc({ s1: { a: 1, b: 1 }, s2: { a: 2, b: 2 }, s3: { a: 3, b: 3 }, s4: { a: 4, b: 4 }, s5: { a: 5, b: 5 } });
  const jv = jointVsIsolated(joint, isolated);
  assert.equal(jv.per_persona.a.spearman, 1);
  assert.equal(jv.per_persona.b.spearman, -1);
  assert.equal(jv.per_persona.a.n, 5);
  assert.deepEqual(jv.below, ["b"]);
  assert.equal(jv.threshold, 0.9);
});

test("differentiation flags correlated pairs and never-top personas", () => {
  /* MUTATION (run red): `flagged: r !== null && r >= 1.0` (threshold 1.0)
     -- the r = 0.9 pair is no longer flagged.
     MUTATION (run red): `flagged: share < 0` -- the never-top persona c is
     not flagged. */
  const table = {
    s1: { a: 5, b: 5, c: 1 },
    s2: { a: 4, b: 4, c: 2 },
    s3: { a: 3, b: 3, c: 2 },
    s4: { a: 2, b: 1, c: 1 },
    s5: { a: 1, b: 2, c: 1 },
    s6: { a: 3, b: 3, c: 2 },
  };
  const d = personaDifferentiation(ratingsDoc(table));
  const ab = d.pairs.find((p) => p.a === "a" && p.b === "b");
  assert.equal(r3(ab.r), 0.9, "hand: 9 / sqrt(10 * 10)");
  assert.deepEqual(d.correlated, [["a", "b"]]);
  assert.equal(d.top_share.c.shows, 0);
  assert.deepEqual(d.rarely_top, ["c"]);
  assert.ok(d.variance.ratio > 0, "the variance ratio is reported");
  // One listener copied 13 times has no within-show disagreement at all.
  const clones = personaDifferentiation(ratingsDoc({ s1: { a: 1, b: 1 }, s2: { a: 5, b: 5 } }));
  assert.equal(clones.variance.ratio, 0);
});

test("withinNodeTau averages tau inside each root node only", () => {
  /* MUTATION (run red): `const node = "all"` (ignore nodeOf, pool every
     show) -- the pooled tau over both nodes is not 0. */
  const teacher = ratingsDoc({ x1: { a: 1 }, x2: { a: 2 }, x3: { a: 3 }, y1: { a: 4 }, y2: { a: 5 }, y3: { a: 5 } });
  const predicted = { x1: { a: 1 }, x2: { a: 2 }, x3: { a: 3 }, y1: { a: 3.4 }, y2: { a: 3.0 }, y3: { a: 3.0 }, z1: { a: 2 } };
  const nodeOf = { x1: "X", x2: "X", x3: "X", y1: "Y", y2: "Y", y3: "Y" };
  const w = withinNodeTau(teacher, nodeOf, predicted);
  assert.equal(w.per_node.X.mean, 1);
  assert.equal(w.per_node.Y.mean, -1);
  assert.equal(w.mean, 0);
  assert.equal(w.groups, 2);
  assert.equal(withinNodeTau(teacher, (k) => (k.startsWith("x") ? "X" : null), predicted).groups, 1, "a function nodeOf; a show without a node is left out");
});

test("batchDrift flags a 0.5 deviation", () => {
  /* MUTATION (run red): `flagged: Math.abs(deviation) > 10` (threshold 10)
     -- the batch 0.5 above the mean goes unflagged. */
  const ratings = ratingsDoc({ s1: { a: 2.5, b: 3 }, s2: { a: 3, b: 2.5 }, s3: { a: 3.5, b: 3.5 } });
  const dr = batchDrift(ratings, { s1: "b1", s2: "b2", s3: "b3" });
  assert.equal(dr.overall_mean, 3);
  assert.equal(dr.per_batch.b3.deviation, 0.5);
  assert.equal(dr.per_batch.b1.deviation, -0.25);
  assert.deepEqual(dr.flagged, ["b3"], "-0.25 is inside D13's 0.3");
  assert.equal(dr.max_abs_deviation, 0.5);
  assert.equal(dr.threshold, 0.3);
});

test("scoreDistribution flags a persona with over 60% of its mass on one value", () => {
  /* MUTATION (run red): `compressed: modal_share > 1` -- the persona rating
     7 of 10 shows a 3 is not flagged. */
  const table = {};
  const aFits = [3, 3, 3, 3, 3, 3, 3, 1, 4, 5];
  const bFits = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
  aFits.forEach((f, i) => (table[`s${i}`] = { a: f, b: bFits[i] }));
  table.s0.c = 2.6; // pass means round to the anchors
  const d = scoreDistribution(ratingsDoc(table));
  assert.deepEqual(d.per_persona.a.hist, { 1: 1, 2: 0, 3: 7, 4: 1, 5: 1 });
  assert.equal(d.per_persona.a.modal_share, 0.7);
  assert.deepEqual(d.per_persona.c.hist, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 });
  assert.deepEqual(d.compressed, ["a", "c"]);
});

/* ---------- the CLI ---------- */

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "rv11-agreement-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const quiet = { log: () => {}, error: () => {} };

test("loadResults reads only the batches ratings.json lists as merged", (t) => {
  /* MUTATION (run red): drop `if (merged && !merged.has(doc.batch_id)) continue`
     -- a never-merged results file renamed onto a merged id (b4 below holds
     batch b2) counts toward test-retest. */
  const dir = scratch(t);
  writeFileSync(join(dir, "rating-results-b1.json"), JSON.stringify(resultsDoc({ batch_id: "b1", pass: 1, shows: { s1: { a: [3, 0.5] } } })));
  writeFileSync(join(dir, "rating-results-b2.json"), JSON.stringify(resultsDoc({ batch_id: "b2", pass: 2, shows: { s1: { a: [4, 0.5] } } })));
  writeFileSync(join(dir, "notes.json"), "{}");
  /* MUTATION (run red): drop the by-name `if (merged && !merged.has(m[1])) continue`
     -- a refused, truncated (unparseable) results file crashes the report. */
  writeFileSync(join(dir, "rating-results-b3.json"), '{"batch_id": "b3", "shows": {');
  writeFileSync(join(dir, "rating-results-b4.json"), JSON.stringify(resultsDoc({ batch_id: "b2", pass: 2, shows: { s1: { a: [5, 0.5] } } })));
  const docs = loadResults(dir, ratingsDoc({ s1: { a: 3 } }, { merged: ["b1", "b4"] }));
  assert.deepEqual(docs.map((d) => d.batch_id), ["b1"]);
  /* MUTATION (run red): read only ratings.json's ledger -- an isolated batch,
     which RV-09 records in ratings-isolated.json's merged_batches, is dropped. */
  writeFileSync(join(dir, "rating-results-b5.json"), JSON.stringify(resultsDoc({ batch_id: "b5", pass: 1, mode: "isolated:a", shows: { s1: { a: [3, 0.5] } } })));
  const withIso = loadResults(dir, ratingsDoc({ s1: { a: 3 } }, { merged: ["b1"] }), ratingsDoc({ s1: { a: 3 } }, { merged: ["b5"] }));
  assert.deepEqual(withIso.map((d) => d.batch_id), ["b1", "b5"]);
  assert.equal(loadResults(join(dir, "absent"), {}), null);
});

test("the report block is rewritten and --check sees staleness", (t) => {
  /* MUTATION (run red): `if (args.check) { ...; return 0; }` on both
     branches (always exit 0) -- a stale block passes the check. */
  const dir = scratch(t);
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir);
  const table = { s1: { a: 5, b: 2 }, s2: { a: 3, b: 4 }, s3: { a: 1, b: 1 } };
  const ratings = ratingsDoc(table, { merged: ["b1", "b2"] });
  assert.deepEqual(validateRatingsFile(ratings), [], "the fixture is a valid ratings.json");
  writeFileSync(join(dir, "ratings.json"), JSON.stringify(ratings));
  writeFileSync(join(dir, "ratings-isolated.json"), JSON.stringify(ratingsDoc({ s1: { a: 4 }, s2: { a: 3 }, s3: { a: 2 } })));
  writeFileSync(join(resultsDir, "rating-results-b1.json"), JSON.stringify(resultsDoc({ batch_id: "b1", pass: 1, shows: { s1: { a: [5, 0.9], b: [2, 0.2] }, s2: { a: [3, 0.4], b: [4, 0.6] } } })));
  writeFileSync(join(resultsDir, "rating-results-b2.json"), JSON.stringify(resultsDoc({ batch_id: "b2", pass: 2, shows: { s1: { a: [4, 0.8], b: [2, 0.2] }, s3: { a: [1, 0.1], b: [1, 0.1] } } })));
  const report = join(dir, "report.md");
  writeFileSync(report, "# Pilot report\n\nProse the orchestrator wrote.\n\n<!-- BEGIN agreement:pilot -->\nold\n<!-- END agreement:pilot -->\n\nMore prose.\n");
  const argv = ["--ratings", "ratings.json", "--isolated", "ratings-isolated.json", "--results", "results", "--out", "report.md", "--block", "pilot"];

  assert.equal(main([...argv, "--check"], { root: dir, ...quiet }), 1, "the placeholder block is stale");
  assert.equal(main(argv, { root: dir, ...quiet }), 0);
  const text = readFileSync(report, "utf8");
  assert.ok(text.startsWith("# Pilot report\n\nProse the orchestrator wrote.\n\n<!-- BEGIN agreement:pilot -->\n"), "prose before the block is kept");
  assert.ok(text.endsWith("<!-- END agreement:pilot -->\n\nMore prose.\n"), "prose after the block is kept");
  assert.ok(!text.includes("\nold\n"));
  assert.match(text, /\| a \| 3 \| 1 \| 0 \| 1 \| 0 \| 1 \|/, "the score histogram row");
  assert.match(text, /shows rated in two or more passes: 1/);
  assert.match(text, /\| b1 \| 2 \|/, "s1 and s2 first rated in b1");
  assert.equal(main([...argv, "--check"], { root: dir, ...quiet }), 0, "a fresh block is current");
  assert.equal(main(argv, { root: dir, ...quiet }), 0);
  assert.equal(readFileSync(report, "utf8"), text, "a rerun on the same inputs is byte-identical");

  table.s3.b = 5;
  writeFileSync(join(dir, "ratings.json"), JSON.stringify(ratingsDoc(table, { merged: ["b1", "b2"] })));
  assert.equal(main([...argv, "--check"], { root: dir, ...quiet }), 1, "new ratings make the block stale");

  // A report that does not exist yet is created with the block; --check on a
  // missing report is stale.
  const fresh = ["--ratings", "ratings.json", "--no-results", "--out", "new/report.md", "--block", "gold"];
  assert.equal(main([...fresh, "--check"], { root: dir, ...quiet }), 1);
  assert.equal(main(fresh, { root: dir, ...quiet }), 0);
  const created = readFileSync(join(dir, "new", "report.md"), "utf8");
  assert.ok(created.includes(beginMarker("gold")) && created.includes(endMarker("gold")));
  assert.match(created, /no per-pass results files were read/);
});

test("the CLI refuses an invalid ratings file and a bad argument list", (t) => {
  /* MUTATION (run red): skip the validateRatingsFile loop -- a ratings file
     with a fit of 9 is reported on as if it were real. */
  const dir = scratch(t);
  const bad = ratingsDoc({ s1: { a: 3 } });
  bad.shows.s1.personas.a[0] = 9;
  writeFileSync(join(dir, "ratings.json"), JSON.stringify(bad));
  const errors = [];
  const code = main(["--ratings", "ratings.json", "--no-results", "--out", "r.md", "--block", "pilot"], { root: dir, log: () => {}, error: (m) => errors.push(m) });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /bad_score/);
  assert.equal(main(["--ratings", "ratings.json", "--out", "r.md"], { root: dir, ...quiet }), 2, "--block is required");
  assert.equal(main(["--ratings", "ratings.json", "--out", "r.md", "--block", "pilot", "--bogus"], { root: dir, ...quiet }), 2);
});
