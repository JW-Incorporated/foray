/* Foray search engine — pure, deterministic query interpretation + scoring.
   No DOM, no localStorage, no network, no LLM at query time (per
   docs/curation/personalization-and-depth-plan.md §7). Concepts/modifiers
   come from data/semantic-index.json (compiled offline); item tags from
   data/item-tags.json. Both are fetched once per session by app.js and
   passed in as `ctx` here — this module never touches globals.

   Loaded as a plain <script> before app.js (see index.html) so it works
   under the strict CSP with no build step, and is also require()-able from
   Node (tools/test-search.mjs) for the search-quality battery.

   ctx shape: { semantic, itemTags, discover, _dfMemo?, _corpusDfMemo? }
   (the two memo maps are created lazily and cached on the ctx object the
   caller passes in — callers should reuse one ctx per session/run). */

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
   over it (history 23.0%, science 18.6%). Tunable — see tools/test-search.mjs. */
const BROAD_DF_THRESHOLD = 0.10;

function tokenize(q) {
  return q.toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !GENERIC_WORDS.has(w));
}

/* ---------- corpus stats (memoized per ctx, same pattern for both) ---------- */

function branchOf(item) {
  const t = item.topics?.[0] || "";
  return t.split("/")[0] || "other";
}

function tagDF(term, ctx) {
  if (!ctx._dfMemo) ctx._dfMemo = new Map();
  if (ctx._dfMemo.has(term)) return ctx._dfMemo.get(term);
  const tagsMap = ctx.itemTags?.tags || {};
  let n = 0;
  for (const tags of Object.values(tagsMap)) {
    if (tags.some(tag => term.length < 4 ? (tag === term || tag.split("-").includes(term)) : tag.includes(term))) n++;
  }
  ctx._dfMemo.set(term, n);
  return n;
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
    const lookupKeys = new Set([tok, ...aliasesOf]);

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
      const df = tagDF(t, ctx);
      if (df > 60) terms.delete(t);
      else if (df > 25) terms.set(t, { ...info, w: info.w * 0.4 });
    }

    return {
      token: tok,
      terms,
      broad: corpusDF(tok, ctx) >= BROAD_DF_THRESHOLD,
      df: tagDF(tok, ctx),
      hasConceptExpansion,
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

  return {
    groups, filters, topicBoosts,
    hasPrimary: primaryGroups.length > 0,
    properNounQuery,
    primaryGroupCount: primaryGroups.length,
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
   "team" inside "steam". All three known collisions add extra letters
   BEFORE the term, never after -- so instead of a blanket switch to
   word-boundary matching (which would also break legitimate plural
   matches some concepts rely on, e.g. a term "rocket" matching text
   "rockets"), this requires no letter/digit immediately before the
   match and allows an optional trailing "s". Blocks all three known
   collisions, keeps plural matching, touches nothing else.

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
    }
    sum += best * (group.df <= 10 ? 1.35 : group.df <= 30 ? 1 : 0.75);
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
    }
  }

  return { sum, matched: matchedGroups, primaryMatched };
}

/* pool must already be pre-filtered (family mode etc. — app.js's poolFiltered()).
   rankFallback(item) ranks the zero-content-token case (e.g. a bare "short"
   duration query) — app.js passes its personalized interestScore; tests can
   omit it and get a stable 0.5 for every item. */
function searchWithRelaxation(pool, interp, minScore, itemTags, rankFallback) {
  const attempt = (filters) => {
    const p = pool.filter(i => passesFilters(i, filters));
    if (!interp.groups.length) {
      return p.map(i => ({ i, sum: rankFallback ? rankFallback(i) : 0.5, matched: 0, primaryMatched: 0 }))
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
         search. */
      .filter(x => {
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

/* ---------- diversity ----------
   Anti-echo-chamber (CLAUDE.md principle #1): a result shouldn't be
   dominated by the one or two biggest shows the catalog happens to carry
   the most episodes of -- "nuclear fusion energy" returning Lex Fridman
   twice, "true crime" returning Casefile/Crime Junkie twice each, etc.
   Relevance stays authoritative (this never changes `sum`/`matched`, and
   classifyResults' rich/sparse/empty tiering above is computed BEFORE this
   runs, on pure relevance) -- diversify() only re-ranks/selects WITHIN an
   already-qualified candidate set. It can reorder or defer a candidate; it
   can never introduce one that didn't already pass the relevance bar. */
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
function diversify(candidates, { cap = 10, perShowCap = PER_SHOW_CAP, listenedShows = new Set() } = {}) {
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

function classifyResults(results, { cap = 10, perShowCap = PER_SHOW_CAP, listenedShows = new Set() } = {}) {
  if (!results.length) return { status: "empty", picks: [] };
  const bar = results[0].sum * STRONG_RATIO;
  const strong = results.filter(x => x.sum >= bar);
  if (strong.length < 2) return { status: "empty", picks: [] };
  const sparse = strong.length < RICH_MIN;
  // Sparse: only the strong matches make the cut -- never pad toward `cap`
  // with sub-bar results just to look like a fuller playlist. Diversity is
  // applied to whichever candidate set would have been sliced, so it can
  // reorder within "strong"/"results" but never reach outside either.
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
  const candidates = (sparse || singleShow) ? strong : results;
  const picks = diversify(candidates, { cap, perShowCap, listenedShows });
  if (picks.length < 2) return { status: "empty", picks: [] };
  return { status: sparse ? "sparse" : "ok", picks };
}

/* Deterministic "here's what's actually covered nearby" suggestions for the
   honest-empty state -- concepts related to the query's own concept(s),
   kept only if they have real catalog coverage (tagDF > 0 on at least one
   term). No LLM, no fabrication: an uncovered related concept is silently
   dropped rather than suggested. */
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
        const coverage = (rc.terms || []).reduce((n, t) => n + tagDF(t, ctx), 0);
        if (coverage > 0) suggestions.push({ id: rid, label: prettyConceptLabel(rid), coverage });
      }
    }
  }
  return suggestions.sort((a, b) => b.coverage - a.coverage).slice(0, 3);
}

function prettyConceptLabel(id) {
  return id.split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const SearchEngine = {
  STOPWORDS, GENERIC_WORDS, ALIASES, BROAD_DF_THRESHOLD,
  STRONG_RATIO, RICH_MIN, PER_SHOW_CAP, LISTENED_PENALTY, SENSE_LOCKED_STEMS,
  tokenize, branchOf, tagDF, corpusDF, hitText, hitTag,
  interpretQuery, passesFilters, scoreMatch, searchWithRelaxation, classifyResults, diversify,
  suggestAdjacentTopics, prettyConceptLabel,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchEngine;
} else {
  window.SearchEngine = SearchEngine;
}
