/* Search-quality battery for search-engine.js.
   Runs a diverse set of real queries against the live catalog data
   (data/discover.json + data/item-tags.json + data/semantic-index.json) and
   asserts three things per docs/curation/personalization-and-depth-plan.md
   §7 and CLAUDE.md principle #1 ("no misleading results"):

     1. Regression anchors: "nuclear fusion energy" and "startups and venture
        capital" must return their EXACT top-3 (by id, in order) -- these
        were already excellent before this fix and must not move.
     2. Primary-token presence / no off-topic top result: for topics with
        real catalog coverage, every one of the checked top results must
        carry the query's actual subject (a tag, title, or show substring
        we specify per case) -- if this fails, junk is leaking into results.
     3. Honest empty: for topics the catalog genuinely doesn't cover (an
        NBA team by name), status must be "empty" -- never a padded list of
        unrelated filler.

   Usage: node tools/test-search.mjs
   Exit code 0 = all pass, 1 = at least one failure (readable report to stdout).

   NOTE on scope: a few pre-existing weaknesses were found while building
   this battery and are deliberately NOT covered/asserted here because
   fixing them is out of scope for this pass (see PR description):
     - hitText()/hitTag() use raw substring matching (not word-boundary) for
       terms >= 4 chars, which occasionally collides on an unrelated word
       that contains the term (e.g. "fusion" inside "diffusion", "roman"
       inside "romance", "plane" inside "planetary", "team" inside "steam").
     - Multi-word proper-noun queries (e.g. a podcast host's name that isn't
       repeated in individual episode titles, like "huberman lab") can be
       satisfied by matching only ONE of the words when both are flagged
       primary -- there's no AND-semantics across primary groups.
   Both are pre-existing (present before this change too) and are noted in
   the PR for a future, separately-scoped fix. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const SE = require(join(ROOT, "search-engine.js"));

const discover = JSON.parse(readFileSync(join(ROOT, "data/discover.json"), "utf8"));
const itemTags = JSON.parse(readFileSync(join(ROOT, "data/item-tags.json"), "utf8"));
const semantic = JSON.parse(readFileSync(join(ROOT, "data/semantic-index.json"), "utf8"));
const session = JSON.parse(readFileSync(join(ROOT, "data/session.json"), "utf8"));
const validated = JSON.parse(readFileSync(join(ROOT, "data/validated-links.json"), "utf8"));

/* Mirrors app.js's fullPool()/snapshot()/episode() exactly -- the real
   client searches session.episodes + discover.items (deduped), NOT
   discover.items alone. Testing against discover.json only missed 27
   session episodes, including several of the highest-scoring fusion
   results the live app actually returns (e.g. lex-485-kirtley) -- caught
   by cross-checking a live-server run against this harness during review. */
function fullPool() {
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    const ep = session.episodes[id];
    const v = validated?.episodes?.[id];
    const src = v ? { ...ep, apple_track_id: ep.apple_track_id ?? v.apple_track_id, artwork_url: v.artwork_url || ep.artwork_url || null, apple_episode_url: v.apple_episode_url || null } : ep;
    pool.push({
      id, show: src.show, title: src.title,
      apple_collection_id: src.apple_collection_id,
      apple_track_id: src.apple_track_id ?? null,
      apple_episode_url: src.apple_episode_url ?? null,
      duration_min: src.duration_min ?? null,
      artwork_url: src.artwork_url ?? null,
      topics: src.topics || [],
      hook: src.hook || src.summary || src.title,
    });
    seen.add(id);
  }
  for (const item of discover.items) {
    if (!seen.has(item.id)) pool.push(item);
  }
  return pool;
}
const pool = fullPool();

function freshCtx() {
  return { semantic, itemTags, discover };
}

function search(query) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results);
  return { status, picks, interp };
}

/* True if item's tags/title/show/topics contain `needle` (case-insensitive
   substring on the combined text, or an exact tag hit). */
function itemHas(item, needle) {
  const n = needle.toLowerCase();
  const tags = itemTags.tags?.[item.id] || [];
  if (tags.some((t) => t.includes(n))) return true;
  const text = [item.title, item.show, (item.topics || []).join(" ")].join(" ").toLowerCase();
  return text.includes(n);
}

const failures = [];
const passes = [];

function check(label, cond, detail) {
  if (cond) passes.push(label);
  else failures.push(`${label}\n    ${detail}`);
}

/* ---------- 1. regression anchors ---------- */

function assertExactTop3(query, expectedIds) {
  const { status, picks } = search(query);
  const gotIds = picks.slice(0, 3).map((p) => p.i.id);
  check(
    `anchor "${query}" top-3 unchanged`,
    status === "ok" && JSON.stringify(gotIds) === JSON.stringify(expectedIds),
    `expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(gotIds)} (status=${status})`
  );
}

assertExactTop3("nuclear fusion energy", [
  "lex-485-kirtley",
  "cleantechies-216-thea",
  "lex-353-whyte",
]);
assertExactTop3("startups and venture capital", [
  "twenty-minute-vc--fred-turner-curative",
  "this-week-in-startups--farm-robots-reservoir",
  "this-week-in-startups--surgery-bots-mogul",
]);

/* ---------- 2. topical, on-topic queries: primary token must appear, no junk ---------- */

/* Each case: query, expected status ("ok" | "sparse"), how many of the top
   picks to check, and the needle(s) every one of those picks must contain
   (any one of the needles is enough per item -- OR semantics). */
const topicalCases = [
  { query: "how bbq works", status: "sparse", checkTop: 4, anyOf: ["bbq", "barbecue", "grill"] },
  { query: "the history of jazz", status: "sparse", checkTop: 2, anyOf: ["jazz"] },
  { query: "true crime", status: "ok", checkTop: 5, anyOf: ["true-crime", "crime", "murder", "serial-killer"] },
  { query: "comedy", status: "ok", checkTop: 5, anyOf: [] /* checked separately via branchOf */ },
  { query: "parenting", status: "ok", checkTop: 5, anyOf: ["parenting"] },
  { query: "smartless", status: "ok", checkTop: 5, anyOf: ["smartless"] },
  { query: "crime junkie", status: "ok", checkTop: 5, anyOf: ["crime"] },
  { query: "formula 1 racing", status: "ok", checkTop: 5, anyOf: ["f1", "formula-1", "formula 1"] },
  { query: "cooking", status: "ok", checkTop: 5, anyOf: ["food", "cooking", "bbq", "barbecue", "cuisine", "recipes"] },
  { query: "meditation", status: "sparse", checkTop: 2, anyOf: ["meditation", "mindfulness"] },
  { query: "endurance running", status: "ok", checkTop: 5, anyOf: ["endurance", "running", "triathlon", "nutrition", "physiology"] },
  { query: "rome", status: "ok", checkTop: 3, anyOf: ["rome", "roman"] },
  { query: "plane crashes", status: "ok", checkTop: 5, anyOf: ["aviation", "plane-crash", "aircraft"] },
  { query: "politics", status: "ok", checkTop: 5, anyOf: ["politics"] },
];

for (const c of topicalCases) {
  const { status, picks } = search(c.query);
  check(`"${c.query}" status is ${c.status}`, status === c.status, `got status=${status}, raw picks=${picks.length}`);
  if (status !== c.status) continue;

  const top = picks.slice(0, c.checkTop);
  check(`"${c.query}" has >=2 results in top-${c.checkTop} window`, top.length >= Math.min(2, c.checkTop), `only ${top.length} picks`);

  if (c.query === "comedy") {
    const offBranch = top.filter((p) => SE.branchOf(p.i) !== "comedy");
    check(`"${c.query}" top-${c.checkTop} all branch=comedy`, offBranch.length === 0,
      `off-branch: ${offBranch.map((p) => `${p.i.id} (${SE.branchOf(p.i)})`).join(", ")}`);
    continue;
  }

  const offTopic = top.filter((p) => !c.anyOf.some((needle) => itemHas(p.i, needle)));
  check(`"${c.query}" top-${c.checkTop} all on-topic (${c.anyOf.join("/")})`, offTopic.length === 0,
    `off-topic: ${offTopic.map((p) => `${p.i.id} "${p.i.title}"`).join(", ")}`);
}

/* ---------- 3. honest empty for genuinely-absent topics ---------- */

for (const query of ["the lakers", "warriors"]) {
  const { status, picks } = search(query);
  check(`"${query}" is honestly empty (no NBA-team content in catalog)`, status === "empty" && picks.length === 0,
    `got status=${status}, picks=${picks.length}`);
}

/* ---------- 4. generic-filler stress test: filler words never dominate ---------- */

for (const query of ["how bbq works", "the history of jazz"]) {
  const { interp } = search(query);
  const broadOnly = interp.groups.filter((g) => g.broad).map((g) => g.token);
  const primaryPresent = interp.groups.some((g) => !g.broad);
  check(`"${query}" has a primary (non-broad) token`, primaryPresent,
    `all groups broad: ${JSON.stringify(broadOnly)}`);
}

/* ---------- report ---------- */

console.log(`${passes.length} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("FAILURES:\n");
  failures.forEach((f) => console.log("  - " + f));
  console.log("");
  process.exit(1);
}
console.log("All search-quality battery checks passed.");
