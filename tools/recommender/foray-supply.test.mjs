/* tools/recommender/foray-supply.mjs: the Foray supply report per rating
   persona (RV-22, docs/roadmap/recommender-v1.md, #1380) -- candidate nodes
   for the catalogue lane with positive persona weight, timed-transcript
   supply, and no published Foray.

   Every test names the one-line mutation of foray-supply.mjs that turns it
   red; each was run red before this suite was committed. Offline: inputs are
   built here, and the CLI test reads and lists only a fresh temp folder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNodeIndex, main, PATHS, personaNodeWeights, supplyByNode, supplyReport } from "./foray-supply.mjs";

const FLAGS = { explicit: false, harassment: false, medical_financial_advice: false, injection_suspected: false };

/** A ratings.json row: the fit in slot 0 of the RV-02 ten-slot array. */
const row = (fits) => ({
  evidence_tier: "show-metadata",
  summary: "s",
  format: "mixed",
  flags: FLAGS,
  top_reason: "r",
  top_persona: Object.keys(fits)[0],
  passes: 1,
  personas: Object.fromEntries(Object.entries(fits).map(([p, f]) => [p, [f, 0.5, 3, 3, 3, 3, null, null, null, 0.4]])),
});

const ratingsOf = (shows) => ({ version: 1, rubric_version: 1, built_at: "2026-10-14T00:00:00.000Z", merged_batches: [], shows });

/** Curated `cur-a` (Apple 111) on node-a; breadth 222 on node-a and node-b; breadth 333 on node-c. */
function inputs({ forays = [] } = {}) {
  return {
    ratings: ratingsOf({ "cur-a": row({ p1: 5 }), 222: row({ p1: 4 }), 333: row({ p1: 5 }) }),
    catalog: { shows: [{ show_id: "cur-a", apple_collection_id: 111, taxonomy_node_ids: ["node-a"] }] },
    breadth: {
      shows: [
        { apple_collection_id: 111, taxonomy_node_ids: ["ignored-breadth-node"] },
        { apple_collection_id: 222, taxonomy_node_ids: ["node-a", "node-b"] },
        { apple_collection_id: 333, taxonomy_node_ids: ["node-c"] },
      ],
    },
    availability: { shows: [{ show_id: "cur-a", apple_collection_id: 111, episodes_with_timed_transcript: 40 }] },
    yieldDoc: {
      shows: [
        { show_id: "111", apple_collection_id: 111, episodes_with_timed_transcript: 30 },
        { show_id: "222", apple_collection_id: 222, episodes_with_timed_transcript: 7 },
        { show_id: "333", apple_collection_id: 333, episodes_with_timed_transcript: 0 },
      ],
    },
    forays: { forays },
  };
}

const nodesFor = (report, persona = "p1") => report.personas.find((p) => p.persona_id === persona).candidates.map((c) => c.node);

/* Mutation: ignore supply (drop the `if (!s || !(s.episodes > 0)) continue;`
   line in supplyReport) -- node-c, rated 5 but with zero timed episodes,
   becomes a candidate. */
test("a node with supply and no Foray is a candidate", () => {
  const report = supplyReport(inputs());
  assert.deepEqual(nodesFor(report), ["node-a", "node-b"]);
  const a = report.personas[0].candidates[0];
  assert.equal(a.node, "node-a");
  assert.equal(a.supply_episodes, 47, "cur-a once (max of 40 and 30) plus 222's 7");
  assert.equal(a.supply_shows, 2);
  assert.ok(!nodesFor(report).includes("node-c"), "no timed transcripts, no candidate");
  assert.ok(!nodesFor(report).includes("ignored-breadth-node"), "a curated row's own nodes win over its breadth row's");
});

/* Mutation: ignore status (publishedNodes adds every Foray's topic, i.e.
   `foray.status === PUBLISHED &&` removed) -- the draft on node-b would then
   remove node-b too. */
test("a node with a published Foray is excluded", () => {
  const report = supplyReport(
    inputs({
      forays: [
        { id: "f1", status: "published", topic: "node-a" },
        { id: "f2", status: "draft", topic: "node-b" },
      ],
    }),
  );
  assert.deepEqual(nodesFor(report), ["node-b"], "the published node is gone, the draft's is not");
  assert.deepEqual(report.published_nodes, ["node-a"]);
  assert.equal(report.personas[0].excluded_published, 1);
});

/* Mutation: sum fit (`cell.weight += fit - NEUTRAL_FIT` -> `cell.weight += fit`)
   -- node-x would weigh 5 + 2 = 7 rather than 2 + (-1) = 1, and node-y's
   fit of 2 would weigh +2 rather than -1. */
test("persona weight sums fit minus 3", () => {
  const breadth = {
    shows: [
      { apple_collection_id: 1, taxonomy_node_ids: ["node-x"] },
      { apple_collection_id: 2, taxonomy_node_ids: ["node-x", "node-y"] },
    ],
  };
  const index = buildNodeIndex({ catalog: { shows: [] }, breadth });
  const weights = personaNodeWeights(ratingsOf({ 1: row({ p1: 5, p2: 3 }), 2: row({ p1: 2, p2: 4 }) }), index.nodesOf);
  assert.deepEqual(weights.get("p1").get("node-x"), { weight: 1, shows: 2 });
  assert.deepEqual(weights.get("p1").get("node-y"), { weight: -1, shows: 1 });
  assert.deepEqual(weights.get("p2").get("node-x"), { weight: 1, shows: 2 });
  const report = supplyReport({
    ratings: ratingsOf({ 1: row({ p1: 5 }), 2: row({ p1: 2 }) }),
    catalog: { shows: [] },
    breadth,
    availability: { shows: [] },
    yieldDoc: { shows: [{ apple_collection_id: 2, episodes_with_timed_transcript: 9 }] },
    forays: { forays: [] },
  });
  assert.deepEqual(nodesFor(report), ["node-x"], "node-y (weight -1) is not a candidate despite its supply");
  assert.equal(report.personas[0].candidates[0].weight, 1);
});

/* Mutation: count a curated show twice (`Math.max(perShow.get(k) ?? 0, n)` ->
   `(perShow.get(k) ?? 0) + n` in supplyByNode) -- node-a's supply becomes
   40 + 30 + 7 = 77 episodes. Also pins the Apple-id alias to the curated key. */
test("supply joins both files through node ids, a curated show counted once", () => {
  const i = inputs();
  const index = buildNodeIndex(i);
  assert.equal(index.canonicalKey("111"), "cur-a");
  const supply = supplyByNode(i, index);
  assert.deepEqual(supply.get("node-a"), { episodes: 47, shows: 2 });
  assert.deepEqual(supply.get("node-b"), { episodes: 7, shows: 1 });
  assert.equal(supply.has("node-c"), false);
});

/* Mutation: render JSON always (`args.json ? JSON... : renderMarkdown(report)`
   -> `JSON.stringify(report, null, 2) + "\n"`) -- the default run prints no
   Markdown table. Also pins that a run writes no file. */
test("the CLI prints a Markdown table by default and JSON with --json, writing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "foray-supply-"));
  try {
    const i = inputs({ forays: [{ id: "f1", status: "published", topic: "node-b" }] });
    const docs = { ratings: i.ratings, catalog: i.catalog, breadth: i.breadth, availability: i.availability, yield: i.yieldDoc, forays: i.forays };
    for (const [name, doc] of Object.entries(docs)) {
      const file = join(dir, PATHS[name]);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(doc));
    }
    const listing = () =>
      readdirSync(dir, { recursive: true })
        .map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`)
        .sort();
    const before = listing();

    let out = "";
    assert.equal(main(["--root", dir], { stdout: (s) => (out += s), stderr: () => {} }), 0);
    assert.match(out, /^# Foray supply per persona/);
    assert.ok(out.includes("| `node-a` | 3 | 2 | 47 | 2 |"), out);
    assert.ok(!out.includes("| `node-b` |"), "the published node is not a row");

    let json = "";
    assert.equal(main(["--root", dir, "--json", "--top", "1"], { stdout: (s) => (json += s), stderr: () => {} }), 0);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.published_nodes, ["node-b"]);
    assert.deepEqual(nodesFor(parsed), ["node-a"]);

    let err = "";
    assert.equal(main(["--bogus"], { stdout: () => {}, stderr: (s) => (err += s) }), 2);
    assert.match(err, /unknown argument/);

    assert.deepEqual(listing(), before, "no file written or touched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
