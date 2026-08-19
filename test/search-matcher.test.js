/* Unit tests for search-engine.js's hitText/hitTag -- the shared matcher.
 *
 * WHY THIS EXISTS
 * `tools/test-search.mjs` (the search-quality battery) exercises this matcher
 * only through whole queries against live catalogue data, which makes it a poor
 * net for the matcher itself in both directions. It cannot see a matcher change
 * that the concept vocabulary happens to paper over -- #218 is exactly that: the
 * `bbq` concept hand-authors BOTH `grill` and `grilling` as terms, so
 * `search("grill")` returned correct picks on main even though
 * `hitText("grilling", "grill")` was false, and the battery's own bbq needle
 * contributed zero items in silence. And it cannot pin a collision at all,
 * because a collision only shows up if some real catalogue item happens to
 * carry the colliding word today.
 *
 * So the semantics get asserted directly, on strings, with no data dependency:
 * these tests cannot be flipped by a nightly refresh, and they fail in
 * milliseconds rather than in the battery's ~170 seconds.
 *
 * THE INVARIANT THAT MATTERS MOST is the asymmetry. Widening the SUFFIX side is
 * what #218 asked for. The PREFIX side is load-bearing: it is the only thing
 * blocking `software`/`toward` as "war", `romance` as "roman" and `confusion` as
 * "fusion", which tools/test-search.mjs separately asserts the RANKER must not
 * do. Both directions are pinned below, so loosening the prefix guard to buy
 * recall fails here immediately instead of surfacing as a slow flood.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { hitText, hitTag } = require(path.join(ROOT, "search-engine.js"));

/* ---------- the suffix set, element by element ---------- */

test("hitText: a term matches its own -ing form (the #218 defect)", () => {
  assert.equal(hitText("grilling with steven raichlen", "grill"), true);
  assert.equal(hitText("murdering her father", "murder"), true);
  /* This third example WAS `hitText("marketing", "market")`, and it was wrong --
     see the sense-lock tests below. `engineer`/`engineering` replaces it because
     it is the largest real win the `ing` allowance buys (188 pool items, against
     `marketing`'s 10 that all turned out off-sense) and because the concept's own
     sense IS the verb `to engineer`, which is what makes a gerund on-sense. */
  assert.equal(hitText("school of nuclear science & engineering", "engineer"), true);
  assert.equal(hitText("the human skills of nutrition coaching", "coach"), true);
});

test("hitText: a term matches its own plural, including the -es plural", () => {
  assert.equal(hitText("grills", "grill"), true);
  assert.equal(hitText("frozen flight crashes in the potomac", "crash"), true);
  assert.equal(hitText("tornadoes", "tornado"), true);
  assert.equal(hitText("coaches", "coach"), true);
});

test("hitText: -ed is deliberately NOT in the set, and that was a reversal", () => {
  /* `ed` was in the shipped set until it was measured over the whole vocabulary
     rather than over the battery's 51 needles. On the needles it looked free (4
     on-subject items: three "murdered", one "crashed"). Over the vocabulary
     roughly 4 of its ~18 matches are on-subject and the rest are filler
     participles -- "AI-powered threats" for `power`, "engineered", "launched" a
     startup for the space sense of `launch`. Pinned so re-adding it is a
     deliberate act with a measurement attached, not a tidy-up. */
  assert.equal(hitText("the ghost bomber crashed", "crash"), false);
  assert.equal(hitText("murdered bill and peggy", "murder"), false);
  assert.equal(hitText("ai-powered threats", "power"), false);
});

test("hitText: the bare term still matches, unchanged", () => {
  assert.equal(hitText("a grill and a smoker", "grill"), true);
  assert.equal(hitText("war", "war"), true);
});

/* ---------- the suffix set is BOUNDED: not a stemmer ---------- */

test("hitText: suffixes outside the named set are not admitted", () => {
  /* If this ever passes, someone has replaced a bounded list with something
     open-ended -- the whole point is that the admitted set is reviewable. */
  assert.equal(hitText("grillmaster", "grill"), false);
  assert.equal(hitText("grilly", "grill"), false);
  assert.equal(hitText("grillion", "grill"), false);
  assert.equal(hitText("designer", "design"), false);
  assert.equal(hitText("warden", "war"), false);
});

test("hitText: derivational compounds are NOT inflections -- `war` does not reach `warfare`", () => {
  /* Deliberate, and filed as such in #218: admitting `fare` means admitting
     arbitrary suffixes, which is the flood the prefix guard exists to prevent
     in mirror image. `warfare` is reachable by typing "warfare". */
  assert.equal(hitText("warfare", "war"), false);
  assert.equal(hitText("wartime", "war"), false);
});

test("hitText: stem-mutating inflections stay out (they need a stemmer, not a suffix)", () => {
  assert.equal(hitText("stories", "story"), false);
  assert.equal(hitText("baking", "bake"), false);
});

/* ---------- #248: the sense-locked stems take s/es but never ing ---------- */

/* Each member is asserted INDIVIDUALLY rather than in a loop over the exported
   set, deliberately. A loop over `SENSE_LOCKED_STEMS` would be a tautology --
   delete a member and the loop simply stops checking it, silently and green,
   which is the "assertion that asserts nothing" this file's history is made of.
   Naming the five surface words pins the behaviour independently of the set. */

test("hitText: a sense-locked stem does not reach its -ing form (#248)", () => {
  /* `training` is a real inflection of `to train` -- the wrong verb for a concept
     carrying only the railway noun. 32 pool items, the largest single off-sense
     bucket the `ing` allowance opened. */
  assert.equal(hitText("constraint-led speed training", "train"), false);
  assert.equal(hitText("the pre-training wall", "train"), false);
  assert.equal(hitText("wellness marketing vs. evidence", "market"), false);
  assert.equal(hitText("the dilemma hanging over f1's future", "hang"), false);
  assert.equal(hitText("summer travel and booking", "book"), false);
  assert.equal(hitText("a long winding road", "wind"), false);
});

test("hitText: a sense-locked stem keeps its bare form and its plural (#248)", () => {
  /* The point of #248 is that the fix is NOT deleting `train` from the concept.
     If the lock ever cost the natural singular or plural, it would have
     reintroduced the #218 defect it is built to preserve. */
  assert.equal(hitText("american civil war railroads and trains", "train"), true);
  assert.equal(hitText("a train", "train"), true);
  assert.equal(hitText("the tungsten market", "market"), true);
  assert.equal(hitText("markets all around the world", "market"), true);
  assert.equal(hitText("banned books", "book"), true);
  assert.equal(hitText("a book", "book"), true);
  assert.equal(hitText("offshore wind", "wind"), true);
  assert.equal(hitText("a comedy hang", "hang"), true);
});

test("hitText: the sense lock is NARROW -- on-sense stems keep their -ing (#248)", () => {
  /* The lock is a subtraction from a set that #218 measured, so the thing that
     makes it acceptable is that it subtracts almost nothing: 46 off-sense (term,
     item) pairs out of 258, leaving these. Adding any of them to the set would
     undo #218 in the same motion. */
  assert.equal(hitText("grilling with steven raichlen", "grill"), true);
  assert.equal(hitText("school of nuclear science & engineering", "engineer"), true);
  assert.equal(hitText("nutrition coaching", "coach"), true);
  assert.equal(hitText("homebrewing a wet-hopped ipa", "homebrew"), true);
  /* Not an inflection at all, so the suffix set never applied to it -- the
     `homebrew` items in the pool are reached through the tag `homebrewing`. */
  assert.equal(hitText("homebrewcon asheville", "homebrew"), false);
  assert.equal(hitText("shooting in remote regions", "film"), false); // unrelated word, sanity
  assert.equal(hitText("filming in remote regions", "film"), true);
  assert.equal(hitText("murdering her father", "murder"), true);
  assert.equal(hitText("crafting characters", "craft"), true);
});

test("hitText: the sense lock does not admit -ed either, or any other suffix (#248)", () => {
  /* The locked set is `(?:s|es)?`, so everything the main set already excluded
     stays excluded. If someone "simplifies" the lock to a bare `s?` this still
     passes -- that is what the -es claim below is for. */
  assert.equal(hitText("trained", "train"), false);
  assert.equal(hitText("marketed", "market"), false);
  assert.equal(hitText("trainer", "train"), false);
  assert.equal(hitText("bookish", "book"), false);
  assert.equal(hitText("window", "wind"), false);
  assert.equal(hitText("hanger", "hang"), false);
});

test("hitText: the sense lock keeps -es, so it subtracts exactly one suffix (#248)", () => {
  /* None of "traines"/"marketes"/"bookes"/"windes"/"hanges" is a word, so this
     allowance is inert on today's five members and cannot be verified against the
     pool. It is pinned on a synthetic string precisely BECAUSE it is inert: the
     locked set must differ from the main set on `ing` and on nothing else, so
     that a future member ending in a sibilant (the coach/coaches shape) gets a
     working plural without anyone having to rediscover why. */
  assert.equal(hitText("traines", "train"), true);
  assert.equal(hitText("bookes", "book"), true);
});

test("hitText: the sense lock does not weaken the prefix guard (#248)", () => {
  /* A narrower suffix set must not accidentally become a looser prefix rule --
     these terms are still long-branch terms and still carry the lookbehind. */
  assert.equal(hitText("retraining", "train"), false);
  assert.equal(hitText("supermarket", "market"), false);
  assert.equal(hitText("supermarkets", "market"), false);
  assert.equal(hitText("ebook", "book"), false);
  assert.equal(hitText("headwind", "wind"), false);
  assert.equal(hitText("2train", "train"), false);
});

test("hitTag: the sense lock applies to TAGS too, not just prose (#248)", () => {
  /* tagDF and scoreMatch's +2.5 tag bonus both run through hitTag, and tags are
     where the off-sense count concentrates (`wellness-marketing`, `marketing`,
     `referral-marketing` are real tags in data/item-tags.json). A lock that lived
     only in hitText would leave the strongest signal in the ranker unlocked. */
  assert.equal(hitTag("training", "train"), false);
  assert.equal(hitTag("speed-training", "train"), false);
  assert.equal(hitTag("wellness-marketing", "market"), false);
  assert.equal(hitTag("referral-marketing", "market"), false);
  /* ...while the plural and the bare tag still hit. */
  assert.equal(hitTag("trains", "train"), true);
  assert.equal(hitTag("freight-trains", "train"), true);
  assert.equal(hitTag("markets", "market"), true);
});

test("the sense-locked set is exported and holds exactly its documented members", () => {
  /* A pin, not a tautology: the membership RULE lives in a comment, so the only
     mechanical guard against a member arriving without a measurement is that
     changing this set is a visible, deliberate edit. Five members, each argued
     and counted in search-engine.js. If you are here because this went red, the
     rule and the per-member counts are what you need to satisfy -- and the
     rejected list right below them is where `engineer` (188 on-sense items) and
     `grill` (#218's whole purpose) are kept out. */
  const SE = require(path.join(ROOT, "search-engine.js"));
  assert.ok(SE.SENSE_LOCKED_STEMS instanceof Set);
  assert.deepEqual([...SE.SENSE_LOCKED_STEMS].sort(), ["book", "hang", "market", "train", "wind"]);
});

/* ---------- THE PREFIX GUARD: must stay exactly as strict ---------- */

test("hitText: the LEADING guard blocks the two prefix collisions", () => {
  /* Split from the trailing-guard test below, 2026-08-17. These two collisions
     add letters BEFORE the term and are the lookbehind's own work: delete
     `(?<![a-z0-9])` and exactly these fail. */
  assert.equal(hitText("diffusion llms", "fusion"), false);
  assert.equal(hitText("kings of the steam age", "team"), false);
});

test("hitText: the TRAILING guard blocks the romance collision", () => {
  /* `roman` inside "romance"/"romantic" adds letters AFTER the term, so the
     lookbehind has nothing to do with it -- this is `(?![a-z0-9])` after the
     suffix alternation. It used to sit in the prefix-guard test above, which
     made the prefix guard look like it was doing work it was not, and led
     tools/test-search.mjs §6 to record the "rome" collision case as vacuous
     when in fact it is witnessed by mutating THIS guard: drop the trailing
     lookahead and the Huberman romance episode is retrieved for "rome".
     Keeping the two in separate tests is what keeps each witness legible. */
  assert.equal(hitText("romance and compatibility", "roman"), false);
  assert.equal(hitText("romantic", "roman"), false);
  /* The suffix allowance must not become a hole in the trailing guard either:
     "romances" is `roman` + a suffix outside the named set, and stays out. */
  assert.equal(hitText("romances", "roman"), false);
  /* ...while a term followed by a genuine word boundary still matches. */
  assert.equal(hitText("the roman empire", "roman"), true);
  assert.equal(hitText("romans", "roman"), true);
});

test("hitText: prefix guard blocks the oracle's historical false friends for `war`", () => {
  assert.equal(hitText("software engineering daily", "war"), false);
  assert.equal(hitText("toward athens", "war"), false);
  assert.equal(hitText("postwar", "war"), false);
});

test("hitText: prefix guard blocks `geopolitics` for `politics`", () => {
  /* An accepted precision/recall trade: the guard cannot tell a meaningful
     compound (geo-politics) from a coincidental one (dif-fusion). #218 asked
     for the suffix side only, so this stays false. */
  assert.equal(hitText("geopolitics", "politics"), false);
  assert.equal(hitText("politics", "politics"), true);
});

test("hitText: a digit immediately before the term also blocks the match", () => {
  /* Long-branch terms only. `war` is 3 chars and takes the SHORT branch, whose
     guard is `\b` and never evaluates the lookbehind at all -- an assertion on
     "4war" here would be green with the lookbehind deleted, so it would be
     vacuous with respect to the guard this test is named after. It lives in the
     short-branch section below instead, as a `\b` claim. */
  assert.equal(hitText("2fusion", "fusion"), false);
  assert.equal(hitText("9roman", "roman"), false);
  assert.equal(hitText("1politics", "politics"), false);
});

test("hitText: widening the suffix did not open a prefix hole on the new suffixes", () => {
  /* The suffix alternation must not let a blocked prefix through by matching a
     longer tail: "software wars" is fine (that IS the word "wars"), but
     "softwaring" and "diffusioned" must stay blocked. */
  assert.equal(hitText("softwaring", "war"), false);
  assert.equal(hitText("diffusioned", "fusion"), false);
  assert.equal(hitText("diffusions", "fusion"), false);
  assert.equal(hitText("romances", "roman"), false);
  assert.equal(hitText("steaming", "team"), false);
});

/* ---------- the under-4-char branch: plural only ---------- */

test("hitText: short terms reach their plural (#218's second half)", () => {
  assert.equal(hitText("business wars", "war"), true);
  assert.equal(hitText("wars", "war"), true);
  assert.equal(hitText("cars", "car"), true);
  assert.equal(hitText("bbqs", "bbq"), true);
});

test("hitText: short terms do NOT reach warm or Warner", () => {
  /* Named in #218 as the thing the plural allowance must not cost. */
  assert.equal(hitText("warm up", "war"), false);
  assert.equal(hitText("warner bros", "war"), false);
  assert.equal(hitText("warehouse", "war"), false);
  assert.equal(hitText("warden", "war"), false);
});

test("hitText: short terms get NO -es/-ing/-ed, measured rather than assumed", () => {
  /* Over the whole 1,364-term concept vocabulary against every surface word in
     the pool, `es` on a short stem yields exactly one pair and it is wrong
     (rag/rages, where rag is retrieval-augmented generation); `ing` likewise
     yields exactly one, also wrong (car/caring); `ed` yields none at all. A
     three-letter stem is a prefix of too much English for anything but the
     plural to be safe. */
  assert.equal(hitText("rages", "rag"), false);
  assert.equal(hitText("caring for a parent", "car"), false);
  assert.equal(hitText("wares", "war"), false);
  assert.equal(hitText("cared", "car"), false);
  assert.equal(hitText("waring", "war"), false);
});

test("hitText: the short branch still requires a whole word", () => {
  assert.equal(hitText("nbaa business aviation", "nba"), false);
  assert.equal(hitText("swar", "war"), false);
  /* A digit before a short term is blocked by `\b`, not by the long branch's
     lookbehind -- see the digit test above for why this claim lives here. */
  assert.equal(hitText("4war", "war"), false);
});

/* ---------- hitTag ---------- */

test("hitTag: a long term matches an inflected tag", () => {
  assert.equal(hitTag("grilling", "grill"), true);
  assert.equal(hitTag("true-crime", "crime"), true);
  assert.equal(hitTag("plane-crashes", "crash"), true);
});

test("hitTag: a long term is still blocked by the prefix guard inside a tag", () => {
  assert.equal(hitTag("diffusion", "fusion"), false);
  assert.equal(hitTag("maritime-crime", "time"), false);
});

test("hitTag: a short term matches an exact tag or a hyphen segment, plus its plural", () => {
  assert.equal(hitTag("war", "war"), true);
  assert.equal(hitTag("wars", "war"), true);
  assert.equal(hitTag("world-wars", "war"), true);
  assert.equal(hitTag("cold-war-espionage", "war"), true);
});

test("hitTag: a short term does not match a segment that merely starts with it", () => {
  assert.equal(hitTag("warm-up", "war"), false);
  assert.equal(hitTag("warner-bros", "war"), false);
  assert.equal(hitTag("software", "war"), false);
  assert.equal(hitTag("nbaa", "nba"), false);
});

/* ---------- #219: nobody re-implements the shared matcher ---------- */

test("no file outside search-engine.js declares its own hitText/hitTag", () => {
  /* Copies of these helpers existed and disagreed with the ranker: the battery's
     (#211) and topic-coverage-report.mjs's (#219). Both were LOOSER than the
     ranker they described, which is the dangerous direction -- an oracle that
     admits what the ranker rejects hides real gaps and contradicts the collision
     assertions in the same repo. Copies are how they drifted, so copies are what
     this forbids. Importing is fine; a destructuring
     `const { hitText, hitTag } = SE` is an import, not a declaration, and is
     deliberately not matched.
     BE PRECISE ABOUT ITS REACH, because it is easy to over-read as "no copies
     exist anywhere". It catches a NAMED declaration reusing one of these two
     identifiers, in a file other than search-engine.js. It does NOT catch a copy
     under a different name, nor an anonymous inline one, nor anything inside
     search-engine.js itself. There WAS one of exactly that shape -- `tagDF`
     inlined the pre-#211 loose predicate (`tag.includes(term)`, no collision
     guard, no plural on the short branch) as an anonymous arrow, making the count
     four copies rather than three -- and #249 collapsed it onto `hitTag`.
     THE SCAN IS STILL NOT WHAT CAUGHT IT and still could not catch its return, so
     do not read the tick below as coverage of this file. #249 deliberately did NOT
     widen the scan to chase anonymous or differently-named copies: the predicate
     has no stable syntax to match, so any regex would be a guess that reads as a
     guarantee. What guards it instead is the BEHAVIOURAL pair of tagCount tests
     below, which compare counts against hitTag on synthetic tags and fail for any
     disagreeing predicate regardless of how it is spelled or whether it is named.
     search-engine.js therefore stays exempt from this scan, on the grounds that
     the scan was never the right instrument for it. */
  const DECL = /(?:^|[^.\w])(?:const|let|var|function)\s+(hitText|hitTag)\s*(?:=|\()/;
  const SKIP = new Set(["node_modules", ".git", "audio-cache", "data-local", "ios", "mobile"]);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) {
        const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
        if (rel === "search-engine.js") continue;
        if (DECL.test(fs.readFileSync(abs, "utf8"))) offenders.push(rel);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [],
    `these files declare their own hitText/hitTag instead of importing search-engine.js's: ${offenders.join(", ")}. ` +
    `Three copies existed and two drifted looser than the ranker (#211, #219) -- import them.`);
});

/* ---------- #249: tagCount counts through the shared matcher ---------- */

test("tagCount counts tags through hitTag, not a loose substring (#249)", () => {
  /* THE FOURTH COPY. `tagDF` inlined the pre-#211 loose predicate as an anonymous
     arrow -- `tag.includes(term)` on the long branch, no collision guard, and no
     plural on the short branch -- inside search-engine.js itself, where the
     reimplementation scan above cannot see it (it matches NAMED declarations and
     skips this file by path).
     This is a BEHAVIOURAL test, not a scan, and that is the point: a scan can only
     ever catch the copies it knows how to describe, whereas this fails for any
     predicate that disagrees with hitTag on these tags, named or anonymous.
     Synthetic ctx on purpose -- no data dependency, so a nightly refresh cannot
     flip it. The tag shapes are the real ones from #249's report: `ship` was
     counted at 155 and DELETED from expansions on a tally made of `relationships`
     and `championship` substring hits, against a true count of 6.
     READS `tagCount`, WHICH IS WHERE #275 LEFT THE COUNT. `tagDF` is now that
     count over the size of the tag map, so these expected values would each grow
     a denominator and this test would be about normalisation rather than about
     the matcher. The count is the mechanism #249 is about, so the count is what
     this reads; the fraction is pinned in test/search-df-scaling.test.js. */
  const SE = require(path.join(ROOT, "search-engine.js"));
  const ctx = {
    itemTags: { tags: {
      a: ["ship", "maritime"],          // a real `ship` tag
      b: ["relationships", "dating"],   // loose predicate counted this as `ship`
      c: ["championship", "sports"],    // and this
      d: ["ships", "naval"],            // a genuine plural, which the loose short
      e: ["shipwrecks"],                // branch missed; this one is a collision
    } },
  };
  /* 2, not 5: `relationships` and `championship` are substring hits the ranker
     would never make, and `shipwrecks` adds letters after the term. Only the
     literal `ship` (item a) and the genuine plural `ships` (item d) count -- the
     plural is in the named suffix set, and the loose SHORT branch had no plural
     allowance at all, which is the other half of the same defect. The loose
     predicate scores this same fixture 5 -- every one of the five items -- so it
     fails here by 3. */
  assert.equal(SE.tagCount("ship", ctx), 2);

  /* The short branch, where the loose predicate had no plural allowance at all.
     `car` is 3 chars: exact tag, hyphen segment, or their plurals. */
  const shortCtx = {
    itemTags: { tags: {
      a: ["car"], b: ["cars"], c: ["electric-car"], d: ["car-culture"],
      e: ["carbon"], f: ["nascar"],
    } },
  };
  assert.equal(SE.tagCount("car", shortCtx), 4);

  /* And the sense lock reaches tagCount too, since tagCount is a hitTag consumer:
     `training` tags must not inflate the railway term's count. */
  const trainCtx = {
    itemTags: { tags: {
      a: ["trains", "railway"], b: ["training"], c: ["strength-training"], d: ["train"],
    } },
  };
  assert.equal(SE.tagCount("train", trainCtx), 2);
});

test("tagCount memoizes per ctx without leaking between ctxs (#249)", () => {
  /* The memo is keyed by term on the ctx object, and tagCount is the only writer.
     Two ctxs with different data must not share an answer -- a cache keyed
     globally would make the count depend on which query ran first. */
  const SE = require(path.join(ROOT, "search-engine.js"));
  const one = { itemTags: { tags: { a: ["ship"] } } };
  const two = { itemTags: { tags: { a: ["ship"], b: ["ships"] } } };
  assert.equal(SE.tagCount("ship", one), 1);
  assert.equal(SE.tagCount("ship", two), 2);
  assert.equal(SE.tagCount("ship", one), 1);
});

test("the matcher is actually exported, so sharing it is possible at all", () => {
  const SE = require(path.join(ROOT, "search-engine.js"));
  assert.equal(typeof SE.hitText, "function");
  assert.equal(typeof SE.hitTag, "function");
});
