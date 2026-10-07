/* Tests for taxonomy node terms and episode topics — tools/foraycorpus-export/topics.mjs
   (PKG-29, docs/roadmap/corpus.md §3).
   Run: npm test --prefix tools/foraycorpus-export -- topics.test.mjs

   One 6-node / 4-episode fixture, built in a tmp directory. The constants are
   PKG-28's PROVISIONAL placeholders, so every test passes τ explicitly; none of
   them asserts a constant's value (PKG-28's own suite pins those).

   EVERY TEST NAMES THE ONE-LINE MUTATION THAT MAKES IT FAIL, per CLAUDE.md
   § "A green test is not evidence until you have broken it". The floor for
   this suite lives in test/suite-integrity.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assignEpisodes,
  buildNodeTerms,
  main,
  markGeneralShows,
  showMapFromCatalog,
  writeEpisodeTopics,
  writeTaxonomyTerms,
} from "./topics.mjs";

const TAU = 0.3;

/* Six nodes, two roots with a child each plus one more pair. `weight: 1.0` on
   one node is deliberate: JSON.stringify would write it as `1`, so a writer
   that re-serializes the whole file is visible in the bytes. */
const TAXONOMY_TEXT = `{
  "version": 1,
  "notes": "fixture",
  "nodes": [
    {
      "id": "science",
      "parent": null,
      "label": "Science",
      "apple_anchor": "Science",
      "weight": 1.0
    },
    {
      "id": "science/physics",
      "parent": "science",
      "label": "Physics",
      "terms": [
        "fission"
      ],
      "apple_anchor": "Science > Physics",
      "weight": 0.9
    },
    {
      "id": "history",
      "parent": null,
      "label": "History",
      "apple_anchor": "History",
      "weight": 0.8
    },
    {
      "id": "history/war",
      "parent": "history",
      "label": "Wars and conflict systems",
      "apple_anchor": "History",
      "weight": 0.7
    },
    {
      "id": "food",
      "parent": null,
      "label": "Food",
      "apple_anchor": "Arts > Food",
      "weight": 0.6
    },
    {
      "id": "food/baking",
      "parent": "food",
      "label": "Baking",
      "apple_anchor": "Arts > Food",
      "weight": 0.5
    }
  ]
}
`;
const taxonomy = JSON.parse(TAXONOMY_TEXT);

/* show-a is a curated show (apple 111 -> slug), show 222 is breadth. ep4's
   discover item is labelled food/baking but carries no guid, so it is the
   episode whose show label exists and whose own terms do not support it. */
const catalog = { shows: [{ show_id: "show-a", apple_collection_id: 111 }] };
const discover = {
  items: [
    { id: "i1", apple_collection_id: 111, episode_guid: "g1", topics: ["science/physics"] },
    { id: "i2", apple_collection_id: 111, episode_guid: "g2", topics: ["history/war"] },
    { id: "i3", apple_collection_id: 222, episode_guid: "g3", topics: ["food/baking"] },
    { id: "i4", apple_collection_id: 222, topics: ["food/baking"] },
  ],
};
const episodeTerms = [
  { show_id: "show-a", guid: "g1", n_tokens: 900, terms: [["quark", 5], ["episode", 3], ["lepton", 2]] },
  { show_id: "show-a", guid: "g2", n_tokens: 900, terms: [["trench", 5], ["episode", 3], ["armistice", 2]] },
  { show_id: "222", guid: "g3", n_tokens: 900, terms: [["sourdough", 5], ["crumb", 2]] },
  { show_id: "222", guid: "g4", n_tokens: 900, terms: [["weather", 5], ["traffic", 4], ["crumb", 0.1]] },
];
const words = { stopwords: new Set(["and"]), generic: new Set(["systems"]) };

function build() {
  return buildNodeTerms({ taxonomy, discover, episodeTerms, showMap: showMapFromCatalog(catalog), words }).nodeTerms;
}
const termsOf = (nodeTerms, id) => nodeTerms.get(id).terms.map(([t]) => t);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pkg29-topics-"));
}

/* 1. Killing mutation: drop `!shared.has(t) &&` from the evidence filter in
      buildNodeTerms. "episode" is in the evidence of 2 of 6 nodes (33 % > 30 %),
      so it would stay on both physics and war. */
test("node terms drop a term shared by more than 30 % of nodes, and no node is left empty", () => {
  const nodeTerms = build();
  for (const id of ["science/physics", "history/war"]) {
    assert.ok(!termsOf(nodeTerms, id).includes("episode"), `${id} kept the shared term "episode"`);
  }
  assert.deepEqual(termsOf(nodeTerms, "science/physics"), ["fission", "quark", "lepton", "physics", "science"]);
  assert.deepEqual(termsOf(nodeTerms, "history/war"), ["trench", "armistice", "wars", "conflict", "history"]);
  for (const node of taxonomy.nodes) assert.ok(termsOf(nodeTerms, node.id).length > 0, `${node.id} is empty`);
});

/* 2. Killing mutation: delete the ancestor loop in assignEpisodes (`for (let p
      = nodeTerms.get(id)?.parent; …) topics.add(p);`). ep1 would get physics
      without science. */
test("an episode at cosine >= τ is assigned the node and the node's parent", () => {
  const out = assignEpisodes({ nodeTerms: build(), episodeTerms, tau: TAU });
  const ep1 = out.get("show-a|g1");
  assert.deepEqual(ep1.topics, ["science", "science/physics"]);
  assert.ok(ep1.scores["science/physics"] >= TAU, `physics scored ${ep1.scores["science/physics"]}`);
  assert.deepEqual(out.get("show-a|g2").topics, ["history", "history/war"]);
});

/* 3. Killing mutation: drop the τ filter in assignEpisodes
      (`.filter(([, c]) => c >= tau)` -> nothing). ep4 shares one weak term
      with food/baking — the label its show's other episode and its own discover
      item carry — and would be given food/baking and food. Below τ the answer
      is [], never a label borrowed from the show. */
test("an episode below τ gets no topics, never its show's label", () => {
  const out = assignEpisodes({ nodeTerms: build(), episodeTerms, tau: TAU });
  const ep4 = out.get("222|g4");
  assert.deepEqual(ep4.topics, []);
  assert.deepEqual(ep4.scores, {});
  assert.deepEqual(markGeneralShows({ assignments: out, minRoots: 2, maxShare: 0.5 }), ["show-a"]);
});

/* 4. Killing mutation: replace writeTaxonomyTerms' line edits with
      `writeFileSync(taxonomyPath, JSON.stringify(intended, null, 2) + "\n")`.
      The fixture's `"weight": 1.0` becomes `1` and the byte comparison fails. */
test("writeTaxonomyTerms changes only `terms` in the file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "taxonomy.json");
  fs.writeFileSync(file, TAXONOMY_TEXT);
  const nodeTerms = build();
  const { changed } = writeTaxonomyTerms(file, nodeTerms);
  const after = fs.readFileSync(file, "utf8");
  assert.equal(changed, 6);
  for (const node of JSON.parse(after).nodes) assert.deepEqual(node.terms, termsOf(nodeTerms, node.id));
  const withoutTerms = (s) => s.replace(/^ {6}"terms": \[[\s\S]*?^ {6}\],\n/gm, "");
  assert.equal(withoutTerms(after), withoutTerms(TAXONOMY_TEXT));
  assert.match(after, /"weight": 1\.0\n/);
  assert.equal(writeTaxonomyTerms(file, nodeTerms).changed, 0, "a second write of the same terms changes nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

/* 5. Killing mutation: iterate `assignments.keys()` without `.sort()` in
      episodeTopicsDoc (or drop the `Object.keys(scores).sort()`). The map below
      is filled in reverse order, so the file would come out reversed. */
test("episode-topics.json is written with sorted episode and score keys", () => {
  const dir = tmpDir();
  const file = path.join(dir, "episode-topics.json");
  const assignments = new Map([
    ["zz|9", { show_id: "zz", guid: "9", topics: ["b", "a"], scores: { b: 0.5, a: 0.4 } }],
    ["aa|1", { show_id: "aa", guid: "1", topics: [], scores: {} }],
    ["mm|5", { show_id: "mm", guid: "5", topics: ["c"], scores: { c: 0.9 } }],
  ]);
  writeEpisodeTopics(file, assignments, { generalShows: ["zz", "aa"], builtAt: "2026-10-07T00:00:00Z" });
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(doc.episodes), ["aa|1", "mm|5", "zz|9"]);
  assert.deepEqual(Object.keys(doc.episodes["zz|9"].scores), ["a", "b"]);
  assert.deepEqual(doc.episodes["zz|9"].topics, ["a", "b"]);
  assert.deepEqual(doc.general_shows, ["aa", "zz"]);
  assert.equal(doc.rule, "docs/curation/episode-topics-rule.md");
  fs.rmSync(dir, { recursive: true, force: true });
});

/* 6. Killing mutation: delete the `if (values.write && provisional) throw …`
      guard in main. With PKG-28's numbers still placeholders, --write would
      rewrite the taxonomy and write episode-topics.json. The second half runs
      the same command with the guard satisfied, so the refusal is the guard's
      doing and not a broken CLI (it also reads the real backend word lists). */
test("--write is refused while the constants are provisional, and works once they are not", () => {
  const dir = tmpDir();
  const p = (f) => path.join(dir, f);
  fs.writeFileSync(p("taxonomy.json"), TAXONOMY_TEXT);
  fs.writeFileSync(p("discover.json"), JSON.stringify(discover));
  fs.writeFileSync(p("catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(p("terms.jsonl"), episodeTerms.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(p("df.json"), JSON.stringify({ version: 1, built_at: "x", docs: 4, df: { episode: 2, crumb: 2 } }));
  const argv = [
    "--terms", p("terms.jsonl"), "--df", p("df.json"), "--tau", String(TAU), "--write",
    "--taxonomy", p("taxonomy.json"), "--discover", p("discover.json"), "--catalog", p("catalog.json"),
    "--archive", p("absent.json.gz"), "--out", p("episode-topics.json"),
  ];
  const quiet = () => {};
  assert.throws(() => main(argv, { provisional: true, log: quiet }), (e) => e.code === "PROVISIONAL");
  assert.equal(fs.readFileSync(p("taxonomy.json"), "utf8"), TAXONOMY_TEXT);
  assert.ok(!fs.existsSync(p("episode-topics.json")));

  const res = main(argv, { provisional: false, log: quiet });
  assert.equal(res.written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p("episode-topics.json"), "utf8")).episodes["show-a|g1"].topics, ["science", "science/physics"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
