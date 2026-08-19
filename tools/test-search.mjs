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
     3. Honest coverage: for topics the catalog genuinely doesn't cover (a
        basketball team by name, or a sport it barely mentions), status must
        be "empty" -- never a padded list of unrelated filler. For a topic
        whose coverage is real but THIN, the empty claim is gated on coverage
        counted from the catalog rather than pinned to a tier label (see the
        "nba" case), because the nightly refresh grows the catalog by design
        and a hard-coded tier breaks the moment it does. What is asserted
        UNCONDITIONALLY there is purity: whatever comes back must name the
        subject.
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
     7. Proper-noun matching: a multi-word show/host query ("lex fridman")
        is rescued by the full-phrase show-name bonus even when neither
        word crosses the normal per-term threshold alone, AND a lone
        coincidental word match (e.g. "lex" in an unrelated Ancient Rome
        episode) no longer satisfies it once AND-gating applies.
     8. Newly-authored/fixed concepts (bulk expansion against
        data/top-topics.json + data/topic-coverage-report.json, hand-
        verified against the CURRENT semantic-index.json since the report
        predates this PR and #16): nutrition, parenting, relationships,
        world-war-2 (now routes to the correct history/military-modern,
        not -ancient), video games, stand-up comedy, design, paranormal,
        fiction/audio-drama. Coverage-gated throughout -- topics with no
        real catalog content (e.g. gardening, chess: verified zero tag
        hits despite the coverage report listing them) got no concept.
     9. `sports` concept cleanup: near-zero-coverage league/team terms (nba,
        basketball, baseball, tennis, ...) removed so a bare "nba"/
        "basketball" query no longer floods in generic sports-science
        content and instead returns only items that name the league
        themselves -- ONE item for "nba" before the 2026-08-17 refresh, two
        after it (see §3) -- verified via the validator's zero-coverage-term
        WARN (tools/validate-semantic-index.mjs), which flagged `basketball`
        as strictly zero (tagDF=0 AND corpusDF=0); `nba` and the rest were
        removed by hand after direct verification they're negligible
        (tagDF<=1, i.e. one tangential mention for an entire league name).
        Corrected 2026-08-17: this said the WARN flagged "exactly these two"
        as strictly zero. It flagged one. Re-measured at the cleanup commit
        itself (040c9f6): `basketball` tagDF=0/corpusDF=0, but `nba`
        tagDF=1/corpusDF=0.00102 -- it was always the hand-removed,
        one-tangential-mention case the next clause describes, and pretending
        it was strictly zero is what made "no NBA content in catalog" look
        true enough to assert in §3 for the 24 days between 040c9f6
        (2026-07-24) and the refresh that broke it.

     9. Ordering and the strong bar agree on "better" (#216): results are
        ORDERED by `matched` then `sum` but the bar cuts on `sum` alone, so the
        two could disagree and classifyResults' narrow branch then showed the
        worse of two results. Asserted as a coupling -- the ranking must be
        monotone in the key the bar cuts, the prefix must hold every bar-clearer
        and end at one, and no sparse answer may skip a result it ranks above one
        it shows. The witness lives in test/search-tiering.test.js; see §9 for
        why the two suites split that way.
        (Two sections are numbered 9. That is pre-existing and left alone rather
        than renumbered: "§9" is cited by number from search-engine.js twice and
        from test/search-tiering.test.js twice, and silently moving what it points
        at is worse than a visible duplicate.)

    10. Catalogue growth cannot retune the interpreter (#275): every query's
        interpretation -- expansion terms, weights, broad flags, df multiplier
        tier -- is identical against today's corpus and against the same corpus
        duplicated. The document-frequency thresholds are fractions, so size alone
        cannot move a term across one; before #275 they were absolute counts and
        137 terms changed bucket at 2x. 4x, and the witness that the absolute rule
        drifts, live in test/search-df-scaling.test.js for the runtime reasons
        stated there and in §10.

   Usage: node tools/test-search.mjs [--tiering]
   Exit code 0 = all pass, 1 = at least one failure (readable report to stdout).
   --tiering also prints the per-query tiering table (bar, bar-clearers, prefix,
   picks, and the #216 inversions) after the assertions have run. */

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

/* Every query this file searches with DEFAULT options, and what it got back.
   §9 and the --tiering report both read this instead of carrying a second list
   of queries: a hand-maintained list would drift the day someone adds a case
   above and forgets, and a §9 that silently stops covering a query is the
   "green because it asserts nothing" failure this file keeps recording. It also
   costs no extra searches -- §9 grades the runs that already happened.
   Keyed on the query, DEFAULT OPTIONS ONLY: §5's listened-history run passes
   `listenedShows` and would otherwise overwrite the plain run with a
   deliberately re-ranked one. */
const searched = new Map();

function search(query, opts) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(query, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  const { status, picks } = SE.classifyResults(results, opts);
  const out = { status, picks, interp, results };
  if (opts === undefined) searched.set(query, out);
  return out;
}

/* True if item's tags/title/show/hook/topics contain `needle`.
 *
 * THE ORACLE MUST NOT BE LOOSER THAN THE RANKER IT GRADES. Two ways this was,
 * both fixed 2026-08-17, and the second was found by review after the first fix
 * was already written:
 *
 *   1. It could not see `hook`, which `scoreMatch` scores at +1.5. An oracle
 *      blind to an input its subject reads is measuring the wrong object.
 *   2. It matched with a bare `text.includes(needle)` while the ranker uses a
 *      collision guard. So the oracle admitted `software`, `toward`, `warm` and
 *      `Warner` as "war"; `romance` as "roman"; `confusion` as "fusion" — and
 *      the last two are collisions this file separately asserts the RANKER must
 *      not make (see the substring-collision checks below). The oracle was
 *      contradicting its own test file.
 *
 * Both are fixed by sharing the ranker's matcher instead of reimplementing it:
 * `hitText`/`hitTag` are now exported from search-engine.js. Reimplementing them
 * here is what allowed the two to drift in the first place, so don't.
 *
 * Net effect on the whole `fullPool()` (NOT `discover.items`, which misses the 27
 * session episodes; see fullPool's comment), summed over the 51 topical needles:
 * 1,292 -> 1,246 at the time, a NARROWING of 46 despite gaining a whole new
 * field, because the collision guard removes more than `hook` adds.
 *
 * Then #218 widened the SUFFIX side of the same matcher, and the direction
 * reversed. Re-measured on today's pool (1,540 items, not the 1,516 those figures
 * were taken on — the nightly grows it): 1,261 -> 1,284, a widening of 23, of
 * which the >=4-char suffix set is +9 and the new under-4-char plural is +14.
 * FOUR needles move and every one of them moves UP: grill 0 -> 7 (it could not
 * match "grilling"), war 87 -> 101 ("wars"), murder 29 -> 30 ("murdering"),
 * crash 9 -> 10 ("crashes"). Nothing narrows, and the needles a widening would
 * be expected to endanger do not move at all: politics stays 35 and roman stays
 * 14, because `geopolitics` and `romance` are PREFIX collisions and the prefix
 * guard is deliberately untouched.
 *
 * These needles are also where `ed` was cut from the suffix set: it added 4 items
 * here and looked free, and measuring the whole vocabulary instead showed most of
 * what it adds is filler participles on terms that are not needles at all. A
 * 51-needle blast radius is the right instrument for "did anything break"; it is
 * the wrong one for "is this suffix worth having". */
function itemHas(item, needle) {
  const n = needle.toLowerCase();
  const tags = itemTags.tags?.[item.id] || [];
  if (tags.some((t) => SE.hitTag(t, n))) return true;
  const text = [item.title, item.show, item.hook, (item.topics || []).join(" ")]
    .join(" ").toLowerCase();
  return SE.hitText(text, n);
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
  // Flipped sparse->ok by catalogue growth: the 2026-07-30 refresh's BBQ
  // Central episode tipped the strong count past RICH_MIN -- same
  // catalogue-growth flip as "plane crashes" (2026-08-06) below. The
  // on-topic needle check is what guards quality here, not the label.
  { query: "how bbq works", status: "ok", checkTop: 4, anyOf: ["bbq", "barbecue", "grill"] },
  /* `grill` ALONE, and that is the whole point of the case (#218). The case
     above passes on `bbq`/`barbecue`, so `grill` contributing NOTHING was
     invisible in it -- an OR over needles cannot tell you that one of them is
     dead. It was dead: `hitText` allowed a term plus an optional trailing "s"
     and no more, so `grill` matched 0 of the pool's 1,540 items while all 7
     candidates carried the tag `grilling`, and this assertion is red on main
     with every pick off-topic. The query itself was NOT broken on main -- the
     `bbq` concept hand-authors both `grill` and `grilling`, so expansion
     rescued the picks while the matcher stayed wrong, which is exactly how this
     survived. Single-needle on purpose: a second needle would re-hide it. */
  { query: "grill", status: "ok", checkTop: 5, anyOf: ["grill"] },
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
  // "planetary-radio" match was removed, which at the time left this
  // honestly sparse. The nightly pipeline has since grown real aviation
  // coverage (e.g. the 2026-08-06 refresh's Flight Safety Detectives
  // episode tipped the strong count past RICH_MIN), so "ok" is now the
  // honest status -- same catalogue-growth flip as the bbq case below
  // (2026-07-29). The on-topic needle check is what guards quality here,
  // not the sparse/ok label.
  { query: "plane crashes", status: "ok", checkTop: 5, anyOf: ["aviation", "plane-crash", "aircraft", "flight", "crash"] },
  // Same fix cost "geopolitics" as a loose match for "politics" (the
  // prefix-guard can't distinguish a meaningful compound like
  // geo-politics from a coincidental collision like dif-fusion) -- an
  // accepted, deliberate precision/recall trade-off. 4 genuinely
  // politics-tagged items, honestly sparse.
  { query: "politics", status: "sparse", checkTop: 4, anyOf: ["politics"] },
  // Bulk concept-expansion additions (PR2) -- each grounded in verified
  // real tag coverage, see tools/validate-semantic-index.mjs for the
  // coverage audit that backs every one of these.
  { query: "nutrition", status: "ok", checkTop: 5, anyOf: ["nutrition"] },
  { query: "parenting", status: "ok", checkTop: 5, anyOf: ["parenting"] },
  { query: "relationships", status: "ok", checkTop: 5, anyOf: ["relationships", "dating", "marriage"] },
  { query: "world war 2", status: "ok", checkTop: 5, anyOf: ["war", "ww2", "wwii", "pacific"] },
  { query: "video games", status: "ok", checkTop: 5, anyOf: ["game", "gaming", "video-games"] },
  { query: "stand up comedy", status: "ok", checkTop: 5, anyOf: ["comedy", "comedian", "stand-up"] },
  { query: "design", status: "ok", checkTop: 5, anyOf: ["design"] },
  { query: "paranormal", status: "ok", checkTop: 3, anyOf: ["paranormal", "supernatural"] },
  { query: "fiction podcast", status: "ok", checkTop: 5, anyOf: ["fiction", "audio-drama"] },
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

/* ---------- 3. honest coverage for absent and thin topics ---------- */

/* "nba"/"basketball" joined this list in PR2 -- before the `sports` concept
   cleanup, a bare "nba" query flooded in generic sports-science content via
   full concept-vocabulary expansion. With the near-zero-coverage league terms
   removed, only items naming the league themselves can match. ("nba" has
   since left this list and become a coverage-gated case of its own, directly
   below -- the catalog grew real NBA content on 2026-08-17.)
   The team names stay genuinely absent, and both collide with ordinary prose
   ("warriors" reaches an episode of The Ancients about Scotland's first
   warriors; and "team" reaches "steam", the §6 collision case below), so
   anything returned here would be filler by construction.
   `basketball` stays here too, for a reason worth writing down: exactly ONE
   item in the pool carries the word (Freakonomics' Gary Gulman episode,
   which mentions basketball in passing in a comedy/mental-health hook), and
   one result can never clear classifyResults' two-strong-matches floor. The
   2026-08-17 refresh's real NBA episode is tagged `nba`, not `basketball`,
   so it does not change this -- a tagging gap, deliberately left to the
   catalogue owner rather than patched from inside the oracle. */
for (const query of ["the lakers", "warriors", "basketball"]) {
  const { status, picks } = search(query);
  /* The reason is "fewer than two catalog items name it", NOT "no such
     content exists" -- `basketball` names one. Stating the mechanism in the
     label is the whole lesson of the "nba" case below. */
  check(`"${query}" is honestly empty (fewer than two catalog items name it)`, status === "empty" && picks.length === 0,
    `got status=${status}, picks=${picks.length}`);
}

/* "nba" was in that list until the 2026-08-17 nightly refresh (+24 episodes,
   PR #214) turned it red -- and the label it carried there, "no NBA-team
   content in catalog", was already wrong before that. What actually kept the
   query empty was classifyResults' floor: it returns "empty" whenever fewer
   than two results clear the relative strong bar, and the catalog held
   exactly ONE item naming the league (Just Fly Performance Podcast 515, an
   NBA performance coach on tendon biomechanics -- tagged `nba`, "NBA" in its
   hook). The refresh added a second and squarely on-topic one (Happier's
   Jalen Brunson episode -- tagged `nba`, "NBA" in both title and hook), which
   flipped the query empty -> sparse with 2 picks. NEITHER pick is a ranker
   false positive: both name the league in prose a listener reads, and both
   match through the same `hitTag`/`hitText` the ranker scores with.

   So it becomes a real topical case -- split into the two claims the old
   one-liner had fused together, because they do not deserve the same
   treatment:

   PURITY, asserted unconditionally: whatever comes back must name the
   league. This is the half with teeth, and the half the old guard was really
   protecting. Verified by reproduction, not by argument: re-adding
   `nba`/`basketball` to the `sports` concept in data/semantic-index.json
   recreates the pre-cleanup flood, and this check fails loudly on it -- 9
   off-topic picks of 10 on main's pool, 8 of 10 on the 2026-08-17 refresh's,
   and they are not all sports science either: "The Fascist World Cup:
   Mussolini's Football Dictatorship", "Can the LA Olympics in 2028 be a
   catalyst for clean energy", "The Non-BS Science of Manifestation". Ungated
   on purpose: it is trivially true when nothing comes back, so it costs
   nothing in the empty world, and an ungated check cannot be switched off by
   a gate that guesses wrong.

   HONEST EMPTY, gated on coverage counted from the catalog: below
   classifyResults' two-strong floor the honest answer is nothing at all.
   Gated rather than pinned to a tier, because a pinned tier is exactly what
   broke -- three times in nine days, twice as a pinned tier ("how bbq works"
   2026-07-30, "plane crashes" 2026-08-06) and once as a pinned pick count
   (bbq again, 2026-07-29 -- see §4). The nightly grows the catalog by
   design. Assert the behaviour, never the count.

   THERE IS DELIBERATELY NO RECALL ASSERTION -- no "2 items name the league,
   so search must show them". It was written, and it was a landmine: the
   strong bar is RELATIVE (results[0].sum * STRONG_RATIO), so a second item
   whose only mention is its `nba` tag scores 2.5 x 1.35 = 3.375 against a bar
   of 4.05 and classifyResults correctly returns empty. Deleting one "NBA"
   from one hook -- one nightly hook-authoring edit -- turns that into a red
   battery over behaviour that is working as designed. No static predicate can
   forecast a relative bar, so a recall claim here can only ever be a tripwire
   on correct behaviour. Whether search should hide real coverage this way is
   a genuine question; it belongs in an issue against classifyResults, not in
   a nightly-blocking assertion.

   `nba` is the whole needle set on purpose. The query is one token, it
   expands to no concept (interpretQuery yields a single own-source term), so
   `nba` is the only thing that can match. Adding `basketball` would be worse
   than dead weight: if someone later re-adds `nba` to a concept that also
   carries `basketball`, a `basketball` needle would let the flood's own
   filler satisfy the purity check and mask the exact regression it exists to
   catch. */
{
  const needle = "nba";
  /* SELF-CONTAINED, and it has to be. This started as
     `itemHas(i, needle) || nbaWord.test(hook)`, which was wrong in a way worth
     recording: the word boundary guarded the hook clause and NOTHING else,
     because itemHas() matches tags/title/show/topics by bare substring -- and
     those are the fields that dominate the count. So the predicate over-counted,
     and over-counting is the dangerous direction: it switches the gate OFF.
     One plausible refresh does it. A Flight Safety Detectives episode titled
     "NBAA Business Aviation Convention" -- NBAA is the National Business
     Aviation Association, that show is ALREADY in the catalog (it is the one §2
     credits for the plane-crashes flip), and `"nbaa".includes("nba")` is true --
     takes `covered` 1 -> 2, deactivates the honest-empty claim, leaves purity
     vacuous at 0 picks, and the battery then asserts NOTHING about "nba" while
     staying green. Not a contrived mutation; one nightly away.
     So it mirrors hitTag/hitText's `length < 4` branches itself rather than
     borrowing half of one: tags by exact-or-hyphen-segment, prose by word
     boundary. It also reads `hook`, which itemHas() does not (§2) but
     scoreMatch() scores at 1.5 x 1.35 = 2.025 -- a hook-only mention would
     otherwise be invisible to the count and fully visible to the ranker, and the
     catalog already holds an item in that shape (the Gary Gulman episode names
     basketball only in its hook). Widening the shared itemHas() instead would
     loosen every §1/§2 on-topic check, a separate decision with a 51-needle
     blast radius.
     `show` is deliberately NOT read. scoreMatch weights a show hit at 1.0,
     below the 1.2 per-group threshold, so an item whose ONLY league mention is
     its show name can never reach `results` at all -- counting it would inflate
     `covered` and switch the gate off for an item the ranker will never return,
     which is the NBAA failure in a different costume. No catalog show currently
     contains the word, so this is prophylactic.
     COLLAPSED ONTO THE SHARED MATCHER, 2026-08-17 (#219), and the hand-mirror is
     gone. What is shared is the MATCHING; what stays local is the FIELD LIST,
     which is the part with a reason (`show` excluded, `hook` included, both
     argued above). Sharing only half of a predicate is what this file warns
     about, so to be explicit: `taggedLeague`/`titleHit`/`topicsHit` below now use
     search-engine.js's own hitTag/hitText, and differ from itemHas() only in
     which fields they read.
     This was not cosmetic by the time it was done. #218 gave the under-4-char
     branch a plural allowance, so the shared matcher now admits "NBAs" while the
     hand-mirror's `\bnba\b` did not -- leaving the mirror STRICTLY NARROWER than
     the ranker. Under-counting `covered` is the safe direction for the
     honest-empty gate, but `namesLeague` also backs the PURITY check, where a
     narrower predicate is a false RED: one item saying "NBAs" in a hook and the
     battery blames the ranker for a pick it was right to return. That is the
     third instance of the same defect in this one file, from the same cause. */
  const taggedLeague = (i) => {
    const tags = itemTags.tags?.[i.id] || [];
    return tags.some((t) => SE.hitTag(t, needle));
  };
  const titleHit = (i) => SE.hitText(i.title.toLowerCase(), needle);
  const topicsHit = (i) => SE.hitText((i.topics || []).join(" ").toLowerCase(), needle);
  const namesLeague = (i) =>
    taggedLeague(i) ||
    SE.hitText([i.title, i.hook, (i.topics || []).join(" ")].join(" ").toLowerCase(), needle);

  const covered = pool.filter(namesLeague).length;
  const { status, picks, results, interp } = search(needle);

  const offTopic = picks.filter((p) => !namesLeague(p.i));
  check(`"nba" returns only items that name the league`, offTopic.length === 0,
    `got status=${status}, picks=${picks.length}; off-topic: ${offTopic.map((p) => `${p.i.id} "${p.i.title}"`).join(", ")}`);

  /* RETRIEVAL, asserted on the RAW `results` array rather than on `picks`, and
     that distinction is the whole reason this can exist at all. `results` is
     what searchWithRelaxation returns: gated on the primary token and
     `sum > minScore`, sorted, untruncated, and computed BEFORE classifyResults
     derives its relative `bar`. So this structurally cannot reproduce the
     landmine that got the old recall assertion deleted -- no relative bar is
     involved, and an item's presence here does not depend on how well any OTHER
     item scored. (It also passes `passesFilters`, vacuous here since a bare
     "nba" carries no duration/format modifier, and never takes a relaxation
     branch for the same reason.)
     Restricted to STRONG-signal items, and the floor is DERIVED, not hard-coded,
     because scoreMatch's df multiplier is a function of the query token's own
     document frequency: `best * dfMultiplier(group.df)`, where `group.df` is
     tagDF("nba"). At 1.35 a tag hit is 3.375, topics 4.05, title 2.7, all clear
     of minScore 2. But one tier down the multiplier drops to 1 and a title-only
     item scores EXACTLY 2.000, which the strict `sum > minScore` gate rejects --
     so a hard-coded field list would start false-reding on catalogue change and
     blame "a scoring regression". That is the failure this whole case exists to
     eliminate, so the field list is filtered by the tier actually in force.
     Fields sum, so a single field is a floor on the score, never a ceiling.
     THE TIERS ARE READ FROM THE ENGINE, NOT MIRRORED HERE, as of #275. This was
     an inline `df <= 10 ? 1.35 : df <= 30 ? 1 : 0.75` -- a fourth-copy-of-the-
     matcher (#249) one level up, an oracle reimplementing its subject. #275
     normalised `tagDF` to a FRACTION of the tag map, and the mirror would have
     survived that silently: every fraction is <= 10, so every term would have
     been reported at 1.35, `strongFields` would have kept all three fields, and
     the check would have gone quietly wrong in the false-RED direction the
     paragraph above is about. `SE.dfMultiplier` cannot drift from scoreMatch
     because scoreMatch calls it.
     Deliberately excluded at every tier: show-only (1.0, which never clears the
     1.2 per-group threshold, so it is not retrievable by design) and hook-only
     (2.025, which clears minScore by 1.25% and would become a false red the day
     that constant moves).
     HONEST ABOUT ITS REACH, because it is easy to overrate. The suite catches
     the flood below by other means too, so this is not the only net. On the real
     pools it would NOT catch #219-style matcher drift: break hitTag's short
     branch and both real items keep prose hits (Chris Chase falls to hook-only
     2.025, still retrieved), so this check stays green -- while on the refresh's
     pool that same drift silently flips the query sparse -> empty and the whole
     battery still passes, because the loss happens at the relative bar this file
     deliberately refuses to assert. It earns its place in one specific state:
     when `covered` is wrong and purity is vacuous, it is the only thing left
     asserting anything at all about this query. */
  const dfMult = SE.dfMultiplier(interp.groups[0]?.df ?? 0);
  const strongFields = [[2.5, taggedLeague], [3, topicsHit], [2, titleHit]]
    .filter(([weight]) => weight * dfMult > 2);
  const stronglySignalled = pool.filter((i) => strongFields.some(([, hit]) => hit(i)));
  const unretrieved = stronglySignalled.filter((i) => !results.some((r) => r.i.id === i.id));
  check(`"nba" retrieves every item carrying a signal strong enough to clear minScore alone`,
    unretrieved.length === 0,
    `${stronglySignalled.length} item(s) qualify at df multiplier ${dfMult}; never reached the result set: ${unretrieved.map((i) => `${i.id} "${i.title}"`).join(", ")} -- each clears minScore on one field alone, so a miss is a scoring or gating regression, not a tiering choice`);

  if (covered < 2) {
    check(`"nba" is honestly empty (only ${covered} catalog item(s) name the league, below the two-strong floor)`,
      status === "empty" && picks.length === 0,
      `got status=${status}, picks=${picks.length} -- if these picks DO name the league, the coverage count above is what is wrong, not the engine`);
  }
  /* THE GATE STILL HAS A DATA-ONLY OFF-SWITCH, and saying so is the point of
     writing it down. Closing the NBAA hole closed the SUBSTRING route, not every
     route. Two ordinary hook mentions of the league (say a Business Breakdowns
     episode pricing an NBA jersey patch) take `covered` to 3 on main's data while
     scoring 2.025 each -- under a 2.700 bar set by the one tagged item, so
     `results` has three entries, `classifyResults` returns empty, and the gate
     switches off against 0 picks. `covered >= 2` is a proxy for "two items could
     clear the RELATIVE strong floor", and a proxy is all it can be: gating on the
     strong-signal count instead just trades this for a false red when three
     hook-only items arrive with no dominant tagged one. That is the same trade
     that got the recall assertion deleted, taken the same way -- prefer silence
     to a nightly-blocking assertion over correct behaviour -- and the retrieval
     check above is what keeps that silence from being total. */
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
  // Assert the BEHAVIOUR (the per-show cap did not shrink this), not a pick
  // count. The count is a function of catalogue size, which the nightly grows
  // by design — this assertion was `=== 4` and broke the nightly pipeline on
  // 2026-07-29 when a new bbq episode landed and made it 5. The `smartless`
  // check below was always written this way; this one now matches it.
  const bbq = search("how bbq works");
  check(`"how bbq works" (single-show sparse) isn't capped to ${SE.PER_SHOW_CAP}`, bbq.picks.length > SE.PER_SHOW_CAP,
    `got ${bbq.picks.length} picks, expected more than the per-show cap since backfill should keep the sparse list intact`);
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
/* ASSERTED ON RAW `results`, NOT ONLY ON `picks`, and that was found by
   mutation rather than by reading (#218). Removing the prefix guard from
   search-engine.js -- deleting the exact mechanism these three cases exist to
   protect -- left ALL THREE of them GREEN. The reason is specific and worth
   recording: the `diffusion` collision does come straight back, re-entering
   retrieval at raw index 13 with sum 6.00 against a relative strong bar of
   5.50, so it is genuinely a strong match again; it just lands outside the
   10-item truncation that `picks` applies. An assertion that reads only `picks`
   cannot see a collision that ranks 11th, which is most of them.
   `results` is the honest surface for this claim: gated on the primary token and
   `sum > minScore`, sorted, UNTRUNCATED, and computed before classifyResults
   derives any relative bar -- the same argument the "nba" retrieval check above
   makes for reading it. With the guard intact all three banned ids are absent
   from `results` entirely, so this costs nothing today.
   ONE OF THE OTHER TWO IS NOT VACUOUS AFTER ALL, corrected 2026-08-18 (#249).
   This said both stayed vacuous because "the romance item never reaches `results`
   -- `roman` arrives as a low-weight expansion whose title-only hit does not clear
   minScore", i.e. that scoring kept it out. That was reasoned, not measured, and
   it is wrong. Measured: with the prefix guard deleted the romance item scores
   0.00 -- not a low score, NO MATCH -- because "romance" is `roman` plus letters
   AFTER the term, and it is the TRAILING `(?![a-z0-9])`, not the leading
   lookbehind, that blocks it. The prefix mutation was simply the wrong mutation
   for this case.
   Delete the trailing guard instead and this case goes red exactly as intended:
   the Huberman romance episode is retrieved for "rome" and both assertions fire.
   So two of the three §6 cases have real witnesses, one per guard:

     "...about fusion" / diffusion   witnessed by deleting the LEADING lookbehind
     "rome" / romance                witnessed by deleting the TRAILING lookahead

   THE THIRD IS GENUINELY VACUOUS AND CANNOT BE FIXED HERE. "an nba team" is
   AND-gated as a proper-noun query (neither `nba` nor `team` is concept
   vocabulary), so every primary token must match and no item carries both --
   the query returns nothing whatever the matcher does. That is a property of the
   query shape, not of the guard, so no matcher mutation can ever witness it and
   no rewrite of this case will change that. It is kept because it costs nothing
   and documents the collision; it is not evidence of anything.
   The fast direct witnesses live in test/search-matcher.test.js, where the two
   guards are now pinned as SEPARATE tests -- they were one test named after the
   prefix guard, which is what made a trailing-guard claim look like a
   prefix-guard claim and produced the wrong note above. */
for (const c of collisionCases) {
  const { picks, results } = search(c.query);
  check(`"${c.query}" excludes ${c.bannedId} from picks (${c.note})`, !picks.some((p) => p.i.id === c.bannedId),
    `still present in picks`);
  check(`"${c.query}" never even retrieves ${c.bannedId} (${c.note})`, !results.some((r) => r.i.id === c.bannedId),
    `absent from picks but PRESENT in the raw result set -- the collision is back and is only hidden by the 10-pick truncation`);
}

/* ---------- 6b. sense-locked stems: off-sense inflections (#248) ---------- */

/* #246 widened the suffix set to `(?:s|es|ing)?`, which is what `grill`/`grilling`
   needed and what `train`/`training` did not: `train` is a term of the `trains`
   concept and carries only the railway noun, so 32 fitness, dog-training and
   AI-pre-training items started matching a railway term, two of them inside the
   top 10 for "train history". #248, fixed by SENSE_LOCKED_STEMS in
   search-engine.js.
   ASSERTED ON RAW `results` AS WELL AS `picks`, for exactly the reason §6 records
   above: the `diffusion` case proved that a 10-pick truncation hides a collision
   that ranks 11th, and an assertion that cannot see rank 11 is most of the way to
   vacuous. Here that is not hypothetical -- of the two items below, the speed-
   training episode sat at pick 10 and the pre-training one at pick 8, and the
   other 30 off-sense items were in `results` behind them, one catalogue refresh
   away from being promoted. `results` sees all of them.
   NOT a needle check. A needle list ("must contain train/rail/railway") would
   have to enumerate the legitimate expansion -- `transit`, `locomotive`,
   `steam-engine`, and a Gershwin episode whose hook names a train -- and would go
   red on catalogue growth rather than on a regression. Banned ids are the same
   instrument §6 uses, and they are specific to the mechanism. */
const senseLockCases = [
  { query: "train history", bannedId: "corecursive--pre-training-wall",
    note: "`train` should not match inside training -- AI pre-training is the wrong verb" },
  { query: "train history", bannedId: "just-fly-performance-podcast--scott-leech",
    note: "`train` should not match inside training -- speed training is the wrong verb" },
  { query: "stock market", bannedId: "the-peter-attia-drive--403-peptides-separating-scientific-promise-from",
    note: "`market` should not match inside marketing -- to advertise is the wrong verb" },
  { query: "stock market", bannedId: "maintenance-phase--salt",
    note: "`market` should not match inside marketing -- the tag is wellness-marketing" },
];
for (const c of senseLockCases) {
  const { picks, results } = search(c.query);
  check(`"${c.query}" excludes ${c.bannedId} from picks (${c.note})`, !picks.some((p) => p.i.id === c.bannedId),
    `still present in picks`);
  check(`"${c.query}" never even retrieves ${c.bannedId} (${c.note})`, !results.some((r) => r.i.id === c.bannedId),
    `absent from picks but PRESENT in the raw result set -- the off-sense inflection is back and is only hidden by the 10-pick truncation`);
}

/* THE TEMPTING WRONG FIX, pinned so it cannot be taken. #248 could be made green
   by deleting `train` from the `trains` concept, and that would be a regression
   dressed as a fix: `interpretQuery` triggers a concept on an exact query token,
   so removing the term stops the natural singular "train" from triggering
   `trains` at all -- no `transport/trains` topic boost, no expansion to
   `railway`/`locomotive`/`rail`. That is precisely the defect #218 exists to fix,
   which is why #248 names it and refuses it.
   So the vocabulary side is asserted directly, on the interpretation rather than
   on the picks: a ranking assertion could stay green while the concept quietly
   stopped firing, because the literal token `train` still matches railway items
   by itself. This reads the mechanism instead. */
{
  const { interp } = search("train");
  check(`"train" still triggers the trains concept (topic boost survives #248)`,
    interp.topicBoosts.has("transport/trains"),
    `topicBoosts=${JSON.stringify([...interp.topicBoosts])} -- if transport/trains is absent, the term "train" was probably deleted from the concept, which is the fix #248 rules out`);
  const expansion = interp.groups[0]?.terms ?? new Map();
  const expected = ["railway", "locomotive", "rail", "trains"];
  const missing = expected.filter((t) => !expansion.has(t));
  check(`"train" still expands to the railway vocabulary (${expected.join("/")})`, missing.length === 0,
    `missing from the expansion: ${missing.join(", ")} -- the sense lock must narrow what a TERM matches in text, never what a query token maps to`);
}

/* ---------- 7. proper-noun matching (fix B) ---------- */

{
  // Recall (B)(i): "lex fridman" -- neither word alone reliably crosses
  // the match threshold (the only real per-item signal is a flat +1
  // show-field hit each), so before the full-phrase show-name rescue this
  // returned nothing useful. Now it should be rich, and every pick should
  // genuinely be the show (the rescue only fires for the full phrase).
  const lex = search("lex fridman");
  check(`"lex fridman" status is ok (recall fix)`, lex.status === "ok", `got status=${lex.status}`);
  if (lex.status === "ok") {
    const wrongShow = lex.picks.filter((p) => p.i.show !== "Lex Fridman Podcast");
    check(`"lex fridman" every pick is actually the show`, wrongShow.length === 0,
      `off-show picks: ${wrongShow.map((p) => `${p.i.id} (${p.i.show})`).join(", ")}`);
  }

  // Precision (B)(ii): "lex" alone matches an unrelated Ancient History
  // Fangirl episode about "The Lex Juliae" (a Roman law) via the show/
  // title text -- neither "lex" nor "fridman" is concept vocabulary, so
  // this query is AND-gated: a lone "lex" hit is no longer enough.
  check(`"lex fridman" excludes the unrelated Lex Juliae episode`,
    !lex.picks.some((p) => p.i.id === "ancient-history-fangirl--lex-juliae"),
    `still present -- AND-gating for proper-noun queries isn't excluding a lone coincidental word match`);

  // "huberman lab": "lab" alone is common enough to match other shows
  // (Materialism, Off-Nominal, Lab to Market Leadership) via the
  // topic-phrase OR-gate ("lab" IS concept vocabulary via `computing`/
  // similar, so this ISN'T AND-gated) -- the fix here is recall, not
  // precision: real Huberman Lab episodes must now be findable at all.
  const huberman = search("huberman lab");
  const realHuberman = huberman.picks.filter((p) => p.i.show === "Huberman Lab");
  check(`"huberman lab" finds real Huberman Lab episodes (recall fix)`, realHuberman.length >= 2,
    `only found ${realHuberman.length}; picks: ${huberman.picks.map((p) => p.i.show).join(", ")}`);
}

/* ---------- 8. generic-filler stress test: filler words never dominate ---------- */

for (const query of ["how bbq works", "the history of jazz"]) {
  const { interp } = search(query);
  const broadOnly = interp.groups.filter((g) => g.broad).map((g) => g.token);
  const primaryPresent = interp.groups.some((g) => !g.broad);
  check(`"${query}" has a primary (non-broad) token`, primaryPresent,
    `all groups broad: ${JSON.stringify(broadOnly)}`);
}

/* ---------- 9. ordering and the strong bar agree on "better" (#216) ---------- */

/* #216: results were ORDERED by `matched` (desc, then `sum`) and CUT by a bar on
   `sum` alone, so the two could disagree about which of two results was better,
   and classifyResults' narrow branch then showed the worse one. search-engine.js
   now hands that branch `strongPrefix()` -- the prefix of the ranking ending at
   the last bar-clearer.
   THREE CLAIMS, AGGREGATED RATHER THAN PER-QUERY, because 3 x ~35 queries of
   near-identical output would bury the readable report this file exists to
   produce. Each names its offenders in the failure detail.
   WHAT THIS COVERS THAT test/search-tiering.test.js CANNOT, which is the reason
   to spend a governed-path edit on it: the fixtures over there are hand-sorted,
   so they assume the comparator instead of reading it. `strongPrefix` is only a
   meaningful cut if `results` really is ordered the way it presumes -- claim (a)
   is that coupling, over the live pool, and it is the one thing that goes red if
   searchWithRelaxation's sort changes without classifyResults changing with it.
   Conversely the WITNESS lives over there, not here: the disagreement only
   reaches the page on a sparse or single-show query, and on this pool today no
   query is both sparse and inverted -- so claim (c) is green on main by latency,
   not by argument, and saying so is better than implying it has teeth it does
   not have yet. The inversion IS live, on five "ok" queries where the wide
   branch passes the whole result array through and the bar filters nothing:
   "nuclear fusion energy" (15 results ranked above a shown one while scoring
   below the bar), "true crime cold case" (13), "plane crashes", "video games",
   "train history" (1 each). Run `--tiering` to see them. */
{
  const misordered = [];
  const barViolations = [];
  const skipping = [];
  for (const [query, { status, picks, results }] of searched) {
    if (!results.length) continue;

    /* (a) THE COUPLING. classifyResults' prefix is only a cut in the ranking if
       the ranking is monotone non-increasing in (matched, sum). Asserted on the
       raw `results` array -- untruncated, and computed before any relative bar
       exists -- for the reason §3 and §6 both give for reading it. */
    for (let k = 1; k < results.length; k++) {
      const prev = results[k - 1], cur = results[k];
      if (prev.matched < cur.matched || (prev.matched === cur.matched && prev.sum < cur.sum)) {
        misordered.push(`"${query}" at raw index ${k}: ${prev.i.id} (m${prev.matched}/${prev.sum.toFixed(3)}) ranked above ${cur.i.id} (m${cur.matched}/${cur.sum.toFixed(3)})`);
        break;
      }
    }

    /* (b) THE PREFIX IS WELL-FORMED: it is contiguous from the top, it holds
       every bar-clearer, and it ENDS at one. Those three together pin it
       uniquely, so this fails on an amnesty (`results.slice()`, which stops
       ending at a clearer) as well as on a regression to the filter (which stops
       being contiguous once anything sub-bar ranks above a clearer). */
    const bar = results[0].sum * SE.STRONG_RATIO;
    const prefix = SE.strongPrefix(results, bar);
    const contiguous = prefix.every((x, k) => x === results[k]);
    const holdsAll = results.every((x, k) => x.sum < bar || k < prefix.length);
    const endsStrong = prefix[prefix.length - 1].sum >= bar;
    if (!contiguous || !holdsAll || !endsStrong) {
      barViolations.push(`"${query}": prefix of ${prefix.length}/${results.length}${contiguous ? "" : ", NOT contiguous"}${holdsAll ? "" : ", drops a bar-clearer"}${endsStrong ? "" : ", does not end at a bar-clearer"}`);
    }

    /* (c) END TO END, on the branch where the bar actually selects what is shown.
       A "sparse" answer is drawn from the narrow branch, and diversify()'s
       backfill returns all of it when it fits under the cap -- so a sparse
       answer that is not exactly the prefix is the #216 defect, visible on the
       page. Gated on the engine's own `DEFAULT_CAP` -- not a literal 10 -- because
       at the cap the truncation is doing the cutting and prefix-closure is not the
       claim, and a hardcoded bound would either start false-reding or, worse,
       silently stop asserting on queries it should cover the day that constant
       moved.
       The single-show branch is NOT covered here and does not need to be: it
       keeps the bar-clearers rather than the prefix, precisely so that the
       per-show cap cannot promote a cross-show sub-bar result over the show's
       own strong episodes (see classifyResults). Telling it apart from the wide
       branch out here would mean mirroring the engine's own condition, which is
       the defect §3 and §6 both record; it is pinned on fixtures instead, in
       test/search-tiering.test.js, where the shows can be set directly.
       An earlier draft of this comment claimed the fixture suite covered that
       branch "by construction". It did not -- every fixture there defaulted its
       show to its id, so `singleShow` was false in all of them and the branch had
       no coverage anywhere. Review caught it; the fixtures now set shows. */
    if (status === "sparse" && picks.length < SE.DEFAULT_CAP) {
      const missing = prefix.filter((x) => !picks.some((p) => p.i.id === x.i.id));
      if (missing.length) skipping.push(`"${query}" (${picks.length} picks): ${missing.map((x) => `${x.i.id} m${x.matched}/${x.sum.toFixed(3)}`).join(", ")}`);
    }
  }

  check(`every query's ranking is monotone in (matched, sum), which is what makes the strong bar a cut in it`,
    misordered.length === 0,
    `${misordered.length} query/queries are ordered differently from what classifyResults assumes -- if searchWithRelaxation's comparator changed, strongPrefix is no longer a prefix of the ranking anyone sees:\n      ${misordered.join("\n      ")}`);

  check(`every query's strong prefix is contiguous, holds every bar-clearer, and ends at one`,
    barViolations.length === 0,
    `${barViolations.length} query/queries:\n      ${barViolations.join("\n      ")}`);

  check(`no sparse answer skips a result it ranks above one it shows (#216)`,
    skipping.length === 0,
    `${skipping.length} query/queries drop a better-ranked result while showing a worse one:\n      ${skipping.join("\n      ")}`);
}

/* ---------- 10. catalogue growth cannot retune the query interpreter (#275) ---------- */

/* THE DEFECT #275 REPORTS IS DRIFT, WHICH NO SINGLE-CORPUS ASSERTION CAN SEE.
   `tagDF` returned an absolute count and `interpretQuery` compared it against
   absolute thresholds, so the same query got a different expansion and different
   weights every night as the catalogue grew -- 52 terms across the expansion
   threshold and 125 across the score multiplier over one month of nightlies, with
   no code change. Every assertion in this file was green throughout, because every
   one of them reads TODAY's corpus. So the instrument has to be two corpora.

   THE SECOND CORPUS IS TODAY'S, DUPLICATED. Every item and every tag entry is
   cloned under a suffixed id, which cannot change what the catalogue is ABOUT: the
   share of the pool matching any term is exactly preserved. So every
   interpretation must be identical, and under the pre-#275 rule none of them was.

   ASSERTED ON THE INTERPRETATION, NOT ON `status` OR `picks`, and that is a
   measured choice rather than a convenient one. Duplication doubles the number of
   bar-clearing results, `RICH_MIN` is a COUNT of them, and `diversify`'s per-show
   cap sees each show twice -- so sparse queries legitimately go "ok" and picks
   legitimately reorder at 2x, on arithmetic that has nothing to do with document
   frequency. Measured on this pool, 5 of the 37 queries move status at 2x with
   every df bucket identical. Asserting status invariance here would be asserting
   something false and blaming #275 for classifyResults; asserting the
   interpretation is asserting exactly what #275 governs.

   WHAT THIS COVERS THAT test/search-df-scaling.test.js CANNOT, which is the reason
   to spend a governed-path edit on it: that suite walks the vocabulary term by
   term against the tag map. This walks the REAL QUERIES through the real
   `interpretQuery`, so it also covers `corpusDF`'s `broad` flag, the topic boosts,
   the alias expansion and the concept-support logic -- the whole object the ranker
   is handed. A term-level check cannot see a query whose interpretation changes
   through an interaction between those.

   ONE ctx PER CORPUS, deliberately: both memos are keyed on the ctx, so a shared
   one makes every term free after the first query and this section costs a few
   seconds rather than a second battery. */
{
  const suffixed = (k) => {
    const items = [];
    const tags = {};
    for (let n = 0; n < k; n++) {
      const sfx = n === 0 ? "" : `--grow${n}`;
      for (const it of discover.items) items.push({ ...it, id: it.id + sfx });
      for (const [id, t] of Object.entries(itemTags.tags)) tags[id + sfx] = t;
    }
    return { discover: { ...discover, items }, itemTags: { tags } };
  };

  /* The comparable shape of an interpretation: the tokens, whether each is broad,
     the multiplier tier its df selects, and every expansion term with its weight.
     Weights are rounded because they are products of literals -- 0.6 * 0.4 is not
     exactly 0.24 -- and an equality on raw floats would fail on formatting rather
     than on drift. */
  const shapeOf = (interp) => JSON.stringify({
    groups: interp.groups.map((g) => ({
      token: g.token,
      broad: g.broad,
      mult: SE.dfMultiplier(g.df),
      terms: [...g.terms].map(([t, i]) => [t, i.w.toFixed(6), i.source]).sort(),
    })),
    topics: [...interp.topicBoosts].sort(),
    hasPrimary: interp.hasPrimary,
    properNoun: interp.properNounQuery,
    filters: interp.filters,
  });

  const baseCtx = freshCtx();
  const base = new Map([...searched.keys()].map((q) => [q, shapeOf(SE.interpretQuery(q, baseCtx))]));

  /* 2x AND NOT ALSO 4x, and the reason is runtime measured rather than guessed.
     Both memos are O(corpus) per novel term, so a 4x pass costs this file another
     three minutes on top of its ~170 seconds -- for a claim that is scale-free, so
     the second doubling can only re-derive what the first one showed. 4x is
     asserted in test/search-df-scaling.test.js, where it runs against a slice of
     the tag map instead of the whole pool and costs seconds. */
  const grown = suffixed(2);
  const grownCtx = { semantic, itemTags: grown.itemTags, discover: grown.discover };
  const drifted = [];
  for (const [query, shape] of base) {
    if (shapeOf(SE.interpretQuery(query, grownCtx)) !== shape) drifted.push(`"${query}"`);
  }
  check(`no query's interpretation changes when the catalogue is duplicated 2x (#275)`,
    drifted.length === 0,
    `${drifted.length} of ${base.size} queries interpret differently at twice the catalogue with its composition untouched: ${drifted.join(", ")} -- ` +
    `a df threshold is reading an absolute count again, so search quality is drifting with catalogue size`);

  /* THE LADDER IS REACHED, which is this section's guard against vacuity. Every
     check above is trivially true on a corpus where no term is common enough to be
     demoted, on a vocabulary that stopped expanding, and on a `tagDF` that returns
     a constant -- so the exercised queries have to be shown to span the ladder
     rather than sit in one tier of it. Free: every value here is already memoized
     by the pass above.
     The DRIFT witness -- that the pre-#275 absolute rule really does move buckets
     under this same duplication, 137 expansion buckets and 206 multipliers at 2x
     over the 1,366-term vocabulary -- deliberately lives in
     test/search-df-scaling.test.js instead. It needs a full-vocabulary sweep at two
     corpus sizes, which is two more minutes here and seconds there, and one witness
     in the right place beats two in the wrong one. */
  const tiers = new Set();
  const demoted = [];
  let broadest = 0;
  for (const [query] of searched) {
    for (const g of SE.interpretQuery(query, baseCtx).groups) {
      tiers.add(SE.dfMultiplier(g.df));
      broadest = Math.max(broadest, g.df);
      /* SE.expansionBucket, not `> SE.TAG_DF_COMMON` re-derived here. Reading the
         constant and rewriting the comparison is what #275's own review found in
         three places, this one included -- the rule is exported for the same reason
         dfMultiplier is. The `info.w < 1` clause the first version carried is gone
         as redundant: interpretQuery's prune loop only ever reaches terms with
         `w < 1`, so a term that survived in the "0.4x" bucket was demoted there. */
      for (const [t] of g.terms) {
        if (SE.expansionBucket(SE.tagDF(t, baseCtx)) === "0.4x") demoted.push(`${query}:${t}`);
      }
    }
  }
  check(`the queries here span all three df multiplier tiers, so 2x-invariance is not invariance in one tier`,
    tiers.size === 3, `only reached ${[...tiers].join("/")} -- the ladder is not exercised, so the check above cannot fail`);
  check(`at least one exercised query carries an expansion term the ladder actually demotes`,
    demoted.length > 0,
    `no term over TAG_DF_COMMON (${SE.TAG_DF_COMMON}) survives in any expansion; broadest token df is ${broadest.toFixed(4)} -- ` +
    `nothing here crosses a threshold, so the invariance above is vacuous`);
}

/* ---------- --tiering: the per-query tiering table, not an assertion ---------- */

/* `node tools/test-search.mjs --tiering` runs the whole battery and THEN prints
   this. Deliberately not a short-circuit mode: a flag that skipped the
   assertions and exited 0 would be a way to get a green-looking run out of this
   file, which is the one thing it must never offer.
   It exists because #216 was CAUSED by local reasoning. PR #211 improved one
   show's topics, which raised that query's top score, which raised the relative
   bar, which evicted a DIFFERENT episode -- and the PR shipped describing a
   state its own change did not produce. The bar is relative, so the unit of
   measurement for any scoring or tagging change is the whole pool per query,
   never the item you are thinking about. This prints that unit. */
if (process.argv.includes("--tiering")) {
  const rows = [...searched].map(([query, { status, picks, results }]) => {
    if (!results.length) return { query, status, line: "no results" };
    const bar = results[0].sum * SE.STRONG_RATIO;
    const clearers = results.filter((x) => x.sum >= bar).length;
    const prefix = SE.strongPrefix(results, bar);
    /* Results the bar rejects that the ranking nonetheless places above a
       result it accepts -- the #216 inversion, per query. */
    const inverted = prefix.filter((x) => x.sum < bar);
    return {
      query, status,
      line: `${status.padEnd(7)} raw ${String(results.length).padStart(3)}  bar ${bar.toFixed(3).padStart(7)}  clearers ${String(clearers).padStart(3)}  prefix ${String(prefix.length).padStart(3)}  picks ${String(picks.length).padStart(2)}  inverted ${String(inverted.length).padStart(2)}`,
      inverted,
    };
  });
  console.log("\n---------- tiering, per query, over the whole fullPool() ----------");
  console.log("`inverted` = results the bar rejects that the ranking places above one it accepts (#216).\n");
  for (const r of rows) console.log("  " + r.query.padEnd(32) + r.line);
  console.log("\n  inversions in detail:");
  const any = rows.filter((r) => r.inverted?.length);
  if (!any.length) console.log("    none on this pool");
  for (const r of any) {
    console.log(`    "${r.query}"`);
    for (const x of r.inverted) console.log(`      m${x.matched} sum ${x.sum.toFixed(3)}  ${x.i.id}`);
  }
  console.log("");
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
