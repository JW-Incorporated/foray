/* Foray search engine — pure, deterministic query interpretation + scoring.
   No DOM, no localStorage, no network, no LLM at query time (per
   docs/curation/personalization-and-depth-plan.md §7). Concepts/modifiers
   come from data/semantic-index.json (compiled offline); item tags from
   data/item-tags.json. Both are fetched once per session by app.js and
   passed in as `ctx` here — this module never touches globals.

   Loaded as a plain <script> before app.js (see index.html) so it works
   under the strict CSP with no build step, and is also require()-able from
   Node (tools/test-search.mjs) for the search-quality battery.

   ctx shape: { semantic, itemTags, discover, _dfMemo?, _corpusDfMemo?, _dfTotal? }
   (the two memo maps and the cached tag-map size are created lazily on the ctx
   object the caller passes in — callers should reuse one ctx per session/run, and
   must NOT swap `itemTags` on a ctx that has already been used, since all three
   caches describe the corpus that was there when they were filled). */

/* ---------- stopwords / generic words / aliases ---------- */

/* Pure function words — never carry topic meaning, always stripped. */
const STOPWORDS = new Set(["a","an","the","about","series","playlist","of","on","for","me","my","give","build","make","with","to","and","or","in","podcast","podcasts","episode","episodes","show","shows","some","something","want","i","please","that","stuff","things"]);

/* Interrogative/meta words: real English words, but never a useful search
   anchor even alone ("how" / "works" / "guide" carry no topic). Distinct
   from GENERIC_WORDS below: these are hand-curated because raw corpus
   frequency alone won't catch a rare-but-empty word like "works" (0.7% of
   titles) or "guide" — frequency-based demotion (see BROAD_DF_THRESHOLD)
   only catches words that are *both* generic *and* common. */
const GENERIC_WORDS = new Set([
  "how","why","what","when","where","which","who",
  "works","work","working","does","do","did",
  "explain","explains","explained","understand","understanding",
  "learn","learning","learns","guide","guides","tutorial","tutorials",
  "intro","introduction","basics","basic","beginner","beginners",
  "overview","primer","talk","talks","chat","chats","discussion","discussions",
  "interview","interviews","dive","dives",
  "best","top","great","good","real","true","actual","actually",
]);

const ALIASES = {
  bbq: ["barbecue", "grill"], barbeque: ["barbecue"],
  cooking: ["food", "culinary"], rome: ["roman"], ww2: ["war"],
  plane: ["aviation", "aircraft"], planes: ["aviation", "aircraft"],
  car: ["automotive"], cars: ["automotive"], ocean: ["sea", "marine"],
};

/* A content token whose corpus document-frequency (title+hook+topics+tags,
   see corpusDF) is at/above this fraction of the catalog is a "broad" word
   -- a real topic/genre marker (history, science, comedy) too common to
   single-handedly anchor a query when a more specific token is present.
   Calibrated against the live catalog (984 items, 2026-07-24):
   regression-anchor tokens sit well under this (energy 7.0%, fusion 4.8%,
   startups 5.5%); the words that caused off-topic top results sit well
   over it (history 23.0%, science 18.6%). Those two figures are from that 2026-07-24
   snapshot; on 2026-08-18's 1,534 items the same words read 24.3% and 19.4%, and the
   ladder below quotes the newer ones -- the same quantity measured twice, not two
   quantities. Tunable — see tools/test-search.mjs.
   SHARES ITS VALUE WITH TAG_DF_TOO_BROAD below, deliberately, and the two are NOT
   the same measurement: this one reads corpusDF (title/hook/topics/tags over the
   discover pool) and that one reads tagDF (tags only, over the tag map). See there
   for the argument and for the asymmetry it leaves. */
const BROAD_DF_THRESHOLD = 0.10;

/* A primary (non-broad) token that is real and specific but has almost
   no catalogue footprint AND no concept models it -- see the THIN ANCHOR
   comment in interpretQuery, where this gates whether a token can be
   silently outvoted by a commoner co-token under OR semantics. Corpus DF,
   not tag DF (a different, larger-magnitude measure -- see BROAD_DF_THRESHOLD
   vs the TAG_DF ladder above), so it is directly comparable to
   BROAD_DF_THRESHOLD and sits one order of magnitude under it: broad tokens
   are >=10% of the catalogue, thin tokens are under 0.2%, and the decade
   between is intentionally silent -- most real topic words with any
   coverage at all live there and must never be treated as thin. */
const THIN_ANCHOR_DF = 0.002;

/* THE TAG-DF LADDER: three fractions of the tag map (see tagDF), read by the two
   consumers that care how common a term is. #275.

   THESE WERE FOUR ABSOLUTE COUNTS -- `df > 60` dropped a term from a query
   expansion, `df > 25` cut its weight to 0.4x, and scoreMatch bucketed its
   multiplier at 10 and 30 -- while BROAD_DF_THRESHOLD directly above was already a
   fraction. Half of this module's df logic was therefore scale-free and half was
   not, so the scale-bound half retuned itself every night as the catalogue grew:
   `df > 60` meant "in more than 6.8% of the tag map" at 878 entries and "more than
   3.8%" at 1,561, and over five real nightly snapshots (2026-07-19 -> 2026-08-18)
   52 terms crossed the expansion threshold and 125 the multiplier with no code
   change. Duplicating today's map -- which cannot change what the catalogue is
   ABOUT -- moved 137 and 206 at 2x, 284 and 494 at 4x. All of that is denominator.

   FOUR CUTS BECAME THREE, and the collapse is measured rather than tidy: the
   expansion's lower cut was 25 and the multiplier's upper cut was 30 -- 1.60% and
   1.92% of the map, within 20% of each other, with nothing in this file ever
   explaining the difference. They answer the same question ("is this term common
   enough to stop trusting on its own"), so they are one number now.
   WHAT THE COLLAPSE COSTS, measured rather than waved at, because at the WRONG
   values it is not free: held at the today-equivalent fractions it moves two
   queries, since `racing` (26 of 1,561) and `cold` (30) sit between the two old
   cuts and lose the 1.0 multiplier for 0.75. At the values below it costs nothing
   at all -- TAG_DF_COMMON 0.02 is above both 25/1,561 and 30/1,561, so both terms
   are on the same side of it as they were of 30. If a measurement ever
   distinguishes the two cuts again, splitting is one line plus a reason.

   HOW THE VALUES WERE PICKED, and NOT by dividing 60 and 25 by today's item count
   -- today's count is arbitrary, and enshrining it is how the absolute thresholds
   happened in the first place. Each cut is the most STABLE fraction inside the
   window search quality allows: "stable" is the number of vocabulary terms that
   cross it across the five nightly snapshots, "allowed" is tools/test-search.mjs.
   The today-equivalent fractions were first run as a CONTROL, in their exact
   four-cut form (60/1,561, 25/1,561, 10/1,561, 30/1,561): over 45 queries -- the 37
   the battery exercises plus the ten the issue names -- that is bit-identical to the
   absolute rule -- 0 status changes, 0 pick changes, 0 retrieval-set changes -- and
   the battery is green. That is the useful thing it establishes: the normalisation
   itself moves NOTHING, so everything the ladder below changes is the values, and
   the two can be argued separately. They were then rejected as values, because they
   sit in the densest part of the df distribution and still drift 32 expansion
   buckets over the same five snapshots, against 12 for the ladder below.

     TAG_DF_TOO_BROAD 0.10   The catalogue's genre markers and nothing else:
                             history 19.5%, storytelling 15.2%, science 12.9%,
                             comedy 10.7%. Measured, the whole 1,366-term
                             vocabulary has NO term between 8% and 10% -- the one
                             empty band in the distribution -- so this cut is the
                             most stable available anywhere: 1 crossing over the
                             five snapshots against 15 for `df > 60`. It is also
                             deliberately the SAME NUMBER as BROAD_DF_THRESHOLD:
                             a token too common to anchor a query is too common to
                             expand INTO, and having those two answers disagree by
                             an accident of tuning is the shape of this whole issue.
                             ONE SCALE SHARED, NOT ONE MEASUREMENT, and the
                             difference has a visible consequence rather than being
                             a caveat. corpusDF reads prose as well as tags and runs
                             a few points higher, so at a shared number the
                             expansion cut is systematically LOOSER than the anchor
                             cut. `engineering` is the live example: corpusDF 12.3%
                             makes it `broad` as a typed token, tagDF 6.3% leaves it
                             in expansions at 0.4x. That is coherent -- "cannot
                             anchor a query alone" and "may still contribute" are
                             different claims -- but it is not the identity the
                             shared value looks like, and anybody retuning one cut
                             should decide about the other rather than inherit it.
                             THE BOUNDARIES DISAGREE TOO, which is the sharpest form
                             of the same point: `broad` is `corpusDF >= this` and
                             expansionBucket is `tagDF > this`, so AT exactly 0.10
                             the two consumers of one number answer oppositely. The
                             strictness is inherited (`df > 60`) and is not worth
                             changing for a value no term has ever held, but a
                             shared constant with two boundary conventions is
                             exactly the kind of thing this issue was.
     TAG_DF_COMMON    0.02   Bounded ABOVE by product quality and below by churn,
                             and the ceiling is a real measurement rather than a
                             preference: at 0.025 the battery goes red on
                             "parenting", because `family` sits at 2.50% and keeps
                             full expansion weight, which puts a kids-science
                             episode about hermit crabs in the top five. 0.02 is
                             the stability optimum under that ceiling -- 17
                             crossings against 33 at 0.016 and 40 for `df > 25`.
     TAG_DF_RARE      0.008  The local minimum of crossings in the region a boost
                             tier can sit at all: 57 at 0.008 against 70 at both
                             0.0064 (today-equivalent) and 0.010, and 91 for
                             `df <= 10`. The low end of the distribution is dense
                             -- 904 terms under 0.2% -- so no cut down here is as
                             quiet as the two above, and saying so is better than
                             implying otherwise.

   WHAT THE VALUES CHANGE TODAY, which the stability figures above do NOT say and a
   future reader will want first. Against main, on 2026-08-18's data: 33 terms change
   expansion bucket and 43 change multiplier. 16 stop being DROPPED, and they are the
   broadest terms in the vocabulary below the genre markers -- health 6.9%, engineer
   6.3%, engineering 6.3%, ai 6.0%, music 5.6%, business 5.5%, narrative 5.3%,
   psychology 5.1%, banter 4.9%, war 4.6%, startup(s) 4.3%, crime 4.2%, self 4.0%,
   military 4.0%, true-crime 4.0% -- so they now enter expansions at 0.4x where the
   3.84% effective cut deleted them. 17 stop being DEMOTED, all between 1.6% and
   2.0% (nutrition, space, stories, philosophy, racing, kids ...), because the demote
   cut moved 1.60% -> 2.00%.
   END TO END that is small and it was checked rather than assumed: over 45 queries
   (the 37 the battery exercises plus the ten the issue names) 0 statuses change and
   5 pick lists do, three of them swapping items and two reordering. The one worth a
   human's eye is a bare `jazz` losing sticky-notes--gershwin-rhapsody from its top
   ten; "the history of jazz", the query the issue names, does not move.

   WHAT REMAINING DRIFT MEANS, because "12 terms still move" invites the wrong
   reading. Under duplication a fraction cannot move at all, so every crossing left
   in the real series is the corpus genuinely becoming more or less ABOUT that term
   -- `crime` 2.2% -> 4.2% over the month is a true-crime wave in the catalogue, and
   responding to it is the point. The absolute rule mixed that signal with pure
   denominator drift and could not tell you which was which. Tunable, and the
   instruments are tools/test-search.mjs and test/search-df-scaling.test.js. */
const TAG_DF_TOO_BROAD = 0.10;
const TAG_DF_COMMON = 0.02;
const TAG_DF_RARE = 0.008;

/* scoreMatch's per-group multiplier, as a function of the query token's tagDF.
   A NAMED EXPORTED FUNCTION rather than an inline ternary, because
   tools/test-search.mjs §3 had to know the tiers to know which fields can clear
   `minScore` on their own, and it MIRRORED them -- a fourth-copy-of-the-matcher
   shape (#249) one level up, and one that #275 would have broken silently: the
   mirror compared a fraction against 10 and 30, every fraction is under 10, so
   every term would have been reported in the top tier and the copy would have
   stayed green while measuring nothing. An oracle may not reimplement its
   subject. */
function dfMultiplier(df) {
  return df <= TAG_DF_RARE ? 1.35 : df <= TAG_DF_COMMON ? 1 : 0.75;
}

/* Which of the three things interpretQuery does to an expansion term, as a function
   of the term's tagDF: "drop" it, keep it at "0.4x" weight, or keep it at "full".
   EXPORTED AND SHARED FOR THE SAME REASON dfMultiplier IS, and review caught that
   the first version of #275 had fixed only half the problem. The df TIERS stopped
   being mirrored, but this RULE was then re-derived in three places --
   test/search-df-scaling.test.js, tools/mobile/prepare-webdir.test.mjs and
   tools/test-search.mjs -- each reading the constants from here and then rewriting
   the comparison. That is the #249 shape again: swap the two branches below and all
   three oracles would agree with each other while disagreeing with the ranker.
   Naming the rule once means an oracle can only be wrong by disagreeing with the
   engine, which is the thing a test is for. */
function expansionBucket(df) {
  return df > TAG_DF_TOO_BROAD ? "drop" : df > TAG_DF_COMMON ? "0.4x" : "full";
}

function tokenize(q) {
  return q.toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !GENERIC_WORDS.has(w));
}

/* ---------- corpus stats (memoized per ctx, same pattern for both) ---------- */

function branchOf(item) {
  const t = item.topics?.[0] || "";
  return t.split("/")[0] || "other";
}

/* How many tagged items carry `term` as a tag, THROUGH THE SHARED MATCHER.
   An ABSOLUTE count. Two callers: `tagDF` below, which divides it by the size of
   the map -- see there for why every THRESHOLD reads the fraction and never this --
   and suggestAdjacentTopics, which ranks coverage and wants a count of items.
   Exported because it is what test/search-matcher.test.js pins the matcher-sharing
   on: a count is the quantity that mechanism is about, and normalising it would only
   add a denominator to every expected value.
   #249. This inlined the pre-#211 loose predicate as an anonymous arrow:

     tags.some(tag => term.length < 4
       ? (tag === term || tag.split("-").includes(term))
       : tag.includes(term))

   -- bare `tag.includes(term)` on the long branch with no collision guard, and no
   plural allowance on the short branch. It was the FOURTH copy of the matcher.
   #219 counted three and fixed them; this one survived because
   test/search-matcher.test.js's reimplementation scan matches NAMED declarations
   and skips search-engine.js by path, so an anonymous arrow in this very file was
   invisible to it. The scan was green with the copy sitting in the same module as
   the original.

   IT WAS NOT A REPORTING BUG. `tagCount` drives expansion pruning in
   interpretQuery (via `tagDF` and `expansionBucket`): over TAG_DF_TOO_BROAD DELETES
   a term from the expansion and over TAG_DF_COMMON cuts its weight to 0.4x, so an
   inflated count silently removes vocabulary. It also sets `group.df`, which picks
   scoreMatch's per-group multiplier (see dfMultiplier). Two consumers, two sets
   of thresholds, both reading a number the ranker itself would never produce.

   Measured over the whole vocabulary (1,364 terms against 1,540 tagged items,
   2026-08-17): 102 terms change count, 94 narrower and 8 wider, 10,035 -> 8,665
   summed. 13 change PRUNING bucket, all of them toward keeping more vocabulary:

     ship          155 -> 6    dropped -> full weight
     story         460 -> 31   dropped -> 0.4x
     tech          137 -> 23   dropped -> full weight
     improv         69 -> 12   dropped -> full weight
     sport          72 -> 49   dropped -> 0.4x
     hang           61 -> 54   dropped -> 0.4x
     entrepreneurs  51 -> 0    0.4x    -> full weight
     search         44 -> 1    0.4x    -> full weight
     wood           41 -> 1    0.4x    -> full weight
     ships          41 -> 6    0.4x    -> full weight
     film           36 -> 21   0.4x    -> full weight
     myth           30 -> 11   0.4x    -> full weight
     physics        27 -> 24   0.4x    -> full weight

   `ship` is the clearest: deleted as "too broad" on a tally built entirely out of
   `relationships` and `championship` substring hits, matches the ranker could
   never make because the ranker uses the guarded matcher. `entrepreneurs` is the
   sharpest -- a true count of ZERO was being read as 51 and having its weight cut.

   A 14th term, `train` (31 -> 7, 0.4x -> full weight), changes bucket only
   because #248 landed first: the loose predicate and the pre-#248 shared matcher
   both counted `training` tags and agreed at 31. It is #248's sense lock becoming
   visible here, not this change's own effect.

   FORWARD REFERENCE, and it is safe: `hitTag` is a `const` arrow declared below.
   `tagCount` is only ever called from query time (tagDF, via interpretQuery, and
   suggestAdjacentTopics), long after module evaluation, so the binding is
   initialized. Do not move a CALL to tagCount -- or to tagDF, which is one line
   over it -- to module scope. */
function tagCount(term, ctx) {
  if (!ctx._dfMemo) ctx._dfMemo = new Map();
  if (ctx._dfMemo.has(term)) return ctx._dfMemo.get(term);
  const tagsMap = ctx.itemTags?.tags || {};
  let n = 0;
  for (const tags of Object.values(tagsMap)) {
    if (tags.some(tag => hitTag(tag, term))) n++;
  }
  ctx._dfMemo.set(term, n);
  return n;
}

/* Fraction of the TAG MAP (0..1) whose tag list carries `term`, through the same
   matcher. #275.

   THIS USED TO BE THE ABSOLUTE COUNT, and every threshold reading it was an
   absolute count too -- `df > 60`, `df > 25`, and scoreMatch's buckets at 10 and
   30 -- while `corpusDF` ten lines down was already a fraction. So half of this
   module's document-frequency logic was scale-free and half was not, which means
   the scale-bound half silently retuned itself every night as the catalogue grew.
   `df > 60` meant "in more than 6.8% of the tag map" at 878 entries and "more
   than 3.8%" at 1,561. Measured over the whole vocabulary (1,366 terms) against
   five real nightly snapshots, 878 -> 1,561 entries, 2026-07-19 -> 2026-08-18: 52
   terms changed expansion bucket and 125 changed score multiplier, with no code
   change and nobody deciding anything.

   THE DENOMINATOR IS THE TAG MAP, NOT THE POOL, and that is the load-bearing
   choice rather than a detail. `corpusDF` divides by `discover.items.length`
   because it counts items; this counts ENTRIES IN THE TAG MAP, so the fraction it
   reports is a fraction of the population it actually scanned. Two consequences:

     it is the only denominator under which SUBSETTING THE MAP can be safe at all.
     #274 wanted to ship the app a tag map trimmed to the items the app bundles
     (1,561 entries -> 649, ~181 KB). Under an absolute count that scales every df
     by ~0.42 and the app ranks differently from the website: `war` 72 -> 24,
     deleted from the expansion on the web and at full weight on the phone.
     Dividing by the map's own size cancels that scaling EXACTLY, so the question
     stops being arithmetic and becomes sampling: a PROPORTIONAL subset reports
     identical fractions (0 terms move -- pinned on fixtures in
     test/search-df-scaling.test.js), and a skewed one does not. #274's real slice
     is skewed, being three items per show, and it still moves 12 expansion buckets
     and 62 multipliers -- down from 66 and 176. So the file is STILL copied whole;
     tools/mobile/prepare-webdir.test.mjs owns that measurement and that refusal.
     Do not read this paragraph as "the trim is now safe".

     it is NOT interchangeable with the pool size, so do not "tidy" it into one.
     `discover.items` and the searched pool are different sets from the tag map
     (app.js searches session.episodes + discover.items; the map is keyed by
     whatever the tagger has reached), and dividing by a set this function never
     walked would reintroduce exactly the two-denominators problem #275 is about.

   Memoized on the same `_dfMemo` as `tagCount` via that function, plus one cached
   map size -- `Object.keys().length` is O(entries) and query time calls this once
   per expansion term. */
function tagDF(term, ctx) {
  if (ctx._dfTotal === undefined) ctx._dfTotal = Object.keys(ctx.itemTags?.tags || {}).length;
  return ctx._dfTotal ? tagCount(term, ctx) / ctx._dfTotal : 0;
}

function itemWordSet(item, tagsMap) {
  const text = [item.title || "", item.hook || "", (item.topics || []).join(" ")].join(" ").toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  (tagsMap?.[item.id] || []).forEach(tag => tag.split("-").forEach(p => words.add(p)));
  return words;
}

/* Fraction of the catalog (0..1) whose title/hook/topics/tags contain `term`
   as a whole word. O(n) per novel term, memoized on ctx — same cost profile
   as tagDF above; catalog is ~1k items so this is sub-millisecond per query. */
function corpusDF(term, ctx) {
  if (!ctx._corpusDfMemo) ctx._corpusDfMemo = new Map();
  if (ctx._corpusDfMemo.has(term)) return ctx._corpusDfMemo.get(term);
  const items = ctx.discover?.items || [];
  let n = 0;
  for (const item of items) {
    if (itemWordSet(item, ctx.itemTags?.tags).has(term)) n++;
  }
  const df = items.length ? n / items.length : 0;
  ctx._corpusDfMemo.set(term, df);
  return df;
}

/* ---------- query interpreter ---------- */

/* QUERY-SIDE LEMMA NORMALIZATION (bare plural/singular mismatch, systemic
   thin-anchor class -- kanban t_fe968b47, filed from t_711dce13).

   data/semantic-index.json's concept term lists carry only ONE of
   {singular, plural} for most lemmas (measured: 305 of 1,364 concept terms
   have a plural-present/singular-absent gap; 848 are singular-only with no
   plural at all). LONG_INFLECTIONS above only widens what a catalogue TERM
   matches in item TEXT -- it does nothing for this step, which is the
   query's typed token being looked up against those same dictionary KEYS
   in interpretQuery's `concepts`/`mods` maps. A query using the "wrong"
   (unlisted) inflection of a real, well-covered concept therefore gets
   hasConceptExpansion=false and, if its own bare corpusDF is also under
   THIN_ANCHOR_DF, reads `thin` -- collapsing an honest, well-covered topic
   to status "empty" on roughly a coin flip (singular vs. plural phrasing).

   This is query-side normalization only: it widens the SET OF KEYS a typed
   token is looked up under before dictionary membership tests, and changes
   nothing about hitText/hitText's catalogue-text matching, scoring, or the
   thin-anchor GATE itself (still exactly `!hasConceptExpansion && corpusDF
   < THIN_ANCHOR_DF`) -- a token that has neither a direct nor a lemma-
   variant concept match is still correctly thin. Three bounded, named
   transforms, chosen for measured coverage of the repro set (not a
   stemmer): strip/add bare "s", strip/add sibilant "es"
   (glass/glasses-shaped), and swap "y"<->"ies" (energy/energies-shaped --
   deliberately in scope HERE even though the hitText comment above rules
   y<->ies OUT for catalogue-text matching: that guard is about not
   mutating a TERM's regex to match unpredictable TEXT, a materially
   different and riskier operation than an exact-string dictionary lookup
   on a bounded, reviewable transform of the QUERY token itself).
   Deliberately excluded, same reasoning as LONG_INFLECTIONS/#248: "ing"
   (verb-sense ambiguity, e.g. train/training) and "ed" (participle noise)
   -- neither is a singular/plural relationship, so neither belongs to a
   helper scoped to that one gap.

   INVARIANT_S_NOUNS: bare-"s" stripping (e.g. cats -> cat) is a real
   guess, and it is wrong for a bounded, named set of words that are
   already singular/mass nouns despite ending in "s" -- stripping them
   manufactures an unrelated token (news -> new is the review-caught
   case: a "news" query would then also match anything containing "new",
   flipping thin/broad status on a fabricated word). Named and bounded
   like SENSE_LOCKED_STEMS above, not a general dictionary check.
   Extended (codex review round 4) with possessive pronouns (ours,
   yours, hers, theirs -- "our"/"your"/"her"/"their" are unrelated,
   extremely common words, the worst case for a fabricated bare-s strip)
   and common "-us"/"-as" singular nouns that are not plurals of
   anything (status, bias, canvas, atlas, gas, census, bonus, focus,
   consensus, corpus, campus, virus, cactus, plus, minus, bus, plus the
   already-covered "-ics" family above). A general "don't strip before
   us/as" rule was considered and rejected: it would also block real
   +s plurals of the same shape (areas -> area, ideas -> idea, pizzas ->
   pizza), so this stays a named list rather than a suffix rule.

   Directional (codex review round 5): membership in this set only
   blocks the DESPLURALIZE branches (stripping a trailing s/es to guess
   a shorter, likely-wrong singular). It must NOT also block the
   PLURALIZE branch -- an invariant word can still be a real singular
   that the taxonomy indexes only by its plural, same as any other
   concept (measured case: data/semantic-index.json's decision-making
   concept lists "biases" but not "bias"). Blocking pluralize too would
   silently preserve the exact asymmetry this whole fix exists to
   remove, just for a different word class. */
const INVARIANT_S_NOUNS = new Set([
  "news", "series", "species", "means", "outskirts", "measles",
  "mathematics", "physics", "statistics", "economics", "politics",
  "athletics", "gymnastics", "electronics", "graphics", "ethics",
  "aerobics", "logistics", "genetics", "ceramics",
  "ours", "yours", "hers", "theirs",
  "status", "bias", "canvas", "atlas", "gas", "census", "bonus",
  "focus", "consensus", "corpus", "campus", "virus", "cactus",
  "plus", "minus", "bus",
]);

/* SENSE_LOCKED_PLURALS: a bounded, named set of plural query tokens
   whose bare-s-stripped "singular" is a REAL WORD but the WRONG SENSE
   -- same failure shape as SENSE_LOCKED_STEMS/#248 above (a term can be
   a genuine inflection of the wrong sense of an ambiguous stem), just
   surfaced through this helper's despluralize branch instead of
   hitText's inflection suffix. Measured case (codex review round 7,
   direct repro): "marines" (the military branch/service members) bare-
   s-strips to "marine", which data/semantic-index.json indexes under
   the OCEAN concept ("marine biology") -- so a "marines" query picked
   up ocean vocabulary and topic boosts despite the catalogue's own
   military content. This blocks despluralize only for the exact listed
   token (not a general "don't strip near military words" rule, which
   would be unbounded); pluralize is unaffected, same directional
   split as INVARIANT_S_NOUNS above. */
const SENSE_LOCKED_PLURALS = new Set(["marines"]);
function lemmaVariants(tok) {
  const out = new Set();
  let despluralized = false;
  const invariant = INVARIANT_S_NOUNS.has(tok) || SENSE_LOCKED_PLURALS.has(tok);
  if (!invariant) {
    if (/[^aeiou]ies$/.test(tok) && tok.length > 4) {
      /* Same ambiguity as the "es" branch below, one letter over: real
         y<->ies plurals (city -> cities, gladiator query set: entry ->
         entries) genuinely strip to "...y", but a singular that already
         ends in silent "ie" (movie, cookie, zombie) only ever added a
         bare "s" -- movies/cookies/zombies are NOT y-pluralized, so
         stripping "ies"->"y" mangles them to "movy"/"cooky"/"zomby"
         (codex review round 6, direct repro). Emit both candidates, same
         "wrong one is harmless" reasoning as the es-branch fix: strip
         "ies"->"y" for the real y-plural case, and separately strip only
         the bare "s" for the silent-ie case (movies -> movie). */
      out.add(tok.slice(0, -3) + "y");
      out.add(tok.slice(0, -1));
      despluralized = true;
    } else if (/(?:s|x|z|ch|sh)es$/.test(tok) && tok.length > 4) {
      /* Ambiguous without a dictionary: "kisses"/"boxes"/"buzzes"/"catches"/
         "dishes" genuinely take +es (singular strips 2 chars: kiss, box,
         buzz, catch, dish), but "cases"/"houses"/"mazes"/"sizes" are a
         silent-e singular ("case", "house", "maze", "size") that only ever
         added a bare "s" -- stripping 2 chars from those yields a nonsense
         fragment ("cas", "hous") that fails every concept/corpus lookup and
         silently drops the systemic fix for this common noun class (codex
         review P2, t_fe968b47). Emit BOTH candidates rather than guessing:
         the wrong one is harmless (a fragment string no real concept or
         corpus text will ever contain), and the right one is now always
         present. */
      out.add(tok.slice(0, -2));
      out.add(tok.slice(0, -1));
      despluralized = true;
    } else if (/s$/.test(tok) && !/ss$/.test(tok) && tok.length > 3) {
      /* Same ambiguity family as the two branches above, for the plainest
         shape: "cats" -> "cat" is correct, but a handful of real
         SINGULAR nouns also end in a bare "s" whose actual plural adds
         "es" rather than being the despluralized guess's inverse --
         "lens" (photography/optics) is not itself a plural of "len"; its
         real plural is "lenses" (codex review round 7, direct repro:
         data/semantic-index.json's photography concept lists "lenses"
         but not "lens"). Emitting both the despluralize guess (harmless
         fragment when wrong) and the tok+"es" pluralize candidate closes
         this without a dictionary, same pattern as the ies/es branches
         above. */
      out.add(tok.slice(0, -1));
      out.add(tok + "es");
      despluralized = true;
    }
  }
  /* Only try to PLURALIZE tok when none of the branches above already
     recognized it as a plural shape -- otherwise an already-plural token
     ending in a sibilant (e.g. "warriors") falls into the `es` branch here
     too and manufactures a nonsense double-plural ("warriorses") on top of
     the correct singular already added above. Singularization and
     pluralization are mutually exclusive views of the same token. */
  if (despluralized) return out;
  if (/[^aeiou]y$/.test(tok) && tok.length > 3) {
    out.add(tok.slice(0, -1) + "ies");
  } else if (/(?:s|x|z|ch|sh)$/.test(tok)) {
    out.add(tok + "es");
  } else if (!/s$/.test(tok)) {
    out.add(tok + "s");
  }
  return out;
}

function interpretQuery(q, ctx) {
  const tokens = tokenize(q);
  const filters = [];
  const topicBoosts = new Set();
  const mods = ctx.semantic?.modifiers || {};
  const concepts = ctx.semantic?.concepts || {};

  const contentTokens = tokens.filter(tok => {
    if (mods[tok]) { filters.push(mods[tok]); return false; }
    return true;
  });

  const groups = contentTokens.map(tok => {
    const aliasesOf = ALIASES[tok] || [];
    const exactKeys = new Set([tok, ...aliasesOf]);
    /* See lemmaVariants above -- bridges a query token to a concept that
       only lists the OTHER inflection (singular/plural) of the same
       lemma. Concept-membership lookup only; does not add scoring terms
       or change what literal text this token's own addTerm() calls
       match.

       FALLBACK ONLY, never additive to an exact match: the semantic
       index deliberately assigns different senses to different
       inflections in places (e.g. "transmission" -> energy-grid,
       "transmissions" -> motorsport). If the exact typed token already
       resolves to a concept, lemma variants are held back entirely --
       merging both senses into one query would silently blend two
       concepts the taxonomy intentionally kept apart. Only when the
       exact token has NO concept of its own do we widen the lookup to
       the other inflection, which is the actual bug this card describes
       (a real, well-covered concept reachable only from its other
       spelling). */
    const hasExactConceptMatch = Object.values(concepts).some(c => c.terms?.some(t => exactKeys.has(t)));
    /* Computed once and reused everywhere below (lookupKeys, addTerm,
       broad/thin) -- avoids recomputing lemmaVariants(tok) three separate
       times and, more importantly, avoids the corpusDF scans it feeds
       into for a token whose variants are never actually going to be
       used for matching. When the exact token already owns a concept,
       the fallback set is empty: this is what makes the fallback GATE
       (not just the final addTerm/lookupKeys use) actually skip the
       catalog-scanning corpusDF(variant) calls flagged in codex review
       round 3 -- a fresh "culture"/"cultures" interpretQuery() dropped
       from ~200ms to a cache-warmed corpusDF's usual cost once other
       concept-backed tokens stop paying for variants they never use. */
    const fallbackVariants = hasExactConceptMatch ? [] : [...lemmaVariants(tok)];
    const lookupKeys = new Set(exactKeys);
    for (const v of fallbackVariants) lookupKeys.add(v);

    /* term -> {w, source}. source "own" = the token's literal text, its
       aliases, or its concept's *own* terms (full scoring weight, eligible
       for tag/topic bonuses). source "related" = pulled in via a *related*
       concept — capped below to title/hook/show text only, so an unrelated
       concept's vocabulary (e.g. bbq -> food-science -> "nutrition") can
       never single-handedly manufacture a match on an unrelated item. */
    const terms = new Map();
    const addTerm = (t, w, source) => {
      const cur = terms.get(t);
      if (!cur || w > cur.w || (w === cur.w && source === "own" && cur.source !== "own")) {
        terms.set(t, { w, source });
      }
    };
    addTerm(tok, 1, "own");
    aliasesOf.forEach(a => addTerm(a, 0.9, "own"));
    /* Bare literal fallback for the corpus-text-only case (no concept
       covers either inflection at all, e.g. culture/cultures below): a
       token's own hitText pattern is built FROM that exact string, and
       LONG_INFLECTIONS only APPENDS a suffix, so a plural query token's
       literal pattern ("cultures(?:s|es|ing)?") can never match catalogue
       text that only ever spells the concept's singular ("culture") --
       inflection allowance widens what a term matches forward, not what
       a query maps backward onto a shorter surface form. Adding the
       lemma variant as its own additional literal term (same "own"
       weight as the typed token itself) closes that gap without
       touching hitText's matcher or LONG_INFLECTIONS at all.

       GATED on hasExactConceptMatch, same as the lookupKeys widening
       above (codex review round 2, P2): even as bare literal text, an
       own-weight term is eligible for tag/topic bonuses via
       expansionBucket below, so unconditionally adding the variant let a
       "transmissions" (motorsport) query's own-weight "transmission"
       term still match energy-grid items that spell the singular --
       the same sense-blend the lookupKeys gate exists to prevent, just
       reached through the literal-term path instead of the concept-
       membership path. Skipping it when the exact token already owns a
       concept costs nothing for the real fix target (culture/cultures:
       neither inflection has ANY concept, so hasExactConceptMatch is
       false and this still fires exactly as intended). */
    if (!hasExactConceptMatch) {
      for (const v of fallbackVariants) addTerm(v, 1, "own");
    }

    const others = contentTokens.filter(o => o !== tok);
    const otherKeys = others.map(o => new Set([o, ...(ALIASES[o] || [])]));

    let hasConceptExpansion = false;
    for (const [cid, c] of Object.entries(concepts)) {
      if (!c.terms?.some(t => lookupKeys.has(t))) continue;
      hasConceptExpansion = true;
      const related = new Set(c.related || []);
      const supported = others.length === 0 || otherKeys.some(okeys => {
        if (c.terms.some(t => okeys.has(t))) return true;
        return Object.entries(concepts).some(([oid, oc]) =>
          oc.terms?.some(t => okeys.has(t)) && (related.has(oid) || (oc.related || []).includes(cid)));
      });
      const wTerm = supported ? 0.6 : 0.25;
      const wRelated = supported ? 0.25 : 0.1;
      c.terms.forEach(t => addTerm(t, wTerm, "own"));
      if (supported) (c.topics || []).forEach(t => topicBoosts.add(t));
      (c.related || []).forEach(rid => {
        const rc = concepts[rid];
        if (rc) rc.terms?.forEach(t => addTerm(t, wRelated, "related"));
      });
    }

    for (const [t, info] of [...terms]) {
      if (info.w >= 1) continue;
      const bucket = expansionBucket(tagDF(t, ctx));
      if (bucket === "drop") terms.delete(t);
      else if (bucket === "0.4x") terms.set(t, { ...info, w: info.w * 0.4 });
    }

    return {
      token: tok,
      terms,
      /* Both `broad` and `thin` read the MAX corpusDF across the token and
         its lemma variants (see lemmaVariants above, reused via
         fallbackVariants -- computed once above, not re-derived here, so
         a concept-backed token's variants are never scanned at all, per
         codex review round 3's latency finding), not just the bare typed
         spelling. Without this, a lemma pair where NEITHER inflection has
         concept coverage (e.g. culture/cultures -- no concept or modifier
         carries either) but the OTHER inflection is common in the
         catalogue text (culture: corpusDF ~3.9%) would still read the
         untried inflection ("cultures") as thin purely because its own
         bare spelling has zero literal corpus hits, even though the
         addTerm() call above already added "culture" as a same-weight
         literal term that WILL match. Taking the max keeps thin/broad
         honest about what this group can actually match, independent of
         which inflection the query happened to type. */
      broad: Math.max(corpusDF(tok, ctx), ...fallbackVariants.map(v => corpusDF(v, ctx))) >= BROAD_DF_THRESHOLD,
      df: tagDF(tok, ctx),
      hasConceptExpansion,
      /* See THIN_ANCHOR_DF below -- a specific, real word the taxonomy has
         not modeled AND the catalogue barely mentions. */
      thin: !hasConceptExpansion &&
        Math.max(corpusDF(tok, ctx), ...fallbackVariants.map(v => corpusDF(v, ctx))) < THIN_ANCHOR_DF,
    };
  });

  const primaryGroups = groups.filter(g => !g.broad);
  /* A query where every specific (non-broad) token is ALSO unrecognized by
     any concept's vocabulary looks like a proper noun (a person/show name),
     not a topic phrase -- topic words are almost always concept terms once
     the index has real coverage for them. Only for that narrow shape do we
     require every primary token to match (AND), not just one (OR): a named-
     entity query where only one of two names coincidentally matches
     something unrelated (e.g. "lex" alone matching an Ancient Rome episode
     about the "Lex Juliae") should not qualify. Topic-phrase queries (at
     least one token IS concept vocabulary) keep OR semantics -- requiring
     every word of "nuclear fusion energy" to literally co-occur would hurt
     recall for legitimate broader topic matches. */
  const properNounQuery = primaryGroups.length >= 2 && primaryGroups.every(g => !g.hasConceptExpansion);

  /* THIN ANCHORS (#209 -- "Electrical Circuit Design Dummies" returning
     game-design/finance content).

     Plain OR semantics (below, non-properNoun path: "at least one primary
     group matched") assumes every primary token is roughly as trustworthy a
     signal as any other. That assumption breaks for a token that is BOTH
     unmodeled by the taxonomy (no concept carries it, so it can only ever
     match by bare literal text -- no sense-disambiguation, no tag/topic
     bonus) AND almost absent from the catalogue (corpusDF under
     THIN_ANCHOR_DF): such a token is real and specific -- exactly the word
     the query is actually about -- but under OR semantics it can be
     silently dropped in favour of whatever OTHER primary token the query
     happens to also contain, if that other token is common. That is
     precisely what happened: "circuit"/"electrical"/"dummies" in
     "Electrical Circuit Design Dummies" each match at most one or two
     catalogue items (df ~0.0005-0), so none of them anchor anything, while
     "design" -- a real concept term but also a common literal word
     (Game Design Round Table, Design Matters, Designer Notes) -- carries
     the whole query alone. The result reads as a confident 10-pick answer
     about circuit design and is actually 10 picks about "design" the show
     title.

     The fix is not to matcher-tune "design" (it is a correct match for
     product/industrial-design queries, see the "design" battery case) --
     it is to stop letting a thin token get overridden instead of honestly
     reported as uncovered. A thin primary group must ALSO appear in a
     result for that result to qualify at all (searchWithRelaxation), on
     top of (not instead of) the normal hasPrimary/properNoun gates. That
     leaves plain OR recall untouched for the common case (every primary
     token is either concept-backed or has real catalogue presence) and
     only tightens the narrow case a thin token identifies -- usually
     collapsing the result set to genuinely honest sparse/empty, per
     product principle #1, rather than fabricating relevance from whichever
     other word happened to be common.

     0.002 (0.2% of the catalogue): calibrated against corpusDF, one order
     of magnitude under BROAD_DF_THRESHOLD's floor and TAG_DF_RARE (0.008,
     a DIFFERENT measure, tag-map DF not corpus DF, so not directly
     comparable) -- deliberately far below "rare but real" (e.g. "fusion"
     ~a few percent) so it only catches tokens with essentially no
     catalogue footprint, not merely uncommon ones. See
     test/search-thin-anchor.test.js for the calibration cases this value
     must keep passing. */
  const thinAnchorCount = primaryGroups.filter(g => g.thin).length;

  return {
    groups, filters, topicBoosts,
    hasPrimary: primaryGroups.length > 0,
    properNounQuery,
    primaryGroupCount: primaryGroups.length,
    thinAnchorCount,
  };
}

function passesFilters(item, filters) {
  for (const f of filters) {
    if (f.type === "duration_max" && !(item.duration_min && item.duration_min <= f.value)) return false;
    if (f.type === "duration_min" && !(item.duration_min && item.duration_min >= f.value)) return false;
    if (f.type === "branch" && !f.value.includes(branchOf(item))) return false;
    if (f.type === "recency_days") {
      const d = new Date(item.release_date || 0);
      if ((Date.now() - d.getTime()) / 86400000 > f.value) return false;
    }
  }
  return true;
}

/* Terms >=4 chars used to match via plain substring (text.includes(t)),
   which collides on an unrelated word that happens to CONTAIN the term:
   "fusion" inside "diffusion", "roman" inside "romance"/"romantic",
   "team" inside "steam". So instead of a blanket switch to word-boundary
   matching (which would break legitimate plural matches some concepts
   rely on, e.g. a term "rocket" matching text "rockets"), this is a
   word-boundary match on BOTH sides with a bounded suffix allowance in
   between: no letter/digit immediately before, the named inflections
   below, then no letter/digit immediately after. Blocks all three known
   collisions, keeps plural matching, touches nothing else.

   THE TWO GUARDS BLOCK DIFFERENT COLLISIONS, and conflating them cost this
   file two wrong claims. Earlier revisions of this comment said "all three
   known collisions add extra letters BEFORE the term, never after", and
   tools/test-search.mjs §6 said the romance case could not witness the
   guard because scoring kept it out. Both are wrong, measured 2026-08-17:

     LEADING lookbehind  blocks dif+fusion and s+team -- letters before.
     TRAILING lookahead  blocks roman+ce and roman+tic -- letters AFTER.

   Delete the lookbehind and the `diffusion` case goes red; delete the
   lookahead and the `romance` case goes red, scoring notwithstanding -- with
   the lookbehind gone the romance item still scores 0, because "romance" was
   never a prefix collision. Each guard has its own witness; neither is
   redundant. See test/search-matcher.test.js, where they are pinned as two
   separate tests for this reason.

   MODULE SCOPE AND EXPORTED, as of 2026-08-17. These were closures inside
   scoreMatch, and `tools/test-search.mjs` — the battery that judges whether a
   result is "on-topic" — had its own unguarded `text.includes(needle)` instead.
   So the ORACLE was looser than the ranker it grades: it admitted "software" and
   "toward" for `war`, "romance" for `roman`, "confusion" for `fusion`. The last
   two are collisions this very comment names and that the battery separately
   asserts the ranker must not make. An oracle may not be more permissive than
   its subject, and the only way to guarantee that is to share the matcher rather
   than to reimplement it. Do not inline these again.

   THE SUFFIX SIDE WIDENED, AND ONLY THE SUFFIX SIDE, 2026-08-17 (#218). An
   optional "s" was too narrow to be honest about English: `grill` could not
   match "grilling", so the battery's own bbq needle contributed nothing and
   every coverage count taken through this matcher under-reported. The prefix
   guard above is UNCHANGED and must stay that way -- the asymmetry the previous
   paragraphs describe is real (all known collisions prepend letters), and it is
   the only thing standing between this matcher and the "software"/"toward"-as-war
   flood.

   The allowance is a BOUNDED, NAMED set of inflections, not a stemmer, because a
   stemmer's failure mode here is unbounded and unreviewable while a three-element
   list can be justified element by element and measured. Over the whole query
   vocabulary (1,364 concept terms) against every surface word in the pool:

     s    kept as-is.
     es   4 pairs (coach/coaches, crash/crashes, glass/glasses,
          tornado/tornadoes) -- the plural of every term that ends in a sibilant,
          which a bare "s" structurally cannot reach.
     ing  19 pairs, and the reason #218 exists: grill/grilling. Also
          engineer/engineering, murder/murdering, coach/coaching, film/filming.
          Worth 258 (term, item) matches, the bulk of this change.

   `ed` WAS IN THIS SET AND WAS CUT, which is worth recording because the first
   version of this comment argued for it. It looked free on the battery's 51
   needles -- 4 real items, three "murdered" true-crime episodes and one
   "crashed" bomber, no visible cost. Measured over the whole vocabulary instead
   of over the needles, it is a losing trade: of the ~18 (term, item) matches it
   adds, roughly 4 are on-subject and the rest are participles used as filler in
   prose that is about something else -- "AI-powered threats" for `power`,
   "engineered" for `engineer`, "launched" a startup for the `space`/`rockets`
   sense of `launch`. Needle-scoped measurement could not see that, because none
   of those terms is a needle. The earlier comment promised `ed` would be the
   first thing dropped if a measurement found it costing precision. It did, so it
   is.

   WHAT THIS SET GETS WRONG ON ITS OWN, and what SENSE_LOCKED_STEMS below does
   about it: the scan behind the table above applied a MORPHOLOGICAL test -- is
   the surface word an inflection of the term -- and passing it does not make a
   match right. A term can be a genuine inflection of the wrong SENSE of an
   ambiguous stem. `train` is a term of the `trains` concept
   (topics: transport/trains) and carries only the railway sense, but `training`
   is a real inflection of the unrelated verb, so `ing` newly matched 32 fitness,
   dog-training and AI-pre-training items. That was user-visible, not just an
   oracle count: `search("train history")` returned "The Pre-Training Wall" and a
   speed-training episode inside its top 10.
   This is NOT fixable by choosing different suffixes -- `ing` is exactly what
   #218 asks for, and `grill`/`grilling` needs it. It is a vocabulary problem: an
   ambiguous bare stem in a single-sense concept. #218 names the substitution
   ("matcher changes and vocabulary changes can substitute for each other here"),
   and #248 is the fix: a second, smaller named set that subtracts `ing` for the
   handful of stems where it is provably the wrong verb. Note what #248 rules out
   as the tempting non-fix -- dropping `train` from the concept would stop the
   natural singular from triggering it at all, no topic boost and no expansion to
   `railway`/`locomotive`, which is the very defect #218 exists to fix.

   Deliberately OUT: y->ies (story/stories), e-dropping (bake/baking) and any
   consonant doubling. Each needs to MUTATE the stem rather than append to it,
   which is stemming; the honest fix for those is vocabulary, see below.

   THE UNDER-4-CHAR BRANCH GETS "s" AND NOTHING MORE, and that asymmetry is
   measured rather than assumed. Same scan, restricted to the 42 short terms the
   vocabulary actually contains: "s" yields 14 pairs, all true plurals (war/wars
   -- the second half of #218 -- plus art/arts, car/cars, lab/labs, llm/llms).
   "es" yields exactly one pair and it is wrong: rag/rages, where `rag` is
   retrieval-augmented generation. "ing" likewise yields exactly one, also wrong:
   car/caring. "ed" yields none at all. A three-letter stem is a prefix of too
   much English for anything but the plural to be safe, which is the same
   reasoning that put the length-4 threshold here in the first place.

   Note what this does NOT fix, so nobody re-files it: this widens what a TERM
   matches in the text, never what a typed QUERY word maps to. Query "grilled"
   still finds nothing, because `grilled` is not a term in any concept and
   nothing stems it back to `grill`. And data/semantic-index.json is still full
   of hand-authored inflection pairs (engineering/engineers/engineer,
   trains/train, books/book, laugh/laughs) doing this matcher's job by hand --
   which is why "grill" already returned 8 correct picks before this change,
   through the `bbq` concept's separately authored `grilling` term. That
   redundancy is now harmless rather than load-bearing; retiring it is a
   vocabulary question, not a matcher one. */
const LONG_INFLECTIONS = "(?:s|es|ing)?";
const SHORT_INFLECTIONS = "s?";

/* Stems that take the plural and NOTHING ELSE: `(?:s|es)?` instead of the set
   above. #248. A second named list is a cost -- the paragraph above argues for
   "one bounded, named set" and this breaks that property -- so it carries a
   MEMBERSHIP RULE, not just members, and a measurement per member. Without a
   rule a reader cannot tell whether a new term belongs, and a list nobody can
   extend correctly rots into a list of whatever happened to get reported.

   THE RULE. A term belongs here when ALL THREE hold:

     1. The concept carries the term's NOUN sense, and the `-ing` form is the
        gerund of a DISTINCT VERB -- not a metaphor or an unusual reading of the
        same verb. `train` (railway carriage) vs. `to train` (instruct); `book`
        (printed volume) vs. `to book` (reserve). This noun/verb split is the
        shape every member below has, and stating it that way is what makes the
        rejected list decidable: where the concept's own sense IS the verb
        (`to grill`, `to coach`, `to engineer`), the gerund is on-sense and the
        term does not belong here.
     2. Every concept carrying the term carries only that ONE sense of it, so
        there is no reading under which the `-ing` match would be on-sense. A
        term in two concepts fails this by construction.
     3. Measured over the pool, the items the `-ing` form adds are OFF-SENSE for
        those concepts' topics. This is the clause with teeth: 1 and 2 are
        arguments, 3 is a count, and 3 is what disqualified two of the terms
        #248 proposed on the strength of 1 and 2 alone.

   Rule out an over-reading: this is NOT "the -ing form is a different part of
   speech" and NOT "some off-topic item matched". `powering` in "just powering
   through" is the same verb as `power`, used figuratively, and `searching` in
   "soul searching" is the same verb as `search` -- both surface an off-topic item
   and NEITHER belongs here, because the fix for a figurative use is ranking, not
   the matcher. Membership needs a different VERB.

   MEMBERS, each with the count of pool items its `-ing` form adds that clause 3
   finds off-sense (whole vocabulary against every surface word in the pool, 1,322
   terms of >=4 chars over 1,540 items, 2026-08-17):

     train    32  `trains` [transport/trains]. `training` -- to instruct/exercise.
                  All 32 are fitness (sports/biomechanics), dog-training or
                  AI-pre-training (computing/history); none is a railway. The
                  reason #248 exists.
     market   10  `markets` [economics/markets]. `marketing` -- to advertise. The
                  concept is unambiguously the finance NOUN (investing, stocks,
                  wall-street, commodities, valuation); the verb "to market" is
                  the distinct advertising sense. All 10 land in
                  business/founders, health/nutrition, medicine/neuroscience or
                  business/startups; zero in economics/markets -- "wellness
                  marketing", "brand building", "separating scientific promise
                  from marketing hype".
                  NOT reported in #248 -- found by re-running its scan -- and it
                  REVERSES A CHOICE #218 MADE: test/search-matcher.test.js
                  asserted `hitText("marketing", "market")` as a WIN of the `ing`
                  allowance, on a morphological reading, with no item-level
                  measurement attached. Clause 3 is the disagreement, and clause 3
                  is a count. That assertion now pins the opposite, and says so.
     hang      2  `comedy` [comedy/casual-hangs, comedy/stand-up]. `hanging` -- to
                  suspend. Both topics are the one "casual hangout" sense of the
                  noun. #248 guessed this was "arguably on-sense"; the two items
                  are an F1 refuelling debate ("the dilemma hanging over F1's
                  future") and an Odd Lots episode ("Fed Independence Is Now
                  Hanging by a Thread"). Idiom, not comedy.
     book      1  `books` [linguistics/language, culture/books]. `booking` -- to
                  reserve. Both topics are the printed-volume sense. The item is a
                  Delta CEO episode on summer travel.
     wind      1  `clean-energy` [engineering/energy-*, automotive]. `winding` --
                  to twist. The item is an Armchair Expert true-crime interview.

   REJECTED, which is where the rule earns its place -- these are the terms whose
   `-ing` form the same scan reports, kept OUT by clause 1 or 2, and together they
   are 212 of the 258 `-ing`-only (term, item) pairs in the pool:

     engineer 188  `engineering` is the SAME verb. Fails 1. This is the bulk of
                   what #218 bought, and a rule that touched it would be wrong.
     coach      8  `coaching`, same verb, and the concept is `training`
                   [sports/biomechanics] -- squarely on-sense. Fails 1.
     grill      7  `grilling`, same verb. Fails 1, and it is #218's whole point.
     homebrew   3  `homebrewing`, same verb. Fails 1.
     film       2  `filming`, same verb (fails 1), AND `film` is carried by both
                   `celebrities` and `filmmaking` (fails 2 independently).
     power      1  `powering`, same verb used figuratively. Fails 1 -- see the
                   over-reading note above.
     search     1  `searching` ("soul searching"), same verb. Fails 1.
     craft      1  `crafting`, same verb. Fails 1.
     murder     1  `murdering`, same verb. Fails 1.

   `es` STAYS ON for these five, so the list subtracts exactly one suffix and no
   more: none of "traines"/"marketes"/"hanges"/"bookes"/"windes" is a word, so the
   allowance is inert here and keeping it means one fewer axis on which this list
   can differ from the main set.

   WHAT THIS DOES NOT COST, checked rather than assumed: none of the five is a
   needle in tools/test-search.mjs's 51, and none of `marketing`/`hanging`/
   `booking`/`winding`/`training` is itself a term in data/semantic-index.json --
   except that a typed query word always matches its own literal text, so
   search("marketing") is unaffected either way. `training` additionally has its
   own concept (`training`, sports/biomechanics), so search("dog training")
   reaches it through that concept and not through `train`. */
const SENSE_LOCKED_STEMS = new Set(["train", "market", "hang", "book", "wind"]);
const SENSE_LOCKED_INFLECTIONS = "(?:s|es)?";

/* Compiled patterns are CACHED per term, which is a real cost here rather than
   premature tuning. scoreMatch calls hitText five times per term per item over a
   1,540-item pool, so a single battery run is millions of calls, and the terms
   repeat on every one of them. It also repairs a regression this change would
   otherwise have introduced: hitTag's short branch used to be a string compare
   (`tag === t || tag.split("-").includes(t)`) and now needs a pattern, which
   measured ~4us per call compiling one regex PER HYPHEN SEGMENT. Cached, both
   branches are cheaper than what they replace.
   Keyed by branch + term, since the same term compiles differently on each. The
   size cap matters because query tokens come from a text box, so the key space is
   attacker-controlled in a long-lived tab; the vocabulary itself is ~1,400 terms,
   so the cap is never reached by legitimate use. Clearing wholesale is fine --
   these are pure functions of the key and cost microseconds to rebuild. */
const PATTERN_CACHE_MAX = 4000;
const patternCache = new Map();
function compiledPattern(key, build) {
  let re = patternCache.get(key);
  if (re === undefined) {
    if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.clear();
    re = build();
    patternCache.set(key, re);
  }
  return re;
}
/* The suffix set is chosen per TERM, and it is a pure function of the term, so the
   existing "long:"+t cache key stays correct -- a sense-locked stem can only ever
   compile to its own narrower pattern. */
const longTermPattern = (t) =>
  compiledPattern("long:" + t, () => new RegExp("(?<![a-z0-9])" + t +
    (SENSE_LOCKED_STEMS.has(t) ? SENSE_LOCKED_INFLECTIONS : LONG_INFLECTIONS) + "(?![a-z0-9])"));
const shortTermPattern = (t) =>
  compiledPattern("shortText:" + t, () => new RegExp("\\b" + t + SHORT_INFLECTIONS + "\\b"));
const shortTagPattern = (t) =>
  compiledPattern("shortTag:" + t, () => new RegExp("^" + t + SHORT_INFLECTIONS + "$"));
const hitText = (text, t) =>
  (t.length < 4 ? shortTermPattern(t) : longTermPattern(t)).test(text);
const hitTag = (tag, t) => {
  if (t.length >= 4) return longTermPattern(t).test(tag);
  const re = shortTagPattern(t);
  return tag.split("-").some(seg => re.test(seg));
};

function scoreMatch(item, interp, itemTags) {
  const title = item.title.toLowerCase();
  const hook = (item.hook || "").toLowerCase();
  const show = item.show.toLowerCase();
  const topics = (item.topics || []).join(" ").toLowerCase();
  const tags = itemTags?.tags?.[item.id] || [];

  let sum = 0;
  let matchedGroups = 0;
  let primaryMatched = 0;
  let thinMatched = 0;
  for (const group of interp.groups) {
    let best = 0;
    for (const [t, info] of group.terms) {
      let f = 0;
      /* "related"-sourced terms never get the tag/topic bonuses -- those are
         the strong signals, and a term borrowed from a neighboring concept
         (not the query's own concept) must not be able to out-rank a
         genuine match using them. See addTerm() above. */
      if (info.source !== "related") {
        if (tags.some(tag => hitTag(tag, t))) f += 2.5;
        if (hitText(topics, t)) f += 3;
      }
      if (hitText(title, t)) f += 2;
      if (hitText(hook, t)) f += 1.5;
      if (hitText(show, t)) f += 1;
      best = Math.max(best, f * info.w);
    }
    if (best >= 1.2) {
      matchedGroups++;
      if (!group.broad) primaryMatched++;
      if (group.thin) thinMatched++;
    }
    sum += best * dfMultiplier(group.df);
  }
  for (const tb of interp.topicBoosts) {
    if ((item.topics || []).includes(tb)) sum += 2;
  }

  /* Full-phrase show-name RESCUE: a multi-word query where every token
     appears as a whole word in the show name is almost certainly a direct
     show/host search ("lex fridman", "huberman lab"). Those often can't
     cross the normal per-term threshold on their own -- the only real
     signal is a flat +1 show-field hit per term, deliberately capped low
     since a single show-word hit alone is weak evidence.

     Gated on `!wouldPassGate`: only items that would otherwise be EXCLUDED
     get this treatment. An early version applied it unconditionally and
     regressed "crime junkie"/"endurance running" from rich to sparse --
     shows whose NAME happens to equal the query (Crime Junkie, Physiology
     & Endurance Running) already pass normally through real topic/tag
     matches, and adding +8 on top of an already-good score inflated the
     query's *relative* strong-match bar (see classifyResults), knocking
     other genuinely-good matches (other true-crime/endurance shows) out
     of the "strong" set even though nothing about THEIR relevance
     changed. Gating on "would otherwise be excluded" makes this a pure
     rescue for the recall gap it targets, with zero effect on any query
     that already worked -- verified via the full battery. */
  const wouldPassGate = interp.properNounQuery
    ? primaryMatched === interp.primaryGroupCount
    : (interp.hasPrimary ? primaryMatched > 0 : matchedGroups > 0);
  if (!wouldPassGate && interp.groups.length >= 2) {
    const allTokensInShow = interp.groups.every(g => new RegExp("\\b" + g.token + "\\b").test(show));
    if (allTokensInShow) {
      sum += 8;
      matchedGroups = interp.groups.length;
      primaryMatched = interp.primaryGroupCount;
      thinMatched = interp.thinAnchorCount;
    }
  }

  return { sum, matched: matchedGroups, primaryMatched, thinMatched };
}

/* pool must already be pre-filtered (family mode etc. — app.js's poolFiltered()).
   rankFallback(item) ranks the zero-content-token case (e.g. a bare "short"
   duration query) — app.js passes its personalized interestScore; tests can
   omit it and get a stable 0.5 for every item. */
function searchWithRelaxation(pool, interp, minScore, itemTags, rankFallback) {
  const attempt = (filters) => {
    const p = pool.filter(i => passesFilters(i, filters));
    if (!interp.groups.length) {
      return p.map(i => ({ i, sum: rankFallback ? rankFallback(i) : 0.5, matched: 0, primaryMatched: 0, thinMatched: 0 }))
        .sort((a, b) => b.sum - a.sum);
    }
    return p.map(i => ({ i, ...scoreMatch(i, interp, itemTags) }))
      /* The primary-token gate: when the query has at least one non-broad
         (specific) token, an item must match one of THOSE to qualify at all
         -- a broad/generic-only match (e.g. "history") can never by itself
         justify inclusion. When the whole query is broad words (e.g. a bare
         "history"), there's nothing more specific to prefer, so any match
         counts, same as before. For a properNounQuery (see interpretQuery),
         the gate tightens from OR to AND -- every primary token must match,
         not just one -- since a lone coincidental word match (e.g. "lex" in
         an unrelated Ancient Rome episode) shouldn't satisfy a 2-word name
         search.

         ON TOP of that (not instead of it): every THIN primary token (see
         THIN ANCHOR in interpretQuery) must ALSO match, regardless of which
         of the two rules above applied. A thin token is unmodeled AND
         nearly absent from the catalogue, so OR semantics would let a
         result qualify purely on some OTHER, commoner primary token while
         silently dropping the thin one -- which is how "design" alone
         carried "Electrical Circuit Design Dummies" to a confident 10-pick
         game-design/celebrity result with zero of "circuit"/"electrical"
         present in a single pick. Requiring every thin token to also match
         does not touch queries with no thin tokens at all (thinMatched and
         thinAnchorCount are both 0, so the check is `0 === 0`, always
         true), and for a query that IS thin-anchored it either finds real
         matches for the thin word too or -- far more often, since a thin
         word by definition has almost no catalogue coverage -- honestly
         empties out per product principle #1 instead of padding with an
         unrelated common word's matches. */
      .filter(x => {
        if (x.thinMatched !== interp.thinAnchorCount) return false;
        if (interp.properNounQuery) return x.primaryMatched === interp.primaryGroupCount && x.sum > minScore;
        return (interp.hasPrimary ? x.primaryMatched > 0 : x.matched > 0) && x.sum > minScore;
      })
      .sort((a, b) => b.matched - a.matched || b.sum - a.sum);
  };
  let results = attempt(interp.filters);
  let relaxed = null;
  if (!results.length && interp.filters.some(f => f.type.startsWith("duration"))) {
    results = attempt(interp.filters.filter(f => !f.type.startsWith("duration")));
    if (results.length) relaxed = "duration";
  }
  if (!results.length && interp.filters.length) {
    results = attempt([]);
    if (results.length) relaxed = "all";
  }
  return { results, relaxed };
}

/* ---------- honest rich/sparse/empty tiering ----------
   Product principle #1: an honest sparse/empty answer beats padding a list
   with off-topic filler. "Strong" is relative, not an absolute score bar:
   a match within STRONG_RATIO of *this query's own* top score. Relative
   because the natural score ceiling differs by query shape -- a single-
   word exact show-name match (e.g. "smartless") tops out lower per-item
   than a rich multi-concept query (e.g. "nuclear fusion energy"), and it
   also has to work for the zero-content-token / pure-filter case ("comedy",
   "something short") where `sum` comes from rankFallback (~0..1) rather
   than scoreMatch (~2..16) -- an absolute bar tuned for one scale silently
   breaks the other. A relative bar is scale-invariant, so one rule covers
   both, and it's what actually separates the real BBQ episodes (ratio
   0.71-1.0 of top) from the "Texas" place-name false positives that leak
   in from true-crime/disaster episodes on a "how bbq works" query (ratio
   0.30-0.34) -- see tools/test-search.mjs for the calibration cases.
   Both app.js's buildPlaylist and the test harness call classifyResults()
   so the tiering rule has exactly one definition. Tunable. */
const STRONG_RATIO = 0.5;
const RICH_MIN = 6;

/* WHAT A RELATIVE BAR COSTS, AND WHY THE BILL IS STILL BEING PAID (#301).
   Because the bar is a fraction of results[0].sum, raising the TOP result's own
   score raises the bar for every other result, so IMPROVING A QUERY'S BEST MATCH
   CAN DELETE THAT QUERY'S ANSWER. Doubling the top score is enough to empty any
   query whose ranking is also sum-ordered: the bar reaches the OLD top score, and
   the only results still clearing it are the ones that scored at least as much as
   the top-ranked result already did -- ties, and the sum-vs-`matched` disagreement
   #216 records, which is why this is "any query" in practice but not by
   construction.
   Measured on the 2026-08-21 pool over the 35 of tools/test-search.mjs's 37 queries
   that return anything (`--tiering` prints them), bumping only results[0].sum: 27
   lose picks at or before +80%, and four go EMPTY at +54% or less -- "meditation"
   and "nba" at +34%, "politics" at +51%, "stock market" at +54%.
   The instance: PR #300 labelled Huberman's meditation episode `health/meditation`
   correctly, 8.100 -> 12.150. The bar went 4.050 -> 6.075, Ten Percent Happier's
   5.400 fell out although nothing about ITS relevance changed, one clearer was
   left, and "meditation" returned nothing where it had returned two. Coverage
   went up; the gain WAS the mechanism. The show-name RESCUE comment above
   describes the same failure from a different cause, so the shape was already
   known -- what #301 adds is that ordinary curation triggers it.

   FIRST THING TO SUSPECT when a curation PR turns a battery status check red
   ("<query> status is sparse" and the like): look at what the query's top result
   scored before and after. In #300 it read as "the topic change broke meditation"
   for a while, when it was "the topic change was right and the grader is fragile".

   IT IS STILL HERE BECAUSE EVERY EXIT MEASURED WORSE, not because nobody looked.
   All four directions in #301 were run against the battery (123 checks, green
   here) on the 2026-08-21 pool:
     1. CAP THE BAR'S RISE, `min(top, 2 * second) * STRONG_RATIO`. 1 red. The
        clamp makes the runner-up clear by construction, which deletes the
        honest-empty floor: "basketball" answers with a Freakonomics episode on
        depression that mentions basketball in passing.
     2. ANCHOR ON A ROBUST STATISTIC. Second-best: 2 red -- "meditation" becomes
        status "ok" over 9 picks, promoting Marcus Aurelius and two Engines of Our
        Ingenuity episodes. It also all but deletes the honest-empty state: the
        anchor clears its own bar, so `empty` needs the TOP-ranked result to score
        under half of the runner-up, which only the sum-vs-`matched` disagreement
        can produce and no battery query currently does.
        Median: 2 red -- filler is the majority on a broad query, so the median IS
        filler; "grill" comes back with Serial, Dateline, Morbid and Wicked Words
        in the top five, which is the "Texas" leak this bar was calibrated to keep
        out.
     3. TREAT ONE CLEARER AS AN ANSWER (`strong.length < 1` plus `picks.length <
        1`). 2 red, and the two are the argument: "warriors" answers with an
        Ancients episode on Scotland's first warriors, "basketball" with the
        depression episode. The two-clearer floor is a CORROBORATION rule -- two
        results clearing independently is the evidence that a thin query has real
        coverage, and one result is unfalsifiable. A lone clearer is filler often
        enough that the honest answer is the empty state plus
        suggestAdjacentTopics().
     4. RETUNING THIS CONSTANT is not an exit either, because every ratio has a
        cliff somewhere; it only moves. And there is no room: 0.44 is green, 0.40
        is 3 red ("grill", "meditation", "basketball"). Post-improvement the
        meditation runner-up sits at ratio 0.4444 and "basketball"'s filler at
        0.4286, so the whole window that saves the measured instance without
        admitting measured filler is (0.4286, 0.4444].
   So the hazard is bounded and documented instead. The bar reads results[0].sum
   and nothing else, so an improvement that leaves a result RANKED BELOW the top
   one cannot evict anything, however large it is: the dangerous curation edit is
   specifically "raise the score of the result the ranking already places first on
   a thin query". Two things that bound does NOT cover, both measured rather than
   reasoned: an improvement big enough to OVERTAKE the top result makes it
   results[0] and the same hazard applies to it; and past a page #216's
   `prefix.length <= cap` fallback can still cut the pick count (10 picks to 2,
   measured) when a promotion lengthens the prefix -- that one keeps the honest
   clearers, so it is the guard working as ruled rather than this defect.
   Both halves are pinned in test/search-tiering.test.js, and the bound is
   re-checked against the live pool in test/search-bar-exposure.test.js. #301
   stays open: the fix is a product ruling about what a one-strong-answer query
   should show, not a constant. */

/* How many picks a playlist shows. Was an inline `cap = 10` default in both
   diversify() and classifyResults(); named and exported because #216 made it
   load-bearing in a third place -- the sparse widening is only safe while it
   fits on one page (see classifyResults) -- and because tools/test-search.mjs
   §9 has to know where truncation starts to know which queries its claim
   applies to. A literal 10 in the battery would either start failing or,
   worse, silently stop asserting the day this moved. */
const DEFAULT_CAP = 10;

/* The prefix of the ranking that ends at the LAST bar-clearing result. #216.
   Returned as the candidate set for the narrow (sparse/single-show) branch of
   classifyResults, in place of the bar-clearers themselves.

   THE DEFECT, and it is a disagreement rather than a miscalculation. Ordering
   is `b.matched - a.matched || b.sum - a.sum` (searchWithRelaxation): `matched`
   -- how many of the query's concept groups an item hit at all -- dominates
   absolutely. The bar is `results[0].sum * STRONG_RATIO`, applied to `sum` and
   nothing else. So the two could disagree about which of two results was
   better, and when they did, the narrow branch showed the worse one. Measured,
   the issue's own example (#216, reproduced exactly by adding `music/jazz` to
   sticky-notes--gershwin-rhapsody, which is PR #211's curation change and is
   not on main -- so the defect is real but latent there):

     query "the history of jazz"        bar = 9.300 * 0.5 = 4.650
     raw0  matched=2  sum=9.300  gershwin-rhapsody          clears
     raw1  matched=2  sum=4.275  john-williams-a-composers  BELOW BAR
     raw2  matched=1  sum=5.400  smartless--sting           clears

   raw1 matched BOTH query concepts and the ranking placed it second; raw2
   matched one and was shown instead. The page lost the better result.

   WHAT IS FIXED, stated as an invariant rather than as a patch to that case:
   the candidate set is a PREFIX of the ranking. Nothing is dropped in favour
   of a result the ranking places below it. The wide branch already had this
   property trivially -- it passes the whole `results` array -- so after this
   the two branches agree, and "better" has exactly one definition in this
   module: the sort comparator.

   Equivalently, and this is the useful way to read the blast radius: within a
   `matched` tier the comparator already orders by `sum`, so every clearer in a
   tier precedes every non-clearer in it. The prefix therefore admits exactly
   the sub-bar results sitting in tiers ABOVE the lowest tier that clears at
   all. Nothing below the last clearer is ever admitted.

   THE BAR IS STILL RELATIVE AND STILL COUNTS THE SAME THINGS. This deliberately
   does not touch the bar, and it does not touch what `strong` means anywhere
   else in classifyResults -- the two-result honesty floor, `sparse`/`ok`, and
   the single-show test all still count bar-CLEARERS, exactly as before. So the
   status a query reports is bit-identical to before this change for every
   possible input, and the neighbouring hazard the old comment records (raising
   one item's score raises the bar and can evict a DIFFERENT item) can no longer
   move a query between empty/sparse/ok at all. What it can still do is change
   which items fill a sparse answer -- and there this change makes the eviction
   fill the hole instead of leaving it, whenever the evicted result outranks
   something still shown. An item ranked below every clearer is still evicted,
   silently, and that is the honest remaining limit.
   Because a lone clearer can only ever be results[0] (results[0] clears by
   construction), a one-clearer query has a one-item prefix, so the floor cannot
   be reached through this widening either.

   THE THREE ALTERNATIVES WERE MEASURED, over all 38 queries the battery
   exercises, on main's pool and again on the witness pool above. All three lose,
   and each loses differently:

     a per-`matched`-tier bar (#216's first suggestion) DOES NOT FIX THE ISSUE'S
     OWN EXAMPLE. Tier matched=2 tops out at 9.300, so its bar is still 4.650 and
     raw1 at 4.275 is still evicted -- the witness stays at 2 picks. Meanwhile
     tier matched=1 gets a bar of 2.700 and "stock market" goes sparse -> ok on
     47 sub-bar results.

     admitting anything whose `matched` equals results[0].matched (#216's second
     suggestion) does fix the witness, but only because raw1 happens to sit in
     the top tier; it leaves the identical defect one tier down untouched, and it
     admits top-tier results with no lower bound on `sum` at all. Measured, that
     is not theoretical: on a single-token query every retrieved item is in the
     top tier, so "how bbq works" goes from 0 off-topic picks of 8 to 7 of 10 and
     "grill" from 1 of 8 to 7 of 10 -- Serial, Dateline, Morbid, Casefile and the
     Texas City disaster, which is precisely the place-name leak the sparse
     comment below exists to describe.

     ranking on `sum` so that both agree the other way is the tidiest option on
     paper -- prefix closure then holds by construction rather than by rule -- and
     it does not fix the witness either. It makes the two agree by DROPPING raw1
     consistently (sum order is 9.300, 5.400, 4.275, so the evicted result is
     last and the prefix is closed trivially), which answers #216 by deciding the
     multi-concept match was never better. It also costs precision, because
     `matched` was doing real work: "video games" moves an FFmpeg video-codec
     episode from pick 9 to pick 1 and gains a Google-search episode, and "world
     war 2" gains two World Cup episodes. Five queries change picks.

   The reading that won, then: `matched` stays primary and the bar follows it,
   because the alternative that demotes `matched` measurably promotes
   single-signal matches over multi-concept ones on a several-word query, which
   is the opposite of what a several-word query asks for.

   Covered by test/search-tiering.test.js (the mechanism, on fixtures, in
   milliseconds -- including the numbers above) and by tools/test-search.mjs §9
   (the coupling to the real comparator over the live pool, which fixtures
   cannot see). `node tools/test-search.mjs --tiering` prints the per-query
   table these numbers came from.

   TOTAL, AND NEVER EMPTY. `last` seeds at 0 and the scan starts at 1 because
   results[0] clears its own bar by construction (bar is a fraction of its score),
   so index 0 needs no test. That is also the contract: the top-ranked result is
   always showable. Seeding at -1 instead is an EQUIVALENT MUTATION from
   classifyResults' side -- no reachable input distinguishes it, since something
   always clears -- so it is pinned from the other side, on a bar nothing clears
   at all, in test/search-tiering.test.js. Without that the mutation survives. */
function strongPrefix(results, bar) {
  let last = 0;
  for (let k = 1; k < results.length; k++) if (results[k].sum >= bar) last = k;
  return results.slice(0, last + 1);
}

/* ---------- diversity ----------
   Anti-echo-chamber (CLAUDE.md principle #1): a result shouldn't be
   dominated by the one or two biggest shows the catalog happens to carry
   the most episodes of -- "nuclear fusion energy" returning Lex Fridman
   twice, "true crime" returning Casefile/Crime Junkie twice each, etc.
   Relevance stays authoritative (this never changes `sum`/`matched`, and
   classifyResults' rich/sparse/empty tiering above is computed BEFORE this
   runs, on pure relevance) -- diversify() only re-ranks/selects WITHIN an
   already-qualified candidate set. It can reorder or defer a candidate; it
   can never introduce one classifyResults did not hand it.
   That last sentence used to read "one that didn't already pass the relevance
   bar", and #216 made it false: on a sparse answer the candidate set is now a
   prefix of the ranking, which can include a result whose own `sum` is under
   the bar because the ranking places it above one that cleared. The set is
   still authoritative and still built on pure relevance; it is just no longer
   the same thing as "cleared the bar". See strongPrefix(). */
const PER_SHOW_CAP = 2;
const LISTENED_PENALTY = 0.85; // 15% gentle down-weight, not exclusion

/* Greedy per-show cap with a backfill pass, over candidates already sorted
   by relevance (matched desc, then a listened-history-adjusted sum). Takes
   up to `perShowCap` per show on the first pass; if that leaves fewer than
   `cap` picks (not enough distinct shows to diversify with), backfills the
   deferred over-cap items back in their original order -- so capping can
   only ever REORDER/SPREAD an already-diverse-enough set; it never shrinks
   a genuinely sparse or single-show (e.g. a show-name query like
   "smartless") result. That backfill is what keeps this honest: capping
   bbq's 4 same-show episodes down to 2 and calling it "sparse" would be
   exactly the padding-vs-honesty problem this whole engine exists to avoid. */
function diversify(candidates, { cap = DEFAULT_CAP, perShowCap = PER_SHOW_CAP, listenedShows = new Set() } = {}) {
  const ranked = candidates
    .map((c, idx) => ({ c, idx, adjusted: c.sum * (listenedShows.has(c.i.show) ? LISTENED_PENALTY : 1) }))
    .sort((a, b) => (b.c.matched - a.c.matched) || (b.adjusted - a.adjusted) || (a.idx - b.idx));

  const showCounts = new Map();
  const picked = [];
  const deferred = [];
  for (const r of ranked) {
    const show = r.c.i.show;
    const n = showCounts.get(show) || 0;
    if (n < perShowCap) {
      picked.push(r.c);
      showCounts.set(show, n + 1);
      if (picked.length === cap) return picked;
    } else {
      deferred.push(r.c);
    }
  }
  for (const c of deferred) {
    picked.push(c);
    if (picked.length === cap) break;
  }
  return picked;
}

function classifyResults(results, { cap = DEFAULT_CAP, perShowCap = PER_SHOW_CAP, listenedShows = new Set() } = {}) {
  if (!results.length) return { status: "empty", picks: [] };
  const bar = results[0].sum * STRONG_RATIO;
  const strong = results.filter(x => x.sum >= bar);
  /* The honesty floor, and it is REDUNDANT WITH THE `picks.length < 2` GUARD at
     the bottom -- deliberately, and worth saying so because it reads like dead
     code. A single clearer can only ever be results[0] (results[0] clears by
     construction), so strongPrefix returns one candidate, diversify returns one
     pick, and the guard below returns empty anyway. Lowering this to `< 1` is an
     equivalent mutation and survives the suites; it is kept because it states
     the rule where a reader looks for it, and because it stops the work rather
     than undoing it. Do not "simplify" it away expecting a test to object. */
  if (strong.length < 2) return { status: "empty", picks: [] };
  const sparse = strong.length < RICH_MIN;
  // Sparse: the answer stops at the last strong match -- never pad toward
  // `cap` with sub-bar results just to look like a fuller playlist. That
  // used to read "only the strong matches make the cut", and #216 is the
  // difference: the cut-off is where the ranking runs out of strong matches,
  // not which individual results cleared the bar, so a result the ranking
  // places ABOVE one being shown is shown too even if its own `sum` is under
  // the bar. That is a widening, and it is bounded in the two ways the
  // `candidates` comment below sets out -- unbounded, it really would pad, and
  // review caught it doing so. Diversity is applied to whichever candidate set
  // would have been sliced, so it can reorder within that set but never reach
  // outside it.
  //
  // Single-show strong set: same strong-only rule even when the count
  // clears RICH_MIN. When every bar-clearing match comes from ONE show,
  // there is nothing real to diversify with -- widening to `results` just
  // hands the per-show cap sub-bar false positives to promote over the
  // show's own deferred STRONG episodes (the "Texas" leak described above:
  // "how bbq works" put true-crime filler at rank 3 while real BBQ
  // episodes sat at rank 7, the moment the catalog's 6th BBQ Central
  // episode landed, 2026-07-30). The honest playlist is the show's
  // un-capped strong list (diversify()'s backfill keeps it intact), and
  // the status stays "ok"/"sparse" by strong count alone. A multi-show
  // strong set keeps the wide candidate pool: there sub-bar backfill is
  // what lets other shows' weaker-but-on-topic items break up an
  // echo-chamber top-10 (e.g. "startups and venture capital").
  const singleShow = strong.length >= 2 && strong.every((x) => x.i.show === strong[0].i.show);
  /* THE PREFIX REPLACES `strong` FOR A SPARSE ANSWER ONLY, AND ONLY WHEN IT FITS
     ON THE PAGE (#216). Both guards were found by review, both are behavioural
     rather than stylistic, and each has a fixture in
     test/search-tiering.test.js.

     `!singleShow`. The single-show half of this branch exists because the
     per-show cap DEFERS a show's own episodes, so any cross-show result in the
     candidate set gets promoted over them -- that is the "Texas" leak the
     paragraph above dates to 2026-07-30. Widening to the prefix hands it exactly
     the sub-bar cross-show results it was built to exclude: measured on fixtures,
     one bbq show's six strong episodes plus one sub-bar true-crime result in a
     higher `matched` tier put the true-crime result at rank 2. #216's ordering
     argument does not beat a measured product ruling on the branch that ruling
     was made for, so single-show answers keep the bar-clearers.

     `prefix.length <= cap`. diversify() truncates at `cap`, and the prefix is
     unbounded, so a long prefix does not merely widen the answer -- it can push a
     genuine bar-clearer off the end. Measured: one top-tier result, twelve
     sub-bar results in the tier below it, and one clearer under those returns a
     "sparse" status over ten picks, nine of them sub-bar, with the second real
     strong match gone. That is both the padding this branch forbids and a fresh
     instance of #216 itself. Past a page the hole-filling has become padding, so
     the honest set is the clearers again.

     Note what is NOT guarded, because it does not need to be: the prefix can only
     add results that outrank a clearer, never results below the last one, so
     inside a page it cannot pad toward `cap` with anything the ranking places
     worse than what is already shown. */
  const prefix = strongPrefix(results, bar);
  const widen = sparse && !singleShow && prefix.length <= cap;
  const candidates = widen ? prefix : (sparse || singleShow) ? strong : results;
  const picks = diversify(candidates, { cap, perShowCap, listenedShows });
  if (picks.length < 2) return { status: "empty", picks: [] };
  return { status: sparse ? "sparse" : "ok", picks };
}

/* Deterministic "here's what's actually covered nearby" suggestions for the
   honest-empty state -- concepts related to the query's own concept(s),
   kept only if they have real catalog coverage (tagCount > 0 on at least one
   term). No LLM, no fabrication: an uncovered related concept is silently
   dropped rather than suggested.
   READS `tagCount`, NOT `tagDF`, and #275 is where that stopped being the same
   thing. `coverage` is a sum used only to rank suggestions against each other and
   to test `> 0`, so a common denominator cancels out of both and the fraction
   would be an identical ordering expressed in worse units -- but it is a COUNT of
   items that this is honest about ("real catalog coverage"), and a threshold is
   the one thing it must never grow into. If a future change wants "covered
   enough", that is a fraction and belongs with the constants at the top. */
function suggestAdjacentTopics(interp, ctx) {
  const concepts = ctx.semantic?.concepts || {};
  const seen = new Set();
  const suggestions = [];
  for (const group of interp.groups) {
    for (const [cid, c] of Object.entries(concepts)) {
      if (!c.terms?.includes(group.token)) continue;
      for (const rid of c.related || []) {
        if (seen.has(rid) || rid === cid) continue;
        seen.add(rid);
        const rc = concepts[rid];
        if (!rc) continue;
        const coverage = (rc.terms || []).reduce((n, t) => n + tagCount(t, ctx), 0);
        if (coverage > 0) suggestions.push({ id: rid, label: prettyConceptLabel(rid), coverage });
      }
    }
  }
  return suggestions.sort((a, b) => b.coverage - a.coverage).slice(0, 3);
}

function prettyConceptLabel(id) {
  return id.split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/* ---------- show search (Stage 2, docs/show-pages-plan.md) ----------

   A SEPARATE mode from interpretQuery/scoreMatch above, on purpose (plan §2,
   kanban card scope). Topic search answers "what should I listen to" by
   scoring episode-level relevance against a semantic index; this answers
   "does this show exist here" by plain substring matching against
   catalog(-client).json's `title` field -- there is no `host` field today
   (see the plan §2 and the card body) and this must not invent one, so it
   is not wired to fall back on anything else. No STOPWORDS/ALIASES/df
   machinery: a show's name is not a topic query, and running it through the
   topic tokenizer would strip words like "The" or "On" out of an actual
   show title ("The Daily", "On Being") that a listener typed on purpose. */
function searchShows(query, shows) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const show of shows || []) {
    const title = String(show?.title || "");
    const idx = title.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    /* Ranked, not just filtered: an exact title match should lead, then a
       match at the start of the title, then a match anywhere inside it.
       Ties within a rank keep the catalogue's own title order (stable
       sort), so results are deterministic for a fixed catalog snapshot. */
    const rank = title.toLowerCase() === q ? 0 : idx === 0 ? 1 : 2;
    scored.push({ show, rank, idx });
  }
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return scored.map(s => s.show);
}

const SearchEngine = {
  STOPWORDS, GENERIC_WORDS, ALIASES, BROAD_DF_THRESHOLD,
  TAG_DF_TOO_BROAD, TAG_DF_COMMON, TAG_DF_RARE,
  STRONG_RATIO, RICH_MIN, DEFAULT_CAP, PER_SHOW_CAP, LISTENED_PENALTY, SENSE_LOCKED_STEMS,
  tokenize, branchOf, tagCount, tagDF, dfMultiplier, expansionBucket, corpusDF, hitText, hitTag,
  lemmaVariants,
  interpretQuery, passesFilters, scoreMatch, searchWithRelaxation, classifyResults, diversify,
  strongPrefix,
  suggestAdjacentTopics, prettyConceptLabel,
  searchShows,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchEngine;
} else {
  window.SearchEngine = SearchEngine;
}
