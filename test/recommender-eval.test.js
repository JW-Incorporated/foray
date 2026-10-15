/* RV-21 (docs/roadmap/recommender-v1.md, D2/D7/D12; issue #1380): the offline
 * eval of the persona-rating prior, tools/recommender/eval.mjs, which writes
 * the generated block of docs/research/persona-ratings-eval-2026-10.md.
 *
 * WHAT THIS PROVES
 *  1. The scorer's arithmetic on hand-worked fixtures: archetype precision and
 *     its three baselines, the leave-one-out node-modal persona, persona-vector
 *     recall@6, the chart Spearman over charted shows only, and the skew
 *     shares against hand-computed base rates.
 *  2. The archetype map covers every `archetype_fit` value in data/catalog.json
 *     and names only real rating personas.
 *  3. The committed report's generated block is what the eval produces from
 *     the committed inputs (a PR that changes data/recommender/ratings.json
 *     reruns node tools/recommender/eval.mjs).
 *
 * NO FLOORS on the eval numbers (the card): they are a first measurement on the
 * 299-show pilot; raise floors in the PR that earns them, as the similar-shows
 * note says.
 *
 * Every test names the mutation that kills it (CLAUDE.md: a green test is not
 * evidence until you have broken it). Each was run red on 2026-10-14.
 *
 * Harness: no app boot, no network. The tool module is ESM, imported
 * dynamically. */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const EVAL = "tools/recommender/eval.mjs";
const load = () => import(pathToFileURL(path.join(ROOT, EVAL)).href);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const PERSONAS = ["a", "b", "c", "d"];

test("archetype precision on a hand-worked fixture", async () => {
  /* Map: x -> {a, b}, y -> {c}, stretch -> {}. Four scored shows plus one
     stretch-only show:
       s1 [x]          top a  -> hit;  random 2/4
       s2 [x]          top c  -> miss; random 2/4
       s3 [y]          top c  -> hit;  random 1/4
       s4 [x, y]       top d  -> miss; random 3/4 (union {a, b, c})
       s5 [stretch]    top b  -> not scored, reported under stretchOnly
     precision 2/4 = 0.5; random mean (0.5 + 0.5 + 0.25 + 0.75) / 4 = 0.5.
     Node modal (given): s1 b (hit), s2 d (miss), s3 a (miss), s4 c (hit) -> 0.5.
     Affinity by root: r1 -> a, r2 -> d. s1 r1 (hit), s2 r1 (hit), s3 r2 (miss),
     s4 r2 (miss) -> 0.5. Per value: x has s1, s2, s4 -> 1 hit of 3; y has s3,
     s4 -> 1 hit of 2.
     MUTATION (run): in archetypeAgreement's `add`, count every show as a hit
     (`acc.hits += 1` without the `mapped.has` check) -> red (4 != 2). */
  const { archetypeAgreement } = await load();
  const map = { x: ["a", "b"], y: ["c"], stretch: [] };
  const shows = [
    { show_key: "s1", archetypes: ["x"], top_persona: "a", root: "r1" },
    { show_key: "s2", archetypes: ["x"], top_persona: "c", root: "r1" },
    { show_key: "s3", archetypes: ["y"], top_persona: "c", root: "r2" },
    { show_key: "s4", archetypes: ["x", "y"], top_persona: "d", root: "r2" },
    { show_key: "s5", archetypes: ["stretch"], top_persona: "b", root: "r2" },
  ];
  const r = archetypeAgreement(shows, {
    personaIds: PERSONAS,
    map,
    nodeModal: { s1: "b", s2: "d", s3: "a", s4: "c" },
    affinityOf: (root) => ({ r1: "a", r2: "d" })[root],
  });
  assert.strictEqual(r.all.n, 4);
  assert.strictEqual(r.all.hits, 2);
  assert.strictEqual(r.all.precision, 0.5);
  assert.strictEqual(r.all.random, 0.5);
  assert.strictEqual(r.all.nodeModal, 0.5);
  assert.strictEqual(r.all.affinity, 0.5);
  assert.deepStrictEqual([r.byArchetype.x.n, r.byArchetype.x.hits], [3, 1]);
  assert.deepStrictEqual([r.byArchetype.y.n, r.byArchetype.y.hits], [2, 1]);
  assert.deepStrictEqual(r.stretchOnly, { n: 1, top: { b: 1 } });
});

test("the node-modal baseline is leave-one-out and the affinity baseline reads only the root", async () => {
  /* Root r1 holds s1 (top a), s2 (top a), s3 (top b). Leave-one-out: s1 sees
     [a, b] -> tie, lower id a; s3 sees [a, a] -> a. Root r2 holds only s4: no
     other show, so null (never its own top persona).
     MUTATION (run): drop the `o.show_key !== r.show_key` filter in
     nodeModalPersona -> red (s4 would be its own modal persona, b).
     Affinity: the highest positive weight for the root, ties to the lower id;
     a root nobody names is null. */
  const { nodeModalPersona, affinityPersona } = await load();
  const m = nodeModalPersona([
    { show_key: "s1", root: "r1", top_persona: "a" },
    { show_key: "s2", root: "r1", top_persona: "a" },
    { show_key: "s3", root: "r1", top_persona: "b" },
    { show_key: "s4", root: "r2", top_persona: "b" },
  ]);
  assert.deepStrictEqual(m, { s1: "a", s2: "a", s3: "a", s4: null });
  const profiles = [
    { id: "b", taxonomy_affinity: [{ node_id: "r1", weight: 0.9 }] },
    { id: "a", taxonomy_affinity: [{ node_id: "r1", weight: 0.9 }, { node_id: "r2", weight: -0.3 }] },
  ];
  assert.strictEqual(affinityPersona("r1", profiles), "a");
  assert.strictEqual(affinityPersona("r2", profiles), null);
});

test("the archetype map covers every value in catalog.json and names only rating personas", async () => {
  /* MUTATION (run): delete the `documentary` entry from ARCHETYPE_PERSONAS
     -> red (12 curated shows carry it). */
  const { ARCHETYPE_PERSONAS } = await load();
  const values = new Set(readJson("data/catalog.json").shows.flatMap((s) => s.archetype_fit || []));
  assert.ok(values.size >= 5, `only ${values.size} archetype values in the catalogue`);
  const unmapped = [...values].filter((v) => !Object.prototype.hasOwnProperty.call(ARCHETYPE_PERSONAS, v)).sort();
  assert.deepStrictEqual(unmapped, [], "archetype_fit values with no entry in ARCHETYPE_PERSONAS");
  const ids = new Set(readJson("data/recommender/persona-profiles.json").personas.map((p) => p.id));
  for (const [a, personas] of Object.entries(ARCHETYPE_PERSONAS)) {
    for (const p of personas) assert.ok(ids.has(p), `${a} maps to ${p}, which is not a rating persona`);
  }
  assert.deepStrictEqual([...ARCHETYPE_PERSONAS.stretch], [], "stretch names no persona (reported separately)");
});

test("persona-vector recall@6 on a fixture seed", async () => {
  /* Fit vectors over 2 personas, shifted so 1 -> 0. Seed s = [5, 1] -> [4, 0].
     Neighbours by cosine: n1..n6 = [4, 0]..[4, 0] scaled (cosine 1), t1 [1, 1]
     (0.707), z [1, 1] -> zero vector is no one's neighbour.
     Expected [n1, n2, n3, n4, n5, n6, t1] -> recall@6 = 6 / min(7, 6) = 1;
     must_not [t1] is the 7th and never shown at k = 6.
     MUTATION (run): in similarAgreement, `rank(e.seed).slice(0, 1)` instead
     of `.slice(0, k)` -> red (recall 1/6). */
  const { fitVector, personaNeighbours, similarAgreement } = await load();
  const pids = ["p", "q"];
  const rows = {
    s: { p: [5], q: [1] },
    n1: { p: [5], q: [1] },
    n2: { p: [4], q: [1] },
    n3: { p: [3], q: [1] },
    n4: { p: [2], q: [1] },
    n5: { p: [5], q: [1] },
    n6: { p: [4], q: [1] },
    t1: { p: [2], q: [2] },
    z: { p: [1], q: [1] },
  };
  const vectors = new Map(Object.entries(rows).map(([k, v]) => [k, fitVector(v, pids)]));
  assert.deepStrictEqual(vectors.get("s"), [4, 0]);
  assert.deepStrictEqual(personaNeighbours("z", vectors), [], "a zero vector has no neighbours");
  assert.ok(!personaNeighbours("t1", vectors, 20).includes("z"), "a zero vector is no one's neighbour");
  const evalSet = { k: 6, seeds: [{ seed: "s", expected: ["n1", "n2", "n3", "n4", "n5", "n6", "t1"], must_not: ["t1"] }] };
  const r = similarAgreement(evalSet, (seed) => personaNeighbours(seed, vectors, 6));
  assert.strictEqual(r.rows[0].recall, 1);
  assert.strictEqual(r.precision, 1);
  assert.strictEqual(r.violations, 0);
  /* The reachable view cuts the judged lists to the pool and skips seeds
     outside it. */
  const pool = new Set(["s", "n1", "n2"]);
  const reach = similarAgreement(evalSet, () => ["n1", "x", "n2"], { pool });
  assert.strictEqual(reach.seeds, 1);
  assert.strictEqual(reach.rows[0].recall, 1, "expected cut to [n1, n2], both shown");
});

test("the chart baseline correlates rank with fit over charted shows only", async () => {
  /* Charted ranks 1, 2, 3, 4 with fits 4, 3, 2, 1: rho = -1 (better rank,
     higher fit). Two uncharted shows (null, 250) with fit 5 are excluded; if
     they were ranked at 0 or kept at 250 the correlation would move.
     MUTATION (run): drop the `chart_rank <= 200` bound -> red (n 5, rho 0). */
  const { chartBaseline } = await load();
  const shows = [
    { chart_rank: 1, fits: { a: 4 } },
    { chart_rank: 2, fits: { a: 3 } },
    { chart_rank: 3, fits: { a: 2 } },
    { chart_rank: 4, fits: { a: 1 } },
    { chart_rank: null, fits: { a: 5 } },
    { chart_rank: 250, fits: { a: 5 } },
  ];
  const r = chartBaseline(shows, ["a"]);
  assert.strictEqual(r.charted, 4);
  assert.strictEqual(r.per.a.n, 4);
  assert.strictEqual(r.per.a.rho, -1);
  assert.strictEqual(r.mean.rho, -1);
});

test("skew shares equal hand-computed base rates on a fixture", async () => {
  /* Six rated shows; persona a's top 3 by fit (then return_prob, then key):
     k1 (5), k2 (4, rp 0.9), k3 (4, rp 0.5).
       top-3: DAI true k1, false k2, unknown k3 -> 1 of 2 classified = 0.5;
              chart top-25 k1, k3 -> 2/3; explicit k2 -> 1/3; transcript k1 -> 1/3;
              roots r1 2/3, r2 1/3; lowest fit 4.
       rated set (6): DAI true 2 of 4 classified = 0.5; chart top-25 3/6;
              explicit 1/6; transcript 1/6.
       catalogue (4 rows, no tier; explicit only on the two curated rows,
              true and false): DAI 1 of 1; chart 1/4; explicit 1 of 2 known
              = 0.5 (not 1/4: breadth rows carry no flag); transcript null.
     MUTATION (run): in shareProfile divide the DAI count by `n` instead of
     `daiKnown` -> red (1/3 != 0.5).
     MUTATION (run): in shareProfile divide the explicit count by `n` instead
     of `explicitKnown` -> red (0.25 != 0.5).
     catalogueAttrs reads Apple's `explicit` from catalog.json only when it is
     a boolean, and never from a breadth row (the harvest's flag is false
     everywhere).
     MUTATION (run): in catalogueAttrs set `explicit: c.explicit === true`
     on every curated row -> red (the null show gets false). */
  const { skewAudit, catalogueAttrs } = await load();
  const row = (key, fit, rp, attrs) => ({ show_key: key, personas: { a: [fit, rp] }, attrs });
  const rated = [
    row("k1", 5, 0.1, { dai: "true", chart: "1-25", explicit: false, tier: "transcript", root: "r1" }),
    row("k2", 4, 0.9, { dai: "false", chart: "26-200", explicit: true, tier: "show-metadata", root: "r1" }),
    row("k3", 4, 0.5, { dai: "unknown", chart: "1-25", explicit: false, tier: "show-metadata", root: "r2" }),
    row("k4", 2, 0.9, { dai: "true", chart: "1-25", explicit: false, tier: "show-metadata", root: "r2" }),
    row("k5", 1, 0.9, { dai: "false", chart: "uncharted", explicit: false, tier: "show-metadata", root: "r3" }),
    row("k6", 1, 0.9, { dai: "unknown", chart: "uncharted", explicit: false, tier: "show-metadata", root: "r3" }),
  ];
  const catalogue = [
    { dai: "true", chart: "1-25", root: "r1", explicit: true },
    { dai: "unknown", chart: "uncharted", root: "r1", explicit: false },
    { dai: "unknown", chart: "uncharted", root: "r2" },
    { dai: "unknown", chart: "26-200", root: "r3" },
  ];
  const s = skewAudit(rated, catalogue, ["a"], { n: 3 });
  const top = s.per.a;
  assert.strictEqual(top.n, 3);
  assert.strictEqual(top.daiKnown, 2);
  assert.strictEqual(top.dai, 0.5);
  assert.strictEqual(top.chartTop25, 2 / 3);
  assert.strictEqual(top.explicit, 1 / 3);
  assert.strictEqual(top.transcript, 1 / 3);
  assert.deepStrictEqual(top.roots, { r1: 2 / 3, r2: 1 / 3 });
  assert.strictEqual(top.minFit, 4);
  assert.strictEqual(s.rated.dai, 0.5);
  assert.strictEqual(s.rated.chartTop25, 0.5);
  assert.strictEqual(s.rated.explicit, 1 / 6);
  assert.strictEqual(s.rated.explicitKnown, 6);
  assert.strictEqual(s.catalogue.explicitKnown, 2);
  assert.strictEqual(s.catalogue.explicit, 0.5);
  assert.strictEqual(s.catalogue.dai, 1);
  assert.strictEqual(s.catalogue.chartTop25, 0.25);
  assert.strictEqual(s.catalogue.transcript, null);
  const attrs = catalogueAttrs(
    {
      shows: [
        { show_id: "c1", apple_collection_id: 11, explicit: true, taxonomy_node_ids: ["r1"] },
        { show_id: "c2", apple_collection_id: 12, explicit: null, taxonomy_node_ids: ["r1"] },
      ],
    },
    { shows: [{ apple_collection_id: 11, explicit: false, chart_rank: 3 }, { apple_collection_id: 13, explicit: false, chart_rank: 9 }] },
    { shows: {} }
  );
  assert.deepStrictEqual(
    [...attrs].map(([k, a]) => [k, a.explicit, a.curated]),
    [["c1", true, true], ["c2", undefined, true], ["13", undefined, false]]
  );
});

test("the committed report block is current", async () => {
  /* Reads the committed ratings, profiles, catalogues, DAI file and eval set,
     re-renders the block and compares. A PR that changes any of them reruns
     node tools/recommender/eval.mjs.
     MUTATION (run): change `0.429` to `0.430` in the report's archetype table
     -> red. */
  const { reportIsCurrent, REPORT_PATH } = await load();
  assert.ok(reportIsCurrent(ROOT), `${REPORT_PATH} is stale -- run node ${EVAL}`);
});
