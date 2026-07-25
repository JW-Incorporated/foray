/* Search-quality battery for search-engine.js.
   Runs a diverse set of real queries against the live catalog data
   (session.json + discover.json merged, matching app.js's fullPool(), plus
   item-tags.json/semantic-index.json) and asserts, per
   docs/curation/personalization-and-depth-plan.md §7 and CLAUDE.md
   principle #1 ("no misleading results" / anti-echo-chamber):

     1. Regression anchors: "nuclear fusion energy" and "startups and venture
        capital" stay excellent -- status "ok", every top-10 pick genuinely
        on-topic, AND diverse (no show >2x). NOT byte-identical top-3 ids --
        diversity is SUPPOSED to change these queries' output (that's the
        bug being fixed: pre-diversity, "nuclear fusion energy" returned
        Lex Fridman Podcast twice in the top 3). See git history for the
        prior exact-id assertion this replaced.
     2. Primary-token presence / no off-topic top result: for topics with
        real catalog coverage, every one of the checked top results must
        carry the query's actual subject (a tag, title, or show substring
        we specify per case) -- if this fails, junk is leaking into results.
     3. Honest empty: for topics the catalog genuinely doesn't cover (an
        NBA team by name), status must be "empty" -- never a padded list of
        unrelated filler.
     4. Diversity: no single show dominates a result, EXCEPT when the
        catalog genuinely can't diversify (a single-show topic like bbq, or
        a direct show-name query like "smartless") -- there the honest
        answer is the un-capped list, not an artificially shrunk one.
     5. Listened-history down-weight: an already-listened show is nudged
        down in rank, never excluded outright.
     6. Substring-collision regressions (the hitText/hitTag word-boundary
        fix): "fusion" no longer matches inside "diffusion", "roman" no
        longer matches inside "romance", "team" no longer matches inside
        "steam".

   Usage: node tools/test-search.mjs
   Exit code 0 = all pass, 1 = at least one failure (readable report to stdout).

   NOTE on scope: two pre-existing weaknesses found while building this
   battery are deliberately NOT fixed/asserted here -- planned for a
   follow-up PR (see PR description):
     - Multi-word proper-noun queries (e.g. a podcast host's name that isn't
       repeated in individual episode titles, like "huberman lab") can be
       satisfied by matching only ONE of the words when both are flagged
       primary -- there's no AND-semantics across primary groups yet.
     - The `sports` concept's terms include several specific league/team
       words (nba, basketball, ...) the catalog has ~zero real coverage
       for, so a bare "nba"/"basketball" query still surfaces generic
       sports-science content rather than staying honestly thin. */

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

function search(query, opts) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, opts);
  return { status, picks, interp, results };
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

function showCounts(picks) {
  const m = new Map();
  for (const p of picks) m.set(p.i.show, (m.get(p.i.show) || 0) + 1);
  return m;
}

const failures = [];
const passes = [];

function check(label, cond, detail) {
  if (cond) passes.push(label);
  else failures.push(`${label}\n    ${detail}`);
}

/* ---------- 1. regression anchors: quality bar, not exact-id equality ---------- */

function assertAnchor(query, anyOf) {
  const { status, picks } = search(query);
  check(`anchor "${query}" status is ok`, status === "ok", `got status=${status}`);
  if (status !== "ok") return;
  const offTopic = picks.filter((p) => !anyOf.some((needle) => itemHas(p.i, needle)));
  check(`anchor "${query}" all top-10 on-topic (${anyOf.join("/")})`, offTopic.length === 0,
    `off-topic: ${offTopic.map((p) => `${p.i.id} "${p.i.title}"`).join(", ")}`);
  const counts = [...showCounts(picks).values()];
  check(`anchor "${query}" no show appears >2x`, counts.every((n) => n <= 2),
    `show counts: ${JSON.stringify([...showCounts(picks).entries()])}`);
}

assertAnchor("nuclear fusion energy", ["nuclear", "fusion", "energy"]);
assertAnchor("startups and venture capital", ["startup", "venture", "capital"]);

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
  { query: "formula 1 racing", status: "ok", checkTop: 5, anyOf: ["f1", "formula-1", "formula 1", "racing"] },
  { query: "cooking", status: "ok", checkTop: 5, anyOf: ["food", "cooking", "bbq", "barbecue", "cuisine", "recipes"] },
  { query: "meditation", status: "sparse", checkTop: 2, anyOf: ["meditation", "mindfulness"] },
  { query: "endurance running", status: "ok", checkTop: 5, anyOf: ["endurance", "running", "triathlon", "nutrition", "physiology"] },
  { query: "rome", status: "ok", checkTop: 3, anyOf: ["rome", "roman"] },
  // Tightened by the substring-collision fix (issue A): the false
  // "planetary-radio" match is gone, dropping the strong count from 6 to
  // 5 -- correctly sparse now instead of a padded-looking "ok".
  { query: "plane crashes", status: "sparse", checkTop: 5, anyOf: ["aviation", "plane-crash", "aircraft"] },
  // Same fix cost "geopolitics" as a loose match for "politics" (the
  // prefix-guard can't distinguish a meaningful compound like
  // geo-politics from a coincidental collision like dif-fusion) -- an
  // accepted, deliberate precision/recall trade-off. 4 genuinely
  // politics-tagged items, honestly sparse.
  { query: "politics", status: "sparse", checkTop: 4, anyOf: ["politics"] },
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

/* ---------- 4. diversity: no show dominates, except where honesty requires it ---------- */

/* Rich, multi-show topics: no show should appear more than PER_SHOW_CAP
   times, and this specifically targets the founder-flagged complaint
   ("true crime cold case" returning Casefile 2x + Crime Junkie 2x is
   FINE at exactly the cap -- the bug was picks being MUCH more
   concentrated than that before diversify() existed). */
for (const query of ["nuclear fusion energy", "true crime cold case", "startups and venture capital", "comedy"]) {
  const { status, picks } = search(query);
  if (status !== "ok") continue;
  const counts = [...showCounts(picks).values()];
  check(`"${query}" diverse: no show >${SE.PER_SHOW_CAP}x in top-10`, counts.every((n) => n <= SE.PER_SHOW_CAP),
    `show counts: ${JSON.stringify([...showCounts(picks).entries()])}`);
  const distinctShows = showCounts(picks).size;
  check(`"${query}" diverse: at least 4 distinct shows in a 10-pick result`, distinctShows >= 4,
    `only ${distinctShows} distinct shows: ${JSON.stringify([...showCounts(picks).keys()])}`);
}

/* Honesty must survive diversity: a genuinely single-show sparse topic
   (bbq) or a direct show-name query (smartless) must NOT be shrunk by
   the per-show cap -- diversify()'s backfill exists exactly for this. */
{
  const bbq = search("how bbq works");
  check(`"how bbq works" (single-show sparse) keeps all 4 picks, not capped down`, bbq.picks.length === 4,
    `got ${bbq.picks.length} picks`);
  const smartless = search("smartless");
  check(`"smartless" (direct show-name query) isn't capped to ${SE.PER_SHOW_CAP}`, smartless.picks.length > SE.PER_SHOW_CAP,
    `got ${smartless.picks.length} picks, expected the full un-capped list since there's nothing to diversify with`);
}

/* ---------- 5. listened-history down-weight: nudges rank, never excludes ---------- */

{
  const query = "nuclear fusion energy";
  const unweighted = search(query);
  const weighted = search(query, { listenedShows: new Set(["Lex Fridman Podcast"]) });
  const rankUnweighted = unweighted.picks.findIndex((p) => p.i.show === "Lex Fridman Podcast");
  const rankWeighted = weighted.picks.findIndex((p) => p.i.show === "Lex Fridman Podcast");
  check(`listened-history down-weight pushes Lex Fridman Podcast lower in "${query}"`,
    rankUnweighted === 0 && rankWeighted > rankUnweighted,
    `unweighted rank=${rankUnweighted}, weighted rank=${rankWeighted}`);
  const weightedCount = weighted.picks.filter((p) => p.i.show === "Lex Fridman Podcast").length;
  check(`listened-history down-weight doesn't exclude Lex Fridman Podcast outright`, weightedCount > 0,
    `weighted picks contain 0 Lex Fridman Podcast episodes -- down-weight should nudge, not exclude`);
}

/* ---------- 6. substring-collision regressions (issue A) ---------- */

const collisionCases = [
  { query: "the best podcast about fusion", bannedId: "twiml-ai--diffusion-llms", note: "fusion should not match inside diffusion" },
  { query: "rome", bannedId: "huberman-lab--science-of-attraction-compatibility-and-romance-dr-paul-east", note: "roman should not match inside romance" },
  { query: "an nba team", bannedId: "railway-mania--richard-peacock", note: "team should not match inside steam" },
];
for (const c of collisionCases) {
  const { picks } = search(c.query);
  check(`"${c.query}" excludes ${c.bannedId} (${c.note})`, !picks.some((p) => p.i.id === c.bannedId),
    `still present in picks`);
}

/* ---------- 7. generic-filler stress test: filler words never dominate ---------- */

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
