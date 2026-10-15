/* RV-07 (docs/roadmap/recommender-v1.md, D4, D12): the stratified gold-set
   sampler. Offline: synthetic candidates in memory, the RV-03 fixtures under
   tools/recommender/fixtures/ for the catalogue path, and temp files for the
   DAI table and the output. No real data file and no network.

   Every test names the one-line mutation that turns it red; each was run. */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources } from "./evidence.mjs";
import { catalogueCandidates, main, sampleBreadthSet, sampleGoldSet, serializeGoldSet } from "./sample.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURE_ENV = {
  RECOMMENDER_CATALOG_PATH: path.join(FIX, "catalog.json"),
  RECOMMENDER_BREADTH_PATH: path.join(FIX, "catalog-breadth.json"),
  RECOMMENDER_CLASSIFICATION_PATH: path.join(FIX, "breadth-classification.json"),
  RECOMMENDER_EPISODE_ARCHIVE_PATH: path.join(FIX, "episode-archive.json.gz"),
  RECOMMENDER_AVAILABILITY_PATH: path.join(FIX, "no-such-transcript-availability.json"),
  RECOMMENDER_RSS_DIR: path.join(FIX, "rss"),
  RECOMMENDER_TRANSCRIPTS_DIR: path.join(FIX, "transcripts", "normalized"),
  RECOMMENDER_DISCOVER_PATH: path.join(FIX, "no-such-discover.json"),
};
// Keyed by apple_collection_id, as data/dai-classification.json is.
const FIXTURE_DAI = { built_at: "2026-10-14T00:00:00.000Z", shows: { 999: { dai: true }, 111: { dai: false } } };

const pad = (n) => String(n).padStart(4, "0");
const cand = (key, root, { tier = "show-metadata", dai = "unknown", chart = "uncharted", length = "unknown" } = {}) => ({
  show_key: key,
  title: `Show ${key}`,
  strata: { root, tier, dai, chart, length },
});
/** n candidates in one root, keys `<root>-0000`... */
const many = (root, n, opts = () => ({})) => Array.from({ length: n }, (_, i) => cand(`${root}-${pad(i)}`, root, opts(i)));
const keysOf = (doc) => doc.shows.map((s) => s.show_key);
const countRoot = (doc, root) => doc.shows.filter((s) => s.strata.root === root).length;
const withRole = (doc, role) => doc.shows.filter((s) => s.roles.includes(role));

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "rv07-sample-"));
}

/* Mutation: `Math.max(FLOOR_BY_MODE[mode], ...)` -> `Math.max(0, ...)` (floor
   0) -- root "b" (5 of 1,007) gets one coverage pick in the pilot, and root
   "b" (40 of 1,040) gets 4 in the gold set, under the floors. */
test("every root with shows gets at least the floor", () => {
  const pilot = sampleGoldSet({ candidates: [...many("a", 1000), ...many("b", 5), ...many("c", 2)], mode: "pilot", size: 30, seed: "floor" });
  assert.equal(pilot.shows.length, 30);
  assert.ok(countRoot(pilot, "b") >= 3, `pilot root b has ${countRoot(pilot, "b")}`);
  assert.equal(countRoot(pilot, "c"), 2, "a root with fewer shows than the floor gives all of them");
  const gold = sampleGoldSet({ candidates: [...many("a", 1000), ...many("b", 40)], mode: "gold", size: 100, seed: "floor" });
  assert.ok(countRoot(gold, "b") >= 15, `gold root b has ${countRoot(gold, "b")}`);
  assert.throws(() => sampleGoldSet({ candidates: [...many("a", 50), ...many("b", 50), ...many("c", 50)], mode: "gold", size: 40, seed: "s" }), /below the strata floors/);
});

/* Mutation: drop `c.strata.tier === "none" ||` from the pool filter -- the
   none-tier rows enter the set (size covers the whole catalogue). */
test("evidence none is excluded", () => {
  const synthetic = sampleGoldSet({ candidates: [...many("a", 10), ...many("n", 10, () => ({ tier: "none" }))], mode: "pilot", size: 300, seed: "none" });
  assert.equal(synthetic.shows.length, 10);
  assert.ok(synthetic.shows.every((s) => s.strata.tier !== "none"));
  assert.ok(!("none" in synthetic.strata_counts.tier));

  // The RV-03 fixture catalogue: breadth show 444 has no evidence at all.
  const candidates = catalogueCandidates(loadSources({ env: FIXTURE_ENV }), { dai: FIXTURE_DAI });
  assert.equal(candidates.find((c) => c.show_key === "444")?.strata.tier, "none", "the fixture still has a none-tier show");
  const doc = sampleGoldSet({ candidates, mode: "pilot", size: 300, seed: "none" });
  assert.ok(!keysOf(doc).includes("444"));
  assert.equal(doc.shows.length, candidates.filter((c) => c.strata.tier !== "none").length);
});

/* Mutation: `eligibleFor` returns true for "holdout" (sample holdout from the
   whole set) -- holdout rows land on retest and isolated rows. */
test("holdout never overlaps retest or isolated", () => {
  const candidates = [...many("a", 120), ...many("b", 60), ...many("c", 20)];
  const doc = sampleGoldSet({ candidates, mode: "gold", size: 100, retest: 30, isolated: 30, holdout: 30, seed: "roles" });
  assert.equal(withRole(doc, "retest").length, 30);
  assert.equal(withRole(doc, "isolated").length, 30);
  assert.equal(withRole(doc, "holdout").length, 30);
  for (const s of withRole(doc, "holdout")) {
    assert.ok(!s.roles.includes("retest") && !s.roles.includes("isolated"), `${s.show_key} has ${s.roles}`);
  }
  // Topped up on extension: the new holdout rows avoid the old retest/isolated rows too.
  const pilot = sampleGoldSet({ candidates, mode: "pilot", size: 40, retest: 15, isolated: 15, seed: "roles-p" });
  const gold = sampleGoldSet({ candidates, mode: "gold", size: 100, retest: 20, holdout: 40, seed: "roles-g", existing: pilot });
  assert.equal(withRole(gold, "holdout").length, 40);
  assert.ok(withRole(gold, "holdout").every((s) => !s.roles.includes("retest") && !s.roles.includes("isolated")));
  assert.throws(() => sampleGoldSet({ candidates, mode: "gold", size: 50, retest: 20, isolated: 20, holdout: 20, seed: "x" }), /exceed the set size/);
});

/* Mutation: `const next = rng(seed)` -> `const next = Math.random` in
   `shuffled` -- two builds with the same seed differ. */
test("the same seed is byte-identical", () => {
  const candidates = [...many("a", 200, (i) => ({ tier: i % 7 === 0 ? "episode-metadata" : "show-metadata", dai: i % 3 ? "unknown" : "true" })), ...many("b", 80, (i) => ({ chart: i % 4 ? "uncharted" : "1-25" }))];
  const args = { candidates, mode: "gold", size: 120, retest: 20, holdout: 20, seed: "same", builtAt: "2026-10-14T00:00:00.000Z" };
  const one = serializeGoldSet(sampleGoldSet(args));
  const two = serializeGoldSet(sampleGoldSet({ ...args, candidates: [...candidates].reverse() }));
  assert.equal(one, two, "same seed, same inputs (in any order) -> same bytes");
  assert.notEqual(serializeGoldSet(sampleGoldSet({ ...args, seed: "other" })), one, "a different seed picks differently");
  assert.ok(one.endsWith("]\n}\n"));
  assert.deepStrictEqual(JSON.parse(one), sampleGoldSet(args));
});

/* Mutation: `const kept = (existing?.shows ?? [])` -> `const kept = ([])`
   (rebuild from scratch) -- the pilot rows and their roles are not all kept. */
test("--extend keeps rows and roles", () => {
  const candidates = [...many("a", 300), ...many("b", 150), ...many("c", 50)];
  const pilot = sampleGoldSet({ candidates, mode: "pilot", size: 30, retest: 6, isolated: 4, seed: "rv-pilot" });
  const gold = sampleGoldSet({ candidates, mode: "gold", size: 90, retest: 20, holdout: 20, seed: "rv-gold", existing: pilot });
  assert.equal(gold.shows.length, 90);
  assert.equal(gold.mode, "gold");
  const byKey = new Map(gold.shows.map((s) => [s.show_key, s]));
  for (const [i, row] of pilot.shows.entries()) {
    assert.equal(gold.shows[i].show_key, row.show_key, "existing rows keep their position");
    const now = byKey.get(row.show_key);
    assert.deepStrictEqual(now.strata, row.strata);
    for (const role of row.roles) assert.ok(now.roles.includes(role), `${row.show_key} lost ${role}`);
    assert.ok(now.roles.includes("gold"), "pilot rows join the gold set");
  }
  assert.equal(withRole(gold, "retest").length, 20);
  assert.equal(withRole(gold, "isolated").length, 4, "isolated is not asked for again and is never dropped");
});

/* Mutation: `shuffled(added, \`${seed}:order\`)` -> `added` (skip the output
   shuffle) -- the 50 rows come back in show_key (catalogue) order. */
test("output order is shuffled, not catalogue order", () => {
  const candidates = many("a", 50);
  const doc = sampleGoldSet({ candidates, mode: "pilot", size: 50, seed: "order" });
  const input = candidates.map((c) => c.show_key);
  assert.deepStrictEqual([...keysOf(doc)].sort(), input, "every show is in the set");
  assert.notDeepStrictEqual(keysOf(doc), input);
});

/* Mutation: `return same ? 0 : 1` -> `return 0` (always 0) -- the edited
   file still passes --check. */
test("--check is 0 after a run and 1 after an edit", () => {
  const dir = tempDir();
  try {
    const daiPath = path.join(dir, "dai.json");
    writeFileSync(daiPath, JSON.stringify(FIXTURE_DAI));
    const env = { ...FIXTURE_ENV, RECOMMENDER_DAI_PATH: daiPath, RECOMMENDER_GOLD_SET_PATH: path.join(dir, "gold-set.json") };
    const quiet = { env, stderr: () => {}, stdout: () => {}, now: () => new Date("2026-10-14T12:00:00Z") };
    const argv = ["--mode", "pilot", "--size", "300", "--retest", "2", "--isolated", "1", "--seed", "rv-test"];
    assert.equal(main(argv, quiet), 0);
    const written = readFileSync(env.RECOMMENDER_GOLD_SET_PATH, "utf8");
    assert.equal(JSON.parse(written).built_at, "2026-10-14T12:00:00.000Z");
    assert.equal(main([...argv, "--check"], quiet), 0);
    // A rerun leaves the file (and its built_at) untouched.
    assert.equal(main(argv, { ...quiet, now: () => new Date("2027-01-01T00:00:00Z") }), 0);
    assert.equal(readFileSync(env.RECOMMENDER_GOLD_SET_PATH, "utf8"), written);
    const edited = JSON.parse(written);
    edited.shows[0].roles = edited.shows[0].roles.includes("retest") ? ["pilot"] : ["pilot", "retest"];
    writeFileSync(env.RECOMMENDER_GOLD_SET_PATH, serializeGoldSet(edited));
    assert.equal(main([...argv, "--check"], quiet), 1);
    assert.equal(main([...argv, "--seed", "other-seed", "--check"], quiet), 1, "different arguments are a different file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Mutation: `coverPicks` returns `[]` at once (skip coverage) -- the single
   DAI-true show and the single chart-top-25 show of each root are missed. */
test("every DAI value and chart band is represented in each root", () => {
  const rare = (i) => (i === 137 ? { dai: "true" } : i === 211 ? { dai: "false", chart: "1-25" } : i === 305 ? { chart: "26-200" } : {});
  const candidates = [...many("a", 400, rare), ...many("b", 400, rare)];
  const doc = sampleGoldSet({ candidates, mode: "pilot", size: 20, seed: "cover" });
  for (const root of ["a", "b"]) {
    const rows = doc.shows.filter((s) => s.strata.root === root);
    assert.deepStrictEqual([...new Set(rows.map((s) => s.strata.dai))].sort(), ["false", "true", "unknown"], `root ${root} dai`);
    assert.deepStrictEqual([...new Set(rows.map((s) => s.strata.chart))].sort(), ["1-25", "26-200", "uncharted"], `root ${root} chart`);
  }
});

/* Mutation: `RICH_SHARE = 1 / 3` -> `RICH_SHARE = 0` -- 20 rich shows of 300
   give about 2 by proportion, under the third (10 of 30). */
test("at least a third of the set has transcript or episode evidence where available", () => {
  const candidates = [...many("a", 200, (i) => ({ tier: i < 12 ? "episode-metadata" : "show-metadata" })), ...many("b", 100, (i) => ({ tier: i < 8 ? "transcript" : "show-metadata" }))];
  const doc = sampleGoldSet({ candidates, mode: "pilot", size: 30, seed: "rich" });
  const rich = doc.shows.filter((s) => s.strata.tier === "transcript" || s.strata.tier === "episode-metadata").length;
  assert.ok(rich >= 10, `rich ${rich}`);
  // Where the catalogue has fewer, all of them.
  const scarce = sampleGoldSet({ candidates: [...many("a", 200), cand("z-1", "a", { tier: "transcript" })], mode: "pilot", size: 30, seed: "rich" });
  assert.ok(keysOf(scarce).includes("z-1"));
});

/* Mutation: `dai?.shows?.[show.acid ?? show.show_key]` ->
   `dai?.shows?.[show.show_key]` -- the curated tx-show (DAI keyed by its Apple
   id 999) reads "unknown". */
test("catalogue strata: root, tier, DAI by Apple id, chart and length bands, curated twins once", () => {
  const candidates = catalogueCandidates(loadSources({ env: FIXTURE_ENV }), { dai: FIXTURE_DAI });
  const by = new Map(candidates.map((c) => [c.show_key, c.strata]));
  assert.ok(!by.has("999") && !by.has("666"), "a curated show's breadth twin is not a second candidate");
  assert.deepStrictEqual(by.get("tx-show"), { root: "science", tier: "transcript", dai: "true", chart: "26-200", length: "31-60" });
  assert.deepStrictEqual(by.get("111"), { root: "history", tier: "episode-metadata", dai: "false", chart: "1-25", length: "31-60" });
  assert.deepStrictEqual(by.get("222"), { root: "history", tier: "episode-metadata", dai: "unknown", chart: "1-25", length: "<=30" });
  assert.equal(by.get("quiz-desk").root, "news", "the root of news/daily");
  assert.equal(by.get("note-only").root, "unlabelled");
  assert.equal(by.get("note-only").length, "unknown");
});

/* RV-33 (orchestrator decision 2026-10-15): --mode breadth, every chart
   top-25 show that is not a gold show. The RV-03 fixture catalogue's 1-25
   shows are 111, 222, 555, 777 and quiz-desk. */
function breadthRun(gold) {
  const dir = tempDir();
  const daiPath = path.join(dir, "dai.json");
  writeFileSync(daiPath, JSON.stringify(FIXTURE_DAI));
  const goldPath = path.join(dir, "gold-set.json");
  if (gold) writeFileSync(goldPath, serializeGoldSet({ version: 1, mode: "gold", seed: "g", built_at: null, strata_counts: {}, shows: gold }));
  const outPath = path.join(dir, "breadth-set.json");
  const env = { ...FIXTURE_ENV, RECOMMENDER_DAI_PATH: daiPath, RECOMMENDER_GOLD_SET_PATH: goldPath, RECOMMENDER_BREADTH_SET_PATH: outPath };
  const errors = [];
  const run = (argv, now = "2026-10-15T12:00:00Z") => main(argv, { env, stderr: (m) => errors.push(m), stdout: () => {}, now: () => new Date(now) });
  return { dir, outPath, errors, run, read: () => JSON.parse(readFileSync(outPath, "utf8")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/* Mutation: `const rows = pool.filter((c) => !excluded.has(c.show_key));` ->
   `const rows = pool;` -- the gold shows 111 (and z-gold) stay in the breadth set. */
test("breadth sampling excludes gold shows", () => {
  const candidates = [cand("z-gold", "a", { chart: "1-25" }), cand("z-new", "a", { chart: "1-25" })];
  const doc = sampleBreadthSet({ candidates, chart: ["1-25"], exclude: ["z-gold"] });
  assert.deepStrictEqual(keysOf(doc), ["z-new"]);
  assert.equal(doc.excluded_gold, 1);

  const w = breadthRun([{ show_key: "111", title: "x", strata: {}, roles: ["pilot", "gold"] }, { show_key: "tx-show", title: "y", strata: {}, roles: ["gold"] }]);
  try {
    assert.equal(w.run(["--mode", "breadth"]), 0, w.errors.join(""));
    const set = w.read();
    assert.deepStrictEqual(keysOf(set), ["222", "555", "777", "quiz-desk"], "every 1-25 fixture show but the gold show 111");
    assert.equal(set.excluded_gold, 1);
    assert.ok(set.shows.every((s) => s.roles.length === 1 && s.roles[0] === "breadth"));
    // Without a readable gold set the breadth set is not built (it would not be disjoint).
    const bare = breadthRun(null);
    try {
      assert.equal(bare.run(["--mode", "breadth"]), 2);
      assert.match(bare.errors.join(""), /gold-set\.json/);
    } finally {
      bare.done();
    }
  } finally {
    w.done();
  }
});

/* Mutation: drop `!bands.includes(c.strata.chart) ||` from the
   sampleBreadthSet filter -- the 26-200 and uncharted rows enter a 1-25 set.
   (Second mutation, also run: delete the chartBands `continue` in
   catalogueCandidates -- the pre-filtered candidates include 333.) */
test("breadth sampling is deterministic and filtered by chart band", () => {
  const candidates = [
    cand("k-3", "a", { chart: "1-25" }),
    cand("k-1", "b", { chart: "1-25", tier: "episode-metadata" }),
    cand("k-2", "a", { chart: "26-200" }),
    cand("k-4", "a", { chart: "uncharted" }),
    cand("k-5", "a", { chart: "1-25", tier: "none" }),
  ];
  const one = serializeGoldSet(sampleBreadthSet({ candidates, chart: ["1-25"], builtAt: "2026-10-15T00:00:00.000Z" }));
  const two = serializeGoldSet(sampleBreadthSet({ candidates: [...candidates].reverse(), chart: ["1-25"], builtAt: "2026-10-15T00:00:00.000Z" }));
  assert.equal(one, two, "input order never changes the bytes");
  assert.deepStrictEqual(JSON.parse(one).shows.map((s) => s.show_key), ["k-1", "k-3"], "1-25 only, none-tier out, show_key order");
  const wider = sampleBreadthSet({ candidates, chart: ["26-200", "1-25"] });
  assert.deepStrictEqual(keysOf(wider), ["k-1", "k-2", "k-3"]);
  assert.deepStrictEqual(wider.chart, ["1-25", "26-200"]);
  assert.throws(() => sampleBreadthSet({ candidates, chart: ["top-10"] }), /chart bands/);

  const pre = catalogueCandidates(loadSources({ env: FIXTURE_ENV }), { dai: FIXTURE_DAI, chartBands: ["1-25"] });
  assert.deepStrictEqual(pre.map((c) => c.show_key), ["111", "222", "555", "777", "quiz-desk"]);

  const w = breadthRun([]);
  try {
    assert.equal(w.run(["--mode", "breadth", "--chart", "1-25"]), 0);
    const written = readFileSync(w.outPath, "utf8");
    assert.equal(JSON.parse(written).built_at, "2026-10-15T12:00:00.000Z");
    assert.equal(w.run(["--mode", "breadth", "--check"]), 0, "--chart defaults to 1-25");
    assert.equal(w.run(["--mode", "breadth"], "2027-01-01T00:00:00Z"), 0);
    assert.equal(readFileSync(w.outPath, "utf8"), written, "a rerun leaves the file and its built_at untouched");
    assert.equal(w.run(["--mode", "breadth", "--chart", "1-25,26-200", "--check"]), 1, "other bands are another file");
    assert.equal(w.run(["--mode", "breadth", "--size", "10"]), 2, "breadth takes no gold sizing");
  } finally {
    w.done();
  }
});
