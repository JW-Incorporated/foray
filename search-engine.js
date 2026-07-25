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

    for (const [cid, c] of Object.entries(concepts)) {
      if (!c.terms?.some(t => lookupKeys.has(t))) continue;
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
    };
  });

  return { groups, filters, topicBoosts, hasPrimary: groups.some(g => !g.broad) };
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

function scoreMatch(item, interp, itemTags) {
  const title = item.title.toLowerCase();
  const hook = (item.hook || "").toLowerCase();
  const show = item.show.toLowerCase();
  const topics = (item.topics || []).join(" ").toLowerCase();
  const tags = itemTags?.tags?.[item.id] || [];

  const hitText = (text, t) =>
    t.length < 4 ? new RegExp("\\b" + t + "\\b").test(text) : text.includes(t);
  const hitTag = (tag, t) =>
    t.length < 4 ? (tag === t || tag.split("-").includes(t)) : tag.includes(t);

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
         counts, same as before. */
      .filter(x => (interp.hasPrimary ? x.primaryMatched > 0 : x.matched > 0) && x.sum > minScore)
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

function classifyResults(results, { cap = 10 } = {}) {
  if (!results.length) return { status: "empty", picks: [] };
  const bar = results[0].sum * STRONG_RATIO;
  const strong = results.filter(x => x.sum >= bar);
  if (strong.length < 2) return { status: "empty", picks: [] };
  const sparse = strong.length < RICH_MIN;
  // Sparse: only the strong matches make the cut -- never pad toward `cap`
  // with sub-bar results just to look like a fuller playlist.
  const picks = (sparse ? strong : results).slice(0, cap);
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
  STRONG_RATIO, RICH_MIN,
  tokenize, branchOf, tagDF, corpusDF,
  interpretQuery, passesFilters, scoreMatch, searchWithRelaxation, classifyResults,
  suggestAdjacentTopics, prettyConceptLabel,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchEngine;
} else {
  window.SearchEngine = SearchEngine;
}
