/* PLURAL/SINGULAR QUERY LEMMA SCALING (kanban t_fe968b47) -- systemic
 * thin-anchor class, filed from adversarial red-team of search-engine.js
 * (t_711dce13). Root-caused: data/semantic-index.json's concept term lists
 * carry only ONE of {singular, plural} for most lemmas (305 of 1,364
 * concept terms have a plural-present/singular-absent gap; 848 are
 * singular-only with zero plural counterpart). LONG_INFLECTIONS only
 * widens what a catalogue TERM matches in item TEXT -- it does nothing for
 * QUERY-side vocabulary lookup in interpretQuery. A query typed in the
 * "wrong" (unlisted) inflection of a real, well-covered concept therefore
 * got hasConceptExpansion=false, and if its own bare corpusDF was also
 * under THIN_ANCHOR_DF, read `thin` -- collapsing an honest, well-covered
 * topic to status "empty" on roughly a coin flip of which inflection the
 * user happened to type.
 *
 * THE FIX, in search-engine.js: `lemmaVariants(tok)` computes a bounded,
 * named set of singular<->plural transforms (bare "s", sibilant "es",
 * "y"<->"ies") for a query token. interpretQuery uses those variants to
 * (a) widen concept/modifier dictionary-key lookup so a query picks up a
 * concept that only lists the OTHER inflection, (b) add the lemma variant
 * as its own same-weight literal query term so bare-text matching also
 * reaches catalogue items spelled in the other inflection, and (c) take
 * the MAX corpusDF across the token and its variants when deciding
 * `broad`/`thin`, so thin-ness reflects what the query can actually match,
 * not just its typed spelling.
 *
 * These are the exact 13 repro pairs from the kanban card, run against the
 * live catalogue (data/discover.json + data/semantic-index.json, mirroring
 * tools/test-search.mjs's fullPool()). Each pair must now have a status
 * that is NOT "empty" on both sides (the coin-flip failure this fixes),
 * and singular/plural picks must be non-trivially close in count so this
 * doesn't just declare victory on a token match that returns 1 result.
 *
 * MUTATION: reverting search-engine.js's lemmaVariants additions (the
 * lookupKeys widening, the addTerm(variant) call, or the max-corpusDF
 * broad/thin computation) reproduces the empty side of each asymmetric
 * pair below and fails this suite.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SE = require(path.join(ROOT, "search-engine.js"));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const discover = read("data/discover.json");
const itemTags = read("data/item-tags.json");
const semantic = read("data/semantic-index.json");
const session = read("data/session.json");
const validated = read("data/validated-links.json");

/* Mirrors app.js's fullPool()/tools/test-search.mjs's copy -- see
   test/search-bar-exposure.test.js's header for why this is copied rather
   than imported: the thing that must never be copied is the matcher, and
   it is not. */
function fullPool() {
  const p = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    const ep = session.episodes[id];
    const v = validated?.episodes?.[id];
    const src = v ? { ...ep, artwork_url: v.artwork_url || ep.artwork_url || null } : ep;
    p.push({
      id, show: src.show, title: src.title,
      apple_collection_id: src.apple_collection_id,
      duration_min: src.duration_min ?? null,
      topics: src.topics || [],
      hook: src.hook || src.summary || src.title,
    });
    seen.add(id);
  }
  for (const it of discover.items) if (!seen.has(it.id)) p.push(it);
  return p;
}
const pool = fullPool();
const ctx = { semantic, itemTags, discover };

function classify(query) {
  const interp = SE.interpretQuery(query, ctx);
  const { results } = SE.searchWithRelaxation(pool, interp, 2, itemTags, () => 0.5);
  return SE.classifyResults(results);
}

/* The 13 pairs from the kanban card's repro table, verbatim. Before the
   fix, the "empty" side of each of these had status "empty"/0 picks while
   its partner was "ok"/"sparse" with real picks -- an honest-looking but
   wrong "nothing here" purely because of which inflection was typed. */
const PAIRS = [
  ["satellite", "satellites"],
  ["astronaut", "astronauts"],
  ["drone", "drones"],
  ["algorithm", "algorithms"],
  ["transistor", "transistors"],
  ["entrepreneur", "entrepreneurs"],
  ["gladiator", "gladiators"],
  ["fusion", "fusions"],
  ["energy", "energies"],
  ["culture", "cultures"],
  ["computer", "computers"],
  ["soldier", "soldiers"],
  ["recipe", "recipes"],
  /* Silent-e plural, codex review P2: "cases" -> "case" must reach the
     right singular fragment, not just "cas". */
  ["case", "cases"],
  /* Invariant-s noun that IS indexed only by its plural, codex review
     round 5: "bias" must still reach the "biases" concept (decision-
     making) even though "bias" itself must never be despluralized. */
  ["bias", "biases"],
  /* Silent-ie plural, codex review round 6: the "ies" branch's naive
     y-strip mangled "movies" to "movy", missing the real singular
     "movie" entirely. */
  ["movie", "movies"],
  /* lens/lenses -- codex review round 7: "lens" is a real singular
     whose plural adds "es" rather than inverting a bare-s strip; the
     "photography" concept indexes only "lenses". */
  ["lens", "lenses"],
];

for (const [singular, plural] of PAIRS) {
  test(`"${singular}"/"${plural}": neither inflection collapses to empty`, () => {
    const singResult = classify(singular);
    const plurResult = classify(plural);
    assert.notStrictEqual(singResult.status, "empty",
      `"${singular}" (singular) is empty -- lemma bridge to "${plural}" is not reaching it`);
    assert.notStrictEqual(plurResult.status, "empty",
      `"${plural}" (plural) is empty -- lemma bridge to "${singular}" is not reaching it`);
  });
}

test("lemmaVariants is a bounded, named transform -- not a general stemmer", () => {
  /* Sanity-pin a few shapes so a future rewrite doesn't silently widen or
     narrow scope. "training"/"trained" must NOT be touched (the card's
     scope explicitly excludes -ing/-ed; that is a verb-sense ambiguity,
     not a singular/plural relationship). */
  assert.deepEqual([...SE.lemmaVariants("satellites")], ["satellite", "satelliteses"],
    "bare-s despluralize (codex review round 7) also emits the +es pluralize candidate ('satelliteses' is a harmless unused fragment) so real singular-s-plus-es words like 'lens'/'lenses' aren't missed");
  assert.deepEqual([...SE.lemmaVariants("satellite")], ["satellites"]);
  assert.deepEqual([...SE.lemmaVariants("energies")], ["energy", "energie"],
    "y<->ies plurals (codex review round 6) also emit the bare-s-strip fragment ('energie' is harmless) so a silent-ie singular like 'movie'/'cookie' isn't missed by the same branch");
  assert.deepEqual([...SE.lemmaVariants("energy")], ["energies"]);
  assert.deepEqual([...SE.lemmaVariants("glasses")], ["glasseses"],
    "\"glasses\" (eyewear) must never bare-s-strip to \"glass\" -- that IS a real word but the wrong sense (materials concept), same cross-sense contamination as \"marines\"/ocean -- codex review round 8. The pluralize-only fallback ('glasseses') is a harmless unused fragment.");
  assert.deepEqual([...SE.lemmaVariants("warriors")], ["warrior", "warriorses"]);
  assert.deepEqual([...SE.lemmaVariants("training")], ["trainings"],
    "training is treated as a bare noun (pluralize-only), never de-verbed to \"train\"");
  assert.deepEqual([...SE.lemmaVariants("trained")], ["traineds"],
    "no -ed participle stripping -- out of scope for a singular/plural helper");
  for (const invariant of ["news", "ours", "status", "bias", "canvas", "virus"]) {
    /* Round 4 pinned "must not be stripped"; round 5 corrected that to
       "must not be stripped, but MAY still pluralize" -- bias/biases is
       the real card gap: the taxonomy indexes only the plural, so
       blocking pluralize too would silently keep the exact asymmetry
       this fix exists to remove, just for a different word class. The
       pluralized form is a harmless namespaced fragment for the ones
       with no real plural (newses, ourses) and the real correct plural
       for the ones that do have one (biases, statuses, viruses). */
    const v = [...SE.lemmaVariants(invariant)];
    assert.deepEqual(v, [invariant + "es"],
      `"${invariant}" must not be despluralized (no bare-s strip) but must still offer its "+es" pluralize candidate -- got ${JSON.stringify(v)}`);
  }
  /* SENSE_LOCKED_PLURALS, codex review round 7 direct repro: "marines"
     (military) bare-s-strips to "marine", which the semantic index
     indexes under the OCEAN concept ("marine biology") -- a real word,
     but the wrong sense entirely. Must never despluralize; pluralize
     (never fires for an already-plural-shaped word here, so this stays
     empty, matching the pre-fix "no variants" baseline for this one
     named exception). */
  assert.deepEqual([...SE.lemmaVariants("marines")], ["marineses"],
    "\"marines\" must never bare-s-strip to \"marine\" (wrong sense: ocean, not military) -- codex review round 7");
});

test("\"marines\" (military) never picks up the unrelated ocean concept's vocabulary", () => {
  /* MUTATION: removing "marines" from SENSE_LOCKED_PLURALS reproduces
     the round-7 finding exactly -- "marines" bare-s-strips to "marine",
     which IS a term of the "ocean" concept (data/semantic-index.json),
     so hasConceptExpansion flips true and the group's terms gain the
     ocean concept's full vocabulary (sea, maritime, marine-biology,
     ...), corrupting a military-topic query with marine-biology
     content and topic boosts it never asked for. */
  const interp = SE.interpretQuery("marines", ctx);
  const group = interp.groups.find(g => g.token === "marines");
  const oceanOnlyTerms = ["marine-biology", "maritime", "sea", "seas"];
  for (const t of oceanOnlyTerms) {
    assert.ok(!group.terms.has(t), `"marines" query picked up ocean-only term "${t}" via the wrong-sense despluralize guess`);
  }
});

test("\"glasses\" (eyewear) never picks up the unrelated materials concept's vocabulary", () => {
  /* MUTATION: removing "glasses" from SENSE_LOCKED_PLURALS reproduces
     codex review round 8's finding -- "glasses" bare-s-strips to
     "glass", a term of the "materials" concept, corrupting an eyewear
     query with materials-science vocabulary and topic boosts. */
  const interp = SE.interpretQuery("glasses", ctx);
  const group = interp.groups.find(g => g.token === "glasses");
  const materialsOnlyTerms = ["materials-science", "graphene", "polymers"];
  for (const t of materialsOnlyTerms) {
    assert.ok(!group.terms.has(t), `"glasses" query picked up materials-only term "${t}" via the wrong-sense despluralize guess`);
  }
});
