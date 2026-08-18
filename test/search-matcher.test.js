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
 * milliseconds rather than in the battery's ~110 seconds.
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
  assert.equal(hitText("marketing", "market"), true);
});

test("hitText: a term matches its own plural, including the -es plural", () => {
  assert.equal(hitText("grills", "grill"), true);
  assert.equal(hitText("frozen flight crashes in the potomac", "crash"), true);
  assert.equal(hitText("tornadoes", "tornado"), true);
  assert.equal(hitText("coaches", "coach"), true);
});

test("hitText: a term matches its own -ed form", () => {
  assert.equal(hitText("the ghost bomber crashed", "crash"), true);
  assert.equal(hitText("murdered bill and peggy", "murder"), true);
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

/* ---------- THE PREFIX GUARD: must stay exactly as strict ---------- */

test("hitText: prefix guard blocks the three documented collisions", () => {
  assert.equal(hitText("diffusion llms", "fusion"), false);
  assert.equal(hitText("romance and compatibility", "roman"), false);
  assert.equal(hitText("romantic", "roman"), false);
  assert.equal(hitText("kings of the steam age", "team"), false);
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
  assert.equal(hitText("4war", "war"), false);
  assert.equal(hitText("2fusion", "fusion"), false);
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
  /* THREE independent copies of these helpers existed and TWO disagreed with
     the ranker: the battery's (#211) and topic-coverage-report.mjs's (#219).
     Both were LOOSER than the ranker they described, which is the dangerous
     direction -- an oracle that admits what the ranker rejects hides real gaps
     and contradicts the collision assertions in the same repo. Copies are how
     they drifted, so the copies are what this forbids. Importing is fine; a
     destructuring `const { hitText, hitTag } = SE` is an import, not a
     declaration, and is deliberately not matched. */
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

test("the matcher is actually exported, so sharing it is possible at all", () => {
  const SE = require(path.join(ROOT, "search-engine.js"));
  assert.equal(typeof SE.hitText, "function");
  assert.equal(typeof SE.hitTag, "function");
});
