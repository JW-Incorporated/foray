/* Every taxonomy node id referenced by a data file must exist in
 * data/taxonomy.json.
 *
 * WHY THIS EXISTS
 * `data/` auto-merges with no human read, and CI's data-invariant step
 * (.github/workflows/ci.yml) validates topic ids for `discover.json` ONLY.
 * Three other files carry node ids and were checked by nothing:
 *
 *   - data/breadth-classification.json  19,787 shows, ~24k topic references
 *   - data/top-topics.json              155 topics -> node mappings
 *   - data/genre-taxonomy-map.json      110 Apple genres -> node mappings
 *
 * A bad id in any of them fails silently and stays green: the sliders it should
 * light up simply never fire, and `topic-coverage-report.mjs` quietly counts
 * the topic as unsupported. `tools/classify/merge-results.mjs` validates the
 * classification AGENT's output, which covers exactly one of the ways an id
 * gets into these files — a hand edit, a taxonomy rename, or a new pass is not
 * covered by it at all. That gap was found reviewing the 2026-08
 * re-classification, where a stale `top-topics.json` had been reporting 13
 * solved topics as unsolved for a month.
 *
 * TOPIC PROVENANCE (PKG-01; #547, #560 §6.3). The two provenance tests pin that every
 * discover item says where its topics came from (`topics_source`) and carries
 * an `explicit` key. They are real-data tests that pass on today's data by
 * construction; the kill is: delete one item's `topics_source` (or
 * `explicit`) key in data/discover.json locally — the matching test goes red,
 * and `node tools/refresh/backfill-provenance.mjs --check` exits 1 on the same
 * edit.
 *
 * FUSION CONTAMINATION (PKG-07; #547 F19). The PKG-07 test pins that no general
 * show's episode sits on `engineering/energy-fusion` by inheriting the show's
 * label, nor carries it without its own title or hook naming fusion. The
 * residue test after it (#547, 2026-10) closes the gap that test leaves for
 * shows NOT marked general: only an explicitly allowlisted fusion-specific
 * show may hand the fusion leaf to its episodes by inheritance. The kills are
 * in the tests.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "..", "data");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

const taxonomy = read("taxonomy.json");
const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));

/** Formats up to 10 offenders, so a failure names the problem instead of dumping 19k lines. */
function report(bad) {
  return bad.slice(0, 10).join(", ") + (bad.length > 10 ? ` … and ${bad.length - 10} more` : "");
}

test("every taxonomy node id is unique", () => {
  assert.equal(nodeIds.size, taxonomy.nodes.length);
});

test("every child node names a parent that exists and is top-level", () => {
  const bad = [];
  for (const n of taxonomy.nodes) {
    if (!n.parent) continue;
    const parent = taxonomy.nodes.find((p) => p.id === n.parent);
    if (!parent) bad.push(`${n.id}: no such parent ${n.parent}`);
    else if (parent.parent) bad.push(`${n.id}: parent ${n.parent} is itself a child`);
    else if (n.id !== `${n.parent}/${n.id.split("/")[1]}` || n.id.split("/").length !== 2) {
      bad.push(`${n.id}: id must be "<parent>/<leaf>"`);
    }
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/breadth-classification.json topics all resolve", () => {
  const { entries } = read("breadth-classification.json");
  const bad = [];
  for (const [id, e] of Object.entries(entries)) {
    for (const t of e.topics || []) if (!nodeIds.has(t)) bad.push(`${id}:${t}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/breadth-classification.json topic_confidences all resolve", () => {
  const { entries } = read("breadth-classification.json");
  const bad = [];
  for (const [id, e] of Object.entries(entries)) {
    for (const tc of e.topic_confidences || []) if (!nodeIds.has(tc.node)) bad.push(`${id}:${tc.node}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("no breadth-classification entry has an empty topics array", () => {
  // An entry with no topics is the invisible failure mode of every pass that
  // writes this file: still valid JSON, still green, show silently unclassified.
  const { entries } = read("breadth-classification.json");
  const bad = Object.entries(entries)
    .filter(([, e]) => !Array.isArray(e.topics) || e.topics.length === 0)
    .map(([id]) => id);
  assert.deepEqual(bad, [], report(bad));
});

test("data/genre-taxonomy-map.json topics all resolve", () => {
  const { map } = read("genre-taxonomy-map.json");
  const bad = [];
  for (const [genre, m] of Object.entries(map)) {
    for (const t of m.topics || []) if (!nodeIds.has(t)) bad.push(`${genre}:${t}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("every genre-taxonomy-map entry has a confidence and at least one topic", () => {
  const { map } = read("genre-taxonomy-map.json");
  const bad = [];
  for (const [genre, m] of Object.entries(map)) {
    if (!Array.isArray(m.topics) || m.topics.length === 0) bad.push(`${genre}: no topics`);
    if (!["high", "medium", "low"].includes(m.confidence)) bad.push(`${genre}: bad confidence ${m.confidence}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/top-topics.json taxonomy_nodes all resolve", () => {
  const { topics } = read("top-topics.json");
  const bad = [];
  for (const t of topics) {
    for (const n of t.taxonomy_nodes || []) if (!nodeIds.has(n)) bad.push(`${t.id}:${n}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/discover.json topics all resolve", () => {
  const { items } = read("discover.json");
  const bad = [];
  for (const i of items) {
    if (!Array.isArray(i.topics) || i.topics.length === 0) bad.push(`${i.id}: no topics`);
    for (const t of i.topics || []) if (!nodeIds.has(t)) bad.push(`${i.id}:${t}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/session.json episode topics all resolve", () => {
  const session = read("session.json");
  const bad = [];
  for (const [id, e] of Object.entries(session.episodes || {})) {
    for (const t of e.topics || []) if (!nodeIds.has(t)) bad.push(`${id}:${t}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/personas.json weights all resolve", () => {
  const personas = read("personas.json");
  const bad = [];
  for (const p of personas.personas || []) {
    for (const w of p.weights || []) if (!nodeIds.has(w.node_id)) bad.push(`${p.id}:${w.node_id}`);
  }
  assert.deepEqual(bad, [], report(bad));
});

test("data/ladders.json node refs resolve", () => {
  const ladders = read("ladders.json");
  const bad = [];
  const scan = (o, where) => {
    if (Array.isArray(o)) return o.forEach((x) => scan(x, where));
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === "node" || k === "node_id" || k === "topic") && typeof v === "string" && !nodeIds.has(v)) bad.push(`${where}:${v}`);
      else scan(v, where);
    }
  };
  scan(ladders, "ladders");
  assert.deepEqual(bad, [], report(bad));
});

test("every discover item carries topics_source in {show, episode}", () => {
  /* KILLED BY: deleting `topics_source` from one item in data/discover.json, or
     dropping the `topics_source:` line from merge.mjs's item literal (the next
     nightly item then lands without it). */
  const { items } = read("discover.json");
  const bad = items.filter((i) => i.topics_source !== "show" && i.topics_source !== "episode").map((i) => `${i.id}:${i.topics_source}`);
  assert.deepEqual(bad, [], report(bad));
});

test("every discover item carries an explicit key (true, false or null)", () => {
  /* KILLED BY: deleting `explicit` from one item in data/discover.json, or
     reverting merge.mjs to `explicit: ep.explicit,` (an unflagged episode then
     lands with no key). */
  const { items } = read("discover.json");
  const bad = items.filter((i) => !("explicit" in i) || ![true, false, null].includes(i.explicit)).map((i) => i.id);
  assert.deepEqual(bad, [], report(bad));
});

test("no engineering/energy-fusion item comes from a general show's inherited label", () => {
  /* PKG-07 (#547 F19). Catalyst, CBC Ideas and TechSurge seed every episode
     with `engineering/energy-fusion` because the show's own label says so, and
     those episodes were about batteries, psychopaths, David Bowie and wildfires
     — the fusion leaf and every generated playlist on it was mostly not fusion.
     docs/curation/relabel-2026-09-fusion.json relabelled them per episode
     (topics_source "episode"). A general show's episode may still sit on the
     fusion leaf, but only by someone's per-episode judgement, never by
     inheritance. KILLED BY: setting one relabelled item back to
     `"topics": ["engineering/energy-fusion"], "topics_source": "show"` in
     data/discover.json (e.g. cbc-ideas--david-bowie-took-his-own-death).

     "episode" IS NOT PROOF OF A JUDGEMENT. Lex Fridman's catalog row has
     `taxonomy_node_ids: []`, so PKG-01's backfill stamped any topic its
     episodes carried "episode" — and #499 Gary Gallagher (Civil War), #500
     Khabib Nurmagomedov (MMA) and #501 DHH (programming) all sat on the fusion
     leaf as "episode" until the same batch relabelled them. So a general
     show's fusion item must also name fusion in its own title or hook: an
     episode a person actually judged to be about fusion says so (the SYSK
     reactor episode does). KILLED BY: setting
     lex-fridman-podcast--501-dhh-future-of-programming-ai back to
     `"topics": ["engineering/energy-fusion"]`, leaving `topics_source`
     "episode". */
  const FUSION = "engineering/energy-fusion";
  const general = new Set(read("catalog.json").shows.filter((s) => s.label_scope === "general").map((s) => s.title));
  assert.ok(general.size > 0, "catalog.json marks no show label_scope general — the guard would be vacuous");
  const { items } = read("discover.json");
  const onLeaf = items.filter((i) => general.has(i.show) && (i.topics || []).includes(FUSION));
  const inherited = onLeaf.filter((i) => i.topics_source === "show").map((i) => `inherited — ${i.show}: ${i.id}`);
  const unjudged = onLeaf
    .filter((i) => i.topics_source !== "show" && !/fusion/i.test(`${i.title || ""} ${i.hook || ""}`))
    .map((i) => `not about fusion by its own title/hook — ${i.show}: ${i.id}`);
  const bad = [...inherited, ...unjudged];
  assert.deepEqual(bad, [], report(bad));
});

test("only an allowlisted fusion-specific show passes engineering/energy-fusion to its episodes by inheritance", () => {
  /* #547 residue (2026-10). The PKG-07 test above guards only `label_scope:
     "general"` shows. Lab to Market Leadership and CleanTechies Podcast are not
     general, and their show labels carried `engineering/energy-fusion` onto
     episodes about startup founders, e-waste minerals and home batteries.
     Those three episodes were the newest three of the fusion playlist's six.
     docs/curation/relabel-2026-10-fusion-residue.json relabelled them, and
     both shows lost the fusion node from their catalog row.

     THE ALLOWLIST IS EXPLICIT ON PURPOSE. "The show's own label contains the
     leaf" would pass by construction: every inherited item inherits a label
     that names the leaf. CleanTechies, whose only node was the fusion leaf,
     passed that check while being wrong. A show joins this list only by
     someone's judgement that every episode of it is fusion/fission
     engineering.

     Two halves: (1) no discover item outside the allowlist wears the leaf with
     `topics_source: "show"`; (2) no catalog row outside the allowlist carries
     the leaf, unless it is general (merge.mjs then refuses an episode that has
     no topic of its own, PKG-05a). Without (2), the next nightly episode of
     such a show would inherit the leaf again.
     KILLED BY (run 2026-10-05): (1) setting
     cleantechies-podcast--291-building-physical-infrastructure-at-the back to
     `"topics": ["engineering/energy-fusion"], "topics_source": "show"` in
     data/discover.json; (2) putting `engineering/energy-fusion` back in
     CleanTechies Podcast's `taxonomy_node_ids` in data/catalog.json. */
  const FUSION = "engineering/energy-fusion";
  const FUSION_SPECIFIC_SHOWS = new Set(["Titans of Nuclear", "omega tau"]);
  const shows = read("catalog.json").shows;
  const titles = new Set(shows.map((s) => s.title));
  const unknown = [...FUSION_SPECIFIC_SHOWS].filter((t) => !titles.has(t));
  assert.deepEqual(unknown, [], `allowlisted shows missing from catalog.json: ${unknown.join(", ")}`);
  const { items } = read("discover.json");
  const inherited = items
    .filter((i) => (i.topics || []).includes(FUSION) && i.topics_source === "show" && !FUSION_SPECIFIC_SHOWS.has(i.show))
    .map((i) => `inherited — ${i.show}: ${i.id}`);
  const labelled = shows
    .filter((s) => (s.taxonomy_node_ids || []).includes(FUSION) && !FUSION_SPECIFIC_SHOWS.has(s.title) && s.label_scope !== "general")
    .map((s) => `show label — ${s.show_id}`);
  const bad = [...inherited, ...labelled];
  assert.deepEqual(bad, [], report(bad));
});
